// Tablet kalemi: basınç, eğim ve silgi bilgisiyle kalem olaylarını bilgisayara iletir.
// Yalnızca pointerType === 'pen' olan olaylar işlenir; parmak/fare çekirdek koduna bırakılır.
// Kalem özelliği devredeyken (RC.setPenActive) çekirdek, kalemin ürettiği fare/dokunma olaylarını yok sayar.
// Devrede değilse (izleme yok, salt izleme, bilgisayar sentetik kalemi desteklemiyor) kalem fare gibi çalışmaya devam eder.
(() => {
  const RC = window.RC;
  if (!RC) return;
  const stage = RC.ui.stage();

  let bekleyen = null;   // rAF ile birleştirilecek son hover/move olayı
  let planli = false;
  let temas = false;     // kalem ekrana değiyor mu
  let destek = null;     // bilgisayar sentetik kalemi destekliyor mu (null: henüz bilinmiyor)
  let sorgulandi = false;

  // Kontrol ve ikinci ekran (extend) modlarında çalışır; sunucu ikisini de kabul eder.
  function destekli() {
    const s = RC.state();
    return !!(s.stream && s.stream.started && RC.canInput() && destek !== false);
  }
  if (RC.setPenActive) RC.setPenActive(destekli);

  RC.on('viewer:start', () => {
    if (!sorgulandi && RC.canInput()) { sorgulandi = true; RC.send({ t: 'kalem-destek' }); }
  });
  RC.on('kalem-destek', (m) => {
    destek = !!m.ok;
    if (!m.ok) {
      console.warn('Kalem desteklenmiyor:', m.hata || '');
      RC.overlay('Bu bilgisayar kalem girdisini desteklemiyor; kalem fare gibi çalışacak.');
      setTimeout(() => RC.overlay(''), 3500);
    }
  });
  // Yeniden bağlanınca (sunucu yeniden başlamış olabilir) tekrar sorulur.
  RC.on('disconnect', () => { sorgulandi = false; destek = null; temas = false; bekleyen = null; });

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
  // pointerleave kabarmaz; yakalama aşamasında alt öğelerinkini de (ör. setPointerCapture sonrası canvas'ın
  // "yakalama sınırı" olayı) görürdük ve çizgi ilk harekette koparıldı. Yalnızca sahnenin kendi çıkışı sayılır;
  // temas sürerken (yakalama varken) zaten kalkış pointerup/pointercancel ile gelir.
  stage.addEventListener('pointerleave', (e) => {
    if (e.target !== stage || temas) return;
    kalkis(e, 'out');
  });
})();
