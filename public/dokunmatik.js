// Dokunmatik hareketlerin saf (DOM'suz) hesapları: touchpad ivmesi, sanal imleç, sıkıştırma/kaydırma ayrımı,
// yakınlaştırma ve kaydırma sınırları. Tarayıcıda window.Dokunmatik, Node'da require() ile kullanılır (test/ozellik-telefon.js).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Dokunmatik = api;
})(typeof self !== 'undefined' ? self : this, () => {
  const ZOOM_MIN = 1;
  const ZOOM_MAX = 4;
  const PINCH_THRESHOLD = 24;  // px: parmak arası mesafe bu kadar değişirse sıkıştırma
  const PAN_THRESHOLD = 12;    // px: orta nokta bu kadar kayarsa kaydırma
  const TAP_MOVE = 10;         // px: dokunuş sayılması için en fazla hareket
  const TAP_MS = 250;          // ms: dokunuş sayılması için en uzun süre

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // Touchpad ivmesi: yavaş hareket hassas (1x), hızlı hareket daha uzağa gider (en fazla 4x).
  // speed: px/ms (parmak hızı).
  function accelGain(speed) {
    if (!Number.isFinite(speed) || speed <= 0) return 1;
    return clamp(1 + (speed - 0.25) * 1.6, 1, 4);
  }

  // Parmak hareketini (px) sanal imleç konumuna (0..1) uygular.
  // pos: { x, y } normalize; dx, dy: px; dt: ms; contentW/H: görüntünün ekrandaki (yakınlaştırmasız) boyutu, px;
  // zoom: yakınlaştırılmışken imleç daha hassas hareket eder.
  function moveCursor(pos, dx, dy, dt, contentW, contentH, zoom = 1) {
    if (!contentW || !contentH) return { x: pos.x, y: pos.y };
    const speed = Math.hypot(dx, dy) / Math.max(1, dt);
    const g = accelGain(speed) / Math.max(1, zoom);
    return {
      x: clamp(pos.x + (dx * g) / contentW, 0, 1),
      y: clamp(pos.y + (dy * g) / contentH, 0, 1),
    };
  }

  // İki parmak hareketi sıkıştırma mı kaydırma mı? Karar verilemiyorsa null.
  // d0/d: başlangıç ve şimdiki parmak arası mesafe; m0/m: başlangıç ve şimdiki orta nokta.
  function classifyTwoFinger(d0, d, m0, m) {
    const spread = Math.abs(d - d0);
    const shift = Math.hypot(m.x - m0.x, m.y - m0.y);
    if (spread >= PINCH_THRESHOLD && spread >= shift * 0.6) return 'pinch';
    if (shift >= PAN_THRESHOLD) return 'pan';
    if (spread >= PINCH_THRESHOLD) return 'pinch';
    return null;
  }

  // Bir eksende kaydırma sınırı. size: öğe boyutu (sahne), off/len: öğe içindeki görüntü alanı (siyah kenarlar hariç).
  // Görüntü sahneden büyükse kenarları sahneden içeri giremez; küçükse ortalanır.
  function clampAxis(t, z, size, off, len) {
    const shown = len * z;
    if (shown <= size) return (size - shown) / 2 - off * z;
    return clamp(t, size - (off + len) * z, -off * z);
  }

  // Yakınlaştırma durumu: { z, tx, ty } — CSS: translate(tx, ty) scale(z), transform-origin 0 0.
  // box: { w, h, ox, oy, cw, ch } — sahne boyutu ve görüntünün sahne içindeki yeri/boyutu (z = 1 iken).
  function clampView(v, box) {
    const z = clamp(v.z, ZOOM_MIN, ZOOM_MAX);
    if (z <= ZOOM_MIN + 1e-3) return { z: 1, tx: 0, ty: 0 };
    return {
      z,
      tx: clampAxis(v.tx, z, box.w, box.ox, box.cw),
      ty: clampAxis(v.ty, z, box.h, box.oy, box.ch),
    };
  }

  // Sıkıştırma: başlangıçta orta noktanın altındaki içerik noktası parmakların ortasında kalır.
  // start: hareket başındaki görünüm; d0/d: mesafeler; m0/m: orta noktalar (sahneye göre px).
  function pinchView(start, d0, d, m0, m, box) {
    const z = clamp(start.z * (d0 > 0 ? d / d0 : 1), ZOOM_MIN, ZOOM_MAX);
    const px = (m0.x - start.tx) / start.z;
    const py = (m0.y - start.ty) / start.z;
    return clampView({ z, tx: m.x - px * z, ty: m.y - py * z }, box);
  }

  // Touchpad modunda görünüm imleci takip eder: imleç kenar payının dışına çıkarsa görünüm kayar.
  // cur: imlecin sahnedeki konumu (z = 1 iken, px).
  function followCursor(v, cur, box, margin = 0.15) {
    if (v.z <= 1) return v;
    const sx = cur.x * v.z + v.tx, sy = cur.y * v.z + v.ty;
    const mx = box.w * margin, my = box.h * margin;
    let { tx, ty } = v;
    if (sx < mx) tx += mx - sx; else if (sx > box.w - mx) tx -= sx - (box.w - mx);
    if (sy < my) ty += my - sy; else if (sy > box.h - my) ty -= sy - (box.h - my);
    return clampView({ z: v.z, tx, ty }, box);
  }

  // object-fit: contain ile çizilen görüntünün sahne içindeki yeri (z = 1 iken).
  function contentBox(w, h, nw, nh) {
    if (!nw || !nh || !w || !h) return { w, h, ox: 0, oy: 0, cw: w, ch: h };
    const s = Math.min(w / nw, h / nh);
    const cw = nw * s, ch = nh * s;
    return { w, h, ox: (w - cw) / 2, oy: (h - ch) / 2, cw, ch };
  }

  const isTap = (dist, ms) => dist <= TAP_MOVE && ms <= TAP_MS;

  return {
    ZOOM_MIN, ZOOM_MAX, PINCH_THRESHOLD, PAN_THRESHOLD, TAP_MOVE, TAP_MS,
    clamp, accelGain, moveCursor, classifyTwoFinger, clampView, pinchView, followCursor, contentBox, isTap,
  };
});
