// Gizlilik perdesi testi.
// Kanıtlanan: perde (SetWindowDisplayAffinity ile yakalamadan hariç) açıkken ne RemoteHelper'ın
// JPEG yakalamasında ne de ffmpeg gdigrab H.264 akışında GÖRÜNMÜYOR. Ölçümün anlamlı olduğunu
// kanıtlamak için önce "yakalamaya görünür" (hariç tutulmayan) siyah bir perdenin kareyi gerçekten
// kararttığı gösterilir. Gerçek fare/klavye/kalem girdisi enjekte EDİLMEZ. Perde sonunda kesinlikle kapatılır.
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const WebSocket = require(path.join(ROOT, 'node_modules', 'ws'));
const ffmpeg = require(path.join(ROOT, 'node_modules', 'ffmpeg-static'));
const { Helper, buildExe } = require(path.join(ROOT, 'lib', 'helper'));
const PERDE_EXE = path.join(ROOT, 'helper', 'Perde.exe');
const URL = `ws://localhost:${process.env.TEST_PORT || 3999}`;
const CHILD_ENV = { ...process.env, __COMPAT_LAYER: 'HighDpiAware' }; // gdigrab fiziksel piksel

let fails = 0;
const check = (n, c, x = '') => { console.log(`${c ? 'OK  ' : 'FAIL'} ${n} ${x}`); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function killTree(pid) { if (pid) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }); }

// Perde.exe'yi açar; ilk JSON satırını (ok:true/false) döner. Süreci ve pid'i verir.
function perdeAc(args) {
  return new Promise((resolve) => {
    const p = spawn(PERDE_EXE, args, { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
    let buf = '';
    let done = false;
    const fin = (sonuc) => { if (!done) { done = true; clearTimeout(t); resolve({ p, ...sonuc }); } };
    const t = setTimeout(() => fin({ ok: false, hata: 'zaman aşımı' }), 8000);
    p.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const satir = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!satir) continue;
        try { const m = JSON.parse(satir); if (typeof m.ok === 'boolean') fin(m); } catch {}
      }
    });
    p.on('error', (e) => fin({ ok: false, hata: e.message }));
    p.on('exit', () => fin({ ok: false, hata: 'çıktı' }));
  });
}

async function perdeKapat(h) {
  if (!h || !h.p) return;
  try { if (h.p.stdin.writable) h.p.stdin.end('kapat\n'); } catch {}
  await sleep(300);
  killTree(h.p.pid);
}

// Gri ham kareden ölçüm: ortalama parlaklık ve siyah olmayan piksel oranı.
function olc(gray) {
  if (!gray || !gray.length) return null;
  let sum = 0, nonblack = 0;
  for (let i = 0; i < gray.length; i++) { sum += gray[i]; if (gray[i] > 24) nonblack++; }
  return { mean: sum / gray.length, nonblack: nonblack / gray.length, n: gray.length };
}

// Bir JPEG tamponunu ffmpeg ile küçültüp gri ham veriye çözer.
function jpegOlc(jpeg) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
    '-vf', 'scale=200:-2,format=gray', '-f', 'rawvideo', '-'],
    { input: jpeg, maxBuffer: 16 * 1024 * 1024 });
  return r.status === 0 ? olc(r.stdout) : null;
}

// gdigrab ile bir ekran bölgesini yakalar, H.264'e (libx264) kodlar, geri çözer, ölçer.
function gdigrabH264Olc(sc) {
  const tmp = path.join(os.tmpdir(), `rc-perde-${process.pid}-${Date.now()}.h264`);
  try {
    const cap = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error',
      '-f', 'gdigrab', '-framerate', '15', '-offset_x', String(sc.x), '-offset_y', String(sc.y),
      '-video_size', `${sc.w}x${sc.h}`, '-i', 'desktop', '-frames:v', '12',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-f', 'h264', '-y', tmp],
      { env: CHILD_ENV, maxBuffer: 16 * 1024 * 1024, timeout: 30000 });
    if (cap.status !== 0 || !fs.existsSync(tmp)) return null;
    const dec = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', tmp,
      '-frames:v', '1', '-vf', 'scale=200:-2,format=gray', '-f', 'rawvideo', '-'],
      { maxBuffer: 16 * 1024 * 1024 });
    return dec.status === 0 ? olc(dec.stdout) : null;
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

(async () => {
  let helper, visible, real;
  try {
    buildExe('Perde', { target: 'winexe' });
    helper = new Helper();
    const info = await helper.info();
    const sc = info.screens.find((s) => s.primary) || info.screens[0];
    check('ana ekran bulundu', !!sc, sc ? `${sc.name} ${sc.w}x${sc.h}` : '');
    if (!sc) throw new Error('ekran yok');

    // JPEG yakalaması için yardımcıdan taban kare al (ekranın o anki hali).
    const jpegAl = () => helper.request(`cap 80 800 ${sc.name}`);
    const taban = jpegOlc(await jpegAl());
    check('taban kare çözüldü (JPEG)', !!taban, taban ? `nonblack=${(taban.nonblack * 100).toFixed(0)}%` : '');
    if (!taban) throw new Error('taban ölçülemedi');

    const anlamli = taban.nonblack > 0.05; // masaüstü neredeyse tamamen siyahsa oran testleri anlamsız

    // 1) DUYARLILIK: yakalamaya GÖRÜNÜR (hariç tutulmayan) siyah perde kareyi karartmalı.
    visible = await perdeAc(['--yakalamaya-goster']);
    check('görünür test perdesi açıldı', visible.ok, visible.hata || '');
    if (visible.ok) {
      await sleep(700);
      const g = jpegOlc(await jpegAl());
      if (anlamli && g) {
        check('ölçüm duyarlı: görünür perde JPEG karesini karartıyor',
          g.nonblack < taban.nonblack * 0.5, `taban ${(taban.nonblack * 100).toFixed(0)}% -> perde ${(g.nonblack * 100).toFixed(0)}%`);
      } else {
        check('ölçüm duyarlılığı (masaüstü zaten karanlık, atlandı)', true, g ? `nonblack=${(g.nonblack * 100).toFixed(0)}%` : 'ölçülemedi');
      }
    }
    await perdeKapat(visible); visible = null;
    await sleep(400);

    // Taban kareyi perde kapandıktan sonra tazele (ekran değişmiş olabilir).
    const taban2 = jpegOlc(await jpegAl()) || taban;

    // 2) GERÇEK perde: yakalamadan hariç; ne JPEG'de ne H.264'te görünmemeli.
    real = await perdeAc([]);
    check('gerçek perde açıldı (yakalamadan hariç)', real.ok, real.hata || '');
    if (real.ok) {
      const pencere = (real.pencereler || [])[0] || {};
      const WS_EX_TRANSPARENT = 0x20;
      check('perde tıklama-geçirgen (tasarım gereği tıklama alttaki pencereye gider)',
        (pencere.exstyle & WS_EX_TRANSPARENT) !== 0 && pencere.tiklamaGecer === true,
        `exstyle=0x${(pencere.exstyle >>> 0).toString(16)} tiklamaGecer=${pencere.tiklamaGecer}`);
      check('perde pencereleri WDA_EXCLUDEFROMCAPTURE (0x11) ile işaretli',
        (real.pencereler || []).every((w) => w.affinity === 0x11));

      await sleep(700);
      const gJpeg = jpegOlc(await jpegAl());
      const gH264 = gdigrabH264Olc(sc);
      if (anlamli) {
        check('gerçek perde RemoteHelper JPEG yakalamasında GÖRÜNMÜYOR',
          gJpeg && gJpeg.nonblack > taban2.nonblack * 0.7,
          gJpeg ? `taban ${(taban2.nonblack * 100).toFixed(0)}% -> ${(gJpeg.nonblack * 100).toFixed(0)}%` : 'ölçülemedi');
        check('gerçek perde ffmpeg gdigrab H.264 akışında GÖRÜNMÜYOR',
          gH264 && gH264.nonblack > taban2.nonblack * 0.7,
          gH264 ? `taban ${(taban2.nonblack * 100).toFixed(0)}% -> ${(gH264.nonblack * 100).toFixed(0)}%` : 'ölçülemedi');
      } else {
        // Masaüstü karanlık: en azından çözüm başarılı ve kare tamamen siyah DEĞİL diye bakılamaz; bilgi ver.
        check('gerçek perde yakalama ölçümü (masaüstü karanlık, yalnızca çözüm doğrulandı)', !!gJpeg && !!gH264,
          `JPEG nonblack=${gJpeg ? (gJpeg.nonblack * 100).toFixed(0) : '?'}% H264 nonblack=${gH264 ? (gH264.nonblack * 100).toFixed(0) : '?'}%`);
      }
    }
    await perdeKapat(real); real = null;

    // 3) Sunucu özelliği (features/perde.js) protokolü: izleme yokken açılamaz.
    await wsProtokol();
  } catch (e) {
    console.error('TEST HATASI', e);
    fails++;
  } finally {
    await perdeKapat(visible);
    await perdeKapat(real);
    try { if (helper && helper.proc) killTree(helper.proc.pid); } catch {}
  }
  console.log(fails ? `\n${fails} HATA` : '\nhepsi geçti');
  process.exit(fails ? 1 : 0);
})();

// WebSocket üzerinden features/perde.js davranışı: izleme başlamadan perde açılamaz; durum sorgulanabilir.
function wsProtokol() {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL);
    const bekle = [];
    const next = (pred, ms = 8000) => new Promise((res, rej) => {
      const w = { pred, res }; bekle.push(w);
      w.timer = setTimeout(() => { const i = bekle.indexOf(w); if (i >= 0) bekle.splice(i, 1); rej(new Error('timeout')); }, ms);
    });
    const kuyruk = [];
    ws.on('message', (d, bin) => {
      if (bin) return;
      const m = JSON.parse(d.toString());
      const i = bekle.findIndex((w) => w.pred(m));
      if (i >= 0) { const w = bekle.splice(i, 1)[0]; clearTimeout(w.timer); w.res(m); } else kuyruk.push(m);
    });
    const take = (pred, ms) => { const i = kuyruk.findIndex(pred); return i >= 0 ? Promise.resolve(kuyruk.splice(i, 1)[0]) : next(pred, ms); };
    const send = (o) => ws.send(JSON.stringify(o));
    (async () => {
      try {
        const hello = await take((m) => m.t === 'hello');
        send(hello.canSetup ? { t: 'setup', username: 'perde', password: 'perde1234' }
          : { t: 'login', username: 'perde', password: 'perde1234' });
        const auth = await take((m) => m.t === 'auth');
        check('WS: giriş yapıldı', auth.ok);
        // İzleme başlatılmadan perde açma isteği hata ile reddedilmeli (perdeyi fiilen açmaz).
        send({ t: 'perde', acik: true });
        const d1 = await take((m) => m.t === 'perde-durum');
        check('WS: izleme yokken perde açılamaz', d1.acik === false && !!d1.hata, d1.hata || '');
        send({ t: 'perde-sorgu' });
        const d2 = await take((m) => m.t === 'perde-durum');
        check('WS: perde durumu sorgulanabilir (kapalı)', d2.acik === false);
      } catch (e) {
        check('WS: protokol', false, e.message);
      } finally {
        try { ws.close(); } catch {}
        resolve();
      }
    })();
  });
}
