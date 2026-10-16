// Güç menüsü: bilgisayarı kilitle / uyut / yeniden başlat / kapat (yalnızca yönetici).
// Mesaj: { t: 'guc', islem: 'kilitle' | 'uyku' | 'yeniden' | 'kapat' | 'iptal' }
// Cevap (isteyene): { t: 'guc-sonuc', ok, islem, komut, kuru, hata? }
// Duyuru (herkese): { t: 'guc-duyuru', islem, kullanici, metin, kuru, zaman, iptalSn? }
// REMOTE_GUC_KURU=1 ise komut ÇALIŞTIRILMAZ, yalnızca ne çalıştırılacağı bildirilir (testler bunu kullanır).
const path = require('path');
const { execFile } = require('child_process');

const SYS32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const RUNDLL = path.join(SYS32, 'rundll32.exe');
const SHUTDOWN = path.join(SYS32, 'shutdown.exe');
const GECIKME = 30; // yeniden başlat / kapat için saniye (bu sürede iptal edilebilir)
const ISLEMLER = new Set(['kilitle', 'uyku', 'yeniden', 'kapat', 'iptal']);
const ADLAR = { kilitle: 'kilitledi', uyku: 'uyku moduna aldı', yeniden: 'yeniden başlatıyor', kapat: 'kapatıyor', iptal: 'kapanmayı iptal etti' };

// shutdown /c açıklamasına giden metin: yalnızca harf, rakam, boşluk ve . _ - (tırnak/satır sonu giremez).
const temizAd = (s) => String(s || '').replace(/[^\p{L}\p{N}._ -]/gu, '').trim().slice(0, 32) || 'bilinmeyen';

function komut(islem, kullanici) {
  switch (islem) {
    case 'kilitle': return [RUNDLL, ['user32.dll,LockWorkStation']];
    // Not: hazırda bekletme açıksa SetSuspendState uyku yerine hazırda bekletmeye geçebilir.
    case 'uyku': return [RUNDLL, ['powrprof.dll,SetSuspendState', '0,1,0']];
    case 'yeniden': return [SHUTDOWN, ['/r', '/t', String(GECIKME), '/c', `Uzaktan Bağlantı: ${kullanici} tarafından yeniden başlatılıyor`]];
    case 'kapat': return [SHUTDOWN, ['/s', '/t', String(GECIKME), '/c', `Uzaktan Bağlantı: ${kullanici} tarafından kapatılıyor`]];
    case 'iptal': return [SHUTDOWN, ['/a']];
  }
  return null;
}

const goster = ([exe, args]) => [path.basename(exe), ...args.map((a) => (/\s/.test(a) ? `"${a}"` : a))].join(' ');

module.exports.init = (api) => {
  let son = { islem: '', zaman: 0 };

  api.on('guc', async (ws, m) => {
    const islem = String(m.islem || '');
    if (!ISLEMLER.has(islem)) return api.sendJson(ws, { t: 'guc-sonuc', ok: false, islem, hata: 'Geçersiz işlem.' });
    // Yanlışlıkla çift tıklamaya karşı: aynı işlem 3 sn içinde tekrarlanmaz (iptal hariç).
    if (islem !== 'iptal' && son.islem === islem && Date.now() - son.zaman < 3000) {
      return api.sendJson(ws, { t: 'guc-sonuc', ok: false, islem, hata: 'Biraz bekleyip tekrar deneyin.' });
    }
    son = { islem, zaman: Date.now() };

    const kullanici = temizAd(ws.session.username);
    const cmd = komut(islem, kullanici);
    const kuru = process.env.REMOTE_GUC_KURU === '1';
    const metin = goster(cmd);

    let hata = null;
    if (!kuru) {
      hata = await new Promise((resolve) => {
        execFile(cmd[0], cmd[1], { windowsHide: true, timeout: 10000 }, (err) => {
          if (!err) return resolve(null);
          // shutdown /a, bekleyen kapanma yoksa 1116 ile döner.
          resolve(islem === 'iptal' && err.code === 1116 ? 'İptal edilecek bir kapanma yok.' : `Komut başarısız: ${err.message.split('\n')[0]}`);
        });
      });
    }

    api.store.log('guc', { user: ws.session.username, ip: ws.ip, op: islem, target: kuru ? 'deneme (çalıştırılmadı)' : hata ? 'hata' : '' });
    api.log(`${ws.session.username} → ${islem}${kuru ? ' (kuru mod)' : ''}${hata ? ` — ${hata}` : ''}`);
    api.sendJson(ws, { t: 'guc-sonuc', ok: !hata, islem, komut: metin, kuru, hata: hata || undefined });
    if (hata) return;
    api.broadcast({
      t: 'guc-duyuru', islem, kullanici: ws.session.username, kuru, zaman: Date.now(),
      metin: `${ws.session.username} bilgisayarı ${ADLAR[islem]}`,
      iptalSn: islem === 'yeniden' || islem === 'kapat' ? GECIKME : undefined, // istemci saatinden bağımsız geri sayım
    });
  }, { role: 'admin' });
};
