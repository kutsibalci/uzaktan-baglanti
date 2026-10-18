// Ev ağında HTTPS (features/sertifika.js): ⋯ menüsünde "🔒 Ev ağında HTTPS" ve kurulum rehberi paneli,
// ana menüde (sayfa HTTP'deyken ve HTTPS hazırsa) küçük bir öneri şeridi, yönetim panelinde aç/kapat/yeniden üret/sil.
// HTTP sayfası, HTTPS adresindeki /api/sertifika/yokla'yı ister: istek başarılıysa bu cihaz sertifikaya güveniyor demektir.
(() => {
  const RC = window.RC;
  if (!RC) return;

  const httpSayfa = location.protocol === 'http:';
  // localhost zaten "güvenli bağlam" sayılır (H.264 çalışır): öneri gerekmez.
  const yerelSayfa = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  const ua = navigator.userAgent;
  const iOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOS kendini Mac gösterir
  const android = /Android/i.test(ua);
  const SERIT_ANAHTAR = 'rc-sertifika-serit-gizle';

  const stil = document.createElement('style');
  stil.textContent = `
    #sertifikaPanel .rc-panel-ic { gap: 10px; }
    .srt-durum { margin: 0; padding: 8px 10px; border-radius: 10px; background: var(--bg); font-size: 14px; }
    .srt-durum.iyi { color: var(--ok); }
    .srt-durum.uyari { color: var(--warn); }
    .srt-adim { margin: 0; padding-left: 22px; display: grid; gap: 10px; font-size: 14px; }
    .srt-adim li::marker { color: var(--muted); font-weight: 600; }
    .srt-onemli { background: rgba(251,191,36,.12); border: 1px solid var(--warn); border-radius: 10px; padding: 8px 10px; margin-left: -6px; }
    .srt-onemli b.srt-uyari { color: var(--warn); display: block; margin-bottom: 2px; }
    a.srt-btn { display: inline-block; background: var(--accent); color: var(--text); text-decoration: none; border-radius: 10px;
      padding: 10px 14px; margin-top: 6px; font-size: 14px; text-align: center; }
    a.srt-btn.ghost { background: transparent; border: 1px solid var(--line); }
    a.srt-btn.gec { display: block; word-break: break-all; }
    .srt-diger summary { cursor: pointer; color: var(--muted); font-size: 14px; padding: 4px 0; }
    .srt-diger[open] summary { margin-bottom: 8px; }
    .srt-parmak { font-family: ui-monospace, Consolas, monospace; font-size: 11px; word-break: break-all; color: var(--muted); }
    .srt-serit { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; background: rgba(59,130,246,.12); border: 1px solid var(--accent);
      border-radius: 12px; padding: 8px 10px; font-size: 13px; }
    .srt-serit span { flex: 1 1 180px; min-width: 0; }
    .srt-serit button, .srt-serit a.srt-btn { margin: 0; padding: 7px 10px; font-size: 13px; border-radius: 8px; }
    .srt-serit .srt-gizle { background: transparent; color: var(--muted); padding: 7px 8px; }
    .srt-yonetim .row button { white-space: nowrap; }
  `;
  document.head.appendChild(stil);

  let durum = null;      // /api/sertifika/durum
  let guveniyor = null;  // bu cihaz HTTPS sertifikasına güveniyor mu (yoklama sonucu; HTTP sayfasında)

  // ---------- Menü satırı + panel ----------
  const item = RC.ui.menuItem({
    id: 'sertifikaBtn', icon: '🔒', label: 'Ev ağında HTTPS', order: 70, title: 'Ev ağında şifreli bağlantı (H.264 ve ses için)',
    onClick: () => kabuk.toggle(),
  });
  const kabuk = RC.ui.panel('🔒 Ev ağında HTTPS', {
    id: 'sertifikaPanel',
    onOpen() { ciz(); yenile(); },
  });

  const esc = RC.esc;
  const indirMobil = '/api/sertifika/ca.mobileconfig';
  const indirCer = '/api/sertifika/ca.cer';

  function rehberIos() {
    const ad = esc(durum?.ad || 'Uzaktan Bağlantı Yerel CA');
    return `
      <ol class="srt-adim">
        <li>Bu sayfayı <b>Safari</b>'de açıkken profili indir, çıkan soruda <b>İzin Ver</b> → <b>Kapat</b>.
          <br><a class="srt-btn" href="${indirMobil}" data-k="indir-ios">Sertifikayı indir (iPhone / iPad)</a>
          <br><span class="muted small">iOS Chrome profil yüklemeyebilir; bu adım için Safari'yi kullan. İndirdiğin şey yalnızca bu bilgisayarın kök sertifikası.</span></li>
        <li><b>Ayarlar</b> uygulamasını aç → en üstte <b>İndirilen Profil</b> (yoksa Genel → VPN ve Aygıt Yönetimi) → <b>Yükle</b> → iPhone parolası → <b>Yükle</b>.
          <br><span class="muted small">"Doğrulanmamış" yazması normal: profil imzasız. Yalnızca yerel adlar ve ev ağı adresleri için geçerli.</span></li>
        <li class="srt-onemli"><b class="srt-uyari">⚠ BU ADIM UNUTULURSA ÇALIŞMAZ</b>
          Ayarlar → Genel → Hakkında → en altta <b>Sertifika Güven Ayarları</b> → "<b>${ad}</b>" anahtarını <b>aç</b> → Devam.</li>
        <li>Şifreli adrese geç. Orada bir kez daha giriş yap (yeni adres, cihaz hatırlaması ayrı); ana ekrana eklediysen yeni adresi tekrar ekle.
          ${gecDugmesi()}</li>
      </ol>
      <p class="muted small">Kaldırmak için: Ayarlar → Genel → VPN ve Aygıt Yönetimi → profil → Profili Sil.</p>`;
  }

  function rehberAndroid() {
    return `
      <ol class="srt-adim">
        <li>Sertifikayı indir.<br><a class="srt-btn" href="${indirCer}" data-k="indir-cer">Sertifikayı indir (.cer)</a></li>
        <li><b>Ayarlar</b> → Güvenlik → (Diğer güvenlik ayarları / Şifreleme ve kimlik bilgileri) → <b>Sertifika yükle</b> → <b>CA sertifikası</b> → Yine de yükle → indirilen dosyayı seç.
          <br><span class="muted small">Menü adları markaya göre değişir; Ayarlar'da "sertifika" diye arayabilirsin.</span></li>
        <li>Tarayıcıyı kapatıp aç, sonra şifreli adrese geç (orada bir kez daha giriş yap). ${gecDugmesi()}</li>
      </ol>
      <p class="muted small">Chrome, Edge ve Samsung Internet kullanıcının yüklediği CA'lara güvenir. Firefox varsayılan olarak güvenmez (ayarı gizli) — Chrome kullan.</p>`;
  }

  function rehberBilgisayar() {
    return `
      <p class="small">Bu bilgisayarın kendisinde gerekmez (<b>localhost</b> zaten güvenli sayılır). Başka bir bilgisayarda:</p>
      <ol class="srt-adim">
        <li><a class="srt-btn ghost" href="${indirCer}">Sertifikayı indir (.cer)</a></li>
        <li><b>Windows:</b> dosyaya çift tıkla → Sertifika Yükle → Geçerli Kullanıcı → "Tüm sertifikaları aşağıdaki depolama alanına yerleştir" → <b>Güvenilen Kök Sertifika Yetkilileri</b>.
          <b>macOS:</b> çift tıkla → Anahtar Zinciri'nde sertifikayı aç → Güven → "Her zaman güven".</li>
        <li>Tarayıcıyı yeniden başlatıp şifreli adrese geç. ${gecDugmesi()}</li>
      </ol>`;
  }

  function gecDugmesi() {
    if (!durum?.adres) return '';
    return `<a class="srt-btn gec" href="${esc(durum.adres)}/" data-k="gec">${esc(durum.adres)} adresine geç →</a>`;
  }

  function durumSatiri() {
    if (!durum) return '<p class="srt-durum">Durum alınıyor…</p>';
    if (location.protocol === 'https:' && (!durum.port || location.port === String(durum.port))) {
      return '<p class="srt-durum iyi">✓ Bu bağlantı şifreli (HTTPS). H.264 görüntü ve ses kullanılabilir.</p>';
    }
    if (location.protocol === 'https:') return '<p class="srt-durum iyi">✓ Bu bağlantı zaten şifreli (Tailscale HTTPS). Ev ağı HTTPS\'i Tailscale olmadan evde kullanmak içindir.</p>';
    if (!durum.acik) {
      return `<p class="srt-durum uyari">Ev ağı HTTPS kapalı${durum.hata ? ` (${esc(durum.hata)})` : ''}. Yönetici bunu Yönetim → "Ev ağı HTTPS" bölümünden açabilir.</p>`;
    }
    const neden = yerelSayfa ? 'Bu bilgisayarda localhost zaten güvenli sayılır.' : 'Bu sayfa şifresiz (HTTP): iPhone\'da H.264 görüntü ve ses çalışmaz.';
    if (guveniyor) return `<p class="srt-durum iyi">✓ Bu cihaz sertifikaya güveniyor. ${neden} Şifreli adrese geçebilirsin.</p>${gecDugmesi()}`;
    return `<p class="srt-durum">${neden} Bir kez sertifikayı yükleyince şifreli adres kullanılabilir.${guveniyor === false ? ' <span class="muted">(Bu cihaz henüz güvenmiyor.)</span>' : ''}</p>`;
  }

  function ciz() {
    const parcalar = [
      { ad: 'iPhone / iPad', html: rehberIos, bu: iOS },
      { ad: 'Android', html: rehberAndroid, bu: android },
      { ad: 'Bilgisayar', html: rehberBilgisayar, bu: !iOS && !android },
    ];
    const kur = durum?.acik || durum?.parmakIzi;
    let html = durumSatiri();
    if (kur && !(guveniyor && httpSayfa)) {
      const ana = parcalar.find((p) => p.bu);
      html += `<h3 class="srt-baslik" style="margin:4px 0 0;font-size:14px">Kurulum (${ana.ad})</h3>${ana.html()}`;
      for (const p of parcalar.filter((x) => x !== ana)) {
        html += `<details class="srt-diger"><summary>${p.ad} için</summary>${p.html()}</details>`;
      }
    }
    if (durum?.parmakIzi) html += `<p class="srt-parmak">Kök sertifika SHA-256: ${esc(durum.parmakIzi)}</p>`;
    kabuk.body.innerHTML = html;
    item.set({ state: menuDurumu() });
  }

  function menuDurumu() {
    if (location.protocol === 'https:') return 'açık ✓';
    if (!durum) return '';
    if (!durum.acik) return 'kapalı';
    return guveniyor ? 'hazır — geç' : 'kurulum';
  }

  // ---------- Ana menüdeki öneri şeridi ----------
  const serit = document.createElement('div');
  serit.className = 'srt-serit';
  serit.id = 'sertifikaSerit';
  serit.hidden = true;
  // Kartların üstünde: ana menü uzun (kumanda, çizim kartları); altta kalınca telefonda görünmüyordu.
  const modlar = document.querySelector('#vHome .modes');
  if (modlar) modlar.before(serit); else RC.ui.home(serit);

  const seritGizli = () => { try { return localStorage.getItem(SERIT_ANAHTAR) === '1'; } catch { return false; } };
  function seritCiz() {
    const goster = httpSayfa && !yerelSayfa && !!durum?.acik && !seritGizli();
    serit.hidden = !goster;
    if (!goster) return;
    serit.innerHTML = (guveniyor
      ? `<span>🔒 Bu cihaz ev ağı sertifikasına güveniyor: şifreli adreste H.264 görüntü ve ses çalışır.</span>
         <a class="srt-btn" href="${esc(durum.adres)}/" data-k="gec">Şifreli adrese geç</a>`
      : `<span>🔒 Ev ağında şifreli bağlantı hazır: bir kez sertifika yükle, H.264 görüntü ve ses çalışsın.</span>
         <button type="button" data-k="nasil">Nasıl?</button>`)
      + '<button type="button" class="srt-gizle" data-k="gizle" title="Bir daha gösterme" aria-label="Bir daha gösterme">✕</button>';
  }
  serit.addEventListener('click', (e) => {
    const k = e.target.closest('[data-k]')?.dataset.k;
    if (k === 'nasil') kabuk.open();
    if (k === 'gizle') {
      try { localStorage.setItem(SERIT_ANAHTAR, '1'); } catch { /* özel pencere */ }
      seritCiz();
    }
  });

  // ---------- Durum ve güven yoklaması ----------
  async function yenile() {
    try {
      const r = await fetch('/api/sertifika/durum', { cache: 'no-store' });
      durum = r.ok ? await r.json() : null;
    } catch { durum = null; }
    await yokla();
    ciz();
    seritCiz();
  }

  async function yokla() {
    if (!httpSayfa || !durum?.acik || !durum.adres) { guveniyor = null; return; }
    const ctl = new AbortController();
    const zaman = setTimeout(() => ctl.abort(), 4000);
    try {
      const r = await fetch(`${durum.adres}/api/sertifika/yokla`, { cache: 'no-store', signal: ctl.signal });
      guveniyor = r.ok;
    } catch {
      guveniyor = false; // sertifika güvenilmiyor (ya da port erişilemiyor)
    } finally { clearTimeout(zaman); }
  }

  RC.on('auth', yenile);
  RC.on('sertifika-durum', (m) => {
    yenile();
    if ('ipler' in m) yonetimCiz(m); // yalnızca yöneticiye giden ayrıntı
    if (m.ok || m.error) { yonetimMsg.className = `msg ${m.error ? 'err' : 'ok'}`; yonetimMsg.textContent = m.error || m.ok; }
  });
  ciz();

  // ---------- Yönetim paneli ----------
  const yonetim = document.createElement('div');
  yonetim.className = 'srt-yonetim';
  yonetim.style.display = 'grid';
  yonetim.style.gap = '10px';
  const yonetimIc = document.createElement('div');
  yonetimIc.style.display = 'grid';
  yonetimIc.style.gap = '10px';
  const yonetimMsg = document.createElement('p');
  yonetimMsg.className = 'msg';
  yonetim.append(yonetimIc, yonetimMsg);
  RC.ui.adminSection('Ev ağı HTTPS (kendi sertifikamız)', yonetim);

  function yonetimCiz(d) {
    const bitis = (s) => (s ? new Date(s).toLocaleDateString('tr-TR') : '—');
    yonetimIc.innerHTML = `
      <div><span class="dot ${d.acik ? 'on' : ''}"></span>${d.acik ? `Açık — port <b>${d.port}</b>` : 'Kapalı'}${d.hata ? ` <span class="warn">(${esc(d.hata)})</span>` : ''}</div>
      ${d.ipler?.length ? `<div class="small">Sertifikadaki adresler: ${d.ipler.map((x) => `<span class="mono" style="letter-spacing:0">${esc(x)}</span>`).join(', ')}; adlar: ${d.adlar.map(esc).join(', ')}</div>` : ''}
      ${d.ad ? `<div class="small muted">Kök sertifika: ${esc(d.ad)} · bitiş ${bitis(d.caBitis)} · sunucu sertifikası bitiş ${bitis(d.sunucuBitis)} (kendiliğinden yenilenir)</div>` : ''}
      ${d.parmakIzi ? `<div class="srt-parmak">SHA-256: ${esc(d.parmakIzi)}</div>` : ''}
      <div class="row gap wrap">
        ${d.acik ? '<button class="small ghost" data-op="kapat">Kapat</button>' : '<button class="small" data-op="ac">Aç (gerekirse sertifika üret)</button>'}
        ${d.ad ? '<button class="small ghost" data-op="yeniden">Kök sertifikayı yeniden üret</button><button class="small danger" data-op="sil">Sil</button>' : ''}
      </div>
      <p class="muted small">iPhone'da Safari H.264 ve sesi yalnızca HTTPS'te çalıştırır. Bu bilgisayar kendi kök sertifikasını (CA) üretir; telefona bir kez yüklenir
        (⋯ menü / ana menü → 🔒 Ev ağında HTTPS). Kök sertifika yalnızca yerel adlar (localhost, *.local, bilgisayar adı) ve ev ağı / Tailscale adresleri için
        geçerli olacak şekilde kısıtlıdır (Name Constraints): anahtarı çalınsa bile internet sitelerini taklit edemez. Özel anahtarlar yalnızca bu bilgisayarda,
        <span class="mono" style="letter-spacing:0">${esc(d.klasor || 'data/sertifika')}</span> klasöründe durur. IP adresi değişirse sunucu sertifikası kendiliğinden yeniden imzalanır.</p>`;
  }
  yonetim.addEventListener('click', (e) => {
    const op = e.target.closest('button[data-op]')?.dataset.op;
    if (!op) return;
    const uyari = {
      kapat: 'Ev ağı HTTPS kapatılsın mı? HTTPS adresinden bağlı olanların bağlantısı kesilir.',
      yeniden: 'Yeni kök sertifika üretilsin mi?\n\nTelefonlara daha önce yüklenen profil GEÇERSİZ olur: her cihaza yeni profili yükleyip Sertifika Güven Ayarları\'nda yeniden açmak gerekir.',
      sil: 'Sertifikalar silinsin ve ev ağı HTTPS kapatılsın mı?\n\nTelefonlardaki eski profil işe yaramaz hale gelir (Ayarlar\'dan silebilirsiniz).',
    }[op];
    if (uyari && !confirm(uyari)) return;
    yonetimMsg.className = 'msg';
    yonetimMsg.textContent = 'İşleniyor…';
    RC.send({ t: 'sertifika', op });
  });
  RC.on('admin', (m) => { if (m.features?.sertifika) yonetimCiz(m.features.sertifika); });
})();
