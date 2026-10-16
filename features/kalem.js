// Tablet kalemi: basınç, eğim ve silgi bilgisiyle kalem girdisi (RemoteHelper "pen" komutu,
// Windows'un sentetik işaretçi API'si). Tarayıcı tarafı: public/features/kalem.js
//
//   istemci -> { t: 'kalem', x, y, p, durum, tx, ty, silgi }   x,y: 0..1, p: 0..1024, tx/ty: -90..90
//   istemci -> { t: 'kalem-destek' }  -> { t: 'kalem-destek', ok, hata? }   (bu bilgisayar sentetik kalemi destekliyor mu)
const SCREEN_NAME = /^\\\\\.\\DISPLAY\d+$/;
const DURUMLAR = new Set(['hover', 'down', 'move', 'up', 'out']);
const HIZ_SINIRI = 120; // saniyede en fazla bu kadar hover/move olayı (down/up/out asla atılmaz)

const sayi = (v) => typeof v === 'number' && Number.isFinite(v);
const kistir = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Mesajı yardımcı sürece gidecek komuta çevirir; geçersizse null.
// Komuta yalnızca doğrulanmış sayılar ve düzenli ifadeyle denetlenmiş ekran adı girer (satır/boşluk enjeksiyonu yok).
function komutOlustur(ekran, m) {
  if (typeof ekran !== 'string' || !SCREEN_NAME.test(ekran)) return null;
  if (!m || typeof m.durum !== 'string' || !DURUMLAR.has(m.durum)) return null;
  if (!sayi(m.x) || !sayi(m.y)) return null;
  const p = sayi(m.p) ? Math.round(kistir(m.p, 0, 1024)) : 0;
  const tx = sayi(m.tx) ? Math.round(kistir(m.tx, -90, 90)) : 0;
  const ty = sayi(m.ty) ? Math.round(kistir(m.ty, -90, 90)) : 0;
  const silgi = m.silgi === true || m.silgi === 1 ? 1 : 0;
  return `pen ${ekran} ${kistir(m.x, 0, 1).toFixed(5)} ${kistir(m.y, 0, 1).toFixed(5)} ${p} ${m.durum} ${tx} ${ty} ${silgi}`;
}

module.exports.komutOlustur = komutOlustur;

module.exports.init = (api) => {
  let destek = null; // { ok, hata } — bir kez öğrenilince saklanır

  api.on('kalem', async (ws, m) => {
    if (!ws.streaming) return;
    const ekran = ws.session.view.screen;
    const cmd = komutOlustur(ekran, m);
    if (!cmd) return;
    // Hız sınırı: yalnızca hover/move olayları atılır, temas değişimleri her zaman geçer.
    const now = Date.now();
    if (!ws.kalemPencere || now - ws.kalemPencere >= 1000) { ws.kalemPencere = now; ws.kalemSayac = 0; }
    if ((m.durum === 'hover' || m.durum === 'move') && ++ws.kalemSayac > HIZ_SINIRI) return;
    if (m.durum === 'down' || m.durum === 'move') ws.kalemTemas = { ekran, x: m.x, y: m.y };
    else ws.kalemTemas = null;
    api.helper.send(cmd);
  }, { role: 'control' });

  api.on('kalem-destek', async (ws) => {
    if (!destek?.ok) {
      try {
        const r = JSON.parse((await api.helper.request('pentest')).toString());
        destek = { ok: !!r.ok, hata: r.ok ? undefined : r.hata };
      } catch (e) {
        destek = null;
        api.sendJson(ws, { t: 'kalem-destek', ok: false, hata: 'Yardımcı program cevap vermedi.' });
        return;
      }
    }
    api.sendJson(ws, { t: 'kalem-destek', ...destek });
  }, { role: 'control' });

  // Kalem ekrana değerken bağlantı koparsa uç basılı kalmasın.
  api.onClose((ws) => {
    const t = ws.kalemTemas;
    ws.kalemTemas = null;
    if (t) {
      const cmd = komutOlustur(t.ekran, { durum: 'out', x: t.x, y: t.y });
      if (cmd) api.helper.send(cmd);
    }
  });
};
