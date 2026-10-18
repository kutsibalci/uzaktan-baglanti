// Görüntüleyici arayüzü, gerçek tarayıcı motorunda (başsız Edge / Chrome): tek satırlık araç çubuğu, ⋯ menü, ortak panel
// (✕ / dışarı dokunma / Esc ile kapanma), "Tuşlar" paneli (Kısayollar, Ctrl·Oklar, F1–F12), salt izleme, iPhone ipucu, masaüstü.
// Girdi mesajları (move/down/up/wheel/key/text/kalem/guc) sayfada YAKALANIR ve sunucuya GİTMEZ: gerçek fare/klavye girdisi
// ya da güç komutu oluşmaz. iOS Safari emüle EDİLEMEZ: yalnızca boyut, dokunma ve iPhone kullanıcı aracısı taklit edilir.
// Ekran görüntüleri %TEMP%\rc-arayuz\ altına kaydedilir (tasarımı gözle kontrol için). Edge ya da Chrome yoksa atlanır.
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
const SHOTS = path.join(os.tmpdir(), 'rc-arayuz');
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kill = (pid) => spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });

let pass = 0, fail = 0;
const check = (n, c, x = '') => { console.log(`${c ? 'OK  ' : 'FAIL'} ${n} ${x}`); c ? pass++ : fail++; };

const getJson = (u) => new Promise((res, rej) => http.get(u, (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej));

// Sayfaya yeni belgede eklenen yakalayıcı: girdi ve güç mesajları sunucuya gitmez, window.__sent'e yazılır.
const YAKALAYICI = `
  window.__sent = [];
  const __orig = WebSocket.prototype.send;
  const __block = new Set(['move','down','up','wheel','key','text','kalem','guc']);
  window.__fake = (m) => window.__ws && window.__ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(m) }));
  WebSocket.prototype.send = function (d) {
    window.__ws = this;
    try {
      const m = JSON.parse(d);
      if (__block.has(m.t)) { window.__sent.push(m); return; }
      if (m.t === 'kalem-destek') { setTimeout(() => window.__fake({ t: 'kalem-destek', ok: false }), 0); return; }
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
    const rect = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, top: r.top, bottom: r.bottom }; })()`);
    const touch = (type, pts) => call('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: i, radiusX: 1, radiusY: 1, force: 1 })) });
    // Gerçek dokunuş (pointerdown/touchstart/touchend/click zinciri), öğenin ortasına
    const tap = async (selOrPt) => {
      const p = typeof selOrPt === 'string' ? await rect(selOrPt) : selOrPt;
      if (!p) throw new Error(`öğe yok: ${selOrPt}`);
      await touch('touchStart', [p]); await sleep(40); await touch('touchEnd', []); await sleep(120);
    };
    const mouseClick = async (selOrPt) => {
      const p = typeof selOrPt === 'string' ? await rect(selOrPt) : selOrPt;
      await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
      await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
      await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
      await sleep(120);
    };
    const shown = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && !e.hidden && getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0; })()`);
    // Araç çubuğu tek satır mı, taşıyor mu: görünür çocukların dikey ortaları aynı satırda, kaydırma genişliği sığıyor.
    const barInfo = () => ev(`(() => {
      const tb = document.getElementById('toolbar');
      const kids = [...tb.children].filter((e) => e.getClientRects().length && getComputedStyle(e).display !== 'none');
      const mids = kids.map((e) => { const r = e.getBoundingClientRect(); return Math.round(r.top + r.height / 2); });
      const last = kids.at(-1).getBoundingClientRect();
      return { h: tb.getBoundingClientRect().height, sw: tb.scrollWidth, cw: tb.clientWidth, satir: new Set(mids).size, sagKenar: last.right, gen: innerWidth,
        ids: kids.map((e) => e.id || e.className) };
    })()`);

    await call('Page.enable'); await call('Runtime.enable');
    // ---------------- iPhone boyutu (390x844, dokunmatik) ----------------
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await call('Page.addScriptToEvaluateOnNewDocument', { source: YAKALAYICI });
    await call('Page.navigate', { url: `http://localhost:${PORT}/` });
    for (let i = 0; i < 40 && !(await ev("!document.getElementById('vSetup').hidden").catch(() => false)); i++) await sleep(250);
    if (!(await ev('Array.isArray(window.__sent)'))) throw new Error('girdi yakalayıcı kurulamadı, test durduruldu');
    await ev(`(() => { const f = document.getElementById('setupForm'); f.username.value='deneme'; f.password.value='deneme123'; f.password2.value='deneme123'; f.requestSubmit(); })()`);
    for (let i = 0; i < 40 && !(await ev("!document.getElementById('vHome').hidden")); i++) await sleep(250);
    await ev("document.getElementById('modeControl').click()");
    for (let i = 0; i < 60 && !(await ev("document.getElementById('screen').width > 0")); i++) await sleep(250);
    check('görüntüleyici açıldı', await ev("document.getElementById('screen').width > 0"));
    await sleep(1500); // gecikme sayacı ilk ölçümü yazsın
    await sent();

    let b = await barInfo();
    check('telefon: araç çubuğu tek satır ve taşmıyor', b.satir === 1 && b.sw <= b.cw && b.sagKenar <= b.gen && b.h <= 56, JSON.stringify(b));
    check('telefon: çubukta geri, ⌨, Tuşlar, dokunmatik modu ve ⋯ var', ['backBtn', 'kbBtn', 'tusBtn', 'touchModeBtn', 'menuBtn'].every((x) => b.ids.includes(x)), b.ids.join(','));
    check('telefon: özellik simgeleri ve fps çubukta değil (menüde)', !(await shown('#panoBtnPin')) && !(await shown('#fps')) && !(await shown('#sesBtnPin')));
    const kucuk = await ev("[...document.querySelectorAll('#toolbar button')].filter((e) => e.getClientRects().length && getComputedStyle(e).display !== 'none').map((e) => { const r = e.getBoundingClientRect(); return [e.id, Math.round(r.width), Math.round(r.height)]; }).filter(([i, w, h]) => i !== 'olcumBtn' && (w < 44 || h < 44))");
    check('telefon: çubuk düğmeleri en az 44px', kucuk.length === 0, JSON.stringify(kucuk));
    await shot('1-telefon-cubuk');

    // ---- ⋯ Menü ----
    await tap('#menuBtn');
    check('menü dokununca açıldı', await shown('#menuPanel'));
    const satirlar = await ev("[...document.querySelectorAll('#menuPanel .menu-row')].filter((e) => e.getClientRects().length).map((e) => e.id)");
    check('menüde kalite, pano, dosya, ses, perde, gecikme, tam ekran, çubuğu gizle', ['qualityRow', 'panoBtn', 'dosyaBtn', 'sesBtn', 'perdeBtn', 'olcumMenu', 'fsBtn', 'hideBtn'].every((x) => satirlar.includes(x)), satirlar.join(','));
    const sesDurum = await ev("document.querySelector('#sesBtn .ms').textContent");
    check('menü satırı durum gösteriyor (Ses)', /kapalı|HTTPS|destek/.test(sesDurum), sesDurum);
    check('menü sırası: kalite önce, çubuğu gizle sonda', satirlar[0] === 'qualityRow' && satirlar.at(-1) === 'hideBtn', satirlar.join(','));
    const mp = await rect('#menuPanel');
    check('menü ekrana sığıyor (çubuğun altında, alt kenar görünür)', mp.top >= b.h && mp.bottom <= 844 && mp.w <= 390, JSON.stringify(mp));
    await shot('2-telefon-menu');
    await tap('#menuPanel .rc-x');
    check('menü ✕ ile kapandı', !(await shown('#menuPanel')));
    // dışarı (görüntünün üstüne) dokunma: menü kapanır, bilgisayara tıklama GİTMEZ
    await tap('#menuBtn');
    await sent();
    const st = await rect('#stage');
    // Menünün altında kalan nokta (menü uzadıkça ortası menünün içine düşer: ör. 📊 Bilgisayar durumu satırı)
    st.y = Math.max(st.y, mp.bottom - 100 + 30);
    await tap({ x: st.x, y: st.y + 100 });
    check('menü dışarı dokununca kapandı', !(await shown('#menuPanel')));
    let s = await sent();
    check('kapatan dokunuş bilgisayara tıklama göndermedi', !s.some((m) => m.t === 'down' || m.t === 'up'), JSON.stringify(s));
    await tap({ x: st.x, y: st.y + 100 });
    s = await sent();
    check('menü kapalıyken dokunuş yine tıklar', s.some((m) => m.t === 'down' && m.b === 'left'), JSON.stringify(s));
    // Esc
    await tap('#menuBtn');
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(80);
    s = await sent();
    check('Esc menüyü kapattı ve bilgisayara Esc gitmedi', !(await shown('#menuPanel')) && !s.some((m) => m.t === 'key'), JSON.stringify(s));
    // Menüden pano paneli: menü kapanır, pano açılır, ✕ ile kapanır
    await tap('#menuBtn');
    await tap('#panoBtn');
    check('menüden Pano açıldı, menü kapandı', (await shown('#panoPanel')) && !(await shown('#menuPanel')));
    check('pano panelinde ✕ var', await shown('#panoPanel .rc-x'));
    await shot('3-telefon-pano');
    await tap('#panoPanel .rc-x');
    check('pano ✕ ile kapandı', !(await shown('#panoPanel')));
    // Gecikme ayrıntısı: çubuktaki küçük sayaçtan
    if (await shown('#olcumBtn')) {
      await tap('#olcumBtn');
      check('gecikme paneli açıldı (✕ var)', (await shown('#olcumPanel')) && (await shown('#olcumPanel .rc-x')));
      await tap('#olcumPanel .rc-x');
      check('gecikme paneli ✕ ile kapandı', !(await shown('#olcumPanel')));
    } else check('gecikme sayacı çubukta görünür', false);

    // ---- Tuşlar paneli ----
    await tap('#tusBtn');
    check('Tuşlar paneli açıldı', await shown('#tusPanel'));
    const gruplar = await ev("[...document.querySelectorAll('#tusPanel .tus-grup')].map((g) => g.dataset.grup)");
    check('Tuşlar paneli üç grup: kısayol, gezinme, F', JSON.stringify(gruplar) === '["kisayol","gezinme","f"]', JSON.stringify(gruplar));
    const sekmeOlc = async (ad) => {
      await tap(`#tusPanel [data-sekme="${ad}"]`);
      return ev(`(() => {
        const p = document.getElementById('tusPanel'), g = p.querySelector('.tus-grup[data-grup="${ad}"]');
        const bs = [...g.querySelectorAll('button')].filter((e) => e.getClientRects().length);
        const k = bs.map((e) => e.getBoundingClientRect()).filter((r) => r.width < 44 || r.height < 44).length;
        const pr = p.getBoundingClientRect(), sr = document.getElementById('stage').getBoundingClientRect();
        return { n: bs.length, kucuk: k, gorunur: !g.hidden, tasma: p.scrollWidth > p.clientWidth || pr.right > innerWidth + 0.5,
          ustuste: sr.bottom > pr.top + 0.5, altKenar: pr.bottom, sahne: Math.round(sr.height) };
      })()`);
    };
    let g = await sekmeOlc('kisayol');
    check('Kısayollar: 16 düğme (yönetici Kilitle dahil), en az 44px, taşma yok', g.n === 16 && g.kucuk === 0 && !g.tasma && g.gorunur, JSON.stringify(g));
    check('Tuşlar paneli görüntünün altında (ekranı örtmüyor)', !g.ustuste && g.altKenar <= 844.5 && g.sahne > 300, JSON.stringify(g));
    await shot('4-telefon-tuslar-kisayol');
    g = await sekmeOlc('gezinme');
    check('Ctrl·Oklar: 17 düğme, en az 44px, taşma yok', g.n === 17 && g.kucuk === 0 && !g.tasma, JSON.stringify(g));
    const oklar = await ev("(() => { const r = (vk) => document.querySelector('#tusPanel button[data-vk=\"' + vk + '\"]').getBoundingClientRect(); const u = r(38), l = r(37), d = r(40), ri = r(39); return Math.abs(u.left - d.left) < 1 && u.bottom <= d.top && l.right <= d.left && d.right <= ri.left && Math.abs(l.top - d.top) < 1; })()");
    check('oklar yön tuşu düzeninde (↑ ↓ üstünde, ← ↓ → yan yana)', oklar);
    await shot('5-telefon-tuslar-gezinme');
    g = await sekmeOlc('f');
    check('F1–F12: 12 düğme, en az 44px, taşma yok', g.n === 12 && g.kucuk === 0 && !g.tasma, JSON.stringify(g));
    await shot('6-telefon-tuslar-f');

    const TV = (vk) => `#tusPanel button[data-vk="${vk}"]`;
    const kod = (list) => list.map((m) => (m.t === 'key' ? `${m.vk}${m.down ? 'v' : '^'}` : `${m.t}:${m.s ?? m.islem}`)).join(' ');
    await sent();
    // yapışkan Ctrl + ekran klavyesiyle "c"
    await tap('#tusPanel [data-sekme="gezinme"]');
    await tap(TV(17));
    check('Ctrl yapışkan vurgulu, sekmede işaret', (await ev(`document.querySelector('${TV(17)}').classList.contains('on')`)) && (await ev("document.querySelector('#tusPanel [data-sekme=\"gezinme\"]').classList.contains('yapiskan')")));
    await ev("document.getElementById('kbInput').focus()");
    await call('Input.insertText', { text: 'c' });
    await sleep(60);
    s = await sent();
    check('yapışkan Ctrl + "c" -> Ctrl+C', kod(s) === '17v 67v 67^ 17^', kod(s));
    check('Ctrl bırakıldı', !(await ev(`document.querySelector('${TV(17)}').classList.contains('on')`)));
    // Kısayol düğmesi: Kopyala
    await tap('#tusPanel [data-sekme="kisayol"]');
    await tap('#tusPanel [data-kisayol="kopyala"]');
    s = await sent();
    check('Kısayol "Kopyala" -> Ctrl+C', kod(s) === '17v 67v 67^ 17^', kod(s));
    await tap('#tusPanel [data-kisayol="gorev"]');
    s = await sent();
    check('Görev Yöneticisi -> Ctrl+Shift+Esc', kod(s) === '17v 16v 27v 27^ 16^ 17^', kod(s));
    await tap('#tusPanel [data-kisayol="ekran"]');
    s = await sent();
    check('Ekran alıntısı -> Win+Shift+S', kod(s) === '91v 16v 83v 83^ 16^ 91^', kod(s));
    // Yapışkan Shift + Alt+Tab -> Shift+Alt+Tab (değiştiriciler birleşir)
    await tap('#tusPanel [data-sekme="gezinme"]');
    await tap(TV(16));
    await tap('#tusPanel [data-sekme="kisayol"]');
    await tap('#tusPanel [data-kisayol="alttab"]');
    s = await sent();
    check('yapışkan Shift + Alt+Tab -> Shift+Alt+Tab', kod(s) === '16v 18v 9v 9^ 18^ 16^', kod(s));
    // Onaylı kısayollar: Alt+F4 (iptal / onay), Kilitle (güç özelliğinin komutu; burada yakalanır)
    await ev('window.confirm = () => false');
    await tap('#tusPanel [data-kisayol="altf4"]');
    s = await sent();
    check('Alt+F4 onay iptal edilince gönderilmez', s.length === 0, kod(s));
    await ev('window.confirm = () => true');
    await tap('#tusPanel [data-kisayol="altf4"]');
    s = await sent();
    check('Alt+F4 onaylanınca gönderilir', kod(s) === '18v 115v 115^ 18^', kod(s));
    await tap('#tusPanel [data-kisayol="kilitle"]');
    s = await sent();
    check('Kilitle -> güç özelliğinin kilitle komutu (yakalandı, gönderilmedi)', JSON.stringify(s) === '[{"t":"guc","islem":"kilitle"}]', JSON.stringify(s));
    // Tuşlar paneli açıkken görüntüye dokunmak tıklar (kenetli panel dışarı dokunuşla kapanmaz)
    const st2 = await rect('#stage');
    await tap({ x: st2.x, y: st2.top + 40 });
    s = await sent();
    check('Tuşlar açıkken görüntüye dokunuş tıklar, panel açık kalır', s.some((m) => m.t === 'down') && (await shown('#tusPanel')), kod(s));
    await tap('#tusPanel .rc-x');
    check('Tuşlar paneli ✕ ile kapandı', !(await shown('#tusPanel')));
    await tap('#tusBtn');
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(80);
    check('Tuşlar paneli Esc ile kapandı', !(await shown('#tusPanel')));
    await sent();

    // ---- Salt izleme ----
    await tap('#tusBtn');
    await ev("window.__fake({ t: 'role', role: 'view' })");
    await sleep(100);
    const ctl = await ev("['kbBtn', 'tusBtn', 'touchModeBtn', 'panoBtn', 'dosyaBtn', 'perdeBtn', 'tusPanel'].filter((x) => { const e = document.getElementById(x); return e && getComputedStyle(e).display !== 'none' && e.getClientRects().length; })");
    check('salt izleme: kontrol öğeleri görünmüyor', ctl.length === 0, JSON.stringify(ctl));
    check('salt izleme rozeti görünür', await shown('#viewOnly'));
    b = await barInfo();
    check('salt izleme: çubuk tek satır', b.satir === 1 && b.sw <= b.cw, JSON.stringify(b));
    await tap('#menuBtn');
    const salt = await ev("[...document.querySelectorAll('#menuPanel .menu-row')].filter((e) => e.getClientRects().length).map((e) => e.id)");
    check('salt izleme menüsü: kalite var, pano/dosya/perde yok', salt.includes('qualityRow') && !salt.some((x) => ['panoBtn', 'dosyaBtn', 'perdeBtn'].includes(x)), salt.join(','));
    await shot('7-telefon-salt-izleme');
    await tap('#menuPanel .rc-x');
    await ev("window.__fake({ t: 'role', role: 'admin' })");
    await sleep(100);
    check('yetki geri gelince kontrol öğeleri görünür', (await shown('#kbBtn')) && (await shown('#tusBtn')));
    await tap('#tusPanel .rc-x').catch(() => {});

    // ---- Çubuğu gizle / göster ----
    await tap('#menuBtn');
    await tap('#hideBtn');
    check('menüden çubuk gizlendi, ▾ göründü', !(await shown('#toolbar')) && (await shown('#showBtn')));
    await tap('#showBtn');
    check('▾ ile çubuk geri geldi', await shown('#toolbar'));

    // ---------------- iPhone kullanıcı aracısı + Fullscreen API yok (iOS Safari taklidi) ----------------
    await call('Emulation.setUserAgentOverride', { userAgent: IPHONE_UA, platform: 'iPhone' });
    await call('Page.addScriptToEvaluateOnNewDocument', { source: 'try { delete Element.prototype.requestFullscreen; delete Element.prototype.webkitRequestFullscreen; } catch {}' });
    await call('Page.reload');
    for (let i = 0; i < 40 && !(await ev("!document.getElementById('vHome').hidden").catch(() => false)); i++) await sleep(250);
    await ev("document.getElementById('modeControl').click()");
    for (let i = 0; i < 60 && !(await ev("document.getElementById('screen').width > 0")); i++) await sleep(250);
    await tap('#menuBtn');
    check('iPhone taklidi: tam ekran satırı yok, "Ana ekrana ekle" ipucu var', !(await shown('#fsBtn')) && (await shown('#iosHint')));
    await shot('8-iphone-menu-ipucu');
    await tap('#menuPanel .rc-x');
    await call('Emulation.setUserAgentOverride', { userAgent: '' });

    // ---------------- Masaüstü (1280x800, fare) ----------------
    await call('Emulation.setTouchEmulationEnabled', { enabled: false });
    await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await sleep(400);
    b = await barInfo();
    check('masaüstü: çubuk tek satır, taşmıyor', b.satir === 1 && b.sw <= b.cw && b.h <= 56, JSON.stringify(b));
    check('masaüstü: özellik simgeleri ve fps çubukta', (await shown('#panoBtnPin')) && (await shown('#dosyaBtnPin')) && (await shown('#fps')), b.ids.join(','));
    await mouseClick('#panoBtnPin');
    check('masaüstü: çubuktaki 📋 pano panelini açtı', await shown('#panoPanel'));
    await mouseClick('#panoBtnPin');
    check('masaüstü: 📋 ikinci tıklama kapattı', !(await shown('#panoPanel')));
    await mouseClick('#menuBtn');
    check('masaüstü: menü açıldı', await shown('#menuPanel'));
    await shot('9-masaustu-menu');
    const st3 = await rect('#stage');
    await sent();
    await mouseClick({ x: st3.x, y: st3.y });
    s = await sent();
    check('masaüstü: dışarı tıklama menüyü kapattı, tıklama gitmedi', !(await shown('#menuPanel')) && !s.some((m) => m.t === 'down'), kod(s));
    await mouseClick('#tusBtn');
    await shot('10-masaustu-tuslar');
    check('masaüstü: Tuşlar paneli açık', await shown('#tusPanel'));

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
