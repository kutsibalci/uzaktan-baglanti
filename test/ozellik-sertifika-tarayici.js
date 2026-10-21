// Ev ağı HTTPS kurulum akışı, gerçek tarayıcı motorunda (başsız Edge / Chrome): sayfa ev ağı IP'sinden HTTP ile açılır,
// ana menüde öneri şeridi, "Nasıl?" → iPhone rehberi (Sertifika Güven Ayarları uyarısı vurgulu), ⋯ menüde "🔒 Ev ağında HTTPS",
// güven yoklaması (önce güvenmiyor; sonra tarayıcıya sertifika hatası yok saydırılarak "güveniyor" benzetilir), şifreli adrese
// geçiş (isSecureContext + VideoDecoder), iPad (iPadOS kendini Mac gösterir) ve Android rehberi, yönetim bölümü.
// Girdi mesajları sayfada YAKALANIR (sunucuya gitmez). iOS Safari'nin profil kurulumu emüle EDİLEMEZ: yalnızca boyut,
// dokunma ve kullanıcı aracısı taklit edilir. Ekran görüntüleri %TEMP%\rc-sertifika\ altına kaydedilir.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const ROOT = path.join(__dirname, '..');
const WebSocket = require(path.join(ROOT, 'node_modules', 'ws'));
const { yerelAdresler } = require(path.join(ROOT, 'lib', 'sertifika'));
const PORT = process.env.TEST_PORT || 3999;
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const SHOTS = path.join(os.tmpdir(), 'rc-sertifika');
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';
const IPAD_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kill = (pid) => spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });

let pass = 0, fail = 0;
const check = (n, c, x = '') => { console.log(`${c ? 'OK  ' : 'FAIL'} ${n} ${x}`); c ? pass++ : fail++; };
const getJson = (u) => new Promise((res, rej) => http.get(u, (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej));

const YAKALAYICI = `
  window.__sent = [];
  const __orig = WebSocket.prototype.send;
  const __block = new Set(['move','down','up','wheel','key','text','kalem','guc']);
  WebSocket.prototype.send = function (d) {
    try { const m = JSON.parse(d); if (__block.has(m.t)) { window.__sent.push(m); return; } } catch {}
    return __orig.call(this, d);
  };`;

// Yönetici hesabı (localhost'tan) + ev ağından girişte bilgisayarda onay penceresi açılmasın.
function hazirlik() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    ws.on('message', (d) => {
      const m = JSON.parse(d);
      if (m.t === 'hello') ws.send(JSON.stringify({ t: 'setup', username: 'deneme', password: 'deneme123', deviceName: 'test' }));
      if (m.t === 'auth' && m.ok) ws.send(JSON.stringify({ t: 'admin', op: 'setSetting', key: 'requireApproval', value: false }));
      if (m.t === 'adminData') { ws.close(); resolve(); }
      if (m.t === 'auth' && !m.ok) reject(new Error(m.error));
    });
    ws.on('error', reject);
  });
}

(async () => {
  const exe = BROWSERS.find((b) => fs.existsSync(b));
  if (!exe) { console.log('OK   tarayıcı (Edge/Chrome) bulunamadı, tarayıcı testi atlandı'); process.exit(0); }
  const lan = yerelAdresler().find((x) => x.startsWith('192.168.')) || yerelAdresler().find((x) => x.startsWith('10.') || x.startsWith('172.'));
  if (!lan) { console.log('OK   ev ağı adresi yok, tarayıcı testi atlandı'); process.exit(0); }
  await hazirlik();
  const durum = await getJson(`http://${lan}:${PORT}/api/sertifika/durum`);
  check('sunucuda ev ağı HTTPS açık', durum.acik && durum.adres === `https://${lan}:${durum.port}`, JSON.stringify(durum));
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
    let id = 0; const pending = new Map();
    const exceptions = [];
    cdp.on('message', (d) => {
      const m = JSON.parse(d);
      if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    });
    const call = (method, params = {}) => new Promise((r, j) => { const i = ++id; pending.set(i, r); cdp.send(JSON.stringify({ id: i, method, params })); setTimeout(() => j(new Error(`CDP zaman aşımı: ${method}`)), 15000); });
    const ev = async (expression) => { const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails)); return r.result?.result?.value; };
    const bekle = async (expr, ms = 10000) => { for (let i = 0; i < ms / 200; i++) { if (await ev(expr).catch(() => false)) return true; await sleep(200); } return false; };
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
    const text = (sel) => ev(`document.querySelector(${JSON.stringify(sel)})?.textContent || ''`);
    const cihaz = async (w, h, ua, platform) => {
      await call('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: w > 900 ? 2 : 3, mobile: true });
      await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      await call('Emulation.setUserAgentOverride', { userAgent: ua, platform });
    };
    const giris = async (url) => {
      await call('Page.navigate', { url });
      if (!(await bekle("!document.getElementById('vLogin').hidden || !document.getElementById('vHome').hidden"))) throw new Error(`giriş ekranı gelmedi: ${url}`);
      if (await ev("!document.getElementById('vLogin').hidden")) {
        await ev(`(() => { const f = document.getElementById('tAccount'); f.username.value = 'deneme'; f.password.value = 'deneme123'; f.requestSubmit(); })()`);
      }
      if (!(await bekle("!document.getElementById('vHome').hidden"))) throw new Error('ana menü gelmedi');
    };

    await call('Page.enable'); await call('Runtime.enable'); await call('Security.enable');
    await call('Page.addScriptToEvaluateOnNewDocument', { source: YAKALAYICI });

    // ---------------- iPhone (390x844), ev ağı HTTP ----------------
    await cihaz(390, 844, IPHONE_UA, 'iPhone');
    const httpUrl = `http://${lan}:${PORT}/`;
    await giris(httpUrl);
    check('HTTP sayfası güvenli bağlam değil (WebCodecs yok)', (await ev('window.isSecureContext')) === false);
    check('ana menüde öneri şeridi görünüyor', await bekle("(() => { const e = document.getElementById('sertifikaSerit'); return e && !e.hidden; })()"));
    const serit = await text('#sertifikaSerit');
    check('şerit: kurulum önerisi + "Nasıl?"', /şifreli bağlantı hazır/.test(serit) && (await shown('#sertifikaSerit [data-k="nasil"]')), serit);
    const sr = await rect('#sertifikaSerit');
    check('şerit ekrana sığıyor', sr.left >= 0 && sr.right <= 390, JSON.stringify(sr));
    await shot('1-iphone-ana-menu-serit');

    await tap('#sertifikaSerit [data-k="nasil"]');
    check('"Nasıl?" rehber panelini açtı', await shown('#sertifikaPanel'));
    await bekle("/güvenmiyor/.test(document.querySelector('#sertifikaPanel .srt-durum')?.textContent || '')");
    const pd = await text('#sertifikaPanel .srt-durum');
    check('durum: HTTP uyarısı + "henüz güvenmiyor" (yoklama başarısız)', /HTTP/.test(pd) && /henüz güvenmiyor/.test(pd), pd);
    check('iPhone için iOS rehberi önde', /Kurulum \(iPhone \/ iPad\)/.test(await text('#sertifikaPanel .srt-baslik')));
    const ic = await text('#sertifikaPanel');
    check('rehber: İndirilen Profil → Yükle, Sertifika Güven Ayarları, Doğrulanmamış açıklaması', /İndirilen Profil/.test(ic) && /Sertifika Güven Ayarları/.test(ic) && /Doğrulanmamış/.test(ic) && /Safari/.test(ic));
    check('rehber: güven adımı vurgulu uyarı', (await shown('#sertifikaPanel .srt-onemli')) && /UNUTULURSA ÇALIŞMAZ/.test(await text('#sertifikaPanel .srt-onemli')));
    const indir = await ev("document.querySelector('#sertifikaPanel [data-k=\"indir-ios\"]')?.getAttribute('href')");
    check('iOS indirme bağlantısı .mobileconfig', indir === '/api/sertifika/ca.mobileconfig', indir);
    const tip = await ev(`fetch(${JSON.stringify(indir)}).then((r) => r.status + ' ' + r.headers.get('content-type'))`);
    check('sayfadan oturumsuz profil indirilebiliyor', tip === '200 application/x-apple-aspen-config', tip);
    const gec = await ev("document.querySelector('#sertifikaPanel [data-k=\"gec\"]')?.getAttribute('href')");
    check('"adresine geç" düğmesi aynı IP\'nin HTTPS adresi', gec === `https://${lan}:${durum.port}/`, gec);
    const pr = await rect('#sertifikaPanel');
    check('panel telefona sığıyor (genişlik, alt kenar)', pr.left >= 0 && pr.right <= 390 && pr.bottom <= 844, JSON.stringify(pr));
    await shot('2-iphone-rehber');
    await ev("document.querySelector('#sertifikaPanel .srt-onemli').scrollIntoView({ block: 'center' })");
    await sleep(150);
    await shot('3-iphone-rehber-guven-adimi');
    await tap('#sertifikaPanel .rc-x');
    check('rehber ✕ ile kapandı', !(await shown('#sertifikaPanel')));

    // ⋯ menüde satır (görüntüleyicide)
    await ev("document.getElementById('modeControl').click()");
    await bekle("!document.getElementById('vViewer').hidden");
    await sleep(800);
    await tap('#menuBtn');
    if (await shown('#dahaFazla')) await tap('#dahaFazla'); // telefonda az kullanılanlar katlı
    check('⋯ menüde "🔒 Ev ağında HTTPS" var', (await shown('#sertifikaBtn')) && /Ev ağında HTTPS/.test(await text('#sertifikaBtn')));
    check('menü satırı durumu "kurulum"', (await text('#sertifikaBtn .ms')) === 'kurulum', await text('#sertifikaBtn .ms'));
    await shot('4-iphone-menu');
    await tap('#sertifikaBtn');
    check('menüden rehber açıldı, menü kapandı', (await shown('#sertifikaPanel')) && !(await shown('#menuPanel')));
    await tap('#sertifikaPanel .rc-x');
    await tap('#backBtn');
    await bekle("!document.getElementById('vHome').hidden");

    // ---------------- iPad (1024x1366; iPadOS Safari kendini Mac gösterir) ----------------
    await cihaz(1024, 1366, IPAD_UA, 'MacIntel');
    await giris(httpUrl);
    await bekle("(() => { const e = document.getElementById('sertifikaSerit'); return e && !e.hidden; })()");
    await tap('#sertifikaSerit [data-k="nasil"]');
    await bekle("!!document.querySelector('#sertifikaPanel .srt-baslik')");
    check('iPad: iOS rehberi önde (Mac kullanıcı aracısı + dokunmatik)', /iPhone \/ iPad/.test(await text('#sertifikaPanel .srt-baslik')), await text('#sertifikaPanel .srt-baslik'));
    await shot('7-ipad-rehber');

    // ---------------- Android ----------------
    await cihaz(412, 915, ANDROID_UA, 'Linux armv8l');
    await giris(httpUrl);
    await bekle("(() => { const e = document.getElementById('sertifikaSerit'); return e && !e.hidden; })()");
    await tap('#sertifikaSerit [data-k="nasil"]');
    await bekle("!!document.querySelector('#sertifikaPanel .srt-baslik')");
    check('Android: Android rehberi önde, .cer indirme', /Android/.test(await text('#sertifikaPanel .srt-baslik'))
      && (await ev("document.querySelector('#sertifikaPanel [data-k=\"indir-cer\"]')?.getAttribute('href')")) === '/api/sertifika/ca.cer');
    await shot('8-android-rehber');
    await tap('#sertifikaPanel .rc-x');

    // ---------------- Sertifikaya güvenen iPhone (benzetim: tarayıcı sertifika hatalarını yok sayar) ----------------
    // Tarayıcı kabul edilen sertifikayı oturum boyunca hatırladığı için bu bölüm güvenmeyen cihaz denemelerinden sonra.
    await cihaz(390, 844, IPHONE_UA, 'iPhone');
    await call('Security.setIgnoreCertificateErrors', { ignore: true });
    await giris(httpUrl);
    check('güvenen cihaz: şerit "Şifreli adrese geç"', await bekle("/güveniyor/.test(document.getElementById('sertifikaSerit')?.textContent || '') && !document.getElementById('sertifikaSerit').hidden"));
    await shot('5-iphone-guveniyor-serit');
    const gecHref = await ev("document.querySelector('#sertifikaSerit [data-k=\"gec\"]')?.getAttribute('href')");
    check('şeritteki geç bağlantısı HTTPS adresi', gecHref === `https://${lan}:${durum.port}/`, gecHref);
    await tap('#sertifikaSerit [data-k="gec"]');
    await bekle(`location.protocol === 'https:'`);
    await giris(`https://${lan}:${durum.port}/`).catch(() => {});
    check('HTTPS sayfası: güvenli bağlam + WebCodecs (H.264 yolu açık)', (await ev("window.isSecureContext && 'VideoDecoder' in window")) === true);
    check('HTTPS sayfasında öneri şeridi yok', !(await shown('#sertifikaSerit')));
    await shot('6-iphone-https-ana-menu');
    await call('Security.setIgnoreCertificateErrors', { ignore: false });
    await giris(httpUrl);
    await bekle("(() => { const e = document.getElementById('sertifikaSerit'); return e && !e.hidden; })()");

    // ✕ ile şerit gizlenir ve bir daha gösterilmez
    await tap('#sertifikaSerit [data-k="gizle"]');
    check('şerit ✕ ile gizlendi', !(await shown('#sertifikaSerit')));
    await giris(httpUrl);
    await sleep(800);
    check('gizlenen şerit yeniden yüklemede de gizli', !(await shown('#sertifikaSerit')));

    // ---------------- Yönetim (masaüstü genişliği) ----------------
    await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await call('Emulation.setTouchEmulationEnabled', { enabled: false });
    await call('Emulation.setUserAgentOverride', { userAgent: '' });
    await giris(`http://localhost:${PORT}/`);
    await ev("document.getElementById('adminBtn').click()");
    check('yönetim: "Ev ağı HTTPS" bölümü', await bekle("[...document.querySelectorAll('#vAdmin h2')].some((h) => /Ev ağı HTTPS/.test(h.textContent)) && /Açık — port/.test(document.querySelector('.srt-yonetim')?.textContent || '')"));
    check('yönetim: kapat / yeniden üret / sil düğmeleri', await ev("['kapat','yeniden','sil'].every((op) => !!document.querySelector('.srt-yonetim [data-op=\"' + op + '\"]'))"));
    await ev("document.querySelector('.srt-yonetim').scrollIntoView({ block: 'center' })");
    await sleep(200);
    await shot('9-yonetim');
    // Kapat (onay penceresi otomatik kabul)
    await ev('window.confirm = () => true; document.querySelector(\'.srt-yonetim [data-op="kapat"]\').click()');
    check('yönetim: Kapat → "Kapalı"', await bekle("/Kapalı/.test(document.querySelector('.srt-yonetim')?.textContent || '') && !!document.querySelector('.srt-yonetim [data-op=\"ac\"]')"));
    await ev("document.querySelector('.srt-yonetim [data-op=\"ac\"]').click()");
    check('yönetim: Aç → yeniden açık', await bekle("/Açık — port/.test(document.querySelector('.srt-yonetim')?.textContent || '')"));

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
