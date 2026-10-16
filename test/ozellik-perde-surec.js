// Gizlilik perdesi süreç yönetimi (features/perde.js), gerçek Perde.exe olmadan:
// sahte bir perde programı (node betiği) kullanılır.
// Kanıtlanan: kapat→hemen aç sırasında eski sürecin çıkışı yeni perdenin durumunu silmez; izlemeyi bırakan ya da
// kontrol yetkisi alınan bağlantının perdesi kendiliğinden kalkar.
// @sunucu yok
const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');

let fails = 0;
const check = (n, c, x = '') => { console.log(`${c ? 'OK  ' : 'FAIL'} ${n} ${x}`); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Sahte perde: {"ok":true} yazar, "kapat" satırı ya da stdin kapanınca 400 ms bekleyip çıkar. Ekrana hiçbir şey çizmez.
// (Derlenmiş bir sahte .exe, Uygulama Denetimi / Smart App Control tarafından engellenebildiği için node ile çalışır.)
const SAHTE = `
process.stdout.write('{"ok":true}\\n');
let buf = '';
let bitti = false;
const cik = () => { if (!bitti) { bitti = true; setTimeout(() => process.exit(0), 400); } };
process.stdin.on('data', (d) => { buf += d; if (buf.split('\\n').some((l) => l.trim() === 'kapat')) cik(); });
process.stdin.on('end', cik);
`;

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-perde-sahte-'));
  const sahte = path.join(dir, 'sahte-perde.js');
  fs.writeFileSync(sahte, SAHTE);
  const handlers = {};
  const closeHooks = [];
  const sent = [];
  const api = {
    buildExe: () => [process.execPath, sahte],
    log: () => {},
    on: (t, fn) => { handlers[t] = fn; },
    onClose: (fn) => closeHooks.push(fn),
    adminData: () => {},
    broadcast: () => {},
    sendJson: (ws, m) => sent.push({ ws, m }),
  };
  const perde = require(path.join(ROOT, 'features', 'perde.js'));
  perde.init(api);
  const durum = () => perde._durum();
  const ws = (role = 'control') => ({ readyState: 1, streaming: true, session: { role } });

  try {
    // 1. Aç → kapat → hemen aç: eski sürecin çıkışı yeni perdeyi unutturmamalı.
    const a = ws();
    await handlers.perde(a, { acik: true });
    check('perde açıldı', durum().acik && durum().proc, JSON.stringify(durum()));
    await handlers.perde(a, { acik: false });
    check('perde kapandı', !durum().acik && !durum().proc, JSON.stringify(durum()));
    await handlers.perde(a, { acik: true });
    check('hemen yeniden açıldı', durum().acik && durum().proc && durum().acan === 1, JSON.stringify(durum()));
    await sleep(1500); // eski süreç bu arada çıktı
    check('eski sürecin çıkışı yeni perdeyi silmedi', durum().acik && durum().proc && durum().acan === 1, JSON.stringify(durum()));
    await handlers.perde(a, { acik: false });
    check('yeni perde uzaktan kapatılabildi', !durum().acik && !durum().proc && durum().acan === 0, JSON.stringify(durum()));

    // 2. İzlemeyi bırakan bağlantının perdesi kalkar (bağlantı açık kalsa da).
    const b = ws();
    await handlers.perde(b, { acik: true });
    check('ikinci perde açıldı', durum().acik, JSON.stringify(durum()));
    b.streaming = false;
    await sleep(1500);
    check('izleme bırakılınca perde kalktı', !durum().acik && !durum().proc && durum().acan === 0, JSON.stringify(durum()));

    // 3. Rolü view'a düşürülen bağlantının perdesi kalkar.
    const c = ws();
    await handlers.perde(c, { acik: true });
    check('üçüncü perde açıldı', durum().acik, JSON.stringify(durum()));
    c.session.role = 'view';
    await sleep(1500);
    check('kontrol yetkisi alınınca perde kalktı', !durum().acik && !durum().proc, JSON.stringify(durum()));

    // 4. Bağlantı kapanınca perde kalkar.
    const d = ws();
    await handlers.perde(d, { acik: true });
    for (const fn of closeHooks) fn(d);
    check('bağlantı kapanınca perde kalktı', !durum().acik && !durum().proc, JSON.stringify(durum()));

    await sleep(2500); // tüm sahte süreçler çıksın
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  console.log(fails ? `\n${fails} kontrol BAŞARISIZ` : '\nTüm kontroller geçti');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('TEST HATASI', e); process.exit(1); });
