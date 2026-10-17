(() => {
  const $ = (id) => document.getElementById(id);
  const canvas = $('screen');
  const ctx = canvas.getContext('2d');
  const stage = $('stage');
  const kbInput = $('kbInput');

  // quality/fps JPEG için, kbps H.264 için.
  // auto: JPEG'de sunucu kaliteyi ve genişliği ağa göre seçer (quality/maxWidth tavandır); H.264'te "Orta" ile aynıdır.
  const QUALITY = {
    auto: { quality: 70, maxWidth: 1920, fps: 30, kbps: 4000, auto: true },
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
  let lastStats = { fps: 0, kbps: 0, decodeMs: null, codec: '' };
  let lastDrawAt = 0;
  const intervals = [];        // son birkaç saniyenin kare aralıkları { t: çizim anı, ms } (titreşim/takılma için)
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
    // Görüntüleme biterken basılı tuş/düğme kalmasın: sunucu 'stop'tan sonra girdi kabul etmez, önce bırakılır.
    if (obj.t === 'stop') releaseAll();
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
      case 'durgun': stillPending = true; return; // ekran durağan: sıradaki karenin aralığı takılma sayılmaz
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
    resetJpeg();
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

  // afterStill: bu kareden önce ekran durağandı (sunucu 'durgun' bildirdi); aradaki süre kare aralığı sayılmaz.
  function draw(src, afterStill = false) {
    const w = src.displayWidth || src.width, h = src.displayHeight || src.height;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    ctx.drawImage(src, 0, 0, w, h);
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

  function onJpeg(data, recv, afterStill) {
    if (jpegBusy) {
      if (jpegWaiting) { send({ t: 'ack' }); afterStill = afterStill || jpegWaiting.afterStill; }
      jpegWaiting = { data, recv, afterStill };
      return;
    }
    jpegBusy = true;
    createImageBitmap(new Blob([data], { type: 'image/jpeg' }))
      .then((bmp) => paint(bmp, recv, afterStill))
      .catch(() => {})
      .finally(() => {
        send({ t: 'ack' });
        jpegBusy = false;
        const next = jpegWaiting;
        jpegWaiting = null;
        if (next) onJpeg(next.data, next.recv, next.afterStill);
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

  // İkili mesajın ilk baytı: 1 = JPEG kare, 2 = H.264 kare ([2][anahtar kare mi][veri]).
  function onFrame(ab) {
    const u8 = new Uint8Array(ab);
    if (u8[0] > 2) { emit(`binary:${u8[0]}`, u8); return; } // özellik verisi görüntüden bağımsız
    if (!stream) { if (u8[0] === 1) send({ t: 'ack' }); return; }
    byteCount += u8.length;
    const recv = performance.now();
    if (u8[0] === 1) {
      const afterStill = stillPending;
      stillPending = false;
      onJpeg(u8.subarray(1), recv, afterStill);
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
  // İki mod (araç çubuğundaki düğmeyle değişir, seçim hatırlanır):
  //  Doğrudan: parmağın değdiği yer tıklanır. Dokun-bırak = sol tık (çift dokunuş = çift tık), parmakla hızlı sürükleme =
  //            kaydırma (tekerlek; ekranı telefonda kaydırır gibi), hareketsiz basılı tut (HOLD_MS, halka + titreşim) sonra
  //            sürükle = sol tuşla sürükleme (seçme, pencere taşıma), basılı tut sonra bırak = sağ tık.
  //            İki parmak = kaydırma (yakınlaştırılmışken görünümü kaydırır).
  //            Neden: telefonda tek parmak sürüklemesi kaydırma demektir; eskiden her sürükleme sol tuşu basılı tutuyordu
  //            ve sayfayı kaydırmak isteyince metin seçiliyor / pencere sürükleniyordu. Bilerek sürüklemek için önce kısa bir
  //            "tut" gerekir — touchpad modundaki "dokun, sonra dokunup sürükle" ile aynı fikir: tuşa basmak ayrı bir hareket.
  //  Touchpad: dizüstü touchpad'i gibi. Tek parmak imleci göreli (ivmeli) taşır, dokunuş = sol tık,
  //            iki parmak dokunuş = sağ tık, iki parmak kaydırma = tekerlek, çift dokunup sürükleme = sol tuşla sürükleme.
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
  let touchMode = storage.get('touchMode') === 'touchpad' ? 'touchpad' : 'direct';
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
  // Doğrudan mod: "basılı tutuldu" göstergesi (şimdi sürüklersen sol tuşla sürükleme, bırakırsan sağ tık).
  const holdRing = document.createElement('div');
  holdRing.id = 'tpHold';
  holdRing.hidden = true;
  stage.appendChild(holdRing);

  const penTouchIds = new Set();
  const fingers = (list) => [...list].filter((t) => !penTouchIds.has(t.identifier) && !(t.touchType === 'stylus' && penActive()));
  const forgetPenTouches = (e) => { for (const t of e.changedTouches) penTouchIds.delete(t.identifier); };
  const curMode = () => (canInput() ? touchMode : 'direct');
  const canView = () => stream?.started && visible('vViewer');
  const viewBox = () => T.contentBox(stage.clientWidth, stage.clientHeight, canvas.width, canvas.height);
  function local(t) {
    const r = stage.getBoundingClientRect();
    return { x: t.clientX - r.left, y: t.clientY - r.top };
  }
  const midOf = (a, b) => { const p = local(a), q = local(b); return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }; };
  const distOf = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  const hasId = (list, id) => [...list].some((t) => t.identifier === id);

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
    $('zoomBtn').textContent = `${view.z.toFixed(1)}× ✕`;
    drawCursor();
  }
  function setView(v) {
    view = T.clampView(v, viewBox());
    applyView();
  }

  // Touchpad imlecinin yerel göstergesi (karşıdan gelen görüntüdeki imleç gecikmeli olabilir).
  function drawCursor() {
    tpCursor.hidden = touchMode !== 'touchpad' || !canInput() || !canvas.width;
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

  function setTouchMode(mode) {
    cancelGesture();
    touchMode = mode;
    storage.set('touchMode', mode);
    $('touchModeBtn').textContent = mode === 'touchpad' ? '🖱 Touchpad' : '👆 Doğrudan';
    $('touchModeBtn').title = mode === 'touchpad' ? 'Dokunmatik: touchpad modu (değiştir)' : 'Dokunmatik: doğrudan mod (değiştir)';
    drawCursor();
  }
  setTouchMode(touchMode);
  $('touchModeBtn').addEventListener('click', () => setTouchMode(touchMode === 'touchpad' ? 'direct' : 'touchpad'));
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
    const f = fingers(e.touches);
    // Ekrandaki parmakların hepsi yeniyse önceki hareketin bitişi kaçırılmıştır (touchend/touchcancel gelmedi): bırak.
    if (gesture && f.every((t) => hasId(e.changedTouches, t.identifier))) cancelGesture();
    if (f.length >= 2) {
      if (gesture?.two) return;
      endSingle();
      flushTap();
      gesture = { two: true, d0: distOf(f[0], f[1]), m0: midOf(f[0], f[1]), start: { ...view }, kind: null, t0: Date.now(), acc: 0 };
      gesture.wy = gesture.m0.y;
      return;
    }
    if (f.length !== 1 || gesture) return;
    const t = f[0];
    if (curMode() === 'touchpad') {
      gesture = { pad: true, id: t.identifier, x0: t.clientX, y0: t.clientY, x: t.clientX, y: t.clientY, time: Date.now(), t0: Date.now(), moved: false, dragging: false, second: !!tapTimer };
      if (tapTimer) { clearTimeout(tapTimer); tapTimer = null; }
      drawCursor();
      return;
    }
    if (!canInput()) return;
    // kind: null (henüz karar yok) | 'scroll' (tekerlek) | 'hold' (basılı tutuldu) | 'drag' (sol tuşla sürükleme)
    gesture = { id: t.identifier, x0: t.clientX, y0: t.clientY, x: t.clientX, y: t.clientY, kind: null, axis: null, acc: 0 };
    lastPoint = toNorm(t.clientX, t.clientY);
    const g = gesture;
    g.timer = setTimeout(() => {
      if (gesture !== g || g.kind) return;
      g.kind = 'hold';
      showHold(g);
      navigator.vibrate?.(25);
    }, T.HOLD_MS);
  }, { passive: false });

  stage.addEventListener('touchmove', (e) => {
    e.preventDefault();
    if (!gesture) return;
    const f = fingers(e.touches);
    if (gesture.two) {
      if (f.length < 2) return;
      const g = gesture;
      const d = distOf(f[0], f[1]), m = midOf(f[0], f[1]);
      if (!g.kind) g.kind = T.classifyTwoFinger(g.d0, d, g.m0, m);
      if (g.kind === 'pinch') {
        view = T.pinchView(g.start, g.d0, d, g.m0, m, viewBox());
        applyView();
      } else if (g.kind === 'pan') {
        // Doğrudan modda yakınlaştırılmışken görünüm kayar; aksi halde tekerlek.
        if (view.z > 1 && curMode() === 'direct') {
          setView({ z: view.z, tx: g.start.tx + m.x - g.m0.x, ty: g.start.ty + m.y - g.m0.y });
        } else if (canInput()) {
          const w = T.wheelNotches(g.acc + m.y - g.wy);
          g.acc = w.rest;
          g.wy = m.y;
          if (w.n) send({ t: 'wheel', dy: w.n * 120, dx: 0 });
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
    const far = Math.hypot(t.clientX - g.x0, t.clientY - g.y0) > DRAG_THRESHOLD;
    if (!g.kind) {
      if (!far) return;
      // Basılı tutmadan sürükleme: kaydırma. İmleç önce parmağın altına gider (tekerlek o pencereye gitsin).
      clearTimeout(g.timer);
      g.kind = 'scroll';
      g.axis = Math.abs(t.clientX - g.x0) > Math.abs(t.clientY - g.y0) ? 'x' : 'y';
      moveNow(g.x0, g.y0);
      g.x = g.x0; g.y = g.y0;
    }
    if (g.kind === 'hold') {
      if (!far) return;
      g.kind = 'drag';
      holdRing.hidden = true;
      moveNow(g.x0, g.y0);
      press('left');
    }
    if (g.kind === 'drag') { queueMove(t.clientX, t.clientY); return; }
    // Kaydırma: parmak aşağı = içerik aşağı (yukarı kaydır, tekerlek +), parmak sola = sağa kaydır.
    const w = T.wheelNotches(g.acc + (g.axis === 'x' ? t.clientX - g.x : t.clientY - g.y));
    g.acc = w.rest;
    g.x = t.clientX; g.y = t.clientY;
    if (w.n && canInput()) send(g.axis === 'x' ? { t: 'wheel', dy: 0, dx: -w.n * 120 } : { t: 'wheel', dy: w.n * 120, dx: 0 });
  }

  function padMove(t) {
    const g = gesture, now = Date.now();
    let dx = t.clientX - g.x, dy = t.clientY - g.y, dt = now - g.time;
    if (!g.moved) {
      if (Math.hypot(t.clientX - g.x0, t.clientY - g.y0) <= T.TAP_MOVE) return;
      // Eşik aşılınca baştan beri olan hareket uygulanır (dokunuşta titreme imleci oynatmasın).
      g.moved = true;
      dx = t.clientX - g.x0; dy = t.clientY - g.y0; dt = now - g.t0;
      if (g.second && canInput()) {
        // Çift dokunup sürükleme: sol tuş basılı.
        g.dragging = true;
        send({ t: 'move', x: cursor.x, y: cursor.y });
        press('left');
      }
    }
    g.x = t.clientX; g.y = t.clientY; g.time = now;
    if (!canInput()) return;
    const b = viewBox();
    cursor = T.moveCursor(cursor, dx, dy, dt, b.cw, b.ch, view.z);
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
    // Tek parmak hareketi kendi parmağı kalkınca biter; iki parmak hareketi tüm parmaklar kalkınca.
    if (gesture.two ? left > 0 : left > 0 && !hasId(e.changedTouches, gesture.id)) return;
    const g = gesture;
    gesture = null;
    clearTimeout(g.timer);
    holdRing.hidden = true;
    const now = Date.now();
    if (g.two) {
      if (g.kind || now - g.t0 > T.TAP_MS * 1.5) return;
      // İki parmak dokunuş: çift ise 1x'e dön, tek ise (touchpad) sağ tık.
      if (now - lastTwoTap < DOUBLE_TAP_MS + T.TAP_MS) {
        lastTwoTap = 0;
        clearTimeout(rightTimer); rightTimer = null;
        setView({ z: 1, tx: 0, ty: 0 });
        return;
      }
      lastTwoTap = now;
      if (touchMode !== 'touchpad' || !canInput()) return;
      // Yakınlaştırılmışken ikinci dokunuşu bekle (1x'e dönüş olabilir).
      if (view.z > 1) rightTimer = setTimeout(() => { rightTimer = null; clickAtCursor('right'); }, DOUBLE_TAP_MS);
      else clickAtCursor('right');
      return;
    }
    if (g.pad) {
      if (g.dragging) { release('left'); return; }
      if (g.moved || !canInput()) return;
      if (g.second) { clickAtCursor('left', T.isTap(0, now - g.t0) ? 2 : 1); return; }
      if (!T.isTap(0, now - g.t0)) return;
      // Tek tık biraz beklenir: hemen ardından dokunup sürüklenirse sol tuşla sürükleme olur.
      tapTimer = setTimeout(() => { tapTimer = null; clickAtCursor('left'); }, DOUBLE_TAP_MS);
      return;
    }
    if (g.kind === 'drag') {
      release('left');
    } else if (g.kind === 'hold' && canInput()) {
      moveNow(g.x0, g.y0);
      click('right');
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
    // Son bir saniyenin görüntü ölçümleri: { fps, kbps, decodeMs (geliş→çizim, ort.), codec,
    //   intervalMs (kare aralığı ort.), jitterMs (aralığın standart sapması), maxIntervalMs, stutters (takılma sayısı) }
    // Kare yokken aralık alanları null. Durağan ekrandan (sunucu kare göndermedi) sonraki aralık sayılmaz.
    stats: () => ({ ...lastStats }),
    // Kalem özelliği, kalem olaylarını kendisi işlediği sürece true dönen bir fonksiyon kaydeder.
    setPenActive(fn) { penActive = typeof fn === 'function' ? fn : () => false; },
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
