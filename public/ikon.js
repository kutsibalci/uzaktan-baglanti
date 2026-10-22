// Arayüz simgeleri: emoji yerine tek çizgi kalınlığında SVG (24x24, currentColor). Bağımlılık yok, dışarıya bağlanmaz.
// Özellikler simgeyi emoji olarak verir (RC.ui.menuItem({ icon: '📁' }), ana menü düğmesi '📁 Dosya aktarımı');
// app.js bunları bu tabloyla SVG'ye çevirir. Tabloda olmayan emoji olduğu gibi kalır.
//   RCIkon.svg(ad)            -> '<svg …>'   (ad: 'folder' ya da emoji)
//   RCIkon.renk(ad)           -> '#hex'      (simge kutucuğunun rengi)
//   RCIkon.kutu(ad)           -> renkli kutucuk içinde simge ('<span class="ik" …>')
//   RCIkon.yerlestir(el, ad)  -> el'in içeriğini simgeyle değiştirir (bilinmiyorsa metin)
//   RCIkon.ayir(metin)        -> { ad, metin } baştaki emojiyi ayırır ('📁 Dosya' -> { ad: 'folder', metin: 'Dosya' })
(() => {
  const P = {
    monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    monitorPlus: '<rect x="2.5" y="4" width="14" height="11" rx="2"/><path d="M6.5 19h6M9.5 15v4M20.5 6.5v6M17.5 9.5h6"/>',
    pen: '<path d="M12 20h8"/><path d="M16.4 3.6a2 2 0 0 1 2.9 2.9L7.5 18.3 4 19.2l.9-3.5Z"/>',
    gamepad: '<rect x="2" y="7" width="20" height="11" rx="5.5"/><path d="M7.5 10.5v4M5.5 12.5h4"/><path d="M15.5 11.5h.01M18 14h.01" stroke-width="2.6"/>',
    folder: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.2h7.5A2.5 2.5 0 0 1 21 9.7v7.8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5Z"/>',
    power: '<path d="M12 3v8"/><path d="M6.6 6.5a7.6 7.6 0 1 0 10.8 0"/>',
    qr: '<rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1.2"/><rect x="14" y="3.5" width="6.5" height="6.5" rx="1.2"/><rect x="3.5" y="14" width="6.5" height="6.5" rx="1.2"/><path d="M14 14h3v3M20.5 14v.01M14 20.5h3M20.5 17.5v3" />',
    activity: '<path d="M3 12h3.5l2.5-7 5 14 2.5-7H21"/>',
    sliders: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
    gauge: '<path d="M4.2 18a9 9 0 1 1 15.6 0"/><path d="M12 14l4.2-4.2"/><circle cx="12" cy="14" r="1.3"/>',
    clipboard: '<rect x="5.5" y="4.5" width="13" height="16.5" rx="2"/><path d="M9 4.5V3.2h6v1.3"/><path d="M9 10.5h6M9 14.5h4"/>',
    volume: '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5Z"/><path d="M15.5 9a4.3 4.3 0 0 1 0 6M18.3 6.5a8 8 0 0 1 0 11"/>',
    volumeOff: '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5Z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>',
    eyeOff: '<path d="M3 3l18 18"/><path d="M10.6 5.1Q11.3 5 12 5c5 0 8.8 4.4 10 7a14 14 0 0 1-2.7 3.6M6.5 6.6C4.4 8 2.9 10.2 2 12c1.2 2.6 5 7 10 7a9.4 9.4 0 0 0 4.3-1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
    timer: '<circle cx="12" cy="13.5" r="7.5"/><path d="M12 10v3.5l2.3 1.7M9.5 2.5h5"/>',
    signal: '<path d="M5 20v-3.5M9.7 20v-7M14.3 20V9M19 20V4.5"/>',
    lock: '<rect x="4.5" y="10.5" width="15" height="10.5" rx="2.2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
    maximize: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    chevronUp: '<path d="M6 15l6-6 6 6"/>',
    chevronDown: '<path d="M6 9l6 6 6-6"/>',
    hand: '<path d="M9 12V5.5a1.5 1.5 0 0 1 3 0V11"/><path d="M12 10.5v-1a1.5 1.5 0 0 1 3 0V11"/><path d="M15 10.8a1.5 1.5 0 0 1 3 0v3.7a6.5 6.5 0 0 1-6.5 6.5h-.7a6 6 0 0 1-4.6-2.2l-2.6-3.3a1.6 1.6 0 0 1 2.4-2.1L9 15.3"/>',
    mouse: '<rect x="6" y="3" width="12" height="18" rx="6"/><path d="M12 7v3.5"/>',
    keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2.2"/><path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M7.5 14h9" stroke-width="2"/>',
    arrowLeft: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
    more: '<path d="M5.5 12h.01M12 12h.01M18.5 12h.01" stroke-width="3"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    logout: '<path d="M9.5 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3.5"/><path d="M15 16.5 19.5 12 15 7.5M19.5 12H9.5"/>',
    smartphone: '<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M11 18h2"/>',
    shield: '<path d="M12 3l7.5 2.8v5.7c0 4.6-3.2 8.2-7.5 9.5-4.3-1.3-7.5-4.9-7.5-9.5V5.8Z"/><path d="M9 12l2 2 4-4"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 14a6.5 6.5 0 0 1 3 6"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.7 5.6 3.7 9s-1.2 6.4-3.7 9c-2.5-2.6-3.7-5.6-3.7-9S9.5 5.6 12 3Z"/>',
    ticket: '<path d="M3 8a2 2 0 0 0 2-2h14a2 2 0 0 0 2 2v8a2 2 0 0 0-2 2H5a2 2 0 0 0-2-2Z"/><path d="M14 6v12" stroke-dasharray="2 2"/>',
    devices: '<rect x="2.5" y="4.5" width="13" height="10" rx="1.8"/><path d="M5.5 18.5h7"/><rect x="17" y="8.5" width="5" height="11" rx="1.4"/>',
    list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />',
    wifi: '<path d="M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M8.8 16a4.8 4.8 0 0 1 6.4 0M12 19.5h.01"/>',
    rocket: '<path d="M5 14.5c-1.5 1.2-2 4.5-2 4.5s3.3-.5 4.5-2"/><path d="M14.5 3.5C18 3 21 6 20.5 9.5L13 17l-6-6Z"/><path d="M7 11H3.5L6 8h4M13 17v3.5l3-2.5v-4"/><circle cx="15.5" cy="8.5" r="1.4"/>',
    alert: '<path d="M12 3.5 2.5 20h19Z"/><path d="M12 10v4.5M12 17.5h.01"/>',
    cursor: '<path d="M5 3.5l13 6.3-5.6 1.8-2.4 5.9Z"/>',
    playPause: '<path d="M4.5 5.5 13 12l-8.5 6.5Z"/><path d="M16.5 6v12M20 6v12"/>',
    skipBack: '<path d="M19 19 9.5 12 19 5Z"/><path d="M5.5 5v14"/>',
    skipForward: '<path d="M5 5l9.5 7L5 19Z"/><path d="M18.5 5v14"/>',
    volumeDown: '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5Z"/><path d="M16 9.5a3.6 3.6 0 0 1 0 5"/>',
    presentation: '<rect x="3" y="4" width="18" height="12" rx="1.8"/><path d="M12 16v4M8.5 20h7"/><path d="M10.5 8l4 2-4 2Z"/>',
    arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    play: '<path d="M7 4.5 19 12 7 19.5Z"/>',
    square: '<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
    command: '<path d="M9 9V6.5A2.5 2.5 0 1 0 6.5 9H17.5A2.5 2.5 0 1 0 15 6.5v11a2.5 2.5 0 1 0 2.5-2.5h-11A2.5 2.5 0 1 0 9 17.5Z"/>',
    rightClick: '<rect x="6" y="3" width="12" height="18" rx="6"/><path d="M12 3v7.5M6 10.5h12"/><path d="M12.6 3.7a5.4 5.4 0 0 1 4.7 5.4v.7h-4.7Z" fill="currentColor" stroke="none"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.4a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.7"/><path d="M12 17.2h.01" stroke-width="2.4"/>',
  };
  // Simge kutucuk renkleri (ana menü araçları, menü satırları).
  const RENK = {
    monitor: '#4f7cff', monitorPlus: '#8b5cf6', pen: '#ec4899', gamepad: '#10b981', folder: '#f59e0b', power: '#f43f5e',
    qr: '#06b6d4', activity: '#14b8a6', sliders: '#94a3b8', gauge: '#818cf8', clipboard: '#38bdf8', volume: '#fb923c',
    volumeOff: '#94a3b8', eyeOff: '#a78bfa', timer: '#a3e635', signal: '#22d3ee', lock: '#fbbf24', maximize: '#94a3b8',
    chevronUp: '#94a3b8', hand: '#f472b6', mouse: '#60a5fa', keyboard: '#94a3b8', smartphone: '#06b6d4', shield: '#34d399',
    users: '#60a5fa', globe: '#4f7cff', ticket: '#f59e0b', devices: '#a78bfa', list: '#94a3b8', wifi: '#22d3ee',
    rocket: '#f472b6', alert: '#fbbf24', command: '#94a3b8', rightClick: '#60a5fa', help: '#818cf8',
  };
  const EMOJI = {
    '🖥': 'monitor', '➕': 'monitorPlus', '🎨': 'pen', '🎮': 'gamepad', '📁': 'folder', '⏻': 'power', '📱': 'qr', '📲': 'smartphone',
    '📊': 'activity', '⚙': 'sliders', '🎚': 'gauge', '📋': 'clipboard', '🔊': 'volume', '🔇': 'volumeOff', '🕶': 'eyeOff',
    '⏱': 'timer', '📶': 'signal', '🔒': 'lock', '⛶': 'maximize', '▴': 'chevronUp', '▾': 'chevronDown', '✋': 'hand', '👆': 'hand', '🖱': 'mouse',
    '⌨': 'keyboard', '←': 'arrowLeft', '⋯': 'more', '✕': 'x', '❓': 'help', '⌘': 'command',
  };
  // Değişken seçicileri (U+FE0F) ve boşlukları at.
  const temiz = (s) => String(s || '').replace(/️/g, '').trim();
  const ad = (v) => { const t = temiz(v); return P[t] ? t : EMOJI[t] || null; };
  const svg = (v) => {
    const a = ad(v);
    return a ? `<svg class="svg-ik" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[a]}</svg>` : '';
  };
  const renk = (v) => RENK[ad(v)] || '#94a3b8';
  const kutu = (v) => (ad(v) ? `<span class="ik" style="--ik:${renk(v)}">${svg(v)}</span>` : '');
  function yerlestir(el, v) {
    const s = svg(v);
    if (s) { el.innerHTML = s; el.style.setProperty('--ik', renk(v)); el.classList.add('has-ik'); } else { el.textContent = v || ''; el.classList.remove('has-ik'); }
  }
  // '📁 Dosya aktarımı' -> { ad: '📁', metin: 'Dosya aktarımı' } (yalnızca tablodaki simgeler)
  function ayir(metin) {
    const t = String(metin || '').trim();
    for (const k of Object.keys(EMOJI)) {
      const m = t.replace(/️/g, '');
      if (m.startsWith(k)) return { ad: k, metin: m.slice(k.length).trim() };
    }
    return null;
  }
  window.RCIkon = { svg, renk, kutu, yerlestir, ayir, ad };
})();
