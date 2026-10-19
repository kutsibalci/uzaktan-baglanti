// Başlatma ve Windows engelleri (features/baslatma.js):
//   - yöneticiye ana menüde küçük uyarı: Windows (Akıllı Uygulama Denetimi) bir yardımcı programı engellediyse
//   - bu bilgisayardaki yöneticiye yeni cihaz onay isteği (onay penceresi açılamazsa da cevaplanabilsin)
//   - yönetim panelinde: "Windows açılınca başlat" (Tepsi / Arka plan, tepsisiz), engeller ve ne yapılabileceği, son bildirimler
(() => {
  const RC = window.RC;
  if (!RC) return;
  const esc = RC.esc;

  const stil = document.createElement('style');
  stil.textContent = `
    .bsl-uyari { display: flex; align-items: flex-start; gap: 8px; background: rgba(251,191,36,.12); border: 1px solid var(--warn);
      border-radius: 12px; padding: 8px 10px; font-size: 13px; text-align: left; }
    .bsl-uyari span { flex: 1 1 auto; min-width: 0; }
    .bsl-uyari button { margin: 0; padding: 7px 10px; font-size: 13px; border-radius: 8px; white-space: nowrap; }
    #onayKutusu { position: fixed; left: 12px; right: 12px; top: calc(env(safe-area-inset-top, 0px) + 12px); z-index: 1000; max-width: 520px;
      margin: 0 auto; background: var(--panel); border: 2px solid var(--warn); border-radius: 14px; padding: 12px 14px;
      box-shadow: 0 10px 30px rgba(0,0,0,.5); display: grid; gap: 10px; }
    #onayKutusu h3 { margin: 0; font-size: 16px; }
    #onayKutusu p { margin: 0; white-space: pre-line; font-size: 14px; }
    #onayKutusu .row button { flex: 1; min-height: 46px; }
    .bsl-yonetim { display: grid; gap: 12px; }
    .bsl-yonetim h3 { margin: 4px 0 0; font-size: 15px; }
    .bsl-yonetim p { margin: 0; }
    .bsl-engel { border: 1px solid var(--warn); border-radius: 10px; padding: 8px 10px; display: grid; gap: 6px; }
    .bsl-engel b { color: var(--warn); }
    .bsl-yonetim ul, .bsl-yonetim ol { margin: 0; padding-left: 20px; display: grid; gap: 4px; font-size: 13px; }
    .bsl-yonetim .mono { letter-spacing: 0; word-break: break-all; }
    .bsl-satir { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .bsl-satir select { max-width: 100%; }
  `;
  document.head.appendChild(stil);

  const admin = () => RC.state().me?.role === 'admin';

  // ---------- Ana menü uyarısı ----------
  const uyari = document.createElement('div');
  uyari.className = 'bsl-uyari';
  uyari.id = 'baslatmaUyari';
  uyari.hidden = true;
  RC.ui.home(uyari);
  let engeller = [];
  function uyariCiz() {
    uyari.hidden = !admin() || !engeller.length;
    if (uyari.hidden) return;
    const adlar = engeller.map((k) => `${esc(k.dosya)} (${esc(k.ozellik)})`).join(', ');
    const sac = engeller.some((k) => k.politika && k.sac === 'acik');
    uyari.innerHTML = `<span>⚠ ${sac ? 'Windows Akıllı Uygulama Denetimi' : 'Windows'} ${engeller.length > 1 ? 'yardımcı programları' : 'bir yardımcı programı'} engelledi: ${adlar}.</span>
      <button type="button" class="ghost" data-k="ayrinti">Ayrıntı</button>`;
  }
  uyari.addEventListener('click', (e) => {
    if (e.target.closest('[data-k="ayrinti"]')) document.getElementById('adminBtn')?.click();
  });

  // ---------- Onay isteği (yalnızca bu bilgisayardaki yöneticiye gelir) ----------
  const onaylar = new Map(); // id -> istek
  const kutu = document.createElement('div');
  kutu.id = 'onayKutusu';
  kutu.hidden = true;
  kutu.setAttribute('role', 'alertdialog');
  document.body.appendChild(kutu);
  let sayac = null;
  function kutuCiz() {
    const o = [...onaylar.values()][0];
    kutu.hidden = !o;
    clearInterval(sayac);
    if (!o) return;
    const kalan = () => Math.max(0, Math.round((o.bitis - Date.now()) / 1000));
    kutu.innerHTML = `<h3>🔔 ${esc(o.baslik)}</h3><p>${esc(o.mesaj)}</p>
      <p class="muted small">${o.pencere ? 'Bilgisayarda açılan pencereden de cevaplayabilirsiniz.' : 'Onay penceresi açılamadı; buradan cevaplayın.'}
        <span data-k="kalan">${kalan()}</span> sn içinde cevap verilmezse reddedilir.</p>
      <div class="row gap"><button type="button" class="danger" data-k="red">Reddet</button><button type="button" data-k="izin">İzin ver</button></div>`;
    sayac = setInterval(() => {
      const el = kutu.querySelector('[data-k="kalan"]');
      if (el) el.textContent = kalan();
      if (kalan() <= 0) { onaylar.delete(o.id); kutuCiz(); }
    }, 1000);
  }
  kutu.addEventListener('click', (e) => {
    const k = e.target.closest('button[data-k]')?.dataset.k;
    const o = [...onaylar.values()][0];
    if (!k || !o) return;
    RC.send({ t: 'onay-cevap', id: o.id, onay: k === 'izin' });
    onaylar.delete(o.id);
    kutuCiz();
  });
  RC.on('onay-istegi', (m) => { onaylar.set(m.id, m); kutuCiz(); });
  RC.on('onay-bitti', (m) => { onaylar.delete(m.id); kutuCiz(); });

  // ---------- Yönetim paneli ----------
  const yonetim = document.createElement('div');
  yonetim.className = 'bsl-yonetim';
  const ic = document.createElement('div');
  ic.className = 'bsl-yonetim';
  const msg = document.createElement('p');
  msg.className = 'msg';
  yonetim.append(ic, msg);
  RC.ui.adminSection('Başlatma ve Windows engelleri', yonetim);

  const BASLATICI = { tepsi: 'tepsi simgesi (Tepsi.exe)', 'arka-plan': 'arka plan, tepsisiz (arka-plan-baslat.bat)', konsol: 'konsol penceresi (baslat.bat)' };
  const SAC = { acik: 'açık', deneme: 'değerlendirme modunda', kapali: 'kapalı' };
  let son = null;

  function secenekler(k) {
    const kok = k.ad === 'RemoteHelper';
    return `<ol>
      <li>${kok ? 'Uzaktan görüntü ve kontrol bu dosya olmadan çalışmaz; yönetim paneli ve yeni cihaz onayı (bu bilgisayardaki tarayıcıdan) çalışır.' : 'Bu özellik olmadan devam edebilirsiniz; diğer özellikler çalışır.'}</li>
      <li>Engel her zaman kalıcı olmayabilir (Windows dosyanın itibarını çevrim içi denetler): sunucuyu yeniden başlatınca bir kez daha denenir.
        Engellenen dosya bu çalışma boyunca tekrar başlatılmaz.</li>
      <li>Akıllı Uygulama Denetimi'ni kapatmak (Windows Güvenliği → Uygulama ve tarayıcı denetimi → Akıllı Uygulama Denetimi) <b>sizin kararınızdır</b>:
        bilgisayarın korumasını azaltır ve kapatıldıktan sonra genellikle Windows sıfırlanmadan yeniden açılamaz.</li>
      <li>Kalıcı çözüm, yardımcı programları bir kod imzalama sertifikasıyla imzalamaktır (ücretli; ileride).</li>
      ${k.ad === 'Tepsi' ? '<li>Tepsi yerine: <b>arka-plan-baslat.bat</b> (tepsi simgesi yok, yalnızca Windows\'un kendi powershell.exe\'si).</li>' : ''}
    </ol>`;
  }

  function engelHtml(d) {
    if (!d.engeller.length) return '<p class="small"><span class="dot on"></span>Bu çalışmada engellenen yardımcı program yok.</p>';
    return d.engeller.map((k) => `<div class="bsl-engel">
      <div><b>⚠ ${esc(k.mesaj)}</b></div>
      <div class="small muted">Hata: ${esc(k.kod)} · ${RC.fmtTime(k.zaman)} · <span class="mono">${esc(k.yol)}</span></div>
      ${k.kanit ? `<div class="small">Kanıt: Code Integrity günlüğü olay ${k.kanit.olay}, ${RC.fmtTime(k.kanit.zaman)} — ${esc(k.kanit.surec)} → ${esc(k.kanit.dosya)} engellendi.</div>` : ''}
      ${k.politika ? secenekler(k) : '<p class="small">Dosya eksik ya da bozuksa helper klasöründeki exe\'yi silip sunucuyu yeniden başlatın (kaynaktan yeniden derlenir).</p>'}
    </div>`).join('');
  }

  function ciHtml(d) {
    if (!d.ci) return '<p class="small muted">Windows günlüğü henüz okunmadı. <button type="button" class="small ghost" data-k="yenile">Günlüğü oku</button></p>';
    if (d.ci.hata) return `<p class="small muted">Windows günlüğü okunamadı (${esc(d.ci.hata)}).</p>`;
    const l = d.ci.list.slice(0, 8);
    return `<p class="small">Son 7 günde Windows'un engellediği bu klasördeki dosyalar (Code Integrity 3077/3033): ${l.length ? '' : '<b>yok</b>.'}
      <button type="button" class="small ghost" data-k="yenile">Yenile</button></p>
      ${l.length ? `<ul>${l.map((e) => `<li>${RC.fmtTime(e.zaman)} — <b>${esc(e.dosya)}</b> (${e.olay === 3077 ? 'engellendi' : 'imza düzeyi yetersiz'}, başlatan ${esc(e.surec)})</li>`).join('')}</ul>` : ''}`;
  }

  function otomatikHtml(o) {
    const yontem = o.yontem === 'tepsi' ? 'tepsi' : 'arka-plan';
    const tepsiNot = !o.tepsiExe.var ? ' — Tepsi.exe yok'
      : o.tepsiExe.engel ? ' — Windows engellemiş, önerilmez'
        : o.tepsiExe.eski ? ' — eski derleme' : '';
    let durum;
    if (!o.acik) durum = 'Kapalı.';
    else if (o.yontem === 'baska') durum = `Açık ama başka bir komut kayıtlı: <span class="mono">${esc(o.deger)}</span>`;
    else durum = `Açık: ${o.yontem === 'tepsi' ? 'Tepsi' : 'arka plan (tepsisiz)'}${o.buKopya ? '' : ' — <span class="warn">başka bir klasördeki kopyayı başlatıyor</span>'}.`;
    return `<div class="bsl-satir">
        <label class="row gap"><input type="checkbox" id="bslOtomatik" ${o.acik ? 'checked' : ''}> Windows açılınca başlat</label>
        <select id="bslYontem" aria-label="Başlatma yöntemi">
          <option value="arka-plan" ${yontem === 'arka-plan' ? 'selected' : ''}>Arka plan (tepsisiz)</option>
          <option value="tepsi" ${yontem === 'tepsi' ? 'selected' : ''} ${o.tepsiOlur && o.tepsiExe.var ? '' : 'disabled'}>Tepsi${esc(tepsiNot)}</option>
        </select>
      </div>
      <p class="small">${durum}${o.kuru ? ' <span class="warn">(test: kayıt defterine yazılmıyor)</span>' : ''}${o.hata ? ` <span class="warn">${esc(o.hata)}</span>` : ''}</p>
      ${o.tepsiKisayolu ? `<p class="small warn">Tepsi'nin kendi "Windows açılınca başlat" kısayolu da açık (Başlangıç klasörü).${o.acik ? ' İkisi birden açılırsa ikincisi aynı portu bulur ve yeni kopya açmaz; birini kapatmanız önerilir (tepsi menüsünden).' : ''}</p>` : ''}
      <p class="muted small">Oturum açılınca kayıt defterindeki kullanıcı başlangıç listesi (HKCU\\…\\Run) çalıştırılır; yönetici izni gerekmez.
        <b>Arka plan (tepsisiz)</b>: yalnızca Windows'un imzalı powershell.exe'si kullanılır (Akıllı Uygulama Denetimi'ne takılmaz), konsol penceresi
        ve tepsi simgesi yoktur; sunucu çökerse yeniden başlatılır, günlük <span class="mono">data\\sunucu.log</span>. Durdurmak için
        <b>arka-plan-durdur.bat</b>. Bağlantı bildirimleri tepsi yokken Windows bildirimi olarak gelir.</p>`;
  }

  function ciz(d) {
    son = d;
    ic.innerHTML = `
      <p class="small">Bu sunucu: <b>${esc(BASLATICI[d.baslatici] || d.baslatici)}</b> ile çalışıyor.
        Akıllı Uygulama Denetimi: <b>${esc(SAC[d.sac] || 'bilinmiyor')}</b>.</p>
      <h3>Windows açılınca başlat</h3>
      ${otomatikHtml(d.otomatik)}
      <h3>Engellenen yardımcı programlar</h3>
      ${engelHtml(d)}
      ${ciHtml(d)}
      ${d.bildirimler.length ? `<h3>Son Windows bildirimleri${d.bildirimKuru ? ' (test: gösterilmedi)' : ''}</h3>
        <ul>${d.bildirimler.slice(0, 5).map((b) => `<li>${RC.fmtTime(b.zaman)} — ${esc(b.baslik)}: ${esc(b.metin)}${b.hata ? ` <span class="warn">(gösterilemedi: ${esc(b.hata)})</span>` : ''}</li>`).join('')}</ul>` : ''}`;
    engeller = d.engeller;
    uyariCiz();
    for (const o of d.onaylar || []) onaylar.set(o.id, o);
    kutuCiz();
  }

  ic.addEventListener('change', (e) => {
    if (e.target.id !== 'bslOtomatik' && e.target.id !== 'bslYontem') return;
    const acik = ic.querySelector('#bslOtomatik').checked;
    if (e.target.id === 'bslYontem' && !acik) return; // kapalıyken yöntem yalnızca seçilir
    msg.className = 'msg';
    msg.textContent = 'Kaydediliyor…';
    RC.send({ t: 'baslatma-otomatik', acik, yontem: ic.querySelector('#bslYontem').value });
  });
  ic.addEventListener('click', (e) => {
    if (!e.target.closest('[data-k="yenile"]')) return;
    msg.className = 'msg';
    msg.textContent = 'Windows günlüğü okunuyor…';
    RC.send({ t: 'baslatma-yenile' });
  });

  RC.on('admin', (m) => { if (m.features?.baslatma) ciz(m.features.baslatma); });
  RC.on('baslatma-durum', (m) => { ciz(m); if (msg.textContent === 'Windows günlüğü okunuyor…') msg.textContent = ''; });
  RC.on('baslatma-sonuc', (m) => { msg.className = `msg ${m.error ? 'err' : 'ok'}`; msg.textContent = m.error || m.ok; });
  RC.on('baslatma-engel', (m) => { engeller = m.engeller || []; uyariCiz(); });
  RC.on('auth', () => { engeller = []; onaylar.clear(); uyariCiz(); kutuCiz(); });
})();
