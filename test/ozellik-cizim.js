// Çizim tableti: kısayol profilleri, kombinasyon mesajları, sunucunun basılı tuşları bırakması ve kalem hız sınırı.
// GERÇEK GİRDİ YOK: sunucu özellikleri sahte bir api ile (helper.send yakalanır) çalıştırılır; yardımcı programa,
// dolayısıyla bilgisayara hiçbir tuş/kalem olayı gitmez. Tarayıcı tarafı: test/ozellik-cizim-tarayici.js.
// @sunucu yok
const path = require('path');
const ROOT = path.join(__dirname, '..');
const C = require(path.join(ROOT, 'public', 'features', 'cizim.js'));
const cizim = require(path.join(ROOT, 'features', 'cizim.js'));
const kalem = require(path.join(ROOT, 'features', 'kalem.js'));

let fails = 0;
const check = (n, c, x = '') => { console.log(`${c ? 'OK  ' : 'FAIL'} ${n} ${x}`); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Sahte çekirdek: mesaj işleyicileri ve helper.send kaydedilir.
function sahteApi() {
  const h = new Map(), kapanis = [], komutlar = [];
  return {
    h, komutlar, clients: new Set(),
    helper: { send: (c) => komutlar.push(c), request: async () => Buffer.from('{"ok":true}') },
    sendJson() {}, log() {},
    on(t, fn) { h.set(t, fn); },
    onClose(fn) { kapanis.push(fn); },
    kapat(ws) { for (const f of kapanis) f(ws); },
    route() {}, onAuth() {}, adminData() {},
  };
}

function profilTestleri() {
  const k = (vks, basili) => C.kombinasyon(vks, basili).map((m) => `${m.vk}${m.down ? '↓' : '↑'}`).join(' ');
  check('kombinasyon: Ctrl+Z sırası', k([17, 90]) === '17↓ 90↓ 90↑ 17↑', k([17, 90]));
  check('kombinasyon: Ctrl+Shift+Z sırası (değiştiriciler ters sırayla bırakılır)', k([17, 16, 90]) === '17↓ 16↓ 90↓ 90↑ 16↑ 17↑', k([17, 16, 90]));
  check('kombinasyon: basılı tutulan Ctrl yeniden basılmaz ve bırakılmaz', k([17, 90], new Set([17])) === '90↓ 90↑', k([17, 90], new Set([17])));
  check('kombinasyon: tek tuş', k([66]) === '66↓ 66↑');
  const e = (d, p) => C.eylem(C.DUGMELER.find((x) => x.k === d), p);
  check('Photoshop: Yinele = Ctrl+Shift+Z', JSON.stringify(e('yinele', 'photoshop')) === '{"bas":[17,16,90]}');
  check('Photoshop: renk seçici = Alt basılı', JSON.stringify(e('renk', 'photoshop')) === '{"tut":18}');
  check('Krita: Yinele = Ctrl+Shift+Z, renk = Ctrl basılı', JSON.stringify(e('yinele', 'krita')) === '{"bas":[17,16,90]}' && JSON.stringify(e('renk', 'krita')) === '{"tut":17}');
  check('Clip Studio: Yinele = Ctrl+Y', JSON.stringify(e('yinele', 'csp')) === '{"bas":[17,89]}');
  check('Paint.NET: renk seçici aracı K', JSON.stringify(e('renk', 'paintnet')) === '{"bas":[75]}');
  check('Paint: fırça/silgi/renk yok, yakınlaştırma Ctrl+PageUp', !e('firca', 'paint') && !e('silgi', 'paint') && !e('renk', 'paint') && JSON.stringify(e('yakin', 'paint')) === '{"bas":[17,33]}');
  check('Boşluk her profilde basılı tutulur', Object.keys(C.PROFILLER).every((p) => JSON.stringify(e('bosluk', p)) === '{"tut":32}'));
  check('fırça küçült/büyüt [ ] (Photoshop, Krita, CSP, Paint.NET)', ['photoshop', 'krita', 'csp', 'paintnet'].every((p) => e('kucult', p).bas[0] === 219 && e('buyut', p).bas[0] === 221));
  check('bilinmeyen profil varsayılana (Photoshop) düşer', JSON.stringify(e('yinele', 'yok')) === '{"bas":[17,16,90]}');
  check('ipucu metni', C.ipucu({ bas: [17, 16, 90] }) === 'Ctrl+Shift+Z' && C.ipucu({ tut: 18 }) === 'Alt (basılı tut)', C.ipucu({ bas: [17, 16, 90] }));
  // Tüm kodlar sunucunun kabul ettiği aralıkta
  const hepsi = Object.keys(C.PROFILLER).flatMap((p) => C.DUGMELER.map((d) => C.eylem(d, p)).filter(Boolean).flatMap((x) => x.tut ? [x.tut] : x.bas));
  check('profillerdeki tüm tuş kodları geçerli', hepsi.every((vk) => cizim.tusKodu(vk) === vk), hepsi.length);
}

async function sunucuTestleri() {
  const api = sahteApi();
  cizim.init(api);
  const f = api.h.get('cizim-tus');
  const ws = { streaming: true };
  api.clients.add(ws);
  await f(ws, { t: 'cizim-tus', vk: 16, down: true });
  check('sunucu: basılı Shift yardımcıya key 16 1', api.komutlar.join('|') === 'key 16 1', api.komutlar.join('|'));
  await f(ws, { t: 'cizim-tus', vk: 16, down: false });
  check('sunucu: bırakış key 16 0', api.komutlar.join('|') === 'key 16 1|key 16 0');
  api.komutlar.length = 0;
  await f(ws, { t: 'cizim-tus', vk: 17, down: false });
  check('sunucu: basılmamış tuşun bırakılışı yok sayılır', api.komutlar.length === 0);
  for (const vk of [0, 255, -3, 1.5, '17', null]) await f(ws, { t: 'cizim-tus', vk, down: true });
  check('sunucu: geçersiz tuş kodları reddedilir', api.komutlar.length === 0, api.komutlar.join('|'));
  await f({ streaming: false }, { t: 'cizim-tus', vk: 17, down: true });
  check('sunucu: izleme yokken basış yok sayılır', api.komutlar.length === 0);
  for (let vk = 65; vk < 80; vk++) await f(ws, { t: 'cizim-tus', vk, down: true });
  check('sunucu: aynı anda en fazla 8 basılı tuş', api.komutlar.length === 8, api.komutlar.length);
  api.komutlar.length = 0;
  api.kapat(ws);
  check('sunucu: bağlantı kopunca basılı tuşların hepsi bırakılır', api.komutlar.length === 8 && api.komutlar.every((c) => / 0$/.test(c)), api.komutlar.join('|'));
  api.komutlar.length = 0;
  api.kapat(ws);
  check('sunucu: ikinci kapanışta tekrar bırakılmaz', api.komutlar.length === 0);
  // İzleme biterse (istemci up göndermeden) bir saniye içinde bırakılır.
  await f(ws, { t: 'cizim-tus', vk: 32, down: true });
  ws.streaming = false;
  api.komutlar.length = 0;
  await sleep(1300);
  check('sunucu: izleme bitince basılı Boşluk bırakılır', api.komutlar.join('|') === 'key 32 0', api.komutlar.join('|'));
  // İzleme bittikten sonra gelen bırakış da geçerli (istemci 'stop'tan sonra up gönderir)
  ws.streaming = true;
  await f(ws, { t: 'cizim-tus', vk: 18, down: true });
  ws.streaming = false;
  api.komutlar.length = 0;
  await f(ws, { t: 'cizim-tus', vk: 18, down: false });
  check('sunucu: izleme bittikten sonra gelen bırakış uygulanır', api.komutlar.join('|') === 'key 18 0', api.komutlar.join('|'));
}

async function kalemHizTesti() {
  const api = sahteApi();
  kalem.init(api);
  const f = api.h.get('kalem');
  const ws = { streaming: true, session: { view: { screen: '\\\\.\\DISPLAY1' } } };
  await f(ws, { t: 'kalem', durum: 'down', x: 0.1, y: 0.1, p: 500 });
  for (let i = 0; i < 300; i++) await f(ws, { t: 'kalem', durum: 'move', x: 0.1 + i / 1000, y: 0.1, p: 500 });
  const n240 = api.komutlar.length - 1;
  check('kalem: saniyede 300 nokta (240 Hz kalem + pay) atılmadan geçer', n240 === 300, n240);
  for (let i = 0; i < 400; i++) await f(ws, { t: 'kalem', durum: 'move', x: 0.5, y: 0.5, p: 500 });
  const hareket = api.komutlar.filter((c) => / move /.test(c)).length;
  check('kalem: sınır saniyede 480 hareket', hareket === 480, hareket);
  await f(ws, { t: 'kalem', durum: 'up', x: 0.5, y: 0.5 });
  check('kalem: sınırdayken de kalkış (up) gider', / up /.test(api.komutlar.at(-1)), api.komutlar.at(-1));
}

(async () => {
  try {
    profilTestleri();
    await sunucuTestleri();
    await kalemHizTesti();
  } catch (e) {
    console.error('TEST HATASI', e);
    fails++;
  }
  console.log(fails ? `\n${fails} HATA` : '\nhepsi geçti');
  process.exit(fails ? 1 : 0);
})();
