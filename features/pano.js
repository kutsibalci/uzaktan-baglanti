// Pano (kopyala-yapıştır) eşitleme — metin ve resim.
// helper/Pano.exe bilgisayar panosunu dinler; yalnızca en az bir kontrol/yönetici oturumu varken çalışır.
//   Sunucu -> istemci: { t:'pano', text } | { t:'pano', tooBig:true }   (bilgisayar panosu değişti / pano-al cevabı)
//                      { t:'pano', resim: { id, w, h, bytes } }        (panoda resim var; PNG'si GET /api/pano/resim'den çekilir)
//                      { t:'pano', resim: { tooBig:true, w, h } }      (resim 20 MB'tan büyük, aktarılmaz)
//                      { t:'pano-yazildi', ok, msg? }                   (pano-yaz sonucu)
//                      { t:'pano-ayar', otomatik }                      (ayar değişti, yalnızca yöneticiye)
//   İstemci -> sunucu: { t:'pano-yaz', text } (control+), { t:'pano-al' } (control+), { t:'pano-ayar', otomatik } (admin)
//   HTTP (control+):  POST /api/pano/yaz   (gövde: UTF-8 metin) — WebSocket mesaj sınırını (64 KB) aşan metinler için.
//                     GET  /api/pano/resim (image/png) — bilgisayar panosundaki son resim; resim JSON'a gömülmez.
//                     POST /api/pano/resim (gövde: PNG/JPEG/GIF/BMP, en fazla 20 MB) -> bilgisayar panosuna resim olarak konur.
// Ayar: dataDir/pano.json { otomatik } — kapalıyken bilgisayar panosu kendiliğinden gönderilmez (pano-al ile alınır).
// Geri yankı: panoya kendi yazdığımız içerik "bilinen" anahtarıyla tanınır (metin: 't:'+metin, resim: 'r:'+piksel özeti).
const fs = require('fs');
const path = require('path');
const { spawnHelper } = require('../lib/helper');

const MAX_BAYT = 1024 * 1024;
const MAX_RESIM = 20 * 1024 * 1024;
const ISTEK_SURESI = 15000; // büyük resim çevirme birkaç saniye sürebilir
const RANK = { view: 0, control: 1, admin: 2 };
const yetkili = (c) => (RANK[c.session?.role] ?? -1) >= RANK.control;

// İlk baytlara bakarak resim türü (Pano.exe yalnızca bunları çözer).
function resimTuru(b) {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length > 6 && b.toString('latin1', 0, 4) === 'GIF8') return 'gif';
  if (b.length > 26 && b[0] === 0x42 && b[1] === 0x4d) return 'bmp';
  return null;
}

// İstek gövdesini en fazla "sinir" bayt okur; aşarsa null.
function govdeOku(req, sinir) {
  return new Promise((resolve) => {
    const parcalar = [];
    let boyut = 0;
    req.on('data', (d) => {
      boyut += d.length;
      if (boyut > sinir) { resolve(null); req.destroy(); return; }
      parcalar.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(parcalar)));
    req.on('error', () => resolve(null));
    req.on('close', () => resolve(null));
  });
}

module.exports.init = (api) => {
  const exe = api.buildExe('Pano');
  const AYAR_DOSYASI = path.join(api.dataDir, 'pano.json');

  let ayar = { otomatik: true };
  try {
    const d = JSON.parse(fs.readFileSync(AYAR_DOSYASI, 'utf8'));
    ayar.otomatik = d.otomatik !== false;
  } catch { /* ilk çalıştırma: varsayılanlar */ }
  function ayarKaydet() {
    fs.mkdirSync(api.dataDir, { recursive: true });
    fs.writeFileSync(AYAR_DOSYASI, JSON.stringify(ayar, null, 2));
  }

  // ---------- Pano.exe süreci ----------

  let proc = null;
  let bekleyenler = [];   // get/set cevaplarını sırayla bekleyenler
  let bilinen = null;     // bilgisayar panosunda olduğunu bildiğimiz son içeriğin anahtarı (geri yankı/tekrar engelleme)
  let resim = null;       // { id, png, w, h, hash } — bilgisayar panosundaki son resim (bellekte, en fazla 20 MB)
  let resimSayac = 0;
  let yukleyen = null;    // panoya son resmi gönderen istemci (geri yankı ona gitmez, diğer cihazlara gider)
  let yenidenTimer = null;

  const gerekli = () => [...api.clients].some(yetkili);

  function baslat() {
    if (proc) return;
    clearTimeout(yenidenTimer);
    const p = spawnHelper('Pano', exe, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    if (!p) return; // Windows engelledi: bir daha denenmez (uyarı yönetim panelinde)
    proc = p;
    bilinen = null;
    let parcalar = [];
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d) => {
      // Satırlar çok büyük olabilir (resim base64 ~27 MB); parçaları biriktirip yalnızca yeni parçada satır sonu ararız.
      let i;
      while ((i = d.indexOf('\n')) >= 0) {
        parcalar.push(d.slice(0, i));
        const satir = parcalar.join('');
        parcalar = [];
        d = d.slice(i + 1);
        if (satir.trim()) satirGeldi(satir);
      }
      if (d) parcalar.push(d);
    });
    p.stdin.on('error', () => {});
    p.on('error', (e) => api.log('Pano.exe başlatılamadı:', e.message));
    p.on('exit', (code) => {
      if (proc !== p) return; // bilerek durduruldu
      proc = null;
      bekleyenleriBitir();
      api.log(`Pano.exe kapandı (kod ${code})`);
      if (gerekli()) yenidenTimer = setTimeout(esitle, 2000);
    });
  }

  function durdur() {
    clearTimeout(yenidenTimer);
    resim = null; // bellek boşalsın
    yukleyen = null;
    if (!proc) return;
    const p = proc;
    proc = null;
    bekleyenleriBitir();
    p.stdin.end(); // stdin kapanınca kendisi çıkar
    setTimeout(() => { if (p.exitCode === null) p.kill(); }, 2000);
  }

  function bekleyenleriBitir() {
    for (const b of bekleyenler) { clearTimeout(b.timer); b.resolve(null); }
    bekleyenler = [];
  }

  function esitle() {
    if (gerekli()) baslat(); else durdur();
  }
  api.onAuth(esitle);
  api.onClose((ws) => { if (ws === yukleyen) yukleyen = null; esitle(); });

  // Pano.exe'ye komut gönderir; cevap ({t:'get'|'set',...}) ya da zaman aşımında null döner.
  // Komut yalnızca "get", "set <base64>" ya da "setimg <base64>" olabilir (satır sonu/boşluk enjeksiyonu yok).
  function istek(komut) {
    baslat();
    const p = proc;
    if (!p) return Promise.resolve(null);
    return new Promise((resolve) => {
      const b = {
        resolve,
        timer: setTimeout(() => {
          // Cevap gelmedi: sıra bozulmasın diye süreci yeniden başlat.
          api.log('Pano.exe cevap vermedi, yeniden başlatılıyor');
          if (proc === p) { durdur(); esitle(); }
          resolve(null);
        }, ISTEK_SURESI),
      };
      bekleyenler.push(b);
      p.stdin.write(komut + '\n');
    });
  }

  function satirGeldi(satir) {
    let m;
    try { m = JSON.parse(satir); } catch { return; }
    if (m.t === 'get' || m.t === 'set') {
      // Kendi koyduğumuz resmin değişiklik olayı hemen arkasından (aynı veri parçasında) gelebilir:
      // anahtar beklenen cevabı çözmeden, eşzamanlı olarak işaretlenir.
      if (m.t === 'set' && m.ok && m.image) bilinen = `r:${m.hash}`;
      const b = bekleyenler.shift();
      if (b) { clearTimeout(b.timer); b.resolve(m); }
    } else if (m.t === 'change') {
      degisti(m);
    } else if (m.t === 'error') {
      api.log('Pano.exe:', m.msg);
    }
  }

  function yay(obj, haric = null) {
    if (!ayar.otomatik) return;
    api.broadcast(obj, (c) => c !== haric && yetkili(c));
  }

  // Pano.exe'nin resim bildirimini saklar; istemciye gidecek özeti döner (PNG'nin kendisi HTTP'den çekilir).
  function resimSakla(m) {
    if (m.tooBig || typeof m.png !== 'string') {
      resim = null;
      return { tooBig: true, w: m.w, h: m.h };
    }
    if (!resim || resim.hash !== m.hash) resim = { id: ++resimSayac, png: Buffer.from(m.png, 'base64'), w: m.w, h: m.h, hash: m.hash };
    return { id: resim.id, w: resim.w, h: resim.h, bytes: resim.png.length };
  }

  function degisti(m) {
    if (m.image) {
      const anahtar = `r:${m.hash}`;
      const kendi = anahtar === bilinen; // telefondan gönderdiğimiz resim panoya kondu
      if (kendi && (m.tooBig ? !resim : resim?.hash === m.hash)) return; // aynı resim zaten biliniyor
      bilinen = anahtar;
      // Gönderen cihaza geri yankı yok; diğer bağlı cihazlar yeni resmi görsün.
      yay({ t: 'pano', resim: resimSakla(m) }, kendi ? yukleyen : null);
      return;
    }
    const anahtar = m.tooBig ? 'tb' : typeof m.text === 'string' ? `t:${m.text}` : null;
    if (!anahtar || anahtar === bilinen) return; // kendi yazdığımız ya da aynı metin
    bilinen = anahtar;
    resim = null;
    yay(m.tooBig ? { t: 'pano', tooBig: true } : { t: 'pano', text: m.text });
  }

  // İstemciden gelen metni bilgisayar panosuna yazar.
  async function yaz(ws, text) {
    if (typeof text !== 'string') return { ok: false, msg: 'Geçersiz metin.' };
    const buf = Buffer.from(text, 'utf8'); // eşleşmemiş vekiller U+FFFD olur; karşılaştırma için metni de buna göre al
    if (!buf.length) return { ok: false, msg: 'Boş metin gönderilemez.' };
    if (buf.length > MAX_BAYT) return { ok: false, msg: 'Metin çok büyük (en fazla 1 MB).' };
    text = buf.toString('utf8');
    const onceki = bilinen;
    bilinen = `t:${text}`; // panodan geri gelen değişiklik olayı yayınlanmasın
    const r = await istek(`set ${buf.toString('base64')}`);
    if (!r?.ok) {
      if (bilinen === `t:${text}`) bilinen = onceki;
      return { ok: false, msg: r?.msg || 'Panoya yazılamadı.' };
    }
    resim = null;
    yay({ t: 'pano', text }, ws); // diğer bağlı cihazlar da görsün (gönderen hariç)
    return { ok: true };
  }

  api.on('pano-yaz', async (ws, m) => {
    api.sendJson(ws, { t: 'pano-yazildi', ...(await yaz(ws, m.text)) });
  }, { role: 'control' });

  api.on('pano-al', async (ws) => {
    const r = await istek('get');
    if (!r || r.error) return api.sendJson(ws, { t: 'error', msg: 'Bilgisayarın panosu okunamadı.' });
    if (r.image) {
      bilinen = `r:${r.hash}`;
      return api.sendJson(ws, { t: 'pano', resim: resimSakla(r), istek: true });
    }
    if (r.tooBig) return api.sendJson(ws, { t: 'pano', tooBig: true, istek: true });
    api.sendJson(ws, { t: 'pano', text: typeof r.text === 'string' ? r.text : '', istek: true });
  }, { role: 'control' });

  api.on('pano-ayar', async (ws, m) => {
    ayar.otomatik = !!m.otomatik;
    ayarKaydet();
    api.store.log('admin', { user: ws.session.username, op: 'pano-ayar', target: ayar.otomatik ? 'açık' : 'kapalı' });
    api.broadcast({ t: 'pano-ayar', otomatik: ayar.otomatik }, (c) => c.session?.role === 'admin');
  }, { role: 'admin' });

  const json = (res, code, obj) => res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(obj));

  // Büyük metinler (WebSocket 64 KB sınırını aşanlar) için HTTP yolu.
  api.route('POST', '/api/pano/yaz', async (req, res, ws) => {
    const cokBuyuk = { ok: false, msg: 'Metin çok büyük (en fazla 1 MB).' };
    if (Number(req.headers['content-length']) > MAX_BAYT) { req.resume(); return json(res, 413, cokBuyuk); }
    const govde = await govdeOku(req, MAX_BAYT);
    if (!govde) { if (!res.headersSent && !res.destroyed) json(res, 413, cokBuyuk); return; }
    const r = await yaz(ws, govde.toString('utf8'));
    json(res, r.ok ? 200 : 400, r);
  }, { role: 'control' });

  // Bilgisayar panosundaki resim (bildirimdeki id yalnızca önbellek kırmak için; her zaman güncel resim döner).
  api.route('GET', '/api/pano/resim', async (req, res) => {
    const r = resim;
    if (!r) return res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Bilgisayarın panosunda resim yok.');
    res.writeHead(200, {
      'Content-Type': 'image/png', 'Content-Length': r.png.length, 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'X-Resim': `${r.id};${r.w}x${r.h}`,
    }).end(r.png);
  }, { role: 'control' });

  // Cihazdan gelen resmi bilgisayar panosuna koyar.
  api.route('POST', '/api/pano/resim', async (req, res, ws) => {
    const cokBuyuk = { ok: false, msg: 'Resim çok büyük (en fazla 20 MB).' };
    if (Number(req.headers['content-length']) > MAX_RESIM) { req.resume(); return json(res, 413, cokBuyuk); }
    const govde = await govdeOku(req, MAX_RESIM);
    if (!govde) { if (!res.headersSent && !res.destroyed) json(res, 413, cokBuyuk); return; }
    if (!resimTuru(govde)) return json(res, 415, { ok: false, msg: 'Desteklenmeyen resim biçimi (PNG, JPEG, GIF ya da BMP olmalı).' });
    yukleyen = ws;
    const r = await istek(`setimg ${govde.toString('base64')}`);
    if (!r?.ok) return json(res, r ? 400 : 500, { ok: false, msg: r?.msg || 'Panoya resim konamadı.' });
    json(res, 200, { ok: true, w: r.w, h: r.h });
  }, { role: 'control' });

  api.adminData(async () => ({ pano: { otomatik: ayar.otomatik, calisiyor: !!proc } }));
};
