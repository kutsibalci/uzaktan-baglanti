// Kumanda modu, gerçek tarayıcı motorunda (başsız Edge / Chrome), iPhone (390x844) ve iPad (1024x1366) boyutunda:
// ana menüde üçüncü kart, sekmeler, touchpad hareketleri (göreli imleç, dokun = tık, iki parmak dokun / uzun bas = sağ tık,
// iki parmak kaydır ve şerit = tekerlek), Sol/Sağ tık düğmeleri, medya / sunum tuşları, ekran klavyesi; görüntü akışının
// BAŞLAMADIĞI ('start' gönderilmez, hiç ikili kare gelmez). Kumanda mesajları sayfada YAKALANIR, sunucuya GİTMEZ (ayrıca sunucu
// kuru modda). iOS Safari emüle EDİLEMEZ: dokunuşlar Chromium'un CDP dokunma olaylarıdır. Ekran görüntüleri TEST_TMP'ye
// (ya da KUMANDA_EKRAN klasörüne) yazılır. Edge ya da Chrome yoksa atlanır.
// @ortam REMOTE_KUMANDA_KURU=1
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const ROOT = path.join(__dirname, '..');
const WebSocket = require(path.join(ROOT, 'node_modules', 'ws'));
const PORT = process.env.TEST_PORT || 3999;
const SHOT_DIR = process.env.KUMANDA_EKRAN || process.env.TEST_TMP || os.tmpdir();
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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-kumanda-'));
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
    const shot = async (name) => {
      const r = await call('Page.captureScreenshot', { format: 'png' });
      const f = path.join(SHOT_DIR, name);
      fs.writeFileSync(f, Buffer.from(r.result.data, 'base64'));
      console.log(`     ekran görüntüsü: ${f}`);
    };

    await call('Page.enable'); await call('Runtime.enable');
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await call('Page.addScriptToEvaluateOnNewDocument', { source: `
      window.__km = [];   // yakalanan kumanda mesajları (sunucuya gitmez)
      window.__all = [];  // gönderilen tüm mesaj türleri
      window.__bin = 0;   // gelen ikili mesaj (görüntü karesi) sayısı
      const __orig = WebSocket.prototype.send;
      const __block = new Set(['move','down','up','wheel','key','text']);
      WebSocket.prototype.send = function (d) {
        try {
          const m = JSON.parse(d);
          window.__all.push(m.t);
          if (m.t === 'kumanda') { window.__km.push(m); return; }
          if (__block.has(m.t)) return;
        } catch {}
        return __orig.call(this, d);
      };
      const __om = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'onmessage');
      Object.defineProperty(WebSocket.prototype, 'onmessage', {
        configurable: true,
        get() { return __om.get.call(this); },
        set(fn) { __om.set.call(this, (e) => { if (typeof e.data !== 'string') window.__bin++; return fn(e); }); },
      });` });
    await call('Page.navigate', { url: `http://localhost:${PORT}/` });
    for (let i = 0; i < 40 && !(await ev("!document.getElementById('vSetup').hidden").catch(() => false)); i++) await sleep(250);
    if (!(await ev('Array.isArray(window.__km)'))) throw new Error('mesaj yakalayıcı kurulamadı, test durduruldu');
    await ev(`(() => { const f = document.getElementById('setupForm'); f.username.value='deneme'; f.password.value='deneme123'; f.password2.value='deneme123'; f.requestSubmit(); })()`);
    for (let i = 0; i < 40 && !(await ev("!document.getElementById('vHome').hidden")); i++) await sleep(250);

    check('ana menüde Kumanda kartı (çekirdek kartlardan sonra)', await ev("(() => { const m = [...document.querySelectorAll('#vHome .modes .mode')]; const i = m.findIndex((e) => e.id === 'modeKumanda'); return i >= 2 && !m[i].disabled; })()"));
    await shot('kumanda-0-ana-menu-iphone.png');
    await ev("document.getElementById('modeKumanda').click()");
    await sleep(200);
    check('kumanda ekranı açıldı', await ev("!document.getElementById('kumanda').hidden"));
    check('sayfa yatay taşmıyor (iPhone)', await ev('document.documentElement.scrollWidth <= window.innerWidth'));
    await shot('kumanda-1-touchpad-iphone.png');

    const km = () => ev('window.__km.splice(0)');
    const rect = (sel) => ev(`(() => { const r = document.querySelector('${sel}').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, l: r.left, t: r.top }; })()`);
    const touch = async (type, pts) => call('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p) => ({ x: p.x, y: p.y, id: p.id ?? 0, radiusX: 1, radiusY: 1, force: 1 })) });
    const tap = async (p, ms = 40) => { await touch('touchStart', [p]); await sleep(ms); await touch('touchEnd', []); };
    const pad = await rect('#kmPad');
    check('touchpad alanı geniş (iPhone ekranının büyük kısmı)', pad.w > 250 && pad.h > 350, JSON.stringify(pad));
    const c = { x: pad.x, y: pad.y };
    await km();

    // tek parmak: göreli hareket, tık yok
    await touch('touchStart', [c]);
    for (let i = 1; i <= 10; i++) { await sleep(30); await touch('touchMove', [{ x: c.x + i * 6, y: c.y + i * 3 }]); }
    await sleep(50); await touch('touchEnd', []); await sleep(60);
    let s = await km();
    const rels = s.filter((m) => m.op === 'rel');
    const sx = rels.reduce((a, m) => a + m.dx, 0), sy = rels.reduce((a, m) => a + m.dy, 0);
    check('touchpad: kaydırma -> göreli hareket (sağa, aşağı), tık yok', rels.length >= 2 && sx > 60 && sy > 30 && sx > sy && !s.some((m) => m.op === 'down'), `${sx},${sy} ${JSON.stringify(s.slice(0, 3))}`);
    // dokunuş -> 300 ms sonra sol tık
    await tap(c);
    s = await km();
    check('touchpad: dokunuş hemen tıklamaz (çift dokunuş beklenir)', !s.some((m) => m.op === 'down'));
    await sleep(400);
    s = await km();
    check('touchpad: dokunuş -> sol tık (down, up)', s.map((m) => `${m.op}:${m.b}`).join(',') === 'down:left,up:left', JSON.stringify(s));
    // iki parmak dokunuş (aynı anda) -> sağ tık
    const two = [{ x: c.x - 40, y: c.y, id: 0 }, { x: c.x + 40, y: c.y, id: 1 }];
    await touch('touchStart', two); await sleep(60); await touch('touchEnd', []); await sleep(50);
    s = await km();
    check('touchpad: iki parmak dokunuş -> sağ tık', s.map((m) => `${m.op}:${m.b}`).join(',') === 'down:right,up:right', JSON.stringify(s));
    // uzun basma -> bırakınca sağ tık
    await touch('touchStart', [c]); await sleep(650);
    const held = await ev("document.getElementById('kmPad').classList.contains('tutuldu')");
    s = await km();
    check('touchpad: uzun basınca gösterge, henüz tık yok', held && !s.length, JSON.stringify(s));
    await touch('touchEnd', []); await sleep(50);
    s = await km();
    check('touchpad: uzun basıp bırakma -> sağ tık', s.map((m) => `${m.op}:${m.b}`).join(',') === 'down:right,up:right', JSON.stringify(s));
    // iki parmak kaydırma -> tekerlek, sağ tık yok
    await touch('touchStart', two);
    for (let i = 1; i <= 8; i++) { await sleep(16); await touch('touchMove', two.map((p) => ({ ...p, y: p.y - i * 15 }))); }
    await sleep(16); await touch('touchEnd', []); await sleep(50);
    s = await km();
    check('touchpad: iki parmak yukarı kaydır -> tekerlek (aşağı), sağ tık yok', s.some((m) => m.op === 'wheel' && m.dy < 0) && !s.some((m) => m.op === 'down'), JSON.stringify(s));
    // kaydırma şeridi
    const sr = await rect('#kmSerit');
    await touch('touchStart', [{ x: sr.x, y: sr.y - 60 }]);
    for (let i = 1; i <= 6; i++) { await sleep(16); await touch('touchMove', [{ x: sr.x, y: sr.y - 60 + i * 20 }]); }
    await touch('touchEnd', []); await sleep(30);
    s = await km();
    check('kaydırma şeridi: aşağı çek -> tekerlek (yukarı)', s.some((m) => m.op === 'wheel' && m.dy > 0) && s.every((m) => m.op === 'wheel'), JSON.stringify(s));
    // Sol tık düğmesi basılı tutulabilir
    const sol = await rect('[data-fare="left"]');
    await touch('touchStart', [sol]); await sleep(80);
    s = await km();
    const onBasili = await ev("document.querySelector('[data-fare=\"left\"]').classList.contains('on')");
    check('Sol tık düğmesi: basınca down (basılı kalır)', s.map((m) => `${m.op}:${m.b}`).join(',') === 'down:left' && onBasili, JSON.stringify(s));
    await touch('touchEnd', []); await sleep(50);
    s = await km();
    check('Sol tık düğmesi: bırakınca up', s.map((m) => `${m.op}:${m.b}`).join(',') === 'up:left', JSON.stringify(s));
    const sag = await rect('[data-fare="right"]');
    await tap(sag); await sleep(50);
    s = await km();
    check('Sağ tık düğmesi -> down/up right', s.map((m) => `${m.op}:${m.b}`).join(',') === 'down:right,up:right', JSON.stringify(s));

    // ---- Medya ----
    await ev("document.querySelector('#kumanda [data-sekme=\"medya\"]').click()");
    await sleep(100);
    await shot('kumanda-2-medya-iphone.png');
    const MEDYA = [[179, 'Oynat'], [177, 'Önceki'], [176, 'Sonraki'], [174, 'Ses −'], [175, 'Ses +'], [173, 'Sessiz']];
    for (const [vk, ad] of MEDYA) {
      const r = await rect(`[data-govde="medya"] [data-vk="${vk}"]`);
      await tap(r); await sleep(60);
      s = await km();
      check(`medya: ${ad} -> key ${vk} aşağı + yukarı`, JSON.stringify(s) === JSON.stringify([{ t: 'kumanda', op: 'key', vk, down: true }, { t: 'kumanda', op: 'key', vk, down: false }]), JSON.stringify(s));
    }
    // ---- Sunum ----
    await ev("document.querySelector('#kumanda [data-sekme=\"sunum\"]').click()");
    await sleep(100);
    await shot('kumanda-3-sunum-iphone.png');
    for (const [vk, ad] of [[34, 'sonraki (PgDn)'], [33, 'önceki (PgUp)'], [116, 'Başlat (F5)'], [66, 'Siyah (B)'], [27, 'Bitir (Esc)']]) {
      const r = await rect(`[data-govde="sunum"] [data-vk="${vk}"]`);
      await tap(r); await sleep(60);
      s = await km();
      check(`sunum: ${ad} -> key ${vk}`, s.length === 2 && s.every((m) => m.op === 'key' && m.vk === vk) && s[0].down && !s[1].down, JSON.stringify(s));
    }
    check('sunum: Esc kumandayı kapatmadı', await ev("!document.getElementById('kumanda').hidden"));
    const big = await rect('[data-govde="sunum"] [data-vk="34"]');
    check('sunum: ileri düğmesi büyük', big.w > 150 && big.h > 140, JSON.stringify(big));
    // ---- Klavye ----
    await ev("document.querySelector('#kumanda [data-sekme=\"klavye\"]').click()");
    await sleep(100);
    await ev("document.getElementById('kmYazi').focus()");
    await call('Input.insertText', { text: 'Merhaba ş' });
    await sleep(50);
    s = await km();
    check('klavye: yazı metin olarak gider', s.length === 1 && s[0].op === 'text' && s[0].s === 'Merhaba ş', JSON.stringify(s));
    check('klavye: yazı alanı boş kalır', (await ev("document.getElementById('kmYazi').value")) === '');
    await call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await sleep(30);
    s = await km();
    check('klavye: ⌫ tek kez', JSON.stringify(s.map((m) => `${m.vk}${m.down ? 'v' : '^'}`)) === '["8v","8^"]', JSON.stringify(s));
    const ok = await rect('[data-govde="klavye"] [data-vk="39"]');
    await tap(ok); await sleep(50);
    s = await km();
    check('klavye: → düğmesi', s.length === 2 && s[0].vk === 39, JSON.stringify(s));
    await shot('kumanda-4-klavye-iphone.png');

    // ---- Görüntü akışı yok ----
    const all = await ev('window.__all.slice()');
    check("kumanda: 'start' hiç gönderilmedi", !all.includes('start'), `${all.length} mesaj`);
    check('kumanda: hiç görüntü karesi gelmedi', (await ev('window.__bin')) === 0, String(await ev('window.__bin')));
    check('kumanda: görüntüleyici açılmadı', await ev("document.getElementById('vViewer').hidden && document.getElementById('screen').width === 0"));

    // ---- iPad boyutu ----
    await ev("document.querySelector('#kumanda [data-sekme=\"pad\"]').click()");
    await call('Emulation.setDeviceMetricsOverride', { width: 1024, height: 1366, deviceScaleFactor: 2, mobile: true });
    await sleep(300);
    check('sayfa yatay taşmıyor (iPad)', await ev('document.documentElement.scrollWidth <= window.innerWidth'));
    const padI = await rect('#kmPad');
    check('iPad: touchpad alanı ekranı doldurur', padI.w > 800 && padI.h > 1000, JSON.stringify(padI));
    await shot('kumanda-5-touchpad-ipad.png');
    await ev("document.querySelector('#kumanda [data-sekme=\"sunum\"]').click()");
    await sleep(100);
    await shot('kumanda-6-sunum-ipad.png');
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await sleep(200);

    // ---- Çıkış: basılı düğme bırakılır, 'end' gider ----
    await ev("document.querySelector('#kumanda [data-sekme=\"pad\"]').click()");
    const sol2 = await rect('[data-fare="left"]');
    await touch('touchStart', [sol2]); await sleep(50);
    await ev("document.getElementById('kmGeri').click()");
    await touch('touchEnd', []); await sleep(50);
    s = await km();
    check("geri: basılı sol düğme bırakılır ve 'end' gider", s.map((m) => m.op + (m.b ? ':' + m.b : '')).join(',') === 'down:left,up:left,end', JSON.stringify(s));
    check('geri: ana menü görünür', await ev("document.getElementById('kumanda').hidden && !document.getElementById('vHome').hidden"));
    check('sayfada JS hatası yok', exceptions.length === 0, exceptions.join(' | '));
  } catch (e) {
    check('tarayıcı testi', false, e.stack || e.message);
  } finally {
    if (browser) kill(browser.pid);
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  }
  console.log(`\n${pass} geçti, ${fail} başarısız`);
  process.exit(fail ? 1 : 0);
})();
