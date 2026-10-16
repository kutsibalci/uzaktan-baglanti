// Tepsi simgesi uçları (features/tepsi.js): yalnızca bu bilgisayar + belirteç, durum, kes, olay akışı, kapat.
// @ortam TRAY_TOKEN=test-tepsi-belirteci-0123456789abcdef
const path = require('path');
const http = require('http');
const ROOT = path.join(__dirname, '..');
const WebSocket = require(path.join(ROOT, 'node_modules', 'ws'));
const PORT = Number(process.env.TEST_PORT || 3999);
const URL = `ws://localhost:${PORT}`;
const TOKEN = process.env.TRAY_TOKEN;

function client() {
  const ws = new WebSocket(URL);
  const queue = [];
  const waiters = [];
  ws.on('message', (d, bin) => {
    const msg = bin ? { t: 'frame', size: d.length } : JSON.parse(d.toString());
    const i = waiters.findIndex((w) => w.pred(msg));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg); else queue.push(msg);
  });
  const next = (pred = () => true, ms = 8000) => {
    const i = queue.findIndex(pred);
    if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      waiters.push({ pred, resolve });
      setTimeout(() => reject(new Error('timeout waiting')), ms);
    });
  };
  const send = (o) => ws.send(JSON.stringify(o));
  const closed = new Promise((r) => ws.on('close', (c) => r(c)));
  return { ws, next, send, closed };
}
const t = (type) => (m) => m.t === type;
let pass = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${name} ${extra}`);
  if (cond) pass++; else process.exitCode = 1;
}

// host: Host başlığı (varsayılan localhost), headers: ek başlıklar
function request(method, pathName, { token, headers = {}, body, host } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (token !== undefined) h['X-Tepsi'] = token;
    if (host) h.Host = host;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path: pathName, headers: h }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* düz metin */ }
        resolve({ status: res.statusCode, body: data, json });
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('zaman aşımı')));
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

// Olay akışı (SSE): gelen "data:" satırlarını sıraya koyar.
function events() {
  const queue = [];
  const waiters = [];
  let status = 0;
  let req;
  const ready = new Promise((resolve, reject) => {
    req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/tepsi/olaylar', headers: { 'X-Tepsi': TOKEN } }, (res) => {
      status = res.statusCode;
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = block.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          const ev = JSON.parse(line.slice(6));
          const w = waiters.findIndex((x) => x.pred(ev));
          if (w >= 0) waiters.splice(w, 1)[0].resolve(ev); else queue.push(ev);
        }
      });
      resolve();
    });
    req.on('error', reject);
    req.end();
  });
  const next = (pred, ms = 6000) => {
    const i = queue.findIndex(pred);
    if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      waiters.push({ pred, resolve });
      setTimeout(() => reject(new Error('olay gelmedi')), ms);
    });
  };
  return { ready, next, status: () => status, close: () => req.destroy() };
}
const ev = (tur, user) => (e) => e.tur === tur && (!user || e.kisi?.kullanici === user);

(async () => {
  check('test belirteci ortamda', !!TOKEN && TOKEN.length >= 16);

  // Kurulum: yönetici + izleyici hesabı
  const a = client();
  await a.next(t('hello'));
  a.send({ t: 'setup', username: 'ahmet', password: 'gizli123', remember: false, deviceName: 'Test PC' });
  let r = await a.next(t('auth'));
  check('yönetici oluşturuldu', r.ok && r.role === 'admin');
  a.send({ t: 'admin', op: 'addUser', username: 'izleyici', password: 'izle1234', role: 'view' });
  await a.next(t('adminData'));

  // 1. Erişim denetimi
  r = await request('GET', '/api/tepsi/durum');
  check('belirteçsiz → 401', r.status === 401, `(${r.status})`);
  r = await request('GET', '/api/tepsi/durum', { token: 'yanlis-belirtec-0123456789abcdef' });
  check('yanlış belirteç → 401', r.status === 401, `(${r.status})`);
  r = await request('GET', '/api/tepsi/durum', { token: TOKEN.slice(0, -1) });
  check('eksik belirteç → 401', r.status === 401, `(${r.status})`);
  r = await request('GET', '/api/tepsi/durum', { token: TOKEN, headers: { 'X-Forwarded-For': '100.101.102.103', 'Tailscale-User-Login': 'biri@ornek.com' } });
  check('tailscale serve yönlendirmesi (doğru belirteçle bile) → 403', r.status === 403, `(${r.status})`);
  r = await request('GET', '/api/tepsi/durum', { token: TOKEN, host: 'kotu-site.example:3000' });
  check('localhost olmayan Host (DNS yeniden bağlama) → 403', r.status === 403, `(${r.status})`);
  r = await request('POST', '/api/tepsi/kes', { token: 'yanlis', body: { hepsi: true } });
  check('kes: yanlış belirteç → 401', r.status === 401, `(${r.status})`);
  r = await request('GET', '/api/tepsi/olaylar', { token: 'yanlis' });
  check('olaylar: yanlış belirteç → 401', r.status === 401, `(${r.status})`);
  r = await request('POST', '/api/tepsi/kapat', { headers: { 'X-Forwarded-For': '100.64.0.1' }, token: TOKEN });
  check('kapat: yerel olmayan → 403', r.status === 403, `(${r.status})`);
  r = await request('GET', '/api/tepsi/durumxyz', { token: TOKEN });
  check('bilinmeyen alt yol → 404', r.status === 404, `(${r.status})`);

  // 2. Durum
  r = await request('GET', '/api/tepsi/durum', { token: TOKEN });
  check('durum → 200 JSON', r.status === 200 && !!r.json, `(${r.status})`);
  const d = r.json || {};
  check('durum: port', d.port === PORT, `(${d.port})`);
  check('durum: misafir kodu 6 hane', /^\d{6}$/.test(String(d.misafirKodu)), `(${d.misafirKodu})`);
  const ahmet = (d.kisiler || []).find((k) => k.kullanici === 'ahmet');
  check('durum: bağlı kişi listesi', !!ahmet && ahmet.id > 0 && ahmet.via === 'local' && ahmet.ip && ahmet.izliyor === false,
    JSON.stringify(ahmet || {}));
  check('durum: tailscale alanı var', 'tailscale' in d, `(${JSON.stringify(d.tailscale)})`);

  // 3. Olay akışı
  const es = events();
  await es.ready;
  check('olay akışı açıldı', es.status() === 200);
  const hello = await es.next(ev('merhaba'));
  check('olay: merhaba', hello.izleyen === 0);

  const b = client();
  await b.next(t('hello'));
  b.send({ t: 'login', username: 'izleyici', password: 'izle1234', remember: false, deviceName: 'Android · Chrome' });
  r = await b.next(t('auth'));
  check('ikinci kişi bağlandı', r.ok);
  let e = await es.next(ev('baglandi', 'izleyici'));
  check('olay: baglandi', e.kisi.cihaz === 'Android · Chrome' && e.kisi.viaAd === 'bu bilgisayar' && e.kisi.id > 0, JSON.stringify(e.kisi));
  const bId = e.kisi.id;

  b.send({ t: 'start', mode: 'control' });
  await b.next(t('started'));
  e = await es.next(ev('izleme-basladi', 'izleyici'));
  check('olay: izleme-basladi', e.izleyen === 1 && e.kisi.izliyor === true);
  r = await request('GET', '/api/tepsi/durum', { token: TOKEN });
  check('durum: izliyor + izleyen sayısı', r.json.izleyen === 1 && r.json.kisiler.find((k) => k.id === bId)?.izliyor === true);
  b.send({ t: 'stop' });
  e = await es.next(ev('izleme-bitti', 'izleyici'));
  check('olay: izleme-bitti', e.izleyen === 0);

  // 4. Kes (belirli bağlantı)
  r = await request('POST', '/api/tepsi/kes', { token: TOKEN, body: 'bozuk{' });
  check('kes: bozuk gövde → 400', r.status === 400, `(${r.status})`);
  r = await request('POST', '/api/tepsi/kes', { token: TOKEN, body: { id: 'x' } });
  check('kes: geçersiz id → 400', r.status === 400, `(${r.status})`);
  r = await request('POST', '/api/tepsi/kes', { token: TOKEN, body: { id: 1, dolgu: 'x'.repeat(4000) } }).catch((er) => ({ status: 0, err: er.message }));
  check('kes: büyük gövde reddedildi', r.status !== 200, `(${r.status || r.err})`);
  r = await request('POST', '/api/tepsi/kes', { token: TOKEN, body: { id: 999999 } });
  check('kes: olmayan id → 0 kesilen', r.status === 200 && r.json.kesilen === 0);
  b.send({ t: 'start', mode: 'control' });
  await b.next(t('started'));
  await es.next(ev('izleme-basladi', 'izleyici'));
  r = await request('POST', '/api/tepsi/kes', { token: TOKEN, body: { id: bId } });
  check('kes: id ile → 1 kesilen', r.status === 200 && r.json.kesilen === 1, r.body);
  const code = await Promise.race([b.closed, new Promise((res) => setTimeout(() => res('açık'), 3000))]);
  check('kesilen bağlantı gerçekten kapandı', code === 4002, `(${code})`);
  e = await es.next(ev('izleme-bitti', 'izleyici'));
  check('olay: kesilince izleme-bitti', e.izleyen === 0);
  e = await es.next(ev('ayrildi', 'izleyici'));
  check('olay: ayrildi (atılan hemen bildirilir)', e.kisi.id === bId);
  r = await request('GET', '/api/tepsi/durum', { token: TOKEN });
  check('durum: kesilen listede yok', !r.json.kisiler.some((k) => k.id === bId) && r.json.kisiler.some((k) => k.kullanici === 'ahmet'));
  check('yönetici bağlantısı açık kaldı', a.ws.readyState === 1);

  // 4b. Hatırlanan cihaz: kesildikten sonra kayıtlı anahtarla onaysız geri giremez
  const c = client();
  await c.next(t('hello'));
  c.send({ t: 'login', username: 'izleyici', password: 'izle1234', remember: true, deviceName: 'Tablet' });
  r = await c.next(t('auth'));
  check('hatırlanan cihazla giriş', r.ok && typeof r.token === 'string', JSON.stringify({ ok: r.ok, token: !!r.token }));
  const cihazAnahtari = r.token;
  e = await es.next(ev('baglandi', 'izleyici'));
  r = await request('POST', '/api/tepsi/kes', { token: TOKEN, body: { id: e.kisi.id } });
  check('kes: hatırlanan cihaz kesildi', r.status === 200 && r.json.kesilen === 1, r.body);
  check('hatırlanan cihaz bağlantısı kapandı', (await Promise.race([c.closed, new Promise((res) => setTimeout(() => res('açık'), 3000))])) === 4002);
  await es.next(ev('ayrildi', 'izleyici'));
  const c2 = client();
  await c2.next(t('hello'));
  c2.send({ t: 'token', token: cihazAnahtari });
  r = await c2.next(t('auth'));
  check('kesilen cihaz kayıtlı anahtarla geri giremiyor', r.ok === false, JSON.stringify(r));
  c2.ws.close();

  // 5. Kes (hepsi)
  r = await request('POST', '/api/tepsi/kes', { token: TOKEN, body: { hepsi: true } });
  check('kes: hepsi', r.status === 200 && r.json.kesilen === 1, r.body);
  check('yönetici de kesildi', (await Promise.race([a.closed, new Promise((res) => setTimeout(() => res('açık'), 3000))])) === 4002);
  await es.next(ev('ayrildi', 'ahmet'));
  r = await request('GET', '/api/tepsi/durum', { token: TOKEN });
  check('durum: kimse kalmadı', r.json.kisiler.length === 0);

  // 6. Kapat (en son: sunucuyu kapatır)
  r = await request('POST', '/api/tepsi/kapat', { token: 'yanlis' });
  check('kapat: yanlış belirteç → 401', r.status === 401);
  r = await request('POST', '/api/tepsi/kapat', { token: TOKEN, body: {} });
  check('kapat → 200', r.status === 200);
  es.close();
  await new Promise((res) => setTimeout(res, 2000));
  const after = await request('GET', '/api/tepsi/durum', { token: TOKEN }).then((x) => x.status, () => 'kapalı');
  check('sunucu kapandı', after === 'kapalı', `(${after})`);

  console.log(`\n${pass} kontrol geçti`);
  process.exit();
})().catch((e) => { console.error('TEST HATASI', e); process.exit(1); });
