// @ortam REMOTE_ESLESTIR_SURE_MS=3000
// @ortam REMOTE_ESLESTIR_ONAY_MS=2500
// QR kodla telefon eşleştirme: QR kodlayıcı (lib/qr.js) birim testleri + belirteç akışı (features/eslestir.js).
// Kodlayıcı, ISO 18004'teki bilinen değerlerle (biçim/sürüm bilgisi, Reed-Solomon örneği) ve bağımsız bir referans
// uygulamanın (qrcode-generator 1.4.4, MIT) ürettiği matrislerin özetleriyle karşılaştırılır.
// "Telefon" bağlantıları X-Forwarded-For ile tailscale serve'den geliyormuş gibi açılır (her senaryoya ayrı IP:
// kaba kuvvet kilidi IP başına).
const path = require('path');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..');
const WebSocket = require(path.join(ROOT, 'node_modules', 'ws'));
const qr = require(path.join(ROOT, 'lib', 'qr'));
const URL = `ws://localhost:${process.env.TEST_PORT || 3999}`;
const SURE_MS = 3000, ONAY_MS = 2500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${name} ${extra}`);
  if (cond) pass++; else process.exitCode = 1;
}

function client(ip) {
  const ws = new WebSocket(URL, ip ? { headers: { 'X-Forwarded-For': ip } } : {});
  const queue = [];
  const waiters = [];
  ws.on('message', (d, bin) => {
    if (bin) return;
    const msg = JSON.parse(d.toString());
    const i = waiters.findIndex((w) => w.pred(msg));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg); else queue.push(msg);
  });
  const next = (pred = () => true, ms = 8000) => {
    const i = queue.findIndex(pred);
    if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      waiters.push(w);
      setTimeout(() => { const k = waiters.indexOf(w); if (k >= 0) waiters.splice(k, 1); reject(new Error('zaman aşımı')); }, ms);
    });
  };
  const none = async (pred, ms) => { try { await next(pred, ms); return false; } catch { return true; } };
  const send = (o) => ws.send(JSON.stringify(o));
  const opened = new Promise((r) => ws.on('open', r));
  const closed = new Promise((r) => ws.on('close', (c) => r(c)));
  return { ws, next, none, send, opened, closed };
}
const t = (type) => (m) => m.t === type;

// ---------- 1. QR kodlayıcı ----------

function birimTestleri() {
  // ISO/IEC 18004 Tablo C.1: seviye M biçim bilgisi (maske 0..7)
  const FORMAT_M = [0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0];
  check('biçim bilgisi (M, maske 0–7) standart tabloyla aynı', FORMAT_M.every((v, i) => qr.formatBits(i) === v));
  // Tablo D.1: sürüm bilgisi
  check('sürüm bilgisi (7, 21, 40) standart tabloyla aynı', qr.versionBits(7) === 0x07c94 && qr.versionBits(21) === 0x15683 && qr.versionBits(40) === 0x28c69);
  // Ek I örneği: "01234567", 1-M veri kod sözcükleri ve 10 hata düzeltme kod sözcüğü
  const veri = [0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11];
  const ecc = qr.rsRemainder(veri, qr.rsDivisor(10));
  check('Reed-Solomon: standarttaki 1-M örneği', ecc.join(',') === [0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55].join(','), ecc.map((x) => x.toString(16)).join(' '));
  check('veri kod sözcüğü (M): sürüm 1=16, 6=108, 40=2334', qr.dataCodewords(1) === 16 && qr.dataCodewords(6) === 108 && qr.dataCodewords(40) === 2334);
  check('hizalama desenleri: sürüm 2, 7, 32', qr.alignmentPositions(2).join() === '6,18' && qr.alignmentPositions(7).join() === '6,22,38'
    && qr.alignmentPositions(32).join() === '6,34,60,86,112,138');

  // Referans uygulamanın (qrcode-generator 1.4.4, aynı metin + aynı maske) matrislerinin SHA-256 özeti (ilk 32 hane).
  const UZUN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdEfG';
  const ALTIN = [
    ['HELLO WORLD', 0, 1, '2cee776cd87923a0b50751b157fe74b2'],
    ['HELLO WORLD', 3, 1, '1e387bd8b7a170bfa73b461bab560d96'],
    ['HELLO WORLD', 6, 1, '84a0007f0e8c0dbac8c1c5b7ea46ab60'],
    [`https://desktop-abc1234.tailnet123.ts.net/#e=${UZUN}`, 0, 6, 'c0a03f732e822e5b66f7681952b0eda3'],
    [`https://desktop-abc1234.tailnet123.ts.net/#e=${UZUN}`, 3, 6, 'd7e14edaede3089201a1a7760c6ae8d8'],
    [`https://desktop-abc1234.tailnet123.ts.net/#e=${UZUN}`, 6, 6, '213b9837c08d4a6fecc052f6bd5de76c'],
    [`http://192.168.1.34:3080/#e=${UZUN}`, 0, 5, '5a091271e9bf04862e815ddb1c16120b'],
    [`http://192.168.1.34:3080/#e=${UZUN}`, 3, 5, 'c2c5dacd6bcc758012382ed4d81d72ec'],
    [`http://192.168.1.34:3080/#e=${UZUN}`, 6, 5, '5af43fa4452dc42c030615b75d707a82'],
    ['x'.repeat(300), 0, 13, 'a6c4c99a50e77d18b6ddfdcbd85fffbd'],
    ['x'.repeat(300), 3, 13, '06540e7d3086d1a1c7ae802f6c37eb98'],
    ['x'.repeat(300), 6, 13, '966f409b0f95894f7a52849253ebfd12'],
    ['Türkçe ğüşiöç İ', 0, 2, '167b2dce685c35576287a8e2855c85bf'],
    ['Türkçe ğüşiöç İ', 3, 2, 'f3dbbcd467f91d3ac2db8885673aabff'],
    ['Türkçe ğüşiöç İ', 6, 2, 'e793bd0a0d93c93a47abf3126fa10b30'],
  ];
  const ozet = (m) => crypto.createHash('sha256').update(m.map((r) => r.map((c) => (c ? '1' : '0')).join('')).join('\n')).digest('hex').slice(0, 32);
  const farkli = ALTIN.filter(([metin, mask, surum, h]) => {
    const e = qr.encode(metin, { mask });
    return e.version !== surum || e.size !== surum * 4 + 17 || ozet(e.modules) !== h;
  });
  check('referans uygulamayla bit bit aynı (5 metin × 3 maske, sürüm 1–13, UTF-8)', farkli.length === 0, farkli.map((x) => `${x[0].slice(0, 12)}/${x[1]}`).join(', '));

  // Otomatik maske: en düşük ceza puanlı maske seçilir; matristen biçim bilgisi geri okunabilir.
  const url = `https://desktop-abc1234.tailnet123.ts.net/#e=${crypto.randomBytes(32).toString('base64url')}`;
  const e = qr.encode(url);
  const puanlar = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => qr.penalty(qr.encode(url, { mask: k }).modules));
  check('maske: en düşük ceza puanlısı seçildi', puanlar[e.mask] === Math.min(...puanlar), `maske ${e.mask}, puanlar ${puanlar.join('/')}`);
  let okunan = 0;
  for (let i = 0; i <= 5; i++) okunan |= (e.modules[i][8] ? 1 : 0) << i;
  okunan |= (e.modules[7][8] ? 1 : 0) << 6;
  okunan |= (e.modules[8][8] ? 1 : 0) << 7;
  okunan |= (e.modules[8][7] ? 1 : 0) << 8;
  for (let i = 9; i < 15; i++) okunan |= (e.modules[8][14 - i] ? 1 : 0) << i;
  check('matristeki biçim bilgisi: seviye M + seçilen maske', okunan === qr.formatBits(e.mask), `${okunan.toString(16)}`);
  check('eşleştirme adresi (90 karakter) sürüm 6 (41×41) ile sığıyor', e.version === 6 && e.size === 41);
  const s = qr.svg(url);
  check('SVG: sessiz kenarlı viewBox, beyaz zemin, tek path', /^<svg [^>]*viewBox="0 0 49 49"/.test(s) && s.includes('fill="#fff"') && (s.match(/<path/g) || []).length === 1);
  let hata = '';
  try { qr.encode('x'.repeat(2400)); } catch (er) { hata = er.message; }
  check('çok uzun metin anlamlı hata verir', /uzun/.test(hata), hata);
}

// ---------- 2. Belirteç akışı ----------

async function giris(c, username, password) {
  await c.next(t('hello'));
  c.send({ t: 'login', username, password, remember: false, deviceName: 'Test' });
  return c.next(t('auth'));
}

async function qrAl(pc) {
  pc.send({ t: 'eslestir-olustur' });
  const m = await pc.next((x) => x.t === 'eslestir-qr' || x.t === 'eslestir-hata');
  return { m, belirtec: m.url ? m.url.split('#e=')[1] : null };
}

async function telefon(ip, belirtec, deviceName = 'iPhone · Safari') {
  const c = client(ip);
  await c.next(t('hello'));
  c.send({ t: 'eslestir', belirtec, deviceName });
  return c;
}

async function akisTestleri() {
  // Kurulum: bu bilgisayardan yönetici
  const pc = client();
  await pc.next(t('hello'));
  pc.send({ t: 'setup', username: 'yonetici', password: 'gizli123', remember: false, deviceName: 'PC' });
  const a = await pc.next(t('auth'));
  check('yönetici oluşturuldu (bu bilgisayar)', a.ok && a.role === 'admin');
  check('bu bilgisayardaki yöneticiye "eslestir-izin" geldi', !!(await pc.next(t('eslestir-izin'), 3000).catch(() => null)));

  // QR oluşturma
  let { m, belirtec } = await qrAl(pc);
  check('QR oluşturuldu: adres + #e=<43 karakter>', m.t === 'eslestir-qr' && /^(https:\/\/[a-z0-9.-]+|http:\/\/\d+\.\d+\.\d+\.\d+:\d+)\/#e=[A-Za-z0-9_-]{43}$/.test(m.url), m.url && m.url.replace(/#e=.*/, '#e=…'));
  check('QR: belirteç yalnızca parça (#) kısmında, adres alanında yok', m.adres && !m.adres.includes(belirtec) && m.url.startsWith(`${m.adres}/#e=`));
  check('QR: SVG, kullanıcı ve süre', /^<svg /.test(m.svg) && m.kullanici === 'yonetici' && m.rol === 'Yönetici' && m.sureMs === SURE_MS, `(${m.adresTuru})`);
  const { belirtec: b2 } = await qrAl(pc);
  check('her QR yeni, yüksek entropili belirteç', b2 !== belirtec && Buffer.from(b2, 'base64url').length === 32);

  // Eski QR (aynı ekranda yenisi oluşturuldu) geçersiz
  let tel = await telefon('100.100.1.1', belirtec);
  let r = await tel.next(t('auth'));
  check('yenisi oluşturulunca eski QR geçersiz', !r.ok && /süresi dolmuş|kullanılmış/.test(r.error), r.error);
  tel.ws.close();
  belirtec = b2;

  // tailscale serve üzerinden (X-Forwarded-For taklidi) yönetici: QR oluşturamaz
  const uzak = client('100.100.0.5');
  r = await giris(uzak, 'yonetici', 'gizli123');
  check('Tailscale üzerinden yönetici girişi', r.ok && r.role === 'admin');
  check('Tailscale üzerinden gelen yöneticiye izin gönderilmedi', await uzak.none(t('eslestir-izin'), 600));
  const uz = await qrAl(uzak);
  check('Tailscale (X-Forwarded-For) üzerinden QR oluşturulamaz', uz.m.t === 'eslestir-hata' && !uz.belirtec, uz.m.hata);
  uzak.ws.close();

  // Bu bilgisayardaki ama yönetici olmayan kullanıcı
  pc.send({ t: 'admin', op: 'addUser', username: 'kontrolcu', password: 'kontrol123', role: 'control' });
  await pc.next(t('adminData'));
  const kc = client();
  r = await giris(kc, 'kontrolcu', 'kontrol123');
  kc.send({ t: 'eslestir-olustur' });
  const ke = await kc.next((x) => x.t === 'error' || x.t === 'eslestir-qr' || x.t === 'eslestir-hata');
  check('yönetici olmayan kullanıcı QR oluşturamaz', ke.t === 'error', ke.msg || ke.t);
  kc.ws.close();

  // Reddetme
  tel = await telefon('100.100.2.1', belirtec);
  const p = await tel.next((x) => x.t === 'pending' || x.t === 'auth');
  check('telefon: onay bekleniyor', p.t === 'pending' && p.eslestir === true);
  const istek = await pc.next(t('eslestir-istek'));
  check('bilgisayara istek geldi (cihaz adı, IP, yol)', istek.cihaz === 'iPhone · Safari' && istek.ip === '100.100.2.1' && istek.via === 'Tailscale', JSON.stringify(istek));
  // Onaysız giriş yok: bekleme sırasında görüntü/giriş mesajları işlenmez
  tel.send({ t: 'start', mode: 'control' });
  tel.send({ t: 'token', token: 'x'.repeat(43) });
  check('onay beklerken görüntü başlamaz', await tel.none((x) => x.t === 'started' || x.t === 'auth', 700));
  pc.send({ t: 'eslestir-cevap', onay: false });
  r = await tel.next(t('auth'));
  check('reddedilince giriş yok', !r.ok && /reddedildi/.test(r.error), r.error);
  let s = await pc.next(t('eslestir-sonuc'));
  check('bilgisayara "reddedildi" sonucu', s.ok === false);
  tel.send({ t: 'start', mode: 'control' });
  check('reddedilen telefon görüntü alamaz', await tel.none(t('started'), 600));
  tel.ws.close();

  // Tek kullanım: reddedilen belirteç tekrar kullanılamaz
  tel = await telefon('100.100.2.2', belirtec);
  r = await tel.next(t('auth'));
  check('tek kullanımlık: kullanılmış belirteç reddedildi', !r.ok && /kullanılmış/.test(r.error), r.error);
  tel.ws.close();

  // Onay
  ({ belirtec } = await qrAl(pc));
  tel = await telefon('100.100.3.1', belirtec);
  await tel.next(t('pending'));
  await pc.next(t('eslestir-istek'));
  pc.send({ t: 'eslestir-cevap', onay: true });
  r = await tel.next(t('auth'));
  check('onaylanınca giriş: QR\'ı oluşturan yöneticinin hesabı', r.ok && r.username === 'yonetici' && r.role === 'admin');
  check('onaylanınca cihaz anahtarı verildi (hatırlama)', typeof r.token === 'string' && r.token.length >= 40);
  s = await pc.next(t('eslestir-sonuc'));
  check('bilgisayara "bağlandı" sonucu', s.ok === true && s.cihaz === 'iPhone · Safari');
  check('telefona eslestir-izin gönderilmedi (bu bilgisayar değil)', await tel.none(t('eslestir-izin'), 500));
  tel.ws.close();
  await tel.closed;
  const tel2 = client('100.100.3.1');
  await tel2.next(t('hello'));
  tel2.send({ t: 'token', token: r.token });
  const r2 = await tel2.next(t('auth'));
  check('hatırlanan cihaz: anahtarla şifresiz giriş', r2.ok && r2.username === 'yonetici');
  tel2.ws.close();
  pc.send({ t: 'admin', op: 'list' });
  const ad = await pc.next(t('adminData'));
  check('yönetimde hatırlanan cihaz listede', ad.devices.some((d) => d.name === 'iPhone · Safari' && d.username === 'yonetici'));
  check('günlükte QR eşleştirme', ad.log.some((l) => l.event === 'admin' && l.op === 'qr-eslestir'));

  // Süre dolması
  ({ belirtec } = await qrAl(pc));
  await sleep(SURE_MS + 400);
  tel = await telefon('100.100.4.1', belirtec);
  r = await tel.next(t('auth'));
  check('süresi dolan QR reddedildi', !r.ok && /süresi dolmuş/.test(r.error), r.error);
  tel.ws.close();

  // Onay süresi dolması
  ({ belirtec } = await qrAl(pc));
  tel = await telefon('100.100.5.1', belirtec);
  await tel.next(t('pending'));
  await pc.next(t('eslestir-istek'));
  r = await tel.next(t('auth'), ONAY_MS + 3000);
  check('bilgisayarda cevap verilmezse süre dolunca giriş yok', !r.ok, r.error);
  await pc.next(t('eslestir-sonuc'));
  tel.ws.close();

  // QR ekranı kapatıldı
  ({ belirtec } = await qrAl(pc));
  pc.send({ t: 'eslestir-kapat' });
  await sleep(200);
  tel = await telefon('100.100.6.1', belirtec);
  r = await tel.next(t('auth'));
  check('QR ekranı kapatılınca belirteç geçersiz', !r.ok, r.error);
  tel.ws.close();

  // QR'ı oluşturan bağlantı kapandı
  const pc2 = client();
  await pc2.next(t('hello'));
  pc2.send({ t: 'login', username: 'yonetici', password: 'gizli123' });
  await pc2.next(t('auth'));
  const q2 = await qrAl(pc2);
  pc2.ws.close();
  await pc2.closed;
  await sleep(200);
  tel = await telefon('100.100.7.1', q2.belirtec);
  r = await tel.next(t('auth'));
  check('QR\'ı oluşturan oturum kapanınca belirteç geçersiz', !r.ok, r.error);
  tel.ws.close();

  // Telefon onay beklerken ayrılırsa bilgisayara bildirilir
  ({ belirtec } = await qrAl(pc));
  tel = await telefon('100.100.8.1', belirtec);
  await tel.next(t('pending'));
  await pc.next(t('eslestir-istek'));
  tel.ws.close();
  s = await pc.next(t('eslestir-sonuc'), 4000).catch(() => null);
  check('telefon ayrılınca bilgisayardaki istek kapandı', s && s.ok === false, s && s.neden);

  // Bozuk belirteç
  tel = await telefon('100.100.8.2', 'kısa<script>');
  r = await tel.next(t('auth'));
  check('bozuk belirteç reddedildi', !r.ok, r.error);
  tel.ws.close();

  // Kaba kuvvet: aynı IP'den 5 hatalı denemeden sonra geçerli belirteç bile kabul edilmez
  const ip = '100.100.9.9';
  for (let i = 0; i < 5; i++) {
    tel = await telefon(ip, crypto.randomBytes(32).toString('base64url'));
    await tel.next(t('auth'));
    tel.ws.close();
  }
  ({ belirtec } = await qrAl(pc));
  tel = await telefon(ip, belirtec);
  r = await tel.next(t('auth'));
  check('kaba kuvvet: 5 hatalı denemeden sonra kilit', !r.ok && /Çok fazla/.test(r.error), r.error);
  check('kilitliyken bilgisayara istek gitmedi', await pc.none(t('eslestir-istek'), 500));
  tel.ws.close();
  pc.ws.close();
}

(async () => {
  try {
    birimTestleri();
    await akisTestleri();
  } catch (e) {
    check('test tamamlandı', false, e.stack);
  }
  console.log(`\n${pass} kontrol geçti${process.exitCode ? ', HATA VAR' : ''}`);
  process.exit(process.exitCode || 0);
})();
