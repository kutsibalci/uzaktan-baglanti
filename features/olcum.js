// Gecikme sayacı: tarayıcı her saniye ping atar, sunucu hemen cevaplar (gidiş-dönüş süresi = RTT).
// Mesaj: { t: 'olcum-ping', c: <istemci zamanı> }
// Cevap: { t: 'olcum-pong', c, capMs (JPEG yakalama+sıkıştırma, ms | null), kuyrukKB (gönderilmeyi bekleyen veri), via: 'local' | 'lan' | 'tailscale',
//          ackMs (JPEG: kare gönderiminden onayına kadar, yumuşatılmış ms | null), kalite (JPEG: { quality, maxWidth, auto } | null) }
module.exports.init = (api) => {
  api.on('olcum-ping', async (ws, m) => {
    if (typeof m.c !== 'number') return;
    const jpeg = ws.session?.view?.codec === 'jpeg';
    api.sendJson(ws, {
      t: 'olcum-pong',
      c: m.c,
      capMs: jpeg && typeof ws.capMs === 'number' ? ws.capMs : null,
      ackMs: jpeg && typeof ws.ackMs === 'number' ? Math.round(ws.ackMs) : null,
      kalite: jpeg && ws.jpegQuality ? ws.jpegQuality : null,
      kuyrukKB: Math.round((ws.bufferedAmount || 0) / 1024),
      via: ws.via || '',
    });
  });
};
