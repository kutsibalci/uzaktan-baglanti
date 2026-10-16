(() => {
  const $ = (id) => document.getElementById(id);
  const canvas = $('screen');
  const ctx = canvas.getContext('2d');
  const stage = $('stage');
  const kbInput = $('kbInput');

  // quality/fps JPEG için, kbps H.264 için.
  const QUALITY = {
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
  let codecLabel = '';
  let httpToken = null;       // özelliklerin HTTP istekleri için (X-Oturum başlığı)

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
  function show(id) {
    for (const v of VIEWS) $(v).hidden = v !== id;
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
    ws.onmessage = (e) => (typeof e.data === 'string' ? onJson(JSON.parse(e.data)) : onFrame(e.data));
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

  function send(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
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
    overlay('');
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    $('helloName').textContent = `Merhaba, ${me.username}`;
    $('helloRole').textContent = `Yetki: ${ROLE_NAMES[me.role] || me.role}${me.guest ? ' (misafir)' : ''}`;
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

  function fillScreens(sel, list, current) {
    sel.innerHTML = '';
    list.forEach((s, i) => {
      const o = document.createElement('option');
      o.value = s.name;
      o.textContent = `Ekran ${i + 1} — ${s.w}×${s.h}${s.primary ? ' (ana)' : ''}`;
      sel.appendChild(o);
    });
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
    canvas.width = 0;
    canvas.height = 0;
    overlay(msg);
    show('vViewer');
  }

  function onStarted(m) {
    screens = m.screens || screens;
    stream = { mode: m.mode, screen: m.screen, started: true };
    const extend = m.mode === 'extend';
    $('screenSel').hidden = extend || screens.length < 2;
    fillScreens($('screenSel'), screens, m.screen);
    $('quality').hidden = extend;
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

  function applyRole() {
    const viewOnly = me?.role === 'view';
    $('viewOnly').hidden = !viewOnly;
    document.querySelectorAll('#toolbar .ctl').forEach((el) => { el.hidden = viewOnly; });
  }

  function draw(src) {
    const w = src.displayWidth || src.width, h = src.displayHeight || src.height;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    ctx.drawImage(src, 0, 0, w, h);
    frameCount++;
  }

  // İkili mesajın ilk baytı: 1 = JPEG kare, 2 = H.264 kare ([2][anahtar kare mi][veri]).
  function onFrame(ab) {
    const u8 = new Uint8Array(ab);
    if (u8[0] > 2) { emit(`binary:${u8[0]}`, u8); return; } // özellik verisi görüntüden bağımsız
    if (!stream) return;
    if (u8[0] === 1) {
      // JPEG: çizilince sunucuya bildir; sunucu ancak o zaman yeni kare yollar.
      createImageBitmap(new Blob([u8.subarray(1)], { type: 'image/jpeg' }))
        .then((bmp) => { draw(bmp); bmp.close(); })
        .catch(() => {})
        .finally(() => send({ t: 'ack' }));
    } else if (u8[0] === 2) {
      decodeH264(u8[1] === 1, u8.subarray(2));
    }
  }

  // ---------- H.264 çözme ----------

  let decoder = null;
  let chunkTs = 0;

  function configureDecoder(m) {
    closeDecoder();
    decoder = new VideoDecoder({
      output: (frame) => { draw(frame); frame.close(); },
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

  function decodeH264(key, data) {
    if (!decoder || decoder.state !== 'configured') return;
    // Çözücü geride kaldıysa (yavaş cihaz) kuyruğu boşaltıp anahtar kareden devam et.
    if (decoder.decodeQueueSize > 8 && !key) {
      closeDecoder();
      send({ t: 'keyframe' });
      return;
    }
    try {
      decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: (chunkTs += 33333), data }));
    } catch {
      closeDecoder();
      send({ t: 'keyframe' });
    }
  }

  function closeDecoder() {
    if (decoder && decoder.state !== 'closed') { try { decoder.close(); } catch { /* zaten kapalı */ } }
    decoder = null;
  }

  function setStatus(on) {
    $('status').classList.toggle('on', on);
    $('status').title = on ? 'Bağlı' : 'Bağlantı yok';
  }

  setInterval(() => {
    $('fps').textContent = stream ? `${frameCount} fps · ${codecLabel}` : '';
    frameCount = 0;
  }, 1000);

  $('backBtn').addEventListener('click', () => { send({ t: 'stop' }); goHome(); });
  $('quality').addEventListener('change', (e) => send({ t: 'settings', ...QUALITY[e.target.value] }));
  $('screenSel').addEventListener('change', (e) => {
    stream.screen = e.target.value;
    send({ t: 'screen', name: e.target.value });
  });
  $('fsBtn').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  });
  $('hideBtn').addEventListener('click', () => { $('toolbar').hidden = true; $('showBtn').hidden = false; });
  $('showBtn').addEventListener('click', () => { $('toolbar').hidden = false; $('showBtn').hidden = true; });
  $('kbBtn').addEventListener('click', () => { kbInput.value = ''; kbInput.focus(); });

  const COMBOS = {
    win: [91],
    alttab: [18, 9],
    esc: [27],
    taskmgr: [17, 16, 27],
    showdesk: [91, 68],
    copy: [17, 67],
    paste: [17, 86],
  };
  $('keysSel').addEventListener('change', (e) => {
    const keys = COMBOS[e.target.value];
    e.target.value = '';
    if (!keys) return;
    keys.forEach((vk) => send({ t: 'key', vk, down: true }));
    [...keys].reverse().forEach((vk) => send({ t: 'key', vk, down: false }));
  });

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
  function click(b) {
    send({ t: 'down', b });
    send({ t: 'up', b });
  }

  // ---------- Fare ----------

  const BTN = ['left', 'middle', 'right'];
  const heldButtons = new Set();

  stage.addEventListener('mousemove', (e) => queueMove(e.clientX, e.clientY));
  stage.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const b = BTN[e.button];
    if (!b || !canInput()) return;
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
  // Tek dokunuş = sol tık, uzun basma = sağ tık, sürükleme = sol tuşla sürükleme, iki parmak = kaydırma.

  let touch = null;
  const LONG_PRESS_MS = 550;
  const DRAG_THRESHOLD = 10;

  stage.addEventListener('touchstart', (e) => {
    e.preventDefault();
    if (!canInput()) return;
    if (e.touches.length === 2) {
      if (touch?.timer) clearTimeout(touch.timer);
      if (touch?.dragging) send({ t: 'up', b: 'left' });
      touch = { scroll: true, y: avgY(e.touches), acc: 0 };
      return;
    }
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    touch = { x0: t.clientX, y0: t.clientY, dragging: false, long: false };
    touch.timer = setTimeout(() => {
      touch.long = true;
      moveNow(touch.x0, touch.y0);
      click('right');
      navigator.vibrate?.(30);
    }, LONG_PRESS_MS);
  }, { passive: false });

  stage.addEventListener('touchmove', (e) => {
    e.preventDefault();
    if (!touch) return;
    if (touch.scroll) {
      if (e.touches.length < 2) return;
      const y = avgY(e.touches);
      touch.acc += y - touch.y;
      touch.y = y;
      const steps = Math.trunc(touch.acc / 30);
      if (steps) { send({ t: 'wheel', dy: steps * 120, dx: 0 }); touch.acc -= steps * 30; }
      return;
    }
    const t = e.touches[0];
    if (!touch.dragging && !touch.long && Math.hypot(t.clientX - touch.x0, t.clientY - touch.y0) > DRAG_THRESHOLD) {
      clearTimeout(touch.timer);
      touch.dragging = true;
      moveNow(touch.x0, touch.y0);
      send({ t: 'down', b: 'left' });
    }
    if (touch.dragging) queueMove(t.clientX, t.clientY);
  }, { passive: false });

  stage.addEventListener('touchend', (e) => {
    e.preventDefault();
    if (!touch || e.touches.length > 0) return;
    clearTimeout(touch.timer);
    if (touch.dragging) {
      send({ t: 'up', b: 'left' });
    } else if (!touch.long && !touch.scroll) {
      moveNow(touch.x0, touch.y0);
      click('left');
    }
    touch = null;
  }, { passive: false });

  function avgY(list) {
    let s = 0;
    for (const t of list) s += t.clientY;
    return s / list.length;
  }

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
    for (const vk of heldKeys) send({ t: 'key', vk, down: false });
    for (const [vk, st] of modState) if (st.sent) send({ t: 'key', vk, down: false });
    for (const b of heldButtons) send({ t: 'up', b });
    heldKeys.clear();
    modState.clear();
    heldButtons.clear();
  }
  window.addEventListener('blur', releaseAll);

  // ---------- Yönetim paneli ----------

  const admin = (op, extra = {}) => send({ t: 'admin', op, ...extra });

  $('adminBtn').addEventListener('click', () => { $('adminMsg').textContent = ''; show('vAdmin'); admin('list'); });
  $('adminClose').addEventListener('click', () => goHome());
  $('setGuestOtp').addEventListener('change', (e) => admin('setSetting', { key: 'guestOtp', value: e.target.checked }));
  $('setGuestRole').addEventListener('change', (e) => admin('setSetting', { key: 'guestRole', value: e.target.value }));
  $('setApproval').addEventListener('change', (e) => admin('setSetting', { key: 'requireApproval', value: e.target.checked }));
  $('setTrustTs').addEventListener('change', (e) => admin('setSetting', { key: 'trustTailscale', value: e.target.checked }));
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
    state: () => ({ me: me && { ...me }, stream: stream && { ...stream }, screens: [...screens], connected: ws?.readyState === 1 }),
    canInput,
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
      toolbar: (el) => insertBefore('fps', el),          // görüntüleyici araç çubuğuna öğe ekle
      home: (el) => insertBefore('adminBtn', el),        // ana menü kartına öğe ekle
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
    .finally(connect);
})();
