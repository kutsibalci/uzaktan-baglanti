// H.264 görüntü akışı: ffmpeg (gdigrab ile ekran yakalama + donanım kodlayıcı) -> Annex B
// -> erişim birimlerine (kare) bölünür -> WebSocket ile tarayıcıya (WebCodecs) gönderilir.
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const { patchSps } = require('./sps');
const Ekranlar = require('../public/ekranlar');

let FFMPEG = null;
try { FFMPEG = require('ffmpeg-static'); } catch { /* paket yok */ }
if (FFMPEG && !fs.existsSync(FFMPEG)) FFMPEG = null;

// Kodlayıcılar, tercih sırasına göre. Hepsi düşük gecikme ayarlı, B-kare yok.
// NVENC: -delay 0 olmadan ffmpeg çıktıyı "yüzey sayısı - 1" (3) kare bekletiyordu (ölçüm, 1080p 30 fps: yakalamadan kodlanmış
// pakete ortanca ~120-145 ms -> ~55-60 ms; test/ozellik-kodlayici-gecikme.js). Kare bgra olarak verilir: renk dönüşümünü NVENC
// kendisi yapar (işlemcide nv12'ye çevirme yok; ffmpeg CPU'su ~%6,5 -> ~%3, renk aynı).
// Bit hızı değişken (VBR): ekran durağanken az veri harcar, hareketlenince "kbps" üst sınırına kadar çıkar.
// (Ölçüm, 1080p durağan masaüstü: CBR 4000 kbps, NVENC VBR ~840 kbps.)
const ENCODERS = [
  { name: 'h264_nvenc', label: 'NVIDIA', pix: 'bgra', args: (k) => ['-preset', 'p1', '-tune', 'ull', '-zerolatency', '1', '-delay', '0', '-rc', 'vbr', '-cq', String(cq(k)), '-b:v', '0', '-profile:v', 'main', '-bf', '0', ...cap(k)] },
  { name: 'h264_amf', label: 'AMD', pix: 'nv12', args: (k) => ['-usage', 'ultralowlatency', '-quality', 'speed', '-rc', 'vbr_peak', '-b:v', `${Math.round(k / 2)}k`, '-profile:v', 'main', '-bf', '0', ...cap(k)] },
  { name: 'h264_qsv', label: 'Intel', pix: 'nv12', args: (k) => ['-preset', 'veryfast', '-look_ahead', '0', '-async_depth', '1', '-b:v', `${Math.round(k / 2)}k`, '-profile:v', 'main', '-bf', '0', ...cap(k)] },
  { name: 'libx264', label: 'İşlemci', pix: 'yuv420p', args: (k) => ['-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', String(cq(k)), '-profile:v', 'main', ...cap(k)] },
];
// Kalite seviyesi üst sınırdan türetilir: Düşük (1500) -> 30, Orta (4000) -> 26, Yüksek (8000) -> 22.
const cq = (kbps) => (kbps <= 2000 ? 30 : kbps >= 7000 ? 22 : 26);
const cap = (kbps) => ['-maxrate', `${kbps}k`, '-bufsize', `${Math.round(kbps / 2)}k`];

const SEND_LIMIT = 512 * 1024; // istemcinin kuyruğu bundan büyükse bir sonraki anahtar kareye kadar atla
// gdigrab fiziksel piksellerle çalışsın. ffmpeg-static'in exe'si zaten PerMonitorV2 bildirimli (manifest) ve bildirim bu
// katmana baskın geliyor; katman, bildirimsiz bir ffmpeg için yedek. Bölge (offset/video_size) RemoteHelper "info"dan
// gelir; o da Per-Monitor v2 olduğundan iki taraf aynı fiziksel koordinat sistemini kullanır (farklı ölçekli monitörlerde de).
const CHILD_ENV = { ...process.env, __COMPAT_LAYER: 'HighDpiAware' };

// ---------- Kodlayıcı seçimi ----------

const badEncoders = new Set();

function encoderWorks(enc) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=black:s=320x240:r=30',
    '-frames:v', '5', '-vf', `format=${enc.pix}`, '-c:v', enc.name, ...enc.args(1000), '-f', 'null', '-'], { timeout: 15000, windowsHide: true });
  return r.status === 0;
}

let encoders = null; // çalışan kodlayıcılar
function detectEncoders() {
  if (encoders) return encoders;
  // REMOTE_H264_ENCODER=libx264 gibi bir değer yalnızca o kodlayıcıyı dener (karşılaştırma ve testler için).
  const only = process.env.REMOTE_H264_ENCODER;
  encoders = FFMPEG ? ENCODERS.filter((e) => (!only || e.name === only) && encoderWorks(e)) : [];
  return encoders;
}
const currentEncoder = () => detectEncoders().find((e) => !badEncoders.has(e.name)) || null;

// ---------- H.264 bit akışı ayrıştırma ----------

// Annex B akışından NAL birimlerinin başlangıç konumlarını bulur.
function findNals(buf, from) {
  const out = [];
  for (let i = from; i + 3 < buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0) {
      if (buf[i + 2] === 1) { out.push({ start: i, hdr: i + 3 }); i += 2; }
      else if (buf[i + 2] === 0 && buf[i + 3] === 1) { out.push({ start: i, hdr: i + 4 }); i += 3; }
    }
  }
  return out;
}

function nalTypes(au) {
  return findNals(au, 0).map((n) => ({ type: au[n.hdr] & 0x1f, start: n.start, hdr: n.hdr }));
}

const hex2 = (b) => b.toString(16).padStart(2, '0').toUpperCase();

// SPS'e "kare bekletme yok" bilgisini ekler (bkz. lib/sps.js). Aynı SPS her anahtar karede tekrarlandığı için sonuç saklanır.
const spsCache = { in: null, out: null };
function fixSps(au) {
  const nals = nalTypes(au);
  const i = nals.findIndex((n) => n.type === 7);
  if (i < 0) return au;
  const end = i + 1 < nals.length ? nals[i + 1].start : au.length;
  const orig = au.subarray(nals[i].hdr, end);
  if (!spsCache.in || !spsCache.in.equals(orig)) {
    spsCache.in = Buffer.from(orig);
    spsCache.out = patchSps(orig);
    if (spsCache.out) console.log('H.264: SPS düzeltildi (tarayıcıda kare bekletme kapatıldı)');
  }
  if (!spsCache.out) return au;
  return Buffer.concat([au.subarray(0, nals[i].hdr), spsCache.out, au.subarray(end)]);
}

// ---------- Akış ----------

class VideoStream {
  constructor(manager, key, p) {
    this.manager = manager;
    this.key = key;
    this.p = p; // { x, y, w, h, outW, outH, fps, kbps }
    this.subs = new Set();
    this.buf = Buffer.alloc(0);
    this.sps = null;
    this.pps = null;
    this.codec = null;
    this.restarts = 0;
    this.start();
  }

  start() {
    const enc = currentEncoder();
    if (!enc) { this.fail('Kullanılabilir H.264 kodlayıcı yok.'); return; }
    this.enc = enc;
    const p = this.p;
    const vf = [];
    if (p.outW !== p.w || p.outH !== p.h) vf.push(`scale=${p.outW}:${p.outH}:flags=bilinear`);
    vf.push(`format=${enc.pix}`);
    const args = [
      '-hide_banner', '-loglevel', 'error',
      ...gdigrabArgs(p),
      '-vf', vf.join(','),
      '-c:v', enc.name, ...enc.args(p.kbps), '-g', String(p.fps * 2),
      '-bsf:v', 'h264_metadata=aud=insert',
      '-flush_packets', '1', '-f', 'h264', '-',
    ];
    this.startedAt = Date.now();
    this.stderr = '';
    this.proc = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: CHILD_ENV });
    this.proc.stdout.on('data', (d) => this.onData(d));
    this.proc.stderr.on('data', (d) => { this.stderr = (this.stderr + d).slice(-2000); });
    this.proc.on('exit', (code) => this.onExit(code));
    console.log(`H.264 akışı başladı: ${p.outW}x${p.outH} @${p.fps}fps ${p.kbps}kbps (${enc.label})`);
  }

  onExit(code) {
    this.proc = null;
    if (this.stopped) return;
    const quick = Date.now() - this.startedAt < 3000;
    console.warn(`ffmpeg kapandı (kod ${code}) ${this.stderr.trim().split('\n').pop() || ''}`);
    if (quick) {
      // Hemen çöktüyse bu kodlayıcıyı bırak, sıradakini dene.
      badEncoders.add(this.enc.name);
      if (!currentEncoder()) { this.fail('H.264 kodlayıcı başlatılamadı.'); return; }
    }
    if (++this.restarts > 5) { this.fail('H.264 akışı tekrar tekrar durdu.'); return; }
    this.buf = Buffer.alloc(0);
    for (const ws of this.subs) ws.vWaitKey = true;
    setTimeout(() => { if (!this.stopped) this.start(); }, 500);
  }

  fail(msg) {
    console.warn(`H.264 kullanılamıyor: ${msg} JPEG'e geçiliyor.`);
    const subs = [...this.subs];
    this.stop();
    for (const ws of subs) this.manager.onFail(ws, msg);
  }

  // Akışı AUD (tip 9) NAL'larından bölerek tam kareleri çıkarır.
  onData(chunk) {
    const scanFrom = Math.max(0, this.buf.length - 3);
    this.buf = Buffer.concat([this.buf, chunk]);
    const auds = findNals(this.buf, scanFrom > 0 ? scanFrom : 0).filter((n) => (this.buf[n.hdr] & 0x1f) === 9);
    let cut = 0;
    for (const a of auds) {
      if (a.start > cut) {
        const au = this.buf.subarray(cut, a.start);
        if (findNals(au, 0).length) this.emit(Buffer.from(au));
      }
      cut = a.start;
    }
    // İlk AUD'dan önceki veri ve tamamlanmış kareler atılır.
    if (cut > 0) this.buf = this.buf.subarray(cut);
    if (this.buf.length > 8 * 1024 * 1024) this.buf = Buffer.alloc(0); // bozuk akışa karşı
  }

  emit(au) {
    au = fixSps(au);
    const nals = nalTypes(au);
    let key = false;
    for (let i = 0; i < nals.length; i++) {
      const n = nals[i];
      const end = i + 1 < nals.length ? nals[i + 1].start : au.length;
      if (n.type === 7) {
        this.sps = au.subarray(n.start, end);
        this.codec = `avc1.${hex2(au[n.hdr + 1])}${hex2(au[n.hdr + 2])}${hex2(au[n.hdr + 3])}`;
      } else if (n.type === 8) {
        this.pps = au.subarray(n.start, end);
      } else if (n.type === 5) {
        key = true;
      }
    }
    if (!this.codec) return;
    const hasHeaders = nals.some((n) => n.type === 7);
    this.restarts = 0;

    for (const ws of this.subs) {
      if (ws.readyState !== 1) continue;
      if (ws.vWaitKey) {
        if (!key) continue;
        ws.vWaitKey = false;
      } else if (ws.bufferedAmount > SEND_LIMIT) {
        ws.vWaitKey = true; // ağ yetişemiyor: biriktirme, sonraki anahtar kareden devam et
        continue;
      }
      if (key && ws.vCodec !== this.codec) {
        ws.vCodec = this.codec;
        ws.send(JSON.stringify({ t: 'vconfig', codec: this.codec, w: this.p.outW, h: this.p.outH, encoder: this.enc.label }));
      }
      const payload = key && !hasHeaders && this.sps && this.pps ? Buffer.concat([this.sps, this.pps, au]) : au;
      ws.send(Buffer.concat([Buffer.from([2, key ? 1 : 0]), payload]), { binary: true });
    }
  }

  stop() {
    this.stopped = true;
    this.subs.clear();
    this.manager.streams.delete(this.key);
    if (this.proc) this.proc.kill();
  }
}

// gdigrab bölgesi (fiziksel piksel, RemoteHelper "info" ile aynı sistem) ve kodlanacak boyut. Kodlayıcı çift boyut ister.
// Yakalama bölgesi aşağı yuvarlanır: tek sayılı genişlikte yukarı yuvarlamak bölgeyi 1 piksel komşu monitöre
// (en sağdaki/alttaki monitörde sanal masaüstünün dışına) taşırırdı.
// screen.tum: "Tüm ekranlar" — bölge bütün ekranların sınır kutusu (gdigrab tek süreçte yakalar, ekran dışı boşluklar siyah),
// ölçek genişliğe göre değil toplam piksele göre (public/ekranlar.js olcek: Orta ~1920×1080 kadar piksel, Yüksek tam çözünürlük).
function grabRegion(screen, maxWidth) {
  const even = (v) => Math.max(2, Math.round(v / 2) * 2);
  const evenDown = (v) => Math.max(2, Math.floor(v / 2) * 2);
  const w = evenDown(screen.w), h = evenDown(screen.h);
  const k = screen.tum ? Ekranlar.olcek({ w, h }, maxWidth) : Math.min(1, maxWidth / w);
  return { x: screen.x, y: screen.y, w, h, outW: k < 1 ? even(w * k) : w, outH: k < 1 ? even(h * k) : h };
}

// ffmpeg gdigrab'ın giriş argümanları (testler de aynı argümanlarla kare alır).
function gdigrabArgs(p) {
  return ['-f', 'gdigrab', '-framerate', String(p.fps), '-draw_mouse', '1',
    '-offset_x', String(p.x), '-offset_y', String(p.y), '-video_size', `${p.w}x${p.h}`, '-i', 'desktop'];
}

class VideoManager {
  constructor({ onFail }) {
    this.streams = new Map();
    this.onFail = onFail;
  }

  get available() {
    return !!currentEncoder();
  }

  get encoderLabel() {
    return currentEncoder()?.label || null;
  }

  // screen: { x, y, w, h }, opts: { maxWidth, fps, kbps }
  subscribe(ws, screen, opts) {
    const p = { ...grabRegion(screen, opts.maxWidth), fps: opts.fps, kbps: opts.kbps };
    const key = JSON.stringify(p);
    // Zaten aynı akıştaysa yeniden başlatma (ekran düzeni denetimi her değişiklikte çağırır; bölgesi değişmeyen akış sürsün).
    if (ws.vStream && ws.vStream.key === key && !ws.vStream.stopped) return;
    this.unsubscribe(ws);
    let s = this.streams.get(key);
    if (!s) { s = new VideoStream(this, key, p); this.streams.set(key, s); }
    if (s.stopped) return;
    ws.vStream = s;
    ws.vWaitKey = true;
    ws.vCodec = null;
    s.subs.add(ws);
  }

  unsubscribe(ws) {
    const s = ws.vStream;
    if (!s) return;
    ws.vStream = null;
    s.subs.delete(ws);
    if (s.subs.size === 0) s.stop();
  }

  requestKeyframe(ws) {
    ws.vWaitKey = true;
    ws.vCodec = null;
  }
}

module.exports = { VideoManager, detectEncoders, ffmpegPath: () => FFMPEG, grabRegion, gdigrabArgs, CHILD_ENV };
