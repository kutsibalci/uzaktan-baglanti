// @sunucu yok
// Tepsisiz arka plan başlatma (tools\arka-plan.ps1, arka-plan-baslat.bat, arka-plan-durdur.bat):
//   başlat → port cevap veriyor → ikinci başlat yeni kopya açmıyor → node'u (bu testin başlattığı, PID dosyasındaki) öldür →
//   bekçi yeniden başlatıyor → durdur → hepsi gitti, PID dosyası temiz. Ayrıca: günlük döndürme (5 MB), başka yolla çalışan
//   sunucuya (tepsi / konsol) dokunulmaması, art arda çökmede bekçinin durması, aynı anda iki başlatta tek bekçi (adlı Mutex;
//   eskiden artan bekçi PID dosyasını silip çalışan sunucuyu durdurulamaz bırakıyordu).
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
const izlenen = new Set(); // bu testin bekçi / node PID'leri (temizlikte yalnızca hâlâ bizimse kapatılır)
const T0 = Date.now();
let konsol = null; // 5. bölümün konsol sunucusu (ChildProcess)

function ps(islem, ek = {}) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS1, '-Islem', islem],
    { env: { ...ENV, ...ek }, encoding: 'utf8', timeout: 90000 });
  return { kod: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}
function psAsync(islem) {
  return new Promise((resolve) => {
    const c = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS1, '-Islem', islem],
      { env: ENV, windowsHide: true });
    let out = '';
    c.stdout.on('data', (b) => { out += b; });
    c.stderr.on('data', (b) => { out += b; });
    c.on('close', (kod) => resolve({ kod, out }));
  });
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
// Bu testin hâlâ çalışan süreçleri. PID'ler yeniden kullanılabildiği için yalnızca PID'e bakılmaz: test başladıktan sonra
// oluşmuş olmalı ve ya komut satırında bu klasörün arka-plan.ps1'i + '-Islem bekci' olan bekçi, ya da izlenen bir bekçinin
// node çocuğu (bekçisi ölmüş olsa da) olmalı. { bekci: [...], node: [...] }
function bizimSurecler() {
  const ust = [...izlenen].filter(Boolean).join(',') || '0';
  const komut = `$t = [DateTimeOffset]::FromUnixTimeMilliseconds(${T0}).LocalDateTime; $u = @(${ust}); `
    + `@(Get-CimInstance Win32_Process | Where-Object { $_.CreationDate -ge $t } | ForEach-Object { `
    + `if ($_.CommandLine -and $_.CommandLine.Contains('${PS1.replace(/'/g, "''")}') -and $_.CommandLine -match '-Islem\\s+bekci') { "b$($_.ProcessId)" } `
    + `elseif ($_.Name -eq 'node.exe' -and $u -contains [int]$_.ParentProcessId) { "n$($_.ProcessId)" } }) -join ','`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', komut], { encoding: 'utf8' });
  const l = (r.stdout || '').trim().split(',').filter(Boolean);
  return { bekci: l.filter((x) => x[0] === 'b').map((x) => Number(x.slice(1))), node: l.filter((x) => x[0] === 'n').map((x) => Number(x.slice(1))) };
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
    konsol = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...ENV, REMOTE_DATA_DIR: path.join(tmp, 'konsol') }, stdio: 'ignore', windowsHide: true });
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

    // ---------- 7. Aynı anda iki başlat (çift tık / Run + elle): tek bekçi, durdurulabilir ----------
    // İkisi de PID dosyasını boş görüp birer bekçi açar; kilidi (adlı Mutex) alamayan bekçi hemen çıkmalı. Eskiden o da sunucu
    // açıyor (EADDRINUSE ile çöküyor), çalışan sunucuyu görünce durup PID dosyasını siliyordu: 'durdur' artık durduramıyordu.
    const t7 = log().length;
    const [c1, c2] = await Promise.all([psAsync('baslat'), psAsync('baslat')]);
    check('aynı anda iki başlat: ikisi de başarılı', c1.kod === 0 && c2.kod === 0, `${c1.out.trim()} | ${c2.out.trim()}`);
    for (const m of log().slice(t7).matchAll(/bekçi başlatıldı \(pid (\d+)/g)) izlenen.add(Number(m[1]));
    await sleep(2500); // artan bekçi (varsa) ikinci sunucuyu açıp çöksün
    let k7 = pidOku();
    if (k7) { izlenen.add(k7.bekci); izlenen.add(k7.node); }
    let l7 = log().slice(t7);
    check('PID dosyası duruyor: bekçi ve node canlı, port cevap veriyor', !!k7 && canli(k7.bekci) && canli(k7.node) && (await cevap()), JSON.stringify(k7));
    const s7 = bizimSurecler();
    check('tek bekçi çalışıyor (PID dosyasındaki)', s7.bekci.length === 1 && s7.bekci[0] === k7?.bekci, JSON.stringify(s7));
    check('ikinci sunucu açılmadı (çökme yok)', (l7.match(/\] sunucu başlatıldı/g) || []).length === 1 && !/beklenmedik şekilde kapandı/.test(l7), l7.trim().slice(-600));
    if ((l7.match(/bekçi başlatıldı/g) || []).length > 1) check('yarışan ikinci bekçi kilidi alamayıp çıktı', /bu kopya çıkıyor/.test(l7));
    else console.log('     (iki başlat bu sefer yarışmadı: ikincisi PID dosyasını gördü)');
    // Yarışı her seferinde garanti etmek için: bekçi çalışırken doğrudan ikinci bekçi
    const b7 = ps('bekci');
    l7 = log().slice(t7);
    const k7b = pidOku();
    check('doğrudan ikinci bekçi: kilit alınamadı, hemen çıktı, PID dosyasına dokunmadı',
      b7.kod === 0 && /bu kopya çıkıyor/.test(l7) && k7b?.bekci === k7?.bekci && k7b?.node === k7?.node && bizimSurecler().bekci.length === 1, JSON.stringify(k7b));
    const d7 = ps('durdur');
    check('durdur: aynı anda başlatılan sunucu durduruldu', d7.kod === 0 && /durduruldu/.test(d7.out), d7.out.trim());
    await sleep(500);
    check('port artık cevap vermiyor, bekçi kalmadı', !(await cevap()) && !bizimSurecler().bekci.length);
  } catch (e) {
    check(`beklenmeyen hata: ${e.stack}`, false);
  } finally {
    // Temizlik: yalnızca bu testin (hâlâ çalışan) süreçleri
    const k = pidOku();
    if (k) { izlenen.add(k.bekci); izlenen.add(k.node); }
    for (const m of log().matchAll(/bekçi başlatıldı \(pid (\d+)/g)) izlenen.add(Number(m[1])); // PID dosyasında olmayan artan bekçi
    const s = bizimSurecler();
    for (const pid of [...s.bekci, ...s.node]) killTree(pid);
    if (konsol && konsol.exitCode === null && konsol.signalCode === null) killTree(konsol.pid);
    await sleep(500);
    if (process.exitCode) console.log(`--- günlük (son) ---\n${log().slice(-2500)}`);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`${pass} kontrol geçti`);
})();
