// Küçük QR kod kodlayıcı (bağımlılık yok): bayt modu, hata düzeltme seviyesi M, sürüm 1–40 otomatik, maske ceza puanıyla seçilir.
// ISO/IEC 18004 algoritması (yerleşim ve ceza kuralları Nayuki'nin açık kaynak QR uygulamasındaki biçimle aynı).
//   const { encode, svg } = require('./lib/qr');
//   encode('https://...')  -> { version, size, mask, modules: [[bool...]...] }  (modules[y][x], true = koyu)
//   svg('https://...')     -> '<svg ...>' (4 modül sessiz kenar, beyaz zemin)
// Testler maskeyi sabitlemek için encode(metin, { mask: 0..7 }) kullanır.

// Seviye M: blok başına hata düzeltme kod sözcüğü ve blok sayısı (sürüm 1..40).
const ECC_PER_BLOCK = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26,
  26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
const BLOCKS = [1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16,
  17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];
const FORMAT_M = 0; // biçim bilgisindeki iki bit: L=1, M=0, Q=3, H=2

// Veri + hata düzeltme için kullanılabilen modül sayısı (işlev desenleri çıkınca).
function rawModules(v) {
  let r = (16 * v + 128) * v + 64;
  if (v >= 2) {
    const n = Math.floor(v / 7) + 2;
    r -= (25 * n - 10) * n - 55;
    if (v >= 7) r -= 36;
  }
  return r;
}
const dataCodewords = (v) => Math.floor(rawModules(v) / 8) - ECC_PER_BLOCK[v - 1] * BLOCKS[v - 1];

// ---------- Reed-Solomon (GF(256), indirgeme polinomu 0x11D) ----------

function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree) {
  const r = new Array(degree).fill(0);
  r[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < r.length; j++) {
      r[j] = gfMul(r[j], root);
      if (j + 1 < r.length) r[j] ^= r[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return r;
}

function rsRemainder(data, divisor) {
  const r = divisor.map(() => 0);
  for (const b of data) {
    const f = b ^ r.shift();
    r.push(0);
    divisor.forEach((c, i) => { r[i] ^= gfMul(c, f); });
  }
  return r;
}

// ---------- Veri kod sözcükleri ----------

function chooseVersion(len) {
  for (let v = 1; v <= 40; v++) {
    const bits = 4 + (v < 10 ? 8 : 16) + 8 * len;
    if (bits <= dataCodewords(v) * 8) return v;
  }
  throw new Error('QR kod için metin çok uzun.');
}

function dataBytes(bytes, v) {
  const bits = [];
  const put = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(0b0100, 4);                       // bayt modu
  put(bytes.length, v < 10 ? 8 : 16);   // karakter sayısı
  for (const b of bytes) put(b, 8);
  const cap = dataCodewords(v) * 8;
  put(0, Math.min(4, cap - bits.length)); // sonlandırıcı
  put(0, (8 - (bits.length % 8)) % 8);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0xec; out.length < cap / 8; pad ^= 0xec ^ 0x11) out.push(pad);
  return out;
}

// Blokları böl, her bloğa hata düzeltme ekle, sütun sütun ara ara diz.
function interleave(data, v) {
  const nBlocks = BLOCKS[v - 1], ecLen = ECC_PER_BLOCK[v - 1];
  const raw = Math.floor(rawModules(v) / 8);
  const nShort = nBlocks - (raw % nBlocks);
  const shortLen = Math.floor(raw / nBlocks);
  const div = rsDivisor(ecLen);
  const blocks = [];
  for (let i = 0, k = 0; i < nBlocks; i++) {
    const len = shortLen - ecLen + (i < nShort ? 0 : 1);
    const dat = data.slice(k, k + len);
    k += len;
    const ecc = rsRemainder(dat, div);
    if (i < nShort) dat.push(null); // kısa bloklarda hizalama boşluğu (dizilirken atlanır)
    blocks.push(dat.concat(ecc));
  }
  const out = [];
  for (let i = 0; i < blocks[0].length; i++) {
    for (const b of blocks) if (b[i] !== null) out.push(b[i]);
  }
  return out;
}

// ---------- Matris ----------

function alignmentPositions(v) {
  if (v === 1) return [];
  const size = v * 4 + 17;
  const n = Math.floor(v / 7) + 2;
  const step = v === 32 ? 26 : Math.ceil((v * 4 + 4) / (n * 2 - 2)) * 2;
  const r = [6];
  for (let pos = size - 7; r.length < n; pos -= step) r.splice(1, 0, pos);
  return r;
}

function formatBits(mask) {
  const d = (FORMAT_M << 3) | mask;
  let rem = d;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((d << 10) | rem) ^ 0x5412;
}

function versionBits(v) {
  let rem = v;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (v << 12) | rem;
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function buildBase(v, codewords) {
  const size = v * 4 + 17;
  const m = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => { m[y][x] = dark; fn[y][x] = true; };

  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); } // zamanlama
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {                 // bulucu + ayırıcı
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      set(x, y, d !== 2 && d !== 4);
    }
  }
  const al = alignmentPositions(v);
  for (let i = 0; i < al.length; i++) for (let j = 0; j < al.length; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      set(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
  drawFormat(m, fn, 0); // yer ayır (maske seçilince yeniden yazılır)
  if (v >= 7) {
    const b = versionBits(v);
    for (let i = 0; i < 18; i++) {
      const dark = ((b >>> i) & 1) === 1;
      const a = size - 11 + (i % 3), c = Math.floor(i / 3);
      set(a, c, dark); set(c, a, dark);
    }
  }

  // Veri: sağdan sola iki sütunluk şeritler, zikzak.
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const up = ((right + 1) & 2) === 0;
        const y = up ? size - 1 - vert : vert;
        if (!fn[y][x] && i < codewords.length * 8) {
          m[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
          i++;
        }
      }
    }
  }
  return { m, fn, size };
}

function drawFormat(m, fn, mask) {
  const size = m.length;
  const bits = formatBits(mask);
  const bit = (i) => ((bits >>> i) & 1) === 1;
  const set = (x, y, dark) => { m[y][x] = dark; if (fn) fn[y][x] = true; };
  for (let i = 0; i <= 5; i++) set(8, i, bit(i));
  set(8, 7, bit(6));
  set(8, 8, bit(7));
  set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
  set(8, size - 8, true); // her zaman koyu modül
}

function applyMask(base, mask) {
  const { m, fn, size } = base;
  const out = m.map((row) => row.slice());
  const f = MASKS[mask];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (!fn[y][x] && f(x, y)) out[y][x] = !out[y][x];
  }
  drawFormat(out, null, mask);
  return out;
}

// ---------- Maske ceza puanı ----------

function penalty(m) {
  const size = m.length;
  let score = 0;
  const lines = [];
  for (let y = 0; y < size; y++) lines.push(m[y]);
  for (let x = 0; x < size; x++) lines.push(m.map((row) => row[x]));
  for (const line of lines) {
    // Kural 1: aynı renkte 5+ ardışık modül
    let run = 1;
    for (let i = 1; i <= size; i++) {
      if (i < size && line[i] === line[i - 1]) { run++; continue; }
      if (run >= 5) score += 3 + (run - 5);
      run = 1;
    }
    // Kural 3: 1:1:3:1:1 bulucu benzeri desen, bir yanında 4 açık modül (simgenin dışı açık sayılır)
    const at = (i) => (i < 0 || i >= size ? false : line[i]);
    for (let i = -4; i < size; i++) {
      if (at(i) && !at(i + 1) && at(i + 2) && at(i + 3) && at(i + 4) && !at(i + 5) && at(i + 6)) {
        const before = !at(i - 1) && !at(i - 2) && !at(i - 3) && !at(i - 4);
        const after = !at(i + 7) && !at(i + 8) && !at(i + 9) && !at(i + 10);
        if (before || after) score += 40;
      }
    }
  }
  // Kural 2: 2x2 aynı renk blok
  for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
    const c = m[y][x];
    if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += 3;
  }
  // Kural 4: koyu oranı %50'den uzaklaştıkça
  let dark = 0;
  for (const row of m) for (const c of row) if (c) dark++;
  const total = size * size;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}

// ---------- Dışa açık ----------

function encode(text, opts = {}) {
  const bytes = [...Buffer.from(String(text), 'utf8')];
  const version = chooseVersion(bytes.length);
  const base = buildBase(version, interleave(dataBytes(bytes, version), version));
  let best = null;
  const masks = Number.isInteger(opts.mask) ? [opts.mask] : [0, 1, 2, 3, 4, 5, 6, 7];
  for (const mask of masks) {
    const modules = applyMask(base, mask);
    const p = masks.length > 1 ? penalty(modules) : 0;
    if (!best || p < best.p) best = { mask, modules, p };
  }
  return { version, size: base.size, mask: best.mask, modules: best.modules };
}

function svg(text, { margin = 4 } = {}) {
  const { size, modules } = encode(text);
  const n = size + margin * 2;
  let d = '';
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (modules[y][x]) d += `M${x + margin} ${y + margin}h1v1h-1z`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" role="img" aria-label="QR kod">`
    + `<rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

module.exports = { encode, svg, penalty, formatBits, versionBits, dataCodewords, alignmentPositions, rsRemainder, rsDivisor };
