// "Tüm ekranlar", gerçek tarayıcı motorunda (başsız Edge / Chrome), iPhone boyutunda (390x844, dokunmatik):
// seçicide seçenek, birleşik görüntü (en-boy), ekran etiketleri ("1", "2"), doğrudan dokunmada ikinci ekrana giden move
// (ekran 2 + doğru nx, ny), ekranlar arası sürükleme (düğme basılı kalır), fare, touchpad'de imlecin sağ kenardan ikinci
// ekrana geçmesi, yakınlaştırılmış görüntüde eşleme ve etiketler, etikete dokununca tek ekran, seçiciyle geri dönüş.
// Dikeyde etiketler görüntünün dışında (üstteki boşlukta); touchpad'de etikete denk gelen dokunuş / kaydırma çekirdeğe geçer
// (tık, imleç), fareyle etiket yine tek ekran açar.
// Dizilim kullanıcınınki gibi taklit edilir (REMOTE_EKRANLAR_SAHTE: 1920×1080 + sağında 1920×1080); bu bilgisayarda şu an
// tek monitör olduğundan ikinci "ekranın" karesi yardımcıdan ana ekran olarak gelir (içerik değil, boyut ve eşleme sınanır).
// Akış JPEG'e zorlanır (sahte ikinci ekran gerçek masaüstünün dışında: gdigrab onu yakalayamaz).
// Girdi mesajları (move/down/up/wheel/key/text/kalem) sayfada YAKALANIR ve sunucuya GİTMEZ; sunucu da kuru modda.
// iOS Safari emüle EDİLEMEZ. Ekran görüntüleri %TEMP%\rc-tum-ekranlar\ altına kaydedilir.
// @ortam REMOTE_EKRANLAR_SAHTE=[{"name":"\\\\.\\DISPLAY1","x":0,"y":0,"w":1920,"h":1080,"primary":true,"dpi":120,"scale":1.25},{"name":"\\\\.\\DISPLAY2","x":1920,"y":0,"w":1920,"h":1080,"primary":false,"dpi":96,"scale":1}]
// @ortam REMOTE_GIRDI_KURU=1
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
const SHOTS = path.join(os.tmpdir(), 'rc-tum-ekranlar');
const D1 = '\\\\.\\DISPLAY1', D2 = '\\\\.\\DISPLAY2';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kill = (pid) => spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });

let pass = 0, fail = 0;
const check = (n, c, x = '') => { console.log(`${c ? 'OK  ' : 'FAIL'} ${n} ${x}`); c ? pass++ : fail++; };
const getJson = (u) => new Promise((res, rej) => http.get(u, (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej));

// Girdi sunucuya gitmez (window.__sent); akış JPEG'e zorlanır.
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
      if (m.t === 'start') { m.codecs = ['jpeg']; d = JSON.stringify(m); }
    } catch {}
    return __orig.call(this, d);
  };`;

const kisa = (list) => JSON.stringify(list.map((m) => (m.t === 'move' ? `move ${m.s ? m.s.slice(-1) : '-'} ${m.x.toFixed(3)} ${m.y.toFixed(3)}` : `${m.t} ${m.b || ''}`)));

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
    const touch = (type, pts) => call('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: i, radiusX: 1, radiusY: 1, force: 1 })) });
    const tap = async (p) => { await touch('touchStart', [p]); await sleep(40); await touch('touchEnd', []); await sleep(150); };
    const rectOf = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, top: r.top, w: r.width, h: r.height }; })()`);
    // Görüntünün (contain ile yerleşmiş, yakınlaştırma dahil) ekrandaki kutusu ve oradaki (u, v) noktası.
    const icerik = () => ev(`(() => { const c = document.getElementById('screen'); const r = c.getBoundingClientRect();
      const k = Math.min(r.width / c.width, r.height / c.height); const w = c.width * k, h = c.height * k;
      return { left: r.left + (r.width - w) / 2, top: r.top + (r.height - h) / 2, w, h, cw: c.width, ch: c.height }; })()`);
    const nokta = (b, u, v) => ({ x: b.left + u * b.w, y: b.top + v * b.h });
    const etiketler = () => ev(`[...document.querySelectorAll('.tum-etiket')].filter((e) => e.getClientRects().length && !e.closest('[hidden]')).map((e) => { const r = e.getBoundingClientRect(); return { t: e.textContent, left: r.left, top: r.top, w: r.width, h: r.height, op: getComputedStyle(e).backgroundColor }; })`);
    const bekle = async (expr, n = 60) => { for (let i = 0; i < n; i++) { if (await ev(expr)) return true; await sleep(200); } return false; };
    // Fiziksel piksel x (birleşik görüntüde) -> beklenen nx (kullanıcının dizilimi, 3840 geniş).
    const bekNx = (u) => { const px = u * 3839; return px < 1920 ? { s: D1, x: px / 1919 } : { s: D2, x: (px - 1920) / 1919 }; };

    await call('Page.enable'); await call('Runtime.enable');
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await call('Page.addScriptToEvaluateOnNewDocument', { source: YAKALAYICI });
    await call('Page.navigate', { url: `http://localhost:${PORT}/` });
    for (let i = 0; i < 40 && !(await ev("!document.getElementById('vSetup').hidden").catch(() => false)); i++) await sleep(250);
    if (!(await ev('Array.isArray(window.__sent)'))) throw new Error('girdi yakalayıcı kurulamadı, test durduruldu');
    await ev(`(() => { const f = document.getElementById('setupForm'); f.username.value='deneme'; f.password.value='deneme123'; f.password2.value='deneme123'; f.requestSubmit(); })()`);
    await bekle("!document.getElementById('vHome').hidden");

    // ---- Ana menüde seçici ----
    const secenekler = await ev("[...document.getElementById('screenPick').options].map((o) => [o.value, o.textContent])");
    check('ana menü: seçicide "Tüm ekranlar" var', secenekler.some(([v, t]) => v === '*' && /Tüm ekranlar/.test(t)) && !(await ev("document.getElementById('screenPickRow').hidden")), JSON.stringify(secenekler));
    await ev("document.getElementById('screenPick').value = '*'");
    await shot('1-ana-menu');
    await ev("document.getElementById('modeControl').click()");
    await bekle("document.getElementById('screen').width > 0");
    await sleep(800);
    let b = await icerik();
    check('birleşik görüntü geldi, en-boy 3840:1080', b.cw > 0 && Math.abs(b.cw / b.ch - 3840 / 1080) < 0.01, `${b.cw}×${b.ch}`);
    check('görüntü toplam pikselde ~1920×1080 (Otomatik)', b.cw * b.ch <= 1920 * 1080 * 1.01, `${b.cw}×${b.ch}`);
    const sel = await ev("[document.getElementById('screenSel').value, [...document.getElementById('screenSel').options].map((o) => o.value)]");
    check('menüdeki seçici "Tüm ekranlar"da', sel[0] === '*' && sel[1].includes(D1) && sel[1].includes(D2), JSON.stringify(sel));
    let et = await etiketler();
    check('iki ekran etiketi: "1" ve "2"', et.length === 2 && et[0].t === '1' && et[1].t === '2', JSON.stringify(et));
    check('etiketler ekranların sol kenarı hizasında', et.length === 2 && Math.abs(et[0].left - (b.left + 6)) < 2 && Math.abs(et[1].left - (b.left + b.w / 2 + 6)) < 2,
      JSON.stringify({ et: et.map((e) => [e.left, e.top]), b }));
    // Dikey telefonda birleşik görüntü basık (390×110): etiket içeride ekranın sol üstünü (simgeler, menüler) örterdi
    check('dikeyde etiketler görüntünün dışında, hemen üstündeki boşlukta', et.length === 2 && et.every((e) => e.top + e.h <= b.top + 0.5 && e.top >= b.top - e.h - 12),
      JSON.stringify({ et: et.map((e) => [e.top, e.h]), top: b.top }));
    check('etiketler küçük ve yarı saydam', et.every((e) => e.w <= 48 && e.h <= 40 && /rgba\(.*, 0\.\d+\)/.test(e.op)), JSON.stringify(et.map((e) => [e.w, e.h, e.op])));
    await shot('2-tum-ekranlar');

    // ---- Doğrudan dokunma ----
    await sent();
    const durum = await ev("document.getElementById('touchModeBtn').textContent");
    if (/Touchpad/.test(durum)) await tap(await rectOf('#touchModeBtn'));
    await tap(nokta(b, 0.75, 0.5));
    let s = await sent();
    let mv = s.find((m) => m.t === 'move');
    let bk = bekNx(0.75);
    check('dokunma: ikinci ekrana dokununca move ekran 2, nx≈0.5 ny≈0.5', mv && mv.s === D2 && Math.abs(mv.x - bk.x) < 0.01 && Math.abs(mv.y - 0.5) < 0.01, kisa(s));
    check('dokunma: ardından sol tık', s.some((m) => m.t === 'down' && m.b === 'left') && s.some((m) => m.t === 'up' && m.b === 'left'), kisa(s));
    await sleep(400); // çift tık sayılmasın
    await tap(nokta(b, 0.2, 0.9));
    s = await sent();
    mv = s.find((m) => m.t === 'move');
    bk = bekNx(0.2);
    check('dokunma: birinci ekrana dokununca move ekran 1', mv && mv.s === D1 && Math.abs(mv.x - bk.x) < 0.01 && Math.abs(mv.y - 0.9) < 0.01, kisa(s));
    await sleep(400);

    // ---- Ekranlar arası sürükleme (basılı tut + sürükle): düğme basılı kalır ----
    const p0 = nokta(b, 0.4, 0.5);
    await touch('touchStart', [p0]);
    await sleep(650); // HOLD_MS
    for (let i = 1; i <= 10; i++) { await touch('touchMove', [nokta(b, 0.4 + i * 0.03, 0.5)]); await sleep(30); }
    await sleep(60);
    await touch('touchEnd', []);
    await sleep(150);
    s = await sent();
    const iDown = s.findIndex((m) => m.t === 'down'), iUp = s.findIndex((m) => m.t === 'up');
    const iD1 = s.findIndex((m) => m.t === 'move' && m.s === D1), iD2 = s.findIndex((m) => m.t === 'move' && m.s === D2);
    const sonMove = [...s].reverse().find((m) => m.t === 'move');
    check('sürükleme: ekran 1\'de bas, ekran 2\'de bırak (arada up yok)', iD1 >= 0 && iD1 < iDown && iDown < iD2 && iD2 < iUp && s.filter((m) => m.t === 'up').length === 1 && sonMove.s === D2, kisa(s));
    check('sürükleme: son konum ekran 2\'de (nx≈0.4)', sonMove && Math.abs(sonMove.x - bekNx(0.7).x) < 0.02, kisa([sonMove]));

    // ---- Fare (masaüstü tarayıcı yolu) ----
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: nokta(b, 0.9, 0.2).x, y: nokta(b, 0.9, 0.2).y });
    await sleep(120);
    s = await sent();
    mv = [...s].reverse().find((m) => m.t === 'move');
    check('fare: hareket ekran 2\'ye (nx≈0.8)', mv && mv.s === D2 && Math.abs(mv.x - bekNx(0.9).x) < 0.01 && Math.abs(mv.y - 0.2) < 0.01, kisa(s));

    // ---- Touchpad: imleç ekran 1'in sağ kenarından ekran 2'ye geçer ----
    await tap(await rectOf('#touchModeBtn'));
    check('touchpad moduna geçildi', /Touchpad/.test(await ev("document.getElementById('touchModeBtn').textContent")));
    await sent();
    const st = await rectOf('#stage');
    const kaydir = async (x0, x1, y, adim = 12) => {
      await touch('touchStart', [{ x: x0, y }]);
      for (let i = 1; i <= adim; i++) { await touch('touchMove', [{ x: x0 + ((x1 - x0) * i) / adim, y }]); await sleep(16); }
      await touch('touchEnd', []);
      await sleep(80);
    };
    // Önce sola (ekran 1'e), sonra yavaşça sağa: hareketler ekran 1'in sağ kenarından ekran 2'nin sol kenarına geçmeli.
    await kaydir(st.left + 300, st.left + 200, st.y);
    await sleep(200);
    await sent();
    for (let i = 0; i < 6; i++) await kaydir(st.left + 120, st.left + 150, st.y, 6);
    await sleep(200);
    s = (await sent()).filter((m) => m.t === 'move');
    const gecis = s.findIndex((m, i) => i > 0 && s[i - 1].s === D1 && m.s === D2);
    check('touchpad: imleç ekran 1\'de başladı', s.length && s[0].s === D1, kisa(s.slice(0, 3)));
    check('touchpad: imleç ekran 1\'in sağ kenarından ekran 2\'ye geçti', gecis > 0 && s[gecis - 1].x > 0.9 && s[gecis].x < 0.1, kisa(s.slice(Math.max(0, gecis - 2), gecis + 2)));
    await shot('3-touchpad');
    // Touchpad'de dokunuşun yeri anlamsız: etikete denk gelen dokunuş da tık olmalı, görünüm tek ekrana geçmemeli
    await sleep(400);
    await sent();
    await tap(await rectOf('.tum-etiket:nth-child(2)'));
    await sleep(400); // touchpad tek tık, olası çift dokunuşu bekledikten sonra gider
    s = await sent();
    check('touchpad: etikete dokunuş sol tık gönderdi', s.some((m) => m.t === 'down' && m.b === 'left'), kisa(s));
    check('touchpad: etikete dokunuş görünümü değiştirmedi', (await ev("document.getElementById('screenSel').value")) === '*');
    const e1 = await rectOf('.tum-etiket:nth-child(1)');
    await kaydir(e1.x, e1.x + 60, e1.y, 10);
    s = (await sent()).filter((m) => m.t === 'move');
    check('touchpad: etiketin üstünden başlayan kaydırma imleci taşıdı', s.length > 0, `${s.length} move`);
    await tap(await rectOf('#touchModeBtn')); // doğrudan moda dön
    await sent();

    // ---- Yakınlaştırma (iki parmak sıkıştırma): eşleme ve etiketler yakınlaştırılmış görüntüde de doğru ----
    const m0 = { x: st.x, y: st.y };
    await touch('touchStart', [{ x: m0.x - 30, y: m0.y }, { x: m0.x + 30, y: m0.y }]);
    for (let i = 1; i <= 10; i++) { await touch('touchMove', [{ x: m0.x - 30 - i * 9, y: m0.y }, { x: m0.x + 30 + i * 9, y: m0.y }]); await sleep(20); }
    await touch('touchEnd', []);
    await sleep(300);
    await sent();
    const z = await icerik();
    check('yakınlaştırıldı', z.w > b.w * 1.5, `${b.w.toFixed(0)} -> ${z.w.toFixed(0)}`);
    // Ekranın ortasındaki nokta (yakınlaştırılmış görüntüde nerede olursa olsun) doğru ekrana ve konuma.
    const hedef = { x: st.x + 40, y: st.y };
    const u = (hedef.x - z.left) / z.w, v = (hedef.y - z.top) / z.h;
    await tap(hedef);
    s = await sent();
    mv = s.find((m) => m.t === 'move');
    bk = bekNx(u);
    check('yakınlaştırılmışken dokunma doğru ekrana ve konuma', mv && mv.s === bk.s && Math.abs(mv.x - bk.x) < 0.01 && Math.abs(mv.y - v) < 0.01, `${kisa(s)} beklenen ${bk.s.slice(-1)} ${bk.x.toFixed(3)} ${v.toFixed(3)}`);
    et = await etiketler();
    const e2 = et.find((e) => e.t === '2');
    check('yakınlaştırılmışken etiket 2 ekran 2\'nin köşesinde', e2 && Math.abs(e2.left - (z.left + z.w / 2 + 6)) < 2, JSON.stringify({ e2, z }));
    await shot('4-yakinlastirilmis');
    await tap(await rectOf('#zoomBtn')); // 1x
    await sleep(200);
    await sent();

    // ---- Etikete dokunma: o ekran tek başına açılır; dokunuş bilgisayara gitmez ----
    await tap(await rectOf('.tum-etiket:nth-child(2)'));
    s = await sent();
    check('etikete dokunuş bilgisayara tıklama göndermedi', !s.some((m) => m.t === 'down' || m.t === 'move'), kisa(s));
    check('etiket 2: seçici ekran 2\'de', (await ev("document.getElementById('screenSel').value")) === D2);
    const tek = await bekle("(() => { const c = document.getElementById('screen'); return Math.abs(c.width / c.height - 16 / 9) < 0.01; })()", 40);
    b = await icerik();
    check('etiket 2: görüntü tek ekran (16:9)', tek, `${b.cw}×${b.ch}`);
    check('tek ekranda etiket yok', (await etiketler()).length === 0);
    await tap(nokta(b, 0.5, 0.5));
    s = await sent();
    mv = s.find((m) => m.t === 'move');
    check('tek ekranda move eski biçimde (s yok, nx≈0.5)', mv && mv.s === undefined && Math.abs(mv.x - 0.5) < 0.01, kisa(s));
    await shot('5-tek-ekran');
    await sleep(400);

    // ---- Seçiciyle "Tüm ekranlar"a geri dönüş ----
    await ev("(() => { const s = document.getElementById('screenSel'); s.value = '*'; s.dispatchEvent(new Event('change')); })()");
    const geri = await bekle("(() => { const c = document.getElementById('screen'); return Math.abs(c.width / c.height - 3840 / 1080) < 0.01; })()", 40);
    check('seçiciyle tüm ekranlara dönüldü', geri && (await etiketler()).length === 2);
    b = await icerik();
    await tap(nokta(b, 0.65, 0.7)); // etiketin altında
    s = await sent();
    mv = s.find((m) => m.t === 'move');
    check('dönüşte yine ekran 2', mv && mv.s === D2, kisa(s));

    // ---- Touchpad modunda fare: etiket yine tek ekran açar (touchpad yalnızca dokunuşu etkiler) ----
    await sleep(400);
    await tap(await rectOf('#touchModeBtn'));
    await sent();
    const e1f = await rectOf('.tum-etiket:nth-child(1)');
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: e1f.x, y: e1f.y });
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: e1f.x, y: e1f.y, button: 'left', clickCount: 1 });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: e1f.x, y: e1f.y, button: 'left', clickCount: 1 });
    await sleep(300);
    s = await sent();
    check('touchpad modunda fareyle etiket 1: tek ekran, bilgisayara tık yok', (await ev("document.getElementById('screenSel').value")) === D1 && !s.some((m) => m.t === 'down'), kisa(s));

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
