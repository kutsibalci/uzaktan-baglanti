// Tepsi.exe uçtan uca: derle, başlat (sunucuyu gizli başlatmalı), olay akışı, uyku engeli, çökünce yeniden başlatma,
// başlangıç kısayolu (geçici klasörde), --cikis ile düzgün kapanma (alt süreçler dahil).
// Ortak test sunucusu kullanılmaz: Tepsi.exe kendi sunucusunu TEST_PORT'ta başlatır.
// @sunucu yok
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn, spawnSync, execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const WebSocket = require(path.join(ROOT, 'node_modules', 'ws'));
const { buildExe } = require(path.join(ROOT, 'lib', 'helper'));
const PORT = Number(process.env.TEST_PORT || 3999);
const TOKEN = 'tepsi-uygulama-testi-0123456789abcdef';

let pass = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${name} ${extra}`);
  if (cond) pass++; else process.exitCode = 1;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function durum() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/tepsi/durum', headers: { 'X-Tepsi': TOKEN } }, (res) => {
      let d = '';
      res.on('data', (x) => { d += x; });
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(d) }); } catch { resolve({ status: res.statusCode }); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(3000, () => req.destroy());
  });
}
async function waitFor(fn, ms, step = 500) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(step);
  }
  return null;
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const killTree = (pid) => spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });

// Bir sürecin tüm alt süreçleri (yalnızca okuma).
function descendants(pid) {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
    'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.Name)" }'], { encoding: 'utf8' });
  const rows = out.trim().split(/\r?\n/).map((l) => { const [p, pp, ...n] = l.trim().split(' '); return { pid: +p, ppid: +pp, name: n.join(' ') }; });
  const result = [];
  const walk = (p) => { for (const r of rows) if (r.ppid === p && !result.some((x) => x.pid === r.pid)) { result.push(r); walk(r.pid); } };
  walk(pid);
  return result;
}

function wsClient() {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  const queue = [];
  const waiters = [];
  ws.on('message', (d, bin) => {
    const msg = bin ? { t: 'frame' } : JSON.parse(d.toString());
    const i = waiters.findIndex((w) => w.pred(msg));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg); else queue.push(msg);
  });
  const next = (pred, ms = 8000) => {
    const i = queue.findIndex(pred);
    if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
    return new Promise((resolve, reject) => { waiters.push({ pred, resolve }); setTimeout(() => reject(new Error('timeout')), ms); });
  };
  return { ws, next, send: (o) => ws.send(JSON.stringify(o)), closed: new Promise((r) => ws.on('close', r)) };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-tepsi-'));
const dataDir = path.join(tmp, 'data');
const startupDir = path.join(tmp, 'baslangic');
fs.mkdirSync(startupDir);
const logFile = path.join(dataDir, 'sunucu.log');
const readLog = () => { try { return fs.readFileSync(logFile, 'utf8'); } catch { return ''; } };
const env = {
  ...process.env, PORT: String(PORT), REMOTE_DATA_DIR: dataDir, TRAY_TOKEN: TOKEN, REMOTE_GUC_KURU: '1',
  TEPSI_SESSIZ: '1', TEPSI_BASLANGIC_KLASORU: startupDir,
};
let tray = null;


(async () => {
  // 1. Derleme
  let exe;
  try {
    exe = buildExe('Tepsi', { target: 'winexe', refs: ['System.Drawing.dll', 'System.Windows.Forms.dll', 'System.Web.Extensions.dll'] });
    check('Tepsi.exe derlendi', fs.existsSync(exe));
  } catch (e) {
    check('Tepsi.exe derlendi', false, e.message);
    return;
  }
  const run = (args) => spawnSync(exe, args, { env, timeout: 30000 });

  // 2. Başlangıç kısayolu (gerçek Başlangıç klasörü yerine geçici klasör)
  const lnk = path.join(startupDir, 'Uzaktan Bağlantı.lnk');
  check('kısayol başta yok (durum=1)', run(['--baslangic', 'durum']).status === 1);
  check('kısayol oluşturuldu', run(['--baslangic', 'ac']).status === 0 && fs.existsSync(lnk));
  const target = execFileSync('powershell.exe', ['-NoProfile', '-Command',
    `(New-Object -ComObject WScript.Shell).CreateShortcut('${lnk.replace(/'/g, "''")}').TargetPath`], { encoding: 'utf8' }).trim();
  check('kısayol Tepsi.exe\'yi gösteriyor', path.resolve(target).toLowerCase() === path.resolve(exe).toLowerCase(), target);
  check('kısayol durum=0', run(['--baslangic', 'durum']).status === 0);
  check('kısayol silindi', run(['--baslangic', 'kapat']).status === 0 && !fs.existsSync(lnk));
  check('çalışan örnek yokken --cikis sorunsuz', run(['--cikis']).status === 0);

  // 3. Başlatma: sunucuyu gizli başlatıp /api/tepsi/durum cevap vermeli
  tray = spawn(exe, [], { env, stdio: 'ignore' });
  const d = await waitFor(async () => { const r = await durum(); return r && r.status === 200 ? r : null; }, 60000);
  check('tepsi sunucuyu başlattı, /api/tepsi/durum cevap verdi', !!d, d ? `(port ${d.json.port})` : readLog().slice(-1500));
  if (!d) return;
  check('belirteç sunucuya geçti, port doğru', d.json.port === PORT);
  const firstPid = Number((readLog().match(/sunucu başlatıldı \(pid (\d+)\)/) || [])[1]);
  check('sunucu tepsinin alt süreci', firstPid > 0 && descendants(tray.pid).some((x) => x.pid === firstPid), `(pid ${firstPid})`);

  check('sunucu çıktısı günlüğe yazılıyor', /sunucusu çalışıyor/.test(readLog()));
  check('olay akışına bağlandı', !!(await waitFor(() => /olay akışı bağlandı/.test(readLog()), 10000)));

  // 4. Bağlantı bildirimi ve uyku engeli
  const c = wsClient();
  await c.next((m) => m.t === 'hello');
  c.send({ t: 'setup', username: 'ahmet', password: 'gizli123', remember: false, deviceName: 'Android · Chrome' });
  await c.next((m) => m.t === 'auth');
  check('bağlandı bildirimi (günlükte)', !!(await waitFor(() => /bildirim: ahmet bağlandı — \(bu bilgisayar\)/.test(readLog()), 8000)));
  // Cihaz adı girişte bildirilir (ilk kurulumda saklanmaz): ikinci bir hesapla dene.
  c.send({ t: 'admin', op: 'addUser', username: 'ayse', password: 'ayse1234', role: 'view' });
  await c.next((m) => m.t === 'adminData');
  const c2 = wsClient();
  await c2.next((m) => m.t === 'hello');
  c2.send({ t: 'login', username: 'ayse', password: 'ayse1234', remember: false, deviceName: 'Android · Chrome' });
  await c2.next((m) => m.t === 'auth');
  check('bildirim cihaz adını içeriyor', !!(await waitFor(() => /bildirim: ayse bağlandı — Android · Chrome \(bu bilgisayar\)/.test(readLog()), 8000)));
  c2.ws.close();
  await c2.closed;
  check('ayrıldı bildirimi (kopma sonrası birkaç sn beklenir)', !!(await waitFor(() => /bildirim: ayse ayrıldı/.test(readLog()), 10000)));
  c.send({ t: 'start', mode: 'control' });
  await c.next((m) => m.t === 'started');
  check('izlerken uyku engellendi', !!(await waitFor(() => /uyku engellendi/.test(readLog()), 8000)));
  c.send({ t: 'stop' });
  check('izleme bitince uyku engeli kalktı', !!(await waitFor(() => /uyku engeli kaldırıldı/.test(readLog()), 8000)));
  c.ws.close();
  await c.closed;

  // 5. Sunucu beklenmedik kapanınca yeniden başlatılır (kendi başlattığımız ağaçtaki node süreci)
  killTree(firstPid);
  const restarted = await waitFor(() => {
    const m = [...readLog().matchAll(/sunucu başlatıldı \(pid (\d+)\)/g)].map((x) => Number(x[1]));
    return m.length >= 2 ? m[m.length - 1] : null;
  }, 20000);
  check('çöken sunucu yeniden başlatıldı', !!restarted && restarted !== firstPid, `(pid ${restarted})`);

  check('çökme günlükte', /beklenmedik şekilde kapandı/.test(readLog()));
  const d2 = await waitFor(async () => { const r = await durum(); return r && r.status === 200 ? r : null; }, 40000);
  check('yeniden başlayan sunucu cevap veriyor', !!d2);

  // 6. Düzgün kapanma: --cikis sinyali → sunucu ve alt süreçleri (yardımcı, ffmpeg) kapanır
  const kids = descendants(tray.pid);
  check('alt süreçler görüldü', kids.length >= 2, kids.map((k) => k.name).join(', '));
  const trayExit = new Promise((r) => tray.on('exit', r));
  const r = run(['--cikis']);
  check('--cikis 0 döndü', r.status === 0, `(${r.status})`);
  const exited = await Promise.race([trayExit.then(() => true), sleep(15000).then(() => false)]);
  check('tepsi kapandı', exited);
  await sleep(1000);
  const left = kids.filter((k) => alive(k.pid));
  check('sunucu ve tüm alt süreçler kapandı', left.length === 0, left.map((k) => `${k.name}:${k.pid}`).join(', '));
  check('port boşaldı', (await durum()) === null);
  check('kapanış günlükte', /\[tepsi\] kapandı/.test(readLog()));
  tray = null;
})()
  .catch((e) => { console.error('TEST HATASI', e); process.exitCode = 1; })
  .finally(() => {
    // Ne olursa olsun yalnızca kendi başlattığımız süreçleri (ağaçlarıyla) kapat.
    // (Sunucu süreçleri tepsinin iş nesnesinde/ağacında olduğundan onlarla birlikte kapanır; PID'leri
    // yeniden kullanılmış olabileceği için ayrıca öldürülmez.)
    if (tray && alive(tray.pid)) killTree(tray.pid);
    try { fs.rmSync(path.join(startupDir, 'Uzaktan Bağlantı.lnk'), { force: true }); } catch { /* yok */ }
    setTimeout(() => {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* kilitliyse kalsın */ }
      console.log(`\n${pass} kontrol geçti`);
      process.exit();
    }, 500);
  });
