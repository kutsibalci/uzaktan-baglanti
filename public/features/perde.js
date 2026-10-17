// Gizlilik perdesi: ⋯ menüsünde "Gizlilik perdesi: kapalı/açık" (geniş ekranda çubukta 🕶). Yalnızca kontrol modunda ve kontrol yetkisinde görünür.
// Perde açıkken bilgisayarın kendi ekranı kararır; uzaktan görüntü etkilenmez.
(() => {
  const RC = window.RC;
  if (!RC) return;

  const item = RC.ui.menuItem({
    id: 'perdeBtn', icon: '🕶', label: 'Gizlilik perdesi', state: 'kapalı', order: 40, pin: true, ctl: true, extend: false, keepOpen: true,
    title: 'Gizlilik perdesi (bilgisayarın ekranını karart)', hidden: true,
    onClick() {
      if (!gorunur()) return;
      RC.send({ t: 'perde', acik: !acik });
    },
  });

  let acik = false;

  function gorunur() {
    const s = RC.state();
    // Kontrol modunda, kontrol yetkisinde ve izleme sürerken.
    return !!(s.stream && s.stream.started && s.stream.mode === 'control' && s.me && s.me.role !== 'view');
  }

  function guncelle() {
    item.set({ hidden: !gorunur(), active: acik, state: acik ? 'açık (ekran karartıldı)' : 'kapalı' });
  }

  RC.on('perde-durum', (m) => {
    acik = !!m.acik;
    guncelle();
    if (m.hata) RC.overlay('Perde: ' + m.hata);
    else if (m.neden === 'tus') RC.overlay('Perde bilgisayardan kapatıldı.');
    if (m.hata || m.neden) setTimeout(() => RC.overlay(''), 3500);
  });

  RC.on('viewer:start', () => { guncelle(); if (gorunur()) RC.send({ t: 'perde-sorgu' }); });
  // İzleme bitince perdeyi bırak (sunucu da saniyede bir yoklayıp izlemeyen bağlantının perdesini kaldırır).
  RC.on('viewer:stop', () => { if (acik) RC.send({ t: 'perde', acik: false }); acik = false; guncelle(); });
  RC.on('auth', guncelle);
  RC.on('disconnect', () => { acik = false; guncelle(); });

  guncelle();
})();
