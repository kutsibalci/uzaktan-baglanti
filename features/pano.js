// Pano (kopyala-yapıştır) eşitleme — yalnızca metin.
// helper/Pano.exe bilgisayar panosunu dinler; yalnızca en az bir kontrol/yönetici oturumu varken çalışır.
//   Sunucu -> istemci: { t:'pano', text } | { t:'pano', tooBig:true }   (bilgisayar panosu değişti / pano-al cevabı)
//                      { t:'pano-yazildi', ok, msg? }                   (pano-yaz sonucu)
//                      { t:'pano-ayar', otomatik }                      (ayar değişti, yalnızca yöneticiye)
//   İstemci -> sunucu: { t:'pano-yaz', text } (control+), { t:'pano-al' } (control+), { t:'pano-ayar', otomatik } (admin)
//   HTTP: POST /api/pano/yaz (gövde: UTF-8 metin) — WebSocket mesaj sınırını (64 KB) aşan metinler için.
// Ayar: dataDir/pano.json { otomatik } — kapalıyken bilgisayar panosu kendiliğinden gönderilmez (pano-al ile alınır).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const MAX_BAYT = 1024 * 1024;
const ISTEK_SURESI = 5000;
const RANK = { view: 0, control: 1, admin: 2 };
const yetkili = (c) => (RANK[c.session?.role] ?? -1) >= RANK.control;
const BUYUK = Symbol('tooBig');

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
  let bilinen = null;     // bilgisayar panosunda olduğunu bildiğimiz son metin (geri yankı/tekrar engelleme)
  let yenidenTimer = null;

  const gerekli = () => [...api.clients].some(yetkili);

  function baslat() {
    if (proc) return;
    clearTimeout(yenidenTimer);
    const p = spawn(exe, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    proc = p;
    bilinen = null;
    let parcalar = [];
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d) => {
      // Satırlar 1 MB'ı aşabilir; parçaları biriktirip yalnızca yeni parçada satır sonu ararız.
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
  api.onClose(esitle);

  // Pano.exe'ye komut gönderir; cevap ({t:'get'|'set',...}) ya da zaman aşımında null döner.
  // Komut yalnızca "get" ya da "set <base64>" olabilir (satır sonu/boşluk enjeksiyonu yok).
  function istek(komut) {
    baslat();
    const p = proc;
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

  function degisti(m) {
    if (m.tooBig) {
      if (bilinen === BUYUK) return;
      bilinen = BUYUK;
      yay({ t: 'pano', tooBig: true });
      return;
    }
    if (typeof m.text !== 'string' || m.text === bilinen) return; // kendi yazdığımız ya da aynı metin
    bilinen = m.text;
    yay({ t: 'pano', text: m.text });
  }

  // İstemciden gelen metni bilgisayar panosuna yazar.
  async function yaz(ws, text) {
    if (typeof text !== 'string') return { ok: false, msg: 'Geçersiz metin.' };
    const buf = Buffer.from(text, 'utf8'); // eşleşmemiş vekiller U+FFFD olur; karşılaştırma için metni de buna göre al
    if (!buf.length) return { ok: false, msg: 'Boş metin gönderilemez.' };
    if (buf.length > MAX_BAYT) return { ok: false, msg: 'Metin çok büyük (en fazla 1 MB).' };
    text = buf.toString('utf8');
    const onceki = bilinen;
    bilinen = text; // panodan geri gelen değişiklik olayı yayınlanmasın
    const r = await istek(`set ${buf.toString('base64')}`);
    if (!r?.ok) {
      if (bilinen === text) bilinen = onceki;
      return { ok: false, msg: r?.msg || 'Panoya yazılamadı.' };
    }
    yay({ t: 'pano', text }, ws); // diğer bağlı cihazlar da görsün (gönderen hariç)
    return { ok: true };
  }

  api.on('pano-yaz', async (ws, m) => {
    api.sendJson(ws, { t: 'pano-yazildi', ...(await yaz(ws, m.text)) });
  }, { role: 'control' });

  api.on('pano-al', async (ws) => {
    const r = await istek('get');
    if (!r || r.error) return api.sendJson(ws, { t: 'error', msg: 'Bilgisayarın panosu okunamadı.' });
    if (r.tooBig) return api.sendJson(ws, { t: 'pano', tooBig: true, istek: true });
    api.sendJson(ws, { t: 'pano', text: typeof r.text === 'string' ? r.text : '', istek: true });
  }, { role: 'control' });

  api.on('pano-ayar', async (ws, m) => {
    ayar.otomatik = !!m.otomatik;
    ayarKaydet();
    api.store.log('admin', { user: ws.session.username, op: 'pano-ayar', target: ayar.otomatik ? 'açık' : 'kapalı' });
    api.broadcast({ t: 'pano-ayar', otomatik: ayar.otomatik }, (c) => c.session?.role === 'admin');
  }, { role: 'admin' });

  // Büyük metinler (WebSocket 64 KB sınırını aşanlar) için HTTP yolu.
  api.route('POST', '/api/pano/yaz', async (req, res, ws) => {
    const json = (code, obj) => res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(obj));
    if (Number(req.headers['content-length']) > MAX_BAYT) { req.resume(); return json(413, { ok: false, msg: 'Metin çok büyük (en fazla 1 MB).' }); }
    const parcalar = [];
    let boyut = 0;
    const tamam = await new Promise((resolve) => {
      req.on('data', (d) => {
        boyut += d.length;
        if (boyut > MAX_BAYT) { resolve(false); req.destroy(); return; }
        parcalar.push(d);
      });
      req.on('end', () => resolve(true));
      req.on('error', () => resolve(false));
      req.on('close', () => resolve(false));
    });
    if (!tamam) { if (!res.headersSent && !res.destroyed) json(413, { ok: false, msg: 'Metin çok büyük (en fazla 1 MB).' }); return; }
    const r = await yaz(ws, Buffer.concat(parcalar).toString('utf8'));
    json(r.ok ? 200 : 400, r);
  }, { role: 'control' });

  api.adminData(async () => ({ pano: { otomatik: ayar.otomatik, calisiyor: !!proc } }));
};
