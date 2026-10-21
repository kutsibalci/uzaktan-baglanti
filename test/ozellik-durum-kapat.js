// Bilgisayar durumu: GERÇEK program kapatma — yalnızca bu testin kendi başlattığı zararsız node alt süreçleri kapatılır.
// Pencere yok -> nazik kapatma "penceresi yok" der, hemen "hâlâ açık" denetimi gelir -> zorla kapatma süreci gerçekten bitirir.
// Grup: cmd.exe -> node kök -> 2 node çocuk (kendi grubumuz); listedeki grubun Kapat'ı üç süreci de PID + başlama zamanıyla kapatır.
// Başka hiçbir PID'e kapatma isteği gönderilmez.
// @ortam REMOTE_DURUM_KURU=0
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const WebSocket = require(path.join(ROOT, 'node_modules', 'ws'));
const URL = `ws://localhost:${process.env.TEST_PORT || 3999}`;

function client() {
  const ws = new WebSocket(URL);
  const queue = [];
  const waiters = [];
  ws.on('message', (d, bin) => {
    const msg = bin ? { t: 'frame' } : JSON.parse(d.toString());
    const i = waiters.findIndex((w) => w.pred(msg));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg); else queue.push(msg);
  });
  const next = (pred = () => true, ms = 8000) => {
    const i = queue.findIndex(pred);
    if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      waiters.push(w);
      setTimeout(() => {
        const j = waiters.indexOf(w);
        if (j < 0) return;
        waiters.splice(j, 1);
        reject(new Error('timeout waiting'));
      }, ms);
    });
  };
  const send = (o) => ws.send(JSON.stringify(o));
  return { ws, next, send };
}
const t = (type) => (m) => m.t === type;
let pass = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${name} ${extra}`);
  if (cond) pass++; else process.exitCode = 1;
}
const canli = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Kendi grubumuz (ozellik-durum.js'teki gibi): cmd.exe araya girer ki kök bu testin node zincirine bağlanmasın. Her süreç ~100 MB
// tutar ki grup arka planın "en çok RAM" listesinde görünsün.
const GRUP_JS = `const { spawn } = require('child_process');
const [, , n, ms, mb, rol] = process.argv;
const tut = Buffer.alloc(Number(mb) * 2 ** 20, 1);
if (rol !== 'cocuk') {
  const c = [];
  for (let i = 0; i < Number(n); i++) c.push(spawn(process.execPath, [__filename, '0', ms, mb, 'cocuk'], { stdio: 'ignore', windowsHide: true }));
  console.log(JSON.stringify([process.pid, ...c.map((x) => x.pid)]));
}
setTimeout(() => tut.length, Number(ms));`;

(async () => {
  const cocuk = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore', windowsHide: true });
  let bitti = false;
  const cikis = new Promise((r) => cocuk.on('exit', () => { bitti = true; r(); }));
  const js = path.join(process.env.TEST_TMP || os.tmpdir(), `durum-kapat-grup-${process.pid}.js`);
  fs.writeFileSync(js, GRUP_JS);
  const cmd = spawn('cmd.exe', ['/d', '/s', '/c', `""${process.execPath}" "${js}" 2 120000 100"`],
    { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, windowsVerbatimArguments: true });
  let grup = [];
  try {
    grup = await new Promise((resolve, reject) => {
      let s = '';
      cmd.stdout.on('data', (d) => { s += d; if (s.includes('\n')) resolve(JSON.parse(s)); });
      setTimeout(() => reject(new Error('grup başlatılamadı')), 15000);
    });
    const a = client();
    await a.next(t('hello'));
    a.send({ t: 'setup', username: 'ahmet', password: 'gizli123', remember: false });
    check('yönetici oluşturuldu', (await a.next(t('auth'))).ok);
    // Panel açık: listedeki başlama zamanını (ct) kullanmak için abone ol
    a.send({ t: 'durum-abone', acik: true });
    // Durum.exe yeni derlendiyse ilk ölçüm (ve dosya açıklamalarının ilk okunuşu) birkaç saniye sürebilir
    await a.next(t('durum-ilk'), 15000);

    a.send({ t: 'durum-kapat', pid: cocuk.pid, ct: '1', zorla: true });
    let r = await a.next(t('durum-kapat-sonuc'));
    check('yanlış başlama zamanıyla kapatılmadı', !r.ok && !bitti, r.msg);

    a.send({ t: 'durum-kapat', pid: cocuk.pid });
    r = await a.next(t('durum-kapat-sonuc'));
    check('nazik: penceresiz süreç için "penceresi yok"', r.ok && r.kuru === false && r.asama === 'nazik' && r.pencere === 0 && /Penceresi yok/.test(r.msg), JSON.stringify(r));
    r = await a.next(t('durum-kapat-sonuc'));
    check('  hemen "hâlâ açık" denetimi (Zorla kapat sunulur)', r.asama === 'kontrol' && r.hala === true && !bitti, JSON.stringify(r));

    a.send({ t: 'durum-kapat', pid: cocuk.pid, ct: r.ct, zorla: true });
    r = await a.next(t('durum-kapat-sonuc'));
    check('zorla kapatma başarılı', r.ok && r.asama === 'zorla' && r.kuru === false, JSON.stringify(r));
    await Promise.race([cikis, new Promise((res) => setTimeout(res, 3000))]);
    check('  alt süreç gerçekten kapandı', bitti);

    a.send({ t: 'durum-kapat', pid: cocuk.pid, zorla: true });
    r = await a.next(t('durum-kapat-sonuc'));
    check('kapanmış süreç tekrar kapatılamaz', !r.ok && /kapanmış/.test(r.msg), r.msg);

    // ---- Grup: listedeki satırın üyeleri (PID + ct) ----
    let g = null;
    for (let i = 0; i < 15 && !g; i++) {
      const m = await a.next(t('durum'), 12000);
      g = (m.gruplar || []).find((x) => x.pid === grup[0]);
    }
    const sirali = (l) => [...l].sort((x, y) => x - y).join();
    check('kendi grubumuz listede: 3 süreç, korumasız', g && g.n === 3 && !g.koruma && sirali(g.uyeler.map((u) => u[0])) === sirali(grup), g ? `${g.ad} (${g.n})` : grup.join());
    if (g) {
      a.send({ t: 'durum-kapat', surecler: g.uyeler.map(([pid]) => [pid, '1']), zorla: true });
      r = await a.next(t('durum-kapat-sonuc'));
      check('grup: yanlış başlama zamanlarıyla hiçbiri kapatılmadı', !r.ok && grup.every(canli), r.msg);
      a.send({ t: 'durum-kapat', pid: g.pid, ct: g.ct, surecler: g.uyeler, ad: g.ad });
      r = await a.next(t('durum-kapat-sonuc'));
      check('grup nazik: penceresiz, 3 süreç hedeflendi', r.ok && r.kuru === false && r.asama === 'nazik' && r.adet === 3 && r.pencere === 0, JSON.stringify(r));
      r = await a.next(t('durum-kapat-sonuc'));
      check('  hemen "hâlâ açık (3)" denetimi', r.asama === 'kontrol' && r.hala === true && r.kalan.length === 3 && grup.every(canli), JSON.stringify(r.kalan));
      a.send({ t: 'durum-kapat', pid: r.pid, ct: r.ct, surecler: r.kalan, ad: r.ad, zorla: true });
      r = await a.next(t('durum-kapat-sonuc'));
      check('grup zorla kapatma başarılı (3 süreç)', r.ok && r.asama === 'zorla' && r.kuru === false && r.kapatilan === 3, JSON.stringify(r));
      for (let i = 0; i < 30 && grup.some(canli); i++) await sleep(100);
      check('  grubun üç süreci de gerçekten kapandı', !grup.some(canli), grup.filter(canli).join(','));
      a.send({ t: 'durum-kapat', surecler: g.uyeler, zorla: true });
      r = await a.next(t('durum-kapat-sonuc'));
      check('  kapanmış grup tekrar kapatılamaz', !r.ok && /kapanmış/.test(r.msg), r.msg);
    }
  } finally {
    if (!bitti) cocuk.kill();
    // Yalnızca kendi PID'lerimiz (ağacıyla).
    spawnSync('taskkill', ['/pid', String(cmd.pid), '/T', '/F'], { stdio: 'ignore' });
    for (const pid of grup) { try { process.kill(pid); } catch { /* kapanmış */ } }
  }
  console.log(`\n${pass} kontrol geçti`);
  process.exit();
})().catch((e) => { console.error('TEST HATASI', e); process.exit(1); });
