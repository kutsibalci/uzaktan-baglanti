// İlk bağlantıda kısa tanıtım (public/features/tanitim.js). Sunucu yalnızca açık olup olmadığını bildirir:
// REMOTE_TANITIM=0 ile kapalı (test/calistir.js varsayılanı: tanıtım katmanı tarayıcı testlerinde dokunuşları örtmesin).
module.exports.init = (api) => {
  api.onAuth((ws) => api.sendJson(ws, { t: 'tanitim', acik: process.env.REMOTE_TANITIM !== '0' }));
};
