// Dosya aktarımı testi: yükleme (akış, ad temizleme, çakışma, yarıda kesme, sınır), gezinme, indirme,
// yol geçişi saldırıları, yetkiler ve günlük.
// ORTAM: Sunucuyu test/calistir.js başlatır ve her pakete geçici bir klasör verir (TEST_TMP). Sunucu ile bu test
// aynı ortam değişkenlerini alır: REMOTE_UPLOAD_DIR = TEST_TMP\yuklenen, REMOTE_BROWSE_ROOT = TEST_TMP\kok.
// Böylece gerçek İndirilenler ya da profil klasörüne hiç dokunulmaz. Elle çalıştırırken de bu üç değişkeni
// sunucuya ve teste aynı şekilde verin.
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const WebSocket = require(path.join(ROOT, 'node_modules', 'ws'));
const PORT = process.env.TEST_PORT || 3999;
const URL = `ws://localhost:${PORT}`;

const TMP = process.env.TEST_TMP;
const YUKLE = process.env.REMOTE_UPLOAD_DIR;
const KOK = process.env.REMOTE_BROWSE_ROOT;
if (!TMP || !YUKLE || !KOK || !YUKLE.startsWith(TMP) || !KOK.startsWith(TMP)) {
  console.log('FAIL bu test test/calistir.js ile çalıştırılmalı (TEST_TMP, REMOTE_UPLOAD_DIR, REMOTE_BROWSE_ROOT gerekli)');
  process.exit(1);
}
const DISARI = path.join(TMP, 'disari'); // kökün DIŞINDA, saldırıların ulaşmaya çalışacağı klasör

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
      waiters.push({ pred, resolve });
      setTimeout(() => reject(new Error('timeout waiting')), ms);
    });
  };
  const send = (o) => ws.send(JSON.stringify(o));
  const closed = new Promise((r) => ws.on('close', (c) => r(c)));
  return { ws, next, send, closed };
}
const t = (type) => (m) => m.t === type;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${name} ${extra}`);
  if (cond) pass++; else process.exitCode = 1;
}

// Ham HTTP isteği. govde: Buffer | (req) => Promise (akışla yazan fonksiyon)
function istek(method, yol, { token, headers = {}, govde } = {}) {
  return new Promise((resolve) => {
    const h = { ...headers };
    if (token) h['X-Oturum'] = token;
    const req = http.request({ host: 'localhost', port: PORT, method, path: yol, headers: h }, (res) => {
      const parcalar = [];
      res.on('data', (c) => parcalar.push(c));
      res.on('end', () => {
        const body = Buffer.concat(parcalar);
        let json = null;
        try { json = JSON.parse(body.toString()); } catch { /* ikili */ }
        resolve({ status: res.statusCode, headers: res.headers, body, json });
      });
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    if (typeof govde === 'function') govde(req);
    else req.end(govde);
  });
}
const yukle = (token, ad, veri) => istek('POST', `/api/dosya/yukle?ad=${encodeURIComponent(ad)}`, { token, govde: veri });
const liste = (token, yol) => istek('GET', `/api/dosya/liste?yol=${yol}`, { token }); // yol ham (saldırı testleri için kodlanmadan)
const indir = (token, yol) => istek('GET', `/api/dosya/indir?yol=${yol}`, { token });

// Sunucu sürecinin bellek kullanımı (dinlediği porttan bulunur), MB.
function sunucuPid() {
  const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' });
  // Durum sütunu Windows diline göre değişir (LISTENING/DİNLEME); dinleyen soketin uzak adresi 0.0.0.0:0'dır.
  const satir = out.split(/\r?\n/).find((l) => new RegExp(`^\\s*TCP\\s+0\\.0\\.0\\.0:${PORT}\\s+0\\.0\\.0\\.0:0\\s`).test(l));
  return satir ? Number(satir.trim().split(/\s+/).pop()) : null;
}
function bellekMB(pid) {
  const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
  const m = out.match(/"([\d.,\s]+) K"\s*$/m);
  return m ? Number(m[1].replace(/[^\d]/g, '')) / 1024 : NaN;
}

async function giris(username, password) {
  const c = client();
  await c.next(t('hello'));
  c.send({ t: 'login', username, password, remember: false });
  return { c, r: await c.next(t('auth')) };
}

(async () => {
  // ---------- Hazırlık ----------
  fs.mkdirSync(path.join(KOK, 'alt', 'derin'), { recursive: true });
  fs.mkdirSync(path.join(KOK, 'Belgeler'), { recursive: true });
  fs.mkdirSync(DISARI, { recursive: true });
  fs.writeFileSync(path.join(DISARI, 'gizli.txt'), 'GİZLİ İÇERİK');
  const turkceAd = 'Türkçe ğüşıöç dosya "tırnak".txt'.replace(/"/g, ''); // Windows'ta " yasak
  const turkceIcerik = Buffer.from('merhaba dünya — içerik 🚀\n'.repeat(1000));
  fs.writeFileSync(path.join(KOK, 'alt', turkceAd), turkceIcerik);
  fs.writeFileSync(path.join(KOK, 'b.txt'), 'b');
  fs.writeFileSync(path.join(KOK, 'a.txt'), 'a');
  fs.writeFileSync(path.join(KOK, 'ads.txt'), 'görünen');
  let adsVar = true;
  try { fs.writeFileSync(path.join(KOK, 'ads.txt:gizli'), 'ADS İÇERİK'); } catch { adsVar = false; }
  const kopru = path.join(KOK, 'uzun-kopru-klasoru');
  fs.symlinkSync(DISARI, kopru, 'junction'); // mklink /J ile aynı
  const yerelKopru = path.join(KOK, 'ic-kopru');
  fs.symlinkSync(path.join(KOK, 'alt'), yerelKopru, 'junction'); // kökün İÇİNE işaret eden junction

  try {
    // ---------- Oturumlar ----------
    const a = client();
    await a.next(t('hello'));
    a.send({ t: 'setup', username: 'ahmet', password: 'gizli123', remember: false });
    const ar = await a.next(t('auth'));
    check('yönetici oturumu + http anahtarı', ar.ok && !!ar.http);
    const T = ar.http;
    a.send({ t: 'admin', op: 'addUser', username: 'izleyici', password: 'izle1234', role: 'view' });
    await a.next(t('adminData'));
    const { c: v, r: vr } = await giris('izleyici', 'izle1234');

    // ---------- Yetki ----------
    let r = await liste('', '');
    check('oturumsuz liste 401', r.status === 401, `(${r.status})`);
    r = await istek('GET', '/api/dosya/liste?oturum=yanlis');
    check('yanlış oturum 401', r.status === 401);
    r = await yukle('', 'x.txt', Buffer.from('x'));
    check('oturumsuz yükleme 401', r.status === 401);
    r = await liste(vr.http, '');
    check('salt izleme liste 403', r.status === 403, `(${r.status})`);
    r = await indir(vr.http, 'a.txt');
    check('salt izleme indirme 403', r.status === 403);
    r = await yukle(vr.http, 'x.txt', Buffer.from('x'));
    check('salt izleme yükleme 403', r.status === 403);
    check('reddedilen yüklemeler dosya bırakmadı', !fs.existsSync(path.join(YUKLE, 'x.txt')));
    r = await istek('GET', `/api/dosya/liste?yol=&oturum=${encodeURIComponent(T)}`);
    check('?oturum= parametresiyle de çalışıyor', r.status === 200 && r.json?.ok);

    // ---------- Liste ----------
    r = await liste(T, '');
    const adlar = r.json?.girdiler?.map((g) => g.ad) || [];
    check('kök listesi', r.status === 200, `${r.status} ${r.body?.toString().slice(0, 200)} ${adlar.join(', ')}`);
    check('klasörler önce, alfabetik', JSON.stringify(adlar) === JSON.stringify(['alt', 'Belgeler', 'a.txt', 'ads.txt', 'b.txt']), JSON.stringify(adlar));
    check('junction/symlink girişleri listelenmedi', !adlar.includes('uzun-kopru-klasoru') && !adlar.includes('ic-kopru'));
    const at = r.json.girdiler.find((g) => g.ad === 'a.txt');
    check('dosya boyutu ve tarih', at.tur === 'dosya' && at.boyut === 1 && at.degisme > 0);
    r = await liste(T, encodeURIComponent('alt'));
    check('alt klasör listesi', r.json?.yol === 'alt' && r.json.girdiler.some((g) => g.ad === turkceAd) && r.json.girdiler[0].ad === 'derin');
    r = await liste(T, encodeURIComponent('olmayan'));
    check('olmayan klasör 404', r.status === 404);
    r = await liste(T, encodeURIComponent('a.txt'));
    check('dosyayı listeleme 400', r.status === 400);

    // ---------- İndirme ----------
    r = await indir(T, encodeURIComponent(`alt/${turkceAd}`));
    check('indirme 200 ve içerik aynı', r.status === 200 && r.body.equals(turkceIcerik));
    check('Content-Length doğru', Number(r.headers['content-length']) === turkceIcerik.length);
    const cd = r.headers['content-disposition'] || '';
    check('Content-Disposition UTF-8 (RFC 5987)', cd.startsWith('attachment;') && cd.includes(`filename*=UTF-8''${encodeURIComponent(turkceAd)}`) && /filename="[\x20-\x7e]+"/.test(cd), cd);
    r = await indir(T, encodeURIComponent('alt'));
    check('klasör indirilemez', r.status === 400);
    r = await indir(T, encodeURIComponent('ic-kopru/' + turkceAd));
    check('kökün içine işaret eden junction üzerinden indirme çalışır', r.status === 200 && r.body.equals(turkceIcerik));

    // ---------- Yol geçişi saldırıları ----------
    const gizliIcerik = (x) => x.body && x.body.toString().includes('GİZLİ');
    const saldirilar = [
      ['..', liste, '..'],
      ['..\\..', liste, encodeURIComponent('..\\..')],
      ['alt/../../disari', liste, encodeURIComponent('alt/../../disari')],
      ['%2e%2e (URL kodlu)', liste, '%2e%2e'],
      ['%2e%2e%2fdisari%2fgizli.txt', indir, '%2e%2e%2fdisari%2fgizli.txt'],
      ['%252e%252e (çift kodlu)', liste, '%252e%252e'],
      ['mutlak C:\\Windows', liste, encodeURIComponent('C:\\Windows')],
      ['mutlak sürücüye göreli C:', liste, encodeURIComponent('C:')],
      ['mutlak yol (dışarıdaki dosya)', indir, encodeURIComponent(path.join(DISARI, 'gizli.txt'))],
      ['eğik çizgiyle başlayan /Windows', liste, encodeURIComponent('/Windows')],
      ['UNC \\\\localhost\\c$', liste, encodeURIComponent('\\\\localhost\\c$\\Windows')],
      ['UNC aygıt yolu \\\\?\\C:\\', liste, encodeURIComponent('\\\\?\\C:\\Windows')],
      ['UNC \\\\.\\ aygıt', indir, encodeURIComponent('\\\\.\\PhysicalDrive0')],
      ['junction (mklink /J) kök dışına', liste, encodeURIComponent('uzun-kopru-klasoru')],
      ['junction içinden dosya', indir, encodeURIComponent('uzun-kopru-klasoru/gizli.txt')],
      ['ADS ads.txt:gizli', indir, encodeURIComponent('ads.txt:gizli')],
      ['ADS ::$DATA', indir, encodeURIComponent('a.txt::$DATA')],
      ['NUL baytı', indir, encodeURIComponent('a.txt\u0000.png')],
      ['aygıt adı CON', indir, 'CON'],
      ['aygıt adı nul.txt', indir, 'nul.txt'],
      ['sondaki nokta/boşluk ".. "', liste, encodeURIComponent('.. ')],
      ['"..." (Windows\'ta .. gibi davranabilir)', liste, encodeURIComponent('...')],
      ['sondaki nokta "a.txt."', indir, encodeURIComponent('a.txt.')],
    ];
    // 8.3 kısa ad: junction'ın kısa adı varsa onunla da dışarı çıkılamamalı.
    try {
      const kisa = execFileSync('cmd.exe', ['/d', '/c', `for %I in ("${kopru}") do @echo %~sI`], { encoding: 'utf8', windowsVerbatimArguments: true }).trim();
      const kisaAd = path.basename(kisa);
      if (kisaAd && kisaAd !== path.basename(kopru)) saldirilar.push([`8.3 kısa ad ${kisaAd}`, liste, encodeURIComponent(kisaAd)]);
      else console.log('BİLGİ bu birimde 8.3 kısa adlar kapalı; kısa ad denemesi atlandı');
    } catch { console.log('BİLGİ kısa ad alınamadı; atlandı'); }

    let engellenen = 0;
    for (const [ad, fn, yol] of saldirilar) {
      const x = await fn(T, yol);
      const ok = x.status >= 400 && x.status < 500 && !gizliIcerik(x) && !(x.body && x.body.toString().includes('ADS İÇERİK'));
      if (ok) engellenen++;
      check(`saldırı engellendi: ${ad}`, ok, `(${x.status}${x.json?.msg ? ` ${x.json.msg}` : ''})`);
    }
    check(`en az 8 farklı yol geçişi denemesi`, engellenen >= 8 && engellenen === saldirilar.length, `(${engellenen}/${saldirilar.length}, ADS ${adsVar ? 'var' : 'yok'})`);

    // ---------- Yükleme ----------
    r = await yukle(T, 'merhaba.txt', Buffer.from('merhaba'));
    check('küçük dosya yüklendi', r.status === 200 && r.json?.ad === 'merhaba.txt' && fs.readFileSync(path.join(YUKLE, 'merhaba.txt'), 'utf8') === 'merhaba');
    r = await yukle(T, 'merhaba.txt', Buffer.from('ikinci'));
    check('çakışmada "ad (1).uzantı"', r.json?.ad === 'merhaba (1).txt' && fs.readFileSync(path.join(YUKLE, 'merhaba (1).txt'), 'utf8') === 'ikinci', r.json?.ad);
    r = await yukle(T, 'merhaba.txt', Buffer.from('üçüncü'));
    check('ikinci çakışmada (2)', r.json?.ad === 'merhaba (2).txt');

    const adTestleri = [
      ['..\\..\\kotu<>:"|?*.txt', 'kotu_______.txt'],
      ['../../../etc/passwd', 'passwd'],
      ['C:\\Windows\\System32\\evil.dll', 'evil.dll'],
      ['CON.txt', '_CON.txt'],
      ['nul', '_nul'],
      ['com1.log', '_com1.log'],
      ['  .gizli. ', 'gizli'],
      ['...', 'dosya'],
      ['dosya.txt:ads', 'dosya.txt_ads'],
      ['Türkçe ğüş İ.pdf', 'Türkçe ğüş İ.pdf'],
      ['sekme\tsatır\nsonu.txt', 'sekme_satır_sonu.txt'],
    ];
    for (const [gelen, beklenen] of adTestleri) {
      r = await yukle(T, gelen, Buffer.from('x'));
      const varMi = r.json?.ad && fs.existsSync(path.join(YUKLE, r.json.ad));
      check(`ad temizlendi: ${JSON.stringify(gelen)}`, r.json?.ad === beklenen && varMi, `→ ${JSON.stringify(r.json?.ad)}`);
    }
    r = await yukle(T, 'a'.repeat(300) + '.txt', Buffer.from('x'));
    check('çok uzun ad kısaltıldı, uzantı korundu', r.json?.ad?.length <= 180 && r.json.ad.endsWith('.txt'));
    check('hiçbir dosya yükleme klasörü dışına yazılmadı', !fs.existsSync(path.join(TMP, 'kotu_______.txt')) && !fs.existsSync(path.join(KOK, 'passwd')));

    // Büyük dosya (~50 MB) akışla; sunucu belleği dosya boyutu kadar büyümemeli.
    const pid = sunucuPid();
    const once = pid ? bellekMB(pid) : NaN;
    const BOYUT = 50 * 1024 * 1024;
    const PARCA = 1024 * 1024;
    const hash = crypto.createHash('sha256');
    let tepe = once;
    let olcuyor = true;
    const olcum = (async () => { while (olcuyor && pid) { tepe = Math.max(tepe, bellekMB(pid)); await sleep(100); } })();
    const t0 = Date.now();
    r = await istek('POST', '/api/dosya/yukle?ad=buyuk.bin', {
      token: T,
      headers: { 'Content-Length': BOYUT },
      govde: async (req) => {
        for (let i = 0; i < BOYUT / PARCA; i++) {
          const p = crypto.randomBytes(PARCA);
          hash.update(p);
          if (!req.write(p)) await new Promise((res) => req.once('drain', res));
          if (i % 10 === 0) await sleep(20); // ölçüm için biraz yay
        }
        req.end();
      },
    });
    olcuyor = false;
    await olcum;
    const sure = Date.now() - t0;
    const diskteki = path.join(YUKLE, 'buyuk.bin');
    const ayni = fs.existsSync(diskteki) && crypto.createHash('sha256').update(fs.readFileSync(diskteki)).digest('hex') === hash.digest('hex');
    check('50 MB akışla yüklendi, içerik aynı', r.status === 200 && r.json?.boyut === BOYUT && ayni, `(${sure} ms)`);
    check('sunucu belleği dosya boyutu kadar büyümedi', Number.isFinite(once) ? tepe - once < 35 : false,
      `(önce ${once.toFixed(0)} MB, tepe ${tepe.toFixed(0)} MB)`);

    // Yarıda kesilen yükleme: yarım dosya silinmeli.
    await new Promise((resolve) => {
      const req = http.request({ host: 'localhost', port: PORT, method: 'POST', path: '/api/dosya/yukle?ad=yarim.bin',
        headers: { 'X-Oturum': T, 'Content-Length': 20 * PARCA } });
      req.on('error', () => resolve());
      req.on('close', () => resolve());
      req.write(crypto.randomBytes(5 * PARCA), () => setTimeout(() => req.destroy(), 300));
    });
    await sleep(1000);
    check('yarıda kesilen yüklemenin yarım dosyası silindi', !fs.readdirSync(YUKLE).some((f) => f.startsWith('yarim')), fs.readdirSync(YUKLE).filter((f) => f.startsWith('yarim')).join(','));

    // 8 GB sınırı (Content-Length ile hemen reddedilir)
    r = await istek('POST', '/api/dosya/yukle?ad=dev.bin', { token: T, headers: { 'Content-Length': String(9 * 1024 ** 3) }, govde: (req) => { req.on('error', () => {}); req.write('x'); setTimeout(() => req.destroy(), 500); } });
    check('8 GB üstü 413', r.status === 413, `(${r.status})`);
    check('reddedilen büyük yükleme dosya bırakmadı', !fs.readdirSync(YUKLE).some((f) => f.startsWith('dev')));

    // ---------- Günlük ----------
    a.send({ t: 'admin', op: 'list' });
    const ad = await a.next(t('adminData'));
    const kayitlar = ad.log.filter((l) => l.event === 'dosya');
    check('yükleme günlüğe yazıldı', kayitlar.some((l) => l.islem === 'yukle' && l.ad === 'buyuk.bin' && l.boyut === BOYUT && l.user === 'ahmet' && l.ip));
    check('indirme günlüğe yazıldı', kayitlar.some((l) => l.islem === 'indir' && l.ad === `alt/${turkceAd}` && l.boyut === turkceIcerik.length));

    a.ws.close(); await a.closed;
    v.ws.close(); await v.closed;
    r = await liste(T, '');
    check('bağlantı kapanınca http anahtarı geçersiz', r.status === 401);
  } finally {
    // Junction'ları bağlantı olarak kaldır (hedefleri silinmez); geri kalanını calistir.js temizler.
    for (const j of [kopru, yerelKopru]) { try { fs.rmdirSync(j); } catch { /* yok */ } }
  }
  console.log(`\n${pass} kontrol geçti`);
  process.exit();
})().catch((e) => { console.error('TEST HATASI', e); process.exit(1); });
