// Ev ağı HTTPS'i: lib/sertifika.js'in ürettiği kök sertifika (CA) ve sunucu sertifikası, Name Constraints'in gerçekten
// uygulandığı, Windows/.NET zincir doğrulaması (CA kullanıcının deposuna YAZILMAZ: ExtraStore + bilinmeyen kök izni),
// test sunucusunun HTTPS dinleyicisi (aynı istek işleyici + aynı WebSocket sunucusu, istemci sınıflandırması),
// oturumsuz indirme uçları (.mobileconfig, .cer), güven yoklaması (CORS) ve yönetici işlemleri (kapat/aç/yeniden üret/sil).
// Gerçek iPhone/iPad'de profil kurulumu burada denenemez.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const tls = require('tls');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const WebSocket = require(path.join(ROOT, 'node_modules', 'ws'));
const sertifika = require(path.join(ROOT, 'lib', 'sertifika'));
const PORT = Number(process.env.TEST_PORT || 3999);
const TMP = process.env.TEST_TMP || fs.mkdtempSync(path.join(os.tmpdir(), 'rc-sert-'));
const GUN = 24 * 60 * 60 * 1000;

let pass = 0, fail = 0;
const check = (n, c, x = '') => { console.log(`${c ? 'OK  ' : 'FAIL'} ${n} ${x}`); c ? pass++ : fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function istek(url, { ca, headers = {} } = {}) {
  const mod = url.startsWith('https:') ? https : http;
  return new Promise((resolve, reject) => {
    const r = mod.get(url, { ca, headers, agent: false }, (res) => {
      const parca = [];
      res.on('data', (d) => parca.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parca), sock: res.socket }));
    });
    r.on('error', reject);
    r.setTimeout(8000, () => r.destroy(new Error('zaman aşımı')));
  });
}
const json = async (url, o) => JSON.parse((await istek(url, o)).body.toString());
const hataKodu = (p) => p.then(() => null, (e) => e.code || e.message);

function wsAc(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, opts);
    const kuyruk = [];
    const bekleyen = [];
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      const i = bekleyen.findIndex((b) => b.f(m));
      if (i >= 0) bekleyen.splice(i, 1)[0].r(m); else kuyruk.push(m);
    });
    ws.bekle = (f, ms = 8000) => new Promise((r, j) => {
      const i = kuyruk.findIndex(f);
      if (i >= 0) return r(kuyruk.splice(i, 1)[0]);
      const b = { f, r };
      bekleyen.push(b);
      setTimeout(() => { const k = bekleyen.indexOf(b); if (k >= 0) { bekleyen.splice(k, 1); j(new Error('mesaj gelmedi')); } }, ms);
    });
    ws.gonder = (o) => ws.send(JSON.stringify(o));
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

// PowerShell (.NET Framework) X509Chain: CA geçici olarak ExtraStore'a konur, kullanıcının sertifika deposuna YAZILMAZ.
function zincir(caDosya, sunucuDosya) {
  const betik = path.join(TMP, 'zincir.ps1');
  fs.writeFileSync(betik, `param($ca, $leaf)
$c = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 -ArgumentList $ca
$l = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 -ArgumentList $leaf
$ch = New-Object System.Security.Cryptography.X509Certificates.X509Chain
$ch.ChainPolicy.RevocationMode = 'NoCheck'
$null = $ch.ChainPolicy.ExtraStore.Add($c)
$ch.ChainPolicy.VerificationFlags = 'AllowUnknownCertificateAuthority'
$null = $ch.ChainPolicy.ApplicationPolicy.Add((New-Object System.Security.Cryptography.Oid '1.3.6.1.5.5.7.3.1'))
$ok = $ch.Build($l)
$els = @($ch.ChainElements | % { @{ t = $_.Certificate.Thumbprint; s = @($_.ChainElementStatus | % { [string]$_.Status }) } })
@{ ok = $ok; els = $els } | ConvertTo-Json -Depth 4 -Compress
`);
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', betik, caDosya, sunucuDosya], { encoding: 'utf8', timeout: 60000 });
  try { return JSON.parse(r.stdout.trim()); } catch { return { hata: r.stdout + r.stderr }; }
}

(async () => {
  // ---------------- 1. Üretim (lib/sertifika.js) ----------------
  const dir = path.join(TMP, 'sertifika'); // yok: klasör izinleri kısıtlanarak oluşturulur
  const t0 = Date.now();
  const r = sertifika.hazirla(dir);
  check('CA ve sunucu sertifikası üretildi', r.yeniCa && r.yeniSunucu, `(${Date.now() - t0} ms)`);
  const ca = r.ca, s = r.sunucu;
  check('CA: kök (CA:TRUE), kendi kendini imzalıyor', ca.ca === true && ca.verify(ca.publicKey) && ca.checkIssued(ca));
  check('CA adı "Uzaktan Bağlantı Yerel CA — <bilgisayar adı>"', ca.subject.includes(`CN=Uzaktan Bağlantı Yerel CA — ${os.hostname()}`), ca.subject.replace(/\n/g, ', '));
  const caGun = (Date.parse(ca.validTo) - Date.parse(ca.validFrom)) / GUN;
  check('CA geçerliliği ~10 yıl', caGun >= 3650 && caGun <= 3652, `(${caGun} gün)`);
  check('CA ECDSA P-256', ca.publicKey.asymmetricKeyType === 'ec' && ca.publicKey.asymmetricKeyDetails.namedCurve === 'prime256v1');
  check('sunucu: CA değil, CA tarafından imzalı (x509.verify(caPublicKey))', s.ca === false && s.checkIssued(ca) && s.verify(ca.publicKey));
  check('sunucu: EKU serverAuth', (s.keyUsage || []).includes('1.3.6.1.5.5.7.3.1'), JSON.stringify(s.keyUsage));
  const sunGun = (Date.parse(s.validTo) - Date.parse(s.validFrom)) / GUN;
  check('sunucu: geçerlilik ≤ 825 gün (iOS kuralı)', sunGun <= 825 && Date.parse(s.validFrom) <= Date.now(), `(${sunGun} gün)`);
  const san = s.subjectAltName.split(', ');
  const host = os.hostname().toLowerCase();
  const ipler = sertifika.yerelAdresler();
  check('SAN: localhost, bilgisayar adı, ad.local', ['localhost', host, `${host}.local`].every((x) => san.includes(`DNS:${x}`)), s.subjectAltName);
  check('SAN: tüm yerel IPv4 adresleri + 127.0.0.1', ipler.includes('127.0.0.1') && ipler.every((x) => san.includes(`IP Address:${x}`)), ipler.join(','));
  check('SAN: 169.254 (otomatik adres) ve genel IP girmez', !san.some((x) => /IP Address:(169\.254\.|8\.8\.)/.test(x)));
  check('Node: ad ve IP denetimi (checkHost / checkIP)', s.checkHost('localhost') === 'localhost' && s.checkIP('127.0.0.1') === '127.0.0.1' && !s.checkHost('example.com'));
  const anahtar = crypto.createPrivateKey(r.key);
  check('sunucu anahtarı sertifikayla eşleşiyor', crypto.createPublicKey(anahtar).export({ type: 'spki', format: 'der' }).equals(s.publicKey.export({ type: 'spki', format: 'der' })));
  const dosyalar = fs.readdirSync(dir).sort();
  check('dosyalar: CA ve sunucu anahtarı + sertifikalar', ['ca-anahtar.pem', 'ca.json', 'ca.pem', 'sunucu-anahtar.pem', 'sunucu.pem'].every((f) => dosyalar.includes(f)), dosyalar.join(','));
  if (process.platform === 'win32') {
    const acl = spawnSync('icacls', [dir], { encoding: 'utf8' }).stdout;
    const satirlar = acl.split(/\r?\n/).filter((l) => /:\(/.test(l));
    check('klasör izinleri: devralma yok, yalnızca bu kullanıcı', satirlar.length === 1 && !/\(I\)/.test(acl) && acl.includes(process.env.USERNAME), satirlar.map((l) => l.trim()).join(' | '));
  }

  const r2 = sertifika.hazirla(dir);
  check('tekrar: hiçbir şey yeniden üretilmez', !r2.yeniCa && !r2.yeniSunucu && r2.sunucu.fingerprint256 === s.fingerprint256);
  const r3 = sertifika.hazirla(dir, { adresler: [...ipler, '10.77.0.5', '8.8.8.8'] });
  check('IP değişti (DHCP): sunucu sertifikası aynı CA ile yeniden imzalandı', !r3.yeniCa && r3.yeniSunucu && r3.ca.fingerprint256 === ca.fingerprint256
    && r3.sunucu.subjectAltName.includes('IP Address:10.77.0.5') && !r3.sunucu.subjectAltName.includes('8.8.8.8') && r3.sunucu.verify(ca.publicKey));
  const r4 = sertifika.hazirla(dir, { adresler: ['127.0.0.1'] });
  check('bir adres kaybolunca yeniden imzalanmaz', !r4.yeniSunucu);

  // .mobileconfig
  const mc = sertifika.mobileconfig(ca, r.meta);
  const dataB64 = /<key>PayloadContent<\/key>\s*<data>([\s\S]*?)<\/data>/.exec(mc);
  check('.mobileconfig: içindeki DER = CA', !!dataB64 && Buffer.from(dataB64[1].replace(/\s+/g, ''), 'base64').equals(ca.raw));
  check('.mobileconfig: com.apple.security.root + Configuration', mc.includes('<string>com.apple.security.root</string>') && mc.includes('<string>Configuration</string>'));

  // ---------------- 2. Windows/.NET zincir doğrulaması ----------------
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(TMP, 'ca.cer'), ca.raw);
    fs.writeFileSync(path.join(TMP, 'sunucu.cer'), r3.sunucu.raw);
    const z = zincir(path.join(TMP, 'ca.cer'), path.join(TMP, 'sunucu.cer'));
    const kok = z.els?.at(-1);
    check('.NET X509Chain: zincir kuruldu, kök = bizim CA, tek uyarı "UntrustedRoot" (depoda olmadığı için)',
      z.ok === true && z.els.length === 2 && kok.t === crypto.createHash('sha1').update(ca.raw).digest('hex').toUpperCase()
      && z.els[0].s.length === 0 && kok.s.join() === 'UntrustedRoot', JSON.stringify(z));
    // CA'ya GERÇEKTEN güvenerek (yalnızca bu zincir için; depo değişmez): .NET 8+ CustomTrustStore. Windows PowerShell 5.1'in
    // .NET Framework'ünde bu yok; dotnet SDK (10+, tek dosyalı "dotnet run x.cs") kuruluysa çalışır, yoksa atlanır.
    const kotu = sertifika._imzala(dir, ['www.ornek-banka.com'], ['8.8.8.8']);
    fs.writeFileSync(path.join(TMP, 'kotu.cer'), new crypto.X509Certificate(kotu.cert).raw);
    const dn = spawnSync('dotnet', ['run', path.join(__dirname, 'sertifika-zincir.cs'), '--', path.join(TMP, 'ca.cer'), path.join(TMP, 'sunucu.cer'), path.join(TMP, 'kotu.cer')], {
      encoding: 'utf8', timeout: 150000, env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1' },
    });
    const satir = (dn.stdout || '').trim().split(/\r?\n/).filter((l) => /^(True|False)\|/.test(l));
    if (dn.error || satir.length !== 2) {
      console.log(`OK   (atlandı) .NET CustomTrustStore doğrulaması — dotnet SDK 10+ yok ya da derlenemedi: ${(dn.error?.message || dn.stderr || dn.stdout || '').trim().slice(0, 200)}`);
    } else {
      const caSha1 = crypto.createHash('sha1').update(ca.raw).digest('hex').toUpperCase();
      check('.NET X509Chain (CustomTrustStore, CA geçici güvenilen kök): sunucu sertifikası GEÇTİ', satir[0] === `True|2|${caSha1}|`, satir[0]);
      check('.NET X509Chain: CA ile imzalanmış "www.ornek-banka.com" + 8.8.8.8 Name Constraints yüzünden reddedildi',
        satir[1].startsWith('False|') && /HasNotPermittedNameConstraint/.test(satir[1]), satir[1]);
    }
  }

  // Node/OpenSSL: kısıta uymayan sertifikayla TLS bağlantısı kurulamaz
  {
    const kotu = sertifika._imzala(dir, ['www.ornek-banka.com'], []);
    const srv = tls.createServer({ key: kotu.key, cert: kotu.cert }, (c) => c.end());
    await new Promise((res) => srv.listen(0, '127.0.0.1', res));
    const e = await new Promise((res) => {
      const c = tls.connect({ port: srv.address().port, host: '127.0.0.1', servername: 'www.ornek-banka.com', ca: sertifika.pem(ca.raw) },
        () => { res(null); c.end(); });
      c.on('error', (er) => res(er.message));
    });
    srv.close();
    check('OpenSSL: "www.ornek-banka.com" sertifikası reddedildi (CA çalınsa bile site taklit edilemez)', !!e && /subtree|name constraint/i.test(e), String(e));
  }

  // ---------------- 3. Test sunucusu: HTTPS dinleyicisi ----------------
  let d = await json(`http://localhost:${PORT}/api/sertifika/durum`);
  check('durum: HTTPS açık (ilk açılışta kendiliğinden), port verildi', d.acik === true && d.port > 0, JSON.stringify(d));
  check('durum: önerilen adres sayfanın adıyla (localhost)', d.adres === `https://localhost:${d.port}`, d.adres);
  // Sertifikada olmayan adla açılan sayfa (ör. tailscale serve'ün *.ts.net adı): checkIP ada istisna atıyordu ('Invalid name', 500)
  const yabanci = await istek(`http://localhost:${PORT}/api/sertifika/durum`, { headers: { Host: `bilgisayar.ornek.ts.net:${PORT}` } });
  const yd = yabanci.status === 200 ? JSON.parse(yabanci.body) : {};
  check('durum: sertifikada olmayan adla (Host *.ts.net) 200, önerilen adres ev ağı IP\'si ya da localhost',
    yabanci.status === 200 && /^https:\/\/((\d+\.){3}\d+|localhost):\d+$/.test(yd.adres || ''), `${yabanci.status} ${yabanci.body.toString().slice(0, 120)}`);
  const HP = d.port;
  const cer = await istek(`http://localhost:${PORT}/api/sertifika/ca.cer`);
  check('ca.cer oturumsuz indirilir (DER, application/x-x509-ca-cert)', cer.status === 200 && cer.headers['content-type'] === 'application/x-x509-ca-cert');
  const sCa = new crypto.X509Certificate(cer.body);
  const caPem = sertifika.pem(sCa.raw);
  check('ca.cer: kök sertifika, parmak izi durumdakiyle aynı', sCa.ca && sCa.fingerprint256 === d.parmakIzi);
  const mob = await istek(`http://localhost:${PORT}/api/sertifika/ca.mobileconfig`);
  check('ca.mobileconfig oturumsuz indirilir (application/x-apple-aspen-config)', mob.status === 200 && mob.headers['content-type'] === 'application/x-apple-aspen-config');
  const mobXml = mob.body.toString('utf8');
  const mobDer = /<data>([\s\S]*?)<\/data>/.exec(mobXml);
  check('mobileconfig içindeki DER = indirilen CA', !!mobDer && Buffer.from(mobDer[1].replace(/\s+/g, ''), 'base64').equals(cer.body));
  if (process.platform === 'win32') {
    // Geçerli XML mi (System.Xml; DTD indirilmez) + plist kökü + iki PayloadType
    const xf = path.join(TMP, 'profil.mobileconfig');
    fs.writeFileSync(xf, mob.body);
    const ps = spawnSync('powershell.exe', ['-NoProfile', '-Command', `$s = New-Object System.Xml.XmlReaderSettings; $s.DtdProcessing = 'Ignore'; $s.XmlResolver = $null;
      $r = [System.Xml.XmlReader]::Create('${xf.replace(/'/g, "''")}', $s); $x = New-Object System.Xml.XmlDocument; $x.Load($r); $r.Close();
      $t = $x.SelectNodes("//key[.='PayloadType']/following-sibling::string[1]") | % { $_.InnerText };
      "$($x.DocumentElement.Name) $($x.DocumentElement.version) $($t -join ',')"`], { encoding: 'utf8' });
    check('mobileconfig geçerli plist XML (System.Xml ayrıştırdı)', ps.stdout.trim() === 'plist 1.0 com.apple.security.root,Configuration', (ps.stdout + ps.stderr).trim());
  }

  // HTTPS: yalnızca indirilen CA'ya güvenerek
  const sayfa = await istek(`https://localhost:${HP}/`, { ca: caPem });
  check('HTTPS: aynı uygulama (index.html), sertifika CA ile doğrulandı', sayfa.status === 200 && sayfa.body.toString().includes('Uzaktan Bağlantı') && sayfa.sock.authorized !== false);
  const peer = sayfa.sock.getPeerX509Certificate?.();
  check('HTTPS: sunucunun gösterdiği sertifika CA tarafından imzalı', !!peer && peer.verify(sCa.publicKey));
  check('HTTPS: CA verilmeden bağlantı reddedilir (güvenilmeyen kök)', !!(await hataKodu(istek(`https://localhost:${HP}/`))));
  const lan = ipler.find((x) => x.startsWith('192.168.')) || ipler.find((x) => x !== '127.0.0.1');
  const lanVia = lan && /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(lan) ? 'tailscale' : 'lan';
  if (lan) {
    const lanSayfa = await istek(`https://${lan}:${HP}/api/sertifika/durum`, { ca: caPem }).catch((e) => ({ status: 0, body: Buffer.from(e.message) }));
    const ld = lanSayfa.status === 200 ? JSON.parse(lanSayfa.body) : {};
    check(`HTTPS ev ağı adresiyle (${lan}): sertifika IP için geçerli, önerilen adres aynı IP`, lanSayfa.status === 200 && ld.adres === `https://${lan}:${HP}`, lanSayfa.body.toString().slice(0, 200));
    const hd = await json(`http://${lan}:${PORT}/api/sertifika/durum`);
    check('HTTP ev ağı sayfası için önerilen HTTPS adresi aynı IP', hd.adres === `https://${lan}:${HP}`, hd.adres);
  }

  // Güven yoklaması (CORS): yalnızca bu sunucunun HTTP sayfası okuyabilir
  const yk = await istek(`https://localhost:${HP}/api/sertifika/yokla`, { ca: caPem, headers: { Origin: `http://localhost:${PORT}` } });
  check('yokla: kendi HTTP sayfasına CORS izni', yk.status === 200 && yk.headers['access-control-allow-origin'] === `http://localhost:${PORT}`);
  const yk2 = await istek(`https://localhost:${HP}/api/sertifika/yokla`, { ca: caPem, headers: { Origin: 'http://kotu-site.example' } });
  check('yokla: yabancı siteye CORS izni yok', !yk2.headers['access-control-allow-origin']);

  // WebSocket giriş akışı HTTPS üzerinden (aynı WebSocket sunucusu); istemci sınıflandırması
  const w = await wsAc(`wss://localhost:${HP}`, { ca: caPem });
  const hello = await w.bekle((m) => m.t === 'hello');
  check('wss://localhost: hello, bu bilgisayar sayıldı (ilk kurulum yapılabilir)', hello.canSetup === true, JSON.stringify(hello));
  w.gonder({ t: 'setup', username: 'deneme', password: 'deneme123', remember: false, deviceName: 'test' });
  const auth = await w.bekle((m) => m.t === 'auth');
  check('wss: kurulum + giriş', auth.ok === true && auth.role === 'admin', JSON.stringify(auth).slice(0, 200));
  w.gonder({ t: 'admin', op: 'setSetting', key: 'requireApproval', value: false }); // ev ağı girişinde bilgisayarda onay penceresi açılmasın
  await w.bekle((m) => m.t === 'adminData');
  w.gonder({ t: 'admin', op: 'list' });
  const ad = await w.bekle((m) => m.t === 'adminData');
  check('yönetim verisinde sertifika ayrıntısı', ad.features?.sertifika?.acik === true && ad.features.sertifika.ipler.includes('127.0.0.1'), JSON.stringify(ad.features?.sertifika || {}).slice(0, 200));
  check('yönetim: bu bağlantı "bu bilgisayar" (local)', ad.online.some((o) => o.via === 'local'), JSON.stringify(ad.online));
  if (lan) {
    const wl = await wsAc(`wss://${lan}:${HP}`, { ca: caPem });
    const hl = await wl.bekle((m) => m.t === 'hello');
    check(`wss://${lan}: ev ağı sayıldı (ilk kurulum yok)`, hl.canSetup === false);
    wl.gonder({ t: 'login', username: 'deneme', password: 'deneme123', deviceName: 'lan-test' });
    const al = await wl.bekle((m) => m.t === 'auth');
    w.gonder({ t: 'admin', op: 'list' });
    const ad2 = await w.bekle((m) => m.t === 'adminData');
    check(`wss ev ağı girişi: via = ${lanVia}`, al.ok && ad2.online.some((o) => o.via === lanVia && o.ip === lan), JSON.stringify(ad2.online));
    wl.close();
  }

  // ---------------- 4. Yönetici işlemleri ----------------
  const yon = await wsAc(`ws://localhost:${PORT}`);
  await yon.bekle((m) => m.t === 'hello');
  yon.gonder({ t: 'login', username: 'deneme', password: 'deneme123' });
  await yon.bekle((m) => m.t === 'auth' && m.ok);
  const kapandi = new Promise((res) => w.on('close', (c) => res(c)));
  yon.gonder({ t: 'sertifika', op: 'kapat' });
  let sd = await yon.bekle((m) => m.t === 'sertifika-durum');
  check('kapat: durum kapalı', sd.acik === false && sd.ok, JSON.stringify(sd).slice(0, 160));
  check('kapat: HTTPS üzerinden bağlı olan düştü', (await Promise.race([kapandi, sleep(3000).then(() => 'yok')])) !== 'yok');
  await sleep(200);
  check('kapat: HTTPS portu artık dinlemiyor', (await hataKodu(istek(`https://localhost:${HP}/`, { ca: caPem }))) === 'ECONNREFUSED');
  d = await json(`http://localhost:${PORT}/api/sertifika/durum`);
  check('kapat: HTTP durum ucu kapalı diyor, HTTP çalışmaya devam ediyor', d.acik === false && d.adres === null);

  yon.gonder({ t: 'sertifika', op: 'ac' });
  sd = await yon.bekle((m) => m.t === 'sertifika-durum');
  check('aç: yeniden açıldı, aynı CA', sd.acik === true && sd.parmakIzi === sCa.fingerprint256, JSON.stringify(sd).slice(0, 160));
  check('aç: eski CA ile HTTPS çalışıyor', (await istek(`https://localhost:${sd.port}/api/sertifika/durum`, { ca: caPem })).status === 200);

  yon.gonder({ t: 'sertifika', op: 'yeniden' });
  sd = await yon.bekle((m) => m.t === 'sertifika-durum');
  check('yeniden üret: yeni CA (parmak izi değişti)', sd.acik === true && sd.parmakIzi && sd.parmakIzi !== sCa.fingerprint256);
  check('yeniden üret: eski CA artık geçmiyor', !!(await hataKodu(istek(`https://localhost:${sd.port}/`, { ca: caPem }))));
  const yeniCa = sertifika.pem((await istek(`http://localhost:${PORT}/api/sertifika/ca.cer`)).body);
  check('yeniden üret: yeni CA ile geçiyor', (await istek(`https://localhost:${sd.port}/`, { ca: yeniCa })).status === 200);

  yon.gonder({ t: 'sertifika', op: 'sil' });
  sd = await yon.bekle((m) => m.t === 'sertifika-durum');
  await sleep(200);
  d = await json(`http://localhost:${PORT}/api/sertifika/durum`);
  check('sil: kapalı, sertifika yok, indirme 404', d.acik === false && !d.parmakIzi && (await istek(`http://localhost:${PORT}/api/sertifika/ca.cer`)).status === 404);

  // Yetki: yönetici olmayan sertifika işlemi yapamaz
  yon.gonder({ t: 'admin', op: 'addUser', username: 'izleyici', password: 'izleyici1', role: 'view' });
  await yon.bekle((m) => m.t === 'adminData');
  const iz = await wsAc(`ws://localhost:${PORT}`);
  await iz.bekle((m) => m.t === 'hello');
  iz.gonder({ t: 'login', username: 'izleyici', password: 'izleyici1' });
  await iz.bekle((m) => m.t === 'auth' && m.ok);
  iz.gonder({ t: 'sertifika', op: 'ac' });
  const er = await iz.bekle((m) => m.t === 'error' || m.t === 'sertifika-durum');
  check('salt izleme: sertifika işlemi reddedildi', er.t === 'error');
  await sleep(300);
  check('salt izleme denemesinden sonra hâlâ kapalı', (await json(`http://localhost:${PORT}/api/sertifika/durum`)).acik === false);
  iz.close();
  yon.close();

  console.log(`\n${pass} geçti, ${fail} kaldı`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL beklenmeyen hata:', e.stack); process.exit(1); });
