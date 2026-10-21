// @sunucu yok
// Yeni cihaz onayı: onay penceresi (RemoteHelper.exe ask) başlayıp 0/1 dışında bir kodla kapanırsa (çökme, ilke kodu, oturum
// masaüstü yok) bu bilgisayardaki yöneticiye 'pencere: false' güncellemesi gider ve tepsi çalışsa bile Windows bildirimi
// (kuru) bir kez gösterilir — istek kimseye görünmeden süre dolup reddedilmesin.
// Sunucu açılmaz: lib/helper.js ve features/baslatma.js bu süreçte, sahte api ile yüklenir. RemoteHelper yerine node.exe verilir
// (REMOTE_EXE_REMOTEHELPER); 'ask' argümanı node için çalışma klasöründeki 'ask' betiğidir ve 5 koduyla çıkar.
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${name} ${extra}`);
  if (cond) pass++; else process.exitCode = 1;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(process.env.TEST_TMP || os.tmpdir(), 'onay-'));
fs.writeFileSync(path.join(tmp, 'ask'), 'process.exit(5);\n');
const eskiCwd = process.cwd();
process.chdir(tmp);
process.env.REMOTE_EXE_REMOTEHELPER = process.execPath;
process.env.REMOTE_BILDIRIM_KURU = '1';
process.env.TRAY_TOKEN = 'deneme'; // tepsi çalışıyor sayılır: normalde pencere açıkken bildirim gösterilmez
delete process.env.REMOTE_BASLATICI;

const helper = require('../lib/helper');
const baslatma = require('../features/baslatma');

const giden = [];
const yonetici = { isLocal: true, session: { role: 'admin', username: 'yonetici' } };
let adminData = null;
const api = {
  clients: new Set([yonetici]),
  sendJson: (ws, m) => { if (ws === yonetici) giden.push(m); },
  on() {}, onAuth() {}, route() {},
  adminData: (fn) => { adminData = fn; },
  log() {},
  store: { log() {}, get: () => null, set() {} },
  PORT: 0,
  dataDir: tmp,
};

(async () => {
  try {
    baslatma.init(api);
    let sonuc = null;
    helper.askHost('Deneme', 'uzak · iPhone', 4000).then((ok) => { sonuc = ok; });
    const ilk = giden.find((m) => m.t === 'onay-istegi');
    check('istek anında pencere açık sayıldı', ilk && ilk.pencere === true, JSON.stringify(ilk));
    const son = Date.now() + 3000;
    while (Date.now() < son && !giden.some((m) => m.t === 'onay-istegi' && m.pencere === false)) await sleep(50);
    const guncel = giden.find((m) => m.t === 'onay-istegi' && m.pencere === false);
    check('pencere 5 koduyla kapanınca yöneticiye pencere:false güncellemesi gitti', !!guncel && guncel.id === ilk?.id);
    check('istek hâlâ bekliyor (pencere kapanması ret sayılmadı)', sonuc === null && helper.onaylar.has(ilk?.id));
    const b = (await adminData()).baslatma.bildirimler.filter((x) => x.tur === 'onay');
    check('tepsi varken de pencere kapanınca onay bildirimi bir kez gösterildi (kuru)', b.length === 1 && /açılamadı/.test(b[0].metin), JSON.stringify(b.map((x) => x.metin)));
    while (sonuc === null) await sleep(100);
    check('süre dolunca reddedildi', sonuc === false);
  } catch (e) {
    check(`beklenmeyen hata: ${e.stack}`, false);
  } finally {
    process.chdir(eskiCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`${pass} kontrol geçti`);
  process.exit();
})();
