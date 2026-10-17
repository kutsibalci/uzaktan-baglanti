# Uzaktan Bağlantı — Claude için proje notları

Kişisel proje: tarayıcı tabanlı uzaktan masaüstü (TeamViewer benzeri) + ikinci ekran (Spacedesk benzeri).
Kullanıcı gündelik Türkçe yazar; cevaplar Türkçe. Kişisel kullanım + CV projesi; ana iddia: **bulut yok, veri dışarı çıkmaz**.

## Değişmez kurallar
- Repo ve GitHub Releases **PRIVATE** kalır (kullanıcı aksini söyleyene kadar). Push yalnızca istenince ya da iş bitince; etiket/sürüm yayınlamadan önce sor.
- **3000 portu kullanıcının çalışan sunucusudur**: ona, `data/` klasörüne ve onun süreçlerine dokunma. Testler başka port kullanır.
- Kodun kendisi hiçbir dış adrese bağlanmaz (telemetri, CDN, analitik yok). Yeni bir dış bağlantı eklemek gizlilik iddiasını bozar — önce sor.
- Kullanıcının bilgisayarında YASAK: gerçek fare/klavye/kalem girdisi enjekte etmek; süreçleri ADLA öldürmek (yalnızca kendi PID'lerin, ağacıyla); güç komutları (testlerde `REMOTE_GUC_KURU=1`); panoyu kalıcı değiştirmek (eskiyi geri koy); hoparlörden ses çalmak; yönetici izni isteyen kurulum; Başlangıç klasörüne kalıcı kısayol.
- Gerçek cihazda (iPhone, tablet, kalem) denenmeyen şey için asla "test edildi" deme; NOTLAR.md'de "**(henüz gerçek cihazda test edilmedi: …)**" olarak yaz.

## Nasıl çalışılır
- Önce kök nedeni bul ve kanıtla, sonra düzelt (ör. H.264 gecikmesi: sayaç → SPS eksikliği → `lib/sps.js`). Hatayı yakalayan testi mümkünse önce yaz.
- En basit çözüm; istenmeyen özellik/ayar ekleme. Yalnızca gereken yeri değiştir, çevredeki stile uy (2 boşluk, tek tırnak, Türkçe yorum/arayüz metni).
- Çekirdeğe (server.js, public/app.js, index.html, style.css) dokunmak yerine özellik modülü tercih et — bkz. `features/README.md`.

## Testler
- `node test/calistir.js [paket önekleri]` — her paket için boş veri klasörlü ayrı sunucu açar. Port: `TEST_PORT` (paralel çalıştırmada her işe ayrı port; 3000 ve 3999'u kullanma).
- Tarayıcı testleri başsız Edge + CDP ile (`test/ozellik-telefon-tarayici.js`, `test/ozellik-olcum.js` örnek); girdi mesajları sayfada yakalanır, sunucuya gitmez. iOS Safari emüle edilemez — raporla.
- Bitirmeden önce tüm paketler geçmeli.

## Ortam tuzakları
- Windows 11 Home (RDP sunucusu yok), Node 24, PowerShell + Git Bash. **Python yok** — betikler Node ile.
- Bazı dosyalar CRLF: düzenlerken satır sonunu koru. PowerShell çıktısını okurken `[Console]::OutputEncoding = [Text.Encoding]::UTF8` (klasör adında "ğ" var).
- Ekran ölçekleme %125; iki monitör (DISPLAY1 1920×1080, DISPLAY2 ~2400×1350 fiziksel). DPI farkında olmayan süreç mantıksal piksel görür.
- Hedef istemci öncelikle **iPhone Safari**: HTTP'de WebCodecs/Clipboard API/service worker yok → H.264 ve ses yalnızca HTTPS'te (Tailscale: `https://desktop-abc1234.tailnet123.ts.net`, `tailscale serve --bg 3000`). iPhone'da Fullscreen API yok.
- GPU: RTX 3050 (NVENC) + AMD iGPU. NVENC SPS'e bitstream_restriction yazmaz → `lib/sps.js` ekler.

## Belgeler
- `NOTLAR.md`: piyasa notları, Yapıldı (test edilmeyenlerle), Sıradaki. Her işten sonra güncelle.
- `features/README.md`: eklenti API'si ve ikili mesaj türleri (1 JPEG, 2 H.264, 3 ses).
