// @sunucu yok
// Tepsisiz arka plan başlatma (tools\arka-plan.ps1, arka-plan-baslat.bat, arka-plan-durdur.bat):
//   başlat → port cevap veriyor → ikinci başlat yeni kopya açmıyor → node'u (bu testin başlattığı, PID dosyasındaki) öldür →
//   bekçi yeniden başlatıyor → durdur → hepsi gitti, PID dosyası temiz. Ayrıca: günlük döndürme (5 MB), başka yolla çalışan
//   sunucuya (tepsi / konsol) dokunulmaması, art arda çökmede bekçinin durması.
// Veri klasörü geçicidir (REMOTE_DATA_DIR): PID / günlük / dur dosyaları kullanıcının data\ klasörüne yazılmaz.
// Yalnızca bu testin PID'leri ağacıyla sonlandırılır; tarayıcı açılmaz (REMOTE_ARKA_TARAYICI=0).
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const ROOT = path.join(__dirname, '..');
const PORT = process.env.TEST_PORT || '3999';
const PS1 = path.join(ROOT, 'tools', 'arka-plan.ps1');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${name} ${extra}`);
  if (cond) pass++; else process.exitCode = 1;
}

const tmp = fs.mkdtempSync(path.join(process.env.TEST_TMP || os.tmpdir(), 'arka-plan-'));
const veri = path.join(tmp, 'veri');
fs.mkdirSync(veri);
const PID = path.join(veri, 'arka-plan.pid');
const DUR = path.join(veri, 'arka-plan.dur');
const LOG = path.join(veri, 'sunucu.log');
const ENV = { ...process.env, PORT, REMOTE_DATA_DIR: veri, REMOTE_ARKA_TARAYICI: '0', REMOTE_ARKA_BEKLEME: '1,1,1,1' };
const izlenen = new Set(); // temizlikte kesin kapatılacak PID'ler (yalnızca bizimkiler)

function ps(islem, ek = {}) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS1, '-Islem', islem],
    { env: { ...ENV, ...ek }, encoding: 'utf8', timeout: 90000 });
  return { kod: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}
function bat(ad) {
  const r = spawnSync('cmd.exe', ['/d', '/c', path.join(ROOT, ad)], { env: ENV, encoding: 'utf8', timeout: 90000, stdio: ['ignore', 'pipe', 'pipe'] });
  return { kod: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}
const pidOku = () => { try { return JSON.parse(fs.readFileSync(PID, 'utf8')); } catch { return null; } };
const canli = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const killTree = (pid) => spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
const log = () => { try { return fs.readFileSync(LOG, 'utf8'); } catch { return ''; } };

function cevap() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/features', timeout: 1500 }, (r) => { r.resume(); resolve(r.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}
async function bekle(kosul, ms) {
  const son = Date.now() + ms;
  while (Date.now() < son) { if (await kosul()) return true; await sleep(300); }
  return false;
}
// Bekçinin node çocukları (komut satırı denetimi yok; yalnızca üst süreç PID'i)
function cocuklar(pid) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `@(Get-CimInstance Win32_Process -Filter "ParentProcessId = ${Number(pid)} AND Name = 'node.exe'" | ForEach-Object { $_.ProcessId }) -join ','`], { encoding: 'utf8' });
  return (r.stdout || '').trim().split(',').filter(Boolean).map(Number);
}

(async () => {
  try {
    if (await cevap()) { check(`port ${PORT} zaten kullanılıyor, test yapılamaz`, false); return; }

    // Günlük döndürme için 5 MB'tan büyük eski günlük
    fs.writeFileSync(LOG, `${'eski satır\r\n'.repeat(560000)}`);
    const eskiBoyut = fs.statSync(LOG).size;

    // ---------- 1. Başlat (bat) ----------
    const b1 = bat('arka-plan-baslat.bat');
    check('arka-plan-baslat.bat hemen döndü', b1.kod === 0, b1.out.trim());
    check('sunucu arka planda açıldı, port cevap veriyor', await bekle(cevap, 60000));
    let k = pidOku();
    if (k) { izlenen.add(k.bekci); izlenen.add(k.node); }
    check('PID dosyası: bekçi ve node canlı, port doğru', !!k && canli(k.bekci) && canli(k.node) && k.port === Number(PORT), JSON.stringify(k));
    check('node bekçinin çocuğu (gizli, konsolsuz)', !!k && cocuklar(k.bekci).includes(k.node));
    check('günlük: bekçi + sunucu çıktısı data klasöründe', /\[arka-plan\] sunucu başlatıldı/.test(log()) && /Uzaktan Bağlantı sunucusu çalışıyor/.test(log()));
    check('5 MB\'ı aşan günlük sunucu.log.1\'e taşındı', fs.existsSync(`${LOG}.1`) && fs.statSync(`${LOG}.1`).size === eskiBoyut && fs.statSync(LOG).size < 1024 * 1024);

    // ---------- 2. İkinci başlat: yeni kopya yok ----------
    const b2 = ps('baslat');
    const k2 = pidOku();
    check('ikinci başlat yeni kopya açmadı', b2.kod === 0 && /Zaten arka planda çalışıyor/.test(b2.out) && k2.bekci === k.bekci && k2.node === k.node, b2.out.trim());
    check('bekçinin tek node çocuğu var', cocuklar(k.bekci).length === 1);
    const d = ps('durum');
    check('durum: çalışıyor (çıkış 0)', d.kod === 0 && /"calisiyor":true/.test(d.out), d.out.trim());

    // ---------- 3. Node beklenmedik şekilde kapanınca bekçi yeniden başlatır ----------
    killTree(k.node);
    const yeniden = await bekle(async () => { const x = pidOku(); return !!x && x.node && x.node !== k.node && canli(x.node) && cevap(); }, 45000);
    const k3 = pidOku();
    if (k3) izlenen.add(k3.node);
    check('öldürülen node yerine bekçi yenisini başlattı', yeniden && k3.bekci === k.bekci, JSON.stringify(k3));
    check('günlükte çökme ve bekleme yazıyor', /sunucu beklenmedik şekilde kapandı \(kod \d+\), 1 sn sonra yeniden başlatılıyor/.test(log()));

    // ---------- 4. Durdur (bat) ----------
    const t0 = Date.now();
    const dd = bat('arka-plan-durdur.bat');
    check('arka-plan-durdur.bat başarılı', dd.kod === 0 && /durduruldu/.test(dd.out), `${dd.out.trim()} (${Date.now() - t0} ms)`);
    await sleep(500);
    check('bekçi ve node gitti', !canli(k.bekci) && !canli(k3?.node) && !canli(k.node));
    check('port artık cevap vermiyor', !(await cevap()));
    check('PID ve dur dosyaları temiz', !fs.existsSync(PID) && !fs.existsSync(DUR));
    check('sunucu düzgün kapandı (belirteçli kapatma ucu)', /\[arka-plan\] sunucu düzgün kapandı \(kod 0\)/.test(log()) && /\[arka-plan\] bekçi durdu/.test(log()));
    const d2 = ps('durdur');
    check('ikinci durdur: çalışan yok (çıkış 0)', d2.kod === 0 && /çalışan sunucu yok/.test(d2.out), d2.out.trim());

    // ---------- 5. Başka yolla çalışan sunucu (tepsi / konsol): dokunulmaz ----------
    const konsol = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...ENV, REMOTE_DATA_DIR: path.join(tmp, 'konsol') }, stdio: 'ignore', windowsHide: true });
    izlenen.add(konsol.pid);
    check('konsol sunucusu açıldı', await bekle(cevap, 40000));
    const b5 = ps('baslat');
    check('başlat: başka sunucu çalışıyor, yeni kopya açılmadı', b5.kod === 0 && /yeni kopya açılmadı/.test(b5.out) && !fs.existsSync(PID), b5.out.trim());
    const d5 = ps('durdur');
    check('durdur: bizim başlatmadığımız sunucuya dokunmadı', d5.kod === 3 && /dokunulmadı/.test(d5.out) && canli(konsol.pid) && (await cevap()), d5.out.trim());
    killTree(konsol.pid);
    await bekle(async () => !(await cevap()), 10000);

    // ---------- 6. Art arda çökme: bekçi durur ----------
    const coken = path.join(tmp, 'coken.js');
    fs.writeFileSync(coken, "console.log('deneme: hemen çöküyor'); process.exit(3);\n");
    const b6 = ps('baslat', { REMOTE_ARKA_BETIK: coken });
    check('çöken sunucu: başlat başarısız döner', b6.kod === 1, b6.out.trim());
    const durdu = await bekle(async () => /10 dakika içinde 5 kez beklenmedik şekilde kapandı \(son kod 3\)/.test(log()), 30000);
    check('5 çökmeden sonra bekçi durdu ve günlüğe yazdı', durdu);
    await bekle(async () => !fs.existsSync(PID), 5000);
    check('bekçi durunca PID dosyası silindi', !fs.existsSync(PID));
  } catch (e) {
    check(`beklenmeyen hata: ${e.stack}`, false);
  } finally {
    // Temizlik: yalnızca bu testin süreçleri
    const k = pidOku();
    if (k) { izlenen.add(k.bekci); izlenen.add(k.node); }
    for (const pid of izlenen) if (pid && canli(pid)) killTree(pid);
    await sleep(500);
    if (process.exitCode) console.log(`--- günlük (son) ---\n${log().slice(-2500)}`);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`${pass} kontrol geçti`);
})();
