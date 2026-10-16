// Güç menüsü (features/guc.js): yalnızca yönetici, doğru komut, duyuru. KURU MOD — gerçek komut ÇALIŞTIRILMAZ.
// @ortam REMOTE_GUC_KURU=1
const path = require('path');
const ROOT = path.join(__dirname, '..');
const WebSocket = require(path.join(ROOT, 'node_modules', 'ws'));
const URL = `ws://localhost:${process.env.TEST_PORT || 3999}`;

// Güvenlik: kuru mod değilse hiçbir şey gönderme.
if (process.env.REMOTE_GUC_KURU !== '1') {
  console.log('FAIL REMOTE_GUC_KURU=1 değil, test çalıştırılmadı (gerçek güç komutu riski)');
  process.exit(1);
}

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
      const w = { pred, resolve };
      waiters.push(w);
      setTimeout(() => {
        const i = waiters.indexOf(w);
        if (i < 0) return;
        waiters.splice(i, 1); // zaman aşan bekleyici sonraki mesajı yutmasın
        reject(new Error('timeout waiting'));
      }, ms);
    });
  };
  const none = async (pred, ms = 1200) => { try { await next(pred, ms); return false; } catch { return true; } };
  const send = (o) => ws.send(JSON.stringify(o));
  const closed = new Promise((r) => ws.on('close', (c) => r(c)));
  return { ws, next, none, send, closed };
}
const t = (type) => (m) => m.t === type;
let pass = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${name} ${extra}`);
  if (cond) pass++; else process.exitCode = 1;
}

async function login(username, password) {
  const c = client();
  await c.next(t('hello'));
  c.send({ t: 'login', username, password, remember: false });
  const r = await c.next(t('auth'));
  if (!r.ok) throw new Error(`${username} giriş yapamadı: ${r.error}`);
  return c;
}

(async () => {
  const a = client();
  await a.next(t('hello'));
  a.send({ t: 'setup', username: 'ahmet', password: 'gizli123', remember: false });
  check('yönetici oluşturuldu', (await a.next(t('auth'))).ok);
  a.send({ t: 'admin', op: 'addUser', username: 'kontrolcu', password: 'kontrol1', role: 'control' });
  await a.next(t('adminData'));
  a.send({ t: 'admin', op: 'addUser', username: 'izleyici', password: 'izle1234', role: 'view' });
  await a.next(t('adminData'));

  // 1. Yönetici dışı roller reddedilir, duyuru yapılmaz
  for (const [u, p] of [['kontrolcu', 'kontrol1'], ['izleyici', 'izle1234']]) {
    const c = await login(u, p);
    for (const islem of ['kilitle', 'kapat']) {
      c.send({ t: 'guc', islem });
      const e = await c.next((m) => m.t === 'error' || m.t === 'guc-sonuc');
      check(`${u}: ${islem} reddedildi`, e.t === 'error' && /yetki/i.test(e.msg), e.msg || JSON.stringify(e));
    }
    check(`${u}: reddedilen istek duyurulmadı`, await a.none(t('guc-duyuru')));
    c.ws.close(); await c.closed;
  }

  // Misafir (varsayılan rol: kontrol) da reddedilir
  a.send({ t: 'admin', op: 'list' });
  const guestCode = (await a.next(t('adminData'))).guestCode;
  const g = client();
  await g.next(t('hello'));
  g.send({ t: 'guest', code: guestCode });
  check('misafir girdi', (await g.next(t('auth'))).ok);
  g.send({ t: 'guc', islem: 'yeniden' });
  const ge = await g.next((m) => m.t === 'error' || m.t === 'guc-sonuc');
  check('misafir: yeniden başlat reddedildi', ge.t === 'error', ge.msg);

  // 2. Yönetici: doğru komut (çalıştırılmadan)
  const izleyen = await login('izleyici', 'izle1234'); // duyuruyu herkesin aldığını görmek için
  const beklenen = {
    kilitle: /^rundll32\.exe user32\.dll,LockWorkStation$/,
    uyku: /^rundll32\.exe powrprof\.dll,SetSuspendState 0,1,0$/,
    yeniden: /^shutdown\.exe \/r \/t 30 \/c "Uzaktan Bağlantı: ahmet tarafından yeniden başlatılıyor"$/,
    kapat: /^shutdown\.exe \/s \/t 30 \/c "Uzaktan Bağlantı: ahmet tarafından kapatılıyor"$/,
    iptal: /^shutdown\.exe \/a$/,
  };
  for (const [islem, re] of Object.entries(beklenen)) {
    a.send({ t: 'guc', islem });
    const s = await a.next(t('guc-sonuc'));
    check(`yönetici: ${islem} → doğru komut, kuru mod`, s.ok && s.kuru === true && re.test(s.komut), s.komut || s.hata);
    const d = await izleyen.next(t('guc-duyuru'));
    check(`  ${islem} herkese duyuruldu`, d.islem === islem && d.kullanici === 'ahmet' && d.kuru === true
      && (islem === 'yeniden' || islem === 'kapat' ? d.iptalSn === 30 : d.iptalSn === undefined), d.metin);
    await a.next(t('guc-duyuru'));
  }

  // 3. Geçersiz işlem, çift tıklama koruması
  a.send({ t: 'guc', islem: 'format-c' });
  let s = await a.next(t('guc-sonuc'));
  check('geçersiz işlem reddedildi', !s.ok && !s.komut, s.hata);
  a.send({ t: 'guc', islem: 'kilitle' });
  s = await a.next(t('guc-sonuc'));
  check('ilk kilitle kabul', s.ok);
  await a.next(t('guc-duyuru'));
  a.send({ t: 'guc', islem: 'kilitle' });
  s = await a.next(t('guc-sonuc'));
  check('3 sn içinde aynı işlem tekrar edilmez', !s.ok, s.hata);

  // 4. Günlüğe yazıldı
  a.send({ t: 'admin', op: 'list' });
  const log = (await a.next(t('adminData'))).log.filter((l) => l.event === 'guc');
  check('güç işlemleri günlükte', log.length >= 6 && log.every((l) => l.user === 'ahmet') && log.some((l) => l.op === 'kapat'), `(${log.length} kayıt)`);

  console.log(`\n${pass} kontrol geçti`);
  process.exit();
})().catch((e) => { console.error('TEST HATASI', e); process.exit(1); });
