// İlk bağlantı tanıtımı (public/features/tanitim.js) gerçek tarayıcı motorunda (başsız Edge / Chrome), iPhone boyutunda (390x844,
// dokunmatik) ve masaüstünde: görüntü açılınca bir kez açılır, alt çubuğu ve Diğer düğmesini vurgular, katmana dokunuş bilgisayara
// gitmez, Geç / Başla / Esc kapatır, ikinci açılışta gelmez, ⋯ menüdeki "Nasıl kullanılır?" yeniden açar; sunucu kapalı derse açılmaz.
// Girdi mesajları sayfada YAKALANIR ve sunucuya GİTMEZ. iOS Safari emüle EDİLEMEZ. Ekran görüntüleri %TEMP%\rc-tanitim\ altına.
// @ortam REMOTE_TANITIM=1
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
const SHOTS = path.join(os.tmpdir(), 'rc-tanitim');
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kill = (pid) => spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });

let pass = 0, fail = 0;
const check = (n, c, x = '') => { console.log(`${c ? 'OK  ' : 'FAIL'} ${n} ${x}`); c ? pass++ : fail++; };
const getJson = (u) => new Promise((res, rej) => http.get(u, (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej));

// Girdi mesajları sunucuya gitmez, window.__sent'e yazılır. window.__fake(m): sunucudan gelmiş gibi mesaj.
const YAKALAYICI = `
  window.__sent = [];
  const __orig = WebSocket.prototype.send;
  const __block = new Set(['move','down','up','wheel','key','text','kalem','guc']);
  window.__fake = (m) => window.__ws && window.__ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(m) }));
  WebSocket.prototype.send = function (d) {
    window.__ws = this;
    try { const m = JSON.parse(d); if (__block.has(m.t)) { window.__sent.push(m); return; } } catch {}
    return __orig.call(this, d);
  };`;

(async () => {
  const exe = BROWSERS.find((b) => fs.existsSync(b));
  if (!exe) { console.log('OK   tarayıcı (Edge/Chrome) bulunamadı, tarayıcı testi atlandı'); process.exit(0); }
  fs.mkdirSync(SHOTS, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-tarayici-'));
  let browser;
  try {
    browser = spawn(exe, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 80 && !fs.existsSync(portFile); i++) await sleep(250);
    const dbg = Number(fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0]);
    let targets = [];
    for (let i = 0; i < 40; i++) { try { targets = await getJson(`http://127.0.0.1:${dbg}/json/list`); if (targets.some((t) => t.type === 'page')) break; } catch {} await sleep(250); }
    const cdp = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((r) => cdp.on('open', r));
    let id = 0; const pending = new Map(); const exceptions = [];
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
    const rect = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, top: r.top, bottom: r.bottom, left: r.left, right: r.right }; })()`);
    const touch = (type, pts) => call('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: i, radiusX: 1, radiusY: 1, force: 1 })) });
    const tap = async (selOrPt) => {
      const p = typeof selOrPt === 'string' ? await rect(selOrPt) : selOrPt;
      if (!p) throw new Error(`öğe yok: ${selOrPt}`);
      await touch('touchStart', [p]); await sleep(40); await touch('touchEnd', []); await sleep(150);
    };
    const shown = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && !e.hidden && getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0; })()`);
    const until = async (expr, ms = 8000) => { for (let i = 0; i < ms / 150; i++) { if (await ev(expr).catch(() => false)) return true; await sleep(150); } return false; };
    const adim = () => ev("document.querySelector('#tanitim .tnt-adim')?.textContent || ''");
    const baslik = () => ev("document.querySelector('#tanitim h3')?.textContent || ''");
    // Vurgu (ışık) hedefin üstünde mi: kenarlar en fazla pay + 2 px içeride
    const vurgulu = async (sel) => {
      await sleep(350); // ışık bir önceki hedeften kayarak gelir (.25 sn)
      const [i, h] = [await rect('#tanitim .tnt-isik'), await rect(sel)];
      return !!i && !!h && Math.abs(i.left - h.left) <= 8 && Math.abs(i.right - h.right) <= 8 && Math.abs(i.top - h.top) <= 8 && Math.abs(i.bottom - h.bottom) <= 8;
    };
    const goruntuAc = async () => {
      await ev("document.getElementById('modeControl').click()");
      await until("document.getElementById('screen').width > 0", 15000);
    };

    await call('Page.enable'); await call('Runtime.enable');
    await call('Page.addScriptToEvaluateOnNewDocument', { source: YAKALAYICI });
    // ---------------- iPhone boyutu ----------------
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await call('Emulation.setUserAgentOverride', { userAgent: IPHONE_UA });
    await call('Page.navigate', { url: `http://localhost:${PORT}/` });
    await until("!document.getElementById('vSetup').hidden", 10000);
    await ev(`(() => { const f = document.getElementById('setupForm'); f.username.value='deneme'; f.password.value='deneme123'; f.password2.value='deneme123'; f.requestSubmit(); })()`);
    await until("!document.getElementById('vHome').hidden", 10000);
    check('ana menüde tanıtım yok (yalnızca görüntü açılınca)', !(await shown('#tanitim')));
    await goruntuAc();
    check('görüntü açılınca tanıtım açıldı', await until("!!document.getElementById('tanitim')", 4000));
    check('1. adım: "1 / 3", kontroller', (await adim()) === '1 / 3' && /Kontroller/.test(await baslik()), `${await adim()} ${await baslik()}`);
    check('1. adımda alt çubuk vurgulu', await vurgulu('#altCubuk'));
    const metin = await ev("document.querySelector('#tanitim p').textContent");
    check('1. adım alt çubuktaki düğmeleri sayıyor', ['Klavye', 'Tuşlar', 'Doğrudan', 'Touchpad', 'Sağ tık', 'Pano'].every((k) => metin.includes(k)), metin);
    check('dokunma modu ipucu tanıtımla birlikte gizli', !(await shown('#touchTip')));
    await shot('1-telefon-adim1');
    // Katmana (görüntünün ve alt çubuğun üstüne) dokunmak bilgisayara tıklama göndermez, alt çubuktaki düğmeye basmaz
    await sent();
    const st = await rect('#stage');
    await tap({ x: st.x, y: st.top + 60 });
    await tap(await rect('#kbBtn'));
    let s = await sent();
    check('katmana dokunuş bilgisayara gitmedi, alt çubuk düğmesi çalışmadı', s.length === 0 && (await shown('#tanitim')) && (await ev("document.activeElement?.id !== 'kbInput'")), JSON.stringify(s));
    await tap('#tanitim [data-k="ileri"]');
    check('2. adım: Diğer düğmesi vurgulu', (await adim()) === '2 / 3' && (await vurgulu('#menuBtn')), await adim());
    await shot('2-telefon-adim2');
    await tap('#tanitim [data-k="ileri"]');
    check('3. adım: hareketler, "Başla", Geç gizli', (await adim()) === '3 / 3' && /Hareketler/.test(await baslik())
      && (await ev("document.querySelector('#tanitim [data-k=\"ileri\"]').textContent")) === 'Başla' && !(await shown('#tanitim [data-k="gec"]')));
    await shot('3-telefon-adim3');
    await tap('#tanitim [data-k="ileri"]');
    check('Başla tanıtımı kapattı', !(await ev("!!document.getElementById('tanitim')")));
    check('görüldü olarak kaydedildi', (await ev("localStorage.getItem('rc-tanitim')")) === '1');
    // Kapandıktan sonra görüntüye dokunuş yine tıklar
    await tap({ x: st.x, y: st.top + 60 });
    s = await sent();
    check('tanıtım kapanınca dokunuş tıklıyor', s.some((m) => m.t === 'down'), JSON.stringify(s));
    // İkinci açılışta gelmez
    await ev("document.getElementById('backBtn').click()");
    await until("!document.getElementById('vHome').hidden");
    await goruntuAc();
    await sleep(1500);
    check('ikinci açılışta tanıtım gelmedi', !(await ev("!!document.getElementById('tanitim')")));
    // Menüden "Nasıl kullanılır?" yeniden açar; Geç ve Esc kapatır
    await tap('#menuBtn');
    check('Diğer menüsünde "Nasıl kullanılır?" var', await shown('#tanitimBtn'));
    await tap('#tanitimBtn');
    check('"Nasıl kullanılır?" tanıtımı açtı (menü kapandı)', (await until("!!document.getElementById('tanitim')", 2000)) && !(await shown('#menuPanel')));
    await tap('#tanitim [data-k="gec"]');
    check('Geç kapattı', !(await ev("!!document.getElementById('tanitim')")));
    await tap('#menuBtn');
    await tap('#tanitimBtn');
    await until("!!document.getElementById('tanitim')", 2000);
    await sent();
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(100);
    s = await sent();
    check('Esc kapattı, bilgisayara Esc gitmedi', !(await ev("!!document.getElementById('tanitim')")) && !s.some((m) => m.t === 'key'), JSON.stringify(s));

    // ---------------- Sunucu kapalı derse açılmaz ----------------
    await ev("localStorage.removeItem('rc-tanitim')");
    await ev("document.getElementById('backBtn').click()");
    await until("!document.getElementById('vHome').hidden");
    await ev("window.__fake({ t: 'tanitim', acik: false })");
    await goruntuAc();
    await sleep(1500);
    check('sunucu kapalı derse (REMOTE_TANITIM=0) açılmadı', !(await ev("!!document.getElementById('tanitim')")));
    await ev("window.__fake({ t: 'tanitim', acik: true })");

    // ---------------- Masaüstü (fare): 2 adım, üst çubuk ----------------
    await ev("document.getElementById('backBtn').click()");
    await until("!document.getElementById('vHome').hidden");
    await call('Emulation.setTouchEmulationEnabled', { enabled: false });
    await call('Emulation.setUserAgentOverride', { userAgent: '' });
    await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await sleep(300);
    await goruntuAc();
    check('masaüstü: tanıtım açıldı', await until("!!document.getElementById('tanitim')", 4000));
    check('masaüstü: 2 adım (hareketler yok), üst çubuk vurgulu', (await adim()) === '1 / 2' && (await vurgulu('#toolbar')), await adim());
    check('masaüstü: alt çubuk yok', !(await shown('#altCubuk')));
    await shot('4-masaustu-adim1');
    await ev("document.querySelector('#tanitim [data-k=\"ileri\"]').click()");
    check('masaüstü: 2. adımda ⋯ vurgulu', (await adim()) === '2 / 2' && (await vurgulu('#menuBtn')));
    await ev("document.querySelector('#tanitim [data-k=\"ileri\"]').click()");
    check('masaüstü: kapandı', !(await ev("!!document.getElementById('tanitim')")));

    check('sayfada yakalanmamış hata yok', exceptions.length === 0, JSON.stringify(exceptions));
    cdp.close();
  } catch (e) {
    console.log('HATA', e.stack || e);
    fail++;
  } finally {
    if (browser) kill(browser.pid);
  }
  console.log(`${pass} kontrol geçti, ${fail} hata`);
  process.exit(fail ? 1 : 0);
})();
