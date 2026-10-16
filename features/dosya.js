// Dosya aktarımı: bilgisayara yükleme, bilgisayardaki dosyalarda gezinme ve indirme. Hepsi kontrol yetkisi ister.
//   POST /api/dosya/yukle?ad=<dosya adı>   gövde: ham dosya baytları (akışla diske yazılır, en fazla 8 GB)
//        hedef: REMOTE_UPLOAD_DIR ya da "%USERPROFILE%\Downloads\Uzaktan Bağlantı"
//   GET  /api/dosya/liste?yol=<göreli yol>  -> { yol, girdiler: [{ ad, tur: 'klasor'|'dosya', boyut, degisme }], kesildi }
//   GET  /api/dosya/indir?yol=<göreli yol>  -> dosya (akışla)
//        kök: REMOTE_BROWSE_ROOT ya da kullanıcı profil klasörü; kökün dışına hiçbir şekilde çıkılamaz.
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');
const { promisify } = require('util');
const crypto = require('crypto');

// fs.realpath.native: Windows'ta GetFinalPathNameByHandle — junction/symlink ve 8.3 kısa adları tam yola çevirir.
const gercekYol = promisify(fs.realpath.native);

const MAX_YUKLEME = 8 * 1024 ** 3; // 8 GB
const MAX_GIRDI = 5000;            // bir klasörde listelenecek en fazla giriş
const BOSTA_SURESI = 2 * 60 * 1000; // bu kadar süre hiç veri gelmeyen yükleme kesilir

const yuklemeKlasoru = () => process.env.REMOTE_UPLOAD_DIR || path.join(os.homedir(), 'Downloads', 'Uzaktan Bağlantı');
const gezinmeKoku = () => process.env.REMOTE_BROWSE_ROOT || os.homedir();

// Windows'ta dosya adı olarak kullanılamayan aygıt adları (uzantılı halleri de: "CON.txt").
const AYGIT_ADI = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$|clock\$)$/i;
const YASAK_KARAKTER = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;

// İstemcinin gönderdiği adı güvenli bir dosya adına çevirir (klasör kısmı atılır).
function adTemizle(ad) {
  let s = String(ad || '').normalize('NFC');
  s = s.split(/[\\/]/).pop();                       // yol verilmişse yalnızca son parça
  s = s.replace(YASAK_KARAKTER, '_');
  s = s.replace(/^[\s.]+|[\s.]+$/g, '');            // baştaki/sondaki nokta ve boşluklar
  if (AYGIT_ADI.test(s.split('.')[0].trim())) s = `_${s}`;
  if (s.length > 180) {                             // çok uzun adları uzantıyı koruyarak kısalt
    const uz = path.extname(s).slice(0, 20);
    s = s.slice(0, 180 - uz.length).replace(/[\s.]+$/, '') + uz;
  }
  return s || 'dosya';
}

// Yükleme önce geçici bir ada yazılır; yalnızca eksiksiz bitince son ada taşınır. Böylece sunucu yarıda kapanırsa
// (tepsiden çıkış, çökme) kesik dosya, tam görünümlü bir adla kalmaz. Kalan geçici dosyalar açılışta silinir.
const GECICI_UZ = '.uzaktan-yukleniyor';

async function geciciAc(klasor) {
  const tam = path.join(klasor, `.${crypto.randomBytes(8).toString('hex')}${GECICI_UZ}`);
  return { tam, fh: await fsp.open(tam, 'wx') };
}

// Geçici dosyayı benzersiz son ada taşır. Çakışmada "ad (1).uzantı" ... — fs.link var olan adın üzerine yazmaz
// (EEXIST), bu yüzden iki yükleme aynı adı alamaz. Sabit bağlantı desteklenmeyen sürücülerde yeniden adlandırılır.
async function benzersizTasi(gecici, klasor, ad) {
  const uz = path.extname(ad);
  const govde = ad.slice(0, ad.length - uz.length);
  for (let i = 0; i < 1000; i++) {
    const aday = i ? `${govde} (${i})${uz}` : ad;
    const tam = path.join(klasor, aday);
    try {
      await fsp.link(gecici, tam);
      await fsp.rm(gecici, { force: true });
      return { ad: aday, tam };
    } catch (e) {
      if (e.code === 'EEXIST') continue;
      // Sabit bağlantı yok (FAT32/exFAT vb.): ad boşsa yeniden adlandır.
      try { await fsp.access(tam); continue; } catch {}
      await fsp.rename(gecici, tam);
      return { ad: aday, tam };
    }
  }
  throw new Error('Uygun dosya adı bulunamadı.');
}

// Önceki çalışmadan kalan (sunucu yarıda kapanmış) geçici yükleme dosyalarını siler.
async function eskiGecicileriSil(klasor) {
  let adlar;
  try { adlar = await fsp.readdir(klasor); } catch { return; }
  await Promise.all(adlar.filter((a) => a.endsWith(GECICI_UZ)).map((a) => fsp.rm(path.join(klasor, a), { force: true }).catch(() => {})));
}

// Göreli yolu kökün içinde gerçek bir yola çevirir. Geçersizse { kod, msg } fırlatır.
// Katmanlar: (1) parçalar tek tek doğrulanır (.., sürücü harfi, ADS ':', UNC, aygıt adları, sondaki nokta/boşluk),
// (2) fs.realpath.native ile junction/symlink ve 8.3 kısa adlar çözülür ve sonuç yine kökün altında olmalı.
async function yolCoz(yol) {
  yol = String(yol ?? '');
  const hata = (kod, msg) => Object.assign(new Error(msg), { kod });
  if (yol.length > 1000) throw hata(400, 'Yol çok uzun.');
  if (/^[\\/]/.test(yol) || path.win32.isAbsolute(yol) || path.posix.isAbsolute(yol)) throw hata(400, 'Mutlak yol kullanılamaz.');
  const parcalar = yol.split(/[\\/]+/).filter(Boolean);
  for (const p of parcalar) {
    if (/[\u0000-\u001f<>:"|?*]/.test(p)) throw hata(400, 'Geçersiz karakter.');
    if (/^[\s.]+$/.test(p) || /[\s.]$/.test(p)) throw hata(400, 'Geçersiz yol parçası.');
    if (AYGIT_ADI.test(p.split('.')[0].trim())) throw hata(400, 'Geçersiz ad.');
  }
  const kok = await gercekYol(gezinmeKoku());
  const onEk = kok.endsWith(path.sep) ? kok : kok + path.sep;
  const icinde = (p) => p.toLowerCase() === kok.toLowerCase() || p.toLowerCase().startsWith(onEk.toLowerCase());
  const tam = path.resolve(kok, ...parcalar);
  if (!icinde(tam)) throw hata(403, 'Bu klasöre erişilemez.');
  let gercek;
  try {
    gercek = await gercekYol(tam);
  } catch (e) {
    throw hata(e.code === 'ENOENT' || e.code === 'ENOTDIR' ? 404 : 403, 'Bulunamadı ya da erişilemiyor.');
  }
  if (!icinde(gercek)) throw hata(403, 'Bu klasöre erişilemez.');
  return { kok, gercek, goreli: path.relative(kok, gercek).split(path.sep).join('/') };
}

// RFC 5987/6266: ASCII yedek ad + filename*=UTF-8''...
function contentDisposition(ad) {
  const ascii = ad.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const utf8 = encodeURIComponent(ad).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

module.exports.init = (api) => {
  eskiGecicileriSil(yuklemeKlasoru());

  const json = (res, code, obj) => {
    if (res.headersSent || res.destroyed) return;
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify(obj));
  };

  // ---------- Yükleme ----------

  api.route('POST', '/api/dosya/yukle', async (req, res, ws, url) => {
    // Çekirdeğin istek başına 5 dakikalık süresi (server.js REQUEST_TIMEOUT_MS) büyük yüklemeleri keserdi. Yalnızca
    // bu (oturumu ve yetkisi doğrulanmış) istek için kapatılır; yerine "hiç veri gelmeme" süresi uygulanır
    // (aşağıda req.setTimeout). Sunucu genelindeki ayarlara dokunulmaz.
    req.uzunIstek = true;

    const uzunluk = req.headers['content-length'] !== undefined ? Number(req.headers['content-length']) : null;
    if (uzunluk !== null && !(uzunluk >= 0 && uzunluk <= MAX_YUKLEME)) {
      res.on('finish', () => req.destroy()); // gövdenin tamamını okumayı bekleme
      return json(res, 413, { ok: false, msg: 'Dosya çok büyük (en fazla 8 GB).' });
    }
    const klasor = yuklemeKlasoru();
    await fsp.mkdir(klasor, { recursive: true });
    const istenenAd = adTemizle(url.searchParams.get('ad'));
    const { tam: gecici, fh } = await geciciAc(klasor);

    let boyut = 0;
    const sinir = new Transform({
      transform(parca, _enc, cb) {
        boyut += parca.length;
        if (boyut > MAX_YUKLEME) return cb(Object.assign(new Error('Dosya çok büyük (en fazla 8 GB).'), { kod: 413 }));
        cb(null, parca);
      },
    });
    req.setTimeout(BOSTA_SURESI, () => req.destroy(new Error('Yükleme zaman aşımı')));
    try {
      await pipeline(req, sinir, fh.createWriteStream());
      if (uzunluk !== null && boyut !== uzunluk) throw new Error('Yükleme eksik kaldı.');
    } catch (e) {
      // Yarıda kalan dosyayı bırakma.
      await fh.close().catch(() => {});
      await fsp.rm(gecici, { force: true }).catch(() => {});
      api.log(`Yükleme yarıda kaldı: ${istenenAd} (${e.message})`);
      return json(res, e.kod || 400, { ok: false, msg: e.kod ? e.message : 'Yükleme yarıda kesildi.' });
    }
    await fh.close().catch(() => {});
    let ad;
    try {
      ({ ad } = await benzersizTasi(gecici, klasor, istenenAd));
    } catch (e) {
      await fsp.rm(gecici, { force: true }).catch(() => {});
      api.log(`Yüklenen dosya kaydedilemedi: ${istenenAd} (${e.message})`);
      return json(res, 500, { ok: false, msg: 'Dosya kaydedilemedi.' });
    }
    api.store.log('dosya', { user: ws.session.username, ip: ws.ip, islem: 'yukle', ad, boyut });
    api.log(`Yüklendi: ${ad} (${boyut} bayt) — ${ws.session.username}`);
    json(res, 200, { ok: true, ad, boyut, klasor });
  }, { role: 'control' });

  // ---------- Gezinme ----------

  api.route('GET', '/api/dosya/liste', async (req, res, ws, url) => {
    let r;
    try { r = await yolCoz(url.searchParams.get('yol')); } catch (e) { return json(res, e.kod || 400, { ok: false, msg: e.message }); }
    let dirents;
    try {
      dirents = await fsp.readdir(r.gercek, { withFileTypes: true });
    } catch (e) {
      return json(res, e.code === 'ENOTDIR' ? 400 : 403, { ok: false, msg: e.code === 'ENOTDIR' ? 'Bu bir klasör değil.' : 'Bu klasör açılamıyor.' });
    }
    const kesildi = dirents.length > MAX_GIRDI;
    // Kısayol/junction/symlink girişleri listelenmez (kök dışına işaret edebilirler; elle yazılan yollar yine doğrulanır).
    const adaylar = dirents.filter((d) => !d.isSymbolicLink() && (d.isDirectory() || d.isFile())).slice(0, MAX_GIRDI);
    const girdiler = (await Promise.all(adaylar.map(async (d) => {
      try {
        const st = await fsp.stat(path.join(r.gercek, d.name));
        return { ad: d.name, tur: st.isDirectory() ? 'klasor' : 'dosya', boyut: st.isDirectory() ? null : st.size, degisme: st.mtimeMs };
      } catch { return null; } // erişilemeyen girişleri atla
    }))).filter(Boolean);
    const sirala = new Intl.Collator('tr', { sensitivity: 'base', numeric: true });
    girdiler.sort((a, b) => (a.tur === b.tur ? sirala.compare(a.ad, b.ad) : a.tur === 'klasor' ? -1 : 1));
    json(res, 200, { ok: true, yol: r.goreli, kok: path.basename(r.kok) || r.kok, girdiler, kesildi });
  }, { role: 'control' });

  // ---------- İndirme ----------

  api.route('GET', '/api/dosya/indir', async (req, res, ws, url) => {
    let r;
    try { r = await yolCoz(url.searchParams.get('yol')); } catch (e) { return json(res, e.kod || 400, { ok: false, msg: e.message }); }
    let fh;
    try {
      fh = await fsp.open(r.gercek, 'r');
    } catch {
      return json(res, 403, { ok: false, msg: 'Dosya açılamıyor (kullanımda ya da erişim yok).' });
    }
    const st = await fh.stat();
    if (!st.isFile()) { await fh.close(); return json(res, 400, { ok: false, msg: 'Bu bir dosya değil.' }); }
    const ad = path.basename(r.gercek);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': st.size,
      'Content-Disposition': contentDisposition(ad),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    });
    api.store.log('dosya', { user: ws.session.username, ip: ws.ip, islem: 'indir', ad: r.goreli, boyut: st.size });
    try {
      await pipeline(fh.createReadStream(), res);
    } catch (e) {
      api.log(`İndirme yarıda kaldı: ${r.goreli} (${e.message})`);
    }
  }, { role: 'control' });
};

module.exports._test = { adTemizle, contentDisposition };
