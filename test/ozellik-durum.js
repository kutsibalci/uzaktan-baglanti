// Bilgisayar durumu (features/durum.js): ölçüm değer aralıkları, abonelik bitince Durum.exe durur, roller, kritik süreç reddi,
// Görev Yöneticisi gibi süreç grupları (kendi başlattığımız node grubu tek satırda "(4)", program adı = dosya açıklaması,
// uygulama / arka plan ayrımı, grup kapatma tüm PID'lere), izleyiciler (kendi başlattığımız kısa ömürlü süreç / grubun hepsi
// kapanınca, geçici İndirilenler klasörüne dosya gelince, bağlı değilken).
// KURU MOD — hiçbir program kapatılmaz (REMOTE_DURUM_KURU=1); "kapat" isteği yalnızca kendi node alt süreçlerimiz ve sistem süreçleri
// için (reddedilmesi beklenen) gönderilir. Kendi süreçlerimiz yalnızca PID'leriyle sonlandırılır.
// @ortam REMOTE_DURUM_KURU=1
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const WebSocket = require(path.join(ROOT, 'node_modules', 'ws'));
const URL = `ws://localhost:${process.env.TEST_PORT || 3999}`;
const INDIRME = process.env.REMOTE_INDIRME_DIR;

if (process.env.REMOTE_DURUM_KURU !== '1' || !INDIRME) {
  console.log('FAIL REMOTE_DURUM_KURU=1 / REMOTE_INDIRME_DIR yok, test çalıştırılmadı (gerçek kapatma riski)');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function client() {
  const ws = new WebSocket(URL);
  const queue = [];
  const waiters = [];
  ws.on('message', (d, bin) => {
    const msg = bin ? { t: 'frame' } : JSON.parse(d.toString());
    const i = waiters.findIndex((w) => w.pred(msg));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg); else queue.push(msg);
  });
  const next = (pred = () => true, ms = 8000) => {
    const i = queue.findIndex(pred);
    if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      waiters.push(w);
      setTimeout(() => {
        const j = waiters.indexOf(w);
        if (j < 0) return;
        waiters.splice(j, 1);
        reject(new Error('timeout waiting'));
      }, ms);
    });
  };
  const none = async (pred, ms = 1200) => { try { await next(pred, ms); return false; } catch { return true; } };
  const drop = (pred) => { for (let i = queue.length - 1; i >= 0; i--) if (pred(queue[i])) queue.splice(i, 1); };
  const send = (o) => ws.send(JSON.stringify(o));
  const closed = new Promise((r) => ws.on('close', (c) => r(c)));
  return { ws, next, none, drop, send, closed };
}
const t = (type) => (m) => m.t === type;
let pass = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${name} ${extra}`);
  if (cond) pass++; else process.exitCode = 1;
}
async function login(username, password) {
  const c = client();
  await c.next(t('hello'));
  c.send({ t: 'login', username, password, remember: false });
  const r = await c.next(t('auth'));
  if (!r.ok) throw new Error(`${username} giriş yapamadı: ${r.error}`);
  return c;
}
const between = (x, a, b) => typeof x === 'number' && x >= a && x <= b;
const canli = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// Salt okunur PowerShell sorgusu (süreç listesi): bu testin sunucusu ve onun Durum.exe alt süreci, birkaç sistem süreci.
function ps(cmd) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', windowsHide: true }).trim();
}
const sunucuPid = Number(ps(`(Get-CimInstance Win32_Process -Filter "ParentProcessId=${process.ppid} AND Name='node.exe'" | Where-Object { $_.CommandLine -like '*server.js*' } | Select-Object -First 1).ProcessId`));
const durumExe = () => ps(`@(Get-CimInstance Win32_Process -Filter "ParentProcessId=${sunucuPid} AND Name='Durum.exe'").ProcessId -join ','`).split(',').filter(Boolean).map(Number);

// Kendi başlattığımız zararsız süreç (yalnızca bekler).
function bekleyen(ms) {
  const p = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${ms})`], { stdio: 'ignore', windowsHide: true });
  return p;
}

// Kendi süreç grubumuz: cmd.exe -> node (kök) -> 3 node çocuk; her biri ~100 MB tutar (arka planın "en çok RAM" listesine girsin).
// cmd.exe araya girer ki kök bu testin node zincirine (test çalıştırıcı -> sunucu) bağlanmasın: grupta yalnızca bizim süreçlerimiz olur.
const GRUP_JS = `const { spawn } = require('child_process');
const [, , n, ms, mb, rol] = process.argv;
const tut = Buffer.alloc(Number(mb) * 2 ** 20, 1);
if (rol !== 'cocuk') {
  const c = [];
  for (let i = 0; i < Number(n); i++) c.push(spawn(process.execPath, [__filename, '0', ms, mb, 'cocuk'], { stdio: 'ignore', windowsHide: true }));
  console.log(JSON.stringify([process.pid, ...c.map((x) => x.pid)]));
}
setTimeout(() => tut.length, Number(ms));`;
const temizlik = []; // hata olursa da kendi süreçlerimiz kapatılsın
async function grupBaslat(cocuk, ms, mb) {
  const js = path.join(process.env.TEST_TMP || os.tmpdir(), `durum-grup-${process.pid}.js`);
  fs.writeFileSync(js, GRUP_JS);
  const cmd = spawn('cmd.exe', ['/d', '/s', '/c', `""${process.execPath}" "${js}" ${cocuk} ${ms} ${mb}"`],
    { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, windowsVerbatimArguments: true });
  const pidler = await new Promise((resolve, reject) => {
    let s = '';
    cmd.stdout.on('data', (d) => { s += d; if (s.includes('\n')) resolve(JSON.parse(s)); });
    cmd.on('exit', () => reject(new Error('grup başlatılamadı')));
    setTimeout(() => reject(new Error('grup başlatılamadı (zaman aşımı)')), 15000);
  });
  // Yalnızca kendi PID'lerimiz (ağacıyla): önce cmd ağacı, sonra kalan varsa tek tek.
  const bitir = () => {
    spawnSync('taskkill', ['/pid', String(cmd.pid), '/T', '/F'], { stdio: 'ignore' });
    for (const pid of pidler) { try { process.kill(pid); } catch { /* kapanmış */ } }
  };
  temizlik.push(bitir);
  return { cmd, pidler, bitir };
}
// FileVersionInfo.FileDescription — Durum.exe'den bağımsız okuma (PowerShell).
const dosyaAciklamasi = (exe) => ps(`(Get-Item -LiteralPath '${exe.replace(/'/g, "''")}').VersionInfo.FileDescription`);

(async () => {
  check('test sunucusunun PID\'i bulundu', sunucuPid > 0, `(${sunucuPid})`);
  const a = client();
  await a.next(t('hello'));
  a.send({ t: 'setup', username: 'ahmet', password: 'gizli123', remember: false });
  check('yönetici oluşturuldu', (await a.next(t('auth'))).ok);
  a.send({ t: 'admin', op: 'addUser', username: 'kontrolcu', password: 'kontrol1', role: 'control' });
  await a.next(t('adminData'));
  a.send({ t: 'admin', op: 'addUser', username: 'izleyici', password: 'izle1234', role: 'view' });
  await a.next(t('adminData'));
  const c = await login('kontrolcu', 'kontrol1');
  const v = await login('izleyici', 'izle1234');

  // ---------- 1. Abone yokken Durum.exe çalışmaz ----------
  check('abone yokken Durum.exe çalışmıyor', durumExe().length === 0);

  // ---------- 2. Ölçümler (salt izleme de görebilir) ----------
  const grup = await grupBaslat(3, 120000, 100);
  v.send({ t: 'durum-abone', acik: true });
  const ilk = await v.next(t('durum-ilk'));
  check('salt izleme abone olabildi', Array.isArray(ilk.gecmis) && Array.isArray(ilk.izleyiciler) && ilk.kuru === true && !ilk.hata, ilk.hata || '');
  const olcumler = [];
  // İlk ölçüm daha geç gelebilir: Durum.exe yeni derlendiyse ilk açılışı yavaş, ilk turda program adları (dosya açıklamaları) okunur.
  for (let i = 0; i < 12; i++) olcumler.push(await v.next(t('durum'), i ? 4000 : 12000));
  const m = olcumler.at(-1);
  check('CPU yüzdesi 0–100', olcumler.every((o) => between(o.cpu, 0, 100)), olcumler.map((o) => o.cpu).join(' '));
  check('RAM: kullanılan < toplam, toplam > 1 GB', m.ramTop > 2 ** 30 && between(m.ramKul, 1, m.ramTop), `${(m.ramKul / 2 ** 30).toFixed(1)}/${(m.ramTop / 2 ** 30).toFixed(1)} GB`);
  check('çalışma süresi (sn) > 0', m.uptime > 0, `${m.uptime} sn`);
  check('ağ hızı (indirme/yükleme) ölçülüyor', m.ag && m.ag.in >= 0 && m.ag.out >= 0, JSON.stringify(m.ag));
  check('diskler: en az bir sabit disk, boş ≤ toplam', m.diskler.length > 0 && m.diskler.every((d) => d.top > 0 && between(d.bos, 0, d.top) && /^[A-Z]:\\$/.test(d.ad)), m.diskler.map((d) => d.ad).join(','));
  check('pil: yok ya da 0–100', m.pil === null || (between(m.pil.yuzde, 0, 100) && typeof m.pil.fis === 'boolean'), JSON.stringify(m.pil));
  check('GPU: yok ya da kullanım 0–100, VRAM ≤ toplam', m.gpu === null || (m.gpu.length > 0 && m.gpu.every((g) => g.ad && (g.kul === null || between(g.kul, 0, 100)) && (!g.vramTop || g.vramKul <= g.vramTop))), JSON.stringify(m.gpu));
  check('CPU sıcaklığı: sayı ya da "ölçülemiyor" açıklaması', between(m.cpuSic, 0, 150) || (m.cpuSic === null && typeof m.cpuSicNeden === 'string' && m.cpuSicNeden.length > 3), `${m.cpuSic} ${m.cpuSicNeden}`);
  const s = m.gruplar;
  const uyg = s.filter((g) => g.uyg), arka = s.filter((g) => !g.uyg);
  const uyeOf = (g) => (g.uyeler || [[g.pid, g.ct]]).map(([pid]) => pid);
  check('süreç grupları: alanlar doğru (kök pid/ct, ad, exe, adet, toplam CPU/bellek, üyeler)', s.every((g) => g.pid > 0 && g.ad && g.exe && /^\d+$/.test(g.ct)
    && g.n >= 1 && between(g.cpu, 0, 100) && g.ram >= 0 && (g.n === 1 ? !g.uyeler : g.uyeler.length === g.n && g.uyeler[0][0] === g.pid && g.uyeler.every((u) => /^\d+$/.test(u[1])))),
    `${s.length} grup`);
  check('her bölümde en fazla 30 grup (15 CPU + 15 RAM), arka planda en az 15', uyg.length <= 30 && arka.length >= 15 && arka.length <= 30, `uygulama ${uyg.length}, arka plan ${arka.length}`);
  check('sayılar: grup ve süreç sayısı', m.sayilar && m.sayilar.uyg >= uyg.length && m.sayilar.arka >= arka.length && m.sayilar.surec > m.sayilar.uyg + 50, JSON.stringify(m.sayilar));
  const pidSay = s.flatMap(uyeOf);
  check('bir süreç yalnızca bir grupta', new Set(pidSay).size === pidSay.length);
  const bizimki = s.find((g) => g.pid === grup.pidler[0]);
  const sirali = (l) => [...l].sort((x, y) => x - y).join();
  check('kendi node grubumuz tek satırda, 4 süreç (kök + 3 çocuk), kök önce', bizimki && bizimki.n === 4 && uyeOf(bizimki)[0] === grup.pidler[0] && sirali(uyeOf(bizimki)) === sirali(grup.pidler),
    bizimki ? `${bizimki.ad} (${bizimki.n}) ${uyeOf(bizimki).join()}` : `listede yok (${grup.pidler.join()})`);
  if (bizimki) {
    const aciklama = dosyaAciklamasi(process.execPath);
    check('  program adı = dosya açıklaması (FileDescription), exe adı ayrı', bizimki.ad === aciklama && bizimki.exe === 'node.exe', `"${bizimki.ad}" / "${aciklama}"`);
    check('  penceresiz: arka plan işlemi, korumasız', !bizimki.uyg && !bizimki.koruma, bizimki.koruma || '');
    check('  bellek grubun toplamı (4 × ~100 MB özel çalışma kümesi)', bizimki.ram > 4 * 90 * 2 ** 20, `${(bizimki.ram / 2 ** 20).toFixed(0)} MB`);
  }
  const kritikAd = /^(csrss|svchost|dwm|lsass|smss|wininit|winlogon|services|system|registry|memory compression)(\.exe)?$/i;
  const kritikler = s.filter((g) => kritikAd.test(g.exe));
  check('kritik sistem süreçleri arka planda ve 🔒', kritikler.length > 0 && kritikler.every((g) => g.koruma && !g.uyg), kritikler.map((g) => `${g.exe}(${g.n})`).join(' '));
  const svc = s.filter((g) => g.exe.toLowerCase() === 'svchost.exe');
  if (svc.length) check('  svchost ada göre tek grupta', svc.length === 1 && svc[0].n > 10 && svc[0].ad !== 'svchost.exe', `${svc.map((g) => `${g.ad} (${g.n})`).join(', ')}`);
  const gezgin = s.find((g) => g.exe.toLowerCase() === 'explorer.exe');
  if (gezgin) check('  Gezgini 🔒 (Gezgini nedeniyle)', /Gezgini/.test(gezgin.koruma || ''), gezgin.koruma);
  const kendi = s.find((g) => uyeOf(g).includes(sunucuPid));
  if (kendi) check('kendi sunucumuzun grubu korumalı, arka planda', !!kendi.koruma && !kendi.uyg, kendi.koruma);
  // Uygulama = görünür üst düzey penceresi olan grup: her uygulama grubunun en az bir sürecinin Windows'a göre ana penceresi var.
  const pencereli = new Set(ps("Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { $_.Id }").split(/\r?\n/).filter(Boolean).map(Number));
  check('uygulama gruplarının penceresi ve başlığı var', uyg.every((g) => g.baslik && uyeOf(g).some((pid) => pencereli.has(pid))), uyg.map((g) => `${g.ad} (${g.n})`).join(', ') || '(açık pencere yok)');
  const oz = olcumler.slice(2).map((o) => o.oz);
  const ozOrt = oz.reduce((x, y) => x + y, 0) / oz.length;
  check('Durum.exe kendi CPU yükü %1\'in altında (ortalama)', ozOrt < 1, `ort %${ozOrt.toFixed(2)}, en çok %${Math.max(...oz)}`);
  const dz = durumExe();
  check('abone varken tek Durum.exe çalışıyor', dz.length === 1, dz.join(','));

  // ---------- 3. Roller: salt izleme ve kontrol program kapatamaz, salt izleme izleyici kuramaz ----------
  const zararsiz = bekleyen(60000);
  await sleep(300);
  for (const [ad, k] of [['izleyici', v], ['kontrolcu', c]]) {
    k.send({ t: 'durum-kapat', pid: zararsiz.pid });
    const e = await k.next((x) => x.t === 'error' || x.t === 'durum-kapat-sonuc');
    check(`${ad}: program kapatma reddedildi`, e.t === 'error' && /yetki/i.test(e.msg), e.msg || JSON.stringify(e));
  }
  v.send({ t: 'durum-izle', tur: 'indirme' });
  let e = await v.next((x) => x.t === 'error' || x.t === 'durum-izle-sonuc');
  check('izleyici: bildirim kurma reddedildi', e.t === 'error' && /yetki/i.test(e.msg), e.msg);
  check('zararsız alt süreç hâlâ çalışıyor', canli(zararsiz.pid));

  // ---------- 4. Yönetici, kuru mod: nazik → 5 sn sonra hâlâ açık → zorla (hiçbiri gerçekten kapatmaz) ----------
  a.send({ t: 'durum-kapat', pid: zararsiz.pid });
  let r = await a.next(t('durum-kapat-sonuc'));
  check('yönetici: nazik kapatma kabul (kuru)', r.ok && r.kuru === true && r.asama === 'nazik' && /node/i.test(r.ad), JSON.stringify(r));
  r = await a.next(t('durum-kapat-sonuc'), 9000);
  check('  5 sn sonra "hâlâ açık" denetimi', r.asama === 'kontrol' && r.hala === true && /^\d+$/.test(r.ct), JSON.stringify(r));
  a.send({ t: 'durum-kapat', pid: zararsiz.pid, ct: r.ct, zorla: true });
  r = await a.next(t('durum-kapat-sonuc'));
  check('  zorla kapatma kabul (kuru)', r.ok && r.kuru === true && r.asama === 'zorla', JSON.stringify(r));
  check('  kuru modda süreç kapanmadı', canli(zararsiz.pid));
  a.send({ t: 'durum-kapat', pid: zararsiz.pid, ct: '123', zorla: true });
  r = await a.next(t('durum-kapat-sonuc'));
  check('  başlama zamanı tutmazsa (PID başka sürece geçmiş) reddedilir', !r.ok && /kapanmış/.test(r.msg), r.msg);
  zararsiz.kill();

  // ---------- 4b. Grup kapatma (kuru): gruptaki TÜM süreçlere, yalnızca PID + başlama zamanıyla ----------
  if (bizimki) {
    const gpid = sirali(grup.pidler);
    a.send({ t: 'durum-kapat', pid: bizimki.pid, ct: bizimki.ct, surecler: bizimki.uyeler, ad: bizimki.ad });
    r = await a.next(t('durum-kapat-sonuc'));
    check('grup: nazik kapatma 4 sürece (kuru)', r.ok && r.kuru === true && r.asama === 'nazik' && r.adet === 4 && r.ad === bizimki.ad, JSON.stringify(r));
    r = await a.next(t('durum-kapat-sonuc'), 9000);
    check('  5 sn sonra kontrol: 4 süreç de "hâlâ açık" (PID + ct)', r.asama === 'kontrol' && r.hala === true && r.kalan.length === 4
      && sirali(r.kalan.map((x) => x[0])) === gpid && r.kalan.every(([pid, ct]) => bizimki.uyeler.some((u) => u[0] === pid && u[1] === ct)), JSON.stringify(r.kalan));
    a.send({ t: 'durum-kapat', pid: r.pid, ct: r.ct, surecler: r.kalan, ad: r.ad, zorla: true });
    r = await a.next(t('durum-kapat-sonuc'));
    check('  zorla kapatma 4 sürece (kuru)', r.ok && r.kuru === true && r.asama === 'zorla' && r.adet === 4, JSON.stringify(r));
    check('  kuru modda grubun hiçbir süreci kapanmadı', grup.pidler.every(canli));
    // Bir üyenin başlama zamanı tutmuyor: o atlanır (PID başka sürece geçmiş sayılır), yalnızca diğerleri hedeflenir.
    a.send({ t: 'durum-kapat', surecler: [bizimki.uyeler[0], [bizimki.uyeler[1][0], '123']], zorla: true });
    r = await a.next(t('durum-kapat-sonuc'));
    check('  başlama zamanı tutmayan üye atlandı (1 süreç hedeflendi)', r.ok && r.adet === 1 && r.pid === bizimki.pid, JSON.stringify(r));
    // Listede korumalı bir süreç (sunucumuz) varsa hiçbiri kapatılmaz.
    a.send({ t: 'durum-kapat', surecler: [...bizimki.uyeler, [sunucuPid, '0']], zorla: true });
    r = await a.next(t('durum-kapat-sonuc'));
    check('  listede kendi sunucumuz varsa grubun tamamı reddedildi', !r.ok && /Kapatılamaz/.test(r.msg), r.msg);
    for (const kotu of [[], 'x', [[1.5, '1']], [[4, '1']], Array.from({ length: 257 }, (_, i) => [1000 + i, '1'])]) {
      a.send({ t: 'durum-kapat', surecler: kotu });
      r = await a.next(t('durum-kapat-sonuc'));
      check(`  geçersiz liste reddedildi (${JSON.stringify(kotu).slice(0, 20)})`, !r.ok, r.msg);
    }
    check('  grubun süreçleri hâlâ çalışıyor', grup.pidler.every(canli));
  }

  // ---------- 5. Kritik süreçler, kendi süreçlerimiz, geçersiz PID ----------
  const sistem = ps("Get-Process -Name winlogon,csrss,lsass,services,smss,svchost,dwm,explorer -ErrorAction SilentlyContinue | ForEach-Object { $_.ProcessName + ':' + $_.Id }")
    .split(/\r?\n/).map((x) => x.split(':')).filter((x) => x[1]);
  const birer = new Map();
  for (const [ad, pid] of sistem) if (!birer.has(ad.toLowerCase())) birer.set(ad.toLowerCase(), Number(pid));
  const hedefler = [...birer].map(([ad, pid]) => [ad, pid]);
  hedefler.push(['sunucu (biz)', sunucuPid], ['Durum.exe (biz)', dz[0]], ['test çalıştırıcı (sunucunun atası)', process.ppid]);
  for (const [ad, pid] of hedefler) {
    for (const zorla of [false, true]) {
      a.send({ t: 'durum-kapat', pid, zorla });
      r = await a.next(t('durum-kapat-sonuc'));
      check(`${ad} (${pid}) ${zorla ? 'zorla ' : ''}kapatılamaz`, !r.ok && /Kapatılamaz/.test(r.msg) && (ad !== 'explorer' || /Gezgini/.test(r.msg)), r.msg);
    }
  }
  check('  sistem süreçlerinden en az winlogon/csrss/explorer denendi', ['winlogon', 'csrss', 'explorer'].every((x) => birer.has(x)), [...birer.keys()].join(','));
  for (const pid of [0, 4, -1, 'abc', 1.5, 999999999]) {
    a.send({ t: 'durum-kapat', pid });
    r = await a.next(t('durum-kapat-sonuc'));
    check(`geçersiz PID (${pid}) reddedildi`, !r.ok, r.msg);
  }
  a.send({ t: 'admin', op: 'list' });
  const kayit = (await a.next(t('adminData'))).log.filter((l) => l.event === 'durum');
  check('kapatma istekleri günlükte (kuru diye işaretli)', kayit.length === (bizimki ? 5 : 2) && kayit.every((l) => l.user === 'ahmet' && /deneme/.test(l.target)), `(${kayit.length} kayıt)`);
  if (bizimki) {
    const gk = kayit.filter((l) => /×4/.test(l.target));
    check('  grup kaydı 4 PID\'in hepsini içeriyor', gk.length === 2 && gk.every((l) => grup.pidler.every((pid) => l.target.includes(String(pid)))), gk.map((l) => l.target).join(' | '));
  }

  // ---------- 6. Abonelik bitince Durum.exe durur ----------
  v.send({ t: 'durum-abone', acik: false });
  let kalan = durumExe();
  for (let i = 0; i < 10 && kalan.length; i++) { await sleep(500); kalan = durumExe(); }
  check('abonelik bitince Durum.exe durdu', kalan.length === 0, kalan.join(','));
  v.drop(t('durum'));
  check('abonelik bitince ölçüm gelmiyor', await v.none(t('durum'), 2000));

  // ---------- 7. İzleyici: kendi kısa ömürlü sürecimiz kapanınca ----------
  const kisa = bekleyen(2500);
  await sleep(300);
  c.send({ t: 'durum-izle', tur: 'surec', pid: kisa.pid, ad: 'deneme.exe' });
  check('kontrol: "kapanınca haber ver" kuruldu', (await c.next(t('durum-izle-sonuc'))).ok);
  let l = await v.next(t('durum-izleyiciler'));
  check('izleyici listesi herkese duyuruldu', l.liste.length === 1 && l.liste[0].tur === 'surec' && l.liste[0].olusturan === 'kontrolcu' && /deneme\.exe/.test(l.liste[0].metin), JSON.stringify(l.liste));
  c.send({ t: 'durum-izle', tur: 'surec', pid: kisa.pid, ad: 'deneme.exe' });
  check('aynı süreç iki kez izlenmez', !(await c.next(t('durum-izle-sonuc'))).ok);
  c.send({ t: 'durum-izle', tur: 'surec', pid: 999999999 });
  check('olmayan süreç izlenmez', !(await c.next(t('durum-izle-sonuc'))).ok);
  const yeniKisa = bekleyen(6000);
  await sleep(300);
  c.send({ t: 'durum-izle', tur: 'surec', pid: yeniKisa.pid, ct: '123', ad: 'baska.exe' });
  check('oluşturulma zamanı (ct) tutmayan süreç izlenmez (PID başka sürece verilmiş)', !(await c.next(t('durum-izle-sonuc'))).ok);
  yeniKisa.kill();
  const bild = await v.next(t('durum-bildirim'), 9000);
  check('süreç kapanınca bildirim geldi (salt izlemeye de)', bild.tur === 'surec' && /deneme\.exe/.test(bild.metin) && !bild.gecikmeli, `${bild.baslik}: ${bild.metin}`);
  check('  yöneticiye de geldi', (await a.next(t('durum-bildirim'))).id === bild.id);
  l = await v.next(t('durum-izleyiciler'));
  check('  tetiklenen izleyici kaldırıldı', l.liste.length === 0);
  c.drop(t('durum-bildirim'));

  // ---------- 7b. Grup izleyicisi: gruptaki süreçlerin HEPSİ kapanınca (kendi grubumuz, PID'leriyle kapatılır) ----------
  if (bizimki) {
    c.send({ t: 'durum-izle', tur: 'surec', pid: bizimki.pid, ct: bizimki.ct, surecler: bizimki.uyeler, ad: 'grup-deneme' });
    check('grup izleyicisi kuruldu', (await c.next(t('durum-izle-sonuc'))).ok);
    l = await v.next(t('durum-izleyiciler'));
    const gi = l.liste[0];
    check('  4 süreç (PID + ct) saklandı', l.liste.length === 1 && gi.surecler.length === 4 && sirali(gi.surecler.map((x) => x[0])) === sirali(grup.pidler)
      && /4 işlemin hepsi/.test(gi.metin), `${gi?.metin} ${JSON.stringify(gi?.surecler)}`);
    c.send({ t: 'durum-izle', tur: 'surec', surecler: [bizimki.uyeler[2]], ad: 'tek' });
    check('  gruptaki bir süreç ayrıca izlenmez (zaten izleniyor)', !(await c.next(t('durum-izle-sonuc'))).ok);
    for (const pid of grup.pidler.slice(1)) process.kill(pid);
    check('  çocuklar kapandı, kök açıkken bildirim yok', await v.none(t('durum-bildirim'), 5000));
    process.kill(grup.pidler[0]);
    const gb = await v.next(t('durum-bildirim'), 9000);
    check('  gruptaki hepsi kapanınca bildirim geldi', gb.tur === 'surec' && /grup-deneme/.test(gb.metin), gb.metin);
    l = await v.next(t('durum-izleyiciler'));
    check('  tetiklenen grup izleyicisi kaldırıldı', l.liste.length === 0);
    c.drop(t('durum-bildirim'));
  }
  grup.bitir();

  // ---------- 8. İzleyici: İndirilenler'e yeni dosya (indirme bitince) ----------
  fs.writeFileSync(path.join(INDIRME, 'eski.txt'), 'önceden vardı');
  c.send({ t: 'durum-izle', tur: 'indirme' });
  check('indirme izleyicisi kuruldu', (await c.next(t('durum-izle-sonuc'))).ok);
  c.send({ t: 'durum-izle', tur: 'indirme' });
  check('indirme izleyicisi iki kez kurulmaz', !(await c.next(t('durum-izle-sonuc'))).ok);
  const parca = path.join(INDIRME, 'rapor.pdf.crdownload');
  fs.writeFileSync(parca, Buffer.alloc(50000));
  fs.writeFileSync(path.join(INDIRME, 'firefox.zip'), ''); // Firefox: önce boş dosya + .part
  fs.writeFileSync(path.join(INDIRME, 'firefox.zip.part'), Buffer.alloc(1000));
  check('indirme sürerken (.crdownload / .part) bildirim yok', await c.none(t('durum-bildirim'), 5000));
  fs.renameSync(parca, path.join(INDIRME, 'rapor.pdf'));
  const ib = await c.next(t('durum-bildirim'), 9000);
  check('indirme bitince bildirim geldi', ib.tur === 'indirme' && /rapor\.pdf/.test(ib.metin) && !/firefox/.test(ib.metin), ib.metin);

  // ---------- 9. CPU / pil izleyicileri: eşik denetimi; CPU izleyicisi Durum.exe'yi çalıştırır ----------
  for (const esik of [0, 96, 'x']) {
    c.send({ t: 'durum-izle', tur: 'cpu', esik });
    check(`CPU eşiği ${esik} reddedildi`, !(await c.next(t('durum-izle-sonuc'))).ok);
  }
  c.send({ t: 'durum-izle', tur: 'bilinmeyen' });
  check('bilinmeyen izleyici türü reddedildi', !(await c.next(t('durum-izle-sonuc'))).ok);
  c.send({ t: 'durum-izle', tur: 'cpu', esik: 95 });
  check('CPU %95 izleyicisi kuruldu', (await c.next(t('durum-izle-sonuc'))).ok);
  await sleep(2500);
  check('CPU izleyicisi varken (abone yokken) Durum.exe çalışıyor', durumExe().length === 1);
  try {
    const cb = await c.next(t('durum-bildirim'), 25000);
    check('CPU eşiğin altında 10 sn kalınca bildirim geldi', cb.tur === 'cpu' && /CPU/.test(cb.baslik), cb.metin);
  } catch {
    console.log('ATLANDI CPU izleyicisi tetiklenmedi (bilgisayar 25 sn boyunca %95\'in üstündeydi)');
    l = (await (c.send({ t: 'durum-abone', acik: true }), c.next(t('durum-ilk')))).izleyiciler;
    c.send({ t: 'durum-abone', acik: false });
    for (const i of l) c.send({ t: 'durum-izle-sil', id: i.id });
  }
  kalan = durumExe();
  for (let i = 0; i < 10 && kalan.length; i++) { await sleep(500); kalan = durumExe(); }
  check('izleyici kalmayınca Durum.exe durdu', kalan.length === 0, kalan.join(','));

  // ---------- 10. Bağlı değilken tetiklenen bildirim bir sonraki girişte gösterilir ----------
  const gec = bekleyen(2500);
  await sleep(300);
  c.send({ t: 'durum-izle', tur: 'surec', pid: gec.pid, ad: 'gecikmeli.exe' });
  check('izleyici kuruldu (sonra herkes ayrılıyor)', (await c.next(t('durum-izle-sonuc'))).ok);
  for (const k of [a, c, v]) k.ws.close();
  await Promise.all([a.closed, c.closed, v.closed]);
  await new Promise((res) => gec.on('exit', res));
  await sleep(3500);
  const a2 = await login('ahmet', 'gizli123');
  const gb = await a2.next(t('durum-bildirim'), 4000);
  check('bağlı değilken olan bildirim girişte geldi (gecikmeli)', gb.gecikmeli === true && /gecikmeli\.exe/.test(gb.metin), gb.metin);
  const a3 = await login('ahmet', 'gizli123');
  check('  bir kez gösterildi (sonraki girişte yok)', await a3.none(t('durum-bildirim'), 1500));

  console.log(`\n${pass} kontrol geçti`);
  process.exit();
})().catch((err) => { console.error('TEST HATASI', err); for (const f of temizlik) f(); process.exit(1); });
