# Özellik modülleri

Her özellik iki parçadan oluşur ve çekirdek dosyalara (server.js, public/app.js) mümkün olduğunca dokunmaz:

| Parça | Yer | Bağlantı |
|---|---|---|
| Sunucu | `features/<ad>.js` | `module.exports.init = (api) => {...}` — bkz. `lib/extensions.js` başındaki açıklama |
| Tarayıcı | `public/features/<ad>.js` | `window.RC` — bkz. `public/app.js` sonundaki "Özellik betikleri için arayüz" |
| Yerel program (gerekirse) | `helper/<Ad>.cs` | `api.buildExe('<Ad>')` ile açılışta derlenir |
| Test | `test/ozellik-<ad>.js` | `node test/calistir.js ozellik-<ad>` |

## Sunucu API (özet)
- `api.on(tür, async (ws, m) => {}, { role })` — WebSocket mesajı. `role`: `'view' | 'control' | 'admin'` (en az).
- `api.route(method, önek, async (req, res, ws, url) => {}, { role })` — HTTP adresi; istemci `RC.fetch()` / `RC.authUrl()` ile oturumla çağırır.
  `{ isPublic: true }` ile oturum kontrolü atlanır (ws = null) — kimlik doğrulamayı özellik kendisi yapar (ör. `api.clientInfo(req).isLocal` + gizli belirteç).
- `api.onPreAuth(tür, async (ws, m) => {})` — giriş yapmamış bağlantının mesajı (ör. QR eşleştirme); kaba kuvvet kilidi çekirdekte denetlenir. Giriş: `api.auth.finish(ws, { username, role, deviceId, token, deviceName })`, `api.auth.fail(ws, hata, kayıt?)`, `api.auth.forgive(ip)`.
- `api.onAuth(ws => {})`, `api.onClose(ws => {})`, `api.adminData(async () => ({ <ad>: {...} }))`
- Çekirdek: `api.helper`, `api.video`, `api.store`, `api.clients`, `api.sendJson(ws, obj)`, `api.broadcast(obj, filtre)`, `api.buildExe(ad, {target})`, `api.dataDir`, `api.PORT`, `api.https` (ev ağı HTTPS dinleyicisi: `ac({ key, cert })`, `kapat()`, `port()` — yalnızca `features/sertifika.js` kullanır), `api.log(...)`, `api.guestCode()`, `api.kick(ws => bool, neden)`, `api.clientInfo(req)`
- Özellikler arası olaylar: `require('../lib/olaylar')` (ortak EventEmitter; özellikler birbirini doğrudan require etmez). Şimdilik: `dosya-geldi` (dosya.js yayar → tepsi.js tepsi bildirimine çevirir), `http-bayt` (ws; lib/extensions.js her oturumlu HTTP isteği bitince yayar, baytlar `ws.httpBayt = { alinan, gonderilen }` → veri.js), `veri-tasarruf` (ws; veri.js yayar → ses.js bit hızını seçer).
- Ortak yardımcılar: `lib/zip.js` (akışla zip yazıcı: deflate/store, data descriptor, ZIP64, UTF-8 adlar; dosya.js zip indirmede kullanır).
- `ws.session` → `{ username, role, guest, view: { screen, ... } }`, `ws.streaming`, `ws.isLocal`, `ws.via`

## Tarayıcı API (özet)
- `RC.send(obj)`, `RC.on(tür, fn)` — sunucu mesajları ve yerel olaylar: `auth`, `viewer:start`, `viewer:stop`, `admin`, `disconnect`, `binary:<n>` (ikili mesaj, ilk bayt n ≥ 3)
- `RC.setPenActive(fn)` — kalem özelliği, kalem olaylarını kendisi işlediği sürece `fn()` true döner; o zaman çekirdek kalemin ürettiği fare/dokunma olaylarını yok sayar (aksi halde kalem fare gibi çalışır)
- `RC.setAuthHook(fn)` — sunucu `hello` gönderince `fn(hello)` girişi üstlenip (mesajı kendisi gönderip) true dönebilir; `auth` cevabını çekirdek işler (QR eşleştirme). `RC.deviceName()` — "iPhone · Safari" gibi cihaz adı.
- `RC.traffic()` — sayfa açıldığından beri WebSocket baytları (birikimli, çerçeve başlığı dahil): `{ goruntu, ses, diger, giden }` (veri sayacı kullanır)
- `RC.stats()` — son bir saniyenin görüntü ölçümleri `{ fps, kbps, decodeMs, codec, intervalMs, jitterMs, maxIntervalMs, stutters }` (gecikme sayacı kullanır; durağan ekrandan sonraki aralık sayılmaz — sunucu JPEG'de aynı kareyi göndermeyince bir kez `{ t: 'durgun' }` yollar)
- `RC.state()` (`{ me, stream, screens, connected, vdd }`; vdd: sanal ekran sürücüsü kurulu mu), `RC.canInput()`, `RC.toNorm(x, y)`, `RC.moveNow`, `RC.queueMove`, `RC.click(b)`, `RC.overlay(msg)`
- `RC.fetch(url, opts)`, `RC.authUrl(url)`
- `RC.ui.home(el)`, `RC.ui.adminSection(başlık, el)`, `RC.ui.stage()`, `RC.ui.canvas()`, `RC.ui.menuItem`, `RC.ui.panel`, `RC.ui.closable`, `RC.ui.toolbar` (aşağıda)
- Simgeler: `icon` ve ana menü düğmesinin baştaki emojisi (`'📁 Dosya aktarımı'`) `public/ikon.js` tablosundaysa SVG'ye çevrilir (renkli kutucuk);
  yeni bir simge için tabloya çizim + renk + emoji ekleyin, yoksa emoji olduğu gibi görünür. `RC.ui.home`: düğme (ya da `div > button` + açılır
  bölüm) araçlar ızgarasına, düğmesiz öğe (uyarı şeridi) kartların üstüne yerleşir. Renkler `style.css` `:root` değişkenleri (`--accent`, `--panel`…).

### Görüntüleyici arayüzü (araç çubuğu, menü, paneller)
Telefonda (< 720 px) üstte yalnızca geri, bağlantı/görüntü bilgisi ve gecikme sayacı; **alt çubukta** (yazılı) Klavye, Tuşlar, dokunma modu, Sağ tık,
`alt` seçenekli menü satırları (Pano) ve **Diğer** (⋯ menü; telefonda alttan açılan sade liste, `ikincil` satırlar "Daha fazla"da). Düğmeler `app.js yerlesim()` ile ekran
genişliğine göre üst/alt çubuk arasında TAŞINIR (kimlikler aynı). Geniş ekranda hepsi üst çubukta, simge olarak. Telefonda açılır paneller
alttan açılır (alt çubuğun üstüne yaslanır). İlk bağlantı tanıtımı: `public/features/tanitim.js` (sunucu `REMOTE_TANITIM=0` ile kapatır).
- `RC.ui.menuItem({ id, icon, label, state, title, order, onClick, pin, alt, ikincil, ctl, extend, keepOpen, hidden, disabled })` → `{ el, pinEl, set({...}) }`
  - Menüde etiketli satır (simge + ad + sağda durum, ör. "Ses · kapalı"). `order` küçükten büyüğe (çekirdek: 1–2 kalite/ekran, 80 tam ekran, 90 çubuğu gizle; özellikler 10–60).
  - `pin: true` → geniş ekranda (≥ 720 px) çubukta simge olarak da görünür (`pinEl`, kimliği `<id>Pin`). `alt: 'Pano'` → telefonda alt çubukta bu kısa adla (aynı `pinEl`; yer dar, yalnızca çok sık kullanılanlar). `ikincil: true` → telefonda menünün "Daha fazla" bölümünde katlı (az kullanılanlar). `ctl: true` → salt izleme rolünde gizli; `extend: false` → ikinci ekranda gizli.
  - `keepOpen: true` → tıklayınca menü kapanmaz (aç/kapa satırları). Durum değişince `set({ icon, label, state, title, hidden, disabled, active, badge })`; `badge` satırda ve ⋯ düğmesinde nokta gösterir.
- `RC.ui.panel(başlık, { id, anchor, dock, dismiss, className, onOpen, onClose })` → `{ el, head, body, open(), close(), toggle(), isOpen(), addAnchor(el), setTitle(t) }`
  - Köşesinde ✕ olan ortak panel; içerik `body`'ye konur. Esc en son açılan paneli kapatır (bilgisayara Esc gitmez).
  - Açılır panel (varsayılan) çubuğun altında açılır, dışarı dokununca kapanır; aynı anda tek açılır panel açık kalır. Görüntünün üstüne yapılan kapatma dokunuşu bilgisayara tıklama olarak gitmez. `anchor`: paneli açıp kapatan düğme(ler) — onlara dokunmak "dışarı" sayılmaz.
  - `dock: 'bottom'` → görüntünün altına kenetlenir (ekranı örtmez), dışarı dokunmak kapatmaz (ör. Tuşlar paneli).
- `RC.ui.closable(el, kapat, { dismiss, anchor })` — kendi kabuğu olan öğeyi (ör. tam ekran dosya paneli) Esc ile kapanacak şekilde kaydeder.
- `RC.ui.toolbar(el)` — eski yol, geriye uyumlu: öğeyi çubuğun sağ ucuna (her genişlikte) ekler. Telefonda yer dar; yalnızca küçük göstergeler için (ör. gecikme sayacı), düğmeler için `menuItem` kullanın.
- Salt izleme rolünde `<body>`'de `rc-salt`, ikinci ekranda `rc-genislet` sınıfı vardır (`.ctl` / `.no-extend` öğeler CSS ile gizlenir).
  Dokunmatik touchpad modunda `rc-touchpad` (sahnedeki öğeler dokunma olaylarını durdurmamalı: bütün sahne dokunmatik yüzey; ör. ekran etiketleri touch olaylarını çekirdeğe bırakır, fareyle yine tıklanır).
- Özel tuşlar (kısayollar, yapışkan Ctrl/Alt/Shift/Win, oklar, F1–F12) `public/features/telefon.js`'teki "Tuşlar" panelindedir.

## Özellik mesajları (JSON, özet; ayrıntı her dosyanın başında)
- `kumanda.js` — `{ t:'kumanda', op: rel|down|up|wheel|key|text|end }` (control; görüntü akışı olmadan girdi). RemoteHelper'da salt okuyan `cursor` komutu (GetCursorPos). Testte `REMOTE_KUMANDA_KURU=1`: girdi gönderilmez.
- `cizim.js` — `{ t:'cizim-tus', vk, down }` (control; basılı tuşlar bağlantı kopunca / izleme bitince bırakılır, en fazla 8).
- `eslestir.js` — QR eşleştirme: `onPreAuth('eslestir')` + yönetici ekranında `eslestir-*` mesajları; telefona `eslestir-kod` (onay isteğindeki doğrulama koduyla aynı), `eslestir-olustur` `http: true` ile şifresiz adres. Testte `REMOTE_ESLESTIR_SURE_MS`, `REMOTE_ESLESTIR_ONAY_MS`, `REMOTE_ESLESTIR_TAILSCALE=0`.
- `durum.js` — `durum-abone`, `durum`, `durum-ilk`, `durum-kapat` (admin) / `durum-kapat-sonuc`, `durum-izle` / `durum-izle-sil` / `durum-izleyiciler`, `durum-bildirim`. `REMOTE_DURUM_KURU=1`: program kapatılmaz; `REMOTE_INDIRME_DIR`: izlenen İndirilenler.
  `durum` mesajında `gruplar`: Görev Yöneticisi gibi süreç grupları (aynı adlı ebeveyn → çocuk zinciri tek satır, kritik sistem süreçleri ada göre tek satır) — kök `pid`/`ct`, `ad` (dosya açıklaması), `exe`, `n`, toplam `cpu` / `ram` (özel çalışma kümesi), `uyg` (görünür penceresi var), `baslik`, `koruma`, `uyeler` `[[pid, ct], ...]`; `sayilar: { uyg, arka, surec }`. `durum-kapat` ve `durum-izle` `surecler: [[pid, ct], ...]` ile grubun tüm süreçlerine (biri korumalıysa hiçbiri kapatılmaz; izleyici hepsi kapanınca tetiklenir).
- `pano.js` — `pano` mesajında `resim: { id, w, h, bytes }` ya da `{ tooBig, w, h }`; resim `GET/POST /api/pano/resim` (control, en fazla 20 MB).
- `baslatma.js` — engel uyarıları (`baslatma-engel`), "Windows açılınca başlat" (`baslatma-otomatik` admin), `baslatma-yenile`, yeni cihaz onayı
  tarayıcıdan (`onay-istegi` / `onay-bitti` → yalnızca bu bilgisayardaki yöneticiye; `onay-cevap`). Yardımcı exe başlatan özellikler
  `require('../lib/helper').spawnHelper(ad, exe, args, opts)` kullanır (engelliyse null döner, yeniden denemeyin). Testte `REMOTE_EXE_<AD>`
  (geçersiz exe ile engel taklidi), `REMOTE_RUN_ANAHTARI` (sahte HKCU anahtarı), `REMOTE_BILDIRIM_KURU=1`; test sunucusunda (TEST_PORT) Run ve bildirim kendiliğinden kuru.
- `veri.js` — veri sayacı: sunucu → `{ t:'veri-http', alinan, gonderilen }` (bu bağlantının HTTP toplamı); istemci → `{ t:'veri-tasarruf', acik }` (kalite "Veri tasarrufu" mu; tüm ses dinleyenleri tasarruftaysa Opus 96 → 32 kbps). Kalite `tasarruf` = `{ quality: 35, maxWidth: 1280, fps: 15, kbps: 500 }` (public/app.js QUALITY).
- `sertifika.js` — `GET /api/sertifika/*` (oturumsuz ama yalnızca özel ağdan; `/yokla` güven denetimi), yönetimde aç/kapat/yeniden üret/sil. `PORT_HTTPS` (varsayılan 3443; testte `0` = rastgele).

## İkili mesaj türleri (ilk bayt)
1 = JPEG kare, 2 = H.264 kare (çekirdek). 3 = ses (Opus). 4 = "Tüm ekranlar" JPEG karesi (çekirdek; ekran başına JPEG, biçim `public/ekranlar.js` paketle).

## Tüm ekranlar (çekirdek + `public/ekranlar.js`, etiketler `public/features/tum-ekranlar.js`)
- `view.screen === '*'`: bütün ekranlar tek görüntüde. Bu modda `move` ve `kalem` mesajları hedef ekranı `s` alanında taşır
  (istemcinin `send()`'i çevirir; özellikler `RC.send({ t: 'move', x, y })` ile birleşik görüntüdeki noktayı göndermeye devam eder).
- Sunucu ekran düzeni değişince izleyenlere `{ t: 'ekranlar', screens, screen }` gönderir; tarayıcıda yerel olay `ekranlar`.
- Testler: `REMOTE_EKRANLAR_SAHTE` (ekran dizilimi taklidi: JSON ya da dosya yolu), `REMOTE_GIRDI_KURU=1` (çekirdeğin fare/klavye
  komutları yardımcıya gitmez, `{ t: 'girdi-kuru', cmd }` olarak döner). Yeni tür eklerken buraya yazın.
