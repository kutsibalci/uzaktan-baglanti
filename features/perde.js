// Gizlilik perdesi: uzaktan bagliyken bilgisayarin kendi ekranini karartir; uzaktaki kisi masaustunu normal gorur.
// Perde ayri bir surectir (helper/Perde.cs). Pencereleri ekran yakalamadan haric tutulamazsa hic acilmaz.
//
//   istemci -> { t: 'perde', acik: true|false }   (kontrol yetkisi + izleme surerken)
//   istemci -> { t: 'perde-sorgu' }                (su anki durum)
//   sunucu  -> { t: 'perde-durum', acik, hata?, neden? }
//
// Perdeyi acan baglantilarin hepsi kapaninca, izlemeyi birakinca ya da kontrol yetkisini kaybedince
// perde kendiliginden kalkar. Bilgisayarin basindaki kisi Ctrl+Alt+Shift+P ile her zaman kapatabilir.
const { spawn } = require('child_process');

const ACILIS_SURESI = 8000;
const KAPANIS_BEKLE = 2000;  // eski surecin cikmasi icin en fazla bekleme (kisayol cakismasin)
const YOKLAMA_MS = 1000;

module.exports.init = (api) => {
  let exe = null;
  let derlemeHatasi = null;
  try { exe = api.buildExe('Perde', { target: 'winexe' }); } catch (e) { derlemeHatasi = e.message; api.log('Perde.cs derlenemedi:', e.message); }

  let proc = null;           // GECERLI Perde.exe sureci (acilirken ya da acikken)
  let acik = false;          // perde ekranda mi
  const acanlar = new Set(); // perdeyi acan/acik tutan baglantilar
  let kapanan = null;        // kapatilmakta olan eski surecin cikisi (Promise) ya da null

  function yayinla(extra = {}) {
    api.broadcast({ t: 'perde-durum', acik, ...extra });
  }

  // Gecerli perde surecini kapatir (stdin kapanisi + kesin oldurme). Kapatilan surecin
  // isleyicileri bundan sonra durumu degistirmez (proc !== p).
  function kapatSurec() {
    const p = proc;
    proc = null;
    acik = false;
    acanlar.clear();
    if (!p) return;
    try { if (p.stdin.writable) p.stdin.end('kapat\n'); } catch {}
    if (p.exitCode !== null || p.signalCode !== null) return;
    const bitti = setTimeout(() => { try { p.kill(); } catch {} }, 1500);
    const cikis = new Promise((resolve) => p.once('exit', () => { clearTimeout(bitti); resolve(); }));
    kapanan = cikis;
    cikis.then(() => { if (kapanan === cikis) kapanan = null; });
  }

  async function ac() {
    if (!exe) return { ok: false, hata: derlemeHatasi || 'Perde programi yok.' };
    if (acik) return { ok: true };
    if (proc) return { ok: false, hata: 'Perde zaten aciliyor.' };
    // Eski perde hala cikiyorsa bekle: ayni kisayolu (RegisterHotKey) iki surec tutamaz.
    if (kapanan) {
      await Promise.race([kapanan, new Promise((r) => setTimeout(r, KAPANIS_BEKLE))]);
      if (acik) return { ok: true };
      if (proc) return { ok: false, hata: 'Perde zaten aciliyor.' };
    }
    return new Promise((resolve) => {
      let bitti = false;
      const tamam = (sonuc) => { if (!bitti) { bitti = true; clearTimeout(zaman); resolve(sonuc); } };
      // exe bir dizi de olabilir ([program, ...arguman]); testler sahte perdeyi node ile calistirir.
      const [komut, ...arglar] = Array.isArray(exe) ? exe : [exe];
      const p = spawn(komut, arglar, { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
      proc = p;
      const gecerli = () => proc === p;
      let tampon = '';
      const zaman = setTimeout(() => { if (gecerli()) kapatSurec(); tamam({ ok: false, hata: 'Perde zamaninda acilmadi.' }); }, ACILIS_SURESI);

      p.stdout.on('data', (d) => {
        if (!gecerli()) return;
        tampon += d.toString();
        let i;
        while ((i = tampon.indexOf('\n')) >= 0) {
          const satir = tampon.slice(0, i).trim();
          tampon = tampon.slice(i + 1);
          if (!satir) continue;
          let msg;
          try { msg = JSON.parse(satir); } catch { continue; }
          if (typeof msg.ok === 'boolean') {
            // Acilis cevabi.
            if (msg.ok) { acik = true; tamam({ ok: true }); yayinla(); }
            else { tamam({ ok: false, hata: msg.hata }); }
          } else if (msg.kapandi) {
            // Perde kendiliginden kapandi (yerel kisayol ya da hata).
            kapatSurec();
            yayinla(msg.hata ? { hata: msg.hata } : { neden: msg.kapandi });
            return;
          }
        }
      });
      p.on('error', (e) => {
        if (gecerli()) kapatSurec();
        tamam({ ok: false, hata: e.message });
      });
      p.on('exit', () => {
        tamam({ ok: false, hata: 'Perde beklenmedik sekilde kapandi.' });
        if (!gecerli()) return; // kapatilmis eski surec: yeni perdenin durumuna dokunma
        const vardi = acik;
        proc = null;
        acik = false;
        acanlar.clear();
        if (vardi) yayinla();
      });
    });
  }

  // Bir baglanti artik perdeyi tutmuyorsa cikar; kimse kalmadiysa perdeyi kapat.
  function birak(ws) {
    if (!acanlar.delete(ws)) return;
    if (acanlar.size === 0 && (acik || proc)) { kapatSurec(); yayinla(); }
  }

  const tutabilir = (ws) => ws.readyState === 1 && ws.streaming && ws.session && ws.session.role !== 'view';

  api.on('perde', async (ws, m) => {
    if (m.acik) {
      if (!ws.streaming) { api.sendJson(ws, { t: 'perde-durum', acik, hata: 'Perde yalnizca izleme sirasinda acilir.' }); return; }
      acanlar.add(ws);
      const sonuc = await ac();
      if (sonuc.ok && acanlar.has(ws)) api.sendJson(ws, { t: 'perde-durum', acik: true });
      else if (sonuc.ok) { birak(ws); api.sendJson(ws, { t: 'perde-durum', acik }); }
      else { birak(ws); api.sendJson(ws, { t: 'perde-durum', acik, hata: sonuc.hata }); }
    } else {
      birak(ws);
      api.sendJson(ws, { t: 'perde-durum', acik });
    }
  }, { role: 'control' });

  api.on('perde-sorgu', async (ws) => {
    api.sendJson(ws, { t: 'perde-durum', acik });
  });

  // Ayrilan baglanti perdeyi tutamaz.
  api.onClose((ws) => birak(ws));
  // Izlemeyi birakan (baglantisi acik kalsa da) ya da kontrol yetkisi alinan baglanti da tutamaz.
  // Izleme baslatma/durdurma cekirdekte oldugundan saniyede bir yoklanir (yalnizca bayrak okuma).
  setInterval(() => {
    for (const ws of [...acanlar]) if (!tutabilir(ws)) birak(ws);
  }, YOKLAMA_MS).unref();

  api.adminData(async () => ({ perde: { acik, acan: acanlar.size } }));

  // test icin: perdeyi tutan baglanti sayisi ve durum
  module.exports._durum = () => ({ acik, acan: acanlar.size, proc: !!proc });
};
