// Bilgisayar sesini dinleme: ⋯ menüsünde "Ses: kapalı/açık" satırı (geniş ekranda çubukta 🔇/🔊).
// Sunucu Opus paketlerini [3][paket] ikili mesajlarıyla yollar; WebCodecs AudioDecoder ile çözülüp
// Web Audio ile ardışık zamanlanarak çalınır (hedef tampon ~80 ms, 300 ms'yi aşarsa yeniden hizalanır).
(() => {
  const HEDEF = 0.08;   // hedef tampon (sn)
  const AZAMI = 0.3;    // bundan fazla gecikme birikirse paketler atılıp hedefe dönülür
  const PAKET_US = 20000;
  const DESTEK_YOK = 'Ses için HTTPS (Tailscale adresi) ve güncel tarayıcı gerekli';

  // Menü satırı; aç/kapa olduğu için tıklayınca menü açık kalır (durum görünsün).
  const item = RC.ui.menuItem({
    id: 'sesBtn', icon: '🔇', label: 'Ses', state: 'kapalı', order: 30, pin: true, keepOpen: true, disabled: true,
    title: 'Bilgisayar sesi kapalı — açmak için dokunun',
    onClick: () => (istek ? kapat() : ac()),
  });

  let destek = false;
  let istek = false;     // kullanıcı sesi açtı mı (bağlantı kopsa da hatırlanır)
  let ctx = null;        // AudioContext — yalnızca kullanıcı hareketiyle oluşturulur
  let decoder = null;
  let config = null;
  let ts = 0;            // çözücüye verilen zaman damgası (µs)
  let playhead = 0;      // sıradaki parçanın çalınacağı zaman (ctx saatinde)
  let atla = false;      // gecikme birikti: hedefe inene kadar paketleri at
  let yumusak = true;    // sıradaki parçanın başına kısa giriş (tıklama olmasın)
  const kaynaklar = new Set();

  (async () => {
    if (!window.isSecureContext || !('AudioDecoder' in window) || !('AudioContext' in window)) { item.set({ title: DESTEK_YOK, state: 'HTTPS gerekli' }); return; }
    try {
      const r = await AudioDecoder.isConfigSupported({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2 });
      destek = !!r.supported;
    } catch { /* desteklenmiyor */ }
    item.set(destek ? { disabled: false } : { disabled: true, title: DESTEK_YOK, state: 'desteklenmiyor' });
  })();

  function arayuz(durum) {
    item.set({
      icon: istek ? '🔊' : '🔇',
      active: istek,
      state: durum || (istek ? 'açık' : 'kapalı'),
      title: durum || (istek ? 'Bilgisayar sesi açık — kapatmak için dokunun' : 'Bilgisayar sesi kapalı — açmak için dokunun'),
    });
  }

  function baglamOlustur() {
    if (ctx) return;
    try { ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' }); }
    catch { ctx = new AudioContext({ latencyHint: 'interactive' }); } // tarayıcı farklı hızda çalışabilir; parçalar otomatik dönüştürülür
  }

  function cozucuKur() {
    cozucuKapat();
    if (!config) return;
    decoder = new AudioDecoder({
      output: cal,
      error: (e) => {
        console.warn('Ses çözücü hatası:', e);
        decoder = null;
        if (istek && config) setTimeout(() => { if (istek && !decoder) cozucuKur(); }, 500);
      },
    });
    decoder.configure({ codec: 'opus', sampleRate: config.sampleRate, numberOfChannels: config.channels });
    ts = 0;
    yumusak = true;
  }

  function cozucuKapat() {
    if (decoder && decoder.state !== 'closed') { try { decoder.close(); } catch { /* zaten kapalı */ } }
    decoder = null;
    for (const s of kaynaklar) { try { s.stop(); } catch { /* başlamamış */ } }
    kaynaklar.clear();
    playhead = 0;
    atla = false;
  }

  function cal(ad) {
    try {
      if (!ctx || !istek) return;
      const n = ad.numberOfFrames;
      const now = ctx.currentTime;
      let lead = playhead - now;
      if (atla) {
        if (lead > HEDEF) return;
        atla = false;
      }
      if (lead > AZAMI) { atla = true; yumusak = true; return; } // gecikme birikti: kuyruğu atla
      if (lead < 0.01) { playhead = now + HEDEF; yumusak = true; } // boşaldı: hedef tamponla yeniden başla

      const buf = ctx.createBuffer(2, n, ad.sampleRate);
      const tmp = new Float32Array(n);
      for (let ch = 0; ch < 2; ch++) {
        ad.copyTo(tmp, { planeIndex: Math.min(ch, ad.numberOfChannels - 1), format: 'f32-planar' });
        if (yumusak) { const k = Math.min(n, 120); for (let i = 0; i < k; i++) tmp[i] *= i / k; }
        buf.copyToChannel(tmp, ch);
      }
      yumusak = false;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.onended = () => kaynaklar.delete(src);
      src.start(playhead);
      kaynaklar.add(src);
      playhead += buf.duration; // ardışık zamanlama: parçalar arasında boşluk/çakışma olmaz
    } finally {
      ad.close();
    }
  }

  function ac() {
    if (!destek) return;
    baglamOlustur();
    ctx.resume().catch(() => {});
    istek = true;
    arayuz('Bağlanıyor…');
    RC.send({ t: 'ses', acik: true });
  }

  function kapat() {
    if (istek) RC.send({ t: 'ses', acik: false });
    istek = false;
    config = null;
    cozucuKapat();
    if (ctx && ctx.state === 'running') ctx.suspend().catch(() => {});
    arayuz();
  }

  RC.on('ses-config', (m) => {
    if (!istek) return;
    config = { sampleRate: Number(m.sampleRate) || 48000, channels: Number(m.channels) || 2 };
    cozucuKur();
    arayuz();
  });

  RC.on('ses-durum', (m) => {
    if (m.acik === false) {
      istek = false;
      config = null;
      cozucuKapat();
      arayuz(m.msg || '');
      if (m.msg) { RC.overlay(m.msg); setTimeout(() => RC.overlay(''), 4000); }
    }
  });

  RC.on('binary:3', (u8) => {
    if (!decoder || decoder.state !== 'configured') return;
    if (decoder.decodeQueueSize > 10) return; // çözücü yetişemiyor: biriktirme
    decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: ts, data: u8.subarray(1) }));
    ts += PAKET_US;
  });

  // Görüntüleyiciden çıkınca ses tamamen kapanır.
  RC.on('viewer:stop', kapat);

  // Bağlantı koptu: çalmayı durdur ama isteği hatırla; oturum devam ederse yeniden abone ol.
  RC.on('disconnect', () => {
    config = null;
    cozucuKapat();
    if (istek) arayuz('Bağlantı bekleniyor…');
  });
  RC.on('auth', (a) => {
    if (!istek) return;
    if (a.resumed) RC.send({ t: 'ses', acik: true });
    else { istek = false; arayuz(); } // yeni oturum: ana menüye dönülür, ses kapalı başlar
  });
})();
