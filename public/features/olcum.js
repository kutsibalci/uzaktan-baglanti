// Gecikme sayacı: araç çubuğunda küçük gidiş-dönüş süresi (RTT); ona ya da ⋯ menüsündeki satıra dokununca ayrıntılı panel.
// Her saniye sunucuya ping atılır (olcum-ping → olcum-pong). Görüntü ölçümleri çekirdekten (RC.stats()) gelir.
// Tahmini görüntü gecikmesi = yakalama (yalnızca JPEG'de ölçülür) + ağ (RTT/2) + çözme/çizim.
// Akıcılık: kare aralığı, titreşimi (standart sapma) ve takılma/sn (ortalamanın 2 katından uzun aralık; durağan ekran sayılmaz).
// Oturum boyunca örnekler biriktirilir; "Kopyala" ile özet metin alınır (deneme sonuçlarını paylaşmak için).
(() => {
  const RC = window.RC;
  if (!RC) return;

  const style = document.createElement('style');
  style.textContent = `
    #toolbar #olcumBtn { font-variant-numeric: tabular-nums; font-size: 12px; background: transparent; border-color: transparent;
      padding: 0 6px; min-width: 0; flex: 0 1 auto; overflow: hidden; color: var(--muted); }
    #toolbar #olcumBtn.iyi { color: var(--ok); } #toolbar #olcumBtn.orta { color: var(--warn); } #toolbar #olcumBtn.kotu { color: var(--error); }
    #olcumPanel .rc-panel-ic { font-size: 13px; display: block; }
    #olcumPanel table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
    #olcumPanel td { padding: 2px 0; } #olcumPanel td:last-child { text-align: right; }
    #olcumPanel .toplam td { border-top: 1px solid var(--line); padding-top: 6px; font-weight: 600; }
    #olcumPanel .btns { display: flex; gap: 6px; margin-top: 8px; }
    #olcumPanel .btns button { flex: 1; background: var(--panel2); border: 1px solid var(--line); border-radius: 8px; padding: 5px; }
    #olcumPanel .not { color: var(--muted); margin: 6px 0 0; font-size: 12px; }
  `;
  document.head.appendChild(style);

  const btn = document.createElement('button');
  btn.id = 'olcumBtn';
  btn.title = 'Gecikme (gidiş-dönüş). Ayrıntı için dokunun.';
  btn.textContent = '⏱ –';
  btn.hidden = true;
  RC.ui.toolbar(btn);

  // Ayrıntı paneli (ortak kabuk: ✕, Esc, dışarı dokununca kapanır) ve menü satırı
  const kabuk = RC.ui.panel('Gecikme ayrıntısı', { id: 'olcumPanel', anchor: btn });
  const panel = kabuk.el;
  const menuSatiri = RC.ui.menuItem({
    id: 'olcumMenu', icon: '⏱', label: 'Gecikme ayrıntısı', order: 60, hidden: true, ikincil: true,
    onClick: () => { kabuk.open(); ciz(); },
  });
  kabuk.body.innerHTML = `
    <table>
      <tr><td>Ağ gidiş-dönüş (RTT)</td><td data-k="rtt">–</td></tr>
      <tr><td>Yakalama + sıkıştırma</td><td data-k="cap">–</td></tr>
      <tr><td>Ağ (tek yön ≈ RTT/2)</td><td data-k="ag">–</td></tr>
      <tr><td>Çözme + çizim</td><td data-k="cozme">–</td></tr>
      <tr class="toplam"><td>Tahmini görüntü gecikmesi</td><td data-k="toplam">–</td></tr>
      <tr><td>Kare hızı</td><td data-k="fps">–</td></tr>
      <tr><td>Kare aralığı · titreşim</td><td data-k="aralik">–</td></tr>
      <tr><td>Takılma (en uzun aralık)</td><td data-k="takilma">–</td></tr>
      <tr><td>Kare onayı (JPEG ack)</td><td data-k="ack">–</td></tr>
      <tr><td>Kalite (JPEG)</td><td data-k="kalite">–</td></tr>
      <tr><td>Bant genişliği</td><td data-k="bant">–</td></tr>
      <tr><td>Bekleyen veri (sunucu)</td><td data-k="kuyruk">–</td></tr>
      <tr><td>Kodek · bağlantı</td><td data-k="kodek">–</td></tr>
    </table>
    <p class="not" data-k="not"></p>
    <div class="btns"><button data-a="kopyala">📋 Özeti kopyala</button><button data-a="sifirla">Sıfırla</button></div>`;
  const alan = (k) => panel.querySelector(`[data-k="${k}"]`);

  let zamanlayici = null;
  let son = { rtt: null, cap: null, kuyruk: 0, via: '', ack: null, kalite: null };
  let ornek = yeniOrnek();
  let baslangic = Date.now();

  function yeniOrnek() {
    return { rtt: [], cap: [], cozme: [], fps: [], kbps: [], toplam: [], aralik: [], titresim: [], enUzun: [], takilma: [], ack: [], kalite: {} };
  }
  const ekle = (dizi, v) => { if (typeof v === 'number' && isFinite(v)) { dizi.push(v); if (dizi.length > 3600) dizi.shift(); } };
  const BAGLANTI = { local: 'bu bilgisayar', lan: 'ev ağı', tailscale: 'Tailscale' };
  const ms = (v) => (v == null ? '–' : `${Math.round(v)} ms`);

  function ozet(dizi) {
    if (!dizi.length) return null;
    const s = [...dizi].sort((a, b) => a - b);
    const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    return { n: s.length, min: s[0], med: q(0.5), p95: q(0.95), max: s[s.length - 1], ort: s.reduce((a, b) => a + b, 0) / s.length };
  }

  const kaliteYazi = (k) => `${k.auto ? 'Otomatik: ' : ''}${k.quality} · ${k.maxWidth} px`;

  function tahmin(st) {
    if (son.rtt == null) return null;
    return (son.cap ?? 0) + son.rtt / 2 + (st.decodeMs ?? 0);
  }

  function ciz() {
    const st = RC.stats();
    btn.textContent = `⏱ ${son.rtt == null ? '–' : Math.round(son.rtt)} ms`;
    btn.className = son.rtt == null ? '' : son.rtt < 40 ? 'iyi' : son.rtt < 100 ? 'orta' : 'kotu';
    menuSatiri.set({ state: son.rtt == null ? '' : `${Math.round(son.rtt)} ms` });
    if (panel.hidden) return;
    const h264 = /H\.264/.test(st.codec);
    alan('rtt').textContent = ms(son.rtt);
    alan('cap').textContent = h264 ? 'ölçülmüyor' : ms(son.cap);
    alan('ag').textContent = ms(son.rtt == null ? null : son.rtt / 2);
    alan('cozme').textContent = st.decodeMs == null ? '–' : `${st.decodeMs.toFixed(1)} ms`;
    const t = tahmin(st);
    alan('toplam').textContent = t == null ? '–' : `${h264 ? '> ' : '≈ '}${Math.round(t)} ms`;
    alan('fps').textContent = `${st.fps} fps`;
    alan('aralik').textContent = st.intervalMs == null ? '–' : `${Math.round(st.intervalMs)} ms · ±${Math.round(st.jitterMs)} ms`;
    alan('takilma').textContent = st.intervalMs == null ? '–' : `${st.stutters} /sn (${Math.round(st.maxIntervalMs)} ms)`;
    alan('ack').textContent = h264 ? 'yok' : ms(son.ack);
    alan('kalite').textContent = h264 || !son.kalite ? '–' : kaliteYazi(son.kalite);
    alan('bant').textContent = st.kbps >= 1000 ? `${(st.kbps / 1000).toFixed(1)} Mbps` : `${st.kbps} kbps`;
    alan('kuyruk').textContent = `${son.kuyruk} KB`;
    alan('kodek').textContent = `${st.codec || '–'} · ${BAGLANTI[son.via] || '?'}`;
    alan('not').textContent = h264
      ? 'H.264\'te yakalama + kodlama süresi ölçülemiyor; gerçek gecikme tahminden biraz fazladır.'
      : 'Ekran yenileme (≈16 ms) tahmine dahil değildir.';
  }

  function tik() {
    if (!RC.state().connected) return;
    RC.send({ t: 'olcum-ping', c: performance.now() });
    const st = RC.stats();
    if (st.fps) { ekle(ornek.fps, st.fps); ekle(ornek.kbps, st.kbps); }
    ekle(ornek.cozme, st.decodeMs);
    if (st.intervalMs != null) {
      ekle(ornek.aralik, st.intervalMs);
      ekle(ornek.titresim, st.jitterMs);
      ekle(ornek.enUzun, st.maxIntervalMs);
      ekle(ornek.takilma, st.stutters);
    }
    ciz();
  }

  RC.on('olcum-pong', (m) => {
    const rtt = performance.now() - m.c;
    if (!(rtt >= 0 && rtt < 60000)) return;
    son = { rtt, cap: m.capMs, kuyruk: m.kuyrukKB || 0, via: m.via || '', ack: m.ackMs ?? null, kalite: m.kalite || null };
    ekle(ornek.rtt, rtt);
    ekle(ornek.cap, m.capMs);
    ekle(ornek.ack, m.ackMs);
    if (m.kalite && RC.stats().fps) { const k = kaliteYazi(m.kalite); ornek.kalite[k] = (ornek.kalite[k] || 0) + 1; }
    const st = RC.stats();
    if (st.fps) ekle(ornek.toplam, tahmin(st));
    ciz();
  });

  function baslat() {
    btn.hidden = false;
    menuSatiri.set({ hidden: false });
    if (!zamanlayici) zamanlayici = setInterval(tik, 1000);
    tik();
  }
  function durdur() {
    btn.hidden = true;
    menuSatiri.set({ hidden: true });
    kabuk.close();
    clearInterval(zamanlayici);
    zamanlayici = null;
  }
  RC.on('viewer:start', baslat);
  RC.on('viewer:stop', durdur);
  RC.on('disconnect', () => { son.rtt = null; ciz(); });

  btn.addEventListener('click', () => { kabuk.toggle(); ciz(); });

  function ozetMetni() {
    const st = RC.stats();
    const satir = (ad, o, birim = 'ms', ondalik = 0) => (o
      ? `${ad}: ort ${o.ort.toFixed(ondalik)} · orta ${o.med.toFixed(ondalik)} · %95 ${o.p95.toFixed(ondalik)} · min ${o.min.toFixed(ondalik)} · maks ${o.max.toFixed(ondalik)} ${birim} (${o.n} örnek)`
      : `${ad}: veri yok`);
    return [
      `Uzaktan Bağlantı ölçümü — ${new Date().toLocaleString('tr-TR')}`,
      `Süre: ${Math.round((Date.now() - baslangic) / 1000)} sn · Kodek: ${st.codec || '–'} · Bağlantı: ${BAGLANTI[son.via] || '?'}`,
      `Cihaz: ${navigator.userAgent}`,
      `Ekran: ${screen.width}x${screen.height} @${devicePixelRatio}x`,
      satir('RTT', ozet(ornek.rtt)),
      satir('Yakalama (JPEG)', ozet(ornek.cap)),
      satir('Çözme+çizim', ozet(ornek.cozme), 'ms', 1),
      satir('Tahmini toplam', ozet(ornek.toplam)),
      satir('Kare hızı', ozet(ornek.fps), 'fps'),
      satir('Kare aralığı', ozet(ornek.aralik)),
      satir('Titreşim', ozet(ornek.titresim), 'ms', 1),
      satir('En uzun aralık', ozet(ornek.enUzun)),
      satir('Takılma', ozet(ornek.takilma), '/sn', 2),
      satir('Kare onayı (ack)', ozet(ornek.ack)),
      `Kalite (JPEG): ${Object.entries(ornek.kalite).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} (${n} sn)`).join(', ') || 'veri yok'}`,
      satir('Bant', ozet(ornek.kbps), 'kbps'),
    ].join('\n');
  }

  async function kopyala(metin) {
    try { await navigator.clipboard.writeText(metin); return true; } catch { /* HTTP'de clipboard yok */ }
    const ta = document.createElement('textarea');
    ta.value = metin;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* desteklenmiyor */ }
    ta.remove();
    return ok;
  }

  panel.addEventListener('click', async (e) => {
    const a = e.target.closest('button[data-a]')?.dataset.a;
    if (a === 'sifirla') { ornek = yeniOrnek(); baslangic = Date.now(); ciz(); }
    if (a === 'kopyala') {
      const metin = ozetMetni();
      const b = e.target.closest('button');
      if (await kopyala(metin)) {
        b.textContent = '✔ Kopyalandı';
        setTimeout(() => { b.textContent = '📋 Özeti kopyala'; }, 2000);
      } else {
        // Kopyalama engellendiyse metni elle seçilebilir halde göster.
        let ta = panel.querySelector('textarea');
        if (!ta) { ta = document.createElement('textarea'); ta.rows = 8; ta.style.width = '100%'; ta.readOnly = true; kabuk.body.appendChild(ta); }
        ta.value = metin;
        ta.select();
      }
    }
  });

  // Test ve hata ayıklama için
  window.RC.olcumOzet = ozetMetni;
})();
