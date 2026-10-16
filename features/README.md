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
- `api.onAuth(ws => {})`, `api.onClose(ws => {})`, `api.adminData(async () => ({ <ad>: {...} }))`
- Çekirdek: `api.helper`, `api.video`, `api.store`, `api.clients`, `api.sendJson(ws, obj)`, `api.broadcast(obj, filtre)`, `api.buildExe(ad, {target})`, `api.dataDir`, `api.PORT`, `api.log(...)`
- `ws.session` → `{ username, role, guest, view: { screen, ... } }`, `ws.streaming`, `ws.isLocal`, `ws.via`

## Tarayıcı API (özet)
- `RC.send(obj)`, `RC.on(tür, fn)` — sunucu mesajları ve yerel olaylar: `auth`, `viewer:start`, `viewer:stop`, `admin`, `disconnect`, `binary:<n>` (ikili mesaj, ilk bayt n ≥ 3)
- `RC.state()`, `RC.canInput()`, `RC.toNorm(x, y)`, `RC.moveNow`, `RC.queueMove`, `RC.click(b)`, `RC.overlay(msg)`
- `RC.fetch(url, opts)`, `RC.authUrl(url)`
- `RC.ui.toolbar(el)`, `RC.ui.home(el)`, `RC.ui.adminSection(başlık, el)`, `RC.ui.stage()`, `RC.ui.canvas()`

## İkili mesaj türleri (ilk bayt)
1 = JPEG kare, 2 = H.264 kare (çekirdek). 3 = ses (Opus). Yeni tür eklerken buraya yazın.
