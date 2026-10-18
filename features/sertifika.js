// Ev ağında HTTPS: kendi kök sertifikamız (lib/sertifika.js) ile HTTP'nin yanında HTTPS de dinlenir (varsayılan 3443).
// iPhone Safari'de WebCodecs (H.264) ve ses yalnızca güvenli sayfada çalışır; Tailscale olmadan ev ağında bunu sağlar.
// İlk açılışta CA + sunucu sertifikası üretilir ve HTTPS açılır (yönetim panelinden kapatılabilir). IP değişirse
// (DHCP) sunucu sertifikası aynı CA ile yeniden imzalanır; telefondaki profil geçerli kalır.
//
// HTTP (oturum GEREKMEZ; yalnızca ev ağı / Tailscale / bu bilgisayar — çekirdek diğerlerini zaten reddeder):
//   GET /api/sertifika/durum            -> { acik, port, adres (bu cihaz için önerilen https adresi), ad, parmakIzi, hata }
//   GET /api/sertifika/ca.mobileconfig  -> iOS yapılandırma profili (com.apple.security.root)
//   GET /api/sertifika/ca.cer           -> kök sertifika (DER) — Android ve diğerleri
//   GET /api/sertifika/yokla            -> { ok } — HTTP sayfası bunu HTTPS adresinden ister: başarılıysa cihaz sertifikaya güveniyor
// WebSocket (yönetici):
//   { t: 'sertifika', op: 'ac' | 'kapat' | 'yeniden' | 'sil' }  -> { t: 'sertifika-durum', ...ayrıntı, ok?, error? }
const path = require('path');
const sertifika = require('../lib/sertifika');

const YOKLAMA_MS = 60 * 1000; // IP adresi / süre denetimi

module.exports.init = (api) => {
  const dir = path.join(api.dataDir, 'sertifika');
  let son = null;   // sertifika.hazirla sonucu (açıkken)
  let hata = null;
  let sira = Promise.resolve(); // açma/kapama işlemleri üst üste binmesin
  const isle = (fn) => (sira = sira.then(fn, fn));

  async function ac({ yeniCa = false } = {}) {
    try {
      son = sertifika.hazirla(dir, { yeniCa });
      await api.https.ac({ key: son.key, cert: son.cert });
      hata = null;
      if (son.yeniCa) api.log('Yeni yerel kök sertifika üretildi:', son.meta.ad);
    } catch (e) {
      hata = e.code === 'EADDRINUSE' ? `HTTPS portu kullanımda (${e.port}). PORT_HTTPS ile başka port seçin.` : e.message;
      api.log('HTTPS açılamadı:', hata);
    }
  }

  // HTTPS'i kapatır, sonucu bildirir, sonra HTTPS üzerinden bağlı olanları düşürür (yeniden bağlanınca HTTP adresini kullanmalılar).
  function kapat(ws, ok) {
    api.https.kapat();
    yayinla(ws, { ok });
    api.kick((c) => !!c._socket?.encrypted, 'https kapandı');
  }

  // Sayfanın açıldığı ada göre önerilen HTTPS adresi: o ad/IP sertifikadaysa aynısı, değilse ev ağı IP'si.
  function adres(req) {
    const port = api.https.port();
    if (!port || !son) return null;
    const host = String(req?.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
    const s = son.sunucu;
    const kapsar = (h) => h && (s.checkHost(h) || s.checkIP(h));
    const ipler = (s.subjectAltName || '').split(', ').filter((x) => x.startsWith('IP Address:')).map((x) => x.slice(11));
    const h = kapsar(host) ? host : ipler.find((x) => x.startsWith('192.168.')) || ipler.find((x) => x !== '127.0.0.1') || 'localhost';
    return `https://${h}:${port}`;
  }

  const genel = (req) => ({
    acik: !!api.https.port(), port: api.https.port(), adres: adres(req), hata,
    ad: son?.meta.ad || null, parmakIzi: son?.ca.fingerprint256 || null,
  });

  function ayrinti() {
    const s = son?.sunucu;
    const san = (s?.subjectAltName || '').split(', ').filter(Boolean);
    return {
      ...genel(null),
      ayarAcik: sertifika.ayarOku(dir).acik !== false,
      adlar: san.filter((x) => x.startsWith('DNS:')).map((x) => x.slice(4)),
      ipler: san.filter((x) => x.startsWith('IP Address:')).map((x) => x.slice(11)),
      caBitis: son ? son.ca.validTo : null,
      sunucuBitis: s ? s.validTo : null,
      kisitli: son ? son.meta.izinli : null,
      klasor: dir,
    };
  }

  // Yönetim panelini açık tutanlara ve herkese (öneri şeridi için) son durum.
  function yayinla(ws, sonuc = {}) {
    if (ws) api.sendJson(ws, { t: 'sertifika-durum', ...ayrinti(), ...sonuc });
    api.broadcast({ t: 'sertifika-durum', ...ayrinti() }, (c) => c !== ws && c.session.role === 'admin');
    api.broadcast({ t: 'sertifika-durum', ...genel(null) }, (c) => c.session.role !== 'admin');
  }

  // ---------- Açılış ----------
  if (sertifika.ayarOku(dir).acik !== false) isle(() => ac());

  const zamanlayici = setInterval(() => isle(async () => {
    if (!api.https.port()) return;
    try {
      const r = sertifika.hazirla(dir);
      if (!r.yeniSunucu) return;
      son = r;
      await api.https.ac({ key: r.key, cert: r.cert });
      api.log('Adres değişti ya da süre doluyordu: sunucu sertifikası yenilendi.');
      yayinla(null);
    } catch (e) { api.log('Sertifika yenilenemedi:', e.message); }
  }), YOKLAMA_MS);
  zamanlayici.unref();

  // ---------- Yönetim ----------
  const ISLEM = {
    ac: { acik: true, ok: 'Ev ağı HTTPS açıldı.' },
    yeniden: { acik: true, ok: 'Yeni kök sertifika üretildi. Telefonlara yeni profili yükleyin.' },
    kapat: { acik: false, ok: 'Ev ağı HTTPS kapatıldı.' },
    sil: { acik: false, ok: 'Sertifikalar silindi, ev ağı HTTPS kapatıldı.' },
  };
  api.on('sertifika', (ws, m) => isle(async () => {
    const is = Object.hasOwn(ISLEM, m.op) && ISLEM[m.op];
    if (!is) return;
    api.store.log('admin', { user: ws.session.username, op: `sertifika-${m.op}`, target: '' });
    sertifika.ayarYaz(dir, { acik: is.acik });
    if (is.acik) {
      await ac({ yeniCa: m.op === 'yeniden' });
      yayinla(ws, hata ? { error: hata } : { ok: is.ok });
      return;
    }
    if (m.op === 'sil') { sertifika.sil(dir); son = null; hata = null; }
    kapat(ws, is.ok);
  }), { role: 'admin' });

  api.adminData(async () => ({ sertifika: ayrinti() }));

  // ---------- İndirme ve durum (oturumsuz) ----------
  api.route('GET', '/api/sertifika/', async (req, res, _ws, url) => {
    const ad = url.pathname.slice('/api/sertifika/'.length);
    const json = (obj, ek = {}) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...ek });
      res.end(JSON.stringify(obj));
    };
    if (ad === 'durum') return json(genel(req));
    if (ad === 'yokla') {
      // Yalnızca bu sunucunun kendi HTTP sayfası okuyabilsin (başka siteler "güveniyor mu" bilgisini öğrenemesin).
      const origin = String(req.headers.origin || '');
      let izin = {};
      try {
        const o = new URL(origin);
        const s = son?.sunucu;
        if (o.protocol === 'http:' && Number(o.port || 80) === api.PORT && s && (s.checkHost(o.hostname) || s.checkIP(o.hostname))) {
          izin = { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
        }
      } catch { /* origin yok */ }
      return json({ ok: true }, izin);
    }
    const kayit = son || sertifika.oku(dir);
    if (!kayit) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Ev ağı HTTPS kapalı.'); return; }
    if (ad === 'ca.mobileconfig') {
      // inline: iOS Safari profili doğrudan tanır ("Bu web sitesi bir yapılandırma profili indirmeye çalışıyor").
      res.writeHead(200, {
        'Content-Type': 'application/x-apple-aspen-config', 'Cache-Control': 'no-store',
        'Content-Disposition': 'inline; filename="uzaktan-baglanti-ca.mobileconfig"',
      });
      res.end(sertifika.mobileconfig(kayit.ca, kayit.meta));
      return;
    }
    if (ad === 'ca.cer') {
      res.writeHead(200, {
        'Content-Type': 'application/x-x509-ca-cert', 'Cache-Control': 'no-store',
        'Content-Disposition': 'attachment; filename="uzaktan-baglanti-ca.cer"',
      });
      res.end(kayit.ca.raw);
      return;
    }
    res.writeHead(404).end();
  }, { isPublic: true });
};
