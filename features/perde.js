// Gizlilik perdesi: uzaktan bagliyken bilgisayarin kendi ekranini karartir; uzaktaki kisi masaustunu normal gorur.
// Perde ayri bir surectir (helper/Perde.cs). Pencereleri ekran yakalamadan haric tutulamazsa hic acilmaz.
//
//   istemci -> { t: 'perde', acik: true|false }   (kontrol yetkisi + izleme surerken)
//   istemci -> { t: 'perde-sorgu' }                (su anki durum)
//   sunucu  -> { t: 'perde-durum', acik, hata?, neden? }
//
// Perdeyi acan baglantilarin hepsi kapaninca ya da izlemeyi birakinca perde kendiliginden kalkar.
// Bilgisayarin basindaki kisi Ctrl+Alt+Shift+P ile her zaman kapatabilir.
const { spawn } = require('child_process');

const ACILIS_SURESI = 8000;

module.exports.init = (api) => {
  let exe = null;
  let derlemeHatasi = null;
  try { exe = api.buildExe('Perde', { target: 'winexe' }); } catch (e) { derlemeHatasi = e.message; api.log('Perde.cs derlenemedi:', e.message); }

  let proc = null;           // Perde.exe sureci (acilirken ya da acikken)
  let acik = false;          // perde ekranda mi
  const acanlar = new Set(); // perdeyi acan/acik tutan baglantilar

  function yayinla(extra = {}) {
    api.broadcast({ t: 'perde-durum', acik, ...extra });
  }

  // Perde surecini kapatir (stdin kapanisi + kesin oldurme).
  function kapatSurec() {
    const p = proc;
    proc = null;
    acik = false;
    acanlar.clear();
    if (!p) return;
    try { if (p.stdin.writable) p.stdin.end('kapat\n'); } catch {}
    const pid = p.pid;
    const bitti = setTimeout(() => { try { p.kill(); } catch {} }, 1500);
    p.on('exit', () => clearTimeout(bitti));
  }

  function ac() {
    return new Promise((resolve) => {
      if (!exe) { resolve({ ok: false, hata: derlemeHatasi || 'Perde programi yok.' }); return; }
      if (acik) { resolve({ ok: true }); return; }
      if (proc) { resolve({ ok: false, hata: 'Perde zaten aciliyor.' }); return; }
      let bitti = false;
      const tamam = (sonuc) => { if (!bitti) { bitti = true; clearTimeout(zaman); resolve(sonuc); } };
      proc = spawn(exe, [], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
      let tampon = '';
      const zaman = setTimeout(() => { kapatSurec(); tamam({ ok: false, hata: 'Perde zamaninda acilmadi.' }); }, ACILIS_SURESI);

      proc.stdout.on('data', (d) => {
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
            else { const hata = msg.hata; tamam({ ok: false, hata }); }
          } else if (msg.kapandi) {
            // Perde kendiliginden kapandi (yerel kisayol ya da hata).
            acik = false;
            yayinla(msg.hata ? { hata: msg.hata } : { neden: msg.kapandi });
            kapatSurec();
          }
        }
      });
      proc.on('error', (e) => { kapatSurec(); tamam({ ok: false, hata: e.message }); });
      proc.on('exit', () => {
        if (!bitti) tamam({ ok: false, hata: 'Perde beklenmedik sekilde kapandi.' });
        if (acik) { acik = false; yayinla(); }
        proc = null;
        acanlar.clear();
      });
    });
  }

  // Bir baglanti artik perdeyi tutmuyorsa cikar; kimse kalmadiysa perdeyi kapat.
  function birak(ws) {
    if (!acanlar.delete(ws)) return;
    if (acanlar.size === 0 && (acik || proc)) { kapatSurec(); yayinla(); }
  }

  api.on('perde', async (ws, m) => {
    if (m.acik) {
      if (!ws.streaming) { api.sendJson(ws, { t: 'perde-durum', acik, hata: 'Perde yalnizca izleme sirasinda acilir.' }); return; }
      acanlar.add(ws);
      const sonuc = await ac();
      if (sonuc.ok) api.sendJson(ws, { t: 'perde-durum', acik: true });
      else { acanlar.delete(ws); api.sendJson(ws, { t: 'perde-durum', acik, hata: sonuc.hata }); }
    } else {
      birak(ws);
      api.sendJson(ws, { t: 'perde-durum', acik });
    }
  }, { role: 'control' });

  api.on('perde-sorgu', async (ws) => {
    api.sendJson(ws, { t: 'perde-durum', acik });
  });

  // Izlemeyi birakan ya da ayrilan baglanti perdeyi tutamaz.
  api.onClose((ws) => birak(ws));
  api.adminData(async () => ({ perde: { acik, acan: acanlar.size } }));

  // test icin: perdeyi tutan baglanti sayisi ve durum
  module.exports._durum = () => ({ acik, acan: acanlar.size, proc: !!proc });
};
