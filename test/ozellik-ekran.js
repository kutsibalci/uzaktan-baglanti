// Ekran sınırları / ölçekleme testi (ör. %125 ana ekran + %100 ikinci ekran).
// GERÇEK GİRDİ GÖNDERİLMEZ: fare hareket ettirilmez ("map" yalnızca hesaplar), yalnızca ekran yakalanır.
//  - RemoteHelper Per-Monitor v2 DPI farkında mı, ekran sınırları Windows'un fiziksel ekran ayarlarıyla
//    (EnumDisplaySettings, DPI farkındalığından bağımsız) aynı mı,
//  - her ekranın JPEG karesi (cap) fiziksel çözünürlükte mi,
//  - ffmpeg gdigrab, lib/video.js'in ürettiği parametrelerle aynı bölgeyi yakalıyor mu (boyut + içerik benzerliği),
//  - tüm ekranların birleşimi gdigrab'ın gördüğü sanal masaüstüyle aynı mı,
//  - normalize koordinat -> fiziksel piksel eşlemesi (köşeler, orta),
//  - sunucunun gönderdiği ekran listesinde okunur ad ("Ekran 1 (1920×1080)").
// Tek monitörlü makinede ikinci ekran kısımları atlanır. Kareler %TEMP%\rc-ekran-test altına kaydedilir (gözle bakmak için).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const WebSocket = require(path.join(ROOT, 'node_modules', 'ws'));
const { Helper } = require(path.join(ROOT, 'lib', 'helper'));
const { grabRegion, gdigrabArgs, ffmpegPath, CHILD_ENV } = require(path.join(ROOT, 'lib', 'video'));
const URL = `ws://localhost:${process.env.TEST_PORT || 3999}`;
const OUT = path.join(os.tmpdir(), 'rc-ekran-test');

let fails = 0;
const check = (n, c, x = '') => { console.log(`${c ? 'OK  ' : 'FAIL'} ${n} ${x}`); if (!c) fails++; };
const killTree = (pid) => { if (pid) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }); };
const dosyaAdi = (name) => name.replace(/\W/g, '');

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

// Windows'un fiziksel ekran ayarları (DPI farkındalığından bağımsız): ad -> { x, y, w, h }.
function fizikselAyarlar() {
  const cs = `
using System; using System.Runtime.InteropServices;
public static class EkranAyar {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct DD { public int cb;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceString;
    public uint StateFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceID; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceKey; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct DM {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName; public short dmSpecVersion, dmDriverVersion, dmSize, dmDriverExtra; public int dmFields;
    public int x, y, o, f; public short a, b, c, d, e; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
    public short lp; public int bpp, w, h, fl, fr; public int r1, r2, r3, r4, r5, r6, r7, r8; }
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool EnumDisplayDevices(string d, uint n, ref DD dd, uint f);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool EnumDisplaySettings(string d, int n, ref DM dm);
  public static string Liste() {
    var sb = new System.Text.StringBuilder(); var dd = new DD(); dd.cb = Marshal.SizeOf(typeof(DD));
    for (uint i = 0; EnumDisplayDevices(null, i, ref dd, 0); i++) {
      if ((dd.StateFlags & 1) != 0) { var dm = new DM(); dm.dmSize = (short)Marshal.SizeOf(typeof(DM));
        if (EnumDisplaySettings(dd.DeviceName, -1, ref dm)) sb.AppendLine(dd.DeviceName + " " + dm.x + " " + dm.y + " " + dm.w + " " + dm.h); }
      dd.cb = Marshal.SizeOf(typeof(DD)); }
    return sb.ToString(); } }`;
  const ps1 = path.join(OUT, 'ekran-ayar.ps1');
  fs.writeFileSync(ps1, `Add-Type -TypeDefinition @'\r\n${cs}\r\n'@\r\n[EkranAyar]::Liste()\r\n`);
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  const out = {};
  for (const line of (r.stdout || '').split(/\r?\n/)) {
    const m = line.match(/^(\\\\\.\\DISPLAY\d+) (-?\d+) (-?\d+) (\d+) (\d+)$/);
    if (m) out[m[1]] = { x: +m[2], y: +m[3], w: +m[4], h: +m[5] };
  }
  return out;
}

// ffmpeg ile bir görüntüyü (JPEG dosyası ya da gdigrab girişi) 64x36 gri ham piksele indirir.
function kucukGri(inputArgs) {
  const r = spawnSync(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', ...inputArgs, '-frames:v', '1',
    '-vf', 'scale=64:36:flags=area,format=gray', '-f', 'rawvideo', '-'], { env: CHILD_ENV, timeout: 30000, windowsHide: true, maxBuffer: 1 << 20 });
  return r.status === 0 && r.stdout.length === 64 * 36 ? r.stdout : null;
}
const ortalamaFark = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };

function bolgeTestleri() {
  // Tek sayılı genişlik: yakalama bölgesi komşu monitöre taşmamalı (aşağı yuvarlanır).
  const r1 = grabRegion({ x: 1920, y: 0, w: 1365, h: 767 }, 4000);
  check('bölge: tek sayılı boyut aşağı yuvarlanır', r1.w === 1364 && r1.h === 766 && r1.outW === 1364 && r1.outH === 766, JSON.stringify(r1));
  check('bölge: yakalama monitör sınırını aşmaz', r1.x + r1.w <= 1920 + 1365 && r1.y + r1.h <= 767);
  // Negatif konumlu (solda/üstte) monitör: konum aynen kalır.
  const r2 = grabRegion({ x: -2400, y: -200, w: 2400, h: 1350 }, 1600);
  check('bölge: negatif konum korunur', r2.x === -2400 && r2.y === -200 && r2.w === 2400 && r2.h === 1350, JSON.stringify(r2));
  check('bölge: maxWidth ile küçültme (çift, oran korunur)', r2.outW === 1600 && r2.outH === 900, `${r2.outW}x${r2.outH}`);
  const args = gdigrabArgs({ ...r2, fps: 10 });
  check('bölge: gdigrab argümanları', args.join(' ') === '-f gdigrab -framerate 10 -draw_mouse 1 -offset_x -2400 -offset_y -200 -video_size 2400x1350 -i desktop', args.join(' '));
}

async function helperTestleri() {
  fs.mkdirSync(OUT, { recursive: true });
  const helper = new Helper();
  try {
    const info = await helper.info();
    const screens = info.screens;
    check('yardımcı monitör başına DPI farkında', info.dpiMode === 'pmv2' || info.dpiMode === 'pm', `dpiMode=${info.dpiMode}`);
    check('en az bir ekran', screens.length >= 1, `${screens.length} ekran`);
    check('ekran listesi sayısal sırada', screens.every((s, i) => i === 0 || +screens[i - 1].name.match(/\d+$/)[0] < +s.name.match(/\d+$/)[0]),
      screens.map((s) => s.name).join(' '));
    for (const s of screens) console.log(`     ${s.name}: ${s.x},${s.y} ${s.w}x${s.h} dpi=${s.dpi} ölçek=${s.scale}${s.primary ? ' (ana)' : ''} [${s.adapter}]`);

    const fiz = fizikselAyarlar();
    const fizSayi = Object.keys(fiz).length;
    check('Windows fiziksel ekran ayarları okundu', fizSayi >= 1, `${fizSayi} ekran`);
    if (fizSayi) check('ekran sayısı Windows ile aynı', fizSayi === screens.length, `${fizSayi} / ${screens.length}`);

    const ffmpeg = ffmpegPath();
    for (const s of screens) {
      const ad = `${s.name}`;
      const f = fiz[s.name];
      if (f) check(`${ad}: sınırlar fiziksel çözünürlükle aynı`, f.x === s.x && f.y === s.y && f.w === s.w && f.h === s.h,
        `yardımcı ${s.x},${s.y} ${s.w}x${s.h} / Windows ${f.x},${f.y} ${f.w}x${f.h}`);
      check(`${ad}: ölçek bilgisi`, typeof s.scale === 'number' && s.scale >= 1 && typeof s.dpi === 'number', `scale=${s.scale} dpi=${s.dpi}`);

      // JPEG yakalama (ölçeklemeden): kare tam ekran boyutunda olmalı.
      const jpg = await helper.request(`cap 85 0 ${s.name}`);
      const jsz = jpegSize(jpg);
      const jpgFile = path.join(OUT, `${dosyaAdi(s.name)}-jpeg.jpg`);
      fs.writeFileSync(jpgFile, jpg);
      check(`${ad}: JPEG kare tam ekran boyutunda`, jsz && jsz.w === s.w && jsz.h === s.h, jsz ? `${jsz.w}x${jsz.h} (${jpgFile})` : 'okunamadı');

      // Normalize -> fiziksel piksel eşlemesi (fare/kalem bu hesabı kullanır; fare hareket ETMEZ).
      const map = async (nx, ny) => JSON.parse((await helper.request(`map ${s.name} ${nx} ${ny}`)).toString());
      const a = await map(0, 0), b = await map(1, 1), c = await map(0.5, 0.5);
      check(`${ad}: eşleme sol üst köşe`, a.ok && a.name === s.name && a.x === s.x && a.y === s.y, JSON.stringify(a));
      check(`${ad}: eşleme sağ alt köşe`, b.ok && b.x === s.x + s.w - 1 && b.y === s.y + s.h - 1, JSON.stringify(b));
      check(`${ad}: eşleme orta`, c.ok && Math.abs(c.x - (s.x + (s.w - 1) / 2)) <= 1 && Math.abs(c.y - (s.y + (s.h - 1) / 2)) <= 1, JSON.stringify(c));

      // ffmpeg gdigrab: lib/video.js'in ürettiği bölgeyle aynı alanı yakalamalı.
      if (!ffmpeg) { console.log('     (ffmpeg yok, gdigrab atlandı)'); continue; }
      const p = { ...grabRegion(s, 100000), fps: 10 };
      const pngFile = path.join(OUT, `${dosyaAdi(s.name)}-gdigrab.png`);
      const g = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...gdigrabArgs(p), '-frames:v', '1', pngFile],
        { env: CHILD_ENV, timeout: 30000, windowsHide: true, encoding: 'utf8' });
      const png = g.status === 0 && fs.existsSync(pngFile) ? fs.readFileSync(pngFile) : null;
      const psz = png ? { w: png.readUInt32BE(16), h: png.readUInt32BE(20) } : null;
      check(`${ad}: gdigrab kare boyutu`, psz && psz.w === p.w && psz.h === p.h, psz ? `${psz.w}x${psz.h} (${pngFile})` : (g.stderr || '').trim());
      // İçerik: JPEG ile gdigrab aynı bölgeyi mi görüyor? (Yanlış bölgede ortalama fark çok büyür.)
      const k1 = kucukGri(['-i', jpgFile]);
      const k2 = png && kucukGri(['-i', pngFile]);
      if (k1 && k2) {
        const d = ortalamaFark(k1, k2);
        check(`${ad}: JPEG ve gdigrab aynı görüntü`, d < 12, `ortalama fark ${d.toFixed(1)}/255`);
      } else check(`${ad}: içerik karşılaştırması`, false, 'küçültülemedi');
    }

    // Birleşim = gdigrab'ın tüm masaüstü karesi (sanal masaüstü, fiziksel piksel).
    if (ffmpeg) {
      const minX = Math.min(...screens.map((s) => s.x)), minY = Math.min(...screens.map((s) => s.y));
      const maxX = Math.max(...screens.map((s) => s.x + s.w)), maxY = Math.max(...screens.map((s) => s.y + s.h));
      const allFile = path.join(OUT, 'masaustu-gdigrab.png');
      const g = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'gdigrab', '-framerate', '5', '-i', 'desktop', '-frames:v', '1', allFile],
        { env: CHILD_ENV, timeout: 30000, windowsHide: true });
      const png = g.status === 0 ? fs.readFileSync(allFile) : null;
      const w = png && png.readUInt32BE(16), h = png && png.readUInt32BE(20);
      check('tüm ekranların birleşimi gdigrab masaüstüyle aynı', w === maxX - minX && h === maxY - minY, `${w}x${h} / ${maxX - minX}x${maxY - minY}`);
    }

    if (screens.length < 2) console.log('     (tek ekran: ikinci ekran kontrolleri atlandı)');
    else {
      // Ekranlar üst üste binmemeli (ölçeklenmiş/sanal koordinatlarda ikinci ekran kayıyordu).
      let ust = false;
      for (const s of screens) for (const t of screens) if (s !== t && s.x < t.x + t.w && t.x < s.x + s.w && s.y < t.y + t.h && t.y < s.y + s.h) ust = true;
      check('ekranlar üst üste binmiyor', !ust);
    }

    // Geçersiz map: cevap verir, çökmez.
    const bad = JSON.parse((await helper.request('map \\\\.\\DISPLAY1 abc 2')).toString());
    check('geçersiz map reddedilir', bad.ok === false);
    const info2 = await helper.info();
    check('yardımcı hâlâ ayakta', Array.isArray(info2.screens));
    return screens;
  } finally {
    try { helper.proc.removeAllListeners('exit'); killTree(helper.proc.pid); } catch {} // yeniden başlatılmasın
  }
}

function wsTesti(helperScreens) {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL);
    const kuyruk = []; const bekle = [];
    ws.on('message', (d, bin) => {
      if (bin) return;
      const m = JSON.parse(d.toString());
      const i = bekle.findIndex((w) => w.pred(m));
      if (i >= 0) { const w = bekle.splice(i, 1)[0]; clearTimeout(w.timer); w.res(m); } else kuyruk.push(m);
    });
    const next = (pred, ms = 8000) => new Promise((res, rej) => { const w = { pred, res }; bekle.push(w); w.timer = setTimeout(() => rej(new Error('timeout')), ms); });
    const take = (pred, ms) => { const i = kuyruk.findIndex(pred); return i >= 0 ? Promise.resolve(kuyruk.splice(i, 1)[0]) : next(pred, ms); };
    const send = (o) => ws.send(JSON.stringify(o));
    (async () => {
      try {
        const hello = await take((m) => m.t === 'hello');
        send(hello.canSetup ? { t: 'setup', username: 'ekran', password: 'ekran1234' } : { t: 'login', username: 'ekran', password: 'ekran1234' });
        const auth = await take((m) => m.t === 'auth');
        check('WS: giriş yapıldı', auth.ok);
        const sc = auth.screens || [];
        check('WS: ekran listesi yardımcıyla aynı (fiziksel)', sc.length === helperScreens.length
          && sc.every((s, i) => s.name === helperScreens[i].name && s.w === helperScreens[i].w && s.x === helperScreens[i].x), `${sc.length} ekran`);
        check('WS: eski alanlar duruyor', sc.every((s) => typeof s.name === 'string' && typeof s.primary === 'boolean' && typeof s.label === 'string'));
        check('WS: okunur ad', sc.every((s, i) => s.virtual === false && s.title === `Ekran ${i + 1} (${s.w}×${s.h})`), sc.map((s) => s.title).join(', '));
        send({ t: 'start', mode: 'control', screen: sc[sc.length - 1].name });
        const st = await take((m) => m.t === 'started');
        check('WS: started ekranları okunur adlı', st.screen === sc[sc.length - 1].name && (st.screens || []).every((s) => typeof s.title === 'string'), st.screen);
        send({ t: 'stop' });
      } catch (e) {
        check('WS: protokol', false, e.message);
      } finally {
        try { ws.close(); } catch {}
        resolve();
      }
    })();
  });
}

(async () => {
  try {
    bolgeTestleri();
    const screens = await helperTestleri();
    await wsTesti(screens);
  } catch (e) {
    console.error('TEST HATASI', e);
    fails++;
  }
  console.log(fails ? `\n${fails} HATA` : '\nhepsi geçti');
  process.exit(fails ? 1 : 0);
})();
