// Çizim tableti ("Windows için Sidecar"): iPad/tablet + kalem ile bilgisayardaki çizim programını kullanmak için.
//  - Ana menüde "🎨 Çizim tableti" kartı: sanal ekran sürücüsü kuruluysa ikinci ekranı, yoksa seçili ekranı tam ekran açar,
//    kısayol panelini açar ve araç çubuğunu gizler (üstteki ▾ ile geri gelir). H.264'te görüntü 60 fps'e çıkarılır
//    (kare aralığı 33 → 17 ms: kalemin çizdiği çizgi ekrana daha çabuk gelir).
//  - Kenar kısayol paneli (sol ya da sağ kenarda, yarı saydam, ‹ ile gizlenir): Geri al, Yinele, basılı tutulan
//    Ctrl/Shift/Alt/Boşluk (tuttuğun sürece basılı: el aracı, düz çizgi), Fırça, Silgi, fırça küçült/büyüt,
//    yakınlaştır/uzaklaştır, renk seçici (basılı). Kısayollar uygulama profiline göre değişir; profil, kenar ve
//    gizli/açık durumu bu cihazda hatırlanır. Menüde "🎨 Çizim paneli" ile her görüntülemede açılıp kapatılabilir.
//  - Tuşlar sunucuya { t: 'cizim-tus', vk, down } olarak gider (features/cizim.js): sunucu basılı tuşları izler ve
//    bağlantı koparsa / izleme biterse bırakır. Tarayıcı da sekme gizlenince, pencere odağı gidince, izleme bitince bırakır.
// Avuç içi reddi ve "Parmak" ayarı public/features/kalem.js'te ('rc:cizim' olayıyla çizim modundan haberdar olur).
(() => {
  // Kısayol profilleri (sanal tuş kodları; birden çok kod = kombinasyon, son kod asıl tuş).
  // 17 Ctrl, 16 Shift, 18 Alt, 32 Boşluk, 90 Z, 89 Y, 66 B, 69 E, 75 K, 219 [, 221 ], 107/109 sayısal tuş takımı + / -,
  // 33/34 Page Up/Down. Yakınlaştırmada sayısal tuş takımının +/-'si kullanılır: klavye düzeninden bağımsızdır
  // (Türkçe Q düzeninde "+" ayrı bir tuşta değil). renk: { tut: vk } basılı tutulur, { bas: [...] } tek basış.
  const PROFILLER = {
    photoshop: {
      ad: 'Photoshop', geri: [17, 90], yinele: [17, 16, 90], firca: [66], silgi: [69],
      kucult: [219], buyut: [221], yakin: [17, 107], uzak: [17, 109], renk: { tut: 18 },
    },
    krita: {
      ad: 'Krita', geri: [17, 90], yinele: [17, 16, 90], firca: [66], silgi: [69],
      kucult: [219], buyut: [221], yakin: [17, 107], uzak: [17, 109], renk: { tut: 17 },
    },
    csp: {
      ad: 'Clip Studio Paint', geri: [17, 90], yinele: [17, 89], firca: [66], silgi: [69],
      kucult: [219], buyut: [221], yakin: [17, 107], uzak: [17, 109], renk: { tut: 18 },
    },
    paintnet: {
      ad: 'Paint.NET', geri: [17, 90], yinele: [17, 89], firca: [66], silgi: [69],
      kucult: [219], buyut: [221], yakin: [17, 107], uzak: [17, 109], renk: { bas: [75] },
    },
    paint: {
      ad: 'Paint (Windows)', geri: [17, 90], yinele: [17, 89], firca: null, silgi: null,
      kucult: [17, 109], buyut: [17, 107], yakin: [17, 33], uzak: [17, 34], renk: null,
    },
  };
  const VARSAYILAN = 'photoshop';

  // Paneldeki düğmeler, yukarıdan aşağı. tut: profilden bağımsız basılı tutulan tuş.
  const DUGMELER = [
    { k: 'geri', simge: '↶', ad: 'Geri al' },
    { k: 'yinele', simge: '↷', ad: 'Yinele' },
    { k: 'ctrl', simge: 'Ctrl', ad: 'basılı', tut: 17 },
    { k: 'shift', simge: 'Shift', ad: 'basılı', tut: 16 },
    { k: 'alt', simge: 'Alt', ad: 'basılı', tut: 18 },
    { k: 'bosluk', simge: '✋', ad: 'Boşluk', tut: 32 },
    { k: 'firca', simge: '🖌', ad: 'Fırça' },
    { k: 'silgi', simge: '⌫', ad: 'Silgi' },
    { k: 'kucult', simge: '−●', ad: 'Fırça' },
    { k: 'buyut', simge: '+●', ad: 'Fırça' },
    { k: 'yakin', simge: '＋', ad: 'Yakınlaş' },
    { k: 'uzak', simge: '－', ad: 'Uzaklaş' },
    { k: 'renk', simge: '💧', ad: 'Renk' },
  ];

  // Kombinasyonun mesajları: zaten basılı tutulan değiştiriciler yeniden basılmaz ve bırakılmaz
  // (Ctrl basılıyken "Geri al" Ctrl'yi bırakmasın).
  function kombinasyon(vks, basili = new Set()) {
    const mods = vks.slice(0, -1).filter((vk) => !basili.has(vk));
    const key = vks[vks.length - 1];
    return [
      ...mods.map((vk) => ({ t: 'cizim-tus', vk, down: true })),
      { t: 'cizim-tus', vk: key, down: true }, { t: 'cizim-tus', vk: key, down: false },
      ...[...mods].reverse().map((vk) => ({ t: 'cizim-tus', vk, down: false })),
    ];
  }

  // Düğmenin bu profilde yaptığı iş: { tut: vk } | { bas: [vk...] } | null (bu programda karşılığı yok).
  function eylem(d, profil) {
    if (d.tut) return { tut: d.tut };
    const p = PROFILLER[profil] || PROFILLER[VARSAYILAN];
    const v = p[d.k];
    if (!v) return null;
    if (Array.isArray(v)) return { bas: v };
    return v;
  }

  const tusAdi = (vk) => ({ 16: 'Shift', 17: 'Ctrl', 18: 'Alt', 32: 'Boşluk', 33: 'Page Up', 34: 'Page Down', 107: '+', 109: '-', 219: '[', 221: ']' }[vk]
    || String.fromCharCode(vk));
  const ipucu = (e) => (!e ? '' : e.tut ? `${tusAdi(e.tut)} (basılı tut)` : e.bas.map(tusAdi).join('+'));

  // Node testleri için saf fonksiyonlar (tarayıcıda module yok).
  if (typeof module === 'object' && module.exports) {
    module.exports = { PROFILLER, DUGMELER, kombinasyon, eylem, ipucu };
    return;
  }

  const RC = window.RC;
  if (!RC) return;
  const $ = (id) => document.getElementById(id);

  const ayar = {
    al(k, yedek) { try { return localStorage.getItem(k) ?? yedek; } catch { return yedek; } },
    koy(k, v) { try { localStorage.setItem(k, v); } catch { /* gizli sekme */ } },
  };
  let profil = PROFILLER[ayar.al('cizimProfil', '')] ? ayar.al('cizimProfil', '') : VARSAYILAN;
  let yan = ayar.al('cizimYan', 'sol') === 'sag' ? 'sag' : 'sol';
  let gizli = ayar.al('cizimGizli', '0') === '1';
  let cizimAcik = false;  // bu görüntülemede panel açık mı
  let kartIle = false;    // görüntüleme "Çizim tableti" kartından başlatıldı
  let tetik = false;      // kartın kendisi modeControl/modeExtend'e tıklıyor

  const style = document.createElement('style');
  style.textContent = `
    #cizimPanel { position: fixed; top: 50%; transform: translateY(-50%); z-index: 30; display: flex; align-items: center; pointer-events: none; }
    #cizimPanel.sol { left: 0; padding-left: env(safe-area-inset-left); }
    #cizimPanel.sag { right: 0; padding-right: env(safe-area-inset-right); flex-direction: row-reverse; }
    #cizimPanel > * { pointer-events: auto; }
    #cizimPanel .cz-ic { display: flex; flex-direction: column; gap: 4px; padding: 6px; max-height: calc(var(--vv-h, 100vh) - 16px);
      overflow-y: auto; overscroll-behavior: contain; background: rgba(26, 29, 36, .72); border: 1px solid rgba(51, 58, 72, .9);
      -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px); scrollbar-width: none; }
    #cizimPanel.sol .cz-ic { border-left: 0; border-radius: 0 14px 14px 0; }
    #cizimPanel.sag .cz-ic { border-right: 0; border-radius: 14px 0 0 14px; }
    #cizimPanel.gizli .cz-ic { display: none; }
    #cizimPanel button { width: 54px; min-height: 46px; padding: 3px 2px; background: rgba(35, 39, 49, .85); border: 1px solid var(--line);
      border-radius: 10px; color: var(--text); display: grid; place-items: center; gap: 0; line-height: 1.1; font-size: 17px;
      -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
    #cizimPanel button small { font-size: 10px; color: var(--muted); white-space: nowrap; }
    #cizimPanel .cz-ic button { touch-action: none; } /* ikinci parmak tarayıcı yakınlaştırması başlatıp tutmayı iptal etmesin */
    #cizimPanel button.tut b { font-size: 13px; font-weight: 600; }
    #cizimPanel button.on { background: var(--accent); border-color: var(--accent); }
    #cizimPanel button.on small { color: var(--text); }
    #cizimPanel button[hidden] { display: none; }
    #cizimPanel select { width: 54px; padding: 6px 2px; font-size: 11px; border-radius: 8px; background: rgba(15, 17, 21, .85); }
    #cizimPanel .cz-kol { width: 26px; min-height: 0; height: 70px; padding: 0; font-size: 17px; font-weight: 700; color: var(--text);
      background: rgba(26, 29, 36, .92); border: 1px solid var(--accent); }
    #cizimPanel.sol .cz-kol { border-left: 0; border-radius: 0 10px 10px 0; }
    #cizimPanel.sag .cz-kol { border-right: 0; border-radius: 10px 0 0 10px; }
    #cizimPanel:not(.gizli) .cz-kol { margin: 0 -1px; }
  `;
  document.head.appendChild(style);

  // ---------- Kenar paneli ----------

  const panel = document.createElement('div');
  panel.id = 'cizimPanel';
  panel.className = 'ctl';
  panel.hidden = true;
  panel.setAttribute('role', 'toolbar');
  panel.setAttribute('aria-label', 'Çizim kısayolları');
  panel.innerHTML = '<div class="cz-ic"></div><button type="button" class="cz-kol"></button>';
  const ic = panel.firstChild;
  const kol = panel.lastChild;
  $('vViewer').appendChild(panel);

  const sec = document.createElement('select');
  sec.id = 'cizimProfil';
  sec.title = 'Çizim programı (kısayollar buna göre)';
  for (const [k, p] of Object.entries(PROFILLER)) sec.appendChild(new Option(p.ad, k));
  ic.appendChild(sec);

  const dugmeler = DUGMELER.map((d) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.k = d.k;
    b.innerHTML = `<b></b><small></small>`;
    b.querySelector('b').textContent = d.simge;
    b.querySelector('small').textContent = d.ad;
    ic.appendChild(b);
    return { d, b };
  });

  const yanBtn = document.createElement('button');
  yanBtn.type = 'button';
  yanBtn.dataset.k = 'yan';
  yanBtn.title = 'Paneli öbür kenara taşı';
  yanBtn.innerHTML = '<b>⇄</b><small>Kenar</small>';
  ic.appendChild(yanBtn);

  // ---------- Basılı tuşlar ----------
  // vk -> basılı tutan düğmeler. Aynı tuşu iki düğme tutabilir (ör. Alt ve Photoshop'ta "Renk"): son düğme bırakınca up.
  const basili = new Map();
  const gonder = (m) => RC.send(m);

  function bas(vk, kaynak) {
    if (!RC.canInput()) return;
    if (!basili.has(vk)) { basili.set(vk, new Set()); gonder({ t: 'cizim-tus', vk, down: true }); }
    basili.get(vk).add(kaynak);
    kaynak.classList.add('on');
  }
  function birak(vk, kaynak) {
    kaynak.classList.remove('on');
    const s = basili.get(vk);
    if (!s || !s.delete(kaynak) || s.size) return;
    basili.delete(vk);
    gonder({ t: 'cizim-tus', vk, down: false });
  }
  function hepsiniBirak() {
    for (const [vk, s] of basili) {
      for (const b of s) b.classList.remove('on');
      gonder({ t: 'cizim-tus', vk, down: false });
    }
    basili.clear();
  }

  function kombinasyonGonder(vks) {
    if (!RC.canInput()) return;
    for (const m of kombinasyon(vks, new Set(basili.keys()))) gonder(m);
  }

  // Düğmeler pointer olaylarıyla çalışır, click ile değil: bir parmak Ctrl'yi tutarken ikinci parmağın dokunuşu
  // tarayıcıda "click" üretmez (çok parmaklı hareket sayılır). Kısayol, parmak düğmenin üstünde kalkınca gider.
  const ustunde = (b, e) => { const r = b.getBoundingClientRect(); return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom; };
  for (const { d, b } of dugmeler) {
    b.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const ey = eylem(d, profil);
      if (!ey) return;
      e.preventDefault();
      try { b.setPointerCapture(e.pointerId); } catch { /* desteklenmiyor */ }
      b.dataset.pid = String(e.pointerId);
      // Basılı tutma: parmak düğmede kaldıkça tuş basılı (yakalama: parmak kayarsa da kalkınca up gider).
      if (ey.tut) { b.dataset.vk = String(ey.tut); bas(ey.tut, b); }
    });
    const kalk = (e, uygula) => {
      if (b.dataset.pid !== String(e.pointerId)) return;
      delete b.dataset.pid;
      if (b.dataset.vk) { birak(Number(b.dataset.vk), b); delete b.dataset.vk; return; }
      const ey = eylem(d, profil);
      if (uygula && ey?.bas && ustunde(b, e)) kombinasyonGonder(ey.bas);
    };
    b.addEventListener('pointerup', (e) => kalk(e, true));
    b.addEventListener('pointercancel', (e) => kalk(e, false));
    b.addEventListener('lostpointercapture', (e) => kalk(e, false));
    // Klavyeyle (Enter/Boşluk) etkinleştirme: pointer olayı yoktur.
    b.addEventListener('click', (e) => { const ey = eylem(d, profil); if (e.detail === 0 && ey?.bas) kombinasyonGonder(ey.bas); });
    b.addEventListener('contextmenu', (e) => e.preventDefault()); // uzun basınca menü çıkmasın
  }

  function profilUygula() {
    hepsiniBirak();
    sec.value = profil;
    for (const { d, b } of dugmeler) {
      const ey = eylem(d, profil);
      b.hidden = !ey;
      b.classList.toggle('tut', !!ey?.tut);
      b.title = ey ? `${d.k === 'renk' ? 'Renk seçici' : d.ad}: ${ipucu(ey)}` : '';
      b.setAttribute('aria-label', b.title);
    }
  }
  sec.addEventListener('change', () => {
    if (!PROFILLER[sec.value]) return;
    profil = sec.value;
    ayar.koy('cizimProfil', profil);
    profilUygula();
  });

  function yerlesim() {
    panel.classList.toggle('sol', yan === 'sol');
    panel.classList.toggle('sag', yan === 'sag');
    panel.classList.toggle('gizli', gizli);
    // Ok, panelin kapanacağı / açılacağı yönü gösterir.
    kol.textContent = (yan === 'sol') !== gizli ? '‹' : '›';
    kol.title = gizli ? 'Kısayol panelini göster' : 'Kısayol panelini gizle';
    kol.setAttribute('aria-label', kol.title);
  }
  kol.addEventListener('click', () => {
    gizli = !gizli;
    if (gizli) hepsiniBirak();
    ayar.koy('cizimGizli', gizli ? '1' : '0');
    yerlesim();
  });
  yanBtn.addEventListener('click', () => {
    yan = yan === 'sol' ? 'sag' : 'sol';
    ayar.koy('cizimYan', yan);
    yerlesim();
  });

  // Panel görüntü alanının (sahne) dikey ortasına oturur: araç çubuğu görünürken onun üstüne binmez.
  const sahne = RC.ui.stage();
  function hizala() {
    if (panel.hidden) return;
    const r = sahne.getBoundingClientRect();
    if (!r.height) return;
    panel.style.top = `${Math.round(r.top + r.height / 2)}px`;
    ic.style.maxHeight = `${Math.max(120, Math.round(r.height - 12))}px`;
  }
  if (window.ResizeObserver) new ResizeObserver(hizala).observe(sahne);
  window.addEventListener('resize', hizala);

  function goster() {
    const s = RC.state();
    panel.hidden = !(cizimAcik && s.stream?.started && RC.canInput());
    if (panel.hidden) hepsiniBirak();
    hizala();
  }

  function cizimAyarla(acik) {
    cizimAcik = !!acik;
    menu.set({ active: cizimAcik, state: cizimAcik ? 'açık' : 'kapalı' });
    document.dispatchEvent(new CustomEvent('rc:cizim', { detail: { acik: cizimAcik } }));
    goster();
  }

  const menu = RC.ui.menuItem({
    id: 'cizimBtn', icon: '🎨', label: 'Çizim paneli', state: 'kapalı', order: 45, ctl: true,
    title: 'Kalemle çizim için kenar kısayol paneli (Geri al, Ctrl/Shift/Alt/Boşluk, fırça…)',
    // Telefonda (kısa kenar < 600 px; iPhone'da kalem yok) menüyü uzatmasın; ana menüdeki kart yine açar.
    hidden: Math.min(screen.width, screen.height) < 600,
    onClick() { cizimAyarla(!cizimAcik); },
  });

  // Sekme gizlenince / odak gidince basılı tuş kalmasın (bırakış olayı gelmeyebilir).
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') hepsiniBirak(); });
  window.addEventListener('pagehide', hepsiniBirak);
  window.addEventListener('blur', hepsiniBirak);
  // Bağlantı koptuysa sunucu zaten bırakır (features/cizim.js); burada yalnızca durum temizlenir.
  RC.on('disconnect', () => { for (const s of basili.values()) for (const b of s) b.classList.remove('on'); basili.clear(); });

  RC.on('viewer:start', () => {
    if (kartIle) {
      cizimAyarla(true);
      // Araç çubuğu gizlenir; üstteki ▾ ile geri gelir (ikinci ekranda çekirdek zaten gizler).
      $('toolbar').hidden = true;
      $('showBtn').hidden = false;
      // H.264'te en düşük gecikme: 60 fps (kare aralığı yarıya iner). Kodek, ilk ölçümden (1 sn) sonra bilinir.
      setTimeout(() => {
        if (cizimAcik && RC.state().stream?.started && /^H\.264/.test(RC.stats().codec || '')) RC.send({ t: 'settings', fps: 60 });
      }, 1300);
    } else {
      goster();
    }
  });
  RC.on('viewer:stop', () => { hepsiniBirak(); kartIle = false; cizimAyarla(false); });

  // ---------- Ana menü kartı ----------

  const kart = document.createElement('button');
  kart.className = 'mode';
  kart.id = 'modeCizim';
  kart.innerHTML = '<span class="icon">🎨</span><b>Çizim tableti</b><small id="cizimHint"></small>';
  const modes = document.querySelector('#vHome .modes');
  if (modes) modes.appendChild(kart);
  else RC.ui.home(kart);

  function kartGuncelle() {
    const s = RC.state();
    const salt = s.me?.role === 'view';
    kart.disabled = salt;
    $('cizimHint').textContent = salt ? 'Kontrol yetkisi gerekiyor'
      : s.vdd ? 'Kalemle çiz: ikinci ekran + kısayol paneli'
      : 'Kalemle çiz: seçili ekran, tam ekran + kısayol paneli';
  }
  RC.on('auth', kartGuncelle);
  RC.on('viewer:stop', kartGuncelle);

  // Kullanıcı normal kartlardan birine basarsa çizim modu açılmaz.
  for (const id of ['modeControl', 'modeExtend']) {
    $(id).addEventListener('click', () => { if (!tetik) kartIle = false; }, true);
  }

  kart.addEventListener('click', async () => {
    const s = RC.state();
    kartIle = true;
    if (!s.vdd) {
      // Tam ekran (iPhone'da yok; iPad Safari'de var). İkinci ekran kartı bunu kendisi yapar.
      const el = document.documentElement;
      try { await (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el); } catch { /* izin yok */ }
    }
    tetik = true;
    try { $(s.vdd ? 'modeExtend' : 'modeControl').click(); } finally { tetik = false; }
  });

  profilUygula();
  yerlesim();

  // Testler için (salt okunur durum + ayar).
  RC.cizim = { acik: () => cizimAcik, ayarla: cizimAyarla, basili: () => [...basili.keys()] };
})();
