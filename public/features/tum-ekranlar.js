// "Tüm ekranlar" görünümünde her ekranın sol üst köşesinde küçük, yarı saydam ad etiketi ("1", "2"). Etikete dokunmak
// (ya da tıklamak) o ekranı tek başına açar; "Tüm ekranlar"a dönüş ⋯ menüsündeki ekran seçicide.
// Neden etiket: tek parmak çift dokunuş tık/çift tık, iki parmak çift dokunuş yakınlaştırmayı 1x'e döndürme olarak zaten
// kullanılıyor; etikete dokunuş görüntüye (bilgisayara) gitmez, başka hareketle çakışmaz.
// Görüntü/eşleme hesapları public/ekranlar.js'te (window.Ekranlar); girdi eşlemesi çekirdekte (app.js send()).
(() => {
  const RC = window.RC;
  const E = window.Ekranlar;
  if (!RC || !E) return;

  const stil = document.createElement('style');
  stil.textContent = `
    #tumEtiketler { position: absolute; inset: 0; pointer-events: none; z-index: 1; }
    .tum-etiket { position: absolute; min-width: 34px; height: 34px; padding: 0 9px; border-radius: 9px; pointer-events: auto;
      background: rgba(10, 12, 16, .5); border: 1px solid rgba(255, 255, 255, .28); color: rgba(255, 255, 255, .9);
      font: 600 15px/32px system-ui, sans-serif; text-align: center; box-shadow: 0 1px 4px rgba(0, 0, 0, .35); }
    .tum-etiket:active { background: rgba(59, 130, 246, .6); }
  `;
  document.head.appendChild(stil);

  const stage = RC.ui.stage();
  const canvas = RC.ui.canvas();
  const katman = document.createElement('div');
  katman.id = 'tumEtiketler';
  katman.hidden = true;
  stage.appendChild(katman);

  let ekranlar = [];

  function aktif() {
    const s = RC.state();
    return !!(s.stream && s.stream.started && s.stream.mode !== 'extend' && s.stream.screen === E.TUM && s.screens.length > 1);
  }

  // Etikete dokunuş görüntüye gitmesin (çekirdeğin dokunma/fare işleyicileri sahnede, etiket onun içinde).
  const yut = (e) => e.stopPropagation();

  function tekEkran(name) {
    const sel = document.getElementById('screenSel');
    if (!sel || ![...sel.options].some((o) => o.value === name)) return;
    sel.value = name;
    sel.dispatchEvent(new Event('change'));
  }

  function kur() {
    katman.replaceChildren();
    katman.hidden = !aktif();
    if (katman.hidden) return;
    ekranlar = RC.state().screens;
    ekranlar.forEach((s, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tum-etiket';
      b.textContent = E.etiket(s, i);
      b.title = `${s.title || `Ekran ${i + 1}`}: tek başına aç`;
      b.setAttribute('aria-label', b.title);
      b.dataset.ekran = s.name;
      for (const t of ['touchstart', 'touchmove', 'touchend', 'touchcancel', 'mousedown', 'mouseup', 'mousemove', 'contextmenu']) {
        b.addEventListener(t, yut);
      }
      b.addEventListener('click', (e) => { e.stopPropagation(); tekEkran(s.name); });
      katman.appendChild(b);
    });
    yerlestir();
  }

  // Etiketler görüntünün (yakınlaştırma dahil) üstünde, ekranın sol üst köşesinde.
  function yerlestir() {
    if (katman.hidden) return;
    const nw = canvas.width, nh = canvas.height;
    const U = E.birlesim(ekranlar);
    katman.style.visibility = nw && nh && U ? '' : 'hidden';
    if (!nw || !nh || !U) return;
    const r = canvas.getBoundingClientRect();
    const st = stage.getBoundingClientRect();
    const k = Math.min(r.width / nw, r.height / nh);
    const w = nw * k, h = nh * k;
    const ox = r.left + (r.width - w) / 2 - st.left, oy = r.top + (r.height - h) / 2 - st.top;
    [...katman.children].forEach((b, i) => {
      const box = E.ekranKutusu(U, ekranlar[i]);
      b.style.left = `${Math.round(ox + box.x * w + 6)}px`;
      b.style.top = `${Math.round(oy + box.y * h + 6)}px`;
    });
  }

  let sirada = false;
  function yerlestirSonra() {
    if (sirada) return;
    sirada = true;
    requestAnimationFrame(() => { sirada = false; yerlestir(); });
  }

  // Kare boyutu (width/height) ve yakınlaştırma (style.transform) değişince.
  new MutationObserver(yerlestirSonra).observe(canvas, { attributes: true, attributeFilter: ['width', 'height', 'style'] });
  window.addEventListener('resize', yerlestirSonra);
  window.visualViewport?.addEventListener('resize', yerlestirSonra);
  RC.on('viewer:start', kur);
  RC.on('ekranlar', kur);
  RC.on('viewer:stop', () => { katman.hidden = true; katman.replaceChildren(); });
})();
