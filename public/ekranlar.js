// "Tüm ekranlar" görünümünün saf (DOM'suz) hesapları: bütün monitörler gerçek dizilimleriyle tek görüntüde.
// Tarayıcıda window.Ekranlar, Node'da require() ile kullanılır (server.js, lib/video.js, test/ozellik-tum-ekranlar.js).
// Koordinatlar fiziksel piksel (RemoteHelper "info": x, y, w, h). Birleşik görüntü = ekranların sınır kutusu; aradaki
// boşluklar siyah. Görüntüdeki bir nokta, içinde olduğu ekrana ve o ekrandaki normalize konuma çevrilir; sunucuya mevcut
// "move <ekran> nx ny" biçimi gider (mesajda s: ekran adı). Boşluğa düşen nokta en yakın ekrana sığdırılır.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Ekranlar = api;
})(typeof self !== 'undefined' ? self : this, () => {
  const TUM = '*';              // görüntülenen "ekran" adı: tüm ekranlar
  const EN_GENIS = 3840;        // birleşik görüntünün en fazla genişliği / yüksekliği (çıkış pikseli)
  const EN_YUKSEK = 2160;
  const TAM_COZUNURLUK = 2560;  // bu ve üstü maxWidth ("Yüksek" kalite): ölçekleme yok

  const birim = (v) => Math.min(1, Math.max(0, Number(v) || 0));

  // Ekranların sınır kutusu { x, y, w, h } (fiziksel piksel); ekran yoksa null.
  function birlesim(screens) {
    if (!screens || !screens.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of screens) {
      x0 = Math.min(x0, s.x); y0 = Math.min(y0, s.y);
      x1 = Math.max(x1, s.x + s.w); y1 = Math.max(y1, s.y + s.h);
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  // Nokta hiçbir ekranda değilse (ekranlar arası boşluk) en yakın ekranın içine çekilir.
  // features/kumanda.js'teki ekranaSigdir ile aynı kural (test bunu da karşılaştırır).
  function ekranaSigdir(screens, p) {
    let best = null;
    for (const s of screens) {
      const x = Math.min(s.x + s.w - 1, Math.max(s.x, p.x));
      const y = Math.min(s.y + s.h - 1, Math.max(s.y, p.y));
      const d = Math.hypot(x - p.x, y - p.y);
      if (!best || d < best.d) best = { s, x, y, d };
    }
    return best;
  }

  // Birleşik görüntüde normalize nokta (u, v: 0..1) -> { name, x, y, index } (x, y: o ekranın içinde 0..1).
  // Fiziksel piksel = kutu.x + u * (kutu.w - 1): RemoteHelper.MapPoint'in kuralı (nx * (w - 1) + x); tek ekranda nx = u.
  function noktaEkrana(screens, u, v) {
    const U = birlesim(screens);
    if (!U) return null;
    const p = { x: U.x + birim(u) * (U.w - 1), y: U.y + birim(v) * (U.h - 1) };
    const b = ekranaSigdir(screens, p);
    const s = b.s;
    return {
      name: s.name,
      x: s.w > 1 ? birim((b.x - s.x) / (s.w - 1)) : 0,
      y: s.h > 1 ? birim((b.y - s.y) / (s.h - 1)) : 0,
      index: screens.indexOf(s),
    };
  }

  // Tersi: ekrandaki normalize nokta -> birleşik görüntüde normalize nokta.
  function ekrandanBirlesige(screens, name, nx, ny) {
    const U = birlesim(screens);
    const s = screens && screens.find((x) => x.name === name);
    if (!U || !s) return null;
    return {
      x: U.w > 1 ? (s.x + birim(nx) * (s.w - 1) - U.x) / (U.w - 1) : 0,
      y: U.h > 1 ? (s.y + birim(ny) * (s.h - 1) - U.y) / (U.h - 1) : 0,
    };
  }

  // Ekranın birleşik görüntüdeki yeri, görüntü boyutuna oranla (0..1): etiketler için.
  function ekranKutusu(U, s) {
    return { x: (s.x - U.x) / U.w, y: (s.y - U.y) / U.h, w: s.w / U.w, h: s.h / U.h };
  }

  // Birleşik görüntünün ölçeği (çıkış pikseli / fiziksel piksel). maxWidth: istemcinin kalite ayarındaki genişlik
  // (Düşük 1280, Orta/Otomatik 1920, Yüksek 2560). Yüksek: tam çözünürlük. Değilse toplam piksel tek ekrandaki
  // maxWidth × (maxWidth · 9/16) eşdeğerine iner (1920 -> ~1920×1080 kadar piksel; bant ve telefonda çözme yükü tek ekran gibi).
  // Her durumda en fazla 3840 geniş, 2160 yüksek; en-boy oranı korunur. Büyütmez.
  function olcek(U, maxWidth) {
    const m = Number(maxWidth) || 1920;
    let k = Math.min(1, EN_GENIS / U.w, EN_YUKSEK / U.h);
    if (m < TAM_COZUNURLUK) k = Math.min(k, Math.sqrt((m * m * 9 / 16) / (U.w * U.h)));
    return k;
  }

  // JPEG yolu: her ekran ayrı yakalanır (RemoteHelper'ın ekran başına masaüstü çoğaltması), istemci birleşik görüntüye çizer.
  // Dönen: { W, H, list: [{ name, x, y, w, h }] } — çıkış pikseli; list[i].w aynı zamanda o ekranın yakalama genişliği.
  function parcalar(screens, maxWidth) {
    const U = birlesim(screens);
    if (!U) return null;
    const k = olcek(U, maxWidth);
    const r = (v) => Math.round(v * k);
    return {
      W: Math.max(2, r(U.w)), H: Math.max(2, r(U.h)),
      list: screens.map((s) => ({ name: s.name, x: r(s.x - U.x), y: r(s.y - U.y), w: Math.max(2, r(s.w)), h: Math.max(2, r(s.h)) })),
    };
  }

  // İkili tür 4'ün (birleşik JPEG) gövdesi, küçük-sonlu:
  //   [W u16][H u16][n u8] + n × [x u16][y u16][w u16][h u16][uzunluk u32] + n JPEG art arda
  const BAS = 5, PARCA = 12;
  function paketle(W, H, list, jpegs) {
    const n = list.length;
    let total = BAS + n * PARCA;
    for (const j of jpegs) total += j.length;
    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    dv.setUint16(0, W, true); dv.setUint16(2, H, true); dv.setUint8(4, n);
    let at = BAS + n * PARCA;
    list.forEach((p, i) => {
      const o = BAS + i * PARCA;
      dv.setUint16(o, p.x, true); dv.setUint16(o + 2, p.y, true); dv.setUint16(o + 4, p.w, true); dv.setUint16(o + 6, p.h, true);
      dv.setUint32(o + 8, jpegs[i].length, true);
      out.set(jpegs[i], at);
      at += jpegs[i].length;
    });
    return out;
  }

  // Tersi; bozuk pakette null. parts[i].data: gövdenin alt dizisi (kopyalanmaz).
  function coz(u8) {
    if (!u8 || u8.length < BAS) return null;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const W = dv.getUint16(0, true), H = dv.getUint16(2, true), n = dv.getUint8(4);
    let at = BAS + n * PARCA;
    if (u8.length < at) return null;
    const parts = [];
    for (let i = 0; i < n; i++) {
      const o = BAS + i * PARCA;
      const len = dv.getUint32(o + 8, true);
      if (at + len > u8.length) return null;
      parts.push({ x: dv.getUint16(o, true), y: dv.getUint16(o + 2, true), w: dv.getUint16(o + 4, true), h: dv.getUint16(o + 6, true), data: u8.subarray(at, at + len) });
      at += len;
    }
    return { W, H, parts };
  }

  // Ekranın kısa etiketi: sunucunun okunur adından ("Ekran 2 (1920×1080)" -> "2"), sanal ekranda "S", yoksa sıra numarası.
  function etiket(s, i) {
    const m = /Ekran (\d+)/.exec(s.title || '');
    if (m) return m[1];
    return s.virtual ? 'S' : String(i + 1);
  }

  // Dizilimin anahtarı: değişince (monitör takıldı/çıkarıldı, çözünürlük değişti) akış yeniden yapılandırılır.
  const duzenAnahtari = (screens) => (screens || []).map((s) => `${s.name}:${s.x},${s.y},${s.w}x${s.h}`).join('|');

  return { TUM, birlesim, ekranaSigdir, noktaEkrana, ekrandanBirlesige, ekranKutusu, olcek, parcalar, paketle, coz, etiket, duzenAnahtari };
});
