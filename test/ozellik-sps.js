// @sunucu yok
// lib/sps.js: NVENC benzeri (bitstream_restriction'sız) SPS'e max_num_reorder_frames=0 eklenir; akış hâlâ çözülebilir.
// ffmpeg'in trace_headers süzgeciyle başlıklar okunur. Ekran yakalanmaz, örnek akış lavfi ile üretilir.
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { patchSps, _test } = require(path.join(ROOT, 'lib', 'sps'));

let pass = 0, fail = 0;
const check = (n, c, x = '') => { console.log(`${c ? 'OK  ' : 'FAIL'} ${n} ${x}`); c ? pass++ : fail++; };

let FF = null;
try { FF = require(path.join(ROOT, 'node_modules', 'ffmpeg-static')); } catch { /* yok */ }

// Öykünme önleme gidiş-dönüş
const ham = Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 5, 0, 0]);
check('escape/unescape gidiş-dönüş', _test.unescape(_test.escape(ham)).equals(ham));
const kacmis = _test.escape(ham);
check('escape sonrası 00 00 00/01/02 dizisi yok', ![...kacmis].some((b, i) => i >= 2 && kacmis[i - 2] === 0 && kacmis[i - 1] === 0 && b <= 2), kacmis.toString('hex'));
check('SPS olmayan NAL dokunulmuyor', patchSps(Buffer.from([0x65, 1, 2, 3])) === null);
check('bozuk SPS null', patchSps(Buffer.from([0x67, 0x4d])) === null);

function nalsOf(buf) {
  const out = [];
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) out.push(i + 3);
  }
  return out.map((s, k) => {
    let e = k + 1 < out.length ? out[k + 1] - 3 : buf.length;
    while (e > s && buf[e - 1] === 0) e--;
    return buf.subarray(s, e);
  });
}

function trace(file) {
  const r = spawnSync(FF, ['-hide_banner', '-i', file, '-c', 'copy', '-bsf:v', 'trace_headers', '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  const get = (k) => {
    const l = r.stderr.split('\n').find((x) => x.includes(` ${k} `));
    const m = l && l.match(/= (\d+)\s*$/);
    return m ? Number(m[1]) : null;
  };
  return { restr: get('bitstream_restriction_flag'), reorder: get('max_num_reorder_frames'), dpb: get('max_dec_frame_buffering'), refs: get('max_num_ref_frames'), w: get('pic_width_in_mbs_minus1') };
}

function decodeCount(file) {
  const r = spawnSync(FF, ['-hide_banner', '-v', 'error', '-i', file, '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true });
  const r2 = spawnSync(FF, ['-hide_banner', '-i', file, '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true });
  const m = r2.stderr.match(/frame=\s*(\d+)/g);
  return { ok: r.status === 0 && !r.stderr.trim(), err: r.stderr.trim().slice(0, 200), frames: m ? Number(m.pop().match(/\d+/)[0]) : -1 };
}

function sample(name, encArgs, pix, ek = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-sps-'));
  const src = path.join(dir, 'a.h264'), dst = path.join(dir, 'b.h264');
  const r = spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1600x900:r=30', '-frames:v', '60',
    '-vf', `format=${pix}`, ...encArgs, '-g', '60', ...ek, '-f', 'h264', src], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) { console.log(`OK   ${name}: kodlayıcı yok, atlandı (${r.stderr.trim().split('\n').pop()})`); return; }
  const buf = fs.readFileSync(src);
  const once = trace(src);
  // Akıştaki SPS'leri değiştirip yeni dosya yaz
  const parts = nalsOf(buf).map((nal) => ((nal[0] & 0x1f) === 7 ? patchSps(nal) || nal : nal));
  const patched = (nalsOf(buf).find((n) => (n[0] & 0x1f) === 7));
  const out = Buffer.concat(parts.flatMap((p) => [Buffer.from([0, 0, 0, 1]), p]));
  fs.writeFileSync(dst, out);
  const sonra = trace(dst);
  const d1 = decodeCount(src), d2 = decodeCount(dst);
  if (once.restr === 1) {
    check(`${name}: alan zaten var, dokunulmadı`, patchSps(patched) === null, JSON.stringify(once));
  } else {
    check(`${name}: önce bitstream_restriction yok`, once.restr === 0 || once.restr === null, JSON.stringify(once));
    check(`${name}: sonra reorder=0, dpb>=refs`, sonra.restr === 1 && sonra.reorder === 0 && sonra.dpb >= sonra.refs && sonra.refs === once.refs && sonra.w === once.w, JSON.stringify(sonra));
  }
  check(`${name}: düzeltilmiş akış hatasız ve aynı sayıda kare çözülüyor`, d2.ok && d2.frames === d1.frames && d1.frames === 60, `${d1.frames} -> ${d2.frames} ${d2.err}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

if (!FF) {
  console.log('OK   ffmpeg yok, akış testleri atlandı');
} else {
  sample('NVENC', ['-c:v', 'h264_nvenc', '-preset', 'p1', '-tune', 'ull', '-zerolatency', '1', '-rc', 'vbr', '-cq', '28', '-b:v', '0', '-profile:v', 'main', '-bf', '0'], 'nv12', ['-bsf:v', 'h264_metadata=aud=insert']);
  sample('AMF', ['-c:v', 'h264_amf', '-usage', 'ultralowlatency', '-quality', 'speed', '-rc', 'vbr_peak', '-b:v', '2000k', '-profile:v', 'main', '-bf', '0'], 'nv12', ['-bsf:v', 'h264_metadata=aud=insert']);
  sample('x264', ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '28', '-profile:v', 'main'], 'yuv420p');
  sample('x264 high', ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-profile:v', 'high', '-bf', '0'], 'yuv420p');

  // VUI'siz SPS (elle üretilir: baseline 640x480, 2 referans kare) -> VUI eklenmeli
  const bits = [];
  const u = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1); };
  const ue = (v) => { const x = v + 1, len = Math.floor(Math.log2(x)); u(0, len); u(x, len + 1); };
  u(66, 8); u(0xc0, 8); u(30, 8); ue(0); ue(0); ue(2); ue(2); u(0, 1); ue(39); ue(29); u(1, 1); u(1, 1); u(0, 1); u(0, 1); u(1, 1);
  while (bits.length % 8) bits.push(0);
  const rbsp = Buffer.from(bits.join('').match(/.{8}/g).map((b) => parseInt(b, 2)));
  const yeni = patchSps(Buffer.concat([Buffer.from([0x67]), rbsp]));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-sps-'));
  const f = path.join(dir, 'vuisiz.h264');
  fs.writeFileSync(f, Buffer.concat([Buffer.from([0, 0, 0, 1]), yeni || Buffer.alloc(0)]));
  const tr = trace(f);
  check('VUI\'siz SPS: VUI eklendi, reorder=0, dpb=2, boyut korundu', yeni && tr.restr === 1 && tr.reorder === 0 && tr.dpb === 2 && tr.refs === 2 && tr.w === 39, JSON.stringify(tr));
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${pass} kontrol geçti, ${fail} hata`);
process.exit(fail ? 1 : 0);
