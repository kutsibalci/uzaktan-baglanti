// Kumanda modu sunucu tarafı (features/kumanda.js) + iki parmak dokunuşu toleransı (public/dokunmatik.js, saf hesap).
// KURU MOD — hiçbir fare/klavye girdisi GÖNDERİLMEZ; sunucu gönderecek komutu 'kumanda-kuru' ile bildirir.
// İmleç yerini okuma (RemoteHelper "cursor") gerçek yapılır: yalnızca okur, girdi değildir.
// @ortam REMOTE_KUMANDA_KURU=1
const path = require('path');
const ROOT = path.join(__dirname, '..');
const WebSocket = require(path.join(ROOT, 'node_modules', 'ws'));
const T = require(path.join(ROOT, 'public', 'dokunmatik.js'));
const { ekranaSigdir } = require(path.join(ROOT, 'features', 'kumanda.js'));
const URL = `ws://localhost:${process.env.TEST_PORT || 3999}`;

if (process.env.REMOTE_KUMANDA_KURU !== '1') {
  console.log('FAIL REMOTE_KUMANDA_KURU=1 değil, test çalıştırılmadı (gerçek girdi riski)');
  process.exit(1);
}

function client() {
  const ws = new WebSocket(URL);
  const queue = [];
  const waiters = [];
  let frames = 0;
  ws.on('message', (d, bin) => {
    if (bin) { frames++; return; }
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
      setTimeout(() => {
        const k = waiters.indexOf(w);
        if (k < 0) return;
        waiters.splice(k, 1);
        reject(new Error('timeout waiting'));
      }, ms);
    });
  };
  const none = async (pred, ms = 800) => { try { await next(pred, ms); return false; } catch { return true; } };
  const send = (o) => ws.send(JSON.stringify(o));
  const closed = new Promise((r) => ws.on('close', (c) => r(c)));
  return { ws, next, none, send, closed, frames: () => frames };
}
const t = (type) => (m) => m.t === type;
const kuru = t('kumanda-kuru');
let fails = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${name} ${extra}`);
  if (!cond) { fails++; process.exitCode = 1; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Saf hesap: iki parmak dokunuşu sınırları ----
function saf() {
  const tap = (o) => T.isTwoFingerTap({ downGap: 0, upGap: 0, duration: 100, move: 0, acted: false, ...o });
  check('iki parmak: aynı anda, hareketsiz -> dokunuş', tap({}));
  check('iki parmak: 150 ms farkla inme / kalkma -> dokunuş', tap({ downGap: 150, upGap: 150 }));
  check('iki parmak: 151 ms farkla inme -> değil', !tap({ downGap: 151 }));
  check('iki parmak: 151 ms farkla kalkma -> değil', !tap({ upGap: 151 }));
  check('iki parmak: 500 ms sürdü -> dokunuş; 501 -> değil', tap({ duration: 500 }) && !tap({ duration: 501 }));
  check('iki parmak: 20 px kayma -> dokunuş; 21 -> değil', tap({ move: 20 }) && !tap({ move: 21 }));
  check('iki parmak: etkisi olan hareket (tekerlek / yakınlaştırma) -> değil', !tap({ acted: true }));
  check('eski katı sınır (375 ms) artık geçerli değil: 450 ms dokunuş', tap({ duration: 450, downGap: 80, upGap: 120, move: 15 }));
  check('touchpad uzun basma 500 ms', T.PAD_HOLD_MS === 500);
  const ekr = [{ name: 'A', x: 0, y: 0, w: 1920, h: 1080 }, { name: 'B', x: 1920, y: 0, w: 2400, h: 1350 }];
  let b = ekranaSigdir(ekr, { x: 100, y: 1200 });
  check('ekran dışı nokta en yakın ekrana çekilir', b.s.name === 'A' && b.x === 100 && b.y === 1079, JSON.stringify(b));
  b = ekranaSigdir(ekr, { x: 2000, y: 1200 });
  check('ikinci ekranın altındaki nokta ikinci ekranda kalır', b.s.name === 'B' && b.x === 2000 && b.y === 1200);
  b = ekranaSigdir(ekr, { x: -50, y: -50 });
  check('sol üst dışı -> (0,0)', b.s.name === 'A' && b.x === 0 && b.y === 0);
}

(async () => {
  saf();
  const a = client();
  await a.next(t('hello'));
  a.send({ t: 'setup', username: 'ahmet', password: 'gizli123', remember: false });
  const auth = await a.next(t('auth'));
  check('yönetici oluşturuldu', auth.ok);
  const screens = auth.screens;

  // Medya tuşları: doğru VK, aşağı + yukarı; görüntüleme başlatmadan
  const MEDYA = { 0xB3: 'oynat/duraklat', 0xB1: 'önceki', 0xB0: 'sonraki', 0xAE: 'ses -', 0xAF: 'ses +', 0xAD: 'sessiz' };
  for (const [vk, ad] of Object.entries(MEDYA)) {
    a.send({ t: 'kumanda', op: 'key', vk: Number(vk), down: true });
    a.send({ t: 'kumanda', op: 'key', vk: Number(vk), down: false });
    const d = await a.next(kuru), u = await a.next(kuru);
    check(`medya: ${ad} -> key ${vk} 1 / 0 (akış yokken de)`, d.cmd === `key ${vk} 1` && u.cmd === `key ${vk} 0`, `${d.cmd} | ${u.cmd}`);
  }
  // Geçersiz tuş / düğme / metin yok sayılır
  a.send({ t: 'kumanda', op: 'key', vk: 999, down: true });
  a.send({ t: 'kumanda', op: 'key', vk: 'x', down: true });
  a.send({ t: 'kumanda', op: 'down', b: 'x1' });
  a.send({ t: 'kumanda', op: 'text', s: '' });
  a.send({ t: 'kumanda', op: 'bilinmeyen' });
  check('geçersiz kumanda mesajları komut üretmez', await a.none(kuru));
  a.send({ t: 'kumanda', op: 'text', s: 'merhaba ğ' });
  const tx = await a.next(kuru);
  check('metin base64 olarak gider', tx.cmd === `text ${Buffer.from('merhaba ğ').toString('base64')}`, tx.cmd);
  a.send({ t: 'kumanda', op: 'wheel', dy: -240, dx: 0 });
  check('tekerlek', (await a.next(kuru)).cmd === 'wheel -240 0');

  // Göreli hareket: imleç yeri okunur, +dx uygulanır, ekran adı + normalize konuma çevrilir
  a.send({ t: 'kumanda', op: 'rel', dx: 40, dy: -30 });
  const m1 = await a.next(kuru);
  const mm = /^move (\S+) ([\d.]+) ([\d.]+)$/.exec(m1.cmd || '');
  const sc = mm && screens.find((s) => s.name === mm[1]);
  const fits = (p) => screens.some((s) => p.x >= s.x && p.x < s.x + s.w && p.y >= s.y && p.y < s.y + s.h);
  check('göreli hareket: move <ekran> nx ny', !!(mm && sc), m1.cmd);
  check('göreli hareket: başlangıç gerçek imleç yeri (masaüstünde)', m1.from && fits(m1.from), JSON.stringify(m1.from));
  if (mm && sc) {
    const px = Math.round(sc.x + Number(mm[2]) * (sc.w - 1)), py = Math.round(sc.y + Number(mm[3]) * (sc.h - 1));
    check('göreli hareket: normalize konum hedef piksele denk', Math.abs(px - m1.to.x) <= 1 && Math.abs(py - m1.to.y) <= 1, `${px},${py} ~ ${m1.to.x},${m1.to.y}`);
    const expX = ekranaSigdir(screens, { x: m1.from.x + 40, y: m1.from.y - 30 });
    check('göreli hareket: hedef = başlangıç + (40, -30) (ekrana sığdırılmış)', m1.to.x === expX.x && m1.to.y === expX.y, `${JSON.stringify(m1.from)} -> ${JSON.stringify(m1.to)}`);
  }
  // Hemen ardından: imleç yeniden okunmaz, kendi hesabıyla devam eder (gerçek imleç kuru modda hiç oynamadı)
  a.send({ t: 'kumanda', op: 'rel', dx: -40, dy: 30 });
  const m2 = await a.next(kuru);
  check('art arda göreli hareket önceki hedeften devam eder', m2.from && m2.from.x === m1.to.x && m2.from.y === m1.to.y, `${JSON.stringify(m1.to)} -> ${JSON.stringify(m2.from)}`);
  // Hareketten hemen sonra tık: sırası korunur (move, down, up)
  a.send({ t: 'kumanda', op: 'rel', dx: 5, dy: 0 });
  a.send({ t: 'kumanda', op: 'down', b: 'right' });
  a.send({ t: 'kumanda', op: 'up', b: 'right' });
  const sira = [(await a.next(kuru)).cmd, (await a.next(kuru)).cmd, (await a.next(kuru)).cmd];
  check('hareket + sağ tık sırası korunur', /^move /.test(sira[0]) && sira[1] === 'down right' && sira[2] === 'up right', sira.join(' | '));
  // Çok büyük değerler sınırlanır
  a.send({ t: 'kumanda', op: 'rel', dx: 1e9, dy: 0 });
  const m3 = await a.next(kuru);
  check('çok büyük göreli hareket sınırlı ve masaüstünde kalır', m3.to && fits(m3.to) && m3.to.x - m3.from.x <= 4000, JSON.stringify(m3));

  // Basılı düğme: 'end' ile ve bağlantı kopunca bırakılır
  a.send({ t: 'kumanda', op: 'down', b: 'left' });
  check('sol düğme basıldı', (await a.next(kuru)).cmd === 'down left');
  a.send({ t: 'kumanda', op: 'end' });
  check("'end' basılı düğmeyi bırakır", (await a.next(kuru)).cmd === 'up left');
  a.send({ t: 'kumanda', op: 'end' });
  check("ikinci 'end' bir şey göndermez", await a.none(kuru));

  check('kumanda sırasında hiç görüntü karesi gelmedi', a.frames() === 0, `${a.frames()} kare`);
  check('kumanda görüntülemeyi başlatmadı (started yok)', await a.none(t('started'), 300));

  // Salt izleme rolü reddedilir
  a.send({ t: 'admin', op: 'addUser', username: 'izleyici', password: 'izle1234', role: 'view' });
  await a.next(t('adminData'));
  const v = client();
  await v.next(t('hello'));
  v.send({ t: 'login', username: 'izleyici', password: 'izle1234', remember: false });
  check('izleyici giriş yaptı', (await v.next(t('auth'))).ok);
  v.send({ t: 'kumanda', op: 'key', vk: 0xB3, down: true });
  const e = await v.next((m) => m.t === 'error' || m.t === 'kumanda-kuru');
  check('salt izleme: kumanda reddedilir', e.t === 'error' && /yetki/i.test(e.msg), JSON.stringify(e));
  v.ws.close(); await v.closed;

  a.ws.close(); await a.closed;
  await sleep(100);
  console.log(fails ? `${fails} hata` : 'kumanda: hepsi geçti');
})().catch((e) => { console.log('FAIL', e.message); process.exit(1); });
