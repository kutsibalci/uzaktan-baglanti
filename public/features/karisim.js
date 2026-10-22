// Ses karıştırıcı (Windows Ses Karıştırıcısı gibi): çıkış cihazı seçimi, cihaz ses seviyesi / sessiz, uygulama başına ses seviyesi / sessiz.
//   RC.karisim.mount(el)  -> el'i karıştırıcıyla doldurur (aynı öğe için bir kez; { el, yenile() } döner). Kumanda'nın Medya sekmesi kullanır.
//     Betikler eşzamansız yüklendiği için kap öğesine data-karisim da verilebilir: bu betik sonra yüklenirse onu kendisi bağlar.
//   Görüntüleyicide ⋯ menü > Daha fazla > "Ses karıştırıcı" (paneli açar).
// Kap görünür kaldıkça 3 sn'de bir yenilenir; parmak altındaki (ve az önce gönderilmiş) kaydırıcıya gelen güncelleme onu zıplatmaz.
// Kaydırıcı sürüklerken en sık 70 ms'de bir gönderilir, bırakınca son değer hemen. Dokunmatikte çubuğa dokunmak o noktaya atlar
// (iOS Safari kendiliğinden yalnızca topuzu sürükletir), dikey kaydırma sayfayı kaydırır. Sunucu: features/karisim.js.
(() => {
  const RC = window.RC;
  if (!RC) return;
  const YENILE_MS = 3000;
  const GONDER_MS = 70;
  const KILIT_MS = 1200;  // son gönderimden sonra bu süre gelen değer kaydırıcıya / düğmeye yazılmaz (eski liste zıplatmasın)
  const TOPUZ = 26;       // kaydırıcı topuzu (px; aşağıdaki CSS ile aynı)

  const style = document.createElement('style');
  style.textContent = `
    .kr { display: grid; gap: 10px; min-width: 0; }
    .kr-bas { display: flex; align-items: center; gap: 8px; min-height: 32px; }
    .kr-bas h4 { margin: 0; flex: 1; font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: .5px; }
    .kr-bas button { flex: none; }
    .kr-satir { display: grid; gap: 2px; padding: 6px 10px 2px; border-radius: 10px; background: var(--panel2); border: 1px solid var(--line); min-width: 0; }
    .kr-ad { font-size: 14px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-top: 2px; }
    .kr-satir select { width: 100%; min-height: 44px; margin-top: 2px; font-size: 15px; text-overflow: ellipsis; }
    .kr-kontrol { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .kr-sessiz { flex: none; width: 44px; height: 44px; min-height: 0; padding: 0; display: grid; place-items: center; margin-left: -6px;
      background: transparent; border: 0; border-radius: 10px; color: var(--text); }
    .kr-sessiz .svg-ik { width: 22px; height: 22px; }
    .kr-sessiz:hover:not(:disabled) { background: var(--panel3); }
    .kr-sessiz[aria-pressed=true] { color: var(--muted); }
    .kr-kaydirici { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; touch-action: pan-y; cursor: pointer; -webkit-tap-highlight-color: transparent; }
    .kr input[type=range] { -webkit-appearance: none; appearance: none; flex: 1 1 auto; min-width: 0; width: 100%; height: 44px; margin: 0; padding: 0;
      background: transparent; border: 0; border-radius: 0; box-shadow: none; pointer-events: none; --o: 0; --dolu: var(--accent); }
    .kr input[type=range]:focus { box-shadow: none; }
    .kr input[type=range]::-webkit-slider-runnable-track { height: 6px; border-radius: 3px;
      background: linear-gradient(to right, var(--dolu) calc(${TOPUZ / 2}px + (100% - ${TOPUZ}px) * var(--o)), var(--line2) 0); }
    .kr input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: ${TOPUZ}px; height: ${TOPUZ}px; margin-top: ${(6 - TOPUZ) / 2}px;
      border-radius: 50%; background: #fff; border: 0; box-shadow: 0 1px 4px rgba(0, 0, 0, .5); }
    .kr input[type=range]:focus-visible::-webkit-slider-thumb { box-shadow: var(--ring); }
    .kr input[type=range]::-moz-range-track { height: 6px; border-radius: 3px; background: var(--line2); }
    .kr input[type=range]::-moz-range-progress { height: 6px; border-radius: 3px; background: var(--dolu); }
    .kr input[type=range]::-moz-range-thumb { width: ${TOPUZ}px; height: ${TOPUZ}px; border-radius: 50%; background: #fff; border: 0; }
    .kr-satir.sessiz input[type=range] { --dolu: var(--muted); }
    .kr-yuzde { flex: none; width: 42px; text-align: right; font-size: 13px; color: var(--muted); font-variant-numeric: tabular-nums; }
    .kr-satir.sessiz .kr-yuzde { text-decoration: line-through; }
    .kr-not { margin: 0; font-size: 12.5px; color: var(--muted); }
    .kr-liste { display: grid; gap: 6px; }
    .kr-bos { margin: 0; font-size: 13px; color: var(--muted); }
    .kr-msg { margin: 0; font-size: 13.5px; color: var(--error); }
    .kr-msg:empty { display: none; }
    .rc-panel.drop.karisim-panel { width: min(420px, calc(100vw - 16px)); }
  `;
  document.head.appendChild(style);

  const ornekler = new Set();
  let son = null; // son liste (yeni bağlanan kap hemen çizilsin)
  let sayac = 0;
  const kontrolYetkisi = () => { const r = RC.state().me?.role; return r === 'control' || r === 'admin'; };
  const gorunur = (el) => el.isConnected && el.getClientRects().length > 0;
  const iste = () => { if (RC.state().connected && kontrolYetkisi()) RC.send({ t: 'karisim-al' }); };

  RC.on('karisim', (m) => { son = m; for (const o of ornekler) o.ciz(m); });
  RC.on('karisim-hata', (m) => { for (const o of ornekler) o.mesaj(m.msg || 'Ayar uygulanamadı.'); });
  RC.on('auth', () => { if ([...ornekler].some((o) => gorunur(o.el))) iste(); });

  // Görünür kap varken 3 sn'de bir (sekme arka plandayken değil). Aynı anda birden çok kap görünse de tek istek.
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if ([...ornekler].some((o) => gorunur(o.el))) iste();
  }, YENILE_MS);

  // Kaydırıcı: sürüklerken sınırlı gönderim. İşaretçi olaylarını input'un kendisi değil sarmalayıcısı (alan) alır (input'ta
  // pointer-events: none; klavye ve ekran okuyucu yine input'u kullanır): yerel kaydırıcı Chrome'da dokunur dokunmaz o noktaya atlıyor
  // (listeyi kaydırmak isteyen parmak sesi değiştiriyordu), iOS'ta ise yalnızca topuz sürükleniyor. Burada her yerde aynı: dokunuş = o nokta,
  // yatay sürükleme = parmağı izler, dikey hareket = sayfa kayar (touch-action: pan-y), fare = basınca o nokta + sürükleme.
  // Dönen yaz(v) dışarıdan gelen değeri yazar (parmak altındaysa ya da az önce gönderildiyse yazmaz).
  function kaydirici(alan, inp, out, gonder) {
    let p0 = null, timer = null, bekleyen = null, sonGonderim = 0, sonDeger = null;
    const goster = (v) => { inp.value = String(v); inp.style.setProperty('--o', String(v / 100)); out.textContent = `%${v}`; };
    function yolla(v) {
      clearTimeout(timer);
      timer = null;
      bekleyen = null;
      if (v === sonDeger) return; // değişmedi (ör. kaydırıcı üstünde dikey kaydırma): gönderilmez, kilitlenmez
      sonDeger = v;
      sonGonderim = Date.now();
      gonder(v);
    }
    function planla(v, hemen) {
      if (hemen || Date.now() - sonGonderim >= GONDER_MS) { yolla(v); return; }
      bekleyen = v;
      if (!timer) timer = setTimeout(() => yolla(bekleyen), GONDER_MS - (Date.now() - sonGonderim));
    }
    inp.addEventListener('input', () => { const v = Number(inp.value); goster(v); planla(v, false); });
    inp.addEventListener('change', () => planla(Number(inp.value), true));
    const konumdan = (x) => {
      const r = inp.getBoundingClientRect();
      const v = Math.round(Math.min(1, Math.max(0, (x - r.left - TOPUZ / 2) / Math.max(1, r.width - TOPUZ))) * 100);
      if (v !== Number(inp.value)) { goster(v); planla(v, false); }
    };
    const yakala = (id) => { try { alan.setPointerCapture(id); } catch { /* işaretçi bitti */ } };
    alan.addEventListener('pointerdown', (e) => {
      if (p0 || e.button > 0) return;
      p0 = { id: e.pointerId, x: e.clientX, y: e.clientY, yatay: e.pointerType === 'mouse' };
      if (p0.yatay) { e.preventDefault(); yakala(e.pointerId); inp.focus({ preventScroll: true }); konumdan(e.clientX); }
    });
    alan.addEventListener('pointermove', (e) => {
      if (!p0 || e.pointerId !== p0.id) return;
      const dx = Math.abs(e.clientX - p0.x);
      if (!p0.yatay && dx > 4 && dx >= Math.abs(e.clientY - p0.y)) { p0.yatay = true; yakala(e.pointerId); }
      if (p0.yatay) konumdan(e.clientX);
    });
    const birak = (e) => {
      if (!p0 || e.pointerId !== p0.id) return;
      const p = p0;
      p0 = null;
      // Dokunuş (kaydırmadan bırakıldı): o noktaya. pointercancel = tarayıcı sayfayı kaydırmaya başladı: değer değişmez.
      if (e.type === 'pointerup' && !p.yatay && Math.hypot(e.clientX - p.x, e.clientY - p.y) < 10) konumdan(e.clientX);
      planla(Number(inp.value), true); // bekleyen son değer hemen (değişmediyse gönderilmez)
    };
    alan.addEventListener('pointerup', birak);
    alan.addEventListener('pointercancel', birak);
    return {
      yaz(v) {
        if (p0 || bekleyen != null || Date.now() - sonGonderim < KILIT_MS) return;
        sonDeger = v;
        goster(v);
      },
    };
  }

  // Satır: ad (ya da cihaz seçici) + sessiz düğmesi + kaydırıcı + yüzde.
  function satir(adEl, etiket, ayarla) {
    const el = document.createElement('div');
    el.className = 'kr-satir';
    el.appendChild(adEl);
    const k = document.createElement('div');
    k.className = 'kr-kontrol';
    k.innerHTML = `<button type="button" class="kr-sessiz" aria-pressed="false"></button><span class="kr-kaydirici"><input type="range" min="0" max="100" step="1"></span><span class="kr-yuzde"></span>`;
    el.appendChild(k);
    const btn = k.querySelector('button'), inp = k.querySelector('input'), out = k.querySelector('.kr-yuzde');
    inp.setAttribute('aria-label', `${etiket} ses seviyesi`);
    let sessiz = null, sessizAt = 0;
    const sessizGoster = (s) => {
      sessiz = s;
      btn.setAttribute('aria-pressed', String(s));
      btn.innerHTML = RCIkon.svg(s ? 'volumeOff' : 'volume');
      btn.title = s ? `${etiket}: sessiz — sesi açmak için dokunun` : `${etiket}: sessize al`;
      btn.setAttribute('aria-label', btn.title);
      el.classList.toggle('sessiz', s);
    };
    btn.addEventListener('click', () => {
      sessizAt = Date.now();
      sessizGoster(!sessiz);
      ayarla('sessiz', sessiz);
    });
    const kd = kaydirici(k.querySelector('.kr-kaydirici'), inp, out, (v) => ayarla('ses', v));
    return {
      el,
      guncelle(ses, s) {
        kd.yaz(ses);
        if (Date.now() - sessizAt >= KILIT_MS) sessizGoster(s);
      },
    };
  }

  function mount(el) {
    if (el._karisim) return el._karisim;
    const no = ++sayac;
    el.classList.add('kr');
    el.innerHTML = `
      <p class="kr-msg" data-r="msg"></p>
      <div class="kr-bas"><h4 id="krCihazEt${no}">Çıkış cihazı</h4></div>
      <div data-r="cihaz"></div>
      <p class="kr-not">Seçilen cihaz Windows'un varsayılan ses çıkışı yapılır.</p>
      <div class="kr-bas"><h4>Uygulamalar</h4><button type="button" class="ghost small" data-r="yenile">Yenile</button></div>
      <div class="kr-liste" data-r="uyg"><p class="kr-bos">Yükleniyor…</p></div>`;
    const $ = (r) => el.querySelector(`[data-r=${r}]`);
    const msgEl = $('msg');

    // Cihaz satırı: adı seçici gösterir.
    const sec = document.createElement('select');
    sec.setAttribute('aria-labelledby', `krCihazEt${no}`);
    let cihazId = null, secAt = 0;
    const cihaz = satir(sec, 'Cihaz', (ne, deger) => {
      if (cihazId) RC.send({ t: 'karisim-ayar', tur: `cihaz-${ne}`, id: cihazId, deger });
    });
    cihaz.el.hidden = true; // liste gelene kadar
    $('cihaz').appendChild(cihaz.el);
    sec.addEventListener('change', () => {
      secAt = Date.now();
      msgEl.textContent = '';
      RC.send({ t: 'karisim-ayar', tur: 'varsayilan', id: sec.value });
    });
    $('yenile').addEventListener('click', () => { msgEl.textContent = ''; iste(); });

    const satirlar = new Map(); // pid -> satır
    function ciz(m) {
      msgEl.textContent = m.hata || '';
      const cihazlar = Array.isArray(m.cihazlar) ? m.cihazlar : [];
      const c = cihazlar.find((x) => x.id === m.cihazId) || null;
      cihazId = c ? c.id : null;
      // Seçici: seçenekler değiştiyse yeniden; seçili = varsayılan (az önce değiştirildiyse dokunulmaz)
      const imza = cihazlar.map((x) => `${x.id}\n${x.ad}`).join('\n');
      if (sec.dataset.imza !== imza) {
        sec.dataset.imza = imza;
        sec.replaceChildren(...cihazlar.map((x) => { const o = document.createElement('option'); o.value = x.id; o.textContent = x.ad; return o; }));
      }
      if (Date.now() - secAt >= KILIT_MS && c) sec.value = c.id;
      sec.disabled = cihazlar.length < 2;
      cihaz.el.hidden = !c;
      if (c) cihaz.guncelle(c.ses, c.sessiz);

      const liste = $('uyg');
      const uyg = Array.isArray(m.uygulamalar) ? m.uygulamalar : [];
      if (!c || !uyg.length) {
        satirlar.clear();
        liste.innerHTML = `<p class="kr-bos">${!cihazlar.length ? (m.hata ? '' : 'Etkin ses çıkış cihazı yok.') : 'Bu cihazda ses oturumu açık uygulama yok.'}</p>`;
        return;
      }
      liste.querySelector('.kr-bos')?.remove();
      const gorulen = new Set();
      let onceki = null;
      for (const u of uyg) {
        gorulen.add(u.pid);
        let s = satirlar.get(u.pid);
        if (!s) {
          const ad = document.createElement('div');
          ad.className = 'kr-ad';
          const pid = u.pid;
          s = satir(ad, u.ad, (ne, deger) => RC.send({ t: 'karisim-ayar', tur: `uyg-${ne}`, pid, deger }));
          s.adEl = ad;
          s.el.dataset.pid = String(pid);
          satirlar.set(pid, s);
        }
        if (s.adEl.textContent !== u.ad) { s.adEl.textContent = u.ad; s.adEl.title = u.ad; }
        s.guncelle(u.ses, u.sessiz);
        // Sırayı koru (yerinde: sürüklenen satır DOM'dan çıkarılmaz)
        const yer = onceki ? onceki.el.nextSibling : liste.firstChild;
        if (yer !== s.el) liste.insertBefore(s.el, yer);
        onceki = s;
      }
      for (const [pid, s] of satirlar) if (!gorulen.has(pid)) { s.el.remove(); satirlar.delete(pid); }
    }

    const o = { el, ciz, mesaj(t) { msgEl.textContent = t; } };
    el._karisim = { el, yenile: iste };
    ornekler.add(o);
    if (son) ciz(son);
    // Görünür olunca hemen yenile (sekme / panel açıldı)
    let gorundu = false;
    if ('IntersectionObserver' in window) {
      new IntersectionObserver((g) => {
        const simdi = g.some((x) => x.isIntersecting);
        if (simdi && !gorundu) iste();
        gorundu = simdi;
      }).observe(el);
    }
    if (gorunur(el)) iste();
    return el._karisim;
  }

  RC.karisim = { mount };

  // ---------- Görüntüleyici: ⋯ menü > Daha fazla > Ses karıştırıcı ----------
  const panel = RC.ui.panel('Ses karıştırıcı', { id: 'karisimPanel', className: 'karisim-panel', onOpen: () => iste() });
  const govde = document.createElement('div');
  govde.id = 'karisimKap';
  panel.body.appendChild(govde);
  mount(govde);
  RC.ui.menuItem({ id: 'karisimBtn', icon: '🔊', label: 'Ses karıştırıcı', order: 31, ikincil: true, ctl: true, onClick: () => panel.open() });
  RC.on('viewer:stop', () => panel.close());
  RC.on('auth', (me) => { if (me.role === 'view') panel.close(); });

  // Bu betikten önce oluşturulmuş kaplar (ör. Kumanda > Medya)
  for (const k of document.querySelectorAll('[data-karisim]')) mount(k);
})();
