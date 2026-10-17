// Dosya aktarımı: ana menüde ve araç çubuğunda 📁 düğmesi → tam ekran panel.
// (1) Bilgisayara gönder: çoklu seçim, dosya başına ilerleme çubuğu ve iptal (XMLHttpRequest; oturum ?oturum= ile).
// (2) Bilgisayardaki dosyalar: klasör gezinme ve indirme. Görüntüleyiciye dosya sürükleyip bırakmak da gönderir.
// Salt izleme rolünde gizlidir (sunucu da kontrol yetkisi ister).
(() => {
  const RC = window.RC;

  const stil = document.createElement('style');
  stil.textContent = `
    #dosyaPanel { position: fixed; inset: 0; z-index: 30; background: var(--bg); overflow: auto; }
    #dosyaPanel .dosya-ic { max-width: 860px; margin: 0 auto; padding: 16px; display: grid; gap: 12px;
      padding-bottom: calc(16px + env(safe-area-inset-bottom)); }
    #dosyaPanel .yukleme { display: grid; grid-template-columns: 1fr auto; gap: 4px 10px; align-items: center;
      padding: 8px 0; border-bottom: 1px solid var(--line); }
    #dosyaPanel .yukleme:last-child { border-bottom: 0; }
    #dosyaPanel .yukleme .ad, #dosyaPanel .girdi .ad { overflow-wrap: anywhere; }
    #dosyaPanel progress { width: 100%; height: 8px; grid-column: 1 / -1; accent-color: var(--accent); }
    #dosyaPanel .yol { display: flex; flex-wrap: wrap; gap: 2px; align-items: center; font-size: 14px; }
    #dosyaPanel .yol button { background: transparent; padding: 4px 6px; color: var(--accent); border-radius: 6px; }
    #dosyaPanel .yol span { color: var(--muted); }
    #dosyaPanel .girdi { display: grid; grid-template-columns: 28px 1fr auto; gap: 8px; align-items: center; width: 100%;
      background: transparent; border: 0; border-bottom: 1px solid var(--line); border-radius: 0; padding: 10px 4px; text-align: left; }
    #dosyaPanel .girdi:hover { background: var(--panel2); }
    #dosyaPanel .girdi .bilgi { color: var(--muted); font-size: 12px; text-align: right; white-space: nowrap; }
    #dosyaPanel .birak { border: 2px dashed var(--line); border-radius: 12px; padding: 18px; text-align: center; color: var(--muted); }
    #dosyaPanel .birak.uzerinde, #stage.dosya-uzerinde { outline: 3px dashed var(--accent); outline-offset: -6px; }
    #dosyaPanel .liste { display: grid; }
  `;
  document.head.appendChild(stil);

  // ---------- Düğmeler ----------
  const evBtn = document.createElement('button');
  evBtn.className = 'ghost';
  evBtn.textContent = '📁 Dosya aktarımı';
  RC.ui.home(evBtn);

  // Görüntüleyicide ⋯ menüsünde (geniş ekranda çubukta da); salt izleme rolünde çekirdek gizler (ctl).
  RC.ui.menuItem({ id: 'dosyaBtn', icon: '📁', label: 'Dosya aktarımı', order: 20, pin: true, ctl: true, onClick: () => ac() });

  const izinVar = () => !!RC.state().me && RC.state().me.role !== 'view';
  const guncelle = () => { evBtn.hidden = !izinVar(); if (!izinVar()) kapat(); };

  // ---------- Panel ----------
  const panel = document.createElement('section');
  panel.id = 'dosyaPanel';
  panel.hidden = true;
  panel.innerHTML = `
    <div class="dosya-ic">
      <div class="row between"><h1>Dosyalar</h1><button class="ghost" data-k="kapat">Kapat ✕</button></div>
      <div class="tabs">
        <button class="tab active" data-sekme="gonder">Bilgisayara gönder</button>
        <button class="tab" data-sekme="gez">Bilgisayardaki dosyalar</button>
      </div>
      <div data-pane="gonder" class="box">
        <div class="birak" data-k="birak">
          <p class="muted">Dosyaları buraya sürükleyin ya da</p>
          <button data-k="sec">Dosya seç</button>
          <input type="file" multiple hidden data-k="girdi">
        </div>
        <p class="muted small">Dosyalar bilgisayarda <b>İndirilenler\\Uzaktan Bağlantı</b> klasörüne kaydedilir (en fazla 8 GB). Aynı adda dosya varsa sonuna (1), (2)… eklenir.</p>
        <div data-k="yuklemeler"></div>
      </div>
      <div data-pane="gez" class="box" hidden>
        <div class="row gap">
          <button class="small ghost" data-k="ust" title="Üst klasör">⬆ Üst</button>
          <button class="small ghost" data-k="yenile" title="Yenile">↻</button>
        </div>
        <div class="yol" data-k="yol"></div>
        <p class="msg small" data-k="gezDurum"></p>
        <div class="liste" data-k="liste"></div>
      </div>
    </div>`;
  document.body.appendChild(panel);
  const el = (k) => panel.querySelector(`[data-k="${k}"]`);
  const esc = RC.esc;

  let sekme = 'gonder';
  function sekmeSec(ad) {
    sekme = ad;
    panel.querySelectorAll('[data-sekme]').forEach((b) => b.classList.toggle('active', b.dataset.sekme === ad));
    panel.querySelectorAll('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== ad; });
    if (ad === 'gez' && !yuklendi) listele(yol);
  }
  panel.querySelectorAll('[data-sekme]').forEach((b) => b.addEventListener('click', () => sekmeSec(b.dataset.sekme)));

  function ac(ad) {
    if (!izinVar()) return;
    panel.hidden = false;
    sekmeSec(ad || sekme);
  }
  function kapat() { panel.hidden = true; }
  evBtn.addEventListener('click', () => ac());
  el('kapat').addEventListener('click', kapat);
  RC.ui.closable(panel, kapat); // Esc ile de kapanır

  const boyutYaz = (n) => {
    if (n == null) return '';
    const b = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < b.length - 1) { n /= 1024; i++; }
    return `${i ? n.toFixed(n < 10 ? 1 : 0) : n} ${b[i]}`;
  };

  // ---------- Yükleme ----------
  const kuyruk = [];
  let calisan = null;

  el('sec').addEventListener('click', () => el('girdi').click());
  el('girdi').addEventListener('change', (e) => { ekle(e.target.files); e.target.value = ''; });

  function ekle(dosyalar) {
    for (const f of dosyalar) {
      const satir = document.createElement('div');
      satir.className = 'yukleme';
      satir.innerHTML = `<span class="ad">${esc(f.name)} <span class="muted small">${boyutYaz(f.size)}</span></span>
        <button class="small ghost">İptal</button>
        <progress max="1" value="0"></progress>
        <span class="muted small durum">Bekliyor…</span>`;
      el('yuklemeler').prepend(satir);
      const is = { f, satir, xhr: null, bitti: false };
      satir.querySelector('button').addEventListener('click', () => iptal(is));
      kuyruk.push(is);
    }
    sirada();
  }

  function durumYaz(is, metin, hata = false) {
    const d = is.satir.querySelector('.durum');
    d.textContent = metin;
    d.style.color = hata ? 'var(--error)' : '';
  }

  function bitir(is, metin, hata) {
    is.bitti = true;
    durumYaz(is, metin, hata);
    is.satir.querySelector('button').hidden = true;
    if (calisan === is) { calisan = null; sirada(); }
  }

  function iptal(is) {
    if (is.bitti) return;
    const i = kuyruk.indexOf(is);
    if (i >= 0) kuyruk.splice(i, 1);
    if (is.xhr) is.xhr.abort(); // sunucu yarım dosyayı siler
    else bitir(is, 'İptal edildi.', true);
  }

  function sirada() {
    if (calisan || !kuyruk.length) return;
    const is = calisan = kuyruk.shift();
    const xhr = is.xhr = new XMLHttpRequest();
    const bar = is.satir.querySelector('progress');
    xhr.open('POST', RC.authUrl(`/api/dosya/yukle?ad=${encodeURIComponent(is.f.name)}`));
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      bar.value = e.loaded / e.total;
      durumYaz(is, `${Math.floor((e.loaded / e.total) * 100)}% · ${boyutYaz(e.loaded)} / ${boyutYaz(e.total)}`);
    };
    xhr.onload = () => {
      let j = {};
      try { j = JSON.parse(xhr.responseText); } catch { /* JSON değil */ }
      if (xhr.status === 200 && j.ok) { bar.value = 1; bitir(is, `Kaydedildi: ${j.ad}`); }
      else bitir(is, j.msg || (xhr.status === 401 ? 'Oturum geçersiz, sayfayı yenileyin.' : xhr.status === 403 ? 'Yetki yok.' : `Hata (${xhr.status})`), true);
    };
    xhr.onerror = () => bitir(is, 'Bağlantı hatası.', true);
    xhr.onabort = () => bitir(is, 'İptal edildi.', true);
    durumYaz(is, 'Gönderiliyor…');
    xhr.send(is.f);
  }

  // Sürükle-bırak: paneldeki alana ve görüntüleyiciye.
  const dosyaSurukleniyor = (e) => izinVar() && [...(e.dataTransfer?.types || [])].includes('Files');
  function birakmaAlani(hedef, sinif, birakinca) {
    hedef.addEventListener('dragover', (e) => {
      if (!dosyaSurukleniyor(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      hedef.classList.add(sinif);
    });
    hedef.addEventListener('dragleave', () => hedef.classList.remove(sinif));
    hedef.addEventListener('drop', (e) => {
      hedef.classList.remove(sinif);
      if (!dosyaSurukleniyor(e)) return;
      e.preventDefault();
      if (e.dataTransfer.files.length) birakinca(e.dataTransfer.files);
    });
  }
  birakmaAlani(el('birak'), 'uzerinde', ekle);
  birakmaAlani(RC.ui.stage(), 'dosya-uzerinde', (files) => { ac('gonder'); ekle(files); });

  // ---------- Gezinme ----------
  let yol = '';
  let yuklendi = false;
  let kokAdi = 'Ana klasör';

  const birlestir = (a, b) => (a ? `${a}/${b}` : b);
  const ustYol = (p) => p.split('/').slice(0, -1).join('/');

  async function listele(hedef) {
    el('gezDurum').textContent = 'Yükleniyor…';
    el('gezDurum').className = 'msg small';
    let j;
    try {
      const r = await RC.fetch(`/api/dosya/liste?yol=${encodeURIComponent(hedef)}`);
      j = await r.json().catch(() => ({ msg: `Hata (${r.status})` }));
      if (!r.ok || !j.ok) throw new Error(j.msg || `Hata (${r.status})`);
    } catch (e) {
      el('gezDurum').textContent = e.message || 'Bağlantı hatası.';
      el('gezDurum').className = 'msg small err';
      return;
    }
    yuklendi = true;
    yol = j.yol || '';
    kokAdi = j.kok || kokAdi;
    el('gezDurum').textContent = j.kesildi ? 'Bu klasörde çok fazla dosya var; yalnızca bir kısmı gösteriliyor.' : (j.girdiler.length ? '' : 'Klasör boş.');
    yolCiz();
    el('ust').disabled = !yol;
    el('liste').innerHTML = j.girdiler.map((g) => `
      <button class="girdi" data-ad="${esc(g.ad)}" data-tur="${g.tur}">
        <span>${g.tur === 'klasor' ? '📁' : '📄'}</span>
        <span class="ad">${esc(g.ad)}</span>
        <span class="bilgi">${g.tur === 'dosya' ? `${boyutYaz(g.boyut)}<br>` : ''}${RC.fmtTime(g.degisme)}</span>
      </button>`).join('');
  }

  function yolCiz() {
    const parcalar = yol ? yol.split('/') : [];
    const dugmeler = [`<button data-yol="">🏠 ${esc(kokAdi)}</button>`];
    parcalar.forEach((p, i) => dugmeler.push(`<span>›</span><button data-yol="${esc(parcalar.slice(0, i + 1).join('/'))}">${esc(p)}</button>`));
    el('yol').innerHTML = dugmeler.join('');
  }

  el('yol').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-yol]');
    if (b) listele(b.dataset.yol);
  });
  el('ust').addEventListener('click', () => listele(ustYol(yol)));
  el('yenile').addEventListener('click', () => listele(yol));
  el('liste').addEventListener('click', (e) => {
    const b = e.target.closest('.girdi');
    if (!b) return;
    const hedef = birlestir(yol, b.dataset.ad);
    if (b.dataset.tur === 'klasor') return listele(hedef);
    // İndirme: tarayıcı dosyayı akışla kaydeder (oturum adreste).
    const a = document.createElement('a');
    a.href = RC.authUrl(`/api/dosya/indir?yol=${encodeURIComponent(hedef)}`);
    a.download = b.dataset.ad;
    document.body.appendChild(a);
    a.click();
    a.remove();
  });

  RC.on('auth', guncelle);
  RC.on('viewer:start', guncelle);
  RC.on('viewer:stop', guncelle);
})();
