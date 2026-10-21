# Uzaktan Bağlantı — Claude için proje notları

Kişisel proje: tarayıcı tabanlı uzaktan masaüstü (TeamViewer benzeri) + ikinci ekran (Spacedesk benzeri).
Kullanıcı gündelik Türkçe yazar; cevaplar Türkçe. Kişisel kullanım + CV projesi; ana iddia: **bulut yok, veri dışarı çıkmaz**.

## Değişmez kurallar
- Repo ve GitHub Releases **PRIVATE** kalır (kullanıcı aksini söyleyene kadar). Push yalnızca istenince ya da iş bitince; etiket/sürüm yayınlamadan önce sor.
- **3080 portu kullanıcının çalışan sunucusudur** (varsayılan port; 3000'i Docker'daki Grafana alıyor): ona, `data/` klasörüne ve onun süreçlerine dokunma. Testler başka port kullanır.
- Kodun kendisi hiçbir dış adrese bağlanmaz (telemetri, CDN, analitik yok). Yeni bir dış bağlantı eklemek gizlilik iddiasını bozar — önce sor.
- Kullanıcının bilgisayarında YASAK: gerçek fare/klavye/kalem girdisi enjekte etmek; süreçleri ADLA öldürmek (yalnızca kendi PID'lerin, ağacıyla); güç komutları (testlerde `REMOTE_GUC_KURU=1`); panoyu kalıcı değiştirmek (eskiyi geri koy); hoparlörden ses çalmak; yönetici izni isteyen kurulum; Başlangıç klasörüne kalıcı kısayol.
- Gerçek cihazda (iPhone, tablet, kalem) denenmeyen şey için asla "test edildi" deme; NOTLAR.md'de "**(henüz gerçek cihazda test edilmedi: …)**" olarak yaz.

## Nasıl çalışılır
- Önce kök nedeni bul ve kanıtla, sonra düzelt (ör. H.264 gecikmesi: sayaç → SPS eksikliği → `lib/sps.js`). Hatayı yakalayan testi mümkünse önce yaz.
- En basit çözüm; istenmeyen özellik/ayar ekleme. Yalnızca gereken yeri değiştir, çevredeki stile uy (2 boşluk, tek tırnak, Türkçe yorum/arayüz metni).
- Çekirdeğe (server.js, public/app.js, index.html, style.css) dokunmak yerine özellik modülü tercih et — bkz. `features/README.md`.

## Testler
- `node test/calistir.js [paket önekleri]` — her paket için boş veri klasörlü ayrı sunucu açar. Port: `TEST_PORT` (paralel çalıştırmada her işe ayrı port; 3080, 3443 (kullanıcının ev ağı HTTPS'i), 3000, 3306 (MySQL) ve 3999'u kullanma). calistir.js test sunucularına `PORT_HTTPS=0` (rastgele), `REMOTE_DURUM_KURU=1` ve geçici `REMOTE_INDIRME_DIR` verir.
- Bir helper .cs değiştiyse kullanıcının sunucusu `helper/*.exe`'yi kilitliyor olabilir: testleri ana klasörün (data/.git/.claude hariç) %TEMP% altındaki kopyasında çalıştır, sunucuyu durdurma.
- **Akıllı Uygulama Denetimi (SAC) açık**: kopyada/worktree'de yeni derlenen helper exe'leri rastgele engellenir (`spawn UNKNOWN`). Ana klasörün çalışan `helper/*.exe`'lerini kopyala ve tarihlerini yenile (yeniden derlenmesin); SAC'ı kapatma/atlatma. Engel taklidi: `REMOTE_EXE_<AD>`. Yeni yardımcı exe başlatan kod `lib/helper.js` `spawnHelper` kullanır.
- Test kancaları: `REMOTE_EKRANLAR_SAHTE` (sahte ekran dizilimi), `REMOTE_GIRDI_KURU=1` (fare/klavye yardımcıya gitmez), `REMOTE_BILDIRIM_KURU=1`, `REMOTE_RUN_ANAHTARI` (sahte HKCU Run; gerçek Run anahtarına yazma), `REMOTE_AG_PROFILI_SAHTE` (Windows ağ profili yerine harita; calistir.js varsayılan `{}` = hiçbir ağ Ortak değil, yoksa bilgisayar okul ağındayken ev ağı adresine bağlanan testler 403 alır).
- Pano testi gerçek sistem panosunu, ses testi gerçek ses çıkışını kullanır: başka işlerle paralel çalışınca düşebilir, tek başına yeniden çalıştır.
- Tarayıcı testleri başsız Edge + CDP ile (`test/ozellik-telefon-tarayici.js`, `test/ozellik-olcum.js` örnek); girdi mesajları sayfada yakalanır, sunucuya gitmez. iOS Safari emüle edilemez — raporla.
- Bitirmeden önce tüm paketler geçmeli.

## Ortam tuzakları
- Windows 11 Home (RDP sunucusu yok), Node 24, PowerShell + Git Bash. **Python yok** — betikler Node ile.
- Bazı dosyalar CRLF: düzenlerken satır sonunu koru. PowerShell çıktısını okurken `[Console]::OutputEncoding = [Text.Encoding]::UTF8` (klasör adında "ğ" var).
- İki monitör, farklı ölçek: DISPLAY1 1920×1080 %125, DISPLAY2 1920×1080 %100 (konum 1920,0). RemoteHelper Per-Monitor v2 DPI farkında; farkında olmayan süreç mantıksal/yanlış ölçekli piksel görür.
- Docker Desktop açılışta başlıyor ve 3000'i (watch-party-grafana) alıyor — bu yüzden varsayılan port 3080.
- Hedef istemci öncelikle **iPhone** (iOS 26; Safari ve iOS Chrome — ikisi de WebKit): HTTP'de WebCodecs/Clipboard API/service worker yok → H.264 ve ses yalnızca HTTPS'te (Tailscale: `https://desktop-abc1234.tailnet123.ts.net` — 2026-10-21 sıfırlamadan sonra bilgisayar adı değişti; eski abc1234 adresi geçersiz; `tailscale serve --bg 3080`, Tailscale çıkış yaparsa yeniden). iPhone'da Fullscreen API yok.
- GPU: RTX 3050 (NVENC) + AMD iGPU. NVENC SPS'e bitstream_restriction yazmaz → `lib/sps.js` ekler.

## Belgeler
- `NOTLAR.md`: piyasa notları, Yapıldı (test edilmeyenlerle), Sıradaki. Her işten sonra güncelle.
- `features/README.md`: eklenti API'si ve ikili mesaj türleri (1 JPEG, 2 H.264, 3 ses).
