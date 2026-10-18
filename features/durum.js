// Bilgisayar durumu paneli + uygulama içi bildirimler ("izleyiciler").
// Ölçümleri helper/Durum.exe yapar (kalıcı süreç, Windows API'si; her saniye PowerShell/WMI çalıştırılmaz).
// Durum.exe yalnızca biri paneli açıkken (abone) ya da CPU/pil izleyicisi varken çalışır; süreç listesi ve GPU yalnızca abone varken ölçülür.
//   İstemci -> sunucu:
//     { t:'durum-abone', acik }                        (herkes; salt izleme de görebilir)
//     { t:'durum-kapat', pid, ct, zorla }              (yalnızca yönetici) önce nazik (WM_CLOSE), 5 sn sonra hâlâ açıksa istemci "Zorla kapat" sunar
//     { t:'durum-izle', tur, pid?, ct?, ad?, esik? }   (kontrol+) tur: 'surec' (kapanınca) | 'cpu' (eşiğin altına inince) | 'pil' | 'indirme'
//     { t:'durum-izle-sil', id }                       (kontrol+)
//   Sunucu -> istemci:
//     { t:'durum-ilk', gecmis, son, izleyiciler, kuru, hata? }     abone olunca (son 60 sn)
//     { t:'durum', cpu, ramKul, ramTop, uptime, ag, pil, gpu, diskler, cpuSic, cpuSicNeden, surecler, oz }   saniyede bir, abonelere
//     { t:'durum-kapat-sonuc', asama:'nazik'|'kontrol'|'zorla', ok, pid, ad, pencere?, hala?, kuru?, msg? }
//     { t:'durum-izle-sonuc', ok, msg? }, { t:'durum-izleyiciler', liste }   (liste değişince herkese)
//     { t:'durum-bildirim', id, tur, baslik, metin, zaman, gecikmeli? }       (izleyici tetiklenince bağlı herkese;
//       kimse bağlı değilse saklanır, bir sonraki girişte gösterilir)
// Kayıt: dataDir/durum.json { izleyiciler, bekleyen }.
// REMOTE_DURUM_KURU=1 ise hiçbir program kapatılmaz (testler); REMOTE_INDIRME_DIR: izlenen İndirilenler klasörü (testler geçici klasör verir).
// Telefon kapalıyken bildirim (Web Push) BİLEREK YOK: Apple/Google push sunucularına bağlanmayı gerektirir ("veri dışarı çıkmaz").
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// Kapatılamaz süreçler (küçük harf, .exe'siz). Kapatılırsa Windows çöker, oturum kapanır ya da ekran gider.
const KRITIK = new Set(['system', 'idle', 'secure system', 'registry', 'memory compression', 'smss', 'csrss', 'wininit', 'winlogon',
  'services', 'lsass', 'lsaiso', 'svchost', 'dwm', 'fontdrvhost', 'sihost']);
const ISTEK_SURESI = 5000;
const NAZIK_BEKLEME = 5000;     // nazik kapatmadan sonra "hâlâ açık mı" denetimi
const CPU_SURE = 10;            // CPU bu kadar ölçüm (sn) art arda eşiğin altında kalınca tetiklenir
const YOKLAMA = 2000;           // süreç / indirme izleyicileri yoklama aralığı
const CT_ARALIK = 10000;        // izlenen süreç hâlâ aynı süreç mi (PID yeniden kullanılmış olabilir): oluşturulma zamanı denetimi
const MAX_IZLEYICI = 20;
const GECICI = /\.(crdownload|part|partial|download|tmp|opdownload)$/i;

function koruma(ad, biz) {
  if (biz) return 'Uzaktan Bağlantı\'nın kendi süreci (kapatılırsa bağlantı kopar).';
  const k = String(ad || '').toLowerCase().replace(/\.exe$/, '');
  if (k === 'explorer') return 'Windows Gezgini: görev çubuğu ve masaüstü. Kapatılırsa ekran boş kalır; buradan kapatılamaz.';
  if (KRITIK.has(k)) return 'Windows sistem süreci: kapatılırsa bilgisayar çöker ya da oturum kapanır.';
  return null;
}

const temizAd = (s) => String(s || '').replace(/[\u0000-\u001f]/g, '').slice(0, 120);

module.exports.init = (api) => {
  let exe = null, derlemeHatasi = null;
  try { exe = api.buildExe('Durum', { refs: ['System.Management.dll'] }); } catch (e) { derlemeHatasi = e.message; api.log('Durum.exe derlenemedi:', e.message); }
  const kuru = process.env.REMOTE_DURUM_KURU === '1';
  const indirmeKlasoru = () => process.env.REMOTE_INDIRME_DIR || path.join(os.homedir(), 'Downloads');
  const KAYIT = path.join(api.dataDir, 'durum.json');

  // ---------- Kayıt ----------
  let kayit = { izleyiciler: [], bekleyen: [] };
  try {
    const d = JSON.parse(fs.readFileSync(KAYIT, 'utf8'));
    if (Array.isArray(d.izleyiciler)) kayit.izleyiciler = d.izleyiciler.slice(0, MAX_IZLEYICI);
    if (Array.isArray(d.bekleyen)) kayit.bekleyen = d.bekleyen.slice(-20);
  } catch { /* ilk çalıştırma */ }
  function kaydet() {
    try {
      fs.mkdirSync(api.dataDir, { recursive: true });
      fs.writeFileSync(KAYIT, JSON.stringify({ izleyiciler: kayit.izleyiciler.map(({ _ic, ...x }) => x), bekleyen: kayit.bekleyen }, null, 2));
    } catch (e) { api.log('kaydedilemedi:', e.message); }
  }

  // ---------- Durum.exe ----------
  const aboneler = new Set();
  let proc = null, yenidenTimer = null, ayrintiAcik = null;
  let bekleyenler = [];   // { tur, resolve, timer }
  let son = null;         // son ölçüm
  const gecmis = [];      // son 60 sn: { cpu, ram, gpu, in, out }

  const yardimciGerekli = () => aboneler.size > 0 || kayit.izleyiciler.some((i) => i.tur === 'cpu' || i.tur === 'pil' || (i.tur === 'surec' && i.ct));

  function baslat() {
    if (proc || !exe) return;
    clearTimeout(yenidenTimer);
    const p = spawn(exe, [String(process.pid)], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    proc = p;
    ayrintiAcik = null;
    let kalan = '';
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d) => {
      kalan += d;
      let i;
      while ((i = kalan.indexOf('\n')) >= 0) {
        const satir = kalan.slice(0, i).trim();
        kalan = kalan.slice(i + 1);
        if (satir) satirGeldi(satir);
      }
      if (kalan.length > 1 << 20) kalan = '';
    });
    p.stdin.on('error', () => {});
    p.on('error', (e) => api.log('Durum.exe başlatılamadı:', e.message));
    p.on('exit', (code) => {
      if (proc !== p) return; // bilerek durduruldu
      proc = null;
      bekleyenleriBitir();
      api.log(`Durum.exe kapandı (kod ${code})`);
      yenidenTimer = setTimeout(esitle, 2000);
    });
    api.log(`başladı (Durum.exe pid ${p.pid})`);
    ayrintiEsitle();
  }

  function durdur() {
    clearTimeout(yenidenTimer);
    if (!proc) return;
    const p = proc;
    proc = null;
    bekleyenleriBitir();
    son = null;
    gecmis.length = 0;
    p.stdin.end(); // stdin kapanınca kendisi çıkar
    setTimeout(() => { if (p.exitCode === null) p.kill(); }, 2000);
    api.log('durdu');
  }

  function bekleyenleriBitir() {
    for (const b of bekleyenler) { clearTimeout(b.timer); b.resolve(null); }
    bekleyenler = [];
  }

  function ayrintiEsitle() {
    if (!proc) return;
    const ac = aboneler.size > 0;
    if (ac === ayrintiAcik) return;
    ayrintiAcik = ac;
    proc.stdin.write(`ayrinti ${ac ? 1 : 0}\n`);
  }

  function esitle() {
    if (yardimciGerekli() || bekleyenler.length) { baslat(); ayrintiEsitle(); } else durdur();
    yoklamaEsitle();
  }

  // Komut: "bilgi <pid>" | "kapat <pid> <ct>" | "zorla <pid> <ct>" (yalnızca sayılar; enjeksiyon yok).
  function istek(tur, pid, ct) {
    baslat();
    if (!proc) return Promise.resolve(null);
    const p = proc;
    return new Promise((resolve) => {
      const b = {
        tur,
        resolve: (r) => { resolve(r); setImmediate(esitle); },
        timer: setTimeout(() => {
          api.log('Durum.exe cevap vermedi, yeniden başlatılıyor');
          if (proc === p) durdur();
          b.resolve(null);
        }, ISTEK_SURESI),
      };
      bekleyenler.push(b);
      p.stdin.write(`${tur} ${pid}${tur === 'bilgi' ? '' : ` ${ct || 0}`}\n`);
    });
  }

  function satirGeldi(satir) {
    let m;
    try { m = JSON.parse(satir); } catch { return; }
    if (m.t === 'olcum') return olcumGeldi(m);
    if (m.t === 'error') { api.log('Durum.exe:', m.msg); if (!bekleyenler.length) return; }
    const i = bekleyenler.findIndex((b) => b.tur === m.t || m.t === 'error');
    if (i < 0) return;
    const [b] = bekleyenler.splice(i, 1);
    clearTimeout(b.timer);
    b.resolve(m.t === 'error' ? null : m);
  }

  function olcumGeldi(m) {
    m.t = 'durum';
    if (Array.isArray(m.surecler)) {
      for (const s of m.surecler) {
        const k = koruma(s.ad, s.biz);
        if (k) s.koruma = k;
        delete s.biz;
      }
    }
    son = m;
    gecmis.push({
      cpu: m.cpu, ram: m.ramTop ? Math.round((1000 * m.ramKul) / m.ramTop) / 10 : null,
      gpu: m.gpu?.[0]?.kul ?? null, in: m.ag?.in ?? null, out: m.ag?.out ?? null,
    });
    if (gecmis.length > 60) gecmis.shift();
    if (aboneler.size) {
      const s = JSON.stringify(m);
      for (const ws of aboneler) if (ws.readyState === 1) ws.send(s);
    }
    olcumIzleyicileri(m);
  }

  // ---------- Abonelik ----------
  api.on('durum-abone', async (ws, m) => {
    if (m.acik) {
      aboneler.add(ws);
      esitle();
      api.sendJson(ws, {
        t: 'durum-ilk', gecmis, son, izleyiciler: liste(), kuru,
        hata: exe ? undefined : `Ölçüm programı derlenemedi${derlemeHatasi ? `: ${derlemeHatasi.split('\n')[0]}` : '.'}`,
      });
    } else {
      aboneler.delete(ws);
      esitle();
    }
  });

  api.onClose((ws) => {
    if (aboneler.delete(ws)) esitle();
  });

  // ---------- Program kapatma (yalnızca yönetici) ----------
  async function dogrula(m) {
    const pid = Number(m.pid);
    if (!Number.isInteger(pid) || pid <= 4) return { hata: 'Geçersiz süreç.' };
    const ct = /^\d{1,20}$/.test(String(m.ct || '')) ? String(m.ct) : '0';
    const b = await istek('bilgi', pid);
    if (!b) return { hata: 'Ölçüm programı çalışmıyor.' };
    if (!b.var || (ct !== '0' && ct !== b.ct)) return { hata: 'Program zaten kapanmış.' };
    const k = koruma(b.ad, b.biz);
    if (k) return { hata: `Kapatılamaz — ${k}`, ad: b.ad };
    return { pid, ct: b.ct, ad: b.ad };
  }

  api.on('durum-kapat', async (ws, m) => {
    const zorla = !!m.zorla;
    const asama = zorla ? 'zorla' : 'nazik';
    const v = await dogrula(m);
    const cevap = (o) => api.sendJson(ws, { t: 'durum-kapat-sonuc', asama, pid: Number(m.pid), ad: v.ad, kuru, ...o });
    if (v.hata) return cevap({ ok: false, msg: v.hata });
    api.store.log('durum', { user: ws.session.username, ip: ws.ip, op: zorla ? 'zorla-kapat' : 'kapat', target: `${v.ad} (${v.pid})${kuru ? ' — deneme, kapatılmadı' : ''}` });
    api.log(`${ws.session.username} → ${zorla ? 'zorla kapat' : 'kapat'} ${v.ad} (${v.pid})${kuru ? ' (kuru mod)' : ''}`);

    let r;
    if (kuru) r = { ok: true, pencere: zorla ? undefined : 1, msg: 'Deneme modu — program kapatılmadı.' };
    else r = await istek(zorla ? 'zorla' : 'kapat', v.pid, v.ct);
    if (!r) return cevap({ ok: false, msg: 'Ölçüm programı cevap vermedi.' });
    cevap({ ok: !!r.ok, pencere: r.pencere, msg: r.msg });
    if (zorla || !r.ok) return;

    // Nazik kapatma: penceresi yoksa hemen, varsa 5 sn sonra hâlâ açık mı bak.
    const kontrol = async () => {
      const b = await istek('bilgi', v.pid);
      const hala = !!(b && b.var && b.ct === v.ct);
      api.sendJson(ws, { t: 'durum-kapat-sonuc', asama: 'kontrol', ok: true, pid: v.pid, ct: v.ct, ad: v.ad, hala, kuru });
    };
    if (!r.pencere) kontrol();
    else setTimeout(kontrol, NAZIK_BEKLEME);
  }, { role: 'admin' });

  // ---------- İzleyiciler ----------
  const liste = () => kayit.izleyiciler.map(({ _ic, ...x }) => x);
  const listeYay = () => api.broadcast({ t: 'durum-izleyiciler', liste: liste() });

  function aciklama(i) {
    if (i.tur === 'surec') return `${i.ad} kapanınca`;
    if (i.tur === 'cpu') return `CPU %${i.esik} eşiğinin altına inince`;
    if (i.tur === 'pil') return `Pil %${i.esik} eşiğinin altına inince`;
    return 'İndirilenler\'e yeni dosya gelince';
  }

  function indirmeAnlik() {
    const d = new Map();
    for (const f of fs.readdirSync(indirmeKlasoru(), { withFileTypes: true })) {
      if (!f.isFile()) continue;
      let boyut = -1;
      try { boyut = fs.statSync(path.join(indirmeKlasoru(), f.name)).size; } catch { /* silinmiş */ }
      d.set(f.name, boyut);
    }
    return d;
  }

  api.on('durum-izle', async (ws, m) => {
    const cevap = (ok, msg) => api.sendJson(ws, { t: 'durum-izle-sonuc', ok, msg });
    if (kayit.izleyiciler.length >= MAX_IZLEYICI) return cevap(false, `En fazla ${MAX_IZLEYICI} izleyici kurulabilir.`);
    const i = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, tur: String(m.tur || ''), olusturan: ws.session.username, zaman: Date.now() };
    if (i.tur === 'surec') {
      const pid = Number(m.pid);
      if (!Number.isInteger(pid) || pid <= 4) return cevap(false, 'Geçersiz süreç.');
      if (!canli(pid)) return cevap(false, 'Program zaten kapanmış.');
      // ct (oluşturulma zamanı) saklanır: PID başka sürece verilirse (ör. yeniden başlatma sonrası) izleyici yanlış programa bağlanmasın.
      const ct = /^\d{1,20}$/.test(String(m.ct || '')) ? String(m.ct) : null;
      const b = await istek('bilgi', pid);
      if (b && (!b.var || (ct && ct !== b.ct))) return cevap(false, 'Program zaten kapanmış.');
      if (kayit.izleyiciler.some((x) => x.tur === 'surec' && x.pid === pid)) return cevap(false, 'Bu program zaten izleniyor.');
      if (kayit.izleyiciler.length >= MAX_IZLEYICI) return cevap(false, `En fazla ${MAX_IZLEYICI} izleyici kurulabilir.`);
      Object.assign(i, { pid, ct: b?.ct || ct, ad: temizAd(m.ad) || `PID ${pid}` });
    } else if (i.tur === 'cpu' || i.tur === 'pil') {
      const esik = Math.round(Number(m.esik ?? (i.tur === 'cpu' ? 10 : 20)));
      if (!(esik >= 1 && esik <= (i.tur === 'cpu' ? 95 : 99))) return cevap(false, 'Geçersiz eşik.');
      if (i.tur === 'pil' && son && !son.pil) return cevap(false, 'Bu bilgisayarda pil yok.');
      i.esik = esik;
    } else if (i.tur === 'indirme') {
      if (kayit.izleyiciler.some((x) => x.tur === 'indirme')) return cevap(false, 'İndirilenler zaten izleniyor.');
      try { i._ic = { once: indirmeAnlik(), aday: new Map() }; } catch { return cevap(false, 'İndirilenler klasörü okunamadı.'); }
    } else return cevap(false, 'Geçersiz izleyici.');
    i.metin = aciklama(i);
    kayit.izleyiciler.push(i);
    kaydet();
    cevap(true);
    listeYay();
    esitle();
  }, { role: 'control' });

  api.on('durum-izle-sil', async (ws, m) => {
    const n = kayit.izleyiciler.length;
    kayit.izleyiciler = kayit.izleyiciler.filter((i) => i.id !== m.id);
    if (kayit.izleyiciler.length === n) return;
    kaydet();
    listeYay();
    esitle();
  }, { role: 'control' });

  function tetikle(i, baslik, metin) {
    kayit.izleyiciler = kayit.izleyiciler.filter((x) => x !== i);
    const b = { t: 'durum-bildirim', id: i.id, tur: i.tur, baslik, metin, zaman: Date.now() };
    api.log(`bildirim: ${baslik} — ${metin}`);
    if (api.clients.size) api.broadcast(b);
    else { kayit.bekleyen.push(b); kayit.bekleyen = kayit.bekleyen.slice(-20); }
    kaydet();
    listeYay();
    esitle();
  }

  // Bağlantı yokken tetiklenenler: bir sonraki girişte (kim girerse) gösterilir.
  api.onAuth((ws) => {
    if (!kayit.bekleyen.length) return;
    for (const b of kayit.bekleyen) api.sendJson(ws, { ...b, gecikmeli: true });
    kayit.bekleyen = [];
    kaydet();
  });

  function olcumIzleyicileri(m) {
    for (const i of [...kayit.izleyiciler]) {
      if (i.tur === 'cpu') {
        i._ic = i._ic || { sayac: 0 };
        i._ic.sayac = m.cpu < i.esik ? i._ic.sayac + 1 : 0;
        if (i._ic.sayac >= CPU_SURE) tetikle(i, 'CPU boşaldı', `İşlemci kullanımı ${CPU_SURE} saniyedir %${i.esik} eşiğinin altında (şu an %${Math.round(m.cpu)}).`);
      } else if (i.tur === 'pil' && m.pil && !m.pil.fis && m.pil.yuzde < i.esik) {
        tetikle(i, 'Pil azaldı', `Pil %${m.pil.yuzde} — bilgisayarı prize takın.`);
      }
    }
  }

  // Süreç var mı: sinyal 0 hiçbir şey göndermez; EPERM = var ama erişim yok (yönetici süreci).
  function canli(pid) {
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
  }

  let yoklamaTimer = null;
  function yoklamaEsitle() {
    const gerekli = kayit.izleyiciler.some((i) => i.tur === 'surec' || i.tur === 'indirme');
    if (gerekli && !yoklamaTimer) yoklamaTimer = setInterval(yokla, YOKLAMA);
    if (!gerekli && yoklamaTimer) { clearInterval(yoklamaTimer); yoklamaTimer = null; }
  }

  function yokla() {
    for (const i of [...kayit.izleyiciler]) {
      if (i.tur === 'surec' && !canli(i.pid)) tetikle(i, 'Program kapandı', `${i.ad} kapandı.`);
      else if (i.tur === 'surec' && i.ct && !(i._ic?.ctZaman > Date.now() - CT_ARALIK)) ctDenetle(i);
      else if (i.tur === 'indirme') indirmeYokla(i);
    }
  }

  // PID canlı ama oluşturulma zamanı farklı: izlenen program kapanmış, PID başka sürece verilmiş.
  // (_ic kaydedilmez: sunucu açılışında ilk yoklamada hemen denetlenir.)
  async function ctDenetle(i) {
    i._ic = { ctZaman: Date.now() };
    const b = await istek('bilgi', i.pid);
    if (!b || !kayit.izleyiciler.includes(i)) return;
    if (!b.var || b.ct !== i.ct) tetikle(i, 'Program kapandı', `${i.ad} kapandı.`);
  }

  // Yeni dosya: geçici uzantılı değil (.crdownload/.part...), yanında aynı adlı geçici dosya yok (Firefox önce boş dosya açar)
  // ve boyutu iki yoklamada aynı.
  function indirmeYokla(i) {
    let simdi;
    try { simdi = indirmeAnlik(); } catch { return; }
    if (!i._ic) { i._ic = { once: simdi, aday: new Map() }; return; } // sunucu yeniden başladı: şimdiki hali temel al
    const { once, aday } = i._ic;
    for (const [ad, boyut] of simdi) {
      if (once.has(ad) || GECICI.test(ad) || ad.startsWith('~$') || boyut < 0) continue;
      if (simdi.has(`${ad}.part`) || simdi.has(`${ad}.crdownload`)) { aday.delete(ad); continue; }
      if (aday.get(ad) === boyut) return tetikle(i, 'İndirme bitti', `${ad} (${boyutYaz(boyut)}) İndirilenler klasörüne geldi.`);
      aday.set(ad, boyut);
    }
    for (const ad of aday.keys()) if (!simdi.has(ad)) aday.delete(ad);
    // Silinen dosyalar listeden çıksın; yeniden gelirse yeni sayılır.
    for (const ad of [...once.keys()]) if (!simdi.has(ad)) once.delete(ad);
  }

  const boyutYaz = (b) => (b >= 1 << 30 ? `${(b / (1 << 30)).toFixed(1)} GB` : b >= 1 << 20 ? `${(b / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

  api.adminData(async () => ({ durum: { calisiyor: !!proc, izleyici: kayit.izleyiciler.length, kuru } }));

  esitle(); // kayıtlı izleyiciler varsa yoklama / ölçüm başlasın
};

module.exports.koruma = koruma;
