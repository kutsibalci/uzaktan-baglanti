// Pano eşitleme testi: istemci -> bilgisayar panosu, bilgisayar panosu -> istemci, ayar, yetkiler, süreç yaşam döngüsü.
// GERÇEK pano kullanılır: başta mevcut metin kaydedilir, sonda (hata olsa bile) geri yüklenir.
// Panoda metin dışı bir şey (resim, dosya) varsa kaybolmasın diye panoya yazan adımlar atlanır.
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const WebSocket = require(path.join(ROOT, 'node_modules', 'ws'));
const PORT = process.env.TEST_PORT || 3999;
const URL = `ws://localhost:${PORT}`;
const TMP = fs.mkdtempSync(path.join(process.env.TEST_TMP || os.tmpdir(), 'pano-'));
const PANO_EXE = path.join(ROOT, 'helper', 'Pano.exe');

function client() {
  const ws = new WebSocket(URL);
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
      setTimeout(() => { const j = waiters.indexOf(w); if (j >= 0) waiters.splice(j, 1); reject(new Error('timeout waiting')); }, ms);
    });
  };
  const none = async (pred, ms) => { try { await next(pred, ms); return false; } catch { return true; } };
  const send = (o) => ws.send(JSON.stringify(o));
  const opened = new Promise((r) => ws.on('open', r));
  const closed = new Promise((r) => ws.on('close', (c) => r(c)));
  return { ws, next, none, send, opened, closed, queue };
}
const t = (type) => (m) => m.t === type;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${name} ${extra}`);
  if (cond) pass++; else process.exitCode = 1;
}

// ---------- Gerçek pano (PowerShell ile, sunucudan bağımsız) ----------
function ps(cmd) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', timeout: 30000 }).trim();
}
function panoOku() {
  const b = ps("$t = Get-Clipboard -Raw; if ($null -eq $t) { 'YOK' } else { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t)) }");
  return b === 'YOK' ? null : Buffer.from(b, 'base64').toString('utf8');
}
function panoYaz(metin) {
  // Uzun metinler komut satırına sığmaz: geçici dosya üzerinden.
  const f = path.join(TMP, 'pano.txt');
  fs.writeFileSync(f, metin, 'utf8');
  ps(`Set-Clipboard -Value ([IO.File]::ReadAllText('${f.replace(/'/g, "''")}', [Text.Encoding]::UTF8))`);
}
function panoTemizle() {
  ps('Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::Clear()');
}
const metinDisiVar = () => ps("Add-Type -AssemblyName System.Windows.Forms; $d = [System.Windows.Forms.Clipboard]::GetDataObject(); if ($d -and ($d.GetDataPresent('Bitmap') -or $d.GetDataPresent('FileDrop'))) { 'EVET' } else { 'HAYIR' }") === 'EVET';
// Yalnızca test sunucusunun (PORT'u dinleyen node) başlattığı Pano.exe'ler sayılır;
// aynı klasörden çalışan başka bir sunucunun (ör. kullanıcının 3000'deki) Pano.exe'si sayılmaz.
const panoSurecSayisi = () => Number(ps(`$s = (Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess; @(Get-CimInstance Win32_Process -Filter "Name='Pano.exe'" | Where-Object { $_.ExecutablePath -eq '${PANO_EXE.replace(/'/g, "''")}' -and $_.ParentProcessId -eq $s }).Count`));

function postMetin(token, body) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(body, 'utf8');
    const req = http.request({ host: 'localhost', port: PORT, method: 'POST', path: '/api/pano/yaz', headers: { 'X-Oturum': token, 'Content-Length': buf.length } }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', (e) => resolve({ status: 0, body: e.message }));
    req.end(buf);
  });
}

async function giris(username, password) {
  const c = client();
  await c.next(t('hello'));
  c.send({ t: 'login', username, password, remember: false });
  const r = await c.next(t('auth'));
  return { c, r };
}

(async () => {
  let kayitli;
  let panoyaYazilabilir = true;
  if (metinDisiVar()) {
    panoyaYazilabilir = false;
    console.log('ATLANDI panoda resim/dosya var; kaybolmasın diye panoya yazan adımlar çalıştırılmayacak');
  } else {
    kayitli = panoOku();
  }
  const benzersiz = `rc-test-${Date.now()}`;
  try {
    // Kurulum: yönetici + salt izleme kullanıcısı
    const a = client();
    await a.next(t('hello'));
    a.send({ t: 'setup', username: 'ahmet', password: 'gizli123', remember: false });
    const ar = await a.next(t('auth'));
    check('yönetici oturumu', ar.ok);
    a.send({ t: 'admin', op: 'addUser', username: 'izleyici', password: 'izle1234', role: 'view' });
    let ad = await a.next(t('adminData'));
    check('pano yönetim verisi var, otomatik varsayılan açık', ad.features?.pano?.otomatik === true, JSON.stringify(ad.features?.pano));
    check('kontrol oturumu varken Pano.exe çalışıyor', ad.features?.pano?.calisiyor === true);
    await sleep(1000); // dinleyici kaydolsun

    const { c: b } = await giris('ahmet', 'gizli123'); // ikinci cihaz
    const { c: v, r: vr } = await giris('izleyici', 'izle1234');
    check('salt izleme girişi', vr.ok && vr.role === 'view');

    // Salt izleme yazamaz/okuyamaz
    v.send({ t: 'pano-yaz', text: 'izleyici yazmamalı' });
    let e = await v.next(t('error'));
    check('salt izleme pano-yaz reddedildi', /yetki/i.test(e.msg), e.msg);
    v.send({ t: 'pano-al' });
    e = await v.next(t('error'));
    check('salt izleme pano-al reddedildi', /yetki/i.test(e.msg));
    const vh = await postMetin(vr.http, 'izleyici');
    check('salt izleme HTTP pano yazma 403', vh.status === 403, `(${vh.status})`);
    const yh = await postMetin('yanlis-anahtar', 'x');
    check('oturumsuz HTTP pano yazma 401', yh.status === 401, `(${yh.status})`);

    if (panoyaYazilabilir) {
      // 1. İstemci -> bilgisayar
      const m1 = `Merhaba "dünya" \\ ğüşıöçĞÜŞİÖÇ 🚀 <&>\r\nikinci satır\ttab ${benzersiz}`;
      a.send({ t: 'pano-yaz', text: m1 });
      const y = await a.next(t('pano-yazildi'));
      check('pano-yaz başarılı', y.ok, y.msg || '');
      check('bilgisayar panosunda aynı metin (Türkçe, emoji, satır sonu, tırnak)', panoOku() === m1);
      const yanki = await a.next((m) => m.t === 'pano' && !m.istek && m.text === m1, 1200).catch(() => null);
      check('yazan istemciye geri yankı yok', !yanki, yanki ? JSON.stringify(yanki).slice(0, 120) : '');
      const bm = await b.next((m) => m.t === 'pano' && m.text === m1).catch(() => null);
      check('diğer kontrol cihazına yeni metin gitti', bm?.text === m1);
      check('salt izlemeye pano metni gitmedi', !v.queue.some((m) => m.t === 'pano'));

      // 2. Bilgisayar -> istemci
      const m2 = `bilgisayarda kopyalandı ğ ${benzersiz}`;
      panoYaz(m2);
      const p1 = await a.next((m) => m.t === 'pano' && !m.istek && m.text === m2, 8000).catch(() => null);
      check('bilgisayar panosu değişince istemciye pano mesajı', p1?.text === m2, p1 ? JSON.stringify(p1.text).slice(0, 60) : 'gelmedi');
      const p2 = await b.next((m) => m.t === 'pano' && m.text === m2, 8000).catch(() => null);
      check('ikinci cihaza da geldi', p2?.text === m2);
      await sleep(500);
      check('salt izlemeye bilgisayar panosu gitmedi', !v.queue.some((m) => m.t === 'pano'));

      // 3. pano-al
      a.send({ t: 'pano-al' });
      const al = await a.next((m) => m.t === 'pano' && m.istek);
      check('pano-al şu anki metni döndü', al.text === m2);

      // 4. Otomatik gönderme kapalı
      a.send({ t: 'pano-ayar', otomatik: false });
      const ay = await a.next(t('pano-ayar'));
      check('ayar kapatıldı', ay.otomatik === false);
      panoYaz(`kapaliyken ${benzersiz}`);
      check('otomatik kapalıyken pano mesajı gelmedi', await a.none(t('pano'), 2000));
      a.send({ t: 'pano-al' });
      const al2 = await a.next((m) => m.t === 'pano' && m.istek);
      check('kapalıyken pano-al yine çalışıyor', al2.text === `kapaliyken ${benzersiz}`);
      a.send({ t: 'pano-ayar', otomatik: true });
      await a.next(t('pano-ayar'));
      a.send({ t: 'admin', op: 'list' });
      ad = await a.next(t('adminData'));
      check('ayar kalıcı ve yönetim verisinde', ad.features.pano.otomatik === true);

      // 5. Büyük metin HTTP ile (WebSocket sınırı 64 KB)
      const buyuk = `${'büyük metin satırı 0123456789\n'.repeat(7000)}${benzersiz}`; // ~220 KB
      const hb = await postMetin(ar.http, buyuk);
      check('HTTP ile büyük metin yazıldı', hb.status === 200, `(${hb.status} ${hb.body.slice(0, 80)})`);
      check('bilgisayar panosunda büyük metin', panoOku() === buyuk);
      const cokBuyuk = await postMetin(ar.http, 'x'.repeat(1024 * 1024 + 10));
      check('1 MB üstü metin reddedildi (413)', cokBuyuk.status === 413, `(${cokBuyuk.status})`);
      a.send({ t: 'pano-yaz', text: '' });
      const bos = await a.next(t('pano-yazildi'));
      check('boş metin reddedildi', !bos.ok);
    }

    // 6. Süreç yaşam döngüsü: yalnızca salt izleme kalınca Pano.exe durur
    a.ws.close(); await a.closed;
    b.ws.close(); await b.closed;
    await sleep(3000);
    check('kontrol oturumu kalmayınca Pano.exe durdu', panoSurecSayisi() === 0, `(${panoSurecSayisi()} süreç)`);
    v.ws.close(); await v.closed;
  } finally {
    if (panoyaYazilabilir) {
      try {
        if (!kayitli) panoTemizle(); else panoYaz(kayitli);
        const geri = panoOku();
        console.log((kayitli ? geri === kayitli : !geri) ? '(pano geri yüklendi)' : 'UYARI: pano geri yüklemesi doğrulanamadı');
      } catch (err) {
        console.log('UYARI: pano geri yüklenemedi:', err.message);
      }
    }
    fs.rmSync(TMP, { recursive: true, force: true });
  }
  console.log(`\n${pass} kontrol geçti`);
  process.exit();
})().catch((e) => { console.error('TEST HATASI', e); process.exit(1); });
