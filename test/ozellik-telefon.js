// Telefon özelliği testleri: dokunmatik hesapları (saf fonksiyonlar), toNorm'un yakınlaştırmayla uyumu,
// tuş çubuğu kısayolları, PWA dosyaları (manifest, ikonlar, service worker) ve sunucunun bunları doğru türle vermesi.
// Gerçek dokunma/telefon gerektirmez; gerçek fare/klavye girdisi GÖNDERMEZ.
const fs = require('fs');
const path = require('path');
const http = require('http');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const PORT = process.env.TEST_PORT || 3999;
const T = require(path.join(PUB, 'dokunmatik.js'));
const K = require(path.join(PUB, 'features', 'telefon.js'));

let pass = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${name} ${extra}`);
  if (cond) pass++; else process.exitCode = 1;
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

function get(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: 'localhost', port: PORT, path: p }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] || '', body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

function pngSize(buf) {
  const sig = buf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
  return sig ? { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) } : null;
}

// app.js'teki gerçek toNorm fonksiyonunu çıkarıp sahte (dönüşümlü) bir canvas ile çalıştırır.
function loadToNorm() {
  const src = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');
  const m = src.match(/\n {2}function toNorm\(cx, cy\) \{[\s\S]*?\n {2}\}\r?\n/);
  if (!m) return null;
  return (canvas) => vm.runInNewContext(`(${m[0].trim()})`, { canvas, Math });
}

(async () => {
  // ---------- 1. İvme ve sanal imleç ----------
  check('ivme: yavaşta 1x', T.accelGain(0.1) === 1 && T.accelGain(0) === 1 && T.accelGain(NaN) === 1);
  check('ivme: hızlandıkça artar, 4x ile sınırlı', T.accelGain(0.5) < T.accelGain(1) && T.accelGain(1) < T.accelGain(2) && T.accelGain(100) === 4);
  let c = T.moveCursor({ x: 0.5, y: 0.5 }, 10, 0, 100, 1000, 500);
  check('imleç: yavaş 10 px = 0.01', near(c.x, 0.51) && near(c.y, 0.5), JSON.stringify(c));
  const slow = T.moveCursor({ x: 0.5, y: 0.5 }, 100, 0, 1000, 1000, 500).x - 0.5;
  const fast = T.moveCursor({ x: 0.5, y: 0.5 }, 100, 0, 20, 1000, 500).x - 0.5;
  check('imleç: aynı mesafe hızlı kaydırınca daha uzağa', fast > slow * 2, `${slow.toFixed(3)} / ${fast.toFixed(3)}`);
  c = T.moveCursor({ x: 0.99, y: 0.01 }, 5000, -5000, 10, 1000, 500);
  check('imleç: 0..1 içinde kalır', c.x === 1 && c.y === 0);
  c = T.moveCursor({ x: 0.5, y: 0.5 }, 10, 0, 100, 1000, 500, 2);
  check('imleç: yakınlaştırılmışken daha hassas', near(c.x, 0.505));
  check('imleç: görüntü yoksa yerinde', T.moveCursor({ x: 0.3, y: 0.4 }, 50, 50, 10, 0, 0).x === 0.3);

  // ---------- 2. Sıkıştırma / kaydırma ayrımı ----------
  const m0 = { x: 100, y: 100 };
  check('iki parmak: küçük hareket kararsız', T.classifyTwoFinger(200, 205, m0, { x: 103, y: 104 }) === null);
  check('iki parmak: parmaklar açılırsa sıkıştırma', T.classifyTwoFinger(200, 240, m0, { x: 102, y: 101 }) === 'pinch');
  check('iki parmak: birlikte kayarsa kaydırma', T.classifyTwoFinger(200, 206, m0, { x: 100, y: 130 }) === 'pan');
  check('iki parmak: hem kayıp hem az açılırsa kaydırma', T.classifyTwoFinger(200, 225, m0, { x: 100, y: 160 }) === 'pan');

  // ---------- 3. Yakınlaştırma sınırları ----------
  const box = T.contentBox(400, 800, 1920, 1080); // dikey telefon, yatay ekran: üst/alt siyah kenar
  check('contentBox: object-fit contain', near(box.cw, 400) && near(box.ch, 225) && near(box.ox, 0) && near(box.oy, 287.5));
  check('zoom 1x ve altı sıfırlanır', JSON.stringify(T.clampView({ z: 0.5, tx: 50, ty: 50 }, box)) === '{"z":1,"tx":0,"ty":0}');
  check('zoom en fazla 4x', T.clampView({ z: 9, tx: 0, ty: 0 }, box).z === 4);
  let v = T.clampView({ z: 2, tx: 100, ty: 0 }, box);
  check('yatayda içerik kenarı sahneden içeri girmez', near(v.tx, 0) && near(-400, T.clampView({ z: 2, tx: -900, ty: 0 }, box).tx));
  check('dikeyde sahneden küçük içerik ortalanır', near(v.ty + (box.oy + box.ch / 2) * 2, 400), `ty=${v.ty}`);
  // Sıkıştırma: parmakların ortasındaki içerik noktası yerinde kalır.
  const start = { z: 1, tx: 0, ty: 0 };
  v = T.pinchView(start, 100, 200, { x: 200, y: 400 }, { x: 200, y: 400 }, box);
  check('sıkıştırma: mesafe 2 katı = 2x', near(v.z, 2));
  check('sıkıştırma: orta noktadaki içerik yerinde', near(200 * v.z + v.tx, 200) && near(400 * v.z + v.ty, 400));
  v = T.pinchView(start, 100, 10000, { x: 200, y: 400 }, { x: 200, y: 400 }, box);
  check('sıkıştırma: 4x ile sınırlı', v.z === 4);
  // Touchpad: görünüm imleci takip eder.
  const z3 = T.clampView({ z: 3, tx: 0, ty: -900 }, T.contentBox(800, 400, 1600, 800));
  const b2 = T.contentBox(800, 400, 1600, 800);
  const f = T.followCursor(z3, { x: 500, y: 200 }, b2);
  const sx = 500 * f.z + f.tx;
  check('touchpad: imleç kenar payına girince görünüm kayar', sx <= 800 * 0.85 + 1e-6 && f.tx < z3.tx, `sx=${sx.toFixed(1)}`);
  check('touchpad: 1x iken görünüm sabit', T.followCursor({ z: 1, tx: 0, ty: 0 }, { x: 790, y: 10 }, b2).tx === 0);
  check('dokunuş eşiği', T.isTap(5, 100) && !T.isTap(30, 100) && !T.isTap(0, 900));

  // ---------- 4. toNorm yakınlaştırmayı hesaba katıyor mu (getBoundingClientRect dönüşümlü kutuyu verir) ----------
  const mk = loadToNorm();
  check('app.js toNorm bulundu', !!mk);
  if (mk) {
    const W = 400, H = 800, L = 10, TOP = 50, nw = 1920, nh = 1080;
    const bx = T.contentBox(W, H, nw, nh);
    let worst = 0;
    for (const vv of [{ z: 1, tx: 0, ty: 0 }, T.clampView({ z: 2.5, tx: -300, ty: -200 }, bx), T.clampView({ z: 4, tx: -1200, ty: -1000 }, bx)]) {
      // CSS: transform-origin 0 0; translate(tx,ty) scale(z) -> sınırlayıcı kutu
      const canvas = { width: nw, height: nh, getBoundingClientRect: () => ({ left: L + vv.tx, top: TOP + vv.ty, width: W * vv.z, height: H * vv.z }) };
      const toNorm = mk(canvas);
      for (const [px, py] of [[200, 400], [10, 300], [390, 500]]) {
        const exp = { x: ((px - vv.tx) / vv.z - bx.ox) / bx.cw, y: ((py - vv.ty) / vv.z - bx.oy) / bx.ch };
        const got = toNorm(L + px, TOP + py);
        const cl = (q) => Math.min(1, Math.max(0, q));
        worst = Math.max(worst, Math.abs(got.x - cl(exp.x)), Math.abs(got.y - cl(exp.y)));
      }
    }
    check('toNorm yakınlaştırılmış görünümde doğru noktayı verir', worst < 1e-9, `(en büyük fark ${worst})`);
  }

  // ---------- 5. Tuş çubuğu kısayolları ----------
  check('karakter -> VK', K.charToVk('c') === 67 && K.charToVk('V') === 86 && K.charToVk('5') === 53 && K.charToVk(' ') === 32 && K.charToVk('ş') === null && K.charToVk('ab') === null);
  const combo = K.comboMessages([17, 16], { vk: 27 });
  check('Ctrl+Shift+Esc sırası', JSON.stringify(combo.map((x) => `${x.vk}${x.down ? 'v' : '^'}`)) === '["17v","16v","27v","27^","16^","17^"]');
  const tc = K.comboMessages([18], { text: 'ş' });
  check('değiştirici + metin', tc.length === 3 && tc[1].t === 'text' && tc[1].s === 'ş' && tc[2].down === false);
  check('değiştiricisiz tek tuş', K.comboMessages([], { vk: 112 }).length === 2);

  // ---------- 6. PWA dosyaları ----------
  let man = null;
  try { man = JSON.parse(fs.readFileSync(path.join(PUB, 'manifest.webmanifest'), 'utf8')); } catch (e) { check('manifest geçerli JSON', false, e.message); }
  if (man) {
    check('manifest alanları', man.name === 'Uzaktan Bağlantı' && man.display === 'standalone' && man.theme_color === '#0f1115' && !!man.start_url);
    const want = { 'icon-192.png': 192, 'icon-512.png': 512, 'maskable-512.png': 512 };
    for (const ic of man.icons) {
      const file = path.join(PUB, ic.src);
      const size = fs.existsSync(file) ? pngSize(fs.readFileSync(file)) : null;
      const n = want[path.basename(ic.src)];
      check(`ikon ${ic.src}`, !!size && size.w === n && size.h === n && ic.sizes === `${n}x${n}`, size ? `${size.w}x${size.h}` : 'yok');
    }
    check('maskable ikon var', man.icons.some((i) => i.purpose === 'maskable'));
  }
  const apple = pngSize(fs.readFileSync(path.join(PUB, 'icons', 'apple-touch-icon.png')));
  check('apple-touch-icon 180x180', apple && apple.w === 180 && apple.h === 180);
  const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  check('index.html: manifest ve apple ikon bağlantısı', html.includes('rel="manifest" href="manifest.webmanifest"') && html.includes('apple-touch-icon.png'));
  check('index.html: dokunmatik.js app.js\'ten önce', html.indexOf('src="dokunmatik.js"') > 0 && html.indexOf('src="dokunmatik.js"') < html.indexOf('src="app.js"'));

  // ---------- 7. Service worker davranışı (sahte ortamda) ----------
  const swSrc = fs.readFileSync(path.join(PUB, 'sw.js'), 'utf8');
  const listeners = {};
  const store = new Map();
  let netOk = true, netCalls = 0;
  const cacheObj = {
    add: async (req) => { store.set(new URL(req.url).pathname, 'kabuk'); },
    put: async (k, r) => { store.set(new URL(k, 'http://localhost/').pathname, r.body); },
    match: async (k) => { const p = new URL(k, 'http://localhost/').pathname; return store.has(p) ? { body: store.get(p), cached: true } : undefined; },
  };
  const sandbox = {
    URL,
    Request: class { constructor(u) { this.url = new URL(u, 'http://localhost/').href; } },
    caches: { open: async () => cacheObj, keys: async () => ['eski-v0'], delete: async () => true },
    fetch: async (req) => { netCalls++; if (!netOk) throw new TypeError('ağ yok'); return { ok: true, type: 'basic', body: `ağ:${req.url}`, clone() { return this; } }; },
    console,
  };
  sandbox.self = {
    registration: { scope: 'http://localhost/' },
    location: { origin: 'http://localhost' },
    addEventListener: (t, fn) => { listeners[t] = fn; },
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  };
  vm.runInNewContext(swSrc, sandbox);
  check('sw: install/activate/fetch dinleyicileri', !!listeners.install && !!listeners.activate && !!listeners.fetch);
  let waits = [];
  listeners.install({ waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  check('sw: kabuk önbelleğe alındı', ['/', '/index.html', '/app.js', '/style.css', '/manifest.webmanifest', '/icons/icon-192.png'].every((p) => store.has(p)));
  const fire = async (url, opts = {}) => {
    let resp = null;
    listeners.fetch({ request: { url, method: opts.method || 'GET', mode: opts.mode || 'cors' }, respondWith: (p) => { resp = p; } });
    return resp ? await resp : null;
  };
  check('sw: /api/* ele alınmaz', (await fire('http://localhost/api/features')) === null);
  check('sw: özellik betikleri ele alınmaz', (await fire('http://localhost/features/telefon.js')) === null);
  check('sw: sorgulu adres ele alınmaz', (await fire('http://localhost/app.js?oturum=x')) === null);
  check('sw: POST ele alınmaz', (await fire('http://localhost/app.js', { method: 'POST' })) === null);
  check('sw: başka köken ele alınmaz', (await fire('https://ornek.com/app.js')) === null);
  netCalls = 0;
  let r = await fire('http://localhost/app.js');
  check('sw: ağ öncelikli (çevrimiçi ağdan gelir)', r && r.body === 'ağ:http://localhost/app.js' && netCalls === 1);
  netOk = false;
  r = await fire('http://localhost/app.js');
  check('sw: çevrimdışı önbellekten', r && r.cached && r.body === 'ağ:http://localhost/app.js');
  r = await fire('http://localhost/', { mode: 'navigate' });
  check('sw: çevrimdışı sayfa önbellekten', r && r.cached);
  netOk = true;

  // ---------- 8. Sunucu bu dosyaları doğru türle veriyor mu ----------
  const types = {
    '/manifest.webmanifest': 'application/manifest+json',
    '/icons/icon-192.png': 'image/png',
    '/icons/icon-512.png': 'image/png',
    '/icons/maskable-512.png': 'image/png',
    '/icons/apple-touch-icon.png': 'image/png',
    '/sw.js': 'text/javascript',
    '/dokunmatik.js': 'text/javascript',
    '/features/telefon.js': 'text/javascript',
  };
  for (const [p, type] of Object.entries(types)) {
    const res = await get(p);
    check(`sunucu ${p}`, res.status === 200 && res.type.startsWith(type), `${res.status} ${res.type}`);
  }
  const feats = JSON.parse((await get('/api/features')).body.toString());
  check('özellik listesinde telefon.js', feats.includes('features/telefon.js'));
  const trav = await get('/icons/..%2f..%2fserver.js');
  check('ikon yolunda dizin dışına çıkılamaz', trav.status === 403 || trav.status === 404, String(trav.status));

  console.log(`\n${pass} kontrol geçti`);
  process.exit();
})().catch((e) => { console.error('TEST HATASI', e); process.exit(1); });
