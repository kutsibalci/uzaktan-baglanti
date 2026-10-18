// QR kodla telefon eşleştirme (sunucu: features/eslestir.js).
// Telefon: adres "#e=<belirteç>" ile açılınca giriş yerine belirteç gönderilir, bilgisayardaki onayı bekler.
// Bilgisayar (yalnızca localhost'tan açılmış yönetici oturumu): ana menüde "📱 Telefonu bağla (QR)".
// Tepsi menüsü "#qr" ile açar: giriş olunca QR ekranı kendiliğinden açılır.
(() => {
  const RC = window.RC;
  if (!RC) return;

  // ---------- Adres parçası: belirteç ya da tepsiden gelen istek ----------
  // Belirteç adres çubuğunda/geçmişte kalmasın diye hemen silinir (sayfa yenilense de tekrar gönderilmez).
  let belirtec = null;
  let qrIstegi = false;
  const parca = /^#e=([A-Za-z0-9_-]{20,100})$/.exec(location.hash);
  if (parca) belirtec = parca[1];
  if (location.hash === '#qr') qrIstegi = true;
  if (parca || qrIstegi) {
    try { history.replaceState(null, '', location.pathname + location.search); } catch { /* eski tarayıcı */ }
  }

  // "Onay bekleniyor" ekranındaki metin QR eşleştirmede farklı.
  const bekleP = document.querySelector('#vPending p.muted');
  const bekleAsil = bekleP ? bekleP.innerHTML : '';
  const bekleMetni = (qr) => {
    if (bekleP) bekleP.innerHTML = qr ? 'Bilgisayardaki QR ekranında <b>Onayla</b>\'ya basın (60 sn).' : bekleAsil;
  };
  document.addEventListener('submit', () => bekleMetni(false), true);

  RC.setAuthHook(() => {
    if (!belirtec) return false;
    const b = belirtec;
    belirtec = null; // tek kullanımlık
    bekleMetni(true);
    RC.send({ t: 'eslestir', belirtec: b, deviceName: RC.deviceName() });
    return true;
  });

  // ---------- Bilgisayar: QR ekranı ----------

  const style = document.createElement('style');
  style.textContent = `
    .eslestir-panel { background: var(--panel2); border: 1px solid var(--line); border-radius: 12px; padding: 6px 12px 14px; display: grid; gap: 10px; justify-items: center; text-align: center; }
    .eslestir-panel .es-bas { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; }
    .eslestir-panel .es-bas p { flex: 1; }
    .eslestir-panel .es-qr { width: min(260px, 70vw); aspect-ratio: 1; background: #fff; border-radius: 10px; padding: 0; display: grid; place-items: center; }
    .eslestir-panel .es-qr svg { width: 100%; height: 100%; display: block; border-radius: 10px; }
    .eslestir-panel .es-qr.soluk { opacity: .15; }
    .eslestir-panel .es-adres { font-family: ui-monospace, Consolas, monospace; font-size: 13px; word-break: break-all; color: var(--text); margin: 0; }
    .eslestir-panel .es-istek { width: 100%; background: var(--panel); border: 1px solid var(--warn); border-radius: 12px; padding: 12px; display: grid; gap: 10px; }
    .eslestir-panel .es-istek p { margin: 0; }
    .eslestir-panel .es-btns { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .eslestir-panel .es-btns .red { background: #7f1d1d; }
    .eslestir-panel .msg { margin: 0; }
  `;
  document.head.appendChild(style);

  const wrap = document.createElement('div');
  wrap.style.display = 'grid';
  wrap.style.gap = '8px';
  wrap.hidden = true;

  const btn = document.createElement('button');
  btn.className = 'ghost';
  btn.id = 'eslestirBtn';
  btn.textContent = '📱 Telefonu bağla (QR)';

  const panel = document.createElement('div');
  panel.className = 'eslestir-panel';
  panel.id = 'eslestirPanel';
  panel.hidden = true;
  panel.innerHTML = `
    <div class="es-bas"><p class="muted small">Telefonun kamerasıyla okut, açılan adrese gir.</p>
      <button type="button" class="rc-x" data-act="kapat" title="Kapat" aria-label="Kapat">✕</button></div>
    <div class="es-qr" aria-live="polite"></div>
    <p class="es-adres"></p>
    <p class="muted small es-kim"></p>
    <p class="muted small es-sure"></p>
    <div class="es-istek" hidden>
      <p class="es-istek-metin"></p>
      <div class="es-btns"><button type="button" data-act="onayla">Onayla</button><button type="button" class="red" data-act="reddet">Reddet</button></div>
    </div>
    <p class="msg"></p>`;
  const $ = (s) => panel.querySelector(s);
  const qrKutu = $('.es-qr');
  const istekKutu = $('.es-istek');
  const msg = $('.msg');

  let bitis = 0;          // QR'ın geçerlilik sonu (yerel saat)
  let istekBitis = 0;
  let istekCihaz = '';
  let tik = null;
  let izinli = false;

  const sn = (ms) => {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  function guncelle() {
    if (panel.hidden) return;
    const now = Date.now();
    if (!istekKutu.hidden) {
      $('.es-istek-metin').innerHTML = `<b>${RC.esc(istekCihaz)}</b> bağlanmak istiyor — ${sn(istekBitis - now)}`;
      return;
    }
    if (bitis) {
      if (now >= bitis) { yeniKod(); return; }
      $('.es-sure').textContent = `Tek kullanımlık · ${sn(bitis - now)} sonra yenilenir`;
    }
  }

  function yeniKod() {
    bitis = 0;
    qrKutu.hidden = false;
    $('.es-adres').hidden = false;
    qrKutu.classList.add('soluk');
    $('.es-sure').textContent = 'QR kod hazırlanıyor…';
    RC.send({ t: 'eslestir-olustur' });
  }

  function ac() {
    panel.hidden = false;
    msg.textContent = '';
    msg.className = 'msg';
    istekKutu.hidden = true;
    qrKutu.innerHTML = '';
    $('.es-adres').textContent = '';
    $('.es-kim').textContent = '';
    yeniKod();
    clearInterval(tik);
    tik = setInterval(guncelle, 500);
  }

  function kapat() {
    if (panel.hidden) return;
    panel.hidden = true;
    clearInterval(tik);
    tik = null;
    bitis = 0;
    qrKutu.innerHTML = '';
    RC.send({ t: 'eslestir-kapat' });
  }

  btn.addEventListener('click', () => (panel.hidden ? ac() : kapat()));
  RC.ui.closable(panel, kapat); // Esc ile kapanır
  panel.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    if (b.dataset.act === 'kapat') return kapat();
    if (b.dataset.act === 'onayla' || b.dataset.act === 'reddet') {
      RC.send({ t: 'eslestir-cevap', onay: b.dataset.act === 'onayla' });
      istekKutu.hidden = true;
      msg.className = 'msg';
      msg.textContent = 'Bekleniyor…';
    }
  });

  wrap.appendChild(btn);
  wrap.appendChild(panel);
  RC.ui.home(wrap);

  RC.on('auth', () => {
    bekleMetni(false);
    izinli = false;
    wrap.hidden = true;
    // Tepsiden "#qr" ile açıldı ama bu oturum QR oluşturamıyor: nedenini söyle.
    if (qrIstegi) {
      setTimeout(() => {
        if (izinli || !qrIstegi) return;
        qrIstegi = false;
        const e = document.getElementById('homeError');
        if (e) e.textContent = 'QR kod için bu bilgisayarda yönetici hesabıyla giriş yapın.';
      }, 1500);
    }
  });
  RC.on('eslestir-izin', () => {
    izinli = true;
    wrap.hidden = false;
    if (qrIstegi) { qrIstegi = false; ac(); }
  });
  RC.on('disconnect', () => {
    wrap.hidden = true;
    panel.hidden = true;
    clearInterval(tik);
    tik = null;
  });

  RC.on('eslestir-qr', (m) => {
    if (panel.hidden) { RC.send({ t: 'eslestir-kapat' }); return; }
    qrKutu.innerHTML = m.svg; // sunucunun ürettiği SVG (lib/qr.js)
    qrKutu.classList.remove('soluk');
    qrKutu.title = m.url;
    $('.es-adres').textContent = m.adres;
    $('.es-kim').innerHTML = `Telefon <b>${RC.esc(m.kullanici)}</b> (${RC.esc(m.rol)}) hesabıyla girecek ve hatırlanacak. Girişi bu ekranda onaylaman gerekir.`
      + (m.adresTuru === 'tailscale' ? '<br>Telefonda Tailscale açık olmalı.' : '<br>Telefon bu bilgisayarla aynı Wi-Fi ağında olmalı.');
    bitis = Date.now() + m.sureMs;
    guncelle();
  });
  RC.on('eslestir-hata', (m) => {
    qrKutu.innerHTML = '';
    $('.es-sure').textContent = '';
    msg.className = 'msg err';
    msg.textContent = m.hata;
  });
  RC.on('eslestir-istek', (m) => {
    if (panel.hidden) return;
    istekCihaz = `${m.cihaz} (${m.ip}, ${m.via})`;
    istekBitis = Date.now() + m.sureMs;
    bitis = 0;
    // QR kullanıldı: yerine istek gösterilir (Onayla / Reddet ekranın dışında kalmasın).
    qrKutu.hidden = true;
    $('.es-adres').hidden = true;
    $('.es-sure').textContent = '';
    msg.textContent = '';
    istekKutu.hidden = false;
    guncelle();
    istekKutu.scrollIntoView?.({ block: 'nearest' });
  });
  RC.on('eslestir-sonuc', (m) => {
    istekKutu.hidden = true;
    msg.className = `msg ${m.ok ? 'ok' : 'err'}`;
    msg.textContent = m.ok ? `✓ ${m.cihaz} bağlandı ve hatırlandı.` : `${m.cihaz}: ${m.neden || 'bağlanmadı.'}`;
    if (!panel.hidden) yeniKod(); // kod tek kullanımlıktı: yenisi
  });
})();
