// Telefon özelliği, gerçek tarayıcı motorunda (başsız Edge / Chrome): dokunmatik modlar (dokun = tık, hızlı sürükle =
// kaydırma, basılı tut + sürükle = sürükleme, uzun bas = sağ tık, her durumda 'up'), yakınlaştırma, kalem filtresi,
// Tuşlar paneli, ekran klavyesi açılınca görünür alana yerleşme (sahte visualViewport ile) ve service worker.
// iOS Safari emüle EDİLEMEZ: buradaki dokunuşlar Chromium'un CDP dokunma olaylarıdır. Girdi mesajları (move/down/up/wheel/key/text/kalem) sayfada YAKALANIR ve sunucuya
// GİTMEZ: gerçek fare/klavye/kalem girdisi oluşmaz. "kalem-destek" sorgusu da yakalanır ve sayfada sahte cevap verilir. Edge ya da Chrome yoksa atlanır.
// Sunucuyu test/calistir.js TEST_PORT'ta boş veri klasörüyle başlatır (localhost "setup" ile yönetici oluşturulur).
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kill = (pid) => spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });

let pass = 0, fail = 0;
const check = (n, c, x = '') => { console.log(`${c ? 'OK  ' : 'FAIL'} ${n} ${x}`); c ? pass++ : fail++; };

const getJson = (u) => new Promise((res, rej) => http.get(u, (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej));

(async () => {
  const exe = BROWSERS.find((b) => fs.existsSync(b));
  if (!exe) { console.log('OK   tarayıcı (Edge/Chrome) bulunamadı, tarayıcı testi atlandı'); process.exit(0); }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-tarayici-'));
  let browser;
  try {
    // Hata ayıklama portu 0: tarayıcı boş bir port seçer ve profile/DevToolsActivePort dosyasına yazar.
    browser = spawn(exe, [
      '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--mute-audio', 'about:blank',
    ], { stdio: 'ignore' });
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 80 && !fs.existsSync(portFile); i++) await sleep(250);
    const dbg = Number(fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0]);
    let targets = [];
    for (let i = 0; i < 40; i++) { try { targets = await getJson(`http://127.0.0.1:${dbg}/json/list`); if (targets.some((t) => t.type === 'page')) break; } catch {} await sleep(250); }
    const page = targets.find((t) => t.type === 'page');
    const cdp = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r) => cdp.on('open', r));
    let id = 0; const pending = new Map();
    const exceptions = [];
    cdp.on('message', (d) => {
      const m = JSON.parse(d);
      if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    });
    const call = (method, params = {}) => new Promise((r, j) => { const i = ++id; pending.set(i, r); cdp.send(JSON.stringify({ id: i, method, params })); setTimeout(() => j(new Error(`CDP zaman aşımı: ${method}`)), 15000); });
    const ev = async (expression) => { const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails)); return r.result?.result?.value; };
    // Ekran görüntüsü: KUMANDA_EKRAN (ya da TEST_TMP) klasörüne
    const shot = async (name) => {
      const r = await call('Page.captureScreenshot', { format: 'png' });
      const f = path.join(process.env.KUMANDA_EKRAN || process.env.TEST_TMP || os.tmpdir(), name);
      fs.writeFileSync(f, Buffer.from(r.result.data, 'base64'));
      console.log(`     ekran görüntüsü: ${f}`);
    };

    await call('Page.enable'); await call('Runtime.enable');
    await call('Emulation.setDeviceMetricsOverride', { width: 400, height: 800, deviceScaleFactor: 2, mobile: true });
    await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await call('Page.addScriptToEvaluateOnNewDocument', { source: `
      window.__sent = [];
      window.__kalem = [];
      window.__kalemDestek = true;
      const __orig = WebSocket.prototype.send;
      const __block = new Set(['move','down','up','wheel','key','text']);
      // Sunucudan geliyormuş gibi mesaj ver (ör. kalem-destek cevabı).
      window.__fake = (m) => window.__ws && window.__ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(m) }));
      window.__all = []; // gönderilen tüm mesaj türleri, sırayla (ör. 'up' 'stop'tan önce mi)
      WebSocket.prototype.send = function (d) {
        window.__ws = this;
        try {
          const m = JSON.parse(d);
          window.__all.push(m.t + (m.b ? ':' + m.b : ''));
          if (__block.has(m.t)) { window.__sent.push(m); return; }
          if (m.t === 'kalem') { window.__kalem.push(m.durum); return; }
          if (m.t === 'kalem-destek') { setTimeout(() => window.__fake({ t: 'kalem-destek', ok: window.__kalemDestek }), 0); return; }
        } catch {}
        return __orig.call(this, d);
      };` });
    await call('Page.navigate', { url: `http://localhost:${PORT}/` });
    for (let i = 0; i < 40 && !(await ev("!document.getElementById('vSetup').hidden").catch(() => false)); i++) await sleep(250);
    if (!(await ev('Array.isArray(window.__sent)'))) throw new Error('girdi engelleyici kurulamadı, test durduruldu');
    await ev(`(() => { const f = document.getElementById('setupForm'); f.username.value='deneme'; f.password.value='deneme123'; f.password2.value='deneme123'; f.requestSubmit(); })()`);
    for (let i = 0; i < 40 && !(await ev("!document.getElementById('vHome').hidden")); i++) await sleep(250);
    await ev("document.getElementById('modeControl').click()");
    for (let i = 0; i < 60 && !(await ev("document.getElementById('screen').width > 0")); i++) await sleep(250);
    check('görüntüleyici açıldı, kare çizildi', await ev("document.getElementById('screen').width > 0"));
    check('Dokunmatik (window.Dokunmatik) yüklendi', await ev('!!window.Dokunmatik'));
    check('Tuşlar düğmesi eklendi', await ev("!!document.getElementById('tusBtn')"));
    check('touch-only düğmeler (any-pointer: coarse) görünüyor', await ev("getComputedStyle(document.getElementById('touchModeBtn')).display !== 'none'"));
    await ev("localStorage.removeItem('touchMode')");

    const st = await ev("(() => { const r = document.getElementById('stage').getBoundingClientRect(); const c = document.getElementById('screen'); return { l: r.left, t: r.top, w: r.width, h: r.height, nw: c.width, nh: c.height }; })()");
    const box = (() => { const s = Math.min(st.w / st.nw, st.h / st.nh); const cw = st.nw * s, ch = st.nh * s; return { ox: (st.w - cw) / 2, oy: (st.h - ch) / 2, cw, ch }; })();
    const P = (fx, fy) => ({ x: st.l + box.ox + fx * box.cw, y: st.t + box.oy + fy * box.ch }); // görüntüdeki oran -> sayfa
    const sent = async () => { const s = await ev('window.__sent.splice(0)'); return s; };
    const touch = async (type, pts) => call('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: p.id ?? i, radiusX: 1, radiusY: 1, force: 1 })) });
    const tap = async (p) => { await touch('touchStart', [p]); await sleep(40); await touch('touchEnd', []); };
    const drag = async (pts, steps = 8, ms = 16) => {
      // pts: [[başlangıç...], [bitiş...]] parmak listeleri
      const [a, b] = pts;
      await touch('touchStart', a);
      for (let i = 1; i <= steps; i++) { await sleep(ms); await touch('touchMove', a.map((p, k) => ({ x: p.x + (b[k].x - p.x) * i / steps, y: p.y + (b[k].y - p.y) * i / steps }))); }
      await sleep(ms); await touch('touchEnd', []);
    };
    await sent();

    // ---- Doğrudan mod ----
    check('varsayılan mod Doğrudan', /Doğrudan/.test(await ev("document.getElementById('touchModeBtn').textContent")));
    check('ilk kullanımda dokunma ipucu kartı (doğrudan mod) görünür', await ev("!document.getElementById('touchTip').hidden && /basılı tut, bırak = sağ tık/.test(document.getElementById('touchTip').textContent)"));
    check('dokunma modu düğmesinin title\'ında hareketler', /sağ tık/.test(await ev("document.getElementById('touchModeBtn').title")));
    check('çubukta Sağ tık düğmesi (dokunmatik)', await ev("(() => { const b = document.getElementById('rightBtn'); const r = b.getBoundingClientRect(); return getComputedStyle(b).display !== 'none' && r.right <= window.innerWidth && /Sağ tık/.test(b.textContent); })()"));
    check('araç çubuğu taşmıyor (menü düğmesi görünür)', await ev("document.getElementById('menuBtn').getBoundingClientRect().right <= window.innerWidth"));
    await shot('sagtik-0-cubuk-ipucu.png');
    await tap(P(0.25, 0.75));
    check('ipucu kartı ilk dokunuşta kaybolur', await ev("document.getElementById('touchTip').hidden"));
    await sleep(100);
    let s = await sent();
    const mv = s.find((m) => m.t === 'move');
    check('doğrudan: dokunuş -> dokunulan noktaya move + sol tık', mv && Math.abs(mv.x - 0.25) < 0.01 && Math.abs(mv.y - 0.75) < 0.01 && s.some((m) => m.t === 'down' && m.b === 'left') && s.some((m) => m.t === 'up' && m.b === 'left'), JSON.stringify(s));
    check('doğrudan: dokun-bırak tam olarak move, down, up (basılı kalmaz)', s.map((m) => `${m.t}${m.b ? ':' + m.b : ''}`).join(',') === 'move,down:left,up:left', JSON.stringify(s));
    // Hemen ardından birkaç piksel yana dokunuş: aynı noktaya gider (Windows çift tıkı saysın).
    await tap(P(0.25, 0.75)); await sleep(60);
    const pA = P(0.25, 0.75);
    await tap({ x: pA.x + 9, y: pA.y + 7 }); await sleep(60);
    s = await sent();
    const mvs = s.filter((m) => m.t === 'move');
    check('doğrudan: çift dokunuş ikinci tıkı ilkinin yerine gönderir', mvs.length === 2 && mvs[0].x === mvs[1].x && mvs[0].y === mvs[1].y && s.filter((m) => m.t === 'down').length === 2 && s.filter((m) => m.t === 'up').length === 2, JSON.stringify(s));
    await sleep(500);
    // Dokunmadan türeyen uyumluluk fare olayı (Safari) çekirdekte ikinci bir 'down' göndermez.
    await tap(P(0.4, 0.4)); await sleep(30);
    await ev(`(() => { const el = document.getElementById('screen'); for (const t of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, clientX: ${P(0.4, 0.4).x}, clientY: ${P(0.4, 0.4).y}, button: 0 })); })()`);
    await sleep(30);
    s = await sent();
    check('doğrudan: dokunuştan türeyen fare olayları yok sayılır (tek down)', s.filter((m) => m.t === 'down').length === 1 && s.filter((m) => m.t === 'up').length === 1, JSON.stringify(s));
    await sleep(500);
    // iki parmak dikey kaydırma (yakınlaştırma yok) -> tekerlek
    const c0 = P(0.5, 0.5);
    await drag([[{ x: c0.x - 40, y: c0.y - 60 }, { x: c0.x + 40, y: c0.y - 60 }], [{ x: c0.x - 40, y: c0.y + 60 }, { x: c0.x + 40, y: c0.y + 60 }]]);
    s = await sent();
    check('doğrudan: iki parmak dikey kaydırma -> tekerlek', s.some((m) => m.t === 'wheel' && m.dy > 0) && !s.some((m) => m.t === 'down'), JSON.stringify(s));
    check('kaydırma yakınlaştırmadı', (await ev("document.getElementById('screen').style.transform")) === '');
    // sıkıştırma
    await drag([[{ x: c0.x - 30, y: c0.y }, { x: c0.x + 30, y: c0.y }], [{ x: c0.x - 90, y: c0.y }, { x: c0.x + 90, y: c0.y }]], 10);
    const tr = await ev("document.getElementById('screen').style.transform");
    const z = Number((tr.match(/scale\(([\d.]+)\)/) || [])[1]);
    check('sıkıştırma ile yakınlaştı (~3x)', z > 2.5 && z <= 4, tr);
    check('yakınlaştırma düğmesi görünür', await ev("!document.getElementById('zoomBtn').hidden"), await ev("document.getElementById('zoomBtn').textContent"));
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 800, deviceScaleFactor: 2, mobile: true });
    await sleep(150);
    check('390 px: yakınlaştırma + Sağ tık düğmesiyle çubuk taşmıyor (⋯ görünür)', await ev("document.getElementById('menuBtn').getBoundingClientRect().right <= window.innerWidth + 0.5"), String(await ev("document.getElementById('menuBtn').getBoundingClientRect().right")));
    await shot('sagtik-3-cubuk-390-yakin.png');
    await call('Emulation.setDeviceMetricsOverride', { width: 400, height: 800, deviceScaleFactor: 2, mobile: true });
    await sleep(150);
    s = await sent();
    check('sıkıştırma girdi göndermedi', s.length === 0, JSON.stringify(s));
    // yakınlaştırılmışken dokunuş: toNorm dönüşümü hesaba katmalı -> merkezdeki dokunuş hâlâ ~ (0.5, 0.5) (sıkıştırma ortası merkezdi)
    await tap(c0);
    await sleep(100);
    s = await sent();
    const mv2 = s.find((m) => m.t === 'move');
    check('yakınlaştırılmış dokunuş doğru noktaya', mv2 && Math.abs(mv2.x - 0.5) < 0.01 && Math.abs(mv2.y - 0.5) < 0.02, JSON.stringify(mv2));
    // sahnenin sol kenarına yakın dokunuş: 3x'te görüntünün ~ 0.5 - (0.5 - kenar)/3 kısmı
    const edgeP = { x: st.l + 20, y: c0.y };
    await tap(edgeP);
    await sleep(100);
    s = await sent();
    const exp = await ev(`(() => { const r = document.getElementById('screen').getBoundingClientRect(); const c = document.getElementById('screen'); const sc = Math.min(r.width / c.width, r.height / c.height); const w = c.width * sc; const ox = r.left + (r.width - w) / 2; return (${edgeP.x} - ox) / w; })()`);
    const mv3 = s.find((m) => m.t === 'move');
    check('yakınlaştırılmış kenar dokunuşu ölçekli', mv3 && Math.abs(mv3.x - exp) < 0.005 && mv3.x > 0.3, `${mv3 && mv3.x.toFixed(3)} beklenen ${exp.toFixed(3)}`);
    // yakınlaştırılmışken iki parmak kaydırma -> görünüm kayar, tekerlek yok
    const before = await ev("document.getElementById('screen').style.transform");
    await drag([[{ x: c0.x - 40, y: c0.y }, { x: c0.x + 40, y: c0.y }], [{ x: c0.x + 20, y: c0.y }, { x: c0.x + 100, y: c0.y }]]);
    s = await sent();
    const after = await ev("document.getElementById('screen').style.transform");
    check('yakınlaştırılmışken iki parmak kaydırma görünümü kaydırır', before !== after && !s.some((m) => m.t === 'wheel'), `${before} -> ${after}`);
    // iki parmak çift dokunuş -> 1x
    const two = [{ x: c0.x - 40, y: c0.y }, { x: c0.x + 40, y: c0.y }];
    await touch('touchStart', two); await sleep(40); await touch('touchEnd', []);
    await sleep(80);
    await touch('touchStart', two); await sleep(40); await touch('touchEnd', []);
    await sleep(50);
    check('iki parmak çift dokunuş -> 1x', (await ev("document.getElementById('screen').style.transform")) === '' && await ev("document.getElementById('zoomBtn').hidden"));
    await sleep(400); await sent();
    // uzun basma -> (tutuldu göstergesi, henüz girdi yok) -> bırakınca sağ tık
    await touch('touchStart', [P(0.6, 0.4)]); await sleep(650);
    const ringOn = await ev("!document.getElementById('tpHold').hidden");
    s = await sent();
    check('doğrudan: basılı tutunca gösterge çıkar, düğme basılmaz', ringOn && !s.some((m) => m.t === 'down'), JSON.stringify(s));
    await touch('touchEnd', []);
    await sleep(50);
    s = await sent();
    check('doğrudan: uzun basıp bırakma -> sağ tık', s.map((m) => `${m.t}${m.b ? ':' + m.b : ''}`).join(',') === 'move,down:right,up:right', JSON.stringify(s));
    check('gösterge bırakınca kaybolur', await ev("document.getElementById('tpHold').hidden"));
    // hızlı sürükleme (basılı tutmadan) -> kaydırma (tekerlek), sol tuş basılmaz
    await drag([[P(0.5, 0.3)], [P(0.5, 0.75)]]);
    await sleep(50);
    s = await sent();
    check('doğrudan: hızlı dikey sürükleme -> tekerlek (parmak aşağı = yukarı kaydır), down yok', s.some((m) => m.t === 'wheel' && m.dy > 0 && m.dx === 0) && !s.some((m) => m.t === 'down' || m.t === 'up'), JSON.stringify(s));
    check('doğrudan: kaydırmadan önce imleç parmağın altına gider', s[0]?.t === 'move' && Math.abs(s[0].x - 0.5) < 0.01 && Math.abs(s[0].y - 0.3) < 0.01, JSON.stringify(s[0]));
    await drag([[P(0.8, 0.5)], [P(0.2, 0.5)]]);
    await sleep(50);
    s = await sent();
    check('doğrudan: hızlı yatay sürükleme -> yatay tekerlek (parmak sola = sağa)', s.some((m) => m.t === 'wheel' && m.dx > 0 && m.dy === 0) && !s.some((m) => m.t === 'down'), JSON.stringify(s));
    // basılı tut + sürükle -> sol tuşla sürükleme: move, down, move..., up
    const holdDrag = async (a, b, end = 'touchEnd') => {
      await touch('touchStart', [a]); await sleep(600);
      for (let i = 1; i <= 8; i++) { await sleep(16); await touch('touchMove', [{ x: a.x + (b.x - a.x) * i / 8, y: a.y + (b.y - a.y) * i / 8 }]); }
      await sleep(30);
      if (end) await touch(end, []);
    };
    await holdDrag(P(0.3, 0.3), P(0.6, 0.6));
    await sleep(50);
    s = await sent();
    let seq = s.map((m) => m.t);
    const lastMv = s.filter((m) => m.t === 'move').at(-1);
    check('doğrudan: basılı tut + sürükle -> move, down, move..., up', seq[0] === 'move' && Math.abs(s[0].x - 0.3) < 0.01 && seq[1] === 'down' && s[1].b === 'left' && seq.at(-1) === 'up' && seq.filter((t) => t === 'move').length >= 3 && seq.filter((t) => t === 'down').length === 1, seq.join(','));
    check('doğrudan: sürükleme son konumda bırakılır', lastMv && Math.abs(lastMv.x - 0.6) < 0.01 && Math.abs(lastMv.y - 0.6) < 0.01 && seq.lastIndexOf('move') < seq.indexOf('up'), JSON.stringify(lastMv));
    // touchcancel (iOS: sistem hareketi, bildirim...) -> up
    await holdDrag(P(0.3, 0.3), P(0.5, 0.5), 'touchCancel');
    await sleep(50);
    s = await sent();
    seq = s.map((m) => m.t);
    check('doğrudan: sürüklerken touchcancel -> up', seq.includes('down') && seq.at(-1) === 'up' && seq.filter((t) => t === 'up').length === 1, seq.join(','));
    // sekme gizlenince (uygulama değiştirme) -> up; sonra gelen touchend ikinci kez up göndermez
    await holdDrag(P(0.3, 0.3), P(0.5, 0.5), null);
    await ev("(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); delete document.visibilityState; })()");
    await sleep(30);
    await touch('touchEnd', []);
    await sleep(50);
    s = await sent();
    seq = s.map((m) => m.t);
    check('doğrudan: sürüklerken sekme gizlenince -> up (bir kez)', seq.includes('down') && seq.at(-1) === 'up' && seq.filter((t) => t === 'up').length === 1, seq.join(','));
    // touchend kaçırılmışsa (yeni dokunuşta ekranda yalnızca yeni parmak var) önceki sürükleme bırakılır
    // (Sayfada olay gönderilerek: ilk parmağın touchend'i hiç gelmemiş gibi yeni bir parmak yalnız başına değer.)
    await holdDrag(P(0.3, 0.3), P(0.5, 0.5), null);
    await ev(`(() => {
      const el = document.getElementById('screen');
      const tc = () => new Touch({ identifier: 50, target: el, clientX: ${P(0.7, 0.7).x}, clientY: ${P(0.7, 0.7).y} });
      el.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: [tc()], changedTouches: [tc()] }));
    })()`);
    await sleep(20);
    s = await sent();
    seq = s.map((m) => m.t);
    check('doğrudan: touchend kaçırılsa da yeni dokunuşta önceki sürükleme bırakılır', seq.includes('down') && seq.at(-1) === 'up', seq.join(','));
    await ev(`(() => {
      const el = document.getElementById('screen');
      const tc = () => new Touch({ identifier: 50, target: el, clientX: ${P(0.7, 0.7).x}, clientY: ${P(0.7, 0.7).y} });
      el.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, touches: [], changedTouches: [tc()] }));
    })()`);
    await touch('touchEnd', []);
    await sleep(50);
    s = await sent();
    seq = s.map((m) => m.t);
    check('doğrudan: ardından yeni dokunuş normal tık', seq.join(',') === 'move,down,up', seq.join(','));
    await sleep(500); await sent();

    // ---- Touchpad modu ----
    await ev("document.getElementById('touchModeBtn').click()");
    check('mod değişti: Touchpad', /Touchpad/.test(await ev("document.getElementById('touchModeBtn').textContent")) && (await ev("localStorage.getItem('touchMode')")) === 'touchpad');
    check('touchpad ipucu kartı ilk kez görünür', await ev("!document.getElementById('touchTip').hidden && /iki parmak dokun = sağ tık/.test(document.getElementById('touchTip').textContent)"));
    await shot('sagtik-2-touchpad-ipucu.png');
    check('touchpad imleç göstergesi', await ev("(() => { const e = document.getElementById('tpCursor'); return !!e; })()"));
    await sent();
    // tek parmak: göreli hareket (yavaş)
    await drag([[{ x: c0.x, y: c0.y + 100 }], [{ x: c0.x + 50, y: c0.y + 100 }]], 10, 40);
    await sleep(50);
    s = await sent();
    let last = s.filter((m) => m.t === 'move').at(-1);
    check('touchpad: sürükleme imleci göreli taşır (yukarı/aşağı yok, tık yok)', last && last.x > 0.5 && Math.abs(last.y - 0.5) < 0.01 && !s.some((m) => m.t === 'down'), JSON.stringify(last));
    const slowDx = last.x - 0.5;
    check('touchpad imleç göstergesi görünür', await ev("!document.getElementById('tpCursor').hidden"));
    // hızlı aynı mesafe -> daha uzağa
    await drag([[{ x: c0.x - 25, y: c0.y + 100 }], [{ x: c0.x + 25, y: c0.y + 100 }]], 3, 5);
    await sleep(50);
    s = await sent();
    const last2 = s.filter((m) => m.t === 'move').at(-1);
    check('touchpad: hızlı kaydırma daha uzağa (ivme)', last2 && last2.x - last.x > slowDx * 1.3, `yavaş ${slowDx.toFixed(3)}, hızlı ${(last2.x - last.x).toFixed(3)}`);
    last = last2;
    // dokunuş -> (beklemeden sonra) imleç yerinde sol tık
    await tap({ x: st.l + 30, y: st.t + 30 });
    s = await sent();
    check('touchpad: dokunuş tıkı hemen gitmez (çift dokunuş beklenir)', !s.some((m) => m.t === 'down'));
    await sleep(400);
    s = await sent();
    const mvc = s.find((m) => m.t === 'move');
    check('touchpad: dokunuş -> imlecin yerinde sol tık', mvc && Math.abs(mvc.x - last.x) < 1e-9 && s.filter((m) => m.t === 'down' && m.b === 'left').length === 1, JSON.stringify(s));
    // çift dokunuş -> çift tık
    await tap(c0); await sleep(80); await tap(c0); await sleep(50);
    s = await sent();
    check('touchpad: çift dokunuş -> çift tık', s.filter((m) => m.t === 'down' && m.b === 'left').length === 2, s.map((m) => m.t).join(','));
    await sleep(400); await sent();
    // iki parmak dokunuş -> sağ tık
    await touch('touchStart', two); await sleep(40); await touch('touchEnd', []);
    await sleep(50);
    s = await sent();
    check('touchpad: iki parmak dokunuş -> sağ tık', s.some((m) => m.t === 'down' && m.b === 'right'), JSON.stringify(s));
    await sleep(400); await sent();

    // ---- Touchpad sağ tık: gerçek parmak gibi toleranslı iki parmak dokunuşu, uzun basma, Sağ tık düğmesi ----
    // Parmaklar ayrı ayrı iner/kalkar. CDP tek parmağı ayrıca kaldıramadığı için olaylar sayfada (Touch nesneleriyle) gönderilir.
    const rightSeq = (arr) => arr.filter((m) => m.t === 'down' || m.t === 'up').map((m) => `${m.t}:${m.b}`).join(',');
    const tev = (type, on, changed) => ev(`(() => {
      const el = document.getElementById('screen');
      const mk = (p) => new Touch({ identifier: 70 + p.id, target: el, clientX: p.x, clientY: p.y });
      el.dispatchEvent(new TouchEvent('${type}', { bubbles: true, cancelable: true, touches: ${JSON.stringify(on)}.map(mk), changedTouches: ${JSON.stringify(changed)}.map(mk) }));
    })()`);
    const twoTap = async ({ gapDown = 0, hold = 60, gapUp = 0, drift = 0, preMove = 0 } = {}) => {
      const a = { x: c0.x - 40, y: c0.y + 80, id: 0 }, b = { x: c0.x + 40, y: c0.y + 80, id: 1 };
      await tev('touchstart', [a], [a]);
      const a1 = { ...a, x: a.x + preMove };
      if (preMove) { await sleep(20); await tev('touchmove', [a1], [a1]); }
      if (gapDown) await sleep(gapDown);
      await tev('touchstart', [a1, b], [b]);
      await sleep(hold / 2);
      const a2 = { ...a1, x: a1.x + drift * 0.6, y: a1.y + drift * 0.8 }, b2 = { ...b, x: b.x - drift * 0.6, y: b.y + drift * 0.8 };
      if (drift) await tev('touchmove', [a2, b2], [a2, b2]);
      await sleep(hold / 2);
      await tev('touchend', [b2], [a2]);
      if (gapUp) await sleep(gapUp);
      await tev('touchend', [], [b2]);
      await sleep(60);
    };
    await twoTap({ gapDown: 80, hold: 180, gapUp: 100, drift: 15 });
    s = await sent();
    check('touchpad: parmaklar 80/100 ms farkla inip kalkınca, 15 px kayınca da sağ tık', rightSeq(s) === 'down:right,up:right', JSON.stringify(s));
    await sleep(400); await sent();
    await twoTap({ hold: 330 });
    s = await sent();
    check('touchpad: ~400 ms süren iki parmak dokunuş -> sağ tık (eskiden 375 ms sınırı)', rightSeq(s) === 'down:right,up:right', JSON.stringify(s));
    await sleep(400); await sent();
    await twoTap({ hold: 650 });
    s = await sent();
    check('touchpad: 650 ms basılı iki parmak -> sağ tık YOK', !s.some((m) => m.t === 'down'), JSON.stringify(s));
    await sleep(400); await sent();
    await twoTap({ gapDown: 230 });
    s = await sent();
    check('touchpad: ikinci parmak 230 ms sonra gelirse sağ tık YOK', !s.some((m) => m.b === 'right'), JSON.stringify(s));
    await sleep(400); await sent();
    await twoTap({ gapUp: 250 });
    s = await sent();
    check('touchpad: parmaklar 250 ms farkla kalkarsa sağ tık YOK', !s.some((m) => m.t === 'down'), JSON.stringify(s));
    await sleep(400); await sent();
    await twoTap({ drift: 35, hold: 120 });
    s = await sent();
    check('touchpad: 35 px kayan iki parmak -> sağ tık YOK', !s.some((m) => m.t === 'down'), JSON.stringify(s));
    await sleep(400); await sent();
    // İlk parmak ikinci gelmeden 14 px kaydı (imleç biraz oynadı): yine sağ tık, imleç başladığı yerde
    const curBefore = await ev("(() => { const e = document.getElementById('tpCursor'); return { l: e.style.left, t: e.style.top }; })()");
    await twoTap({ preMove: 14, gapDown: 60 });
    s = await sent();
    const curAfter = await ev("(() => { const e = document.getElementById('tpCursor'); return { l: e.style.left, t: e.style.top }; })()");
    const rmv = s.filter((m) => m.t === 'move').at(-1);
    check('touchpad: ilk parmak biraz kaydıktan sonra iki parmak dokunuş -> sağ tık', rightSeq(s) === 'down:right,up:right', JSON.stringify(s));
    check('touchpad: o sağ tık imlecin dokunuştan önceki yerine gider', rmv && Math.abs(rmv.x - last.x) < 1e-9 && curBefore.l === curAfter.l, `${JSON.stringify(rmv)} ${JSON.stringify(curBefore)} ${JSON.stringify(curAfter)}`);
    await sleep(400); await sent();
    // Uzun basma (hareketsiz 500 ms): halka, bırakınca sağ tık
    await touch('touchStart', [c0]); await sleep(620);
    s = await sent();
    check('touchpad: uzun basınca halka çıkar, henüz tık yok', await ev("!document.getElementById('tpHold').hidden") && !s.some((m) => m.t === 'down'), JSON.stringify(s));
    await touch('touchEnd', []); await sleep(50);
    s = await sent();
    check('touchpad: uzun basıp bırakma -> imlecin yerinde sağ tık', rightSeq(s) === 'down:right,up:right' && Math.abs(s.find((m) => m.t === 'move').x - last.x) < 1e-9, JSON.stringify(s));
    // Uzun basıp sonra kaydırma: sağ tık iptal, imleç oynar
    await touch('touchStart', [c0]); await sleep(620);
    for (let i = 1; i <= 6; i++) { await sleep(20); await touch('touchMove', [{ x: c0.x + i * 8, y: c0.y }]); }
    await touch('touchEnd', []); await sleep(60);
    s = await sent();
    check('touchpad: uzun basıp kaydırınca sağ tık yok, imleç oynar', !s.some((m) => m.t === 'down') && s.some((m) => m.t === 'move'), JSON.stringify(s));
    last = s.filter((m) => m.t === 'move').at(-1) || last;
    check('halka kaydırınca kaybolur', await ev("document.getElementById('tpHold').hidden"));
    await sleep(400); await sent();
    // Sağ tık düğmesi: dokun -> sıradaki dokunuş (bekleme olmadan) imleç yerinde sağ tık, tek seferlik
    const rb = await ev("(() => { const r = document.getElementById('rightBtn').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()");
    await tap(rb); await sleep(50);
    check('Sağ tık düğmesi: dokununca vurgulu', await ev("document.getElementById('rightBtn').classList.contains('on')"));
    await shot('sagtik-1-dugme-acik.png');
    // Kaydırmak hakkı harcamaz
    await drag([[{ x: c0.x, y: c0.y + 100 }], [{ x: c0.x + 30, y: c0.y + 100 }]], 5, 20);
    await sleep(50);
    s = await sent();
    check('Sağ tık açıkken imleci taşımak hakkı harcamaz', !s.some((m) => m.t === 'down') && await ev("document.getElementById('rightBtn').classList.contains('on')"), JSON.stringify(s));
    last = s.filter((m) => m.t === 'move').at(-1) || last;
    await tap(c0); await sleep(30);
    s = await sent();
    check('Sağ tık açıkken dokunuş -> hemen imleç yerinde sağ tık', rightSeq(s) === 'down:right,up:right' && Math.abs(s[0].x - last.x) < 1e-9, JSON.stringify(s));
    check('Sağ tık tek seferlik: düğme söndü', await ev("!document.getElementById('rightBtn').classList.contains('on')"));
    await sleep(400); await sent();
    await tap(c0); await sleep(400);
    s = await sent();
    check('sonraki dokunuş yine sol tık', rightSeq(s) === 'down:left,up:left', JSON.stringify(s));
    // Uzun basınca kilit: iki dokunuş da sağ tık, düğmeye dokununca kapanır
    await touch('touchStart', [rb]); await sleep(650); await touch('touchEnd', []); await sleep(50);
    check('Sağ tık düğmesi uzun basınca kilitli', await ev("(() => { const b = document.getElementById('rightBtn'); return b.classList.contains('on') && /🔒/.test(b.textContent); })()"));
    await tap(c0); await sleep(30); await tap({ x: c0.x + 50, y: c0.y }); await sleep(30);
    s = await sent();
    check('kilitliyken her dokunuş sağ tık', rightSeq(s) === 'down:right,up:right,down:right,up:right', JSON.stringify(s));
    await tap(rb); await sleep(50);
    check('kilitliyken düğmeye dokununca kapanır', await ev("!document.getElementById('rightBtn').classList.contains('on') && !/🔒/.test(document.getElementById('rightBtn').textContent)"));
    await sleep(400); await sent();
    // dokun + dokunup sürükle -> sol tuşla sürükleme
    await tap(c0); await sleep(80);
    await drag([[c0], [{ x: c0.x + 60, y: c0.y + 40 }]], 8, 20);
    await sleep(50);
    s = await sent();
    seq = s.map((m) => m.t);
    check('touchpad: çift dokunup sürükleme -> down ... up (tık yok)', seq.filter((t) => t === 'down').length === 1 && seq.at(-1) === 'up' && seq.indexOf('down') < seq.lastIndexOf('move'), seq.join(','));
    // iki parmak kaydırma -> tekerlek
    await drag([[{ x: c0.x - 40, y: c0.y + 60 }, { x: c0.x + 40, y: c0.y + 60 }], [{ x: c0.x - 40, y: c0.y - 60 }, { x: c0.x + 40, y: c0.y - 60 }]]);
    s = await sent();
    check('touchpad: iki parmak kaydırma -> tekerlek (yukarı itince aşağı)', s.some((m) => m.t === 'wheel' && m.dy < 0) && !s.some((m) => m.t === 'down'), JSON.stringify(s));
    // touchpad + yakınlaştırma: imleç kenara giderse görünüm takip eder
    await drag([[{ x: c0.x - 30, y: c0.y }, { x: c0.x + 30, y: c0.y }], [{ x: c0.x - 90, y: c0.y }, { x: c0.x + 90, y: c0.y }]], 10);
    const tz = await ev("document.getElementById('screen').style.transform");
    for (let i = 0; i < 4; i++) await drag([[{ x: c0.x - 100, y: c0.y + 100 }], [{ x: c0.x + 100, y: c0.y + 100 }]], 4, 8);
    const tz2 = await ev("document.getElementById('screen').style.transform");
    const curInside = await ev("(() => { const c = document.getElementById('tpCursor').getBoundingClientRect(), s = document.getElementById('stage').getBoundingClientRect(); return c.left >= s.left - 10 && c.right <= s.right + 10; })()");
    check('touchpad: yakınlaştırılmışken görünüm imleci takip eder', tz !== tz2 && curInside, `${tz} -> ${tz2}`);
    await ev("document.getElementById('zoomBtn').click()");
    check('yakınlaştırma düğmesi 1x yapar', (await ev("document.getElementById('screen').style.transform")) === '');
    await sleep(400); await sent();

    // ---- Kalem: pen kaynaklı fare olayları yok sayılır ----
    await ev("document.getElementById('touchModeBtn').click()"); // doğrudan moda dön
    check('ipucu kartı her mod için yalnızca bir kez', await ev("document.getElementById('touchTip').hidden"));
    // Doğrudan modda Sağ tık düğmesi: dokunulan yere sağ tık
    await sent();
    await ev("document.getElementById('rightBtn').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); document.getElementById('rightBtn').dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))");
    await tap(P(0.7, 0.3)); await sleep(50);
    s = await sent();
    check('doğrudan: Sağ tık açıkken dokunuş -> dokunulan yere sağ tık', s.map((m) => `${m.t}${m.b ? ':' + m.b : ''}`).join(',') === 'move,down:right,up:right' && Math.abs(s[0].x - 0.7) < 0.01 && Math.abs(s[0].y - 0.3) < 0.01, JSON.stringify(s));
    await sleep(500); await sent();
    await ev('window.__kalem.splice(0)');
    // Kalemle sürükleme: down -> move... -> up; arada "out" olmamalı (setPointerCapture sonrası alt öğenin
    // pointerleave olayı çizgiyi koparıyordu).
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c0.x - 50, y: c0.y, pointerType: 'pen' });
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: c0.x - 50, y: c0.y, button: 'left', clickCount: 1, pointerType: 'pen' });
    for (let i = 1; i <= 4; i++) { await sleep(30); await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c0.x - 50 + i * 20, y: c0.y, button: 'left', buttons: 1, pointerType: 'pen' }); }
    await sleep(30);
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c0.x + 30, y: c0.y, button: 'left', clickCount: 1, pointerType: 'pen' });
    await sleep(50);
    const ks = await ev('window.__kalem.splice(0)');
    const kd = ks.indexOf('down'), ku = ks.indexOf('up');
    check('kalem: sürükleme down -> move -> up, arada out yok', kd >= 0 && ku > kd && ks.slice(kd, ku).filter((d) => d === 'move').length >= 2 && !ks.slice(kd, ku).includes('out'), JSON.stringify(ks));
    s = await sent();
    check('kalem sürüklemesi çekirdekte fare olarak gitmedi', !s.some((m) => m.t === 'down'), JSON.stringify(s));
    // Android Chrome: kalem dokunma olayı da üretir (touchType yok). Kalemin pointerdown'ından sonra gelen dokunuş yok sayılır.
    // (CDP dokunuşu kendi "touch" pointer olayını ürettiği için kalem dizisi sayfada olay gönderilerek kurulur.)
    await ev(`(() => {
      const el = document.getElementById('screen');
      const pt = (type) => el.dispatchEvent(new PointerEvent(type, { pointerType: 'pen', pointerId: 77, bubbles: true, cancelable: true, clientX: ${c0.x}, clientY: ${c0.y} }));
      const tc = () => new Touch({ identifier: 5, target: el, clientX: ${c0.x}, clientY: ${c0.y} });
      const te = (type, on) => el.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: on ? [tc()] : [], changedTouches: [tc()] }));
      pt('pointerdown'); te('touchstart', true);
      pt('pointerup'); te('touchend', false);
    })()`);
    await sleep(50);
    s = await sent();
    check('kalemin ürettiği dokunma olayı çekirdekte ikinci kez işlenmez', !s.some((m) => m.t === 'down'), JSON.stringify(s));
    await ev('window.__kalem.splice(0)');
    await tap(P(0.25, 0.75)); await sleep(50);
    s = await sent();
    check('kalemden sonra parmak dokunuşu yine tıklar', s.some((m) => m.t === 'down' && m.b === 'left'), JSON.stringify(s));
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: c0.x, y: c0.y, button: 'left', clickCount: 1, pointerType: 'pen' });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c0.x, y: c0.y, button: 'left', clickCount: 1, pointerType: 'pen' });
    await sleep(50);
    s = await sent();
    check('kalem (pointerType pen) fare olayları çekirdekte yok sayılır', !s.some((m) => m.t === 'down'), JSON.stringify(s));
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: c0.x, y: c0.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c0.x, y: c0.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
    await sleep(50);
    s = await sent();
    check('normal fare hâlâ çalışır', s.some((m) => m.t === 'down') && s.some((m) => m.t === 'up'), JSON.stringify(s));
    // Bilgisayar sentetik kalemi desteklemiyorsa kalem fare gibi çalışır (yedek).
    await ev('window.__kalem.splice(0)');
    await ev("window.__fake({ t: 'kalem-destek', ok: false, hata: 'deneme' })");
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: c0.x, y: c0.y, button: 'left', clickCount: 1, pointerType: 'pen' });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c0.x, y: c0.y, button: 'left', clickCount: 1, pointerType: 'pen' });
    await sleep(50);
    s = await sent();
    const ks2 = await ev('window.__kalem.splice(0)');
    check('kalem desteklenmiyorsa kalem fare gibi tıklar', s.some((m) => m.t === 'down') && s.some((m) => m.t === 'up') && ks2.length === 0, JSON.stringify({ s, ks2 }));
    await ev("window.__fake({ t: 'kalem-destek', ok: true })");
    await ev("document.getElementById('overlay').hidden = true");

    // ---- Tuşlar paneli (eski tuş çubuğu; ayrıntılı testler ozellik-arayuz-tarayici.js'te) ----
    const T_ = (vk) => `document.querySelector('#tusPanel button[data-vk="${vk}"]')`;
    await ev("document.getElementById('tusBtn').click()");
    check('tuşlar paneli açıldı', await ev("!document.getElementById('tusPanel').hidden"));
    await ev("document.querySelector('#tusPanel [data-sekme=\"gezinme\"]').click()");
    const bodyScroll = await ev('document.documentElement.scrollWidth <= window.innerWidth');
    check('sayfa yatay taşmıyor', bodyScroll);
    await sent();
    await ev(`${T_(27)}.click()`);
    s = await sent();
    check('Esc düğmesi', JSON.stringify(s) === '[{"t":"key","vk":27,"down":true},{"t":"key","vk":27,"down":false}]', JSON.stringify(s));
    await ev(`${T_(17)}.click()`);
    check('Ctrl yapışkan vurgulandı', await ev(`${T_(17)}.classList.contains('on')`));
    await ev("document.getElementById('kbInput').focus()");
    await call('Input.insertText', { text: 'c' });
    await sleep(50);
    s = await sent();
    check('Ctrl + ekran klavyesi "c" -> Ctrl+C', JSON.stringify(s.map((m) => `${m.t}:${m.vk ?? m.s}:${m.down ? 1 : 0}`)) === JSON.stringify(['key:17:1', 'key:67:1', 'key:67:0', 'key:17:0']), JSON.stringify(s));
    check('Ctrl bırakıldı (vurgu kalktı)', await ev(`!${T_(17)}.classList.contains('on')`));
    await call('Input.insertText', { text: 'ş' });
    await sleep(50);
    s = await sent();
    check('değiştiricisiz yazı çekirdekten metin olarak gider', JSON.stringify(s) === '[{"t":"text","s":"ş"}]', JSON.stringify(s));
    await ev(`${T_(18)}.click()`);
    await ev("document.querySelector('#tusPanel [data-sekme=\"f\"]').click()");
    await ev(`${T_(115)}.click()`);
    s = await sent();
    check('Alt (yapışkan) + F4 düğmeleri (sekme değişse de)', JSON.stringify(s.map((m) => `${m.vk}${m.down ? 'v' : '^'}`)) === '["18v","115v","115^","18^"]', JSON.stringify(s));
    await ev("document.querySelector('#tusPanel [data-sekme=\"gezinme\"]').click()");
    await ev(`${T_(91)}.click()`);
    await ev(`${T_(91)}.click()`);
    s = await sent();
    check('değiştiriciye ikinci dokunuş iptal eder', s.length === 0 && await ev(`!${T_(91)}.classList.contains('on')`));
    await ev("document.querySelector('#tusPanel .rc-x').click()");
    await ev("document.getElementById('kbInput').blur()");
    const rectOf = (sel) => ev(`(() => { const r = document.querySelector('${sel}').getBoundingClientRect(); return { top: r.top, bottom: r.bottom, h: r.height }; })()`);
    // Görüntünün (object-fit: contain) sahnedeki gerçek alanı, dönüşüm dahil.
    const imgRect = () => ev(`(() => { const c = document.getElementById('screen'), r = c.getBoundingClientRect(); const sc = Math.min(r.width / c.width, r.height / c.height); const h = c.height * sc, w = c.width * sc; return { top: r.top + (r.height - h) / 2, bottom: r.top + (r.height + h) / 2, left: r.left + (r.width - w) / 2, w, h }; })()`);
    const full = await rectOf('#vViewer');
    check('klavye kapalıyken görüntüleyici tüm yükseklikte', Math.abs(full.top) < 1 && Math.abs(full.h - 800) < 2, JSON.stringify(full));
    // Gerçek boyut değişimi (Android'de klavye sayfayı küçültünce olduğu gibi): visualViewport resize
    await call('Emulation.setDeviceMetricsOverride', { width: 400, height: 480, deviceScaleFactor: 2, mobile: true });
    await sleep(300);
    let vr = await rectOf('#vViewer'), sr = await rectOf('#stage');
    check('görünür alan küçülünce görüntüleyici sığar', Math.abs(vr.h - 480) < 2 && sr.bottom <= 481, JSON.stringify({ vr, sr }));
    await call('Emulation.setDeviceMetricsOverride', { width: 400, height: 800, deviceScaleFactor: 2, mobile: true });
    await sleep(300);
    // iPhone: klavye sayfa boyutunu değiştirmez, yalnızca visualViewport küçülür ve sayfa yukarı itilir (offsetTop).
    // Sahte visualViewport ile benzetilir; olay gerçek visualViewport nesnesinden gönderilir (app.js ona abone).
    const fakeVV = (o) => ev(`(() => {
      window.__realVV = window.__realVV || window.visualViewport;
      const f = ${o ? JSON.stringify(o) : 'window.__realVV'};
      Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => f });
      window.__realVV.dispatchEvent(new Event('resize'));
      return !!window.visualViewport;
    })()`);
    await fakeVV({ height: 430, offsetTop: 70, scale: 1, width: 400 });
    await sleep(100);
    vr = await rectOf('#vViewer'); sr = await rectOf('#stage');
    let ir = await imgRect();
    check('iPhone klavyesi (sahte visualViewport): görüntüleyici görünür alanda', Math.abs(vr.top - 70) < 1 && Math.abs(vr.h - 430) < 1 && sr.bottom <= 501, JSON.stringify({ vr, sr }));
    check('görüntü klavyenin üstündeki alana sığdı', ir.top >= 70 - 1 && ir.bottom <= 500 + 1, JSON.stringify(ir));
    check('klavye açık sınıfı', await ev("document.getElementById('vViewer').classList.contains('kb-open')"));
    // Yatay iPhone + klavye (~150 px görünür alan) + Tuşlar paneli: görüntü kaybolmasın, panel görünür alanda kalsın
    await fakeVV({ height: 150, offsetTop: 0, scale: 1, width: 400 });
    await sleep(100);
    await ev("document.getElementById('tusBtn').click()");
    await sleep(100);
    vr = await rectOf('#vViewer'); sr = await rectOf('#stage');
    let tp = await rectOf('#tusPanel');
    check('dar görünür alan + Tuşlar: görüntüye yer kalır, panel görünür alanda', sr.h >= 40 && tp.bottom <= vr.top + 150 + 1 && tp.h >= 50,
      JSON.stringify({ vr, sr, tp }));
    check('dar görünür alanda çubuk gizlendi', await ev("document.getElementById('vViewer').classList.contains('tus-sikisik') && document.getElementById('toolbar').offsetHeight === 0"));
    await fakeVV({ height: 430, offsetTop: 70, scale: 1, width: 400 });
    await sleep(100);
    sr = await rectOf('#stage'); tp = await rectOf('#tusPanel');
    check('yer açılınca çubuk geri gelir, panel tam boy', !(await ev("document.getElementById('vViewer').classList.contains('tus-sikisik')")) && sr.h >= 90 && tp.bottom <= 501,
      JSON.stringify({ sr, tp }));
    await ev("document.querySelector('#tusPanel .rc-x').click()");
    await sleep(100);
    check('panel kapanınca çubuk görünür', await ev("document.getElementById('toolbar').offsetHeight > 0 && !document.getElementById('vViewer').classList.contains('tus-sikisik')"));
    // Sayfa sıkıştırılarak yakınlaştırılmışsa (scale ≠ 1) dokunulmaz
    await fakeVV({ height: 200, offsetTop: 0, scale: 2, width: 200 });
    await sleep(100);
    vr = await rectOf('#vViewer');
    check('sayfa yakınlaştırılmışken görüntüleyici yerinde kalır', Math.abs(vr.top - 70) < 1 && Math.abs(vr.h - 430) < 1, JSON.stringify(vr));
    await fakeVV(null);
    await sleep(100);
    vr = await rectOf('#vViewer');
    check('klavye kapanınca eski hale döner', Math.abs(vr.top) < 1 && Math.abs(vr.h - 800) < 2 && !(await ev("document.getElementById('vViewer').classList.contains('kb-open')")), JSON.stringify(vr));
    // Yakınlaştırılmışken klavye açılınca son dokunulan nokta görünür kalır
    await tap(P(0.5, 0.9)); await sleep(500);
    const cz = P(0.5, 0.9);
    await drag([[{ x: cz.x - 30, y: cz.y - 40 }, { x: cz.x + 30, y: cz.y - 40 }], [{ x: cz.x - 90, y: cz.y - 40 }, { x: cz.x + 90, y: cz.y - 40 }]], 10);
    await sleep(100);
    await fakeVV({ height: 330, offsetTop: 0, scale: 1, width: 400 });
    await sleep(100);
    ir = await imgRect();
    const ptY = ir.top + 0.9 * ir.h;
    const zz = Number(((await ev("document.getElementById('screen').style.transform")).match(/scale\(([\d.]+)\)/) || [])[1]);
    sr = await rectOf('#stage');
    check('yakınlaştırılmışken klavye açılınca dokunulan nokta görünür kalır', zz > 1.5 && ptY >= sr.top && ptY <= sr.bottom && sr.bottom <= 331, JSON.stringify({ zz, ptY, sr }));
    await fakeVV(null);
    await sleep(100);
    await ev("document.getElementById('zoomBtn').click()");
    await sleep(400); await sent();

    // ---- Görüntüleyiciden çıkarken basılı düğme bırakılır ('stop'tan önce) ----
    await ev('window.__all.splice(0)');
    await holdDrag(P(0.3, 0.3), P(0.5, 0.5), null);
    await ev("document.getElementById('backBtn').click()");
    await sleep(50);
    const all = await ev('window.__all.splice(0)');
    await sent();
    await touch('touchEnd', []);
    await sleep(50);
    s = await sent();
    check('görüntüleyiciden çıkarken basılıysa up, stop\'tan önce', all.indexOf('up:left') > all.indexOf('down:left') && all.indexOf('down:left') >= 0 && all.indexOf('up:left') < all.indexOf('stop'), JSON.stringify(all));
    check('çıktıktan sonra parmak kalkınca ek girdi yok', s.length === 0 &&await ev("!document.getElementById('vHome').hidden"), JSON.stringify(s));

    const reg = await ev("navigator.serviceWorker.ready.then((r) => !!r.active && r.scope)");
    check('service worker kaydedildi ve etkin (localhost)', !!reg, String(reg));
    // Yeniden yükleme: SW denetiminde sayfa yine ağdan gelip çalışmalı
    await call('Page.reload');
    for (let i = 0; i < 40 && !(await ev("!!navigator.serviceWorker.controller && !document.getElementById('vHome').hidden").catch(() => false)); i++) await sleep(250);
    check('SW denetiminde yeniden yükleme + giriş çalışıyor', await ev("!!navigator.serviceWorker.controller && !document.getElementById('vHome').hidden"));
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
