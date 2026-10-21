// Windows ağ profilleri (Ortak / Özel / Etki alanı): bilgisayarın hangi yerel adresi hangi ağda.
// "Ortak ağdan ev ağı girişini kapat" ayarı (server.js allowed) bağlantının geldiği yerel adresin profiline bakar:
// okul, kafe, otel ağları Windows'ta genelde "Ortak"tır; oradan gelen ev ağı bağlantıları reddedilir.
// Get-NetConnectionProfile yönetici izni istemez; PowerShell'in açılışı birkaç saniye sürdüğü için profil yalnızca adres
// değişince (5 sn'de bir bakılır), reddetmeden önce bilgi eskiyse ve 5 dakikada bir yenilenir. Adresler Node'dan
// (os.networkInterfaces'teki ad = Windows'taki InterfaceAlias).
// REMOTE_AG_PROFILI_SAHTE='{"10.0.0.5":"Public","*":"Private"}': PowerShell çalıştırılmaz, bu harita kullanılır (testler).
const os = require('os');
const { execFile } = require('child_process');

const PS = "$ErrorActionPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; "
  + 'ConvertTo-Json -Compress -InputObject @(Get-NetConnectionProfile | ForEach-Object { [pscustomobject]@{ arayuz=[string]$_.InterfaceAlias; ad=[string]$_.Name; k=[string]$_.NetworkCategory } })';
const KATEGORILER = new Set(['Public', 'Private', 'DomainAuthenticated']);

const normalize = (ip) => (ip && ip.startsWith('::ffff:') ? ip.slice(7) : ip || '');

let liste = [];          // [{ ip, arayuz, ad, k }]
let harita = new Map();  // ip -> 'Public' | 'Private' | 'DomainAuthenticated' | null
let yuklendi = false;
let sonYenileme = 0;
let suruyor = null;

function sahte() {
  try { return process.env.REMOTE_AG_PROFILI_SAHTE ? JSON.parse(process.env.REMOTE_AG_PROFILI_SAHTE) : null; } catch { return {}; }
}

// Profilleri PowerShell'den okur (yalnızca okuma), adreslerle eşler; profili olmayan adreste k: null. Hata olursa boş liste.
function powershellOku() {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS], { timeout: 20000, windowsHide: true, encoding: 'utf8' }, (err, out) => {
      if (err) return resolve([]);
      let profiller;
      try { profiller = [].concat(JSON.parse(String(out).trim() || '[]')).filter(Boolean); } catch { return resolve([]); }
      const l = [];
      for (const [arayuz, adresler] of Object.entries(os.networkInterfaces())) {
        const p = profiller.find((x) => x.arayuz === arayuz);
        for (const a of adresler) if (a.family === 'IPv4') l.push({ ip: a.address, arayuz, ad: p?.ad || null, k: KATEGORILER.has(p?.k) ? p.k : null });
      }
      resolve(l);
    });
  });
}

function yenile() {
  if (suruyor) return suruyor;
  sonYenileme = Date.now();
  const s = sahte();
  suruyor = (s ? Promise.resolve(Object.entries(s).filter(([ip]) => ip !== '*').map(([ip, k]) => ({ ip, arayuz: 'sahte', ad: null, k })))
    : powershellOku()).then((l) => {
    liste = l;
    harita = new Map(l.map((x) => [x.ip, x.k]));
    yuklendi = true;
    suruyor = null;
    return liste;
  });
  return suruyor;
}

// Bu yerel adres Ortak ağda mı? İlk okuma bitmeden "evet" (açılıştaki ~1 sn'de ev ağı girişi yok);
// okunamayan/profili olmayan adres "hayır" (ör. WSL sanal ağı) — güvenlik duvarından sonraki ikinci katman.
function ortakMi(yerelIp) {
  const s = sahte();
  const ip = normalize(yerelIp);
  if (s) return (ip in s ? s[ip] : s['*']) === 'Public';
  if (!yuklendi) { yenile(); return true; }
  if (!harita.has(ip)) { if (Date.now() - sonYenileme > 10000) yenile(); return false; }
  const ortak = harita.get(ip) === 'Public';
  // Reddederken bilgi eskiyse yenile: ağ az önce Özel yapıldıysa sonraki istek geçer.
  if (ortak && Date.now() - sonYenileme > 10000) yenile();
  return ortak;
}

// Yönetim paneli için: profili bilinen ağlar (Tailscale ve geri döngü hariç).
const ozet = () => liste.filter((x) => x.k && x.arayuz !== 'Tailscale' && !x.ip.startsWith('127.'));

let adresAnahtari = '';
function adresler() {
  return Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4').map((a) => a.address).sort().join(',');
}
function izle() {
  adresAnahtari = adresler();
  setInterval(() => {
    const a = adresler();
    if (a !== adresAnahtari) { adresAnahtari = a; yenile(); }
  }, 5000).unref();
  setInterval(yenile, 5 * 60000).unref();
  return yenile();
}

module.exports = { ortakMi, yenile, izle, ozet, powershellOku };
