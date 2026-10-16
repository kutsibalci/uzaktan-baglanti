const path = require('path');
const ROOT = path.join(__dirname, '..');
const WebSocket = require(path.join(ROOT, 'node_modules', 'ws'));
const fs = require('fs');
const { spawnSync } = require('child_process');
const ffmpeg = require(path.join(ROOT, 'node_modules', 'ffmpeg-static'));
const outFile = path.join(require('os').tmpdir(), 'rc-test-out.h264');
let fails = 0;
const check = (n, c, x = '') => { console.log(`${c ? 'OK  ' : 'FAIL'} ${n} ${x}`); if (!c) fails++; };

function login(codecs, onReady) {
  const ws = new WebSocket('ws://localhost:3999');
  ws.on('message', (d, bin) => {
    if (bin) return onReady.frame?.(d);
    const m = JSON.parse(d.toString());
    if (m.t === 'hello') ws.send(JSON.stringify(m.canSetup
      ? { t: 'setup', username: 'test', password: 'test1234' }
      : { t: 'login', username: 'test', password: 'test1234' }));
    else if (m.t === 'auth' && m.ok) ws.send(JSON.stringify({ t: 'start', mode: 'control', codecs }));
    else if (m.t === 'started') { onReady.started?.(m); ws.send(JSON.stringify({ t: 'settings', quality: 60, maxWidth: 1920, fps: 30, kbps: 4000 })); }
    else if (m.t === 'vconfig') onReady.vconfig?.(m);
    else if (m.t === 'codec' || m.t === 'error') console.log('mesaj:', m);
  });
  return ws;
}

const chunks = [];
let vconfig = null, firstKey = null, started = null, t0 = 0, bytes = 0;
const ws = login(['h264', 'jpeg'], {
  started: (m) => { started = m; },
  vconfig: (m) => { vconfig = m; t0 = Date.now(); },
  frame: (d) => {
    if (firstKey === null) firstKey = d[0] === 2 && d[1] === 1;
    if (d[0] === 2) { chunks.push(d.subarray(2)); bytes += d.length; }
  },
});

setTimeout(() => {
  ws.close();
  const secs = (Date.now() - t0) / 1000;
  check('sunucu H.264 seçti', started?.codec === 'h264', `kodlayıcı=${started?.encoder}`);
  check('vconfig geldi', !!vconfig, JSON.stringify(vconfig));
  check('ilk kare anahtar kare', firstKey === true);
  check('kareler geliyor', chunks.length > 50, `${chunks.length} kare, ${(chunks.length / secs).toFixed(1)} fps, ${((bytes * 8) / secs / 1000).toFixed(0)} kbps`);
  fs.writeFileSync(outFile, Buffer.concat(chunks));
  const r = spawnSync(ffmpeg, ['-hide_banner', '-v', 'error', '-i', outFile, '-f', 'null', '-'], { encoding: 'utf8' });
  const p = spawnSync(ffmpeg, ['-hide_banner', '-i', outFile, '-f', 'null', '-'], { encoding: 'utf8' });
  const frames = (p.stderr.match(/frame=\s*(\d+)/g) || []).pop();
  check('ffmpeg akışı hatasız çözdü', r.status === 0 && !r.stderr.trim(), (r.stderr.trim().split('\n')[0] || '') + ` ${frames}`);
  check('her mesaj tam bir kare (kare sayısı eşit)', frames && Number(frames.match(/\d+/)[0]) === chunks.length, `${frames} / ${chunks.length}`);

  // JPEG istemcisi
  let jpeg = 0;
  const ws2 = login(['jpeg'], { frame: (d) => { if (d[0] === 1 && d[1] === 0xff && d[2] === 0xd8) jpeg++; ws2.send('{"t":"ack"}'); } });
  setTimeout(() => {
    check('WebCodecs olmayan istemci JPEG alıyor', jpeg > 3, `${jpeg} kare`);
    ws2.close();
    console.log(fails ? `${fails} HATA` : 'hepsi geçti');
    process.exit(fails ? 1 : 0);
  }, 3000);
}, 5000);
