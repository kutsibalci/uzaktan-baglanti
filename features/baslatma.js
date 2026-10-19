// Başlatma ve Windows engelleri: tepsi simgesi olmadan da (Akıllı Uygulama Denetimi Tepsi.exe'yi engelleyebiliyor) rahat çalışmak için.
//   1. Engel uyarıları: lib/helper.js yardımcı exe'lerin (RemoteHelper, Pano, Perde, Ses, Durum) Windows tarafından engellendiğini
//      kaydeder; burada günlüğe, yönetim paneline ve (yöneticiye) ana menüye gider. Kanıt: Code Integrity günlüğünün 3077/3033
//      olayları (yönetici izni gerekmez).
//   2. "Windows açılınca başlat": HKCU\...\Run değeri (yönetici gerekmez). Yöntem: 'arka-plan' (tools\arka-plan.ps1, tepsisiz,
//      yalnızca imzalı powershell.exe) ya da 'tepsi' (helper\Tepsi.exe). Kullanıcı yönetim panelinden kendisi açar.
//   3. Windows bildirimi (tepsinin balonu yokken): biri bağlanınca / yeni cihaz onay beklerken, powershell.exe + WinRT
//      ToastNotification (sessiz). Oran sınırlı.
//   4. Yeni cihaz onayı tarayıcıdan: askHost penceresi (RemoteHelper.exe ask) engellenmişse ya da açılamadıysa bu bilgisayardaki
//      yönetici oturumu isteği ana menüde görür ve cevaplar (lib/helper.js onaylar).
// Mesajlar:
//   sunucu -> yönetici: { t:'baslatma-engel', engeller }  { t:'baslatma-durum', ...adminData }  { t:'baslatma-sonuc', ok?, error? }
//   sunucu -> bu bilgisayardaki yönetici: { t:'onay-istegi', id, baslik, mesaj, bitis, pencere }  { t:'onay-bitti', id, ok, kaynak }
//   istemci -> { t:'baslatma-otomatik', acik, yontem }  (admin)   { t:'baslatma-yenile' } (admin)   { t:'onay-cevap', id, onay } (admin, yalnızca bu bilgisayar)
// Ortam: REMOTE_RUN_ANAHTARI (Run yerine; testler sahte anahtar verir, yalnızca HKCU\...), REMOTE_BILDIRIM_KURU=1 (bildirim gösterilmez,
//   komut kaydedilir; yönetim verisinde bildirimler[].komut). TEST_PORT tanımlıyken (test sunucusu) REMOTE_RUN_ANAHTARI yoksa gerçek Run
//   anahtarına ASLA yazılmaz (kuru) ve bildirimler de kurudur.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { engeller, engelOlay, sacDurumu, ciOlaylari, onaylar, onayOlay } = require('../lib/helper');

const ROOT = path.join(__dirname, '..');
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const RUN_GERCEK = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const DEGER = 'UzaktanBaglanti';
const PS_AUMID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';
const BILDIRIM_ARALIK = 15000;   // aynı türden iki bildirim arası en az
const BILDIRIM_DAKIKA = 5;       // dakikada en fazla
const KISI_ARALIK = 2 * 60000;   // aynı kişi/cihaz için "bağlandı" bildirimi en sık
const VIA_NAMES = { local: 'bu bilgisayar', lan: 'ev ağı', tailscale: 'Tailscale' };

const xmlKac = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
const psTirnak = (s) => `'${String(s).replace(/'/g, "''")}'`;

// Sessiz Windows bildirimi (Windows PowerShell 5.1 + WinRT; uygulama kimliği PowerShell'inki). Metin XML'e kaçışlı, base64 ile gider.
function toastArgs(baslik, metin) {
  const xml = `<toast><visual><binding template="ToastGeneric"><text>${xmlKac(baslik)}</text><text>${xmlKac(metin)}</text></binding></visual><audio silent="true"/></toast>`;
  const ps = "$ErrorActionPreference = 'Stop'; "
    + '[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]; '
    + '[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]; '
    + '$x = New-Object Windows.Data.Xml.Dom.XmlDocument; '
    + `$x.LoadXml([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(xml, 'utf8').toString('base64')}'))); `
    + '$t = New-Object Windows.UI.Notifications.ToastNotification $x; $t.Tag = \'uzaktan-baglanti\'; $t.Group = \'uzaktan-baglanti\'; '
    + `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${psTirnak(PS_AUMID)}).Show($t)`;
  return ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')];
}
module.exports.toastArgs = toastArgs;

function calistir(dosya, args, zaman = 15000) {
  return new Promise((resolve) => {
    execFile(dosya, args, { encoding: 'utf8', windowsHide: true, timeout: zaman }, (err, out, hata) => resolve({ err, out: String(out || ''), hata: String(hata || '') }));
  });
}

module.exports.init = (api) => {
  // features/tepsi.js TRAY_TOKEN'ı kendi init'inde siler; bu dosya alfabetik olarak önce yüklenir (baslatma < tepsi).
  // Arka plan bekçisi de TRAY_TOKEN verir (düzgün kapanış için) ama REMOTE_BASLATICI=arka-plan ile kendini belli eder.
  const baslatici = process.env.REMOTE_BASLATICI === 'arka-plan' ? 'arka-plan' : process.env.TRAY_TOKEN ? 'tepsi' : 'konsol';
  const tepsiVar = baslatici === 'tepsi';
  // Test sunucularında (TEST_PORT) bildirim varsayılan olarak kuru: başka testlerin bağlantıları ekranda bildirim göstermesin.
  const bildirimKuru = process.env.REMOTE_BILDIRIM_KURU === '1' || (!!process.env.TEST_PORT && process.env.REMOTE_BILDIRIM_KURU !== '0');
  const runOrtam = process.env.REMOTE_RUN_ANAHTARI || '';
  const runKuru = !runOrtam && !!process.env.TEST_PORT; // testte gerçek anahtara asla yazılmaz
  const RUN = runOrtam || RUN_GERCEK;
  const runGecerli = /^HKCU\\[^"\r\n]+$/i.test(RUN);

  const yoneticiler = () => [...api.clients].filter((c) => c.session?.role === 'admin');
  const yerelYoneticiler = () => yoneticiler().filter((c) => c.isLocal);

  // ---------- 1. Engel uyarıları ----------
  let ci = null; // { list, hata, zaman } — Code Integrity olayları (önbellek)
  let ciOkunuyor = null;
  function ciYenile() {
    if (ciOkunuyor) return ciOkunuyor;
    ciOkunuyor = ciOlaylari().then((r) => {
      ci = { list: r.list || [], hata: r.hata, zaman: Date.now() };
      // Engel kaydına kanıt: aynı dosya için son 15 dakikadaki olay
      for (const k of engeller.values()) {
        const e = ci.list.find((x) => x.dosya.toLowerCase() === k.dosya.toLowerCase() && Math.abs(x.zaman - k.zaman) < 15 * 60000);
        if (e) k.kanit = e;
      }
      return ci;
    }).finally(() => { ciOkunuyor = null; });
    return ciOkunuyor;
  }

  const engelListesi = () => [...engeller.values()].map(({ exe, ...k }) => ({ ...k, yol: exe }));

  engelOlay.on('engel', (k) => {
    api.log(`ENGEL: ${k.mesaj}`);
    for (const ws of yoneticiler()) api.sendJson(ws, { t: 'baslatma-engel', engeller: engelListesi() });
    // Kanıtı biraz sonra oku (olay günlüğe birkaç yüz ms içinde düşer); yöneticilere tazesini gönder.
    setTimeout(() => {
      ci = null;
      ciYenile().then(async () => { for (const ws of yoneticiler()) api.sendJson(ws, { t: 'baslatma-durum', ...(await durum()) }); }).catch(() => {});
    }, 1500).unref();
  });

  api.onAuth((ws) => {
    if (ws.session?.role !== 'admin') return;
    if (engeller.size) api.sendJson(ws, { t: 'baslatma-engel', engeller: engelListesi() });
    if (ws.isLocal) for (const o of onaylar.values()) api.sendJson(ws, onayMesaji(o));
  });

  // ---------- 2. Windows açılınca başlat (Run değeri) ----------
  const portVarsayilan = api.PORT === 3080;
  const veriVarsayilan = path.resolve(api.dataDir).toLowerCase() === path.join(ROOT, 'data').toLowerCase();

  function komut(yontem) {
    if (yontem === 'tepsi') return `"${path.join(ROOT, 'helper', 'Tepsi.exe')}" --oturum-acilisi`;
    let k = `"${POWERSHELL}" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${path.join(ROOT, 'tools', 'arka-plan.ps1')}" -Islem baslat -Sessiz`;
    if (!portVarsayilan) k += ` -PortNo ${api.PORT}`;
    if (!veriVarsayilan) k += ` -VeriKlasoru "${path.resolve(api.dataDir)}"`;
    return k;
  }

  const regPs = () => `Registry::${RUN.replace(/^HKCU\\/i, 'HKEY_CURRENT_USER\\')}`;
  let kuruDeger = null; // kuru modda "yazılmış" değer (yalnızca bellekte)

  async function runOku() {
    if (runKuru) return kuruDeger;
    if (!runGecerli) return null;
    // reg query çıktısı OEM kod sayfasında (klasör adındaki "ğ" bozulur): PowerShell ile UTF-8 okunur.
    const ps = `[Console]::OutputEncoding = [Text.Encoding]::UTF8; $v = (Get-ItemProperty -LiteralPath ${psTirnak(regPs())} -Name ${psTirnak(DEGER)} -ErrorAction SilentlyContinue).${DEGER}; if ($null -ne $v) { [Console]::Out.Write('=' + $v) }`;
    const r = await calistir(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', ps]);
    return r.out.startsWith('=') ? r.out.slice(1) : null;
  }

  async function runYaz(deger) {
    if (runKuru) { kuruDeger = deger; return; }
    if (!runGecerli) throw new Error('Kayıt anahtarı geçersiz (yalnızca HKCU).');
    const args = deger == null
      ? ['delete', RUN, '/v', DEGER, '/f']
      : ['add', RUN, '/v', DEGER, '/t', 'REG_SZ', '/d', deger, '/f'];
    const r = await calistir('reg.exe', args);
    // Silinecek değer yoksa reg hata verir: zaten kapalı demektir.
    if (r.err && deger != null) throw new Error(`Kayıt defterine yazılamadı: ${(r.hata || r.err.message).trim().split('\n')[0]}`);
  }

  function tepsiKisayolu() {
    const dir = process.env.TEPSI_BASLANGIC_KLASORU || path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
    return fs.existsSync(path.join(dir, 'Uzaktan Bağlantı.lnk'));
  }

  function tepsiExe() {
    const exe = path.join(ROOT, 'helper', 'Tepsi.exe');
    const cs = path.join(ROOT, 'helper', 'Tepsi.cs');
    const st = (f) => { try { return fs.statSync(f); } catch { return null; } };
    const e = st(exe), c = st(cs);
    const engel = ci?.list.find((x) => x.dosya.toLowerCase() === 'tepsi.exe' && x.olay === 3077) || null;
    return { var: !!e, eski: !!(e && c && e.mtimeMs < c.mtimeMs), engel };
  }

  async function otomatik() {
    let deger = null, hata = null;
    try { deger = await runOku(); } catch (e) { hata = e.message; }
    let yontem = null;
    if (deger) yontem = /arka-plan\.ps1/i.test(deger) ? 'arka-plan' : /Tepsi\.exe/i.test(deger) ? 'tepsi' : 'baska';
    const buKopya = !!deger && deger.toLowerCase().includes(ROOT.toLowerCase());
    return {
      acik: !!deger, yontem, deger, buKopya, kuru: runKuru, anahtar: RUN, hata,
      tepsiKisayolu: tepsiKisayolu(), tepsiExe: tepsiExe(), tepsiOlur: portVarsayilan && veriVarsayilan,
    };
  }

  api.on('baslatma-otomatik', async (ws, m) => {
    try {
      const yontem = m.yontem === 'tepsi' ? 'tepsi' : 'arka-plan';
      if (m.acik) {
        if (yontem === 'tepsi') {
          if (!tepsiExe().var) throw new Error('helper\\Tepsi.exe yok. Önce tepsi-baslat.bat ile derleyin ya da "Arka plan (tepsisiz)" seçin.');
          if (!portVarsayilan || !veriVarsayilan) throw new Error('Tepsi yalnızca varsayılan port (3080) ve data klasörüyle başlar; "Arka plan (tepsisiz)" seçin.');
        }
        await runYaz(komut(yontem));
      } else {
        await runYaz(null);
      }
      api.store.log('admin', { user: ws.session.username, op: 'otomatik-baslat', target: m.acik ? yontem : 'kapalı' });
      api.sendJson(ws, { t: 'baslatma-sonuc', ok: m.acik ? `Windows açılınca başlatma açık (${yontem === 'tepsi' ? 'Tepsi' : 'arka plan, tepsisiz'}).` : 'Windows açılınca başlatma kapatıldı.' });
    } catch (e) {
      api.sendJson(ws, { t: 'baslatma-sonuc', error: e.message });
    }
    api.sendJson(ws, { t: 'baslatma-durum', ...(await durum()) });
  }, { role: 'admin' });

  api.on('baslatma-yenile', async (ws) => {
    ci = null;
    await ciYenile().catch(() => {});
    api.sendJson(ws, { t: 'baslatma-durum', ...(await durum()) });
  }, { role: 'admin' });

  // ---------- 3. Windows bildirimi ----------
  const bildirimler = [];       // son 10: { zaman, baslik, metin, tur, kuru, hata? }
  const sonTur = new Map();     // tür -> zaman
  const sonKisi = new Map();    // kişi anahtarı -> zaman
  let dakika = { bas: 0, n: 0 };

  // zorla: tepsi çalışsa da göster (onay penceresi açılamadığında)
  function bildir(tur, baslik, metin, { zorla = false } = {}) {
    if (tepsiVar && !zorla) return false;
    const simdi = Date.now();
    if (simdi - (sonTur.get(tur) || 0) < BILDIRIM_ARALIK) return false;
    if (simdi - dakika.bas > 60000) dakika = { bas: simdi, n: 0 };
    if (dakika.n >= BILDIRIM_DAKIKA) return false;
    dakika.n++;
    sonTur.set(tur, simdi);
    const kayit = { zaman: simdi, tur, baslik, metin, kuru: bildirimKuru };
    bildirimler.unshift(kayit);
    bildirimler.length = Math.min(bildirimler.length, 10);
    if (bildirimKuru) {
      kayit.komut = [POWERSHELL, ...toastArgs(baslik, metin)].join(' ').slice(0, 200) + '…';
      api.log(`bildirim (kuru, gösterilmedi): ${baslik} — ${metin}`);
      return true;
    }
    calistir(POWERSHELL, toastArgs(baslik, metin), 20000).then((r) => {
      if (r.err) { kayit.hata = (r.hata || r.err.message).trim().split('\n')[0].slice(0, 200); api.log('Windows bildirimi gösterilemedi:', kayit.hata); }
    });
    return true;
  }

  api.onAuth((ws) => {
    if (ws.isLocal || process.platform !== 'win32') return;
    const s = ws.session;
    const anahtar = `${s.username}|${ws.ip}|${s.deviceName || ''}`;
    const simdi = Date.now();
    if (simdi - (sonKisi.get(anahtar) || 0) < KISI_ARALIK) return; // kısa kopma sonrası geri dönüş
    sonKisi.set(anahtar, simdi);
    if (sonKisi.size > 200) sonKisi.clear();
    const cihaz = s.deviceName ? ` · ${s.deviceName}` : '';
    bildir('baglandi', 'Uzaktan Bağlantı: biri bağlandı', `${s.guest ? 'Misafir' : s.username}${cihaz} (${VIA_NAMES[ws.via] || ws.via}, ${ws.ip})`);
  });

  // ---------- 4. Yeni cihaz onayı tarayıcıdan ----------
  const onayMesaji = (o) => ({ t: 'onay-istegi', id: o.id, baslik: o.baslik, mesaj: o.mesaj, bitis: o.bitis, pencere: o.pencere });

  onayOlay.on('istek', (o) => {
    for (const ws of yerelYoneticiler()) api.sendJson(ws, onayMesaji(o));
    const ek = o.pencere ? 'Bilgisayardaki pencereden' : 'Onay penceresi açılamadı: bu bilgisayarda tarayıcıda Uzaktan Bağlantı ana menüsünden';
    bildir('onay', 'Uzaktan Bağlantı: yeni cihaz onay bekliyor', `${ek} izin verin ya da reddedin (${Math.round((o.bitis - Date.now()) / 1000)} sn).`, { zorla: !o.pencere });
  });
  onayOlay.on('degisti', (o) => { for (const ws of yerelYoneticiler()) api.sendJson(ws, onayMesaji(o)); });
  onayOlay.on('bitti', (b) => { for (const ws of yerelYoneticiler()) api.sendJson(ws, { t: 'onay-bitti', ...b }); });

  api.on('onay-cevap', async (ws, m) => {
    // Yalnızca bilgisayarın başındaki kişi: Tailscale / ev ağı üzerinden bağlı yönetici cevaplayamaz.
    if (!ws.isLocal) return api.sendJson(ws, { t: 'error', msg: 'Onay yalnızca bu bilgisayardan verilebilir.' });
    const o = onaylar.get(Number(m.id));
    if (!o) return api.sendJson(ws, { t: 'onay-bitti', id: Number(m.id), ok: false, kaynak: 'yok' });
    api.store.log('admin', { user: ws.session.username, op: m.onay === true ? 'onay-izin' : 'onay-red', target: o.mesaj.split('\n')[0].slice(0, 80) });
    o.cevapla(m.onay === true, 'tarayici');
  }, { role: 'admin' });

  // ---------- Yönetim verisi ----------
  async function durum() {
    if (!ci && !ciOkunuyor && engeller.size) ciYenile().catch(() => {});
    return {
      engeller: engelListesi(),
      sac: sacDurumu(),
      ci,
      otomatik: await otomatik(),
      baslatici,
      bildirimKuru,
      bildirimler, // kuru modda gösterilmeyen komut da (kısaltılmış) içinde
      onaylar: [...onaylar.values()].map(onayMesaji),
    };
  }
  api.adminData(async () => ({ baslatma: await durum() }));

  if (baslatici !== 'konsol') api.log(`başlatıcı: ${baslatici === 'tepsi' ? 'tepsi simgesi' : 'arka plan (tepsisiz)'}`);
};
