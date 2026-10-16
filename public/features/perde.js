// Gizlilik perdesi düğmesi (araç çubuğu). Yalnızca kontrol modunda ve kontrol yetkisinde görünür.
// Perde açıkken bilgisayarın kendi ekranı kararır; uzaktan görüntü etkilenmez.
(() => {
  const RC = window.RC;
  if (!RC) return;

  const btn = document.createElement('button');
  btn.id = 'perdeBtn';
  btn.className = 'ctl';
  btn.title = 'Gizlilik perdesi (bilgisayarın ekranını karart)';
  btn.textContent = '🕶';
  btn.hidden = true;
  RC.ui.toolbar(btn);

  // Perde açıkken düğmeyi vurgulamak için küçük bir stil.
  const style = document.createElement('style');
  style.textContent = '#perdeBtn.acik { background: var(--accent) !important; border-color: var(--accent) !important; }';
  document.head.appendChild(style);

  let acik = false;

  function gorunur() {
    const s = RC.state();
    // Kontrol modunda, kontrol yetkisinde ve izleme sürerken.
    return !!(s.stream && s.stream.started && s.stream.mode === 'control' && s.me && s.me.role !== 'view');
  }

  function guncelle() {
    btn.hidden = !gorunur();
    btn.classList.toggle('acik', acik);
  }

  btn.addEventListener('click', () => {
    if (!gorunur()) return;
    RC.send({ t: 'perde', acik: !acik });
  });

  RC.on('perde-durum', (m) => {
    acik = !!m.acik;
    guncelle();
    if (m.hata) RC.overlay('Perde: ' + m.hata);
    else if (m.neden === 'tus') RC.overlay('Perde bilgisayardan kapatıldı.');
    if (m.hata || m.neden) setTimeout(() => RC.overlay(''), 3500);
  });

  RC.on('viewer:start', () => { guncelle(); if (gorunur()) RC.send({ t: 'perde-sorgu' }); });
  RC.on('viewer:stop', () => { acik = false; guncelle(); });
  RC.on('auth', guncelle);
  RC.on('disconnect', () => { acik = false; guncelle(); });

  guncelle();
})();
