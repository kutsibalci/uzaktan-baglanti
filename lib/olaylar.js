// Özellikler arası küçük olay veriyolu (aynı süreç içinde). Bir özellik olay yayar, başka bir özellik dinler;
// böylece özellikler birbirini doğrudan require etmez.
//   'dosya-geldi'  { ad, yer, klasor, boyut, kullanici, via }  — features/dosya.js yayar, features/tepsi.js tepsiye iletir
const { EventEmitter } = require('events');

module.exports = new EventEmitter();
