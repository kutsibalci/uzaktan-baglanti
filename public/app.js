(() => {
  const $ = (id) => document.getElementById(id);
  const canvas = $('screen');
  const ctx = canvas.getContext('2d');
  const stage = $('stage');
  const kbInput = $('kbInput');

  // ---------- Simgeler (ikon.js): emoji yerine SVG ----------
  const ikon = window.RCIkon;
  for (const el of document.querySelectorAll('[data-ik]')) {
    if (el.tagName === 'H2') el.insertAdjacentHTML('afterbegin', ikon.svg(el.dataset.ik));
    else if (!el.closest('.mode')) ikon.yerlestir(el, el.dataset.ik);
  }
  ikon.yerlestir($('backBtn'), '←');
  $('kbBtn').innerHTML = `${ikon.svg('keyboard')}<span class="al">Klavye</span>`;
  $('menuBtn').innerHTML = `${ikon.svg('more')}<span class="al">Diğer</span>`;
  $('logoutBtn').innerHTML = `${ikon.svg('logout')}<span>Çıkış</span>`;
  // Ana menü: '📁 Dosya aktarımı' gibi düğmeler renkli simge kutucuklu araç düğmesi olur; kartların simgesi de renklenir.
  function aracDugmesi(btn) {
    const a = ikon.ayir(btn.textContent);
    if (!a) return;
    btn.innerHTML = `${ikon.kutu(a.ad)}<span class="tl"></span>`;
    btn.querySelector('.tl').textContent = a.metin;
  }
  function modKarti(kart) {
    const ic = kart.querySelector('.icon');
    if (!ic || ic.classList.contains('has-ik')) return;
    const ad = ic.dataset.ik || ic.textContent;
    if (!ikon.ad(ad)) return;
    ikon.yerlestir(ic, ad);
    kart.style.setProperty('--ik', ikon.renk(ad));
  }
  aracDugmesi($('adminBtn'));
  {
    const modes = document.querySelector('#vHome .modes');
    const hepsi = () => modes.querySelectorAll('.mode').forEach(modKarti);
    hepsi();
    new MutationObserver(hepsi).observe(modes, { childList: true }); // özelliklerin kartları (çizim, kumanda) sonradan eklenir
  }

  // quality/fps JPEG için, kbps H.264 için.
  // auto: JPEG'de sunucu kaliteyi ve genişliği ağa göre seçer (quality/maxWidth tavandır); H.264'te "Orta" ile aynıdır.
  const QUALITY = {
    auto: { quality: 70, maxWidth: 1920, fps: 30, kbps: 4000, auto: true },
    // Veri tasarrufu (mobil veri): H.264 en fazla 500 kbps (sürekli hareketli ekranda bile saatte ≤ ~220 MB), 15 fps, uzun kenar 1280.
    tasarruf: { quality: 35, maxWidth: 1280, fps: 15, kbps: 500 },
    low: { quality: 40, maxWidth: 1280, fps: 20, kbps: 1500 },
    mid: { quality: 60, maxWidth: 1920, fps: 30, kbps: 4000 },
    high: { quality: 80, maxWidth: 2560, fps: 30, kbps: 8000 },
  };
  const EXTEND_SETTINGS = { quality: 70, fps: 30, kbps: 6000 };
  const ROLE_NAMES = { admin: 'Yönetici', control: 'Kontrol', view: 'Salt izleme' };

  let ws = null;
  let me = null;               // { username, role, guest }
  let resumeToken = null;      // kısa kopmalar için (yalnızca bellekte)
  let screens = [];
  let vddAvailable = false;
  let stream = null;           // { mode, screen } — aktif görüntüleme
  let lastAttempt = null;
  let frameCount = 0;
  // Gecikme sayacı için son bir saniyenin ölçümleri (RC.stats() ile okunur).
  let byteCount = 0, decodeSum = 0, decodeN = 0;
  // Veri sayacı (RC.traffic): sayfa açıldığından beri WebSocket'ten alınan/gönderilen baytlar (çerçeve başlığı dahil, TLS hariç).
  const traffic = { goruntu: 0, ses: 0, diger: 0, giden: 0 };
  const utf8 = new TextEncoder();
  const wsFrame = (n, out) => n + (n < 126 ? 2 : n < 65536 ? 4 : 10) + (out ? 4 : 0); // istemci→sunucu çerçeveleri maskeli (+4)
  function countIn(d) {
    if (typeof d === 'string') { traffic.diger += wsFrame(utf8.encode(d).length); return; }
    const t = d.byteLength ? new Uint8Array(d, 0, 1)[0] : 0;
    traffic[t === 1 || t === 2 || t === 4 ? 'goruntu' : t === 3 ? 'ses' : 'diger'] += wsFrame(d.byteLength);
  }
  let lastStats = { fps: 0, kbps: 0, decodeMs: null, codec: '' };
  let lastDrawAt = 0;
  const intervals = [];        // son birkaç saniyenin kare aralıkları { t: çizim anı, ms } (titreşim/takılma için)
  let codecLabel = '';
  let httpToken = null;       // özelliklerin HTTP istekleri için (X-Oturum başlığı)
  let authHook = () => false; // RC.setAuthHook: hello gelince girişi bir özellik üstlenebilir (true dönerse)

  // Özellik betikleri (public/features/*.js) için olay sistemi.
  // Sunucudan gelen tanınmayan JSON mesajları türüne göre buraya iletilir;
  // ayrıca yerel olaylar: 'auth', 'viewer:start', 'viewer:stop', 'admin', 'disconnect'.
  const listeners = new Map();
  function on(type, fn) {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(fn);
  }
  function emit(type, data) {
    for (const fn of listeners.get(type) || []) {
      try { fn(data); } catch (e) { console.error(`Özellik hatası (${type}):`, e); }
    }
  }

  // ---------- H.264 desteği (WebCodecs: yalnızca HTTPS veya localhost) ----------

  let h264Supported = false;
  (async () => {
    if (!window.isSecureContext || !('VideoDecoder' in window)) return;
    try {
      const r = await VideoDecoder.isConfigSupported({ codec: 'avc1.4D4028', optimizeForLatency: true });
      h264Supported = !!r.supported;
    } catch { /* desteklenmiyor */ }
  })();
  const codecList = () => (h264Supported ? ['h264', 'jpeg'] : ['jpeg']);

  // ---------- Yardımcılar ----------

  const storage = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* gizli sekme */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* gizli sekme */ } },
  };

  const VIEWS = ['vConnecting', 'vSetup', 'vLogin', 'vPending', 'vHome', 'vViewer', 'vAdmin'];
  let panelleriKapat = null; // aşağıda (paneller) atanır
  function show(id) {
    for (const v of VIEWS) $(v).hidden = v !== id;
    // Girişe / kuruluma dönünce açık kalan paneller (ör. bilgisayar durumu) kapanır.
    if (id !== 'vViewer' && id !== 'vHome' && id !== 'vAdmin') panelleriKapat?.();
  }
  const visible = (id) => !$(id).hidden;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtTime = (t) => (t ? new Date(t).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' }) : '—');

  function deviceName() {
    const ua = navigator.userAgent;
    const os = /Android/.test(ua) ? 'Android'
      : /iPhone/.test(ua) ? 'iPhone'
      : /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'iPad'
      : /Windows/.test(ua) ? 'Windows'
      : /Mac/.test(ua) ? 'Mac'
      : /Linux/.test(ua) ? 'Linux' : 'Cihaz';
    const br = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome'
      : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Tarayıcı';
    return `${os} · ${br}`;
  }

  function overlay(msg) {
    $('overlay').hidden = !msg;
    $('overlay').textContent = msg || '';
  }

  // ---------- Bağlantı ----------

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (e) => { countIn(e.data); return typeof e.data === 'string' ? onJson(JSON.parse(e.data)) : onFrame(e.data); };
    ws.onclose = (e) => {
      setStatus(false);
      releaseAll();
      emit('disconnect', { code: e.code });
      if (e.code === 4000) { me = null; resumeToken = null; stream = null; showLogin(); return; }
      if (e.code === 4002) { resumeToken = null; stream = null; }
      if (visible('vViewer')) overlay('Bağlantı koptu, yeniden bağlanılıyor…');
      else if (!me) show('vConnecting');
      setTimeout(connect, 2000);
    };
  }

  const TUM = window.Ekranlar.TUM;
  function send(obj) {
    // Görüntüleme biterken basılı tuş/düğme kalmasın: sunucu 'stop'tan sonra girdi kabul etmez, önce bırakılır.
    if (obj.t === 'stop') releaseAll();
    // Tüm ekranlar: görüntüdeki nokta (0..1, birleşik görüntüde) içinde olduğu ekrana ve oradaki konuma çevrilir; boşluktaki
    // nokta en yakın ekrana. Bütün yollar (fare, dokunma, touchpad, sürükleme, kalem, özellikler) buradan geçer.
    if ((obj.t === 'move' || obj.t === 'kalem') && stream?.screen === TUM) {
      const e = window.Ekranlar.noktaEkrana(screens, obj.x, obj.y);
      if (e) obj = { ...obj, s: e.name, x: e.x, y: e.y };
    }
    if (ws && ws.readyState === 1) { const s = JSON.stringify(obj); ws.send(s); traffic.giden += wsFrame(utf8.encode(s).length, true); }
  }

  function onJson(m) {
    switch (m.t) {
      case 'hello': return onHello(m);
      case 'auth': return m.ok ? onAuthOk(m) : onAuthFail(m);
      case 'pending': return show('vPending');
      case 'started': return onStarted(m);
      case 'status': return overlay(m.msg);
      case 'error': return onError(m);
      case 'role':
        me.role = m.role;
        applyRole();
        return;
      case 'adminData': return renderAdmin(m);
      case 'vconfig': return configureDecoder(m);
      case 'durgun': stillPending = true; return; // ekran durağan: sıradaki karenin aralığı takılma sayılmaz
      case 'ekranlar': return onScreens(m);
      case 'codec':
        // Sunucu H.264'ü başlatamadı, JPEG'e döndü.
        closeDecoder();
        codecLabel = 'JPEG';
        return;
      default:
        emit(m.t, m); // özellik modüllerinin mesajları
    }
  }

  function onHello(m) {
    $('guestTabBtn').hidden = !m.guestOtp;
    $('noSetupMsg').hidden = !(m.needsSetup && !m.canSetup);
    const token = storage.get('deviceToken');
    if (resumeToken) { lastAttempt = 'resume'; send({ t: 'resume', token: resumeToken }); }
    else if (authHook(m)) lastAttempt = 'ozellik'; // özellik girişi üstlendi (ör. QR eşleştirme)
    else if (token) { lastAttempt = 'token'; send({ t: 'token', token }); }
    else if (m.canSetup) show('vSetup');
    else showLogin();
  }

  function showLogin(error = '') {
    $('loginError').textContent = error;
    show('vLogin');
  }

  function onAuthOk(m) {
    me = { username: m.username, role: m.role, guest: m.guest };
    if (m.token) storage.set('deviceToken', m.token);
    resumeToken = m.resume;
    httpToken = m.http || null;
    screens = m.screens || [];
    vddAvailable = m.vdd;
    setStatus(true);
    emit('auth', { ...me, resumed: !!m.resumed });
    if (m.resumed && stream) {
      overlay('Yeniden bağlanıldı…');
      send({ t: 'start', ...startParams(stream.mode), screen: stream.screen, codecs: codecList() });
      return;
    }
    goHome();
  }

  function onAuthFail(m) {
    if (lastAttempt === 'resume') {
      resumeToken = null;
      stream = null;
      const token = storage.get('deviceToken');
      if (token) { lastAttempt = 'token'; send({ t: 'token', token }); return; }
    } else if (lastAttempt === 'token') {
      storage.del('deviceToken');
    } else if (lastAttempt === 'ozellik') {
      // Özellik girişi olmadı (ör. QR'ın süresi dolmuş): bu cihaz zaten hatırlanıyorsa onunla gir.
      const token = storage.get('deviceToken');
      if (token) { lastAttempt = 'token'; send({ t: 'token', token }); return; }
    }
    if (lastAttempt === 'setup') {
      document.querySelector('#setupForm .error').textContent = m.error;
      return;
    }
    showLogin(m.error);
  }

  function onError(m) {
    if (visible('vViewer') && stream?.mode === 'extend' && !stream.started) {
      stream = null;
      goHome(m.msg);
    } else if (visible('vViewer')) {
      overlay(m.msg);
      setTimeout(() => overlay(''), 4000);
    } else {
      $('homeError').textContent = m.msg;
    }
  }

  // ---------- Formlar ----------

  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
    document.querySelectorAll('.tabpane').forEach((p) => { p.hidden = p.id !== t.dataset.tab; });
    $('loginError').textContent = '';
  }));

  $('setupForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    const err = f.querySelector('.error');
    if (f.password.value !== f.password2.value) { err.textContent = 'Şifreler aynı değil.'; return; }
    err.textContent = '';
    lastAttempt = 'setup';
    send({ t: 'setup', username: f.username.value.trim(), password: f.password.value, remember: f.remember.checked, deviceName: deviceName() });
  });

  $('tAccount').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    $('loginError').textContent = '';
    lastAttempt = 'login';
    send({ t: 'login', username: f.username.value.trim(), password: f.password.value, remember: f.remember.checked, deviceName: deviceName() });
    f.password.value = '';
  });

  $('tGuest').addEventListener('submit', (e) => {
    e.preventDefault();
    $('loginError').textContent = '';
    lastAttempt = 'guest';
    send({ t: 'guest', code: e.target.code.value.trim(), deviceName: deviceName() });
    e.target.code.value = '';
  });

  // ---------- Ana menü ----------

  function goHome(error = '') {
    if (stream) emit('viewer:stop');
    stream = null;
    closeDecoder();
    resetJpeg();
    overlay('');
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    $('helloName').textContent = `Merhaba, ${me.username}`;
    $('helloRole').textContent = `${ROLE_NAMES[me.role] || me.role}${me.guest ? ' (misafir)' : ''}`;
    $('adminBtn').hidden = me.role !== 'admin';
    $('modeExtend').disabled = me.role === 'view';
    $('extendHint').textContent = me.role === 'view' ? 'Kontrol yetkisi gerekiyor'
      : vddAvailable ? 'Bu cihazı bilgisayarın ek monitörü yap'
      : 'Sürücü kurulu değil — bilgisayarda surucu-kur.bat';
    $('controlHint').textContent = me.role === 'view' ? 'Bilgisayarın ekranını izle' : 'Bilgisayarın ekranını gör ve kontrol et';
    fillScreens($('screenPick'), screens);
    $('screenPickRow').hidden = screens.length < 2;
    $('homeError').textContent = error;
    show('vHome');
  }

  // kisa: menüdeki dar seçici için "(ana)" eklenmez (yoksa ad kesiliyordu).
  function fillScreens(sel, list, current, kisa = false) {
    sel.innerHTML = '';
    list.forEach((s, i) => {
      const o = document.createElement('option');
      o.value = s.name;
      // title sunucudan gelir ("Ekran 2 (1920×1080)", sanal ekranda "Sanal ekran (…)"); eski sunucu için yedek.
      o.textContent = `${s.title || `Ekran ${i + 1} — ${s.w}×${s.h}`}${s.primary && !kisa ? ' (ana)' : ''}`;
      sel.appendChild(o);
    });
    // Birden çok ekran varsa: hepsi gerçek dizilimiyle tek görüntüde (public/ekranlar.js, public/features/tum-ekranlar.js).
    if (list.length > 1 || current === TUM) sel.appendChild(new Option('🖥🖥 Tüm ekranlar', TUM));
    if (current) sel.value = current;
  }

  function startParams(mode) {
    if (mode !== 'extend') return { mode: 'control' };
    // Cihazın fiziksel piksel çözünürlüğü, o anki yönelime göre.
    const dpr = window.devicePixelRatio || 1;
    const long = Math.max(screen.width, screen.height) * dpr;
    const short = Math.min(screen.width, screen.height) * dpr;
    const landscape = window.innerWidth >= window.innerHeight;
    return { mode: 'extend', w: Math.round(landscape ? long : short), h: Math.round(landscape ? short : long) };
  }

  $('modeControl').addEventListener('click', () => {
    stream = { mode: 'control', screen: $('screenPick').value || null };
    enterViewer('Bağlanılıyor…');
    send({ t: 'start', mode: 'control', screen: stream.screen, codecs: codecList() });
  });

  $('modeExtend').addEventListener('click', async () => {
    try { await document.documentElement.requestFullscreen?.(); } catch { /* iPhone desteklemiyor */ }
    await new Promise((r) => setTimeout(r, 300)); // tam ekran sonrası boyutlar otursun
    stream = { mode: 'extend' };
    enterViewer('Sanal ekran oluşturuluyor…');
    send({ t: 'start', ...startParams('extend'), codecs: codecList() });
  });

  $('logoutBtn').addEventListener('click', () => {
    storage.del('deviceToken');
    resumeToken = null;
    send({ t: 'logout', forget: true });
  });

  // ---------- Görüntüleyici ----------

  function enterViewer(msg) {
    resetJpeg();
    canvas.width = 0;
    canvas.height = 0;
    overlay(msg);
    show('vViewer');
  }

  function onStarted(m) {
    screens = m.screens || screens;
    stream = { mode: m.mode, screen: m.screen, started: true };
    const extend = m.mode === 'extend';
    $('screenRow').hidden = extend || (screens.length < 2 && m.screen !== TUM);
    fillScreens($('screenSel'), screens, m.screen, true);
    $('qualityRow').hidden = extend;
    document.body.classList.toggle('rc-genislet', extend); // .no-extend öğeler gizlenir
    codecLabel = m.codec === 'h264' ? `H.264${m.encoder ? ` (${m.encoder})` : ''}` : 'JPEG';
    if (m.codec !== 'h264') closeDecoder();
    send({ t: 'settings', ...(extend ? EXTEND_SETTINGS : QUALITY[$('quality').value]) });
    applyRole();
    // İkinci ekranda araç çubuğu ekranı kaplamasın.
    $('toolbar').hidden = extend;
    $('showBtn').hidden = !extend;
    overlay('');
    emit('viewer:start', { ...stream });
  }

  // Ekran düzeni değişti (monitör takıldı/çıkarıldı, çözünürlük): sunucu yeni listeyi ve izlenen ekranı gönderir.
  function onScreens(m) {
    screens = m.screens || screens;
    if (!stream?.started) return;
    if (m.screen) stream.screen = m.screen;
    $('screenRow').hidden = stream.mode === 'extend' || (screens.length < 2 && stream.screen !== TUM);
    fillScreens($('screenSel'), screens, stream.screen, true);
    emit('ekranlar', { screens: [...screens], screen: stream.screen });
  }

  function applyRole() {
    const viewOnly = me?.role === 'view';
    $('viewOnly').hidden = !viewOnly;
    // .ctl öğeler (araç çubuğu, menü, paneller) salt izlemede CSS ile gizlenir; özelliklerin kendi hidden durumu bozulmaz.
    document.body.classList.toggle('rc-salt', viewOnly);
  }

  // afterStill: bu kareden önce ekran durağandı (sunucu 'durgun' bildirdi); aradaki süre kare aralığı sayılmaz.
  function draw(src, afterStill = false) {
    const w = src.displayWidth || src.width, h = src.displayHeight || src.height;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    if (src.parts) {
      // Tüm ekranlar (JPEG): ekran başına kareler yerlerine, aradaki boşluk siyah.
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, h);
      for (const p of src.parts) ctx.drawImage(p.bmp, p.x, p.y, p.w, p.h);
    } else ctx.drawImage(src, 0, 0, w, h);
    frameCount++;
    const t = performance.now();
    if (lastDrawAt && !afterStill) intervals.push({ t, ms: t - lastDrawAt });
    lastDrawAt = t;
  }

  // ---------- JPEG çözme ----------
  // Aynı anda tek kare çözülür. Çözülürken yenisi gelirse beklemeye alınır; beklemedeki daha eski kare atılır
  // (yavaş cihazda kuyruk birikip gecikme büyümesin). Her kare (atılan da) sunucuya onaylanır (ack): sunucu en fazla
  // 2 onaysız kare yollar. Çizim requestAnimationFrame ile ekran yenilemesine denk getirilir; araya yeni kare girerse eskisi çizilmez.
  let stillPending = false;    // 'durgun' geldi, henüz sonraki kare gelmedi
  let jpegBusy = false;
  let jpegWaiting = null;      // { data, recv, afterStill }
  let toPaint = null;          // { bmp, recv, afterStill }
  let paintQueued = false;

  const jpegBitmap = (data) => createImageBitmap(new Blob([data], { type: 'image/jpeg' }));
  // Tüm ekranlar (ikili tür 4): ekran başına JPEG'ler çözülür; draw() hepsini birleşik görüntüye çizer.
  async function tumBitmap(data) {
    const k = window.Ekranlar.coz(data);
    if (!k) throw new Error('bozuk birleşik kare');
    const r = await Promise.allSettled(k.parts.map((p) => jpegBitmap(p.data)));
    const parts = k.parts.map((p, i) => ({ x: p.x, y: p.y, w: p.w, h: p.h, bmp: r[i].value })).filter((p) => p.bmp);
    return { width: k.W, height: k.H, parts, close() { for (const p of parts) p.bmp.close(); } };
  }

  // tum: tür 4 (tüm ekranlar) karesi.
  function onJpeg(data, recv, afterStill, tum = false) {
    if (jpegBusy) {
      if (jpegWaiting) { send({ t: 'ack' }); afterStill = afterStill || jpegWaiting.afterStill; }
      jpegWaiting = { data, recv, afterStill, tum };
      return;
    }
    jpegBusy = true;
    (tum ? tumBitmap(data) : jpegBitmap(data))
      .then((bmp) => paint(bmp, recv, afterStill))
      .catch(() => {})
      .finally(() => {
        send({ t: 'ack' });
        jpegBusy = false;
        const next = jpegWaiting;
        jpegWaiting = null;
        if (next) onJpeg(next.data, next.recv, next.afterStill, next.tum);
      });
  }

  function paint(bmp, recv, afterStill) {
    if (!stream) { bmp.close(); return; }
    if (toPaint) { toPaint.bmp.close(); afterStill = afterStill || toPaint.afterStill; }
    toPaint = { bmp, recv, afterStill };
    if (paintQueued) return;
    paintQueued = true;
    requestAnimationFrame(() => {
      paintQueued = false;
      const p = toPaint;
      toPaint = null;
      if (!p) return;
      if (stream) { draw(p.bmp, p.afterStill); addDecode(p.recv); }
      p.bmp.close();
    });
  }

  function resetJpeg() {
    jpegWaiting = null;
    if (toPaint) { toPaint.bmp.close(); toPaint = null; }
    stillPending = false;
    lastDrawAt = 0;
    intervals.length = 0;
  }

  // İkili mesajın ilk baytı: 1 = JPEG kare, 2 = H.264 kare ([2][anahtar kare mi][veri]),
  // 4 = tüm ekranlar JPEG karesi (ekran başına JPEG, biçim public/ekranlar.js paketle).
  function onFrame(ab) {
    const u8 = new Uint8Array(ab);
    const jpeg = u8[0] === 1 || u8[0] === 4;
    if (u8[0] > 2 && !jpeg) { emit(`binary:${u8[0]}`, u8); return; } // özellik verisi görüntüden bağımsız
    if (!stream) { if (jpeg) send({ t: 'ack' }); return; }
    byteCount += u8.length;
    const recv = performance.now();
    if (jpeg) {
      const afterStill = stillPending;
      stillPending = false;
      onJpeg(u8.subarray(1), recv, afterStill, u8[0] === 4);
    } else if (u8[0] === 2) {
      decodeH264(u8[1] === 1, u8.subarray(2), recv);
    }
  }

  // Karenin gelişinden ekrana çizilmesine kadar geçen süre (çözme + çizim).
  function addDecode(recv) {
    decodeSum += performance.now() - recv;
    decodeN++;
  }

  // ---------- H.264 çözme ----------

  let decoder = null;
  let chunkTs = 0;
  const recvTimes = new Map(); // kare zaman damgası -> geliş anı (çözme süresini ölçmek için)

  function configureDecoder(m) {
    closeDecoder();
    decoder = new VideoDecoder({
      output: (frame) => {
        draw(frame);
        const recv = recvTimes.get(frame.timestamp);
        if (recv !== undefined) { recvTimes.delete(frame.timestamp); addDecode(recv); }
        frame.close();
      },
      error: (e) => {
        console.warn('Çözücü hatası:', e);
        closeDecoder();
        send({ t: 'keyframe' }); // yeni yapılandırma + anahtar kare iste
      },
    });
    try {
      decoder.configure({ codec: m.codec, codedWidth: m.w, codedHeight: m.h, optimizeForLatency: true });
    } catch (e) {
      // Bu cihaz bu H.264 profilini çözemiyor: JPEG'e dön.
      console.warn('H.264 yapılandırılamadı:', e);
      h264Supported = false;
      closeDecoder();
      send({ t: 'start', ...startParams(stream.mode), screen: stream.screen, codecs: ['jpeg'] });
    }
  }

  function decodeH264(key, data, recv) {
    if (!decoder || decoder.state !== 'configured') return;
    // Çözücü geride kaldıysa (yavaş cihaz) kuyruğu boşaltıp anahtar kareden devam et.
    if (decoder.decodeQueueSize > 8 && !key) {
      closeDecoder();
      send({ t: 'keyframe' });
      return;
    }
    try {
      chunkTs += 33333;
      if (recvTimes.size > 60) recvTimes.clear(); // çıktısı gelmeyen kareler birikmesin
      recvTimes.set(chunkTs, recv);
      decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: chunkTs, data }));
    } catch {
      closeDecoder();
      send({ t: 'keyframe' });
    }
  }

  function closeDecoder() {
    if (decoder && decoder.state !== 'closed') { try { decoder.close(); } catch { /* zaten kapalı */ } }
    decoder = null;
    recvTimes.clear();
  }

  // Son saniyenin kare aralıkları: ortalama, titreşim (standart sapma), en uzun ve takılma sayısı.
  // Takılma: son 3 saniyenin ortalama aralığının 2 katından uzun süren aralık. Durağan ekrandan sonraki aralık sayılmaz.
  function intervalStats() {
    const now = performance.now();
    while (intervals.length && now - intervals[0].t > 3000) intervals.shift();
    const last = intervals.filter((x) => now - x.t <= 1000).map((x) => x.ms);
    if (!stream || !last.length) return { intervalMs: null, jitterMs: null, maxIntervalMs: null, stutters: 0 };
    const avg3 = intervals.reduce((a, x) => a + x.ms, 0) / intervals.length;
    const avg = last.reduce((a, b) => a + b, 0) / last.length;
    const jitter = Math.sqrt(last.reduce((a, b) => a + (b - avg) ** 2, 0) / last.length);
    return { intervalMs: avg, jitterMs: jitter, maxIntervalMs: Math.max(...last), stutters: last.filter((x) => x > 2 * avg3).length };
  }

  function setStatus(on) {
    $('status').classList.toggle('on', on);
    $('status').title = on ? 'Bağlı' : 'Bağlantı yok';
  }

  setInterval(() => {
    $('fps').textContent = stream ? `${frameCount} fps · ${codecLabel}` : '';
    lastStats = {
      fps: stream ? frameCount : 0,
      kbps: Math.round((byteCount * 8) / 1000),
      decodeMs: decodeN ? decodeSum / decodeN : null,
      codec: stream ? codecLabel : '',
      ...intervalStats(),
    };
    frameCount = 0;
    byteCount = 0; decodeSum = 0; decodeN = 0;
  }, 1000);

  $('backBtn').addEventListener('click', () => { send({ t: 'stop' }); goHome(); });
  // Kalite seçimi: "Otomatik" seçeneği burada eklenir; seçim bu cihazda hatırlanır (varsayılan Otomatik).
  (() => {
    const sel = $('quality');
    if (![...sel.options].some((o) => o.value === 'auto')) sel.insertBefore(new Option('Otomatik', 'auto'), sel.firstChild);
    const saved = storage.get('quality');
    sel.value = QUALITY[saved] ? saved : 'auto';
  })();
  $('quality').addEventListener('change', (e) => {
    if (!QUALITY[e.target.value]) return;
    storage.set('quality', e.target.value);
    send({ t: 'settings', ...QUALITY[e.target.value] });
  });
  $('screenSel').addEventListener('change', (e) => {
    stream.screen = e.target.value;
    send({ t: 'screen', name: e.target.value });
    emit('ekranlar', { screens: [...screens], screen: stream.screen });
  });
  $('showBtn').addEventListener('click', () => { $('toolbar').hidden = false; $('showBtn').hidden = true; });
  $('kbBtn').addEventListener('click', () => { kbInput.value = ''; kbInput.focus(); });
  // Özel tuşlar (Kısayollar / Ctrl·Oklar / F1–F12) public/features/telefon.js'teki "Tuşlar" panelinde.

  // ---------- Paneller ve menü ----------
  // RC.ui.panel(başlık, seçenekler): köşesinde ✕ olan ortak panel. Esc ile, açılır (drop) panellerde dışarı dokununca da kapanır;
  // aynı anda tek açılır panel açık kalır. Kenetli panel (dock: 'bottom') görüntünün altına yerleşir, ekranı örtmez,
  // dışarı dokunmak onu kapatmaz (ekrana dokunup tıklamak sürebilsin). Görüntünün üstüne dokunup bir açılır paneli kapatan
  // dokunuş bilgisayara tıklama olarak gitmez.
  // RC.ui.closable(el, kapat): kendi kabuğu olan bir öğeyi (ör. tam ekran dosya paneli) Esc ile kapanacak şekilde kaydeder.
  // RC.ui.menuItem({...}): ⋯ menüsüne satır ekler; pin: true ise geniş ekranda çubukta simge olarak da görünür.

  const toolbarEl = $('toolbar');
  const altCubuk = $('altCubuk');
  const panels = []; // { el, close, drop, dismiss, anchors, openedAt }

  function trackPanel(entry) {
    entry.openedAt = entry.el.hidden ? 0 : performance.now();
    new MutationObserver(() => { if (!entry.el.hidden) entry.openedAt = performance.now(); })
      .observe(entry.el, { attributes: true, attributeFilter: ['hidden'] });
    panels.push(entry);
    return entry;
  }
  const openPanels = () => panels.filter((p) => !p.el.hidden && p.el.isConnected);
  panelleriKapat = () => { for (const p of openPanels()) p.close(); };

  // Açılır panel çubuğun hemen altında açılır (çubuk gizliyse ekranın üstünde); yükseklik görünür alana sığar.
  // Telefonda (alt çubuk varken) alttan açılır: alt çubuğun hemen üstüne yaslanır, içerik artınca yukarı doğru büyür.
  function placeDrop(el) {
    const vh = window.visualViewport?.height || window.innerHeight;
    const bar = visible('vViewer') && !toolbarEl.hidden ? Math.round(toolbarEl.getBoundingClientRect().bottom) : 0;
    const top = bar + 6;
    const alt = visible('vViewer') && altCubuk.getClientRects().length ? Math.round(altCubuk.getBoundingClientRect().top) : 0;
    el.classList.toggle('alttan', !!alt);
    if (alt) {
      el.style.top = 'auto';
      el.style.bottom = `${Math.max(0, Math.round(window.innerHeight - alt + 6))}px`;
      el.style.maxHeight = `${Math.max(160, alt - 6 - top)}px`;
      return;
    }
    el.style.bottom = '';
    el.style.top = bar ? `${top}px` : `calc(${top}px + env(safe-area-inset-top))`;
    el.style.maxHeight = `${Math.max(160, Math.round(vh - top - 8))}px`;
  }
  const relayout = () => { for (const p of openPanels()) if (p.drop) placeDrop(p.el); };
  window.addEventListener('resize', relayout);
  window.visualViewport?.addEventListener('resize', relayout);

  function panel(title, opts = {}) {
    const el = document.createElement('div');
    el.className = `rc-panel ${opts.dock ? 'dock' : 'drop'}${opts.className ? ` ${opts.className}` : ''}`;
    if (opts.id) el.id = opts.id;
    el.hidden = true;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', title);
    el.innerHTML = `<div class="rc-panel-bas"><h3></h3><button type="button" class="rc-x" title="Kapat" aria-label="Kapat">${ikon.svg('x')}</button></div><div class="rc-panel-ic"></div>`;
    const head = el.firstChild, body = el.lastChild;
    head.querySelector('h3').textContent = title;
    const anchors = new Set([].concat(opts.anchor || []).filter(Boolean));
    const p = {
      el, head, body,
      isOpen: () => !el.hidden,
      open() {
        if (entry.drop) {
          for (const o of openPanels()) if (o.drop && o !== entry) o.close();
          placeDrop(el);
        }
        if (!el.hidden) return;
        el.hidden = false;
        opts.onOpen?.();
      },
      close() {
        if (el.hidden) return;
        el.hidden = true;
        opts.onClose?.();
      },
      toggle() { if (el.hidden) p.open(); else p.close(); },
      addAnchor(a) { if (a) anchors.add(a); },
      setTitle(t) { head.querySelector('h3').textContent = t; el.setAttribute('aria-label', t); },
    };
    const entry = trackPanel({ el, drop: !opts.dock, dismiss: opts.dismiss ?? !opts.dock, anchors, close: () => p.close() });
    head.querySelector('.rc-x').addEventListener('click', () => p.close());
    if (opts.dock) $('stage').after(el);
    else document.body.appendChild(el);
    return p;
  }

  function closable(el, close, opts = {}) {
    trackPanel({ el, close, drop: false, dismiss: !!opts.dismiss, anchors: new Set([].concat(opts.anchor || []).filter(Boolean)) });
  }

  // Dışarı dokununca kapanma. Kapatan dokunuş görüntünün üstündeyse o hareketin tamamı yutulur (bilgisayara gitmez).
  let swallowing = false;
  const inStage = (t) => t instanceof Node && stage.contains(t);
  function onOutside(e) {
    const t = e.target;
    const start = e.type === 'pointerdown' || e.type === 'touchstart' || e.type === 'mousedown';
    if (swallowing) {
      if (inStage(t)) {
        e.stopImmediatePropagation();
        if (e.cancelable && e.type !== 'pointerdown') e.preventDefault();
      }
      const end = e.type === 'pointerup' || e.type === 'pointercancel' || e.type === 'mouseup' || e.type === 'touchcancel'
        || (e.type === 'touchend' && !e.touches.length);
      if (end) swallowing = false;
      return;
    }
    if (!start) return;
    let closed = false;
    for (const p of openPanels()) {
      if (!p.dismiss || p.el.contains(t) || [...p.anchors].some((a) => a.contains(t))) continue;
      p.close();
      closed = true;
    }
    if (closed && inStage(t)) {
      swallowing = true;
      e.stopImmediatePropagation();
      if (e.cancelable && e.type !== 'pointerdown') e.preventDefault();
    }
  }
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'mousedown', 'mousemove', 'mouseup',
    'touchstart', 'touchmove', 'touchend', 'touchcancel']) {
    window.addEventListener(type, onOutside, { capture: true, passive: false });
  }
  // Esc en son açılan paneli kapatır (bilgisayara Esc gitmez).
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' && e.keyCode !== 27) return;
    const top = openPanels().sort((a, b) => b.openedAt - a.openedAt)[0];
    if (!top) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    top.close();
  }, true);

  // ---- ⋯ Menü ----
  const menuBtn = $('menuBtn');
  const menuList = $('menuItems');
  let menuTimer = null;
  let daralt = null; // "Daha fazla" açıksa menü kapanınca yine katlanır (aşağıda)
  const menu = panel('Menü', {
    id: 'menuPanel',
    anchor: menuBtn,
    onOpen() { menuBtn.classList.add('on'); menuInfo(); menuTimer = setInterval(menuInfo, 1000); },
    onClose() { menuBtn.classList.remove('on'); clearInterval(menuTimer); daralt?.(); },
  });
  menu.body.appendChild(menuList);
  menuBtn.addEventListener('click', () => menu.toggle());
  on('viewer:stop', () => menu.close());
  on('disconnect', () => menu.close());

  // Menünün başında küçük bağlantı bilgisi (telefonda fps çubukta gösterilmez).
  function menuInfo() {
    const s = lastStats;
    const bagli = ws?.readyState === 1;
    $('menuInfo').textContent = !bagli ? '● Bağlantı yok' : stream ? `● Bağlı · ${s.fps} fps · ${s.codec || codecLabel || '–'}` : '● Bağlı';
    $('menuInfo').classList.toggle('kopuk', !bagli);
  }

  function addOrdered(parent, el, order) {
    el.dataset.order = String(order);
    const next = [...parent.children].find((c) => Number(c.dataset.order ?? 1e9) > order);
    parent.insertBefore(el, next || null);
  }

  const menuItems = [];
  const altPinler = []; // menuItem({ alt }) düğmeleri: telefonda alt çubukta (ör. Pano)
  function updateMenuBadge() {
    let dot = menuBtn.querySelector('.mdot');
    const any = menuItems.some((i) => i.st.badge && !i.st.hidden);
    if (any && !dot) { dot = document.createElement('span'); dot.className = 'mdot'; menuBtn.appendChild(dot); }
    if (dot) dot.hidden = !any;
  }

  // o: { id, icon, label, state, title, order (varsayılan 100), onClick(e), pin, alt ('Pano': telefonda alt çubukta bu kısa adla), ctl,
  //      extend (false: ikinci ekranda gizli),
  //      keepOpen (tıklayınca menü açık kalsın; aç/kapa düğmeleri için), hidden, disabled }
  // Dönen: { el, pinEl, set({ icon, label, state, title, hidden, disabled, active, badge }) }
  function menuItem(o = {}) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'menu-row';
    if (o.id) row.id = o.id;
    row.innerHTML = '<span class="mi"></span><span class="ml"></span><span class="ms"></span><span class="mdot" hidden></span>';
    let pin = null;
    if (o.pin || o.alt) {
      pin = document.createElement('button');
      pin.type = 'button';
      pin.className = 'tb-pin';
      if (o.id) pin.id = `${o.id}Pin`;
      pin.innerHTML = '<span class="pi"></span><span class="al"></span><span class="mdot" hidden></span>';
      pin.querySelector('.al').textContent = o.alt || '';
    }
    for (const e of [row, pin]) {
      if (!e) continue;
      if (o.ctl) e.classList.add('ctl');
      if (o.ikincil && e === row) e.classList.add('ikincil');
      if (o.extend === false) e.classList.add('no-extend');
    }
    const st = { icon: '', label: '', state: '', title: '', hidden: false, disabled: false, active: false, badge: false };
    const item = { el: row, pinEl: pin, st };
    item.set = (patch = {}) => {
      Object.assign(st, patch);
      const mi = row.querySelector('.mi');
      if (mi.dataset.v !== st.icon) { ikon.yerlestir(mi, st.icon); mi.dataset.v = st.icon; }
      row.querySelector('.ml').textContent = st.label;
      const ms = row.querySelector('.ms');
      ms.textContent = st.state;
      ms.hidden = !st.state;
      row.title = st.title;
      row.hidden = st.hidden;
      row.disabled = st.disabled;
      row.classList.toggle('on', st.active);
      row.querySelector('.mdot').hidden = !st.badge;
      if (pin) {
        const pi = pin.querySelector('.pi');
        if (pi.dataset.v !== st.icon) { ikon.yerlestir(pi, st.icon); pi.dataset.v = st.icon; }
        pin.title = st.title || (st.state ? `${st.label}: ${st.state}` : st.label);
        pin.setAttribute('aria-label', pin.title);
        pin.hidden = st.hidden;
        pin.disabled = st.disabled;
        pin.classList.toggle('on', st.active);
        pin.querySelector('.mdot').hidden = !st.badge;
      }
      updateMenuBadge();
      return item;
    };
    row.addEventListener('click', (e) => { if (!o.keepOpen) menu.close(); o.onClick?.(e); });
    pin?.addEventListener('click', (e) => o.onClick?.(e));
    menuItems.push(item);
    addOrdered(menuList, row, Number(o.order ?? 100));
    if (o.pin) addOrdered($('tbPins'), pin, Number(o.order ?? 100));
    if (o.alt) altPinler.push({ el: pin, pin: !!o.pin, order: Number(o.order ?? 100) });
    return item.set({ icon: o.icon || '', label: o.label || '', state: o.state || '', title: o.title || '', hidden: !!o.hidden, disabled: !!o.disabled });
  }

  // Tam ekran: iPhone'da Fullscreen API yok (yalnızca video için) — orada gösterilmez, yerine "Ana ekrana ekle" ipucu.
  const docEl = document.documentElement;
  const fsSupported = !!(docEl.requestFullscreen || docEl.webkitRequestFullscreen);
  const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement;
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  const standalone = navigator.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches;
  const fsItem = menuItem({
    id: 'fsBtn', icon: '⛶', label: 'Tam ekran', order: 80, pin: true, hidden: !fsSupported,
    onClick() {
      if (fsElement()) (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
      else {
        try { (docEl.requestFullscreen || docEl.webkitRequestFullscreen).call(docEl)?.catch?.(() => {}); } catch { /* izin yok */ }
      }
    },
  });
  const fsChanged = () => fsItem.set({ label: fsElement() ? 'Tam ekrandan çık' : 'Tam ekran', active: !!fsElement() });
  document.addEventListener('fullscreenchange', fsChanged);
  document.addEventListener('webkitfullscreenchange', fsChanged);
  if (isIOS && !standalone && !fsSupported) {
    const hint = document.createElement('p');
    hint.id = 'iosHint';
    hint.className = 'menu-hint';
    hint.innerHTML = '📲 <b>Tam ekran için:</b> Safari\'de Paylaş <span aria-hidden="true">⎙</span> → <b>Ana Ekrana Ekle</b>. Simgeden açınca adres çubuğu görünmez.';
    addOrdered(menuList, hint, 81);
  }
  menuItem({
    id: 'hideBtn', icon: '▴', label: 'Çubuğu gizle', state: 'üstteki ▾ ile geri gelir', order: 90, pin: true, ikincil: true,
    title: 'Çubuğu gizle', onClick() { toolbarEl.hidden = true; $('showBtn').hidden = false; },
  });
  // Telefonda menü kısa kalsın: az kullanılanlar (menuItem({ ikincil: true })) "Daha fazla"nın altında katlı (style.css).
  // Geniş ekranda bu satır görünmez, hepsi açık.
  const dahaFazla = menuItem({
    id: 'dahaFazla', icon: '▾', label: 'Daha fazla', order: 99, keepOpen: true,
    onClick() {
      const acik = menuList.classList.toggle('tum');
      menu.el.classList.toggle('genis', acik); // açıkken menü boyu sınırlanmaz (style.css)
      dahaFazla.set({ label: acik ? 'Daha az' : 'Daha fazla', icon: acik ? '▴' : '▾' });
      if (acik) dahaFazla.el.scrollIntoView({ block: 'start' }); // açılan satırlar görünsün
    },
  });
  daralt = () => { menuList.classList.remove('tum'); menu.el.classList.remove('genis'); dahaFazla.set({ label: 'Daha fazla', icon: '▾' }); };

  const canInput = () => stream?.started && me?.role !== 'view' && visible('vViewer');

  // ---------- Koordinat dönüşümü ----------

  function toNorm(cx, cy) {
    const nw = canvas.width, nh = canvas.height;
    if (!nw || !nh) return null;
    const r = canvas.getBoundingClientRect();
    const s = Math.min(r.width / nw, r.height / nh);
    const w = nw * s, h = nh * s;
    const ox = r.left + (r.width - w) / 2, oy = r.top + (r.height - h) / 2;
    const c = (v) => Math.min(1, Math.max(0, v));
    return { x: c((cx - ox) / w), y: c((cy - oy) / h) };
  }

  let pendingMove = null;
  function queueMove(cx, cy) {
    if (!canInput()) return;
    const p = toNorm(cx, cy);
    if (!p) return;
    if (!pendingMove) requestAnimationFrame(() => { if (pendingMove) send({ t: 'move', ...pendingMove }); pendingMove = null; });
    pendingMove = p;
  }
  function moveNow(cx, cy) {
    const p = toNorm(cx, cy);
    if (p) { pendingMove = null; send({ t: 'move', ...p }); }
  }
  // Bekleyen (rAF'a kalmış) hareketi hemen gönderir: düğme bırakılmadan önce son konuma gidilsin.
  function flushMove() {
    if (pendingMove && canInput()) send({ t: 'move', ...pendingMove });
    pendingMove = null;
  }
  function click(b) {
    send({ t: 'down', b });
    send({ t: 'up', b });
  }

  // ---------- Fare ----------

  const BTN = ['left', 'middle', 'right'];
  const heldButtons = new Set();

  // Kalem (pointerType 'pen') olaylarını kalem özelliği işler; o devredeyken (RC.setPenActive) tarayıcının kalem için
  // ürettiği fare/dokunma olaylarını yok say. Devrede değilse (ör. bilgisayar sentetik kalemi desteklemiyor) kalem
  // fare/parmak gibi çalışır. Pointer olayları uyumluluk fare ve dokunma olaylarından önce gelir.
  let penActive = () => false;
  let lastPointerType = 'mouse';
  const notePointer = (e) => { lastPointerType = e.pointerType; };
  stage.addEventListener('pointerdown', notePointer, true);
  stage.addEventListener('pointermove', notePointer, true);
  const fromPen = () => lastPointerType === 'pen' && penActive();
  // Dokunuştan türetilen uyumluluk fare olayları (Safari/Chrome preventDefault edilmemiş bir dokunuş için
  // mousemove/mousedown/mouseup/click üretir) yok sayılır: dokunuşu yalnızca dokunma işleyicileri işler,
  // yoksa aynı dokunuş için ikinci bir 'down' giderdi. Dokunma olayı olmayan tarayıcıda dokunuş fare yoluyla çalışır.
  const hasTouchEvents = 'ontouchstart' in window;
  const fromTouch = () => hasTouchEvents && lastPointerType === 'touch';

  stage.addEventListener('mousemove', (e) => { if (!fromPen() && !fromTouch()) queueMove(e.clientX, e.clientY); });
  stage.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const b = BTN[e.button];
    if (!b || !canInput() || fromPen() || fromTouch()) return;
    moveNow(e.clientX, e.clientY);
    heldButtons.add(b);
    send({ t: 'down', b });
  });
  window.addEventListener('mouseup', (e) => {
    const b = BTN[e.button];
    if (!b || !heldButtons.has(b)) return;
    heldButtons.delete(b);
    send({ t: 'up', b });
  });
  stage.addEventListener('contextmenu', (e) => e.preventDefault());
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (!canInput()) return;
    const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
    send({ t: 'wheel', dy: Math.round(-e.deltaY * unit * 1.2), dx: Math.round(e.deltaX * unit * 1.2) });
  }, { passive: false });

  // ---------- Dokunmatik ----------
  // İki mod (alt çubuktaki düğmeyle değişir, seçim hatırlanır; varsayılan Fare — parmakla hedefe isabet etmek zor):
  //  Fare (touchpad): dizüstü touchpad'i gibi. Tek parmak imleci göreli (ivmeli) taşır, dokunuş = sol tık,
  //            iki parmak dokunuş = sağ tık, iki parmak kaydırma = tekerlek, çift dokunup sürükleme = sol tuşla sürükleme,
  //            hareketsiz basılı tut (PAD_HOLD_MS) = hemen sağ tık (bırakmayı beklemeden; önce kaydırırsan imleç oynar).
  //  Dokunmatik (doğrudan): parmağın değdiği yer tıklanır. Dokun-bırak = sol tık (çift dokunuş = çift tık), tek parmakla
  //            sürükleme = sol tuşla sürükleme (seçme, pencere taşıma), hareketsiz basılı tut (HOLD_MS) = hemen sağ tık,
  //            iki parmak kaydırma = tekerlek (yakınlaştırılmışken görünümü kaydırır).
  //            Kullanıcı: eskiden tek parmak = kaydırma, basılı tut + sürükle = sürükleme, bas-bırak = sağ tık idi ve
  //            "kaydırma/sürükleme karışıyor, hareketler anlaşılmıyor" dedi; şimdi iki modda da iki parmak = kaydırma,
  //            basılı tut = sağ tık.
  //            İki parmak dokunuşu toleranslıdır (Dokunmatik.isTwoFingerTap): parmaklar 150 ms'ye kadar farklı inip kalkabilir,
  //            toplam 500 ms, her parmak 20 px'e kadar kayabilir; ilk parmak ikinci gelmeden biraz kaymışsa imleç geri alınır.
  //            Eskiden eşikler (12/24 px, 375 ms) gerçek parmakta çoğu zaman tutmuyordu: "sağ tık basamıyoruz".
  // "Sağ tık" düğmesi (alt çubukta, yalnızca dokunmatik): dokununca imlecin olduğu yerde hemen sağ tık.
  // Her iki modda: iki parmak sıkıştırma = yakınlaştırma (1x–4x), iki parmak çift dokunuş = 1x.
  // Basılı düğme her durumda bırakılır: parmak kalkınca, touchcancel'da, sekme gizlenince/pencere odağı gidince,
  // görüntüleyiciden çıkarken ('stop'tan önce), bağlantı koparken (sunucu da izleme bitince bırakır).
  // Kalem özelliği devredeyken kalem dokunuşları burada işlenmez (kalem özelliği pointer olaylarıyla işler).
  // Chromium'da Touch.touchType yok; bu yüzden kalemin pointerdown'ından hemen sonra gelen dokunuşlar kimlikleriyle
  // kalem olarak işaretlenir (Android Chrome kalem için dokunma olayı da üretir). Safari'de touchType 'stylus' da elenir.
  // Salt izleme rolünde touchpad modu anlamsızdır (imleç yok); hatırlanan mod ne olursa olsun doğrudan mod geçerlidir.
  // Hesaplar public/dokunmatik.js içinde (window.Dokunmatik).

  const T = window.Dokunmatik;
  const DRAG_THRESHOLD = 10;
  const DOUBLE_TAP_MS = 300;
  // Anahtar adı değişti (eski 'touchMode'): herkes yeni varsayılan olan Fare modundan başlasın.
  let touchMode = storage.get('dokunmaModu') === 'direct' ? 'direct' : 'touchpad';
  // Fare modunda imleç hızı çarpanı: ⋯ menüde "Fare hızı" (hatırlanır). Kullanıcı "biraz hızlı" dedi: eski hız artık "Hızlı" (1),
  // varsayılan "Normal" 0.8.
  let fareHizi = 0.8;
  {
    const sec = $('fareHiz');
    if ([...sec.options].some((o) => o.value === storage.get('fareHizi'))) sec.value = storage.get('fareHizi');
    fareHizi = Number(sec.value) || 0.8;
    sec.addEventListener('change', () => { fareHizi = Number(sec.value) || 0.8; storage.set('fareHizi', sec.value); });
  }
  let gesture = null;              // o anki dokunma hareketi
  let view = { z: 1, tx: 0, ty: 0 };  // yakınlaştırma: translate(tx, ty) scale(z)
  let cursor = { x: 0.5, y: 0.5 };    // touchpad sanal imleci (0..1)
  let lastPoint = null;            // doğrudan mod: son dokunulan nokta (0..1; klavye açılınca görünür tutulur)
  let lastTap = null;              // doğrudan mod: son dokunuşun yeri/zamanı (çift tık için)
  let tapTimer = null;             // touchpad: bekleyen tek tık (çift dokunup sürükleme olabilir)
  let rightTimer = null;           // touchpad: bekleyen sağ tık (iki parmak çift dokunuş olabilir)
  let lastTwoTap = 0;
  const touchHeld = new Set();     // dokunuşla basılı tutulan fare düğmeleri

  const tpCursor = document.createElement('div');
  tpCursor.id = 'tpCursor';
  tpCursor.hidden = true;
  stage.appendChild(tpCursor);
  // Basılı tutma göstergesi (sağ tık gönderildi).
  const holdRing = document.createElement('div');
  holdRing.id = 'tpHold';
  holdRing.hidden = true;
  stage.appendChild(holdRing);

  const penTouchIds = new Set();
  const fingers = (list) => [...list].filter((t) => !penTouchIds.has(t.identifier) && !(t.touchType === 'stylus' && penActive()));
  const forgetPenTouches = (e) => { for (const t of e.changedTouches) penTouchIds.delete(t.identifier); };
  // Çizim tableti açıkken parmak dokunduğu yeri tıklar (Fare modu seçili olsa da): tablette imleç sürmek anlamsız.
  let cizimModu = false;
  document.addEventListener('rc:cizim', (e) => { cizimModu = !!e.detail?.acik; cancelGesture(); drawCursor(); });
  const curMode = () => (canInput() && !cizimModu ? touchMode : 'direct');
  const canView = () => stream?.started && visible('vViewer');
  const viewBox = () => T.contentBox(stage.clientWidth, stage.clientHeight, canvas.width, canvas.height);
  function local(t) {
    const r = stage.getBoundingClientRect();
    return { x: t.clientX - r.left, y: t.clientY - r.top };
  }
  const midOf = (a, b) => { const p = local(a), q = local(b); return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }; };
  const distOf = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  const hasId = (list, id) => [...list].some((t) => t.identifier === id);
  // İki parmak hareketi: her parmağın kendi başlangıcından en çok kayması (dokunuş mu kararı için, px).
  function trackMove(g, list) {
    for (const t of list) {
      const s = g.starts.get(t.identifier);
      if (s) g.move = Math.max(g.move, Math.hypot(t.clientX - s.x, t.clientY - s.y));
    }
  }

  function press(b) {
    if (touchHeld.has(b)) return;
    touchHeld.add(b);
    send({ t: 'down', b });
  }
  function release(b) {
    if (!touchHeld.delete(b)) return;
    flushMove();
    send({ t: 'up', b });
  }

  function applyView() {
    canvas.style.transform = view.z > 1 ? `translate(${view.tx}px, ${view.ty}px) scale(${view.z})` : '';
    $('zoomBtn').hidden = view.z <= 1;
    // Telefonda kısa ("3×"): çubukta Sağ tık düğmesiyle birlikte sığsın.
    $('zoomBtn').innerHTML = `${+view.z.toFixed(1)}×<span class="tb-label"> ✕</span>`;
    drawCursor();
  }
  function setView(v) {
    view = T.clampView(v, viewBox());
    applyView();
  }

  // Touchpad imlecinin yerel göstergesi (karşıdan gelen görüntüdeki imleç gecikmeli olabilir).
  function drawCursor() {
    tpCursor.hidden = curMode() !== 'touchpad' || !canvas.width;
    if (tpCursor.hidden) return;
    const b = viewBox();
    tpCursor.style.left = `${(b.ox + cursor.x * b.cw) * view.z + view.tx}px`;
    tpCursor.style.top = `${(b.oy + cursor.y * b.ch) * view.z + view.ty}px`;
  }

  let cursorQueued = false;
  function sendCursor() {
    drawCursor();
    if (cursorQueued) return;
    cursorQueued = true;
    requestAnimationFrame(() => { cursorQueued = false; if (canInput()) send({ t: 'move', x: cursor.x, y: cursor.y }); });
  }
  function clickAtCursor(b, times = 1) {
    if (!canInput()) return;
    send({ t: 'move', x: cursor.x, y: cursor.y });
    for (let i = 0; i < times; i++) click(b);
  }

  // Hareketlerin kısa açıklaması: düğmenin title'ında ve her mod ilk kullanıldığında bir kez gösterilen ipucu kartında.
  // Kart girdiyi engellemez (pointer-events: none); ilk dokunuşta ya da 8 sn sonra kaybolur.
  const TOUCH_TIPS = {
    touchpad: ['Fare modu', 'parmağını kaydır = imleç · dokun = tık · basılı tut ya da iki parmakla dokun = sağ tık · iki parmakla kaydır = kaydırma · çift dokun + sürükle = sürükle'],
    direct: ['Dokunmatik mod', 'dokunduğun yer tıklanır · basılı tut = sağ tık · sürükle = sürükle (seç, taşı) · iki parmakla kaydır = kaydırma'],
  };
  const touchTip = document.createElement('div');
  touchTip.id = 'touchTip';
  touchTip.hidden = true;
  stage.appendChild(touchTip);
  let tipTimer = null;
  const isCoarse = () => !!window.matchMedia?.('(any-pointer: coarse)').matches;
  function hideTip() { clearTimeout(tipTimer); touchTip.hidden = true; }
  function maybeShowTip() {
    const key = `touchTip:${touchMode}`;
    if (!canInput() || !isCoarse() || storage.get(key)) return;
    storage.set(key, '1');
    const [name, text] = TOUCH_TIPS[touchMode];
    touchTip.innerHTML = `<b>${name}:</b> ${text}<br><small>Sağ tık için çubuktaki <b>Sağ tık</b> düğmesi de var.</small>`;
    touchTip.hidden = false;
    clearTimeout(tipTimer);
    tipTimer = setTimeout(hideTip, 8000);
  }

  function setTouchMode(mode) {
    cancelGesture();
    touchMode = mode;
    storage.set('dokunmaModu', mode);
    document.body.classList.toggle('rc-touchpad', mode === 'touchpad'); // özellikler (ör. ekran etiketleri) dokunuşu bıraksın
    $('touchModeBtn').innerHTML = mode === 'touchpad' ? `${ikon.svg('mouse')}<span class="al">Fare</span>` : `${ikon.svg('hand')}<span class="al">Dokunmatik</span>`;
    const [name, text] = TOUCH_TIPS[mode];
    $('touchModeBtn').title = `${name}: ${text} (değiştirmek için dokun)`;
    drawCursor();
  }
  setTouchMode(touchMode);
  $('touchModeBtn').addEventListener('click', () => { setTouchMode(touchMode === 'touchpad' ? 'direct' : 'touchpad'); hideTip(); maybeShowTip(); });

  // "Sağ tık" düğmesi (yalnızca dokunmatik, kontrol rolünde): dokununca imlecin olduğu yerde HEMEN sağ tık — Fare modunda
  // sanal imleç, dokunmatik modda son dokunulan yer (bilgisayarın imleci orada). Ekrana ayrıca dokunmak gerekmez.
  // (Eskiden "sıradaki dokunuş sağ tık" idi; kullanıcı: "basılı tutup tekrar ekrana dokunmak gerekiyor".)
  const rightBtn = document.createElement('button');
  rightBtn.id = 'rightBtn';
  rightBtn.className = 'ctl touch-only';
  rightBtn.title = 'Sağ tık (imlecin olduğu yerde)';
  rightBtn.innerHTML = `${ikon.svg('rightClick')}<span class="al">Sağ tık</span>`;
  $('touchModeBtn').after(rightBtn);
  rightBtn.addEventListener('click', () => {
    if (!canInput()) return;
    flushTap(); // bekleyen sol tık (Fare modunda dokunuştan hemen sonra) önce gitsin
    if (curMode() === 'touchpad') clickAtCursor('right'); else click('right');
    navigator.vibrate?.(15);
  });
  rightBtn.addEventListener('contextmenu', (e) => e.preventDefault());
  on('viewer:start', () => setTimeout(maybeShowTip, 0));
  $('zoomBtn').addEventListener('click', () => setView({ z: 1, tx: 0, ty: 0 }));
  window.addEventListener('resize', () => setView(view));

  // Süren dokunma hareketini bitirir ve dokunuşla basılı tutulan düğmeleri bırakır (asla basılı kalmasın).
  function cancelGesture() {
    if (gesture) clearTimeout(gesture.timer);
    gesture = null;
    holdRing.hidden = true;
    for (const b of [...touchHeld]) release(b);
  }

  function resetTouch() {
    clearTimeout(tapTimer); clearTimeout(rightTimer);
    tapTimer = rightTimer = null;
    cancelGesture();
    hideTip();
    cursor = { x: 0.5, y: 0.5 };
    lastPoint = lastTap = null;
    setView({ z: 1, tx: 0, ty: 0 });
  }
  on('viewer:start', resetTouch);
  on('viewer:stop', resetTouch);
  // Sekme arka plana geçince (iOS'ta uygulama değiştirme, ekran kilidi) touchend gelmeyebilir.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') releaseAll(); });
  window.addEventListener('pagehide', () => releaseAll());

  // Bekleyen tek parmak hareketini bitirir (ikinci parmak gelince).
  function endSingle() {
    if (!gesture || gesture.two) return;
    clearTimeout(gesture.timer);
    holdRing.hidden = true;
    release('left');
  }
  function flushTap() {
    if (!tapTimer) return;
    clearTimeout(tapTimer);
    tapTimer = null;
    clickAtCursor('left');
  }

  function showHold(g) {
    const p = local({ clientX: g.x0, clientY: g.y0 });
    holdRing.style.left = `${p.x}px`;
    holdRing.style.top = `${p.y}px`;
    holdRing.hidden = false;
  }

  stage.addEventListener('touchstart', (e) => {
    e.preventDefault();
    if (fromPen()) for (const t of e.changedTouches) penTouchIds.add(t.identifier);
    if (!canView()) return;
    hideTip();
    const f = fingers(e.touches);
    // Ekrandaki parmakların hepsi yeniyse önceki hareketin bitişi kaçırılmıştır (touchend/touchcancel gelmedi): bırak.
    if (gesture && f.every((t) => hasId(e.changedTouches, t.identifier))) cancelGesture();
    if (f.length >= 2) {
      if (gesture?.two) return;
      // İkinci parmaktan önce inen (belki biraz kaymış) tek parmak hareketi iki parmak dokunuşunun başlangıcı sayılır.
      const prev = gesture && f.some((t) => t.identifier === gesture.id) ? gesture : null;
      endSingle();
      flushTap();
      // Dokunuştan hemen sonra (bekleyen sol tık ilk parmak inince iptal edilmişti) gelen iki parmak: önce o sol tık gider.
      if (prev?.pad && prev.second && !prev.moved && canInput()) clickAtCursor('left');
      const now = Date.now();
      const two = f.slice(0, 2);
      gesture = {
        two: true, d0: distOf(two[0], two[1]), m0: midOf(two[0], two[1]), start: { ...view }, kind: null, acc: 0,
        t0: prev ? prev.t0 : now, downGap: prev ? now - prev.t0 : 0, up1: 0, move: 0,
        acted: !!(prev && (prev.dragging || prev.kind === 'drag')), cur0: prev?.cur0 || null,
        starts: new Map(two.map((t) => [t.identifier, prev && t.identifier === prev.id ? { x: prev.x0, y: prev.y0 } : { x: t.clientX, y: t.clientY }])),
      };
      gesture.wy = gesture.m0.y;
      trackMove(gesture, f);
      return;
    }
    if (f.length !== 1 || gesture) return;
    const t = f[0];
    if (curMode() === 'touchpad') {
      gesture = { pad: true, id: t.identifier, x0: t.clientX, y0: t.clientY, x: t.clientX, y: t.clientY, time: Date.now(), t0: Date.now(), moved: false, dragging: false, held: false, second: !!tapTimer, cur0: { ...cursor } };
      if (tapTimer) { clearTimeout(tapTimer); tapTimer = null; }
      const g = gesture;
      g.timer = setTimeout(() => {
        if (gesture !== g || g.moved) return;
        g.held = true;
        showHold(g);
        navigator.vibrate?.(25);
        // Basılı tutma = hemen sağ tık (önceki dokunuşun bekleyen sol tıkı önce). Sonra kaydırmak imleci oynatır.
        if (canInput()) { if (g.second) clickAtCursor('left'); clickAtCursor('right'); }
      }, T.PAD_HOLD_MS);
      drawCursor();
      return;
    }
    if (!canInput()) return;
    // kind: null (henüz karar yok) | 'hold' (basılı tutuldu, sağ tık gönderildi) | 'drag' (sol tuşla sürükleme)
    gesture = { id: t.identifier, x0: t.clientX, y0: t.clientY, x: t.clientX, y: t.clientY, t0: Date.now(), kind: null };
    lastPoint = toNorm(t.clientX, t.clientY);
    const g = gesture;
    g.timer = setTimeout(() => {
      if (gesture !== g || g.kind) return;
      g.kind = 'hold';
      showHold(g);
      navigator.vibrate?.(25);
      lastTap = null;
      moveNow(g.x0, g.y0);
      click('right'); // basılı tutma = hemen sağ tık
    }, T.HOLD_MS);
  }, { passive: false });

  stage.addEventListener('touchmove', (e) => {
    e.preventDefault();
    if (!gesture) return;
    const f = fingers(e.touches);
    if (gesture.two) {
      const g = gesture;
      trackMove(g, f);
      if (f.length < 2) return;
      const d = distOf(f[0], f[1]), m = midOf(f[0], f[1]);
      if (!g.kind) g.kind = T.classifyTwoFinger(g.d0, d, g.m0, m);
      if (g.kind === 'pinch') {
        view = T.pinchView(g.start, g.d0, d, g.m0, m, viewBox());
        applyView();
        g.acted = true;
      } else if (g.kind === 'pan') {
        // Doğrudan modda yakınlaştırılmışken görünüm kayar; aksi halde tekerlek.
        if (view.z > 1 && curMode() === 'direct') {
          setView({ z: view.z, tx: g.start.tx + m.x - g.m0.x, ty: g.start.ty + m.y - g.m0.y });
          g.acted = true;
        } else if (canInput()) {
          const w = T.wheelNotches(g.acc + m.y - g.wy);
          g.acc = w.rest;
          g.wy = m.y;
          if (w.n) { send({ t: 'wheel', dy: w.n * 120, dx: 0 }); g.acted = true; }
        }
      }
      return;
    }
    const t = f.find((x) => x.identifier === gesture.id);
    if (!t) return;
    if (gesture.pad) return padMove(t);
    directMove(t);
  }, { passive: false });

  function directMove(t) {
    const g = gesture;
    if (g.kind === 'hold') return; // sağ tık gönderildi; parmak kalkana dek başka girdi yok
    if (!g.kind) {
      if (Math.hypot(t.clientX - g.x0, t.clientY - g.y0) <= DRAG_THRESHOLD) return;
      // Tek parmakla sürükleme = sol tuşla sürükleme: dokunulan yerde basılır, parmağı izler.
      clearTimeout(g.timer);
      g.kind = 'drag';
      moveNow(g.x0, g.y0);
      press('left');
    }
    queueMove(t.clientX, t.clientY);
  }

  function padMove(t) {
    const g = gesture, now = Date.now();
    let dx = t.clientX - g.x, dy = t.clientY - g.y, dt = now - g.time;
    if (!g.moved) {
      if (Math.hypot(t.clientX - g.x0, t.clientY - g.y0) <= T.TAP_MOVE) return;
      // Eşik aşılınca baştan beri olan hareket uygulanır (dokunuşta titreme imleci oynatmasın).
      g.moved = true;
      // Basılı tutma süresi dolmadan kaydırınca sağ tık yok; imleç oynar (dolduysa sağ tık gitmiştir, imleç yine oynar).
      clearTimeout(g.timer);
      holdRing.hidden = true;
      dx = t.clientX - g.x0; dy = t.clientY - g.y0; dt = now - g.t0;
      if (g.second && !g.held && canInput()) {
        // Çift dokunup sürükleme: sol tuş basılı.
        g.dragging = true;
        send({ t: 'move', x: cursor.x, y: cursor.y });
        press('left');
      }
    }
    g.x = t.clientX; g.y = t.clientY; g.time = now;
    if (!canInput()) return;
    const b = viewBox();
    cursor = T.moveCursor(cursor, dx * fareHizi, dy * fareHizi, dt, b.cw, b.ch, view.z);
    if (view.z > 1) {
      view = T.followCursor(view, { x: b.ox + cursor.x * b.cw, y: b.oy + cursor.y * b.ch }, b);
      applyView();
    }
    sendCursor();
  }

  stage.addEventListener('touchend', (e) => {
    e.preventDefault();
    forgetPenTouches(e);
    if (!gesture) return;
    const left = fingers(e.touches).length;
    const now = Date.now();
    // Tek parmak hareketi kendi parmağı kalkınca biter; iki parmak hareketi tüm parmaklar kalkınca (ilk kalkış zamanı tutulur).
    if (gesture.two && left > 0) { trackMove(gesture, e.changedTouches); gesture.up1 = gesture.up1 || now; return; }
    if (!gesture.two && left > 0 && !hasId(e.changedTouches, gesture.id)) return;
    const g = gesture;
    gesture = null;
    clearTimeout(g.timer);
    holdRing.hidden = true;
    if (g.two) {
      trackMove(g, e.changedTouches);
      if (!T.isTwoFingerTap({ downGap: g.downGap, upGap: g.up1 ? now - g.up1 : 0, duration: now - g.t0, move: g.move, acted: g.acted })) return;
      // İki parmak dokunuş: yakınlaştırılmışken çift ise 1x'e dön, tek ise (touchpad) sağ tık. 1x'te her dokunuş sağ tık.
      if (view.z > 1 && g.t0 - lastTwoTap < DOUBLE_TAP_MS) {
        lastTwoTap = 0;
        clearTimeout(rightTimer); rightTimer = null;
        setView({ z: 1, tx: 0, ty: 0 });
        return;
      }
      lastTwoTap = now;
      if (curMode() !== 'touchpad') return;
      // İlk parmak ikinci gelmeden biraz kaydıysa imleç dokunuşun başladığı yere döner (sağ tık amaçlanan yere).
      if (g.cur0) { cursor = g.cur0; drawCursor(); }
      // Yakınlaştırılmışken ikinci dokunuşu bekle (1x'e dönüş olabilir).
      if (view.z > 1) rightTimer = setTimeout(() => { rightTimer = null; clickAtCursor('right'); }, DOUBLE_TAP_MS);
      else clickAtCursor('right');
      return;
    }
    if (g.pad) {
      if (g.dragging) { release('left'); return; }
      if (g.moved || !canInput()) return;
      if (g.held) return; // basılı tutma: sağ tık süre dolunca gönderildi
      if (g.second) { clickAtCursor('left', T.isTap(0, now - g.t0) ? 2 : 1); return; }
      if (!T.isTap(0, now - g.t0)) return;
      // Tek tık biraz beklenir: hemen ardından dokunup sürüklenirse sol tuşla sürükleme olur.
      tapTimer = setTimeout(() => { tapTimer = null; clickAtCursor('left'); }, DOUBLE_TAP_MS);
      return;
    }
    if (g.kind === 'drag') {
      release('left');
    } else if (!g.kind && canInput()) {
      // Dokun-bırak: hemen sol tık (move + down + up). Hemen ardından yakına dokunulursa aynı yere (çift tık).
      const p = T.snapTap(lastTap, { x: g.x0, y: g.y0 }, performance.now());
      lastTap = { ...p, time: performance.now() };
      moveNow(p.x, p.y);
      click('left');
    }
  }, { passive: false });

  stage.addEventListener('touchcancel', (e) => {
    forgetPenTouches(e);
    cancelGesture();
  });

  // ---------- Klavye ----------
  // Yazdırılabilir karakterler metin olarak gönderilir (klavye düzeninden bağımsız),
  // kısayollar ve özel tuşlar sanal tuş kodu (VK) olarak gönderilir.
  // Ctrl/Alt/Shift/Win yalnızca bir kısayolda kullanıldığında karşı tarafa basılır;
  // böylece AltGr ile yazılan karakterler (@, € ...) bozulmaz.

  const MODIFIERS = new Set([16, 17, 18, 91, 92]);
  const modState = new Map(); // vk -> { sent, used }
  const heldKeys = new Set();

  function isTextKey(e) {
    if (e.key.length !== 1) return false;
    if (e.getModifierState('AltGraph')) return true;
    return !e.ctrlKey && !e.altKey && !e.metaKey;
  }

  function flushModifiers() {
    for (const [vk, st] of modState) {
      st.used = true;
      if (!st.sent) { st.sent = true; send({ t: 'key', vk, down: true }); }
    }
  }

  window.addEventListener('keydown', (e) => {
    if (!canInput()) return;
    if (e.target === kbInput && (e.keyCode === 229 || e.key === 'Unidentified')) return;
    e.preventDefault();
    const vk = e.keyCode;
    if (!vk || vk === 229) return;

    if (MODIFIERS.has(vk)) {
      if (!modState.has(vk)) modState.set(vk, { sent: false, used: false });
      return;
    }
    if (isTextKey(e)) {
      for (const st of modState.values()) st.used = true;
      send({ t: 'text', s: e.key });
      return;
    }
    flushModifiers();
    heldKeys.add(vk);
    send({ t: 'key', vk, down: true });
  });

  window.addEventListener('keyup', (e) => {
    const vk = e.keyCode;
    if (MODIFIERS.has(vk)) {
      const st = modState.get(vk);
      modState.delete(vk);
      if (!st || !canInput()) return;
      if (st.sent) send({ t: 'key', vk, down: false });
      else if (!st.used) { send({ t: 'key', vk, down: true }); send({ t: 'key', vk, down: false }); }
      return;
    }
    if (heldKeys.delete(vk)) send({ t: 'key', vk, down: false });
  });

  // Mobil ekran klavyesi
  kbInput.addEventListener('beforeinput', (e) => {
    e.preventDefault();
    if (!canInput()) return;
    if (e.inputType === 'insertText' || e.inputType === 'insertCompositionText' || e.inputType === 'insertReplacementText') {
      if (e.data) send({ t: 'text', s: e.data });
    } else if (e.inputType === 'deleteContentBackward') {
      send({ t: 'key', vk: 8, down: true }); send({ t: 'key', vk: 8, down: false });
    } else if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') {
      send({ t: 'key', vk: 13, down: true }); send({ t: 'key', vk: 13, down: false });
    }
  });
  kbInput.addEventListener('input', () => { kbInput.value = ''; });

  function releaseAll() {
    cancelGesture(); // dokunuşla basılı tutulanlar
    for (const vk of heldKeys) send({ t: 'key', vk, down: false });
    for (const [vk, st] of modState) if (st.sent) send({ t: 'key', vk, down: false });
    for (const b of heldButtons) send({ t: 'up', b });
    heldKeys.clear();
    modState.clear();
    heldButtons.clear();
  }
  window.addEventListener('blur', releaseAll);

  // ---------- Ekran klavyesi açıkken görünür alan ----------
  // iPhone Safari'de ekran klavyesi sayfanın boyutunu değiştirmez: görünür alanı (visualViewport) küçültür ve çoğu
  // zaman sayfayı yukarı iter; görüntünün altı klavyenin arkasında kalır. Görüntüleyici (position: fixed) görünür alana
  // yerleştirilir (--vv-top / --vv-h): araç çubuğu üstte kalır, görüntü klavyenin üstündeki alana sığar. Yakınlaştırılmışken
  // son dokunulan nokta (touchpad'de imleç) görünür tutulur. Android Chrome'da (klavye görünür alanı ya da sayfayı
  // küçültür) aynı hesap çalışır. Sayfanın kendisi sıkıştırılarak yakınlaştırılmışsa (scale ≠ 1) dokunulmaz.
  const vViewer = $('vViewer');
  let fitQueued = false;
  function fitViewport() {
    fitQueued = false;
    const vv = window.visualViewport;
    // iOS'un yukarı ittiği sayfayı geri al (görüntüleyici görünür alanı zaten kendisi izliyor).
    const se = document.scrollingElement || document.documentElement;
    if (visible('vViewer') && (se.scrollTop || se.scrollLeft)) window.scrollTo(0, 0);
    const a = T.visibleArea(vv && { height: vv.height, offsetTop: vv.offsetTop, scale: vv.scale }, document.documentElement.clientHeight);
    if (!a) return;
    vViewer.style.setProperty('--vv-top', `${Math.round(a.top)}px`);
    vViewer.style.setProperty('--vv-h', `${Math.round(a.height)}px`);
    vViewer.classList.toggle('kb-open', a.covered > 80);
    if (!canView()) return;
    // Sahne boyutu değişti: görünümü yeni sınırlara oturt, yakınlaştırılmışsa son noktayı görünür tut.
    const b = viewBox();
    const n = curMode() === 'touchpad' ? cursor : lastPoint;
    view = n && view.z > 1 ? T.followCursor(view, { x: b.ox + n.x * b.cw, y: b.oy + n.y * b.ch }, b) : T.clampView(view, b);
    applyView();
  }
  function queueFit() {
    if (fitQueued) return;
    fitQueued = true;
    requestAnimationFrame(fitViewport);
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', queueFit);
    window.visualViewport.addEventListener('scroll', queueFit);
  }
  window.addEventListener('resize', queueFit);
  window.addEventListener('scroll', queueFit);
  // Klavye açılıp kapanırken iOS boyutları animasyonla değiştirir; sonda bir kez daha ölç.
  const fitLater = () => { queueFit(); setTimeout(queueFit, 350); };
  kbInput.addEventListener('focus', fitLater);
  kbInput.addEventListener('blur', fitLater);
  on('viewer:start', queueFit);
  queueFit();

  // ---------- Yönetim paneli ----------

  const admin = (op, extra = {}) => send({ t: 'admin', op, ...extra });

  $('adminBtn').addEventListener('click', () => { $('adminMsg').textContent = ''; show('vAdmin'); admin('list'); });
  $('adminClose').addEventListener('click', () => goHome());
  $('setGuestOtp').addEventListener('change', (e) => admin('setSetting', { key: 'guestOtp', value: e.target.checked }));
  $('setGuestRole').addEventListener('change', (e) => admin('setSetting', { key: 'guestRole', value: e.target.value }));
  $('setApproval').addEventListener('change', (e) => admin('setSetting', { key: 'requireApproval', value: e.target.checked }));
  $('setTrustTs').addEventListener('change', (e) => admin('setSetting', { key: 'trustTailscale', value: e.target.checked }));
  $('setBlockPublic').addEventListener('change', (e) => admin('setSetting', { key: 'blockPublicLan', value: e.target.checked }));
  $('tsBox').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-copy]');
    if (!b) return;
    navigator.clipboard?.writeText(b.dataset.copy).then(() => { b.textContent = 'Kopyalandı'; }, () => {});
  });
  $('newCodeBtn').addEventListener('click', () => admin('newGuestCode'));
  $('addUserForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    admin('addUser', { username: f.username.value.trim(), password: f.password.value, role: f.role.value });
    f.reset();
  });

  const VIA_NAMES = { local: 'bu bilgisayar', lan: 'ev ağı', tailscale: 'Tailscale' };
  const LOG_NAMES = { login: 'Giriş', failed: 'Hatalı giriş', rejected: 'Reddedildi', setup: 'Kurulum', admin: 'Yönetim', extend: 'İkinci ekran' };

  function roleSelect(username, role) {
    return `<select data-act="role" data-user="${esc(username)}">${
      Object.entries(ROLE_NAMES).map(([k, v]) => `<option value="${k}"${k === role ? ' selected' : ''}>${v}</option>`).join('')
    }</select>`;
  }

  function renderAdmin(m) {
    emit('admin', m); // özellikler kendi bölümlerini m.features.<ad> ile günceller
    const msg = $('adminMsg');
    msg.textContent = m.error || m.ok || '';
    msg.className = `msg ${m.error ? 'err' : 'ok'}`;

    $('setGuestOtp').checked = m.settings.guestOtp;
    $('guestRow').hidden = !m.settings.guestOtp;
    $('guestCode').textContent = m.guestCode || '—';
    $('setGuestRole').value = m.settings.guestRole;
    $('setApproval').checked = m.settings.requireApproval;
    $('setTrustTs').checked = m.settings.trustTailscale;
    $('setTrustTs').disabled = !m.settings.requireApproval;
    $('setBlockPublic').checked = m.settings.blockPublicLan;
    const NET_NAMES = { Public: 'Ortak', Private: 'Özel', DomainAuthenticated: 'Etki alanı' };
    $('netList').innerHTML = (m.networks || []).map((n) => `${esc(n.ad || n.arayuz)} (${esc(n.ip)}): <b>${NET_NAMES[n.k]}</b>${
      n.k === 'Public' ? (m.settings.blockPublicLan ? ' — buradan giriş kapalı' : ' — <b style="color:var(--error)">buradan giriş açık</b>') : ''}`).join('<br>');
    renderTailscale(m.tailscale, m.port);

    $('usersTable').innerHTML = '<tr><th>Kullanıcı</th><th>Yetki</th><th></th></tr>' + m.users.map((u) => `
      <tr>
        <td>${esc(u.username)}${u.username === me.username ? ' <span class="muted">(sen)</span>' : ''}</td>
        <td>${roleSelect(u.username, u.role)}</td>
        <td><div class="row">
          <button class="small ghost" data-act="pw" data-user="${esc(u.username)}">Şifre</button>
          <button class="small danger" data-act="del" data-user="${esc(u.username)}">Sil</button>
        </div></td>
      </tr>`).join('');

    $('devicesTable').innerHTML = m.devices.length
      ? '<tr><th>Cihaz</th><th>Kullanıcı</th><th>Son görülme</th><th>IP</th><th></th></tr>' + m.devices.map((d) => `
        <tr>
          <td>${esc(d.name)}</td><td>${esc(d.username)}</td><td>${fmtTime(d.lastSeen)}</td><td>${esc(d.lastIp)}</td>
          <td><button class="small danger" data-act="rmdev" data-id="${esc(d.id)}">Kaldır</button></td>
        </tr>`).join('')
      : '<tr><td class="muted">Hatırlanan cihaz yok.</td></tr>';

    $('onlineTable').innerHTML = m.online.length
      ? '<tr><th>Kullanıcı</th><th>Yetki</th><th>IP</th><th>Bağlantı</th></tr>' + m.online.map((o) => `
        <tr><td>${esc(o.username)}</td><td>${esc(ROLE_NAMES[o.role] || o.role)}</td><td>${esc(o.ip)}</td><td>${esc(VIA_NAMES[o.via] || '')}</td></tr>`).join('')
      : '<tr><td class="muted">Kimse bağlı değil.</td></tr>';

    $('logTable').innerHTML = m.log.length
      ? '<tr><th>Zaman</th><th>Olay</th><th>Kullanıcı</th><th>IP / Ayrıntı</th></tr>' + m.log.map((l) => `
        <tr><td>${fmtTime(l.time)}</td><td>${esc(LOG_NAMES[l.event] || l.event)}</td><td>${esc(l.user || '')}</td>
        <td>${esc([l.ip, VIA_NAMES[l.via], l.device, l.op, l.target, l.size].filter(Boolean).join(' · '))}</td></tr>`).join('')
      : '<tr><td class="muted">Kayıt yok.</td></tr>';
  }

  function renderTailscale(ts, port) {
    const urlRow = (u, note) => `<div class="row gap wrap"><span class="url">${esc(u)}</span>
      <button class="small ghost" data-copy="${esc(u)}">Kopyala</button><span class="muted small">${note}</span></div>`;
    let html;
    if (!ts.installed) {
      html = `<p><span class="dot"></span>Tailscale kurulu değil.</p>
        <p class="muted small">Bilgisayarda <b>tailscale-kur.bat</b> dosyasını çalıştır. Sonra telefonuna Tailscale uygulamasını kurup aynı hesapla giriş yap.</p>`;
    } else if (!ts.running) {
      html = `<p><span class="dot"></span>Tailscale kurulu ama bağlı değil.</p>
        <p class="muted small">Görev çubuğundaki Tailscale simgesinden giriş yap ya da <b>tailscale-kur.bat</b> dosyasını tekrar çalıştır.</p>`;
    } else {
      html = `<p><span class="dot on"></span>Tailscale bağlı. Telefonunda Tailscale açıkken şu adreslerden bağlanabilirsin:</p>
        ${ts.httpsUrl ? urlRow(ts.httpsUrl, 'önerilen (HTTPS)') : ''}
        ${ts.dns ? urlRow(`http://${ts.dns}:${port}`, '') : ''}
        ${ts.ip ? urlRow(`http://${ts.ip}:${port}`, '') : ''}
        ${ts.httpsUrl ? '' : '<p class="muted small">HTTPS adresi için <b>tailscale-kur.bat</b> dosyasını tekrar çalıştır (Tailscale HTTPS özelliğini açar).</p>'}`;
    }
    $('tsBox').innerHTML = html;
  }

  $('vAdmin').addEventListener('change', (e) => {
    const el = e.target;
    if (el.dataset.act === 'role') admin('setRole', { username: el.dataset.user, role: el.value });
  });
  $('vAdmin').addEventListener('click', (e) => {
    const el = e.target.closest('button[data-act]');
    if (!el) return;
    const user = el.dataset.user;
    if (el.dataset.act === 'del' && confirm(`"${user}" kullanıcısı silinsin mi? Hatırlanan cihazları da silinir.`)) {
      admin('deleteUser', { username: user });
    } else if (el.dataset.act === 'pw') {
      const pw = prompt(`"${user}" için yeni şifre (en az 6 karakter). Hatırlanan cihazlarının kaydı silinir:`);
      if (pw) admin('setPassword', { username: user, password: pw });
    } else if (el.dataset.act === 'rmdev' && confirm('Bu cihaz unutulsun mu? Bir dahaki girişte şifre sorulur.')) {
      admin('removeDevice', { id: el.dataset.id });
    }
  });

  // ---------- Özellik betikleri için arayüz ----------
  // public/features/*.js dosyaları window.RC üzerinden çekirdeğe bağlanır.

  function insertBefore(anchorId, el) {
    const anchor = $(anchorId);
    anchor.parentNode.insertBefore(el, anchor);
    return el;
  }

  window.RC = {
    send,
    on,
    // vdd: sanal ekran sürücüsü kurulu mu (ikinci ekran kullanılabilir mi)
    state: () => ({ me: me && { ...me }, stream: stream && { ...stream }, screens: [...screens], connected: ws?.readyState === 1, vdd: !!vddAvailable }),
    canInput,
    // Son bir saniyenin görüntü ölçümleri: { fps, kbps, decodeMs (geliş→çizim, ort.), codec,
    //   intervalMs (kare aralığı ort.), jitterMs (aralığın standart sapması), maxIntervalMs, stutters (takılma sayısı) }
    // Kare yokken aralık alanları null. Durağan ekrandan (sunucu kare göndermedi) sonraki aralık sayılmaz.
    stats: () => ({ ...lastStats }),
    // Sayfa açıldığından beri WebSocket baytları (birikimli): { goruntu (JPEG/H.264), ses, diger (JSON ve diğer ikili), giden }
    traffic: () => ({ ...traffic }),
    // Kalem özelliği, kalem olaylarını kendisi işlediği sürece true dönen bir fonksiyon kaydeder.
    setPenActive(fn) { penActive = typeof fn === 'function' ? fn : () => false; },
    // Girişi üstlenmek isteyen özellik (QR eşleştirme): fn(hello) giriş mesajını kendisi gönderip true döner.
    // Sunucunun 'auth' cevabını çekirdek işler; başarısızsa kayıtlı cihaz anahtarı varsa onunla denenir.
    setAuthHook(fn) { authHook = typeof fn === 'function' ? fn : () => false; },
    deviceName,
    toNorm,
    moveNow,
    queueMove,
    click,
    overlay,
    esc,
    fmtTime,
    // Özellik HTTP adreslerine oturumla istek atar (ör. dosya yükleme).
    fetch(url, opts = {}) {
      return fetch(url, { ...opts, headers: { ...(opts.headers || {}), 'X-Oturum': httpToken || '' } });
    },
    // İndirme bağlantıları gibi başlık eklenemeyen yerler için.
    authUrl(url) {
      const u = new URL(url, location.href);
      u.searchParams.set('oturum', httpToken || '');
      return u.pathname + u.search;
    },
    ui: {
      toolbar: (el) => insertBefore('fps', el),          // araç çubuğunun sağ ucuna öğe ekle (her genişlikte görünür; yenilerde menuItem tercih edin)
      menuItem,                                          // ⋯ menüsüne satır (pin: geniş ekranda çubukta da simge)
      panel,                                             // ✕ ile kapanan ortak panel: { el, head, body, open, close, toggle, isOpen, addAnchor, setTitle }
      closable,                                          // kendi kabuğu olan paneli Esc ile kapanacak şekilde kaydet
      // ana menüye öğe ekle: düğme (ya da düğmeli kutu: düğme + açılır bölüm) araçlar ızgarasına, diğerleri (uyarı şeridi) kartların üstüne
      home(el) {
        const btn = el.matches('button') ? el : el.querySelector(':scope > button');
        if (!btn) return document.querySelector('#vHome .modes').before(el);
        insertBefore('adminBtn', el);
        aracDugmesi(btn);
        return el;
      },
      adminSection(title, el) {                          // yönetim paneline bölüm ekle
        const h = document.createElement('h2');
        h.textContent = title;
        const box = document.createElement('div');
        box.className = 'box';
        box.appendChild(el);
        const admin = document.querySelector('#vAdmin .admin');
        admin.appendChild(h);
        admin.appendChild(box);
        return box;
      },
      stage: () => stage,
      canvas: () => canvas,
    },
  };

  // ---------- Alt çubuk (telefon) ----------
  // Dar ekranda sık kullanılan kontroller altta, simge + yazı olarak (başparmakla erişilir; telefon dik tutulunca görüntünün
  // altında zaten boş alan kalır). Düğmeler TAŞINIR (kopyalanmaz): kimlikler ve dinleyiciler aynı kalır. Geniş ekranda üst
  // çubuktadırlar. Sıra: Klavye, Tuşlar, dokunma modu, Sağ tık, menuItem({ alt }) ile eklenenler (ör. Pano), Diğer (⋯ menü).
  const darEkran = window.matchMedia('(max-width: 719px)');
  function yerlesim() {
    const dar = darEkran.matches;
    document.body.classList.toggle('rc-alt', dar);
    const ana = ['kbBtn', 'tusBtn', 'touchModeBtn', 'rightBtn'].map($).filter(Boolean);
    if (dar) {
      for (const el of ana) altCubuk.appendChild(el);
      for (const p of [...altPinler].sort((a, b) => a.order - b.order)) altCubuk.appendChild(p.el);
      altCubuk.appendChild(menuBtn);
    } else {
      let onceki = $('status');
      for (const el of ana) { onceki.after(el); onceki = el; }
      for (const p of altPinler) { if (p.pin) addOrdered($('tbPins'), p.el, p.order); else p.el.remove(); }
      toolbarEl.appendChild(menuBtn);
    }
    relayout();
  }
  yerlesim();
  darEkran.addEventListener?.('change', yerlesim);

  // Özellik betiklerini yükle, sonra bağlan.
  fetch('/api/features')
    .then((r) => (r.ok ? r.json() : []))
    .catch(() => [])
    .then((list) => Promise.all(list.map((src) => new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => { console.error('Özellik yüklenemedi:', src); resolve(); };
      document.body.appendChild(s);
    }))))
    .finally(() => { yerlesim(); connect(); }); // özelliklerin düğmeleri (Tuşlar, Pano) de yerine
})();
