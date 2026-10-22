// Ses karıştırıcı (Windows Ses Karıştırıcısı gibi): ses çıkış cihazı seçimi, cihaz ses seviyesi / sessiz, uygulama başına ses seviyesi / sessiz.
// Okuma ve ayarı helper/Karistirici.exe yapar (Core Audio COM); yalnızca istek gelince başlar, 30 sn boşta kalınca kapanır.
//   İstemci -> sunucu (kontrol yetkisi; salt izleme alamaz):
//     { t:'karisim-al', cihazId? }
//        -> { t:'karisim', cihazlar, cihazId, uygulamalar, kuru?, hata? }
//        cihazlar: etkin çıkış cihazları [{ id, ad, varsayilan, multimedya, iletisim, ses (0-100), sessiz }]
//          (varsayilan / multimedya / iletisim: Windows'un konsol / multimedya / iletişim rolündeki varsayılanı)
//        cihazId: uygulamaların ait olduğu cihaz (istenen; yoksa varsayılan cihaz)
//        uygulamalar: o cihazın ses oturumları [{ pid, ad, ses, sessiz, cihazId, sistem? }] — süreç başına tek satır, Sistem sesleri önce
//        hata: karıştırıcı kullanılamıyorsa (yardımcı derlenemedi / Windows engelledi) neden
//     { t:'karisim-ayar', tur, id | pid, deger }
//        tur: 'cihaz-ses' | 'cihaz-sessiz' | 'varsayilan' (id: listedeki cihaz) | 'uyg-ses' | 'uyg-sessiz' (pid: listedeki uygulama)
//        deger: ses için 0-100, sessiz için true / false; varsayilan'da yok (konsol + multimedya + iletişim rolleri birden)
//        Uygulanır, ardından ayarı gönderen(ler)e güncel liste ({ t:'karisim' }). Geçersizse ya da uygulanamazsa { t:'karisim-hata', msg }.
//   Ayarlar sırayla ve en fazla saniyede ~15 kez yardımcıya gider; araya giren aynı ayarın (tür + cihaz / süreç) yalnızca SON değeri
//   uygulanır (kaydırıcı sürüklenirken). Liste ayar kuyruğu boşalınca bir kez gönderilir.
// REMOTE_KARISIM_KURU=1 (testler; test/calistir.js varsayılanı): ayarlar yardımcıya GİTMEZ — sunucu kaydeder ve listede öyleymiş gibi
//   gösterir (cevapta kuru: { uygulanan }); yardımcı ayrıca "kuru" başlatılır (ayar komutu gelse bile hiçbir şeyi değiştirmez). Okuma gerçektir.
//   REMOTE_KARISIM_BOSTA_MS: boşta kapanma süresi (test kısaltır).
const { spawnHelper, engeller } = require('../lib/helper');

const ISTEK_SURESI = 5000;   // yardımcı bu sürede cevap vermezse yeniden başlatılır
const BOSTA_MS = Number(process.env.REMOTE_KARISIM_BOSTA_MS) || 30000; // son istekten bu kadar sonra yardımcı kapanır (test kısaltır)
const ARALIK_MS = 66;        // iki ayar arası en az (saniyede ~15)
const LISTE_GECIKME = 100;   // ayar kuyruğu boşaldıktan sonra listeyi göndermeden önce (sürükleme sürüyorsa her ayarda liste olmasın)
const TURLER = new Set(['cihaz-ses', 'cihaz-sessiz', 'varsayilan', 'uyg-ses', 'uyg-sessiz']);

const metin = (s, n) => String(s ?? '').replace(/[\u0000-\u001f]/g, '').slice(0, n);
const yuzde = (v) => (Number.isFinite(Number(v)) ? Math.min(100, Math.max(0, Math.round(Number(v)))) : 0);
const gecerliId = (s) => typeof s === 'string' && /^[\x21-\x7e]{1,512}$/.test(s); // boşluk / satır sonu yok: komuta güvenle yazılır

// Yardımcının listesi: türler denetlenir, uygulamalar sıralanır (Sistem sesleri önce, sonra ada göre).
function temizle(r) {
  const cihazlar = (Array.isArray(r.cihazlar) ? r.cihazlar : []).filter((c) => c && gecerliId(c.id)).map((c) => ({
    id: c.id, ad: metin(c.ad, 200) || c.id, varsayilan: c.varsayilan === true, multimedya: c.multimedya === true, iletisim: c.iletisim === true,
    ses: yuzde(c.ses), sessiz: c.sessiz === true,
  }));
  const uygulamalar = (Array.isArray(r.uygulamalar) ? r.uygulamalar : [])
    .filter((u) => u && Number.isInteger(u.pid) && u.pid >= 0 && u.pid <= 0xffffffff && gecerliId(u.cihazId))
    .map((u) => ({ pid: u.pid, ad: metin(u.ad, 200) || `Süreç ${u.pid}`, ses: yuzde(u.ses), sessiz: u.sessiz === true, cihazId: u.cihazId, ...(u.sistem ? { sistem: true } : {}) }))
    .sort((a, b) => (b.sistem ? 1 : 0) - (a.sistem ? 1 : 0) || a.ad.localeCompare(b.ad, 'tr'));
  return { cihazlar, uygulamalar };
}

module.exports.init = (api) => {
  let exe = null, derlemeHatasi = null;
  try { exe = api.buildExe('Karistirici', { refs: [] }); } catch (e) { derlemeHatasi = e.message; api.log('Karistirici.exe derlenemedi:', e.message); }
  const kuru = process.env.REMOTE_KARISIM_KURU === '1';
  const neden = () => (derlemeHatasi ? 'Ses karıştırıcı yardımcı programı derlenemedi.' : engeller.get('Karistirici')?.mesaj
    || (listeHatasi ? `Ses cihazları okunamadı: ${listeHatasi}` : 'Ses karıştırıcı yardımcısı cevap vermedi.'));
  const hata = (ws, msg) => api.sendJson(ws, { t: 'karisim-hata', msg });

  // ---------- Karistirici.exe (istek gelince başlar, boşta kapanır) ----------
  let proc = null, bostaTimer = null;

  function baslat() {
    if (proc || !exe) return;
    const p = spawnHelper('Karistirici', exe, kuru ? ['kuru'] : [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    if (!p) return; // Windows engelledi: bir daha denenmez (uyarı yönetim panelinde)
    proc = p;
    p.bekleyen = []; // sırayla cevaplanan istekler: { resolve, timer }
    let kalan = '';
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d) => {
      kalan += d;
      let i;
      while ((i = kalan.indexOf('\n')) >= 0) {
        const satir = kalan.slice(0, i).trim();
        kalan = kalan.slice(i + 1);
        if (!satir) continue;
        const b = p.bekleyen.shift();
        if (!b) continue;
        clearTimeout(b.timer);
        let m = null;
        try { m = JSON.parse(satir); } catch { /* bozuk satır */ }
        b.resolve(m);
      }
      if (kalan.length > 1 << 20) kalan = '';
    });
    p.stdin.on('error', () => {});
    p.on('error', (e) => api.log('Karistirici.exe başlatılamadı:', e.message));
    p.on('exit', (code) => {
      if (proc === p) { proc = null; api.log(`Karistirici.exe kapandı (kod ${code})`); }
      bitir(p);
    });
  }

  // Sürecin bekleyen isteklerini cevapsız (null) bitirir.
  function bitir(p) {
    for (const b of p.bekleyen.splice(0)) { clearTimeout(b.timer); b.resolve(null); }
  }

  function durdur() {
    clearTimeout(bostaTimer);
    if (!proc) return;
    const p = proc;
    proc = null;
    bitir(p);
    p.stdin.end(); // stdin kapanınca kendisi çıkar
    setTimeout(() => { if (p.exitCode === null) p.kill(); }, 2000);
  }

  // Tek satırlık komut -> cevap nesnesi (yardımcı yoksa / cevap vermezse null). Her komuta tek satır gelir, sırası korunur.
  function istek(satir) {
    baslat();
    if (!proc) return Promise.resolve(null);
    const p = proc;
    clearTimeout(bostaTimer);
    return new Promise((resolve) => {
      const b = {
        resolve: (r) => {
          resolve(r);
          if (proc === p && !p.bekleyen.length) { clearTimeout(bostaTimer); bostaTimer = setTimeout(durdur, BOSTA_MS); }
        },
        timer: setTimeout(() => {
          api.log('Karistirici.exe cevap vermedi, yeniden başlatılacak');
          if (proc === p) durdur(); else bitir(p);
        }, ISTEK_SURESI),
      };
      p.bekleyen.push(b);
      p.stdin.write(`${satir}\n`);
    });
  }

  // ---------- Liste ----------
  let son = null;           // son temizlenmiş liste (doğrulama da bunu kullanır)
  let listeHatasi = null;   // yardımcı listeyi okuyamadıysa nedeni (ör. COM hatası)
  let surenListe = null;    // { promise, ayarNo }: aynı anda gelen istekler tek okumayı paylaşır
  let ayarNo = 0;           // uygulanan ayar sayısı (ayardan önce başlamış okuma, ayardan sonrakine verilmez)
  const kuruDurum = { cihaz: new Map(), uyg: new Map(), varsayilan: null, uygulanan: 0 };

  function liste() {
    if (surenListe && surenListe.ayarNo === ayarNo) return surenListe.promise;
    const s = { ayarNo };
    s.promise = istek('liste').then((r) => {
      if (!r || r.t !== 'liste' || r.ok === false) { listeHatasi = r?.msg ? metin(r.msg, 200) : null; return null; }
      listeHatasi = null;
      son = temizle(r);
      return son;
    }).finally(() => { if (surenListe === s) surenListe = null; });
    surenListe = s;
    return s.promise;
  }

  // Kuru kipte kaydedilen ayarlar listeye işlenir.
  function kuruIsle(l) {
    const k = kuruDurum;
    const cihazlar = l.cihazlar.map((c) => ({ ...c, ...k.cihaz.get(c.id) }));
    if (k.varsayilan && cihazlar.some((c) => c.id === k.varsayilan)) {
      for (const c of cihazlar) c.varsayilan = c.multimedya = c.iletisim = c.id === k.varsayilan;
    }
    return { cihazlar, uygulamalar: l.uygulamalar.map((u) => ({ ...u, ...k.uyg.get(u.pid) })) };
  }

  function gonder(ws, l) {
    if (ws.readyState !== 1) return;
    if (!l) { api.sendJson(ws, { t: 'karisim', cihazlar: [], cihazId: null, uygulamalar: [], hata: neden() }); return; }
    const g = kuru ? kuruIsle(l) : l;
    const secili = g.cihazlar.find((c) => c.id === ws.karisimCihaz) || g.cihazlar.find((c) => c.varsayilan) || g.cihazlar[0] || null;
    api.sendJson(ws, {
      t: 'karisim', cihazlar: g.cihazlar, cihazId: secili ? secili.id : null,
      uygulamalar: secili ? g.uygulamalar.filter((u) => u.cihazId === secili.id) : [],
      ...(kuru ? { kuru: { uygulanan: kuruDurum.uygulanan } } : {}),
    });
  }

  api.on('karisim-al', async (ws, m) => {
    ws.karisimCihaz = gecerliId(m.cihazId) ? m.cihazId : null;
    gonder(ws, await liste());
  }, { role: 'control' });

  // ---------- Ayarlar (sıralı, oran sınırlı, aynı ayarın son değeri) ----------
  const kuyruk = new Map();     // anahtar -> ayar
  const cevapBekleyen = new Set();
  let ayarTimer = null, cevapTimer = null, ayarSuruyor = false, sonAyar = 0;

  function ayarEkle(a) {
    kuyruk.delete(a.anahtar); // sona geçer: sıralama son dokunulana göre
    kuyruk.set(a.anahtar, a);
    cevapBekleyen.add(a.ws);
    planla();
  }

  function planla() {
    if (ayarTimer || ayarSuruyor || !kuyruk.size) return;
    ayarTimer = setTimeout(ayarIsle, Math.max(0, sonAyar + ARALIK_MS - Date.now()));
  }

  async function ayarIsle() {
    ayarTimer = null;
    const [anahtar, a] = kuyruk.entries().next().value;
    kuyruk.delete(anahtar);
    ayarSuruyor = true;
    sonAyar = Date.now();
    let msg = null;
    try { msg = await uygula(a); } catch (e) { msg = e.message; }
    ayarSuruyor = false;
    ayarNo++;
    if (msg) hata(a.ws, `Ayar uygulanamadı: ${msg}`);
    if (kuyruk.size) planla();
    else { clearTimeout(cevapTimer); cevapTimer = setTimeout(cevapGonder, LISTE_GECIKME); }
  }

  async function cevapGonder() {
    cevapTimer = null;
    if (kuyruk.size || ayarSuruyor) return; // ayarIsle bitince yeniden planlar
    const hedef = [...cevapBekleyen];
    cevapBekleyen.clear();
    const l = await liste();
    for (const ws of hedef) gonder(ws, l);
  }

  // Ayarı uygular; hata metni döner (null = tamam).
  async function uygula(a) {
    if (kuru) {
      const k = kuruDurum;
      k.uygulanan++;
      if (a.tur === 'varsayilan') k.varsayilan = a.id;
      else {
        const harita = a.tur.startsWith('uyg-') ? k.uyg : k.cihaz;
        const anah = a.tur.startsWith('uyg-') ? a.pid : a.id;
        harita.set(anah, { ...harita.get(anah), [a.tur.endsWith('-ses') ? 'ses' : 'sessiz']: a.deger });
      }
      return null;
    }
    const hedef = a.tur.startsWith('uyg-') ? a.pid : a.id;
    const deger = a.tur === 'varsayilan' ? '' : ` ${typeof a.deger === 'boolean' ? (a.deger ? 1 : 0) : a.deger}`;
    const r = await istek(`${a.tur} ${hedef}${deger}`);
    if (!r) return neden();
    return r.ok ? null : metin(r.msg, 200) || 'bilinmeyen hata';
  }

  // Kimlik / süreç listede yoksa liste bir kez yenilenip yeniden bakılır (yeni takılan cihaz, yeni açılan uygulama).
  async function listede(bul) {
    if (son && bul(son)) return true;
    const l = await liste();
    return !!(l && bul(l));
  }

  api.on('karisim-ayar', async (ws, m) => {
    const tur = typeof m.tur === 'string' ? m.tur : '';
    if (!TURLER.has(tur)) { hata(ws, 'Bilinmeyen ayar.'); return; }
    const a = { tur, ws };
    if (tur.startsWith('uyg-')) {
      const pid = m.pid;
      if (!Number.isInteger(pid) || pid < 0 || pid > 0xffffffff || !(await listede((l) => l.uygulamalar.some((u) => u.pid === pid)))) {
        hata(ws, 'Uygulama bulunamadı (kapanmış olabilir).');
        return;
      }
      a.pid = pid;
      a.anahtar = `${tur} ${pid}`;
    } else {
      const id = m.id;
      if (!gecerliId(id) || !(await listede((l) => l.cihazlar.some((c) => c.id === id)))) { hata(ws, 'Ses cihazı bulunamadı (çıkarılmış olabilir).'); return; }
      a.id = id;
      a.anahtar = `${tur} ${id}`;
    }
    if (tur.endsWith('-ses')) {
      if (typeof m.deger !== 'number' || !Number.isFinite(m.deger) || m.deger < 0 || m.deger > 100) { hata(ws, 'Ses seviyesi 0 ile 100 arasında olmalı.'); return; }
      a.deger = Math.round(m.deger);
    } else if (tur.endsWith('-sessiz')) {
      if (typeof m.deger !== 'boolean') { hata(ws, 'Sessiz değeri açık / kapalı olmalı.'); return; }
      a.deger = m.deger;
    }
    if (tur === 'varsayilan') ws.karisimCihaz = null; // cevapta yeni varsayılanın uygulamaları
    ayarEkle(a);
  }, { role: 'control' });

  api.onClose((ws) => cevapBekleyen.delete(ws));

  // Sunucu kapanırken yardımcı ortada kalmasın.
  process.on('exit', () => { if (proc) { try { proc.kill(); } catch { /* zaten kapalı */ } } });
};
