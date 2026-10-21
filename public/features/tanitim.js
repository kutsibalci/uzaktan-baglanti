// İlk bağlantıda kısa tanıtım: görüntü açılınca (cihaz başına bir kez) 2-3 adımda çubukları ve hareketleri gösterir;
// ⋯ menüde "Nasıl kullanılır?" ile yeniden açılır. Katman açıkken dokunuşlar bilgisayara gitmez (görüntünün üstündedir).
// Salt izleme, ikinci ekran ve çizim tableti (çubuk gizli) modlarında kendiliğinden açılmaz. Sunucu { t: 'tanitim', acik } bildirir.
(() => {
  const ANAHTAR = 'rc-tanitim';
  const style = document.createElement('style');
  style.textContent = `
    #tanitim { position: fixed; inset: 0; z-index: 90; touch-action: none; }
    #tanitim .tnt-karart { position: fixed; inset: 0; background: rgba(3, 5, 10, .74); } /* vurgulanan yer clip-path ile delinir */
    #tanitim .tnt-isik { position: fixed; border-radius: 14px; pointer-events: none; transition: all .25s ease;
      box-shadow: 0 0 0 2px rgba(79, 124, 255, .9), 0 0 26px rgba(79, 124, 255, .55); }
    #tanitim .tnt-kart { position: fixed; left: 16px; right: 16px; max-width: 420px; margin: 0 auto; display: grid; gap: 10px; padding: 18px;
      background: var(--panel); border: 1px solid var(--line2); border-radius: 20px; box-shadow: 0 24px 60px rgba(0, 0, 0, .6); }
    #tanitim .tnt-ust { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    #tanitim .tnt-adim { font-size: 12px; font-weight: 600; color: var(--muted); }
    #tanitim .tnt-noktalar { display: flex; gap: 5px; }
    #tanitim .tnt-noktalar i { width: 7px; height: 7px; border-radius: 50%; background: var(--line2); }
    #tanitim .tnt-noktalar i.on { background: var(--accent); width: 18px; border-radius: 4px; }
    #tanitim h3 { margin: 0; font-size: 18px; font-weight: 700; }
    #tanitim p { margin: 0; color: #c3cada; font-size: 14.5px; line-height: 1.55; }
    #tanitim p b { color: var(--text); }
    #tanitim .tnt-dug { display: flex; gap: 8px; justify-content: flex-end; margin-top: 4px; }
    #tanitim .tnt-dug button { min-height: 44px; padding: 0 18px; }
    #tanitim .tnt-dug [data-k="ileri"] { background: var(--grad); color: #fff; }
  `;
  document.head.appendChild(style);

  const $ = (id) => document.getElementById(id);
  const gorunur = (id) => { const e = $(id); return e && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden' ? e : null; };
  const oku = () => { try { return localStorage.getItem(ANAHTAR); } catch { return '1'; } }; // depolama yoksa her seferinde gösterme
  const yaz = () => { try { localStorage.setItem(ANAHTAR, '1'); } catch { /* gizli sekme */ } };

  function adimlar() {
    const alt = gorunur('altCubuk');
    const dokunmatik = window.matchMedia('(any-pointer: coarse)').matches;
    return [
      {
        hedef: () => alt || gorunur('toolbar'),
        baslik: 'Kontroller burada',
        metin: alt
          ? 'Alttaki çubukta <b>Klavye</b>, <b>Tuşlar</b> (Ctrl, Alt, Win, F1–F12, kısayollar), dokunma modu (<b>Fare / Dokunmatik</b>), <b>Sağ tık</b> ve <b>Pano</b> var.'
          : 'Üstteki çubukta klavye, özel tuşlar (Ctrl, Alt, Win, F1–F12, kısayollar), pano, dosya, ses ve diğer kontroller var.',
      },
      {
        hedef: () => gorunur('menuBtn'),
        baslik: 'Diğer özellikler',
        metin: `<b>${alt ? 'Diğer' : '⋯'}</b> düğmesinde: dosya aktarımı, bilgisayar sesi, gizlilik perdesi, bilgisayar durumu, görüntü kalitesi, tam ekran ve daha fazlası.`,
      },
      dokunmatik && {
        hedef: () => gorunur('stage'),
        baslik: 'Hareketler',
        metin: '<b>Fare</b> modunda parmağın imleci sürer, dokun = tık. <b>Dokunmatik</b> modda dokunduğun yer tıklanır, sürükle = sürükle. '
          + 'İkisinde de: <b>basılı tut = sağ tık</b>, iki parmakla kaydır = kaydırma, iki parmakla sıkıştır = yakınlaştır.',
      },
    ].filter(Boolean);
  }

  let kat = null;
  function kapat() {
    if (!kat) return;
    kat.remove();
    kat = null;
    yaz();
    window.removeEventListener('resize', ciz);
  }
  let liste = [], sira = 0;
  function ciz() {
    if (!kat) return;
    const a = liste[sira];
    const isik = kat.querySelector('.tnt-isik');
    const karart = kat.querySelector('.tnt-karart');
    const kart = kat.querySelector('.tnt-kart');
    kat.querySelector('.tnt-adim').textContent = `${sira + 1} / ${liste.length}`;
    kat.querySelector('.tnt-noktalar').innerHTML = liste.map((_, i) => `<i class="${i === sira ? 'on' : ''}"></i>`).join('');
    kat.querySelector('h3').textContent = a.baslik;
    kat.querySelector('p').innerHTML = a.metin;
    const ileri = kat.querySelector('[data-k="ileri"]');
    ileri.textContent = sira === liste.length - 1 ? 'Başla' : 'İleri';
    kat.querySelector('[data-k="gec"]').hidden = sira === liste.length - 1;
    const h = a.hedef();
    const r = h ? h.getBoundingClientRect() : null;
    const pay = 6;
    isik.hidden = !r;
    if (r) {
      const [x1, y1, x2, y2] = [r.left + pay, r.top + pay, r.right - pay, r.bottom - pay].map(Math.round);
      Object.assign(isik.style, { left: `${x1}px`, top: `${y1}px`, width: `${Math.max(0, x2 - x1)}px`, height: `${Math.max(0, y2 - y1)}px` });
      karart.style.clipPath = `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${x1}px ${y1}px, ${x1}px ${y2}px, ${x2}px ${y2}px, ${x2}px ${y1}px, ${x1}px ${y1}px)`;
    } else karart.style.clipPath = 'none';
    // Kart, vurgulanan yerin karşı tarafına: hedef aşağıdaysa üstüne, yukarıdaysa altına; görüntünün tamamıysa ortaya.
    const vh = window.innerHeight;
    kart.style.top = kart.style.bottom = '';
    if (!r || r.height > vh * 0.6) kart.style.top = `${Math.max(16, (vh - kart.offsetHeight) / 2)}px`;
    else if (r.top + r.height / 2 > vh / 2) kart.style.bottom = `${vh - r.top + 12}px`;
    else kart.style.top = `${r.bottom + 12}px`;
  }
  function baslat(elle) {
    if (kat || (!elle && oku() === '1')) return;
    liste = adimlar();
    sira = 0;
    kat = document.createElement('div');
    kat.id = 'tanitim';
    kat.setAttribute('role', 'dialog');
    kat.setAttribute('aria-modal', 'true');
    kat.setAttribute('aria-label', 'Kısa tanıtım');
    kat.innerHTML = '<div class="tnt-karart"></div><div class="tnt-isik"></div><div class="tnt-kart"><div class="tnt-ust"><span class="tnt-adim"></span><span class="tnt-noktalar"></span></div>'
      + '<h3></h3><p></p><div class="tnt-dug"><button type="button" class="ghost" data-k="gec">Geç</button><button type="button" data-k="ileri"></button></div></div>';
    kat.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-k]');
      if (!b) return;
      if (b.dataset.k === 'gec' || sira === liste.length - 1) return kapat();
      sira++;
      ciz();
    });
    document.body.appendChild(kat);
    if ($('touchTip')) $('touchTip').hidden = true; // dokunma modu ipucu tanıtımla aynı şeyi anlatır
    RC.ui.closable(kat, kapat); // Esc kapatır (bilgisayara gitmez)
    window.addEventListener('resize', ciz);
    ciz();
  }

  let acik = false;
  RC.on('tanitim', (m) => { acik = !!m.acik; });
  RC.on('viewer:start', (s) => {
    if (!acik || s?.mode !== 'control') return;
    // Çubuklar yerleşsin; çizim tableti gibi çubuğu gizleyen modlarda açılmaz.
    setTimeout(() => {
      if (!RC.state().stream || document.body.classList.contains('rc-salt') || $('toolbar').hidden) return;
      baslat(false);
    }, 700);
  });
  RC.on('viewer:stop', kapat);
  RC.on('disconnect', kapat);

  RC.ui.menuItem({ id: 'tanitimBtn', icon: '❓', label: 'Nasıl kullanılır?', order: 85, extend: false, ikincil: true, onClick: () => baslat(true) });
})();
