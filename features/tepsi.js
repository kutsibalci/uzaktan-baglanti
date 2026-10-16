// Görev çubuğu tepsi simgesi (helper/Tepsi.exe) için yerel uçlar.
// Tepsi.exe sunucuyu başlatırken rastgele bir TRAY_TOKEN üretip ortam değişkeniyle verir; bu değişken yoksa
// (ör. baslat.bat ile konsoldan çalışırken) hiçbir uç kaydedilmez.
// Uçlara YALNIZCA bu bilgisayardan (tailscale serve yönlendirmesi değil) ve doğru "X-Tepsi" başlığıyla erişilir:
//   GET  /api/tepsi/durum    misafir kodu, port, bağlı kişiler, Tailscale adresi
//   POST /api/tepsi/kes      {"id": 3} ya da {"hepsi": true} — bağlantıyı keser (hatırlanan cihaz kaydı da silinir)
//   POST /api/tepsi/kapat    sunucuyu düzgün kapatır (tepsideki "Çıkış" / "Yeniden başlat")
//   GET  /api/tepsi/olaylar  Server-Sent Events: baglandi, ayrildi, izleme-basladi, izleme-bitti
const crypto = require('crypto');
const { tailscaleInfo } = require('../lib/network');

const VIA_NAMES = { local: 'bu bilgisayar', lan: 'ev ağı', tailscale: 'Tailscale' };
const MAX_STREAMS = 4;          // aynı anda açık olay akışı
const MAX_BODY = 1024;          // POST gövdesi sınırı (bayt)
const RECONNECT_MS = 4000;      // kısa kopmalarda (resume) ayrıldı/bağlandı bildirimini bastır
const HEARTBEAT_MS = 15000;

module.exports.init = (api) => {
  const token = process.env.TRAY_TOKEN;
  if (!token) return;
  // Sonradan başlatılan alt süreçler (ffmpeg vb.) belirteci devralmasın.
  delete process.env.TRAY_TOKEN;
  if (token.length < 16) { api.log('TRAY_TOKEN çok kısa, tepsi uçları kapalı.'); return; }
  const tokenHash = crypto.createHash('sha256').update(token).digest();

  // Sabit zamanlı karşılaştırma: uzunluk farkı da sızmasın diye özetler karşılaştırılır.
  function tokenOk(req) {
    const given = String(req.headers['x-tepsi'] || '');
    if (!given) return false;
    return crypto.timingSafeEqual(crypto.createHash('sha256').update(given).digest(), tokenHash);
  }

  // true dönerse istek geçerli; değilse cevap yazılmıştır.
  function guard(req, res) {
    if (!api.clientInfo(req).isLocal) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Yalnızca bu bilgisayardan.'); return false; }
    if (!tokenOk(req)) { res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Belirteç geçersiz.'); return false; }
    return true;
  }

  const json = (res, code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  };

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const parts = [];
      req.on('data', (d) => {
        size += d.length;
        if (size > MAX_BODY) { reject(new Error('Gövde çok büyük.')); req.destroy(); return; }
        parts.push(d);
      });
      req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
      req.on('error', reject);
    });
  }

  // ---------- Bağlantı kimlikleri ve izleme durumu ----------

  let nextId = 1;
  const watching = new Map(); // ws -> son bilinen ws.streaming
  const pendingLeave = new Map(); // anahtar -> { timer, kisi }

  const key = (ws) => `${ws.session.username}|${ws.ip}|${ws.session.deviceName || ''}`;

  function kisi(ws) {
    const s = ws.session || {};
    return {
      id: ws.tepsiId,
      kullanici: s.username,
      rol: s.role,
      misafir: !!s.guest,
      cihaz: s.deviceName || '',
      ip: ws.ip,
      via: ws.via,
      viaAd: VIA_NAMES[ws.via] || ws.via,
      izliyor: !!ws.streaming,
    };
  }

  const kisiler = () => [...api.clients].filter((c) => c.tepsiId).map(kisi);
  const izleyenSayisi = () => [...api.clients].filter((c) => c.tepsiId && c.streaming).length;

  // ---------- Olay akışı (SSE) ----------

  const streams = new Set();
  function publish(tur, extra = {}) {
    const line = `data: ${JSON.stringify({ tur, izleyen: izleyenSayisi(), zaman: Date.now(), ...extra })}\n\n`;
    for (const res of streams) res.write(line);
  }

  api.onAuth((ws) => {
    ws.tepsiId = nextId++;
    watching.set(ws, false);
    const k = key(ws);
    const p = pendingLeave.get(k);
    if (p) {
      // Kısa kopma sonrası geri döndü: bildirim gösterme, yalnızca listeyi tazele.
      clearTimeout(p.timer);
      pendingLeave.delete(k);
      publish('yenilendi', { kisi: kisi(ws) });
      return;
    }
    publish('baglandi', { kisi: kisi(ws) });
  });

  api.onClose((ws) => {
    if (!ws.tepsiId) return;
    const k = kisi(ws);
    const wasWatching = watching.get(ws);
    watching.delete(ws);
    k.izliyor = false;
    if (wasWatching) publish('izleme-bitti', { kisi: k });
    // Kendi isteğiyle çıkan / atılan hemen bildirilir; kopanlar biraz beklenir (resume).
    if (ws.loggedOut) { publish('ayrildi', { kisi: k }); return; }
    const pk = key(ws);
    const old = pendingLeave.get(pk);
    if (old) clearTimeout(old.timer);
    const timer = setTimeout(() => { pendingLeave.delete(pk); publish('ayrildi', { kisi: k }); }, RECONNECT_MS);
    timer.unref?.();
    pendingLeave.set(pk, { timer, kisi: k });
  });

  // Görüntü başlatma/durdurma çekirdekte olduğundan durum saniyede bir yoklanır (ucuz: yalnızca bayrak okuma).
  setInterval(() => {
    for (const [ws, was] of watching) {
      const now = !!ws.streaming;
      if (now === was) continue;
      watching.set(ws, now);
      publish(now ? 'izleme-basladi' : 'izleme-bitti', { kisi: kisi(ws) });
    }
  }, 1000).unref();

  setInterval(() => { for (const res of streams) res.write(': canli\n\n'); }, HEARTBEAT_MS).unref();

  // ---------- Tailscale bilgisi (önbellekli: her çağrı bir süreç başlatır) ----------

  let tsCache = { at: 0, value: null };
  async function tailscale() {
    if (Date.now() - tsCache.at < 30000) return tsCache.value;
    const t = await tailscaleInfo().catch(() => null);
    tsCache = {
      at: Date.now(),
      value: t && t.running ? { ip: t.ip, dns: t.dns, httpsUrl: t.httpsUrl } : null,
    };
    return tsCache.value;
  }

  // ---------- Uçlar ----------

  api.route('GET', '/api/tepsi/durum', async (req, res, ws, url) => {
    if (url.pathname !== '/api/tepsi/durum' || !guard(req, res)) { if (!res.headersSent) res.writeHead(404).end(); return; }
    json(res, 200, {
      misafirKodu: api.guestCode(),
      port: api.PORT,
      kisiler: kisiler(),
      izleyen: izleyenSayisi(),
      tailscale: await tailscale(),
    });
  }, { isPublic: true });

  api.route('POST', '/api/tepsi/kes', async (req, res, ws, url) => {
    if (url.pathname !== '/api/tepsi/kes' || !guard(req, res)) { if (!res.headersSent) res.writeHead(404).end(); return; }
    let body;
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { return json(res, 400, { ok: false, hata: 'Geçersiz istek.' }); }
    let pred;
    if (body && body.hepsi === true) pred = (c) => !!c.tepsiId;
    else if (body && Number.isInteger(body.id) && body.id > 0) pred = (c) => c.tepsiId === body.id;
    else return json(res, 400, { ok: false, hata: 'id ya da hepsi gerekli.' });
    const targets = [...api.clients].filter(pred);
    // "Beni hatırla" ile girmiş cihazlar 4002'den sonra kayıtlı anahtarla onaysız geri girerdi; bilgisayarın
    // başındaki kişinin kesme kararı kalıcı olsun diye bu cihazların kaydı silinir (tekrar girmek için şifre gerekir).
    for (const c of targets) {
      if (c.session?.deviceId) { try { api.store.removeDevice(c.session.deviceId); } catch {} }
    }
    api.kick(pred, 'tepsiden kesildi');
    if (targets.length) {
      api.store.log('admin', { user: '(bilgisayar)', op: 'tepsi-kes', target: targets.map((c) => c.session.username).join(', ') });
    }
    json(res, 200, { ok: true, kesilen: targets.length });
  }, { isPublic: true });

  api.route('POST', '/api/tepsi/kapat', async (req, res, ws, url) => {
    if (url.pathname !== '/api/tepsi/kapat' || !guard(req, res)) { if (!res.headersSent) res.writeHead(404).end(); return; }
    json(res, 200, { ok: true });
    api.log('Tepsiden kapatma isteği, sunucu kapanıyor...');
    // Bağlantıları düzgün kapat (sanal ekran kaldırılsın, istemciler "oturum kapandı" görsün).
    api.kick(() => true, 'sunucu kapandı');
    for (const s of streams) s.end();
    setTimeout(() => process.exit(0), 800);
  }, { isPublic: true });

  api.route('GET', '/api/tepsi/olaylar', async (req, res, ws, url) => {
    if (url.pathname !== '/api/tepsi/olaylar' || !guard(req, res)) { if (!res.headersSent) res.writeHead(404).end(); return; }
    if (streams.size >= MAX_STREAMS) { res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Çok fazla akış.'); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    res.write(`data: ${JSON.stringify({ tur: 'merhaba', izleyen: izleyenSayisi(), zaman: Date.now() })}\n\n`);
    streams.add(res);
    req.socket.setTimeout(0);
    const done = () => streams.delete(res);
    req.on('close', done);
    res.on('close', done);
  }, { isPublic: true });

  api.log('Tepsi uçları açık (yalnızca bu bilgisayar + belirteç).');
};
