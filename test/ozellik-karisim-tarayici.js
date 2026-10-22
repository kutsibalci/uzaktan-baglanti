// Ses karıştırıcı paneli, gerçek tarayıcı motorunda (başsız Edge / Chrome), iPhone boyutunda (390x844, dokunmatik):
// ⋯ menü > Daha fazla > Ses karıştırıcı; gerçek cihaz listesi (sunucu kuru), çıkış cihazı seçici, sessiz düğmeleri, kaydırıcılar
// (dokununca o noktaya, sürüklerken sınırlı gönderim, sürüklenen kaydırıcı gelen güncellemeyle zıplamaz), Yenile, 3 sn'de bir yenileme,
// taşma yok; iPad genişliğinde de. Ayar mesajları (karisim-ayar) sayfada YAKALANIR, sunucuya GİTMEZ (sunucu ayrıca kuru modda).
// iOS Safari emüle EDİLEMEZ: yalnızca boyut, dokunma ve iPhone kullanıcı aracısı taklit edilir. Ekran görüntüleri %TEMP%\rc-karisim\ altına.
// @ortam REMOTE_KARISIM_KURU=1
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
const SHOTS = path.join(os.tmpdir(), 'rc-karisim');
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const IPAD_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kill = (pid) => spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });

if (process.env.REMOTE_KARISIM_KURU !== '1') {
  console.log('FAIL REMOTE_KARISIM_KURU=1 değil, test çalıştırılmadı (gerçek ses ayarı riski)');
  process.exit(1);
}

let pass = 0, fail = 0;
const check = (n, c, x = '') => { console.log(`${c ? 'OK  ' : 'FAIL'} ${n} ${x}`); c ? pass++ : fail++; };
const getJson = (u) => new Promise((res, rej) => http.get(u, (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej));

// Girdi ve karıştırıcı AYAR mesajları sunucuya gitmez (window.__sent); karisim-al gider (window.__alEngel ile durdurulabilir), hepsi window.__log'da.
const YAKALAYICI = `
  window.__sent = []; window.__log = []; window.__alEngel = false;
  const __orig = WebSocket.prototype.send;
  const __block = new Set(['move','down','up','wheel','key','text','kalem','guc','karisim-ayar']);
  window.__fake = (m) => window.__ws && window.__ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(m) }));
  WebSocket.prototype.send = function (d) {
    window.__ws = this;
    try {
      const m = JSON.parse(d);
      if (m.t && m.t.startsWith('karisim')) window.__log.push({ ...m, zaman: performance.now() });
      if (__block.has(m.t)) { window.__sent.push({ ...m, zaman: performance.now() }); return; }
      if (m.t === 'karisim-al' && window.__alEngel) return;
      if (m.t === 'kalem-destek') { setTimeout(() => window.__fake({ t: 'kalem-destek', ok: false }), 0); return; }
    } catch {}
    return __orig.call(this, d);
  };`;

// Uzun adlar ve sessiz satırla sahte liste (taşma ve çizim denetimi için).
const SAHTE = (o = {}) => ({
  t: 'karisim', cihazId: 'c1',
  cihazlar: [
    { id: 'c1', ad: 'Hoparlör (Realtek(R) Audio)', varsayilan: true, multimedya: true, iletisim: true, ses: 40, sessiz: false },
    { id: 'c2', ad: 'Kulaklıklar (Çok Uzun Adlı Bluetooth Kulaklık Stereo Ses Çıkışı Aygıtı)', varsayilan: false, multimedya: false, iletisim: false, ses: 70, sessiz: true },
  ],
  uygulamalar: [
    { pid: 0, ad: 'Sistem sesleri', ses: 100, sessiz: false, cihazId: 'c1', sistem: true },
    { pid: 111, ad: 'Spotify', ses: 55, sessiz: false, cihazId: 'c1' },
    { pid: 222, ad: 'Google Chrome — çok uzun bir uygulama adı ğüşıöç ĞÜŞİÖÇ taşmamalı', ses: 20, sessiz: true, cihazId: 'c1' },
    { pid: 333, ad: 'Discord', ses: o.discord ?? 80, sessiz: false, cihazId: 'c1' },
  ],
});

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
    const fake = (m) => ev(`window.__fake(${JSON.stringify(m)})`);
    // Kaydırıcıda yüzdeye denk gelen nokta (topuz 26 px: çubuğun iki ucunda 13 px)
    const nokta = (r, yuzde) => ({ x: r.left + 13 + (r.w - 26) * yuzde / 100, y: r.y });
    const tasma = () => ev(`(() => {
      const p = document.getElementById('karisimPanel'), ic = p.querySelector('.rc-panel-ic'), r = p.getBoundingClientRect();
      const disari = [...p.querySelectorAll('.kr-satir, .kr-satir *, .kr-bas, .kr-not')].filter((e) => e.getClientRects().length)
        .map((e) => e.getBoundingClientRect()).filter((x) => x.right > r.right + 0.5 || x.left < r.left - 0.5).length;
      return { sol: r.left, sag: r.right, gen: innerWidth, ust: r.top, alt: r.bottom, yuk: innerHeight, sw: ic.scrollWidth, cw: ic.clientWidth, disari };
    })()`);
    const olcu = () => ev(`(() => {
      const k = document.getElementById('karisimKap');
      const b = (e) => { const r = e.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; };
      return { secici: b(k.querySelector('select')), kaydiricilar: [...k.querySelectorAll('input[type=range]')].filter((e) => e.getClientRects().length).map(b),
        sessizler: [...k.querySelectorAll('.kr-sessiz')].filter((e) => e.getClientRects().length).map(b) };
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
    check('RC.karisim.mount var', await ev("typeof RC.karisim?.mount === 'function'"));
    await ev("window.__gelen = []; RC.on('karisim', (m) => window.__gelen.push(m))");

    await ev("document.getElementById('modeControl').click()");
    check('görüntüleyici açıldı', await until("document.getElementById('screen').width > 0", 15000));
    await tap('#menuBtn');
    check('⋯ menüde "Ses karıştırıcı" ilk bakışta görünmüyor (Daha fazla altında)', !(await shown('#karisimBtn')) && await shown('#dahaFazla'));
    await tap('#dahaFazla');
    await ev("document.getElementById('karisimBtn').scrollIntoView({ block: 'center' })");
    await sleep(200);
    check('"Daha fazla"da Ses karıştırıcı satırı (salt izlemede gizli: ctl)', await shown('#karisimBtn') && await ev("document.getElementById('karisimBtn').classList.contains('ctl')"),
      await ev("document.querySelector('#karisimBtn').textContent"));
    await ev('window.__log.length = 0');
    await tap('#karisimBtn');
    check('dokununca panel açıldı, menü kapandı', await shown('#karisimPanel') && !(await shown('#menuPanel')));
    check('açılınca karisim-al gönderildi', await until("window.__log.some((m) => m.t === 'karisim-al')", 3000));
    check('gerçek cihaz listesi geldi (sunucu kuru)', await until('window.__gelen.length > 0 && document.querySelectorAll("#karisimKap select option").length > 0', 10000));
    const g = await ev('window.__gelen.at(-1)');
    const gercek = await ev(`({ secenek: [...document.querySelectorAll('#karisimKap select option')].map((o) => [o.value, o.textContent]), secili: document.querySelector('#karisimKap select').value,
      kaydirici: document.querySelector('#karisimKap [data-r=cihaz] input').value, yuzde: document.querySelector('#karisimKap [data-r=cihaz] .kr-yuzde').textContent,
      sessiz: document.querySelector('#karisimKap [data-r=cihaz] .kr-sessiz').getAttribute('aria-pressed'), uyg: document.querySelectorAll('#karisimKap [data-r=uyg] .kr-satir').length,
      adlar: [...document.querySelectorAll('#karisimKap [data-r=uyg] .kr-ad')].map((e) => e.textContent) })`);
    const vc = g.cihazlar.find((c) => c.id === g.cihazId);
    console.log(`     gerçek liste: ${g.cihazlar.map((c) => c.ad).join(' · ')} | uygulamalar: ${gercek.adlar.join(' · ')}`);
    check('seçici: tüm cihazlar, seçili = varsayılan', JSON.stringify(gercek.secenek) === JSON.stringify(g.cihazlar.map((c) => [c.id, c.ad])) && gercek.secili === g.cihazId && vc.varsayilan);
    check('cihaz satırı: kaydırıcı, yüzde ve sessiz gerçek değerde', gercek.kaydirici === String(vc.ses) && gercek.yuzde === `%${vc.ses}` && gercek.sessiz === String(vc.sessiz), JSON.stringify(gercek));
    check('uygulama satırları listedekiler', gercek.uyg === g.uygulamalar.length && JSON.stringify(gercek.adlar) === JSON.stringify(g.uygulamalar.map((u) => u.ad)), `${gercek.uyg} satır`);
    check('Türkçe adlar bozulmadan görünüyor', !gercek.secenek.some(([, ad]) => /\\u|\ufffd|Ã/.test(ad)));
    await shot('1-telefon-gercek-liste');

    // ---- 3 sn'de bir yenileme ----
    await ev('window.__log.length = 0');
    await sleep(3600);
    const yenileme = await ev("window.__log.filter((m) => m.t === 'karisim-al').length");
    check('panel açıkken 3 sn\'de bir yenileniyor', yenileme >= 1 && yenileme <= 2, `${yenileme} istek / 3,6 sn`);

    // ---- Sahte liste: uzun adlar, sessiz satır, taşma ----
    await ev('window.__alEngel = true');
    await sleep(100);
    await fake(SAHTE());
    await sleep(200);
    const s = await ev(`({ uyg: [...document.querySelectorAll('#karisimKap [data-r=uyg] .kr-satir')].map((e) => ({ pid: e.dataset.pid, ad: e.querySelector('.kr-ad').textContent,
      yuzde: e.querySelector('.kr-yuzde').textContent, sessiz: e.classList.contains('sessiz'), basili: e.querySelector('.kr-sessiz').getAttribute('aria-pressed'),
      simge: e.querySelector('.kr-sessiz svg') ? e.querySelector('.kr-sessiz svg').innerHTML.includes('M16 9.5l5 5') : null })),
      secili: document.querySelector('#karisimKap select').value, secenek: document.querySelectorAll('#karisimKap select option').length })`);
    check('sahte liste çizildi: 4 uygulama, sırayla', s.uyg.map((x) => x.pid).join() === '0,111,222,333' && s.secili === 'c1' && s.secenek === 2, JSON.stringify(s.uyg.map((x) => x.pid)));
    check('yüzdeler ve sessiz satır (SVG volumeOff simgesi, aria-pressed)', s.uyg.map((x) => x.yuzde).join() === '%100,%55,%20,%80'
      && s.uyg[2].sessiz && s.uyg[2].basili === 'true' && s.uyg[2].simge === true && !s.uyg[1].sessiz && s.uyg[1].simge === false, JSON.stringify(s.uyg[2]));
    check('simgeler emoji değil SVG', await ev("[...document.querySelectorAll('#karisimKap .kr-sessiz')].every((b) => b.querySelector('svg') && !/[\\u{1F300}-\\u{1FAFF}]/u.test(b.textContent))"));
    let ts = await tasma();
    check('telefon: panel ekrana sığıyor, yatay taşma yok (uzun adlar dahil)', ts.sol >= 0 && ts.sag <= ts.gen && ts.alt <= ts.yuk && ts.sw <= ts.cw && ts.disari === 0, JSON.stringify(ts));
    const o = await olcu();
    check('parmak boyu: seçici, kaydırıcılar ve sessiz düğmeleri ≥ 44 px yüksek', o.secici[1] >= 44 && o.kaydiricilar.every(([w, h]) => h >= 44 && w >= 150) && o.sessizler.every(([w, h]) => w >= 44 && h >= 44), JSON.stringify(o));
    check('uzun ad tek satırda kısaltıldı (…)', await ev("(() => { const e = document.querySelector('#karisimKap [data-pid=\"222\"] .kr-ad'); return e.scrollWidth > e.clientWidth && getComputedStyle(e).textOverflow === 'ellipsis'; })()"));
    check('"Varsayılan cihaz yapılır" notu', /varsayılan ses çıkışı yapılır/.test(await ev("document.querySelector('#karisimKap .kr-not').textContent")));
    await shot('2-telefon-sahte-liste');

    // ---- Sessiz düğmesi ----
    await sent();
    await tap('#karisimKap [data-r=cihaz] .kr-sessiz');
    let m = await sent();
    check('cihaz sessiz düğmesi: cihaz-sessiz true gönderdi, düğme basılı', m.length === 1 && m[0].tur === 'cihaz-sessiz' && m[0].id === 'c1' && m[0].deger === true
      && (await ev("document.querySelector('#karisimKap [data-r=cihaz] .kr-sessiz').getAttribute('aria-pressed')")) === 'true', JSON.stringify(m));
    await tap('#karisimKap [data-pid="222"] .kr-sessiz');
    m = await sent();
    check('uygulama sessiz düğmesi (sessizdeki): uyg-sessiz false', m.length === 1 && m[0].tur === 'uyg-sessiz' && m[0].pid === 222 && m[0].deger === false, JSON.stringify(m));
    await fake(SAHTE()); // eski değerler (sunucu henüz uygulamadı): az önce dokunulan düğmeler geri dönmemeli
    await sleep(100);
    check('az önce dokunulan sessiz düğmesi eski listeyle geri dönmedi', (await ev("document.querySelector('#karisimKap [data-r=cihaz] .kr-sessiz').getAttribute('aria-pressed')")) === 'true');

    // ---- Kaydırıcıya dokunma: o noktaya ----
    const spot = await rect('#karisimKap [data-pid="111"] input');
    await tap(nokta(spot, 25));
    m = await sent();
    const son111 = m.filter((x) => x.pid === 111).at(-1);
    check('kaydırıcıya dokunma: o noktanın değeri gönderildi (%25 ±2)', son111 && son111.tur === 'uyg-ses' && Math.abs(son111.deger - 25) <= 2, JSON.stringify(m));
    check('kaydırıcı ve yüzde de o değerde', (await ev("document.querySelector('#karisimKap [data-pid=\"111\"] .kr-yuzde').textContent")) === `%${son111?.deger}`);

    // ---- Sürükleme: sınırlı gönderim, son değer, zıplama yok ----
    await sleep(1300);
    const dc = await rect('#karisimKap [data-pid="333"] input');
    await touch('touchStart', [nokta(dc, 10)]);
    for (let i = 1; i <= 24; i++) {
      await touch('touchMove', [nokta(dc, 10 + (80 * i) / 24)]);
      await sleep(25);
      if (i === 12) await fake(SAHTE({ discord: 5 })); // sürüklerken sunucudan eski / farklı değer
    }
    const surerken = await ev("Number(document.querySelector('#karisimKap [data-pid=\"333\"] input').value)");
    await touch('touchEnd', []);
    await sleep(150);
    m = (await sent()).filter((x) => x.pid === 333);
    const araliklar = m.slice(1).map((x, i) => x.zaman - m[i].zaman);
    const sure = m.length > 1 ? m.at(-1).zaman - m[0].zaman : 0;
    console.log(`     sürükleme: ${m.length} mesaj / ${Math.round(sure)} ms, değerler ${m.map((x) => x.deger).join(',')}, aralıklar ${araliklar.map((x) => Math.round(x)).join(',')} ms`);
    check('sürüklerken gelen güncelleme kaydırıcıyı zıplatmadı', surerken > 40, `değer ${surerken}`);
    check('sürükleme: sınırlı gönderim (aralar ≥ 60 ms — bırakınca giden son mesaj hariç; 24 harekete karşı daha az mesaj)',
      m.length >= 3 && m.length < 24 && m.length <= sure / 60 + 2 && araliklar.slice(0, -1).every((x) => x >= 60), `${m.length} mesaj`);
    check('sürükleme: değerler artan, son değer bırakılan nokta (%90 ±2)', m.every((x, i) => i === 0 || x.deger >= m[i - 1].deger) && Math.abs(m.at(-1).deger - 90) <= 2, String(m.at(-1)?.deger));
    await fake(SAHTE({ discord: 5 }));
    await sleep(100);
    check('bıraktıktan hemen sonra gelen eski değer de yazılmadı', Number(await ev("document.querySelector('#karisimKap [data-pid=\"333\"] input').value")) > 80);
    await sleep(1300);
    await fake(SAHTE({ discord: 5 }));
    await sleep(100);
    check('kilit süresinden sonra sunucunun değeri yazıldı', (await ev("document.querySelector('#karisimKap [data-pid=\"333\"] .kr-yuzde').textContent")) === '%5');

    // ---- Dikey kaydırma kaydırıcıyı oynatmaz ----
    const once = await ev("document.querySelector('#karisimKap [data-pid=\"111\"] input').value");
    const sp2 = await rect('#karisimKap [data-pid="111"] input');
    await touch('touchStart', [nokta(sp2, 70)]);
    for (let i = 1; i <= 6; i++) { await touch('touchMove', [{ x: nokta(sp2, 70).x, y: sp2.y - i * 15 }]); await sleep(20); }
    await touch('touchEnd', []);
    await sleep(150);
    m = (await sent()).filter((x) => x.pid === 111);
    check('kaydırıcı üstünde dikey kaydırma değeri değiştirmedi', m.length === 0 && (await ev("document.querySelector('#karisimKap [data-pid=\"111\"] input').value")) === once, JSON.stringify(m));

    // ---- Çıkış cihazı seçici ----
    await ev("(() => { const s = document.querySelector('#karisimKap select'); s.value = 'c2'; s.dispatchEvent(new Event('change', { bubbles: true })); })()");
    m = await sent();
    check('çıkış cihazı değişince onay sormadan varsayilan gönderildi', m.length === 1 && m[0].tur === 'varsayilan' && m[0].id === 'c2', JSON.stringify(m));
    await fake(SAHTE());
    await sleep(100);
    check('seçim eski listeyle geri dönmedi', (await ev("document.querySelector('#karisimKap select').value")) === 'c2');

    // ---- Yenile ----
    await ev('window.__log.length = 0');
    await tap('#karisimKap [data-r=yenile]');
    check('Yenile düğmesi karisim-al gönderdi', await ev("window.__log.some((m) => m.t === 'karisim-al')"));

    // ---- Hata ve boş liste ----
    await fake({ t: 'karisim-hata', msg: 'Ayar uygulanamadı: deneme' });
    await sleep(100);
    check('karisim-hata metni gösterildi', /deneme/.test(await ev("document.querySelector('#karisimKap [data-r=msg]').textContent")));
    await fake({ ...SAHTE(), uygulamalar: [] });
    await sleep(100);
    check('uygulama yoksa açıklama', /uygulama yok/.test(await ev("document.querySelector('#karisimKap [data-r=uyg]').textContent")));
    await fake(SAHTE());
    await sleep(100);

    // ---- Başka kaba bağlama (Kumanda > Medya gibi) ----
    const kap = await ev(`(() => { const d = document.createElement('div'); d.id = 'krDeneme'; d.style.cssText = 'position:fixed;left:0;top:0;width:360px;background:#000;z-index:99';
      document.body.appendChild(d); const a = RC.karisim.mount(d), b = RC.karisim.mount(d);
      return { ayni: a === b, yenile: typeof a.yenile, satir: d.querySelectorAll('.kr-satir').length, secici: d.querySelectorAll('select').length }; })()`);
    check('RC.karisim.mount: son listeyle hemen çizdi, aynı öğeye ikinci kez bağlamaz', kap.ayni && kap.yenile === 'function' && kap.satir === 5 && kap.secici === 1, JSON.stringify(kap));
    await ev("document.getElementById('krDeneme').remove()");

    // ---- Kapatınca yenileme durur ----
    await tap('#karisimPanel .rc-x');
    check('✕ paneli kapattı', !(await shown('#karisimPanel')));
    await ev('window.__log.length = 0');
    await sleep(3600);
    check('panel kapalıyken yenileme yok', (await ev("window.__log.filter((m) => m.t === 'karisim-al').length")) === 0);

    // ---------------- iPad (1024x1366) ----------------
    await call('Emulation.setDeviceMetricsOverride', { width: 1024, height: 1366, deviceScaleFactor: 2, mobile: true });
    await call('Emulation.setUserAgentOverride', { userAgent: IPAD_UA });
    await sleep(500);
    await tap('#menuBtn');
    check('iPad: Ses karıştırıcı menüde doğrudan görünüyor', await shown('#karisimBtn'));
    await tap('#karisimBtn');
    await fake(SAHTE());
    await sleep(300);
    ts = await tasma();
    check('iPad: panel 420 px, taşma yok', Math.round(ts.sag - ts.sol) === 420 && ts.sag <= ts.gen && ts.sw <= ts.cw && ts.disari === 0, JSON.stringify(ts));
    await shot('3-ipad-panel');
    await tap('#karisimPanel .rc-x');

    // ---------------- Masaüstü fare (1280x800) ----------------
    await call('Emulation.setTouchEmulationEnabled', { enabled: false });
    await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await sleep(500);
    const fare = (type, p, buttons = 0) => call('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', buttons, clickCount: 1 });
    const menuR = await rect('#menuBtn');
    await fare('mousePressed', menuR, 1); await fare('mouseReleased', menuR);
    await sleep(200);
    const krR = await rect('#karisimBtn');
    await fare('mousePressed', krR, 1); await fare('mouseReleased', krR);
    await sleep(200);
    await fake(SAHTE());
    await sleep(300);
    await sent();
    const fr = await rect('#karisimKap [data-pid="111"] input');
    await fare('mousePressed', nokta(fr, 30), 1);
    for (let i = 1; i <= 10; i++) { await fare('mouseMoved', nokta(fr, 30 + 3 * i), 1); await sleep(20); }
    await fare('mouseMoved', { x: nokta(fr, 60).x, y: fr.y + 80 }, 1); // imleç kaydırıcının dışına çıktı (yakalama sürer)
    await fare('mouseReleased', { x: nokta(fr, 60).x, y: fr.y + 80 });
    await sleep(150);
    m = (await sent()).filter((x) => x.pid === 111);
    check('fare: basınca o nokta (%30), sürükleyince izler, dışarıda bırakınca son değer (%60)', m.length >= 2 && Math.abs(m[0].deger - 30) <= 2 && Math.abs(m.at(-1).deger - 60) <= 2,
      m.map((x) => x.deger).join(','));
    await ev("document.querySelector('#karisimPanel .rc-x').click()");

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
