// @sunucu yok
// Başlatma ve Windows engelleri (features/baslatma.js, lib/helper.js):
//   - Akıllı Uygulama Denetimi engeli TAKLİDİ: REMOTE_EXE_<AD> yardımcıları geçersiz exe'lere (metin dosyası) yönlendirir; spawn
//     gerçek engeldeki gibi UNKNOWN hatası verir. Sunucu çökmemeli, giriş çalışmalı, uyarı günlükte ve yönetim verisinde olmalı,
//     engellenen exe tekrar tekrar başlatılmamalı.
//   - Yeni cihaz onayı: RemoteHelper engelliyken onay penceresi açılamaz; bu bilgisayardaki yönetici oturumu cevaplar.
//   - Windows bildirimi kuru (REMOTE_BILDIRIM_KURU=1): gösterilmez, komut kaydedilir.
//   - "Windows açılınca başlat": SAHTE kayıt anahtarı (HKCU\Software\UzaktanBaglantiTest\Run); gerçek Run anahtarına yazılmaz,
//     test sonunda sahte anahtar silinir.
// "Uzak" bağlantılar X-Forwarded-For ile tailscale serve'den geliyormuş gibi açılır.
const { spawn, spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const WebSocket = require(path.join(ROOT, 'node_modules', 'ws'));
const PORT = process.env.TEST_PORT || '3999';
const URL = `ws://localhost:${PORT}`;
const SAHTE_ANAHTAR_KOK = 'HKCU\\Software\\UzaktanBaglantiTest';
const SAHTE_ANAHTAR = `${SAHTE_ANAHTAR_KOK}\\Run`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${name} ${extra}`);
  if (cond) pass++; else process.exitCode = 1;
}

function client(ip) {
  const ws = new WebSocket(URL, ip ? { headers: { 'X-Forwarded-For': ip } } : {});
  const queue = [];
  const waiters = [];
  ws.on('message', (d, bin) => {
    if (bin) return;
    const msg = JSON.parse(d.toString());
    const i = waiters.findIndex((w) => w.pred(msg));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg); else queue.push(msg);
  });
  const next = (pred = () => true, ms = 8000) => {
    const i = queue.findIndex(pred);
    if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      waiters.push(w);
      setTimeout(() => { const k = waiters.indexOf(w); if (k >= 0) waiters.splice(k, 1); reject(new Error('zaman aşımı')); }, ms);
    });
  };
  const none = async (pred, ms) => { try { await next(pred, ms); return false; } catch { return true; } };
  const send = (o) => ws.send(JSON.stringify(o));
  const opened = new Promise((r) => ws.on('open', r));
  // Kuyruktaki eski mesajları at (ör. engel kanıtı okununca gelen baslatma-durum).
  const drain = (pred) => { for (let i = queue.length - 1; i >= 0; i--) if (pred(queue[i])) queue.splice(i, 1); };
  return { ws, next, none, send, opened, drain };
}
const t = (type) => (m) => m.t === type;

function regOku(anahtar, ad) {
  const ps = `[Console]::OutputEncoding = [Text.Encoding]::UTF8; $v = (Get-ItemProperty -LiteralPath 'Registry::${anahtar.replace(/^HKCU\\/, 'HKEY_CURRENT_USER\\')}' -Name '${ad}' -ErrorAction SilentlyContinue).'${ad}'; if ($null -ne $v) { [Console]::Out.Write('=' + $v) }`;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' });
  return out.startsWith('=') ? out.slice(1) : null;
}

function sunucuBaslat(dataDir, ortam) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, ...ortam, PORT, REMOTE_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
    const s = { p, out: '' };
    const timer = setTimeout(() => reject(new Error(`sunucu başlamadı:\n${s.out}`)), 30000);
    const onData = (d) => { s.out += d; if (s.out.includes('sunucusu çalışıyor')) { clearTimeout(timer); resolve(s); } };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('exit', (c) => { clearTimeout(timer); s.cikis = c; reject(new Error(`sunucu kapandı (${c}):\n${s.out}`)); });
  });
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(process.env.TEST_TMP || os.tmpdir(), 'baslatma-'));
  const dataDir = path.join(tmp, 'veri');
  const sahte = path.join(tmp, 'sahte');
  fs.mkdirSync(sahte);
  fs.mkdirSync(path.join(tmp, 'baslangic'));
  // Geçersiz exe: metin dosyası. CreateProcess ERROR_BAD_EXE_FORMAT verir, Node bunu SAC engelindeki gibi UNKNOWN fırlatır.
  for (const ad of ['RemoteHelper', 'Pano', 'Durum', 'Ses']) fs.writeFileSync(path.join(sahte, `${ad}.exe`), 'bu bir exe değil (engel taklidi)\r\n');
  const gercekOnce = regOku('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', 'UzaktanBaglanti');

  let s;
  try {
    s = await sunucuBaslat(dataDir, {
      REMOTE_EXE_REMOTEHELPER: path.join(sahte, 'RemoteHelper.exe'),
      REMOTE_EXE_PANO: path.join(sahte, 'Pano.exe'),
      REMOTE_EXE_DURUM: path.join(sahte, 'Durum.exe'),
      REMOTE_EXE_SES: path.join(sahte, 'Ses.exe'),
      REMOTE_RUN_ANAHTARI: SAHTE_ANAHTAR,
      REMOTE_BILDIRIM_KURU: '1',
      TEPSI_BASLANGIC_KLASORU: path.join(tmp, 'baslangic'),
    });
    s.p.removeAllListeners('exit');
    check('RemoteHelper engelliyken sunucu çökmeden açıldı', true);
    check('günlükte Türkçe uyarı (RemoteHelper.exe, özellik adı)', /UYARI: Windows( Akıllı Uygulama Denetimi)? RemoteHelper\.exe dosyasını engelledi — uzaktan görüntü/.test(s.out)
      || /UYARI: Windows .*RemoteHelper\.exe dosyasının çalışmasını engelledi/.test(s.out), s.out.split('\n').find((l) => l.includes('UYARI')) || '');

    // Yönetici (bu bilgisayar)
    const pc = client();
    await pc.opened;
    await pc.next(t('hello'));
    pc.send({ t: 'setup', username: 'yonetici', password: 'yonetici123' });
    const a = await pc.next(t('auth'));
    check('RemoteHelper engelliyken giriş çalışıyor (ekran listesi boş)', a.ok && Array.isArray(a.screens) && a.screens.length === 0, JSON.stringify(a).slice(0, 120));
    const eng = await pc.next(t('baslatma-engel'), 5000).catch(() => null);
    check('yöneticiye girişte engel uyarısı gitti (ana menü)', eng && eng.engeller.some((k) => k.ad === 'RemoteHelper'), JSON.stringify(eng?.engeller?.map((k) => k.ad)));
    // Pano.exe, kontrol yetkili oturum açılınca başlatılmak istenir -> engellenir
    await sleep(500);
    pc.send({ t: 'admin', op: 'list' });
    let ad = await pc.next(t('adminData'));
    let b = ad.features.baslatma;
    const k = (n) => b.engeller.find((x) => x.ad === n);
    check('yönetim verisi: RemoteHelper ve Pano engeli kayıtlı', !!k('RemoteHelper') && !!k('Pano'), b.engeller.map((x) => `${x.ad}:${x.kod}`).join(', '));
    check('engel kaydı: UNKNOWN → politika engeli, Türkçe mesaj ve yol', k('Pano')?.politika === true && k('Pano').kod === 'UNKNOWN' && /Pano\.exe/.test(k('Pano').mesaj)
      && /pano eşitleme çalışmıyor/.test(k('Pano').mesaj) && k('Pano').yol.endsWith('Pano.exe'), k('Pano')?.mesaj);
    check('SAC açıksa mesaj "Akıllı Uygulama Denetimi" der', b.sac !== 'acik' || /Akıllı Uygulama Denetimi Pano\.exe dosyasını engelledi/.test(k('Pano')?.mesaj), `sac=${b.sac}`);
    check('başlatıcı: konsol (tepsi yok)', b.baslatici === 'konsol');

    // Döngü yok: pano isteği hemen cevap verir, uyarı bir kez yazılır
    const t0 = Date.now();
    pc.send({ t: 'pano-al' });
    const pe = await pc.next((m) => m.t === 'error' || m.t === 'pano');
    check('Pano engelliyken pano-al hemen hata döner (bekleme yok)', pe.t === 'error' && Date.now() - t0 < 2000, `${pe.msg} ${Date.now() - t0} ms`);
    pc.send({ t: 'pano-al' });
    await pc.next((m) => m.t === 'error' || m.t === 'pano');
    // Durum ve Ses: abone olunca başlatılmak istenir
    pc.send({ t: 'durum-abone', acik: true });
    const di = await pc.next(t('durum-ilk'));
    check('Durum engelliyken panel hata mesajını gösterir', /Durum\.exe/.test(di.hata || ''), di.hata);
    pc.send({ t: 'ses', acik: true });
    const sd = await pc.next(t('ses-durum'), 5000).catch(() => null);
    check('Ses engelliyken ses-durum kapalı + neden', sd && sd.acik === false && /Ses\.exe/.test(sd.msg), sd?.msg);
    pc.send({ t: 'ses', acik: true });
    const sd2 = await pc.next(t('ses-durum'), 3000).catch(() => null);
    check('Ses ikinci denemede başlatmadan reddedilir', sd2 && sd2.acik === false && /Ses\.exe/.test(sd2.msg), sd2?.msg);
    await sleep(3000); // Durum'un yeniden başlatma zamanlayıcısı (2 sn) işlesin
    const say = (re) => (s.out.match(re) || []).length;
    check('her engellenen exe için tek uyarı (yeniden başlatma döngüsü yok)',
      say(/UYARI: .*RemoteHelper\.exe/g) === 1 && say(/UYARI: .*Pano\.exe/g) === 1 && say(/UYARI: .*Durum\.exe/g) === 1 && say(/UYARI: .*Ses\.exe/g) === 1,
      `RH ${say(/UYARI: .*RemoteHelper\.exe/g)} Pano ${say(/UYARI: .*Pano\.exe/g)} Durum ${say(/UYARI: .*Durum\.exe/g)} Ses ${say(/UYARI: .*Ses\.exe/g)}`);
    check('"Yardımcı program kapandı, yeniden başlatılıyor" döngüsü yok', !/Yardımcı program kapandı/.test(s.out));

    // ---------- Yeni cihaz onayı: pencere yok, bu bilgisayardaki yönetici cevaplar ----------
    pc.send({ t: 'admin', op: 'setSetting', key: 'trustTailscale', value: false });
    await pc.next(t('adminData'));
    pc.send({ t: 'admin', op: 'addUser', username: 'uzak', password: 'uzak12345', role: 'control' });
    await pc.next(t('adminData'));

    let uz = client('100.100.7.1');
    await uz.opened;
    await uz.next(t('hello'));
    uz.send({ t: 'login', username: 'uzak', password: 'uzak12345', deviceName: 'iPhone · Safari' });
    check('uzak giriş onay bekliyor', (await uz.next(t('pending'))).t === 'pending');
    let istek = await pc.next(t('onay-istegi'));
    check('yerel yöneticiye onay isteği geldi (pencere açılamadı)', istek.pencere === false && /uzak/.test(istek.mesaj) && /iPhone/.test(istek.mesaj), JSON.stringify(istek).slice(0, 160));
    pc.send({ t: 'admin', op: 'list' });
    ad = await pc.next(t('adminData'));
    b = ad.features.baslatma;
    const onayB = b.bildirimler.find((x) => x.tur === 'onay');
    check('kuru Windows bildirimi kaydedildi (gösterilmedi, komut var)', onayB && onayB.kuru === true && /powershell\.exe/i.test(onayB.komut) && /EncodedCommand/.test(onayB.komut), onayB?.baslik);
    check('yönetim verisinde bekleyen onay', b.onaylar.some((o) => o.id === istek.id));
    pc.send({ t: 'onay-cevap', id: istek.id, onay: false });
    let r = await uz.next(t('auth'));
    check('reddedilince uzak giriş yok', r.ok === false && /reddedildi/.test(r.error), r.error);
    check('yöneticiye onay-bitti', (await pc.next(t('onay-bitti'))).id === istek.id);
    uz.ws.close();

    uz = client('100.100.7.2');
    await uz.opened;
    await uz.next(t('hello'));
    uz.send({ t: 'login', username: 'uzak', password: 'uzak12345', deviceName: 'iPad · Safari' });
    await uz.next(t('pending'));
    istek = await pc.next(t('onay-istegi'));
    pc.send({ t: 'onay-cevap', id: istek.id, onay: true });
    r = await uz.next(t('auth'));
    check('bu bilgisayardan izin verilince uzak giriş açıldı', r.ok === true, r.error || '');
    await sleep(300);
    pc.send({ t: 'admin', op: 'list' });
    ad = await pc.next(t('adminData'));
    const bag = ad.features.baslatma.bildirimler.find((x) => x.tur === 'baglandi');
    check('"biri bağlandı" kuru bildirimi (kişi, cihaz, yol)', bag && /uzak · iPad · Safari \(Tailscale, 100\.100\.7\.2\)/.test(bag.metin), bag?.metin);
    // Uzak kontrol kullanıcısı onay cevaplayamaz (rol + yerel denetimi)
    uz.send({ t: 'onay-cevap', id: 999, onay: true });
    const ue = await uz.next(t('error'));
    check('yönetici olmayan uzak kullanıcı onay veremez', /yetki/i.test(ue.msg), ue.msg);
    uz.ws.close();

    // ---------- Windows açılınca başlat: sahte anahtar ----------
    await sleep(2500); // engel kanıtının (Code Integrity günlüğü) durum mesajları gelsin, sonra atılsın
    pc.drain(t('baslatma-durum'));
    pc.send({ t: 'baslatma-otomatik', acik: true, yontem: 'arka-plan' });
    let sn = await pc.next(t('baslatma-sonuc'));
    let bd = await pc.next(t('baslatma-durum'));
    const deger = regOku(SAHTE_ANAHTAR, 'UzaktanBaglanti');
    check('arka plan yöntemi açıldı', !!sn.ok && bd.otomatik.acik && bd.otomatik.yontem === 'arka-plan' && bd.otomatik.buKopya && !bd.otomatik.kuru, `${sn.ok || sn.error} ${JSON.stringify(bd.otomatik)}`);
    check('sahte anahtardaki komut: imzalı powershell + arka-plan.ps1 + sessiz + port + veri klasörü',
      !!deger && /^"[A-Z]:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe" -NoProfile/i.test(deger) && deger.includes(path.join(ROOT, 'tools', 'arka-plan.ps1'))
      && /-WindowStyle Hidden/.test(deger) && /-Islem baslat -Sessiz/.test(deger) && deger.includes(`-PortNo ${PORT}`) && deger.includes(`-VeriKlasoru "${dataDir}"`), deger);
    pc.send({ t: 'baslatma-otomatik', acik: true, yontem: 'tepsi' });
    sn = await pc.next(t('baslatma-sonuc'));
    await pc.next(t('baslatma-durum'));
    check('Tepsi yöntemi varsayılan dışı port/veri ile reddedildi (ya da Tepsi.exe yok)', !!sn.error && /Tepsi/.test(sn.error), sn.error);
    check('reddedilen değişiklik anahtarı bozmadı', regOku(SAHTE_ANAHTAR, 'UzaktanBaglanti') === deger);
    pc.send({ t: 'baslatma-otomatik', acik: false });
    sn = await pc.next(t('baslatma-sonuc'));
    bd = await pc.next(t('baslatma-durum'));
    check('kapatılınca değer silindi', !!sn.ok && !bd.otomatik.acik && regOku(SAHTE_ANAHTAR, 'UzaktanBaglanti') === null, sn.ok || sn.error);
    check('gerçek Run anahtarına dokunulmadı', regOku('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', 'UzaktanBaglanti') === gercekOnce);
    pc.ws.close();
  } catch (e) {
    check(`beklenmeyen hata: ${e.message}`, false);
    if (s) console.log(s.out.slice(-3000));
  } finally {
    if (s) spawnSync('taskkill', ['/pid', String(s.p.pid), '/T', '/F'], { stdio: 'ignore' });
    spawnSync('reg', ['delete', SAHTE_ANAHTAR_KOK, '/f'], { stdio: 'ignore' });
    check('sahte kayıt anahtarı silindi', spawnSync('reg', ['query', SAHTE_ANAHTAR_KOK], { stdio: 'ignore' }).status !== 0);
    await sleep(300);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`${pass} kontrol geçti`);
})();
