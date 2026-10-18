// Bilgisayar durumu: GERÇEK program kapatma — yalnızca bu testin kendi başlattığı zararsız node alt süreci kapatılır.
// Pencere yok -> nazik kapatma "penceresi yok" der, hemen "hâlâ açık" denetimi gelir -> zorla kapatma süreci gerçekten bitirir.
// Başka hiçbir PID'e kapatma isteği gönderilmez.
// @ortam REMOTE_DURUM_KURU=0
const path = require('path');
const { spawn } = require('child_process');
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

(async () => {
  const cocuk = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore', windowsHide: true });
  let bitti = false;
  const cikis = new Promise((r) => cocuk.on('exit', () => { bitti = true; r(); }));
  try {
    const a = client();
    await a.next(t('hello'));
    a.send({ t: 'setup', username: 'ahmet', password: 'gizli123', remember: false });
    check('yönetici oluşturuldu', (await a.next(t('auth'))).ok);
    // Panel açık: listedeki başlama zamanını (ct) kullanmak için abone ol
    a.send({ t: 'durum-abone', acik: true });
    await a.next(t('durum-ilk'));

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
  } finally {
    if (!bitti) cocuk.kill();
  }
  console.log(`\n${pass} kontrol geçti`);
  process.exit();
})().catch((e) => { console.error('TEST HATASI', e); process.exit(1); });
