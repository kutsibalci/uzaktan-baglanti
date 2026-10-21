// Tablet kalemi: basınç, eğim ve silgi bilgisiyle kalem olaylarını bilgisayara iletir.
// Yalnızca pointerType === 'pen' olan olaylar işlenir; parmak/fare çekirdek koduna bırakılır.
// Kalem özelliği devredeyken (RC.setPenActive) çekirdek, kalemin ürettiği fare/dokunma olaylarını yok sayar.
// Devrede değilse (izleme yok, salt izleme, bilgisayar sentetik kalemi desteklemiyor) kalem fare gibi çalışmaya devam eder.
//
// Gecikme: hareketler requestAnimationFrame'de birleştirilmez. Tarayıcı pointermove'u zaten ekran yenilemesinde bir kez
// verir; aradaki noktalar (iPad'de Apple Pencil 240 Hz) getCoalescedEvents() ile alınır ve HEPSİ hemen gönderilir —
// çizgiler köşeli olmaz. Sunucu kalem için saniyede 480 olaya izin verir (features/kalem.js).
// Apple Pencil hover (iPadOS 16+, M2 ve sonrası iPad): temassız pointermove (buttons 0) 'hover' olarak gider.
//
// Avuç içi reddi (kalem kullanılmaya başlandıktan ya da çizim modu açıldıktan sonra):
//  - kalem ekrana değerken ve son kalem olayından sonraki AVUC_MS içinde parmak dokunuşları yok sayılır,
//  - temas alanı büyük dokunuşlar (Touch.radiusX/Y ya da PointerEvent width/height) her zaman yok sayılır,
//  - "Parmak" ayarı (menü): açık / yalnızca kalem + iki parmak (yakınlaştırma, kaydırma) / yalnızca kalem.
// Yok sayılan dokunuş çekirdeğe hiç ulaşmaz (yakalama aşamasında durdurulur). Süren bir parmak hareketine avuç
// değerse çekirdeğe sahte bir touchcancel verilir: basılı düğme kalmaz.
(() => {
  const RC = window.RC;
  if (!RC) return;
  const stage = RC.ui.stage();

  const AVUC_MS = 1000;      // son kalem olayından sonra parmakların yok sayıldığı süre
  const AVUC_YARICAP = 25;   // px; temas yarıçapı bundan büyükse avuç içi sayılır (parmak ~5-20 px)
  // Kalemin pointerdown'ından hemen sonra AYNI noktada başlayan dokunuş kalemin kendisidir (Android Chrome kalem için
  // dokunma olayı da üretir, touchType yok). Başka yerdeki dokunuş (avuç) kalem sayılmaz.
  const KALEM_DOKUNUS_MS = 120, KALEM_DOKUNUS_PX = 4;
  const PARMAK = {
    acik: 'açık',
    iki: 'yalnızca kalem + iki parmak',
    kapali: 'yalnızca kalem',
  };
  const SIRA = ['acik', 'iki', 'kapali'];

  let temas = false;     // kalem ekrana değiyor mu
  let destek = null;     // bilgisayar sentetik kalemi destekliyor mu (null: henüz bilinmiyor)
  let sorgulandi = false;
  let sonKalem = -1e9;   // son kalem olayının zamanı (performance.now)
  let sonKalemBas = { t: -1e9, x: 0, y: 0 }; // son kalem pointerdown'ı
  let kalemGoruldu = false;
  let cizimAcik = false; // çizim tableti modu (public/features/cizim.js 'rc:cizim' olayıyla bildirir)
  let buyukAn = -1e9;    // son büyük temaslı dokunma pointerdown'ı (Touch.radiusX vermeyen tarayıcılar için)
  let parmak = 'acik';
  try { if (PARMAK[localStorage.getItem('kalemParmak')]) parmak = localStorage.getItem('kalemParmak'); } catch { /* gizli sekme */ }

  // Kontrol ve ikinci ekran (extend) modlarında çalışır; sunucu ikisini de kabul eder.
  function destekli() {
    const s = RC.state();
    return !!(s.stream && s.stream.started && RC.canInput() && destek !== false);
  }
  if (RC.setPenActive) RC.setPenActive(destekli);

  // ---------- Parmak ayarı (menü) ----------
  const parmakItem = RC.ui.menuItem({
    id: 'parmakBtn', icon: '✋', label: 'Parmak', order: 46, ctl: true, keepOpen: true, hidden: true, ikincil: true,
    title: 'Kalem kullanırken parmak dokunuşları', onClick() { parmakAyarla(SIRA[(SIRA.indexOf(parmak) + 1) % SIRA.length]); },
  });
  function parmakGuncelle() {
    parmakItem.set({ state: PARMAK[parmak], hidden: !(kalemGoruldu || cizimAcik), active: parmak !== 'acik' });
  }
  function parmakAyarla(v) {
    if (!PARMAK[v]) return;
    parmak = v;
    try { localStorage.setItem('kalemParmak', v); } catch { /* gizli sekme */ }
    parmakGuncelle();
  }
  parmakGuncelle();
  document.addEventListener('rc:cizim', (e) => { cizimAcik = !!e.detail?.acik; parmakGuncelle(); });

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
  RC.on('disconnect', () => { sorgulandi = false; destek = null; temas = false; reddedilen.clear(); cekirdekte = false; });

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

  // Bu pointermove'a birleştirilmiş ara noktalar (sonuncusu olayın kendisi). Desteklenmiyorsa yalnızca olay.
  function araNoktalar(e) {
    let c = null;
    try { c = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null; } catch { c = null; }
    return c && c.length ? c : [e];
  }

  function kalemMi(e) { return e.pointerType === 'pen'; }
  function kalemGor() {
    sonKalem = performance.now();
    if (!kalemGoruldu) { kalemGoruldu = true; parmakGuncelle(); }
  }

  stage.addEventListener('pointerdown', (e) => {
    if (!kalemMi(e) || !destekli()) return;
    e.preventDefault();
    e.stopPropagation();
    try { stage.setPointerCapture(e.pointerId); } catch {}
    kalemGor();
    sonKalemBas = { t: sonKalem, x: e.clientX, y: e.clientY };
    temas = true;
    gonder(e, 'down');
  }, true);

  stage.addEventListener('pointermove', (e) => {
    if (!kalemMi(e) || !destekli()) return;
    e.preventDefault();
    e.stopPropagation();
    kalemGor();
    // Temas varken tüm ara noktalar (pürüzsüz çizgi); hover'da yalnızca son konum yeter.
    if (temas) for (const c of araNoktalar(e)) gonder(c, 'move');
    else gonder(e, 'hover');
  }, true);

  // Menzile girince (temas olmadan) kalem imleci
  stage.addEventListener('pointerover', (e) => {
    if (!kalemMi(e) || !destekli() || temas) return;
    e.preventDefault();
    e.stopPropagation();
    kalemGor();
    gonder(e, 'hover');
  }, true);

  function kalkis(e, durum) {
    if (!kalemMi(e)) return;
    e.preventDefault();
    e.stopPropagation();
    kalemGor();
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

  // ---------- Avuç içi reddi ----------

  const reddedilen = new Set(); // yok sayılan dokunuş kimlikleri (parmak kalkana kadar)
  const kalemDokunus = new Set(); // kalemin kendi dokunuşları (çekirdek bunları zaten ayıklar)
  const ikiBekleyen = new Set(); // "iki parmak" ayarında tek başına kaldığı için bekletilen parmak
  let cekirdekte = false;       // çekirdeğe bir dokunma hareketi başlatıldı ve henüz bitmedi
  let sahteIptal = false;

  // Touch.radiusX vermeyen tarayıcılar için pointer olayının temas alanı (dokunma olayından önce gelir).
  stage.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch' && Math.max(e.width || 0, e.height || 0) > AVUC_YARICAP * 2) buyukAn = performance.now();
  }, true);

  const etkin = () => destekli() && (kalemGoruldu || cizimAcik);
  const buyukMu = (t) => Math.max(t.radiusX || 0, t.radiusY || 0) > AVUC_YARICAP;
  const kalemin = (t, simdi) => temas && simdi - sonKalemBas.t < KALEM_DOKUNUS_MS
    && Math.abs(t.clientX - sonKalemBas.x) <= KALEM_DOKUNUS_PX && Math.abs(t.clientY - sonKalemBas.y) <= KALEM_DOKUNUS_PX;
  const kalemYakin = () => temas || performance.now() - sonKalem < AVUC_MS;

  function cekirdegiIptal() {
    if (!cekirdekte) return;
    cekirdekte = false;
    const ev = new Event('touchcancel', { bubbles: true });
    Object.defineProperty(ev, 'touches', { value: [] });
    Object.defineProperty(ev, 'changedTouches', { value: [] });
    sahteIptal = true;
    try { stage.dispatchEvent(ev); } finally { sahteIptal = false; }
  }

  function yut(e) {
    e.stopImmediatePropagation();
    if (e.cancelable) e.preventDefault(); // uyumluluk fare olayları da üretilmesin
  }

  function dokunma(e) {
    if (sahteIptal) return;
    if (!reddedilen.size && !ikiBekleyen.size && !etkin()) return;
    const simdi = performance.now();
    const hepsi = [...e.touches, ...e.changedTouches];
    if (e.type === 'touchstart') {
      for (const t of e.changedTouches) {
        if (t.touchType === 'stylus' || kalemin(t, simdi)) { kalemDokunus.add(t.identifier); continue; }
        if (!etkin()) continue;
        if (buyukMu(t) || simdi - buyukAn < 80 || kalemYakin() || parmak === 'kapali') reddedilen.add(t.identifier);
        else if (parmak === 'iki') ikiBekleyen.add(t.identifier);
      }
      // "İki parmak" ayarı: ekranda (reddedilmemiş) iki parmak olunca ikisi de çekirdeğe gider; tek parmak bekletilir.
      if (ikiBekleyen.size) {
        const parmaklar = [...e.touches].filter((t) => !kalemDokunus.has(t.identifier) && !reddedilen.has(t.identifier));
        if (parmaklar.length >= 2) ikiBekleyen.clear();
      }
    } else if (e.type === 'touchmove' && etkin()) {
      // Sonradan büyüyen temas (avuç yavaşça yaslanır): o andan itibaren yok sayılır.
      for (const t of e.changedTouches) {
        if (!kalemDokunus.has(t.identifier) && !reddedilen.has(t.identifier) && buyukMu(t)) reddedilen.add(t.identifier);
      }
    }
    const engel = hepsi.some((t) => reddedilen.has(t.identifier) || ikiBekleyen.has(t.identifier));
    if (engel) {
      // Süren bir hareket varsa çekirdek onu bitirsin; o hareketin parmakları da artık yok sayılır.
      if (cekirdekte) {
        for (const t of e.touches) if (!kalemDokunus.has(t.identifier) && !ikiBekleyen.has(t.identifier)) reddedilen.add(t.identifier);
        cekirdegiIptal();
      }
      yut(e);
    } else if (e.type === 'touchstart') {
      if ([...e.changedTouches].some((t) => !kalemDokunus.has(t.identifier))) cekirdekte = true;
    } else if ((e.type === 'touchend' || e.type === 'touchcancel') && !e.touches.length) {
      cekirdekte = false;
    }
    if (e.type === 'touchend' || e.type === 'touchcancel') {
      for (const t of e.changedTouches) { reddedilen.delete(t.identifier); kalemDokunus.delete(t.identifier); ikiBekleyen.delete(t.identifier); }
    }
  }
  for (const tip of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) {
    stage.addEventListener(tip, dokunma, { capture: true, passive: false });
  }

  // Testler ve diğer özellikler için durum (salt okunur).
  RC.kalem = { parmak: () => parmak, setParmak: parmakAyarla, reddedilen: () => reddedilen.size };
})();
