// @ortam TRAY_TOKEN=dosya-testi-tepsi-belirteci-0123456789
// Dosya aktarımı testi: yükleme (akış, ad temizleme, çakışma, yarıda kesme, sınır), gezinme, indirme,
// yol geçişi saldırıları, yetkiler ve günlük. Kaydedilecek yer: ?klasor= ile yükleme ve kök dışı denemeler,
// yeni klasör ucu, "bilgisayarda göster" (kuru mod: REMOTE_DOSYA_KURU=1, Gezgin AÇILMAZ), tepsi olay akışında
// 'dosya-geldi' (TRAY_TOKEN tepsi uçlarını açar) ve başsız Edge'de panelin hedef satırı + seçimin hatırlanması,
// "Bilgisayardaki dosyalar"da seçme kutuları, "Zip olarak indir", "Seçilenleri indir" (zip ve indirme Edge'in indirme
// klasörü TEST_TMP altına yönlendirilerek gerçekten indirilir; ekran görüntüleri %TEMP%\rc-dosya). Zip ayrıntıları: ozellik-zip.js.
// ORTAM: Sunucuyu test/calistir.js başlatır ve her pakete geçici bir klasör verir (TEST_TMP). Sunucu ile bu test
// aynı ortam değişkenlerini alır: REMOTE_UPLOAD_DIR = TEST_TMP\yuklenen, REMOTE_BROWSE_ROOT = TEST_TMP\kok.
// Böylece gerçek İndirilenler ya da profil klasörüne hiç dokunulmaz. Elle çalıştırırken de bu üç değişkeni
// sunucuya ve teste aynı şekilde verin.
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const os = require('os');
const ROOT = path.join(__dirname, '..');
const WebSocket = require(path.join(ROOT, 'node_modules', 'ws'));
const PORT = process.env.TEST_PORT || 3999;
const URL = `ws://localhost:${PORT}`;

const TMP = process.env.TEST_TMP;
const YUKLE = process.env.REMOTE_UPLOAD_DIR;
const KOK = process.env.REMOTE_BROWSE_ROOT;
if (!TMP || !YUKLE || !KOK || !YUKLE.startsWith(TMP) || !KOK.startsWith(TMP)) {
  console.log('FAIL bu test test/calistir.js ile çalıştırılmalı (TEST_TMP, REMOTE_UPLOAD_DIR, REMOTE_BROWSE_ROOT gerekli)');
  process.exit(1);
}
const DISARI = path.join(TMP, 'disari'); // kökün DIŞINDA, saldırıların ulaşmaya çalışacağı klasör

function client() {
  const ws = new WebSocket(URL);
  const queue = [];
  const waiters = [];
  ws.on('message', (d, bin) => {
    if (bin) return;
    const msg = JSON.parse(d.toString());
    const i = waiters.findIndex((w) => w.pred(msg));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg); else queue.push(msg);
  });
  const next = (pred = () => true, ms = 8000) => {
    const i = queue.findIndex(pred);
    if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      waiters.push({ pred, resolve });
      setTimeout(() => reject(new Error('timeout waiting')), ms);
    });
  };
  const send = (o) => ws.send(JSON.stringify(o));
  const closed = new Promise((r) => ws.on('close', (c) => r(c)));
  return { ws, next, send, closed };
}
const t = (type) => (m) => m.t === type;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${name} ${extra}`);
  if (cond) pass++; else process.exitCode = 1;
}

// Ham HTTP isteği. govde: Buffer | (req) => Promise (akışla yazan fonksiyon)
function istek(method, yol, { token, headers = {}, govde } = {}) {
  return new Promise((resolve) => {
    const h = { ...headers };
    if (token) h['X-Oturum'] = token;
    const req = http.request({ host: 'localhost', port: PORT, method, path: yol, headers: h }, (res) => {
      const parcalar = [];
      res.on('data', (c) => parcalar.push(c));
      res.on('end', () => {
        const body = Buffer.concat(parcalar);
        let json = null;
        try { json = JSON.parse(body.toString()); } catch { /* ikili */ }
        resolve({ status: res.statusCode, headers: res.headers, body, json });
      });
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    if (typeof govde === 'function') govde(req);
    else req.end(govde);
  });
}
const yukle = (token, ad, veri) => istek('POST', `/api/dosya/yukle?ad=${encodeURIComponent(ad)}`, { token, govde: veri });
const liste = (token, yol) => istek('GET', `/api/dosya/liste?yol=${yol}`, { token }); // yol ham (saldırı testleri için kodlanmadan)
const indir = (token, yol) => istek('GET', `/api/dosya/indir?yol=${yol}`, { token });

// Sunucu sürecinin bellek kullanımı (dinlediği porttan bulunur), MB.
function sunucuPid() {
  const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' });
  // Durum sütunu Windows diline göre değişir (LISTENING/DİNLEME); dinleyen soketin uzak adresi 0.0.0.0:0'dır.
  const satir = out.split(/\r?\n/).find((l) => new RegExp(`^\\s*TCP\\s+0\\.0\\.0\\.0:${PORT}\\s+0\\.0\\.0\\.0:0\\s`).test(l));
  return satir ? Number(satir.trim().split(/\s+/).pop()) : null;
}
function bellekMB(pid) {
  const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
  const m = out.match(/"([\d.,\s]+) K"\s*$/m);
  return m ? Number(m[1].replace(/[^\d]/g, '')) / 1024 : NaN;
}

const tepsiOlaylari = [];
let tepsiAkis = null;
const ekJunctionlar = []; // hedef testlerinin kurduğu junction'lar (sonda bağlantı olarak kaldırılır)
const gercek = (p) => fs.realpathSync.native(p);
const yukleK = (token, ad, veri, klasor) => istek('POST', `/api/dosya/yukle?ad=${encodeURIComponent(ad)}&klasor=${klasor}`, { token, govde: veri });
const yeniKlasor = (token, yol, ad) => istek('POST', `/api/dosya/klasor?yol=${yol}&ad=${ad}`, { token });
const goster = (token, sorgu) => istek('POST', `/api/dosya/goster?${sorgu}`, { token });
const disariAdlari = () => fs.readdirSync(DISARI).sort().join(',');

// Kaydedilecek yer: hedef bilgisi, ?klasor= ile yükleme, kök dışı denemeler, yeni klasör, bilgisayarda göster.
async function hedefTestleri(T, V, { kopru, adsVar }) {
  // Kısayol klasörleri (Belgeler/Documents bilerek yok: yalnızca var olanlar listelenmeli).
  for (const k of ['Desktop', 'Downloads', 'Pictures']) fs.mkdirSync(path.join(KOK, k), { recursive: true });
  const disariOnce = disariAdlari();

  // ---------- Hedef bilgisi ----------
  let r = await istek('GET', '/api/dosya/hedef', { token: T });
  const ks = r.json?.kisayollar || [];
  check('hedef bilgisi: varsayılan klasör ve tam yolu', r.status === 200 && r.json.varsayilan.tam === gercek(YUKLE) && r.json.varsayilan.yer === `${path.basename(TMP)} › yuklenen`,
    JSON.stringify(r.json?.varsayilan));
  check('hedef bilgisi: yalnızca var olan kısayollar (Türkçe adlarla)',
    JSON.stringify(ks.map((k) => `${k.ad}=${k.yol}`)) === JSON.stringify(['Masaüstü=Desktop', 'İndirilenler=Downloads', 'Resimler=Pictures']), JSON.stringify(ks.map((k) => `${k.ad}=${k.yol}`)));
  check('hedef bilgisi: kök adı', r.json?.kok?.ad === path.basename(KOK));
  check('hedef bilgisi: salt izleme 403, oturumsuz 401', (await istek('GET', '/api/dosya/hedef', { token: V })).status === 403 && (await istek('GET', '/api/dosya/hedef')).status === 401);
  r = await liste(T, 'Pictures');
  check('liste cevabında kullanıcı dostu yer ve tam yol', r.json?.yer === 'Resimler' && r.json.tam === gercek(path.join(KOK, 'Pictures')), `${r.json?.yer} ${r.json?.tam}`);

  // ---------- ?klasor= ile yükleme ----------
  const foto = crypto.randomBytes(3000);
  r = await yukleK(T, 'IMG_0676.jpeg', foto, 'Pictures');
  const fotoYol = path.join(KOK, 'Pictures', 'IMG_0676.jpeg');
  check('seçilen klasöre yüklendi (iPhone adı korunur)', r.status === 200 && r.json?.ad === 'IMG_0676.jpeg' && fs.existsSync(fotoYol) && fs.readFileSync(fotoYol).equals(foto), `${r.status} ${JSON.stringify(r.json)}`);
  check('yükleme cevabı: yer, tam yol, köke göreli yol, kimlik', r.json?.yer === 'Resimler' && r.json.tam === gercek(fotoYol) && r.json.yol === 'Pictures/IMG_0676.jpeg' && /^[0-9a-f]{24}$/.test(r.json.id),
    JSON.stringify(r.json));
  const fotoId = r.json?.id;
  r = await yukleK(T, 'IMG_0676.jpeg', foto, 'Pictures');
  check('seçilen klasörde çakışma "IMG_0676 (1).jpeg"', r.json?.ad === 'IMG_0676 (1).jpeg' && fs.existsSync(path.join(KOK, 'Pictures', 'IMG_0676 (1).jpeg')), r.json?.ad);
  r = await yukleK(T, 'IMG_0677.HEIC', Buffer.from('heic'), encodeURIComponent('Pictures'));
  check('HEIC uzantısı olduğu gibi korunur', r.json?.ad === 'IMG_0677.HEIC');
  r = await yukleK(T, 'kok.txt', Buffer.from('k'), '');
  check('klasor= boş: kökün kendisi', r.status === 200 && r.json?.yer === path.basename(KOK) && fs.existsSync(path.join(KOK, 'kok.txt')), JSON.stringify(r.json));
  r = await yukleK(T, 'ic.txt', Buffer.from('i'), 'ic-kopru');
  check('kökün içine işaret eden junction klasörüne yükleme çalışır', r.status === 200 && fs.existsSync(path.join(KOK, 'alt', 'ic.txt')));
  r = await yukleK(T, 'x.txt', Buffer.from('x'), encodeURIComponent('Pictures/Tatil'));
  check('olmayan klasör 404 ve yükleme ucu klasör oluşturmaz', r.status === 404 && !fs.existsSync(path.join(KOK, 'Pictures', 'Tatil')), `(${r.status})`);
  r = await yukleK(T, 'x.txt', Buffer.from('x'), 'a.txt');
  check('dosyayı klasör diye vermek 400', r.status === 400);
  r = await yukleK(V, 'x.txt', Buffer.from('x'), 'Pictures');
  check('salt izleme ?klasor= ile yükleme 403', r.status === 403 && !fs.existsSync(path.join(KOK, 'Pictures', 'x.txt')));

  const klasorSaldirilari = [
    ['..', '..'],
    ['..\\..', encodeURIComponent('..\\..')],
    ['Pictures/../../disari', encodeURIComponent('Pictures/../../disari')],
    ['%2e%2e (URL kodlu)', '%2e%2e'],
    ['%2e%2e%2fdisari', '%2e%2e%2fdisari'],
    ['%252e%252e (çift kodlu)', '%252e%252e'],
    ['mutlak C:\\Windows\\Temp', encodeURIComponent('C:\\Windows\\Temp')],
    ['sürücüye göreli C:', encodeURIComponent('C:')],
    ['mutlak yol (dışarıdaki klasör)', encodeURIComponent(DISARI)],
    ['eğik çizgiyle başlayan /disari', encodeURIComponent('/disari')],
    ['UNC \\\\localhost\\c$', encodeURIComponent('\\\\localhost\\c$\\Windows\\Temp')],
    ['UNC aygıt yolu \\\\?\\', encodeURIComponent(`\\\\?\\${DISARI}`)],
    ['junction (mklink /J) kök dışına', encodeURIComponent('uzun-kopru-klasoru')],
    ['ADS Pictures:gizli', encodeURIComponent('Pictures:gizli')],
    ['ADS ::$INDEX_ALLOCATION', encodeURIComponent('Pictures::$INDEX_ALLOCATION')],
    ['sondaki nokta "Pictures."', encodeURIComponent('Pictures.')],
    ['sondaki boşluk "Pictures "', encodeURIComponent('Pictures ')],
    ['"..." ', encodeURIComponent('...')],
    ['aygıt adı CON', 'CON'],
    ['NUL baytı', encodeURIComponent('Pictures\u0000')],
  ];
  try {
    const kisa = execFileSync('cmd.exe', ['/d', '/c', `for %I in ("${kopru}") do @echo %~sI`], { encoding: 'utf8', windowsVerbatimArguments: true }).trim();
    const kisaAd = path.basename(kisa);
    if (kisaAd && kisaAd !== path.basename(kopru)) klasorSaldirilari.push([`8.3 kısa ad ${kisaAd}`, encodeURIComponent(kisaAd)]);
    else console.log('BİLGİ bu birimde 8.3 kısa adlar kapalı; kısa ad denemesi atlandı');
  } catch { console.log('BİLGİ kısa ad alınamadı; atlandı'); }
  let engel = 0;
  for (const [ad, k] of klasorSaldirilari) {
    const x = await yukleK(T, 'saldiri.txt', Buffer.from('SALDIRI'), k);
    const ok = x.status >= 400 && x.status < 500;
    if (ok) engel++;
    check(`?klasor= kök dışı reddedildi: ${ad}`, ok, `(${x.status}${x.json?.msg ? ` ${x.json.msg}` : ''})`);
  }
  check('?klasor= için en az 8 farklı kök dışı deneme', engel >= 8 && engel === klasorSaldirilari.length, `(${engel}/${klasorSaldirilari.length}, ADS ${adsVar ? 'var' : 'yok'})`);
  check('kök dışına hiçbir dosya yazılmadı', disariAdlari() === disariOnce && !fs.existsSync(path.join(TMP, 'saldiri.txt')), disariAdlari());

  // ---------- Yeni klasör ----------
  r = await yeniKlasor(T, 'Pictures', encodeURIComponent('Tatil 2026'));
  check('yeni klasör oluşturuldu', r.status === 200 && r.json?.yol === 'Pictures/Tatil 2026' && r.json.yer === 'Resimler › Tatil 2026' && !r.json.mevcut && fs.statSync(path.join(KOK, 'Pictures', 'Tatil 2026')).isDirectory(),
    JSON.stringify(r.json));
  r = await yeniKlasor(T, 'Pictures', encodeURIComponent('Tatil 2026'));
  check('var olan klasör: mevcut=true', r.status === 200 && r.json?.mevcut === true);
  const adlar = [
    ['..\\..\\kotu', 'kotu'],
    ['../../kotu2', 'kotu2'],
    ['CON', '_CON'],
    ['a:b', 'a_b'],
    ['x. ', 'x'],
    ['Yıl <2026>', 'Yıl _2026_'],
  ];
  for (const [gelen, beklenen] of adlar) {
    r = await yeniKlasor(T, 'Pictures', encodeURIComponent(gelen));
    check(`klasör adı temizlendi: ${JSON.stringify(gelen)}`, r.json?.ad === beklenen && fs.existsSync(path.join(KOK, 'Pictures', beklenen)), `→ ${JSON.stringify(r.json?.ad)} (${r.status})`);
  }
  check('temizlenen klasör adları kök dışına çıkmadı', !fs.existsSync(path.join(TMP, 'kotu')) && !fs.existsSync(path.join(TMP, 'kotu2')) && !fs.existsSync(path.join(KOK, 'kotu')));
  for (const [ad, deger] of [['boş ad', ''], ['"..."', '...'], ['yalnızca boşluk', '%20%20']]) {
    r = await yeniKlasor(T, '', deger);
    check(`geçersiz klasör adı reddedildi: ${ad}`, r.status === 400, `(${r.status})`);
  }
  r = await yeniKlasor(T, '', 'a.txt');
  check('aynı adda dosya varken 409', r.status === 409, `(${r.status})`);
  for (const [ad, ust] of [['..', '..'], ['%2e%2e', '%2e%2e'], ['mutlak', encodeURIComponent(DISARI)], ['UNC', encodeURIComponent('\\\\localhost\\c$\\Windows\\Temp')], ['junction', 'uzun-kopru-klasoru'], ['olmayan', 'olmayan']]) {
    r = await yeniKlasor(T, ust, 'yeni');
    check(`yeni klasör kök dışında/olmayan üstte reddedildi: ${ad}`, r.status >= 400 && r.status < 500, `(${r.status})`);
  }
  check('yeni klasör ucu kök dışına klasör açmadı', disariAdlari() === disariOnce && !fs.existsSync(path.join(TMP, 'yeni')));
  check('yeni klasör: salt izleme 403, oturumsuz 401', (await yeniKlasor(V, 'Pictures', 'v')).status === 403 && (await yeniKlasor('', 'Pictures', 'v')).status === 401 && !fs.existsSync(path.join(KOK, 'Pictures', 'v')));
  r = await yukleK(T, 'tatil.jpg', Buffer.from('t'), encodeURIComponent('Pictures/Tatil 2026'));
  check('yeni klasöre yükleme', r.status === 200 && r.json?.yer === 'Resimler › Tatil 2026' && fs.existsSync(path.join(KOK, 'Pictures', 'Tatil 2026', 'tatil.jpg')));

  // ---------- Bilgisayarda göster (kuru mod) ----------
  r = await goster(T, `id=${fotoId}`);
  check('göster: kuru modda komut doğru, Gezgin açılmadı', r.status === 200 && r.json?.kuru === true && r.json.komut === `explorer.exe /select,"${gercek(fotoYol)}"`, JSON.stringify(r.json));
  r = await goster(T, `id=${fotoId}`);
  check('göster: peş peşe basma 429', r.status === 429, `(${r.status})`);
  await sleep(1600);
  r = await goster(T, `yol=${encodeURIComponent('Pictures/IMG_0676 (1).jpeg')}`);
  check('göster: köke göreli doğrulanmış yol ile', r.status === 200 && r.json?.komut?.endsWith(`IMG_0676 (1).jpeg"`), JSON.stringify(r.json));
  const gosterRet = [
    ['bilinmeyen kimlik', 'id=0123456789abcdef01234567', 404],
    ['kimlik yok', '', 404],
    ['..', `yol=${encodeURIComponent('../disari/gizli.txt')}`],
    ['%2e%2e', 'yol=%2e%2e%2fdisari%2fgizli.txt'],
    ['mutlak yol', `yol=${encodeURIComponent(path.join(DISARI, 'gizli.txt'))}`],
    ['UNC', `yol=${encodeURIComponent('\\\\localhost\\c$\\Windows\\win.ini')}`],
    ['junction içinden', `yol=${encodeURIComponent('uzun-kopru-klasoru/gizli.txt')}`],
    ['ADS', `yol=${encodeURIComponent('ads.txt:gizli')}`],
    ['klasör (dosya değil)', `yol=${encodeURIComponent('Pictures')}`, 400],
    ['tırnaklı ad enjeksiyonu', `yol=${encodeURIComponent('a.txt" /root,C:\\Windows')}`],
  ];
  for (const [ad, sorgu, beklenen] of gosterRet) {
    const x = await goster(T, sorgu);
    check(`göster reddedildi: ${ad}`, beklenen ? x.status === beklenen : x.status >= 400 && x.status < 500 && x.status !== 429, `(${x.status}${x.json?.msg ? ` ${x.json.msg}` : ''})`);
  }
  // Silinen dosya
  r = await yukleK(T, 'silinecek.txt', Buffer.from('s'), 'Desktop');
  fs.rmSync(path.join(KOK, 'Desktop', 'silinecek.txt'));
  const silinen = await goster(T, `id=${r.json?.id}`);
  check('göster: silinmiş dosya 404', silinen.status === 404, `(${silinen.status})`);
  // Yükledikten sonra klasör kök dışına işaret eden bir junction ile değiştirilirse kimlik artık açmaz.
  fs.mkdirSync(path.join(KOK, 'degisen'));
  r = await yukleK(T, 'gizli.txt', Buffer.from('benim'), 'degisen');
  fs.renameSync(path.join(KOK, 'degisen'), path.join(KOK, 'degisen-eski'));
  fs.symlinkSync(DISARI, path.join(KOK, 'degisen'), 'junction');
  ekJunctionlar.push(path.join(KOK, 'degisen'));
  const degisen = await goster(T, `id=${r.json?.id}`);
  check('göster: yolu junction ile değişen kayıt reddedildi', degisen.status === 403, `(${degisen.status} ${degisen.json?.msg || ''})`);
  check('göster: salt izleme 403, oturumsuz 401', (await goster(V, `id=${fotoId}`)).status === 403 && (await goster('', `id=${fotoId}`)).status === 401);
}

// Başsız Edge (yoksa Chrome): panelde hedef satırı, klasör seçici, yeni klasör, seçimin hatırlanması, yükleme sonrası yer.
// iOS Safari emüle EDİLEMEZ; burada yalnızca Chromium motoru ve telefon boyutlu görüntü alanı denenir.
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const getJson = (u) => new Promise((res, rej) => http.get(u, (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej));

async function tarayiciKismi() {
  const exe = BROWSERS.find((b) => fs.existsSync(b));
  if (!exe) { console.log('OK   tarayıcı (Edge/Chrome) bulunamadı, tarayıcı kısmı atlandı'); return; }
  const profil = fs.mkdtempSync(path.join(TMP, 'tarayici-'));
  let tarayici;
  try {
    tarayici = require('child_process').spawn(exe, [
      '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profil}`, '--no-first-run', '--no-default-browser-check', '--mute-audio', 'about:blank',
    ], { stdio: 'ignore' });
    const portDosyasi = path.join(profil, 'DevToolsActivePort');
    for (let i = 0; i < 80 && !fs.existsSync(portDosyasi); i++) await sleep(250);
    const dbg = Number(fs.readFileSync(portDosyasi, 'utf8').split(/\r?\n/)[0]);
    let hedefler = [];
    for (let i = 0; i < 40; i++) { try { hedefler = await getJson(`http://127.0.0.1:${dbg}/json/list`); if (hedefler.some((x) => x.type === 'page')) break; } catch {} await sleep(250); }
    const cdp = new WebSocket(hedefler.find((x) => x.type === 'page').webSocketDebuggerUrl);
    await new Promise((r) => cdp.on('open', r));
    let id = 0; const bekleyen = new Map(); const hatalar = [];
    cdp.on('message', (d) => {
      const m = JSON.parse(d);
      if (m.method === 'Runtime.exceptionThrown') hatalar.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
      if (m.id && bekleyen.has(m.id)) { bekleyen.get(m.id)(m); bekleyen.delete(m.id); }
    });
    const call = (method, params = {}) => new Promise((r, j) => { const i = ++id; bekleyen.set(i, r); cdp.send(JSON.stringify({ id: i, method, params })); setTimeout(() => j(new Error(`CDP zaman aşımı: ${method}`)), 15000); });
    const ev = async (expression) => { const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails)); return r.result?.result?.value; };
    const bekle = async (ifade, ms = 8000) => { for (let i = 0; i < ms / 100; i++) { if (await ev(ifade).catch(() => false)) return true; await sleep(100); } return false; };
    const P = (k) => `document.querySelector('#dosyaPanel [data-k="${k}"]')`;
    const metin = (k) => ev(`${P(k)}.textContent`);
    const tikla = (secici) => ev(`(() => { const b = ${secici}; if (!b) return false; b.click(); return true; })()`);
    const dugmeMetinle = (kap, yazi) => `[...${P(kap)}.querySelectorAll('button')].find((b) => b.textContent.includes(${JSON.stringify(yazi)}))`;

    await call('Page.enable'); await call('Runtime.enable'); await call('DOM.enable');
    // İndirmeler kullanıcının İndirilenler klasörüne değil, testin geçici klasörüne.
    const indirmeler = path.join(TMP, 'tarayici-indirilen');
    fs.mkdirSync(indirmeler, { recursive: true });
    await call('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: indirmeler });
    // Telefon boyutlu görüntü alanı (iPhone 13/14 genişliği) ve dokunma.
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

    const girisYap = async () => {
      await bekle("!document.getElementById('vLogin').hidden || !document.getElementById('vHome').hidden", 10000);
      if (await ev("!document.getElementById('vLogin').hidden")) {
        await ev(`(() => { const f = document.getElementById('tAccount'); f.username.value='ahmet'; f.password.value='gizli123'; f.requestSubmit(); })()`);
      }
      return bekle("!document.getElementById('vHome').hidden", 10000);
    };
    const paneliAc = async () => {
      await tikla(`[...document.querySelectorAll('#vHome button')].find((b) => b.textContent.includes('Dosya aktarımı'))`);
      return bekle(`!document.getElementById('dosyaPanel').hidden && ${P('hedefTam')}.textContent.length > 0`);
    };

    await call('Page.navigate', { url: `http://localhost:${PORT}/` });
    check('tarayıcı: giriş yapıldı', await girisYap());
    check('tarayıcı: panel açıldı', await paneliAc());
    const vYer = `${path.basename(TMP)} › yuklenen`;
    check('tarayıcı: "Kaydedilecek yer" satırı varsayılanı gösteriyor', (await metin('hedef')).includes('Kaydedilecek yer:') && (await metin('hedefAd')) === vYer && (await metin('hedefTam')) === gercek(YUKLE),
      `${await metin('hedefAd')} | ${await metin('hedefTam')}`);
    check('tarayıcı: telefon genişliğinde yatay taşma yok', await ev("(() => { const p = document.getElementById('dosyaPanel'); return p.scrollWidth <= p.clientWidth; })()"));

    // Klasör seçici: Resimler → Tatil 2026 → yeni klasör "Telefon" → bu klasöre kaydet
    await tikla(P('degistir'));
    check('tarayıcı: seçici kısayolları', await bekle(`${P('kisayollar')}.textContent.includes('Resimler') && ${P('kisayollar')}.textContent.includes('Masaüstü') && !${P('kisayollar')}.textContent.includes('Belgeler')`),
      await metin('kisayollar'));
    await tikla(dugmeMetinle('kisayollar', 'Resimler'));
    await bekle(`${P('sListe')}.textContent.includes('Tatil 2026')`);
    await tikla(`[...${P('sListe')}.querySelectorAll('.girdi')].find((b) => b.dataset.ad === 'Tatil 2026')`);
    check('tarayıcı: klasörde gezinme', await bekle(`${P('sYol')}.textContent.includes('Tatil 2026')`), await metin('sYol'));
    await tikla(P('yeni'));
    await ev(`${P('yeniAd')}.value = 'Telefon'; ${P('yeniForm')}.requestSubmit()`);
    check('tarayıcı: yeni klasör oluşturuldu ve açıldı', await bekle(`${P('sYol')}.textContent.includes('Telefon')`) && fs.existsSync(path.join(KOK, 'Pictures', 'Tatil 2026', 'Telefon')),
      `${await metin('sYol')} | ${await metin('sDurum')}`);
    await tikla(P('buraya'));
    const secilen = 'Resimler › Tatil 2026 › Telefon';
    check('tarayıcı: seçim hedef satırında', (await metin('hedefAd')) === secilen && await ev(`${P('secici')}.hidden`), await metin('hedefAd'));
    const kayitli = await ev("(() => { try { return JSON.parse(localStorage.getItem('rc-dosya-hedef')); } catch { return null; } })()");
    check('tarayıcı: seçim bu cihazda saklandı', kayitli?.yol === 'Pictures/Tatil 2026/Telefon', JSON.stringify(kayitli));

    // Sayfa yenilenince seçim hatırlanmalı.
    await call('Page.reload', { ignoreCache: true });
    await sleep(500);
    check('tarayıcı: yenilemeden sonra giriş', await girisYap());
    await paneliAc();
    await sleep(500); // hedefYukle doğrulaması bitsin
    check('tarayıcı: seçim yenilemeden sonra hatırlandı', (await metin('hedefAd')) === secilen && (await metin('hedefTam')) === gercek(path.join(KOK, 'Pictures', 'Tatil 2026', 'Telefon')),
      `${await metin('hedefAd')} | ${await metin('hedefTam')}`);

    // Dosya seçiciden yükleme (CDP ile dosya seçimi).
    const fotoDosya = path.join(TMP, 'IMG_0676.jpeg');
    fs.writeFileSync(fotoDosya, crypto.randomBytes(5000));
    const { root } = (await call('DOM.getDocument', { depth: -1 })).result;
    const { nodeId } = (await call('DOM.querySelector', { nodeId: root.nodeId, selector: '#dosyaPanel [data-k="girdi"]' })).result;
    await call('DOM.setFileInputFiles', { nodeId, files: [fotoDosya] });
    const beklenenDurum = `Kaydedildi: ${secilen} › IMG_0676.jpeg`;
    check('tarayıcı: yükleme bitince tam yer gösterildi', await bekle(`${P('yuklemeler')}.querySelector('.durum').textContent === ${JSON.stringify(beklenenDurum)}`, 10000),
      await ev(`${P('yuklemeler')}.textContent.replace(/\\s+/g, ' ')`));
    check('tarayıcı: dosya seçilen klasöre kaydedildi', fs.existsSync(path.join(KOK, 'Pictures', 'Tatil 2026', 'Telefon', 'IMG_0676.jpeg')));
    await sleep(1600); // göster ucunun peş peşe basma sınırı
    await tikla(dugmeMetinle('yuklemeler', 'Bilgisayarda göster'));
    check('tarayıcı: "Bilgisayarda göster" (kuru mod)', await bekle(`${P('yuklemeler')}.textContent.includes('Deneme modu')`), await ev(`${P('yuklemeler')}.textContent.replace(/\\s+/g, ' ')`));
    check('tarayıcı: "Son gönderilenler" listesi yerle', await ev(`!${P('sonBolum')}.hidden && ${P('sonListe')}.textContent.includes('IMG_0676.jpeg') && ${P('sonListe')}.textContent.includes(${JSON.stringify(`${secilen} › IMG_0676.jpeg`)})`),
      (await metin('sonListe')).replace(/\s+/g, ' '));
    const son = await ev("(() => { try { return JSON.parse(localStorage.getItem('rc-dosya-son')); } catch { return null; } })()");
    check('tarayıcı: son gönderilenler bu cihazda saklandı', Array.isArray(son) && son[0]?.ad === 'IMG_0676.jpeg' && son[0].id, JSON.stringify(son?.[0]));

    // Seçilen klasör silinirse varsayılana dönülür.
    fs.rmSync(path.join(KOK, 'Pictures', 'Tatil 2026', 'Telefon'), { recursive: true, force: true });
    await tikla(P('kapat'));
    await paneliAc();
    check('tarayıcı: silinen klasör seçimi varsayılana döndü', await bekle(`${P('hedefAd')}.textContent === ${JSON.stringify(vYer)}`) && await ev("localStorage.getItem('rc-dosya-hedef') === null"),
      await metin('hedefAd'));
    // Varsayılana dön düğmesi
    await tikla(P('degistir'));
    await bekle(`${P('kisayollar')}.textContent.includes('Resimler')`);
    await tikla(dugmeMetinle('kisayollar', 'Masaüstü'));
    await bekle(`${P('buraya')}.textContent.includes('Masaüstü')`);
    await tikla(P('buraya'));
    check('tarayıcı: Masaüstü seçildi', (await metin('hedefAd')) === 'Masaüstü');
    await tikla(P('degistir'));
    await tikla(P('varsayilan'));
    check('tarayıcı: "Varsayılana dön"', (await metin('hedefAd')) === vYer && await ev("localStorage.getItem('rc-dosya-hedef') === null"));
    // ---------- Bilgisayardaki dosyalar: seçme kutuları, zip, seçilenleri indir ----------
    const SHOTS = path.join(os.tmpdir(), 'rc-dosya');
    fs.mkdirSync(SHOTS, { recursive: true });
    const goruntu = async (ad) => {
      const g = await call('Page.captureScreenshot', { format: 'png' });
      const p = path.join(SHOTS, `${ad}.png`);
      fs.writeFileSync(p, Buffer.from(g.result.data, 'base64'));
      console.log(`BİLGİ ekran görüntüsü: ${p}`);
    };
    const indirilen = async (ad, ms = 10000) => {
      const p = path.join(indirmeler, ad);
      for (let i = 0; i < ms / 100; i++) { if (fs.existsSync(p) && !fs.readdirSync(indirmeler).some((x) => x.endsWith('.crdownload'))) return fs.readFileSync(p); await sleep(100); }
      return null;
    };
    await tikla("document.querySelector('#dosyaPanel [data-sekme=gez]')");
    check('tarayıcı: dosya listesi', await bekle(`${P('liste')}.querySelectorAll('.gsatir').length >= 5`), await metin('gezDurum'));
    const satirlar = await ev(`[...${P('liste')}.querySelectorAll('.gsatir')].map((s) => ({ ad: s.dataset.ad, tur: s.dataset.tur, kutu: !!s.querySelector('input[type=checkbox]'), zip: s.querySelector('.zip')?.textContent || '', zipGorunur: !!s.querySelector('.zip')?.getClientRects().length }))`);
    check('tarayıcı: her satırda seçme kutusu', satirlar.every((x) => x.kutu), JSON.stringify(satirlar));
    check('tarayıcı: klasör satırlarında görünür "Zip olarak indir", dosyalarda yok', satirlar.filter((x) => x.tur === 'klasor').every((x) => x.zip.includes('Zip olarak indir') && x.zipGorunur) && satirlar.filter((x) => x.tur === 'dosya').every((x) => !x.zip),
      satirlar.map((x) => `${x.ad}:${x.zip}`).join(', '));
    check('tarayıcı: dosya listesinde yatay taşma yok', await ev("(() => { const p = document.getElementById('dosyaPanel'); return p.scrollWidth <= p.clientWidth; })()"));
    check('tarayıcı: seçim yokken seçim çubuğu gizli', await ev(`${P('secimCubugu')}.hidden`));
    await goruntu('1-liste');
    const kutu = (ad) => `[...${P('liste')}.querySelectorAll('.gsatir')].find((s) => s.dataset.ad === ${JSON.stringify(ad)}).querySelector('input')`;
    await tikla(kutu('a.txt'));
    check('tarayıcı: tek dosya seçilince "Seçileni indir"', await bekle(`!${P('secimCubugu')}.hidden && ${P('secilenleriIndir')}.textContent === 'Seçileni indir'`), await metin('secimCubugu'));
    await tikla(P('secilenleriIndir'));
    const aIcerik = await indirilen('a.txt');
    check('tarayıcı: tek seçili dosya doğrudan indi', aIcerik && aIcerik.toString() === 'a', String(aIcerik));
    await tikla(kutu('b.txt'));
    await tikla(kutu('alt'));
    check('tarayıcı: çoklu seçim çubuğu', await bekle(`${P('secimSayi')}.textContent === '3 seçili (1 klasör)' && ${P('secilenleriIndir')}.textContent === 'Seçilenleri zip olarak indir'`), await metin('secimCubugu'));
    await tikla(P('secilenleriIndir'));
    check('tarayıcı: zip çubuğunda tahmini boyut ve İndir bağlantısı', await bekle(`${P('zipBar')}.querySelector('a[download]') && ${P('zipBar')}.textContent.includes('dosya') && ${P('zipBar')}.textContent.includes('sıkıştırmadan önce')`),
      (await metin('zipBar')).replace(/\s+/g, ' '));
    const zipAdi = await ev(`${P('zipBar')}.querySelector('a[download]').getAttribute('download')`);
    check('tarayıcı: zip adı', zipAdi === `${path.basename(KOK)} (3 öğe).zip`, zipAdi);
    await goruntu('2-coklu-secim-zip');
    const once = await ev('location.href');
    await tikla(`${P('zipBar')}.querySelector('a[download]')`);
    const zipIcerik = await indirilen(zipAdi);
    check('tarayıcı: "İndir" zip\'i indirdi (PK imzası)', zipIcerik && zipIcerik.subarray(0, 2).toString() === 'PK', zipIcerik ? `${zipIcerik.length} bayt` : 'yok');
    check('tarayıcı: indirme sayfadan ayrılmadı', (await ev('location.href')) === once && await ev("!document.getElementById('dosyaPanel').hidden") && await ev(`!${P('zipBar')}.querySelector('[data-k3="not"]').hidden`));
    await tikla(`[...${P('liste')}.querySelectorAll('.gsatir')].find((s) => s.dataset.ad === 'alt').querySelector('.zip')`);
    check('tarayıcı: klasör satırındaki zip düğmesi', await bekle(`${P('zipBar')}.querySelector('a[download="alt.zip"]')`), (await metin('zipBar')).replace(/\s+/g, ' '));
    await tikla(`${P('zipBar')}.querySelector('a[download]')`);
    const altZip = await indirilen('alt.zip');
    check('tarayıcı: alt.zip indi', altZip && altZip.subarray(0, 2).toString() === 'PK');
    await tikla(P('secimTemizle'));
    check('tarayıcı: seçimi temizle', await bekle(`${P('secimCubugu')}.hidden && ![...${P('liste')}.querySelectorAll('input')].some((k) => k.checked)`));
    await tikla(P('tumu'));
    check('tarayıcı: tümünü seç', await bekle(`[...${P('liste')}.querySelectorAll('input')].every((k) => k.checked) && ${P('tumu')}.textContent === 'Seçimi kaldır'`));
    await tikla(`[...${P('liste')}.querySelectorAll('.gsatir')].find((s) => s.dataset.ad === 'alt').querySelector('.ac')`);
    check('tarayıcı: klasöre girince seçim sıfırlandı', await bekle(`${P('yol')}.textContent.includes('alt') && ${P('secimCubugu')}.hidden && ${P('zipBar')}.hidden`));
    await goruntu('3-alt-klasor');
    check('tarayıcı: sayfada yakalanmamış hata yok', hatalar.length === 0, JSON.stringify(hatalar));
    cdp.close();
  } finally {
    if (tarayici) { try { execFileSync('taskkill', ['/pid', String(tarayici.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* zaten kapandı */ } }
    // Edge süreçleri kapanırken profil ve indirme klasörünü bir süre tutabilir (yoksa calistir.js geçici klasörü silemez).
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      try {
        for (const d of [profil, path.join(TMP, 'tarayici-indirilen')]) fs.rmSync(d, { recursive: true, force: true });
        break;
      } catch { /* tarayıcı dosyaları bırakıyor olabilir */ }
    }
  }
}

async function giris(username, password) {
  const c = client();
  await c.next(t('hello'));
  c.send({ t: 'login', username, password, remember: false });
  return { c, r: await c.next(t('auth')) };
}

(async () => {
  // ---------- Hazırlık ----------
  fs.mkdirSync(path.join(KOK, 'alt', 'derin'), { recursive: true });
  fs.mkdirSync(path.join(KOK, 'Belgeler'), { recursive: true });
  fs.mkdirSync(DISARI, { recursive: true });
  fs.writeFileSync(path.join(DISARI, 'gizli.txt'), 'GİZLİ İÇERİK');
  const turkceAd = 'Türkçe ğüşıöç dosya "tırnak".txt'.replace(/"/g, ''); // Windows'ta " yasak
  const turkceIcerik = Buffer.from('merhaba dünya — içerik 🚀\n'.repeat(1000));
  fs.writeFileSync(path.join(KOK, 'alt', turkceAd), turkceIcerik);
  fs.writeFileSync(path.join(KOK, 'b.txt'), 'b');
  fs.writeFileSync(path.join(KOK, 'a.txt'), 'a');
  fs.writeFileSync(path.join(KOK, 'ads.txt'), 'görünen');
  let adsVar = true;
  try { fs.writeFileSync(path.join(KOK, 'ads.txt:gizli'), 'ADS İÇERİK'); } catch { adsVar = false; }
  const kopru = path.join(KOK, 'uzun-kopru-klasoru');
  fs.symlinkSync(DISARI, kopru, 'junction'); // mklink /J ile aynı
  const yerelKopru = path.join(KOK, 'ic-kopru');
  fs.symlinkSync(path.join(KOK, 'alt'), yerelKopru, 'junction'); // kökün İÇİNE işaret eden junction

  try {
    // Tepsi olay akışı (yalnızca bu bilgisayardan + belirteçle): yüklemeler 'dosya-geldi' olarak gelmeli.
    tepsiAkis = await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/tepsi/olaylar', headers: { 'X-Tepsi': process.env.TRAY_TOKEN || '' } }, (res) => {
        let tampon = '';
        res.setEncoding('utf8');
        res.on('data', (d) => {
          tampon += d;
          let i;
          while ((i = tampon.indexOf('\n\n')) >= 0) {
            const blok = tampon.slice(0, i);
            tampon = tampon.slice(i + 2);
            const satir = blok.split('\n').find((l) => l.startsWith('data: '));
            if (satir) { try { tepsiOlaylari.push(JSON.parse(satir.slice(6))); } catch { /* yok say */ } }
          }
        });
        res.on('error', () => {});
        resolve(res.statusCode === 200 ? req : null);
      });
      req.on('error', () => resolve(null));
    });
    check('tepsi olay akışı açıldı', !!tepsiAkis);

    // ---------- Oturumlar ----------
    const a = client();
    await a.next(t('hello'));
    a.send({ t: 'setup', username: 'ahmet', password: 'gizli123', remember: false });
    const ar = await a.next(t('auth'));
    check('yönetici oturumu + http anahtarı', ar.ok && !!ar.http);
    const T = ar.http;
    a.send({ t: 'admin', op: 'addUser', username: 'izleyici', password: 'izle1234', role: 'view' });
    await a.next(t('adminData'));
    const { c: v, r: vr } = await giris('izleyici', 'izle1234');

    // ---------- Yetki ----------
    let r = await liste('', '');
    check('oturumsuz liste 401', r.status === 401, `(${r.status})`);
    r = await istek('GET', '/api/dosya/liste?oturum=yanlis');
    check('yanlış oturum 401', r.status === 401);
    r = await yukle('', 'x.txt', Buffer.from('x'));
    check('oturumsuz yükleme 401', r.status === 401);
    r = await liste(vr.http, '');
    check('salt izleme liste 403', r.status === 403, `(${r.status})`);
    r = await indir(vr.http, 'a.txt');
    check('salt izleme indirme 403', r.status === 403);
    r = await yukle(vr.http, 'x.txt', Buffer.from('x'));
    check('salt izleme yükleme 403', r.status === 403);
    check('reddedilen yüklemeler dosya bırakmadı', !fs.existsSync(path.join(YUKLE, 'x.txt')));
    r = await istek('GET', `/api/dosya/liste?yol=&oturum=${encodeURIComponent(T)}`);
    check('?oturum= parametresiyle de çalışıyor', r.status === 200 && r.json?.ok);

    // ---------- Liste ----------
    r = await liste(T, '');
    const adlar = r.json?.girdiler?.map((g) => g.ad) || [];
    check('kök listesi', r.status === 200, `${r.status} ${r.body?.toString().slice(0, 200)} ${adlar.join(', ')}`);
    check('klasörler önce, alfabetik', JSON.stringify(adlar) === JSON.stringify(['alt', 'Belgeler', 'a.txt', 'ads.txt', 'b.txt']), JSON.stringify(adlar));
    check('junction/symlink girişleri listelenmedi', !adlar.includes('uzun-kopru-klasoru') && !adlar.includes('ic-kopru'));
    const at = r.json.girdiler.find((g) => g.ad === 'a.txt');
    check('dosya boyutu ve tarih', at.tur === 'dosya' && at.boyut === 1 && at.degisme > 0);
    r = await liste(T, encodeURIComponent('alt'));
    check('alt klasör listesi', r.json?.yol === 'alt' && r.json.girdiler.some((g) => g.ad === turkceAd) && r.json.girdiler[0].ad === 'derin');
    r = await liste(T, encodeURIComponent('olmayan'));
    check('olmayan klasör 404', r.status === 404);
    r = await liste(T, encodeURIComponent('a.txt'));
    check('dosyayı listeleme 400', r.status === 400);

    // ---------- İndirme ----------
    r = await indir(T, encodeURIComponent(`alt/${turkceAd}`));
    check('indirme 200 ve içerik aynı', r.status === 200 && r.body.equals(turkceIcerik));
    check('Content-Length doğru', Number(r.headers['content-length']) === turkceIcerik.length);
    const cd = r.headers['content-disposition'] || '';
    check('Content-Disposition UTF-8 (RFC 5987)', cd.startsWith('attachment;') && cd.includes(`filename*=UTF-8''${encodeURIComponent(turkceAd)}`) && /filename="[\x20-\x7e]+"/.test(cd), cd);
    r = await indir(T, encodeURIComponent('alt'));
    check('klasör indirilemez', r.status === 400);
    r = await indir(T, encodeURIComponent('ic-kopru/' + turkceAd));
    check('kökün içine işaret eden junction üzerinden indirme çalışır', r.status === 200 && r.body.equals(turkceIcerik));

    // ---------- Yol geçişi saldırıları ----------
    const gizliIcerik = (x) => x.body && x.body.toString().includes('GİZLİ');
    const saldirilar = [
      ['..', liste, '..'],
      ['..\\..', liste, encodeURIComponent('..\\..')],
      ['alt/../../disari', liste, encodeURIComponent('alt/../../disari')],
      ['%2e%2e (URL kodlu)', liste, '%2e%2e'],
      ['%2e%2e%2fdisari%2fgizli.txt', indir, '%2e%2e%2fdisari%2fgizli.txt'],
      ['%252e%252e (çift kodlu)', liste, '%252e%252e'],
      ['mutlak C:\\Windows', liste, encodeURIComponent('C:\\Windows')],
      ['mutlak sürücüye göreli C:', liste, encodeURIComponent('C:')],
      ['mutlak yol (dışarıdaki dosya)', indir, encodeURIComponent(path.join(DISARI, 'gizli.txt'))],
      ['eğik çizgiyle başlayan /Windows', liste, encodeURIComponent('/Windows')],
      ['UNC \\\\localhost\\c$', liste, encodeURIComponent('\\\\localhost\\c$\\Windows')],
      ['UNC aygıt yolu \\\\?\\C:\\', liste, encodeURIComponent('\\\\?\\C:\\Windows')],
      ['UNC \\\\.\\ aygıt', indir, encodeURIComponent('\\\\.\\PhysicalDrive0')],
      ['junction (mklink /J) kök dışına', liste, encodeURIComponent('uzun-kopru-klasoru')],
      ['junction içinden dosya', indir, encodeURIComponent('uzun-kopru-klasoru/gizli.txt')],
      ['ADS ads.txt:gizli', indir, encodeURIComponent('ads.txt:gizli')],
      ['ADS ::$DATA', indir, encodeURIComponent('a.txt::$DATA')],
      ['NUL baytı', indir, encodeURIComponent('a.txt\u0000.png')],
      ['aygıt adı CON', indir, 'CON'],
      ['aygıt adı nul.txt', indir, 'nul.txt'],
      ['sondaki nokta/boşluk ".. "', liste, encodeURIComponent('.. ')],
      ['"..." (Windows\'ta .. gibi davranabilir)', liste, encodeURIComponent('...')],
      ['sondaki nokta "a.txt."', indir, encodeURIComponent('a.txt.')],
    ];
    // 8.3 kısa ad: junction'ın kısa adı varsa onunla da dışarı çıkılamamalı.
    try {
      const kisa = execFileSync('cmd.exe', ['/d', '/c', `for %I in ("${kopru}") do @echo %~sI`], { encoding: 'utf8', windowsVerbatimArguments: true }).trim();
      const kisaAd = path.basename(kisa);
      if (kisaAd && kisaAd !== path.basename(kopru)) saldirilar.push([`8.3 kısa ad ${kisaAd}`, liste, encodeURIComponent(kisaAd)]);
      else console.log('BİLGİ bu birimde 8.3 kısa adlar kapalı; kısa ad denemesi atlandı');
    } catch { console.log('BİLGİ kısa ad alınamadı; atlandı'); }

    let engellenen = 0;
    for (const [ad, fn, yol] of saldirilar) {
      const x = await fn(T, yol);
      const ok = x.status >= 400 && x.status < 500 && !gizliIcerik(x) && !(x.body && x.body.toString().includes('ADS İÇERİK'));
      if (ok) engellenen++;
      check(`saldırı engellendi: ${ad}`, ok, `(${x.status}${x.json?.msg ? ` ${x.json.msg}` : ''})`);
    }
    check(`en az 8 farklı yol geçişi denemesi`, engellenen >= 8 && engellenen === saldirilar.length, `(${engellenen}/${saldirilar.length}, ADS ${adsVar ? 'var' : 'yok'})`);

    // ---------- Yükleme ----------
    r = await yukle(T, 'merhaba.txt', Buffer.from('merhaba'));
    check('küçük dosya yüklendi', r.status === 200 && r.json?.ad === 'merhaba.txt' && fs.readFileSync(path.join(YUKLE, 'merhaba.txt'), 'utf8') === 'merhaba');
    r = await yukle(T, 'merhaba.txt', Buffer.from('ikinci'));
    check('çakışmada "ad (1).uzantı"', r.json?.ad === 'merhaba (1).txt' && fs.readFileSync(path.join(YUKLE, 'merhaba (1).txt'), 'utf8') === 'ikinci', r.json?.ad);
    r = await yukle(T, 'merhaba.txt', Buffer.from('üçüncü'));
    check('ikinci çakışmada (2)', r.json?.ad === 'merhaba (2).txt');

    const adTestleri = [
      ['..\\..\\kotu<>:"|?*.txt', 'kotu_______.txt'],
      ['../../../etc/passwd', 'passwd'],
      ['C:\\Windows\\System32\\evil.dll', 'evil.dll'],
      ['CON.txt', '_CON.txt'],
      ['nul', '_nul'],
      ['com1.log', '_com1.log'],
      ['  .gizli. ', 'gizli'],
      ['...', 'dosya'],
      ['dosya.txt:ads', 'dosya.txt_ads'],
      ['Türkçe ğüş İ.pdf', 'Türkçe ğüş İ.pdf'],
      ['sekme\tsatır\nsonu.txt', 'sekme_satır_sonu.txt'],
    ];
    for (const [gelen, beklenen] of adTestleri) {
      r = await yukle(T, gelen, Buffer.from('x'));
      const varMi = r.json?.ad && fs.existsSync(path.join(YUKLE, r.json.ad));
      check(`ad temizlendi: ${JSON.stringify(gelen)}`, r.json?.ad === beklenen && varMi, `→ ${JSON.stringify(r.json?.ad)}`);
    }
    r = await yukle(T, 'a'.repeat(300) + '.txt', Buffer.from('x'));
    check('çok uzun ad kısaltıldı, uzantı korundu', r.json?.ad?.length <= 180 && r.json.ad.endsWith('.txt'));
    check('hiçbir dosya yükleme klasörü dışına yazılmadı', !fs.existsSync(path.join(TMP, 'kotu_______.txt')) && !fs.existsSync(path.join(KOK, 'passwd')));

    // Büyük dosya (~50 MB) akışla; sunucu belleği dosya boyutu kadar büyümemeli.
    const pid = sunucuPid();
    const once = pid ? bellekMB(pid) : NaN;
    const BOYUT = 50 * 1024 * 1024;
    const PARCA = 1024 * 1024;
    const hash = crypto.createHash('sha256');
    let tepe = once;
    let olcuyor = true;
    const olcum = (async () => { while (olcuyor && pid) { tepe = Math.max(tepe, bellekMB(pid)); await sleep(100); } })();
    const t0 = Date.now();
    r = await istek('POST', '/api/dosya/yukle?ad=buyuk.bin', {
      token: T,
      headers: { 'Content-Length': BOYUT },
      govde: async (req) => {
        for (let i = 0; i < BOYUT / PARCA; i++) {
          const p = crypto.randomBytes(PARCA);
          hash.update(p);
          if (!req.write(p)) await new Promise((res) => req.once('drain', res));
          if (i % 10 === 0) await sleep(20); // ölçüm için biraz yay
        }
        req.end();
      },
    });
    olcuyor = false;
    await olcum;
    const sure = Date.now() - t0;
    const diskteki = path.join(YUKLE, 'buyuk.bin');
    const ayni = fs.existsSync(diskteki) && crypto.createHash('sha256').update(fs.readFileSync(diskteki)).digest('hex') === hash.digest('hex');
    check('50 MB akışla yüklendi, içerik aynı', r.status === 200 && r.json?.boyut === BOYUT && ayni, `(${sure} ms)`);
    check('sunucu belleği dosya boyutu kadar büyümedi', Number.isFinite(once) ? tepe - once < 35 : false,
      `(önce ${once.toFixed(0)} MB, tepe ${tepe.toFixed(0)} MB)`);

    // Yarıda kesilen yükleme: yarım dosya silinmeli.
    await new Promise((resolve) => {
      const req = http.request({ host: 'localhost', port: PORT, method: 'POST', path: '/api/dosya/yukle?ad=yarim.bin',
        headers: { 'X-Oturum': T, 'Content-Length': 20 * PARCA } });
      req.on('error', () => resolve());
      req.on('close', () => resolve());
      req.write(crypto.randomBytes(5 * PARCA), () => setTimeout(() => req.destroy(), 300));
    });
    await sleep(1000);
    check('yarıda kesilen yüklemenin yarım dosyası silindi', !fs.readdirSync(YUKLE).some((f) => f.startsWith('yarim')), fs.readdirSync(YUKLE).filter((f) => f.startsWith('yarim')).join(','));

    // 8 GB sınırı (Content-Length ile hemen reddedilir)
    r = await istek('POST', '/api/dosya/yukle?ad=dev.bin', { token: T, headers: { 'Content-Length': String(9 * 1024 ** 3) }, govde: (req) => { req.on('error', () => {}); req.write('x'); setTimeout(() => req.destroy(), 500); } });
    check('8 GB üstü 413', r.status === 413, `(${r.status})`);
    check('reddedilen büyük yükleme dosya bırakmadı', !fs.readdirSync(YUKLE).some((f) => f.startsWith('dev')));

    await hedefTestleri(T, vr.http, { kopru, adsVar });
    await tarayiciKismi();

    const dosyaOlayi = tepsiOlaylari.find((o) => o.tur === 'dosya-geldi' && o.dosya?.ad === 'IMG_0676.jpeg');
    check('tepsi olay akışında "dosya-geldi" (ad ve yer)', !!dosyaOlayi && dosyaOlayi.dosya.yer === 'Resimler' && dosyaOlayi.dosya.kullanici === 'ahmet' && dosyaOlayi.dosya.boyut > 0,
      JSON.stringify(dosyaOlayi || tepsiOlaylari.map((o) => o.tur)));
    const varsayilanOlay = tepsiOlaylari.find((o) => o.tur === 'dosya-geldi' && o.dosya?.ad === 'merhaba.txt');
    check('varsayılan klasöre gelen dosyanın yeri ters eğik çizgiyle', !!varsayilanOlay && varsayilanOlay.dosya.yer === `${path.basename(TMP)}\\yuklenen`, JSON.stringify(varsayilanOlay?.dosya));
    if (tepsiAkis) tepsiAkis.destroy();

    // ---------- Günlük ----------
    a.send({ t: 'admin', op: 'list' });
    const ad = await a.next(t('adminData'));
    const kayitlar = ad.log.filter((l) => l.event === 'dosya');
    check('yükleme günlüğe yazıldı', kayitlar.some((l) => l.islem === 'yukle' && l.ad === 'buyuk.bin' && l.boyut === BOYUT && l.user === 'ahmet' && l.ip));
    check('seçilen klasöre yükleme günlükte yeriyle', kayitlar.some((l) => l.islem === 'yukle' && l.ad === 'IMG_0676.jpeg' && l.klasor === 'Resimler'));
    check('indirme günlüğe yazıldı',kayitlar.some((l) => l.islem === 'indir' && l.ad === `alt/${turkceAd}` && l.boyut === turkceIcerik.length));

    a.ws.close(); await a.closed;
    v.ws.close(); await v.closed;
    r = await liste(T, '');
    check('bağlantı kapanınca http anahtarı geçersiz', r.status === 401);
  } finally {
    if (tepsiAkis) tepsiAkis.destroy();
    // Junction'ları bağlantı olarak kaldır (hedefleri silinmez); geri kalanını calistir.js temizler.
    for (const j of [kopru, yerelKopru, ...ekJunctionlar]) { try { fs.rmdirSync(j); } catch { /* yok */ } }
  }
  console.log(`\n${pass} kontrol geçti`);
  process.exit();
})().catch((e) => { console.error('TEST HATASI', e); process.exit(1); });
