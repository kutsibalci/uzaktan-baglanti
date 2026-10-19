// @sunucu yok
// Başlatma ve Windows engelleri arayüzü, gerçek tarayıcı motorunda (başsız Edge / Chrome), iPhone boyutunda (390x844, dokunmatik):
// ana menüdeki engel uyarısı, yönetim panelindeki "Başlatma ve Windows engelleri" bölümü ("Windows açılınca başlat" anahtarı —
// test sunucusunda KURU: kayıt defterine yazılmaz), yeni cihaz onay kutusu (onay penceresi açılamadığında bu bilgisayardaki
// tarayıcıdan izin verme). Engel taklidi: RemoteHelper.exe ve Pano.exe geçersiz dosyalara yönlendirilir (gerçek onay penceresi de
// açılmaz). iOS Safari emüle EDİLEMEZ. Ekran görüntüleri %TEMP%\rc-baslatma\ altına kaydedilir. Edge ya da Chrome yoksa atlanır.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const ROOT = path.join(__dirname, '..');
const WebSocket = require(path.join(ROOT, 'node_modules', 'ws'));
const PORT = process.env.TEST_PORT || '3999';
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const SHOTS = path.join(os.tmpdir(), 'rc-baslatma');
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kill = (pid) => spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });

let pass = 0, fail = 0;
const check = (n, c, x = '') => { console.log(`${c ? 'OK  ' : 'FAIL'} ${n} ${x}`); c ? pass++ : fail++; };
const getJson = (u) => new Promise((res, rej) => http.get(u, (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej));

function sunucuBaslat(dataDir, ortam) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, ...ortam, PORT, REMOTE_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => reject(new Error(`sunucu başlamadı:\n${out}`)), 30000);
    const onData = (d) => { out += d; if (out.includes('sunucusu çalışıyor')) { clearTimeout(timer); p.removeAllListeners('exit'); resolve({ p, log: () => out }); } };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('exit', (c) => { clearTimeout(timer); reject(new Error(`sunucu kapandı (${c}):\n${out}`)); });
  });
}

(async () => {
  const exe = BROWSERS.find((b) => fs.existsSync(b));
  if (!exe) { console.log('OK   tarayıcı (Edge/Chrome) bulunamadı, tarayıcı testi atlandı'); process.exit(0); }
  fs.mkdirSync(SHOTS, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(process.env.TEST_TMP || os.tmpdir(), 'baslatma-tarayici-'));
  fs.mkdirSync(path.join(tmp, 'sahte'));
  for (const ad of ['RemoteHelper', 'Pano']) fs.writeFileSync(path.join(tmp, 'sahte', `${ad}.exe`), 'engel taklidi\r\n');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-tarayici-'));
  let browser, sunucu;
  try {
    // REMOTE_RUN_ANAHTARI YOK: TEST_PORT tanımlı olduğundan özellik kuru çalışmalı (gerçek Run anahtarına yazmaz).
    sunucu = await sunucuBaslat(path.join(tmp, 'veri'), {
      REMOTE_EXE_REMOTEHELPER: path.join(tmp, 'sahte', 'RemoteHelper.exe'), REMOTE_EXE_PANO: path.join(tmp, 'sahte', 'Pano.exe'),
      REMOTE_BILDIRIM_KURU: '1', TEPSI_BASLANGIC_KLASORU: tmp,
    });
    browser = spawn(exe, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
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
    const shot = async (ad) => {
      const r = await call('Page.captureScreenshot', { format: 'png' });
      const p = path.join(SHOTS, `${ad}.png`);
      fs.writeFileSync(p, Buffer.from(r.result.data, 'base64'));
      console.log(`     ekran görüntüsü: ${p}`);
    };
    const rect = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, top: r.top, bottom: r.bottom, left: r.left, right: r.right }; })()`);
    const touch = (type, pts) => call('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: i, radiusX: 1, radiusY: 1, force: 1 })) });
    const tap = async (sel) => {
      await ev(`document.querySelector(${JSON.stringify(sel)}).scrollIntoView({ block: 'center' })`);
      await sleep(100);
      const p = await rect(sel);
      if (!p) throw new Error(`öğe yok: ${sel}`);
      await touch('touchStart', [p]); await sleep(40); await touch('touchEnd', []); await sleep(200);
    };
    const shown = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && !e.hidden && getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0; })()`);
    const until = async (expr, ms = 8000) => { for (let i = 0; i < ms / 200; i++) { if (await ev(expr).catch(() => false)) return true; await sleep(200); } return false; };
    const tasma = () => ev('document.documentElement.scrollWidth <= innerWidth + 1');

    await call('Page.enable'); await call('Runtime.enable');
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await call('Emulation.setUserAgentOverride', { userAgent: IPHONE_UA });
    await call('Page.navigate', { url: `http://localhost:${PORT}/` });
    await until("!document.getElementById('vSetup').hidden", 10000);
    await ev(`(() => { const f = document.getElementById('setupForm'); f.username.value='yonetici'; f.password.value='yonetici123'; f.password2.value='yonetici123'; f.requestSubmit(); })()`);
    await until("!document.getElementById('vHome').hidden", 10000);

    // ---- Ana menü uyarısı ----
    check('ana menüde engel uyarısı görünüyor', await until("!document.getElementById('baslatmaUyari').hidden"));
    const metin = await ev("document.getElementById('baslatmaUyari').textContent");
    check('uyarı metni: Akıllı Uygulama Denetimi / Windows, engellenen dosyalar ve özellikler', /engelledi/.test(metin) && /RemoteHelper\.exe/.test(metin) && /Pano\.exe/.test(metin) && /pano eşitleme/.test(metin), metin.trim());
    const ur = await rect('#baslatmaUyari');
    check('uyarı ekrana sığıyor, sayfa yatay taşmıyor', ur.left >= 0 && ur.right <= 390 && (await tasma()), JSON.stringify(ur));
    await shot('1-ana-menu-uyari');

    // ---- Yönetim paneli ----
    await tap('#baslatmaUyari [data-k="ayrinti"]');
    check('"Ayrıntı" yönetim panelini açtı', await until("!document.getElementById('vAdmin').hidden"));
    check('bölüm: başlatma, engeller ve seçenekler', await until("(document.querySelector('.bsl-yonetim')?.textContent || '').includes('RemoteHelper.exe')"));
    const bolum = await ev("document.querySelector('.bsl-yonetim').textContent");
    check('bölüm metni: başlatıcı, SAC durumu, ne yapılabilir (karar sizin, imzalama)', /konsol penceresi/.test(bolum) && /Akıllı Uygulama Denetimi: /.test(bolum)
      && /sizin kararınızdır/.test(bolum) && /kod imzalama/.test(bolum) && /Uzaktan görüntü ve kontrol bu dosya olmadan çalışmaz/.test(bolum), bolum.slice(0, 200));
    await ev("document.querySelector('.bsl-yonetim').scrollIntoView({ block: 'start' })");
    await sleep(200);
    check('yönetim sayfası yatay taşmıyor', await tasma());
    await shot('2-yonetim-baslatma');

    // ---- Windows açılınca başlat (kuru) ----
    check('anahtar başlangıçta kapalı, yöntem arka plan', await ev("!document.getElementById('bslOtomatik').checked && document.getElementById('bslYontem').value === 'arka-plan'"));
    check('Tepsi seçeneği (Tepsi.exe yok / varsayılan dışı port) seçilemez', await ev("document.querySelector('#bslYontem option[value=tepsi]').disabled"));
    await tap('#bslOtomatik');
    check('açılınca: "açık (arka plan)" + kuru notu', await until("/Açık: arka plan \\(tepsisiz\\)/.test(document.querySelector('.bsl-yonetim').textContent) && /kayıt defterine yazılmıyor/.test(document.querySelector('.bsl-yonetim').textContent)"),
      await ev("document.querySelector('.bsl-yonetim p.small:nth-of-type(2)')?.textContent || ''"));
    check('kaydedildi mesajı', await until("/Windows açılınca başlatma açık/.test(document.querySelector('.bsl-yonetim > .msg').textContent)"));
    await shot('3-yonetim-otomatik-acik');
    await tap('#bslOtomatik');
    check('kapatılınca: kapalı', await until("/Windows açılınca başlatma kapatıldı/.test(document.querySelector('.bsl-yonetim > .msg').textContent) && !document.getElementById('bslOtomatik').checked"));

    // ---- Yeni cihaz onayı: pencere yok, bu tarayıcıdan izin ----
    await ev("RC.send({ t: 'admin', op: 'setSetting', key: 'trustTailscale', value: false })");
    await ev("RC.send({ t: 'admin', op: 'addUser', username: 'uzak', password: 'uzak12345', role: 'control' })");
    await sleep(500);
    await ev("document.getElementById('backBtn')?.click(); document.querySelector('#vAdmin [data-act=back], #adminBack')?.click()");
    const uzak = new WebSocket(`ws://localhost:${PORT}`, { headers: { 'X-Forwarded-For': '100.100.9.1' } });
    const gelen = [];
    uzak.on('message', (d) => gelen.push(JSON.parse(d.toString())));
    await new Promise((r) => uzak.on('open', r));
    uzak.send(JSON.stringify({ t: 'login', username: 'uzak', password: 'uzak12345', deviceName: 'iPhone · Safari' }));
    check('onay kutusu tarayıcıda göründü', await until("!document.getElementById('onayKutusu').hidden"));
    const kutu = await ev("document.getElementById('onayKutusu').textContent");
    check('kutuda kullanıcı, cihaz ve "pencere açılamadı" notu', /uzak/.test(kutu) && /iPhone · Safari/.test(kutu) && /açılamadı/.test(kutu), kutu.replace(/\s+/g, ' ').slice(0, 160));
    const kr = await rect('#onayKutusu');
    const dugme = await rect('#onayKutusu [data-k="izin"]');
    check('kutu ekrana sığıyor, düğmeler en az 44px', kr.left >= 0 && kr.right <= 390 && kr.bottom <= 844 && dugme.h >= 44, `${JSON.stringify(kr)} düğme ${dugme.h}`);
    await shot('4-onay-kutusu');
    await tap('#onayKutusu [data-k="izin"]');
    let auth = null;
    for (let i = 0; i < 40 && !auth; i++) { auth = gelen.find((m) => m.t === 'auth'); await sleep(200); }
    check('"İzin ver" ile uzak giriş açıldı', auth?.ok === true, JSON.stringify(auth || gelen.map((m) => m.t)));
    check('kutu kapandı', await until("document.getElementById('onayKutusu').hidden"));
    uzak.close();

    check('sayfada yakalanmamış hata yok', exceptions.length === 0, JSON.stringify(exceptions));
    cdp.close();
  } catch (e) {
    console.log('HATA', e.stack || e);
    if (sunucu) console.log(sunucu.log().slice(-2000));
    fail++;
  } finally {
    if (browser) kill(browser.pid);
    if (sunucu) kill(sunucu.p.pid);
    await sleep(500);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* tarayıcı dosyaları bırakıyor olabilir */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
    console.log(`\n${pass} kontrol geçti, ${fail} hata`);
    process.exit(fail ? 1 : 0);
  }
})();
