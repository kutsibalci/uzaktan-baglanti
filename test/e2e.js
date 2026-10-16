// Uçtan uca test: kurulum, token, hatalı şifre, misafir kodu, yayın+ack, yönetim, sanal ekran, resume
const path = require('path');
const ROOT = path.join(__dirname, '..');
const WebSocket = require(path.join(ROOT, 'node_modules', 'ws'));
const fs = require('fs');
const URL = `ws://localhost:${process.env.TEST_PORT || 3999}`;

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
  const opened = new Promise((r) => ws.on('open', r));
  const closed = new Promise((r) => ws.on('close', (c) => r(c)));
  return { ws, next, send, opened, closed };
}
const t = (type) => (m) => m.t === type;
let pass = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${name} ${extra}`);
  if (cond) pass++; else process.exitCode = 1;
}

(async () => {
  // 1. Kurulum
  let c = client();
  let hello = await c.next(t('hello'));
  check('hello: kurulum gerekli ve localhost kurabilir', hello.needsSetup && hello.canSetup);
  c.send({ t: 'setup', username: 'ahmet', password: 'kisa', remember: true });
  let r = await c.next(t('auth'));
  check('kısa şifre reddedildi', !r.ok, r.error);
  c.send({ t: 'setup', username: 'ahmet', password: 'gizli123', remember: true, deviceName: 'Test PC' });
  r = await c.next(t('auth'));
  check('yönetici oluşturuldu + cihaz anahtarı', r.ok && r.role === 'admin' && !!r.token && !!r.resume);
  const token = r.token, resume = r.resume;
  check('ekran listesi geldi', r.screens.length >= 1, `(${r.screens.length} ekran, vdd=${r.vdd})`);

  // 2. Görüntü + ack
  c.send({ t: 'start', mode: 'control' });
  const st = await c.next(t('started'));
  check('yayın başladı', st.mode === 'control' && !!st.screen, st.screen);
  const f1 = await c.next(t('frame'));
  check('ilk kare', f1.size > 1000, `${(f1.size / 1024).toFixed(0)} KB`);
  let gotWithoutAck = false;
  try { await c.next(t('frame'), 1200); gotWithoutAck = true; } catch {}
  check('ack olmadan yeni kare gelmedi', !gotWithoutAck);
  c.send({ t: 'ack' });

  // 3. Yönetim
  c.send({ t: 'admin', op: 'addUser', username: 'izleyici', password: 'izle1234', role: 'view' });
  let a = await c.next(t('adminData'));
  check('kullanıcı eklendi', a.users.some((u) => u.username === 'izleyici' && u.role === 'view') && !a.error, a.error || '');
  check('cihaz listede, token hash gizli', a.devices.length === 1 && !('tokenHash' in a.devices[0]));
  c.send({ t: 'admin', op: 'deleteUser', username: 'ahmet' });
  a = await c.next(t('adminData'));
  check('son yönetici silinemez', !!a.error, a.error);
  const guestCode = a.guestCode;

  // 4. Sanal ekran (sürücü yoksa anlamlı hata)
  c.send({ t: 'start', mode: 'extend', w: 2400, h: 1600 });
  const ev = await c.next((m) => m.t === 'error' || m.t === 'started', 20000);
  check('ikinci ekran isteği cevaplandı', true, ev.t === 'error' ? `→ ${ev.msg}` : `→ başladı ${ev.screen}`);
  c.send({ t: 'stop' });
  c.ws.close();
  await c.closed;

  // 5. Hatırlanan cihaz ile giriş
  c = client();
  await c.next(t('hello'));
  c.send({ t: 'token', token });
  r = await c.next(t('auth'));
  check('cihaz anahtarıyla şifresiz giriş', r.ok && r.username === 'ahmet');
  c.ws.close(); await c.closed;

  // 6. Resume
  c = client();
  await c.next(t('hello'));
  c.send({ t: 'resume', token: resume });
  r = await c.next(t('auth'));
  check('kopma sonrası oturum devamı', r.ok && r.resumed);
  c.ws.close(); await c.closed;

  // 7. Hatalı şifre, salt izleme yetkisi
  c = client();
  await c.next(t('hello'));
  c.send({ t: 'login', username: 'ahmet', password: 'yanlis', remember: false });
  r = await c.next(t('auth'));
  check('hatalı şifre reddedildi', !r.ok, r.error);
  c.send({ t: 'login', username: 'izleyici', password: 'izle1234', remember: false });
  r = await c.next(t('auth'));
  check('salt izleme kullanıcısı girişi (localhost onaysız)', r.ok && r.role === 'view' && !r.token);
  c.send({ t: 'start', mode: 'extend', w: 1920, h: 1080 });
  const e2 = await c.next(t('error'));
  check('salt izleme ikinci ekran açamaz', /yetki/.test(e2.msg), e2.msg);
  c.send({ t: 'admin', op: 'list' });
  const e3 = await c.next(t('error'));
  check('salt izleme yönetime giremez', /yönetici/.test(e3.msg));
  c.ws.close(); await c.closed;

  // 8. Misafir kodu tek seferlik
  c = client();
  await c.next(t('hello'));
  c.send({ t: 'guest', code: guestCode });
  r = await c.next(t('auth'));
  check('misafir kodu ile giriş', r.ok && r.guest);
  c.ws.close(); await c.closed;
  c = client();
  await c.next(t('hello'));
  c.send({ t: 'guest', code: guestCode });
  r = await c.next(t('auth'));
  check('aynı misafir kodu ikinci kez çalışmaz', !r.ok, r.error);
  c.ws.close(); await c.closed;

  console.log(`\n${pass} kontrol geçti`);
  process.exit();
})().catch((e) => { console.error('TEST HATASI', e); process.exit(1); });
