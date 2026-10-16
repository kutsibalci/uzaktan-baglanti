// H.264 SPS düzeltmesi: VUI'ye "bitstream_restriction" ekleyip max_num_reorder_frames = 0 yazar.
//
// Neden: NVENC bu alanı yazmıyor. Alan yoksa tarayıcının çözücüsü (WebCodecs) karelerin sırası değişebilir diye
// birkaç kareyi bekletip öyle gösteriyor — ölçülen ek gecikme 30 fps'de ~130 ms (x264 bu alanı yazar, ~2 ms).
// Akışımızda B-kare yok (-bf 0), yani bu bilgi doğru; çözücü her kareyi hemen çıkarabilir.
//
// patchSps(nal) — nal: başlangıç kodu OLMADAN SPS NAL birimi (ilk bayt NAL başlığı).
// Değiştirilmiş yeni NAL'ı döner; alan zaten varsa ya da SPS ayrıştırılamıyorsa null döner (akış olduğu gibi kalır).

// Öykünme önleme baytlarını (00 00 03) kaldırır: NAL -> RBSP
function unescape(buf) {
  const out = [];
  let zeros = 0;
  for (const b of buf) {
    if (zeros >= 2 && b === 3) { zeros = 0; continue; }
    out.push(b);
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return Buffer.from(out);
}

// RBSP -> NAL (00 00 xx, xx <= 3 ise araya 03 girer)
function escape(buf) {
  const out = [];
  let zeros = 0;
  for (const b of buf) {
    if (zeros >= 2 && b <= 3) { out.push(3); zeros = 0; }
    out.push(b);
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return Buffer.from(out);
}

class BitReader {
  constructor(buf) { this.buf = buf; this.pos = 0; }
  bit() {
    if (this.pos >= this.buf.length * 8) throw new Error('SPS beklenenden kısa');
    const b = (this.buf[this.pos >> 3] >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return b;
  }
  bits(n) { let v = 0; for (let i = 0; i < n; i++) v = v * 2 + this.bit(); return v; }
  ue() {
    let zeros = 0;
    while (this.bit() === 0) { if (++zeros > 31) throw new Error('bozuk ue'); }
    return zeros ? 2 ** zeros - 1 + this.bits(zeros) : 0;
  }
  se() { const k = this.ue(); return k & 1 ? (k + 1) / 2 : -k / 2; }
}

class BitWriter {
  constructor() { this.bytes = []; this.cur = 0; this.n = 0; }
  bit(b) {
    this.cur = (this.cur << 1) | (b & 1);
    if (++this.n === 8) { this.bytes.push(this.cur); this.cur = 0; this.n = 0; }
  }
  bits(v, n) { for (let i = n - 1; i >= 0; i--) this.bit(Math.floor(v / 2 ** i) & 1); }
  ue(v) {
    const x = v + 1;
    const len = Math.floor(Math.log2(x));
    this.bits(0, len);
    this.bits(x, len + 1);
  }
  // Okuyucunun ilk n bitini aynen kopyalar
  copy(reader, n) { const r = new BitReader(reader.buf); for (let i = 0; i < n; i++) this.bit(r.bit()); }
  // rbsp_trailing_bits: 1 ve bayt sonuna kadar 0
  finish() { this.bit(1); while (this.n !== 0) this.bit(0); return Buffer.from(this.bytes); }
}

const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

function skipHrd(r) {
  const cpbCnt = r.ue() + 1;
  r.bits(4); r.bits(4); // bit_rate_scale, cpb_size_scale
  for (let i = 0; i < cpbCnt; i++) { r.ue(); r.ue(); r.bit(); }
  r.bits(5); r.bits(5); r.bits(5); r.bits(5);
}

function patchSps(nal) {
  if (!nal || nal.length < 4 || (nal[0] & 0x1f) !== 7) return null;
  try {
    const rbsp = unescape(nal.subarray(1));
    const r = new BitReader(rbsp);
    const profile = r.bits(8);
    r.bits(8); r.bits(8); // constraint bayrakları, seviye
    r.ue(); // seq_parameter_set_id
    if (HIGH_PROFILES.has(profile)) {
      if (r.ue() === 3) r.bit(); // chroma_format_idc, separate_colour_plane_flag
      r.ue(); r.ue(); r.bit(); // bit derinlikleri, qpprime_y_zero_transform_bypass_flag
      if (r.bit()) return null; // ölçekleme matrisi: desteklemiyoruz, dokunma
    }
    r.ue(); // log2_max_frame_num_minus4
    const pocType = r.ue();
    if (pocType === 0) r.ue();
    else if (pocType === 1) {
      r.bit(); r.se(); r.se();
      const n = r.ue();
      for (let i = 0; i < n; i++) r.se();
    }
    const maxRefFrames = r.ue();
    r.bit(); r.ue(); r.ue(); // gaps_in_frame_num_allowed, genişlik, yükseklik
    if (!r.bit()) r.bit(); // frame_mbs_only_flag, mb_adaptive_frame_field_flag
    r.bit(); // direct_8x8_inference_flag
    if (r.bit()) { r.ue(); r.ue(); r.ue(); r.ue(); } // kırpma
    const vuiFlagPos = r.pos;
    const w = new BitWriter();
    if (!r.bit()) {
      // VUI yok: yalnızca bitstream_restriction içeren bir VUI yaz.
      w.copy(r, vuiFlagPos);
      w.bit(1); // vui_parameters_present_flag
      for (let i = 0; i < 8; i++) w.bit(0); // aspect, overscan, video_signal, chroma_loc, timing, nal_hrd, vcl_hrd, pic_struct
    } else {
      if (r.bit() && r.bits(8) === 255) { r.bits(16); r.bits(16); } // aspect_ratio
      if (r.bit()) r.bit(); // overscan
      if (r.bit()) { r.bits(3); r.bit(); if (r.bit()) { r.bits(8); r.bits(8); r.bits(8); } } // video_signal_type
      if (r.bit()) { r.ue(); r.ue(); } // chroma_loc
      if (r.bit()) { r.bits(32); r.bits(32); r.bit(); } // timing_info
      const nalHrd = r.bit(); if (nalHrd) skipHrd(r);
      const vclHrd = r.bit(); if (vclHrd) skipHrd(r);
      if (nalHrd || vclHrd) r.bit(); // low_delay_hrd_flag
      r.bit(); // pic_struct_present_flag
      const flagPos = r.pos;
      if (r.bit()) return null; // zaten var (x264 gibi)
      w.copy(r, flagPos);
    }
    w.bit(1); // bitstream_restriction_flag
    w.bit(1); // motion_vectors_over_pic_boundaries_flag
    w.ue(2); // max_bytes_per_pic_denom (varsayılan)
    w.ue(1); // max_bits_per_mb_denom (varsayılan)
    w.ue(16); w.ue(16); // log2_max_mv_length_horizontal / vertical (varsayılan)
    w.ue(0); // max_num_reorder_frames — asıl amaç: kare bekletme yok
    w.ue(Math.max(1, maxRefFrames)); // max_dec_frame_buffering >= max_num_ref_frames olmalı
    return Buffer.concat([nal.subarray(0, 1), escape(w.finish())]);
  } catch {
    return null;
  }
}

module.exports = { patchSps, _test: { unescape, escape, BitReader } };
