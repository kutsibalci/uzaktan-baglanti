// "Ortak ağdan ev ağı girişini kapat" (server.js allowed + lib/agprofili.js): Windows'ta Ortak olarak işaretli ağdan gelen
// ev ağı bağlantıları reddedilir; bu bilgisayar ve Tailscale etkilenmez; ayar kapatılınca ev ağı yine girer.
// Sahte profil: bütün adresler Ortak. Ev ağı bağlantısı bu bilgisayarın kendi ev ağı adresine bağlanarak denenir.
// @ortam REMOTE_AG_PROFILI_SAHTE={"*":"Public"}
const path = require('path');
const os = require('os');
const http = require('http');
const ROOT = path.join(__dirname, '..');
const WebSocket = require(path.join(ROOT, 'node_modules', 'ws'));
const agProfili = require(path.join(ROOT, 'lib', 'agprofili'));
const PORT = process.env.TEST_PORT || 3999;

let pass = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${name} ${extra}`);
  if (cond) pass++; else process.exitCode = 1;
}

function get(host, headers = {}) {
  return new Promise((resolve) => {
    const req = http.get({ host, port: PORT, path: '/', headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', (e) => resolve({ status: 0, body: e.message }));
  });
}

// WebSocket açılıp 'hello' gelirse true, reddedilirse HTTP kodu.
function wsDene(host) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://${host}:${PORT}`);
    const bitir = (v) => { try { ws.terminate(); } catch {} resolve(v); };
    ws.on('message', (d) => { if (JSON.parse(d.toString()).t === 'hello') bitir(true); });
    ws.on('unexpected-response', (_req, res) => bitir(res.statusCode));
    ws.on('error', () => bitir(false));
    setTimeout(() => bitir('zaman aşımı'), 8000);
  });
}

function client() {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  const queue = [];
  const waiters = [];
  ws.on('message', (d, bin) => {
    if (bin) return;
    const msg = JSON.parse(d.toString());
    const i = waiters.findIndex((w) => w.pred(msg));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg); else queue.push(msg);
  });
  const next = (pred, ms = 8000) => {
    const i = queue.findIndex(pred);
    if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      waiters.push(w);
      setTimeout(() => { const j = waiters.indexOf(w); if (j >= 0) { waiters.splice(j, 1); reject(new Error('timeout waiting')); } }, ms);
    });
  };
  const send = (o) => ws.send(JSON.stringify(o));
  return { ws, next, send };
}
const t = (type) => (m) => m.t === type;

// Bu bilgisayarın ev ağı adresi (geri döngü, APIPA ve Tailscale değil).
function evAgiAdresi() {
  for (const a of Object.values(os.networkInterfaces()).flat()) {
    if (!a || a.family !== 'IPv4' || a.internal) continue;
    const [x, y] = a.address.split('.').map(Number);
    if (x === 169 && y === 254) continue;
    if (x === 100 && y >= 64 && y <= 127) continue;
    if (x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168)) return a.address;
  }
  return null;
}

(async () => {
  // 1. Saf: sahte harita, IPv4'e eşlenmiş IPv6 biçimi, varsayılan '*'
  const eski = process.env.REMOTE_AG_PROFILI_SAHTE;
  process.env.REMOTE_AG_PROFILI_SAHTE = '{"10.1.1.1":"Private","10.2.2.2":"DomainAuthenticated","*":"Public"}';
  check('Özel ağdaki adres Ortak değil', agProfili.ortakMi('10.1.1.1') === false);
  check('::ffff: biçimi de tanınıyor', agProfili.ortakMi('::ffff:10.1.1.1') === false);
  check('etki alanı ağı Ortak değil', agProfili.ortakMi('10.2.2.2') === false);
  check('haritada olmayan adres * (Ortak)', agProfili.ortakMi('10.9.9.9') === true);
  process.env.REMOTE_AG_PROFILI_SAHTE = '{}';
  check('boş harita: hiçbir adres Ortak değil', agProfili.ortakMi('10.9.9.9') === false);
  if (eski === undefined) delete process.env.REMOTE_AG_PROFILI_SAHTE; else process.env.REMOTE_AG_PROFILI_SAHTE = eski;

  // 2. Gerçek okuma (yalnızca okur, yönetici gerektirmez)
  const t0 = Date.now();
  const gercek = await agProfili.powershellOku();
  const ms = Date.now() - t0;
  const yerel = new Set(Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4').map((a) => a.address));
  check('Windows ağ profilleri okundu', Array.isArray(gercek) && gercek.length > 0, `(${gercek.length} adres, ${ms} ms)`);
  check('okunan adresler bu bilgisayarın', gercek.some((x) => yerel.has(x.ip)));
  check('kategoriler geçerli', gercek.every((x) => x.k === null || ['Public', 'Private', 'DomainAuthenticated'].includes(x.k)),
    gercek.filter((x) => x.k).map((x) => `${x.arayuz}=${x.k}`).join(', '));

  // 3. Sunucu: ev ağı (sahte Ortak) reddedilir, bu bilgisayar ve Tailscale girer
  const lan = evAgiAdresi();
  if (!lan) {
    console.log('FAIL bu bilgisayarda ev ağı adresi yok, ev ağı bağlantısı denenemedi');
    process.exitCode = 1;
    return;
  }
  let r = await get(lan);
  check(`Ortak ağdan (${lan}) sayfa reddedildi`, r.status === 403 && r.body.includes('Ortak'), `(${r.status})`);
  check('Ortak ağdan WebSocket reddedildi', (await wsDene(lan)) !== true);
  r = await get('localhost');
  check('bu bilgisayar (localhost) giriyor', r.status === 200, `(${r.status})`);
  r = await get('127.0.0.1', { 'X-Forwarded-For': '100.64.10.20', Host: 'bilgisayar.ornek.ts.net' });
  check('Tailscale (tailscale serve) giriyor', r.status === 200, `(${r.status})`);

  // 4. Ayar: varsayılan açık, kapatılınca ev ağı girer, açılınca yine reddedilir
  const a = client();
  await a.next(t('hello'));
  a.send({ t: 'setup', username: 'ahmet', password: 'gizli123', remember: false });
  check('yönetici oluşturuldu', (await a.next(t('auth'))).ok);
  a.send({ t: 'admin', op: 'list' });
  let d = await a.next(t('adminData'));
  check('ayar varsayılan açık', d.settings.blockPublicLan === true);
  check('yönetim verisinde ağ listesi', Array.isArray(d.networks));
  a.send({ t: 'admin', op: 'setSetting', key: 'blockPublicLan', value: false });
  d = await a.next(t('adminData'));
  check('ayar kapatıldı', d.settings.blockPublicLan === false);
  r = await get(lan);
  check('ayar kapalıyken Ortak ağdan sayfa açılıyor', r.status === 200, `(${r.status})`);
  check('ayar kapalıyken Ortak ağdan WebSocket açılıyor', (await wsDene(lan)) === true);
  a.send({ t: 'admin', op: 'setSetting', key: 'blockPublicLan', value: true });
  d = await a.next(t('adminData'));
  r = await get(lan);
  check('yeniden açılınca Ortak ağdan yine reddediliyor', d.settings.blockPublicLan === true && r.status === 403, `(${r.status})`);
  a.ws.close();

  console.log(`${pass} kontrol geçti`);
})().catch((e) => { console.log('FAIL', e.message); process.exitCode = 1; });
