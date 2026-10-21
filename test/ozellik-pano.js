// Pano eşitleme testi: istemci -> bilgisayar panosu, bilgisayar panosu -> istemci (metin ve resim), ayar, yetkiler,
// süreç yaşam döngüsü ve başsız Edge'de pano paneli (resim önizlemesi, düğmeler; iPhone/iPad boyutu).
// GERÇEK pano kullanılır: başta mevcut içerik (metin, resim, "PNG" akışı, dosya listesi) kaydedilir,
// sonda (hata olsa bile) .NET Clipboard ile geri yüklenir. Diğer biçimler (HTML, RTF...) geri gelmez.
// Tarayıcıda navigator.clipboard.write/read ve navigator.share sayfada taklit edilir (cihaz panosuna/paylaşıma gitmez);
// gerçek iOS Safari emüle EDİLEMEZ. Ekran görüntüleri %TEMP%\rc-pano\ altına kaydedilir.
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const zlib = require('zlib');
const { execFileSync, spawn, spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const WebSocket = require(path.join(ROOT, 'node_modules', 'ws'));
const PORT = process.env.TEST_PORT || 3999;
const URL = `ws://localhost:${PORT}`;
const TMP = fs.mkdtempSync(path.join(process.env.TEST_TMP || os.tmpdir(), 'pano-'));
const PANO_EXE = path.join(ROOT, 'helper', 'Pano.exe');
const SHOTS = path.join(os.tmpdir(), 'rc-pano');
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

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

// ---------- Gerçek pano (PowerShell ile, sunucudan bağımsız; Clipboard STA ister) ----------
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
function ps(cmd) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', cmd], { encoding: 'utf8', timeout: 60000 }).trim();
}
const PS_BAS = 'Add-Type -AssemblyName System.Windows.Forms, System.Drawing; $C = [System.Windows.Forms.Clipboard];';
function panoOku() {
  const b = ps("$t = Get-Clipboard -Raw; if ($null -eq $t) { 'YOK' } else { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t)) }");
  return b === 'YOK' ? null : Buffer.from(b, 'base64').toString('utf8');
}
function panoYaz(metin) {
  // Uzun metinler komut satırına sığmaz: geçici dosya üzerinden.
  const f = path.join(TMP, 'pano.txt');
  fs.writeFileSync(f, metin, 'utf8');
  ps(`Set-Clipboard -Value ([IO.File]::ReadAllText(${q(f)}, [Text.Encoding]::UTF8))`);
}

// Panonun şu anki içeriğini TMP\kayit\ altına kaydeder.
const KAYIT = path.join(TMP, 'kayit');
function panoKaydet() {
  fs.mkdirSync(KAYIT, { recursive: true });
  return JSON.parse(ps(`${PS_BAS} $k = ${q(KAYIT)}; $o = @{ metin = $false; resim = $false; png = $false; dosya = $false; w = 0; h = 0 }
    if ($C::ContainsText()) { [IO.File]::WriteAllText("$k\\metin.txt", $C::GetText(), [Text.Encoding]::UTF8); $o.metin = $true }
    $d = $C::GetDataObject()
    if ($d -and $d.GetDataPresent('PNG')) { $ms = $d.GetData('PNG'); if ($ms -is [IO.MemoryStream]) { [IO.File]::WriteAllBytes("$k\\akis.png", $ms.ToArray()); $o.png = $true } }
    if ($C::ContainsImage()) { $i = $C::GetImage(); $i.Save("$k\\resim.png", [System.Drawing.Imaging.ImageFormat]::Png); $o.resim = $true; $o.w = $i.Width; $o.h = $i.Height; $i.Dispose() }
    if ($C::ContainsFileDropList()) { [IO.File]::WriteAllLines("$k\\dosya.txt", [string[]]@($C::GetFileDropList()), [Text.Encoding]::UTF8); $o.dosya = $true }
    $o | ConvertTo-Json -Compress`));
}
function panoGeriYukle(k) {
  ps(`${PS_BAS} $k = ${q(KAYIT)}; $d = New-Object System.Windows.Forms.DataObject; $var = $false
    if (${k.metin ? '$true' : '$false'}) { $d.SetText([IO.File]::ReadAllText("$k\\metin.txt", [Text.Encoding]::UTF8)); $var = $true }
    if (${k.resim ? '$true' : '$false'}) { $img = [System.Drawing.Image]::FromFile("$k\\resim.png"); $d.SetImage($img); $var = $true }
    if (${k.png ? '$true' : '$false'}) { $d.SetData('PNG', $false, (New-Object IO.MemoryStream(,[IO.File]::ReadAllBytes("$k\\akis.png")))); $var = $true }
    if (${k.dosya ? '$true' : '$false'}) { $sc = New-Object System.Collections.Specialized.StringCollection; foreach ($s in [IO.File]::ReadAllLines("$k\\dosya.txt")) { [void]$sc.Add($s) }; $d.SetFileDropList($sc); $var = $true }
    if ($var) { $C::SetDataObject($d, $true, 10, 100) } else { $C::Clear() }`);
}
// Bilgisayar panosundaki resmin durumu.
function panoResim() {
  return JSON.parse(ps(`${PS_BAS} $d = $C::GetDataObject(); $o = @{ resim = $C::ContainsImage(); metin = $C::ContainsText(); png = $false; dib = $false; w = 0; h = 0; renk = '' }
    if ($d) { $o.png = $d.GetDataPresent('PNG'); $o.dib = $d.GetDataPresent('DeviceIndependentBitmap') }
    if ($o.resim) { $i = $C::GetImage(); $o.w = $i.Width; $o.h = $i.Height; $p = $i.GetPixel(5, 5); $o.renk = '{0},{1},{2}' -f $p.R, $p.G, $p.B; $i.Dispose() }
    $o | ConvertTo-Json -Compress`));
}
// Bilgisayar panosuna test resmi koyar. png: true -> ekran alıntısı gibi "PNG" akışı (+ Bitmap), değilse yalnızca SetImage (CF_BITMAP/DIB).
function resimKoy(w, h, { png = false } = {}) {
  ps(`${PS_BAS} $b = New-Object System.Drawing.Bitmap(${w}, ${h}); $g = [System.Drawing.Graphics]::FromImage($b)
    $g.Clear([System.Drawing.Color]::FromArgb(255, 30, 120, 200)); $g.FillRectangle([System.Drawing.Brushes]::Orange, 0, 0, [int](${w} / 2), [int](${h} / 2)); $g.Dispose()
    if (${png ? '$true' : '$false'}) { $ms = New-Object IO.MemoryStream; $b.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); $d = New-Object System.Windows.Forms.DataObject; $d.SetData('PNG', $false, $ms); $d.SetImage($b); $C::SetDataObject($d, $true, 10, 100) }
    else { $C::SetImage($b) }`);
}
// Sıkıştırılamayan (rastgele) büyük resim: PNG'si 20 MB'ı aşar.
function gurultuKoy(w, h) {
  ps(`${PS_BAS} $b = New-Object System.Drawing.Bitmap(${w}, ${h}, [System.Drawing.Imaging.PixelFormat]::Format32bppRgb)
    $v = $b.LockBits((New-Object System.Drawing.Rectangle(0, 0, ${w}, ${h})), 'WriteOnly', $b.PixelFormat); $a = New-Object byte[] ($v.Stride * ${h}); (New-Object Random(7)).NextBytes($a)
    [Runtime.InteropServices.Marshal]::Copy($a, 0, $v.Scan0, $a.Length); $b.UnlockBits($v); $C::SetImage($b)`);
}
function jpegYap(w, h) {
  const f = path.join(TMP, 'deneme.jpg');
  ps(`${PS_BAS} $b = New-Object System.Drawing.Bitmap(${w}, ${h}); $g = [System.Drawing.Graphics]::FromImage($b); $g.Clear([System.Drawing.Color]::SeaGreen); $g.Dispose(); $b.Save(${q(f)}, [System.Drawing.Imaging.ImageFormat]::Jpeg)`);
  return fs.readFileSync(f);
}
// Node ile küçük PNG (RGBA). renk(x, y) -> [r, g, b, a]
function pngYap(w, h, renk) {
  const satirlar = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) Buffer.from(renk(x, y)).copy(satirlar, y * (w * 4 + 1) + 1 + x * 4);
  const parca = (tur, veri) => {
    const b = Buffer.alloc(8 + veri.length + 4);
    b.writeUInt32BE(veri.length, 0); b.write(tur, 4, 'latin1'); veri.copy(b, 8);
    b.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(tur, 'latin1'), veri])), 8 + veri.length);
    return b;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), parca('IHDR', ihdr), parca('IDAT', zlib.deflateSync(satirlar)), parca('IEND', Buffer.alloc(0))]);
}
const pngBoyut = (b) => (b.length > 24 && b.readUInt32BE(0) === 0x89504e47 ? { w: b.readUInt32BE(16), h: b.readUInt32BE(20) } : null);

// Yalnızca test sunucusunun (PORT'u dinleyen node) başlattığı Pano.exe'ler sayılır;
// aynı klasörden çalışan başka bir sunucunun (ör. kullanıcının 3080'deki) Pano.exe'si sayılmaz.
const panoSurecSayisi = () => Number(ps(`$s = (Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess; @(Get-CimInstance Win32_Process -Filter "Name='Pano.exe'" | Where-Object { $_.ExecutablePath -eq ${q(PANO_EXE)} -and $_.ParentProcessId -eq $s }).Count`));

function istekAt({ method = 'GET', yol, token, body, headers = {} }) {
  return new Promise((resolve) => {
    const h = { ...headers };
    if (token) h['X-Oturum'] = token;
    if (body) h['Content-Length'] = body.length;
    const req = http.request({ host: 'localhost', port: PORT, method, path: yol, headers: h }, (res) => {
      const p = [];
      res.on('data', (c) => p.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(p) }));
      res.on('error', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(p) }));
    });
    req.on('error', (e) => resolve({ status: 0, body: Buffer.from(e.message) }));
    req.end(body);
  });
}
const postMetin = async (token, metin) => {
  const r = await istekAt({ method: 'POST', yol: '/api/pano/yaz', token, body: Buffer.from(metin, 'utf8') });
  return { status: r.status, body: r.body.toString('utf8') };
};
const postResim = (token, body, tur = 'image/png') => istekAt({ method: 'POST', yol: '/api/pano/resim', token, body, headers: { 'Content-Type': tur } });
const getResim = (token) => istekAt({ yol: '/api/pano/resim?id=1', token });
const jsonu = (r) => { try { return JSON.parse(r.body.toString('utf8')); } catch { return {}; } };

async function giris(username, password) {
  const c = client();
  await c.next(t('hello'));
  c.send({ t: 'login', username, password, remember: false });
  const r = await c.next(t('auth'));
  return { c, r };
}

const resimMesaji = (pred = () => true) => (m) => m.t === 'pano' && m.resim && pred(m.resim);

(async () => {
  const kayit = panoKaydet();
  console.log(`(pano kaydedildi: ${Object.entries(kayit).filter(([k, v]) => v === true).map(([k]) => k).join(', ') || 'boş'})`);
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

    // 6. Resim: bilgisayar -> istemci
    let r404 = await getResim(ar.http);
    check('panoda resim yokken GET /api/pano/resim 404', r404.status === 404, `(${r404.status})`);
    resimKoy(123, 77);
    const rm = await a.next(resimMesaji((r) => r.w === 123), 10000).catch(() => null);
    check('bilgisayarda resim kopyalanınca istemciye resim bildirimi (123×77)', rm?.resim.w === 123 && rm.resim.h === 77 && rm.resim.id > 0 && rm.resim.bytes > 0, JSON.stringify(rm?.resim));
    check('bildirimde resim verisi gömülü değil (yalnızca adres bilgisi)', rm && JSON.stringify(rm).length < 300, rm ? `(${JSON.stringify(rm).length} karakter)` : '');
    const rmb = await b.next(resimMesaji((r) => r.w === 123), 8000).catch(() => null);
    check('ikinci cihaza da resim bildirimi', rmb?.resim.id === rm?.resim.id);
    let g = await getResim(ar.http);
    check('GET /api/pano/resim PNG döndü, boyutlar aynı', g.status === 200 && g.headers['content-type'] === 'image/png' && pngBoyut(g.body)?.w === 123 && pngBoyut(g.body)?.h === 77,
      `(${g.status} ${g.headers['content-type']} ${JSON.stringify(pngBoyut(g.body))})`);
    check('resim önbelleğe alınmaz (no-store)', /no-store/.test(g.headers['cache-control'] || ''));
    const gv = await getResim(vr.http);
    check('salt izleme resmi alamaz (403)', gv.status === 403, `(${gv.status})`);
    const go = await getResim(null);
    check('oturumsuz resim isteği 401', go.status === 401, `(${go.status})`);
    await sleep(300);
    check('salt izlemeye resim bildirimi gitmedi', !v.queue.some((m) => m.t === 'pano'));
    a.send({ t: 'pano-al' });
    const ral = await a.next((m) => m.t === 'pano' && m.istek);
    check('pano-al panodaki resmi bildirdi (aynı id)', ral.resim?.id === rm?.resim.id && ral.resim.w === 123, JSON.stringify(ral));

    // Ekran alıntısı gibi "PNG" akışı (saydamlık korunur)
    resimKoy(200, 150, { png: true });
    const rp = await a.next(resimMesaji((r) => r.w === 200), 10000).catch(() => null);
    check('"PNG" biçimindeki resim (ekran alıntısı) bildirildi (200×150)', rp?.resim.h === 150, JSON.stringify(rp?.resim));
    g = await getResim(ar.http);
    check('"PNG" akışı aynı boyutta alındı', JSON.stringify(pngBoyut(g.body)) === '{"w":200,"h":150}', JSON.stringify(pngBoyut(g.body)));

    // 7. Resim: istemci -> bilgisayar
    const kirmizi = pngYap(321, 123, (x) => (x < 160 ? [220, 20, 30, 255] : [20, 40, 220, 128]));
    let pr = await postResim(ar.http, kirmizi);
    check('istemciden PNG gönderildi', pr.status === 200 && jsonu(pr).ok && jsonu(pr).w === 321 && jsonu(pr).h === 123, `(${pr.status} ${pr.body.toString().slice(0, 100)})`);
    let pd = panoResim();
    check('bilgisayar panosunda aynı boyutta resim (321×123)', pd.resim && pd.w === 321 && pd.h === 123, JSON.stringify(pd));
    // Resim ayrıca dosya aktarımı klasörüne kaydedilir (REMOTE_UPLOAD_DIR), Dosya Gezgini'nde gösterilebilir (kuru)
    const kd = jsonu(pr).dosya;
    const kdYol = kd && path.join(process.env.REMOTE_UPLOAD_DIR || '', kd.ad);
    check('resim dosya olarak da kaydedildi (pano-<tarih>.png, aynı baytlar)', !!kd && /^pano-\d{8}-\d{6}(-\d+)?\.png$/.test(kd.ad) && !!process.env.REMOTE_UPLOAD_DIR
      && fs.existsSync(kdYol) && fs.readFileSync(kdYol).equals(kirmizi), JSON.stringify(kd));
    check('cevapta kaydedildiği yer (klasörün son iki parçası)', kd && / › /.test(kd.yer), kd && kd.yer);
    const gs = await istekAt({ method: 'POST', yol: `/api/pano/goster?ad=${encodeURIComponent(kd ? kd.ad : 'x')}`, token: ar.http });
    check('"Bilgisayarda göster" (kuru: Gezgin açılmadı)', gs.status === 200 && jsonu(gs).ok && jsonu(gs).kuru === true, `(${gs.status}) ${gs.body.toString().slice(0, 100)}`);
    const gy = await istekAt({ method: 'POST', yol: `/api/pano/goster?ad=${encodeURIComponent('..\\..\\Windows\\win.ini')}`, token: ar.http });
    check('yalnızca bu oturumda kaydedilen ad gösterilebilir (yol verilemez)', gy.status === 404, String(gy.status));
    check('panoda hem "PNG" akışı hem CF_DIB var (her uygulamada yapıştırılır)', pd.png && pd.dib, JSON.stringify(pd));
    check('piksel rengi korunmuş (kırmızı)', pd.renk === '220,20,30', pd.renk);
    check('panoda eski metin kalmadı', !pd.metin);
    const ryanki = await a.next(resimMesaji((r) => r.w === 321), 1500).catch(() => null);
    check('gönderen istemciye resim geri yankısı yok', !ryanki, JSON.stringify(ryanki));
    const rdiger = await b.next(resimMesaji((r) => r.w === 321), 8000).catch(() => null);
    check('diğer kontrol cihazına gönderilen resim bildirildi', rdiger?.resim.h === 123, JSON.stringify(rdiger?.resim));
    g = await getResim(ar.http);
    check('gönderilen resim HTTP\'den de alınabiliyor', JSON.stringify(pngBoyut(g.body)) === '{"w":321,"h":123}');

    pr = await postResim(ar.http, jpegYap(64, 48), 'image/jpeg');
    pd = panoResim();
    check('JPEG gönderildi, panoda 64×48 resim', pr.status === 200 && pd.w === 64 && pd.h === 48 && pd.png && pd.dib, `(${pr.status}) ${JSON.stringify(pd)}`);
    pr = await postResim(ar.http, Buffer.from('bu bir resim değil'), 'image/png');
    check('resim olmayan veri reddedildi (415)', pr.status === 415, `(${pr.status})`);
    pr = await postResim(ar.http, Buffer.alloc(20 * 1024 * 1024 + 10, 0x89));
    check('20 MB üstü resim reddedildi (413)', pr.status === 413, `(${pr.status})`);
    pr = await postResim(vr.http, kirmizi);
    check('salt izleme resim gönderemez (403)', pr.status === 403, `(${pr.status})`);
    check('reddedilenlerden sonra pano değişmedi', panoResim().w === 64);

    // 8. Bilgisayarda çok büyük resim (PNG 20 MB üstü): aktarılmaz
    gurultuKoy(3500, 2500);
    const rb = await a.next(resimMesaji((r) => r.tooBig), 20000).catch(() => null);
    check('20 MB üstü bilgisayar resmi "çok büyük" olarak bildirildi', rb?.resim.w === 3500 && !rb.resim.id, JSON.stringify(rb?.resim));
    r404 = await getResim(ar.http);
    check('çok büyük resim HTTP\'den verilmez (404)', r404.status === 404, `(${r404.status})`);
    // Metin kopyalanınca resim düşer
    panoYaz(`resimden sonra ${benzersiz}`);
    await a.next((m) => m.t === 'pano' && m.text === `resimden sonra ${benzersiz}`, 8000).catch(() => null);
    r404 = await getResim(ar.http);
    check('metin kopyalanınca resim artık verilmiyor (404)', r404.status === 404, `(${r404.status})`);

    // 9. Tarayıcı (başsız Edge): panelde önizleme ve düğmeler
    await tarayiciTesti();

    // 10. Süreç yaşam döngüsü: yalnızca salt izleme kalınca Pano.exe durur
    a.ws.close(); await a.closed;
    b.ws.close(); await b.closed;
    await sleep(3000);
    check('kontrol oturumu kalmayınca Pano.exe durdu', panoSurecSayisi() === 0, `(${panoSurecSayisi()} süreç)`);
    v.ws.close(); await v.closed;
  } finally {
    try {
      panoGeriYukle(kayit);
      const s = panoResim();
      const metinOk = !kayit.metin || panoOku() === fs.readFileSync(path.join(KAYIT, 'metin.txt'), 'utf8').replace(/^\uFEFF/, '');
      const resimOk = !kayit.resim || (s.w === kayit.w && s.h === kayit.h);
      const bosOk = kayit.metin || kayit.resim || kayit.dosya || kayit.png || (!s.resim && !s.metin);
      console.log(metinOk && resimOk && bosOk ? '(pano geri yüklendi)' : `UYARI: pano geri yüklemesi doğrulanamadı ${JSON.stringify(s)}`);
    } catch (err) {
      console.log('UYARI: pano geri yüklenemedi:', err.message);
    }
    fs.rmSync(TMP, { recursive: true, force: true });
  }
  console.log(`\n${pass} kontrol geçti`);
  process.exit();
})().catch((e) => { console.error('TEST HATASI', e); process.exit(1); });

// ---------------- Başsız Edge ----------------
// Girdi mesajları sayfada yakalanır (bilgisayara gitmez). Cihaz panosu ve paylaşım taklit edilir.
const YAKALAYICI = `
  window.__sent = [];
  const __orig = WebSocket.prototype.send;
  const __block = new Set(['move','down','up','wheel','key','text','kalem','guc']);
  WebSocket.prototype.send = function (d) {
    try { const m = JSON.parse(d); if (__block.has(m.t)) { window.__sent.push(m); return; } } catch {}
    return __orig.call(this, d);
  };
  window.__pano = { okunacak: [] };
  if (navigator.clipboard) {
    navigator.clipboard.write = (items) => {
      window.__pano.yaziliyor = true;
      return Promise.resolve(items[0].getType('image/png')).then((b) => { window.__pano.yazilan = { tur: b.type, boyut: b.size, turler: items[0].types }; });
    };
    navigator.clipboard.read = async () => window.__pano.okunacak;
  }
  navigator.canShare = () => true;
  navigator.share = async (d) => { window.__pano.paylasilan = d.files.map((f) => ({ ad: f.name, tur: f.type, boyut: f.size })); };`;
// HTTP (güvenli olmayan bağlam) taklidi: Clipboard API ve paylaşım yok.
const GUVENSIZ = `
  Object.defineProperty(window, 'isSecureContext', { get: () => false });
  Object.defineProperty(Navigator.prototype, 'clipboard', { get: () => undefined, configurable: true });
  Object.defineProperty(navigator, 'clipboard', { get: () => undefined, configurable: true });
  navigator.canShare = undefined; navigator.share = undefined;
  window.__dosyaSecici = 0;
  const __tikla = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function () { if (this.type === 'file') { window.__dosyaSecici++; return; } return __tikla.call(this); };`;

const getJson = (u) => new Promise((res, rej) => http.get(u, (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej));

async function tarayiciTesti() {
  const exe = BROWSERS.find((x) => fs.existsSync(x));
  if (!exe) { console.log('OK   tarayıcı (Edge/Chrome) bulunamadı, tarayıcı testi atlandı'); return; }
  fs.mkdirSync(SHOTS, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-pano-tarayici-'));
  const indirilen = path.join(TMP, 'indirilen');
  fs.mkdirSync(indirilen);
  let browser;
  try {
    browser = spawn(exe, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 80 && !fs.existsSync(portFile); i++) await sleep(250);
    const dbg = Number(fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0]);
    let targets = [];
    for (let i = 0; i < 40; i++) { try { targets = await getJson(`http://127.0.0.1:${dbg}/json/list`); if (targets.some((x) => x.type === 'page')) break; } catch {} await sleep(250); }
    const cdp = new WebSocket(targets.find((x) => x.type === 'page').webSocketDebuggerUrl);
    await new Promise((r) => cdp.on('open', r));
    let id = 0; const pending = new Map();
    const hatalar = [];
    cdp.on('message', (d) => {
      const m = JSON.parse(d);
      if (m.method === 'Runtime.exceptionThrown') hatalar.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    });
    const call = (method, params = {}) => new Promise((r, j) => { const i = ++id; pending.set(i, r); cdp.send(JSON.stringify({ id: i, method, params })); setTimeout(() => j(new Error(`CDP zaman aşımı: ${method}`)), 15000); });
    const ev = async (expression) => { const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails)); return r.result?.result?.value; };
    const bekle = async (expr, ms = 8000) => { for (let i = 0; i < ms / 100; i++) { if (await ev(expr).catch(() => false)) return true; await sleep(100); } return false; };
    const shot = async (ad) => {
      const r = await call('Page.captureScreenshot', { format: 'png' });
      const p = path.join(SHOTS, `${ad}.png`);
      fs.writeFileSync(p, Buffer.from(r.result.data, 'base64'));
      console.log(`     ekran görüntüsü: ${p}`);
    };
    const rect = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })()`);
    const touch = (type, pts) => call('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: i, radiusX: 1, radiusY: 1, force: 1 })) });
    const tap = async (sel) => {
      const p = await rect(sel);
      if (!p) throw new Error(`öğe yok: ${sel}`);
      await touch('touchStart', [p]); await sleep(40); await touch('touchEnd', []); await sleep(150);
    };
    const shown = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && !e.hidden && getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0; })()`);
    const durumYazi = () => ev("document.querySelector('#panoPanel [data-k=\"durum\"]').textContent");
    const panelAc = async () => {
      if (await shown('#panoPanel')) return;
      if (await shown('#panoBtnPin')) await tap('#panoBtnPin');
      else { await tap('#menuBtn'); await tap('#panoBtn'); }
    };
    const sayfaAc = async () => {
      await call('Page.navigate', { url: `http://localhost:${PORT}/` });
      await bekle("!document.getElementById('vLogin').hidden || !document.getElementById('vHome').hidden", 10000);
      if (await ev("!document.getElementById('vLogin').hidden")) {
        await ev("(() => { const f = document.getElementById('tAccount'); f.username.value = 'ahmet'; f.password.value = 'gizli123'; f.requestSubmit(); })()");
        await bekle("!document.getElementById('vHome').hidden", 10000);
      }
      await ev("document.getElementById('modeControl').click()");
      return bekle("document.getElementById('screen').width > 0", 15000);
    };

    await call('Page.enable'); await call('Runtime.enable');
    await call('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: indirilen }); // indirmeler kullanıcının klasörüne gitmesin
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await call('Emulation.setUserAgentOverride', { userAgent: IPHONE_UA });
    const yakalayici = await call('Page.addScriptToEvaluateOnNewDocument', { source: YAKALAYICI });
    check('tarayıcı: görüntüleyici açıldı (iPhone boyutu)', await sayfaAc());

    // Bilgisayarda resim kopyalanınca: ⋯ menüde işaret, panelde önizleme
    resimKoy(240, 160, { png: true });
    check('tarayıcı: yeni resim işareti (menü satırında nokta)', await bekle("!document.querySelector('#panoBtn .mdot').hidden", 10000));
    await panelAc();
    check('tarayıcı: pano paneli açıldı', await shown('#panoPanel'));
    check('tarayıcı: önizleme yüklendi (240×160)', await bekle("(() => { const i = document.querySelector('#panoPanel [data-k=\"resim\"]'); return i.complete && i.naturalWidth === 240 && i.naturalHeight === 160; })()"));
    const bilgi = await ev("document.querySelector('#panoPanel [data-k=\"resimBilgi\"]').textContent");
    check('tarayıcı: resim bilgisi (boyut)', /240×160/.test(bilgi), bilgi);
    check('tarayıcı: "Telefona kopyala" ve "Kaydet / Paylaş" görünür, metin kutusu gizli',
      (await shown('#panoPanel [data-k="resimKopyala"]')) && (await shown('#panoPanel [data-k="resimKaydet"]')) && !(await shown('#panoPanel [data-k="pc"]')) &&
      (await ev("document.querySelector('#panoPanel [data-k=\"resimKaydet\"]').textContent")) === 'Kaydet / Paylaş');
    check('tarayıcı: "Telefondan resim gönder" görünür', await shown('#panoPanel [data-k="resimGonder"]'));
    const pp = await rect('#panoPanel');
    const ip = await rect('#panoPanel [data-k="resim"]');
    check('tarayıcı: panel ve önizleme ekrana sığıyor', pp.w <= 390 && ip.w <= pp.w && ip.h > 30 && ip.h <= 844 * 0.35, JSON.stringify({ pp, ip }));
    const kucuk = await ev("[...document.querySelectorAll('#panoPanel button')].filter((e) => e.getClientRects().length).map((e) => [e.dataset.k || e.className, Math.round(e.getBoundingClientRect().height)]).filter(([, h]) => h < 40)");
    check('tarayıcı: panel düğmeleri dokunulabilir boyutta', kucuk.length === 0, JSON.stringify(kucuk));
    await shot('1-iphone-pano-resim');

    await tap('#panoPanel [data-k="resimKopyala"]');
    check('tarayıcı: "Telefona kopyala" panoya image/png (Promise ile ClipboardItem) yazdı',
      await bekle("window.__pano.yazilan && window.__pano.yazilan.tur === 'image/png' && window.__pano.yazilan.boyut > 0"), JSON.stringify(await ev('window.__pano.yazilan')));
    check('tarayıcı: kopyalama durumu yazıldı', /kopyalandı/.test(await durumYazi()), await durumYazi());
    await tap('#panoPanel [data-k="resimKaydet"]');
    const paylasilan = await ev('window.__pano.paylasilan');
    check('tarayıcı: "Kaydet / Paylaş" paylaşım menüsüne PNG dosyası verdi', paylasilan?.[0]?.tur === 'image/png' && /^pano-.*\.png$/.test(paylasilan[0].ad) && paylasilan[0].boyut > 0, JSON.stringify(paylasilan));

    // Cihaz -> bilgisayar: panodan (clipboard.read taklidi)
    await ev(`(async () => {
      const c = document.createElement('canvas'); c.width = 50; c.height = 40; const g = c.getContext('2d'); g.fillStyle = '#c81e1e'; g.fillRect(0, 0, 50, 40);
      const b = await new Promise((r) => c.toBlob(r, 'image/png'));
      window.__pano.okunacak = [new ClipboardItem({ 'image/png': b })];
    })()`);
    await tap('#panoPanel [data-k="resimGonder"]');
    check('tarayıcı: cihaz panosundaki resim gönderildi', await bekle("/kondu \\(50×40\\)/.test(document.querySelector('#panoPanel [data-k=\"durum\"]').textContent)", 15000), await durumYazi());
    let pd = panoResim();
    check('tarayıcı: bilgisayar panosunda 50×40 resim', pd.w === 50 && pd.h === 40 && pd.renk === '200,30,30', JSON.stringify(pd));
    // Panoda resim yoksa "Resim seç…" çıkar
    await ev('window.__pano.okunacak = []');
    await tap('#panoPanel [data-k="resimGonder"]');
    check('tarayıcı: cihaz panosunda resim yoksa "Resim seç…" düğmesi çıktı', await bekle("!document.querySelector('#panoPanel [data-k=\"resimSec\"]').hidden"), await durumYazi());
    // Dosya seçiciden HEIC benzeri (doğrudan desteklenmeyen) biçim: tarayıcıda PNG'ye çevrilir (WebP ile denenir)
    await ev(`(async () => {
      const c = document.createElement('canvas'); c.width = 70; c.height = 30; const g = c.getContext('2d'); g.fillStyle = '#1e64c8'; g.fillRect(0, 0, 70, 30);
      const b = await new Promise((r) => c.toBlob(r, 'image/webp'));
      const i = document.querySelector('#panoPanel [data-k="dosya"]'); const dt = new DataTransfer(); dt.items.add(new File([b], 'foto.webp', { type: b.type }));
      i.files = dt.files; i.dispatchEvent(new Event('change'));
    })()`);
    check('tarayıcı: desteklenmeyen biçim PNG\'ye çevrilip gönderildi', await bekle("/kondu \\(70×30\\)/.test(document.querySelector('#panoPanel [data-k=\"durum\"]').textContent)", 15000), await durumYazi());
    pd = panoResim();
    check('tarayıcı: bilgisayar panosunda 70×30 resim ("PNG" + DIB)', pd.w === 70 && pd.h === 30 && pd.png && pd.dib, JSON.stringify(pd));
    await shot('2-iphone-pano-gonderildi');

    // iPad boyutu
    await call('Emulation.setDeviceMetricsOverride', { width: 1024, height: 1366, deviceScaleFactor: 2, mobile: true });
    await sleep(400);
    resimKoy(300, 200);
    await panelAc();
    check('tarayıcı (iPad): önizleme 300×200', await bekle("(() => { const i = document.querySelector('#panoPanel [data-k=\"resim\"]'); return i.complete && i.naturalWidth === 300; })()", 10000));
    await shot('3-ipad-pano-resim');

    // HTTP (güvenli olmayan bağlam) taklidi: kopyalama yok, yalnızca indir; gönderme dosya seçiciyle
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await call('Page.removeScriptToEvaluateOnNewDocument', { identifier: yakalayici.result.identifier });
    await call('Page.addScriptToEvaluateOnNewDocument', { source: YAKALAYICI.replace(/window\.__pano = [\s\S]*$/, '') + GUVENSIZ });
    check('tarayıcı (HTTP): görüntüleyici açıldı', await sayfaAc());
    check('tarayıcı (HTTP): güvenli olmayan bağlam taklit edildi', await ev('!window.isSecureContext && !navigator.clipboard'));
    await panelAc();
    check('tarayıcı (HTTP): önizleme yüklendi', await bekle("document.querySelector('#panoPanel [data-k=\"resim\"]').naturalWidth === 300", 10000));
    check('tarayıcı (HTTP): "Telefona kopyala" gizli, "Kaydet (indir)" görünür',
      !(await shown('#panoPanel [data-k="resimKopyala"]')) && (await ev("document.querySelector('#panoPanel [data-k=\"resimKaydet\"]').textContent")) === 'Kaydet (indir)');
    await shot('4-iphone-http-pano-resim');
    await tap('#panoPanel [data-k="resimKaydet"]');
    let inen = null;
    for (let i = 0; i < 50 && !inen; i++) { inen = fs.readdirSync(indirilen).find((f) => f.endsWith('.png')); if (!inen) await sleep(100); }
    check('tarayıcı (HTTP): "Kaydet" PNG indirdi (300×200)', inen && JSON.stringify(pngBoyut(fs.readFileSync(path.join(indirilen, inen)))) === '{"w":300,"h":200}', inen || 'indirilmedi');
    await tap('#panoPanel [data-k="resimGonder"]');
    check('tarayıcı (HTTP): "Telefondan resim gönder" doğrudan dosya seçiciyi açtı', (await ev('window.__dosyaSecici')) === 1);
    check('tarayıcı: sayfada JS hatası yok', hatalar.length === 0, hatalar.join(' | ').slice(0, 300));
    const s = await ev('window.__sent.filter((m) => m.t === "down" || m.t === "up" || m.t === "key").length');
    check('tarayıcı: panel dokunuşları bilgisayara tıklama/tuş göndermedi', s === 0, `(${s})`);
    cdp.close();
  } catch (err) {
    check('tarayıcı testi hatasız tamamlandı', false, err.message);
  } finally {
    if (browser) spawnSync('taskkill', ['/pid', String(browser.pid), '/T', '/F'], { stdio: 'ignore' });
    await sleep(500);
    fs.rmSync(profile, { recursive: true, force: true });
  }
}
