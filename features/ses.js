// Bilgisayar sesini uzaktaki cihaza aktarma.
// Zincir: Ses.exe (WASAPI loopback -> s16le 48 kHz stereo) | ffmpeg (Opus, Ogg) -> Ogg ayrıştırma
// -> her Opus paketi ikili mesaj [3][paket] olarak abonelere gider. Abone yokken hiçbir süreç çalışmaz.
const fs = require('fs');
const { spawn } = require('child_process');
const { spawnHelper, engelli, engeller } = require('../lib/helper');
const olaylar = require('../lib/olaylar');

let FFMPEG = null;
try { FFMPEG = require('ffmpeg-static'); } catch { /* paket yok */ }
if (FFMPEG && !fs.existsSync(FFMPEG)) FFMPEG = null;

const CONFIG = { t: 'ses-config', sampleRate: 48000, channels: 2, codec: 'opus' };
const SEND_LIMIT = 256 * 1024; // istemcinin kuyruğu bundan büyükse paket atılır (ses için kabul edilebilir)
const HEADER = Buffer.from([3]);
const MAX_PACKET = 64 * 1024;          // bozuk akışa karşı paket sınırı
// Opus bit hızı: dinleyenlerin hepsi Veri tasarrufundaysa (features/veri.js, ws.veriTasarruf) 32 kbps (saatte ~14 MB), yoksa 96 kbps.
const KBPS = { normal: 96, tasarruf: 32 };

// Ogg akışından paketleri çıkarır. Sayfa sınırında bölünen (255'lik segmentlerle devam eden) paketler birleştirilir.
class OggReader {
  constructor(onPacket) {
    this.onPacket = onPacket;
    this.buf = Buffer.alloc(0);
    this.partial = null; // önceki sayfadan devam eden paket parçaları
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.buf.length < 27) return;
      if (this.buf.readUInt32BE(0) !== 0x4f676753) { // "OggS" değilse eşitlemeyi yeniden bul
        const i = this.buf.indexOf('OggS', 1);
        this.partial = null;
        this.buf = i < 0 ? this.buf.subarray(Math.max(0, this.buf.length - 3)) : this.buf.subarray(i);
        continue;
      }
      const nsegs = this.buf[26];
      if (this.buf.length < 27 + nsegs) return;
      let dataLen = 0;
      for (let i = 0; i < nsegs; i++) dataLen += this.buf[27 + i];
      const total = 27 + nsegs + dataLen;
      if (this.buf.length < total) return;
      this.page(this.buf.subarray(0, total), nsegs);
      this.buf = this.buf.subarray(total);
    }
  }

  page(p, nsegs) {
    const continued = (p[5] & 0x01) !== 0;
    // Devam sayfası beklenirken gelmediyse (ya da tersi) yarım paketi at.
    if (!continued) this.partial = null;
    let skipFirst = continued && !this.partial; // başını görmediğimiz paketin kalanı
    let off = 27 + nsegs;
    let parts = this.partial || [];
    let size = parts.reduce((n, b) => n + b.length, 0);
    for (let i = 0; i < nsegs; i++) {
      const len = p[27 + i];
      const seg = p.subarray(off, off + len);
      off += len;
      if (!skipFirst) { parts.push(seg); size += len; }
      if (len < 255) { // paket bitti
        if (!skipFirst && size <= MAX_PACKET) this.onPacket(Buffer.concat(parts, size));
        skipFirst = false;
        parts = [];
        size = 0;
      }
    }
    // Son segment 255 ise paket bir sonraki sayfada sürer (kopyalanır: alttaki tampon değişebilir).
    this.partial = parts.length && size <= MAX_PACKET ? [Buffer.from(Buffer.concat(parts, size))] : null;
  }
}

module.exports.init = (api) => {
  let exe = null;
  let buildError = null;
  try { exe = api.buildExe('Ses', { refs: [] }); } catch (e) { buildError = e.message; api.log('Ses.exe derlenemedi:', e.message); }

  const subs = new Set();
  let chain = null;        // { ses, ff, stopped }
  let restarts = 0;
  let restartTimer = null;

  const available = () => !!exe && !!FFMPEG && !engelli('Ses');
  const reason = () => (!FFMPEG ? 'ffmpeg bulunamadı.' : buildError ? 'Ses yardımcı programı derlenemedi.' : engeller.get('Ses')?.mesaj || '');

  function start() {
    if (chain || !subs.size || !available()) return;
    const ses = spawnHelper('Ses', exe, [], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    if (!ses) {
      // Windows engelledi: bir daha denenmez, dinleyenlere söylenir.
      for (const ws of subs) api.sendJson(ws, { t: 'ses-durum', acik: false, msg: `Ses aktarılamıyor: ${reason()}` });
      subs.clear();
      return;
    }
    const kbps = wantedKbps();
    const c = { stopped: false, headers: 0, packets: 0, startedAt: Date.now(), kbps };
    chain = c;
    c.ses = ses;
    c.ff = spawn(FFMPEG, [
      '-hide_banner', '-loglevel', 'error',
      '-f', 's16le', '-ar', '48000', '-ac', '2', '-i', '-',
      '-c:a', 'libopus', '-b:a', `${kbps}k`, '-application', 'lowdelay', '-frame_duration', '20',
      '-flush_packets', '1', '-page_duration', '20000', // her paket hemen kendi sayfasında çıksın (varsayılan 1 sn bekler)
      '-f', 'ogg', '-',
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    api.log(`başladı (${kbps} kbps, Ses.exe pid ${c.ses.pid}, ffmpeg pid ${c.ff.pid})`);

    c.ses.stdout.pipe(c.ff.stdin);
    c.ff.stdin.on('error', () => {}); // ffmpeg kapanınca EPIPE
    c.ses.stdout.on('error', () => {});
    let sesErr = '', ffErr = '';
    c.ses.stderr.on('data', (d) => { sesErr = (sesErr + d).slice(-1000); });
    c.ff.stderr.on('data', (d) => { ffErr = (ffErr + d).slice(-1000); });

    const ogg = new OggReader((pkt) => onPacket(c, pkt));
    c.ff.stdout.on('data', (d) => ogg.push(d));

    const onExit = (who) => (code) => {
      if (c.stopped) return;
      const last = (who === 'Ses.exe' ? sesErr : ffErr).trim().split('\n').pop() || '';
      api.log(`${who} beklenmedik şekilde kapandı (kod ${code}) ${last}`);
      stop();
      if (!subs.size) return;
      // Çalışıp sonra düştüyse sayaç sıfırlanır; hemen düşmeye devam ederse vazgeç.
      if (Date.now() - c.startedAt > 10000) restarts = 0;
      if (++restarts > 5) {
        for (const ws of subs) api.sendJson(ws, { t: 'ses-durum', acik: false, msg: 'Ses akışı başlatılamadı.' });
        subs.clear();
        return;
      }
      restartTimer = setTimeout(() => { restartTimer = null; start(); }, 1000);
    };
    c.ses.on('exit', onExit('Ses.exe'));
    c.ff.on('exit', onExit('ffmpeg'));
    c.ses.on('error', (e) => api.log('Ses.exe başlatılamadı:', e.message));
    c.ff.on('error', (e) => api.log('ffmpeg başlatılamadı:', e.message));
  }

  function onPacket(c, pkt) {
    if (c.stopped) return;
    // İlk iki paket Opus başlıklarıdır (OpusHead, OpusTags) — tarayıcıdaki çözücüye gerekmez.
    if (c.headers < 2) { c.headers++; return; }
    c.packets++;
    const msg = Buffer.concat([HEADER, pkt]);
    for (const ws of subs) {
      if (ws.readyState !== 1 || ws.bufferedAmount > SEND_LIMIT) continue;
      ws.send(msg, { binary: true });
    }
  }

  function stop() {
    clearTimeout(restartTimer);
    restartTimer = null;
    const c = chain;
    if (!c) return;
    chain = null;
    c.stopped = true;
    c.ses.stdout.unpipe();
    // Önce Ses.exe: stdout'u kapanınca kendisi de çıkar; ffmpeg girişi bitince kapanır. Yine de ikisi de öldürülür.
    try { c.ses.kill(); } catch { /* zaten kapalı */ }
    try { c.ff.stdin.destroy(); } catch { /* zaten kapalı */ }
    try { c.ff.kill(); } catch { /* zaten kapalı */ }
    api.log(`durdu (${c.packets} paket)`);
  }

  const wantedKbps = () => ([...subs].every((ws) => ws.veriTasarruf) ? KBPS.tasarruf : KBPS.normal);
  // Bit hızı değişmesi gerekiyorsa zincir yeniden başlatılır (kısa bir kesinti olur).
  function retune() {
    if (chain && subs.size && chain.kbps !== wantedKbps()) { stop(); start(); }
  }
  olaylar.on('veri-tasarruf', (ws) => { if (subs.has(ws)) retune(); });

  function unsubscribe(ws) {
    if (!subs.delete(ws)) return;
    if (!subs.size) { restarts = 0; stop(); } else retune();
  }

  api.on('ses', async (ws, m) => {
    if (m.acik === true) {
      if (!available()) { api.sendJson(ws, { t: 'ses-durum', acik: false, msg: `Ses aktarılamıyor: ${reason()}` }); return; }
      subs.add(ws);
      api.sendJson(ws, CONFIG);
      retune();
      start();
    } else {
      unsubscribe(ws);
    }
  }); // giriş yapmış herkes (salt izleme dahil) dinleyebilir

  api.onClose((ws) => unsubscribe(ws));

  // Sunucu kapanırken alt süreçler ortada kalmasın.
  process.on('exit', stop);

  api.adminData(async () => ({
    ses: {
      kullanilabilir: available(),
      neden: reason(),
      dinleyen: subs.size,
      calisiyor: !!chain,
      pid: chain ? [chain.ses.pid, chain.ff.pid] : [],
      kbps: chain ? chain.kbps : null,
    },
  }));
};

module.exports.OggReader = OggReader; // test için
