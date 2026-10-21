// Bilgisayar durumu paneli, gerçek tarayıcı motorunda (başsız Edge / Chrome): ana menüden ve ⋯ menüsünden açılır, ölçümler ve
// çizgi grafikleri dolar, iPhone (390x844) ve iPad (1024x1366) boyutunda taşmaz; çalışan programlar Görev Yöneticisi gibi gruplu
// ("Google Chrome (15)"), "Uygulamalar" + katlı "Arka plan işlemleri"; yönetici "Kapat" (onaylı, grubun tüm süreçlerine, korumalı
// grupta 🔒), "Zorla kapat" düğmesi (hâlâ açık olanlara), bildirim kartı, izleyici ekleme; salt izleme rolünde düğmeler gizli.
// Kapatma (durum-kapat) ve girdi mesajları sayfada YAKALANIR, sunucuya GİTMEZ (sunucu ayrıca kuru modda). iOS Safari emüle EDİLEMEZ:
// yalnızca boyut, dokunma ve iPhone/iPad kullanıcı aracısı taklit edilir. Ekran görüntüleri %TEMP%\rc-durum\ altına kaydedilir.
// @ortam REMOTE_DURUM_KURU=1
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
const SHOTS = path.join(os.tmpdir(), 'rc-durum');
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const IPAD_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kill = (pid) => spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });

let pass = 0, fail = 0;
const check = (n, c, x = '') => { console.log(`${c ? 'OK  ' : 'FAIL'} ${n} ${x}`); c ? pass++ : fail++; };
const getJson = (u) => new Promise((res, rej) => http.get(u, (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej));

// Girdi ve kapatma mesajları sunucuya gitmez (window.__sent); abonelik mesajları gider ama kaydedilir (window.__log).
// confirm / alert sayfada yanıtlanır (window.__onay, window.__uyari).
const YAKALAYICI = `
  window.__sent = []; window.__log = []; window.__uyari = []; window.__onay = true;
  window.confirm = (m) => { window.__uyari.push('onay:' + m); return window.__onay; };
  window.alert = (m) => { window.__uyari.push('uyari:' + m); };
  const __orig = WebSocket.prototype.send;
  const __block = new Set(['move','down','up','wheel','key','text','kalem','guc','durum-kapat']);
  window.__fake = (m) => window.__ws && window.__ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(m) }));
  WebSocket.prototype.send = function (d) {
    window.__ws = this;
    try {
      const m = JSON.parse(d);
      if (m.t && m.t.startsWith('durum')) window.__log.push(m);
      if (__block.has(m.t)) { window.__sent.push(m); return; }
      if (m.t === 'kalem-destek') { setTimeout(() => window.__fake({ t: 'kalem-destek', ok: false }), 0); return; }
    } catch {}
    return __orig.call(this, d);
  };`;

// Test sürecinden ikinci bir bağlantı: salt izleme kullanıcısı ekler.
function wsIstek(username, password, mesaj) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.t === 'hello') ws.send(JSON.stringify({ t: 'login', username, password, remember: false }));
      else if (m.t === 'auth') { if (!m.ok) reject(new Error(m.error)); else ws.send(JSON.stringify(mesaj)); }
      else if (m.t === 'adminData') { ws.close(); resolve(m); }
    });
    ws.on('error', reject);
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
    const rect = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, top: r.top, bottom: r.bottom, left: r.left, right: r.right }; })()`);
    const touch = (type, pts) => call('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: i, radiusX: 1, radiusY: 1, force: 1 })) });
    const tap = async (selOrPt) => {
      const p = typeof selOrPt === 'string' ? await rect(selOrPt) : selOrPt;
      if (!p) throw new Error(`öğe yok: ${selOrPt}`);
      await touch('touchStart', [p]); await sleep(40); await touch('touchEnd', []); await sleep(150);
    };
    const shown = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && !e.hidden && getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0; })()`);
    const until = async (expr, ms = 8000) => { for (let i = 0; i < ms / 200; i++) { if (await ev(expr).catch(() => false)) return true; await sleep(200); } return false; };
    // Panel taşıyor mu: panel ekranda, içerik yatay kaymıyor, hiçbir satır panelin dışına çıkmıyor.
    // Program listesi doldu: Uygulamalar bölümünde satır (ya da 'açık pencereli program yok') var, 'Ölçülüyor…' değil.
    const HAZIR = "!/Ölçülüyor/.test(document.querySelector('#durumPanel [data-r=uyg]').textContent) && document.querySelector('#durumPanel [data-r=uyg]').children.length > 0";
    const tasma = () => ev(`(() => {
      const p = document.getElementById('durumPanel'), ic = p.querySelector('.rc-panel-ic'), r = p.getBoundingClientRect();
      const disari = [...p.querySelectorAll('.dr-k, .dr-s, .dr-i, .dr-ekle, .dr-disk')].filter((e) => e.getClientRects().length)
        .map((e) => e.getBoundingClientRect()).filter((x) => x.right > r.right + 0.5 || x.left < r.left - 0.5).length;
      return { sol: r.left, sag: r.right, gen: innerWidth, alt: r.bottom, yuk: innerHeight, sw: ic.scrollWidth, cw: ic.clientWidth, disari };
    })()`);

    await call('Page.enable'); await call('Runtime.enable');
    // ---------------- iPhone (390x844, dokunmatik) ----------------
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await call('Emulation.setUserAgentOverride', { userAgent: IPHONE_UA });
    await call('Page.addScriptToEvaluateOnNewDocument', { source: YAKALAYICI });
    await call('Page.navigate', { url: `http://localhost:${PORT}/` });
    for (let i = 0; i < 40 && !(await ev("!document.getElementById('vSetup').hidden").catch(() => false)); i++) await sleep(250);
    if (!(await ev('Array.isArray(window.__sent)'))) throw new Error('yakalayıcı kurulamadı, test durduruldu');
    await ev(`(() => { const f = document.getElementById('setupForm'); f.username.value='deneme'; f.password.value='deneme123'; f.password2.value='deneme123'; f.requestSubmit(); })()`);
    await until("!document.getElementById('vHome').hidden");
    await wsIstek('deneme', 'deneme123', { t: 'admin', op: 'addUser', username: 'bakan', password: 'bakan123', role: 'view' });

    check('ana menüde "📊 Bilgisayar durumu" var (görüntü açmadan)', await shown('#durumHomeBtn'));
    await tap('#durumHomeBtn');
    check('ana menüden panel açıldı', await shown('#durumPanel'));
    check('açılınca abone olundu', (await ev('window.__log.map((m) => m.t + ":" + m.acik)')).includes('durum-abone:true'));
    check('ölçümler geldi (CPU, RAM)', await until("/^%\\d+$/.test(document.querySelector('[data-k=cpu] b').textContent) && /GB/.test(document.querySelector('[data-k=ram] small').textContent)", 10000));
    check('program listesi doldu (Uygulamalar)', await until(HAZIR, 15000), await ev("document.querySelector('#durumPanel [data-r=programlar]').textContent.slice(0, 120)"));
    const bolum = await ev(`({ uyg: document.querySelectorAll('#durumPanel [data-r=uyg] .dr-s').length, arka: document.querySelectorAll('#durumPanel [data-r=arka] .dr-s').length,
      arkaGizli: document.querySelector('#durumPanel [data-r=arka]').hidden, acik: document.querySelector('#durumPanel [data-r=arkaAc]').getAttribute('aria-expanded'),
      uygSayi: document.querySelector('#durumPanel [data-r=uygSayi]').textContent, arkaSayi: document.querySelector('#durumPanel [data-r=arkaSayi]').textContent,
      surecSayi: document.querySelector('#durumPanel [data-r=surecSayi]').textContent,
      hepsiUyg: [...document.querySelectorAll('#durumPanel [data-r=uyg] .dr-s')].every((e) => e._p.uyg) })`);
    check('iki bölüm: Uygulamalar (en fazla 15, hepsi pencereli) ve arka plan varsayılan katlı', bolum.uyg <= 15 && bolum.hepsiUyg && bolum.arka === 0 && bolum.arkaGizli && bolum.acik === 'false'
      && /^\(\d+\)$/.test(bolum.uygSayi) && /^\(\d+\)$/.test(bolum.arkaSayi) && /^\d+ işlem$/.test(bolum.surecSayi), JSON.stringify(bolum));
    await ev("document.querySelector('#durumPanel [data-r=arkaAc]').scrollIntoView({ block: 'center' })");
    await tap('#durumPanel [data-r=arkaAc]');
    check('"Arka plan işlemleri"ne dokununca açıldı: 15 grup, hepsi penceresiz', await until("document.querySelectorAll('#durumPanel [data-r=arka] .dr-s').length === 15 && [...document.querySelectorAll('#durumPanel [data-r=arka] .dr-s')].every((e) => !e._p.uyg)", 5000)
      && (await ev("document.querySelector('#durumPanel [data-r=arkaAc]').getAttribute('aria-expanded')")) === 'true', String(await ev("document.querySelectorAll('#durumPanel [data-r=arka] .dr-s').length")));
    // Satır: program adı (dosya açıklaması) + "(N)" adet, alt satırda exe adı · pencere başlığı, CPU ve bellek alt alta (telefonda).
    const satirlar = await ev(`[...document.querySelectorAll('#durumPanel .dr-s')].map((e) => ({ ad: e.querySelector('.dr-adm').textContent, adet: e.querySelector('.dr-adet').textContent,
      alt: e.querySelector('small').hidden ? '' : e.querySelector('small').textContent, cpu: e.querySelector('[data-n=cpu]').textContent, ram: e.querySelector('[data-n=ram]').textContent,
      p: { ad: e._p.ad, exe: e._p.exe, n: e._p.n, baslik: e._p.baslik || '' }, adGen: e.querySelector('.dr-ad').getBoundingClientRect().width,
      nlar: (() => { const [c, r] = e.querySelectorAll('.dr-nlar span'); return r.getBoundingClientRect().top > c.getBoundingClientRect().top; })() }))`);
    check('satırlar: ad, (N) yalnızca birden çok süreçte, alt satırda exe adı ve başlık, % ve MB/GB', satirlar.every((x) => x.ad === x.p.ad && x.adet === (x.p.n > 1 ? `(${x.p.n})` : '')
      && (x.p.ad === x.p.exe || x.alt.startsWith(x.p.exe)) && (!x.p.baslik || x.p.baslik === x.p.ad || x.alt.includes(x.p.baslik)) && /^%\d+(,\d)?$/.test(x.cpu) && /^\d+(,\d)? ?(MB|GB)$/.test(x.ram)),
      JSON.stringify(satirlar.find((x) => x.ad !== x.p.ad || x.adet !== (x.p.n > 1 ? `(${x.p.n})` : '')) || satirlar[0]));
    check('en az bir grup birden çok süreçli ("(N)")', satirlar.some((x) => x.p.n > 1), satirlar.filter((x) => x.p.n > 1).map((x) => `${x.ad} ${x.adet}`).join(', '));
    check('telefon: CPU ile bellek alt alta, ad sütunu en az 130 px', satirlar.every((x) => x.nlar && x.adGen >= 130), `en dar ad ${Math.min(...satirlar.map((x) => x.adGen)).toFixed(0)} px`);
    await sleep(3500); // çizgi grafikleri birkaç nokta biriktirsin
    const nokta = await ev("document.querySelector('[data-k=cpu] polyline').getAttribute('points').split(' ').filter(Boolean).length");
    check('CPU çizgi grafiği noktaları birikiyor', nokta >= 3, `${nokta} nokta`);
    check('disk satırı var', await shown('#durumPanel .dr-disk'));
    let ts = await tasma();
    check('telefon: panel ekrana sığıyor, yatay taşma yok', ts.sol >= 0 && ts.sag <= ts.gen && ts.alt <= ts.yuk && ts.sw <= ts.cw && ts.disari === 0, JSON.stringify(ts));
    await shot('1-telefon-durum');
    await ev("document.querySelector('#durumPanel [data-r=programlar]').scrollIntoView({ block: 'start' })");
    await sleep(300);
    await shot('2-telefon-programlar');
    await ev("document.querySelector('#durumPanel [data-r=arkaAc]').scrollIntoView({ block: 'start' })");
    await sleep(300);
    await shot('2b-telefon-arka-plan');
    await ev("document.querySelector('#durumPanel .rc-panel-ic').scrollTop = 99999");
    await sleep(300);
    await shot('2c-telefon-durum-alt');
    await ev("document.querySelector('#durumPanel .rc-panel-ic').scrollTop = 0");

    // ---- Yönetici: Kapat (grubun tüm süreçlerine) ----
    const kapatlar = await ev("[...document.querySelectorAll('#durumPanel .dr-s [data-act=kapat]')].filter((b) => !b.hidden).length");
    check('yönetici: her satırda Kapat/🔒 düğmesi', kapatlar === satirlar.length, `${kapatlar}/${satirlar.length}`);
    // Mümkünse birden çok süreçli korumasız grup (Kapat'ın tüm üyelere gittiği görülsün).
    const hedef = await ev(`(() => { const l = [...document.querySelectorAll('#durumPanel .dr-s')].filter((e) => !e._p.koruma);
      const r = l.find((e) => e._p.n > 1) || l[0]; if (!r) return null; r.id = 'drHedef'; r.scrollIntoView({ block: 'center' });
      return { pid: r._p.pid, ct: r._p.ct, ad: r._p.ad, n: r._p.n, uyeler: r._p.uyeler || [[r._p.pid, r._p.ct]] }; })()`);
    if (hedef) {
      await ev('window.__onay = false');
      await tap('#drHedef [data-act=kapat]');
      let s = await sent();
      const u = await ev('window.__uyari.splice(0)');
      check('Kapat önce onay soruyor (adet yazıyor); vazgeçince gönderilmedi', u.length === 1 && u[0].startsWith('onay:') && u[0].includes(hedef.ad)
        && (hedef.n === 1 || u[0].includes(`${hedef.n} işlemin hepsi`)) && s.length === 0, JSON.stringify(u));
      await ev('window.__onay = true');
      await tap('#drHedef [data-act=kapat]');
      s = await sent();
      await ev('window.__uyari.splice(0)');
      check(`onaylayınca nazik kapatma grubun ${hedef.n} sürecine PID + başlama zamanıyla gönderildi`, s.length === 1 && s[0].t === 'durum-kapat' && s[0].pid === hedef.pid && s[0].ct === hedef.ct && !s[0].zorla
        && JSON.stringify(s[0].surecler) === JSON.stringify(hedef.uyeler), JSON.stringify(s).slice(0, 300));
      const kalan = hedef.uyeler.slice(0, 2);
      await ev(`window.__fake({ t: 'durum-kapat-sonuc', asama: 'kontrol', ok: true, pid: ${hedef.pid}, ct: '${hedef.ct}', ad: ${JSON.stringify(hedef.ad)}, hala: true, kalan: ${JSON.stringify(kalan)} })`);
      await sleep(200);
      check('5 sn sonra hâlâ açıksa "Zorla kapat" düğmesi çıkıyor', await shown('#durumPanel [data-r=kmsg] button'), await ev("document.querySelector('#durumPanel [data-r=kmsg]').textContent"));
      await ev("document.querySelector('#durumPanel [data-r=kmsg]').scrollIntoView({ block: 'center' })");
      await shot('3-telefon-zorla');
      await tap('#durumPanel [data-r=kmsg] button');
      s = await sent();
      const u2 = await ev('window.__uyari.splice(0)');
      check('Zorla kapat ikinci onayla, yalnızca hâlâ açık olanlara zorla: true gönderildi', s.length === 1 && s[0].zorla === true && s[0].pid === hedef.pid
        && JSON.stringify(s[0].surecler) === JSON.stringify(kalan) && /KAYBOLUR/.test(u2[0] || ''), JSON.stringify(s));
    } else check('korumasız süreç bulundu', false);
    const korumali = await ev("(() => { const r = [...document.querySelectorAll('#durumPanel .dr-s')].find((e) => e._p.koruma); if (!r) return null; r.id = 'drKoruma'; return r._p.ad; })()");
    if (korumali) {
      check('korumalı süreçte 🔒', (await ev("document.querySelector('#drKoruma [data-act=kapat]').textContent")) === '🔒');
      await tap('#drKoruma [data-act=kapat]');
      const u = await ev('window.__uyari.splice(0)');
      check('🔒: nedeni gösterilir, kapatma gönderilmez', u.length === 1 && u[0].startsWith('uyari:') && (await sent()).length === 0, (u[0] || '').slice(0, 90));
    } else console.log('ATLANDI listede korumalı süreç yok');

    // ---- İzleyici ekleme (gerçekten sunucuya gider) ----
    await ev("(() => { const s = document.querySelector('#durumPanel [data-r=ekle] select'); s.value = 'indirme'; s.dispatchEvent(new Event('change')); })()");
    check('indirme seçilince yüzde kutusu gizlendi', !(await shown('#durumPanel [data-r=ekle] input')));
    await ev("document.querySelector('#durumPanel [data-r=ekle] button').scrollIntoView({ block: 'center' })");
    await tap('#durumPanel [data-r=ekle] button');
    check('izleyici eklendi ve listede', await until("/İndirilenler/.test(document.querySelector('#durumPanel [data-r=izleyiciler]').textContent)", 5000), await ev("document.querySelector('#durumPanel [data-r=kmsg]').textContent + ' | ' + JSON.stringify(window.__log.slice(-3))"));
    const ilkSurec = await ev("document.querySelector('#durumPanel .dr-s')._p");
    await ev("(() => { const e = document.querySelector('#durumPanel .dr-s'); e.id = 'drIzle'; e.scrollIntoView({ block: 'center' }); })()");
    await tap('#drIzle [data-act=izle]');
    check('🔔: grup izleyicisi eklendi', await until(`document.querySelector('#durumPanel [data-r=izleyiciler]').textContent.includes(${JSON.stringify(ilkSurec.ad)})`, 5000));
    const izSon = await ev("window.__log.filter((m) => m.t === 'durum-izle' && m.tur === 'surec').at(-1)");
    check('  🔔 grubun tüm süreçlerini (PID + ct) gönderdi', JSON.stringify(izSon.surecler) === JSON.stringify(ilkSurec.uyeler || [[ilkSurec.pid, ilkSurec.ct]]), JSON.stringify(izSon).slice(0, 200));
    check('  satırdaki 🔔 izleniyor görünüyor', await until(`[...document.querySelectorAll('#durumPanel .dr-s')].some((e) => e._p.pid === ${ilkSurec.pid} && e.querySelector('[data-act=izle]').classList.contains('on'))`, 4000));

    // ---- Bildirim kartı ----
    await ev("window.__fake({ t: 'durum-bildirim', id: 'x1', tur: 'indirme', baslik: 'İndirme bitti', metin: 'rapor.pdf (2,1 MB) İndirilenler klasörüne geldi.', zaman: Date.now() })");
    await ev("window.__fake({ t: 'durum-bildirim', id: 'x2', tur: 'surec', baslik: 'Program kapandı', metin: 'blender.exe kapandı.', zaman: Date.now() - 600000, gecikmeli: true })");
    await sleep(200);
    check('bildirim kartları göründü', (await ev("document.querySelectorAll('#durumBildirim .dr-kart').length")) === 2);
    check('gecikmeli bildirimde "bağlı değilken" notu', /bağlı değilken/.test(await ev("document.querySelector('#durumBildirim').textContent")));
    const kb = await rect('#durumBildirim');
    check('kartlar ekrana sığıyor', kb.left >= 0 && kb.right <= 390, JSON.stringify(kb));
    await shot('4-telefon-bildirim');
    await tap('#durumBildirim .dr-kart button');
    check('✕ kartı kapattı', (await ev("document.querySelectorAll('#durumBildirim .dr-kart').length")) === 1);
    await tap('#durumBildirim .dr-kart button');

    await tap('#durumPanel .rc-x');
    check('✕ paneli kapattı, abonelik bitti', !(await shown('#durumPanel')) && (await ev('window.__log.at(-1)')).acik === false);

    // ---- Görüntüleyici içinde ⋯ menüsünden ----
    await ev("document.getElementById('modeControl').click()");
    await until("document.getElementById('screen').width > 0", 15000);
    await tap('#menuBtn');
    check('⋯ menüsünde "Bilgisayar durumu" satırı', await shown('#durumBtn'));
    await tap('#durumBtn');
    check('menüden panel açıldı, menü kapandı', (await shown('#durumPanel')) && !(await shown('#menuPanel')));
    await until(HAZIR, 10000);
    const st = await rect('#stage');
    await sent();
    await tap({ x: st.left + 3, y: st.bottom - 40 }); // telefonda panel neredeyse tüm genişliği kaplar: sol kenardaki 8 px
    check('görüntüye dokununca panel kapandı, tıklama bilgisayara gitmedi', !(await shown('#durumPanel')) && !(await sent()).some((m) => m.t === 'down'));

    // ---------------- iPad (1024x1366) ----------------
    await call('Emulation.setDeviceMetricsOverride', { width: 1024, height: 1366, deviceScaleFactor: 2, mobile: true });
    await call('Emulation.setUserAgentOverride', { userAgent: IPAD_UA });
    await sleep(500);
    await tap('#menuBtn');
    await tap('#durumBtn');
    await until(HAZIR, 10000);
    await sleep(1500);
    ts = await tasma();
    check('iPad: panel geniş (≥ 500 px) ve taşmıyor', ts.sag - ts.sol >= 500 && ts.sag <= ts.gen && ts.sw <= ts.cw && ts.disari === 0, JSON.stringify(ts));
    const genis = await ev(`[...document.querySelectorAll('#durumPanel .dr-s')].map((e) => { const [c, r] = e.querySelectorAll('.dr-nlar span');
      return { yan: Math.abs(c.getBoundingClientRect().top - r.getBoundingClientRect().top) < 2, ad: e.querySelector('.dr-ad').getBoundingClientRect().width }; })`);
    check('iPad: CPU ve bellek yan yana sütun, ad sütunu en az 250 px', genis.length > 0 && genis.every((x) => x.yan && x.ad >= 250), `en dar ad ${Math.min(...genis.map((x) => x.ad)).toFixed(0)} px`);
    await ev("document.querySelector('#durumPanel [data-r=programlar]').scrollIntoView({ block: 'start' })");
    await sleep(300);
    await shot('5-ipad-durum');
    await tap('#durumPanel .rc-x');

    // ---------------- Salt izleme rolü ----------------
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await call('Emulation.setUserAgentOverride', { userAgent: IPHONE_UA });
    await ev("document.getElementById('backBtn').click()");
    await until("!document.getElementById('vHome').hidden");
    await ev("document.getElementById('logoutBtn').click()");
    await until("!document.getElementById('vLogin').hidden");
    // Çıkışta bağlantı kapanır (4000); yeni giriş için sayfa yeniden açılır.
    await call('Page.navigate', { url: `http://localhost:${PORT}/` });
    await until("!document.getElementById('vLogin').hidden && RC.state().connected");
    await sleep(300);
    await ev(`(() => { const f = document.getElementById('tAccount'); f.username.value='bakan'; f.password.value='bakan123'; f.remember.checked = false; f.requestSubmit(); })()`);
    check('salt izleme kullanıcısı girdi', await until("!document.getElementById('vHome').hidden && RC.state().me?.role === 'view'"), await ev("[...document.querySelectorAll('section')].filter((e) => !e.hidden).map((e) => e.id).join(',') + ' ' + document.getElementById('loginError').textContent + ' ' + JSON.stringify(RC.state().me)"));
    await tap('#durumHomeBtn');
    check('salt izleme: panel açıldı, ölçümler geliyor', await until(HAZIR, 10000));
    const gizli = await ev(`({
      kapat: [...document.querySelectorAll('#durumPanel .dr-s [data-act=kapat]')].some((b) => !b.hidden),
      izle: [...document.querySelectorAll('#durumPanel .dr-s [data-act=izle]')].some((b) => !b.hidden),
      ekle: !document.querySelector('#durumPanel [data-r=ekle]').hidden,
      sil: [...document.querySelectorAll('#durumPanel .dr-i button')].some((b) => !b.hidden),
      izleyici: document.querySelectorAll('#durumPanel .dr-i').length })`);
    check('salt izleme: Kapat, 🔔, ekleme ve silme gizli; izleyiciler görünüyor', !gizli.kapat && !gizli.izle && !gizli.ekle && !gizli.sil && gizli.izleyici === 2, JSON.stringify(gizli));
    await shot('6-telefon-salt-izleme');
    await tap('#durumPanel .rc-x');

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
