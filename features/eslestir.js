// QR kodla telefon eşleştirme.
// Bilgisayarda (YALNIZCA bu bilgisayardan açılmış yönetici oturumu: ws.isLocal — tailscale serve yönlendirmesi sayılmaz)
// "Telefonu bağla (QR)" -> adres + tek kullanımlık belirteç içeren QR kod. Telefon QR'ı okuyup adresi açınca sayfa
// belirteci WebSocket ile (girişten önce) gönderir; bilgisayardaki QR ekranında "Onayla / Reddet" çıkar. Onaylanınca
// telefon QR'ı oluşturan yöneticinin hesabıyla girer ve cihaz hatırlanır (çekirdeğin cihaz anahtarı).
// Belirteç URL'nin parça (#) kısmındadır: sunucu günlüklerine, tailscale serve'e ve Referer'a düşmez.
//
// Mesajlar (yönetici, bu bilgisayar):
//   { t: 'eslestir-olustur' }            -> { t: 'eslestir-qr', url, adres, adresTuru, svg, sureMs, kullanici, rol } | { t: 'eslestir-hata', hata }
//   { t: 'eslestir-kapat' }              QR ekranı kapandı: belirteç geçersiz, bekleyen istek reddedilir
//   { t: 'eslestir-cevap', onay: bool }  bekleyen isteğe cevap
//   sunucudan: { t: 'eslestir-istek', cihaz, ip, via, sureMs }, { t: 'eslestir-sonuc', ok, cihaz, neden? }, { t: 'eslestir-izin' } (girişte)
// Girişten önce (telefon): { t: 'eslestir', belirtec, deviceName } -> { t: 'pending', eslestir: true } ... { t: 'auth', ... }
// Ortam değişkenleri (yalnızca testler için): REMOTE_ESLESTIR_SURE_MS (belirteç ömrü), REMOTE_ESLESTIR_ONAY_MS (onay süresi).
const crypto = require('crypto');
const os = require('os');
const qr = require('../lib/qr');
const { tailscaleInfo } = require('../lib/network');

const SURE_MS = Number(process.env.REMOTE_ESLESTIR_SURE_MS) || 2 * 60 * 1000;
const ONAY_MS = Number(process.env.REMOTE_ESLESTIR_ONAY_MS) || 60 * 1000;
const VIA_NAMES = { local: 'bu bilgisayar', lan: 'ev ağı', tailscale: 'Tailscale' };
const ROL_ADLARI = { admin: 'Yönetici', control: 'Kontrol', view: 'Salt izleme' };
const BELIRTEC = /^[A-Za-z0-9_-]{43}$/; // 32 rastgele bayt, base64url

const ozet = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Ev ağı adresi. Sanal bağdaştırıcılar (VirtualBox host-only 192.168.56.x, Hyper-V/WSL vEthernet, VMware, Docker)
// telefondan erişilemez: MAC önekinden ve adından tanınıp en sona atılır. Wi-Fi > Ethernet; 192.168.x > 10.x > 172.16-31.x.
// Tailscale (100.64/10) ve otomatik (169.254) adresler alınmaz. (Ağa paket gönderilmez, yalnızca bağdaştırıcılar okunur.)
const SANAL_MAC = /^(0a:00:27|08:00:27|00:15:5d|00:50:56|00:0c:29|00:05:69|00:1c:14|00:1c:42|02:42)/i;
const SANAL_AD = /virtual|vbox|vmware|hyper-v|vethernet|wsl|docker|loopback|tailscale|bluetooth/i;
function evAdresi() {
  const adaylar = [];
  for (const [ad, liste] of Object.entries(os.networkInterfaces())) {
    for (const a of liste || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const [x, y] = a.address.split('.').map(Number);
      let puan = x === 192 && y === 168 ? 3 : x === 10 ? 2 : x === 172 && y >= 16 && y <= 31 ? 1 : 0;
      if (!puan) continue;
      if (SANAL_MAC.test(a.mac || '') || SANAL_AD.test(ad)) puan -= 100;
      else if (/wi-?fi|wlan|kablosuz|wireless/i.test(ad)) puan += 20;
      else if (/ethernet/i.test(ad)) puan += 10;
      adaylar.push({ ip: a.address, puan });
    }
  }
  adaylar.sort((p, q) => q.puan - p.puan);
  return adaylar[0]?.ip || null;
}

module.exports.init = (api) => {
  const kodlar = new Map(); // özet(belirteç) -> { olusturan: ws, bitis, kullanici }

  // Tailscale bilgisi önbellekli (her çağrı bir süreç başlatır).
  let tsOnbellek = { at: 0, deger: null };
  async function tailscaleHttps() {
    if (Date.now() - tsOnbellek.at > 30000) {
      const t = await tailscaleInfo().catch(() => null);
      tsOnbellek = { at: Date.now(), deger: t && t.running ? t.httpsUrl : null };
    }
    return tsOnbellek.deger;
  }

  function kodlariSil(ws) {
    for (const [k, v] of kodlar) if (v.olusturan === ws) kodlar.delete(k);
  }
  function temizle() {
    const now = Date.now();
    for (const [k, v] of kodlar) if (v.bitis < now) kodlar.delete(k);
  }

  api.onAuth((ws) => {
    if (ws.isLocal && ws.session.role === 'admin' && !ws.session.guest) api.sendJson(ws, { t: 'eslestir-izin' });
  });
  api.onClose((ws) => {
    kodlariSil(ws);
    ws.eslestirIstek?.bitti(false);
  });

  api.on('eslestir-olustur', async (ws) => {
    if (!ws.isLocal || ws.session.guest) {
      return api.sendJson(ws, { t: 'eslestir-hata', hata: 'QR kod yalnızca bu bilgisayarın kendisinden (localhost) oluşturulabilir.' });
    }
    temizle();
    kodlariSil(ws); // her QR ekranında tek geçerli kod
    const https = await tailscaleHttps();
    const ev = https ? null : evAdresi();
    const adres = https || (ev && `http://${ev}:${api.PORT}`);
    if (!adres) return api.sendJson(ws, { t: 'eslestir-hata', hata: 'Bilgisayarın ağ adresi bulunamadı (Wi-Fi / Ethernet bağlı mı?).' });
    if (ws.readyState !== 1) return;
    const belirtec = crypto.randomBytes(32).toString('base64url');
    kodlar.set(ozet(belirtec), { olusturan: ws, bitis: Date.now() + SURE_MS, kullanici: ws.session.username });
    const url = `${adres}/#e=${belirtec}`;
    api.sendJson(ws, {
      t: 'eslestir-qr', url, adres, adresTuru: https ? 'tailscale' : 'ev', svg: qr.svg(url), sureMs: SURE_MS,
      kullanici: ws.session.username, rol: ROL_ADLARI[ws.session.role] || ws.session.role,
    });
  }, { role: 'admin' });

  api.on('eslestir-kapat', async (ws) => {
    kodlariSil(ws);
    ws.eslestirIstek?.bitti(false);
  }, { role: 'admin' });

  api.on('eslestir-cevap', async (ws, m) => {
    ws.eslestirIstek?.bitti(m.onay === true);
  }, { role: 'admin' });

  // Telefon: giriş yapmadan önce belirteci gönderir. Kaba kuvvet kilidi (5 hatalı deneme) çekirdekte denetlenir.
  api.onPreAuth('eslestir', async (ws, m) => {
    const belirtec = typeof m.belirtec === 'string' && BELIRTEC.test(m.belirtec) ? m.belirtec : '';
    const anahtar = belirtec && ozet(belirtec);
    const k = anahtar && kodlar.get(anahtar);
    if (k) kodlar.delete(anahtar); // tek kullanımlık: ilk denemede silinir (sonuç ne olursa olsun)
    if (!k || k.bitis < Date.now() || k.olusturan.readyState !== 1) {
      return api.auth.fail(ws, 'QR kodun süresi dolmuş ya da kullanılmış. Bilgisayarda yeni QR kod açıp tekrar okutun.', true, { user: '(QR eşleştirme)' });
    }
    const olusturan = k.olusturan;
    if (olusturan.eslestirIstek) return api.auth.fail(ws, 'Bilgisayarda başka bir bağlantı isteği bekliyor, biraz sonra tekrar deneyin.', false);
    const cihaz = String(m.deviceName || 'Bilinmeyen cihaz').slice(0, 60);

    api.sendJson(ws, { t: 'pending', eslestir: true });
    api.sendJson(olusturan, { t: 'eslestir-istek', cihaz, ip: ws.ip, via: VIA_NAMES[ws.via] || ws.via, sureMs: ONAY_MS });
    api.log(`Onay bekleniyor: ${cihaz} (${ws.ip}) -> ${k.kullanici}`);
    const onay = await new Promise((resolve) => {
      const bitti = (v) => {
        clearTimeout(timer);
        ws.off('close', kapandi);
        olusturan.eslestirIstek = null;
        resolve(v);
      };
      const kapandi = () => bitti(false);
      const timer = setTimeout(() => bitti(false), ONAY_MS);
      ws.on('close', kapandi);
      olusturan.eslestirIstek = { bitti };
    });

    if (ws.readyState !== 1) {
      api.sendJson(olusturan, { t: 'eslestir-sonuc', ok: false, cihaz, neden: 'Telefon bağlantıyı kapattı.' });
      return;
    }
    const user = api.store.findUser(k.kullanici);
    if (!onay || !user) {
      api.store.log('rejected', { user: k.kullanici, ip: ws.ip, device: `${cihaz} (QR)` });
      api.sendJson(olusturan, { t: 'eslestir-sonuc', ok: false, cihaz, neden: 'Reddedildi ya da süre doldu.' });
      return api.auth.fail(ws, 'Bağlantı isteği bilgisayarda reddedildi ya da süre doldu.', false);
    }
    api.auth.forgive(ws.ip);
    const { device, token } = api.store.addDevice(user.username, cihaz, ws.ip);
    api.store.log('admin', { user: user.username, op: 'qr-eslestir', target: cihaz });
    await api.auth.finish(ws, { username: user.username, role: user.role, deviceId: device.id, token, deviceName: cihaz });
    api.sendJson(olusturan, { t: 'eslestir-sonuc', ok: true, cihaz, kullanici: user.username });
  });
};
