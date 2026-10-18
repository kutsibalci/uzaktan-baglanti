// Tarayıcıdaki yakalanmamış hataları sunucu günlüğüne yazar (yalnızca bu bilgisayardaki sunucuya gider).
// Telefonda geliştirici konsolu olmadığı için (iPhone Safari) hataları görmenin tek yolu bu.
// Diğer betiklerden ÖNCE yüklenir; böylece sayfa açılırken çıkan hatalar da yakalanır.
(() => {
  let gonderilen = 0;
  const son = new Set();
  function bildir(tur, mesaj, yer, yigin) {
    const metin = `${tur}: ${mesaj}`.slice(0, 500);
    if (gonderilen >= 20 || son.has(metin)) return; // sayfa başına en fazla 20, aynı hata bir kez
    son.add(metin);
    gonderilen++;
    try {
      fetch('/api/hata', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mesaj: metin, yer: String(yer || '').slice(0, 300), yigin: String(yigin || '').slice(0, 1500), sayfa: location.pathname }),
        keepalive: true,
      }).catch(() => {});
    } catch { /* fetch yoksa vazgeç */ }
  }
  window.addEventListener('error', (e) => {
    bildir('Hata', e.message || (e.target && e.target.src ? `yüklenemedi: ${e.target.src}` : 'bilinmeyen'),
      e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : '', e.error && e.error.stack);
  }, true);
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    bildir('Yakalanmamış söz', (r && r.message) || String(r), '', r && r.stack);
  });
})();
