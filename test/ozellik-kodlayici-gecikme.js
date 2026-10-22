// @sunucu yok
// H.264 kodlayıcılar kareyi bekletmeden çıkarmalı (lib/video.js'teki gerçek ayarlarla). Kareler ffmpeg'e tek tek verilir:
// bir sonraki kare, öncekinin kodlanmış hali (AUD ile başlayan erişim birimi) çıkınca yazılır. Kodlayıcı birkaç kare
// biriktirip öyle çıkarıyorsa ilk kare hiç çıkmaz (ffmpeg'in h264_nvenc'i -delay verilmezse "yüzey sayısı - 1" = 3 kare
// bekletiyordu: 30 fps'te ~60-85 ms fazladan gecikme). Ekran yakalanmaz; kare içeriği üretilir.
const { spawn } = require('child_process');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const video = require(path.join(ROOT, 'lib', 'video'));

let pass = 0, fail = 0;
const check = (n, c, x = '') => { console.log(`${c ? 'OK  ' : 'FAIL'} ${n} ${x}`); c ? pass++ : fail++; };
const W = 640, H = 360, KARE = 6, BEKLE_MS = 3000;
// AMF: ffmpeg 6.1'in h264_amf'inde çıkış gecikmesi ayarı yok (ölçüm: ~110 ms); bu bilgisayarda NVIDIA önce seçilir.
const BEKLETMESIZ = new Set(['h264_nvenc', 'h264_qsv', 'libx264']);

function kilitAdim(enc) {
  return new Promise((resolve) => {
    const giris = enc.pix === 'bgra' ? 'bgra' : 'yuv420p';
    const boy = giris === 'bgra' ? W * H * 4 : (W * H * 3) / 2;
    const p = spawn(video.ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', giris, '-s', `${W}x${H}`, '-r', '30', '-i', '-',
      '-vf', `format=${enc.pix}`, '-c:v', enc.name, ...enc.args(4000), '-g', '60', '-bsf:v', 'h264_metadata=aud=insert', '-flush_packets', '1', '-f', 'h264', '-'],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let aud = 0, son = Buffer.alloc(0), yazilan = 0, bitti = false, hata = '';
    const sureler = [];
    let t = 0, zaman = null;
    const bitir = (sonuc) => { if (bitti) return; bitti = true; clearTimeout(zaman); p.stdin.destroy(); p.kill(); resolve({ ...sonuc, sureler, hata: hata.trim().split('\n').pop() }); };
    const yaz = () => {
      const kare = Buffer.alloc(boy, (yazilan * 40) & 0xff);
      yazilan++;
      t = performance.now();
      p.stdin.write(kare);
      clearTimeout(zaman);
      zaman = setTimeout(() => bitir({ ok: false, cikan: aud }), BEKLE_MS);
    };
    p.stdout.on('data', (d) => {
      const b = Buffer.concat([son, d]);
      for (let i = 0; i + 3 < b.length; i++) if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1 && (b[i + 3] & 0x1f) === 9) aud++;
      son = b.subarray(Math.max(0, b.length - 3));
      // yazılan kadar erişim birimi başladıysa son kare çıktı: sıradakini yaz
      if (aud >= yazilan && !bitti) {
        sureler.push(performance.now() - t);
        if (yazilan >= KARE) bitir({ ok: true, cikan: aud });
        else yaz();
      }
    });
    p.stderr.on('data', (d) => { hata += d; });
    p.on('exit', () => bitir({ ok: false, cikan: aud }));
    yaz();
  });
}

(async () => {
  if (!video.ffmpegPath()) { console.log('OK   ffmpeg yok, test atlandı'); process.exit(0); }
  const calisan = video.detectEncoders();
  const denenecek = calisan.filter((e) => BEKLETMESIZ.has(e.name));
  console.log(`     çalışan kodlayıcılar: ${calisan.map((e) => e.label).join(', ') || 'yok'}`);
  if (!denenecek.length) console.log('OK   bekletmesiz olması gereken kodlayıcı yok, test atlandı');
  for (const enc of denenecek) {
    const r = await kilitAdim(enc);
    const ort = r.sureler.length ? r.sureler.reduce((a, b) => a + b, 0) / r.sureler.length : 0;
    check(`${enc.label} (${enc.name}): her kare, sonraki kare verilmeden çıkıyor (${KARE} kare)`, r.ok,
      r.ok ? `ortalama ${ort.toFixed(0)} ms` : `${r.cikan} / ${KARE} kare çıktı, sonra ${BEKLE_MS} ms bekledi ${r.hata || ''}`);
  }
  console.log(`\n${pass} kontrol geçti, ${fail} hata`);
  process.exit(fail ? 1 : 0);
})();
