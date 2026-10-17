// Gecikme sayacı (features/olcum.js + public/features/olcum.js).
// 1) WebSocket: giriş yapmadan ping cevaplanmaz; girişten sonra pong doğru alanlarla gelir.
// 2) Gerçek tarayıcı motoru (başsız Edge / Chrome): görüntüleyicide sayaç görünür, ms değeri yazar, panel ve özet çalışır.
//    Girdi mesajları (move/down/up/wheel/key/text) sayfada yakalanır, sunucuya GİTMEZ. Edge/Chrome yoksa 2. kısım atlanır.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const ROOT = path.join(__dirname, '..');
const WebSocket = require(path.join(ROOT, 'node_modules', 'ws'));
const PORT = process.env.TEST_PORT || 3999;
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kill = (pid) => spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });

let pass = 0, fail = 0;
const check = (n, c, x = '') => { console.log(`${c ? 'OK  ' : 'FAIL'} ${n} ${x}`); c ? pass++ : fail++; };
const getJson = (u) => new Promise((res, rej) => http.get(u, (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej));

function client() {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  const queue = [];
  const waiters = [];
  ws.on('message', (d, bin) => {
    if (bin) return;
    const msg = JSON.parse(d.toString());
    const i = waiters.findIndex((w) => w.pred(msg));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg); else queue.push(msg);
  });
  const next = (pred, ms = 8000) => {
    const i = queue.findIndex(pred);
    if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      waiters.push(w);
      setTimeout(() => { const k = waiters.indexOf(w); if (k >= 0) { waiters.splice(k, 1); reject(new Error('zaman aşımı')); } }, ms);
    });
  };
  const send = (o) => ws.send(JSON.stringify(o));
  return { ws, next, send };
}
const t = (type) => (m) => m.t === type;

async function wsKismi() {
  const a = client();
  await a.next(t('hello'));
  a.send({ t: 'olcum-ping', c: 1 });
  let cevap = true;
  try { await a.next(t('olcum-pong'), 1200); } catch { cevap = false; }
  check('giriş yapmadan ping cevaplanmıyor', !cevap);
  a.send({ t: 'setup', username: 'deneme', password: 'deneme123' });
  const r = await a.next(t('auth'));
  check('yönetici oluşturuldu', r.ok, r.error || '');
  a.send({ t: 'olcum-ping', c: 12345.5 });
  const p = await a.next(t('olcum-pong'));
  check('pong istemci zamanını aynen döndürüyor', p.c === 12345.5, JSON.stringify(p));
  check('pong alanları', 'capMs' in p && typeof p.kuyrukKB === 'number' && p.via === 'local' && 'ackMs' in p && 'kalite' in p, JSON.stringify(p));
  a.send({ t: 'olcum-ping', c: 'x' });
  let bozuk = true;
  try { await a.next(t('olcum-pong'), 800); } catch { bozuk = false; }
  check('sayı olmayan zaman yok sayılıyor', !bozuk);
  a.ws.close();
}

async function tarayiciKismi() {
  const exe = BROWSERS.find((b) => fs.existsSync(b));
  if (!exe) { console.log('OK   tarayıcı (Edge/Chrome) bulunamadı, tarayıcı kısmı atlandı'); return; }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-olcum-'));
  let browser;
  try {
    browser = spawn(exe, [
      '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--mute-audio', 'about:blank',
    ], { stdio: 'ignore' });
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 80 && !fs.existsSync(portFile); i++) await sleep(250);
    const dbg = Number(fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0]);
    let targets = [];
    for (let i = 0; i < 40; i++) { try { targets = await getJson(`http://127.0.0.1:${dbg}/json/list`); if (targets.some((x) => x.type === 'page')) break; } catch {} await sleep(250); }
    const cdp = new WebSocket(targets.find((x) => x.type === 'page').webSocketDebuggerUrl);
    await new Promise((r) => cdp.on('open', r));
    let id = 0; const pending = new Map(); const exceptions = [];
    cdp.on('message', (d) => {
      const m = JSON.parse(d);
      if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    });
    const call = (method, params = {}) => new Promise((r, j) => { const i = ++id; pending.set(i, r); cdp.send(JSON.stringify({ id: i, method, params })); setTimeout(() => j(new Error(`CDP zaman aşımı: ${method}`)), 15000); });
    const ev = async (expression) => { const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails)); return r.result?.result?.value; };

    await call('Page.enable'); await call('Runtime.enable');
    await call('Page.addScriptToEvaluateOnNewDocument', { source: `
      window.__girdi = 0;
      const __orig = WebSocket.prototype.send;
      const __block = new Set(['move','down','up','wheel','key','text','kalem']);
      WebSocket.prototype.send = function (d) {
        try { if (__block.has(JSON.parse(d).t)) { window.__girdi++; return; } } catch {}
        return __orig.call(this, d);
      };` });
    await call('Page.navigate', { url: `http://localhost:${PORT}/` });
    for (let i = 0; i < 40 && !(await ev("!document.getElementById('vLogin').hidden").catch(() => false)); i++) await sleep(250);
    await ev(`(() => { const f = document.getElementById('tAccount'); f.username.value='deneme'; f.password.value='deneme123'; f.requestSubmit(); })()`);
    for (let i = 0; i < 40 && !(await ev("!document.getElementById('vHome').hidden")); i++) await sleep(250);
    check('sayaç görüntüleyici dışında gizli', await ev("document.getElementById('olcumBtn').hidden"));
    await ev("document.getElementById('modeControl').click()");
    for (let i = 0; i < 60 && !(await ev("document.getElementById('screen').width > 0")); i++) await sleep(250);
    check('görüntüleyici açıldı', await ev("document.getElementById('screen').width > 0"));
    for (let i = 0; i < 20 && !/\d+ ms/.test(await ev("document.getElementById('olcumBtn').textContent")); i++) await sleep(250);
    const yazi = await ev("document.getElementById('olcumBtn').textContent");
    check('sayaç ms yazıyor', /⏱ \d+ ms/.test(yazi) && !(await ev("document.getElementById('olcumBtn').hidden")), yazi);
    await sleep(3000);
    const st = await ev('RC.stats()');
    check('RC.stats: fps ve bant ölçülüyor', st.fps > 0 && st.kbps > 0, JSON.stringify(st));
    check('RC.stats: çözme süresi ölçülüyor', typeof st.decodeMs === 'number' && st.decodeMs >= 0 && st.decodeMs < 1000, JSON.stringify(st));
    // SPS düzeltmesi (lib/sps.js) olmadan NVENC akışında tarayıcı kareleri bekletiyordu: ~130 ms. Şimdi birkaç ms olmalı.
    if (/H\.264/.test(st.codec)) check('H.264: tarayıcı kare bekletmiyor (çözme < 60 ms)', st.decodeMs < 60, `${st.decodeMs.toFixed(1)} ms`);
    await ev("document.getElementById('olcumBtn').click()");
    const panel = await ev(`(() => { const p = document.getElementById('olcumPanel'); const g = (k) => p.querySelector('[data-k="' + k + '"]').textContent; return { gizli: p.hidden, rtt: g('rtt'), toplam: g('toplam'), fps: g('fps'), kodek: g('kodek') }; })()`);
    check('panel açıldı ve dolu', !panel.gizli && /\d+ ms/.test(panel.rtt) && /\d+ ms/.test(panel.toplam) && /\d+ fps/.test(panel.fps), JSON.stringify(panel));
    const ozet = await ev('RC.olcumOzet()');
    check('özet metni RTT istatistiği içeriyor', /RTT: ort \d/.test(ozet) && /Kare hızı: ort/.test(ozet), ozet.split('\n').slice(4, 6).join(' | '));
    // Akıcılık alanları (ayrıntılı JPEG denemesi: test/ozellik-akicilik.js)
    check('RC.stats: kare aralığı alanları var', ['intervalMs', 'jitterMs', 'maxIntervalMs', 'stutters'].every((k) => k in st), JSON.stringify(st));
    check('özet ve panel akıcılık satırlarını içeriyor', /Kare aralığı: /.test(ozet) && /Takılma: /.test(ozet) && /Kalite \(JPEG\): /.test(ozet)
      && (await ev(`!!document.querySelector('#olcumPanel [data-k="aralik"]') && !!document.querySelector('#olcumPanel [data-k="takilma"]')`)));
    console.log('     ' + ozet.split('\n').join('\n     '));
    await ev("document.getElementById('backBtn').click()");
    await sleep(300);
    check('görüntüleyiciden çıkınca sayaç ve panel gizlendi', await ev("document.getElementById('olcumBtn').hidden && document.getElementById('olcumPanel').hidden"));
    check('hiç girdi mesajı üretilmedi', (await ev('window.__girdi')) === 0);
    check('sayfada yakalanmamış hata yok', exceptions.length === 0, JSON.stringify(exceptions));
    cdp.close();
  } finally {
    if (browser) kill(browser.pid);
    await sleep(500);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* tarayıcı dosyaları bırakıyor olabilir */ }
  }
}

(async () => {
  try {
    await wsKismi();
    await tarayiciKismi();
  } catch (e) {
    console.log('HATA', e.stack || e);
    fail++;
  }
  console.log(`\n${pass} kontrol geçti, ${fail} hata`);
  process.exit(fail ? 1 : 0);
})();
