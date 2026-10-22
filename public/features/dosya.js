// Dosya aktarımı: ana menüde ve araç çubuğunda 📁 düğmesi → tam ekran panel.
// (1) Bilgisayara gönder: kaydedilecek yer açıkça görünür ve "Değiştir" ile seçilir (bu cihaz için hatırlanır);
//     çoklu seçim, dosya başına ilerleme çubuğu ve iptal (XMLHttpRequest; oturum ?oturum= ile). Biten her dosya için
//     tam yeri ve "Bilgisayarda göster" düğmesi; "Son gönderilenler" listesi (bu cihazda saklanır).
// (2) Bilgisayardaki dosyalar: klasör gezinme ve indirme (her dosya türü). Dosyaya dokununca ortada ONAY penceresi
//     (ad, boyut, İndir / Vazgeç); satıra basılı tutunca seçenekler (klasör: Aç, Zip olarak indir, Seç; dosya: İndir, Seç);
//     üstte "Bu klasörü indir"; seçme kutuları + "Seçilenleri indir". Zip önce POST /api/dosya/secim ile
//     sayılır (tahmini boyut onay penceresinde), sonra kullanıcı gerçek bir <a download> bağlantısına dokunarak indirir:
//     iOS Safari/Chrome indirmeyi sayfadan ayrılmadan indirme yöneticisine verir (blob yok: büyük dosya belleğe alınmaz).
//     Görüntüleyiciye dosya sürükleyip bırakmak da gönderir.
// Salt izleme rolünde gizlidir (sunucu da kontrol yetkisi ister).
(() => {
  const RC = window.RC;

  const stil = document.createElement('style');
  stil.textContent = `
    #dosyaPanel { position: fixed; inset: 0; z-index: 30; background: var(--bg); overflow: auto; -webkit-overflow-scrolling: touch; }
    #dosyaPanel .dosya-ic { max-width: 860px; margin: 0 auto; padding: 16px; display: grid; gap: 12px;
      padding-bottom: calc(16px + env(safe-area-inset-bottom)); }
    #dosyaPanel .yukleme { display: grid; grid-template-columns: 1fr auto; gap: 4px 10px; align-items: center;
      padding: 8px 0; border-bottom: 1px solid var(--line); }
    #dosyaPanel .yukleme:last-child { border-bottom: 0; }
    #dosyaPanel .yukleme .ad, #dosyaPanel .girdi .ad, #dosyaPanel .son .ad { overflow-wrap: anywhere; }
    #dosyaPanel .yukleme .alt { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; }
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
    #dosyaPanel .hedef { display: flex; gap: 10px; align-items: center; justify-content: space-between;
      background: var(--panel2); border-radius: 10px; padding: 10px 12px; }
    #dosyaPanel .hedef > div { min-width: 0; }
    #dosyaPanel .hedef b { overflow-wrap: anywhere; }
    #dosyaPanel .tamyol { font-family: ui-monospace, Consolas, monospace; font-size: 11px; color: var(--muted); overflow-wrap: anywhere; margin: 2px 0 0; }
    #dosyaPanel .secici { border: 1px solid var(--line); border-radius: 10px; padding: 10px; display: grid; gap: 8px; }
    #dosyaPanel .kisayollar { display: flex; flex-wrap: wrap; gap: 6px; }
    #dosyaPanel .kisayollar button { padding: 8px 10px; }
    #dosyaPanel .secici .liste { max-height: 40vh; overflow: auto; -webkit-overflow-scrolling: touch; }
    #dosyaPanel .secici .girdi { grid-template-columns: 28px 1fr; }
    #dosyaPanel .yeniKlasor { display: flex; gap: 6px; }
    #dosyaPanel .yeniKlasor input { flex: 1; font-size: 16px; } /* iOS: 16 px altı yazı kutusu sayfayı yakınlaştırır */
    #dosyaPanel .son { display: grid; grid-template-columns: 1fr auto; gap: 2px 10px; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--line); }
    #dosyaPanel .son:last-child { border-bottom: 0; }
    #dosyaPanel .son .yer { grid-column: 1; }
    #dosyaPanel .son button, #dosyaPanel .yukleme button { white-space: nowrap; }
    #dosyaPanel .wrap { flex-wrap: wrap; }
    #dosyaPanel .gsatir { display: grid; grid-template-columns: 34px 1fr; gap: 4px; align-items: center; border-bottom: 1px solid var(--line); }
    #dosyaPanel .gsatir.secili { background: var(--panel2); }
    #dosyaPanel .gsatir input[type="checkbox"] { width: 22px; height: 22px; margin: 0 auto; padding: 0; accent-color: var(--accent); }
    #dosyaPanel .gsatir .ac { display: grid; grid-template-columns: 26px 1fr; gap: 6px; align-items: center; min-width: 0;
      background: transparent; border: 0; border-radius: 0; padding: 10px 2px; text-align: left; color: var(--text); font-weight: 400;
      -webkit-touch-callout: none; -webkit-user-select: none; user-select: none; }
    #dosyaPanel .gsatir .ac:hover { background: var(--panel2); }
    #dosyaPanel .gsatir .ac.basili { background: var(--panel3); }
    #dosyaPanel .gsatir .ad { overflow-wrap: anywhere; }
    #dosyaPanel .gsatir .bilgi { display: block; color: var(--muted); font-size: 12px; }
    /* Onay / seçenek penceresi (dosyaya dokununca, basılı tutunca, "Bu klasörü indir") */
    #dosyaPanel .onay { position: fixed; inset: 0; z-index: 70; display: grid; align-items: end; justify-items: center; background: rgba(0, 0, 0, .6);
      padding: 16px 12px max(16px, env(safe-area-inset-bottom)); }
    @media (min-width: 600px) { #dosyaPanel .onay { align-items: center; } }
    #dosyaPanel .onay-kart { width: min(420px, 100%); display: grid; gap: 10px; background: var(--panel); border: 1px solid var(--line2);
      border-radius: 14px; padding: 18px; box-shadow: var(--shadow); }
    #dosyaPanel .onay-kart .baslik { font-size: 16px; font-weight: 600; }
    #dosyaPanel .onay-kart .ad { overflow-wrap: anywhere; margin: 0; }
    #dosyaPanel .onay-kart .dugmeler { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 4px; }
    #dosyaPanel .onay-kart .dugmeler > * { min-height: 44px; display: grid; place-items: center; text-align: center; }
    #dosyaPanel .onay-kart a.dugme[aria-disabled="true"] { opacity: .45; pointer-events: none; }
    #dosyaPanel .onay-kart .eylemler { display: grid; gap: 6px; }
    #dosyaPanel .onay-kart .eylemler button { min-height: 46px; text-align: left; padding: 0 14px; }
    #dosyaPanel .cubuk { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between;
      background: var(--panel2); border-radius: 10px; padding: 10px 12px; position: sticky; top: 0; z-index: 1; }
    #dosyaPanel .cubuk > div { min-width: 0; }
    #dosyaPanel .cubuk .ad { overflow-wrap: anywhere; }
    #dosyaPanel a.dugme { display: inline-block; background: var(--accent); color: #fff; text-decoration: none; font-weight: 500;
      border-radius: 8px; padding: 8px 16px; font-size: 14px; -webkit-tap-highlight-color: transparent; }
  `;
  document.head.appendChild(stil);

  // ---------- Bu cihazda saklananlar (gizli sekmede/engelliyse sessizce yok sayılır) ----------
  const depo = {
    al(k, yedek) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : yedek; } catch { return yedek; } },
    koy(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch { /* yok say */ } },
  };
  const HEDEF_ANAHTAR = 'rc-dosya-hedef'; // { yol, yer, tam } — yoksa varsayılan klasör
  const SON_ANAHTAR = 'rc-dosya-son';     // [{ ad, yer, tam, id, yol, boyut, zaman }]
  const MAX_SON = 20;

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
        <div class="hedef" data-k="hedef">
          <div>
            <span class="muted small">Kaydedilecek yer:</span>
            <b data-k="hedefAd">İndirilenler › Uzaktan Bağlantı</b>
            <p class="tamyol" data-k="hedefTam"></p>
          </div>
          <button class="small ghost" data-k="degistir">Değiştir</button>
        </div>
        <div class="secici" data-k="secici" hidden>
          <div class="kisayollar" data-k="kisayollar"></div>
          <div class="yol" data-k="sYol"></div>
          <p class="msg small" data-k="sDurum"></p>
          <div class="liste" data-k="sListe"></div>
          <form class="yeniKlasor" data-k="yeniForm" hidden>
            <input data-k="yeniAd" maxlength="120" placeholder="Yeni klasör adı" autocomplete="off" autocapitalize="off" enterkeyhint="done">
            <button class="small" type="submit">Oluştur</button>
            <button class="small ghost" type="button" data-k="yeniVazgec" aria-label="Vazgeç">✕</button>
          </form>
          <div class="row gap wrap">
            <button class="small" data-k="buraya">Bu klasöre kaydet</button>
            <button class="small ghost" data-k="yeni">＋ Yeni klasör</button>
            <button class="small ghost" data-k="varsayilan">Varsayılana dön</button>
            <button class="small ghost" data-k="sKapat">Vazgeç</button>
          </div>
        </div>
        <div class="birak" data-k="birak">
          <p class="muted">Dosyaları buraya sürükleyin ya da</p>
          <button data-k="sec">Dosya seç</button>
          <input type="file" multiple hidden data-k="girdi">
        </div>
        <p class="muted small">En fazla 8 GB. Aynı adda dosya varsa sonuna (1), (2)… eklenir.</p>
        <div data-k="yuklemeler"></div>
        <div data-k="sonBolum" hidden>
          <div class="row between"><b>Son gönderilenler</b><button class="small ghost" data-k="sonTemizle">Listeyi temizle</button></div>
          <div data-k="sonListe"></div>
        </div>
      </div>
      <div data-pane="gez" class="box" hidden>
        <div class="row gap wrap">
          <button class="small ghost" data-k="ust" title="Üst klasör">⬆ Üst</button>
          <button class="small ghost" data-k="yenile" title="Yenile">↻</button>
          <button class="small ghost" data-k="tumu">Tümünü seç</button>
          <button class="small ghost" data-k="klasoruIndir" title="Bu klasörün tamamını zip olarak indir">⬇ Bu klasörü indir</button>
        </div>
        <div class="yol" data-k="yol"></div>
        <p class="msg small" data-k="gezDurum"></p>
        <div class="cubuk" data-k="secimCubugu" hidden>
          <span class="small" data-k="secimSayi"></span>
          <div class="row gap wrap">
            <button class="small" data-k="secilenleriIndir">Seçilenleri indir</button>
            <button class="small ghost" data-k="secimTemizle">Seçimi temizle</button>
          </div>
        </div>
        <div class="liste" data-k="liste"></div>
        <p class="muted small">Dosyaya dokun: indir. Satıra basılı tut: diğer seçenekler (klasörü zip olarak indir, seç). Her dosya türü
          indirilebilir; iPhone'da indirilenler Dosyalar uygulamasında İndirilenler klasörüne kaydedilir (Safari'de adres çubuğundaki ⬇
          simgesinden izlenir); zip'e dokununca açılır.</p>
        <div class="onay" data-k="onay" hidden>
          <div class="onay-kart" role="dialog" aria-modal="true">
            <div class="baslik" data-k4="baslik"></div>
            <p class="ad" data-k4="ad"></p>
            <p class="muted small" data-k4="ayrinti"></p>
            <div class="eylemler" data-k4="eylemler" hidden></div>
            <div class="dugmeler" data-k4="dugmeler">
              <button type="button" class="ghost" data-k4="vazgec">Vazgeç</button>
              <a class="dugme" data-k4="indir" download>İndir</a>
            </div>
            <p class="muted small" data-k4="not" hidden>İndirme başladı. iPhone'da Dosyalar › İndirilenler'de; Safari'de adres çubuğundaki ⬇ simgesinden izlenir.</p>
          </div>
        </div>
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
    hedefYukle();
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

  async function jsonIste(url, opts) {
    const r = await RC.fetch(url, opts);
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) {
      throw Object.assign(new Error(j.msg || (r.status === 401 ? 'Oturum geçersiz, sayfayı yenileyin.' : r.status === 403 ? 'Yetki yok.' : `Hata (${r.status})`)), { status: r.status });
    }
    return j;
  }

  // ---------- Kaydedilecek yer ----------
  let hedef = depo.al(HEDEF_ANAHTAR, null); // null: sunucunun varsayılan klasörü
  if (hedef && typeof hedef.yol !== 'string') hedef = null;
  let bilgi = null; // /api/dosya/hedef cevabı

  function hedefCiz() {
    const h = hedef || (bilgi && bilgi.varsayilan);
    el('hedefAd').textContent = h ? h.yer : 'İndirilenler › Uzaktan Bağlantı';
    el('hedefTam').textContent = h && h.tam ? h.tam : '';
  }
  hedefCiz();

  async function hedefYukle() {
    try {
      bilgi = await jsonIste('/api/dosya/hedef');
    } catch { return; }
    // Seçilen klasör hâlâ duruyor mu? (silinmiş/taşınmışsa varsayılana dön)
    if (hedef) {
      try {
        const j = await jsonIste(`/api/dosya/liste?yol=${encodeURIComponent(hedef.yol)}`);
        hedef = { yol: j.yol, yer: j.yer, tam: j.tam };
        depo.koy(HEDEF_ANAHTAR, hedef);
      } catch (e) {
        if (e.status === 404 || e.status === 400 || e.status === 403) {
          hedef = null;
          depo.koy(HEDEF_ANAHTAR, null);
          seciciDurum('Seçtiğiniz klasör artık yok; varsayılan klasöre kaydedilecek.', true);
        }
      }
    }
    hedefCiz();
  }

  // ---------- Klasör seçici ----------
  let sYol = '';
  let sYer = '';
  let sTam = '';

  function seciciDurum(metin, hataMi = false) {
    el('sDurum').textContent = metin || '';
    el('sDurum').className = `msg small${hataMi ? ' err' : ''}`;
  }

  async function seciciAc() {
    el('secici').hidden = false;
    el('degistir').hidden = true;
    if (!bilgi) await hedefYukle();
    const ks = (bilgi && bilgi.kisayollar) || [];
    const v = bilgi && bilgi.varsayilan;
    el('kisayollar').innerHTML = [
      v && v.yol != null ? `<button class="ghost" data-yol="${esc(v.yol)}" data-anahtar="varsayilan">⭐ ${esc(v.yer)}</button>` : '',
      ...ks.map((k) => `<button class="ghost" data-yol="${esc(k.yol)}" data-anahtar="${esc(k.anahtar)}">${esc(k.ad)}</button>`),
    ].join('');
    const baslangic = hedef ? hedef.yol : v && v.yol != null ? v.yol : (ks.find((k) => k.anahtar === 'indirilenler') || {}).yol || '';
    seciciListele(baslangic);
  }
  function seciciKapat() {
    el('secici').hidden = true;
    el('degistir').hidden = false;
    el('yeniForm').hidden = true;
  }

  async function seciciListele(hedefYol) {
    seciciDurum('Yükleniyor…');
    let j;
    try {
      j = await jsonIste(`/api/dosya/liste?yol=${encodeURIComponent(hedefYol)}`);
    } catch (e) {
      seciciDurum(e.message || 'Bağlantı hatası.', true);
      return;
    }
    sYol = j.yol || '';
    sYer = j.yer;
    sTam = j.tam;
    const klasorler = j.girdiler.filter((g) => g.tur === 'klasor');
    seciciDurum(klasorler.length ? '' : 'Bu klasörün içinde klasör yok.');
    const parcalar = sYol ? sYol.split('/') : [];
    const dugmeler = [`<button data-yol="">🏠 ${esc(j.kok || 'Ana klasör')}</button>`];
    parcalar.forEach((p, i) => dugmeler.push(`<span>›</span><button data-yol="${esc(parcalar.slice(0, i + 1).join('/'))}">${esc(p)}</button>`));
    el('sYol').innerHTML = dugmeler.join('');
    el('sListe').innerHTML = klasorler.map((g) => `
      <button class="girdi" data-ad="${esc(g.ad)}"><span>📁</span><span class="ad">${esc(g.ad)}</span></button>`).join('');
    el('buraya').textContent = `“${j.yer || 'Ana klasör'}” klasörüne kaydet`;
  }
  el('degistir').addEventListener('click', seciciAc);
  el('sKapat').addEventListener('click', seciciKapat);
  el('kisayollar').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-yol]');
    if (b) seciciListele(b.dataset.yol);
  });
  el('sYol').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-yol]');
    if (b) seciciListele(b.dataset.yol);
  });
  el('sListe').addEventListener('click', (e) => {
    const b = e.target.closest('.girdi');
    if (b) seciciListele(birlestir(sYol, b.dataset.ad));
  });
  el('buraya').addEventListener('click', () => {
    hedef = { yol: sYol, yer: sYer, tam: sTam };
    depo.koy(HEDEF_ANAHTAR, hedef);
    hedefCiz();
    seciciKapat();
  });
  el('varsayilan').addEventListener('click', () => {
    hedef = null;
    depo.koy(HEDEF_ANAHTAR, null);
    hedefCiz();
    seciciKapat();
  });
  el('yeni').addEventListener('click', () => {
    el('yeniForm').hidden = false;
    el('yeniAd').value = '';
    el('yeniAd').focus();
  });
  el('yeniVazgec').addEventListener('click', () => { el('yeniForm').hidden = true; });
  el('yeniForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const ad = el('yeniAd').value.trim();
    if (!ad) return;
    try {
      const j = await jsonIste(`/api/dosya/klasor?yol=${encodeURIComponent(sYol)}&ad=${encodeURIComponent(ad)}`, { method: 'POST' });
      el('yeniForm').hidden = true;
      await seciciListele(j.yol);
      seciciDurum(j.mevcut ? `“${j.ad}” zaten vardı, onu açtım.` : `“${j.ad}” oluşturuldu.`);
    } catch (err) {
      seciciDurum(err.message || 'Klasör oluşturulamadı.', true);
    }
  });

  // ---------- Bilgisayarda göster ----------
  async function goster(k, durumEl) {
    durumEl.textContent = 'Açılıyor…';
    durumEl.style.color = '';
    try {
      const q = [`id=${encodeURIComponent(k.id || '')}`];
      if (k.yol) q.push(`yol=${encodeURIComponent(k.yol)}`);
      const j = await jsonIste(`/api/dosya/goster?${q.join('&')}`, { method: 'POST' });
      durumEl.textContent = j.kuru ? 'Deneme modu: Dosya Gezgini açılmadı.' : 'Bilgisayarda Dosya Gezgini\'nde açıldı.';
    } catch (e) {
      durumEl.textContent = e.message || 'Açılamadı.';
      durumEl.style.color = 'var(--error)';
    }
  }

  // ---------- Son gönderilenler ----------
  let son = depo.al(SON_ANAHTAR, []);
  if (!Array.isArray(son)) son = [];

  function sonCiz() {
    el('sonBolum').hidden = !son.length;
    el('sonListe').innerHTML = son.map((k, i) => `
      <div class="son">
        <span class="ad">${esc(k.ad)} <span class="muted small">${boyutYaz(k.boyut)} · ${esc(RC.fmtTime(k.zaman))}</span></span>
        <button class="small ghost" data-i="${i}">Bilgisayarda göster</button>
        <span class="muted small yer">${esc(k.yer)}</span>
        <span class="small durum" data-durum="${i}"></span>
      </div>`).join('');
  }
  sonCiz();
  el('sonListe').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-i]');
    if (!b) return;
    const i = Number(b.dataset.i);
    if (son[i]) goster(son[i], el('sonListe').querySelector(`[data-durum="${i}"]`));
  });
  el('sonTemizle').addEventListener('click', () => { son = []; depo.koy(SON_ANAHTAR, son); sonCiz(); });

  function sonaEkle(k) {
    son.unshift(k);
    son = son.slice(0, MAX_SON);
    depo.koy(SON_ANAHTAR, son);
    sonCiz();
  }

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
        <button class="small ghost" data-k2="iptal">İptal</button>
        <progress max="1" value="0"></progress>
        <div class="alt"><span class="muted small durum">Bekliyor…</span></div>`;
      el('yuklemeler').prepend(satir);
      // Hedef, dosya sıraya girdiği anda sabitlenir (sonradan değiştirmek bekleyenleri etkilemez).
      const is = { f, satir, xhr: null, bitti: false, hedef: hedef ? { ...hedef } : null };
      satir.querySelector('[data-k2="iptal"]').addEventListener('click', () => iptal(is));
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
    is.satir.querySelector('[data-k2="iptal"]').hidden = true;
    if (calisan === is) { calisan = null; sirada(); }
  }

  function iptal(is) {
    if (is.bitti) return;
    const i = kuyruk.indexOf(is);
    if (i >= 0) kuyruk.splice(i, 1);
    if (is.xhr) is.xhr.abort(); // sunucu yarım dosyayı siler
    else bitir(is, 'İptal edildi.', true);
  }

  function basarili(is, j) {
    const k = { ad: j.ad, yer: `${j.yer} › ${j.ad}`, tam: j.tam, id: j.id, yol: j.yol, boyut: j.boyut, zaman: Date.now() };
    bitir(is, `Kaydedildi: ${k.yer}`);
    const alt = is.satir.querySelector('.alt');
    const tam = document.createElement('p');
    tam.className = 'tamyol';
    tam.textContent = j.tam || '';
    const btn = document.createElement('button');
    btn.className = 'small ghost';
    btn.textContent = 'Bilgisayarda göster';
    const gd = document.createElement('span');
    gd.className = 'small';
    btn.addEventListener('click', () => goster(k, gd));
    alt.append(btn, gd, tam);
    sonaEkle(k);
  }

  function sirada() {
    if (calisan || !kuyruk.length) return;
    const is = calisan = kuyruk.shift();
    const xhr = is.xhr = new XMLHttpRequest();
    const bar = is.satir.querySelector('progress');
    const klasor = is.hedef ? `&klasor=${encodeURIComponent(is.hedef.yol)}` : '';
    xhr.open('POST', RC.authUrl(`/api/dosya/yukle?ad=${encodeURIComponent(is.f.name)}${klasor}`));
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      bar.value = e.loaded / e.total;
      durumYaz(is, `${Math.floor((e.loaded / e.total) * 100)}% · ${boyutYaz(e.loaded)} / ${boyutYaz(e.total)}`);
    };
    xhr.onload = () => {
      let j = {};
      try { j = JSON.parse(xhr.responseText); } catch { /* JSON değil */ }
      if (xhr.status === 200 && j.ok) { bar.value = 1; basarili(is, j); }
      else if (xhr.status === 404 && is.hedef) bitir(is, 'Seçilen klasör bulunamadı. "Değiştir" ile başka bir yer seçin.', true);
      else bitir(is, j.msg || (xhr.status === 401 ? 'Oturum geçersiz, sayfayı yenileyin.' : xhr.status === 403 ? 'Yetki yok.' : `Hata (${xhr.status})`), true);
    };
    xhr.onerror = () => bitir(is, 'Bağlantı hatası.', true);
    xhr.onabort = () => bitir(is, 'İptal edildi.', true);
    durumYaz(is, `Gönderiliyor → ${is.hedef ? is.hedef.yer : el('hedefAd').textContent}`);
    xhr.send(is.f);
  }

  // Sürükle-bırak: paneldeki alana ve görüntüleyiciye.
  const dosyaSurukleniyor = (e) => izinVar() && [...(e.dataTransfer?.types || [])].includes('Files');
  function birakmaAlani(hedefEl, sinif, birakinca) {
    hedefEl.addEventListener('dragover', (e) => {
      if (!dosyaSurukleniyor(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      hedefEl.classList.add(sinif);
    });
    hedefEl.addEventListener('dragleave', () => hedefEl.classList.remove(sinif));
    hedefEl.addEventListener('drop', (e) => {
      hedefEl.classList.remove(sinif);
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

  async function listele(hedefYol) {
    el('gezDurum').textContent = 'Yükleniyor…';
    el('gezDurum').className = 'msg small';
    let j;
    try {
      const r = await RC.fetch(`/api/dosya/liste?yol=${encodeURIComponent(hedefYol)}`);
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
    // Seçim yalnızca aynı klasörde kalır (yenilemede hâlâ duranlar korunur).
    const adlar = new Set(j.girdiler.map((g) => g.ad));
    secili = new Set(yol === seciliYol ? [...secili].filter((a) => adlar.has(a)) : []);
    seciliYol = yol;
    turler = new Map(j.girdiler.map((g) => [g.ad, g.tur]));
    onayKapat();
    girdiler = new Map(j.girdiler.map((g) => [g.ad, g]));
    el('klasoruIndir').disabled = !j.girdiler.length;
    el('liste').innerHTML = j.girdiler.map((g) => `
      <div class="gsatir${secili.has(g.ad) ? ' secili' : ''}" data-ad="${esc(g.ad)}" data-tur="${g.tur}">
        <input type="checkbox" class="sec" aria-label="Seç: ${esc(g.ad)}"${secili.has(g.ad) ? ' checked' : ''}>
        <button class="ac">
          <span>${g.tur === 'klasor' ? '📁' : '📄'}</span>
          <span class="ad">${esc(g.ad)}<span class="bilgi">${g.tur === 'dosya' ? `${boyutYaz(g.boyut)} · ` : ''}${RC.fmtTime(g.degisme)}</span></span>
        </button>
      </div>`).join('');
    secimCiz();
  }

  // ---------- Seçim ve zip ----------
  let secili = new Set(); // geçerli klasördeki seçili adlar
  let seciliYol = null;
  let turler = new Map(); // ad -> 'klasor' | 'dosya'
  let zipIs = 0;          // en son hazırlanan zip (eski cevaplar yok sayılır)
  let girdiler = new Map(); // ad -> { ad, tur, boyut, degisme }

  function secimCiz() {
    el('secimCubugu').hidden = !secili.size;
    const dosya = [...secili].filter((a) => turler.get(a) === 'dosya').length;
    const klasor = secili.size - dosya;
    el('secimSayi').textContent = `${secili.size} seçili${klasor ? ` (${klasor} klasör)` : ''}`;
    el('secilenleriIndir').textContent = secili.size === 1 && dosya === 1 ? 'Seçileni indir' : 'Seçilenleri zip olarak indir';
    const hepsi = turler.size && secili.size === turler.size;
    el('tumu').textContent = hepsi ? 'Seçimi kaldır' : 'Tümünü seç';
    el('tumu').disabled = !turler.size;
  }

  // ---------- Onay / seçenek penceresi ----------
  // İndirme her zaman bu penceredeki gerçek <a download> bağlantısına dokunarak başlar (iOS: kullanıcı hareketi, sayfadan ayrılmaz).
  const O = (k) => el('onay').querySelector(`[data-k4="${k}"]`);
  function onayGoster({ baslik, ad, ayrinti = '', href = null, indirAd = '', eylemler = null }) {
    O('baslik').textContent = baslik;
    O('ad').textContent = ad || '';
    O('ayrinti').textContent = ayrinti;
    O('not').hidden = true;
    O('vazgec').textContent = 'Vazgeç';
    O('eylemler').hidden = !eylemler;
    O('eylemler').innerHTML = '';
    for (const e of eylemler || []) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = e.ana ? '' : 'ghost';
      b.textContent = e.ad;
      b.addEventListener('click', e.yap);
      O('eylemler').appendChild(b);
    }
    const ind = O('indir');
    ind.hidden = !!eylemler;
    O('dugmeler').style.gridTemplateColumns = eylemler ? '1fr' : '';
    if (href) { ind.href = href; ind.removeAttribute('aria-disabled'); } else { ind.removeAttribute('href'); ind.setAttribute('aria-disabled', 'true'); }
    ind.setAttribute('download', indirAd);
    el('onay').hidden = false;
  }
  function onayKapat() { zipIs++; el('onay').hidden = true; }
  RC.ui.closable(el('onay'), onayKapat); // Esc kapatır
  O('vazgec').addEventListener('click', onayKapat);
  el('onay').addEventListener('click', (e) => { if (e.target === el('onay')) onayKapat(); }); // dışına dokununca
  O('indir').addEventListener('click', () => { O('not').hidden = false; O('vazgec').textContent = 'Kapat'; }); // varsayılan davranış: indirme

  // Tek dosya: onay penceresinde ad, boyut, tarih; İndir tarayıcıya akışla kaydettirir (oturum adreste).
  function dosyaOnay(hedefYol, ad) {
    const g = girdiler.get(ad);
    onayGoster({
      baslik: 'Dosyayı indir', ad,
      ayrinti: g ? `${boyutYaz(g.boyut)} · ${RC.fmtTime(g.degisme)}` : '',
      href: RC.authUrl(`/api/dosya/indir?yol=${encodeURIComponent(hedefYol)}`), indirAd: ad,
    });
  }

  // Zip: seçim sunucuda sayılır, onay penceresinde tahmini boyut; İndir hazır olunca etkinleşir.
  async function zipHazirla(yollar) {
    const benim = ++zipIs;
    onayGoster({ baslik: 'Zip olarak indir', ad: 'Hazırlanıyor (dosyalar sayılıyor)…' });
    zipIs = benim; // onayGoster eski cevapları geçersiz kılmasın
    let j;
    try {
      j = await jsonIste('/api/dosya/secim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ yollar }) });
    } catch (e) {
      if (benim !== zipIs) return;
      O('ad').textContent = e.message || 'Zip hazırlanamadı.';
      return;
    }
    if (benim !== zipIs) return;
    const ayrinti = [`${j.dosya} dosya`, j.klasor ? `${j.klasor} klasör` : '', `${boyutYaz(j.boyut)} (sıkıştırmadan önce)`].filter(Boolean).join(' · ')
      + (j.atlanan ? ` · ${j.atlanan} öğe (kısayol/erişilemeyen) eklenmeyecek; liste zip içinde _atlananlar.txt` : '');
    onayGoster({ baslik: 'Zip olarak indir', ad: `📦 ${j.ad}`, ayrinti, href: RC.authUrl(`/api/dosya/zip?secim=${encodeURIComponent(j.id)}`), indirAd: j.ad });
    zipIs = benim;
  }

  // Basılı tutunca seçenekler.
  function secenekler(satir) {
    const ad = satir.dataset.ad, hedefYol = birlestir(yol, ad), klasor = satir.dataset.tur === 'klasor';
    const sec = () => { const k = satir.querySelector('input.sec'); k.checked = !k.checked; k.dispatchEvent(new Event('change', { bubbles: true })); onayKapat(); };
    onayGoster({
      baslik: klasor ? 'Klasör' : 'Dosya', ad,
      eylemler: klasor
        ? [{ ad: '📂 Aç', yap: () => { onayKapat(); listele(hedefYol); } }, { ad: '📦 Zip olarak indir', ana: true, yap: () => zipHazirla([hedefYol]) }, { ad: secili.has(ad) ? '☐ Seçimi kaldır' : '☑ Seç', yap: sec }]
        : [{ ad: '⬇ İndir', ana: true, yap: () => dosyaOnay(hedefYol, ad) }, { ad: secili.has(ad) ? '☐ Seçimi kaldır' : '☑ Seç', yap: sec }],
    });
  }
  el('liste').addEventListener('change', (e) => {
    const k = e.target.closest('input.sec');
    if (!k) return;
    const satir = k.closest('.gsatir');
    if (k.checked) secili.add(satir.dataset.ad); else secili.delete(satir.dataset.ad);
    satir.classList.toggle('secili', k.checked);
    secimCiz();
  });
  function hepsiniIsaretle(acik) {
    secili = new Set(acik ? turler.keys() : []);
    el('liste').querySelectorAll('.gsatir').forEach((s) => {
      s.classList.toggle('secili', acik);
      s.querySelector('input.sec').checked = acik;
    });
    secimCiz();
  }
  el('tumu').addEventListener('click', () => hepsiniIsaretle(!(turler.size && secili.size === turler.size)));
  el('secimTemizle').addEventListener('click', () => hepsiniIsaretle(false));
  el('secilenleriIndir').addEventListener('click', () => {
    const adlar = [...secili];
    if (!adlar.length) return;
    if (adlar.length === 1 && turler.get(adlar[0]) === 'dosya') return dosyaOnay(birlestir(yol, adlar[0]), adlar[0]);
    zipHazirla(adlar.map((a) => birlestir(yol, a)));
  });

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
  // Bu klasörün tamamı: kök klasörde içindekilerin hepsi (kökün kendisi zip'lenemez), alt klasörde klasörün kendisi.
  el('klasoruIndir').addEventListener('click', () => {
    if (!girdiler.size) return;
    zipHazirla(yol ? [yol] : [...girdiler.keys()]);
  });

  // Satıra dokun: klasör açılır, dosya için onay penceresi. Basılı tut (BASILI_MS, kıpırdamadan): seçenekler.
  const BASILI_MS = 500;
  let basili = null; // { satir, x, y, zamanlayici, oldu }
  let tiklamaYut = false;
  el('liste').addEventListener('pointerdown', (e) => {
    const ac = e.target.closest('.ac');
    if (!ac) return;
    const b = { satir: ac.closest('.gsatir'), ac, x: e.clientX, y: e.clientY, oldu: false };
    b.zamanlayici = setTimeout(() => { b.oldu = true; ac.classList.remove('basili'); tiklamaYut = true; navigator.vibrate?.(20); secenekler(b.satir); }, BASILI_MS);
    ac.classList.add('basili');
    basili = b;
  });
  const basiliBitir = () => { if (!basili) return; clearTimeout(basili.zamanlayici); basili.ac.classList.remove('basili'); basili = null; };
  el('liste').addEventListener('pointermove', (e) => { if (basili && Math.hypot(e.clientX - basili.x, e.clientY - basili.y) > 10) basiliBitir(); });
  el('liste').addEventListener('pointerup', basiliBitir);
  el('liste').addEventListener('pointercancel', basiliBitir);
  el('liste').addEventListener('contextmenu', (e) => { if (e.target.closest('.ac')) e.preventDefault(); });
  el('liste').addEventListener('click', (e) => {
    const b = e.target.closest('button.ac');
    const satir = b && b.closest('.gsatir');
    if (!satir) return;
    if (tiklamaYut) { tiklamaYut = false; return; } // basılı tutmanın ardından gelen tıklama
    const hedefYol = birlestir(yol, satir.dataset.ad);
    if (satir.dataset.tur === 'klasor') return listele(hedefYol);
    dosyaOnay(hedefYol, satir.dataset.ad);
  });

  RC.on('auth', guncelle);
  RC.on('viewer:start', guncelle);
  RC.on('viewer:stop', guncelle);
})();
