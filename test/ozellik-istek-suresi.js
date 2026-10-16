// Yavaş istek koruması (server.js REQUEST_TIMEOUT_MS) ile dosya yüklemesinin birlikte çalışması:
// oturumlu yavaş yükleme süreyi aşsa da tamamlanır; ama bir yükleme yapıldıktan SONRA bile oturumsuz yavaş istekler
// (gövdesini damla damla gönderen) süre dolunca kesilir. Yükleme klasörü test/calistir.js'in verdiği geçici klasördür.
// @ortam REMOTE_ISTEK_SURESI_MS=1500
const path = require('path');
const net = require('net');
const fs = require('fs');
const http = require('http');
const ROOT = path.join(__dirname, '..');
const WebSocket = require(path.join(ROOT, 'node_modules', 'ws'));
const PORT = Number(process.env.TEST_PORT || 3999);

let pass = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${name} ${extra}`);
  if (cond) pass++; else process.exitCode = 1;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function oturum() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.t === 'hello') ws.send(JSON.stringify({ t: 'setup', username: 'ahmet', password: 'gizli123', remember: false }));
      if (m.t === 'auth') (m.ok ? resolve({ ws, http: m.http }) : reject(new Error(m.error)));
    });
    ws.on('error', reject);
  });
}

// Gövdeyi parça parça, aralarda bekleyerek gönderen yükleme. Toplam süre ≈ parca * ara.
function yavasYukle(token, ad, parca, ara) {
  return new Promise((resolve) => {
    const veri = Buffer.alloc(parca * 10, 0x61);
    const req = http.request({
      host: '127.0.0.1', port: PORT, method: 'POST', path: `/api/dosya/yukle?ad=${encodeURIComponent(ad)}`,
      headers: { 'X-Oturum': token, 'Content-Length': veri.length },
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    (async () => {
      for (let i = 0; i < parca; i++) {
        if (req.destroyed) return;
        req.write(veri.subarray(i * 10, i * 10 + 10));
        await sleep(ara);
      }
      req.end();
    })();
  });
}

// Ham soketle yarım gövdeli POST: süre dolunca sunucu soketi kapatmalı.
function yarimGovde(yol, ms) {
  return new Promise((resolve) => {
    const s = net.connect(PORT, '127.0.0.1', () => {
      s.write(`POST ${yol} HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\nx`);
    });
    let kapandi = false;
    s.on('data', () => {});
    s.on('close', () => { kapandi = true; });
    s.on('error', () => {});
    setTimeout(() => { resolve(kapandi); s.destroy(); }, ms);
  });
}

(async () => {
  const { ws, http: T } = await oturum();
  check('oturum açıldı', !!T);

  const YUKLE = process.env.REMOTE_UPLOAD_DIR;
  const listele = () => { try { return fs.readdirSync(YUKLE); } catch { return []; } };
  const bekleyen = yavasYukle(T, 'yavas.txt', 12, 250); // ≈3 sn > 1,5 sn
  await sleep(1200);
  const yuklenirken = listele();
  check('yüklenirken son adla dosya yok, geçici adla yazılıyor',
    !yuklenirken.includes('yavas.txt') && yuklenirken.some((a) => a.endsWith('.uzaktan-yukleniyor')), JSON.stringify(yuklenirken));
  const r = await bekleyen;
  const sonra = listele();
  check('bitince yalnızca son ad kaldı', sonra.includes('yavas.txt') && !sonra.some((a) => a.endsWith('.uzaktan-yukleniyor')), JSON.stringify(sonra));
  check('oturumlu yavaş yükleme süre sınırına takılmadı', r.status === 200, `(${r.status} ${r.body || r.error || ''})`);

  // Yüklemeden sonra bile sunucu genelindeki koruma açık kalmalı.
  check('oturumsuz yarım gövdeli POST (yükleme ucu) süre dolunca kesildi', await yarimGovde('/api/dosya/yukle?ad=a.txt', 4000));
  check('yarım gövdeli POST (başka adres) süre dolunca kesildi', await yarimGovde('/baska', 4000));

  const r2 = await yavasYukle(T, 'yavas2.txt', 12, 250);
  check('ikinci yavaş yükleme de tamamlandı', r2.status === 200, `(${r2.status})`);

  ws.close();
  console.log(`\n${pass} kontrol geçti`);
  process.exit();
})().catch((e) => { console.error('TEST HATASI', e); process.exit(1); });
