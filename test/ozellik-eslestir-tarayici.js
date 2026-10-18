// QR eşleştirme, gerçek tarayıcı motorunda (başsız Edge / Chrome): bilgisayar sayfası "#qr" ile açılır (tepsi menüsü
// gibi) -> kurulumdan sonra QR ekranı kendiliğinden açılır; "telefon" (ayrı tarayıcı bağlamı, iPhone 390x844 + dokunma +
// iPhone kullanıcı aracısı) QR'daki adresi açar -> onay bekler; bilgisayarda Onayla -> telefon ana menüde, cihaz hatırlandı.
// iPad boyutunda (1024x1366) ikinci telefon: Reddet -> giriş ekranı + hata. Tarayıcı BarcodeDetector destekliyorsa
// ekrandaki QR görüntüden çözülüp adresle karşılaştırılır (Windows'ta genelde yok: raporlanır).
// iOS Safari emüle EDİLEMEZ: yalnızca boyut, dokunma ve kullanıcı aracısı taklit edilir. Görüntü başlatılmaz, girdi gönderilmez.
// Ekran görüntüleri %TEMP%\rc-eslestir\ altına kaydedilir.
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
const SHOTS = path.join(os.tmpdir(), 'rc-eslestir');
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const IPAD_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kill = (pid) => spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });

let pass = 0, fail = 0;
const check = (n, c, x = '') => { console.log(`${c ? 'OK  ' : 'FAIL'} ${n} ${x}`); c ? pass++ : fail++; };
const getJson = (u) => new Promise((res, rej) => http.get(u, (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej));

function cdpBaglan(wsUrl) {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const exceptions = [];
    ws.on('message', (d) => {
      const m = JSON.parse(d);
      if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    });
    const call = (method, params = {}) => new Promise((r, j) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => j(new Error(`CDP zaman aşımı: ${method}`)), 15000); });
    const ev = async (expression) => { const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails)); return r.result?.result?.value; };
    const bekle = async (expr, ms = 10000) => { for (let i = 0; i < ms / 200; i++) { if (await ev(expr).catch(() => false)) return true; await sleep(200); } return false; };
    const shot = async (ad) => {
      const r = await call('Page.captureScreenshot', { format: 'png' });
      const p = path.join(SHOTS, `${ad}.png`);
      fs.writeFileSync(p, Buffer.from(r.result.data, 'base64'));
      console.log(`     ekran görüntüsü: ${p}`);
    };
    const rect = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, left: r.left, right: r.right, top: r.top, bottom: r.bottom }; })()`);
    const mouseClick = async (sel) => {
      await ev(`document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({ block: 'nearest' })`);
      const p = await rect(sel);
      if (!p) throw new Error(`öğe yok: ${sel}`);
      await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
      await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
      await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
      await sleep(150);
    };
    const shown = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && !e.hidden && getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0; })()`);
    ws.on('open', () => resolve({ ws, call, ev, bekle, shot, rect, mouseClick, shown, exceptions }));
  });
}

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
    const tarayici = await cdpBaglan((await getJson(`http://127.0.0.1:${dbg}/json/version`)).webSocketDebuggerUrl);

    // Ayrı depolamalı (localStorage) bağlamda yeni sekme: her "cihaz" kendi tarayıcısı gibi.
    async function yeniSayfa({ width, height, mobile, ua }) {
      const { result: { browserContextId } } = await tarayici.call('Target.createBrowserContext');
      const { result: { targetId } } = await tarayici.call('Target.createTarget', { url: 'about:blank', browserContextId });
      let hedef = null;
      for (let i = 0; i < 40 && !hedef; i++) { hedef = (await getJson(`http://127.0.0.1:${dbg}/json/list`)).find((t) => t.id === targetId); if (!hedef) await sleep(200); }
      const p = await cdpBaglan(hedef.webSocketDebuggerUrl);
      await p.call('Page.enable'); await p.call('Runtime.enable');
      await p.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 3 : 1, mobile });
      if (mobile) await p.call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      if (ua) await p.call('Emulation.setUserAgentOverride', { userAgent: ua, platform: /iPhone/.test(ua) ? 'iPhone' : 'MacIntel' });
      return p;
    }

    // ---------------- Bilgisayar: tepsi menüsü gibi "#qr" ile aç ----------------
    const pc = await yeniSayfa({ width: 1280, height: 860, mobile: false });
    await pc.call('Page.navigate', { url: `http://localhost:${PORT}/#qr` });
    await pc.bekle("!document.getElementById('vSetup').hidden");
    await pc.ev(`(() => { const f = document.getElementById('setupForm'); f.username.value='yonetici'; f.password.value='gizli123'; f.password2.value='gizli123'; f.requestSubmit(); })()`);
    check('bilgisayar: kurulum + ana menü', await pc.bekle("!document.getElementById('vHome').hidden"));
    check('bilgisayar: "#qr" ile açılınca QR ekranı kendiliğinden açıldı', await pc.bekle("!document.getElementById('eslestirPanel').hidden && !!document.querySelector('#eslestirPanel .es-qr svg')"));
    check('bilgisayar: "#qr" adres çubuğundan silindi', (await pc.ev('location.hash')) === '');
    check('bilgisayar: ana menüde "Telefonu bağla (QR)" düğmesi', await pc.shown('#eslestirBtn'));
    const qr1 = await pc.ev(`(() => { const p = document.getElementById('eslestirPanel'); return { url: p.querySelector('.es-qr').title, adres: p.querySelector('.es-adres').textContent,
      kim: p.querySelector('.es-kim').textContent, sure: p.querySelector('.es-sure').textContent }; })()`);
    check('QR altında adres (belirteç olmadan)', qr1.adres && qr1.url.startsWith(`${qr1.adres}/#e=`) && !qr1.adres.includes('#'), qr1.adres);
    check('QR ekranında kullanıcı adı ve onay notu', /yonetici/.test(qr1.kim) && /Yönetici/.test(qr1.kim) && /onayla/i.test(qr1.kim), qr1.kim);
    check('QR ekranında geri sayım', /\d:\d\d sonra yenilenir/.test(qr1.sure), qr1.sure);
    const qrKutu = await pc.rect('#eslestirPanel .es-qr');
    check('QR kare ve okunacak büyüklükte (≥ 200 px)', qrKutu && Math.abs(qrKutu.w - qrKutu.h) < 2 && qrKutu.w >= 200, qrKutu && `${Math.round(qrKutu.w)}x${Math.round(qrKutu.h)}`);
    // Görüntüden çözme (destekleyen tarayıcıda)
    const cozum = await pc.ev(`(async () => {
      if (!('BarcodeDetector' in window)) return { yok: true };
      try {
        const svg = document.querySelector('#eslestirPanel .es-qr svg').outerHTML;
        const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); await img.decode();
        const c = document.createElement('canvas'); c.width = c.height = 600; const g = c.getContext('2d'); g.drawImage(img, 0, 0, 600, 600);
        const r = await new BarcodeDetector({ formats: ['qr_code'] }).detect(c);
        return { veri: r[0] && r[0].rawValue };
      } catch (e) { return { hata: String(e) }; }
    })()`);
    if (cozum.yok || cozum.hata) console.log(`     (BarcodeDetector yok/çalışmadı: ${cozum.hata || 'desteklenmiyor'} — QR çözümü birim testinde referans uygulamayla doğrulanıyor)`);
    else check('ekrandaki QR görüntüden çözüldü ve adresle aynı', cozum.veri === qr1.url);
    await pc.shot('1-bilgisayar-qr');

    // ---------------- Telefon (iPhone boyutu): QR'daki adresi aç ----------------
    // Telefon, belirteci bu bilgisayarın ev ağı adresinden (http://192.168.x.x:PORT) açar: bağlantı "ev ağı"ndan gelir,
    // yerel sayılmaz (gerçekçi). QR'daki Tailscale HTTPS adresi test sunucusuna gitmediği için belirteç aynen taşınır.
    const lanIp = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.'))?.address;
    const telefonUrl = (u) => `http://${lanIp || 'localhost'}:${PORT}/#e=${u.split('#e=')[1]}`;
    const tel = await yeniSayfa({ width: 390, height: 844, mobile: true, ua: IPHONE_UA });
    await tel.call('Page.navigate', { url: telefonUrl(qr1.url) });
    check('telefon: onay bekleniyor ekranı', await tel.bekle("!document.getElementById('vPending').hidden"));
    check('telefon: belirteç adres çubuğundan silindi', (await tel.ev('location.hash')) === '');
    const bekMetin = await tel.ev("document.querySelector('#vPending p.muted').textContent");
    check('telefon: bekleme metni QR onayını anlatıyor', /QR ekranında/.test(bekMetin), bekMetin);
    await tel.shot('2-telefon-bekliyor');
    check('bilgisayar: "iPhone · Safari bağlanmak istiyor" + Onayla / Reddet', await pc.bekle("!document.querySelector('#eslestirPanel .es-istek').hidden && /iPhone · Safari/.test(document.querySelector('#eslestirPanel .es-istek-metin').textContent)"));
    check('bilgisayar: istek gelince QR gizlendi (kullanıldı)', !(await pc.shown('#eslestirPanel .es-qr')));
    const onayBtn = await pc.rect('#eslestirPanel [data-act="onayla"]');
    check('bilgisayar: Onayla düğmesi ekranda görünüyor', onayBtn && onayBtn.top >= 0 && onayBtn.bottom <= 860, onayBtn && `${Math.round(onayBtn.top)}–${Math.round(onayBtn.bottom)}`);
    const pcKod = await pc.ev("document.querySelector('#eslestirPanel .es-kod').textContent");
    const telKod = await tel.ev("document.querySelector('#vPending .es-tel-kod')?.textContent || ''");
    check('doğrulama kodu telefonda ve bilgisayarda aynı', /^\d{2}$/.test(pcKod) && pcKod === telKod, pcKod + ' / ' + telKod);
    await pc.shot('3-bilgisayar-istek');
    await pc.mouseClick('#eslestirPanel [data-act="onayla"]');
    check('telefon: onaylanınca ana menü', await tel.bekle("!document.getElementById('vHome').hidden"));
    check('telefon: yöneticinin hesabıyla girdi', /yonetici/.test(await tel.ev("document.getElementById('helloName').textContent")));
    check('telefon: cihaz hatırlandı (cihaz anahtarı kaydedildi)', !!(await tel.ev("localStorage.getItem('deviceToken')")));
    if (lanIp) check('telefon: telefonda QR düğmesi yok (ev ağından, bu bilgisayar değil)', !(await tel.shown('#eslestirBtn')));
    await tel.shot('4-telefon-girdi');
    check('bilgisayar: "bağlandı" + yeni QR', await pc.bekle(`/bağlandı/.test(document.querySelector('#eslestirPanel .msg').textContent) && document.querySelector('#eslestirPanel .es-qr').title !== ${JSON.stringify(qr1.url)} && !document.querySelector('#eslestirPanel .es-qr').classList.contains('soluk')`));
    await pc.shot('5-bilgisayar-baglandi');
    // Yeniden yükleme: hatırlanan cihazla şifresiz giriş
    await tel.call('Page.reload');
    check('telefon: sayfa yenilenince hatırlanan cihazla girdi', await tel.bekle("!document.getElementById('vHome').hidden"));

    // ---------------- iPad boyutu: reddetme ----------------
    const qr2 = await pc.ev("document.querySelector('#eslestirPanel .es-qr').title");
    const ipad = await yeniSayfa({ width: 1024, height: 1366, mobile: true, ua: IPAD_UA });
    await ipad.call('Page.navigate', { url: telefonUrl(qr2) });
    check('iPad: onay bekleniyor', await ipad.bekle("!document.getElementById('vPending').hidden"));
    check('bilgisayar: iPad isteği (iPad · Safari)', await pc.bekle("/iPad · Safari/.test(document.querySelector('#eslestirPanel .es-istek-metin').textContent)"));
    await ipad.shot('6-ipad-bekliyor');
    await pc.mouseClick('#eslestirPanel [data-act="reddet"]');
    check('iPad: reddedilince giriş ekranı + hata', await ipad.bekle("!document.getElementById('vLogin').hidden && /reddedildi/.test(document.getElementById('loginError').textContent)"));
    check('iPad: cihaz anahtarı yok', !(await ipad.ev("localStorage.getItem('deviceToken')")));
    await ipad.shot('7-ipad-reddedildi');
    check('bilgisayar: reddedildi mesajı', await pc.bekle("/Reddedildi/.test(document.querySelector('#eslestirPanel .msg').textContent)"));

    // Aynı (kullanılmış) adres tekrar açılırsa giriş ekranı + anlaşılır hata
    await ipad.call('Page.navigate', { url: 'about:blank' });
    await ipad.call('Page.navigate', { url: telefonUrl(qr2) });
    check('iPad: kullanılmış QR adresi -> giriş ekranı + "süresi dolmuş ya da kullanılmış"', await ipad.bekle("!document.getElementById('vLogin').hidden && /kullanılmış/.test(document.getElementById('loginError').textContent)"));

    // QR ekranı ✕ ile kapanır
    await pc.mouseClick('#eslestirPanel [data-act="kapat"]');
    check('bilgisayar: QR ekranı ✕ ile kapandı', !(await pc.shown('#eslestirPanel')));
    await pc.mouseClick('#eslestirBtn');
    check('bilgisayar: düğmeyle tekrar açıldı', await pc.bekle("!document.getElementById('eslestirPanel').hidden && !!document.querySelector('#eslestirPanel .es-qr svg')"));
    await pc.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await pc.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(200);
    check('bilgisayar: Esc ile kapandı', !(await pc.shown('#eslestirPanel')));

    const hatalar = [...pc.exceptions, ...tel.exceptions, ...ipad.exceptions];
    check('sayfalarda JavaScript hatası yok', hatalar.length === 0, hatalar.join(' | '));
  } catch (e) {
    check('tarayıcı testi tamamlandı', false, e.stack);
  } finally {
    if (browser) kill(browser.pid);
    await sleep(500);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  }
  console.log(`\n${pass} geçti, ${fail} hata`);
  process.exit(fail ? 1 : 0);
})();
