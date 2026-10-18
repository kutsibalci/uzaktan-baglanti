// Testler için küçük zip okuyucu (paket değil; ozellik-zip*.js kullanır). Üretilen zip'i baştan sona doğrular:
// EOCD → (varsa) ZIP64 EOCD + bulucu → merkez dizin (ZIP64 ek alanı) → her girdinin yerel başlığı, verisi
// (deflate/store), CRC-32'si ve data descriptor'ı. Bir kural bozulursa Error fırlatır.
const zlib = require('zlib');

const U32 = 0xFFFFFFFF;
const U16 = 0xFFFF;
const big = (b, o) => Number(b.readBigUInt64LE(o));

function ekAlanlari(buf) {
  const alanlar = new Map();
  for (let i = 0; i + 4 <= buf.length;) {
    const id = buf.readUInt16LE(i);
    const n = buf.readUInt16LE(i + 2);
    alanlar.set(id, buf.subarray(i + 4, i + 4 + n));
    i += 4 + n;
  }
  return alanlar;
}

// Yalnızca sondaki kayıtlar + merkez dizin. buf: zip'in son kısmı, taban: buf[0]'ın zip içindeki konumu
// (tamamı bellekteyse 0). Büyük zip'lerde (> 4 GB) yalnızca kuyruk tutulup bununla doğrulanır.
function merkeziOku(buf, taban = 0) {
  const e = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (e < 0) throw new Error('EOCD yok');
  let adet = buf.readUInt16LE(e + 10);
  let cdBoyut = buf.readUInt32LE(e + 12);
  let cdKonum = buf.readUInt32LE(e + 16);
  const toplam = taban + e + 22;
  if (e + 22 !== buf.length) throw new Error('EOCD sonrası fazla bayt (yorum beklenmiyor)');
  let zip64 = null;
  const l = e - 20;
  if (l >= 0 && buf.readUInt32LE(l) === 0x07064b50) {
    const r = big(buf, l + 8) - taban;
    if (buf.readUInt32LE(r) !== 0x06064b50) throw new Error('ZIP64 EOCD imzası yanlış');
    if (big(buf, r + 4) !== 44) throw new Error('ZIP64 EOCD boyutu yanlış');
    zip64 = { adet: big(buf, r + 32), cdBoyut: big(buf, r + 40), cdKonum: big(buf, r + 48), gerek: buf.readUInt16LE(r + 14) };
    if (r + 56 !== l) throw new Error('ZIP64 EOCD bulucudan hemen önce olmalı');
    if (adet === U16) adet = zip64.adet;
    if (cdBoyut === U32) cdBoyut = zip64.cdBoyut;
    if (cdKonum === U32) cdKonum = zip64.cdKonum;
    if (cdKonum + cdBoyut !== taban + r) throw new Error('merkez dizin ZIP64 EOCD\'den hemen önce bitmeli');
  } else if (adet === U16 || cdBoyut === U32 || cdKonum === U32) throw new Error('alan taşmış ama ZIP64 kaydı yok');
  else if (cdKonum + cdBoyut !== taban + e) throw new Error('merkez dizin EOCD\'den hemen önce bitmeli');

  const girdiler = [];
  let p = cdKonum - taban;
  for (let i = 0; i < adet; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`merkez kaydı ${i} imzası yanlış`);
    const bayrak = buf.readUInt16LE(p + 8);
    const nAd = buf.readUInt16LE(p + 28);
    const nEk = buf.readUInt16LE(p + 30);
    const nYorum = buf.readUInt16LE(p + 32);
    const g = {
      yapan: buf.readUInt16LE(p + 4), gerek: buf.readUInt16LE(p + 6), bayrak, yontem: buf.readUInt16LE(p + 10),
      saat: buf.readUInt16LE(p + 12), tarih: buf.readUInt16LE(p + 14), crc: buf.readUInt32LE(p + 16),
      sikisik: buf.readUInt32LE(p + 20), boyut: buf.readUInt32LE(p + 24), dis: buf.readUInt32LE(p + 38), konum: buf.readUInt32LE(p + 42),
      adHam: buf.subarray(p + 46, p + 46 + nAd),
    };
    g.ad = g.adHam.toString(bayrak & 0x0800 ? 'utf8' : 'latin1');
    const ek = ekAlanlari(buf.subarray(p + 46 + nAd, p + 46 + nAd + nEk));
    g.z64 = {};
    if (ek.has(1)) {
      const z = ek.get(1);
      let o = 0;
      for (const k of ['boyut', 'sikisik', 'konum']) {
        if (g[k] === U32) { g[k] = big(z, o); g.z64[k] = true; o += 8; }
      }
      if (o !== z.length) throw new Error(`${g.ad}: ZIP64 ek alanı uzunluğu yanlış`);
    } else if (g.boyut === U32 || g.sikisik === U32 || g.konum === U32) throw new Error(`${g.ad}: ZIP64 ek alanı yok`);
    if (Object.keys(g.z64).length && g.gerek < 45) throw new Error(`${g.ad}: ZIP64 kullanan girdide sürüm < 4.5`);
    g.klasor = g.ad.endsWith('/');
    girdiler.push(g);
    p += 46 + nAd + nEk + nYorum;
  }
  if (p !== cdKonum - taban + cdBoyut) throw new Error('merkez dizin boyutu tutmuyor');
  return { girdiler, zip64, adet, cdKonum, cdBoyut, toplam };
}

// Tüm zip bellekteyken: merkez dizin + yerel başlık + veri + CRC + data descriptor.
function zipOku(buf) {
  const m = merkeziOku(buf);
  for (const g of m.girdiler) {
    const p = g.konum;
    if (buf.readUInt32LE(p) !== 0x04034b50) throw new Error(`${g.ad}: yerel başlık imzası yanlış`);
    const lBayrak = buf.readUInt16LE(p + 6);
    if (lBayrak !== g.bayrak) throw new Error(`${g.ad}: yerel/merkez bayrakları farklı`);
    if (buf.readUInt16LE(p + 8) !== g.yontem) throw new Error(`${g.ad}: yöntem farklı`);
    const nAd = buf.readUInt16LE(p + 26);
    const nEk = buf.readUInt16LE(p + 28);
    if (!buf.subarray(p + 30, p + 30 + nAd).equals(g.adHam)) throw new Error(`${g.ad}: yerel başlıkta ad farklı`);
    const yEk = ekAlanlari(buf.subarray(p + 30 + nAd, p + 30 + nAd + nEk));
    g.yerel64 = yEk.has(1);
    const bas = p + 30 + nAd + nEk;
    const ham = buf.subarray(bas, bas + g.sikisik);
    g.veri = g.yontem === 8 ? zlib.inflateRawSync(ham) : g.yontem === 0 ? Buffer.from(ham) : null;
    if (!g.veri) throw new Error(`${g.ad}: bilinmeyen yöntem ${g.yontem}`);
    if (g.veri.length !== g.boyut) throw new Error(`${g.ad}: boyut ${g.veri.length} ≠ ${g.boyut}`);
    if ((zlib.crc32(g.veri) >>> 0) !== g.crc) throw new Error(`${g.ad}: CRC tutmuyor`);
    if (g.bayrak & 0x0008) {
      const d = bas + g.sikisik;
      if (buf.readUInt32LE(d) !== 0x08074b50) throw new Error(`${g.ad}: data descriptor imzası yok`);
      const [dc, ds, du] = g.yerel64 ? [buf.readUInt32LE(d + 4), big(buf, d + 8), big(buf, d + 16)] : [buf.readUInt32LE(d + 4), buf.readUInt32LE(d + 8), buf.readUInt32LE(d + 12)];
      if (dc !== g.crc || ds !== g.sikisik || du !== g.boyut) throw new Error(`${g.ad}: data descriptor merkez kaydıyla tutmuyor`);
    } else if (buf.readUInt32LE(p + 14) !== g.crc) throw new Error(`${g.ad}: yerel CRC farklı`);
  }
  return m;
}

module.exports = { zipOku, merkeziOku };
