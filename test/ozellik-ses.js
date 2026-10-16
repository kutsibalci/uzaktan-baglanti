// Ses aktarımı testi: Ses.exe (doğrudan), Ogg ayrıştırıcı, WebSocket aboneliği, Opus paketlerinin
// ffmpeg ile çözülebilmesi ve abonelik bitince alt süreçlerin kapanması.
// Hoparlörden ses ÇALINMAZ: yalnızca yakalanan akış okunur, çözme dosyaya/belleğe yapılır.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, spawnSync, execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const WebSocket = require(path.join(ROOT, 'node_modules', 'ws'));
const FFMPEG = require(path.join(ROOT, 'node_modules', 'ffmpeg-static'));
const { OggReader } = require(path.join(ROOT, 'features', 'ses.js'));
const PORT = process.env.TEST_PORT || 3999;
const URL = `ws://localhost:${PORT}`;
const SES_EXE = path.join(ROOT, 'helper', 'Ses.exe');

function client() {
  const ws = new WebSocket(URL);
  const queue = [];
  const waiters = [];
  const packets = []; // [3] türündeki ikili mesajlar
  ws.on('message', (d, bin) => {
    if (bin) { if (d[0] === 3) packets.push({ at: Date.now(), data: Buffer.from(d.subarray(1)) }); return; }
    const msg = JSON.parse(d.toString());
    const i = waiters.findIndex((w) => w.pred(msg));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg); else queue.push(msg);
  });
  const next = (pred = () => true, ms = 8000) => {
    const i = queue.findIndex(pred);
    if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      waiters.push({ pred, resolve });
      setTimeout(() => reject(new Error('timeout waiting')), ms);
    });
  };
  const send = (o) => ws.send(JSON.stringify(o));
  const closed = new Promise((r) => ws.on('close', (c) => r(c)));
  return { ws, next, send, closed, packets };
}
const t = (type) => (m) => m.t === type;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${name} ${extra}`);
  if (cond) pass++; else process.exitCode = 1;
}

// ---------- Ogg yazıcı (test için; CRC dahil, ffmpeg kabul etsin) ----------

const CRC_TABLE = (() => {
  const tbl = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? ((r << 1) ^ 0x04c11db7) : (r << 1);
    tbl[i] = r >>> 0;
  }
  return tbl;
})();
function oggCrc(buf) {
  let crc = 0;
  for (const b of buf) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ b) & 0xff]) >>> 0;
  return crc;
}
// segments: segment uzunlukları; data: sayfa verisi
function oggPage({ flags = 0, granule = 0n, serial = 1, seq, segments, data }) {
  const h = Buffer.alloc(27 + segments.length);
  h.write('OggS', 0);
  h[4] = 0; h[5] = flags;
  h.writeBigInt64LE(BigInt(granule), 6);
  h.writeUInt32LE(serial, 14);
  h.writeUInt32LE(seq, 18);
  h[26] = segments.length;
  segments.forEach((s, i) => { h[27 + i] = s; });
  const page = Buffer.concat([h, data]);
  page.writeUInt32LE(oggCrc(page), 22);
  return page;
}
const lacing = (len) => [...Array(Math.floor(len / 255)).fill(255), len % 255];
function oggOpusFile(packets) {
  const head = Buffer.alloc(19);
  head.write('OpusHead', 0); head[8] = 1; head[9] = 2; head.writeUInt16LE(312, 10); head.writeUInt32LE(48000, 12);
  const vendor = Buffer.from('test');
  const tags = Buffer.concat([Buffer.from('OpusTags'), Buffer.from([vendor.length, 0, 0, 0]), vendor, Buffer.alloc(4)]);
  const pages = [
    oggPage({ flags: 2, seq: 0, segments: lacing(head.length), data: head }),
    oggPage({ seq: 1, segments: lacing(tags.length), data: tags }),
  ];
  let granule = 0n;
  packets.forEach((p, i) => {
    granule += 960n;
    pages.push(oggPage({ flags: i === packets.length - 1 ? 4 : 0, granule, seq: i + 2, segments: lacing(p.length), data: p }));
  });
  return Buffer.concat(pages);
}

// ---------- Süreç ağacı ----------

function serverPid() {
  const out = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' });
  const line = out.split(/\r?\n/).find((l) => /LISTENING/.test(l) && new RegExp(`:${PORT}\\s`).test(l));
  return line ? Number(line.trim().split(/\s+/).pop()) : null;
}
function descendants(pid) {
  const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress'], { encoding: 'utf8' });
  const all = JSON.parse(out);
  const res = [];
  const walk = (p) => { for (const x of all) if (x.ParentProcessId === p && x.ProcessId !== p) { res.push(x); walk(x.ProcessId); } };
  walk(pid);
  return res;
}
const sesProcs = (pid) => descendants(pid).filter((x) => /^(Ses|ffmpeg)\.exe$/i.test(x.Name));

// Opus TOC baytından paket süresi (ms) — RFC 6716 3.1
function opusDurationMs(pkt) {
  const config = pkt[0] >> 3;
  const frameMs = config < 12 ? [10, 20, 40, 60][config & 3]
    : config < 16 ? [10, 20][config & 1]
      : [2.5, 5, 10, 20][config & 3];
  const code = pkt[0] & 3;
  const frames = code === 0 ? 1 : code === 3 ? (pkt[1] & 0x3f) : 2;
  return frameMs * frames;
}

(async () => {
  // 1. Ses.exe doğrudan: 2 sn'de ~48000*2*2*2 bayt
  check('Ses.exe derlendi (sunucu açılışında)', fs.existsSync(SES_EXE));
  {
    const p = spawn(SES_EXE, [], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let bytes = 0, first = 0, stderr = '';
    p.stdout.on('data', (d) => {
      if (!first) first = Date.now();
      if (Date.now() - first <= 2000) bytes += d.length;
    });
    p.stderr.on('data', (d) => { stderr += d; });
    await sleep(3000);
    const exited = new Promise((r) => p.on('exit', r));
    p.stdout.destroy(); // stdout kapanınca kendisi çıkmalı
    const code = await Promise.race([exited, sleep(3000).then(() => 'zaman aşımı')]);
    if (code === 'zaman aşımı') p.kill();
    const want = 48000 * 2 * 2 * 2;
    check('Ses.exe 2 sn içinde ~384000 bayt PCM üretti (±%15)', Math.abs(bytes - want) <= want * 0.15, `(${bytes} bayt, ${stderr.trim().split('\n')[0] || ''})`);
    check('Ses.exe stdout kapanınca kendisi çıktı', code !== 'zaman aşımı', `(çıkış: ${code})`);
  }

  // 2. Dönüştürme yolu (aygıtsız sentetik kip): 44.1 kHz 6 kanal ve 96 kHz -> 48 kHz stereo
  for (const [rate, ch] of [[44100, 6], [96000, 2], [48000, 1]]) {
    const r = spawnSync(SES_EXE, ['sentetik', String(rate), String(ch)], { timeout: 10000 });
    const b = r.stdout || Buffer.alloc(0);
    const n = b.length / 4;
    let zc = 0, bad = 0;
    for (let i = 1; i < n; i++) {
      const a = b.readInt16LE((i - 1) * 4), l = b.readInt16LE(i * 4), rr = b.readInt16LE(i * 4 + 2);
      if ((a < 0) !== (l < 0)) zc++;
      if (ch === 1 ? l !== rr : Math.abs(l + rr) > 2) bad++;
    }
    check(`dönüştürme ${rate} Hz ${ch} kanal -> 48 kHz stereo`, Math.abs(n - 48000) <= 2 && Math.abs(zc - 2000) <= 4 && bad === 0,
      `(${n} kare, ${zc} sıfır geçişi ~1 kHz, kanal hatası ${bad})`);
  }

  // 3. Ogg ayrıştırıcı: sayfa sınırında bölünen paket + başlıklar
  {
    const got = [];
    const r = new OggReader((p) => got.push(p));
    const big = Buffer.alloc(700, 7); const small = Buffer.from([1, 2, 3]);
    // 700 baytlık paket: 255+255 ilk sayfada (devam ediyor), kalan 190 ikinci sayfada (continued bayrağı)
    const p1 = oggPage({ seq: 0, segments: [3, 255, 255], data: Buffer.concat([small, big.subarray(0, 510)]) });
    const p2 = oggPage({ flags: 1, seq: 1, segments: [190, 3], data: Buffer.concat([big.subarray(510), small]) });
    // 510 baytlık paket (255'in katı -> sonda 0 uzunluklu segment)
    const p3 = oggPage({ seq: 2, segments: [255, 255, 0], data: Buffer.alloc(510, 9) });
    const all = Buffer.concat([Buffer.from('çöp'), p1, p2, p3]);
    for (let i = 0; i < all.length; i += 37) r.push(all.subarray(i, i + 37)); // rastgele parçalarla
    check('Ogg: sayfa sınırında birleşen paketler doğru', got.length === 4 && got[0].equals(small) && got[1].equals(big)
      && got[2].equals(small) && got[3].length === 510, `(${got.map((g) => g.length).join(', ')})`);
  }

  // 4. Kurulum + abonelik
  const c = client();
  await c.next(t('hello'));
  c.send({ t: 'ses', acik: true }); // giriş yapmadan: yok sayılmalı
  c.send({ t: 'setup', username: 'ahmet', password: 'gizli123', remember: false, deviceName: 'Test' });
  const auth = await c.next(t('auth'));
  check('yönetici oluşturuldu', auth.ok);
  await sleep(500);
  check('giriş yapmadan ses akışı başlamadı', c.packets.length === 0);

  const pid = serverPid();
  check('sunucu PID bulundu', !!pid, `(${pid})`);
  check('abone yokken Ses.exe/ffmpeg çalışmıyor', pid && sesProcs(pid).length === 0);

  c.send({ t: 'ses', acik: true });
  const cfg = await c.next(t('ses-config'));
  check('ses-config geldi', cfg.sampleRate === 48000 && cfg.channels === 2 && cfg.codec === 'opus');
  await sleep(1500); // ısınma
  const startCount = c.packets.length;
  const t0 = Date.now();
  await sleep(3000);
  const pencere = c.packets.slice(startCount);
  const rate = pencere.length / ((Date.now() - t0) / 1000);
  check('[3] paketleri ~50/sn geliyor', rate >= 40 && rate <= 60, `(${rate.toFixed(1)}/sn)`);
  const procs = sesProcs(pid);
  check('abone varken Ses.exe ve ffmpeg sunucunun alt süreci', procs.some((x) => /^Ses\.exe$/i.test(x.Name)) && procs.some((x) => /^ffmpeg\.exe$/i.test(x.Name)),
    `(${procs.map((x) => `${x.Name}:${x.ProcessId}`).join(', ')})`);

  const pkts = c.packets.map((p) => p.data);
  const tocOk = pkts.every((p) => p.length >= 1 && p.length <= 1275 && opusDurationMs(p) === 20);
  const heads = pkts.some((p) => /^Opus(Head|Tags)/.test(p.subarray(0, 8).toString('latin1')));
  check('her paket geçerli Opus TOC (20 ms) ve makul boyutta, başlık paketi yok', tocOk && !heads && pkts.length > 0,
    `(${pkts.length} paket, TOC 0x${pkts[0]?.[0].toString(16)}, boyut ${Math.min(...pkts.map((p) => p.length))}-${Math.max(...pkts.map((p) => p.length))})`);

  // Paketleri Ogg/Opus dosyasına koyup ffmpeg ile çöz (dosyaya; hoparlöre değil)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-ses-'));
  try {
    const file = path.join(tmp, 'test.opus');
    fs.writeFileSync(file, oggOpusFile(pkts));
    const r = spawnSync(FFMPEG, ['-hide_banner', '-v', 'error', '-xerror', '-i', file, '-f', 's16le', '-ac', '2', '-ar', '48000', '-'],
      { maxBuffer: 256 * 1024 * 1024, timeout: 30000 });
    const pcm = r.stdout ? r.stdout.length : 0;
    const want = pkts.length * 960 * 4 - 312 * 4; // ön atlama (pre-skip) düşülür
    check('paketler ffmpeg ile hatasız çözüldü', r.status === 0 && !String(r.stderr).trim() && Math.abs(pcm - want) <= 960 * 4,
      `(${pcm} bayt PCM, beklenen ~${want}${String(r.stderr).trim() ? `, hata: ${String(r.stderr).trim().slice(0, 200)}` : ''})`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // 5. Salt izleme kullanıcısı da dinleyebilir
  c.send({ t: 'admin', op: 'addUser', username: 'izleyici', password: 'izle1234', role: 'view' });
  await c.next(t('adminData'));
  const v = client();
  await v.next(t('hello'));
  v.send({ t: 'login', username: 'izleyici', password: 'izle1234', remember: false });
  check('salt izleme girişi', (await v.next(t('auth'))).ok);
  v.send({ t: 'ses', acik: true });
  await v.next(t('ses-config'));
  await sleep(800);
  check('salt izleme kullanıcısı ses alıyor', v.packets.length > 10, `(${v.packets.length})`);
  c.send({ t: 'admin', op: 'list' });
  const ad = await c.next(t('adminData'));
  check('yönetim verisi: 2 dinleyen, zincir çalışıyor', ad.features?.ses?.dinleyen === 2 && ad.features.ses.calisiyor, JSON.stringify(ad.features?.ses));

  // 6. Abonelik bitince süreçler kapanır (biri kapatır, diğeri bağlantıyı koparır)
  c.send({ t: 'ses', acik: false });
  await sleep(1000);
  check('bir abone kalınca zincir sürüyor', sesProcs(pid).length === 2);
  const before = c.packets.length;
  await sleep(500);
  check('kapatan istemciye paket gitmiyor', c.packets.length === before);
  v.ws.close(); await v.closed;
  await sleep(1500);
  const left = sesProcs(pid);
  check('abone kalmayınca Ses.exe ve ffmpeg kapandı', left.length === 0, left.length ? `(kalan: ${left.map((x) => x.Name).join(', ')})` : '');

  // 7. Yeniden aç/kapat: sızıntı yok
  for (let i = 0; i < 3; i++) {
    c.send({ t: 'ses', acik: true });
    await c.next(t('ses-config'));
    await sleep(300);
    c.send({ t: 'ses', acik: false });
  }
  await sleep(1500);
  check('art arda aç/kapa sonrası alt süreç kalmadı', sesProcs(pid).length === 0);

  c.ws.close(); await c.closed;
  console.log(`\n${pass} kontrol geçti`);
  process.exit();
})().catch((e) => { console.error('TEST HATASI', e); process.exit(1); });
