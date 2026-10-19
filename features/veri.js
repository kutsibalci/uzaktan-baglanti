// Veri kullanımı sayacı ve "Veri tasarrufu" (sunucu tarafı).
// WebSocket baytlarını tarayıcı kendisi sayar (RC.traffic); HTTP adreslerinin (dosya indirme/yükleme, pano resmi) baytlarını
// sunucu sayar (lib/extensions.js → ws.httpBayt, 'http-bayt' olayı), çünkü tarayıcı <a download> indirmelerini göremez.
// Mesajlar:
//   sunucu → istemci { t: 'veri-http', alinan, gonderilen }  — bu bağlantının HTTP toplamı (bayt, sunucunun gözünden:
//                                                              alinan = istemcinin yüklediği, gonderilen = istemcinin indirdiği)
//   istemci → sunucu { t: 'veri-tasarruf', acik: bool }       — Veri tasarrufu seçili mi; 'veri-tasarruf' olayıyla ses
//                                                              özelliğine iletilir (dinleyenlerin hepsi tasarruftaysa düşük bit hızı)
const olaylar = require('../lib/olaylar');

module.exports.init = (api) => {
  // Aynı bağlantıdan arka arkaya biten istekler tek mesajla bildirilir.
  const bekleyen = new Set();
  let zamanlayici = null;
  olaylar.on('http-bayt', (ws) => {
    bekleyen.add(ws);
    if (!zamanlayici) {
      zamanlayici = setTimeout(() => {
        zamanlayici = null;
        for (const c of bekleyen) {
          if (c.readyState === 1 && c.httpBayt) api.sendJson(c, { t: 'veri-http', ...c.httpBayt });
        }
        bekleyen.clear();
      }, 300);
    }
  });

  api.on('veri-tasarruf', async (ws, m) => {
    const acik = m.acik === true;
    if (!!ws.veriTasarruf === acik) return;
    ws.veriTasarruf = acik;
    olaylar.emit('veri-tasarruf', ws);
  });

  api.onClose((ws) => bekleyen.delete(ws));
};
