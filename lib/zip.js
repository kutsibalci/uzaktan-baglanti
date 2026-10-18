// Akışla zip yazıcı (harici paket yok; Node'un zlib'i). Hiçbir dosya belleğe tamponlanmaz: her girdi okunurken
// sıkıştırılıp hemen gönderilir, CRC-32 ve boyutlar akış sırasında hesaplanıp girdinin ardından "data descriptor"
// olarak yazılır (bayrak bit 3). Bellekte yalnızca merkez dizin kayıtları tutulur (girdi başına ~50 bayt + ad).
// - Adlar UTF-8 (bayrak bit 11): Türkçe adlar iPhone Dosyalar / Windows Gezgini'nde düzgün görünür.
// - ZIP64: 4 GB'tan büyük girdi, 4 GB'ı aşan konum ve 65535'ten fazla girdi. `esik` (varsayılan 0xFFFFFFFF) testlerde
//   küçültülerek ZIP64 kayıtları küçük dosyalarla zorlanabilir.
// - Klasör girdileri "ad/" biçiminde (boş klasörler de korunur).
//
//   for await (const parca of zipAkisi(girdiler, { esik, atlananlar })) res.write(parca)
//   girdiler: (async) yinelenebilir; her öğe şunlardan biri:
//     { ad: 'a/b/', klasor: true, mtime }
//     { ad: 'a/x.txt', mtime, sikistir, veri: Buffer }                          — küçük, bellekteki içerik
//     { ad: 'a/x.txt', mtime, sikistir, boyut, ac: async () => ({ akis, boyut }) } — akış; `ac` hata verirse girdi
//       zip'e hiç yazılmaz, { ad, neden } atlananlar dizisine eklenir. `akis` en fazla `boyut` bayt vermelidir
//       (ZIP64 kararı yerel başlıkta bu boyuta göre verilir).
//   Okuma yarıda hata verirse (girdi başlığı yazılmışken) üreteç hata fırlatır: zip bilerek bozuk bırakılır
//   (eksik içeriği tam gibi göstermemek için). Üreteç erken kapatılırsa (istemci iptali) açık akış yok edilir.
const zlib = require('zlib');
const { pipeline, Transform, PassThrough } = require('stream');

const U32 = 0xFFFFFFFF;
const U16 = 0xFFFF;
const BAYRAK_UTF8 = 0x0800;
const BAYRAK_TANIM = 0x0008; // CRC ve boyutlar girdiden sonra (data descriptor)
const YAPAN = 45;            // "version made by": 4.5 (ZIP64), MS-DOS/Windows özniteliği
// ZIP64 olmayan girdide sıkıştırılmış boyut 4 GB'ı aşmasın: deflate en kötü durumda veriyi çok az büyütür, pay bırakılır.
const YEREL64_SINIR = 0xF0000000;

// Zaten sıkıştırılmış biçimler: deflate bir şey kazandırmaz, yalnızca işlemci harcar → "store".
const SIKISTIRILMIS = new Set(('jpg jpeg png gif webp heic heif avif mp4 m4v mov avi mkv webm wmv flv 3gp '
  + 'mp3 m4a aac ogg oga opus flac wma zip 7z rar gz tgz bz2 xz zst lz4 cab jar apk ipa aab docx xlsx pptx odt ods odp '
  + 'epub pdf woff woff2 msi').split(' '));
const sikistirilsinMi = (ad) => {
  const i = ad.lastIndexOf('.');
  return !(i > 0 && SIKISTIRILMIS.has(ad.slice(i + 1).toLowerCase()));
};

// DOS tarih/saati (yerel saat, 2 sn çözünürlük; 1980 öncesi 1980-01-01).
function dosZamani(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime()) || d.getFullYear() < 1980) return { saat: 0, tarih: (1 << 5) | 1 };
  const y = Math.min(d.getFullYear(), 2107);
  return {
    saat: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    tarih: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function yerelBaslik({ ad, bayrak, yontem, z, crc = 0, boyut = 0, sikisik = 0, z64 }) {
  const ek = z64 ? Buffer.alloc(20) : Buffer.alloc(0);
  if (z64) { ek.writeUInt16LE(0x0001, 0); ek.writeUInt16LE(16, 2); } // boyutlar data descriptor'da (burada 0)
  const b = Buffer.alloc(30);
  b.writeUInt32LE(0x04034b50, 0);
  b.writeUInt16LE(z64 ? 45 : 20, 4);
  b.writeUInt16LE(bayrak, 6);
  b.writeUInt16LE(yontem, 8);
  b.writeUInt16LE(z.saat, 10);
  b.writeUInt16LE(z.tarih, 12);
  b.writeUInt32LE(crc, 14);
  b.writeUInt32LE(z64 ? U32 : sikisik, 18);
  b.writeUInt32LE(z64 ? U32 : boyut, 22);
  b.writeUInt16LE(ad.length, 26);
  b.writeUInt16LE(ek.length, 28);
  return Buffer.concat([b, ad, ek]);
}

function merkezKayit({ ad, bayrak, yontem, z, crc, boyut, sikisik, konum, klasor, esik, zorla64 }) {
  const u64 = zorla64 || boyut >= esik;
  const c64 = zorla64 || sikisik >= esik;
  const o64 = konum >= esik;
  const alanlar = [u64 && boyut, c64 && sikisik, o64 && konum].filter((x) => x !== false);
  const ek = Buffer.alloc(alanlar.length ? 4 + alanlar.length * 8 : 0);
  if (alanlar.length) {
    ek.writeUInt16LE(0x0001, 0);
    ek.writeUInt16LE(alanlar.length * 8, 2);
    alanlar.forEach((v, i) => ek.writeBigUInt64LE(BigInt(v), 4 + i * 8));
  }
  const b = Buffer.alloc(46);
  b.writeUInt32LE(0x02014b50, 0);
  b.writeUInt16LE(YAPAN, 4);
  b.writeUInt16LE(alanlar.length ? 45 : 20, 6);
  b.writeUInt16LE(bayrak, 8);
  b.writeUInt16LE(yontem, 10);
  b.writeUInt16LE(z.saat, 12);
  b.writeUInt16LE(z.tarih, 14);
  b.writeUInt32LE(crc >>> 0, 16);
  b.writeUInt32LE(c64 ? U32 : sikisik, 20);
  b.writeUInt32LE(u64 ? U32 : boyut, 24);
  b.writeUInt16LE(ad.length, 28);
  b.writeUInt16LE(ek.length, 30);
  b.writeUInt16LE(0, 32);                 // yorum
  b.writeUInt16LE(0, 34);                 // disk
  b.writeUInt16LE(0, 36);                 // iç öznitelik
  b.writeUInt32LE(klasor ? 0x10 : 0x20, 38); // dış öznitelik: DOS dizin / arşiv
  b.writeUInt32LE(o64 ? U32 : konum, 42);
  return Buffer.concat([b, ad, ek]);
}

function sonKayitlar({ adet, cdBoyut, cdKonum, esik }) {
  const z64 = adet >= Math.min(esik, U16) || cdBoyut >= esik || cdKonum >= esik;
  const parcalar = [];
  if (z64) {
    const r = Buffer.alloc(56);
    r.writeUInt32LE(0x06064b50, 0);
    r.writeBigUInt64LE(44n, 4);
    r.writeUInt16LE(YAPAN, 12);
    r.writeUInt16LE(45, 14);
    r.writeUInt32LE(0, 16);
    r.writeUInt32LE(0, 20);
    r.writeBigUInt64LE(BigInt(adet), 24);
    r.writeBigUInt64LE(BigInt(adet), 32);
    r.writeBigUInt64LE(BigInt(cdBoyut), 40);
    r.writeBigUInt64LE(BigInt(cdKonum), 48);
    const l = Buffer.alloc(20);
    l.writeUInt32LE(0x07064b50, 0);
    l.writeUInt32LE(0, 4);
    l.writeBigUInt64LE(BigInt(cdKonum + cdBoyut), 8);
    l.writeUInt32LE(1, 16);
    parcalar.push(r, l);
  }
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0);
  e.writeUInt16LE(z64 ? U16 : adet, 8);
  e.writeUInt16LE(z64 ? U16 : adet, 10);
  e.writeUInt32LE(z64 ? U32 : cdBoyut, 12);
  e.writeUInt32LE(z64 ? U32 : cdKonum, 16);
  parcalar.push(e);
  return Buffer.concat(parcalar);
}

async function* zipAkisi(girdiler, { esik = U32, atlananlar = [] } = {}) {
  esik = Math.min(esik, U32);
  const merkez = [];
  let konum = 0;
  const cik = (b) => { konum += b.length; return b; };

  for await (const g of girdiler) {
    const ad = Buffer.from(g.ad, 'utf8');
    if (ad.length > U16) { atlananlar.push({ ad: g.ad, neden: 'ad çok uzun' }); continue; }
    const z = dosZamani(g.mtime);
    const bas = konum;
    if (g.klasor) {
      yield cik(yerelBaslik({ ad, bayrak: BAYRAK_UTF8, yontem: 0, z }));
      merkez.push(merkezKayit({ ad, bayrak: BAYRAK_UTF8, yontem: 0, z, crc: 0, boyut: 0, sikisik: 0, konum: bas, klasor: true, esik }));
      continue;
    }
    let akis = null;
    let beklenen = g.veri ? g.veri.length : g.boyut || 0;
    if (!g.veri) {
      try { ({ akis, boyut: beklenen } = await g.ac()); } catch (e) {
        atlananlar.push({ ad: g.ad, neden: e.neden || e.code || e.message });
        continue;
      }
    }
    const yontem = g.sikistir ? 8 : 0;
    const bayrak = BAYRAK_UTF8 | BAYRAK_TANIM;
    const z64 = beklenen >= Math.min(esik, YEREL64_SINIR);
    yield cik(yerelBaslik({ ad, bayrak, yontem, z, z64 }));

    let crc = 0;
    let boyut = 0;
    let sikisik = 0;
    if (g.veri) {
      crc = zlib.crc32(g.veri);
      boyut = g.veri.length;
      const v = g.sikistir ? zlib.deflateRawSync(g.veri) : g.veri;
      sikisik = v.length;
      yield cik(v);
    } else {
      const say = new Transform({
        transform(c, _enc, cb) { crc = zlib.crc32(c, crc); boyut += c.length; cb(null, c); },
      });
      // pipeline: kaynak hata verirse ya da çıkış erken kapatılırsa hepsi yok edilir (dosya tanıtıcısı kapanır).
      const cikis = pipeline(akis, say, g.sikistir ? zlib.createDeflateRaw({ level: 6 }) : new PassThrough(), () => {});
      for await (const c of cikis) { sikisik += c.length; yield cik(c); }
    }

    const d = Buffer.alloc(z64 ? 24 : 16);
    d.writeUInt32LE(0x08074b50, 0);
    d.writeUInt32LE(crc >>> 0, 4);
    if (z64) { d.writeBigUInt64LE(BigInt(sikisik), 8); d.writeBigUInt64LE(BigInt(boyut), 16); }
    else { d.writeUInt32LE(sikisik, 8); d.writeUInt32LE(boyut, 12); }
    yield cik(d);
    merkez.push(merkezKayit({ ad, bayrak, yontem, z, crc, boyut, sikisik, konum: bas, klasor: false, esik, zorla64: z64 }));
  }

  const cdKonum = konum;
  for (let i = 0; i < merkez.length; i += 512) yield cik(Buffer.concat(merkez.slice(i, i + 512)));
  yield sonKayitlar({ adet: merkez.length, cdBoyut: konum - cdKonum, cdKonum, esik });
}

module.exports = { zipAkisi, sikistirilsinMi, dosZamani };
