// Çizim tableti kısayol paneli (public/features/cizim.js) için tuşlar.
// Çekirdeğin 'key' mesajından farkı: basılı tutulan tuşlar (Ctrl/Shift/Alt/Boşluk) sunucuda izlenir; bağlantı koparsa
// ya da izleme biterse sunucu bırakır (istemci 'up' gönderemeyebilir: sekme kapandı, Wi-Fi gitti).
//
//   istemci -> { t: 'cizim-tus', vk, down }   vk: 1..254 (Windows sanal tuş kodu)
const EN_COK = 8; // aynı anda basılı tutulabilecek tuş sayısı

function tusKodu(v) {
  return Number.isInteger(v) && v >= 1 && v <= 254 ? v : 0;
}

module.exports.tusKodu = tusKodu;

module.exports.init = (api) => {
  function birak(ws) {
    if (!ws.cizimTus?.size) return;
    for (const vk of ws.cizimTus) api.helper.send(`key ${vk} 0`);
    ws.cizimTus.clear();
  }

  api.on('cizim-tus', async (ws, m) => {
    const vk = tusKodu(m.vk);
    if (!vk) return;
    if (!ws.cizimTus) ws.cizimTus = new Set();
    if (m.down === true) {
      if (!ws.streaming) return;
      if (!ws.cizimTus.has(vk) && ws.cizimTus.size >= EN_COK) return;
      ws.cizimTus.add(vk);
      api.helper.send(`key ${vk} 1`);
    } else {
      // Yalnızca bu bağlantının bastığı tuş bırakılır (izleme bittikten sonra gelen bırakış da geçerli).
      if (!ws.cizimTus.delete(vk)) return;
      api.helper.send(`key ${vk} 0`);
    }
  }, { role: 'control' });

  api.onClose(birak);

  // İzleme bitince ('stop', ekrandan çıkış) istemci bırakmayı unutursa: saniyede bir denetlenir.
  const t = setInterval(() => {
    for (const ws of api.clients) if (!ws.streaming && ws.cizimTus?.size) birak(ws);
  }, 1000);
  t.unref?.();
};
