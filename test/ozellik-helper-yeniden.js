// @sunucu yok
// RemoteHelper.exe açılır açılmaz kapanıyorsa (ör. Windows kapanırken 0xC000026B STATUS_DLL_INIT_FAILED) lib/helper.js onu
// sabit 0,5 sn arayla sonsuza dek yeniden başlatıyordu (günlükte art arda "Yardımcı program kapandı (kod 3221226091)").
// Kanıtlanan: bekleme her hızlı kapanışta iki katına çıkar (0,5 → 1 → 2 …), üst sınırda durur; yardımcı bir süre çalıştıktan
// sonra kapanırsa yine 0,5 sn.
// Gerçek RemoteHelper yerine node.exe verilir (REMOTE_EXE_REMOTEHELPER); NODE_OPTIONS --require ile yüklenen sahte betik
// SAHTE_SURE ms sonra 0xC000026B koduyla çıkar. Ekran yakalanmaz, girdi gönderilmez.
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${name} ${extra}`);
  if (cond) pass++; else process.exitCode = 1;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(process.env.TEST_TMP || os.tmpdir(), 'helper-'));
const sahte = path.join(tmp, 'sahte-helper.js');
fs.writeFileSync(sahte, 'setTimeout(() => process.exit(-1073741205), Number(process.env.SAHTE_SURE) || 0);\n'); // 0xC000026B
process.env.REMOTE_EXE_REMOTEHELPER = process.execPath;
process.env.NODE_OPTIONS = `--require "${sahte.replace(/\\/g, '/')}"`; // tırnak içinde \ kaçış sayılır
process.env.SAHTE_SURE = '0';

const uyarilar = []; // { zaman, metin }
const eskiWarn = console.warn;
console.warn = (...a) => { uyarilar.push({ zaman: Date.now(), metin: a.join(' ') }); };
const bekleme = (u) => Number((/, ([\d.]+) sn sonra yeniden başlatılıyor/.exec(u.metin) || [])[1]);

const { Helper } = require('../lib/helper');
Helper.EN_FAZLA_MS = 2000; // testte üst sınıra çabuk varılsın
Helper.KARARLI_MS = 1200;

(async () => {
  let h;
  try {
    h = new Helper();
    const son = Date.now() + 8000;
    while (Date.now() < son && uyarilar.length < 4) await sleep(50);
    const ilk = uyarilar.slice(0, 4);
    console.log(`     ${ilk.map((u) => u.metin).join(' | ')}`);
    check('kapanış kodu günlükte (0xC000026B = 3221226091)', ilk.length > 0 && /kod 3221226091\)/.test(ilk[0].metin));
    check('hızlı kapanışta bekleme artıyor: 0,5 → 1 → 2 sn, üst sınırda (2 sn) duruyor',
      JSON.stringify(ilk.map(bekleme)) === JSON.stringify([0.5, 1, 2, 2]), JSON.stringify(ilk.map(bekleme)));
    const aralik = ilk.slice(1).map((u, i) => u.zaman - ilk[i].zaman);
    check('yeniden başlatmalar gerçekten bekliyor (art arda kapanışlar arası ≥ 0,45 / 0,95 / 1,9 sn)',
      aralik.length === 3 && aralik[0] >= 450 && aralik[1] >= 950 && aralik[2] >= 1900, JSON.stringify(aralik));

    // Bir süre (KARARLI_MS'ten uzun) çalışıp kapanırsa çökme döngüsü sayılmaz: bekleme yine 0,5 sn
    process.env.SAHTE_SURE = '1600';
    const n = uyarilar.length;
    const son2 = Date.now() + 8000;
    while (Date.now() < son2 && uyarilar.length <= n) await sleep(50);
    const sonraki = uyarilar[n];
    check('bir süre çalıştıktan sonra kapanınca bekleme yeniden 0,5 sn', !!sonraki && bekleme(sonraki) === 0.5, sonraki ? sonraki.metin : 'uyarı yok');
  } catch (e) {
    check(`beklenmeyen hata: ${e.stack}`, false);
  } finally {
    console.warn = eskiWarn;
    process.env.SAHTE_SURE = '0';
    try { h?.proc?.kill(); } catch { /* zaten kapandı */ }
    await sleep(300);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`${pass} kontrol geçti`);
  process.exit();
})();
