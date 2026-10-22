// Kumanda modu: görüntü AKIŞI OLMADAN telefonu bilgisayarın kumandası yapar (bant ve gecikme en az; mobil veride de anında).
// Ana menüde üçüncü kart ("Kumanda", kontrol yetkisi gerekir). Sekmeler:
//   Touchpad — tüm alan touchpad (göreli imleç: tek parmak taşır, dokun = sol tık, iki parmak dokun = sağ tık, uzun bas = sağ tık,
//              çift dokun + sürükle = sürükleme, iki parmak kaydır = tekerlek), altta İmleç hızı (ana menüdeki "Fare hızı" ile ortak)
//              ve Sol / Sağ tık düğmeleri (basılı tutulabilir), sağda kaydırma şeridi.
//   Medya    — oynat/duraklat, önceki/sonraki, ses -, ses +, sessiz (Windows medya tuşları); altında ses karıştırıcı
//              (public/features/karisim.js varsa: çıkış cihazı ve uygulama sesleri).
//   Sunum    — büyük ← / → (PgUp / PgDn), Başlat (F5), Bitir (Esc), Siyah ekran (B).
//   Klavye   — ekran klavyesiyle yazma (metin olarak gider; yazılan telefonda da görünür) + "Tuşlar" panelindeki başlıklı bölümler
//              (yapışkan Ctrl/Alt/Shift/Win, gezinme tuşları ve oklar, sık kullanılanlar, F1–F12, diğer kısayollar;
//              tanımlar public/features/telefon.js'ten: RC.tuslar).
// 'start' GÖNDERİLMEZ: sunucuda görüntüleme yoktur. Girdi { t: 'kumanda', op, ... } mesajıyla gider (features/kumanda.js).
(() => {
  const T = window.Dokunmatik;
  const KAT = 2;             // telefon px -> bilgisayar fiziksel px (ivmeden önce)
  const DOUBLE_TAP_MS = 300; // touchpad: dokunuştan sonra bu sürede dokunup sürüklemek = sol tuşla sürükleme
  const HIZ_NORMAL = 0.8;    // "Fare hızı" Normal değeri: kumandada çarpan hiz / HIZ_NORMAL (Normal = eski hız)
  const AYNA_EN_COK = 2000;  // yazı alanında tutulan en fazla karakter
  const send = (o) => RC.send({ t: 'kumanda', ...o });
  const ik = (ad) => window.RCIkon?.svg(ad) || '';
  const storage = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* gizli sekme */ } },
  };

  const style = document.createElement('style');
  style.textContent = `
    #kumanda { position: fixed; inset: 0; z-index: 60; background: var(--bg); display: flex; flex-direction: column;
      padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
      -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; touch-action: manipulation; }
    #kumanda.klavye-acik { padding-bottom: 0; }
    #kumanda button { -webkit-tap-highlight-color: transparent; touch-action: manipulation; }
    .km-bas { display: flex; align-items: center; gap: 8px; padding: 6px 8px; background: var(--panel); border-bottom: 1px solid var(--line); flex: none; }
    .km-bas button { background: var(--panel2); border: 1px solid var(--line); height: 44px; min-width: 44px; padding: 0 12px; display: grid; place-items: center; }
    .km-bas b { font-size: 17px; }
    .km-durum { margin-left: auto; color: var(--muted); font-size: 12px; text-align: right; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .km-durum.kopuk { color: var(--error); }
    .km-sekmeler { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; padding: 6px 8px; flex: none; }
    .km-sekmeler button { background: transparent; border: 1px solid var(--line); padding: 8px 2px; font-size: 13px; color: var(--muted); display: grid; gap: 4px; justify-items: center; }
    .km-sekmeler button .svg-ik { width: 20px; height: 20px; }
    .km-sekmeler button.on { background: var(--panel2); color: var(--text); border-color: var(--accent); }
    .km-govde { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 0 8px 8px; gap: 8px; }
    .km-govde[hidden] { display: none !important; }
    .km-pad-alan { flex: 1; min-height: 0; display: flex; gap: 8px; }
    .km-pad { flex: 1; min-width: 0; position: relative; background: var(--panel); border: 1px solid var(--line); border-radius: 16px;
      touch-action: none; display: grid; place-items: center; color: var(--muted); font-size: 13px; text-align: center; padding: 16px; }
    .km-pad.tutuldu { border-color: var(--accent); box-shadow: inset 0 0 0 2px var(--accent); }
    .km-serit { flex: none; width: 56px; background: var(--panel); border: 1px solid var(--line); border-radius: 16px; touch-action: none;
      display: grid; align-content: center; justify-items: center; gap: 2px; color: var(--muted); }
    .km-serit.on { border-color: var(--accent); color: var(--text); }
    .km-hiz { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex: none; color: var(--muted); font-size: 13px; padding: 0 2px; }
    .km-hiz select { height: 36px; min-width: 132px; font: inherit; font-size: 15px; color: var(--text); background: var(--panel2);
      border: 1px solid var(--line); border-radius: 10px; padding: 0 10px; }
    .km-fare { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; flex: none; }
    .km-fare button { height: 64px; background: var(--panel2); border: 1px solid var(--line); font-size: 16px; }
    .km-fare button.on { background: var(--accent); border-color: var(--accent); }
    .km-izgara { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; align-content: start; }
    .km-izgara button, .km-sunum button { background: var(--panel2); border: 1px solid var(--line); border-radius: 14px; display: grid; gap: 6px;
      justify-items: center; align-content: center; padding: 10px 4px; font-size: 13px; color: var(--text); }
    .km-izgara button { min-height: 96px; }
    .km-izgara button .svg-ik, .km-sunum button .svg-ik { width: 30px; height: 30px; }
    .km-izgara button:active, .km-sunum button:active { background: var(--panel3); border-color: var(--accent); }
    .km-sunum { flex: 1; min-height: 0; display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: 1fr auto; gap: 8px; }
    .km-sunum .buyuk { min-height: 140px; }
    .km-sunum .buyuk .svg-ik { width: 56px; height: 56px; stroke-width: 1.5; }
    .km-sunum .alt { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
    .km-sunum .alt button { min-height: 64px; }
    .km-not { color: var(--muted); font-size: 12px; margin: 0; }
    .km-medya { overflow-y: auto; -webkit-overflow-scrolling: touch; overscroll-behavior: contain; }
    .km-karisim:empty { display: none; }
    .km-yazi-alan { position: relative; flex: none; }
    .km-yazi { display: block; width: 100%; height: 84px; font: inherit; font-size: 16px; resize: none; background: var(--panel); border: 1px solid var(--line);
      border-radius: 14px; color: var(--text); padding: 10px 84px 10px 12px; -webkit-user-select: text; user-select: text; }
    .km-yazi:focus { outline: none; border-color: var(--accent); }
    .km-temizle { position: absolute; top: 8px; right: 8px; height: 32px; padding: 0 10px; font-size: 12px; color: var(--muted);
      background: var(--panel2); border: 1px solid var(--line); border-radius: 8px; }
    .km-temizle[hidden] { display: none; }
    .km-tuslar { flex: 1; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch; overscroll-behavior: contain; padding-bottom: 4px; }
    .km-tuslar h4 { margin: 12px 2px 6px; font-size: 12px; font-weight: 500; color: var(--muted); }
    .km-tuslar h4:first-child { margin-top: 2px; }
    .km-tuslar h4 small { font-weight: 400; font-size: 12px; }
    .km-tuslar h4 small.basili { color: #9ab8ff; }
    .km-grup { display: grid; gap: 6px; }
    .km-grup[data-grup="sik"], .km-grup[data-grup="kisayol"] { grid-template-columns: repeat(4, minmax(0, 1fr)); }
    .km-grup[data-grup="gezinme"] { grid-template-columns: repeat(7, minmax(0, 1fr)); grid-template-rows: repeat(3, 46px); }
    .km-grup[data-grup="f"] { grid-template-columns: repeat(6, minmax(0, 1fr)); }
    @media (min-width: 720px) {
      .km-grup[data-grup="sik"], .km-grup[data-grup="kisayol"] { grid-template-columns: repeat(8, minmax(0, 1fr)); }
      .km-grup[data-grup="f"] { grid-template-columns: repeat(12, minmax(0, 1fr)); }
    }
    .km-grup button { min-width: 0; min-height: 46px; padding: 2px 4px; border-radius: 10px; font-size: 15px; font-weight: 500; color: var(--text);
      background: var(--panel2); border: 1px solid var(--line); line-height: 1.15; overflow: hidden; }
    .km-grup button:active { background: var(--panel3); }
    .km-grup button.mod { color: #9ab8ff; border-color: var(--line2); }
    .km-grup button.on { background: var(--accent); border-color: var(--accent); color: #fff; }
    .km-grup button.ok { font-size: 20px; }
    .km-grup[data-grup="sik"] button, .km-grup[data-grup="kisayol"] button { display: grid; align-content: center; gap: 1px; padding: 6px 2px; min-height: 52px; }
    .km-grup b { font-weight: 500; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .km-grup small { color: var(--muted); font-size: 10.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .km-grup button.dikkat b { color: var(--error); }
  `;
  document.head.appendChild(style);

  // ---------- Ana menü kartı ----------
  const kart = document.createElement('button');
  kart.className = 'mode';
  kart.id = 'modeKumanda';
  kart.innerHTML = '<span class="icon">🎮</span><b>Kumanda</b><small id="kumandaHint">Görüntüsüz: touchpad, medya, sunum, klavye</small>';
  document.querySelector('#vHome .modes').appendChild(kart);
  RC.on('auth', (me) => {
    kart.disabled = me.role === 'view';
    kart.querySelector('small').textContent = me.role === 'view' ? 'Kontrol yetkisi gerekiyor' : 'Görüntüsüz: touchpad, medya, sunum, klavye';
    if (me.role === 'view') kapat();
    for (const b of kok.querySelectorAll('[data-yonetici]')) b.hidden = me.role !== 'admin';
  });

  // ---------- Kumanda ekranı ----------
  const SEKMELER = [['pad', 'mouse', 'Touchpad'], ['medya', 'playPause', 'Medya'], ['sunum', 'presentation', 'Sunum'], ['klavye', 'keyboard', 'Klavye']];
  const HIZLAR = [['0.5', 'Çok yavaş'], ['0.65', 'Yavaş'], ['0.8', 'Normal'], ['1', 'Hızlı'], ['1.3', 'Çok hızlı']];
  const kok = document.createElement('div');
  kok.id = 'kumanda';
  kok.hidden = true;
  kok.innerHTML = `
    <header class="km-bas">
      <button id="kmGeri" aria-label="Ana menü" title="Ana menü">${ik('arrowLeft') || '←'}</button>
      <b>Kumanda</b>
      <span class="km-durum" id="kmDurum">görüntü yok · yalnızca girdi</span>
    </header>
    <nav class="km-sekmeler">${SEKMELER.map(([k, i, a]) => `<button data-sekme="${k}">${ik(i)}${a}</button>`).join('')}</nav>
    <section class="km-govde" data-govde="pad">
      <div class="km-pad-alan">
        <div class="km-pad" id="kmPad">Kaydır = imleç · dokun = tık · iki parmak dokun / uzun bas = sağ tık<br>çift dokun + sürükle = sürükle · iki parmak kaydır = tekerlek</div>
        <div class="km-serit" id="kmSerit" title="Kaydırma şeridi">${ik('chevronUp')}${ik('chevronDown')}</div>
      </div>
      <label class="km-hiz">İmleç hızı
        <select id="kmHiz">${HIZLAR.map(([v, a]) => `<option value="${v}"${v === '0.8' ? ' selected' : ''}>${a}</option>`).join('')}</select>
      </label>
      <div class="km-fare">
        <button data-fare="left">Sol tık</button>
        <button data-fare="right">Sağ tık</button>
      </div>
    </section>
    <section class="km-govde km-medya" data-govde="medya" hidden>
      <div class="km-izgara">
        <button data-vk="177">${ik('skipBack')}Önceki</button>
        <button data-vk="179">${ik('playPause')}Oynat / duraklat</button>
        <button data-vk="176">${ik('skipForward')}Sonraki</button>
        <button data-vk="174">${ik('volumeDown')}Ses −</button>
        <button data-vk="173">${ik('volumeOff')}Sessiz</button>
        <button data-vk="175">${ik('volume')}Ses +</button>
      </div>
      <p class="km-not">Windows medya tuşları: çalan uygulamaya (Spotify, YouTube, VLC…) gider.</p>
      <div class="km-karisim" id="kmKarisim"></div>
    </section>
    <section class="km-govde" data-govde="sunum" hidden>
      <div class="km-sunum">
        <button class="buyuk" data-vk="33">${ik('arrowLeft')}Önceki</button>
        <button class="buyuk" data-vk="34">${ik('arrowRight')}Sonraki</button>
        <div class="alt">
          <button data-vk="116">${ik('play')}Başlat (F5)</button>
          <button data-vk="66">${ik('square')}Siyah (B)</button>
          <button data-vk="27">${ik('stop')}Bitir (Esc)</button>
        </div>
      </div>
    </section>
    <section class="km-govde" data-govde="klavye" hidden>
      <div class="km-yazi-alan">
        <textarea class="km-yazi" id="kmYazi" placeholder="Buraya dokun ve yaz — her harf anında bilgisayara gider" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false"></textarea>
        <button type="button" class="km-temizle" id="kmTemizle" title="Telefondaki yazıyı temizler (bilgisayardakini silmez)" hidden>Temizle</button>
      </div>
      <div class="km-tuslar" id="kmTuslar"></div>
    </section>`;
  document.body.appendChild(kok);
  const $k = (sel) => kok.querySelector(sel);
  const durum = $k('#kmDurum');
  // iOS Safari dokunuşta :active'i yalnızca touchstart dinleyicisi olan öğelerde uygular (basınca kısa geri bildirim).
  kok.addEventListener('touchstart', () => {}, { passive: true });

  let sekme = SEKMELER.some(([k]) => k === storage.get('kumandaSekme')) ? storage.get('kumandaSekme') : 'pad';
  function sekmeSec(k) {
    sekme = k;
    storage.set('kumandaSekme', k);
    for (const b of kok.querySelectorAll('[data-sekme]')) b.classList.toggle('on', b.dataset.sekme === k);
    for (const s of kok.querySelectorAll('[data-govde]')) s.hidden = s.dataset.govde !== k;
    if (k !== 'klavye') { $k('#kmYazi').blur(); stickyTemizle(); }
    // Bölümler ilk açılışta kurulur: diğer özellik dosyaları (telefon.js, karisim.js) bu dosyadan sonra yüklenebilir.
    if (acik() && k === 'klavye') klavyeKur();
    if (acik() && k === 'medya') karisimKur();
  }
  kok.querySelector('.km-sekmeler').addEventListener('click', (e) => {
    const b = e.target.closest('[data-sekme]');
    if (b) sekmeSec(b.dataset.sekme);
  });

  const acik = () => !kok.hidden;
  function ac() {
    if (RC.state().me?.role === 'view') return;
    kok.hidden = false;
    hizOku();
    sekmeSec(sekme);
    sigdir();
  }
  function kapat() {
    if (kok.hidden) return;
    birakHepsi();
    stickyTemizle();
    send({ op: 'end' });
    kok.hidden = true;
    $k('#kmYazi').blur();
  }
  kart.addEventListener('click', ac);
  $k('#kmGeri').addEventListener('click', kapat);
  RC.on('disconnect', (d) => {
    if (d?.code === 4000) { kapat(); return; }
    durum.textContent = 'Bağlantı koptu, yeniden bağlanılıyor…';
    durum.classList.add('kopuk');
    birakYerel();
    stickyTemizle();
  });
  RC.on('auth', () => { durum.textContent = 'görüntü yok · yalnızca girdi'; durum.classList.remove('kopuk'); });

  // Ekran klavyesi açıkken (iPhone'da görünür alan küçülür) kumanda görünür alana sığdırılır: tuş bölümleri klavyenin
  // altında kalmasın, kaydırılarak hepsine ulaşılsın.
  function sigdir() {
    if (kok.hidden) return;
    const a = T.visibleArea(window.visualViewport, document.documentElement.clientHeight || window.innerHeight);
    const kapali = !a || a.covered <= 80;
    kok.classList.toggle('klavye-acik', !kapali);
    kok.style.top = kapali ? '' : `${a.top}px`;
    kok.style.height = kapali ? '' : `${a.height}px`;
    kok.style.bottom = kapali ? '' : 'auto';
  }
  window.visualViewport?.addEventListener('resize', sigdir);
  window.visualViewport?.addEventListener('scroll', sigdir);

  // ---------- Fare ----------
  // İmleç hızı: ana menüdeki "Fare hızı" ile aynı ayar (localStorage 'fareHizi'); Normal kumandanın eski hızıdır.
  const hizSec = $k('#kmHiz');
  let hizKat = 1;
  function hizOku() {
    const v = storage.get('fareHizi');
    if (HIZLAR.some(([x]) => x === v)) hizSec.value = v;
    hizKat = (Number(hizSec.value) || HIZ_NORMAL) / HIZ_NORMAL;
  }
  hizSec.addEventListener('change', () => {
    storage.set('fareHizi', hizSec.value);
    hizOku();
    // Görüntüleme ekranındaki seçim de aynı değere gelsin (yeniden yüklemeden).
    const ana = document.getElementById('fareHiz');
    if (ana && ana.value !== hizSec.value) { ana.value = hizSec.value; ana.dispatchEvent(new Event('change')); }
  });
  hizOku();

  let relAcc = { dx: 0, dy: 0 }, relQueued = false;
  function flushRel() {
    relQueued = false;
    const dx = Math.round(relAcc.dx), dy = Math.round(relAcc.dy);
    relAcc.dx -= dx; relAcc.dy -= dy;
    if (dx || dy) send({ op: 'rel', dx, dy });
  }
  function rel(dx, dy) {
    relAcc.dx += dx; relAcc.dy += dy;
    if (!relQueued) { relQueued = true; requestAnimationFrame(flushRel); }
  }
  const basili = new Set();
  function down(b) { flushRel(); if (basili.has(b)) return; basili.add(b); send({ op: 'down', b }); }
  function up(b) { if (!basili.delete(b)) return; flushRel(); send({ op: 'up', b }); }
  function click(b, n = 1) { flushRel(); for (let i = 0; i < n; i++) { send({ op: 'down', b }); send({ op: 'up', b }); } }
  function birakHepsi() { for (const b of [...basili]) up(b); fareDugmeleri(); }
  function birakYerel() { basili.clear(); fareDugmeleri(); g = null; } // bağlantı koptu: sunucu zaten bıraktı
  const fareDugmeleri = () => { for (const el of kok.querySelectorAll('[data-fare]')) el.classList.toggle('on', basili.has(el.dataset.fare)); };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && acik()) { birakHepsi(); g = null; } });

  // Sol / Sağ tık düğmeleri: basılı tutulabilir (bir parmakla tut, diğeriyle touchpad'de sürükle).
  for (const el of kok.querySelectorAll('[data-fare]')) {
    const b = el.dataset.fare;
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); down(b); fareDugmeleri(); });
    const birak = () => { up(b); fareDugmeleri(); };
    el.addEventListener('pointerup', birak);
    el.addEventListener('pointercancel', birak);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    // Dokunuştan sonra tarayıcının ürettiği click engellenir: düğme basılıyken kumanda kapanırsa (←) bu click
    // alttaki ana menüye (ör. Yönetim düğmesine) düşüyordu.
    el.addEventListener('touchend', (e) => e.preventDefault(), { passive: false });
  }

  // Touchpad alanı (hesaplar çekirdekteki touchpad moduyla aynı: public/dokunmatik.js)
  const pad = $k('#kmPad');
  let g = null, tapTimer = null;
  function trackMove(h, list) {
    for (const t of list) {
      const s = h.starts.get(t.identifier);
      if (s) h.move = Math.max(h.move, Math.hypot(t.clientX - s.x, t.clientY - s.y));
    }
  }
  function flushTap() { if (!tapTimer) return; clearTimeout(tapTimer); tapTimer = null; click('left'); }
  const midY = (f) => (f[0].clientY + f[1].clientY) / 2;
  // Yalnızca bu alanda başlayan parmaklar (e.touches Sol/Sağ tık düğmesini ya da şeridi tutan parmağı da içerir).
  const icinde = (el, list) => [...list].filter((t) => el.contains(t.target));

  pad.addEventListener('touchstart', (e) => {
    e.preventDefault();
    const f = icinde(pad, e.touches);
    if (f.length >= 2) {
      if (g?.two) return;
      const prev = g && f.some((t) => t.identifier === g.id) ? g : null;
      if (g) { clearTimeout(g.timer); pad.classList.remove('tutuldu'); if (g.dragging) up('left'); }
      flushTap();
      // Dokunuştan hemen sonra gelen iki parmak: ilk parmak inince iptal edilen bekleyen sol tık önce gider.
      if (prev?.second && !prev.moved) click('left');
      const now = Date.now();
      const two = f.slice(0, 2);
      g = {
        two: true, t0: prev ? prev.t0 : now, downGap: prev ? now - prev.t0 : 0, up1: 0, move: 0, acted: !!prev?.dragging, wy: midY(two), acc: 0,
        starts: new Map(two.map((t) => [t.identifier, prev && t.identifier === prev.id ? { x: prev.x0, y: prev.y0 } : { x: t.clientX, y: t.clientY }])),
      };
      trackMove(g, f);
      return;
    }
    if (f.length !== 1 || g) return;
    const t = f[0], now = Date.now();
    const h = { id: t.identifier, x0: t.clientX, y0: t.clientY, x: t.clientX, y: t.clientY, t0: now, time: now, moved: false, held: false, dragging: false, second: !!tapTimer };
    if (tapTimer) { clearTimeout(tapTimer); tapTimer = null; }
    h.timer = setTimeout(() => {
      if (g !== h || h.moved) return;
      h.held = true;
      pad.classList.add('tutuldu');
      navigator.vibrate?.(25);
    }, T.PAD_HOLD_MS);
    g = h;
  }, { passive: false });

  pad.addEventListener('touchmove', (e) => {
    e.preventDefault();
    if (!g) return;
    const f = icinde(pad, e.touches);
    if (g.two) {
      trackMove(g, f);
      if (f.length < 2) return;
      const m = midY(f);
      const w = T.wheelNotches(g.acc + m - g.wy);
      g.acc = w.rest; g.wy = m;
      if (w.n) { send({ op: 'wheel', dy: w.n * 120, dx: 0 }); g.acted = true; }
      return;
    }
    const t = f.find((x) => x.identifier === g.id);
    if (!t) return;
    const now = Date.now();
    let dx = t.clientX - g.x, dy = t.clientY - g.y, dt = now - g.time;
    if (!g.moved) {
      if (Math.hypot(t.clientX - g.x0, t.clientY - g.y0) <= T.TAP_MOVE) return;
      g.moved = true;
      clearTimeout(g.timer);
      g.held = false;
      pad.classList.remove('tutuldu');
      dx = t.clientX - g.x0; dy = t.clientY - g.y0; dt = now - g.t0;
      if (g.second) { g.dragging = true; down('left'); }
    }
    g.x = t.clientX; g.y = t.clientY; g.time = now;
    const k = T.accelGain(Math.hypot(dx, dy) / Math.max(1, dt)) * KAT * hizKat;
    rel(dx * k, dy * k);
  }, { passive: false });

  function padEnd(e) {
    e.preventDefault();
    if (!g) return;
    const left = icinde(pad, e.touches).length, now = Date.now();
    if (g.two && left > 0) { trackMove(g, e.changedTouches); g.up1 = g.up1 || now; return; }
    if (!g.two && left > 0 && ![...e.changedTouches].some((t) => t.identifier === g.id)) return;
    const h = g;
    g = null;
    clearTimeout(h.timer);
    pad.classList.remove('tutuldu');
    if (e.type === 'touchcancel') { if (h.dragging) up('left'); return; }
    if (h.two) {
      trackMove(h, e.changedTouches);
      if (T.isTwoFingerTap({ downGap: h.downGap, upGap: h.up1 ? now - h.up1 : 0, duration: now - h.t0, move: h.move, acted: h.acted })) click('right');
      return;
    }
    if (h.dragging) { up('left'); return; }
    if (h.moved) return;
    if (h.held) { if (h.second) click('left'); click('right'); return; }
    if (h.second) { click('left', T.isTap(0, now - h.t0) ? 2 : 1); return; }
    if (!T.isTap(0, now - h.t0)) return;
    // Tek tık biraz beklenir: hemen ardından dokunup sürüklenirse sol tuşla sürükleme olur.
    tapTimer = setTimeout(() => { tapTimer = null; click('left'); }, DOUBLE_TAP_MS);
  }
  pad.addEventListener('touchend', padEnd, { passive: false });
  pad.addEventListener('touchcancel', padEnd, { passive: false });

  // Kaydırma şeridi: parmağı yukarı it = aşağı kaydır (touchpad'deki iki parmak gibi).
  const serit = $k('#kmSerit');
  let sy = null, sid = null, sacc = 0;
  serit.addEventListener('touchstart', (e) => { e.preventDefault(); sy = e.changedTouches[0].clientY; sid = e.changedTouches[0].identifier; sacc = 0; serit.classList.add('on'); }, { passive: false });
  serit.addEventListener('touchmove', (e) => {
    e.preventDefault();
    if (sy == null) return;
    const t = [...e.touches].find((x) => x.identifier === sid);
    if (!t) return;
    const y = t.clientY;
    const w = T.wheelNotches(sacc + y - sy);
    sacc = w.rest; sy = y;
    if (w.n) send({ op: 'wheel', dy: w.n * 120, dx: 0 });
  }, { passive: false });
  const seritBitti = (e) => {
    e.preventDefault();
    const kalan = icinde(serit, e.touches);
    if (!kalan.length) { sy = null; sid = null; serit.classList.remove('on'); }
    else if (!kalan.some((t) => t.identifier === sid)) { sid = kalan[0].identifier; sy = kalan[0].clientY; }
  };
  serit.addEventListener('touchend', seritBitti, { passive: false });
  serit.addEventListener('touchcancel', seritBitti, { passive: false });

  // ---------- Tuşlar (medya, sunum) ----------
  function key(vk) { send({ op: 'key', vk, down: true }); send({ op: 'key', vk, down: false }); }
  kok.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-vk]');
    if (!b) return;
    key(Number(b.dataset.vk));
    navigator.vibrate?.(10);
  });

  // ---------- Ses karıştırıcı (Medya sekmesinin altında; public/features/karisim.js) ----------
  let karisimHazir = false;
  function karisimKur() {
    if (karisimHazir || !RC.karisim?.mount) return;
    karisimHazir = true;
    RC.karisim.mount($k('#kmKarisim'));
  }

  // ---------- Klavye ----------
  // Yazı alanı gönderilenlerin aynasıdır: yazdığın telefonda görünür (her harf anında bilgisayara gider), imleç hep sonda.
  // Temizle yalnızca telefondakini siler.
  const yazi = $k('#kmYazi');
  const temizle = $k('#kmTemizle');
  let ayna = '';
  function aynala(f) {
    ayna = f(ayna).slice(-AYNA_EN_COK);
    yazi.value = ayna;
    try { yazi.setSelectionRange(ayna.length, ayna.length); } catch { /* odak yok */ }
    yazi.scrollTop = yazi.scrollHeight;
    temizle.hidden = !ayna;
  }
  const yaz = (s) => { send({ op: 'text', s }); aynala((v) => v + s); };
  const sil = () => { key(8); aynala((v) => [...v].slice(0, -1).join('')); };
  const satir = () => { key(13); aynala((v) => `${v}\n`); };
  let temizleOdak = false;
  temizle.addEventListener('pointerdown', () => { temizleOdak = document.activeElement === yazi; });
  temizle.addEventListener('mousedown', (e) => e.preventDefault());
  temizle.addEventListener('click', () => { aynala(() => ''); if (temizleOdak) yazi.focus(); });

  // Yapışkan Ctrl/Alt/Shift/Win (Tuşlar panelindeki gibi): seçiliyken sıradaki tuş ya da yazılan harf onlarla birlikte gider.
  const sticky = new Set();
  const modDugmeleri = new Map(); // vk -> düğme
  let modNot = null;
  function stickyGoster() {
    for (const [vk, b] of modDugmeleri) b.classList.toggle('on', sticky.has(vk));
    if (!modNot) return;
    const adlar = [...sticky].map((vk) => RC.tuslar.GEZINME.find((t) => t[1] === vk)?.[0]).filter(Boolean);
    modNot.textContent = adlar.length ? `· ${adlar.join(' + ')} basılı — sıradaki tuşla birlikte gider` : '· Ctrl, Alt, Shift, Win: dokun, sonra diğer tuşa bas';
    modNot.classList.toggle('basili', adlar.length > 0);
  }
  function stickyTemizle() { if (!sticky.size) return; sticky.clear(); stickyGoster(); }
  function combo(k, own = []) {
    const { comboMessages, mergeMods } = RC.tuslar;
    for (const m of comboMessages(mergeMods([...sticky], own), k)) send(m.t === 'key' ? { op: 'key', vk: m.vk, down: m.down } : { op: 'text', s: m.s });
    stickyTemizle();
  }

  let klavyeHazir = false;
  function klavyeKur() {
    if (klavyeHazir || !RC.tuslar) return;
    klavyeHazir = true;
    const { KISAYOLLAR, GEZINME, F_TUSLARI, SIK } = RC.tuslar;
    const kap = $k('#kmTuslar');
    const grup = (ad, baslik) => {
      const h = document.createElement('h4');
      h.textContent = baslik;
      kap.appendChild(h);
      const el = document.createElement('div');
      el.className = 'km-grup';
      el.dataset.grup = ad;
      kap.appendChild(el);
      return { h, el };
    };
    const tusDugmesi = (etiket, vk, o = {}) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = etiket;
      b.dataset.tus = vk;
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
      if (k.yonetici) { b.dataset.yonetici = '1'; b.hidden = RC.state().me?.role !== 'admin'; }
      return b;
    };
    // Yazarken en çok gerekenler (oklar, ⌫, Enter, değiştiriciler) en üstte.
    const gez = grup('gezinme', 'Tuşlar ve oklar ');
    modNot = document.createElement('small');
    gez.h.appendChild(modNot);
    for (const [etiket, vk, o] of GEZINME) {
      const b = tusDugmesi(etiket, vk, o);
      if (o.mod) {
        b.dataset.mod = '1';
        b.classList.add('mod');
        b.title = `${etiket} (yapışkan: sonraki tuşla birlikte basılır, ikinci dokunuş bırakır)`;
        modDugmeleri.set(vk, b);
      }
      gez.el.appendChild(b);
    }
    const sik = grup('sik', 'Sık kullanılanlar');
    for (const ad of SIK) sik.el.appendChild(kisayolDugmesi(KISAYOLLAR.find((k) => k.k === ad)));
    const f = grup('f', 'F tuşları');
    for (const [etiket, vk] of F_TUSLARI) f.el.appendChild(tusDugmesi(etiket, vk));
    const diger = grup('kisayol', 'Diğer kısayollar');
    for (const k of KISAYOLLAR) if (!SIK.includes(k.k)) diger.el.appendChild(kisayolDugmesi(k));
    stickyGoster();
  }

  // Tuşa basınca ekran klavyesi kapanmasın: odak yazı alanındaysa orada kalır.
  const tuslar = $k('#kmTuslar');
  let odakliydi = false;
  tuslar.addEventListener('pointerdown', () => { odakliydi = document.activeElement === yazi; });
  tuslar.addEventListener('mousedown', (e) => e.preventDefault());
  tuslar.addEventListener('click', (e) => {
    if (odakliydi && document.activeElement !== yazi) yazi.focus();
    const kb = e.target.closest('button[data-kisayol]');
    if (kb) {
      const k = RC.tuslar.KISAYOLLAR.find((x) => x.k === kb.dataset.kisayol);
      if (!k) return;
      if (k.onay && !confirm(k.onay)) { stickyTemizle(); return; }
      if (k.guc) { stickyTemizle(); RC.send({ t: 'guc', islem: k.guc }); return; }
      combo({ vk: k.vk }, k.mods);
      navigator.vibrate?.(10);
      return;
    }
    const b = e.target.closest('button[data-tus]');
    if (!b) return;
    const vk = Number(b.dataset.tus);
    if (b.dataset.mod) {
      if (sticky.has(vk)) sticky.delete(vk); else sticky.add(vk);
      stickyGoster();
      return;
    }
    if (!sticky.size && vk === 8) sil();
    else if (!sticky.size && vk === 13) satir();
    else combo({ vk });
    navigator.vibrate?.(10);
  });

  // Ekran klavyesi (çekirdekteki gizli giriş alanıyla aynı mantık; yapışkan değiştirici varsa son harf kısayol olur)
  yazi.addEventListener('beforeinput', (e) => {
    e.preventDefault();
    const metin = e.inputType === 'insertText' || e.inputType === 'insertCompositionText' || e.inputType === 'insertReplacementText';
    const geri = e.inputType === 'deleteContentBackward';
    const enter = e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph';
    if (sticky.size) {
      const ch = metin ? [...(e.data || '')].pop() : null;
      if (ch) { const vk = RC.tuslar.charToVk(ch); combo(vk ? { vk } : { text: ch }); }
      else if (geri) combo({ vk: 8 });
      else if (enter) combo({ vk: 13 });
      return;
    }
    if (metin) { if (e.data) yaz(e.data); }
    else if (geri) sil();
    else if (enter) satir();
  });
  // İptal edilemeyen girdi (bazı klavyelerde birleştirme) alanı değiştirirse ayna geri konur.
  yazi.addEventListener('input', () => { if (yazi.value !== ayna) aynala((v) => v); });
  // Bilgisayar klavyesinden (ör. iPad klavyesi) özel tuşlar: oklar, Esc, Tab, Enter, Backspace.
  const OZEL = new Set([8, 9, 13, 27, 33, 34, 35, 36, 37, 38, 39, 40, 46]);
  yazi.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229 || !OZEL.has(e.keyCode)) return;
    e.preventDefault();
    if (sticky.size) combo({ vk: e.keyCode });
    else if (e.keyCode === 8) sil();
    else if (e.keyCode === 13) satir();
    else key(e.keyCode);
  });

  sekmeSec(sekme);
})();
