// Ev ağı HTTPS'i için yerel sertifikalar: kendi kök sertifikamız (CA) + onunla imzalanmış sunucu sertifikası.
// Node'un crypto'su X.509 üretemediği için sertifika küçük bir DER/ASN.1 yazıcısıyla elle kurulur, crypto.sign ile imzalanır.
// Anahtarlar ECDSA P-256 (iOS, Android ve masaüstü tarayıcılar kabul eder; üretimi milisaniyeler sürer).
//
// Dosyalar <dataDir>/sertifika/ altında (repoya girmez; Windows'ta klasör yalnızca bu kullanıcıya açık):
//   ca-anahtar.pem, ca.pem, ca.json (CA'nın kısıtlı olduğu adlar), sunucu-anahtar.pem, sunucu.pem, ayar.json ({ acik })
//
// iOS kuralları (Apple, iOS 13+ — TLS sunucu sertifikası): SAN'da ad/IP olmalı (CN'ye bakılmaz), EKU serverAuth,
// geçerlilik ≤ 825 gün, SHA-2 imza, RSA ≥ 2048 ya da ECDSA. Kök CA 10 yıl.
// Güvenlik: CA "Name Constraints" ile yalnızca yerel adlara (localhost, *.local, bilgisayar adı) ve özel IP aralıklarına
// kısıtlıdır: anahtarı çalınsa bile internet sitelerini (ör. bir banka) taklit eden geçerli sertifika üretilemez
// (kısıtlamayı uygulayan sistemlerde: iOS/macOS, Chrome, Firefox, Windows).
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const GUN = 24 * 60 * 60 * 1000;
const CA_GUN = 3650;         // 10 yıl
const SUNUCU_GUN = 820;      // iOS sınırı 825 gün
const YENILE_GUN = 30;       // bitişine bu kadar kala sunucu sertifikası yenilenir
const ORG = 'Uzaktan Bağlantı';

// Sunucu sertifikasına girebilecek (ve CA'nın kısıtlı olduğu) IPv4 aralıkları: [adres, önek uzunluğu]
const OZEL_AGLAR = [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['100.64.0.0', 10], ['127.0.0.0', 8]];

// ---------- DER yazıcı ----------

function uzunluk(n) {
  if (n < 0x80) return Buffer.from([n]);
  const b = [];
  for (let x = n; x > 0; x = Math.floor(x / 256)) b.unshift(x & 0xff);
  return Buffer.from([0x80 | b.length, ...b]);
}
const tlv = (etiket, ...parcalar) => {
  const ic = Buffer.concat(parcalar.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
  return Buffer.concat([Buffer.from([etiket]), uzunluk(ic.length), ic]);
};
const seq = (...p) => tlv(0x30, ...p);
const set = (...p) => tlv(0x31, ...p);
const bool = (v) => tlv(0x01, [v ? 0xff : 0]);
const octet = (b) => tlv(0x04, b);
const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
const bitString = (b, kullanilmayan = 0) => tlv(0x03, [kullanilmayan], b);
const baglam = (n, ...p) => tlv(0xa0 + n, ...p); // [n] EXPLICIT / yapılı IMPLICIT

function tamsayi(b) {
  if (typeof b === 'number') b = Buffer.from([b]);
  let i = 0;
  while (i < b.length - 1 && b[i] === 0 && !(b[i + 1] & 0x80)) i++; // en kısa biçim
  b = b.subarray(i);
  return tlv(0x02, b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b);
}

function oid(s) {
  const p = s.split('.').map(Number);
  const out = [40 * p[0] + p[1]];
  for (const v of p.slice(2)) {
    const b = [v & 0x7f];
    for (let x = Math.floor(v / 128); x > 0; x = Math.floor(x / 128)) b.unshift(0x80 | (x & 0x7f));
    out.push(...b);
  }
  return tlv(0x06, out);
}

function zaman(d) {
  const iso = d.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z'; // YYYYMMDDHHMMSSZ
  return d.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(iso.slice(2))) : tlv(0x18, Buffer.from(iso));
}

const ad = (cn) => seq(set(seq(oid('2.5.4.10'), utf8(ORG))), set(seq(oid('2.5.4.3'), utf8(cn))));
const uzanti = (kimlik, kritik, deger) => seq(oid(kimlik), ...(kritik ? [bool(true)] : []), octet(deger));
const ipBaytlari = (ip) => Buffer.from(ip.split('.').map(Number));

function maske(onek) {
  const m = onek === 0 ? 0 : (0xffffffff << (32 - onek)) >>> 0;
  return Buffer.from([m >>> 24, (m >>> 16) & 0xff, (m >>> 8) & 0xff, m & 0xff]);
}
const ipSayi = (ip) => ip.split('.').reduce((a, x) => a * 256 + Number(x), 0);
const ozelMi = (ip) => net.isIPv4(ip) && OZEL_AGLAR.some(([a, n]) => (ipSayi(ip) >>> (32 - n)) === (ipSayi(a) >>> (32 - n)));

// DNS adı kısıtlamaya uyuyor mu (RFC 5280: kısıtlamanın soluna etiket eklenerek elde edilen adlar).
const adUyuyor = (isim, izinli) => izinli.some((k) => isim === k || isim.endsWith(`.${k}`));

const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'));
const anahtarKimligi = (pub) => {
  // SubjectKeyIdentifier: açık anahtar bit dizisinin SHA-1'i (RFC 5280 4.2.1.2, yöntem 1)
  const spki = pub.export({ type: 'spki', format: 'der' });
  const bits = spki.subarray(spki.length - 65); // P-256 sıkıştırılmamış nokta: 65 bayt
  return crypto.createHash('sha1').update(bits).digest();
};

function sertifika({ konu, yayinci, acik, imzaAnahtari, gun, uzantilar }) {
  const seri = crypto.randomBytes(16);
  seri[0] = (seri[0] & 0x7f) | 0x40; // pozitif, sıfırla başlamayan
  const simdi = Date.now();
  const tbs = seq(
    baglam(0, tamsayi(2)), // v3
    tamsayi(seri),
    ECDSA_SHA256,
    yayinci,
    seq(zaman(new Date(simdi - GUN)), zaman(new Date(simdi + gun * GUN))), // 1 gün geriden: saat farkı
    konu,
    acik.export({ type: 'spki', format: 'der' }),
    baglam(3, seq(...uzantilar)),
  );
  const imza = crypto.sign('sha256', tbs, imzaAnahtari); // ECDSA: DER (r, s)
  return seq(tbs, ECDSA_SHA256, bitString(imza));
}

const pem = (der, tur = 'CERTIFICATE') =>
  `-----BEGIN ${tur}-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${tur}-----\n`;

// ---------- Ad ve adresler ----------

const bilgisayarAdi = () => os.hostname();
// Sertifikaya girebilecek DNS adı: harf, rakam, tire (ör. "DESKTOP-ABC1234" -> "desktop-abc1234").
const dnsAdi = () => (/^[a-z0-9-]{1,63}$/i.test(bilgisayarAdi()) ? bilgisayarAdi().toLowerCase() : null);

// Bu bilgisayarın özel IPv4 adresleri (ev ağı, Tailscale, sanal ağlar) + 127.0.0.1. 169.254 (otomatik adres) alınmaz.
function yerelAdresler() {
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter((a) => a && a.family === 'IPv4' && ozelMi(a.address))
    .map((a) => a.address);
  return [...new Set(['127.0.0.1', ...ips])];
}

const sunucuAdlari = (izinli) => {
  const h = dnsAdi();
  return ['localhost', ...(h ? [h, `${h}.local`] : [])].filter((x) => adUyuyor(x, izinli));
};

// ---------- Üretim ----------

function caUret() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const h = dnsAdi();
  const izinli = ['localhost', 'local', ...(h ? [h] : [])];
  const adi = `Uzaktan Bağlantı Yerel CA — ${bilgisayarAdi()}`;
  const kisit = seq(baglam(0, // permittedSubtrees
    ...izinli.map((d) => seq(tlv(0x82, Buffer.from(d, 'ascii')))), // dNSName
    ...OZEL_AGLAR.map(([a, n]) => seq(tlv(0x87, ipBaytlari(a), maske(n)))), // iPAddress: adres + maske
  ));
  const der = sertifika({
    konu: ad(adi), yayinci: ad(adi), acik: publicKey, imzaAnahtari: privateKey, gun: CA_GUN,
    uzantilar: [
      uzanti('2.5.29.19', true, seq(bool(true), tamsayi(0))),  // basicConstraints: CA, pathLen 0
      uzanti('2.5.29.15', true, bitString(Buffer.from([0x06]), 1)), // keyUsage: keyCertSign, cRLSign
      uzanti('2.5.29.14', false, octet(anahtarKimligi(publicKey))),
      uzanti('2.5.29.30', true, kisit),                         // nameConstraints
    ],
  });
  return { der, anahtar: privateKey, meta: { ad: adi, izinli, olusturma: Date.now() } };
}

// adlar/ipler denetlenmez: çağıran CA kısıtlamasına uyanları verir (testler kısıta uymayanı da imzalatır).
function sunucuUret(ca, caAnahtar, meta, { adlar, ipler }) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const san = seq(...adlar.map((d) => tlv(0x82, Buffer.from(d, 'ascii'))), ...ipler.map((ip) => tlv(0x87, ipBaytlari(ip))));
  const der = sertifika({
    konu: ad(adlar[1] || 'localhost'), yayinci: ad(meta.ad), acik: publicKey, imzaAnahtari: caAnahtar, gun: SUNUCU_GUN,
    uzantilar: [
      uzanti('2.5.29.19', true, seq()),                                   // CA değil
      uzanti('2.5.29.15', true, bitString(Buffer.from([0x80]), 7)),        // keyUsage: digitalSignature
      uzanti('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))),           // EKU: serverAuth
      uzanti('2.5.29.17', false, san),                                     // subjectAltName
      uzanti('2.5.29.14', false, octet(anahtarKimligi(publicKey))),
      uzanti('2.5.29.35', false, seq(tlv(0x80, anahtarKimligi(ca.publicKey)))), // authorityKeyIdentifier
    ],
  });
  return { der, anahtar: privateKey };
}

// ---------- Dosyalar ----------

const dosyalar = (dir) => ({
  caAnahtar: path.join(dir, 'ca-anahtar.pem'), ca: path.join(dir, 'ca.pem'), caMeta: path.join(dir, 'ca.json'),
  anahtar: path.join(dir, 'sunucu-anahtar.pem'), sunucu: path.join(dir, 'sunucu.pem'), ayar: path.join(dir, 'ayar.json'),
});

function klasorHazirla(dir) {
  if (fs.existsSync(dir)) return;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Windows: klasörün izinleri devralınmaz, yalnızca bu kullanıcı erişir (içindeki dosyalar bunu devralır).
  if (process.platform === 'win32' && process.env.USERNAME) {
    const kim = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME;
    spawnSync('icacls', [dir, '/inheritance:r', '/grant:r', `${kim}:(OI)(CI)F`], { windowsHide: true, stdio: 'ignore', timeout: 10000 });
  }
}

function yaz(dosya, icerik) {
  const tmp = `${dosya}.tmp`;
  fs.writeFileSync(tmp, icerik, { mode: 0o600 });
  fs.renameSync(tmp, dosya);
}

function oku(dir) {
  const f = dosyalar(dir);
  try {
    const ca = new crypto.X509Certificate(fs.readFileSync(f.ca));
    const caAnahtar = crypto.createPrivateKey(fs.readFileSync(f.caAnahtar));
    const meta = JSON.parse(fs.readFileSync(f.caMeta, 'utf8'));
    let sunucu = null;
    try {
      sunucu = { x509: new crypto.X509Certificate(fs.readFileSync(f.sunucu)), cert: fs.readFileSync(f.sunucu, 'utf8'), key: fs.readFileSync(f.anahtar, 'utf8') };
    } catch { /* yeniden üretilecek */ }
    return { ca, caAnahtar, meta, sunucu };
  } catch {
    return null;
  }
}

// Sunucu sertifikası yenilenmeli mi: yok, başka CA'nın, süresi bitiyor ya da şu anki bir ad/IP içinde yok.
function sunucuEskiMi(d, adresler) {
  const s = d.sunucu?.x509;
  if (!s || !s.checkIssued(d.ca) || !s.verify(d.ca.publicKey)) return true;
  if (Date.parse(s.validTo) - Date.now() < YENILE_GUN * GUN) return true;
  const san = s.subjectAltName || '';
  return [...sunucuAdlari(d.meta.izinli).map((x) => `DNS:${x}`), ...adresler.filter(ozelMi).map((x) => `IP Address:${x}`)]
    .some((x) => !san.split(', ').includes(x));
}

// CA'yı (yoksa) ve sunucu sertifikasını (gerekirse) üretir. Dönen: { key, cert, ca, yeniCa, yeniSunucu }
function hazirla(dir, { adresler = yerelAdresler(), yeniCa = false } = {}) {
  klasorHazirla(dir);
  const f = dosyalar(dir);
  let d = yeniCa ? null : oku(dir);
  let caUretildi = false;
  if (!d) {
    const ca = caUret();
    yaz(f.caAnahtar, ca.anahtar.export({ type: 'pkcs8', format: 'pem' }));
    yaz(f.caMeta, JSON.stringify(ca.meta, null, 2));
    yaz(f.ca, pem(ca.der));
    for (const x of [f.sunucu, f.anahtar]) fs.rmSync(x, { force: true });
    d = oku(dir);
    caUretildi = true;
  }
  let sunucuUretildi = false;
  if (sunucuEskiMi(d, adresler)) {
    const s = sunucuUret(d.ca, d.caAnahtar, d.meta, { adlar: sunucuAdlari(d.meta.izinli), ipler: adresler.filter(ozelMi) });
    yaz(f.anahtar, s.anahtar.export({ type: 'pkcs8', format: 'pem' }));
    yaz(f.sunucu, pem(s.der));
    d = oku(dir);
    sunucuUretildi = true;
  }
  return { key: d.sunucu.key, cert: d.sunucu.cert, ca: d.ca, meta: d.meta, sunucu: d.sunucu.x509, yeniCa: caUretildi, yeniSunucu: sunucuUretildi };
}

// Sertifikaları siler (ayar.json kalır).
function sil(dir) {
  const f = dosyalar(dir);
  for (const k of ['caAnahtar', 'ca', 'caMeta', 'anahtar', 'sunucu']) fs.rmSync(f[k], { force: true });
}

function ayarOku(dir) {
  try { return JSON.parse(fs.readFileSync(dosyalar(dir).ayar, 'utf8')); } catch { return {}; }
}
function ayarYaz(dir, ayar) {
  klasorHazirla(dir);
  yaz(dosyalar(dir).ayar, JSON.stringify(ayar));
}

// ---------- iOS yapılandırma profili ----------
// com.apple.security.root yükü: kök sertifikayı "güvenilen kök" olarak yükler. Profil imzasızdır (iOS "Doğrulanmamış" der).
// Kurulduktan sonra Ayarlar > Genel > Hakkında > Sertifika Güven Ayarları'nda tam güven ayrıca açılmalıdır.
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function uuid(tohum) {
  const h = crypto.createHash('sha256').update(tohum).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`.toUpperCase();
}

function mobileconfig(ca, meta) {
  const der = ca.raw;
  const parmak = ca.fingerprint256.replace(/:/g, '');
  // Kimlik bilgisayara göre sabit: yeni CA'lı profil eskisinin yerine geçer.
  const kimlik = `yerel.uzaktan-baglanti.${(dnsAdi() || 'bilgisayar')}`;
  const b64 = der.toString('base64').match(/.{1,52}/g).join('\n\t\t\t');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>PayloadContent</key>
	<array>
		<dict>
			<key>PayloadCertificateFileName</key>
			<string>uzaktan-baglanti-ca.cer</string>
			<key>PayloadContent</key>
			<data>
			${b64}
			</data>
			<key>PayloadDescription</key>
			<string>Bu bilgisayarın ev ağındaki HTTPS adresi için kök sertifika.</string>
			<key>PayloadDisplayName</key>
			<string>${xml(meta.ad)}</string>
			<key>PayloadIdentifier</key>
			<string>${kimlik}.ca</string>
			<key>PayloadType</key>
			<string>com.apple.security.root</string>
			<key>PayloadUUID</key>
			<string>${uuid(`ca ${parmak}`)}</string>
			<key>PayloadVersion</key>
			<integer>1</integer>
		</dict>
	</array>
	<key>PayloadDescription</key>
	<string>Uzaktan Bağlantı: ${xml(bilgisayarAdi())} bilgisayarına ev ağında şifreli (HTTPS) bağlanmak için. Yalnızca yerel adlar ve ev ağı adresleri için geçerlidir. SHA-256: ${parmak}</string>
	<key>PayloadDisplayName</key>
	<string>${xml(meta.ad)}</string>
	<key>PayloadIdentifier</key>
	<string>${kimlik}</string>
	<key>PayloadOrganization</key>
	<string>${xml(ORG)}</string>
	<key>PayloadRemovalDisallowed</key>
	<false/>
	<key>PayloadType</key>
	<string>Configuration</string>
	<key>PayloadUUID</key>
	<string>${uuid(`profil ${parmak}`)}</string>
	<key>PayloadVersion</key>
	<integer>1</integer>
</dict>
</plist>
`;
}

// _imzala: yalnızca testler için (CA kısıtlamasının gerçekten uygulandığını denemek: kısıta uymayan sertifika imzalatır).
const _imzala = (dir, adlar, ipler) => {
  const d = oku(dir);
  const s = sunucuUret(d.ca, d.caAnahtar, d.meta, { adlar, ipler });
  return { cert: pem(s.der), key: s.anahtar.export({ type: 'pkcs8', format: 'pem' }) };
};

module.exports = { hazirla, oku, sil, ayarOku, ayarYaz, mobileconfig, yerelAdresler, ozelMi, pem, SUNUCU_GUN, CA_GUN, _imzala };
