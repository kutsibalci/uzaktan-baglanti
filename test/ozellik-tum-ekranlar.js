// "Tüm ekranlar" görünümü: bütün monitörler gerçek dizilimiyle tek görüntüde, girdi doğru ekrana.
//  1. Birim: birleşik dikdörtgen, nokta -> (ekran, nx, ny) eşlemesi ve tersi (kullanıcının dizilimi, dikey, farklı boyutlar,
//     boşluklu, negatif koordinatlı ikincil ekran), boşluktaki noktanın en yakın ekrana sığdırılması (kumandadaki ekranaSigdir
//     ile aynı sonuç), çıkış ölçeği (en-boy korunur, çift boyut, Orta ~1920×1080 piksel, Yüksek tam), tür 4 paketi.
//  2. Uçtan uca (kendi sunucusunu açar): ekran dizilimi REMOTE_EKRANLAR_SAHTE ile taklit edilir (bu bilgisayarda şu an tek
//     monitör var); sahte ekranlar gerçek masaüstünün İÇİNDE olduğundan H.264 (gdigrab) gerçekten yakalar. JPEG karesi
//     tür 4 (ekran başına JPEG), H.264 boyutu birleşik en-boyda, girdi REMOTE_GIRDI_KURU=1 ile yalnızca mesaj düzeyinde
//     (GERÇEK FARE/KLAVYE GİRDİSİ GÖNDERİLMEZ), ekran düzeni değişince (sahte dosya yeniden yazılır) liste ve akış yenilenir.
// @sunucu yok
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const WebSocket = require(path.join(ROOT, 'node_modules', 'ws'));
const E = require(path.join(ROOT, 'public', 'ekranlar.js'));
const { grabRegion } = require(path.join(ROOT, 'lib', 'video'));
const { ekranaSigdir } = require(path.join(ROOT, 'features', 'kumanda.js'));
const { komutOlustur } = require(path.join(ROOT, 'features', 'kalem.js'));
const PORT = process.env.TEST_PORT || 3999;

let fails = 0;
const check = (n, c, x = '') => { console.log(`${c ? 'OK  ' : 'FAIL'} ${n} ${x}`); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const yakin = (a, b, e = 1e-6) => Math.abs(a - b) <= e;
const D = (n) => `\\\\.\\DISPLAY${n}`;
const ekran = (n, x, y, w, h, primary = false) => ({ name: D(n), x, y, w, h, primary });

// JPEG boyutu (SOF0/SOF2 başlığından).
function jpegSize(buf) {
  for (let i = 2; i + 9 < buf.length;) {
    if (buf[i] !== 0xff) return null;
    const m = buf[i + 1];
    if (m === 0xc0 || m === 0xc2) return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

// ---------------- 1. Birim testleri ----------------
function birim() {
  // Kullanıcının dizilimi: DISPLAY1 1920×1080 %125 (ana, 0,0), DISPLAY2 1920×1080 %100 (1920,0) — fiziksel piksel.
  const kul = [ekran(1, 0, 0, 1920, 1080, true), ekran(2, 1920, 0, 1920, 1080)];
  const U = E.birlesim(kul);
  check('kullanıcı: birleşim 3840×1080', JSON.stringify(U) === JSON.stringify({ x: 0, y: 0, w: 3840, h: 1080 }), JSON.stringify(U));
  let p = E.noktaEkrana(kul, 0.75, 0.5);
  check('kullanıcı: sağ yarının ortası -> ekran 2 (0.5, 0.5)', p.name === D(2) && yakin(p.x, (0.75 * 3839 - 1920) / 1919) && yakin(p.y, 0.5) && Math.abs(p.x - 0.5) < 0.001, JSON.stringify(p));
  p = E.noktaEkrana(kul, 0.25, 0);
  check('kullanıcı: sol yarı -> ekran 1', p.name === D(1) && Math.abs(p.x - 0.5) < 0.001 && p.y === 0, JSON.stringify(p));
  p = E.noktaEkrana(kul, 1, 1);
  check('kullanıcı: sağ alt köşe -> ekran 2 (1, 1)', p.name === D(2) && p.x === 1 && p.y === 1, JSON.stringify(p));
  p = E.noktaEkrana(kul, 0, 0);
  check('kullanıcı: sol üst köşe -> ekran 1 (0, 0)', p.name === D(1) && p.x === 0 && p.y === 0, JSON.stringify(p));
  // Sınır: fiziksel 1919 ekran 1'in son pikseli, 1920 ekran 2'nin ilki.
  const a = E.noktaEkrana(kul, 1919 / 3839, 0.5), b = E.noktaEkrana(kul, 1920 / 3839, 0.5);
  check('kullanıcı: sınır pikselleri (1919 -> ekran 1 sağ kenar, 1920 -> ekran 2 sol kenar)', a.name === D(1) && yakin(a.x, 1) && b.name === D(2) && yakin(b.x, 0), `${JSON.stringify(a)} ${JSON.stringify(b)}`);
  const geri = E.ekrandanBirlesige(kul, D(2), 0.5, 0.5);
  const ileri = E.noktaEkrana(kul, geri.x, geri.y);
  check('kullanıcı: ters eşleme gidip dönüyor', ileri.name === D(2) && yakin(ileri.x, 0.5) && yakin(ileri.y, 0.5), JSON.stringify(geri));
  check('tek ekranda birleşik nokta = ekrandaki nokta', (() => { const q = E.noktaEkrana([kul[0]], 0.3, 0.7); return q.name === D(1) && yakin(q.x, 0.3) && yakin(q.y, 0.7); })());

  // Dikey dizilim + farklı boyut: 1920×1080 üstte, 1280×1024 altta (sola yaslı).
  const dik = [ekran(1, 0, 0, 1920, 1080, true), ekran(2, 0, 1080, 1280, 1024)];
  const Ud = E.birlesim(dik);
  check('dikey: birleşim 1920×2104', Ud.w === 1920 && Ud.h === 2104 && Ud.x === 0 && Ud.y === 0, JSON.stringify(Ud));
  p = E.noktaEkrana(dik, 640 / 1919, 1592 / 2103);
  check('dikey: alttaki ekranın ortası -> ekran 2', p.name === D(2) && Math.abs(p.x - 640 / 1279) < 1e-6 && Math.abs(p.y - 512 / 1023) < 1e-6, JSON.stringify(p));
  // Alt ekranın sağındaki boşluk (1600, 1500) -> en yakın: ekran 2'nin sağ kenarı.
  p = E.noktaEkrana(dik, 1600 / 1919, 1500 / 2103);
  check('dikey: boşluktaki nokta en yakın ekrana sığdı (ekran 2 sağ kenar)', p.name === D(2) && p.x === 1 && yakin(p.y, (1500 - 1080) / 1023), JSON.stringify(p));

  // Boşluklu, farklı boyutlar: 1920×1080 ve 80 px sağda, 200 px aşağıda 1280×720.
  const bos = [ekran(1, 0, 0, 1920, 1080, true), ekran(2, 2000, 200, 1280, 720)];
  const Ub = E.birlesim(bos);
  check('boşluklu: birleşim 3280×1080', Ub.w === 3280 && Ub.h === 1080, JSON.stringify(Ub));
  p = E.noktaEkrana(bos, 1960 / 3279, 500 / 1079); // boşlukta: ekran 1'e 41, ekran 2'ye 40 px
  check('boşluklu: aradaki boşluk -> en yakın ekran (2, sol kenar)', p.name === D(2) && p.x === 0 && yakin(p.y, 300 / 719), JSON.stringify(p));
  p = E.noktaEkrana(bos, 3000 / 3279, 1000 / 1079); // ekran 2'nin altındaki boşluk
  check('boşluklu: alttaki boşluk -> ekran 2 alt kenar', p.name === D(2) && p.y === 1 && yakin(p.x, 1000 / 1279), JSON.stringify(p));

  // Negatif koordinatlı ikincil ekran (solda ve yukarıda).
  const neg = [ekran(1, 0, 0, 1920, 1080, true), ekran(2, -1280, -300, 1280, 1024)];
  const Un = E.birlesim(neg);
  check('negatif: birleşim (-1280,-300) 3200×1380', Un.x === -1280 && Un.y === -300 && Un.w === 3200 && Un.h === 1380, JSON.stringify(Un));
  p = E.noktaEkrana(neg, 0, 0);
  check('negatif: sol üst -> ekran 2 (0,0)', p.name === D(2) && p.x === 0 && p.y === 0, JSON.stringify(p));
  p = E.noktaEkrana(neg, (1280 + 960) / 3199, (300 + 540) / 1379);
  check('negatif: ana ekranın ortası -> ekran 1 (0.5, 0.5)', p.name === D(1) && Math.abs(p.x - 960 / 1919) < 1e-6 && Math.abs(p.y - 540 / 1079) < 1e-6, JSON.stringify(p));
  const kutu = E.ekranKutusu(Un, neg[0]);
  check('negatif: ekran 1 kutusu görüntüde doğru yerde', yakin(kutu.x, 1280 / 3200) && yakin(kutu.y, 300 / 1380) && yakin(kutu.w, 1920 / 3200), JSON.stringify(kutu));

  // Boşluğa sığdırma kumandadaki ekranaSigdir ile aynı (rastgele noktalar).
  let ayni = true;
  for (let i = 0; i < 500 && ayni; i++) {
    for (const list of [kul, dik, bos, neg]) {
      const u = Math.random(), v = Math.random();
      const U2 = E.birlesim(list);
      const pp = { x: U2.x + u * (U2.w - 1), y: U2.y + v * (U2.h - 1) };
      const k1 = ekranaSigdir(list, pp), k2 = E.ekranaSigdir(list, pp);
      if (k1.s !== k2.s || k1.x !== k2.x || k1.y !== k2.y) ayni = false;
    }
  }
  check('boşluğa sığdırma features/kumanda.js ekranaSigdir ile aynı', ayni);

  // Çıkış ölçeği: en-boy korunur, çift boyut; Orta/Otomatik (1920) ~1920×1080 piksel, Düşük (1280) ~1280×720, Yüksek tam.
  const g = (s, mw) => grabRegion({ ...E.birlesim(s), tum: true }, mw);
  let r = g(kul, 1920);
  check('ölçek: kullanıcı, Orta -> 2716×764 (~1920×1080 piksel)', r.outW === 2716 && r.outH === 764 && r.w === 3840 && r.h === 1080, JSON.stringify(r));
  check('ölçek: en-boy korunuyor (%0,5)', Math.abs(r.outW / r.outH - 3840 / 1080) / (3840 / 1080) < 0.005);
  r = g(kul, 2560);
  check('ölçek: kullanıcı, Yüksek -> tam 3840×1080', r.outW === 3840 && r.outH === 1080, JSON.stringify(r));
  r = g(kul, 1280);
  check('ölçek: kullanıcı, Düşük -> ~1280×720 piksel', r.outW % 2 === 0 && r.outH % 2 === 0 && Math.abs(r.outW * r.outH - 1280 * 720) < 1280 * 720 * 0.01, JSON.stringify(r));
  r = g(dik, 1920);
  check('ölçek: dikey dizilim, çift boyutlar ve en-boy', r.outW % 2 === 0 && r.outH % 2 === 0 && Math.abs(r.outW / r.outH - 1920 / 2104) < 0.01, JSON.stringify(r));
  r = g([ekran(1, 0, 0, 2560, 1440, true), ekran(2, 2560, 0, 2560, 1440), ekran(3, 5120, 0, 2560, 1440)], 2560);
  check('ölçek: Yüksekte de en fazla 3840 geniş', r.outW === 3840 && r.outH === 720, JSON.stringify(r));
  r = g([kul[0]], 1920);
  check('ölçek: tek ekran Orta -> 1920×1080 (tek ekran görünümüyle aynı)', r.outW === 1920 && r.outH === 1080, JSON.stringify(r));
  r = g([ekran(1, 0, 0, 1921, 1081, true)], 1920);
  check('ölçek: tek sayılı boyut aşağı yuvarlanır (bölge masaüstünden taşmaz)', r.w === 1920 && r.h === 1080, JSON.stringify(r));

  // Tür 4 paketi (JPEG yolu): yaz -> oku.
  const pc = E.parcalar(kul, 1920);
  check('parçalar: iki ekran yan yana, birleşik boyutta', pc.W === 2715 && pc.H === 764 && pc.list[0].x === 0 && pc.list[1].x === 1358 && pc.list[1].w === 1358 && pc.list[1].h === 764, JSON.stringify(pc));
  const j1 = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]), j2 = Buffer.from([0xff, 0xd8, 9, 0xff, 0xd9]);
  const pk = E.paketle(pc.W, pc.H, pc.list, [j1, j2]);
  const c = E.coz(pk);
  check('paket: gidip dönüyor', c && c.W === pc.W && c.H === pc.H && c.parts.length === 2 && Buffer.from(c.parts[1].data).equals(j2) && c.parts[1].x === 1358, JSON.stringify(c && c.parts.map((x) => [x.x, x.y, x.w, x.h, x.data.length])));
  check('paket: bozuk (kısa) paket reddedilir', E.coz(pk.subarray(0, pk.length - 1)) === null && E.coz(new Uint8Array(3)) === null);
  check('etiket: "Ekran 2 (…)" -> "2", sanal -> "S"', E.etiket({ title: 'Ekran 2 (1920×1080)' }, 0) === '2' && E.etiket({ title: 'Sanal ekran (1920×1080)', virtual: true }, 1) === 'S');

  // Kalem: tüm ekranlarda hedef ekran mesajdan gelir; komut yine doğrulanır.
  check('kalem: ekran adı doğrulanıyor (enjeksiyon yok)', komutOlustur(D(2), { durum: 'move', x: 0.5, y: 0.5 }) === `pen ${D(2)} 0.50000 0.50000 0 move 0 0 0`
    && komutOlustur('*', { durum: 'move', x: 0.5, y: 0.5 }) === null && komutOlustur(`${D(2)} x\nmove`, { durum: 'move', x: 0.5, y: 0.5 }) === null);
}

// ---------------- 2. Uçtan uca ----------------
function sunucuAc(env) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => reject(new Error(`sunucu başlamadı:\n${out}`)), 30000);
    const onData = (d) => { out += d; if (out.includes('sunucusu çalışıyor')) { clearTimeout(timer); setTimeout(() => resolve({ p, log: () => out }), 800); } };
    p.stdout.on('data', onData);
    p.stderr.on('data', (d) => { out += d; });
    p.on('exit', (c) => { clearTimeout(timer); reject(new Error(`sunucu kapandı (${c}):\n${out}`)); });
  });
}

// Giriş yapmış istemci: mesajları biriktirir, bekle(koşul) ile beklenir.
function istemci() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    const c = { ws, json: [], bin: [], send: (m) => ws.send(JSON.stringify(m)) };
    c.bekle = async (fn, ms = 8000) => {
      const t0 = Date.now();
      for (;;) { const r = fn(c); if (r) return r; if (Date.now() - t0 > ms) return null; await sleep(25); }
    };
    ws.on('message', (d, isBin) => {
      if (isBin) { c.bin.push(d); if (d[0] === 1 || d[0] === 4) c.send({ t: 'ack' }); return; }
      const m = JSON.parse(d.toString());
      c.json.push(m);
      if (m.t === 'hello') c.send(m.canSetup ? { t: 'setup', username: 'test', password: 'test1234' } : { t: 'login', username: 'test', password: 'test1234' });
      else if (m.t === 'auth') m.ok ? resolve(c) : reject(new Error(m.error));
    });
    ws.on('error', reject);
  });
}
const sonJson = (c, t) => [...c.json].reverse().find((m) => m.t === t);

async function uctanUca() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-tum-'));
  const duzenDosya = path.join(tmp, 'ekranlar.json');
  // Gerçek masaüstünün (en az 1920×1080) içinde, boşluklu iki sahte ekran: birleşim 1700×1080.
  const iki = [ekran(1, 0, 0, 1000, 1080, true), ekran(2, 1100, 100, 600, 700)];
  fs.writeFileSync(duzenDosya, JSON.stringify(iki));
  let srv;
  try {
    srv = await sunucuAc({ PORT: String(PORT), REMOTE_DATA_DIR: path.join(tmp, 'veri'), REMOTE_EKRANLAR_SAHTE: duzenDosya, REMOTE_GIRDI_KURU: '1' });

    // ---- JPEG ----
    const j = await istemci();
    check('ekran listesinde iki ekran', j.json.find((m) => m.t === 'auth').screens.length === 2);
    j.send({ t: 'start', mode: 'control', screen: '*', codecs: ['jpeg'] });
    const st = await j.bekle(() => sonJson(j, 'started'));
    check('tüm ekranlar başladı (screen *)', st?.screen === '*' && st.codec === 'jpeg', JSON.stringify(st && { screen: st.screen, codec: st.codec }));
    j.send({ t: 'settings', quality: 40, maxWidth: 1280, fps: 20, kbps: 1500 });
    const cozK = (d) => E.coz(new Uint8Array(d.buffer, d.byteOffset + 1, d.length - 1));
    const bek = E.parcalar(iki, 1280);
    // Ayar gelmeden önce varsayılan kaliteyle yakalanmış kare olabilir: ayarın genişliğindeki kare beklenir.
    const kare = await j.bekle(() => j.bin.find((d) => d[0] === 4 && cozK(d)?.W === bek.W)) || j.bin.find((d) => d[0] === 4);
    const pk = kare && cozK(kare);
    check('JPEG: tür 4 birleşik kare geldi', !!pk, kare ? `${kare.length} bayt` : 'kare yok');
    if (pk) {
      check('JPEG: birleşik boyut beklenen en-boyda (1700:1080, ~1280×720 piksel)', pk.W === bek.W && pk.H === bek.H && Math.abs(pk.W / pk.H - 1700 / 1080) < 0.01, `${pk.W}×${pk.H}`);
      check('JPEG: iki parça, ekranların yerinde', pk.parts.length === 2 && pk.parts.every((p, i) => p.x === bek.list[i].x && p.y === bek.list[i].y && p.w === bek.list[i].w && p.h === bek.list[i].h),
        JSON.stringify(pk.parts.map((p) => [p.x, p.y, p.w, p.h])));
      const boy = pk.parts.map((p) => jpegSize(Buffer.from(p.data)));
      check('JPEG: her parça geçerli JPEG, genişliği parçanınki', boy.every((s, i) => s && s.w === pk.parts[i].w), JSON.stringify(boy));
      fs.writeFileSync(path.join(tmp, 'parca2.jpg'), Buffer.from(pk.parts[1].data));
    }

    // ---- Girdi (kuru): hedef ekran mesajdan, doğrulanmış ----
    const kuru = () => j.json.filter((m) => m.t === 'girdi-kuru').map((m) => m.cmd);
    j.json.length = 0;
    j.send({ t: 'move', s: D(2), x: 0.5, y: 0.25 });
    j.send({ t: 'down', b: 'left' });
    j.send({ t: 'move', s: D(1), x: 1, y: 0.5 }); // basılıyken başka ekrana: düğme bırakılmaz
    j.send({ t: 'up', b: 'left' });
    j.send({ t: 'move', s: 'abc', x: 0.1, y: 0.1 });            // geçersiz ad
    j.send({ t: 'move', s: D(7), x: 0.1, y: 0.1 });             // dizilimde olmayan ekran
    j.send({ t: 'move', x: 0.1, y: 0.1 });                      // ekran yok
    j.send({ t: 'move', s: `${D(2)} 0 0\nkey 13 1`, x: 0.1, y: 0.1 }); // komut enjeksiyonu
    j.send({ t: 'wheel', dy: 120, dx: 0 });
    await j.bekle(() => kuru().some((c) => c.startsWith('wheel')));
    check('girdi: ekranlar arası sürükleme komutları sırayla, düğme ekran değişince bırakılmadı',
      JSON.stringify(kuru()) === JSON.stringify([`move ${D(2)} 0.50000 0.25000`, 'down left', `move ${D(1)} 1.00000 0.50000`, 'up left', 'wheel 120 0']), JSON.stringify(kuru()));

    // ---- Tek ekrana geçiş: hedef yine görüntülenen ekran (s yok sayılır), kare tür 1 ----
    j.bin.length = 0;
    j.send({ t: 'screen', name: D(2) });
    const tek = await j.bekle(() => j.bin.find((d) => d[0] === 1));
    await sleep(500);
    const sonra = j.bin.slice(j.bin.indexOf(tek));
    j.json.length = 0;
    j.send({ t: 'move', s: D(1), x: 0.2, y: 0.3 });
    await j.bekle(() => kuru().length);
    check('tek ekran: kare tür 1 (JPEG), ardından tür 4 gelmiyor', !!tek && !sonra.some((d) => d[0] === 4));
    check('tek ekran: girdi görüntülenen ekrana (mesajdaki s yok sayılır)', kuru()[0] === `move ${D(2)} 0.20000 0.30000`, JSON.stringify(kuru()));
    j.bin.length = 0;
    j.send({ t: 'screen', name: '*' });
    check('tüm ekranlara geri dönüş: tür 4', !!(await j.bekle(() => j.bin.find((d) => d[0] === 4))));

    // ---- H.264 ----
    const h = await istemci();
    h.send({ t: 'start', mode: 'control', screen: '*', codecs: ['h264', 'jpeg'] });
    const hs = await h.bekle(() => sonJson(h, 'started'));
    if (hs?.codec !== 'h264') {
      check('H.264: bu bilgisayarda kodlayıcı yok, atlandı', true, JSON.stringify(hs?.codec));
    } else {
      h.send({ t: 'settings', quality: 60, maxWidth: 1920, fps: 30, kbps: 4000 });
      const vc = await h.bekle(() => sonJson(h, 'vconfig'), 15000);
      const er = grabRegion({ ...E.birlesim(iki), tum: true }, 1920);
      check('H.264: vconfig birleşik boyutta (1700×1080)', vc && vc.w === er.outW && vc.h === er.outH && vc.w === 1700 && vc.h === 1080, JSON.stringify(vc));
      const anahtar = await h.bekle(() => h.bin.find((d) => d[0] === 2 && d[1] === 1), 10000);
      check('H.264: anahtar kare geldi', !!anahtar);
      await sleep(2000);
      const n0 = h.bin.filter((d) => d[0] === 2).length;
      await sleep(3000);
      const fps = (h.bin.filter((d) => d[0] === 2).length - n0) / 3;
      console.log(`     H.264 tüm ekranlar (1700×1080, gdigrab tek bölge): ${fps.toFixed(1)} kare/sn (durağan ekranda da kodlayıcı kare üretir)`);
      // Ölçek: Düşük -> ~1280×720 piksel, çift boyutlar.
      h.json.length = 0;
      h.send({ t: 'settings', quality: 40, maxWidth: 1280, fps: 20, kbps: 1500 });
      const vc2 = await h.bekle(() => sonJson(h, 'vconfig'), 15000);
      const er2 = grabRegion({ ...E.birlesim(iki), tum: true }, 1280);
      check('H.264: Düşük kalitede ölçeklendi, en-boy korundu, çift boyut', vc2 && vc2.w === er2.outW && vc2.h === er2.outH && vc2.w % 2 === 0 && vc2.h % 2 === 0 && Math.abs(vc2.w / vc2.h - 1700 / 1080) < 0.01, JSON.stringify(vc2));
    }

    // ---- Ekran düzeni değişti: ekran 2 çıkarıldı ----
    j.json.length = 0; h.json.length = 0;
    const tek2 = await istemci(); // ekran 2'yi tek başına izleyen
    tek2.send({ t: 'start', mode: 'control', screen: D(2), codecs: ['jpeg'] });
    await tek2.bekle(() => sonJson(tek2, 'started'));
    tek2.send({ t: 'settings', quality: 40, maxWidth: 1280, fps: 20, kbps: 1500 });
    await sleep(500);
    // Kareler düzen yazılmadan ÖNCE temizlenir: yeni birleşimin ilk karesi 'ekranlar' mesajlarını beklerken gelebilir, durağan
    // masaüstünde de ondan sonra aynı kare bir daha gönderilmez. Eski düzenin geç gelen kareleri (2 parça) aşağıda atlanır.
    j.bin.length = 0;
    fs.writeFileSync(duzenDosya, JSON.stringify([iki[0]]));
    const yeni = await j.bekle(() => sonJson(j, 'ekranlar'), 6000);
    check('düzen değişti: tüm ekranlar istemcisine yeni liste', yeni && yeni.screens.length === 1 && yeni.screen === '*', JSON.stringify(yeni && { n: yeni.screens.length, screen: yeni.screen }));
    const yeniTek = await tek2.bekle(() => sonJson(tek2, 'ekranlar'), 6000);
    check('düzen değişti: çıkarılan ekranı izleyen ana ekrana geçti', yeniTek?.screen === D(1), JSON.stringify(yeniTek?.screen));
    const coz4 = (d) => E.coz(new Uint8Array(d.buffer, d.byteOffset + 1, d.length - 1));
    const k2 = await j.bekle(() => j.bin.find((d) => d[0] === 4 && coz4(d).parts.length === 1));
    const son4 = [...j.bin].reverse().find((d) => d[0] === 4);
    const pk2 = (k2 || son4) && coz4(k2 || son4);
    check('düzen değişti: JPEG karesi yeni birleşimde (tek parça, 1000:1080)', pk2 && pk2.parts.length === 1 && Math.abs(pk2.W / pk2.H - 1000 / 1080) < 0.01, pk2 ? `${pk2.W}×${pk2.H}` : 'kare yok');
    if (hs?.codec === 'h264') {
      const vc3 = await h.bekle(() => h.json.find((m) => m.t === 'vconfig'), 15000);
      const er3 = grabRegion({ ...E.birlesim([iki[0]]), tum: true }, 1280);
      check('düzen değişti: H.264 akışı yeni bölgeyle yeniden kuruldu', vc3 && vc3.w === er3.outW && vc3.h === er3.outH, JSON.stringify(vc3));
    }
    for (const c of [j, h, tek2]) c.ws.close();
    await sleep(300);
    check('sunucu günlüğünde ffmpeg hatası yok', !/ffmpeg kapandı/.test(srv.log()), srv.log().split('\n').filter((l) => /ffmpeg/.test(l)).join(' | '));
  } finally {
    if (srv) spawnSync('taskkill', ['/pid', String(srv.p.pid), '/T', '/F'], { stdio: 'ignore' });
    await sleep(300);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

(async () => {
  try {
    birim();
    await uctanUca();
  } catch (e) {
    check('test hatasız bitti', false, e.stack);
  }
  console.log(fails ? `${fails} HATA` : 'hepsi geçti');
  process.exit(fails ? 1 : 0);
})();
