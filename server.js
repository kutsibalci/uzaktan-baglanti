const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const store = require('./lib/store');
const { Helper, askHost, buildExe } = require('./lib/helper');
const { VirtualDisplays } = require('./lib/vdd');
const { clientInfo, isPrivate, tailscaleInfo } = require('./lib/network');
const { VideoManager, detectEncoders } = require('./lib/video');
const ext = require('./lib/extensions');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const helper = new Helper();
const vdd = new VirtualDisplays(helper);
const video = new VideoManager({
  // H.264 çalışmazsa bu istemci JPEG'e döner.
  onFail(ws, msg) {
    if (!ws.session) return;
    ws.session.view.codec = 'jpeg';
    ws.needsFrame = true;
    sendJson(ws, { t: 'codec', codec: 'jpeg', msg });
  },
});

// ---------- Misafir kodu (tek seferlik) ----------

let guestCode = newGuestCode();
function newGuestCode() {
  return String(crypto.randomInt(100000, 1000000));
}
function rotateGuestCode() {
  guestCode = newGuestCode();
  if (store.settings.guestOtp) console.log(`  Yeni misafir kodu: ${guestCode}`);
}

// ---------- Kaba kuvvet koruması ----------

const failures = new Map(); // ip -> { count, until }
const MAX_FAILS = 5;
const LOCK_MS = 5 * 60 * 1000;

function isLocked(ip) {
  const f = failures.get(ip);
  return f && f.until > Date.now();
}
function recordFailure(ip) {
  const f = failures.get(ip) || { count: 0, until: 0 };
  f.count++;
  if (f.count >= MAX_FAILS) { f.until = Date.now() + LOCK_MS; f.count = 0; }
  failures.set(ip, f);
}

// ---------- HTTP (statik dosyalar) ----------

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

// İnternetten doğrudan gelen bağlantıları reddet (modemde yanlışlıkla port açılsa bile).
// Yalnızca ev ağı, Tailscale ve bu bilgisayar kabul edilir.
const allowed = (req) => isPrivate(req.socket.remoteAddress);

// Yavaş istek koruması (slowloris): gövdesi bu süre içinde tamamlanmayan istek kesilir. Node'un sunucu genelindeki
// requestTimeout'u yerine istek başına uygulanır; böylece büyük dosya yüklemesi (req.uzunIstek = true, yalnızca
// oturum ve yetki doğrulandıktan sonra) kendi "hiç veri gelmeme" süresini kullanırken diğer isteklerin koruması sürer.
const REQUEST_TIMEOUT_MS = Number(process.env.REMOTE_ISTEK_SURESI_MS) || 5 * 60 * 1000; // ortam değişkeni: testler için

const server = http.createServer(async (req, res) => {
  const reqTimer = setTimeout(() => { if (!req.complete && !req.uzunIstek) req.socket.destroy(); }, REQUEST_TIMEOUT_MS);
  reqTimer.unref();
  // Cevap erken yazılsa da (ör. 401) gövdesi yarım kalan istek süresi dolunca yine kesilir.
  res.on('close', () => { if (req.complete) clearTimeout(reqTimer); });
  if (!allowed(req)) { res.writeHead(403).end(); return; }
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/features') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify(ext.clientFeatures()));
    return;
  }
  if (await ext.handleHttp(req, res, url, clients)) return;
  let urlPath;
  try { urlPath = decodeURIComponent(url.pathname); } catch { res.writeHead(400).end(); return; }
  const file = path.normalize(path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('Bulunamadı'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// ---------- WebSocket ----------

server.requestTimeout = 0; // yerine yukarıdaki istek başına süre

const wss = new WebSocketServer({ server, maxPayload: 64 * 1024, verifyClient: ({ req }) => allowed(req) });
const clients = new Set(); // giriş yapmış bağlantılar

const QUALITY = { quality: 60, maxWidth: 1600, fps: 20, kbps: 4000, codec: 'jpeg' };
const clamp = (v, lo, hi, def) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : def);
const BUTTONS = new Set(['left', 'right', 'middle']);
const SCREEN_NAME = /^\\\\\.\\DISPLAY\d+$/;
const VIA_NAMES = { local: 'bu bilgisayar', lan: 'ev ağı', tailscale: 'Tailscale' };

wss.on('connection', (ws, req) => {
  const info = clientInfo(req);
  ws.ip = info.ip;
  ws.via = info.via;
  ws.tsUser = info.tsUser;
  ws.isLocal = info.isLocal;
  ws.session = null;
  ws.busy = false;
  ws.inflight = [];
  ws.on('pong', () => jpegPong(ws));
  const authTimeout = setTimeout(() => { if (!ws.session) ws.close(4001, 'auth timeout'); }, 5 * 60 * 1000);

  sendJson(ws, {
    t: 'hello',
    needsSetup: !store.hasUsers(),
    canSetup: !store.hasUsers() && ws.isLocal,
    guestOtp: store.settings.guestOtp,
  });

  ws.on('message', async (raw, isBinary) => {
    if (isBinary) return;
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    try {
      if (!ws.session) await handleAuth(ws, m);
      else await handleSession(ws, m);
    } catch (e) {
      console.error('Hata:', e.message);
      sendJson(ws, { t: 'error', msg: e.message });
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimeout);
    if (!clients.delete(ws)) return;
    stopStream(ws);
    ext.emit('close', ws);
    if (!ws.loggedOut && ws.resumeToken) {
      const { username, role, guest, deviceId, deviceName } = ws.session;
      resumeTokens.set(ws.resumeToken, { session: { username, role, guest, deviceId, deviceName }, expires: Date.now() + RESUME_MS });
    }
    console.log(`Ayrıldı: ${ws.session.username} (${ws.ip})`);
  });
});

// İstemciye giden ekran listesi: RemoteHelper'ın alanları (x, y, w, h fiziksel piksel; scale = Windows ölçeklemesi) aynen
// kalır, ekran seçici için okunur "title" ve "virtual" eklenir: "Ekran 1 (1920×1080)", "Sanal ekran (1920×1080)".
const VIRTUAL_ADAPTER = /virtual display/i; // VirtualDrivers/Virtual-Display-Driver (lib/vdd.js)
function describeScreens(screens) {
  const ours = new Set([...clients].map((c) => c.session?.virtualScreen).filter(Boolean));
  let n = 0;
  return screens.map((s) => {
    const virtual = ours.has(s.name) || VIRTUAL_ADAPTER.test(s.adapter || '');
    const size = `${s.w}×${s.h}`;
    return { ...s, virtual, title: virtual ? `Sanal ekran (${size})` : `Ekran ${++n} (${size})` };
  });
}

function sendJson(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

// ---------- Giriş ----------

async function handleAuth(ws, m) {
  if (ws.busy) return;
  if (isLocked(ws.ip)) {
    sendJson(ws, { t: 'auth', ok: false, error: 'Çok fazla hatalı deneme. 5 dakika sonra tekrar deneyin.' });
    return;
  }
  ws.busy = true;
  try {
    switch (m.t) {
      case 'setup': return await doSetup(ws, m);
      case 'login': return await doLogin(ws, m);
      case 'token': return await doToken(ws, m);
      case 'guest': return await doGuest(ws, m);
      case 'resume': return await doResume(ws, m);
    }
  } finally {
    ws.busy = false;
  }
}

function fail(ws, error, logIt = true, details = {}) {
  if (logIt) {
    recordFailure(ws.ip);
    store.log('failed', { ip: ws.ip, ...details });
    console.log(`Başarısız giriş: ${ws.ip} ${details.user || ''}`);
  }
  // Tahmin denemelerini yavaşlatmak için cevabı geciktir.
  return new Promise((r) => setTimeout(() => { sendJson(ws, { t: 'auth', ok: false, error }); r(); }, logIt ? 800 : 0));
}

async function doSetup(ws, m) {
  if (store.hasUsers()) return fail(ws, 'Kurulum zaten yapılmış.', false);
  if (!ws.isLocal) return fail(ws, 'İlk kurulum yalnızca bu bilgisayardan yapılabilir.', false);
  try {
    store.addUser(String(m.username || '').trim(), m.password, 'admin');
  } catch (e) {
    return fail(ws, e.message, false);
  }
  store.log('setup', { user: m.username, ip: ws.ip });
  console.log(`Yönetici hesabı oluşturuldu: ${m.username}`);
  const user = store.findUser(m.username);
  const remembered = m.remember ? store.addDevice(user.username, m.deviceName, ws.ip) : null;
  finishAuth(ws, { username: user.username, role: user.role, deviceId: remembered?.device.id, token: remembered?.token });
}

async function doLogin(ws, m) {
  const username = String(m.username || '').trim();
  const user = store.verifyUser(username, m.password);
  if (!user) return fail(ws, 'Kullanıcı adı veya şifre hatalı.', true, { user: username });

  const deviceName = String(m.deviceName || 'Bilinmeyen cihaz').slice(0, 60);
  // Tailscale ağına yalnızca senin Tailscale hesabına bağlı cihazlar girebilir; evde değilken
  // onay penceresine kimse cevap veremeyeceği için bu bağlantılarda onay atlanabilir (ayarlanabilir).
  const skipApproval = ws.isLocal || (ws.via === 'tailscale' && store.settings.trustTailscale);
  if (store.settings.requireApproval && !skipApproval) {
    sendJson(ws, { t: 'pending' });
    console.log(`Onay bekleniyor: ${user.username} - ${deviceName} (${ws.ip})`);
    const approved = await askHost(
      'Uzaktan Bağlantı - Yeni cihaz',
      `"${user.username}" kullanıcısı yeni bir cihazdan bağlanmak istiyor.\n\nCihaz: ${deviceName}\nIP: ${ws.ip} (${VIA_NAMES[ws.via]})\n\nİzin verilsin mi?`,
    );
    if (ws.readyState !== 1) return;
    if (!approved) {
      store.log('rejected', { user: user.username, ip: ws.ip, device: deviceName });
      return fail(ws, 'Bağlantı isteği bilgisayarda reddedildi ya da süre doldu.', false);
    }
  }
  failures.delete(ws.ip);
  const remembered = m.remember ? store.addDevice(user.username, deviceName, ws.ip) : null;
  finishAuth(ws, { username: user.username, role: user.role, deviceId: remembered?.device.id, token: remembered?.token, deviceName });
}

async function doToken(ws, m) {
  const found = store.deviceByToken(m.token, ws.ip);
  if (!found) return fail(ws, 'Bu cihazın kaydı silinmiş, tekrar giriş yapın.', true, { user: '(cihaz anahtarı)' });
  failures.delete(ws.ip);
  finishAuth(ws, { username: found.user.username, role: found.user.role, deviceId: found.device.id, deviceName: found.device.name });
}

async function doGuest(ws, m) {
  if (!store.settings.guestOtp) return fail(ws, 'Misafir girişi kapalı.', false);
  const code = String(m.code || '');
  const ok = code.length === guestCode.length && crypto.timingSafeEqual(Buffer.from(code), Buffer.from(guestCode));
  if (!ok) return fail(ws, 'Misafir kodu hatalı.', true, { user: '(misafir)' });
  failures.delete(ws.ip);
  rotateGuestCode();
  finishAuth(ws, { username: 'Misafir', role: store.settings.guestRole, guest: true, deviceName: m.deviceName });
}

// Kısa kopmalarda (Wi-Fi, ekran kilidi) şifre sormadan geri dönebilmek için bellek içi anahtar.
// Yalnızca sayfa açıkken istemcinin belleğinde durur; sunucu kapanınca geçersiz olur.
const resumeTokens = new Map(); // token -> { session, expires }
const RESUME_MS = 10 * 60 * 1000;

async function doResume(ws, m) {
  const r = typeof m.token === 'string' && resumeTokens.get(m.token);
  if (!r || r.expires < Date.now()) return fail(ws, 'Oturum süresi doldu, tekrar giriş yapın.', false);
  const { username, role, guest, deviceId, deviceName } = r.session;
  if (!guest && !store.findUser(username)) return fail(ws, 'Hesap bulunamadı.', false);
  if (deviceId && !store.snapshot().devices.some((d) => d.id === deviceId)) return fail(ws, 'Bu cihazın kaydı silinmiş.', false);
  resumeTokens.delete(m.token);
  const role2 = guest ? role : store.findUser(username).role;
  finishAuth(ws, { username, role: role2, guest, deviceId, deviceName }, true);
}

async function finishAuth(ws, s, resumed = false) {
  ws.session = { ...s, view: { screen: null, ...QUALITY } };
  ws.resumeToken = crypto.randomBytes(24).toString('base64url');
  ws.httpToken = crypto.randomBytes(24).toString('base64url'); // özelliklerin HTTP adresleri için (dosya aktarımı vb.)
  clients.add(ws);
  if (resumed) {
    console.log(`Yeniden bağlandı: ${s.username} (${ws.ip})`);
    const info = await helper.info();
    sendJson(ws, { t: 'auth', ok: true, resumed: true, username: s.username, role: s.role, guest: !!s.guest, resume: ws.resumeToken, http: ws.httpToken, screens: describeScreens(info.screens), vdd: await vdd.available() });
    ext.emit('auth', ws);
    return;
  }
  store.log('login', { user: s.username, ip: ws.ip, via: ws.via, device: s.deviceName || '', remembered: !!s.deviceId });
  console.log(`Bağlandı: ${s.username} [${s.role}] (${ws.ip}, ${VIA_NAMES[ws.via]})`);
  const info = await helper.info();
  sendJson(ws, {
    t: 'auth', ok: true, username: s.username, role: s.role, guest: !!s.guest, token: s.token, resume: ws.resumeToken,
    http: ws.httpToken, screens: describeScreens(info.screens), vdd: await vdd.available(),
  });
  ext.emit('auth', ws);
}

// ---------- Oturum içi mesajlar ----------

async function handleSession(ws, m) {
  const s = ws.session;
  const canControl = s.role !== 'view';

  switch (m.t) {
    case 'start': return startStream(ws, m);
    case 'stop': stopStream(ws); return;
    case 'ack': jpegAck(ws); return;
    case 'keyframe': video.requestKeyframe(ws); return;
    case 'settings':
      s.view.quality = Math.round(clamp(m.quality, 10, 95, s.view.quality));
      s.view.maxWidth = Math.round(clamp(m.maxWidth, 320, 3840, s.view.maxWidth));
      s.view.fps = Math.round(clamp(m.fps, 1, 60, s.view.fps));
      s.view.kbps = Math.round(clamp(m.kbps, 300, 30000, s.view.kbps));
      // Otomatik kalite (yalnızca JPEG): quality/maxWidth tavan olur, sunucu ağa göre altında bir seviye seçer.
      setAuto(ws, m.auto === true);
      ws.needsFrame = true;
      wakeCapture();
      if (ws.streaming && s.view.codec === 'h264') await subscribeVideo(ws);
      return;
    case 'screen':
      if (typeof m.name === 'string' && SCREEN_NAME.test(m.name)) {
        s.view.screen = m.name;
        ws.needsFrame = true;
        wakeCapture();
        if (ws.streaming && s.view.codec === 'h264') await subscribeVideo(ws);
      }
      return;
    case 'logout':
      if (s.deviceId && m.forget) { store.removeDevice(s.deviceId); s.deviceId = null; }
      ws.loggedOut = true;
      ws.close(4000, 'logout');
      return;
    case 'admin': return handleAdmin(ws, m);
  }

  // Özellik modüllerinin mesajları (features/*.js). Yetki kontrolü kayıt sırasında belirtilir.
  if (await ext.handleMessage(ws, m)) return;

  if (!canControl || !ws.streaming) return;
  const screen = s.view.screen;
  switch (m.t) {
    case 'move':
      helper.send(`move ${screen} ${clamp(m.x, 0, 1, 0).toFixed(5)} ${clamp(m.y, 0, 1, 0).toFixed(5)}`);
      break;
    case 'down':
    case 'up':
      if (BUTTONS.has(m.b)) helper.send(`${m.t} ${m.b}`);
      break;
    case 'wheel':
      helper.send(`wheel ${Math.round(clamp(m.dy, -1200, 1200, 0))} ${Math.round(clamp(m.dx, -1200, 1200, 0))}`);
      break;
    case 'key': {
      const vk = Math.round(clamp(m.vk, 1, 254, 0));
      if (vk) helper.send(`key ${vk} ${m.down ? 1 : 0}`);
      break;
    }
    case 'text':
      if (typeof m.s === 'string' && m.s.length && m.s.length <= 1000) {
        helper.send(`text ${Buffer.from(m.s, 'utf8').toString('base64')}`);
      }
      break;
  }
}

async function startStream(ws, m) {
  const s = ws.session;
  stopStream(ws);
  const { screens } = await helper.info();

  if (m.mode === 'extend') {
    if (s.role === 'view') return sendJson(ws, { t: 'error', msg: 'İkinci ekran için kontrol yetkisi gerekiyor.' });
    // Çok büyük çözünürlükleri sınırla (ağ ve CPU yükü).
    let w = Math.round(clamp(m.w, 640, 3840, 1920));
    let h = Math.round(clamp(m.h, 480, 2160, 1080));
    const k = Math.min(1, 2560 / Math.max(w, h));
    w = Math.round((w * k) / 8) * 8;
    h = Math.round((h * k) / 8) * 8;
    sendJson(ws, { t: 'status', msg: 'Sanal ekran oluşturuluyor...' });
    try {
      s.virtualScreen = await vdd.add(w, h);
    } catch (e) {
      const msg = e.message === 'DRIVER_MISSING'
        ? 'Sanal ekran sürücüsü kurulu değil. Bilgisayarda "surucu-kur.bat" dosyasını çalıştırın.'
        : e.message;
      return sendJson(ws, { t: 'error', msg, code: e.message });
    }
    if (ws.readyState !== 1) { await vdd.remove(); s.virtualScreen = null; return; }
    s.view.screen = s.virtualScreen;
    s.view.maxWidth = Math.max(w, h);
    store.log('extend', { user: s.username, ip: ws.ip, size: `${w}x${h}` });
  } else {
    const wanted = screens.find((x) => x.name === m.screen) || screens.find((x) => x.primary) || screens[0];
    s.view.screen = wanted?.name;
  }

  // İstemci WebCodecs destekliyorsa (HTTPS/localhost) H.264, yoksa JPEG.
  s.view.codec = Array.isArray(m.codecs) && m.codecs.includes('h264') && video.available ? 'h264' : 'jpeg';
  ws.streaming = true;
  ws.inflight = [];
  ws.held = null;
  ws.still = false;
  ws.needsFrame = true;
  ws.nextDue = 0;
  setAuto(ws, false);
  wakeCapture();
  const fresh = await helper.info();
  sendJson(ws, {
    t: 'started', mode: m.mode === 'extend' ? 'extend' : 'control', screen: s.view.screen, screens: describeScreens(fresh.screens),
    codec: s.view.codec, encoder: s.view.codec === 'h264' ? video.encoderLabel : null,
  });
  // H.264 akışı istemci ayarlarını gönderince (settings) başlar.
}

async function subscribeVideo(ws) {
  const v = ws.session.view;
  const { screens } = await helper.info();
  const sc = screens.find((x) => x.name === v.screen);
  if (sc && ws.readyState === 1 && ws.streaming) video.subscribe(ws, sc, v);
}

function stopStream(ws) {
  ws.streaming = false;
  ws.lastFrame = null;
  ws.held = null;
  video.unsubscribe(ws);
  const s = ws.session;
  if (s?.virtualScreen) {
    s.virtualScreen = null;
    vdd.remove().catch(() => {});
  }
}

// ---------- Yönetim ----------

async function adminData() {
  return {
    t: 'adminData',
    ...store.snapshot(),
    guestCode: store.settings.guestOtp ? guestCode : null,
    online: [...clients].map((c) => ({ username: c.session.username, role: c.session.role, ip: c.ip, via: c.via, deviceId: c.session.deviceId || null })),
    tailscale: await tailscaleInfo(),
    port: PORT,
    features: await ext.adminData(), // özellik modüllerinin yönetim verisi, özellik adına göre
  };
}

function kick(predicate, reason) {
  for (const c of clients) if (predicate(c)) { c.loggedOut = true; c.close(4002, reason); }
}

async function handleAdmin(ws, m) {
  if (ws.session.role !== 'admin') return sendJson(ws, { t: 'error', msg: 'Bu işlem için yönetici yetkisi gerekiyor.' });
  try {
    switch (m.op) {
      case 'list': break;
      case 'addUser': store.addUser(String(m.username || '').trim(), m.password, m.role); break;
      case 'deleteUser':
        store.deleteUser(m.username);
        kick((c) => c.session.username === m.username, 'user deleted');
        break;
      case 'setRole':
        store.setRole(m.username, m.role);
        for (const c of clients) if (c.session.username === m.username && !c.session.guest) {
          c.session.role = m.role;
          sendJson(c, { t: 'role', role: m.role });
        }
        break;
      case 'setPassword':
        store.setPassword(m.username, m.password);
        kick((c) => c !== ws && c.session.username === m.username && c.session.deviceId, 'password changed');
        break;
      case 'removeDevice':
        store.removeDevice(m.id);
        kick((c) => c.session.deviceId === m.id, 'device removed');
        break;
      case 'setSetting': store.setSetting(m.key, m.value); break;
      case 'newGuestCode': rotateGuestCode(); break;
      default: return;
    }
    if (m.op !== 'list') store.log('admin', { user: ws.session.username, op: m.op, target: m.username || m.id || m.key || '' });
    sendJson(ws, { ...(await adminData()), ok: m.op !== 'list' ? 'Kaydedildi.' : undefined });
  } catch (e) {
    sendJson(ws, { ...(await adminData()), error: e.message });
  }
}

// ---------- Görüntü döngüsü (JPEG) ----------
// İstemci her kareyi çözünce onay (ack) gönderir. Aynı anda en fazla JPEG_INFLIGHT kare onaysız yolda olabilir:
// biri yoldayken sıradaki gönderilir (ağ gidiş-dönüşü kare aralığına eklenmez), ama kareler yine birikmez,
// yavaş Wi-Fi'da gecikme büyümez. Kare zamanlaması yakalamanın başından sayılır (yakalama süresi aralığa eklenmez).
// Yollar doluyken, onayın geleceği tahmin edilen ana yakalama süresi kadar kala sıradaki kare önceden yakalanır ve
// onay gelince hemen gönderilir (yakalama süresi de aralığa eklenmez; kare en fazla tahmin hatası kadar bekler).
// Windows'ta Node zamanlayıcıları ~15.6 ms adımlıdır: ack/ayar gelince döngü zamanlayıcıyı beklemeden uyandırılır.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const JPEG_HEADER = Buffer.from([1]); // ikili mesajın ilk baytı: 1 = JPEG, 2 = H.264
const JPEG_INFLIGHT = 2;      // onaysız yolda olabilecek kare sayısı
const ACK_TIMEOUT_MS = 3000;  // bu sürede onay gelmezse kare kayıp sayılır
const EARLY_MS = 4;           // zamanlayıcı adımı yüzünden geç kalmamak için bu kadar erken yakalanabilir

let wakeFn = null;
function wakeCapture() { const w = wakeFn; wakeFn = null; if (w) w(); }
function nap(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { wakeFn = null; resolve(); }, ms);
    wakeFn = () => { clearTimeout(t); resolve(); };
  });
}

// Otomatik kalite: [JPEG kalitesi, en fazla genişlik, göreli kare boyutu], küçükten büyüğe. İstemcinin gönderdiği
// quality/maxWidth tavandır. Önce kalite düşer, sonra genişlik: küçültme yakalamaya ~20 ms ekliyor (ölçüldü).
// Ölçüt: kare onay süresi (ortanca) − ağ gidiş-dönüşü (yollar boşken WebSocket ping, ortanca) ≈ iletim + çözme süresi.
// Bu, kare aralığının (1000/fps) büyük kısmını tutuyorsa bir seviye düşülür; bir üst seviyede bile rahat kalacaksa
// (birkaç saniye üst üste) bir seviye çıkılır. Gidiş-dönüşün kendisi kaliteyle değişmediği için hesaba katılmaz.
const AUTO_LEVELS = [[35, 960, 0.25], [45, 1280, 0.42], [55, 1280, 0.5], [40, 1920, 0.84], [50, 1920, 0.92], [60, 1920, 1], [70, 1920, 1.12], [80, 2560, 1.3]];
const AUTO_START = 5;

function setAuto(ws, on) {
  const v = ws.session.view;
  if (!on) { v.auto = false; ws.auto = null; return; }
  if (v.auto && ws.auto) return; // zaten otomatik: seviye korunur
  v.auto = true;
  ws.auto = { level: AUTO_START, good: 0, start: performance.now(), acks: [], rtts: [], lastPing: 0 };
}

function jpegParams(c) {
  const v = c.session.view;
  if (!v.auto || !c.auto) return { quality: v.quality, maxWidth: v.maxWidth };
  const [q, w] = AUTO_LEVELS[c.auto.level];
  return { quality: Math.min(q, v.quality), maxWidth: Math.min(w, v.maxWidth) };
}

function sendJpeg(c, frame, p, t) {
  c.send(Buffer.concat([JPEG_HEADER, frame]), { binary: true });
  c.lastFrame = frame;
  c.needsFrame = false;
  c.still = false;
  c.inflight.push({ at: t, size: frame.length });
  c.jpegQuality = { ...p, auto: !!c.session.view.auto };
  autoTune(c, t);
}

function jpegAck(ws) {
  const now = performance.now();
  const f = ws.inflight.shift();
  if (f) {
    const ms = now - f.at;
    ws.ackMs = ws.ackMs == null ? ms : ws.ackMs * 0.8 + ms * 0.2; // gecikme sayacı ve önceden yakalama için
    if (ws.auto) ws.auto.acks.push(ms);
  }
  // Önceden yakalanmış kare bekliyorsa hemen gönder (çok bayatladıysa at; döngü tazesini yakalar).
  const held = ws.held;
  if (held && ws.inflight.length < JPEG_INFLIGHT) {
    ws.held = null;
    if (ws.readyState === 1 && ws.streaming && now - held.at < 2000 / ws.session.view.fps) sendJpeg(ws, held.frame, held.p, now);
  }
  wakeCapture();
}

// Ağ gidiş-dönüşü, yalnızca yolda kare yokken atılan WebSocket ping'iyle ölçülür: kareler doluyken ping onların
// arkasında beklediği için gidiş-dönüşü olduğundan büyük gösterirdi (dolu hatta kalite hiç düşmezdi).
function jpegPing(c, now) {
  const a = c.auto;
  if (!a || c.inflight.length || c.bufferedAmount > 0) return;
  if (c.pingAt && now - c.pingAt < 5000) return; // cevap bekleniyor
  if (now - a.lastPing < 1000) return;
  a.lastPing = now;
  c.pingAt = now;
  try { c.ping(); } catch { c.pingAt = 0; }
}

function jpegPong(ws) {
  if (!ws.pingAt) return;
  const a = ws.auto;
  const now = performance.now();
  if (a) {
    a.rtts.push({ at: now, ms: now - ws.pingAt });
    while (a.rtts.length > 5 || (a.rtts.length > 1 && now - a.rtts[0].at > 30000)) a.rtts.shift();
  }
  ws.pingAt = 0;
}

function autoTune(c, now) {
  const a = c.auto;
  if (!a) return;
  if (now - a.start < 1000) return;
  if (a.acks.length < 4) { if (now - a.start > 3000) { a.start = now; a.acks = []; } return; } // ekran durağan
  const sorted = [...a.acks].sort((x, y) => x - y);
  const median = sorted[Math.floor(sorted.length / 2)];
  // Ortanca: ack süresinin ortancası da ağın olağan sapmasını içeriyor; en düşük ping ile kıyaslamak sapmayı "iletim" sanardı.
  const pings = a.rtts.map((x) => x.ms).sort((x, y) => x - y);
  const rtt = pings.length ? pings[Math.floor(pings.length / 2)] : 0;
  const cost = Math.max(0, median - rtt);
  const period = 1000 / c.session.view.fps;
  let level = a.level;
  const up = AUTO_LEVELS[Math.min(level + 1, AUTO_LEVELS.length - 1)][2] / AUTO_LEVELS[level][2];
  if (cost > 0.9 * period) { level -= cost > 2 * period ? 2 : 1; a.good = 0; }
  else if (cost * up < 0.6 * period) { if (++a.good >= 3) { level++; a.good = 0; } }
  else a.good = 0;
  a.level = Math.max(0, Math.min(AUTO_LEVELS.length - 1, level));
  a.start = now;
  a.acks = [];
}

async function captureLoop() {
  for (;;) {
    const now = performance.now();
    let wait = 200;
    const due = [];
    for (const c of clients) {
      const v = c.session.view;
      if (c.readyState !== 1 || !c.streaming || v.codec !== 'jpeg' || !v.screen) continue;
      if (c.inflight.length && now - c.inflight[0].at > ACK_TIMEOUT_MS) { c.inflight = []; c.held = null; } // onay kayboldu
      jpegPing(c, now);
      // Otomatik kalitede hiç gidiş-dönüş ölçümü yoksa (akış yeni başladı) bir kez yolların boşalması beklenir: temiz ping.
      if (c.auto && !c.auto.rtts.length && !c.pingAt && c.inflight.length) { wait = Math.min(wait, ACK_TIMEOUT_MS); continue; }
      if (c.held) { wait = Math.min(wait, ACK_TIMEOUT_MS); continue; } // önceden yakalanan kare onayı bekliyor
      const timeLeft = c.nextDue - now;
      if (c.inflight.length >= JPEG_INFLIGHT) {
        // Yollar dolu: en eski karenin onayının tahmini gelişine yakalama süresi kadar kala önceden yakala.
        const freeIn = c.ackMs == null ? Infinity : c.inflight[0].at + c.ackMs - (c.capMs || 0) - now;
        const left = Math.max(timeLeft, freeIn);
        if (left <= EARLY_MS) due.push(c);
        else wait = Math.min(wait, Number.isFinite(left) ? left - EARLY_MS : ACK_TIMEOUT_MS - (now - c.inflight[0].at));
        continue;
      }
      // İkinci kare, ilki sunucunun gönderim tamponundan çıkmadan yollanmaz.
      if (c.inflight.length && c.bufferedAmount > 0) { wait = Math.min(wait, 16); continue; }
      if (timeLeft <= EARLY_MS) due.push(c); else wait = Math.min(wait, timeLeft - EARLY_MS);
    }
    if (!due.length) { await nap(Math.max(1, wait)); continue; }

    const groups = new Map();
    for (const c of due) {
      const p = jpegParams(c);
      const key = `${p.quality} ${p.maxWidth} ${c.session.view.screen}`;
      if (!groups.has(key)) groups.set(key, { p, list: [] });
      groups.get(key).list.push(c);
    }

    for (const [key, { p, list }] of groups) {
      let frame;
      const t0 = performance.now();
      try { frame = await helper.request(`cap ${key}`); } catch { await sleep(300); continue; }
      const t = performance.now();
      for (const c of list) {
        const v = c.session.view;
        c.capMs = Math.round(t - t0); // yakalama + JPEG sıkıştırma süresi (gecikme sayacı için)
        // Hedef aralığa göre ilerle; bir aralıktan fazla geride kalındıysa (ack beklendi) yeniden başla, toplu kare atma.
        const period = 1000 / v.fps;
        c.nextDue = t0 - c.nextDue < period ? c.nextDue + period : t0 + period;
        if (!frame.length || c.readyState !== 1 || !c.streaming) continue;
        if (!c.needsFrame && c.lastFrame && frame.equals(c.lastFrame)) {
          // Ekran durağan: kare gönderilmez. İstemci bundan sonraki aralığı takılma saymasın diye bir kez bildirilir.
          if (!c.still) { c.still = true; sendJson(c, { t: 'durgun' }); }
          continue;
        }
        if (c.inflight.length >= JPEG_INFLIGHT) c.held = { frame, p, at: t }; // onay gelince gönderilir (jpegAck)
        else sendJpeg(c, frame, p, t);
      }
    }
  }
}

// ---------- Başlat ----------

function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
}

captureLoop();
const features = ext.init({
  helper, video, store, clients, sendJson, buildExe, PORT, kick, clientInfo,
  dataDir: store.DATA_DIR,
  guestCode: () => (store.settings.guestOtp ? guestCode : null),
  broadcast(obj, filter = () => true) { for (const c of clients) if (filter(c)) sendJson(c, obj); },
});
if (features.length) console.log(`  Özellikler    : ${features.join(', ')}`);
const encs = detectEncoders();
console.log(encs.length
  ? `  H.264 kodlayıcı: ${encs.map((e) => e.label).join(', ')} (ilk çalışan kullanılır)`
  : '  H.264 kodlayıcı: yok (ffmpeg bulunamadı) — yalnızca JPEG');
vdd.reset().then((ok) => console.log(ok ? '  Sanal ekran sürücüsü: hazır' : '  Sanal ekran sürücüsü: kurulu değil (surucu-kur.bat)'));

server.listen(PORT, '0.0.0.0', async () => {
  const tsi = await tailscaleInfo();
  console.log('\n=== Uzaktan Bağlantı sunucusu çalışıyor ===');
  for (const ip of lanAddresses()) if (ip !== tsi.ip) console.log(`  Ev ağı       : http://${ip}:${PORT}`);
  console.log(`  Bu bilgisayar: http://localhost:${PORT}`);
  if (tsi.running) {
    if (tsi.httpsUrl) console.log(`  Her yerden   : ${tsi.httpsUrl}   (Tailscale, önerilen)`);
    console.log(`  Her yerden   : http://${tsi.dns || tsi.ip}:${PORT}   (Tailscale)`);
  } else {
    console.log(`  Her yerden   : ${tsi.installed ? 'Tailscale kapalı — açıp giriş yapın' : 'Tailscale kurulu değil (tailscale-kur.bat)'}`);
  }
  if (!store.hasUsers()) console.log(`\n  İLK KURULUM: Bu bilgisayarda http://localhost:${PORT} adresini açıp yönetici hesabını oluşturun.`);
  if (store.settings.guestOtp) console.log(`  Misafir kodu : ${guestCode}  (her kullanımdan sonra değişir)`);
  console.log('');
});
