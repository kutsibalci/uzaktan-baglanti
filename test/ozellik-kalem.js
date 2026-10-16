// Tablet kalemi testi.
// GERÇEK KALEM GİRDİSİ ENJEKTE EDİLMEZ: geçerli bir "pen down" gönderilmez. Yalnızca:
//  - RemoteHelper "pentest" ile sentetik kalem cihazının oluşturulabildiği (girdi göndermeden),
//  - geçersiz "pen" satırlarının yardımcıyı çökertmediği,
//  - features/kalem.js komut üretiminin değerleri sıkıca doğrulayıp kıstırdığı
// sınanır. Gerçek tablet kalemiyle uçtan uca test DONANIM gerektirir ve burada yapılamaz (raporda belirtildi).
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const WebSocket = require(path.join(ROOT, 'node_modules', 'ws'));
const { Helper } = require(path.join(ROOT, 'lib', 'helper'));
const { komutOlustur } = require(path.join(ROOT, 'features', 'kalem.js'));
const URL = `ws://localhost:${process.env.TEST_PORT || 3999}`;

let fails = 0;
const check = (n, c, x = '') => { console.log(`${c ? 'OK  ' : 'FAIL'} ${n} ${x}`); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const killTree = (pid) => { if (pid) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }); };

const EKRAN = '\\\\.\\DISPLAY1';

function komutTestleri() {
  // Geçerli komut biçimi.
  const c = komutOlustur(EKRAN, { durum: 'hover', x: 0.5, y: 0.25, p: 500, tx: 10, ty: -20, silgi: 0 });
  check('komut: geçerli girdi doğru biçimde', c === `pen ${EKRAN} 0.50000 0.25000 500 hover 10 -20 0`, c);

  // Kıstırma: aralık dışı basınç/eğim ve 0..1 dışı konum.
  const c2 = komutOlustur(EKRAN, { durum: 'move', x: 2, y: -1, p: 99999, tx: 999, ty: -999, silgi: true });
  check('komut: değerler kıstırılıyor', c2 === `pen ${EKRAN} 1.00000 0.00000 1024 move 90 -90 1`, c2);

  // Geçersizler null dönmeli (yardımcıya hiç gitmez).
  check('komut: geçersiz ekran adı reddedilir', komutOlustur('DISPLAY1; rm', { durum: 'move', x: 0.1, y: 0.1 }) === null);
  check('komut: enjeksiyon denemesi (satır sonu) reddedilir', komutOlustur('\\\\.\\DISPLAY1\nmove', { durum: 'move', x: 0, y: 0 }) === null);
  check('komut: bilinmeyen durum reddedilir', komutOlustur(EKRAN, { durum: 'press', x: 0.1, y: 0.1 }) === null);
  check('komut: sayı olmayan konum reddedilir', komutOlustur(EKRAN, { durum: 'move', x: 'x', y: 0.1 }) === null);
  check('komut: NaN konum reddedilir', komutOlustur(EKRAN, { durum: 'move', x: NaN, y: 0.1 }) === null);
  check('komut: eksik mesaj reddedilir', komutOlustur(EKRAN, null) === null);
  // Üretilen komutta boşluk/satır sonu enjeksiyonu olamaz (yalnızca sayı + sabit durum + doğrulanmış ekran).
  check('komut: çıktıda satır sonu yok', !/[\r\n]/.test(c2));
}

async function helperTestleri() {
  const helper = new Helper();
  try {
    // Yardımcı canlı mı?
    const info = await helper.info();
    check('yardımcı çalışıyor', Array.isArray(info.screens));

    // pentest: sentetik kalem cihazı oluşturulabiliyor mu + yapı boyutları (x64 P/Invoke düzeni).
    const pt = JSON.parse((await helper.request('pentest')).toString());
    check('pentest cevabı JSON', typeof pt.ok === 'boolean', JSON.stringify(pt));
    check('yapı boyutları x64 winuser.h ile uyumlu',
      pt.x64 === true && pt.boyut && pt.boyut[0] === 96 && pt.boyut[1] === 120 && pt.boyut[2] === 152,
      pt.boyut ? `POINTER_INFO=${pt.boyut[0]} PEN=${pt.boyut[1]} TYPE=${pt.boyut[2]}` : '');
    // Cihaz oluşturma donanım/oturum gerektirebilir; oluşamazsa anlamlı hata dönmeli (çökmemeli).
    check('sentetik kalem cihazı sonucu', pt.ok || !!pt.hata, pt.ok ? 'oluşturuldu' : pt.hata);

    // Geçersiz pen satırları: yardımcı çökmemeli (gerçek girdi göndermiyoruz).
    helper.send('pen');
    helper.send('pen bozuk ekran a b c d e');
    helper.send(`pen ${EKRAN} 0.5 0.5 -5 press 999 999 2`);
    helper.send('pen \\\\.\\DISPLAY1 abc def 0 move 0 0 0');
    await sleep(200);
    const info2 = await helper.info();
    check('geçersiz pen satırlarından sonra yardımcı hâlâ ayakta', Array.isArray(info2.screens));
  } finally {
    try { killTree(helper.proc && helper.proc.pid); } catch {}
  }
}

function wsTesti() {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL);
    const kuyruk = []; const bekle = [];
    ws.on('message', (d, bin) => {
      if (bin) return;
      const m = JSON.parse(d.toString());
      const i = bekle.findIndex((w) => w.pred(m));
      if (i >= 0) { const w = bekle.splice(i, 1)[0]; clearTimeout(w.timer); w.res(m); } else kuyruk.push(m);
    });
    const next = (pred, ms = 8000) => new Promise((res, rej) => { const w = { pred, res }; bekle.push(w); w.timer = setTimeout(() => rej(new Error('timeout')), ms); });
    const take = (pred, ms) => { const i = kuyruk.findIndex(pred); return i >= 0 ? Promise.resolve(kuyruk.splice(i, 1)[0]) : next(pred, ms); };
    const send = (o) => ws.send(JSON.stringify(o));
    (async () => {
      try {
        const hello = await take((m) => m.t === 'hello');
        send(hello.canSetup ? { t: 'setup', username: 'kalem', password: 'kalem1234' } : { t: 'login', username: 'kalem', password: 'kalem1234' });
        const auth = await take((m) => m.t === 'auth');
        check('WS: giriş yapıldı', auth.ok);
        send({ t: 'kalem-destek' });
        const d = await take((m) => m.t === 'kalem-destek');
        check('WS: kalem-destek cevabı geldi', typeof d.ok === 'boolean', d.ok ? 'destekleniyor' : (d.hata || ''));
        // İzleme başlamadan gelen kalem mesajı sessizce yok sayılır (hata/çökme olmamalı).
        send({ t: 'kalem', durum: 'hover', x: 0.5, y: 0.5, p: 0, tx: 0, ty: 0, silgi: 0 });
        send({ t: 'kalem-destek' });
        const d2 = await take((m) => m.t === 'kalem-destek');
        check('WS: izleme yokken kalem mesajı bağlantıyı bozmadı', typeof d2.ok === 'boolean');
      } catch (e) {
        check('WS: protokol', false, e.message);
      } finally {
        try { ws.close(); } catch {}
        resolve();
      }
    })();
  });
}

(async () => {
  try {
    komutTestleri();
    await helperTestleri();
    await wsTesti();
  } catch (e) {
    console.error('TEST HATASI', e);
    fails++;
  }
  console.log(fails ? `\n${fails} HATA` : '\nhepsi geçti');
  process.exit(fails ? 1 : 0);
})();
