// Bilgisayar durumu paneli (⋯ menüsünde ve ana menüde "📊 Bilgisayar durumu") + uygulama içi bildirim kartları.
// Panel açıkken sunucuya abone olunur (saniyede bir ölçüm), kapanınca abonelik biter. Salt izleme rolü yalnızca görür;
// kontrol rolü izleyici (bildirim) kurar; yalnızca yönetici program kapatabilir. Grafikler: son 60 sn, SVG.
(() => {
  const RC = window.RC;
  if (!RC) return;

  const style = document.createElement('style');
  style.textContent = `
    .rc-panel.drop.durum-panel { width: min(560px, calc(100vw - 16px)); }
    .durum-panel .rc-panel-ic { gap: 10px; }
    .dr-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
    .dr-k { background: var(--panel2); border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; display: grid; gap: 2px; min-width: 0; }
    .dr-k .dr-ust { display: flex; align-items: baseline; justify-content: space-between; gap: 6px; }
    .dr-k .dr-ust span { white-space: nowrap; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .4px; }
    .dr-k b { font-size: 17px; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .dr-k small { color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .dr-spark { width: 100%; height: 26px; display: block; }
    .dr-spark polyline { fill: none; stroke-width: 1.6; vector-effect: non-scaling-stroke; stroke-linejoin: round; }
    .dr-spark .a { stroke: var(--accent); } .dr-spark .b { stroke: var(--ok); }
    .dr-disk { display: grid; gap: 3px; font-size: 13px; }
    .dr-disk .dr-ust { display: flex; justify-content: space-between; gap: 8px; color: var(--muted); font-variant-numeric: tabular-nums; }
    .dr-bar { height: 6px; border-radius: 3px; background: var(--bg); overflow: hidden; }
    .dr-bar i { display: block; height: 100%; background: var(--accent); border-radius: 3px; }
    .dr-bar i.dolu { background: var(--warn); }
    .dr-bas { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
    .dr-bas h4 { margin: 0; flex: 1; font-size: 13px; color: var(--muted); text-transform: uppercase; letter-spacing: .5px; }
    .dr-sira { display: flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
    .dr-sira button { background: transparent; border: 0; border-radius: 0; padding: 6px 12px; font-size: 13px; color: var(--muted); }
    .dr-sira button.on { background: var(--panel2); color: var(--text); }
    .dr-bas h4 small { margin-left: 4px; color: var(--muted); font-size: 12px; font-weight: 400; text-transform: none; letter-spacing: 0; font-variant-numeric: tabular-nums; }
    .dr-liste { display: grid; gap: 2px; }
    .dr-bol { display: flex; align-items: center; gap: 6px; width: 100%; margin: 4px 0 0; padding: 4px 2px; font-size: 13px; font-weight: 500;
      color: var(--muted); background: transparent; border: 0; border-radius: 6px; text-align: left; }
    .dr-bol small { font-weight: 400; font-variant-numeric: tabular-nums; }
    button.dr-bol { min-height: 40px; cursor: pointer; }
    @media (hover: hover) { button.dr-bol:hover:not(:disabled) { background: var(--panel2); } }
    .dr-bol svg { margin-left: auto; width: 16px; height: 16px; transition: transform .15s; }
    .dr-bol[aria-expanded=true] svg { transform: rotate(90deg); }
    .dr-s { display: flex; align-items: center; gap: 6px; min-height: 44px; padding: 3px 4px 3px 10px; border-radius: 8px; background: var(--panel2); }
    .dr-s .dr-ad { flex: 1 1 auto; min-width: 0; display: grid; }
    .dr-s .dr-ad b { display: flex; gap: 4px; min-width: 0; font-weight: 500; font-size: 14px; }
    .dr-s .dr-adm, .dr-s .dr-ad small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
    .dr-s .dr-adet { flex: none; color: var(--muted); font-weight: 400; font-variant-numeric: tabular-nums; }
    .dr-s .dr-ad small { color: var(--muted); font-size: 12px; }
    /* Telefonda CPU ile bellek alt alta (ada yer kalsın), genişte yan yana sütun; sıralanan değer belirgin. */
    .dr-nlar { flex: none; display: grid; justify-items: end; width: 66px; font-size: 13px; line-height: 1.35; font-variant-numeric: tabular-nums; }
    .dr-nlar span { color: var(--muted); white-space: nowrap; }
    .dr-nlar span.on { color: var(--text); }
    @media (min-width: 600px) { .dr-nlar { grid-template-columns: 56px 72px; width: 136px; } }
    .dr-s button { flex: none; min-width: 40px; height: 36px; padding: 0 8px; font-size: 13px; border-radius: 8px; background: var(--panel); border: 1px solid var(--line); }
    @media (hover: hover) { .dr-s button:hover:not(:disabled) { background: var(--panel3); } }
    .dr-s button.on { border-color: var(--warn); }
    .dr-s button[data-act=kapat] { min-width: 62px; }
    .dr-s button.kilit { opacity: .45; }
    .dr-s button.kapat { color: #fca5a5; }
    .dr-msg { margin: 0; font-size: 14px; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .dr-msg:empty { display: none; }
    .dr-msg.ok { color: var(--ok); } .dr-msg.err { color: var(--error); } .dr-msg.warn { color: var(--warn); }
    .dr-msg button { background: #7f1d1d; padding: 6px 12px; font-size: 13px; border-radius: 8px; }
    .dr-i { display: flex; align-items: center; gap: 8px; min-height: 40px; padding: 2px 4px 2px 10px; border-radius: 8px; background: var(--panel2); font-size: 14px; }
    .dr-i span { flex: 1; min-width: 0; }
    .dr-i small { color: var(--muted); }
    .dr-i button { flex: none; width: 36px; height: 36px; padding: 0; background: transparent; border: 0; color: var(--muted); }
    .dr-ekle { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .dr-ekle select { flex: 1 1 180px; padding: 8px 10px; }
    .dr-ekle input { width: 74px; padding: 8px 10px; }
    .dr-ekle button { padding: 8px 14px; }
    .dr-bos { color: var(--muted); font-size: 13px; margin: 0; }
    #durumBildirim { position: fixed; z-index: 60; left: 8px; right: 8px; top: calc(8px + env(safe-area-inset-top)); margin: 0 auto; max-width: 460px;
      display: grid; gap: 8px; pointer-events: none; }
    .dr-kart { pointer-events: auto; display: flex; gap: 10px; align-items: flex-start; background: var(--panel); border: 1px solid var(--warn);
      border-radius: 12px; padding: 10px 6px 10px 12px; box-shadow: 0 6px 24px rgba(0,0,0,.5); }
    .dr-kart > div { flex: 1; min-width: 0; display: grid; gap: 2px; }
    .dr-kart small { color: var(--muted); font-size: 12px; }
    .dr-kart button { flex: none; width: 40px; height: 40px; padding: 0; background: transparent; border: 0; color: var(--muted); font-size: 16px; }
  `;
  document.head.appendChild(style);

  const rol = () => RC.state().me?.role || 'view';
  const kontrol = () => rol() === 'control' || rol() === 'admin';
  const yonetici = () => rol() === 'admin';

  // ---------- Biçimlendirme ----------
  const ondalik = (x, n = 1) => x.toFixed(n).replace('.', ',');
  const gb = (b) => `${ondalik(b / 2 ** 30, b >= 100 * 2 ** 30 ? 0 : 1)} GB`;
  const mb = (b) => (b >= 2 ** 30 ? gb(b) : `${Math.round(b / 2 ** 20)} MB`);
  const hiz = (b) => (b == null ? '–' : b >= 2 ** 20 ? `${ondalik(b / 2 ** 20)} MB/sn` : `${Math.round(b / 1024)} KB/sn`);
  function sure(sn) {
    const g = Math.floor(sn / 86400), s = Math.floor((sn % 86400) / 3600), d = Math.floor((sn % 3600) / 60);
    return g ? `${g} gün ${s} sa` : s ? `${s} sa ${d} dk` : `${d} dk`;
  }
  const saat = (t) => new Date(t).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });

  // ---------- Panel ----------
  const homeBtn = document.createElement('button');
  homeBtn.className = 'ghost';
  homeBtn.id = 'durumHomeBtn';
  homeBtn.textContent = '📊 Bilgisayar durumu';
  RC.ui.home(homeBtn);

  const abone = (acik) => RC.send({ t: 'durum-abone', acik });
  const panel = RC.ui.panel('Bilgisayar durumu', {
    id: 'durumPanel', className: 'durum-panel', anchor: homeBtn,
    onOpen() { gecmis = []; son = null; ciz(null); surecleriCiz(null); rolGuncelle(); abone(true); },
    onClose() { abone(false); },
  });
  homeBtn.addEventListener('click', () => panel.toggle());
  RC.ui.menuItem({ id: 'durumBtn', icon: '📊', label: 'Bilgisayar durumu', order: 55, onClick: () => panel.open() });

  const b = panel.body;
  b.innerHTML = `
    <p class="dr-msg err" data-r="hata"></p>
    <div class="dr-grid">
      <div class="dr-k" data-k="cpu"><div class="dr-ust"><span>İşlemci</span><b>–</b></div><svg class="dr-spark" viewBox="0 0 59 100" preserveAspectRatio="none"><polyline class="a"/></svg><small></small></div>
      <div class="dr-k" data-k="ram"><div class="dr-ust"><span>Bellek</span><b>–</b></div><svg class="dr-spark" viewBox="0 0 59 100" preserveAspectRatio="none"><polyline class="a"/></svg><small></small></div>
      <div class="dr-k" data-k="gpu" hidden><div class="dr-ust"><span>GPU</span><b>–</b></div><svg class="dr-spark" viewBox="0 0 59 100" preserveAspectRatio="none"><polyline class="a"/></svg><small></small></div>
      <div class="dr-k" data-k="ag"><div class="dr-ust"><span>Ağ</span><b>–</b></div><svg class="dr-spark" viewBox="0 0 59 100" preserveAspectRatio="none"><polyline class="a"/><polyline class="b"/></svg><small></small></div>
      <div class="dr-k" data-k="pil" hidden><div class="dr-ust"><span>Pil</span><b>–</b></div><small></small></div>
      <div class="dr-k" data-k="sure"><div class="dr-ust"><span>Açık süre</span><b>–</b></div><small></small></div>
    </div>
    <div class="dr-liste" data-r="diskler"></div>
    <div class="dr-bas"><h4>Çalışan programlar <small data-r="surecSayi"></small></h4>
      <div class="dr-sira" role="group" aria-label="Sıralama"><button type="button" data-sira="cpu" class="on">CPU</button><button type="button" data-sira="ram">RAM</button></div></div>
    <p class="dr-msg" data-r="kmsg"></p>
    <div data-r="programlar">
      <div class="dr-bol">Uygulamalar <small data-r="uygSayi"></small></div>
      <div class="dr-liste" data-r="uyg"><p class="dr-bos">Ölçülüyor…</p></div>
      <button type="button" class="dr-bol" data-r="arkaAc" aria-expanded="false" aria-controls="durumArka">Arka plan işlemleri <small data-r="arkaSayi"></small>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      <div class="dr-liste" data-r="arka" id="durumArka" hidden></div>
    </div>
    <div class="dr-bas"><h4>Bildirimler</h4></div>
    <div class="dr-liste" data-r="izleyiciler"></div>
    <div class="dr-ekle" data-r="ekle">
      <select aria-label="Bildirim türü">
        <option value="cpu">CPU % altına inince (render bitti)</option>
        <option value="pil">Pil % altına inince</option>
        <option value="indirme">İndirme bitince (yeni dosya)</option>
      </select>
      <input type="number" inputmode="numeric" min="1" max="99" value="10" aria-label="Yüzde">
      <button type="button">Ekle</button>
    </div>
    <p class="dr-bos" data-r="ipucu">Program kapanınca haber almak için listede 🔔'e dokunun. Bildirimler bu sayfa açıkken (bağlıyken) gelir; bağlı değilken olanlar bir sonraki girişte gösterilir.</p>
    <label class="check"><input type="checkbox" data-r="ses"> Bildirim sesi (kısa bip)</label>`;
  const q = (r) => b.querySelector(`[data-r="${r}"]`);
  const kutu = (k) => b.querySelector(`[data-k="${k}"]`);

  let gecmis = [];       // { cpu, ram, gpu, in, out }
  let son = null;
  let sira = 'cpu';
  let izleyiciler = [];
  let kuru = false;

  function cizgi(pl, degerler, enBuyuk) {
    const v = degerler.slice(-60);
    const bas = 59 - (v.length - 1);
    pl.setAttribute('points', v.map((x, i) => `${bas + i},${100 - Math.max(0, Math.min(100, ((x ?? 0) / enBuyuk) * 100))}`).join(' '));
  }

  function kart(k, deger, alt) {
    const e = kutu(k);
    e.querySelector('b').textContent = deger;
    e.querySelector('small').textContent = alt || '';
  }

  function ciz(m) {
    if (!m) {
      for (const k of ['cpu', 'ram', 'gpu', 'ag', 'pil', 'sure']) kart(k, '–', '');
      for (const pl of b.querySelectorAll('polyline')) pl.setAttribute('points', '');
      return;
    }
    kart('cpu', `%${Math.round(m.cpu)}`, m.cpuSic != null ? `Sıcaklık ${Math.round(m.cpuSic)} °C` : `Sıcaklık: ${(m.cpuSicNeden || 'ölçülemiyor').replace(/^Ölçülemiyor/, 'ölçülemiyor')}`);
    cizgi(kutu('cpu').querySelector('polyline'), gecmis.map((g) => g.cpu), 100);
    kart('ram', `%${Math.round((100 * m.ramKul) / m.ramTop)}`, `${gb(m.ramKul)} / ${gb(m.ramTop)}`);
    cizgi(kutu('ram').querySelector('polyline'), gecmis.map((g) => g.ram), 100);
    const g = m.gpu?.[0];
    kutu('gpu').hidden = !g;
    if (g) {
      kart('gpu', g.kul != null ? `%${g.kul}` : '–', [g.sic != null && `${g.sic} °C`, g.vramTop && `${ondalik(g.vramKul / 2 ** 30)}/${ondalik(g.vramTop / 2 ** 30)} GB`, g.ad.replace(/^NVIDIA (GeForce )?/, '')].filter(Boolean).join(' · '));
      kutu('gpu').title = g.ad;
      cizgi(kutu('gpu').querySelector('polyline'), gecmis.map((x) => x.gpu), 100);
    }
    kart('ag', `↓ ${hiz(m.ag?.in)}`, `↑ ${hiz(m.ag?.out)}`);
    const enB = Math.max(64 * 1024, ...gecmis.map((x) => Math.max(x.in || 0, x.out || 0)));
    const [pa, pb] = kutu('ag').querySelectorAll('polyline');
    cizgi(pa, gecmis.map((x) => x.in), enB);
    cizgi(pb, gecmis.map((x) => x.out), enB);
    kutu('pil').hidden = !m.pil;
    if (m.pil) kart('pil', `%${m.pil.yuzde}`, m.pil.sarj ? 'şarj oluyor' : m.pil.fis ? 'prizde' : 'pilde');
    kart('sure', sure(m.uptime), 'son açılıştan beri');
    pilSecenek.hidden = pilSecenek.disabled = !m.pil; // iOS seçicide hidden işe yaramaz, disabled da verilir

    const dk = q('diskler');
    dk.replaceChildren(...(m.diskler || []).map((d) => {
      const e = document.createElement('div');
      e.className = 'dr-disk';
      const dolu = (d.top - d.bos) / d.top;
      e.innerHTML = `<div class="dr-ust"><span></span><span></span></div><div class="dr-bar"><i></i></div>`;
      e.querySelector('span').textContent = `💽 ${d.ad.replace(/\\$/, '')}${d.etiket ? ` ${d.etiket}` : ''}`;
      e.querySelectorAll('span')[1].textContent = `${gb(d.bos)} boş / ${gb(d.top)}`;
      const i = e.querySelector('i');
      i.style.width = `${Math.round(dolu * 100)}%`;
      i.classList.toggle('dolu', dolu > 0.9);
      return e;
    }));

    if (!duraklat) surecleriCiz(m.gruplar, m.sayilar);
  }

  // ---------- Süreç listesi (Görev Yöneticisi gibi: gruplar, Uygulamalar + Arka plan işlemleri) ----------
  // Grup: aynı programın süreçleri tek satır ("Google Chrome (40)"), CPU ve bellek toplamı. Kapat / 🔔 gruptaki TÜM süreçlere
  // (PID + başlama zamanıyla) uygulanır; biri korumalıysa grup 🔒.
  const satirlar = new Map(); // "pid:ct" (kök) -> eleman
  let duraklat = false, duraklatTimer = null;
  let arkaAcik = false; // arka plan işlemleri varsayılan katlı
  const programlar = q('programlar');
  const uygListe = q('uyg'), arkaListe = q('arka'), arkaAc = q('arkaAc');
  const uyeleri = (g) => g.uyeler || [[g.pid, g.ct]];
  // Parmak listedeyken sıra değişmesin (yoksa dokunulan satır kayar ve yanlış düğmeye basılır).
  programlar.addEventListener('pointerdown', (e) => { if (e.target.closest('.dr-s')) { duraklat = true; clearTimeout(duraklatTimer); } });
  const birak = () => { clearTimeout(duraklatTimer); duraklatTimer = setTimeout(() => { duraklat = false; }, 1500); };
  programlar.addEventListener('pointerup', birak);
  programlar.addEventListener('pointercancel', birak);

  arkaAc.addEventListener('click', () => {
    arkaAcik = !arkaAcik;
    arkaAc.setAttribute('aria-expanded', String(arkaAcik));
    arkaListe.hidden = !arkaAcik;
    if (son) surecleriCiz(son.gruplar, son.sayilar);
  });

  function satir(g, izlenen) {
    const anahtar = `${g.pid}:${g.ct}`;
    let e = satirlar.get(anahtar);
    if (!e) {
      e = document.createElement('div');
      e.className = 'dr-s';
      e.dataset.pid = g.pid;
      e.dataset.ct = g.ct;
      e.innerHTML = `<div class="dr-ad"><b><span class="dr-adm"></span><span class="dr-adet"></span></b><small></small></div>
        <div class="dr-nlar"><span data-n="cpu" title="İşlemci"></span><span data-n="ram" title="Bellek (özel çalışma kümesi)"></span></div>
        <button type="button" data-act="izle" title="Kapanınca haber ver" aria-label="Kapanınca haber ver">🔔</button>
        <button type="button" data-act="kapat">Kapat</button>`;
    }
    e._p = g;
    e.querySelector('.dr-adm').textContent = g.ad;
    e.querySelector('.dr-adet').textContent = g.n > 1 ? `(${g.n})` : '';
    const alt = [g.ad !== g.exe && g.exe, g.baslik !== g.ad && g.baslik].filter(Boolean).join(' · ');
    const small = e.querySelector('small');
    small.textContent = alt;
    small.hidden = !alt;
    const cpu = e.querySelector('[data-n=cpu]'), ram = e.querySelector('[data-n=ram]');
    cpu.textContent = `%${ondalik(g.cpu)}`;
    ram.textContent = mb(g.ram);
    cpu.classList.toggle('on', sira === 'cpu');
    ram.classList.toggle('on', sira === 'ram');
    const iz = e.querySelector('[data-act="izle"]');
    iz.hidden = !kontrol();
    iz.classList.toggle('on', uyeleri(g).some(([pid]) => izlenen.has(pid)));
    const k = e.querySelector('[data-act="kapat"]');
    k.hidden = !yonetici();
    k.classList.toggle('kilit', !!g.koruma);
    k.classList.toggle('kapat', !g.koruma);
    k.textContent = g.koruma ? '🔒' : 'Kapat';
    k.title = g.koruma || `${g.ad} programını kapat${g.n > 1 ? ` (${g.n} işlem)` : ''}`;
    k.setAttribute('aria-label', k.title);
    return [anahtar, e];
  }

  function surecleriCiz(gruplar, sayilar) {
    q('surecSayi').textContent = sayilar ? `${sayilar.surec} işlem` : '';
    q('uygSayi').textContent = sayilar ? `(${sayilar.uyg})` : '';
    q('arkaSayi').textContent = sayilar ? `(${sayilar.arka})` : '';
    if (!gruplar) {
      uygListe.innerHTML = '<p class="dr-bos">Ölçülüyor…</p>';
      arkaListe.replaceChildren();
      satirlar.clear();
      return;
    }
    const sirala = (l) => l.sort((a, c) => (sira === 'cpu' ? c.cpu - a.cpu || c.ram - a.ram : c.ram - a.ram)).slice(0, 15);
    const izlenen = new Set(izleyiciler.filter((i) => i.tur === 'surec').flatMap((i) => (i.surecler || [[i.pid]]).map(([pid]) => pid)));
    const yeni = new Map();
    const ciz1 = (el, l, bos) => {
      const ogeler = l.map((g) => { const [a, e] = satir(g, izlenen); yeni.set(a, e); return e; });
      if (ogeler.length) el.replaceChildren(...ogeler);
      else el.innerHTML = `<p class="dr-bos">${bos}</p>`;
    };
    ciz1(uygListe, sirala(gruplar.filter((g) => g.uyg)), 'Açık pencereli program yok.');
    if (arkaAcik) ciz1(arkaListe, sirala(gruplar.filter((g) => !g.uyg)), 'Arka plan işlemi yok.');
    else arkaListe.replaceChildren();
    satirlar.clear();
    for (const [a, e] of yeni) satirlar.set(a, e);
  }

  b.querySelector('.dr-sira').addEventListener('click', (e) => {
    const x = e.target.closest('button[data-sira]');
    if (!x) return;
    sira = x.dataset.sira;
    for (const y of b.querySelectorAll('[data-sira]')) y.classList.toggle('on', y === x);
    if (son) surecleriCiz(son.gruplar, son.sayilar);
  });

  const kmsg = q('kmsg');
  const islem = (n) => (n > 1 ? ` (${n} işlem)` : '');
  function mesaj(metin, tur = '', zorla = null) {
    kmsg.className = `dr-msg ${tur}`;
    kmsg.textContent = metin;
    if (zorla) {
      const z = document.createElement('button');
      z.type = 'button';
      z.textContent = 'Zorla kapat';
      z.addEventListener('click', () => {
        if (!confirm(`"${zorla.ad}" zorla kapatılsın mı?${islem(zorla.surecler.length)}\n\nKaydedilmemiş işler KAYBOLUR.`)) return;
        mesaj(`"${zorla.ad}" zorla kapatılıyor…`);
        RC.send({ t: 'durum-kapat', pid: zorla.pid, ct: zorla.ct, surecler: zorla.surecler, ad: zorla.ad, zorla: true });
      });
      kmsg.appendChild(z);
    }
  }

  programlar.addEventListener('click', (e) => {
    const x = e.target.closest('button[data-act]');
    const g = x?.closest('.dr-s')?._p;
    if (!g) return;
    if (x.dataset.act === 'izle') {
      if (x.classList.contains('on')) {
        const pidler = new Set(uyeleri(g).map(([pid]) => pid));
        const i = izleyiciler.find((y) => y.tur === 'surec' && (y.surecler || [[y.pid]]).some(([pid]) => pidler.has(pid)));
        if (i) RC.send({ t: 'durum-izle-sil', id: i.id });
        return;
      }
      RC.send({ t: 'durum-izle', tur: 'surec', pid: g.pid, ct: g.ct, surecler: uyeleri(g), ad: g.baslik && g.baslik !== g.ad ? `${g.ad} (${g.baslik.slice(0, 40)})` : g.ad });
      return;
    }
    if (g.koruma) { alert(`${g.ad}\n\n${g.koruma}`); return; }
    const hepsi = g.n > 1 ? ` (${g.n} işlemin hepsi)` : '';
    if (!confirm(`"${g.ad}" kapatılsın mı?${hepsi}${g.baslik ? `\n${g.baslik}` : ''}\n\nÖnce nazikçe kapatılır; kaydedilmemiş iş varsa program bilgisayarda sorabilir.`)) return;
    mesaj(`"${g.ad}" kapatılıyor…`);
    RC.send({ t: 'durum-kapat', pid: g.pid, ct: g.ct, surecler: uyeleri(g), ad: g.ad });
  });

  RC.on('durum-kapat-sonuc', (m) => {
    const ad = m.ad || `PID ${m.pid}`;
    const deneme = m.kuru ? ' (deneme modu — kapatılmadı)' : '';
    if (!m.ok) return mesaj(m.msg || 'Kapatılamadı.', 'err');
    if (m.asama === 'nazik') return mesaj(m.pencere ? `"${ad}" kapatılması istendi${islem(m.adet)}${deneme}; 5 sn bekleniyor…` : `${m.msg || 'Penceresi yok.'}`, m.pencere ? '' : 'warn');
    if (m.asama === 'kontrol') {
      if (!m.hala) return mesaj(`"${ad}" kapandı.`, 'ok');
      const kalan = Array.isArray(m.kalan) && m.kalan.length ? m.kalan : [[m.pid, m.ct]];
      return mesaj(`"${ad}" hâlâ açık${islem(kalan.length)}${deneme}.`, 'warn', { pid: m.pid, ct: m.ct, ad, surecler: kalan });
    }
    if (m.asama === 'zorla') mesaj(`"${ad}" zorla kapatıldı${islem(m.adet)}${deneme}.`, 'ok');
  });

  // ---------- İzleyiciler ----------
  const ekle = q('ekle');
  const tur = ekle.querySelector('select');
  const esik = ekle.querySelector('input');
  const pilSecenek = tur.querySelector('option[value="pil"]');
  pilSecenek.hidden = pilSecenek.disabled = true;
  tur.addEventListener('change', () => {
    esik.hidden = tur.value === 'indirme';
    esik.value = tur.value === 'pil' ? 20 : 10;
  });
  ekle.querySelector('button').addEventListener('click', () => {
    RC.send({ t: 'durum-izle', tur: tur.value, esik: Number(esik.value) });
  });

  function izleyicileriCiz() {
    const el = q('izleyiciler');
    if (!izleyiciler.length) { el.innerHTML = '<p class="dr-bos">Kurulu bildirim yok.</p>'; return; }
    el.replaceChildren(...izleyiciler.map((i) => {
      const e = document.createElement('div');
      e.className = 'dr-i';
      e.innerHTML = '<span></span><small></small><button type="button" title="Kaldır" aria-label="Kaldır">✕</button>';
      e.querySelector('span').textContent = `🔔 ${i.metin}`;
      e.querySelector('small').textContent = i.olusturan;
      const x = e.querySelector('button');
      x.hidden = !kontrol();
      x.addEventListener('click', () => RC.send({ t: 'durum-izle-sil', id: i.id }));
      return e;
    }));
  }

  RC.on('durum-izle-sonuc', (m) => { if (!m.ok) mesaj(m.msg || 'Bildirim kurulamadı.', 'err'); });
  RC.on('durum-izleyiciler', (m) => {
    izleyiciler = m.liste || [];
    izleyicileriCiz();
    if (son && panel.isOpen()) surecleriCiz(son.gruplar, son.sayilar);
  });

  function rolGuncelle() {
    ekle.hidden = !kontrol();
    q('ipucu').hidden = !kontrol();
    izleyicileriCiz();
    if (son) surecleriCiz(son.gruplar, son.sayilar);
  }

  // ---------- Sunucu mesajları ----------
  RC.on('durum-ilk', (m) => {
    kuru = !!m.kuru;
    gecmis = (m.gecmis || []).slice(-60);
    izleyiciler = m.izleyiciler || [];
    const h = q('hata');
    h.textContent = m.hata || '';
    son = m.son;
    rolGuncelle();
    if (son) ciz(son);
  });
  RC.on('durum', (m) => {
    if (!panel.isOpen()) return;
    son = m;
    gecmis.push({ cpu: m.cpu, ram: m.ramTop ? (100 * m.ramKul) / m.ramTop : null, gpu: m.gpu?.[0]?.kul ?? null, in: m.ag?.in ?? null, out: m.ag?.out ?? null });
    if (gecmis.length > 60) gecmis.shift();
    ciz(m);
  });
  // Yeniden bağlanınca abonelik sunucuda yeniden kurulmalı.
  RC.on('auth', () => { if (panel.isOpen()) { abone(true); rolGuncelle(); } });

  // ---------- Bildirim kartları ----------
  const SES_ANAHTAR = 'durum-ses';
  const sesKutu = q('ses');
  let sesAcik = false;
  try { sesAcik = localStorage.getItem(SES_ANAHTAR) === '1'; } catch { /* gizli pencere */ }
  sesKutu.checked = sesAcik;
  let ses = null;
  // iOS'ta WebAudio yalnızca bir dokunuştan sonra çalabilir: ilk dokunuşta bağlam açılır.
  function sesHazirla() {
    if (!sesAcik) return;
    try {
      ses = ses || new (window.AudioContext || window.webkitAudioContext)();
      if (ses.state === 'suspended') ses.resume();
    } catch { ses = null; }
  }
  document.addEventListener('pointerdown', sesHazirla, { capture: true, passive: true });
  function bip() {
    if (!sesAcik || !ses) return;
    try {
      const t = ses.currentTime;
      for (const [bas, f] of [[0, 880], [0.22, 1175]]) {
        const o = ses.createOscillator(), g = ses.createGain();
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t + bas);
        g.gain.exponentialRampToValueAtTime(0.25, t + bas + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + bas + 0.18);
        o.connect(g).connect(ses.destination);
        o.start(t + bas);
        o.stop(t + bas + 0.2);
      }
    } catch { /* ses yok */ }
  }
  sesKutu.addEventListener('change', () => {
    sesAcik = sesKutu.checked;
    try { localStorage.setItem(SES_ANAHTAR, sesAcik ? '1' : '0'); } catch { /* gizli pencere */ }
    sesHazirla();
    bip();
  });

  let kartlar = null;
  RC.on('durum-bildirim', (m) => {
    if (!kartlar) {
      kartlar = document.createElement('div');
      kartlar.id = 'durumBildirim';
      kartlar.setAttribute('role', 'status');
      kartlar.setAttribute('aria-live', 'polite');
      document.body.appendChild(kartlar);
    }
    const k = document.createElement('div');
    k.className = 'dr-kart';
    k.innerHTML = '<div><b></b><span></span><small></small></div><button type="button" title="Kapat" aria-label="Kapat">✕</button>';
    k.querySelector('b').textContent = `🔔 ${m.baslik}`;
    k.querySelector('span').textContent = m.metin;
    k.querySelector('small').textContent = `${saat(m.zaman)}${m.gecikmeli ? ' · siz bağlı değilken oldu' : ''}`;
    k.querySelector('button').addEventListener('click', () => k.remove());
    kartlar.prepend(k);
    while (kartlar.children.length > 4) kartlar.lastChild.remove();
    try { navigator.vibrate?.([180, 80, 180]); } catch { /* yok */ }
    bip();
  });
})();
