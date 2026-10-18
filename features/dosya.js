// Dosya aktarımı: bilgisayara yükleme, bilgisayardaki dosyalarda gezinme ve indirme. Hepsi kontrol yetkisi ister.
//   POST /api/dosya/yukle?ad=<dosya adı>[&klasor=<köke göreli yol>]   gövde: ham dosya baytları (akışla, en fazla 8 GB)
//        hedef: klasor verilmezse REMOTE_UPLOAD_DIR ya da "%USERPROFILE%\Downloads\Uzaktan Bağlantı" (yoksa oluşturulur);
//        klasor verilirse gezinme kökünün içinde VAR OLAN bir klasör olmalı (bu uç klasör oluşturmaz).
//        -> { ad, boyut, klasor, tam, yer, yol, id }  (yer: "İndirilenler › Uzaktan Bağlantı"; id: "göster" için)
//   GET  /api/dosya/hedef                  -> { varsayilan: { tam, yer, yol }, kisayollar: [{ anahtar, ad, yol, tam }], kok }
//   POST /api/dosya/klasor?yol=<üst klasör>&ad=<ad>   yeni klasör (ad temizlenir, kökün içinde)
//   POST /api/dosya/goster?id=<yükleme kimliği>[&yol=<köke göreli dosya>]   dosyayı bilgisayarda Dosya Gezgini'nde seçili açar
//        REMOTE_DOSYA_KURU=1 ise Gezgin AÇILMAZ, yalnızca çalıştırılacak komut bildirilir (testler bunu kullanır).
//   GET  /api/dosya/liste?yol=<göreli yol>  -> { yol, yer, tam, girdiler: [{ ad, tur: 'klasor'|'dosya', boyut, degisme }], kesildi }
//   GET  /api/dosya/indir?yol=<göreli yol>  -> dosya (akışla; attachment, Range/206 desteği)
//   POST /api/dosya/secim  { yollar }  -> { id, ad, dosya, klasor, boyut }   zip için seçim + tahmini boyut
//   GET  /api/dosya/zip?secim=<id> | ?yol=<göreli yol>[&yol=...]  -> zip (akışla üretilir, lib/zip.js)
//        kök: REMOTE_BROWSE_ROOT ya da kullanıcı profil klasörü; kökün dışına hiçbir şekilde çıkılamaz.
// Yükleme bitince lib/olaylar üzerinden 'dosya-geldi' yayılır (tepsi simgesi balon gösterir).
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { pipeline } = require('stream/promises');
const { Transform, Readable } = require('stream');
const { promisify } = require('util');
const crypto = require('crypto');
const olaylar = require('../lib/olaylar');
const zip = require('../lib/zip');

// fs.realpath.native: Windows'ta GetFinalPathNameByHandle — junction/symlink ve 8.3 kısa adları tam yola çevirir.
const gercekYol = promisify(fs.realpath.native);

const MAX_YUKLEME = 8 * 1024 ** 3; // 8 GB
const MAX_GIRDI = 5000;            // bir klasörde listelenecek en fazla giriş
const BOSTA_SURESI = 2 * 60 * 1000; // bu kadar süre hiç veri gelmeyen yükleme kesilir
const MAX_KAYIT = 1000;            // "bilgisayarda göster" için hatırlanan son yükleme sayısı

const SYS_ROOT = process.env.SystemRoot || 'C:\\Windows';
const EXPLORER = path.join(SYS_ROOT, 'explorer.exe');
const POWERSHELL = path.join(SYS_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

const yuklemeKlasoru = () => process.env.REMOTE_UPLOAD_DIR || path.join(os.homedir(), 'Downloads', 'Uzaktan Bağlantı');
const gezinmeKoku = () => process.env.REMOTE_BROWSE_ROOT || os.homedir();

// Klasör seçicideki kısayollar. kayit: "User Shell Folders" değer adı (OneDrive'a taşınmış klasörler için).
const KISAYOLLAR = [
  { anahtar: 'masaustu', ad: 'Masaüstü', klasor: 'Desktop', kayit: 'Desktop' },
  { anahtar: 'belgeler', ad: 'Belgeler', klasor: 'Documents', kayit: 'Personal' },
  { anahtar: 'indirilenler', ad: 'İndirilenler', klasor: 'Downloads', kayit: '{374DE290-123F-4565-9164-39C4925E467B}' },
  { anahtar: 'resimler', ad: 'Resimler', klasor: 'Pictures', kayit: 'My Pictures' },
];

// Windows'ta dosya adı olarak kullanılamayan aygıt adları (uzantılı halleri de: "CON.txt").
const AYGIT_ADI = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$|clock\$)$/i;
const YASAK_KARAKTER = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;

// İstemcinin gönderdiği adı güvenli bir dosya/klasör adına çevirir (klasör kısmı atılır). Boş kalırsa yedek ad.
function adTemizle(ad, yedek = 'dosya') {
  let s = String(ad || '').normalize('NFC');
  s = s.split(/[\\/]/).pop();                       // yol verilmişse yalnızca son parça
  s = s.replace(YASAK_KARAKTER, '_');
  s = s.replace(/^[\s.]+|[\s.]+$/g, '');            // baştaki/sondaki nokta ve boşluklar
  if (s && AYGIT_ADI.test(s.split('.')[0].trim())) s = `_${s}`;
  if (s.length > 180) {                             // çok uzun adları uzantıyı koruyarak kısalt
    const uz = path.extname(s).slice(0, 20);
    s = s.slice(0, 180 - uz.length).replace(/[\s.]+$/, '') + uz;
  }
  return s || yedek;
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

const hata = (kod, msg) => Object.assign(new Error(msg), { kod });

// p, ust klasörün kendisi ya da altında mı (büyük/küçük harf duyarsız, Windows).
function altinda(p, ust) {
  const a = p.toLowerCase();
  const u = ust.toLowerCase();
  return a === u || a.startsWith(u.endsWith(path.sep) ? u : u + path.sep);
}

async function kokGercek() { return gercekYol(gezinmeKoku()); }

// Göreli yolu kökün içinde gerçek bir yola çevirir. Geçersizse { kod, msg } fırlatır.
// Katmanlar: (1) parçalar tek tek doğrulanır (.., sürücü harfi, ADS ':', UNC, aygıt adları, sondaki nokta/boşluk),
// (2) fs.realpath.native ile junction/symlink ve 8.3 kısa adlar çözülür ve sonuç yine kökün altında olmalı.
async function yolCoz(yol) {
  yol = String(yol ?? '');
  if (yol.length > 1000) throw hata(400, 'Yol çok uzun.');
  if (/^[\\/]/.test(yol) || path.win32.isAbsolute(yol) || path.posix.isAbsolute(yol)) throw hata(400, 'Mutlak yol kullanılamaz.');
  const parcalar = yol.split(/[\\/]+/).filter(Boolean);
  for (const p of parcalar) {
    if (/[\u0000-\u001f<>:"|?*]/.test(p)) throw hata(400, 'Geçersiz karakter.');
    if (/^[\s.]+$/.test(p) || /[\s.]$/.test(p)) throw hata(400, 'Geçersiz yol parçası.');
    if (AYGIT_ADI.test(p.split('.')[0].trim())) throw hata(400, 'Geçersiz ad.');
  }
  const kok = await kokGercek();
  const tam = path.resolve(kok, ...parcalar);
  if (!altinda(tam, kok)) throw hata(403, 'Bu klasöre erişilemez.');
  let gercek;
  try {
    gercek = await gercekYol(tam);
  } catch (e) {
    throw hata(e.code === 'ENOENT' || e.code === 'ENOTDIR' ? 404 : 403, 'Bulunamadı ya da erişilemiyor.');
  }
  if (!altinda(gercek, kok)) throw hata(403, 'Bu klasöre erişilemez.');
  return { kok, gercek, goreli: path.relative(kok, gercek).split(path.sep).join('/') };
}

// Göreli yol bir klasöre çözülmeli.
async function klasorCoz(yol) {
  const r = await yolCoz(yol);
  let st;
  try { st = await fsp.stat(r.gercek); } catch { throw hata(404, 'Klasör bulunamadı.'); }
  if (!st.isDirectory()) throw hata(400, 'Bu bir klasör değil.');
  return r;
}

// ---------- Kullanıcı dostu klasör adları ----------

// Profil kökünde Windows'un kayıtlı kabuk klasörleri (Masaüstü OneDrive'a taşınmış olabilir). Bir kez sorulur.
let kabukOnbellek = null;
function kabukKlasorleri() {
  if (process.env.REMOTE_BROWSE_ROOT || process.platform !== 'win32') return Promise.resolve({});
  if (kabukOnbellek) return kabukOnbellek;
  kabukOnbellek = new Promise((resolve) => {
    const anahtar = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders';
    const adlar = KISAYOLLAR.map((k) => `'${k.kayit}'`).join(',');
    const komut = `[Console]::OutputEncoding = [Text.Encoding]::UTF8; $p = Get-ItemProperty -LiteralPath '${anahtar}'; `
      + `$o = @{}; foreach ($a in @(${adlar})) { $v = $p.$a; if ($v) { $o[$a] = [Environment]::ExpandEnvironmentVariables($v) } }; `
      + '$o | ConvertTo-Json -Compress';
    execFile(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', komut], { windowsHide: true, timeout: 15000 }, (_err, out) => {
      try { resolve(JSON.parse(String(out || '').trim() || '{}') || {}); } catch { resolve({}); }
    });
  });
  return kabukOnbellek;
}

// Var olan ve kökün içinde kalan kısayollar: [{ anahtar, ad, yol (köke göreli), tam }]
async function kisayollar(kok) {
  const kayit = await kabukKlasorleri();
  const sonuc = await Promise.all(KISAYOLLAR.map(async (k) => {
    const adaylar = [kayit[k.kayit], path.join(gezinmeKoku(), k.klasor)].filter((x) => typeof x === 'string' && x);
    for (const aday of adaylar) {
      try {
        const g = await gercekYol(aday);
        if (!altinda(g, kok) || !(await fsp.stat(g)).isDirectory()) continue;
        return { anahtar: k.anahtar, ad: k.ad, yol: path.relative(kok, g).split(path.sep).join('/'), tam: g };
      } catch { /* yok */ }
    }
    return null;
  }));
  return sonuc.filter(Boolean);
}

// Gerçek bir klasör/dosya yolunu "İndirilenler › Uzaktan Bağlantı" gibi parçalara çevirir.
function yerParcalari(tam, kok, ks) {
  const kisa = ks.filter((k) => altinda(tam, k.tam)).sort((a, b) => b.tam.length - a.tam.length)[0];
  const kalan = (ust) => path.relative(ust, tam).split(path.sep).filter(Boolean);
  if (kisa) return [kisa.ad, ...kalan(kisa.tam)];
  if (altinda(tam, kok)) {
    const p = kalan(kok);
    // Profilin altındaki bilinen klasör adları (kayıt başka yeri gösterse bile) Türkçe yazılır.
    const bilinen = p.length && KISAYOLLAR.find((k) => k.klasor.toLowerCase() === p[0].toLowerCase());
    if (bilinen) return [bilinen.ad, ...p.slice(1)];
    return [path.basename(kok) || kok, ...p];
  }
  // Kökün dışında (ör. REMOTE_UPLOAD_DIR): son iki parça.
  return tam.split(/[\\/]+/).filter(Boolean).slice(-2);
}

async function yerBilgisi(tam) {
  const kok = await kokGercek();
  const ks = await kisayollar(kok);
  const parcalar = yerParcalari(tam, kok, ks);
  return { yer: parcalar.join(' › '), yerParcalar: parcalar, yol: altinda(tam, kok) ? path.relative(kok, tam).split(path.sep).join('/') : null };
}

// RFC 5987/6266: ASCII yedek ad + filename*=UTF-8''... (yedekte Türkçe harfler en yakın ASCII harfe çevrilir)
function contentDisposition(ad) {
  const ascii = ad.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ı/g, 'i')
    .replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const utf8 = encodeURIComponent(ad).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

// Tek aralıklı Range başlığı (RFC 9110): { bas, son } | null (yok/geçersiz/çoklu → tüm dosya) | 'karsilanamaz' (416).
function aralikCoz(baslik, boyut) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(baslik || '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let bas;
  let son = boyut - 1;
  if (m[1] === '') {                                // son n bayt
    const n = Number(m[2]);
    if (n === 0) return 'karsilanamaz';
    bas = Math.max(0, boyut - n);
  } else {
    bas = Number(m[1]);
    if (m[2] !== '') {
      if (Number(m[2]) < bas) return null;
      son = Math.min(Number(m[2]), boyut - 1);
    }
  }
  if (bas >= boyut) return 'karsilanamaz';
  return { bas, son };
}

// ---------- Zip ----------
const MAX_ZIP_GIRDI = Number(process.env.REMOTE_ZIP_MAX_GIRDI) || 200000; // dosya + klasör
const MAX_ZIP_BOYUT = 64 * 1024 ** 3;                                     // sıkıştırmadan önce toplam
const ZIP64_ESIK = Number(process.env.REMOTE_ZIP64_ESIK) || 0xFFFFFFFF;   // testler küçültüp ZIP64 kayıtlarını zorlar
const MAX_SECIM = 10000;             // tek istekte seçilebilecek öğe
const SECIM_SURESI = 15 * 60 * 1000; // hazırlanan seçimin geçerlilik süresi
const ATLANAN_ADI = '_atlananlar.txt';

// Seçilen yolları (köke göreli) zip girdilerine çevirir; dosyalar yalnızca zip yazıcı istediğinde açılır.
// Güvenlik gezinmeyle aynı: her seçim yolCoz'dan geçer; alt klasörlerde junction/symlink İZLENMEZ (kök dışına
// çıkabilir), gerçek yolu beklenenden farklı çıkan klasör (bağlama noktası vb.) de atlanır. Erişilemeyenler ve
// sınırı aşan kısım `atlananlar`a yazılır. sayac: { dosya, klasor, boyut, sinir }
async function* zipGirdileri(cozulenler, kok, atlananlar, sayac) {
  const sinirde = (ek) => {
    if (sayac.sinir) return true;
    if (sayac.dosya + sayac.klasor + 1 > MAX_ZIP_GIRDI || sayac.boyut + ek > MAX_ZIP_BOYUT) {
      sayac.sinir = true;
      atlananlar.push({ ad: '…', neden: `sınır aşıldı (en fazla ${MAX_ZIP_GIRDI} öğe / ${MAX_ZIP_BOYUT / 1024 ** 3} GB); kalanlar eklenmedi` });
      return true;
    }
    return false;
  };
  function dosyaGirdisi(tam, ad, st) {
    if (sinirde(st.size)) return null;
    sayac.dosya++;
    sayac.boyut += st.size;
    return {
      ad, mtime: st.mtime, boyut: st.size, sikistir: zip.sikistirilsinMi(ad),
      ac: async () => {
        let fh;
        try { fh = await fsp.open(tam, 'r'); } catch (e) {
          sayac.dosya--;
          sayac.boyut -= st.size;
          throw Object.assign(e, { neden: e.code === 'EBUSY' ? 'kullanımda (başka bir program kilitlemiş)' : 'açılamadı (erişim yok ya da kullanımda)' });
        }
        const boyut = (await fh.stat()).size;
        // En fazla açılıştaki boyut kadar okunur (okurken büyüyen dosya ZIP64 kararını bozmasın).
        if (!boyut) { await fh.close(); return { akis: Readable.from([]), boyut: 0 }; }
        return { akis: fh.createReadStream({ start: 0, end: boyut - 1, highWaterMark: 256 * 1024 }), boyut };
      },
    };
  }
  async function* klasorGez(tam, ad, mtime) {
    if (sinirde(0)) return;
    sayac.klasor++;
    yield { ad: `${ad}/`, klasor: true, mtime };
    let dirents;
    try { dirents = await fsp.readdir(tam, { withFileTypes: true }); } catch {
      atlananlar.push({ ad: `${ad}/`, neden: 'klasör açılamadı' });
      return;
    }
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const d of dirents) {
      if (sayac.sinir) return;
      const altTam = path.join(tam, d.name);
      const altAd = `${ad}/${d.name}`;
      if (d.name.endsWith(GECICI_UZ)) continue;
      if (d.isSymbolicLink()) { atlananlar.push({ ad: altAd, neden: 'kısayol/junction (izlenmedi)' }); continue; }
      let st;
      try { st = await fsp.stat(altTam); } catch { atlananlar.push({ ad: altAd, neden: 'okunamadı' }); continue; }
      if (d.isDirectory() && st.isDirectory()) {
        let g;
        try { g = await gercekYol(altTam); } catch { atlananlar.push({ ad: altAd, neden: 'klasör açılamadı' }); continue; }
        if (g.toLowerCase() !== altTam.toLowerCase() || !altinda(g, kok)) { atlananlar.push({ ad: altAd, neden: 'bağlantı (izlenmedi)' }); continue; }
        yield* klasorGez(altTam, altAd, st.mtime);
      } else if (d.isFile() && st.isFile()) {
        const g = dosyaGirdisi(altTam, altAd, st);
        if (g) yield g;
      }
    }
  }
  const kullanilan = new Set([ATLANAN_ADI.toLowerCase()]);
  for (const r of cozulenler) {
    if (sayac.sinir) break;
    // Üst düzey ad: seçilen öğenin adı; aynı ad iki kez seçilirse "ad (1)".
    let ad = r.gercek === kok ? path.basename(kok) || 'kok' : path.basename(r.gercek);
    const uz = r.st.isDirectory() ? '' : path.extname(ad);
    const govde = ad.slice(0, ad.length - uz.length);
    for (let i = 1; kullanilan.has(ad.toLowerCase()); i++) ad = `${govde} (${i})${uz}`;
    kullanilan.add(ad.toLowerCase());
    if (r.st.isDirectory()) yield* klasorGez(r.gercek, ad, r.st.mtime);
    else if (r.st.isFile()) { const g = dosyaGirdisi(r.gercek, ad, r.st); if (g) yield g; }
  }
}

const atlananMetni = (liste) => `﻿Bu öğeler zip'e eklenmedi:\r\n\r\n${liste.map((a) => `${a.ad} — ${a.neden}`).join('\r\n')}\r\n`;

// Zip dosyasının adı: tek öğede onun adı, çoklu seçimde ortak üst klasörün adı.
function zipAdi(cozulenler, kok) {
  const ad = (p) => (p === kok ? path.basename(kok) || 'Dosyalar' : path.basename(p));
  if (cozulenler.length === 1) {
    const r = cozulenler[0];
    return `${r.st.isDirectory() ? ad(r.gercek) : path.basename(r.gercek, path.extname(r.gercek))}.zip`;
  }
  const ustler = new Set(cozulenler.map((r) => path.dirname(r.gercek).toLowerCase()));
  const ust = ustler.size === 1 ? ad(path.dirname(cozulenler[0].gercek)) : 'Dosyalar';
  return `${ust} (${cozulenler.length} öğe).zip`;
}

// Yolları doğrular (her biri yolCoz) ve tekrarları atar. Geçersiz yol varsa { kod, msg } fırlatır.
async function secimCoz(yollar) {
  if (!Array.isArray(yollar) || !yollar.length) throw hata(400, 'Hiçbir şey seçilmedi.');
  if (yollar.length > MAX_SECIM) throw hata(413, `En fazla ${MAX_SECIM} öğe seçilebilir.`);
  const gorulen = new Set();
  const sonuc = [];
  for (const y of yollar) {
    if (typeof y !== 'string') throw hata(400, 'Geçersiz yol.');
    const r = await yolCoz(y);
    if (gorulen.has(r.gercek.toLowerCase())) continue;
    gorulen.add(r.gercek.toLowerCase());
    let st;
    try { st = await fsp.stat(r.gercek); } catch { throw hata(404, 'Bulunamadı ya da erişilemiyor.'); }
    if (!st.isDirectory() && !st.isFile()) throw hata(400, 'Bu öğe indirilemez.');
    sonuc.push({ ...r, st });
  }
  return sonuc;
}

// explorer.exe komut satırı: /select,"<tam yol>". Yol doğrulanmış, mutlak, yerel bir dosya yolu olmalı; tırnak ve
// denetim karakteri içeremez (Windows yollarında zaten yasak) — böylece argümandan dışarı taşılamaz.
function gosterArgumani(tam) {
  if (typeof tam !== 'string' || !/^[A-Za-z]:\\/.test(tam) || /["\u0000-\u001f]/.test(tam)) return null;
  return `/select,"${tam}"`;
}

module.exports.init = (api) => {
  eskiGecicileriSil(yuklemeKlasoru());

  const json = (res, code, obj, ek = {}) => {
    if (res.headersSent || res.destroyed) return;
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...ek }).end(JSON.stringify(obj));
  };
  // Gövdesi okunmadan reddedilen yükleme: cevap gidince bağlantıyı kapat (gövdenin tamamını okumayı bekleme).
  // 'Connection: close' istemcinin aynı bağlantıyı bir sonraki istek için kullanmasını önler.
  const reddet = (req, res, code, obj) => { res.on('finish', () => req.destroy()); json(res, code, obj, { Connection: 'close' }); };

  // id -> { tam, ad } : "bilgisayarda göster" yalnızca sunucunun kendi kaydettiği dosyaları açar.
  const kayitlar = new Map();
  function kayitEkle(tam, ad) {
    const id = crypto.randomBytes(12).toString('hex');
    kayitlar.set(id, { tam, ad });
    while (kayitlar.size > MAX_KAYIT) kayitlar.delete(kayitlar.keys().next().value);
    return id;
  }

  // ---------- Yükleme ----------

  api.route('POST', '/api/dosya/yukle', async (req, res, ws, url) => {
    // Çekirdeğin istek başına 5 dakikalık süresi (server.js REQUEST_TIMEOUT_MS) büyük yüklemeleri keserdi. Yalnızca
    // bu (oturumu ve yetkisi doğrulanmış) istek için kapatılır; yerine "hiç veri gelmeme" süresi uygulanır
    // (aşağıda req.setTimeout). Sunucu genelindeki ayarlara dokunulmaz.
    req.uzunIstek = true;

    const uzunluk = req.headers['content-length'] !== undefined ? Number(req.headers['content-length']) : null;
    if (uzunluk !== null && !(uzunluk >= 0 && uzunluk <= MAX_YUKLEME)) {
      return reddet(req, res, 413, { ok: false, msg: 'Dosya çok büyük (en fazla 8 GB).' });
    }
    // Hedef klasör: verilmezse varsayılan (oluşturulur); verilirse kökün içinde var olan bir klasör.
    let klasor;
    try {
      if (url.searchParams.has('klasor')) klasor = (await klasorCoz(url.searchParams.get('klasor'))).gercek;
      else {
        await fsp.mkdir(yuklemeKlasoru(), { recursive: true });
        klasor = await gercekYol(yuklemeKlasoru());
      }
    } catch (e) {
      return reddet(req, res, e.kod || 500, { ok: false, msg: e.kod ? e.message : 'Kayıt klasörü hazırlanamadı.' });
    }
    const istenenAd = adTemizle(url.searchParams.get('ad'));
    let gecici, fh;
    try {
      ({ tam: gecici, fh } = await geciciAc(klasor));
    } catch {
      return reddet(req, res, 403, { ok: false, msg: 'Bu klasöre yazılamıyor.' });
    }

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
    let ad, tam;
    try {
      ({ ad, tam } = await benzersizTasi(gecici, klasor, istenenAd));
    } catch (e) {
      await fsp.rm(gecici, { force: true }).catch(() => {});
      api.log(`Yüklenen dosya kaydedilemedi: ${istenenAd} (${e.message})`);
      return json(res, 500, { ok: false, msg: 'Dosya kaydedilemedi.' });
    }
    const yerK = await yerBilgisi(klasor).catch(() => ({ yer: klasor, yerParcalar: [klasor], yol: null }));
    const id = kayitEkle(tam, ad);
    api.store.log('dosya', { user: ws.session.username, ip: ws.ip, islem: 'yukle', ad, boyut, klasor: yerK.yer });
    api.log(`Yüklendi: ${ad} (${boyut} bayt) → ${klasor} — ${ws.session.username}`);
    olaylar.emit('dosya-geldi', { ad, yer: yerK.yerParcalar.join('\\'), klasor, boyut, kullanici: ws.session.username, via: ws.via });
    json(res, 200, {
      ok: true, ad, boyut, klasor, tam, id,
      yer: yerK.yer, yerParcalar: yerK.yerParcalar,
      yol: yerK.yol === null ? null : (yerK.yol ? `${yerK.yol}/${ad}` : ad),
    });
  }, { role: 'control' });

  // ---------- Hedef klasör bilgisi ----------

  api.route('GET', '/api/dosya/hedef', async (req, res) => {
    const kok = await kokGercek();
    const ks = await kisayollar(kok);
    const vTam = yuklemeKlasoru();
    let vGercek = vTam;
    try { vGercek = await gercekYol(vTam); } catch { /* henüz yok: ilk yüklemede oluşturulur */ }
    const vYer = yerParcalari(vGercek, kok, ks);
    // Varsayılan klasör henüz yoksa da adı doğru görünsün (ör. profilde Downloads\Uzaktan Bağlantı).
    let vYol = null;
    try { vYol = (await klasorCoz(path.relative(kok, vGercek))).goreli; } catch { /* yok ya da kök dışı */ }
    json(res, 200, {
      ok: true,
      varsayilan: { tam: vGercek, yer: vYer.join(' › '), yol: vYol },
      kisayollar: ks,
      kok: { ad: path.basename(kok) || kok, tam: kok },
    });
  }, { role: 'control' });

  // ---------- Yeni klasör ----------

  api.route('POST', '/api/dosya/klasor', async (req, res, ws, url) => {
    const ad = adTemizle(url.searchParams.get('ad'), '');
    if (!ad) return json(res, 400, { ok: false, msg: 'Klasör adı geçersiz.' });
    let ust;
    try { ust = await klasorCoz(url.searchParams.get('yol')); } catch (e) { return json(res, e.kod || 400, { ok: false, msg: e.message }); }
    const tam = path.join(ust.gercek, ad);
    let mevcut = false;
    try {
      await fsp.mkdir(tam);
    } catch (e) {
      if (e.code !== 'EEXIST') return json(res, 403, { ok: false, msg: 'Klasör oluşturulamadı.' });
      mevcut = true;
    }
    let r;
    try { r = await klasorCoz(path.relative(ust.kok, tam)); } catch (e) {
      return json(res, e.kod === 400 ? 409 : e.kod || 409, { ok: false, msg: e.kod === 400 ? 'Bu adda bir dosya var.' : e.message });
    }
    if (!mevcut) api.store.log('dosya', { user: ws.session.username, ip: ws.ip, islem: 'klasor', ad: r.goreli });
    const yb = await yerBilgisi(r.gercek);
    json(res, 200, { ok: true, ad, yol: r.goreli, tam: r.gercek, yer: yb.yer, mevcut });
  }, { role: 'control' });

  // ---------- Bilgisayarda göster ----------

  let sonGoster = 0;
  api.route('POST', '/api/dosya/goster', async (req, res, ws, url) => {
    const id = String(url.searchParams.get('id') || '');
    let tam;
    let kayitli = false;
    if (id && kayitlar.has(id)) { tam = kayitlar.get(id).tam; kayitli = true; }
    else if (url.searchParams.has('yol')) {
      try { tam = (await yolCoz(url.searchParams.get('yol'))).gercek; } catch (e) { return json(res, e.kod || 400, { ok: false, msg: e.message }); }
    } else return json(res, 404, { ok: false, msg: 'Bu dosya artık bilinmiyor (sunucu yeniden başlamış olabilir).' });

    // Kayıttan beri yol değişmiş olmamalı (klasör yerine junction konmuş vb.): gerçek yol birebir aynı kalmalı.
    let gercek, st;
    try { gercek = await gercekYol(tam); st = await fsp.stat(gercek); } catch {
      return json(res, 404, { ok: false, msg: 'Dosya artık yerinde değil (taşınmış ya da silinmiş olabilir).' });
    }
    if (kayitli && gercek.toLowerCase() !== tam.toLowerCase()) return json(res, 403, { ok: false, msg: 'Dosyanın yolu değişmiş.' });
    if (!st.isFile()) return json(res, 400, { ok: false, msg: 'Bu bir dosya değil.' });
    const arg = gosterArgumani(gercek);
    if (!arg) return json(res, 400, { ok: false, msg: 'Bu dosya gösterilemiyor.' });
    // Peş peşe basmalar bilgisayarda bir sürü pencere açmasın.
    if (Date.now() - sonGoster < 1500) return json(res, 429, { ok: false, msg: 'Biraz bekleyip tekrar deneyin.' });
    sonGoster = Date.now();

    const kuru = process.env.REMOTE_DOSYA_KURU === '1';
    const komut = `explorer.exe ${arg}`;
    if (!kuru) {
      // windowsVerbatimArguments: Node argümanı kendi tırnaklamasın; explorer /select,"..." biçimini bekler.
      // Gezgin işi var olan explorer sürecine verip hemen (çoğunlukla 1 koduyla) çıkar; çıkış kodu önemsenmez.
      try {
        const p = execFile(EXPLORER, [arg], { windowsVerbatimArguments: true, timeout: 15000 }, () => {});
        p.on('error', (e) => api.log(`Gezgin açılamadı: ${e.message}`));
      } catch (e) {
        return json(res, 500, { ok: false, msg: 'Dosya Gezgini açılamadı.' });
      }
    }
    api.store.log('dosya', { user: ws.session.username, ip: ws.ip, islem: 'goster', ad: path.basename(gercek) });
    json(res, 200, { ok: true, kuru, komut, tam: gercek });
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
    // Yarım kalmış yükleme dosyaları da gösterilmez.
    const adaylar = dirents.filter((d) => !d.isSymbolicLink() && (d.isDirectory() || d.isFile()) && !d.name.endsWith(GECICI_UZ)).slice(0, MAX_GIRDI);
    const girdiler = (await Promise.all(adaylar.map(async (d) => {
      try {
        const st = await fsp.stat(path.join(r.gercek, d.name));
        return { ad: d.name, tur: st.isDirectory() ? 'klasor' : 'dosya', boyut: st.isDirectory() ? null : st.size, degisme: st.mtimeMs };
      } catch { return null; } // erişilemeyen girişleri atla
    }))).filter(Boolean);
    const sirala = new Intl.Collator('tr', { sensitivity: 'base', numeric: true });
    girdiler.sort((a, b) => (a.tur === b.tur ? sirala.compare(a.ad, b.ad) : a.tur === 'klasor' ? -1 : 1));
    const yb = await yerBilgisi(r.gercek).catch(() => ({ yer: '' }));
    json(res, 200, { ok: true, yol: r.goreli, kok: path.basename(r.kok) || r.kok, yer: yb.yer, tam: r.gercek, girdiler, kesildi });
  }, { role: 'control' });

  // ---------- İndirme ----------
  // Her dosya türü indirilir: Content-Disposition: attachment + application/octet-stream + nosniff → tarayıcı (iOS
  // Safari dahil) dosyayı sayfada açmaz, indirme yöneticisine verir. Tek aralıklı Range (206) desteklenir: iOS büyük
  // indirmede ya da kesilen indirmeyi sürdürürken aralık isteyebilir. If-Range uyuşmazsa tüm dosya gönderilir.

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
    const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const degisme = st.mtime.toUTCString();
    let aralik = req.headers.range ? aralikCoz(req.headers.range, st.size) : null;
    const ifRange = req.headers['if-range'];
    if (aralik && ifRange && ifRange !== etag && ifRange !== degisme) aralik = null;
    const ortak = {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': contentDisposition(ad),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      'Accept-Ranges': 'bytes',
      ETag: etag,
      'Last-Modified': degisme,
    };
    if (aralik === 'karsilanamaz') {
      await fh.close();
      return res.writeHead(416, { ...ortak, 'Content-Range': `bytes */${st.size}`, 'Content-Length': 0 }).end();
    }
    const bas = aralik ? aralik.bas : 0;
    const son = aralik ? aralik.son : st.size - 1;
    res.writeHead(aralik ? 206 : 200, {
      ...ortak,
      'Content-Length': son - bas + 1,
      ...(aralik ? { 'Content-Range': `bytes ${bas}-${son}/${st.size}` } : {}),
    });
    // Sürdürülen indirmenin her parçası ayrı kayıt olmasın: yalnızca baştan başlayan istek günlüğe yazılır.
    if (bas === 0) api.store.log('dosya', { user: ws.session.username, ip: ws.ip, islem: 'indir', ad: r.goreli, boyut: st.size });
    if (st.size === 0) { await fh.close(); return res.end(); }
    try {
      await pipeline(fh.createReadStream({ start: bas, end: son }), res);
    } catch (e) {
      api.log(`İndirme yarıda kaldı: ${r.goreli} (${e.message})`);
    }
  }, { role: 'control' });

  // ---------- Zip olarak indirme ----------
  //   POST /api/dosya/secim   gövde: { yollar: [köke göreli yol, ...] }  (JSON, en fazla 1 MB)
  //        -> { id, ad, dosya, klasor, boyut, atlanan }   seçim sayılır (dosyalar açılmaz), tahmini boyut döner;
  //        id 15 dakika geçerli ve yalnızca aynı oturumdan kullanılabilir. Sınır aşılırsa 413.
  //   GET  /api/dosya/zip?secim=<id>   ya da   ?yol=<köke göreli>[&yol=...]   -> zip (akışla, Content-Length yok)
  // Çok yol GET adresine sığmayabilir; bu yüzden çoklu seçim önce POST ile bırakılır, indirme bağlantısı kısa kalır
  // (iOS'ta indirmeyi kullanıcının doğrudan dokunduğu gerçek bir <a download> başlatır).
  const secimler = new Map(); // id -> { ws, yollar, zaman }
  const secimTemizle = () => {
    const simdi = Date.now();
    for (const [id, s] of secimler) if (simdi - s.zaman > SECIM_SURESI) secimler.delete(id);
    while (secimler.size > 200) secimler.delete(secimler.keys().next().value);
  };

  api.route('POST', '/api/dosya/secim', async (req, res, ws) => {
    const SINIR = 1024 * 1024;
    if (Number(req.headers['content-length']) > SINIR) return reddet(req, res, 413, { ok: false, msg: 'Seçim çok büyük.' });
    const parcalar = [];
    let n = 0;
    try {
      for await (const p of req) {
        n += p.length;
        if (n > SINIR) { req.destroy(); return; }
        parcalar.push(p);
      }
    } catch { return; }
    let yollar;
    try { yollar = JSON.parse(Buffer.concat(parcalar).toString('utf8')).yollar; } catch { return json(res, 400, { ok: false, msg: 'Geçersiz istek.' }); }
    let cozulenler;
    try { cozulenler = await secimCoz(yollar); } catch (e) { return json(res, e.kod || 400, { ok: false, msg: e.message }); }
    const kok = await kokGercek();
    const atlananlar = [];
    const sayac = { dosya: 0, klasor: 0, boyut: 0, sinir: false };
    for await (const _g of zipGirdileri(cozulenler, kok, atlananlar, sayac)) { /* yalnızca say */ }
    const ozet = { ad: zipAdi(cozulenler, kok), dosya: sayac.dosya, klasor: sayac.klasor, boyut: sayac.boyut, atlanan: atlananlar.length };
    if (sayac.sinir) return json(res, 413, { ok: false, ...ozet, msg: `Çok büyük: en fazla ${MAX_ZIP_GIRDI} öğe ve ${MAX_ZIP_BOYUT / 1024 ** 3} GB zip'lenebilir.` });
    secimTemizle();
    const id = crypto.randomBytes(16).toString('hex');
    secimler.set(id, { ws, yollar: cozulenler.map((r) => r.goreli), zaman: Date.now() });
    json(res, 200, { ok: true, id, ...ozet });
  }, { role: 'control' });

  api.route('GET', '/api/dosya/zip', async (req, res, ws, url) => {
    let yollar;
    if (url.searchParams.has('secim')) {
      secimTemizle();
      const s = secimler.get(String(url.searchParams.get('secim')));
      if (!s || s.ws !== ws) return json(res, 404, { ok: false, msg: 'Seçim bulunamadı ya da süresi doldu; yeniden seçin.' });
      yollar = s.yollar;
    } else yollar = url.searchParams.getAll('yol');
    let cozulenler;
    try { cozulenler = await secimCoz(yollar); } catch (e) { return json(res, e.kod || 400, { ok: false, msg: e.message }); }
    const kok = await kokGercek();
    const ad = zipAdi(cozulenler, kok);
    const atlananlar = [];
    const sayac = { dosya: 0, klasor: 0, boyut: 0, sinir: false };
    async function* girdiler() {
      yield* zipGirdileri(cozulenler, kok, atlananlar, sayac);
      // Açılamayan dosyalar (zip yazıcı açarken atlar) ve izlenmeyen bağlantılar zip'in sonunda listelenir.
      if (atlananlar.length) yield { ad: ATLANAN_ADI, mtime: new Date(), sikistir: true, veri: Buffer.from(atlananMetni(atlananlar), 'utf8') };
    }
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': contentDisposition(ad),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    });
    let tamam = false;
    try {
      // İstemci indirmeyi iptal ederse res kapanır → pipeline üreteci kapatır → açık dosya akışı yok edilir.
      await pipeline(Readable.from(zip.zipAkisi(girdiler(), { esik: ZIP64_ESIK, atlananlar })), res);
      tamam = true;
    } catch (e) {
      api.log(`Zip yarıda kaldı: ${ad} (${e.message})`);
      res.destroy();
    }
    api.store.log('dosya', {
      user: ws.session.username, ip: ws.ip, islem: 'zip', ad, yollar: yollar.slice(0, 20),
      dosya: sayac.dosya, klasor: sayac.klasor, boyut: sayac.boyut, atlanan: atlananlar.length, tamam,
    });
  }, { role: 'control' });
};

module.exports._test = { adTemizle, contentDisposition, gosterArgumani, yerParcalari, kabukKlasorleri, KISAYOLLAR, aralikCoz };
