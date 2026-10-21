// Telefon deneyimi: "Tuşlar" paneli (tek sayfa, başlıklı bölümler: sık kullanılanlar, yapışkan Ctrl/Alt/Shift/Win + gezinme
// tuşları ve oklar, F1–F12, diğer kısayollar) ve PWA (service worker).
// Panel görüntünün altına kenetlenir (ekranı örtmez); masaüstü tarayıcıda da kullanılır.
// Dokunmatik fare modu ve yakınlaştırma çekirdekte (public/app.js "Dokunmatik" bölümü + public/dokunmatik.js).
(() => {
  const MOD_VKS = new Set([16, 17, 18, 91]);

  // Yazılan karakteri kısayol için sanal tuş koduna çevirir (Ctrl+C gibi); karşılığı yoksa null.
  function charToVk(ch) {
    if (typeof ch !== 'string' || ch.length !== 1) return null;
    if (/[a-z]/i.test(ch)) return ch.toUpperCase().charCodeAt(0);
    if (/[0-9]/.test(ch)) return ch.charCodeAt(0);
    if (ch === ' ') return 32;
    return null;
  }

  // Yapışkan değiştiricilerle birlikte gönderilecek mesajlar: değiştiriciler bas, tuş (ya da metin), değiştiriciler bırak.
  // key: { vk } ya da { text }.
  function comboMessages(mods, key) {
    const out = mods.map((vk) => ({ t: 'key', vk, down: true }));
    if (key.vk) out.push({ t: 'key', vk: key.vk, down: true }, { t: 'key', vk: key.vk, down: false });
    else if (key.text) out.push({ t: 'text', s: key.text });
    for (const vk of [...mods].reverse()) out.push({ t: 'key', vk, down: false });
    return out;
  }

  // Yapışkan değiştiriciler + kısayolun kendi değiştiricileri (tekrarsız, önce yapışkanlar): Shift yapışkanken Alt+Tab → Shift+Alt+Tab.
  const mergeMods = (sticky, own = []) => [...sticky, ...own.filter((vk) => !sticky.includes(vk))];

  // Kısayollar (SIK: panelin en üstündeki "Sık kullanılanlar", sırasıyla; diğerleri en altta). Kilitle: Windows, programın gönderdiği Win+L'yi yok sayar;
  // (LockWorkStation, yalnızca yönetici) kullanılır.
  const KISAYOLLAR = [
    { k: 'kopyala', ad: 'Kopyala', ipucu: 'Ctrl+C', mods: [17], vk: 67 },
    { k: 'yapistir', ad: 'Yapıştır', ipucu: 'Ctrl+V', mods: [17], vk: 86 },
    { k: 'kes', ad: 'Kes', ipucu: 'Ctrl+X', mods: [17], vk: 88 },
    { k: 'tumu', ad: 'Tümünü seç', ipucu: 'Ctrl+A', mods: [17], vk: 65 },
    { k: 'geri', ad: 'Geri al', ipucu: 'Ctrl+Z', mods: [17], vk: 90 },
    { k: 'yinele', ad: 'Yinele', ipucu: 'Ctrl+Y', mods: [17], vk: 89 },
    { k: 'kaydet', ad: 'Kaydet', ipucu: 'Ctrl+S', mods: [17], vk: 83 },
    { k: 'bul', ad: 'Bul', ipucu: 'Ctrl+F', mods: [17], vk: 70 },
    { k: 'alttab', ad: 'Pencereler', ipucu: 'Alt+Tab', mods: [18], vk: 9 },
    { k: 'altf4', ad: 'Kapat', ipucu: 'Alt+F4', mods: [18], vk: 115, onay: 'Bilgisayardaki etkin pencere kapatılsın mı? (Alt+F4)\n\nKaydedilmemiş işler kaybolabilir.' },
    { k: 'win', ad: 'Başlat', ipucu: 'Win', mods: [], vk: 91 },
    { k: 'masaustu', ad: 'Masaüstü', ipucu: 'Win+D', mods: [91], vk: 68 },
    { k: 'gezgin', ad: 'Gezgin', ipucu: 'Win+E', mods: [91], vk: 69 },
    { k: 'gorev', ad: 'Görev Yön.', ipucu: 'Ctrl+Shift+Esc', mods: [17, 16], vk: 27 },
    { k: 'ekran', ad: 'Ekran alıntısı', ipucu: 'Win+Shift+S', mods: [91, 16], vk: 83 },
    { k: 'kilitle', ad: 'Kilitle', ipucu: 'Win+L', guc: 'kilitle', yonetici: true, onay: 'Bilgisayar kilitlensin mi?\n\nKilitlenince ekran uzaktan görünmez (kilit ekranı desteği henüz yok); açmak için bilgisayarın başında şifre gerekir.' },
  ];

  // Gezinme grubu: 7 sütunlu ızgara; oklar sağda yön tuşu düzeninde. [etiket, vk, { mod, c: sütun, r: satır, s: genişlik, title }]
  const GEZINME = [
    ['Ctrl', 17, { mod: true, c: 1, r: 1 }], ['Alt', 18, { mod: true, c: 2, r: 1 }], ['Shift', 16, { mod: true, c: 3, r: 1 }], ['Win', 91, { mod: true, c: 4, r: 1 }],
    ['Esc', 27, { c: 5, r: 1 }], ['Tab', 9, { c: 6, r: 1 }], ['Del', 46, { c: 7, r: 1, title: 'Delete (sil)' }],
    ['Home', 36, { c: 1, r: 2 }], ['End', 35, { c: 2, r: 2 }], ['⌫', 8, { c: 3, r: 2, s: 2, title: 'Geri sil (Backspace)' }],
    ['↑', 38, { c: 6, r: 2, title: 'Yukarı' }],
    ['PgUp', 33, { c: 1, r: 3 }], ['PgDn', 34, { c: 2, r: 3 }], ['↵ Enter', 13, { c: 3, r: 3, s: 2 }],
    ['←', 37, { c: 5, r: 3, title: 'Sol' }], ['↓', 40, { c: 6, r: 3, title: 'Aşağı' }], ['→', 39, { c: 7, r: 3, title: 'Sağ' }],
  ];
  const F_TUSLARI = Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, 112 + i]);
  const SIK = ['kopyala', 'yapistir', 'geri', 'alttab', 'kes', 'tumu', 'win', 'masaustu'];

  // Node testleri için saf fonksiyonlar (tarayıcıda module yok).
  if (typeof module === 'object' && module.exports) {
    module.exports = { charToVk, comboMessages, mergeMods, MOD_VKS, KISAYOLLAR, GEZINME, F_TUSLARI, SIK };
    return;
  }

  const RC = window.RC;
  if (!RC) return;

  // ---------- PWA ----------
  // Service worker yalnızca güvenli bağlamda (HTTPS / localhost) çalışır; düz HTTP'de sessizce atla.
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service worker kaydedilemedi:', e));
  }

  // ---------- Tuşlar paneli ----------

  // Sekmeler yerine tek kaydırılabilir sayfa (kullanıcı: "tuşları bulmakta zorlanabilir"): en sık kullanılanlar üstte.
  const style = document.createElement('style');
  style.textContent = `
    #tusPanel .rc-panel-ic { padding: 4px 10px 10px; height: var(--tus-yukseklik, 260px); display: block; }
    /* Yatay + klavye (boyutla): görüntüye yer kalsın diye çubuk gizlenir, panel başlığı küçülür; ✕ ile kapanınca geri gelir */
    #vViewer.tus-sikisik #toolbar { display: none; }
    #vViewer.tus-sikisik #tusPanel .rc-panel-bas { padding-top: 0; padding-bottom: 0; }
    #vViewer.tus-sikisik #tusPanel .rc-x { height: 34px; }
    #vViewer.tus-sikisik #tusPanel .rc-panel-ic { padding: 2px 8px 6px; }
    #tusPanel .tus-baslik { max-width: 760px; margin: 12px auto 6px; padding: 0 2px; font-size: 12px; font-weight: 500; color: var(--muted); }
    #tusPanel .tus-baslik:first-child { margin-top: 6px; }
    #tusPanel .tus-baslik small { font-weight: 400; }
    #tusPanel .tus-grup { display: grid; gap: 6px; width: 100%; max-width: 760px; margin: 0 auto; }
    #tusPanel .tus-grup[data-grup="sik"], #tusPanel .tus-grup[data-grup="kisayol"] { grid-template-columns: repeat(4, minmax(0, 1fr)); }
    #tusPanel .tus-grup[data-grup="gezinme"] { grid-template-columns: repeat(7, minmax(0, 1fr)); grid-template-rows: repeat(3, 44px); }
    #tusPanel .tus-grup[data-grup="f"] { grid-template-columns: repeat(6, minmax(0, 1fr)); }
    @media (min-width: 720px) {
      #tusPanel .tus-grup[data-grup="sik"], #tusPanel .tus-grup[data-grup="kisayol"] { grid-template-columns: repeat(8, minmax(0, 1fr)); }
      #tusPanel .tus-grup[data-grup="f"] { grid-template-columns: repeat(12, minmax(0, 1fr)); }
    }
    #tusPanel .tus-grup button { min-width: 0; min-height: 44px; padding: 2px 4px; border-radius: 8px; font-size: 15px; font-weight: 500; color: var(--text);
      background: var(--panel2); border: 1px solid var(--line); line-height: 1.15; overflow: hidden; }
    #tusPanel .tus-grup button:active { background: var(--panel3); }
    #tusPanel .tus-grup button.mod { color: #9ab8ff; border-color: var(--line2); }
    #tusPanel .tus-grup button.on { background: var(--accent); border-color: var(--accent); color: #fff; }
    #tusPanel .tus-grup button.ok { font-size: 20px; }
    #tusPanel .tus-grup[data-grup="sik"] button, #tusPanel .tus-grup[data-grup="kisayol"] button { display: grid; align-content: center; gap: 1px; padding: 4px 2px; }
    #tusPanel .tus-grup b { font-weight: 500; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #tusPanel .tus-grup small { color: var(--muted); font-size: 10.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #tusPanel .tus-grup button.dikkat b { color: var(--error); }
  `;
  document.head.appendChild(style);

  const kbInput = document.getElementById('kbInput');

  // Araç çubuğu düğmesi (⌨'nin hemen yanında)
  const toggle = document.createElement('button');
  toggle.id = 'tusBtn';
  toggle.className = 'ctl'; // salt izleme rolünde çekirdek gizler
  toggle.title = 'Özel tuşlar: kısayollar, Ctrl/Alt/Shift/Win, oklar, F1–F12';
  toggle.setAttribute('aria-label', 'Özel tuşlar');
  toggle.innerHTML = `${window.RCIkon ? RCIkon.svg('command') : ''}<span class="al">Tuşlar</span>`;
  document.getElementById('kbBtn').after(toggle);

  const panel = RC.ui.panel('Özel tuşlar', {
    id: 'tusPanel', dock: 'bottom', className: 'ctl', anchor: toggle,
    onOpen() { toggle.classList.add('on'); boyutla(); },
    onClose() { toggle.classList.remove('on'); clearSticky(); boyutSifirla(); },
  });

  // Bölüm: başlık + düğme ızgarası (data-grup: sik | gezinme | f | kisayol)
  const grup = (ad, baslik) => {
    const h = document.createElement('h4');
    h.className = 'tus-baslik';
    h.innerHTML = baslik;
    panel.body.appendChild(h);
    const g = document.createElement('div');
    g.className = 'tus-grup';
    g.dataset.grup = ad;
    panel.body.appendChild(g);
    return g;
  };
  const tusDugmesi = (etiket, vk, o = {}) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = etiket;
    b.dataset.vk = vk;
    if (o.title) b.title = o.title;
    if (o.c) b.style.gridColumn = `${o.c} / span ${o.s || 1}`;
    if (o.r) b.style.gridRow = String(o.r);
    if (/^[←↑↓→]$/.test(etiket)) b.classList.add('ok');
    return b;
  };
  const kisayolDugmesi = (k) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.kisayol = k.k;
    b.title = `${k.ad} (${k.ipucu})`;
    b.innerHTML = `<b>${RC.esc(k.ad)}</b><small>${RC.esc(k.ipucu)}</small>`;
    if (k.onay) b.classList.add('dikkat');
    if (k.yonetici) b.dataset.yonetici = '1';
    return b;
  };

  // (a) Sık kullanılanlar
  const gSik = grup('sik', 'Sık kullanılanlar');
  for (const ad of SIK) gSik.appendChild(kisayolDugmesi(KISAYOLLAR.find((k) => k.k === ad)));
  // (b) Değiştiriciler + gezinme + oklar
  const gGezinme = grup('gezinme', 'Tuşlar ve oklar <small>· Ctrl, Alt, Shift, Win: dokun, sonra diğer tuşa bas</small>');
  const modButtons = new Map(); // vk -> düğme
  for (const [etiket, vk, o] of GEZINME) {
    const b = tusDugmesi(etiket, vk, o);
    if (o.mod) {
      b.dataset.mod = '1';
      b.classList.add('mod');
      b.title = `${etiket} (yapışkan: sonraki tuşla birlikte basılır, ikinci dokunuş bırakır)`;
      modButtons.set(vk, b);
    }
    gGezinme.appendChild(b);
  }
  // (c) F1–F12
  const gF = grup('f', 'F tuşları');
  for (const [etiket, vk] of F_TUSLARI) gF.appendChild(tusDugmesi(etiket, vk));
  // (d) Diğer kısayollar
  const gKisayol = grup('kisayol', 'Diğer kısayollar');
  for (const k of KISAYOLLAR) if (!SIK.includes(k.k)) gKisayol.appendChild(kisayolDugmesi(k));

  // Ekran klavyesi açıkken (iPhone'da görünür alan küçülür) panel görüntüyü tamamen kapatmasın: görüntüye en az
  // SAHNE_MIN px bırakılır, panel gövdesi gerekirse tek sıraya (kaydırılabilir) iner. Yatay iPhone'da klavye açıkken
  // görünür alan ~150 px kalır; o zaman araç çubuğu gizlenir ve panel başlığı küçülür (tus-sikisik), panel kapanınca
  // ya da yer açılınca çubuk geri gelir. Klavye açıkken ev göstergesi klavyenin altında kaldığı için safe-area alt
  // boşluğu kaldırılır.
  const SAHNE_MIN = 90, GOVDE_MIN = 52;
  const toolbarEl = document.getElementById('toolbar');
  const vViewerEl = document.getElementById('vViewer');
  function boyutla() {
    const layoutH = document.documentElement.clientHeight || window.innerHeight;
    const a = window.Dokunmatik?.visibleArea(window.visualViewport, layoutH);
    const vh = a ? a.height : layoutH;
    panel.el.style.paddingBottom = a && a.covered > 80 ? '0px' : '';
    vViewerEl.classList.remove('tus-sikisik');
    const ideal = Math.max(104, Math.min(260, Math.round(vh * 0.42) - 50));
    // Panel başlığı + alt boşluk + üst kenarlık
    const disi = () => panel.head.offsetHeight + (parseFloat(getComputedStyle(panel.el).paddingBottom) || 0) + 1;
    const alt = document.getElementById('altCubuk')?.offsetHeight || 0; // telefonda alt çubuk (Klavye, Tuşlar, …)
    let h = Math.min(ideal, vh - toolbarEl.offsetHeight - alt - disi() - SAHNE_MIN);
    if (h < GOVDE_MIN + 8 && toolbarEl.offsetHeight) {
      vViewerEl.classList.add('tus-sikisik');
      h = Math.min(ideal, vh - disi() - SAHNE_MIN);
    }
    panel.el.style.setProperty('--tus-yukseklik', `${Math.max(GOVDE_MIN, Math.round(h))}px`);
  }
  function boyutSifirla() {
    vViewerEl.classList.remove('tus-sikisik');
    panel.el.style.paddingBottom = '';
  }
  window.visualViewport?.addEventListener('resize', () => { if (panel.isOpen()) boyutla(); });
  window.addEventListener('resize', () => { if (panel.isOpen()) boyutla(); });

  const sticky = new Set(); // basılı tutulacak değiştiriciler (vk), seçilme sırasıyla

  // Basılı (yapışkan) değiştiriciler düğmede ve panel başlığında görünür (sayfa kaydırılınca da belli olsun).
  function stickyGoster() {
    for (const [vk, b] of modButtons) b.classList.toggle('on', sticky.has(vk));
    const adlar = [...sticky].map((vk) => GEZINME.find((t) => t[1] === vk)?.[0]).filter(Boolean);
    panel.setTitle(adlar.length ? `Özel tuşlar · ${adlar.join(' + ')} basılı` : 'Özel tuşlar');
  }
  function clearSticky() {
    sticky.clear();
    stickyGoster();
  }

  const isAdmin = () => RC.state().me?.role === 'admin';
  function refresh() {
    const st = RC.state();
    const usable = !!st.stream && st.me?.role !== 'view';
    if (!usable) panel.close();
    panel.body.querySelectorAll('[data-yonetici]').forEach((b) => { b.hidden = !isAdmin(); });
  }

  toggle.addEventListener('click', () => {
    if (!RC.state().stream) return;
    panel.toggle();
  });
  RC.on('viewer:start', refresh);
  RC.on('viewer:stop', refresh);
  RC.on('auth', refresh);
  RC.on('disconnect', clearSticky);

  function sendCombo(key, own = []) {
    for (const m of comboMessages(mergeMods([...sticky], own), key)) RC.send(m);
    clearSticky();
  }

  // Ekran klavyesi açıksa düğmeye basınca kapanmasın: odak kbInput'ta kalsın.
  let kbWasFocused = false;
  panel.el.addEventListener('pointerdown', () => { kbWasFocused = document.activeElement === kbInput; });
  panel.el.addEventListener('mousedown', (e) => e.preventDefault());
  panel.el.addEventListener('click', (e) => {
    if (kbWasFocused && document.activeElement !== kbInput && !e.target.closest('.rc-x')) kbInput.focus();
    const kb = e.target.closest('button[data-kisayol]');
    if (kb) {
      const k = KISAYOLLAR.find((x) => x.k === kb.dataset.kisayol);
      if (!k || !RC.canInput()) return;
      if (k.onay && !confirm(k.onay)) { clearSticky(); return; }
      if (k.guc) { clearSticky(); RC.send({ t: 'guc', islem: k.guc }); return; }
      sendCombo({ vk: k.vk }, k.mods);
      return;
    }
    const b = e.target.closest('button[data-vk]');
    if (!b || !RC.canInput()) return;
    const vk = Number(b.dataset.vk);
    if (b.dataset.mod) {
      // Değiştirici: aç/kapat (ikinci dokunuş iptal eder).
      if (sticky.has(vk)) sticky.delete(vk); else sticky.add(vk);
      stickyGoster();
      return;
    }
    sendCombo({ vk });
  });

  // Yapışkan değiştirici seçiliyken ekran klavyesiyle yazılanlar onunla birlikte gönderilir.
  // window'da yakalama aşamasında dinlenir: çekirdeğin kbInput dinleyicisinden önce çalışır.
  window.addEventListener('beforeinput', (e) => {
    if (e.target !== kbInput || !sticky.size || !RC.canInput()) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.inputType === 'insertText' || e.inputType === 'insertCompositionText' || e.inputType === 'insertReplacementText') {
      const ch = [...(e.data || '')].pop(); // yalnızca son karakter: kısayol tek tuştur
      if (!ch) return;
      const vk = charToVk(ch);
      sendCombo(vk ? { vk } : { text: ch });
    } else if (e.inputType === 'deleteContentBackward') {
      sendCombo({ vk: 8 });
    } else if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') {
      sendCombo({ vk: 13 });
    }
  }, true);

  // Bazı ekran klavyeleri (ve fiziksel klavyeler) gerçek tuş kodu gönderir.
  window.addEventListener('keydown', (e) => {
    if (!sticky.size || !RC.canInput()) return;
    const vk = e.keyCode;
    if (!vk || vk === 229 || e.key === 'Unidentified' || MOD_VKS.has(vk) || vk === 92) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const fromChar = e.key.length === 1 ? charToVk(e.key) : null;
    if (e.key.length === 1 && !fromChar) sendCombo({ text: e.key });
    else sendCombo({ vk: fromChar || vk });
  }, true);

  refresh();
})();
