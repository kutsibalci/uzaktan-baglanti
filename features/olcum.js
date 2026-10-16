// Gecikme sayacı: tarayıcı her saniye ping atar, sunucu hemen cevaplar (gidiş-dönüş süresi = RTT).
// Mesaj: { t: 'olcum-ping', c: <istemci zamanı> }
// Cevap: { t: 'olcum-pong', c, capMs (JPEG yakalama+sıkıştırma, ms | null), kuyrukKB (gönderilmeyi bekleyen veri), via: 'local' | 'lan' | 'tailscale' }
module.exports.init = (api) => {
  api.on('olcum-ping', async (ws, m) => {
    if (typeof m.c !== 'number') return;
    api.sendJson(ws, {
      t: 'olcum-pong',
      c: m.c,
      capMs: ws.session?.view?.codec === 'jpeg' && typeof ws.capMs === 'number' ? ws.capMs : null,
      kuyrukKB: Math.round((ws.bufferedAmount || 0) / 1024),
      via: ws.via || '',
    });
  });
};
