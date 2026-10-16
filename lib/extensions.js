// Özellik modülleri için kanca sistemi.
// Her özellik features/<ad>.js dosyasıdır ve `init(api)` fonksiyonu dışa aktarır:
//
//   module.exports.init = (api) => {
//     api.on('pano-yaz', async (ws, m) => { ... }, { role: 'control' });   // WebSocket mesajı
//     api.route('POST', '/api/dosya/yukle', async (req, res, ws, url) => { ... }, { role: 'control' });
//     api.onAuth((ws) => { ... });      // biri giriş yapınca
//     api.onClose((ws) => { ... });     // giriş yapmış biri ayrılınca
//     api.adminData(async () => ({ ozellikAdi: {...} }));  // yönetim paneline veri
//   };
//
// api ayrıca çekirdek nesneleri içerir: helper, video, store, clients, sendJson, broadcast, buildExe, dataDir,
// PORT, guestCode() (şu anki misafir kodu ya da null), kick(ws => bool, neden) (bağlantıyı keser, oturum devamı olmadan),
// clientInfo(req) (isteğin nereden geldiği: { ip, via, isLocal }).
// Yetki sırası: view < control < admin. role verilmezse giriş yapmış herkes çağırabilir.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FEATURES_DIR = path.join(__dirname, '..', 'features');
const PUBLIC_FEATURES_DIR = path.join(__dirname, '..', 'public', 'features');
const RANK = { view: 0, control: 1, admin: 2 };

const handlers = new Map(); // tür -> { fn, role, feature }
const routes = [];          // { method, prefix, fn, role, feature }
const hooks = { auth: [], close: [], adminData: [] };
const loaded = [];

const allowedRole = (ws, role) => !role || (RANK[ws.session?.role] ?? -1) >= RANK[role];

function load(core) {
  if (!fs.existsSync(FEATURES_DIR)) return loaded;
  for (const file of fs.readdirSync(FEATURES_DIR).filter((f) => f.endsWith('.js')).sort()) {
    const feature = file.replace(/\.js$/, '');
    const api = {
      ...core,
      feature,
      on(type, fn, { role } = {}) {
        if (handlers.has(type)) throw new Error(`"${type}" mesajı zaten "${handlers.get(type).feature}" tarafından kayıtlı`);
        handlers.set(type, { fn, role, feature });
      },
      // isPublic: true -> oturum kontrolü yapılmaz, ws null gelir; kimlik doğrulamayı özellik KENDİSİ yapmalı
      // (ör. yalnızca bu bilgisayardan + gizli belirteçle erişilen tepsi simgesi uçları).
      route(method, prefix, fn, { role, isPublic = false } = {}) {
        routes.push({ method: method.toUpperCase(), prefix, fn, role, isPublic, feature });
      },
      onAuth(fn) { hooks.auth.push(fn); },
      onClose(fn) { hooks.close.push(fn); },
      adminData(fn) { hooks.adminData.push(fn); },
      log: (...a) => console.log(`[${feature}]`, ...a),
    };
    try {
      require(path.join(FEATURES_DIR, file)).init(api);
      loaded.push(feature);
    } catch (e) {
      // Bir özellik bozuksa diğerleri ve çekirdek çalışmaya devam etsin.
      console.error(`Özellik yüklenemedi: ${feature} — ${e.message}`);
    }
  }
  return loaded;
}

// WebSocket mesajı bir özelliğe aitse çalıştırır ve true döner.
async function handleMessage(ws, m) {
  const h = handlers.get(m.t);
  if (!h) return false;
  if (!allowedRole(ws, h.role)) {
    core().sendJson(ws, { t: 'error', msg: 'Bu işlem için yetkiniz yok.' });
    return true;
  }
  await h.fn(ws, m);
  return true;
}

// HTTP isteği bir özellik adresine aitse çalıştırır ve true döner.
// Kimlik: "X-Oturum" başlığı ya da ?oturum= parametresi (girişte istemciye verilen http anahtarı).
async function handleHttp(req, res, url, clients) {
  const r = routes.find((x) => x.method === req.method && url.pathname.startsWith(x.prefix));
  if (!r) return false;
  let ws = null;
  if (!r.isPublic) {
    const token = String(req.headers['x-oturum'] || url.searchParams.get('oturum') || '');
    ws = token && [...clients].find((c) => c.httpToken && safeEqual(c.httpToken, token));
    if (!ws) { res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Oturum geçersiz.'); return true; }
    if (!allowedRole(ws, r.role)) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Yetki yok.'); return true; }
  }
  try {
    await r.fn(req, res, ws, url);
  } catch (e) {
    console.error(`[${r.feature}] HTTP hatası:`, e.message);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(e.message);
  }
  return true;
}

function safeEqual(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

async function emit(name, ws) {
  for (const fn of hooks[name]) {
    try { await fn(ws); } catch (e) { console.error(`Kanca hatası (${name}):`, e.message); }
  }
}

async function adminData() {
  const out = {};
  for (const fn of hooks.adminData) {
    try { Object.assign(out, await fn()); } catch (e) { console.error('adminData kancası:', e.message); }
  }
  return out;
}

// Tarayıcı tarafı özellik betikleri (public/features/*.js) — app.js bunları yükler.
function clientFeatures() {
  if (!fs.existsSync(PUBLIC_FEATURES_DIR)) return [];
  return fs.readdirSync(PUBLIC_FEATURES_DIR).filter((f) => f.endsWith('.js')).sort().map((f) => `features/${f}`);
}

let coreRef = null;
const core = () => coreRef;
function init(c) { coreRef = c; return load(c); }

module.exports = { init, handleMessage, handleHttp, emit, adminData, clientFeatures, loaded };
