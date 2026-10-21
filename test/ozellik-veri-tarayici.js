// Veri sayacı ve Veri tasarrufu, gerçek tarayıcı motorunda (başsız Edge / Chrome), iPhone boyutu (390x844, dokunmatik):
// - Sayaç doğruluğu: sayfanın saydığı WebSocket baytları, tarayıcının ağ katmanının (CDP Network) gördüğü çerçevelerle ±%1;
//   HTTP indirme/yükleme (bilinen boyutta dosya) ±%1.
// - Mobil veri önerisi: navigator.connection.type = 'cellular' taklit edilir (iOS Safari'de bu API YOK — orada şerit çıkmaz);
//   "Aç" → kalite "Veri tasarrufu", sunucuya giden settings (500 kbps, 1280, 15 fps) ve veri-tasarruf mesajı; seçim hatırlanır.
// - ⋯ menüde "Veri · X MB" satırı, ⏱ panelinde "Veri kullanımı" bölümü, bugün/bu ay (localStorage) ve sıfırlama.
// Girdi mesajları (move/down/up/wheel/key/text/kalem/guc) sayfada YAKALANIR, sunucuya GİTMEZ. iOS Safari emüle EDİLEMEZ.
// Ekran görüntüleri %TEMP%\rc-veri\ altına kaydedilir. Edge ya da Chrome yoksa atlanır.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const ROOT = path.join(__dirname, '..');
const WebSocket = require(path.join(ROOT, 'node_modules', 'ws'));
const PORT = process.env.TEST_PORT || 3999;
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const SHOTS = path.join(os.tmpdir(), 'rc-veri');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kill = (pid) => spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });

let pass = 0, fail = 0;
const check = (n, c, x = '') => { console.log(`${c ? 'OK  ' : 'FAIL'} ${n} ${x}`); c ? pass++ : fail++; };
const yakin = (a, b, oran = 0.01) => b > 0 && Math.abs(a - b) <= b * oran;

const getJson = (u) => new Promise((res, rej) => http.get(u, (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej));

// Girdi mesajları sunucuya gitmez (window.__sent); diğer gönderilenler window.__log'a da yazılır. Mobil veri taklidi.
const YAKALAYICI = `
  window.__sent = []; window.__log = [];
  const __orig = WebSocket.prototype.send;
  const __block = new Set(['move','down','up','wheel','key','text','kalem','guc']);
  WebSocket.prototype.send = function (d) {
    try {
      const m = JSON.parse(d);
      if (__block.has(m.t)) { window.__sent.push(m); return; }
      window.__log.push(m);
    } catch {}
    return __orig.call(this, d);
  };
  Object.defineProperty(Navigator.prototype, 'connection', { configurable: true, get: () => ({ type: 'cellular', effectiveType: '4g', addEventListener() {} }) });`;

// Sayfanın kullandığı çerçeve modeli (public/app.js wsFrame) — CDP'nin verdiği yük boyutuna uygulanır.
const wsFrame = (n, out) => n + (n < 126 ? 2 : n < 65536 ? 4 : 10) + (out ? 4 : 0);

(async () => {
  const exe = BROWSERS.find((b) => fs.existsSync(b));
  if (!exe) { console.log('OK   tarayıcı (Edge/Chrome) bulunamadı, tarayıcı testi atlandı'); process.exit(0); }
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.writeFileSync(path.join(process.env.TEST_TMP, 'kok', 'veri-2mb.bin'), Buffer.alloc(2_000_000, 5));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-tarayici-'));
  let browser;
  try {
    browser = spawn(exe, [
      '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--mute-audio', 'about:blank',
    ], { stdio: 'ignore' });
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 80 && !fs.existsSync(portFile); i++) await sleep(250);
    const dbg = Number(fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0]);
    let targets = [];
    for (let i = 0; i < 40; i++) { try { targets = await getJson(`http://127.0.0.1:${dbg}/json/list`); if (targets.some((t) => t.type === 'page')) break; } catch {} await sleep(250); }
    const page = targets.find((t) => t.type === 'page');
    const cdp = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 512 * 1024 * 1024 });
    await new Promise((r) => cdp.on('open', r));
    let id = 0; const pending = new Map();
    const exceptions = [];
    // Ağ katmanının gördüğü WebSocket çerçeveleri (yük boyutu, türe göre) ve HTTP yanıtları
    const ag = { goruntu: 0, ses: 0, diger: 0, giden: 0, kare: 0 };
    const httpBitti = new Map(); // requestId -> encodedDataLength
    const httpUrl = new Map();
    cdp.on('message', (d) => {
      const m = JSON.parse(d);
      if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
      if (m.method === 'Network.webSocketFrameReceived' || m.method === 'Network.webSocketFrameSent') {
        const r = m.params.response;
        const bin = r.opcode === 2;
        const n = bin ? Buffer.from(r.payloadData, 'base64').length : Buffer.byteLength(r.payloadData, 'utf8');
        if (m.method === 'Network.webSocketFrameSent') ag.giden += wsFrame(n, true);
        else {
          const t = bin ? Buffer.from(r.payloadData.slice(0, 4), 'base64')[0] : 0;
          ag[bin && (t === 1 || t === 2) ? 'goruntu' : bin && t === 3 ? 'ses' : 'diger'] += wsFrame(n);
          if (bin && (t === 1 || t === 2)) ag.kare++;
        }
      }
      if (m.method === 'Network.requestWillBeSent') httpUrl.set(m.params.requestId, m.params.request.url);
      if (m.method === 'Network.loadingFinished') httpBitti.set(m.params.requestId, m.params.encodedDataLength);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    });
    const call = (method, params = {}) => new Promise((r, j) => { const i = ++id; pending.set(i, r); cdp.send(JSON.stringify({ id: i, method, params })); setTimeout(() => j(new Error(`CDP zaman aşımı: ${method}`)), 15000); });
    const ev = async (expression) => { const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails)); return r.result?.result?.value; };
    const shot = async (ad) => {
      const r = await call('Page.captureScreenshot', { format: 'png' });
      const p = path.join(SHOTS, `${ad}.png`);
      fs.writeFileSync(p, Buffer.from(r.result.data, 'base64'));
      console.log(`     ekran görüntüsü: ${p}`);
    };
    const rect = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, top: r.top, bottom: r.bottom, left: r.left, right: r.right }; })()`);
    const touch = (type, pts) => call('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: i, radiusX: 1, radiusY: 1, force: 1 })) });
    const tap = async (sel) => {
      const p = await rect(sel);
      if (!p) throw new Error(`öğe yok: ${sel}`);
      await touch('touchStart', [p]); await sleep(40); await touch('touchEnd', []); await sleep(150);
    };
    const shown = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && !e.hidden && getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0; })()`);
    const bekle = async (expr, n = 60) => { for (let i = 0; i < n && !(await ev(expr).catch(() => false)); i++) await sleep(250); return ev(expr); };

    await call('Page.enable'); await call('Runtime.enable');
    await call('Network.enable', { maxTotalBufferSize: 200 * 1024 * 1024, maxResourceBufferSize: 50 * 1024 * 1024 });
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await call('Page.addScriptToEvaluateOnNewDocument', { source: YAKALAYICI });
    await call('Page.navigate', { url: `http://localhost:${PORT}/` });
    await bekle("!document.getElementById('vSetup').hidden");
    if (!(await ev('Array.isArray(window.__sent)'))) throw new Error('girdi yakalayıcı kurulamadı, test durduruldu');
    await ev(`(() => { const f = document.getElementById('setupForm'); f.username.value='deneme'; f.password.value='deneme123'; f.password2.value='deneme123'; f.requestSubmit(); })()`);
    await bekle("!document.getElementById('vHome').hidden");

    // ---- Mobil veri önerisi ----
    check('mobil veride ana ekranda öneri şeridi var', await shown('#veriSerit'));
    await shot('1-ana-ekran-oneri');
    const sr = await rect('#veriSerit');
    const seritYazi = await ev("document.getElementById('veriSerit').textContent");
    check('şerit: ~250 MB tahmini H.264 koşuluyla (localhost güvenli bağlam, WebCodecs var)', /H\.264 ile saatte en fazla ~250 MB/.test(seritYazi), seritYazi.trim().slice(0, 120));
    check('şerit ekrana sığıyor (390 px)', sr && sr.left >= 0 && sr.right <= 390, JSON.stringify(sr));
    await tap('#veriSerit [data-v="evet"]');
    check('"Aç": kalite Veri tasarrufu oldu, şerit kapandı', (await ev("document.getElementById('quality').value")) === 'tasarruf' && !(await shown('#veriSerit')));
    check('seçim hatırlandı (localStorage)', (await ev("localStorage.getItem('quality') + '/' + localStorage.getItem('rc-veri-oneri')")) === 'tasarruf/evet');

    // ---- Görüntüleyici: sunucuya giden kalite mesajları ----
    await ev("window.__log.length = 0; document.getElementById('modeControl').click()");
    await bekle("document.getElementById('screen').width > 0");
    check('görüntüleyici açıldı', await ev("document.getElementById('screen').width > 0"));
    await sleep(1500);
    const log = await ev('window.__log');
    const st = log.filter((m) => m.t === 'settings').pop();
    check('settings: Veri tasarrufu (500 kbps, 1280, 15 fps, kalite 35)', st && st.kbps === 500 && st.maxWidth === 1280 && st.fps === 15 && st.quality === 35 && !st.auto, JSON.stringify(st));
    check('veri-tasarruf { acik: true } gönderildi', log.some((m) => m.t === 'veri-tasarruf' && m.acik === true));
    const kodek = await ev('RC.stats().codec');
    console.log(`     kodek: ${kodek}, tuval ${await ev("document.getElementById('screen').width + 'x' + document.getElementById('screen').height")}`);
    check('görüntü en fazla 1280 genişlikte', (await ev("document.getElementById('screen').width")) <= 1280);

    // ---- HTTP: bilinen boyutta indirme ve yükleme ----
    const indirilen = await ev("RC.fetch('/api/dosya/indir?yol=veri-2mb.bin').then((r) => r.arrayBuffer()).then((b) => b.byteLength)");
    check('2 MB dosya indirildi', indirilen === 2_000_000);
    const yukleme = await ev("RC.fetch('/api/dosya/yukle?ad=veri-1mb.bin', { method: 'POST', body: new Uint8Array(1000000) }).then((r) => r.status)");
    check('1 MB dosya yüklendi', yukleme === 200, `(${yukleme})`);
    await sleep(1200);
    const v1 = await ev('RC.veri().oturum');
    const indirmeAg = [...httpBitti].filter(([rid]) => /\/api\/dosya\/indir/.test(httpUrl.get(rid) || '')).reduce((a, [, n]) => a + n, 0);
    check('dosya: indirilen + yüklenen sayıldı (±%1)', yakin(v1.dosya, 3_000_000), `(${v1.dosya} bayt)`);
    check('dosya: indirme, tarayıcının ağ katmanının gördüğüyle ±%1', yakin(v1.dosya - 1_000_000, indirmeAg, 0.01), `(sayaç ≈ ${v1.dosya - 1_000_000}, CDP ${indirmeAg})`);

    // ---- ⋯ menü satırı ve ⏱ paneldeki bölüm ----
    await tap('#menuBtn');
    if (await shown('#dahaFazla')) await tap('#dahaFazla'); // telefonda az kullanılanlar katlı
    check('menüde "Veri" satırı ve durumu (MB)', await shown('#veriMenu') && /MB|KB/.test(await ev("document.querySelector('#veriMenu .ms').textContent")), await ev("document.querySelector('#veriMenu').textContent"));
    await shot('2-menu-veri-satiri');
    await tap('#veriMenu');
    await sleep(1200);
    check('dokununca ⏱ panelinde Veri kullanımı bölümü açıldı', await shown('#olcumPanel') && await shown('#veriBolum'));
    const pr = await rect('#olcumPanel');
    check('panel ekrana sığıyor (390x844)', pr && pr.left >= 0 && pr.right <= 390 && pr.bottom <= 844, JSON.stringify(pr));
    const br = await rect('#veriBolum');
    check('bölüm görünür alanda (panel kaydırıldı)', br && br.top >= pr.top && br.top < pr.bottom, JSON.stringify(br));
    const yazi = await ev("[...document.querySelectorAll('#veriBolum td')].map((e) => e.textContent).join(' | ')");
    console.log(`     bölüm: ${yazi}`);
    check('bölümde hız ve saatlik tahmin var', /saatte/.test(yazi) && /(kbps|Mbps)/.test(yazi) && /≈ [\d,.]+ (KB|MB|GB)/.test(yazi));
    check('ondalık ayırıcı gecikme satırlarıyla aynı (nokta)', !/\d,\d/.test(yazi), yazi);
    check('TLS/Tailscale ek yükü notu var', /TLS/.test(await ev("document.querySelector('#veriBolum .not').textContent")));
    await shot('3-olcum-paneli-veri');
    await ev("document.querySelector('#veriBolum').scrollIntoView({ block: 'end' })");
    await shot('4-olcum-paneli-veri-alt');
    const ust = await ev("document.getElementById('toolbar').scrollWidth <= document.getElementById('toolbar').clientWidth");
    check('araç çubuğu 390 px\'te taşmıyor', ust);

    // ---- Bugün / bu ay (localStorage) ----
    await sleep(5500);
    const depo = await ev("JSON.parse(localStorage.getItem('rc-veri'))");
    const toplam1 = await ev('(() => { const o = RC.veri().oturum; return o.gelen + o.giden; })()');
    check('bugün / bu ay localStorage\'a yazıldı', depo && depo.gunB > 3_000_000 && depo.ayB === depo.gunB && depo.gunB <= toplam1, JSON.stringify(depo));

    // ---- WebSocket sayaç doğruluğu: akış durunca sayfanın saydığı = ağ katmanının gördüğü (±%1) ----
    await tap('#olcumPanel .rc-x');
    await ev("document.getElementById('backBtn').click()");
    await sleep(2000);
    const tr = await ev('RC.traffic()');
    console.log(`     sayfa: ${JSON.stringify(tr)}  ağ (CDP): ${JSON.stringify(ag)}`);
    check('görüntü baytları ±%1', ag.kare > 3 && yakin(tr.goruntu, ag.goruntu), `(${tr.goruntu} / ${ag.goruntu}, ${ag.kare} kare)`);
    check('alınan toplam (WebSocket) ±%1', yakin(tr.goruntu + tr.ses + tr.diger, ag.goruntu + ag.ses + ag.diger));
    check('giden (WebSocket, girdi yakalayıcı dışı) ±%1', yakin(tr.giden, ag.giden), `(${tr.giden} / ${ag.giden})`);

    // ---- Sıfırlama ----
    await ev("window.confirm = () => true; document.querySelector('#veriBolum [data-v=\"sifirla\"]').click(); document.querySelector('#veriBolum [data-v=\"sifirlaGun\"]').click()");
    const s = await ev('RC.veri()');
    check('Oturumu sıfırla: oturum toplamı ~0', s.oturum.gelen + s.oturum.giden < 2000, JSON.stringify(s.oturum));
    check('Bugün/ay sıfırla: depo 0', s.depo.gunB === 0 && s.depo.ayB === 0, JSON.stringify(s.depo));

    // ---- Yeniden yükleme: öneri bir daha gösterilmez, kalite hatırlanır ----
    await call('Page.reload');
    await bekle("!document.getElementById('vHome').hidden");
    await sleep(500);
    check('yeniden açılınca öneri şeridi yok, kalite hâlâ Veri tasarrufu', !(await shown('#veriSerit')) && (await ev("document.getElementById('quality').value")) === 'tasarruf');

    check('sayfada yakalanmamış hata yok', exceptions.length === 0, JSON.stringify(exceptions));
    cdp.close();
  } catch (e) {
    console.log('HATA', e.stack || e);
    fail++;
  } finally {
    if (browser) kill(browser.pid);
    await sleep(500);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* tarayıcı dosyaları bırakıyor olabilir */ }
    console.log(`\n${pass} kontrol geçti, ${fail} hata`);
    process.exit(fail ? 1 : 0);
  }
})();
