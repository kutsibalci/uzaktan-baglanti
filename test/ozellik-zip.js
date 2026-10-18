// @ortam REMOTE_ZIP_MAX_GIRDI=60
// Bilgisayardan indirme testi: her dosya türü (attachment, Range/206, 0 bayt, uzantısız, uzun/Türkçe ad, > 4 GB seyrek
// dosya) ve klasörü/seçimi zip olarak indirme (lib/zip.js akışla). Zip'ler kendi okuyucumuzla (test/zip-okuyucu.js:
// CRC, data descriptor, ZIP64), PowerShell Expand-Archive (.NET) ve Windows tar.exe (libarchive) ile açılır.
// Ayrıca: junction/symlink izlenmez, kilitli dosya atlanıp _atlananlar.txt'ye yazılır, kök dışı denemeler, yetkiler,
// seçimin başka oturumdan kullanılamaması, öğe sınırı (REMOTE_ZIP_MAX_GIRDI=60), iptal edilince dosya tanıtıcısının
// kapanması, 65535'ten fazla girdi (ZIP64 EOCD) ve günlük. ZIP64'ün küçük dosyalarla zorlanması: ozellik-zip64.js.
// ORTAM: test/calistir.js ile çalıştırılmalı (TEST_TMP, REMOTE_BROWSE_ROOT); gerçek klasörlere dokunulmaz.
const path = require('path');
const fs = require('fs');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');
const { Readable } = require('stream');
const ROOT = path.join(__dirname, '..');
const WebSocket = require(path.join(ROOT, 'node_modules', 'ws'));
const { zipOku, merkeziOku } = require('./zip-okuyucu');
const { zipAkisi } = require(path.join(ROOT, 'lib', 'zip'));
const PORT = process.env.TEST_PORT || 3999;

const TMP = process.env.TEST_TMP;
const KOK = process.env.REMOTE_BROWSE_ROOT;
if (!TMP || !KOK || !KOK.startsWith(TMP)) {
  console.log('FAIL bu test test/calistir.js ile çalıştırılmalı (TEST_TMP, REMOTE_BROWSE_ROOT gerekli)');
  process.exit(1);
}
const DISARI = path.join(TMP, 'disari');
const SYS = process.env.SystemRoot || 'C:\\Windows';
const POWERSHELL = path.join(SYS, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const TAR = path.join(SYS, 'System32', 'tar.exe');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${name} ${extra}`);
  if (cond) pass++; else process.exitCode = 1;
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
  const next = (pred = () => true, ms = 8000) => {
    const i = queue.findIndex(pred);
    if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
    return new Promise((resolve, reject) => { waiters.push({ pred, resolve }); setTimeout(() => reject(new Error('timeout waiting')), ms); });
  };
  const send = (o) => ws.send(JSON.stringify(o));
  const closed = new Promise((r) => ws.on('close', (c) => r(c)));
  return { ws, next, send, closed };
}
const t = (type) => (m) => m.t === type;

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
      res.on('error', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parcalar), kesildi: true }));
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.end(govde);
  });
}
const secim = (token, yollar) => istek('POST', '/api/dosya/secim', { token, headers: { 'Content-Type': 'application/json' }, govde: JSON.stringify({ yollar }) });
const zipYol = (token, ...yollar) => istek('GET', `/api/dosya/zip?${yollar.map((y) => `yol=${encodeURIComponent(y)}`).join('&')}`, { token });

const ps = (komut, env = {}) => execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding = [Text.Encoding]::UTF8; $ErrorActionPreference = 'Stop'; ${komut}`],
  { env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 }).trim();
const genislet = (zip, hedef) => ps('Expand-Archive -LiteralPath $env:ZIP_YOL -DestinationPath $env:ZIP_HEDEF -Force', { ZIP_YOL: zip, ZIP_HEDEF: hedef });
const netSayi = (zip) => Number(ps('Add-Type -AssemblyName System.IO.Compression.FileSystem; $z = [IO.Compression.ZipFile]::OpenRead($env:ZIP_YOL); $z.Entries.Count; $z.Dispose()', { ZIP_YOL: zip }));
const tarListe = (zip) => execFileSync(TAR, ['-tf', zip], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split(/\r?\n/).filter(Boolean);
// Başka bir süreç dosyayı paylaşımsız açabiliyor mu? Açamıyorsa birinin (sunucunun) tanıtıcısı açık demektir.
const taniticiAcik = (p) => ps("try { $f = [IO.File]::Open($env:K_YOL, 'Open', 'Read', 'None'); $f.Close(); 'SERBEST' } catch { 'ACIK' }", { K_YOL: p }) === 'ACIK';

// Klasör ağacı: göreli ad ('/' ile, klasörler '/' ile biter) -> Buffer | null
function agac(dizin, on = '') {
  const m = new Map();
  for (const d of fs.readdirSync(dizin, { withFileTypes: true })) {
    const ad = on + d.name;
    if (d.isDirectory()) { m.set(`${ad}/`, null); for (const [k, v] of agac(path.join(dizin, d.name), `${ad}/`)) m.set(k, v); }
    else m.set(ad, fs.readFileSync(path.join(dizin, d.name)));
  }
  return m;
}
const ayniAgac = (a, b) => a.size === b.size && [...a].every(([k, v]) => b.has(k) && (v === null ? b.get(k) === null : b.get(k) && b.get(k).equals(v)));
const fark = (a, b) => [...[...a.keys()].filter((k) => !b.has(k)).map((k) => `-${k}`), ...[...b.keys()].filter((k) => !a.has(k)).map((k) => `+${k}`)].join(' ');

async function giris(username, password) {
  const c = client();
  await c.next(t('hello'));
  c.send({ t: 'login', username, password, remember: false });
  return { c, r: await c.next(t('auth')) };
}

(async () => {
  const junctionlar = [];
  let kilit = null;
  try {
    // ---------- Hazırlık ----------
    fs.mkdirSync(DISARI, { recursive: true });
    fs.writeFileSync(path.join(DISARI, 'gizli.txt'), 'GİZLİ İÇERİK');
    const P = path.join(KOK, 'Proje');
    for (const d of ['alt/derin', 'bos', 'bos2/ic-bos']) fs.mkdirSync(path.join(P, d), { recursive: true });
    fs.mkdirSync(path.join(KOK, 'baska'));
    fs.writeFileSync(path.join(KOK, 'baska', 'ic.txt'), 'kök içi ama junction ile');
    const turkce = 'Türkçe ğüşıöç İ.txt';
    const uzun = `Çok uzun ad ${'ğüşİ'.repeat(40)}.txt`; // ~175 karakter
    const metin = Buffer.from('merhaba dünya — İçerik ğüşıöç\r\n'.repeat(2000));
    const foto = crypto.randomBytes(200 * 1024);
    fs.writeFileSync(path.join(P, turkce), metin);
    fs.writeFileSync(path.join(P, uzun), 'uzun');
    fs.writeFileSync(path.join(P, 'foto.jpg'), foto);
    fs.writeFileSync(path.join(P, 'sifir.bin'), '');
    fs.writeFileSync(path.join(P, 'BENIOKU'), 'uzantısız');
    fs.writeFileSync(path.join(P, 'alt', 'derin', 'not.md'), '# not');
    fs.writeFileSync(path.join(P, 'kilitli.docx'), 'kilitli içerik');
    fs.writeFileSync(path.join(P, `.0123456789abcdef.uzaktan-yukleniyor`), 'yarım yükleme');
    fs.symlinkSync(DISARI, path.join(P, 'kopru'), 'junction'); junctionlar.push(path.join(P, 'kopru'));
    fs.symlinkSync(path.join(KOK, 'baska'), path.join(P, 'ic-kopru'), 'junction'); junctionlar.push(path.join(P, 'ic-kopru'));
    fs.symlinkSync(DISARI, path.join(KOK, 'uzun-kopru'), 'junction'); junctionlar.push(path.join(KOK, 'uzun-kopru'));
    let dosyaSembolik = true;
    try { fs.symlinkSync(path.join(DISARI, 'gizli.txt'), path.join(P, 'sembolik.txt'), 'file'); } catch { dosyaSembolik = false; }
    if (!dosyaSembolik) console.log('BİLGİ dosya sembolik bağlantısı oluşturulamadı (Geliştirici modu kapalı); yalnızca junction denendi');
    fs.writeFileSync(path.join(KOK, 'a.txt'), 'a');
    fs.mkdirSync(path.join(KOK, 'Cok'));
    for (let i = 0; i < 70; i++) fs.writeFileSync(path.join(KOK, 'Cok', `d${String(i).padStart(2, '0')}.txt`), String(i));

    // Kilitli dosya: başka bir süreç paylaşımsız açık tutar (sunucu açamaz → atlanmalı).
    kilit = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command',
      "$f = [IO.File]::Open($env:K_YOL, 'Open', 'Read', 'None'); 'HAZIR'; Start-Sleep -Seconds 120"], { env: { ...process.env, K_YOL: path.join(P, 'kilitli.docx') }, stdio: ['ignore', 'pipe', 'ignore'] });
    await new Promise((r) => { kilit.stdout.on('data', (d) => { if (String(d).includes('HAZIR')) r(); }); setTimeout(r, 15000); });

    // ---------- Oturumlar ----------
    const a = client();
    await a.next(t('hello'));
    a.send({ t: 'setup', username: 'ahmet', password: 'gizli123', remember: false });
    const ar = await a.next(t('auth'));
    const T = ar.http;
    a.send({ t: 'admin', op: 'addUser', username: 'izleyici', password: 'izle1234', role: 'view' });
    await a.next(t('adminData'));
    a.send({ t: 'admin', op: 'addUser', username: 'ikinci', password: 'ikinci123', role: 'control' });
    await a.next(t('adminData'));
    const { c: v, r: vr } = await giris('izleyici', 'izle1234');
    const { c: k2, r: k2r } = await giris('ikinci', 'ikinci123');
    check('oturumlar açıldı', !!T && !!vr.http && !!k2r.http);

    // ---------- Tek dosya indirme: her tür ----------
    let r = await istek('GET', `/api/dosya/indir?yol=${encodeURIComponent(`Proje/${turkce}`)}`, { token: T });
    const cd = r.headers['content-disposition'] || '';
    check('indir: attachment + octet-stream + nosniff + Accept-Ranges', r.status === 200 && r.body.equals(metin) && cd.startsWith('attachment;')
      && r.headers['content-type'] === 'application/octet-stream' && r.headers['x-content-type-options'] === 'nosniff' && r.headers['accept-ranges'] === 'bytes', `${r.status} ${r.headers['content-type']}`);
    check('indir: Türkçe ad filename* ile, ASCII yedekte en yakın harf', cd.includes(`filename*=UTF-8''${encodeURIComponent(turkce)}`) && cd.includes('filename="Turkce gusioc I.txt"'), cd);
    r = await istek('GET', `/api/dosya/indir?yol=${encodeURIComponent(`Proje/${uzun}`)}`, { token: T });
    check('indir: uzun ad', r.status === 200 && (r.headers['content-disposition'] || '').includes(encodeURIComponent(uzun)));
    r = await istek('GET', '/api/dosya/indir?yol=Proje/BENIOKU', { token: T });
    check('indir: uzantısız dosya', r.status === 200 && r.body.toString() === 'uzantısız' && r.headers['content-disposition'].includes('filename="BENIOKU"'));
    r = await istek('GET', '/api/dosya/indir?yol=Proje/sifir.bin', { token: T });
    check('indir: 0 bayt', r.status === 200 && r.headers['content-length'] === '0' && r.body.length === 0, `(${r.status} ${r.headers['content-length']})`);
    r = await istek('GET', '/api/dosya/indir?yol=Proje/foto.jpg', { token: T });
    check('indir: resim de sayfada açılmaz (octet-stream + attachment)', r.status === 200 && r.body.equals(foto) && r.headers['content-type'] === 'application/octet-stream');

    // ---------- Range ----------
    const fotoYol = 'Proje/foto.jpg';
    const aralik = (range, ek = {}) => istek('GET', `/api/dosya/indir?yol=${fotoYol}`, { token: T, headers: { Range: range, ...ek } });
    r = await aralik('bytes=0-9');
    check('Range bytes=0-9 → 206', r.status === 206 && r.body.equals(foto.subarray(0, 10)) && r.headers['content-range'] === `bytes 0-9/${foto.length}` && r.headers['content-length'] === '10', `(${r.status} ${r.headers['content-range']})`);
    r = await aralik('bytes=1000-');
    check('Range bytes=1000- → sonuna kadar', r.status === 206 && r.body.equals(foto.subarray(1000)));
    r = await aralik('bytes=-5');
    check('Range bytes=-5 → son 5 bayt', r.status === 206 && r.body.equals(foto.subarray(-5)));
    r = await aralik(`bytes=${foto.length}-`);
    check('Range dosya sonundan sonra → 416', r.status === 416 && r.headers['content-range'] === `bytes */${foto.length}`, `(${r.status})`);
    r = await aralik('bytes=0-1,5-9');
    check('çoklu aralık → tüm dosya 200', r.status === 200 && r.body.equals(foto));
    const etag = r.headers.etag;
    r = await aralik('bytes=0-9', { 'If-Range': etag });
    check('If-Range eşleşince 206', r.status === 206 && !!etag);
    r = await aralik('bytes=0-9', { 'If-Range': '"eski"' });
    check('If-Range eşleşmeyince tüm dosya 200', r.status === 200 && r.body.equals(foto));

    // ---------- Zip: klasör ----------
    r = await zipYol(T, 'Proje');
    check('zip: 200, application/zip, attachment Proje.zip, uzunluk yok (akış)', r.status === 200 && r.headers['content-type'] === 'application/zip'
      && (r.headers['content-disposition'] || '').includes("filename*=UTF-8''Proje.zip") && !r.headers['content-length'], `${r.status} ${r.headers['content-disposition']}`);
    let m;
    try { m = zipOku(r.body); } catch (e) { m = null; check('zip: okunabilir', false, e.message); }
    const beklenen = new Map([
      ['Proje/', null], ['Proje/alt/', null], ['Proje/alt/derin/', null], ['Proje/alt/derin/not.md', Buffer.from('# not')],
      ['Proje/bos/', null], ['Proje/bos2/', null], ['Proje/bos2/ic-bos/', null],
      ['Proje/BENIOKU', Buffer.from('uzantısız')], ['Proje/foto.jpg', foto], ['Proje/sifir.bin', Buffer.alloc(0)],
      [`Proje/${turkce}`, metin], [`Proje/${uzun}`, Buffer.from('uzun')],
    ]);
    if (m) {
      const icerik = new Map(m.girdiler.filter((g) => g.ad !== '_atlananlar.txt').map((g) => [g.ad, g.klasor ? null : g.veri]));
      check('zip: içerik, CRC ve data descriptor doğru (kendi okuyucumuz)', ayniAgac(beklenen, icerik), fark(beklenen, icerik));
      check('zip: tüm adlarda UTF-8 bayrağı (bit 11)', m.girdiler.every((g) => g.bayrak & 0x0800));
      check('zip: dosyalarda data descriptor (bit 3), klasörlerde yok', m.girdiler.every((g) => (g.klasor ? !(g.bayrak & 8) : g.bayrak & 8)));
      const yontem = (ad) => m.girdiler.find((g) => g.ad === ad)?.yontem;
      check('zip: metin deflate, jpg store', yontem(`Proje/${turkce}`) === 8 && yontem('Proje/foto.jpg') === 0, `${yontem(`Proje/${turkce}`)} ${yontem('Proje/foto.jpg')}`);
      check('zip: deflate gerçekten küçültüyor', m.girdiler.find((g) => g.ad === `Proje/${turkce}`).sikisik < metin.length / 10);
      check('zip: klasörlerin dış özniteliği DOS dizin', m.girdiler.filter((g) => g.klasor).every((g) => g.dis === 0x10));
      check('zip: küçük zip\'te ZIP64 kaydı yok', !m.zip64 && m.girdiler.every((g) => !Object.keys(g.z64).length));
      const atl = m.girdiler.find((g) => g.ad === '_atlananlar.txt');
      const atlMetin = atl ? atl.veri.toString('utf8') : '';
      check('zip: _atlananlar.txt en sonda', m.girdiler[m.girdiler.length - 1] === atl, m.girdiler.map((g) => g.ad).slice(-2).join(','));
      check('zip: junction (kök dışına ve kök içine) izlenmedi, listede', !m.girdiler.some((g) => g.ad.includes('kopru/') || g.ad.endsWith('ic.txt') || g.veri?.toString().includes('GİZLİ'))
        && atlMetin.includes('Proje/kopru') && atlMetin.includes('Proje/ic-kopru'), atlMetin.replace(/\r\n/g, ' | '));
      check('zip: dosya sembolik bağlantısı izlenmedi', !dosyaSembolik || (!m.girdiler.some((g) => g.ad.endsWith('sembolik.txt')) && atlMetin.includes('sembolik.txt')));
      check('zip: kilitli dosya atlandı ve listede', !m.girdiler.some((g) => g.ad.endsWith('kilitli.docx')) && atlMetin.includes('Proje/kilitli.docx'));
      check('zip: yarım yükleme dosyası eklenmedi', !m.girdiler.some((g) => g.ad.includes('uzaktan-yukleniyor')));
      check('zip: _atlananlar.txt BOM\'lu UTF-8', atl && atl.veri[0] === 0xef && atl.veri[1] === 0xbb);

      // Windows'un kendi açıcısı (.NET ZipFile) ve libarchive (tar.exe)
      const zipDosya = path.join(TMP, 'Proje.zip');
      fs.writeFileSync(zipDosya, r.body);
      const acilan = path.join(TMP, 'acilan');
      try {
        genislet(zipDosya, acilan);
        const disk = agac(acilan);
        disk.delete('_atlananlar.txt');
        check('Expand-Archive: içerik, Türkçe/uzun adlar, boş klasörler aynı', ayniAgac(beklenen, disk), fark(beklenen, disk));
      } catch (e) { check('Expand-Archive açtı', false, String(e.stderr || e.message).slice(0, 300)); }
      try {
        const liste = tarListe(zipDosya);
        check('tar.exe (libarchive) zip\'i listeledi', liste.length === m.girdiler.length, `(${liste.length}/${m.girdiler.length})`);
      } catch (e) { check('tar.exe açtı', false, String(e.stderr || e.message).slice(0, 300)); }
    }

    // ---------- Zip: seçim (POST) ----------
    r = await secim(T, ['Proje/foto.jpg', 'Proje/alt', 'a.txt', 'a.txt']);
    check('seçim: tahmini boyut ve sayılar', r.status === 200 && r.json?.dosya === 3 && r.json.klasor === 2 && r.json.boyut === foto.length + 5 + 1 && /^[0-9a-f]{32}$/.test(r.json.id),
      JSON.stringify(r.json));
    check('seçim: farklı klasörlerden → "Dosyalar (3 öğe).zip"', r.json?.ad === 'Dosyalar (3 öğe).zip', r.json?.ad);
    const id = r.json?.id;
    r = await istek('GET', `/api/dosya/zip?secim=${id}`, { token: T });
    let ms = null;
    try { ms = zipOku(r.body); } catch (e) { check('seçim zip\'i okunabilir', false, e.message); }
    check('seçim zip\'i: yalnızca seçilenler, üst düzey adlarla', ms && JSON.stringify(ms.girdiler.map((g) => g.ad).sort()) === JSON.stringify(['a.txt', 'alt/', 'alt/derin/', 'alt/derin/not.md', 'foto.jpg'].sort()),
      ms && ms.girdiler.map((g) => g.ad).join(','));
    r = await istek('GET', `/api/dosya/zip?secim=${id}`, { token: k2r.http });
    check('seçim başka oturumdan kullanılamaz (404)', r.status === 404, `(${r.status})`);
    r = await istek('GET', '/api/dosya/zip?secim=00000000000000000000000000000000', { token: T });
    check('bilinmeyen seçim 404', r.status === 404);
    r = await secim(T, ['Proje']);
    check('seçim (tek klasör): ad Proje.zip, atlanan sayısı', r.json?.ad === 'Proje.zip' && r.json.atlanan >= 2 && r.json.klasor === 6, JSON.stringify(r.json));
    r = await secim(T, ['Proje/foto.jpg', 'Proje/BENIOKU']);
    check('seçim aynı klasörden → "Proje (2 öğe).zip"', r.json?.ad === 'Proje (2 öğe).zip', r.json?.ad);
    r = await istek('POST', '/api/dosya/secim', { token: T, govde: 'json değil' });
    check('seçim: bozuk gövde 400', r.status === 400);
    r = await secim(T, []);
    check('seçim: boş 400', r.status === 400);
    r = await istek('POST', '/api/dosya/secim', { token: T, headers: { 'Content-Length': String(2 * 1024 * 1024) }, govde: '{' });
    check('seçim: 1 MB üstü gövde 413', r.status === 413, `(${r.status})`);

    // ---------- Sınır ----------
    r = await secim(T, ['Cok']);
    check('sınır: 60 öğeyi aşan seçim 413 ve açıklama', r.status === 413 && /60 öğe/.test(r.json?.msg || ''), `(${r.status} ${r.json?.msg})`);
    r = await zipYol(T, 'Cok');
    try {
      const mc = zipOku(r.body);
      const atl = mc.girdiler.find((g) => g.ad === '_atlananlar.txt');
      check('sınır: doğrudan zip en fazla 60 öğe + _atlananlar.txt (sınır notu)', mc.girdiler.length === 61 && atl && atl.veri.toString().includes('sınır aşıldı'), `(${mc.girdiler.length})`);
    } catch (e) { check('sınır zip\'i okunabilir', false, e.message); }

    // ---------- Yetki ve kök dışı ----------
    check('zip/seçim: salt izleme 403', (await zipYol(vr.http, 'Proje')).status === 403 && (await secim(vr.http, ['Proje'])).status === 403);
    check('zip/seçim: oturumsuz 401', (await zipYol('', 'Proje')).status === 401 && (await secim('', ['Proje'])).status === 401 && (await istek('GET', '/api/dosya/zip?yol=Proje&oturum=yanlis')).status === 401);
    const saldirilar = [
      ['..', '..'], ['..\\..', '..\\..'], ['Proje/../../disari', 'Proje/../../disari'], ['%2e%2e', '%2e%2e'],
      ['mutlak yol', DISARI], ['C:\\Windows', 'C:\\Windows'], ['/Windows', '/Windows'], ['UNC', '\\\\localhost\\c$\\Windows'],
      ['\\\\?\\ aygıt yolu', `\\\\?\\${DISARI}`], ['kök dışına junction', 'uzun-kopru'], ['junction içinden', 'Proje/kopru'],
      ['ADS', 'a.txt::$DATA'], ['aygıt adı', 'CON'], ['sondaki nokta', 'Proje.'], ['olmayan', 'olmayan'],
    ];
    let engel = 0;
    for (const [ad, y] of saldirilar) {
      const x = await istek('GET', `/api/dosya/zip?yol=${y === '%2e%2e' ? y : encodeURIComponent(y)}`, { token: T });
      const s = await secim(T, [y === '%2e%2e' ? '..' : y]);
      const ok = x.status >= 400 && x.status < 500 && s.status >= 400 && s.status < 500 && !x.body.toString('latin1').includes('PK') && !x.body.toString().includes('GİZLİ');
      if (ok) engel++;
      check(`zip kök dışı reddedildi: ${ad}`, ok, `(${x.status}/${s.status})`);
    }
    check('zip: tüm kök dışı denemeler reddedildi', engel === saldirilar.length, `(${engel}/${saldirilar.length})`);
    r = await zipYol(T, 'Proje', '..');
    check('zip: geçerli yolun yanında kök dışı yol varsa hepsi reddedilir', r.status >= 400 && r.status < 500);

    // ---------- İptal: dosya tanıtıcısı kapanmalı ----------
    fs.mkdirSync(path.join(KOK, 'Iptal'));
    const video = path.join(KOK, 'Iptal', 'video.mp4');
    fs.writeFileSync(video, crypto.randomBytes(64 * 1024 * 1024));
    for (const [ad, adres] of [['zip', '/api/dosya/zip?yol=Iptal'], ['indir', '/api/dosya/indir?yol=Iptal/video.mp4']]) {
      const req = http.request({ host: 'localhost', port: PORT, path: adres, headers: { 'X-Oturum': T } });
      const ilk = await new Promise((res) => {
        req.on('response', (rs) => { rs.once('data', () => { rs.pause(); res(true); }); });
        req.on('error', () => res(false));
        req.end();
      });
      await sleep(800);
      const acikken = ilk && taniticiAcik(video);
      req.destroy();
      let kapandi = false;
      for (let i = 0; i < 20 && !kapandi; i++) { await sleep(250); kapandi = !taniticiAcik(video); }
      check(`iptal (${ad}): indirme sürerken dosya açık, iptal edince sunucu dosyayı kapattı`, acikken && kapandi, `(açıkken ${acikken}, kapandı ${kapandi})`);
    }

    // ---------- 4 GB'tan büyük gerçek dosya (seyrek; diskte yer kaplamaz) ----------
    const B = path.join(KOK, 'Buyuk');
    fs.mkdirSync(B);
    const buyuk = path.join(B, 'buyuk.mp4');
    const BOYUT = 4.5 * 1024 ** 3;
    fs.writeFileSync(buyuk, '');
    let seyrek = true;
    try { execFileSync('fsutil', ['sparse', 'setflag', buyuk], { stdio: 'ignore' }); } catch { seyrek = false; }
    const fd = fs.openSync(buyuk, 'r+'); fs.ftruncateSync(fd, BOYUT); fs.closeSync(fd);
    fs.writeFileSync(path.join(B, 'son.txt'), 'büyük dosyadan sonra');
    console.log(`BİLGİ ${BOYUT} baytlık ${seyrek ? 'seyrek' : 'seyrek OLMAYAN'} dosya`);
    r = await istek('GET', '/api/dosya/indir?yol=Buyuk/buyuk.mp4', { token: T, headers: { Range: `bytes=${BOYUT - 8}-` } });
    check('> 4 GB: 4 GB ötesinden Range', r.status === 206 && r.headers['content-range'] === `bytes ${BOYUT - 8}-${BOYUT - 1}/${BOYUT}` && r.body.equals(Buffer.alloc(8)), `(${r.status} ${r.headers['content-range']})`);
    const tamUzunluk = await new Promise((res) => {
      const q = http.get({ host: 'localhost', port: PORT, path: '/api/dosya/indir?yol=Buyuk/buyuk.mp4', headers: { 'X-Oturum': T } }, (rs) => { res(rs.headers['content-length']); q.destroy(); });
      q.on('error', () => {});
    });
    check('> 4 GB: Content-Length doğru', tamUzunluk === String(BOYUT), tamUzunluk);

    // Zip akışı: tamamı alınır ama yalnızca son 1 MB tutulur (merkez dizin ve son girdi orada).
    const t0 = Date.now();
    const { toplam, kuyruk } = await new Promise((res) => {
      let n = 0; let tutulan = 0; const son = [];
      const bitir = () => res({ toplam: n, kuyruk: Buffer.concat(son) });
      http.get({ host: 'localhost', port: PORT, path: '/api/dosya/zip?yol=Buyuk', headers: { 'X-Oturum': T } }, (rs) => {
        rs.on('data', (c) => {
          n += c.length; son.push(c); tutulan += c.length;
          while (tutulan - son[0].length >= 1024 * 1024) tutulan -= son.shift().length;
        });
        rs.on('end', bitir);
        rs.on('error', bitir);
      });
    });
    const sure = Date.now() - t0;
    let crc = 0;
    const sifir = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < BOYUT / sifir.length; i++) crc = zlib.crc32(sifir, crc);
    try {
      const mb = merkeziOku(kuyruk, toplam - kuyruk.length);
      const gb = mb.girdiler.find((g) => g.ad === 'Buyuk/buyuk.mp4');
      const gs = mb.girdiler.find((g) => g.ad === 'Buyuk/son.txt');
      check('> 4 GB zip: büyük girdi ZIP64 (boyutlar), CRC doğru, store', gb && gb.boyut === BOYUT && gb.sikisik === BOYUT && gb.z64.boyut && gb.z64.sikisik && gb.crc === (crc >>> 0) && gb.yontem === 0 && gb.gerek === 45,
        gb && JSON.stringify({ boyut: gb.boyut, z64: gb.z64, crc: gb.crc, beklenen: crc >>> 0 }));
      check('> 4 GB zip: sonraki girdinin konumu ZIP64, ZIP64 EOCD var', gs && gs.konum > 0xFFFFFFFF && gs.z64.konum && mb.zip64 && mb.cdKonum > 0xFFFFFFFF, gs && JSON.stringify({ konum: gs.konum, z64: gs.z64 }));
      // Büyük girdinin 24 baytlık (ZIP64) data descriptor'ı ve son girdinin verisi kuyrukta.
      const taban = toplam - kuyruk.length;
      const d = gs.konum - 24 - taban;
      check('> 4 GB zip: 8 baytlık boyutlu data descriptor', kuyruk.readUInt32LE(d) === 0x08074b50 && Number(kuyruk.readBigUInt64LE(d + 8)) === BOYUT && Number(kuyruk.readBigUInt64LE(d + 16)) === BOYUT);
      const l = gs.konum - taban;
      const veri = zlib.inflateRawSync(kuyruk.subarray(l + 30 + kuyruk.readUInt16LE(l + 26) + kuyruk.readUInt16LE(l + 28), l + 30 + kuyruk.readUInt16LE(l + 26) + kuyruk.readUInt16LE(l + 28) + gs.sikisik));
      check('> 4 GB zip: son girdinin içeriği', veri.toString() === 'büyük dosyadan sonra', `(${(toplam / 1024 ** 3).toFixed(2)} GB, ${sure} ms)`);
    } catch (e) { check('> 4 GB zip okunabilir', false, e.message); }
    fs.rmSync(buyuk, { force: true });

    // ---------- 65535'ten fazla girdi (ZIP64 EOCD) — lib/zip.js doğrudan, bellekte ----------
    {
      const N = 70000;
      async function* bosGirdiler() { for (let i = 0; i < N; i++) yield { ad: `k/${i}.txt`, veri: Buffer.alloc(0), sikistir: false }; }
      const parcalar = [];
      for await (const p of zipAkisi(bosGirdiler())) parcalar.push(p);
      const buf = Buffer.concat(parcalar);
      const z = zipOku(buf);
      check('70000 girdi: ZIP64 EOCD, EOCD sayısı 0xFFFF', z.adet === N && z.zip64?.adet === N && buf.readUInt16LE(buf.length - 22 + 10) === 0xFFFF);
      const f = path.join(TMP, 'cok-girdi.zip');
      fs.writeFileSync(f, buf);
      try { check('70000 girdi: .NET ZipFile sayıyı doğru okudu', netSayi(f) === N); } catch (e) { check('70000 girdi .NET', false, String(e.stderr || e.message).slice(0, 200)); }
      try { check('70000 girdi: tar.exe listeledi', tarListe(f).length === N); } catch (e) { check('70000 girdi tar', false, String(e.stderr || e.message).slice(0, 200)); }
    }

    // ---------- Günlük ----------
    a.send({ t: 'admin', op: 'list' });
    const ad = await a.next(t('adminData'));
    const kayit = ad.log.filter((l) => l.event === 'dosya');
    check('günlük: zip kaydı (ad, sayılar, tamam)', kayit.some((l) => l.islem === 'zip' && l.ad === 'Proje.zip' && l.dosya === 6 && l.tamam === true && l.atlanan >= 3 && l.user === 'ahmet'),
      JSON.stringify(kayit.filter((l) => l.islem === 'zip').slice(-1)));
    check('günlük: iptal edilen zip tamam=false', kayit.some((l) => l.islem === 'zip' && l.ad === 'Iptal.zip' && l.tamam === false));
    check('günlük: aralıklı isteklerde tek indirme kaydı', kayit.filter((l) => l.islem === 'indir' && l.ad === fotoYol).length === 5, `(${kayit.filter((l) => l.islem === 'indir' && l.ad === fotoYol).length})`);

    a.ws.close(); v.ws.close(); k2.ws.close();
    await Promise.all([a.closed, v.closed, k2.closed]);
  } finally {
    if (kilit) { try { execFileSync('taskkill', ['/pid', String(kilit.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* kapandı */ } }
    for (const j of junctionlar) { try { fs.rmdirSync(j); } catch { /* yok */ } }
  }
  console.log(`\n${pass} kontrol geçti`);
  process.exit();
})().catch((e) => { console.error('TEST HATASI', e); process.exit(1); });
