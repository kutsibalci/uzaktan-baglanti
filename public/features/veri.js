// Veri kullanımı sayacı: bu oturumda gelen + giden veri (görüntü, ses, dosya, diğer), anlık / ortalama hız ve
// "bu hızla saatte ~X" tahmini. ⏱ ölçüm panelinde bir bölüm + ⋯ menüsünde küçük "Veri · 12 MB" satırı.
// Kaynaklar: WebSocket baytları tarayıcıda sayılır (RC.traffic, çerçeve başlığı dahil); HTTP adresleri (dosya indirme/yükleme,
// pano resmi) sunucuda sayılır ve 'veri-http' ile gelir. Dahil değil: TLS/Tailscale ek yükü (~%5-10), sayfanın kendi dosyaları.
// Cihaz başına "bugün" ve "bu ay" toplamları localStorage'da tutulur (gizli sekmede tutulamaz; sayaç yine çalışır).
// Veri tasarrufu: kalite menüsündeki "Veri tasarrufu" seçiliyken sunucuya bildirilir (ses de düşük bit hızına geçer).
// Mobil veri: navigator.connection.type === 'cellular' ise (Android Chrome; iOS Safari'de bu API yok) bir kerelik öneri şeridi.
(() => {
  const RC = window.RC;
  if (!RC) return;

  const ANAHTAR = 'rc-veri';             // { gun, gunB, ay, ayB }
  const ONERI = 'rc-veri-oneri';         // mobil veri önerisine verilen cevap: 'evet' | 'hayir'
  const oku = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const yaz = (k, v) => { try { localStorage.setItem(k, v); } catch { /* gizli sekme */ } };

  const style = document.createElement('style');
  style.textContent = `
    .veri-bolum { font-size: 13px; font-variant-numeric: tabular-nums; }
    .veri-bolum h4 { margin: 10px 0 4px; font-size: 13px; border-top: 1px solid var(--line); padding-top: 8px; }
    .veri-bolum table { width: 100%; border-collapse: collapse; }
    .veri-bolum td { padding: 2px 0; } .veri-bolum td:last-child { text-align: right; }
    .veri-bolum .toplam td { border-top: 1px solid var(--line); padding-top: 4px; font-weight: 600; }
    .veri-bolum .btns { display: flex; gap: 6px; margin-top: 8px; }
    .veri-bolum .btns button { flex: 1; background: var(--panel2); border: 1px solid var(--line); border-radius: 8px; padding: 5px; font-size: 12px; }
    .veri-bolum .not { color: var(--muted); margin: 6px 0 0; font-size: 12px; }
    .veri-serit { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; background: rgba(245,158,11,.12); border: 1px solid var(--warn);
      border-radius: 12px; padding: 8px 10px; font-size: 13px; }
    .veri-serit span { flex: 1 1 180px; min-width: 0; }
    .veri-serit button { margin: 0; padding: 7px 10px; font-size: 13px; border-radius: 8px; }
    .veri-serit .ghost { background: transparent; color: var(--muted); }
  `;
  document.head.appendChild(style);

  // ---------- Sayaç ----------
  // http: bu bağlantının sunucudan gelen son HTTP toplamı (bağlantı kopunca sıfırdan başlar)
  const http = { indirilen: 0, yuklenen: 0, sonAlinan: 0, sonGonderilen: 0 };
  RC.on('veri-http', (m) => {
    const a = Number(m.alinan) || 0, g = Number(m.gonderilen) || 0;
    http.yuklenen += Math.max(0, a - http.sonAlinan);
    http.indirilen += Math.max(0, g - http.sonGonderilen);
    http.sonAlinan = a; http.sonGonderilen = g;
  });
  RC.on('disconnect', () => { http.sonAlinan = 0; http.sonGonderilen = 0; });

  // Sayfa açıldığından beri toplamlar, türe göre
  function simdi() {
    const t = RC.traffic();
    return { goruntu: t.goruntu, ses: t.ses, dosya: http.indirilen + http.yuklenen, diger: t.diger + t.giden,
      gelen: t.goruntu + t.ses + t.diger + http.indirilen, giden: t.giden + http.yuklenen };
  }
  const toplam = (x) => x.gelen + x.giden;
  // Hız ve saatlik tahmin için dosya aktarımları hariç (tek seferlik 100 MB'lık indirme tahmini şişirmesin)
  const akis = (x) => toplam(x) - x.dosya;
  const fark = (a, b) => Object.fromEntries(Object.keys(a).map((k) => [k, a[k] - b[k]]));

  let taban = simdi();               // oturum başı ("Oturumu sıfırla" ile yenilenir)
  let tabanZaman = Date.now();
  const ornekler = [];               // [{ t, b }] son 60 sn'nin akış toplamları (hız için, dosya hariç)
  let kaydedilen = toplam(taban);    // localStorage'a yazılmış en son toplam

  // ---------- Bugün / bu ay (cihaz başına) ----------
  const gunAnahtar = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  function depo() {
    let s = null;
    try { s = JSON.parse(oku(ANAHTAR) || 'null'); } catch { s = null; }
    const gun = gunAnahtar(), ay = gun.slice(0, 7);
    if (!s || typeof s !== 'object') s = {};
    if (s.gun !== gun) { s.gun = gun; s.gunB = 0; }
    if (s.ay !== ay) { s.ay = ay; s.ayB = 0; }
    s.gunB = Number(s.gunB) || 0; s.ayB = Number(s.ayB) || 0;
    return s;
  }
  // Son kayıttan beri eklenen bayt eklenir (aynı cihazda iki sekme açıksa ikisi de kendi payını ekler).
  function kaydet() {
    const t = toplam(simdi());
    const d = t - kaydedilen;
    if (d <= 0) return;
    const s = depo();
    s.gunB += d; s.ayB += d;
    yaz(ANAHTAR, JSON.stringify(s));
    kaydedilen = t;
  }
  addEventListener('pagehide', kaydet);
  document.addEventListener('visibilitychange', () => { if (document.hidden) kaydet(); });

  // ---------- Biçim ----------
  // Ondalık nokta: aynı paneldeki gecikme satırlarıyla (olcum.js, toFixed) tutarlı
  const sayi = (v, d) => v.toFixed(d);
  function boyut(b) {
    if (b < 1e3) return `${Math.round(b)} B`;
    if (b < 1e6) return `${sayi(b / 1e3, 0)} KB`;
    if (b < 1e9) return `${sayi(b / 1e6, b < 1e7 ? 1 : 0)} MB`;
    return `${sayi(b / 1e9, 2)} GB`;
  }
  const hiz = (bps) => (bps * 8 >= 1e6 ? `${sayi((bps * 8) / 1e6, 1)} Mbps` : `${Math.round((bps * 8) / 1e3)} kbps`);

  // Hızlar (bayt/sn): anlık = son 2 sn, dakika = son 60 sn, oturum = baştan beri
  function hizlar() {
    const t = Date.now(), b = akis(simdi()) - akis(taban);
    const once = (sn) => {
      const o = ornekler.find((x) => t - x.t <= sn * 1000 + 500) || null;
      return o && t - o.t >= 900 ? (b - o.b) / ((t - o.t) / 1000) : null;
    };
    const sure = (t - tabanZaman) / 1000;
    return { anlik: once(2), dakika: once(60), oturum: sure >= 1 ? b / sure : null, sure };
  }

  // ---------- Arayüz ----------
  const bolum = document.createElement('div');
  bolum.className = 'veri-bolum';
  bolum.id = 'veriBolum';
  bolum.innerHTML = `
    <h4>📶 Veri kullanımı (bu oturum)</h4>
    <table>
      <tr><td>Görüntü</td><td data-v="goruntu">–</td></tr>
      <tr><td>Ses</td><td data-v="ses">–</td></tr>
      <tr><td>Dosya (indirme + yükleme)</td><td data-v="dosya">–</td></tr>
      <tr><td>Diğer (girdi, komutlar)</td><td data-v="diger">–</td></tr>
      <tr class="toplam"><td>Toplam (gelen · giden)</td><td data-v="toplam">–</td></tr>
      <tr><td>Anlık hız</td><td data-v="anlik">–</td></tr>
      <tr><td>Ortalama (oturum)</td><td data-v="ort">–</td></tr>
      <tr><td>Bu hızla saatte</td><td data-v="saat">–</td></tr>
      <tr><td>Bu cihazda bugün · bu ay</td><td data-v="gunay">–</td></tr>
    </table>
    <p class="not">Bağlantı şifrelemesi (TLS/Tailscale, ~%5-10) ve sayfanın ilk yüklenmesi dahil değil; operatörün sayacı biraz fazla gösterir. Hız ve saatlik tahmine dosya aktarımları girmez.</p>
    <div class="btns"><button type="button" data-v="sifirla">Oturumu sıfırla</button><button type="button" data-v="sifirlaGun">Bugün/ay sıfırla</button></div>`;
  const alan = (k) => bolum.querySelector(`[data-v="${k}"]`);

  // ⏱ ölçüm panelinin içine; o özellik yoksa kendi paneli.
  const olcumIc = document.querySelector('#olcumPanel .rc-panel-ic');
  const kendi = olcumIc ? null : RC.ui.panel('Veri kullanımı', { id: 'veriPanel' });
  (olcumIc || kendi.body).appendChild(bolum);
  const bolumAcik = () => !!bolum.offsetParent;

  const menuSatiri = RC.ui.menuItem({
    id: 'veriMenu', icon: '📶', label: 'Veri', order: 61, hidden: true, ikincil: true, title: 'Bu oturumda kullanılan veri',
    onClick: () => {
      const olcumMenu = document.getElementById('olcumMenu');
      if (olcumMenu && olcumIc) olcumMenu.click(); else kendi.open();
      ciz();
      bolum.scrollIntoView({ block: 'nearest' });
    },
  });

  function ciz() {
    const x = fark(simdi(), taban);
    menuSatiri.set({ state: boyut(toplam(x)) });
    if (!bolumAcik()) return;
    for (const k of ['goruntu', 'ses', 'dosya', 'diger']) alan(k).textContent = boyut(x[k]);
    alan('toplam').textContent = `${boyut(toplam(x))} (${boyut(x.gelen)} · ${boyut(x.giden)})`;
    const h = hizlar();
    alan('anlik').textContent = h.anlik == null ? '–' : hiz(h.anlik);
    alan('ort').textContent = h.oturum == null ? '–' : hiz(h.oturum);
    // Saatlik tahmin son dakikanın ortalamasından (ilk dakikada o ana kadarki ortalama)
    const s = h.dakika ?? h.oturum;
    alan('saat').textContent = s == null ? '–' : `≈ ${boyut(s * 3600)}`;
    const d = depo(), bekleyen = toplam(simdi()) - kaydedilen;
    alan('gunay').textContent = `${boyut(d.gunB + bekleyen)} · ${boyut(d.ayB + bekleyen)}`;
  }

  bolum.addEventListener('click', (e) => {
    const k = e.target.closest('button[data-v]')?.dataset.v;
    if (k === 'sifirla') { kaydet(); taban = simdi(); tabanZaman = Date.now(); ornekler.length = 0; }
    if (k === 'sifirlaGun' && confirm('Bu cihazın bugün ve bu ay toplamları sıfırlansın mı?')) {
      kaydet();
      yaz(ANAHTAR, JSON.stringify({ gun: gunAnahtar(), gunB: 0, ay: gunAnahtar().slice(0, 7), ayB: 0 }));
    }
    ciz();
  });

  let sayac = 0;
  setInterval(() => {
    const t = Date.now();
    ornekler.push({ t, b: akis(simdi()) - akis(taban) });
    while (ornekler.length && t - ornekler[0].t > 61000) ornekler.shift();
    if (++sayac % 5 === 0) kaydet();
    ciz();
  }, 1000);

  RC.on('viewer:start', () => { menuSatiri.set({ hidden: false }); tasarrufBildir(); });
  RC.on('viewer:stop', () => menuSatiri.set({ hidden: true }));

  // ---------- Veri tasarrufu ----------
  const kalite = document.getElementById('quality');
  const tasarrufBildir = () => RC.send({ t: 'veri-tasarruf', acik: kalite?.value === 'tasarruf' });
  kalite?.addEventListener('change', () => { tasarrufBildir(); seritCiz(); });
  RC.on('auth', () => { if (kalite?.value === 'tasarruf') tasarrufBildir(); });

  // ---------- Mobil veri önerisi ----------
  const serit = document.createElement('div');
  serit.className = 'veri-serit';
  serit.id = 'veriSerit';
  serit.hidden = true;
  // ~250 MB/saat sınırı yalnızca H.264'te (500 kbps). JPEG'de bit hızı sınırı yok (kalite 35, 1280 px, 15 fps): hareketli ekranda
  // ölçüm ~2,6 GB/saat. Şifresiz adreste (HTTP) WebCodecs yok, görüntü JPEG olur.
  const h264Var = window.isSecureContext && 'VideoDecoder' in window;
  const tahmin = h264Var
    ? '(H.264 ile saatte en fazla ~250 MB)'
    : '(bu adreste görüntü JPEG: hareketli ekranda saatte 2 GB\'ı aşabilir; HTTPS adresinde ~250 MB)';
  serit.innerHTML = `<span>📶 Mobil veridesin — Veri tasarrufu açılsın mı? ${tahmin}</span>
    <button type="button" data-v="evet">Aç</button><button type="button" class="ghost" data-v="hayir">Hayır</button>`;
  const modlar = document.querySelector('#vHome .modes');
  if (modlar) modlar.before(serit); else RC.ui.home(serit);

  // iOS Safari / iOS Chrome'da navigator.connection yok: öneri hiç gösterilmez.
  const mobil = () => navigator.connection?.type === 'cellular';
  function seritCiz() {
    serit.hidden = !(mobil() && !oku(ONERI) && kalite && kalite.value !== 'tasarruf');
  }
  serit.addEventListener('click', (e) => {
    const k = e.target.closest('button[data-v]')?.dataset.v;
    if (!k) return;
    yaz(ONERI, k);
    if (k === 'evet' && kalite) {
      kalite.value = 'tasarruf';
      kalite.dispatchEvent(new Event('change')); // çekirdek seçimi saklar ve sunucuya bildirir
    }
    seritCiz();
  });
  navigator.connection?.addEventListener?.('change', seritCiz);
  seritCiz();

  // Test ve hata ayıklama için
  RC.veri = () => ({ oturum: fark(simdi(), taban), hiz: hizlar(), depo: depo() });
})();
