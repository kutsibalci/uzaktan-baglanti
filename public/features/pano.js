// Pano eşitleme (yalnızca metin): ⋯ menüsünde (geniş ekranda çubukta da) 📋 Pano ve küçük panel.
// HTTP (güvenli olmayan) sayfalarda navigator.clipboard yoktur; o zaman metin seçili bir kutuda gösterilir
// ve gönderilecek metin kutuya elle yapıştırılır.
(() => {
  const RC = window.RC;
  const MAX_BAYT = 1024 * 1024;
  const WS_SINIRI = 60 * 1024; // sunucunun WebSocket mesaj sınırı 64 KB; üstü HTTP ile gider

  const stil = document.createElement('style');
  stil.textContent = `
    #panoPanel textarea { width: 100%; min-height: 90px; max-height: 40vh; resize: vertical; background: var(--bg); color: var(--text);
      border: 1px solid var(--line); border-radius: 8px; padding: 8px; font: 13px/1.4 ui-monospace, Consolas, monospace; }
    #panoPanel .rc-panel-ic h3 { margin: 0; font-size: 14px; }
  `;
  document.head.appendChild(stil);

  // ---------- Menü satırı (salt izleme rolünde çekirdek gizler: ctl) ----------
  const item = RC.ui.menuItem({
    id: 'panoBtn', icon: '📋', label: 'Pano (kopyala-yapıştır)', order: 10, pin: true, ctl: true,
    onClick: () => (panel.hidden ? ac() : kapat()),
  });
  // Yeni metin geldi işareti (menü satırında ve ⋯ düğmesinde nokta)
  const isaret = (yeni) => item.set({ badge: yeni });

  // ---------- Panel ----------
  const kabuk = RC.ui.panel('Pano', { id: 'panoPanel', anchor: item.pinEl });
  const panel = kabuk.el;
  kabuk.body.innerHTML = `
    <h3>Bilgisayarın panosu</h3>
    <textarea data-k="pc" readonly placeholder="Henüz metin yok. Bilgisayarda bir şey kopyalayın ya da Yenile'ye basın."></textarea>
    <div class="row gap wrap">
      <button class="small" data-k="kopyala">Kopyala</button>
      <button class="small ghost" data-k="yenile">Yenile</button>
    </div>
    <h3>Bu cihazdan gönder</h3>
    <div class="row gap wrap"><button class="small" data-k="oku">Bu cihazın panosunu gönder</button></div>
    <textarea data-k="giden" placeholder="Göndermek istediğiniz metni buraya yapıştırın" hidden></textarea>
    <div class="row gap wrap" data-k="gonderSatir" hidden><button class="small" data-k="gonder">Gönder</button></div>
    <p class="msg small" data-k="durum"></p>
  `;
  const el = (k) => panel.querySelector(`[data-k="${k}"]`);
  const pcKutu = el('pc');
  const gidenKutu = el('giden');

  function durum(metin, hata = false) {
    el('durum').textContent = metin || '';
    el('durum').className = `msg small ${hata ? 'err' : 'ok'}`;
  }

  const izinVar = () => RC.state().me?.role && RC.state().me.role !== 'view';

  function ac() {
    if (!izinVar()) return;
    kabuk.open(); // ortak panel: çubuğun altında açılır, ✕ / Esc / dışarı dokununca kapanır
    isaret(false);
    durum('');
    RC.send({ t: 'pano-al' });
  }
  function kapat() { kabuk.close(); }

  el('yenile').addEventListener('click', () => RC.send({ t: 'pano-al' }));

  el('kopyala').addEventListener('click', async () => {
    const metin = pcKutu.value;
    if (!metin) return durum('Kopyalanacak metin yok.', true);
    try {
      await navigator.clipboard.writeText(metin);
      durum('Bu cihazın panosuna kopyalandı.');
    } catch {
      // Clipboard API yok (HTTP) ya da izin verilmedi: metni seç, kullanıcı kendisi kopyalasın.
      pcKutu.focus();
      pcKutu.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { /* desteklenmiyor */ }
      durum(ok ? 'Bu cihazın panosuna kopyalandı.' : 'Metin seçildi — kopyalamak için basılı tutup "Kopyala"yı seçin.', !ok);
    }
  });

  function elleGonderGoster(mesaj) {
    gidenKutu.hidden = false;
    el('gonderSatir').hidden = false;
    gidenKutu.focus();
    durum(mesaj);
  }

  el('oku').addEventListener('click', async () => {
    if (!navigator.clipboard?.readText) return elleGonderGoster('Bu bağlantıda panoya doğrudan erişilemiyor; metni kutuya yapıştırıp Gönder\'e basın.');
    try {
      const metin = await navigator.clipboard.readText();
      if (!metin) return elleGonderGoster('Bu cihazın panosunda metin yok; kutuya yazıp Gönder\'e basın.');
      gonder(metin);
    } catch {
      elleGonderGoster('Panoyu okuma izni verilmedi; metni kutuya yapıştırıp Gönder\'e basın.');
    }
  });

  el('gonder').addEventListener('click', () => {
    if (!gidenKutu.value) return durum('Gönderilecek metin yok.', true);
    gonder(gidenKutu.value);
  });

  async function gonder(metin) {
    const bayt = new TextEncoder().encode(metin).length;
    if (bayt > MAX_BAYT) return durum('Metin çok büyük (en fazla 1 MB).', true);
    durum('Gönderiliyor…');
    if (JSON.stringify(metin).length * 3 < WS_SINIRI) {
      RC.send({ t: 'pano-yaz', text: metin });
      return; // sonuç 'pano-yazildi' mesajıyla gelir
    }
    try {
      const r = await RC.fetch('/api/pano/yaz', { method: 'POST', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: metin });
      const j = await r.json().catch(() => ({}));
      yazildi({ ok: r.ok && j.ok, msg: j.msg });
    } catch {
      durum('Gönderilemedi (bağlantı hatası).', true);
    }
  }

  function yazildi(m) {
    if (m.ok) {
      durum('Bilgisayarın panosuna yazıldı.');
      gidenKutu.value = '';
      RC.send({ t: 'pano-al' });
    } else {
      durum(m.msg || 'Panoya yazılamadı.', true);
    }
  }

  // ---------- Sunucu mesajları ----------
  RC.on('pano', (m) => {
    pcKutu.value = m.tooBig ? '' : (m.text || '');
    pcKutu.placeholder = m.tooBig ? 'Bilgisayarın panosundaki metin çok büyük (1 MB üstü).' : 'Bilgisayarın panosu boş.';
    if (panel.hidden && !m.istek) isaret(true); // yeni metin geldi
  });
  RC.on('pano-yazildi', yazildi);
  RC.on('viewer:stop', kapat);
  RC.on('disconnect', kapat);
  RC.on('auth', (me) => { if (me.role === 'view') { kapat(); isaret(false); } });

  // ---------- Yönetim paneli ----------
  const ayar = document.createElement('div');
  ayar.innerHTML = `
    <label class="check"><input type="checkbox" data-k="otomatik"> Bilgisayarda kopyalanan metni bağlı cihazlara otomatik gönder</label>
    <p class="muted small">Kapalıyken metin yalnızca cihazda 📋 panelinden "Yenile" ile alınır. Cihazdan bilgisayara gönderme her durumda elle yapılır. Yalnızca metin eşitlenir (en fazla 1 MB).</p>`;
  RC.ui.adminSection('Pano eşitleme', ayar);
  const otomatik = ayar.querySelector('[data-k="otomatik"]');
  otomatik.addEventListener('change', () => RC.send({ t: 'pano-ayar', otomatik: otomatik.checked }));
  RC.on('admin', (m) => { if (m.features?.pano) otomatik.checked = m.features.pano.otomatik; });
  RC.on('pano-ayar', (m) => { otomatik.checked = m.otomatik; });
})();
