// Pano eşitleme (metin ve resim): ⋯ menüsünde (geniş ekranda çubukta da) 📋 Pano ve küçük panel.
// HTTP (güvenli olmayan) sayfalarda navigator.clipboard yoktur; o zaman metin seçili bir kutuda gösterilir
// ve gönderilecek metin kutuya elle yapıştırılır. Resim HTTP'de yalnızca kaydedilir/indirilir, gönderirken dosya seçilir.
// Resim: bildirim WebSocket'ten gelir ({ t:'pano', resim:{ id, w, h, bytes } }), PNG'nin kendisi GET /api/pano/resim'den çekilir.
(() => {
  const RC = window.RC;
  const MAX_BAYT = 1024 * 1024;
  const MAX_RESIM = 20 * 1024 * 1024;
  const WS_SINIRI = 60 * 1024; // sunucunun WebSocket mesaj sınırı 64 KB; üstü HTTP ile gider
  const MAX_TUVAL = 16 * 1024 * 1024; // iOS Safari tuval sınırı ~16,7 milyon piksel
  const DOGRUDAN = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/bmp']); // bilgisayar bunları doğrudan çözer

  const guvenli = window.isSecureContext === true;
  const kopyalanabilir = guvenli && !!navigator.clipboard?.write && typeof window.ClipboardItem === 'function';
  const paylasilabilir = (() => {
    try { return guvenli && !!navigator.canShare && navigator.canShare({ files: [new File([''], 'pano.png', { type: 'image/png' })] }); } catch { return false; }
  })();

  const stil = document.createElement('style');
  stil.textContent = `
    #panoPanel textarea { width: 100%; min-height: 90px; max-height: 40vh; resize: vertical; background: var(--bg); color: var(--text);
      border: 1px solid var(--line); border-radius: 8px; padding: 8px; font: 13px/1.4 ui-monospace, Consolas, monospace; }
    #panoPanel .rc-panel-ic h3 { margin: 0; font-size: 14px; }
    #panoPanel .rc-panel-ic button.small { min-height: 40px; } /* parmakla rahat dokunulsun */
    #panoPanel .pano-resim { display: grid; gap: 6px; }
    #panoPanel .pano-resim[hidden] { display: none; }
    #panoPanel .pano-resim img { display: block; max-width: 100%; max-height: 32vh; min-height: 40px; margin: 0 auto; border-radius: 8px;
      border: 1px solid var(--line); object-fit: contain;
      background: repeating-conic-gradient(rgba(128,128,128,.25) 0 25%, transparent 0 50%) 0 0 / 16px 16px; }
    #panoPanel .pano-resim img:not([src]) { visibility: hidden; }
  `;
  document.head.appendChild(stil);

  // ---------- Menü satırı (salt izleme rolünde çekirdek gizler: ctl) ----------
  const item = RC.ui.menuItem({
    id: 'panoBtn', icon: '📋', label: 'Pano (kopyala-yapıştır)', order: 10, pin: true, alt: 'Pano', ctl: true,
    onClick: () => (panel.hidden ? ac() : kapat()),
  });
  // Yeni metin/resim geldi işareti (menü satırında ve ⋯ düğmesinde nokta)
  const isaret = (yeni) => item.set({ badge: yeni });

  // ---------- Panel ----------
  const kabuk = RC.ui.panel('Pano', { id: 'panoPanel', anchor: item.pinEl });
  const panel = kabuk.el;
  kabuk.body.innerHTML = `
    <h3>Bilgisayarın panosu</h3>
    <div class="pano-resim" data-k="resimKutu" hidden>
      <img data-k="resim" alt="Bilgisayarın panosundaki resim">
      <p class="muted small" data-k="resimBilgi"></p>
      <div class="row gap wrap" data-k="resimDugmeler">
        <button class="small" data-k="resimKopyala"${kopyalanabilir ? '' : ' hidden'}>Telefona kopyala</button>
        <button class="small${kopyalanabilir ? ' ghost' : ''}" data-k="resimKaydet">${paylasilabilir ? 'Kaydet / Paylaş' : 'Kaydet (indir)'}</button>
      </div>
    </div>
    <textarea data-k="pc" readonly placeholder="Henüz metin yok. Bilgisayarda bir şey kopyalayın ya da Yenile'ye basın."></textarea>
    <div class="row gap wrap">
      <button class="small" data-k="kopyala">Kopyala</button>
      <button class="small ghost" data-k="yenile">Yenile</button>
    </div>
    <h3>Bu cihazdan gönder</h3>
    <div class="row gap wrap">
      <button class="small" data-k="oku">Bu cihazın panosunu gönder</button>
      <button class="small" data-k="resimGonder">Telefondan resim gönder</button>
      <button class="small ghost" data-k="resimSec" hidden>Resim seç…</button>
    </div>
    <input type="file" accept="image/*" data-k="dosya" hidden>
    <textarea data-k="giden" placeholder="Göndermek istediğiniz metni buraya yapıştırın" hidden></textarea>
    <div class="row gap wrap" data-k="gonderSatir" hidden><button class="small" data-k="gonder">Gönder</button></div>
    <p class="msg small" data-k="durum"></p>
  `;
  const el = (k) => panel.querySelector(`[data-k="${k}"]`);
  const pcKutu = el('pc');
  const gidenKutu = el('giden');
  const resimEl = el('resim');

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
    onizle();
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

  // ---------- Bilgisayar -> cihaz: resim ----------
  let resimBilgi = null;   // { id, w, h, bytes } | { tooBig, w, h } | null
  let resimSozu = null;    // Promise<Blob> (şu anki resim)
  let resimBlob = null;    // çözülmüş Blob (paylaşım kullanıcı hareketi içinde bekleme yapmadan çağrılabilsin)
  let resimAdres = null;   // önizleme için nesne adresi

  const boyutYaz = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  const dosyaAdi = () => {
    const d = new Date();
    const p = (x) => String(x).padStart(2, '0');
    return `pano-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.png`;
  };

  function resimAyarla(r) {
    if (r && resimBilgi && !r.tooBig && r.id === resimBilgi.id) return; // aynı resim (pano-al cevabı): yeniden indirme
    resimBilgi = r || null;
    resimSozu = null;
    resimBlob = null;
    if (resimAdres) { URL.revokeObjectURL(resimAdres); resimAdres = null; }
    resimEl.removeAttribute('src');
    el('resimKutu').hidden = !r;
    pcKutu.hidden = !!r;
    el('kopyala').hidden = !!r;
    if (!r) return;
    el('resimDugmeler').hidden = !!r.tooBig;
    resimEl.hidden = !!r.tooBig;
    el('resimBilgi').textContent = r.tooBig
      ? `Bilgisayardaki resim çok büyük (${r.w}×${r.h}, 20 MB üstü) — aktarılamıyor.`
      : `${r.w}×${r.h} · ${boyutYaz(r.bytes)}`;
    if (!panel.hidden) onizle();
  }

  // Resmi (bir kez) indirir; önizlemeyi doldurur. Promise<Blob> döner.
  function onizle() {
    const r = resimBilgi;
    if (!r || r.tooBig) return null;
    if (resimSozu) return resimSozu;
    resimSozu = RC.fetch(`/api/pano/resim?id=${r.id}`)
      .then((c) => { if (!c.ok) throw new Error(String(c.status)); return c.blob(); })
      .then((b) => (b.type === 'image/png' ? b : new Blob([b], { type: 'image/png' })));
    const soz = resimSozu;
    soz.then((b) => {
      if (resimSozu !== soz) return; // bu arada pano değişti
      resimBlob = b;
      resimAdres = URL.createObjectURL(b);
      resimEl.src = resimAdres;
    }, () => {
      if (resimSozu !== soz) return;
      resimSozu = null;
      durum('Resim alınamadı; Yenile\'ye basın.', true);
    });
    return soz;
  }

  // iOS Safari: navigator.clipboard.write kullanıcı hareketinin içinde, beklemeden çağrılmalı ve
  // ClipboardItem değeri olarak Blob'un kendisi değil Promise<Blob> verilmeli (Chrome da bunu kabul eder).
  el('resimKopyala').addEventListener('click', () => {
    const soz = onizle();
    if (!soz) return;
    durum('Kopyalanıyor…');
    try {
      navigator.clipboard.write([new ClipboardItem({ 'image/png': soz })])
        .then(() => durum('Resim bu cihazın panosuna kopyalandı.'),
          () => durum('Resim panoya kopyalanamadı (izin verilmedi); "Kaydet / Paylaş"ı deneyin.', true));
    } catch {
      durum('Bu tarayıcı panoya resim kopyalamayı desteklemiyor; "Kaydet"i kullanın.', true);
    }
  });

  function indir(blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = dosyaAdi();
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    durum('Resim indirildi.');
  }

  // Paylaşım menüsü (iOS'ta "Görüntüyü Kaydet" ile Fotoğraflar'a) kullanıcı hareketi içinde açılmalı:
  // resim önceden indirildiyse beklemeden çağrılır; değilse indirildikten sonra dosya olarak kaydedilir.
  el('resimKaydet').addEventListener('click', async () => {
    const soz = onizle();
    if (!soz) return;
    if (resimBlob && paylasilabilir) {
      const dosya = new File([resimBlob], dosyaAdi(), { type: 'image/png' });
      try {
        await navigator.share({ files: [dosya] });
        durum('');
      } catch (e) {
        if (e?.name !== 'AbortError') indir(resimBlob);
      }
      return;
    }
    try { indir(await soz); } catch { durum('Resim alınamadı.', true); }
  });

  // ---------- Cihaz -> bilgisayar: resim ----------
  // Güvenli bağlamda önce bu cihazın panosu okunur (izin isteyebilir); olmazsa dosya/fotoğraf seçici.
  el('resimGonder').addEventListener('click', async () => {
    if (!guvenli || !navigator.clipboard?.read) { el('dosya').click(); return; }
    try {
      const ogeler = await navigator.clipboard.read();
      for (const o of ogeler) {
        const tur = o.types.find((x) => x.startsWith('image/'));
        if (tur) return resimYolla(await o.getType(tur));
      }
      durum('Bu cihazın panosunda resim yok; "Resim seç…" ile bir fotoğraf seçin.');
    } catch {
      durum('Panodaki resim okunamadı (izin verilmedi); "Resim seç…" ile bir fotoğraf seçin.');
    }
    el('resimSec').hidden = false;
  });
  el('resimSec').addEventListener('click', () => el('dosya').click());
  el('dosya').addEventListener('change', () => {
    const f = el('dosya').files[0];
    el('dosya').value = '';
    if (f) resimYolla(f);
  });

  // HEIC, WebP gibi biçimleri tarayıcıda çözüp PNG'ye çevirir (çok büyükse tuval sınırına küçültür).
  async function pngYap(blob) {
    let kaynak = null;
    if (window.createImageBitmap) { try { kaynak = await createImageBitmap(blob); } catch { /* <img> ile dene */ } }
    if (!kaynak) {
      kaynak = await new Promise((ok, hata) => {
        const i = new Image();
        const u = URL.createObjectURL(blob);
        i.onload = () => { URL.revokeObjectURL(u); ok(i); };
        i.onerror = () => { URL.revokeObjectURL(u); hata(new Error('çözülemedi')); };
        i.src = u;
      });
    }
    const w0 = kaynak.naturalWidth || kaynak.width, h0 = kaynak.naturalHeight || kaynak.height;
    if (!w0 || !h0) throw new Error('boş resim');
    const olcek = Math.min(1, Math.sqrt(MAX_TUVAL / (w0 * h0)));
    const tuval = document.createElement('canvas');
    tuval.width = Math.max(1, Math.floor(w0 * olcek));
    tuval.height = Math.max(1, Math.floor(h0 * olcek));
    tuval.getContext('2d').drawImage(kaynak, 0, 0, tuval.width, tuval.height);
    kaynak.close?.();
    const png = await new Promise((ok) => tuval.toBlob(ok, 'image/png'));
    if (!png) throw new Error('çevrilemedi');
    return png;
  }

  async function resimYolla(blob) {
    let veri = blob;
    if (!DOGRUDAN.has(blob.type)) {
      durum('Resim hazırlanıyor…');
      try { veri = await pngYap(blob); } catch { return durum('Bu resim biçimi okunamadı.', true); }
    }
    if (veri.size > MAX_RESIM) return durum('Resim çok büyük (en fazla 20 MB).', true);
    durum('Resim gönderiliyor…');
    try {
      const r = await RC.fetch('/api/pano/resim', { method: 'POST', headers: { 'Content-Type': veri.type || 'application/octet-stream' }, body: veri });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ok) durum(`Resim bilgisayarın panosuna kondu (${j.w}×${j.h}).`);
      else durum(j.msg || (r.status === 413 ? 'Resim çok büyük (en fazla 20 MB).' : 'Resim gönderilemedi.'), true);
    } catch {
      durum('Gönderilemedi (bağlantı hatası).', true);
    }
  }

  // ---------- Sunucu mesajları ----------
  RC.on('pano', (m) => {
    if (m.resim) {
      resimAyarla(m.resim);
    } else {
      resimAyarla(null);
      pcKutu.value = m.tooBig ? '' : (m.text || '');
      pcKutu.placeholder = m.tooBig ? 'Bilgisayarın panosundaki metin çok büyük (1 MB üstü).' : 'Bilgisayarın panosu boş.';
    }
    if (panel.hidden && !m.istek) isaret(true); // yeni metin/resim geldi
  });
  RC.on('pano-yazildi', yazildi);
  RC.on('viewer:stop', kapat);
  RC.on('disconnect', kapat);
  RC.on('auth', (me) => { if (me.role === 'view') { kapat(); isaret(false); resimAyarla(null); } });

  // ---------- Yönetim paneli ----------
  const ayar = document.createElement('div');
  ayar.innerHTML = `
    <label class="check"><input type="checkbox" data-k="otomatik"> Bilgisayarda kopyalanan metni ve resmi bağlı cihazlara otomatik gönder</label>
    <p class="muted small">Kapalıyken pano yalnızca cihazda 📋 panelinden "Yenile" ile alınır. Cihazdan bilgisayara gönderme her durumda elle yapılır. Metin (en fazla 1 MB) ve resim (en fazla 20 MB) eşitlenir.</p>`;
  RC.ui.adminSection('Pano eşitleme', ayar);
  const otomatik = ayar.querySelector('[data-k="otomatik"]');
  otomatik.addEventListener('change', () => RC.send({ t: 'pano-ayar', otomatik: otomatik.checked }));
  RC.on('admin', (m) => { if (m.features?.pano) otomatik.checked = m.features.pano.otomatik; });
  RC.on('pano-ayar', (m) => { otomatik.checked = m.otomatik; });
})();
