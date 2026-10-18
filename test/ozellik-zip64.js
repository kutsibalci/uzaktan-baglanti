// @ortam REMOTE_ZIP64_ESIK=1000
// ZIP64 kayıtlarının küçük dosyalarla zorlanması: sunucu REMOTE_ZIP64_ESIK=1000 ile başlar, 1000 bayt ve üstü boyut/konum
// ZIP64 olarak yazılır (yerel başlıkta ZIP64 ek alanı + 8 baytlık data descriptor, merkez dizinde 0xFFFFFFFF + ek alan,
// ZIP64 EOCD + bulucu). Böylece gerçek > 4 GB dosya yazmadan Windows'un açıcıları (.NET: Expand-Archive ve
// System.IO.Compression) ve tar.exe (libarchive) ile ZIP64 yolu doğrulanır. Gerçek > 4 GB: ozellik-zip.js (seyrek dosya).
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const WebSocket = require(path.join(ROOT, 'node_modules', 'ws'));
const { zipOku } = require('./zip-okuyucu');
const PORT = process.env.TEST_PORT || 3999;
const TMP = process.env.TEST_TMP;
const KOK = process.env.REMOTE_BROWSE_ROOT;
if (!TMP || !KOK || !KOK.startsWith(TMP) || process.env.REMOTE_ZIP64_ESIK !== '1000') {
  console.log('FAIL bu test test/calistir.js ile çalıştırılmalı (TEST_TMP, REMOTE_BROWSE_ROOT, REMOTE_ZIP64_ESIK=1000)');
  process.exit(1);
}
const SYS = process.env.SystemRoot || 'C:\\Windows';
const POWERSHELL = path.join(SYS, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

let pass = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${name} ${extra}`);
  if (cond) pass++; else process.exitCode = 1;
}
const ps = (komut, env = {}) => execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding = [Text.Encoding]::UTF8; $ErrorActionPreference = 'Stop'; ${komut}`],
  { env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 }).trim();

function agac(dizin, on = '') {
  const m = new Map();
  for (const d of fs.readdirSync(dizin, { withFileTypes: true })) {
    const ad = on + d.name;
    if (d.isDirectory()) { m.set(`${ad}/`, null); for (const [k, v] of agac(path.join(dizin, d.name), `${ad}/`)) m.set(k, v); }
    else m.set(ad, fs.readFileSync(path.join(dizin, d.name)));
  }
  return m;
}
const ayniAgac = (a, b) => a.size === b.size && [...a].every(([k, v]) => b.has(k) && (v === null ? b.get(k) === null : b.get(k) && b.get(k).equals(v)));
const fark = (a, b) => [...[...a.keys()].filter((k) => !b.has(k)).map((k) => `-${k}`), ...[...b.keys()].filter((k) => !a.has(k)).map((k) => `+${k}`)].join(' ');

(async () => {
  const A = path.join(KOK, 'Arşiv ğüş');
  fs.mkdirSync(path.join(A, 'Alt klasör İ', 'boş'), { recursive: true });
  const buyuk = crypto.randomBytes(5000);
  const metin = Buffer.from('ZIP64 zorlandı — çğıöşü\r\n'.repeat(300));
  fs.writeFileSync(path.join(A, 'büyük.bin'), buyuk);
  fs.writeFileSync(path.join(A, 'Alt klasör İ', 'metin.txt'), metin);
  fs.writeFileSync(path.join(A, 'küçük.txt'), 'k');
  fs.writeFileSync(path.join(A, 'resim.png'), buyuk.subarray(0, 1500));

  const ws = new WebSocket(`ws://localhost:${PORT}`);
  const auth = await new Promise((res) => {
    ws.on('message', (d, bin) => {
      if (bin) return;
      const m = JSON.parse(d.toString());
      if (m.t === 'hello') ws.send(JSON.stringify({ t: 'setup', username: 'ahmet', password: 'gizli123', remember: false }));
      if (m.t === 'auth') res(m);
    });
  });
  const body = await new Promise((res) => http.get({ host: 'localhost', port: PORT, path: `/api/dosya/zip?yol=${encodeURIComponent('Arşiv ğüş')}`, headers: { 'X-Oturum': auth.http } }, (r) => {
    const p = []; r.on('data', (c) => p.push(c)); r.on('end', () => res(Buffer.concat(p)));
  }));
  let m = null;
  try { m = zipOku(body); } catch (e) { check('zip okunabilir', false, e.message); }
  const beklenen = new Map([
    ['Arşiv ğüş/', null], ['Arşiv ğüş/Alt klasör İ/', null], ['Arşiv ğüş/Alt klasör İ/boş/', null],
    ['Arşiv ğüş/Alt klasör İ/metin.txt', metin], ['Arşiv ğüş/büyük.bin', buyuk], ['Arşiv ğüş/küçük.txt', Buffer.from('k')],
    ['Arşiv ğüş/resim.png', buyuk.subarray(0, 1500)],
  ]);
  if (m) {
    const g = (ad) => m.girdiler.find((x) => x.ad === ad);
    const icerik = new Map(m.girdiler.map((x) => [x.ad, x.klasor ? null : x.veri]));
    check('kendi okuyucumuz: içerik ve CRC', ayniAgac(beklenen, icerik), fark(beklenen, icerik));
    check('≥ 1000 bayt girdiler: yerel ZIP64 ek alanı + 8 baytlık data descriptor, merkezde boyutlar ZIP64',
      ['Arşiv ğüş/büyük.bin', 'Arşiv ğüş/resim.png', 'Arşiv ğüş/Alt klasör İ/metin.txt'].every((a) => g(a)?.yerel64 && g(a).z64.boyut && g(a).z64.sikisik && g(a).gerek === 45));
    check('küçük girdi ZIP64 değil', g('Arşiv ğüş/küçük.txt') && !g('Arşiv ğüş/küçük.txt').yerel64 && !g('Arşiv ğüş/küçük.txt').z64.boyut);
    check('konumu ≥ 1000 olan girdilerde konum ZIP64', m.girdiler.filter((x) => x.konum >= 1000).length >= 2 && m.girdiler.filter((x) => x.konum >= 1000).every((x) => x.z64.konum));
    check('ZIP64 EOCD + bulucu, EOCD alanları 0xFFFF/0xFFFFFFFF', !!m.zip64 && m.zip64.adet === m.girdiler.length && body.readUInt32LE(body.length - 22 + 16) === 0xFFFFFFFF);

    const zipDosya = path.join(TMP, 'zip64.zip');
    fs.writeFileSync(zipDosya, body);
    const hedef = path.join(TMP, 'acilan');
    try {
      ps('Expand-Archive -LiteralPath $env:ZIP_YOL -DestinationPath $env:ZIP_HEDEF -Force', { ZIP_YOL: zipDosya, ZIP_HEDEF: hedef });
      const disk = agac(hedef);
      check('Expand-Archive ZIP64 zip\'i açtı: içerik, Türkçe adlar, boş klasör', ayniAgac(beklenen, disk), fark(beklenen, disk));
    } catch (e) { check('Expand-Archive açtı', false, String(e.stderr || e.message).slice(0, 300)); }
    try {
      const out = ps('Add-Type -AssemblyName System.IO.Compression.FileSystem; $z = [IO.Compression.ZipFile]::OpenRead($env:ZIP_YOL); '
        + "($z.Entries | ForEach-Object { $_.FullName + '|' + $_.Length }) -join [char]10; $z.Dispose()", { ZIP_YOL: zipDosya });
      const satirlar = out.split(/\r?\n/).sort();
      const bek = [...beklenen].map(([k, v]) => `${k}|${v ? v.length : 0}`).sort();
      check('System.IO.Compression: adlar ve boyutlar', JSON.stringify(satirlar) === JSON.stringify(bek), satirlar.join(', '));
    } catch (e) { check('System.IO.Compression açtı', false, String(e.stderr || e.message).slice(0, 300)); }
    try {
      const hedef2 = path.join(TMP, 'acilan-tar');
      fs.mkdirSync(hedef2);
      execFileSync(path.join(SYS, 'System32', 'tar.exe'), ['-xf', zipDosya, '-C', hedef2], { stdio: 'pipe' });
      const disk = agac(hedef2);
      check('tar.exe (libarchive) ZIP64 zip\'i açtı, içerik aynı', [...beklenen].filter(([, v]) => v).every(([k, v]) => {
        const d = [...disk].find(([dk]) => dk.normalize('NFC') === k);
        return d && d[1].equals(v);
      }), fark(beklenen, disk));
    } catch (e) { check('tar.exe açtı', false, String(e.stderr || e.message).slice(0, 300)); }
  }
  ws.close();
  console.log(`\n${pass} kontrol geçti`);
  process.exit();
})().catch((e) => { console.error('TEST HATASI', e); process.exit(1); });
