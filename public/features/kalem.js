// Tablet kalemi: basınç, eğim ve silgi bilgisiyle kalem olaylarını bilgisayara iletir.
// Yalnızca pointerType === 'pen' olan olaylar işlenir; parmak/fare çekirdek koduna bırakılır.
// Çekirdek fare/dokunmatik kodunun kalem olaylarını yok sayması başka bir yerde ayarlanıyor; burada
// ikili işlemeyi önlemek için kalem olaylarında stopPropagation + preventDefault kullanıyoruz.
(() => {
  const RC = window.RC;
  if (!RC) return;
  const stage = RC.ui.stage();

  let bekleyen = null;   // rAF ile birleştirilecek son hover/move olayı
  let planli = false;
  let temas = false;     // kalem ekrana değiyor mu

  function destekli() {
    const s = RC.state();
    return !!(s.stream && s.stream.started && s.stream.mode === 'control' && s.me && s.me.role !== 'view');
  }

  // e.pressure 0..1 -> 0..1024. Temas varken 0 gelirse en az 1 gönder (çizgi kopmasın).
  function basinc(e, durum) {
    if (durum !== 'down' && durum !== 'move') return 0;
    let p = Math.round((e.pressure || 0) * 1024);
    if (p <= 0) p = e.pressure === 0 ? 256 : 1; // bazı kalemler basıncı bildirmez
    return Math.min(1024, p);
  }

  function silgiMi(e) {
    // Silgi ucu: buttons bit 5 (32) ya da button === 5.
    return (e.buttons & 32) !== 0 || e.button === 5;
  }

  function gonder(e, durum) {
    const n = RC.toNorm(e.clientX, e.clientY);
    if (!n) return;
    RC.send({
      t: 'kalem', durum, x: n.x, y: n.y,
      p: basinc(e, durum),
      tx: Math.round(e.tiltX || 0), ty: Math.round(e.tiltY || 0),
      silgi: silgiMi(e),
    });
  }

  // hover/move olayları ekran yenileme hızında birleştirilir; down/up/out anında gider.
  function birlestir(e, durum) {
    bekleyen = { e, durum };
    if (planli) return;
    planli = true;
    requestAnimationFrame(() => {
      planli = false;
      if (bekleyen) { gonder(bekleyen.e, bekleyen.durum); bekleyen = null; }
    });
  }

  function kalemMi(e) { return e.pointerType === 'pen'; }

  stage.addEventListener('pointerdown', (e) => {
    if (!kalemMi(e) || !destekli()) return;
    e.preventDefault();
    e.stopPropagation();
    try { stage.setPointerCapture(e.pointerId); } catch {}
    temas = true;
    bekleyen = null;
    gonder(e, 'down');
  }, true);

  stage.addEventListener('pointermove', (e) => {
    if (!kalemMi(e) || !destekli()) return;
    e.preventDefault();
    e.stopPropagation();
    birlestir(e, temas ? 'move' : 'hover');
  }, true);

  // Menzile girince (temas olmadan) kalem imleci
  stage.addEventListener('pointerover', (e) => {
    if (!kalemMi(e) || !destekli() || temas) return;
    e.preventDefault();
    e.stopPropagation();
    birlestir(e, 'hover');
  }, true);

  function kalkis(e, durum) {
    if (!kalemMi(e)) return;
    e.preventDefault();
    e.stopPropagation();
    bekleyen = null;
    const vardi = temas;
    temas = false;
    try { stage.releasePointerCapture(e.pointerId); } catch {}
    if (!destekli()) return;
    gonder(e, vardi ? durum : 'out');
  }

  stage.addEventListener('pointerup', (e) => kalkis(e, 'up'), true);
  stage.addEventListener('pointercancel', (e) => kalkis(e, 'out'), true);
  stage.addEventListener('pointerleave', (e) => kalkis(e, 'out'), true);
})();
