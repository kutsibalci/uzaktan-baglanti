// Veri sayacı ve "Veri tasarrufu" (sunucu tarafı):
// - Veri tasarrufu ayarları gelince sunucu H.264 kodlayıcısını (ffmpeg) doğru argümanlarla yeniden başlatıyor mu
//   (uzun kenar 1280, 15 fps, en fazla 500 kbps) — sunucunun alt sürecinin GERÇEK komut satırından okunur.
// - Bayt karşılaştırması: aynı (gerçek) ekran, H.264 "Orta" ile "Veri tasarrufu"; ayrıca aynı ffmpeg argümanlarıyla
//   sürekli hareketli sentetik görüntü (lavfi testsrc2; kullanıcının ekranında pencere açılmaz, girdi yok).
// - Ses: dinleyen Veri tasarrufuna geçince Opus 96 → 32 kbps (ffmpeg yeniden başlar). Hoparlörden ses çalınmaz.
// - HTTP baytları (dosya indirme/yükleme) sunucuda sayılıp 'veri-http' ile bildiriliyor mu (±%1).
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawnSync, execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const WebSocket = require(path.join(ROOT, 'node_modules', 'ws'));
const FFMPEG = require(path.join(ROOT, 'node_modules', 'ffmpeg-static'));
const PORT = process.env.TEST_PORT || 3999;
const TASARRUF = { quality: 35, maxWidth: 1280, fps: 15, kbps: 500 };   // public/app.js QUALITY.tasarruf ile aynı
const ORTA = { quality: 60, maxWidth: 1920, fps: 30, kbps: 4000 };      // public/app.js QUALITY.mid
const OLCUM_SN = Number(process.env.VERI_OLCUM_SN || 12);

let fails = 0;
const check = (n, c, x = '') => { console.log(`${c ? 'OK  ' : 'FAIL'} ${n} ${x}`); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mbSaat = (bayt, sn) => (bayt / sn) * 3600 / 1e6;

function client() {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  const queue = [], waiters = [];
  const c = { ws, video: 0, ses: 0, auth: null };
  ws.on('message', (d, bin) => {
    if (bin) { if (d[0] === 2 || d[0] === 1) c.video += d.length; else if (d[0] === 3) c.ses += d.length; return; }
    const m = JSON.parse(d.toString());
    if (m.t === 'hello') ws.send(JSON.stringify(m.canSetup ? { t: 'setup', username: 'test', password: 'test1234' } : { t: 'login', username: 'test', password: 'test1234' }));
    if (m.t === 'auth' && m.ok) c.auth = m;
    const i = waiters.findIndex((w) => w.pred(m));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(m); else queue.push(m);
  });
  c.next = (pred, ms = 15000) => {
    const i = queue.findIndex(pred);
    if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
    return new Promise((resolve, reject) => { waiters.push({ pred, resolve }); setTimeout(() => reject(new Error('zaman aşımı')), ms); });
  };
  c.drop = (pred) => { for (let i = queue.length - 1; i >= 0; i--) if (pred(queue[i])) queue.splice(i, 1); };
  c.send = (o) => ws.send(JSON.stringify(o));
  return c;
}
const t = (type) => (m) => m.t === type;

function serverPid() {
  const out = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' });
  const line = out.split(/\r?\n/).find((l) => /LISTENING/.test(l) && new RegExp(`:${PORT}\\s`).test(l));
  return line ? Number(line.trim().split(/\s+/).pop()) : null;
}
// Sunucunun alt süreçleri, komut satırlarıyla (yalnızca okunur).
function children(pid) {
  const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    `[Console]::OutputEncoding = [Text.Encoding]::UTF8; @(Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | Select-Object ProcessId,Name,CommandLine) | ConvertTo-Json -Compress`], { encoding: 'utf8' });
  const r = JSON.parse(out || '[]');
  return Array.isArray(r) ? r : [r];
}
// Windows komut satırını argümanlara böler (ffmpeg argümanlarında yalnızca tırnaklı yol olur).
function splitArgs(s) {
  const out = [];
  let cur = '', q = false, any = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') { q = !q; any = true; continue; }
    if (ch === ' ' && !q) { if (any || cur) out.push(cur); cur = ''; any = false; continue; }
    cur += ch;
  }
  if (any || cur) out.push(cur);
  return out;
}
const arg = (a, k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };

async function ffmpegBekle(pid, pred, ms = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const f = children(pid).filter((x) => /^ffmpeg\.exe$/i.test(x.Name) && x.CommandLine && pred(x.CommandLine));
    if (f.length) return f.map((x) => ({ pid: x.ProcessId, args: splitArgs(x.CommandLine).slice(1) }));
    await sleep(300);
  }
  return [];
}

// Aynı kodlayıcı argümanlarıyla sürekli hareketli sentetik görüntü (gdigrab yerine lavfi), gerçek zamanlı.
function sentetik(args, sn) {
  const i = args.indexOf('-f');
  const j = args.indexOf('-i', i);
  const fps = arg(args, '-framerate');
  const boyut = arg(args, '-video_size');
  const a = [...args.slice(0, i), '-re', '-f', 'lavfi', '-i', `testsrc2=s=${boyut}:r=${fps}`, '-t', String(sn), ...args.slice(j + 2)];
  const r = spawnSync(FFMPEG, a, { maxBuffer: 1 << 28, timeout: (sn + 20) * 1000, windowsHide: true });
  return r.stdout ? r.stdout.length : 0;
}

function istek(method, yol, token, govde) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: 'localhost', port: PORT, method, path: yol, headers: { 'X-Oturum': token, ...(govde ? { 'Content-Length': govde.length } : {}) } }, (res) => {
      let n = 0;
      res.on('data', (d) => { n += d.length; });
      res.on('end', () => resolve({ status: res.statusCode, n }));
    });
    req.on('error', reject);
    req.end(govde);
  });
}

(async () => {
  const pid = serverPid();
  check('sunucu PID bulundu', !!pid, `(${pid})`);
  const c = client();
  await c.next(t('auth'));

  // ---------- HTTP baytları ----------
  const BOYUT = 2_000_000;
  fs.writeFileSync(path.join(process.env.TEST_TMP, 'kok', 'veri-deneme.bin'), Buffer.alloc(BOYUT, 7));
  const ind = await istek('GET', '/api/dosya/indir?yol=veri-deneme.bin', c.auth.http);
  check('dosya indirildi', ind.status === 200 && ind.n === BOYUT, `(${ind.status}, ${ind.n})`);
  let vh = await c.next(t('veri-http'), 5000).catch(() => null);
  check('indirme baytları sunucuda sayıldı (veri-http, gövde ±%1, başlık dahil)', vh && vh.gonderilen >= BOYUT && vh.gonderilen <= BOYUT * 1.01, JSON.stringify(vh));
  const YUK = 1_000_000;
  const yuk = await istek('POST', '/api/dosya/yukle?ad=veri-yukleme.bin', c.auth.http, Buffer.alloc(YUK, 9));
  check('dosya yüklendi', yuk.status === 200, `(${yuk.status})`);
  const once = vh || { alinan: 0, gonderilen: 0 };
  vh = await c.next(t('veri-http'), 5000).catch(() => null);
  const yuklenen = vh ? vh.alinan - once.alinan : 0;
  check('yükleme baytları sunucuda sayıldı (±%1)', yuklenen >= YUK && yuklenen <= YUK * 1.01, `(${yuklenen} bayt)`);
  const yetkisiz = await istek('GET', '/api/dosya/indir?yol=veri-deneme.bin', 'yanlis');
  await sleep(500);
  c.drop(t('veri-http'));
  check('oturumsuz istek reddedildi ve sayılmadı', yetkisiz.status === 401);

  // ---------- H.264: Veri tasarrufu → ffmpeg argümanları ----------
  c.send({ t: 'start', mode: 'control', codecs: ['h264', 'jpeg'] });
  const started = await c.next(t('started'));
  if (started.codec !== 'h264') {
    console.log(`OK   H.264 kodlayıcı yok (${started.codec}), kodlayıcı testleri atlandı`);
  } else {
    const ekran = started.screens.find((s) => s.name === started.screen) || {};
    c.send({ t: 'settings', ...TASARRUF });
    const vcT = await c.next(t('vconfig'));
    const [ffT] = await ffmpegBekle(pid, (cl) => /gdigrab/.test(cl) && /-maxrate 500k/.test(cl));
    check('Veri tasarrufu: ffmpeg yeniden başladı', !!ffT, ffT ? '' : JSON.stringify(children(pid).map((x) => x.CommandLine)));
    if (ffT) {
      const a = ffT.args;
      const vf = arg(a, '-vf') || '';
      const olcek = vf.match(/scale=(\d+):(\d+)/);
      const uzun = olcek ? Math.max(Number(olcek[1]), Number(olcek[2])) : Math.max(...(arg(a, '-video_size') || '0x0').split('x').map(Number));
      check('Veri tasarrufu: 15 fps yakalama', arg(a, '-framerate') === '15', `(-framerate ${arg(a, '-framerate')})`);
      check('Veri tasarrufu: uzun kenar ≤ 1280 (ölçekleme)', uzun <= 1280, `(-video_size ${arg(a, '-video_size')}, -vf ${vf})`);
      check('Veri tasarrufu: en fazla 500 kbps (maxrate), tampon 250k', arg(a, '-maxrate') === '500k' && arg(a, '-bufsize') === '250k', `(${arg(a, '-c:v')} -maxrate ${arg(a, '-maxrate')} -bufsize ${arg(a, '-bufsize')} -cq ${arg(a, '-cq')})`);
      check('Veri tasarrufu: anahtar kare aralığı 2 sn (-g 30)', arg(a, '-g') === '30');
      check('vconfig küçük boyutu bildirdi', Math.max(vcT.w, vcT.h) <= 1280, `(${vcT.w}x${vcT.h}, ekran ${ekran.w}x${ekran.h})`);
    }
    await sleep(1500);
    let b0 = c.video;
    await sleep(OLCUM_SN * 1000);
    const baytT = c.video - b0;

    c.send({ t: 'settings', ...ORTA });
    await c.next(t('vconfig'));
    const [ffO] = await ffmpegBekle(pid, (cl) => /gdigrab/.test(cl) && /-maxrate 4000k/.test(cl));
    check('Orta: ffmpeg 30 fps / 4000 kbps ile yeniden başladı', !!ffO && arg(ffO.args, '-framerate') === '30');
    const eskiKaldi = ffT && children(pid).some((x) => x.ProcessId === ffT.pid);
    check('eski (tasarruf) ffmpeg kapandı', !eskiKaldi);
    await sleep(1500);
    b0 = c.video;
    await sleep(OLCUM_SN * 1000);
    const baytO = c.video - b0;
    console.log(`     ÖLÇÜM gerçek ekran (${OLCUM_SN} sn, büyük olasılıkla durağan): Orta ${(baytO / 1e6).toFixed(2)} MB ≈ ${mbSaat(baytO, OLCUM_SN).toFixed(0)} MB/saat · `
      + `Veri tasarrufu ${(baytT / 1e6).toFixed(2)} MB ≈ ${mbSaat(baytT, OLCUM_SN).toFixed(0)} MB/saat`);
    check('gerçek ekranda Veri tasarrufu Orta\'dan az veri harcadı', baytT < baytO, `(${baytT} < ${baytO})`);
    check('gerçek ekranda Veri tasarrufu saatte ≤ 250 MB', mbSaat(baytT, OLCUM_SN) <= 250);

    // Sürekli hareketli içerik (en kötü durum): sunucunun kullandığı argümanların aynısı, girişi lavfi
    if (ffT && ffO) {
      const SN = 8;
      const sT = sentetik(ffT.args, SN), sO = sentetik(ffO.args, SN);
      console.log(`     ÖLÇÜM sürekli hareketli sentetik (${SN} sn, testsrc2): Orta ${(sO / 1e6).toFixed(2)} MB ≈ ${mbSaat(sO, SN).toFixed(0)} MB/saat · `
        + `Veri tasarrufu ${(sT / 1e6).toFixed(2)} MB ≈ ${mbSaat(sT, SN).toFixed(0)} MB/saat`);
      check('hareketli içerikte Veri tasarrufu saatte ≤ 250 MB (görüntü)', sT > 0 && mbSaat(sT, SN) <= 250, `(${mbSaat(sT, SN).toFixed(0)} MB/saat)`);
      check('hareketli içerikte Veri tasarrufu Orta\'nın en fazla 1/4\'ü', sT > 0 && sO > 0 && sT * 4 <= sO);
    }
    c.send({ t: 'stop' });
  }

  // ---------- Ses: Veri tasarrufu → Opus 32 kbps ----------
  c.send({ t: 'ses', acik: true });
  const sc = await c.next((m) => m.t === 'ses-config' || m.t === 'ses-durum');
  if (sc.t !== 'ses-config') {
    console.log(`OK   ses kullanılamıyor (${sc.msg}), ses testi atlandı`);
  } else {
    const [s96] = await ffmpegBekle(pid, (cl) => /libopus/.test(cl));
    check('ses: normalde Opus 96 kbps', s96 && arg(s96.args, '-b:a') === '96k', s96 ? `(-b:a ${arg(s96.args, '-b:a')})` : '');
    c.send({ t: 'veri-tasarruf', acik: true });
    const [s32] = await ffmpegBekle(pid, (cl) => /libopus/.test(cl) && /-b:a 32k/.test(cl));
    check('ses: Veri tasarrufunda Opus 32 kbps ile yeniden başladı', !!s32);
    await sleep(1500);
    const a0 = c.ses;
    await sleep(3000);
    check('ses: yeniden başladıktan sonra paketler geliyor', c.ses - a0 > 0, `(${c.ses - a0} bayt / 3 sn ≈ ${mbSaat(c.ses - a0, 3).toFixed(0)} MB/saat)`);
    c.send({ t: 'veri-tasarruf', acik: false });
    const [geri] = await ffmpegBekle(pid, (cl) => /libopus/.test(cl) && /-b:a 96k/.test(cl));
    check('ses: tasarruf kapanınca 96 kbps\'e döndü', !!geri);
    c.send({ t: 'ses', acik: false });
  }

  c.ws.close();
  await sleep(300);
  console.log(fails ? `${fails} HATA` : 'hepsi geçti');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL', e.stack); process.exit(1); });
