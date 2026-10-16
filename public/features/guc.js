// Güç menüsü (yalnızca yönetici): kilitle, uyku, yeniden başlat, kapat + 30 sn içinde iptal.
(() => {
  const RC = window.RC;
  if (!RC) return;

  const style = document.createElement('style');
  style.textContent = `
    .guc-panel { background: var(--panel2); border: 1px solid var(--line); border-radius: 12px; padding: 12px; display: grid; gap: 10px; }
    .guc-panel .guc-btns { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .guc-panel .guc-btns button { background: var(--panel); border: 1px solid var(--line); }
    .guc-panel .guc-btns button.danger { background: #7f1d1d; border-color: #7f1d1d; }
    .guc-panel .msg { margin: 0; }
    #gucBanner { position: fixed; left: 8px; right: 8px; top: 8px; z-index: 50; margin: 0 auto; max-width: 520px;
      background: var(--panel); border: 1px solid var(--warn); border-radius: 12px; padding: 10px 12px;
      box-shadow: 0 6px 24px rgba(0,0,0,.5); }
    #gucBanner span { flex: 1; min-width: 160px; }
  `;
  document.head.appendChild(style);

  const SECENEKLER = [
    { islem: 'kilitle', ad: '🔒 Kilitle', onay: 'Bilgisayar kilitlensin mi?\n\nKilitlenince ekran uzaktan görünmez (kilit ekranı desteği henüz yok).' },
    { islem: 'uyku', ad: '🌙 Uyku', onay: 'Bilgisayar uyku moduna alınsın mı?\n\nUyuyan bilgisayara uzaktan tekrar bağlanılamaz; birinin uyandırması gerekir.' },
    { islem: 'yeniden', ad: '🔄 Yeniden başlat', onay: 'Bilgisayar 30 saniye sonra yeniden başlatılsın mı?\n\nKaydedilmemiş işler kaybolabilir. 30 saniye içinde iptal edebilirsiniz.', tehlikeli: true },
    { islem: 'kapat', ad: '⏻ Kapat', onay: 'Bilgisayar 30 saniye sonra kapatılsın mı?\n\nKapandıktan sonra uzaktan açılamaz. 30 saniye içinde iptal edebilirsiniz.', tehlikeli: true },
  ];

  // ---------- Ana menüdeki düğme ve panel ----------

  const wrap = document.createElement('div');
  wrap.style.display = 'grid';
  wrap.style.gap = '8px';
  wrap.hidden = true;

  const btn = document.createElement('button');
  btn.className = 'ghost';
  btn.textContent = '⏻ Güç';

  const panel = document.createElement('div');
  panel.className = 'guc-panel';
  panel.hidden = true;
  panel.innerHTML = `
    <p class="muted small">Kilitlenince ekran uzaktan görünmez (kilit ekranı desteği henüz yok).</p>
    <div class="guc-btns">${SECENEKLER.map((s) => `<button class="small${s.tehlikeli ? ' danger' : ''}" data-islem="${s.islem}">${s.ad}</button>`).join('')}</div>
    <p class="msg"></p>`;
  const msg = panel.querySelector('.msg');

  btn.addEventListener('click', () => { panel.hidden = !panel.hidden; msg.textContent = ''; });
  panel.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-islem]');
    if (!b) return;
    const s = SECENEKLER.find((x) => x.islem === b.dataset.islem);
    if (!s || !confirm(s.onay)) return;
    msg.className = 'msg';
    msg.textContent = 'Gönderiliyor...';
    RC.send({ t: 'guc', islem: s.islem });
  });

  wrap.appendChild(btn);
  wrap.appendChild(panel);
  RC.ui.home(wrap);

  const isAdmin = () => RC.state().me?.role === 'admin';
  const refresh = () => {
    wrap.hidden = !isAdmin();
    if (wrap.hidden) panel.hidden = true;
  };
  RC.on('auth', refresh);
  // Yetki sonradan değişirse çekirdek "Yönetim" düğmesini gizler/gösterir; aynısını yap.
  const adminBtn = document.getElementById('adminBtn');
  if (adminBtn) new MutationObserver(refresh).observe(adminBtn, { attributes: true, attributeFilter: ['hidden'] });
  RC.on('disconnect', () => { wrap.hidden = true; });

  RC.on('guc-sonuc', (m) => {
    msg.className = `msg ${m.ok ? 'ok' : 'err'}`;
    if (!m.ok) msg.textContent = m.hata || 'İşlem başarısız.';
    else if (m.kuru) msg.textContent = `Deneme modu — çalıştırılacaktı: ${m.komut}`;
    else msg.textContent = 'Komut gönderildi.';
    // Şeritteki "İptal" başarısız olduysa düğmeyi geri aç ve nedenini göster.
    const b = banner && banner.querySelector('button[data-act="iptal"]');
    if (b && m.islem === 'iptal' && !m.ok) {
      b.disabled = false;
      b.textContent = 'İptal';
      alert(m.hata || 'İptal edilemedi.');
    }
  });

  // ---------- Duyuru şeridi (herkese; yeniden başlat/kapat için geri sayım + İptal) ----------

  let banner = null;
  let tick = null;
  function hideBanner() {
    clearInterval(tick);
    tick = null;
    if (banner) banner.remove();
    banner = null;
  }

  function showBanner(text, { iptalSonu, sure } = {}) {
    hideBanner();
    banner = document.createElement('div');
    banner.id = 'gucBanner';
    banner.className = 'row gap wrap';
    banner.innerHTML = `<span></span>
      ${iptalSonu && isAdmin() ? '<button class="small danger" data-act="iptal">İptal</button>' : ''}
      <button class="small ghost" data-act="kapat" aria-label="Kapat">✕</button>`;
    const label = banner.querySelector('span');
    banner.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      if (b.dataset.act === 'iptal') { RC.send({ t: 'guc', islem: 'iptal' }); b.disabled = true; b.textContent = 'İptal ediliyor...'; }
      else hideBanner();
    });
    document.body.appendChild(banner);
    const update = () => {
      if (!iptalSonu) { label.textContent = text; return; }
      const kalan = Math.max(0, Math.ceil((iptalSonu - Date.now()) / 1000));
      label.textContent = `${text} — ${kalan} sn`;
      if (kalan <= 0) hideBanner();
    };
    update();
    if (iptalSonu) tick = setInterval(update, 500);
    else {
      const bu = banner;
      setTimeout(() => { if (banner === bu) hideBanner(); }, sure || 6000);
    }
  }

  RC.on('guc-duyuru', (m) => {
    const metin = `${m.metin || 'Güç işlemi'}${m.kuru ? ' (deneme modu)' : ''}`;
    if (m.iptalSn) showBanner(metin, { iptalSonu: Date.now() + m.iptalSn * 1000 });
    else showBanner(metin);
  });
})();
