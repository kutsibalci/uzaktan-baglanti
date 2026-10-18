// Kumanda modu: görüntü AKIŞI OLMADAN telefonu bilgisayarın kumandası yapar (bant ve gecikme en az; mobil veride de anında).
// Ana menüde üçüncü kart ("Kumanda", kontrol yetkisi gerekir). Sekmeler:
//   Touchpad — tüm alan touchpad (göreli imleç: tek parmak taşır, dokun = sol tık, iki parmak dokun = sağ tık, uzun bas = sağ tık,
//              çift dokun + sürükle = sürükleme, iki parmak kaydır = tekerlek), altta Sol / Sağ tık düğmeleri (basılı tutulabilir),
//              sağda kaydırma şeridi.
//   Medya    — oynat/duraklat, önceki/sonraki, ses -, ses +, sessiz (Windows medya tuşları).
//   Sunum    — büyük ← / → (PgUp / PgDn), Başlat (F5), Bitir (Esc), Siyah ekran (B).
//   Klavye   — ekran klavyesiyle yazma (metin olarak gider) + Esc, Tab, oklar, ⌫, ↵.
// 'start' GÖNDERİLMEZ: sunucuda görüntüleme yoktur. Girdi { t: 'kumanda', op, ... } mesajıyla gider (features/kumanda.js).
(() => {
  const T = window.Dokunmatik;
  const KAT = 2;             // telefon px -> bilgisayar fiziksel px (ivmeden önce)
  const DOUBLE_TAP_MS = 300; // touchpad: dokunuştan sonra bu sürede dokunup sürüklemek = sol tuşla sürükleme
  const send = (o) => RC.send({ t: 'kumanda', ...o });
  const storage = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* gizli sekme */ } },
  };

  const style = document.createElement('style');
  style.textContent = `
    #kumanda { position: fixed; inset: 0; z-index: 60; background: var(--bg); display: flex; flex-direction: column;
      padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
      -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; touch-action: manipulation; }
    #kumanda button { -webkit-tap-highlight-color: transparent; touch-action: manipulation; }
    .km-bas { display: flex; align-items: center; gap: 8px; padding: 6px 8px; background: var(--panel); border-bottom: 1px solid var(--line); flex: none; }
    .km-bas button { background: var(--panel2); border: 1px solid var(--line); height: 44px; min-width: 44px; padding: 0 12px; }
    .km-bas b { font-size: 17px; }
    .km-durum { margin-left: auto; color: var(--muted); font-size: 12px; text-align: right; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .km-durum.kopuk { color: var(--error); }
    .km-sekmeler { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; padding: 6px 8px; flex: none; }
    .km-sekmeler button { background: transparent; border: 1px solid var(--line); padding: 8px 2px; font-size: 13px; color: var(--muted); display: grid; gap: 2px; justify-items: center; }
    .km-sekmeler button span { font-size: 20px; line-height: 1; }
    .km-sekmeler button.on { background: var(--panel2); color: var(--text); border-color: var(--accent); }
    .km-govde { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 0 8px 8px; gap: 8px; }
    .km-govde[hidden] { display: none !important; }
    .km-pad-alan { flex: 1; min-height: 0; display: flex; gap: 8px; }
    .km-pad { flex: 1; min-width: 0; position: relative; background: var(--panel); border: 1px solid var(--line); border-radius: 16px;
      touch-action: none; display: grid; place-items: center; color: var(--muted); font-size: 13px; text-align: center; padding: 16px; }
    .km-pad.tutuldu { border-color: var(--accent); box-shadow: inset 0 0 0 2px var(--accent); }
    .km-serit { flex: none; width: 56px; background: var(--panel); border: 1px solid var(--line); border-radius: 16px; touch-action: none;
      display: grid; place-items: center; color: var(--muted); font-size: 22px; }
    .km-serit.on { border-color: var(--accent); }
    .km-fare { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; flex: none; }
    .km-fare button { height: 64px; background: var(--panel2); border: 1px solid var(--line); font-size: 16px; }
    .km-fare button.on { background: var(--accent); border-color: var(--accent); }
    .km-izgara { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; align-content: start; }
    .km-izgara button, .km-sunum button, .km-tus button { background: var(--panel2); border: 1px solid var(--line); border-radius: 14px; display: grid; gap: 4px;
      justify-items: center; align-content: center; padding: 10px 4px; font-size: 13px; color: var(--text); }
    .km-izgara button { min-height: 96px; }
    .km-izgara button span, .km-sunum button span { font-size: 30px; line-height: 1; }
    .km-izgara button:active, .km-sunum button:active, .km-tus button:active { background: var(--accent); }
    .km-sunum { flex: 1; min-height: 0; display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: 1fr auto; gap: 8px; }
    .km-sunum .buyuk { min-height: 140px; }
    .km-sunum .buyuk span { font-size: 56px; }
    .km-sunum .alt { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
    .km-sunum .alt button { min-height: 64px; }
    .km-yazi { width: 100%; min-height: 96px; font: inherit; font-size: 16px; resize: none; background: var(--panel); border: 1px solid var(--line); border-radius: 14px;
      color: var(--text); padding: 12px; -webkit-user-select: text; user-select: text; }
    .km-tus { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
    .km-tus button { min-height: 52px; font-size: 16px; }
    .km-not { color: var(--muted); font-size: 12px; margin: 0; }
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
  });

  // ---------- Kumanda ekranı ----------
  const SEKMELER = [['pad', '🖱', 'Touchpad'], ['medya', '⏯', 'Medya'], ['sunum', '📽', 'Sunum'], ['klavye', '⌨', 'Klavye']];
  const kok = document.createElement('div');
  kok.id = 'kumanda';
  kok.hidden = true;
  kok.innerHTML = `
    <header class="km-bas">
      <button id="kmGeri" aria-label="Ana menü" title="Ana menü">←</button>
      <b>Kumanda</b>
      <span class="km-durum" id="kmDurum">görüntü yok · yalnızca girdi</span>
    </header>
    <nav class="km-sekmeler">${SEKMELER.map(([k, i, a]) => `<button data-sekme="${k}"><span>${i}</span>${a}</button>`).join('')}</nav>
    <section class="km-govde" data-govde="pad">
      <div class="km-pad-alan">
        <div class="km-pad" id="kmPad">Kaydır = imleç · dokun = tık · iki parmak dokun / uzun bas = sağ tık<br>çift dokun + sürükle = sürükle · iki parmak kaydır = tekerlek</div>
        <div class="km-serit" id="kmSerit" title="Kaydırma şeridi">⇕</div>
      </div>
      <div class="km-fare">
        <button data-fare="left">Sol tık</button>
        <button data-fare="right">Sağ tık</button>
      </div>
    </section>
    <section class="km-govde" data-govde="medya" hidden>
      <div class="km-izgara">
        <button data-vk="177"><span>⏮</span>Önceki</button>
        <button data-vk="179"><span>⏯</span>Oynat / duraklat</button>
        <button data-vk="176"><span>⏭</span>Sonraki</button>
        <button data-vk="174"><span>🔉</span>Ses −</button>
        <button data-vk="173"><span>🔇</span>Sessiz</button>
        <button data-vk="175"><span>🔊</span>Ses +</button>
      </div>
      <p class="km-not">Windows medya tuşları: çalan uygulamaya (Spotify, YouTube, VLC…) gider.</p>
    </section>
    <section class="km-govde" data-govde="sunum" hidden>
      <div class="km-sunum">
        <button class="buyuk" data-vk="33"><span>←</span>Önceki</button>
        <button class="buyuk" data-vk="34"><span>→</span>Sonraki</button>
        <div class="alt">
          <button data-vk="116"><span>▶</span>Başlat (F5)</button>
          <button data-vk="66"><span>⬛</span>Siyah (B)</button>
          <button data-vk="27"><span>⏹</span>Bitir (Esc)</button>
        </div>
      </div>
    </section>
    <section class="km-govde" data-govde="klavye" hidden>
      <textarea class="km-yazi" id="kmYazi" placeholder="Buraya dokun ve yaz — yazdıkların bilgisayara gider" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false"></textarea>
      <div class="km-tus">
        <button data-vk="27">Esc</button><button data-vk="9">Tab</button><button data-vk="8">⌫</button><button data-vk="13">↵</button>
        <button data-vk="37">←</button><button data-vk="38">↑</button><button data-vk="40">↓</button><button data-vk="39">→</button>
      </div>
    </section>`;
  document.body.appendChild(kok);
  const $k = (sel) => kok.querySelector(sel);
  const durum = $k('#kmDurum');

  let sekme = SEKMELER.some(([k]) => k === storage.get('kumandaSekme')) ? storage.get('kumandaSekme') : 'pad';
  function sekmeSec(k) {
    sekme = k;
    storage.set('kumandaSekme', k);
    for (const b of kok.querySelectorAll('[data-sekme]')) b.classList.toggle('on', b.dataset.sekme === k);
    for (const s of kok.querySelectorAll('[data-govde]')) s.hidden = s.dataset.govde !== k;
    if (k !== 'klavye') $k('#kmYazi').blur();
  }
  kok.querySelector('.km-sekmeler').addEventListener('click', (e) => {
    const b = e.target.closest('[data-sekme]');
    if (b) sekmeSec(b.dataset.sekme);
  });
  sekmeSec(sekme);

  const acik = () => !kok.hidden;
  function ac() {
    if (RC.state().me?.role === 'view') return;
    kok.hidden = false;
    sekmeSec(sekme);
  }
  function kapat() {
    if (kok.hidden) return;
    birakHepsi();
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
  });
  RC.on('auth', () => { durum.textContent = 'görüntü yok · yalnızca girdi'; durum.classList.remove('kopuk'); });

  // ---------- Fare ----------
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
    const k = T.accelGain(Math.hypot(dx, dy) / Math.max(1, dt)) * KAT;
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

  // ---------- Tuşlar (medya, sunum, klavye satırı) ----------
  function key(vk) { send({ op: 'key', vk, down: true }); send({ op: 'key', vk, down: false }); }
  kok.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-vk]');
    if (!b) return;
    key(Number(b.dataset.vk));
    navigator.vibrate?.(10);
  });
  // Klavye satırındaki tuşlar yazı alanından odağı almasın (ekran klavyesi kapanmasın).
  kok.querySelector('.km-tus').addEventListener('pointerdown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
  kok.querySelector('.km-tus').addEventListener('mousedown', (e) => e.preventDefault());

  // ---------- Ekran klavyesi (çekirdekteki gizli giriş alanıyla aynı mantık) ----------
  const yazi = $k('#kmYazi');
  yazi.addEventListener('beforeinput', (e) => {
    e.preventDefault();
    if (e.inputType === 'insertText' || e.inputType === 'insertCompositionText' || e.inputType === 'insertReplacementText') {
      if (e.data) send({ op: 'text', s: e.data });
    } else if (e.inputType === 'deleteContentBackward') {
      key(8);
    } else if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') {
      key(13);
    }
  });
  yazi.addEventListener('input', () => { yazi.value = ''; });
  // Bilgisayar klavyesinden (ör. iPad klavyesi) özel tuşlar: oklar, Esc, Tab, Enter, Backspace.
  const OZEL = new Set([8, 9, 13, 27, 33, 34, 35, 36, 37, 38, 39, 40, 46]);
  yazi.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229 || !OZEL.has(e.keyCode)) return;
    e.preventDefault();
    key(e.keyCode);
  });
})();
