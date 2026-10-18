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
- `api.onAuth(ws => {})`, `api.onClose(ws => {})`, `api.adminData(async () => ({ <ad>: {...} }))`
- Çekirdek: `api.helper`, `api.video`, `api.store`, `api.clients`, `api.sendJson(ws, obj)`, `api.broadcast(obj, filtre)`, `api.buildExe(ad, {target})`, `api.dataDir`, `api.PORT`, `api.log(...)`, `api.guestCode()`, `api.kick(ws => bool, neden)`, `api.clientInfo(req)`
- Özellikler arası olaylar: `require('../lib/olaylar')` (ortak EventEmitter; özellikler birbirini doğrudan require etmez). Şimdilik: `dosya-geldi` (dosya.js yayar → tepsi.js tepsi bildirimine çevirir).
- Ortak yardımcılar: `lib/zip.js` (akışla zip yazıcı: deflate/store, data descriptor, ZIP64, UTF-8 adlar; dosya.js zip indirmede kullanır).
- `ws.session` → `{ username, role, guest, view: { screen, ... } }`, `ws.streaming`, `ws.isLocal`, `ws.via`

## Tarayıcı API (özet)
- `RC.send(obj)`, `RC.on(tür, fn)` — sunucu mesajları ve yerel olaylar: `auth`, `viewer:start`, `viewer:stop`, `admin`, `disconnect`, `binary:<n>` (ikili mesaj, ilk bayt n ≥ 3)
- `RC.setPenActive(fn)` — kalem özelliği, kalem olaylarını kendisi işlediği sürece `fn()` true döner; o zaman çekirdek kalemin ürettiği fare/dokunma olaylarını yok sayar (aksi halde kalem fare gibi çalışır)
- `RC.stats()` — son bir saniyenin görüntü ölçümleri `{ fps, kbps, decodeMs, codec, intervalMs, jitterMs, maxIntervalMs, stutters }` (gecikme sayacı kullanır; durağan ekrandan sonraki aralık sayılmaz — sunucu JPEG'de aynı kareyi göndermeyince bir kez `{ t: 'durgun' }` yollar)
- `RC.state()`, `RC.canInput()`, `RC.toNorm(x, y)`, `RC.moveNow`, `RC.queueMove`, `RC.click(b)`, `RC.overlay(msg)`
- `RC.fetch(url, opts)`, `RC.authUrl(url)`
- `RC.ui.home(el)`, `RC.ui.adminSection(başlık, el)`, `RC.ui.stage()`, `RC.ui.canvas()`, `RC.ui.menuItem`, `RC.ui.panel`, `RC.ui.closable`, `RC.ui.toolbar` (aşağıda)

### Görüntüleyici arayüzü (araç çubuğu, menü, paneller)
Telefonda çubukta yalnızca geri, ⌨, Tuşlar, dokunmatik modu, küçük gecikme sayacı ve **⋯ Menü** vardır; özellikler kendini menüye ekler.
- `RC.ui.menuItem({ id, icon, label, state, title, order, onClick, pin, ctl, extend, keepOpen, hidden, disabled })` → `{ el, pinEl, set({...}) }`
  - Menüde etiketli satır (simge + ad + sağda durum, ör. "Ses · kapalı"). `order` küçükten büyüğe (çekirdek: 1–2 kalite/ekran, 80 tam ekran, 90 çubuğu gizle; özellikler 10–60).
  - `pin: true` → geniş ekranda (≥ 720 px) çubukta simge olarak da görünür (`pinEl`, kimliği `<id>Pin`). `ctl: true` → salt izleme rolünde gizli; `extend: false` → ikinci ekranda gizli.
  - `keepOpen: true` → tıklayınca menü kapanmaz (aç/kapa satırları). Durum değişince `set({ icon, label, state, title, hidden, disabled, active, badge })`; `badge` satırda ve ⋯ düğmesinde nokta gösterir.
- `RC.ui.panel(başlık, { id, anchor, dock, dismiss, className, onOpen, onClose })` → `{ el, head, body, open(), close(), toggle(), isOpen(), addAnchor(el), setTitle(t) }`
  - Köşesinde ✕ olan ortak panel; içerik `body`'ye konur. Esc en son açılan paneli kapatır (bilgisayara Esc gitmez).
  - Açılır panel (varsayılan) çubuğun altında açılır, dışarı dokununca kapanır; aynı anda tek açılır panel açık kalır. Görüntünün üstüne yapılan kapatma dokunuşu bilgisayara tıklama olarak gitmez. `anchor`: paneli açıp kapatan düğme(ler) — onlara dokunmak "dışarı" sayılmaz.
  - `dock: 'bottom'` → görüntünün altına kenetlenir (ekranı örtmez), dışarı dokunmak kapatmaz (ör. Tuşlar paneli).
- `RC.ui.closable(el, kapat, { dismiss, anchor })` — kendi kabuğu olan öğeyi (ör. tam ekran dosya paneli) Esc ile kapanacak şekilde kaydeder.
- `RC.ui.toolbar(el)` — eski yol, geriye uyumlu: öğeyi çubuğun sağ ucuna (her genişlikte) ekler. Telefonda yer dar; yalnızca küçük göstergeler için (ör. gecikme sayacı), düğmeler için `menuItem` kullanın.
- Salt izleme rolünde `<body>`'de `rc-salt`, ikinci ekranda `rc-genislet` sınıfı vardır (`.ctl` / `.no-extend` öğeler CSS ile gizlenir).
- Özel tuşlar (kısayollar, yapışkan Ctrl/Alt/Shift/Win, oklar, F1–F12) `public/features/telefon.js`'teki "Tuşlar" panelindedir.

## İkili mesaj türleri (ilk bayt)
1 = JPEG kare, 2 = H.264 kare (çekirdek). 3 = ses (Opus). Yeni tür eklerken buraya yazın.
