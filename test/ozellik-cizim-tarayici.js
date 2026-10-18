// Çizim tableti, gerçek tarayıcı motorunda (başsız Edge / Chrome), iPad boyutunda (1024x1366, dokunmatik):
// ana menü kartı, kenar kısayol paneli (profiller, basılı tutulan değiştiriciler, bırakma), avuç içi reddi, "Parmak"
// ayarı, kalem ara noktalarının (getCoalescedEvents) hepsinin gönderilmesi, kalem hover.
// Girdi mesajları (move/down/up/wheel/key/text/kalem/cizim-tus) sayfada YAKALANIR ve sunucuya GİTMEZ: gerçek fare/klavye/
// kalem girdisi oluşmaz. İkinci ekran isteği (start mode extend) de yakalanır: bilgisayarda sanal ekran oluşturulmaz.
// iPadOS Safari ve Apple Pencil emüle EDİLEMEZ: kalem olayları CDP'nin pointerType 'pen' fare olaylarıdır.
// Ekran görüntüleri %TEMP%\rc-cizim\ altına kaydedilir. Edge ya da Chrome yoksa atlanır.
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
const SHOTS = path.join(os.tmpdir(), 'rc-cizim');
const IPAD_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (n, c, x = '') => { console.log(`${c ? 'OK  ' : 'FAIL'} ${n} ${x}`); c ? pass++ : fail++; };
const getJson = (u) => new Promise((res, rej) => http.get(u, (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej));

// Girdi mesajları sunucuya gitmez (window.__sent). kalem-destek sayfada "destekleniyor" diye cevaplanır.
// start mode 'extend' engellenir (window.__extend): testte sanal ekran oluşturulmasın.
const YAKALAYICI = `
  window.__sent = [];
  window.__extend = [];
  const __orig = WebSocket.prototype.send;
  const __block = new Set(['move','down','up','wheel','key','text','kalem','cizim-tus','guc']);
  window.__fake = (m) => window.__ws && window.__ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(m) }));
  WebSocket.prototype.send = function (d) {
    window.__ws = this;
    try {
      const m = JSON.parse(d);
      if (__block.has(m.t)) { window.__sent.push(m); return; }
      if (m.t === 'start' && m.mode === 'extend') { window.__extend.push(m); return; }
      if (m.t === 'kalem-destek') { setTimeout(() => window.__fake({ t: 'kalem-destek', ok: true }), 0); return; }
    } catch {}
    return __orig.call(this, d);
  };`;

(async () => {
  const exe = BROWSERS.find((b) => fs.existsSync(b));
  if (!exe) { console.log('OK   tarayıcı (Edge/Chrome) bulunamadı, tarayıcı testi atlandı'); process.exit(0); }
  fs.mkdirSync(SHOTS, { recursive: true });
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
    const sent = () => ev('window.__sent.splice(0)');
    const shot = async (ad) => {
      const r = await call('Page.captureScreenshot', { format: 'png' });
      const p = path.join(SHOTS, `${ad}.png`);
      fs.writeFileSync(p, Buffer.from(r.result.data, 'base64'));
      console.log(`     ekran görüntüsü: ${p}`);
    };
    const rect = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, left: r.left, right: r.right, top: r.top, bottom: r.bottom }; })()`);
    const shown = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && !e.hidden && getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0; })()`);
    // Dokunuş: noktalar { x, y, r (yarıçap), id }
    const touch = (type, pts) => call('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: p.id ?? i, radiusX: p.r || 1, radiusY: p.r || 1, force: 1 })) });
    const tap = async (p) => { await touch('touchStart', [p]); await sleep(40); await touch('touchEnd', []); await sleep(80); };
    const tapSel = async (sel) => { const p = await rect(sel); if (!p) throw new Error(`öğe yok: ${sel}`); await tap(p); };
    const pen = (type, p, extra = {}) => call('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, pointerType: 'pen', ...extra });
    const keys = (s) => s.filter((m) => m.t === 'cizim-tus').map((m) => `${m.vk}${m.down ? '↓' : '↑'}`).join(' ');
    const girdi = (s) => s.filter((m) => ['move', 'down', 'up', 'wheel'].includes(m.t));

    await call('Page.enable'); await call('Runtime.enable');
    // ---------------- iPad boyutu (1024x1366, dokunmatik) ----------------
    await call('Emulation.setDeviceMetricsOverride', { width: 1024, height: 1366, deviceScaleFactor: 2, mobile: true });
    await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await call('Emulation.setUserAgentOverride', { userAgent: IPAD_UA });
    await call('Page.addScriptToEvaluateOnNewDocument', { source: YAKALAYICI });
    await call('Page.navigate', { url: `http://localhost:${PORT}/` });
    for (let i = 0; i < 40 && !(await ev("!document.getElementById('vSetup').hidden").catch(() => false)); i++) await sleep(250);
    if (!(await ev('Array.isArray(window.__sent)'))) throw new Error('girdi yakalayıcı kurulamadı, test durduruldu');
    await ev(`(() => { const f = document.getElementById('setupForm'); f.username.value='cizim'; f.password.value='cizim1234'; f.password2.value='cizim1234'; f.requestSubmit(); })()`);
    for (let i = 0; i < 40 && !(await ev("!document.getElementById('vHome').hidden")); i++) await sleep(250);

    // ---- Ana menü kartı ----
    check('ana menüde "Çizim tableti" kartı', await shown('#modeCizim'));
    const kart = await rect('#modeCizim'), kk = await rect('#modeControl'), ke = await rect('#modeExtend');
    check('kart iki çekirdek kartın altında (kumandayla 2×2 ızgara)', kart.top >= kk.bottom && kart.top >= ke.bottom, JSON.stringify({ kart, kk, ke }));
    await shot('1-ipad-ana-menu');
    // Sürücü kuruluysa ikinci ekranı başlatır (istek yakalanır: sanal ekran OLUŞTURULMAZ).
    await ev("(() => { const o = RC.state; RC.state = () => ({ ...o(), vdd: true }); window.__vddGeri = () => { RC.state = o; }; })()");
    await ev("document.getElementById('modeCizim').click()");
    await sleep(800);
    const ext = await ev('window.__extend.splice(0)');
    check('sürücü kuruluysa kart ikinci ekranı ister (start mode extend)', ext.length === 1 && ext[0].mode === 'extend', JSON.stringify(ext));
    await ev("window.__vddGeri(); document.getElementById('backBtn').click()");
    await sleep(300);
    check('geri dönünce çizim paneli kapalı', !(await shown('#cizimPanel')) && !(await ev('RC.cizim.acik()')));
    // Sürücü yoksa seçili ekranı açar; panel açık, çubuk gizli (▾ ile geri gelir).
    await ev("document.getElementById('modeCizim').click()");
    for (let i = 0; i < 60 && !(await ev("document.getElementById('screen').width > 0")); i++) await sleep(250);
    check('görüntüleyici açıldı (seçili ekran)', await ev("document.getElementById('screen').width > 0"));
    await sleep(1800); // kodek ölçümü + fps ayarı
    check('çizim paneli açık', await shown('#cizimPanel'));
    check('araç çubuğu gizli, ▾ görünür', !(await shown('#toolbar')) && (await shown('#showBtn')));
    check('ikinci ekranda olmayan çizim modu da "Parmak" ayarını gösterir', await ev("!document.getElementById('parmakBtn').hidden"));
    const pn = await rect('#cizimPanel');
    check('panel sol kenarda, dikeyde ortada, ekrana sığıyor', pn.left <= 1 && pn.top >= 0 && pn.bottom <= 1366 && Math.abs(pn.y - 683) < 40 && pn.w < 100, JSON.stringify(pn));
    const kucuk = await ev("[...document.querySelectorAll('#cizimPanel button')].filter((b) => b.getClientRects().length).map((b) => { const r = b.getBoundingClientRect(); return [b.dataset.k || b.className, Math.round(r.width), Math.round(r.height)]; }).filter(([k, w, h]) => k !== 'cz-kol' && (w < 44 || h < 44))");
    check('panel düğmeleri en az 44px', kucuk.length === 0, JSON.stringify(kucuk));
    await shot('2-ipad-cizim-paneli');
    await sent();

    // ---- Kısayollar (Photoshop varsayılan) ----
    const B = (k) => `#cizimPanel button[data-k="${k}"]`;
    await ev("(() => { const s = document.getElementById('cizimProfil'); s.value = 'photoshop'; s.dispatchEvent(new Event('change')); })()");
    await tapSel(B('geri'));
    let s = await sent();
    check('Geri al -> Ctrl+Z', keys(s) === '17↓ 90↓ 90↑ 17↑', keys(s));
    check('kısayol çekirdeğin key mesajıyla değil cizim-tus ile gider', !s.some((m) => m.t === 'key'));
    await tapSel(B('yinele'));
    s = await sent();
    check('Photoshop: Yinele -> Ctrl+Shift+Z', keys(s) === '17↓ 16↓ 90↓ 90↑ 16↑ 17↑', keys(s));
    for (const [k, beklenen] of [['firca', '66↓ 66↑'], ['silgi', '69↓ 69↑'], ['kucult', '219↓ 219↑'], ['buyut', '221↓ 221↑'], ['yakin', '17↓ 107↓ 107↑ 17↑'], ['uzak', '17↓ 109↓ 109↑ 17↑']]) {
      await tapSel(B(k));
      s = await sent();
      check(`Photoshop: ${k} -> ${beklenen}`, keys(s) === beklenen, keys(s));
    }
    // Basılı tutma: Shift parmak düğmedeyken basılı, kalkınca bırakılır.
    const shiftP = await rect(B('shift'));
    await touch('touchStart', [shiftP]); await sleep(150);
    s = await sent();
    check('Shift basılı tutuluyor (yalnızca down)', keys(s) === '16↓' && (await ev(`document.querySelector('${B('shift')}').classList.contains('on')`)), keys(s));
    await sleep(300);
    check('basılıyken tekrar gönderilmez', keys(await sent()) === '');
    await touch('touchEnd', []); await sleep(80);
    s = await sent();
    check('parmak kalkınca Shift bırakıldı', keys(s) === '16↑' && !(await ev(`document.querySelector('${B('shift')}').classList.contains('on')`)), keys(s));
    // Ctrl basılıyken Geri al: Ctrl yeniden basılmaz/bırakılmaz (iki parmak: biri Ctrl'de, biri Geri al'da)
    // (CDP'de tek parmak kaldırılamaz — touchEnd hepsini bitirir — bu yüzden iki parmak sayfada pointer olaylarıyla kurulur.)
    const ikiParmak = (adim) => ev(`(() => {
      const pe = (type, sel, id) => { const b = document.querySelector(sel), r = b.getBoundingClientRect();
        b.dispatchEvent(new PointerEvent(type, { pointerType: 'touch', pointerId: id, isPrimary: id === 31, bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 })); };
      ${adim}
    })()`);
    await ikiParmak(`pe('pointerdown', '${B('ctrl')}', 31); pe('pointerdown', '${B('geri')}', 32); pe('pointerup', '${B('geri')}', 32);`);
    await sleep(40);
    s = await sent();
    check('Ctrl basılıyken (ikinci parmakla) Geri al yalnızca Z gönderir', keys(s) === '17↓ 90↓ 90↑', keys(s));
    await ikiParmak(`pe('pointerup', '${B('ctrl')}', 31);`);
    await sleep(40);
    s = await sent();
    check('Ctrl bırakılınca up', keys(s) === '17↑', keys(s));
    // Basılıyken sekme gizlenirse / pencere odağı giderse bırakılır
    const altP = await rect(B('alt'));
    await touch('touchStart', [altP]); await sleep(60);
    await ev("(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); delete document.visibilityState; })()");
    await sleep(40);
    s = await sent();
    check('Alt basılıyken sekme gizlenince up', keys(s) === '18↓ 18↑', keys(s));
    await touch('touchEnd', []); await sleep(60);
    check('sonradan kalkan parmak ikinci up göndermez', keys(await sent()) === '');
    const boslukP = await rect(B('bosluk'));
    await touch('touchStart', [boslukP]); await sleep(60);
    await ev("window.dispatchEvent(new Event('blur'))");
    await sleep(40);
    s = await sent();
    check('Boşluk basılıyken pencere odağı gidince up', keys(s) === '32↓ 32↑', keys(s));
    await touch('touchEnd', []); await sleep(60); await sent();
    // Photoshop: renk seçici Alt basılı; aynı anda Alt düğmesi de tutulursa son bırakılınca up
    await ikiParmak(`pe('pointerdown', '${B('renk')}', 31); pe('pointerdown', '${B('alt')}', 32); pe('pointerup', '${B('alt')}', 32);`);
    await sleep(40);
    s = await sent();
    check('Renk (Alt) + Alt birlikte: tek down, biri kalkınca up yok', keys(s) === '18↓', keys(s));
    await ikiParmak(`pe('pointerup', '${B('renk')}', 31);`);
    await sleep(40);
    s = await sent();
    check('ikisi de kalkınca Alt up', keys(s) === '18↑', keys(s));

    // ---- Profiller ----
    const profil = (p) => ev(`(() => { const s = document.getElementById('cizimProfil'); s.value = '${p}'; s.dispatchEvent(new Event('change')); })()`);
    await profil('csp');
    await tapSel(B('yinele'));
    s = await sent();
    check('Clip Studio: Yinele -> Ctrl+Y', keys(s) === '17↓ 89↓ 89↑ 17↑', keys(s));
    await profil('paint');
    check('Paint: Fırça/Silgi/Renk düğmeleri gizli', !(await shown(B('firca'))) && !(await shown(B('silgi'))) && !(await shown(B('renk'))));
    await tapSel(B('yakin'));
    s = await sent();
    check('Paint: Yakınlaştır -> Ctrl+PageUp', keys(s) === '17↓ 33↓ 33↑ 17↑', keys(s));
    await profil('krita');
    const kritaRenk = await rect(B('renk'));
    await touch('touchStart', [kritaRenk]); await sleep(40); await touch('touchEnd', []); await sleep(60);
    s = await sent();
    check('Krita: renk seçici Ctrl basılı', keys(s) === '17↓ 17↑', keys(s));
    check('profil seçimi hatırlanır', (await ev("localStorage.getItem('cizimProfil')")) === 'krita');
    await profil('photoshop');

    // ---- Panel gizle / kenar değiştir ----
    await tapSel('#cizimPanel .cz-kol');
    check('‹ ile panel gizlendi (yalnızca kulp)', !(await shown(B('geri'))) && (await shown('#cizimPanel .cz-kol')));
    await shot('3-ipad-panel-gizli');
    await tapSel('#cizimPanel .cz-kol');
    check('kulp ile geri geldi', await shown(B('geri')));
    await tapSel(B('yan'));
    const pr = await rect('#cizimPanel');
    check('⇄ ile sağ kenara taşındı', Math.abs(pr.right - 1024) <= 1, JSON.stringify(pr));
    check('kenar hatırlanır', (await ev("localStorage.getItem('cizimYan')")) === 'sag');
    await shot('4-ipad-panel-sag');
    await tapSel(B('yan'));
    await sent();

    // ---- Kalem: ara noktaların hepsi gönderilir ----
    const st = await ev("(() => { const r = document.getElementById('stage').getBoundingClientRect(); const c = document.getElementById('screen'); return { l: r.left, t: r.top, w: r.width, h: r.height, nw: c.width, nh: c.height }; })()");
    const box = (() => { const k = Math.min(st.w / st.nw, st.h / st.nh); const cw = st.nw * k, ch = st.nh * k; return { ox: (st.w - cw) / 2, oy: (st.h - ch) / 2, cw, ch }; })();
    const P = (fx, fy) => ({ x: st.l + box.ox + fx * box.cw, y: st.t + box.oy + fy * box.ch });
    const c0 = P(0.5, 0.5);
    await pen('mouseMoved', { x: c0.x - 60, y: c0.y }); // hover (temassız)
    await sleep(40);
    s = await sent();
    check('kalem hover (buttons 0) -> durum hover', s.some((m) => m.t === 'kalem' && m.durum === 'hover') && !s.some((m) => m.t === 'kalem' && m.durum === 'move'), JSON.stringify(s.map((m) => m.durum || m.t)));
    await pen('mousePressed', { x: c0.x - 60, y: c0.y }, { button: 'left', buttons: 1, clickCount: 1, force: 0.5 });
    const N = 12;
    // Beklemeden art arda: tarayıcı bunları tek pointermove'da birleştirebilir; hepsi gönderilmeli.
    await Promise.all(Array.from({ length: N }, (_, i) => pen('mouseMoved', { x: c0.x - 60 + (i + 1) * 5, y: c0.y + (i % 2) }, { button: 'left', buttons: 1, force: 0.5 })));
    await sleep(60);
    await pen('mouseReleased', { x: c0.x, y: c0.y }, { button: 'left', buttons: 0, clickCount: 1 });
    await sleep(60);
    s = await sent();
    const km = s.filter((m) => m.t === 'kalem');
    const hareket = km.filter((m) => m.durum === 'move');
    check(`CDP kalem: ${N} hareketin hepsi gönderildi (birleştirilmiş olaylar dahil)`, hareket.length === N && km[0].durum === 'down' && km.findIndex((m) => m.durum === 'up') === N + 1, `${hareket.length} move: ${km.map((m) => m.durum).join(',')}`);
    check('kalem hareketleri sırayla (x artıyor)', hareket.every((m, i) => i === 0 || m.x > hareket[i - 1].x));
    check('kalem basıncı gönderildi', hareket.every((m) => m.p > 0));
    check('kalem çekirdekte fare olarak gitmedi', girdi(s).length === 0, JSON.stringify(girdi(s)));
    // getCoalescedEvents'in döndürdüğü ara noktalar (iPad'de 240 Hz) tek olaydan ayrı ayrı gider.
    await sleep(1100); await sent();
    const ara = await ev(`(() => {
      const el = document.getElementById('screen');
      const pe = (type, x, extra = {}) => new PointerEvent(type, { pointerType: 'pen', pointerId: 9, bubbles: true, cancelable: true, clientX: x, clientY: ${c0.y}, pressure: 0.4, buttons: 1, ...extra });
      el.dispatchEvent(pe('pointerdown', ${c0.x}));
      const e = pe('pointermove', ${c0.x} + 30);
      const noktalar = [5, 10, 15, 20, 25, 30].map((d) => pe('pointermove', ${c0.x} + d));
      e.getCoalescedEvents = () => noktalar;
      el.dispatchEvent(e);
      el.dispatchEvent(pe('pointerup', ${c0.x} + 30, { buttons: 0, pressure: 0 }));
      return true;
    })()`);
    s = await sent();
    const am = s.filter((m) => m.t === 'kalem' && m.durum === 'move');
    check('getCoalescedEvents: 6 ara noktanın 6\'sı da gönderildi', ara && am.length === 6 && am.every((m, i) => i === 0 || m.x > am[i - 1].x), `${am.length}`);

    // ---- Avuç içi reddi ----
    await sleep(1100); await sent();
    // Kalemden hemen sonra parmak: girdi yok
    await pen('mousePressed', c0, { button: 'left', buttons: 1, clickCount: 1, force: 0.5 });
    await pen('mouseReleased', c0, { button: 'left', buttons: 0, clickCount: 1 });
    await sleep(30); await sent();
    await tap(P(0.3, 0.7));
    s = await sent();
    check('kalemden hemen sonra parmak dokunuşu yok sayıldı', girdi(s).length === 0, JSON.stringify(girdi(s)));
    // Kalem ekrandayken parmak: girdi yok
    await pen('mousePressed', c0, { button: 'left', buttons: 1, clickCount: 1, force: 0.5 });
    await touch('touchStart', [{ ...P(0.3, 0.7), id: 4 }]); await sleep(40); await touch('touchMove', [{ x: P(0.3, 0.7).x + 80, y: P(0.3, 0.7).y + 80, id: 4 }]); await sleep(40); await touch('touchEnd', []);
    await pen('mouseReleased', c0, { button: 'left', buttons: 0, clickCount: 1 });
    await sleep(40);
    s = await sent();
    check('kalem temas halindeyken parmak (sürükleme dahil) yok sayıldı', girdi(s).length === 0 && s.some((m) => m.t === 'kalem' && m.durum === 'up'), JSON.stringify(girdi(s)));
    // 1 sn sonra parmak yine tıklar
    await sleep(1100); await sent();
    await tap(P(0.3, 0.7));
    s = await sent();
    check('kalemden 1 sn sonra parmak dokunuşu tıklar', s.some((m) => m.t === 'down' && m.b === 'left') && s.some((m) => m.t === 'up' && m.b === 'left'), JSON.stringify(girdi(s)));
    await sleep(400); await sent();
    // Büyük temas alanı (avuç): her zaman yok
    await tap({ ...P(0.6, 0.6), r: 40 });
    s = await sent();
    check('büyük temas alanlı dokunuş (yarıçap 40) yok sayıldı', girdi(s).length === 0, JSON.stringify(girdi(s)));
    await sleep(400);
    await tap({ ...P(0.6, 0.6), r: 12 });
    s = await sent();
    check('normal parmak (yarıçap 12) tıklar', s.some((m) => m.t === 'down'), JSON.stringify(girdi(s)));
    await sleep(500); await sent();
    // Süren sürüklemeye avuç değerse sol tuş bırakılır (basılı kalmaz)
    const d0 = P(0.4, 0.4);
    await touch('touchStart', [{ ...d0, id: 1 }]); await sleep(650); // basılı tut
    for (let i = 1; i <= 4; i++) { await touch('touchMove', [{ x: d0.x + i * 15, y: d0.y, id: 1 }]); await sleep(20); }
    s = await sent();
    const surukleme = s.some((m) => m.t === 'down' && m.b === 'left');
    await touch('touchStart', [{ x: d0.x + 60, y: d0.y, id: 1 }, { x: d0.x + 200, y: d0.y + 200, id: 2, r: 45 }]); await sleep(40);
    await touch('touchMove', [{ x: d0.x + 90, y: d0.y, id: 1 }, { x: d0.x + 220, y: d0.y + 200, id: 2, r: 45 }]); await sleep(40);
    await touch('touchEnd', []); await sleep(60);
    s = await sent();
    const sonX = (d0.x + 75 - st.l - box.ox) / box.cw; // avuçtan sonraki parmak konumları (x >= d0 + 90 px) gitmemeli
    check('sürükleme başladı (sol tuş basılı)', surukleme, JSON.stringify(girdi(s)));
    check('sürükleme sırasında avuç değince sol tuş bırakıldı, sonrası gitmedi', s.some((m) => m.t === 'up' && m.b === 'left') && !s.some((m) => m.t === 'down') && !s.some((m) => m.t === 'move' && m.x > sonX), JSON.stringify(girdi(s)));
    await sleep(400); await sent();

    // ---- "Parmak" ayarı ----
    await ev("RC.kalem.setParmak('kapali')");
    await tap(P(0.3, 0.3));
    const two = async (dy) => {
      const a = P(0.45, 0.5), b = P(0.55, 0.5);
      await touch('touchStart', [{ ...a, id: 1 }, { ...b, id: 2 }]);
      for (let i = 1; i <= 8; i++) { await sleep(16); await touch('touchMove', [{ x: a.x, y: a.y + dy * i / 8, id: 1 }, { x: b.x, y: b.y + dy * i / 8, id: 2 }]); }
      await sleep(16); await touch('touchEnd', []); await sleep(60);
    };
    await two(160);
    s = await sent();
    check('"yalnızca kalem": parmak dokunuşu ve iki parmak kaydırma yok', girdi(s).length === 0, JSON.stringify(girdi(s)));
    await ev("RC.kalem.setParmak('iki')");
    await tap(P(0.3, 0.3));
    s = await sent();
    check('"yalnızca kalem + iki parmak": tek parmak dokunuşu yok', girdi(s).length === 0, JSON.stringify(girdi(s)));
    await two(160);
    s = await sent();
    check('"yalnızca kalem + iki parmak": iki parmak kaydırma tekerlek olarak gider', s.some((m) => m.t === 'wheel') && !s.some((m) => m.t === 'down'), JSON.stringify(girdi(s)));
    check('ayar menüde görünüyor ve hatırlanır', (await ev("document.querySelector('#parmakBtn .ms').textContent")) === 'yalnızca kalem + iki parmak' && (await ev("localStorage.getItem('kalemParmak')")) === 'iki');
    await ev("RC.kalem.setParmak('acik')");
    await sleep(300);
    await tap(P(0.3, 0.3));
    s = await sent();
    check('"açık": parmak yine tıklar', s.some((m) => m.t === 'down'), JSON.stringify(girdi(s)));

    // ---- Çıkış: basılı tuş bırakılır ----
    await sleep(400); await sent();
    await touch('touchStart', [await rect(B('shift'))]); await sleep(60);
    await ev("document.getElementById('showBtn').click()");
    check('▾ ile çubuk geri geldi', await shown('#toolbar'));
    await ev("document.getElementById('backBtn').click()");
    await sleep(100);
    s = await sent();
    check('görüntüleyiciden çıkınca basılı Shift bırakıldı', keys(s) === '16↓ 16↑', keys(s));
    await touch('touchEnd', []);
    check('ana menüye dönünce çizim modu kapandı', !(await ev('RC.cizim.acik()')));

    // ---- Menüden çizim paneli (normal uzaktan kontrol) ----
    await ev("document.getElementById('modeControl').click()");
    for (let i = 0; i < 60 && !(await ev("document.getElementById('screen').width > 0")); i++) await sleep(250);
    await sleep(500);
    check('normal uzaktan kontrolde panel kapalı, çubuk görünür', !(await shown('#cizimPanel')) && (await shown('#toolbar')));
    await tapSel('#menuBtn');
    check('menüde "Çizim paneli" satırı', await shown('#cizimBtn'));
    await tapSel('#cizimBtn');
    check('menüden çizim paneli açıldı', await shown('#cizimPanel'));
    // Yatay iPad (1366x1024): panel sığıyor
    await call('Emulation.setDeviceMetricsOverride', { width: 1366, height: 1024, deviceScaleFactor: 2, mobile: true });
    await sleep(400);
    const py = await rect('#cizimPanel');
    check('yatay iPad: panel ekrana sığıyor', py.top >= 0 && py.bottom <= 1024, JSON.stringify(py));
    await shot('5-ipad-yatay-menu-ile');
    // iPhone boyutu (390x844): panel taşmıyor (kaydırılabilir)
    await call('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 3, mobile: true });
    await sleep(400);
    const pt = await rect('#cizimPanel');
    const tb = await rect('#toolbar');
    check('yatay telefon: panel ekrana sığıyor, araç çubuğunun altında (içi kaydırılır)', pt.top >= tb.bottom - 0.5 && pt.bottom <= 390, JSON.stringify({ pt, tb: tb.bottom }));
    await shot('6-telefon-yatay');

    check('sayfada yakalanmamış hata yok', exceptions.length === 0, exceptions.join(' | '));
  } catch (e) {
    check('tarayıcı testi', false, e.stack || e.message);
  } finally {
    if (browser) spawnSync('taskkill', ['/pid', String(browser.pid), '/T', '/F'], { stdio: 'ignore' });
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  }
  console.log(`\n${pass} geçti, ${fail} hata`);
  process.exit(fail ? 1 : 0);
})();
