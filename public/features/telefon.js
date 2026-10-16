// Telefon deneyimi: mobil tuş çubuğu (yapışkan Ctrl/Alt/Shift/Win, ok tuşları, F1–F12 ...) ve PWA (service worker).
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

  // Node testleri için saf fonksiyonlar (tarayıcıda module yok).
  if (typeof module === 'object' && module.exports) {
    module.exports = { charToVk, comboMessages, MOD_VKS };
    return;
  }

  const RC = window.RC;
  if (!RC) return;

  // ---------- PWA ----------
  // Service worker yalnızca güvenli bağlamda (HTTPS / localhost) çalışır; düz HTTP'de sessizce atla.
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service worker kaydedilemedi:', e));
  }

  // ---------- Tuş çubuğu ----------

  const KEYS = [
    ['Esc', 27], ['Tab', 9],
    ['Ctrl', 17, true], ['Alt', 18, true], ['Shift', 16, true], ['Win', 91, true],
    '|',
    ['←', 37], ['↑', 38], ['↓', 40], ['→', 39],
    '|',
    ['Home', 36], ['End', 35], ['PgUp', 33], ['PgDn', 34], ['Del', 46],
    '|',
    ...Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, 112 + i]),
  ];

  const style = document.createElement('style');
  style.textContent = `
    .tus-cubugu { display: flex; gap: 6px; overflow-x: auto; padding: 6px 8px; background: var(--panel); border-top: 1px solid var(--line);
      -webkit-overflow-scrolling: touch; scrollbar-width: none; touch-action: pan-x; user-select: none; -webkit-user-select: none; }
    .tus-cubugu::-webkit-scrollbar { display: none; }
    .tus-cubugu button { flex: 0 0 auto; min-width: 44px; padding: 8px 10px; font-size: 14px; border-radius: 8px;
      background: var(--panel2); border: 1px solid var(--line); }
    .tus-cubugu button.on { background: var(--accent); border-color: var(--accent); }
    .tus-cubugu .ayrac { flex: 0 0 1px; background: var(--line); margin: 4px 2px; }
    #tusBtn.on { background: var(--accent); border-color: var(--accent); }
  `;
  document.head.appendChild(style);

  const kbInput = document.getElementById('kbInput');
  const toolbar = document.getElementById('toolbar');

  const toggle = document.createElement('button');
  toggle.id = 'tusBtn';
  toggle.className = 'ctl touch-only';
  toggle.title = 'Tuş çubuğu (Esc, Ctrl, oklar, F1–F12 ...)';
  toggle.textContent = 'Fn';
  document.getElementById('kbBtn').after(toggle);

  const bar = document.createElement('div');
  bar.className = 'tus-cubugu touch-only';
  bar.hidden = true;
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Özel tuşlar');
  const modButtons = new Map(); // vk -> düğme
  for (const k of KEYS) {
    if (k === '|') {
      const s = document.createElement('span');
      s.className = 'ayrac';
      bar.appendChild(s);
      continue;
    }
    const [label, vk, isMod] = k;
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.dataset.vk = vk;
    if (isMod) { b.dataset.mod = '1'; b.title = `${label} (yapışkan: sonraki tuşla birlikte basılır)`; modButtons.set(vk, b); }
    bar.appendChild(b);
  }
  toolbar.after(bar);

  let open = false;
  try { open = localStorage.getItem('tusCubugu') === '1'; } catch { /* gizli sekme */ }
  const sticky = new Set(); // basılı tutulacak değiştiriciler (vk), seçilme sırasıyla

  function clearSticky() {
    sticky.clear();
    for (const b of modButtons.values()) b.classList.remove('on');
  }

  function refresh() {
    const st = RC.state();
    const usable = !!st.stream && st.stream.mode !== 'extend' && st.me?.role !== 'view';
    bar.hidden = !(open && usable);
    toggle.classList.toggle('on', open);
    if (bar.hidden) clearSticky();
  }

  toggle.addEventListener('click', () => {
    open = !open;
    try { localStorage.setItem('tusCubugu', open ? '1' : '0'); } catch { /* gizli sekme */ }
    refresh();
  });
  RC.on('viewer:start', refresh);
  RC.on('viewer:stop', refresh);
  RC.on('disconnect', clearSticky);

  function sendCombo(key) {
    for (const m of comboMessages([...sticky], key)) RC.send(m);
    clearSticky();
  }

  // Ekran klavyesi açıksa düğmeye basınca kapanmasın: odak kbInput'ta kalsın.
  let kbWasFocused = false;
  bar.addEventListener('pointerdown', () => { kbWasFocused = document.activeElement === kbInput; });
  bar.addEventListener('mousedown', (e) => e.preventDefault());
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-vk]');
    if (!b) return;
    if (kbWasFocused && document.activeElement !== kbInput) kbInput.focus();
    if (!RC.canInput()) return;
    const vk = Number(b.dataset.vk);
    if (b.dataset.mod) {
      // Değiştirici: aç/kapat (ikinci dokunuş iptal eder).
      if (sticky.has(vk)) sticky.delete(vk); else sticky.add(vk);
      b.classList.toggle('on', sticky.has(vk));
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
