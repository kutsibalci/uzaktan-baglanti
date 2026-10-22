// Ses karıştırıcı: features/karisim.js (sunucu, KURU modda) + helper/Karistirici.exe (gerçek okuma ve DEĞİŞİKLİKSİZ gerçek ayar).
// KURU MOD — sunucu ayarları yardımcıya GÖNDERMEZ, yalnızca listede yansıtır (REMOTE_KARISIM_KURU=1; yardımcısı da "kuru" başlar).
// Yardımcının gerçek yolu bu bilgisayarda kullanıcının ses ayarlarını DEĞİŞTİRMEDEN sınanır: ses seviyesi / sessiz ŞİMDİKİ değerine,
// varsayılan cihaz ŞİMDİKİ varsayılana (yalnızca üç rolde de varsayılansa) yazılır, sonra yeniden okunup aynı olduğu denetlenir.
// Farklı bir değer hiçbir zaman gerçek yardımcıya gönderilmez; ses çalınmaz.
// @ortam REMOTE_KARISIM_KURU=1
// @ortam REMOTE_KARISIM_BOSTA_MS=1500
const path = require('path');
const fs = require('fs');
const { spawn, execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const WebSocket = require(path.join(ROOT, 'node_modules', 'ws'));
const URL = `ws://localhost:${process.env.TEST_PORT || 3999}`;
const EXE = path.join(ROOT, 'helper', 'Karistirici.exe');

if (process.env.REMOTE_KARISIM_KURU !== '1') {
  console.log('FAIL REMOTE_KARISIM_KURU=1 değil, test çalıştırılmadı (gerçek ses ayarı riski)');
  process.exit(1);
}

let fails = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${name} ${extra}`);
  if (!cond) { fails++; process.exitCode = 1; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t = (type) => (m) => m.t === type;

function client() {
  const ws = new WebSocket(URL);
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
      setTimeout(() => {
        const k = waiters.indexOf(w);
        if (k < 0) return;
        waiters.splice(k, 1);
        reject(new Error('timeout waiting'));
      }, ms);
    });
  };
  const none = async (pred, ms = 600) => { try { await next(pred, ms); return false; } catch { return true; } };
  const send = (o) => ws.send(JSON.stringify(o));
  const temizle = () => queue.splice(0); // bekleyen (henüz istenmemiş) mesajları alır
  return { ws, next, none, send, temizle };
}

// Gerçek yardımcı (testin kendi süreci). Her komuta tek satır; ham baytlar ASCII denetimi için saklanır.
function yardimci(args = []) {
  let p;
  try { p = spawn(EXE, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }); } catch (e) { return { hata: e.code || e.message }; }
  let buf = Buffer.alloc(0);
  const bekleyen = [];
  let hata = null;
  p.on('error', (e) => { hata = e.code || e.message; for (const w of bekleyen.splice(0)) w(null); });
  p.stdout.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    let i;
    while ((i = buf.indexOf(10)) >= 0) {
      const satir = buf.subarray(0, i);
      buf = buf.subarray(i + 1);
      const w = bekleyen.shift();
      if (w) w(satir);
    }
  });
  const komut = (s) => new Promise((resolve, reject) => {
    if (hata) { reject(new Error(`yardımcı başlatılamadı: ${hata}`)); return; }
    const zaman = setTimeout(() => reject(new Error(`yardımcı cevap vermedi: ${s}`)), 10000);
    bekleyen.push((satir) => {
      clearTimeout(zaman);
      if (!satir) { reject(new Error(`yardımcı başlatılamadı: ${hata}`)); return; }
      resolve({ ham: satir, m: JSON.parse(satir.toString('latin1')) });
    });
    p.stdin.write(`${s}\n`);
  });
  const kapandi = new Promise((r) => p.on('exit', r));
  return { p, komut, kapat: () => { p.stdin.end(); return kapandi; }, hata: () => hata };
}

// Kayıt defterindeki çıkış cihazı adları (bağımsız kaynak): { '{guid}': { ad: 'Hoparlör', arayuz: 'Realtek(R) Audio' } }
function kayitAdlari() {
  const ps = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; $k = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\MMDevices\\Audio\\Render'; "
    + "@(Get-ChildItem $k | ForEach-Object { $p = Get-ItemProperty \"$($_.PSPath)\\Properties\" -ErrorAction SilentlyContinue; "
    + "[pscustomobject]@{ g = $_.PSChildName; ad = $p.'{a45c254e-df1c-4efd-8020-67d146a850e0},2'; arayuz = $p.'{b3f8fa53-0004-438e-9003-51a46e139bfc},6' } }) | ConvertTo-Json -Compress";
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  let arr = JSON.parse(out.trim() || '[]');
  if (!Array.isArray(arr)) arr = [arr];
  return new Map(arr.map((x) => [String(x.g).toLowerCase(), x]));
}

// Bu klasörün Karistirici.exe süreçlerinin komut satırları (sunucunun kuru başlattığını görmek için).
function surecler() {
  const ps = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; @(Get-CimInstance Win32_Process -Filter \"Name='Karistirici.exe'\" | "
    + 'ForEach-Object { [pscustomobject]@{ yol = $_.ExecutablePath; komut = $_.CommandLine } }) | ConvertTo-Json -Compress';
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 30000 }).trim();
  let arr = out ? JSON.parse(out) : [];
  if (!Array.isArray(arr)) arr = [arr];
  return arr.filter((x) => x && String(x.yol || '').toLowerCase() === EXE.toLowerCase());
}

const ozet = (c) => `${c.id}|${c.varsayilan}|${c.multimedya}|${c.iletisim}|${c.ses}|${c.sessiz}`;
const turkce = (s) => /[çğıöşüÇĞİÖŞÜ]/.test(s);
const bozuk = (s) => /[�?]|Ã|Ä|Å/.test(s);

(async () => {
  // ================= 1. Yardımcının GERÇEK okuma yolu =================
  check('Karistirici.exe derlendi (sunucu açılışta)', fs.existsSync(EXE), EXE);
  const y = yardimci();
  let l1;
  try {
    const r1 = await y.komut('liste');
    l1 = r1.m;
    check('liste: çıktı yalnızca ASCII (Türkçe harfler \\uXXXX)', [...r1.ham].every((b) => b < 0x80), `${r1.ham.length} bayt`);
  } catch (e) {
    check('yardımcı çalıştı', false, `${e.message} — Akıllı Uygulama Denetimi yeni derlenen exe'yi engellemiş olabilir`);
    process.exit(1);
  }
  const C = l1.cihazlar || [];
  check('en az bir etkin çıkış cihazı', C.length >= 1, `${C.length} cihaz`);
  check('tam bir cihaz varsayılan (konsol rolü)', C.filter((c) => c.varsayilan).length === 1);
  check('cihaz alanları: id, ad, ses 0-100 tamsayı, sessiz', C.every((c) => typeof c.id === 'string' && c.id && typeof c.ad === 'string' && c.ad
    && Number.isInteger(c.ses) && c.ses >= 0 && c.ses <= 100 && typeof c.sessiz === 'boolean' && typeof c.iletisim === 'boolean' && typeof c.multimedya === 'boolean'));
  check('cihaz kimlikleri benzersiz', new Set(C.map((c) => c.id)).size === C.length);
  console.log(`     cihazlar: ${C.map((c) => `${c.ad}${c.varsayilan ? ' [varsayılan]' : ''} %${c.ses}${c.sessiz ? ' sessiz' : ''}`).join(' · ')}`);
  const kayit = kayitAdlari();
  const adKontrol = C.map((c) => {
    const g = (c.id.match(/\{[0-9a-f-]+\}$/i) || [''])[0].toLowerCase();
    const k = kayit.get(g);
    return { ad: c.ad, beklenen: k ? (k.arayuz ? `${k.ad} (${k.arayuz})` : k.ad) : null };
  });
  check('cihaz adları kayıt defteriyle aynı (PKEY_Device_FriendlyName = "açıklama (arayüz)")', adKontrol.every((x) => x.beklenen && x.ad === x.beklenen),
    JSON.stringify(adKontrol.filter((x) => x.ad !== x.beklenen)));
  check('adlarda bozuk karakter yok', C.every((c) => !bozuk(c.ad)));
  if (C.some((c) => turkce(c.ad))) check('Türkçe harfli ad doğru çözüldü', true, C.filter((c) => turkce(c.ad)).map((c) => c.ad).join(', '));
  else console.log('     (Türkçe harfli cihaz adı yok)');

  const U = l1.uygulamalar || [];
  check('uygulama alanları: pid, ad, ses, sessiz, listedeki cihaz', U.every((u) => Number.isInteger(u.pid) && u.pid >= 0 && typeof u.ad === 'string' && u.ad && !bozuk(u.ad)
    && Number.isInteger(u.ses) && u.ses >= 0 && u.ses <= 100 && typeof u.sessiz === 'boolean' && C.some((c) => c.id === u.cihazId)));
  check('bir cihazda aynı süreç tek satır', U.every((u, i) => !U.some((v, j) => j !== i && v.pid === u.pid && v.cihazId === u.cihazId)));
  check('sistem sesleri "Sistem sesleri" adıyla', U.filter((u) => u.sistem).every((u) => u.ad === 'Sistem sesleri' && u.pid === 0), `${U.filter((u) => u.sistem).length} oturum`);
  console.log(`     uygulamalar: ${U.map((u) => `${u.ad} (${u.pid}) %${u.ses}${u.sessiz ? ' sessiz' : ''}`).join(' · ') || '(yok)'}`);

  // ================= 2. Yardımcının GERÇEK ayar yolu — DEĞİŞİKLİK YAPMADAN =================
  const D = C.find((c) => c.varsayilan);
  const ok = async (s) => { const r = (await y.komut(s)).m; return r.ok === true && !r.kuru ? true : JSON.stringify(r); };
  let r = await ok(`cihaz-ses ${D.id} ${D.ses}`);
  check(`cihaz-ses: varsayılan cihaza şimdiki değeri (%${D.ses}) yazıldı`, r === true, r === true ? '' : r);
  r = await ok(`cihaz-sessiz ${D.id} ${D.sessiz ? 1 : 0}`);
  check(`cihaz-sessiz: şimdiki durumu (${D.sessiz ? 'sessiz' : 'açık'}) yazıldı`, r === true, r === true ? '' : r);
  const ucRol = D.varsayilan && D.multimedya && D.iletisim;
  if (ucRol) {
    r = await ok(`varsayilan ${D.id}`);
    check('varsayilan: IPolicyConfig::SetDefaultEndpoint şimdiki varsayılana (3 rol) başarılı', r === true, r === true ? '' : r);
  } else {
    console.log('     varsayılan cihaz ayarı ATLANDI: iletişim / multimedya varsayılanı farklı cihaz (3 rolü birden yazmak değişiklik olurdu)');
  }
  const A = U.find((u) => u.cihazId === D.id && !u.sistem) || U.find((u) => u.cihazId === D.id) || U[0];
  if (A) {
    r = await ok(`uyg-ses ${A.pid} ${A.ses}`);
    check(`uyg-ses: "${A.ad}" şimdiki değerine (%${A.ses}) yazıldı`, r === true, r === true ? '' : r);
    r = await ok(`uyg-sessiz ${A.pid} ${A.sessiz ? 1 : 0}`);
    check(`uyg-sessiz: "${A.ad}" şimdiki durumuna yazıldı`, r === true, r === true ? '' : r);
  } else console.log('     (ses oturumu açık uygulama yok: uygulama ayarı sınanmadı)');
  const l2 = (await y.komut('liste')).m;
  check('yeniden okundu: cihazların sesi, sessizi ve varsayılanı aynı', l2.cihazlar.map(ozet).join('\n') === C.map(ozet).join('\n'),
    l2.cihazlar.map(ozet).filter((x) => !C.map(ozet).includes(x)).join(' | '));
  if (A) {
    const A2 = l2.uygulamalar.find((u) => u.pid === A.pid && u.cihazId === A.cihazId);
    check('yeniden okundu: uygulamanın sesi ve sessizi aynı', A2 && A2.ses === A.ses && A2.sessiz === A.sessiz, JSON.stringify(A2));
  }
  // Geçersiz komutlar hiçbir şey yapmadan reddedilir
  const red = async (s) => (await y.komut(s)).m;
  let m = await red('bozuk komut');
  check('bilinmeyen komut -> error', m.t === 'error');
  m = await red('cihaz-ses {0.0.0.00000000}.{00000000-0000-0000-0000-000000000000} 5');
  check('olmayan cihaz -> ok:false', m.t === 'cihaz-ses' && m.ok === false, m.msg);
  m = await red(`cihaz-ses ${D.id} 101`);
  check('aralık dışı seviye (101) -> ok:false', m.ok === false, m.msg);
  m = await red(`cihaz-ses ${D.id} -1`);
  check('eksi seviye -> ok:false', m.ok === false, m.msg);
  m = await red(`cihaz-sessiz ${D.id} 2`);
  check('sessiz yalnızca 0 / 1 -> ok:false', m.ok === false, m.msg);
  m = await red('uyg-ses 4294967295 5');
  check('oturumu olmayan süreç -> ok:false', m.t === 'uyg-ses' && m.ok === false, m.msg);
  await y.kapat();
  // Kuru yardımcı (sunucunun kuru modda başlattığı): ayar komutu hiçbir şeye dokunmadan "kuru" döner (yine şimdiki değerle).
  const yk = yardimci(['kuru']);
  m = (await yk.komut(`cihaz-ses ${D.id} ${D.ses}`)).m;
  check('"kuru" yardımcı: ayar uygulanmadan ok + kuru döner', m.ok === true && m.kuru === true, JSON.stringify(m));
  await yk.kapat();

  // ================= 3. Sunucu (KURU) =================
  const a = client();
  await a.next(t('hello'));
  a.send({ t: 'setup', username: 'ahmet', password: 'gizli123', remember: false });
  check('yönetici oluşturuldu', (await a.next(t('auth'))).ok);
  a.send({ t: 'karisim-al' });
  let k = await a.next(t('karisim'));
  check('karisim-al: liste geldi, sunucu kuru modda', Array.isArray(k.cihazlar) && k.kuru && Number.isInteger(k.kuru.uygulanan), JSON.stringify(k.kuru));
  check('karisim: cihazlar yardımcınınkiyle aynı', k.cihazlar.map(ozet).join('\n') === C.map(ozet).join('\n'));
  // Uygulama oturumları okumalar arasında açılıp kapanabilir: yardımcının listesiyle en fazla 2 fark
  const pidler = (l) => new Set(l.filter((u) => u.cihazId === D.id).map((u) => u.pid));
  const fark = [...pidler(k.uygulamalar)].filter((p) => !pidler(U).has(p)).length + [...pidler(U)].filter((p) => !pidler(k.uygulamalar).has(p)).length;
  check('karisim: cihazId = varsayılan cihaz, uygulamalar yalnızca onun', k.cihazId === D.id && k.uygulamalar.every((u) => u.cihazId === D.id) && fark <= 2,
    `${k.uygulamalar.length} uygulama, yardımcıyla ${fark} fark`);
  check('karisim: Sistem sesleri önce', !k.uygulamalar.some((u) => u.sistem) || k.uygulamalar[0].sistem);
  const E = C.find((c) => c.id !== D.id);
  if (E) {
    a.send({ t: 'karisim-al', cihazId: E.id });
    k = await a.next(t('karisim'));
    check('karisim-al cihazId: o cihazın uygulamaları', k.cihazId === E.id && k.uygulamalar.every((u) => u.cihazId === E.id));
  }
  a.send({ t: 'karisim-al', cihazId: 'yok' });
  k = await a.next(t('karisim'));
  check('bilinmeyen cihazId -> varsayılan cihaz', k.cihazId === D.id);
  const uygulanan0 = k.kuru.uygulanan;
  try {
    const sp = surecler();
    check('sunucunun yardımcısı "kuru" başlatıldı', sp.length >= 1 && sp.every((x) => /\skuru\s*$/.test(x.komut || '')), JSON.stringify(sp.map((x) => x.komut)));
  } catch (e) { check('süreç listesi okundu', false, e.message); }

  // ---- Doğrulama: hepsi karisim-hata, hiçbiri uygulanmaz ----
  const gecersiz = [
    [{ tur: 'bilinmeyen', id: D.id, deger: 5 }, 'bilinmeyen tür'],
    [{ tur: 'cihaz-ses', id: 'yok', deger: 5 }, 'listede olmayan cihaz'],
    [{ tur: 'cihaz-ses', id: `${D.id} 5\nvarsayilan ${D.id}`, deger: 5 }, 'satır sonu içeren kimlik'],
    [{ tur: 'varsayilan', id: 42 }, 'sayı kimlik'],
    [{ tur: 'cihaz-ses', id: D.id, deger: 101 }, 'seviye 101'],
    [{ tur: 'cihaz-ses', id: D.id, deger: -1 }, 'seviye -1'],
    [{ tur: 'cihaz-ses', id: D.id, deger: '50' }, 'metin seviye'],
    [{ tur: 'cihaz-ses', id: D.id, deger: null }, 'seviye yok'],
    [{ tur: 'cihaz-sessiz', id: D.id, deger: 1 }, 'sessiz true/false değil'],
    [{ tur: 'uyg-ses', pid: 4294967295, deger: 5 }, 'listede olmayan pid'],
    [{ tur: 'uyg-ses', pid: String(A ? A.pid : 0), deger: 5 }, 'metin pid'],
    [{ tur: 'uyg-ses', pid: 1.5, deger: 5 }, 'kesirli pid'],
    [{ tur: 'uyg-ses', pid: -1, deger: 5 }, 'eksi pid'],
  ];
  if (A) gecersiz.push([{ tur: 'uyg-ses', pid: A.pid, deger: 100.5 }, 'uygulama seviyesi 100,5']);
  for (const [g, ad] of gecersiz) {
    a.send({ t: 'karisim-ayar', ...g });
    const h = await a.next((x) => x.t === 'karisim-hata' || x.t === 'karisim').catch(() => null);
    check(`geçersiz (${ad}) -> karisim-hata`, h && h.t === 'karisim-hata', h ? h.msg || h.t : 'cevap yok');
  }
  check('geçersizlerden sonra liste gelmedi', await a.none(t('karisim'), 400));
  a.send({ t: 'karisim-al' });
  k = await a.next(t('karisim'));
  check('geçersiz ayarların hiçbiri uygulanmadı', k.kuru.uygulanan === uygulanan0, `${uygulanan0} -> ${k.kuru.uygulanan}`);

  // ---- Salt izleme: alamaz, ayarlayamaz ----
  a.send({ t: 'admin', op: 'addUser', username: 'bakan', password: 'bakan123', role: 'view' });
  await a.next(t('adminData'));
  const b = client();
  await b.next(t('hello'));
  b.send({ t: 'login', username: 'bakan', password: 'bakan123', remember: false });
  check('salt izleme kullanıcısı girdi', (await b.next(t('auth'))).ok);
  b.send({ t: 'karisim-al' });
  let e = await b.next((x) => x.t === 'error' || x.t === 'karisim');
  check('salt izleme: karisim-al reddedildi', e.t === 'error' && /yetki/i.test(e.msg), e.msg || e.t);
  b.send({ t: 'karisim-ayar', tur: 'cihaz-ses', id: D.id, deger: D.ses });
  e = await b.next((x) => x.t === 'error' || x.t === 'karisim' || x.t === 'karisim-hata');
  check('salt izleme: karisim-ayar reddedildi', e.t === 'error' && /yetki/i.test(e.msg), e.msg || e.t);
  b.ws.close();

  // ---- Kuru ayarlar: cevapta yansır, gerçek ayara dokunulmaz ----
  check('kuru değerler denenmeden önce sunucu kuru modda', !!k.kuru);
  const farkli = (v) => (v >= 50 ? v - 37 : v + 37);
  a.send({ t: 'karisim-ayar', tur: 'cihaz-ses', id: D.id, deger: farkli(D.ses) });
  k = await a.next(t('karisim'));
  check(`kuru cihaz-ses %${farkli(D.ses)}: cevapta yansıdı`, k.cihazlar.find((c) => c.id === D.id).ses === farkli(D.ses) && k.kuru.uygulanan === uygulanan0 + 1);
  a.send({ t: 'karisim-ayar', tur: 'cihaz-sessiz', id: D.id, deger: !D.sessiz });
  k = await a.next(t('karisim'));
  check('kuru cihaz-sessiz: cevapta yansıdı', k.cihazlar.find((c) => c.id === D.id).sessiz === !D.sessiz);
  if (A) {
    a.send({ t: 'karisim-al', cihazId: A.cihazId });
    await a.next(t('karisim'));
    a.send({ t: 'karisim-ayar', tur: 'uyg-ses', pid: A.pid, deger: farkli(A.ses) });
    k = await a.next(t('karisim'));
    check(`kuru uyg-ses "${A.ad}" %${farkli(A.ses)}: cevapta yansıdı (o cihazın listesinde)`, k.cihazId === A.cihazId && k.uygulamalar.find((u) => u.pid === A.pid)?.ses === farkli(A.ses));
    a.send({ t: 'karisim-ayar', tur: 'uyg-sessiz', pid: A.pid, deger: !A.sessiz });
    k = await a.next(t('karisim'));
    check('kuru uyg-sessiz: cevapta yansıdı', k.uygulamalar.find((u) => u.pid === A.pid)?.sessiz === !A.sessiz);
  }
  if (E) {
    a.send({ t: 'karisim-ayar', tur: 'varsayilan', id: E.id });
    k = await a.next(t('karisim'));
    check('kuru varsayilan: yeni varsayılan (3 rol) ve onun uygulamaları', k.cihazId === E.id && k.cihazlar.filter((c) => c.varsayilan).map((c) => c.id).join() === E.id
      && k.cihazlar.find((c) => c.id === E.id).iletisim && k.uygulamalar.every((u) => u.cihazId === E.id));
  } else console.log('     (tek çıkış cihazı: varsayılan değiştirme yansıması sınanmadı)');

  // ---- Oran sınırı: sürükleme gibi sık ayarlarda son değer kaybolmaz, en fazla saniyede ~15 uygulanır ----
  let u0 = k.kuru.uygulanan;
  for (let v = 1; v <= 40; v++) a.send({ t: 'karisim-ayar', tur: 'cihaz-ses', id: D.id, deger: v });
  k = await a.next((x) => x.t === 'karisim' && x.cihazlar.find((c) => c.id === D.id).ses === 40);
  check('40 ayar art arda: son değer (40) uygulandı', !!k);
  check('40 ayar art arda: aynı ayarın arası birleşti (≤ 3 uygulama)', k.kuru.uygulanan - u0 <= 3, `${k.kuru.uygulanan - u0} uygulama`);
  u0 = k.kuru.uygulanan;
  a.temizle();
  const t0 = Date.now();
  let v = 0;
  while (Date.now() - t0 < 1000) { v++; a.send({ t: 'karisim-ayar', tur: 'cihaz-ses', id: D.id, deger: v % 100 }); await sleep(15); }
  const sonV = v % 100;
  k = await a.next((x) => x.t === 'karisim' && x.cihazlar.find((c) => c.id === D.id).ses === sonV);
  const n = k.kuru.uygulanan - u0;
  check('1 sn boyunca ~60 ayar: saniyede en fazla ~15 uygulandı, son değer kaybolmadı', n >= 5 && n <= 18, `${v} gönderildi, ${n} uygulandı, son %${sonV}`);
  await sleep(300);
  const araListe = a.temizle().filter(t('karisim')).length;
  check('sürükleme sırasında her ayara liste gönderilmedi (kuyruk boşalınca bir kez)', araListe <= 2, `${araListe} ara liste`);
  if (A) {
    a.send({ t: 'karisim-al', cihazId: A.cihazId });
    await a.next(t('karisim'));
    a.send({ t: 'karisim-ayar', tur: 'cihaz-ses', id: D.id, deger: 11 });
    a.send({ t: 'karisim-ayar', tur: 'uyg-ses', pid: A.pid, deger: 12 });
    a.send({ t: 'karisim-ayar', tur: 'cihaz-ses', id: D.id, deger: 13 });
    a.send({ t: 'karisim-ayar', tur: 'uyg-ses', pid: A.pid, deger: 14 });
    k = await a.next((x) => x.t === 'karisim' && x.cihazlar.find((c) => c.id === D.id).ses === 13 && x.uygulamalar.find((u) => u.pid === A.pid)?.ses === 14);
    check('iki farklı ayar iç içe: ikisinin de son değeri uygulandı', !!k);
  }

  // ---- Gerçek ayarlar kuru ayarlardan sonra hâlâ aynı ----
  const y3 = yardimci();
  const l3 = (await y3.komut('liste')).m;
  await y3.kapat();
  check('kuru ayarlardan sonra gerçek cihaz sesi / sessizi / varsayılanı değişmedi', l3.cihazlar.map(ozet).join('\n') === C.map(ozet).join('\n'),
    l3.cihazlar.map(ozet).filter((x) => !C.map(ozet).includes(x)).join(' | '));
  if (A) {
    const A3 = l3.uygulamalar.find((u) => u.pid === A.pid && u.cihazId === A.cihazId);
    check('kuru ayarlardan sonra gerçek uygulama sesi değişmedi', !A3 || (A3.ses === A.ses && A3.sessiz === A.sessiz), JSON.stringify(A3));
  }

  // ---- Boşta kapanma (testte 1,5 sn) ve yeniden başlama ----
  await sleep(3000);
  try {
    check('boşta kalınca sunucunun yardımcısı kapandı', surecler().length === 0);
  } catch (err) { check('süreç listesi okundu', false, err.message); }
  a.send({ t: 'karisim-al' });
  k = await a.next(t('karisim'));
  check('kapandıktan sonra yeni istek yardımcıyı yeniden başlattı', k.cihazlar.length === C.length && !k.hata);

  a.ws.close();
  console.log(fails ? `\n${fails} hata` : '\nhepsi geçti');
})().catch((err) => { console.log('FAIL', err.stack || err); process.exit(1); });
