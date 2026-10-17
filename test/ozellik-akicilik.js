// @ortam REMOTE_TEST_DEGISEN=3000/1000
// Akıcılık ölçümü (JPEG yolu, HTTP'den bağlanan telefon gibi): kare aralığı dağılımı, takılma, gecikme, kare boyutu, ack süresi.
// Ekran: REMOTE_TEST_DEGISEN ile yardımcı program yakalanan görüntüyü 3 sn kaydırıp 1 sn durduruyor (helper/RemoteHelper.cs).
// Kullanıcının ekranına hiçbir şey açılmaz, girdi gönderilmez. Durağan anlarda sunucu kare göndermez (bu takılma değildir):
// sunucunun 'durgun' bildiriminden sonraki ilk aralık istatistiğe katılmaz.
// Wi-Fi taklidi istemci tarafında: sunucudan gelen her mesaj (kare, JSON, WebSocket ping) sırayla, bant genişliği kadar
// sürede "iletilir", üstüne tek yön gecikme + rastgele sapma (+ arada ani sıçrama) eklenir; ack ve pong da tek yön gecikmeyle döner.
// Telefonun JPEG çözmesi kare boyutuyla orantılı bir süre olarak eklenir. Rastgelelik tohumludur (her çalıştırmada aynı desen).
// Elle uzun ölçüm:  $env:AKICILIK_SURE='20000'; $env:TEST_PORT='3204'; node test/calistir.js ozellik-akicilik
const path = require('path');
const ROOT = path.join(__dirname, '..');
const WebSocket = require(path.join(ROOT, 'node_modules', 'ws'));
const PORT = process.env.TEST_PORT || 3999;
const SURE = Number(process.env.AKICILIK_SURE) || 8000; // senaryo başına ölçüm süresi (ms), ısınma hariç
const ISINMA = 1500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();

let pass = 0, fail = 0;
const check = (n, c, x = '') => { console.log(`${c ? 'OK  ' : 'FAIL'} ${n} ${x}`); c ? pass++ : fail++; };

// Tohumlu rastgele sayı (mulberry32)
function rastgele(tohum) {
  let a = tohum >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Windows'ta Node zamanlayıcıları ~15.6 ms adımlıdır; taklit gecikmelerinin doğru olması için son kısımda setImmediate ile beklenir.
const kuyruk = []; // { at, fn } (at'e göre sıralı)
let pompa = false;
function zamanla(at, fn) {
  let i = kuyruk.length;
  while (i > 0 && kuyruk[i - 1].at > at) i--;
  kuyruk.splice(i, 0, { at, fn });
  if (!pompa) { pompa = true; setImmediate(pompala); }
}
function pompala() {
  const t = now();
  while (kuyruk.length && kuyruk[0].at <= t) kuyruk.shift().fn();
  if (!kuyruk.length) { pompa = false; return; }
  const kalan = kuyruk[0].at - now();
  if (kalan > 20) setTimeout(pompala, kalan - 17); else setImmediate(pompala);
}

let kurulduMu = false;
function baglan(opts) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`, { autoPong: false });
    const t = setTimeout(() => reject(new Error('giriş zaman aşımı')), 10000);
    const ilk = (d, bin) => {
      if (bin) return;
      const m = JSON.parse(d.toString());
      if (m.t === 'hello') {
        ws.send(JSON.stringify(m.canSetup && !kurulduMu
          ? { t: 'setup', username: 'akici', password: 'akici1234' }
          : { t: 'login', username: 'akici', password: 'akici1234' }));
      } else if (m.t === 'auth') {
        clearTimeout(t);
        ws.off('message', ilk);
        if (!m.ok) return reject(new Error(m.error));
        kurulduMu = true;
        resolve({ ws, auth: m });
      }
    };
    ws.on('message', ilk);
    ws.on('error', reject);
  });
}

const ozet = (dizi) => {
  if (!dizi.length) return null;
  const s = [...dizi].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const ort = s.reduce((a, b) => a + b, 0) / s.length;
  const std = Math.sqrt(s.reduce((a, b) => a + (b - ort) ** 2, 0) / s.length);
  return { n: s.length, ort, med: q(0.5), p95: q(0.95), maks: s[s.length - 1], std };
};

// Bir senaryo: bağlan, izlemeyi başlat, ağ taklidiyle SURE ms ölç.
async function senaryo(sc) {
  const { ws, auth } = await baglan();
  const r = rastgele(sc.tohum || 1);
  const owd = () => {
    if (!sc.rtt) return 0;
    let d = sc.rtt / 2 + (r() - 0.5) * (sc.sapma || 0);
    if (sc.ani && r() < sc.ani) d += sc.aniMs || 100;
    return Math.max(0, d);
  };
  const txMs = (bayt) => (sc.mbps ? (bayt * 8) / (sc.mbps * 1000) : 0);
  const cozmeMs = (bayt) => (sc.cozme ?? 0) * (bayt / 100000) + (sc.cozme ? 1 : 0);

  let hatHazir = 0, sonVaris = 0, cozucuHazir = 0, sonYukari = 0;
  const yukari = (fn) => { sonYukari = Math.max(sonYukari, now() + owd()); zamanla(sonYukari, fn); return sonYukari; };
  const asagi = (bayt, fn) => {
    const t = now();
    hatHazir = Math.max(hatHazir, t) + txMs(bayt);
    sonVaris = Math.max(sonVaris, hatHazir + owd());
    zamanla(sonVaris, fn);
  };

  const sonuc = { ad: sc.ad, kareler: 0, aralik: [], gecikme: [], boyut: [], ack: [], cap: [], kalite: [], durgun: 0, haric: 0 };
  let olcuyor = false, sonGosterim = null, durgunSonra = false, durgunGeldi = false;
  const baslangic = now();

  ws.on('ping', (d) => asagi(16, () => yukari(() => { if (ws.readyState === 1) ws.pong(d); })));
  ws.on('message', (d, bin) => {
    const gelis = now();
    if (bin) {
      if (d[0] !== 1) return;
      const bayt = d.length;
      asagi(bayt, () => {
        const varis = now();
        // 'durgun' bildirimi bu kareden önce geldiyse işaret karenin gelişinde alınır (önceki kare hâlâ çözülüyor olabilir).
        const durgundan = durgunSonra;
        durgunSonra = false;
        cozucuHazir = Math.max(cozucuHazir, varis) + cozmeMs(bayt);
        zamanla(cozucuHazir, () => {
          const gosterim = now();
          const ackVaris = yukari(() => { if (ws.readyState === 1) ws.send('{"t":"ack"}'); });
          if (!olcuyor) { sonGosterim = gosterim; return; }
          sonuc.kareler++;
          sonuc.boyut.push(bayt / 1024);
          sonuc.gecikme.push(gosterim - gelis);
          sonuc.ack.push(ackVaris - gelis);
          if (sonGosterim != null) {
            const a = gosterim - sonGosterim;
            // Durağan ekrandan sonra gelen ilk kare: aralık takılma sayılmaz. (Eski sunucu bildirim göndermiyordu: >900 ms.)
            if (durgundan || (!durgunGeldi && a > 900)) sonuc.haric++;
            else sonuc.aralik.push(a);
          }
          sonGosterim = gosterim;
        });
      });
      return;
    }
    const m = JSON.parse(d.toString());
    asagi(d.length, () => {
      if (m.t === 'durgun') { durgunSonra = true; durgunGeldi = true; if (olcuyor) sonuc.durgun++; }
      if (m.t === 'olcum-pong' && olcuyor) {
        if (typeof m.capMs === 'number') sonuc.cap.push(m.capMs);
        if (m.kalite) sonuc.kalite.push(`${m.kalite.quality}/${m.kalite.maxWidth}`);
      }
      if (m.t === 'started') {
        sonuc.ekran = m.screen;
        yukari(() => ws.send(JSON.stringify({ t: 'settings', kbps: 4000, ...sc.ayar })));
      }
    });
  });

  const ekran = process.env.AKICILIK_EKRAN || (auth.screens.find((s) => s.primary) || auth.screens[0]).name;
  sonuc.ekranBilgi = auth.screens.find((s) => s.name === ekran);
  ws.send(JSON.stringify({ t: 'start', mode: 'control', screen: ekran, codecs: ['jpeg'] }));
  const ping = setInterval(() => yukari(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'olcum-ping', c: now() })); }), 1000);
  await sleep(ISINMA);
  olcuyor = true;
  const t0 = now();
  await sleep(SURE);
  olcuyor = false;
  sonuc.sure = (now() - t0) / 1000;
  clearInterval(ping);
  ws.close();
  await sleep(300 + (now() - baslangic) * 0); // bekleyen taklit işleri boşalsın
  return sonuc;
}

// Masaüstü çoğaltma (DXGI) ile GDI yakalaması aynı görüntüyü vermeli. Yardımcı program doğrudan çalıştırılır
// (yalnızca "info" ve "cap"; girdi gönderilmez). Ekran o anda değişirse fark çıkabilir: birkaç deneme yapılır.
async function yakalamaKarsilastir() {
  const exe = path.join(ROOT, 'helper', 'RemoteHelper.exe');
  const ffmpeg = require(path.join(ROOT, 'node_modules', 'ffmpeg-static'));
  const env = { ...process.env };
  delete env.REMOTE_TEST_DEGISEN;
  const yardimci = (ek) => {
    const p = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...env, ...ek } });
    let buf = Buffer.alloc(0), hata = '';
    const bekleyen = [];
    p.stdout.on('data', (c) => {
      buf = Buffer.concat([buf, c]);
      while (buf.length >= 5) { const n = buf.readInt32LE(1); if (buf.length < 5 + n) break; const d = Buffer.from(buf.subarray(5, 5 + n)); buf = buf.subarray(5 + n); bekleyen.shift()(d); }
    });
    p.stderr.on('data', (d) => { hata += d; });
    return { p, hata: () => hata, iste: (cmd) => new Promise((r) => { bekleyen.push(r); p.stdin.write(cmd + '\n'); }) };
  };
  const gri = (jpeg) => {
    const f = path.join(os.tmpdir(), `rc-akici-${process.pid}.jpg`);
    fs.writeFileSync(f, jpeg);
    const r = spawnSync(ffmpeg, ['-v', 'error', '-i', f, '-vf', 'scale=320:180', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 24 });
    fs.rmSync(f, { force: true });
    return r.stdout;
  };
  // JPEG başlığındaki (SOF) genişlik x yükseklik
  const jpegBoyut = (j) => {
    for (let i = 2; i + 9 < j.length;) {
      if (j[i] !== 0xff) return '?';
      const tip = j[i + 1], uz = j.readUInt16BE(i + 2);
      if (tip >= 0xc0 && tip <= 0xc3) return `${j.readUInt16BE(i + 7)}x${j.readUInt16BE(i + 5)}`;
      i += 2 + uz;
    }
    return '?';
  };
  const dx = yardimci({}), gd = yardimci({ REMOTE_YAKALAMA: 'gdi' });
  try {
    const { screens } = JSON.parse((await dx.iste('info')).toString());
    const fark = (j1, j2) => {
      const x = gri(j1), y = gri(j2);
      if (!x.length || x.length !== y.length) return Infinity;
      let f = 0; for (let j = 0; j < x.length; j++) f += Math.abs(x[j] - y[j]);
      return f / x.length;
    };
    // Yeni açılan çoğaltmanın ilk karesi boş (siyah) gelir; yardımcı bunu atlamalı.
    const ilk = screens.find((x) => x.primary) || screens[0];
    const ilkFark = fark(await dx.iste(`cap 60 1920 ${ilk.name}`), await gd.iste(`cap 60 1920 ${ilk.name}`));
    check('yakalama: yeni açılan çoğaltmanın ilk karesi dolu (GDI ile aynı)', ilkFark < 30, `ortalama piksel farkı ${ilkFark.toFixed(2)}/255`);
    for (const sc of screens) {
      const sure = async (h) => { const t = []; let son; for (let i = 0; i < 10; i++) { const t0 = now(); son = await h.iste(`cap 60 1920 ${sc.name}`); t.push(now() - t0); } t.sort((a, b) => a - b); return { ms: t[5], son }; };
      const a = await sure(dx), b = await sure(gd);
      // Karşılaştırma için iki kare art arda alınır (ekranda video vb. oynuyorsa fark küçük kalsın); en iyi deneme sayılır.
      let enIyi = Infinity, boyut = '';
      for (let i = 0; i < 5 && enIyi > 2; i++) {
        const j1 = await dx.iste(`cap 60 1920 ${sc.name}`), j2 = await gd.iste(`cap 60 1920 ${sc.name}`);
        boyut = `${jpegBoyut(j1)} / ${jpegBoyut(j2)}`;
        enIyi = Math.min(enIyi, fark(j1, j2));
      }
      const dxgiYok = dx.hata().includes(sc.name);
      // Bozuk kopyalama (yanlış satır adımı, siyah kare, kayma) ortalama farkı 40'ın üstüne çıkarır; hareketli içerik birkaç birim.
      check(`yakalama ${sc.name}: çoğaltma ve GDI aynı görüntü`, enIyi < 30, `ortalama piksel farkı ${enIyi.toFixed(2)}/255 · boyut ${boyut} · orta yakalama: çoğaltma ${a.ms.toFixed(1)} ms, GDI ${b.ms.toFixed(1)} ms${dxgiYok ? ' (çoğaltma kullanılamadı: GDI)' : ''}`);
    }
    if (dx.hata()) console.log('     yardımcı: ' + dx.hata().trim().split('\n').join(' | '));
  } finally {
    dx.p.kill(); gd.p.kill();
  }
}

// Onay (ack) gelmezse en fazla 2 kare yolda olur; onaylanınca akış sürer.
async function onaySiniri() {
  const { ws } = await baglan();
  let kare = 0;
  ws.on('message', (d, bin) => {
    if (bin) { if (d[0] === 1) kare++; return; }
    const m = JSON.parse(d.toString());
    if (m.t === 'started') ws.send(JSON.stringify({ t: 'settings', ...ORTA, kbps: 4000 }));
  });
  ws.send(JSON.stringify({ t: 'start', mode: 'control', codecs: ['jpeg'] }));
  await sleep(2500);
  const onaysiz = kare;
  for (let i = 0; i < onaysiz; i++) ws.send('{"t":"ack"}');
  await sleep(1500);
  check('ack olmadan en fazla 2 kare yolda', onaysiz >= 1 && onaysiz <= 2, `${onaysiz} kare`);
  check('onaylanınca akış sürüyor', kare > onaysiz, `${kare - onaysiz} yeni kare`);
  ws.close();
}

function yaz(s) {
  const a = ozet(s.aralik), g = ozet(s.gecikme), b = ozet(s.boyut), k = ozet(s.ack), c = ozet(s.cap);
  const fps = s.kareler / s.sure;
  const takilma = a ? s.aralik.filter((x) => x > 2 * a.ort).length / s.sure : 0;
  const kal = [...new Set(s.kalite)].join(' → ') || '-';
  const f = (o, k2 = 'ort') => (o ? o[k2].toFixed(0) : '-');
  console.log(`     ${s.ad.padEnd(26)} ${fps.toFixed(1).padStart(5)} fps | aralık ort ${f(a)} %95 ${f(a, 'p95')} maks ${f(a, 'maks')} ±${f(a, 'std')} ms`
    + ` | takılma ${takilma.toFixed(2)}/sn | gecikme ort ${f(g)} %95 ${f(g, 'p95')} ms | yakalama ${f(c)} ms | kare ${f(b)} KB | ack ${f(k)} ms`
    + ` | durgun ${s.durgun} (hariç ${s.haric}) | kalite ${kal}`);
  return { fps, a, g, takilma, b, durgun: s.durgun, haric: s.haric };
}

// ---------- Tarayıcı kısmı (başsız Edge / Chrome, JPEG yolu) ----------
// WebCodecs sayfada kaldırılır (HTTP'deki telefon gibi JPEG'e düşsün). Girdi mesajları sayfada yakalanır, sunucuya GİTMEZ.
// iOS Safari emüle edilemez: bu kısım yalnızca Chromium motorunda istemci mantığını (ack, eski kareyi atma, rAF çizim,
// aralık/takılma ölçümü, Otomatik kalite seçimi, ölçüm paneli) doğrular.
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const getJson = (u) => new Promise((res, rej) => http.get(u, (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej));
const kill = (pid) => spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });

async function tarayiciKismi() {
  const exe = BROWSERS.find((b) => fs.existsSync(b));
  if (!exe) { console.log('OK   tarayıcı (Edge/Chrome) bulunamadı, tarayıcı kısmı atlandı'); return; }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-akici-'));
  let browser;
  try {
    browser = spawn(exe, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--mute-audio', '--window-size=1280,800', 'about:blank'], { stdio: 'ignore' });
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 80 && !fs.existsSync(portFile); i++) await sleep(250);
    const dbg = Number(fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0]);
    let targets = [];
    for (let i = 0; i < 40; i++) { try { targets = await getJson(`http://127.0.0.1:${dbg}/json/list`); if (targets.some((x) => x.type === 'page')) break; } catch {} await sleep(250); }
    const cdp = new WebSocket(targets.find((x) => x.type === 'page').webSocketDebuggerUrl);
    await new Promise((r) => cdp.on('open', r));
    let id = 0; const pending = new Map(); const exceptions = [];
    cdp.on('message', (d) => {
      const m = JSON.parse(d);
      if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    });
    const call = (method, params = {}) => new Promise((r, j) => { const i = ++id; pending.set(i, r); cdp.send(JSON.stringify({ id: i, method, params })); setTimeout(() => j(new Error(`CDP zaman aşımı: ${method}`)), 15000); });
    const ev = async (expression) => { const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails)); return r.result?.result?.value; };

    await call('Page.enable'); await call('Runtime.enable');
    await call('Page.addScriptToEvaluateOnNewDocument', { source: `
      try { delete window.VideoDecoder; } catch {}
      window.__girdi = 0; window.__ack = 0; window.__ayar = []; window.__yavas = 0;
      const __orig = WebSocket.prototype.send;
      const __block = new Set(['move','down','up','wheel','key','text','kalem']);
      WebSocket.prototype.send = function (d) {
        try {
          const m = JSON.parse(d);
          if (__block.has(m.t)) { window.__girdi++; return; }
          if (m.t === 'ack') window.__ack++;
          if (m.t === 'settings') window.__ayar.push(m);
        } catch {}
        return __orig.call(this, d);
      };
      // Yavaş telefon çözücüsü taklidi: __yavas ms gecikmeli createImageBitmap.
      const __cib = window.createImageBitmap.bind(window);
      window.createImageBitmap = (...a) => __cib(...a).then((b) => (window.__yavas ? new Promise((r) => setTimeout(() => r(b), window.__yavas)) : b));` });
    await call('Page.navigate', { url: `http://localhost:${PORT}/` });
    for (let i = 0; i < 40 && !(await ev("!document.getElementById('vLogin').hidden").catch(() => false)); i++) await sleep(250);
    await ev(`(() => { const f = document.getElementById('tAccount'); f.username.value='akici'; f.password.value='akici1234'; f.requestSubmit(); })()`);
    for (let i = 0; i < 40 && !(await ev("!document.getElementById('vHome').hidden")); i++) await sleep(250);
    const sec = await ev(`(() => { const s = document.getElementById('quality'); return { v: s.value, t: s.options[s.selectedIndex].text }; })()`);
    check('tarayıcı: kalite varsayılanı Otomatik', sec.v === 'auto' && sec.t === 'Otomatik', JSON.stringify(sec));
    await ev("document.getElementById('modeControl').click()");
    for (let i = 0; i < 60 && !(await ev("document.getElementById('screen').width > 0")); i++) await sleep(250);
    for (let i = 0; i < 12 && (await ev('RC.stats().codec')) !== 'JPEG'; i++) await sleep(250); // ölçüm saniyede bir yenilenir
    check('tarayıcı: görüntü geldi (JPEG)', await ev("document.getElementById('screen').width > 0 && RC.stats().codec === 'JPEG'"), await ev('RC.stats().codec'));
    const ayar = await ev('window.__ayar[window.__ayar.length - 1]');
    check('tarayıcı: Otomatik ayarı sunucuya gidiyor', ayar && ayar.auto === true && ayar.maxWidth === 1920, JSON.stringify(ayar));

    // 8 sn boyunca saniyelik ölçümler (ekran 3 sn kayıyor, 1 sn duruyor)
    const ornek = [];
    for (let i = 0; i < 8; i++) { await sleep(1000); ornek.push(await ev('RC.stats()')); }
    const hareket = ornek.filter((s) => s.intervalMs != null);
    const aralik = hareket.map((s) => s.intervalMs).sort((a, b) => a - b);
    const orta = aralik[Math.floor(aralik.length / 2)];
    console.log('     tarayıcı saniyelik: ' + ornek.map((s) => `${s.fps}fps/${s.intervalMs == null ? '-' : Math.round(s.intervalMs)}±${s.jitterMs == null ? '-' : Math.round(s.jitterMs)}/maks${s.maxIntervalMs == null ? '-' : Math.round(s.maxIntervalMs)}/t${s.stutters}`).join(' '));
    check('tarayıcı: RC.stats aralık alanları', hareket.length >= 3 && hareket.every((s) => typeof s.jitterMs === 'number' && typeof s.stutters === 'number'), `${hareket.length} sn`);
    check('tarayıcı: kare aralığı akıcı (ortanca < 70 ms; hedef 33)', orta < 70, `${orta?.toFixed(1)} ms`);
    check('tarayıcı: durağan ekran (1 sn) aralığa ve takılmaya sayılmadı', ornek.every((s) => s.maxIntervalMs == null || s.maxIntervalMs < 700), ornek.map((s) => Math.round(s.maxIntervalMs || 0)).join(','));

    // Yavaş çözücü: kareler birikmemeli (en fazla bir bekleyen kare), onaylar akmaya devam etmeli.
    await ev('window.__yavas = 150');
    const ack0 = await ev('window.__ack');
    const yavas = [];
    for (let i = 0; i < 4; i++) { await sleep(1000); yavas.push(await ev('RC.stats()')); }
    await ev('window.__yavas = 0');
    const ack1 = await ev('window.__ack');
    const cozme = Math.max(...yavas.filter((s) => s.decodeMs != null).map((s) => s.decodeMs));
    check('tarayıcı: yavaş çözücüde kare birikmiyor (geliş→çizim < 500 ms)', cozme < 500, `en kötü ${Math.round(cozme)} ms, ${yavas.map((s) => s.fps).join('/')} fps`);
    check('tarayıcı: yavaş çözücüde onay akıyor', ack1 - ack0 >= 8, `${ack1 - ack0} ack / 4 sn`);

    await sleep(1500);
    await ev("document.getElementById('olcumBtn').click()");
    await sleep(1200);
    const panel = await ev(`(() => { const p = document.getElementById('olcumPanel'); const g = (k) => p.querySelector('[data-k="' + k + '"]').textContent; return { aralik: g('aralik'), takilma: g('takilma'), ack: g('ack'), kalite: g('kalite') }; })()`);
    check('tarayıcı: panelde aralık/takılma/ack/kalite', /^\d+ ms · ±\d+ ms$/.test(panel.aralik) && /^\d+ \/sn \(\d+ ms\)$/.test(panel.takilma) && /^\d+ ms$/.test(panel.ack) && /^Otomatik: \d+ · \d+ px$/.test(panel.kalite), JSON.stringify(panel));
    const ozetMetin = await ev('RC.olcumOzet()');
    check('tarayıcı: özet akıcılık satırlarını içeriyor', /Kare aralığı: ort \d/.test(ozetMetin) && /Titreşim: ort/.test(ozetMetin) && /Takılma: ort/.test(ozetMetin) && /Kalite \(JPEG\): Otomatik/.test(ozetMetin) && /Kare onayı \(ack\): ort/.test(ozetMetin),
      ozetMetin.split('\n').filter((l) => /aralığı|Takılma|Kalite/.test(l)).join(' | '));

    // Kullanıcının seçtiği sabit kaliteye saygı: Orta seçilince auto gitmez, seçim hatırlanır.
    await ev(`(() => { const s = document.getElementById('quality'); s.value = 'mid'; s.dispatchEvent(new Event('change')); })()`);
    await sleep(300);
    const ayar2 = await ev('window.__ayar[window.__ayar.length - 1]');
    check('tarayıcı: Orta seçilince sabit kalite gidiyor ve hatırlanıyor', ayar2 && !ayar2.auto && ayar2.quality === 60 && (await ev("localStorage.getItem('quality')")) === 'mid', JSON.stringify(ayar2));
    await ev("localStorage.removeItem('quality')");

    await ev("document.getElementById('backBtn').click()");
    await sleep(300);
    check('tarayıcı: hiç girdi mesajı üretilmedi', (await ev('window.__girdi')) === 0);
    check('tarayıcı: sayfada yakalanmamış hata yok', exceptions.length === 0, JSON.stringify(exceptions));
    cdp.close();
  } finally {
    if (browser) kill(browser.pid);
    await sleep(500);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* tarayıcı dosyaları bırakıyor olabilir */ }
  }
}

const ORTA = { quality: 60, maxWidth: 1920, fps: 30 };
const OTO = { ...ORTA, auto: true };
// Ev Wi-Fi'ı varsayımları: iyi = 20 ms RTT, 60 Mbps; orta = 40 ms ±30, %3 ihtimalle +120 ms, 25 Mbps; zayıf = 60 ms ±40, 10 Mbps.
const WIFI_IYI = { rtt: 20, sapma: 10, mbps: 60, cozme: 4 };
const WIFI_ORTA = { rtt: 40, sapma: 30, ani: 0.03, aniMs: 120, mbps: 25, cozme: 4 };
const WIFI_ZAYIF = { rtt: 60, sapma: 40, ani: 0.03, aniMs: 150, mbps: 10, cozme: 4 };

(async () => {
  try {
    const sonuclar = {};
    const sadece = process.env.AKICILIK_SADECE; // ör. "zayif" — yalnızca adı bunu içeren senaryolar
    const calistir = async (sc) => { if (!sadece || sc.ad.includes(sadece)) sonuclar[sc.ad] = yaz(await senaryo(sc)); };
    console.log(`     senaryo başına ${SURE / 1000} sn (ısınma ${ISINMA / 1000} sn)`);
    await calistir({ ad: 'yerel · Orta', ayar: ORTA });
    await calistir({ ad: 'wifi-iyi · Orta', ayar: ORTA, ...WIFI_IYI, tohum: 11 });
    await calistir({ ad: 'wifi-orta · Orta', ayar: ORTA, ...WIFI_ORTA, tohum: 22 });
    await calistir({ ad: 'wifi-orta · Otomatik', ayar: OTO, ...WIFI_ORTA, tohum: 22 });
    await calistir({ ad: 'wifi-zayif · Orta', ayar: ORTA, ...WIFI_ZAYIF, tohum: 33 });
    await calistir({ ad: 'wifi-zayif · Otomatik', ayar: OTO, ...WIFI_ZAYIF, tohum: 33 });

    // Eşikler gevşek tutuldu (bilgisayarın yüküne göre oynar). Eski sürümde (tek kare onayı, yakalama süresi aralığa ekli,
    // GDI) yerel/iyi Wi-Fi'da aralık ~100 ms, orta Wi-Fi'da %95 ~250 ms idi; bkz. rapor.
    for (const [ad, s] of Object.entries(sonuclar)) {
      check(`${ad}: kare geliyor`, s.fps > 2, `${s.fps.toFixed(1)} fps`);
      check(`${ad}: durağan ekran bildirildi ve aralığa sayılmadı`, s.durgun >= 1 && s.haric >= 1 && s.a.maks < 900, `durgun ${s.durgun}, hariç ${s.haric}, en uzun ${s.a.maks.toFixed(0)} ms`);
    }
    const s = (ad) => sonuclar[ad];
    if (s('yerel · Orta')) check('yerel: kare aralığı ortalaması < 75 ms (hedef 33)', s('yerel · Orta').a.ort < 75, `${s('yerel · Orta').a.ort.toFixed(0)} ms`);
    if (s('wifi-iyi · Orta')) check('iyi Wi-Fi: kare aralığı ortalaması < 75 ms (gidiş-dönüş aralığa eklenmiyor)', s('wifi-iyi · Orta').a.ort < 75, `${s('wifi-iyi · Orta').a.ort.toFixed(0)} ms`);
    if (s('wifi-orta · Orta')) check('orta Wi-Fi: kare aralığı %95 < 200 ms', s('wifi-orta · Orta').a.p95 < 200, `${s('wifi-orta · Orta').a.p95.toFixed(0)} ms`);
    const zo = s('wifi-zayif · Orta'), za = s('wifi-zayif · Otomatik');
    if (zo && za) {
      check('zayıf Wi-Fi: Otomatik kalite kareyi küçültüyor', za.b.ort < zo.b.ort * 0.8, `${za.b.ort.toFixed(0)} KB / sabit ${zo.b.ort.toFixed(0)} KB`);
      check('zayıf Wi-Fi: Otomatik kalitede gecikme sabit kaliteden düşük', za.g.ort < zo.g.ort, `${za.g.ort.toFixed(0)} ms / sabit ${zo.g.ort.toFixed(0)} ms`);
    }
    if (!process.env.AKICILIK_SADECE) { await onaySiniri(); await yakalamaKarsilastir(); await tarayiciKismi(); }
  } catch (e) {
    console.log('HATA', e.stack || e);
    fail++;
  }
  console.log(`\n${pass} kontrol geçti, ${fail} hata`);
  process.exit(fail ? 1 : 0);
})();
