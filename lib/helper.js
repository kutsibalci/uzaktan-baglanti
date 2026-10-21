// RemoteHelper.exe ile konuşan katman (ekran yakalama, giriş simülasyonu, onay penceresi)
// + yardımcı exe'lerin Windows tarafından engellenmesini algılama (Akıllı Uygulama Denetimi).
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { spawn, execFileSync, execFile } = require('child_process');

const ROOT = path.join(__dirname, '..');
const HELPER_DIR = path.join(ROOT, 'helper');
const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';

// Testler bir yardımcının yerine başka bir dosya verebilir: REMOTE_EXE_<AD> (ör. REMOTE_EXE_PANO=C:\...\bozuk.exe).
// Böyle bir dosya derlenmez; engel algılamayı sınamak için geçersiz bir exe (metin dosyası) verilir.
const exeOverride = (name) => process.env[`REMOTE_EXE_${name.toUpperCase()}`] || '';

// helper/<ad>.cs dosyasını Windows'un kendi C# derleyicisiyle derler (kaynak daha yeniyse) ve exe yolunu döner.
// target: 'exe' (konsol) ya da 'winexe' (pencereli, konsolsuz — ör. tepsi simgesi).
function buildExe(name, { target = 'exe', refs = ['System.Drawing.dll', 'System.Windows.Forms.dll'] } = {}) {
  if (exeOverride(name)) return exeOverride(name);
  const src = path.join(HELPER_DIR, `${name}.cs`);
  const exe = path.join(HELPER_DIR, `${name}.exe`);
  const needsBuild = !fs.existsSync(exe) || fs.statSync(exe).mtimeMs < fs.statSync(src).mtimeMs;
  if (needsBuild) {
    console.log(`Derleniyor: ${name}.cs`);
    execFileSync(CSC, ['/nologo', '/optimize', `/target:${target}`, `/out:${exe}`, ...refs.map((r) => `/r:${r}`), src], { stdio: 'inherit' });
  }
  return exe;
}
const build = () => buildExe('RemoteHelper');

// ---------- Engel algılama ----------
// Akıllı Uygulama Denetimi (SAC) açıkken imzasız, yeni derlenmiş exe'ler engellenebilir. O zaman CreateProcess başarısız
// olur: Node'da spawn eşzamanlı olarak UNKNOWN fırlatır (ya da 'error' olayında EACCES / EPERM gelir) veya süreç hemen bir
// ilke koduyla çıkar. Engellenen exe bu sunucu çalıştıkça BİR DAHA başlatılmaz (döngü yok); sunucu yeniden başlayınca bir kez
// daha denenir. Kayıtlar features/baslatma.js'te yönetim paneline ve günlüğe gider.
const OZELLIK = {
  RemoteHelper: 'uzaktan görüntü, fare/klavye ve yeni cihaz onay penceresi',
  Pano: 'pano eşitleme',
  Perde: 'gizlilik perdesi',
  Ses: 'bilgisayar sesini dinleme',
  Durum: 'bilgisayar durumu paneli',
  Tepsi: 'tepsi simgesi',
};
const ENGEL_HATA = new Set(['UNKNOWN', 'EACCES', 'EPERM']);
// 0xC0000428 STATUS_INVALID_IMAGE_HASH, 0xC0E90002 STATUS_SYSTEM_INTEGRITY_POLICY_VIOLATION,
// 1260 ERROR_ACCESS_DISABLED_BY_POLICY, 4551 ERROR_SYSTEM_INTEGRITY_POLICY_VIOLATION (0x800711C7 = HRESULT biçimi)
const ENGEL_CIKIS = new Set([0xC0000428, 0xC0E90002, 1260, 4551, 0x800711C7]);
const engeller = new Map(); // ad -> kayıt
const engelOlay = new EventEmitter();

// Akıllı Uygulama Denetimi durumu: 'acik' | 'deneme' | 'kapali' | null (okunamadı). Yönetici izni gerekmez.
let sacOnbellek;
function sacDurumu() {
  if (sacOnbellek !== undefined) return sacOnbellek;
  sacOnbellek = null;
  try {
    const out = execFileSync('reg', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy', '/v', 'VerifiedAndReputablePolicyState'],
      { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    const m = out.match(/VerifiedAndReputablePolicyState\s+REG_DWORD\s+0x([0-9a-f]+)/i);
    if (m) sacOnbellek = { 0: 'kapali', 1: 'acik', 2: 'deneme' }[parseInt(m[1], 16)] || null;
  } catch { /* değer yok: SAC hiç açılmamış ya da eski Windows */ }
  return sacOnbellek;
}

function engelMesaji(k) {
  if (k.politika) {
    return k.sac === 'acik'
      ? `Windows Akıllı Uygulama Denetimi ${k.dosya} dosyasını engelledi — ${k.ozellik} çalışmıyor.`
      : `Windows ${k.dosya} dosyasının çalışmasını engelledi (${k.kod}) — ${k.ozellik} çalışmıyor.`;
  }
  return `${k.dosya} başlatılamadı (${k.kod}) — ${k.ozellik} çalışmıyor. Dosya eksik ya da bozuk olabilir.`;
}

function engelKaydet(ad, exe, kod) {
  if (engeller.has(ad)) return engeller.get(ad);
  const politika = ENGEL_HATA.has(kod) || (typeof kod === 'number' && ENGEL_CIKIS.has(kod >>> 0));
  const k = {
    ad, exe: String(exe), dosya: path.basename(String(exe)), ozellik: OZELLIK[ad] || ad,
    kod: typeof kod === 'number' ? `çıkış kodu 0x${(kod >>> 0).toString(16).toUpperCase()}` : String(kod),
    politika, sac: sacDurumu(), zaman: Date.now(),
  };
  k.mesaj = engelMesaji(k);
  engeller.set(ad, k);
  console.warn(`UYARI: ${k.mesaj}${politika ? ' Ayrıntı ve seçenekler: Yönetim → "Başlatma ve Windows engelleri".' : ''}`);
  engelOlay.emit('engel', k);
  return k;
}
const engelli = (ad) => engeller.has(ad);

// Yardımcı exe'yi başlatır. Engellenmişse (şimdi ya da daha önce) null döner; çağıran özellik kapalı kalır.
// 'error' olayı (EACCES/EPERM/ENOENT) ve hemen ilke koduyla çıkış da engel olarak kaydedilir.
function spawnHelper(ad, exe, args = [], opts = {}) {
  if (engelli(ad)) return null;
  let p;
  try {
    p = spawn(exe, args, opts);
  } catch (e) {
    engelKaydet(ad, exe, e.code || 'UNKNOWN');
    return null;
  }
  const t0 = Date.now();
  p.once('error', (e) => engelKaydet(ad, exe, e.code || 'UNKNOWN'));
  p.once('exit', (code) => {
    if (typeof code === 'number' && ENGEL_CIKIS.has(code >>> 0) && Date.now() - t0 < 10000) engelKaydet(ad, exe, code);
  });
  return p;
}

// Code Integrity günlüğünden son engellemeler (3077 = engellendi, 3033 = imza düzeyi yetersiz). Yönetici gerekmez.
// Yalnızca bu klasörün helper\ exe'leri (başka kopyaların değil). Sonuç bir dakika önbellekte.
let ciOnbellek = { at: 0, list: null };
function ciOlaylari() {
  if (Date.now() - ciOnbellek.at < 60000 && ciOnbellek.list) return Promise.resolve(ciOnbellek.list);
  const komut = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; $ErrorActionPreference = 'Stop'; try { "
    + "@(Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-CodeIntegrity/Operational'; Id = 3077, 3033; StartTime = (Get-Date).AddDays(-7) } -MaxEvents 300 | "
    + "ForEach-Object { [pscustomobject]@{ z = $_.TimeCreated.ToUniversalTime().ToString('o'); id = $_.Id; dosya = [string]$_.Properties[1].Value; surec = [string]$_.Properties[3].Value } }) | ConvertTo-Json -Compress "
    + "} catch { if ($_.FullyQualifiedErrorId -match 'NoMatchingEventsFound') { '[]' } else { 'HATA ' + $_.Exception.Message } }";
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', komut],
      { encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 4 << 20 }, (err, out) => {
        const s = String(out || '').trim();
        if (err || !s || s.startsWith('HATA')) { resolve({ hata: (s || err?.message || 'okunamadı').replace(/^HATA /, '').slice(0, 200), list: [] }); return; }
        let arr;
        try { arr = JSON.parse(s); } catch { resolve({ hata: 'olaylar çözümlenemedi', list: [] }); return; }
        if (!Array.isArray(arr)) arr = [arr];
        // Olaydaki yol \Device\HarddiskVolumeN\Users\... biçiminde: sürücü harfi olmadan karşılaştırılır.
        const kok = (HELPER_DIR.replace(/^[a-z]:/i, '') + '\\').toLowerCase();
        const list = arr.filter((e) => e && typeof e.dosya === 'string' && e.dosya.toLowerCase().includes(kok))
          .map((e) => ({ zaman: Date.parse(e.z), olay: e.id, dosya: path.win32.basename(e.dosya), surec: path.win32.basename(e.surec || '') }))
          .slice(0, 20);
        const r = { list };
        ciOnbellek = { at: Date.now(), list: r };
        resolve(r);
      });
  });
}

class Helper {
  constructor() {
    this.exe = build();
    this.pending = [];
    this.buf = Buffer.alloc(0);
    this.start();
  }

  start() {
    const p = spawnHelper('RemoteHelper', this.exe, [], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
    this.proc = p;
    if (!p) { this.failAll(); return; } // engellendi: yeniden denenmez (engel kaydı uyarıyı verir)
    p.stdout.on('data', (chunk) => this.onData(chunk));
    p.stdin.on('error', () => {});
    p.on('error', () => {}); // engelKaydet işler; ardından 'exit' gelmeyebilir
    p.on('exit', (code) => {
      this.failAll();
      if (engelli('RemoteHelper')) return;
      console.warn(`Yardımcı program kapandı (kod ${code}), yeniden başlatılıyor...`);
      setTimeout(() => this.start(), 500);
    });
  }

  failAll() {
    for (const p of this.pending) p.reject(new Error('helper exited'));
    this.pending = [];
    this.buf = Buffer.alloc(0);
  }

  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 5) {
      const len = this.buf.readInt32LE(1);
      if (this.buf.length < 5 + len) break;
      const payload = Buffer.from(this.buf.subarray(5, 5 + len));
      this.buf = this.buf.subarray(5 + len);
      const p = this.pending.shift();
      if (p) p.resolve(payload);
    }
  }

  send(cmd) {
    if (this.proc?.stdin.writable) this.proc.stdin.write(cmd + '\n');
  }

  request(cmd) {
    if (engelli('RemoteHelper')) return Promise.reject(new Error('Yardımcı program (RemoteHelper.exe) Windows tarafından engellendi.'));
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.send(cmd);
    });
  }

  async info() {
    // Engelliyken giriş ve yönetim paneli çalışsın diye ekran listesi boş döner (görüntü yok, uyarı panelde).
    if (engelli('RemoteHelper')) return { screens: [] };
    const info = JSON.parse((await this.request('info')).toString());
    // Testler: REMOTE_EKRANLAR_SAHTE ekran dizilimini taklit eder (ör. tek monitörlü makinede iki ekranlı "Tüm ekranlar"):
    // '[{name,x,y,w,h,primary},...]' ya da böyle bir JSON dosyasının yolu (her seferinde okunur: test düzeni değiştirebilir).
    // Yakalama yardımcıya bu adlarla gider; bilinmeyen adı yardımcı ana ekran sayar.
    const sahte = process.env.REMOTE_EKRANLAR_SAHTE;
    if (sahte) info.screens = JSON.parse(sahte.startsWith('[') ? sahte : fs.readFileSync(sahte, 'utf8'));
    return info;
  }

  async setMode(screen, w, h) {
    return JSON.parse((await this.request(`setmode ${screen} ${w} ${h}`)).toString()).ok;
  }
}

// ---------- Yeni cihaz onayı ----------
// Bilgisayarda "İzin ver / Reddet" penceresi (RemoteHelper.exe ask) gösterir. Aynı istek bu bilgisayardaki tarayıcıdan da
// (yerel yönetici oturumu, features/baslatma.js) cevaplanabilir: pencere engellenmiş ya da açılamamışsa kullanıcı dışarıda
// kalmasın. İlk gelen cevap geçerlidir; süre dolarsa reddedilmiş sayılır.
const onaylar = new Map(); // id -> { id, baslik, mesaj, zaman, bitis, pencere, cevapla(bool) }
const onayOlay = new EventEmitter();
let onaySayac = 0;

function askHost(title, message, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const id = ++onaySayac;
    let bitti = false;
    let p = null;
    const kayit = { id, baslik: title, mesaj: message, zaman: Date.now(), bitis: Date.now() + timeoutMs, pencere: false };
    const cevapla = (ok, kaynak) => {
      if (bitti) return;
      bitti = true;
      clearTimeout(timer);
      onaylar.delete(id);
      if (p && p.exitCode === null) { try { p.kill(); } catch {} }
      onayOlay.emit('bitti', { id, ok, kaynak });
      resolve(ok);
    };
    kayit.cevapla = cevapla;
    const timer = setTimeout(() => cevapla(false, 'sure'), timeoutMs);
    onaylar.set(id, kayit);
    const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
    let exe = null;
    try { exe = build(); } catch { /* derlenemedi: yalnızca tarayıcıdan onay */ }
    p = exe && spawnHelper('RemoteHelper', exe, ['ask', b64(title), b64(message)], { stdio: 'ignore' });
    kayit.pencere = !!p;
    if (p) {
      // Pencerenin kendi cevabı: 0 = izin. Pencere kapanıp reddetmediyse (ör. açılamadı, çöktü, ilke kodu) tarayıcıdan cevap
      // beklenir: yerel yönetici ve bildirim bunu 'degisti' ile öğrenir.
      const kapandi = () => {
        if (bitti || !kayit.pencere) return;
        kayit.pencere = false;
        onayOlay.emit('degisti', kayit);
      };
      p.on('exit', (code) => { if (code === 0) cevapla(true, 'pencere'); else if (code === 1) cevapla(false, 'pencere'); else kapandi(); });
      p.on('error', kapandi);
    }
    onayOlay.emit('istek', kayit);
  });
}

module.exports = {
  Helper, askHost, buildExe, spawnHelper,
  engeller, engelOlay, engelli, sacDurumu, ciOlaylari,
  onaylar, onayOlay,
};
