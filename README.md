# Uzaktan Bağlantı

Windows bilgisayarı telefondan, tabletten ya da başka bir bilgisayardan **tarayıcı ile** görüp kontrol etmeye yarayan, kendi bilgisayarında çalışan uzaktan masaüstü uygulaması. Karşı tarafa bir şey kurmak gerekmez.

## Özellikler
- Uzaktan kontrol: fare, klavye (Türkçe karakterler dahil), dokunmatik; farklı ölçeklemeli (ör. %125 + %100) birden çok monitör
- H.264 görüntü (NVIDIA / AMD / Intel donanım kodlayıcı), desteklenmeyen tarayıcılarda JPEG (hızlı ekran yakalama, ağa göre "Otomatik" kalite)
- İkinci ekran (Spacedesk tarzı) — sanal monitör sürücüsü ile
- "Tüm ekranlar": bütün monitörler gerçek dizilimiyle tek görüntüde, fare/dokunuş ekranlar arasında geçer (etikete dokununca tek ekran)
- Yerel hesaplar: Yönetici / Kontrol / Salt izleme
- Cihaz hatırlama, yeni cihaz için bilgisayarda onay penceresi, tek seferlik misafir kodu
- Okul / kafe / otel ağında (Windows'ta "Ortak" ağ) ev ağından giriş kapalı; Tailscale çalışmaya devam eder (yönetim paneli > Güvenlik)
- Her yerden erişim: Tailscale (HTTPS)
- Telefon: **Fare** modu (varsayılan; parmak imleci touchpad gibi sürer) ya da **Dokunmatik** mod (dokunulan yer tıklanır, sürükle = sürükleme); iki modda da basılı tut = sağ tık, iki parmak = kaydırma, sıkıştırarak yakınlaştırma,
  ekran klavyesi açılınca görüntü klavyenin üstüne sığar, sade araç çubuğu + ⋯ menü (paneller ✕ / Esc / dışarı dokununca kapanır),
  "Tuşlar" paneli (kısayollar: Kopyala, Alt+Tab, Win+D, Ctrl+Shift+Esc…; yapışkan Ctrl/Alt/Shift/Win, oklar, F1–F12), ana ekrana eklenebilir (PWA), USB ile bağlantı (`usb-baglan.bat`)
- Sağ tık: basılı tut, iki parmakla dokun (Fare modu) ya da alt çubuktaki **Sağ tık** düğmesi (imlecin olduğu yerde hemen)
- Telefonda alt çubuk (Klavye, Tuşlar, Fare/Dokunmatik, Sağ tık, Pano, Diğer), ilk bağlantıda kısa tanıtım
- **Kumanda modu** (ana menü): görüntü akışı olmadan telefon = touchpad (ayarlanabilir imleç hızı) + medya tuşları + sunum kumandası (← → F5 B Esc) + klavye (yazılan görünür; kısayollar, F tuşları, yapışkan Ctrl/Alt/Shift/Win)
- **Çizim tableti** (ana menü, iPad için): kenar kısayol paneli (Photoshop / Krita / Clip Studio Paint / Paint.NET / Paint profilleri;
  basılı tutulan Ctrl/Shift/Alt/Boşluk), avuç içi reddi ve "Parmak" ayarı, kalemin ara noktaları ve Apple Pencil hover
- **QR ile telefon eşleştirme:** bilgisayarda ana menü / tepsi → "Telefonu bağla (QR)"; telefon kamerayla okutur, bilgisayarda Onayla
  (kod 2 dk geçerli, tek kullanımlık; cihaz hatırlanır)
- **Bilgisayar durumu** paneli: CPU, sıcaklık, RAM, NVIDIA GPU, ağ, pil, diskler (60 sn grafik), en çok kaynak kullanan programlar ve
  yöneticiye "Kapat / Zorla kapat" (sistem süreçleri korunur); bildirimler: program kapanınca, CPU düşünce, pil azalınca, indirme bitince
- **Ev ağında HTTPS** (Tailscale olmadan; kendi yerel sertifikası, aşağıya bakın)
- Pano eşitleme (metin ve resim, iki yönde; telefondan gelen resim ayrıca İndirilenler › Uzaktan Bağlantı'ya kaydedilir), Fare hızı ayarı, ve dosya aktarımı (yükleme / klasör gezinme / indirme); gönderirken kaydedilecek klasör görünür ve seçilebilir
  (varsayılan İndirilenler › Uzaktan Bağlantı), "Bilgisayarda göster", son gönderilenler listesi, tepside "Dosya geldi" bildirimi
- Bilgisayar sesini uzaktan dinleme (Opus; HTTPS ve güncel tarayıcı gerekir)
- Gizlilik perdesi: kontrol sırasında bilgisayar ekranı karartılır, uzaktaki görüntü etkilenmez
- Tablet kalemi: basınç, eğim, silgi
- Gecikme sayacı: ağ, çözme ve tahmini toplam gecikme, kare aralığı / takılma; deneme sonuçlarını kopyalanabilir özet olarak verir
- **Veri kullanımı sayacı** (⏱ paneli, ⋯ menü: oturum / bugün / bu ay, saatlik tahmin) ve **"Veri tasarrufu"** kalitesi
  (mobil veri için: H.264 en fazla 500 kbps / 15 fps / 1280, ses 32 kbps; H.264 ile sürekli hareketli ekranda bile saatte ~220 MB.
  JPEG'de (HTTP adresi ya da H.264 açılamadığında) bit hızı sınırı yok: hareketli ekranda saatte ~2,6 GB ölçüldü)
- Tepsi simgesi, Windows açılınca başlatma, bağlantı bildirimleri; yöneticiye güç menüsü (kilitle/uyku/yeniden başlat/kapat)
- **Tepsisiz arka plan başlatma** (`arka-plan-baslat.bat`, yalnızca imzalı powershell.exe) ve Akıllı Uygulama Denetimi
  dayanıklılığı: bir yardımcı exe engellenirse sunucu çökmez, yönetim paneli hangi özelliğin çalışmadığını ve seçenekleri gösterir
- Dış sunucu, lisans, abonelik yok — internet olmadan da çalışır

## Taşınabilir paket (önerilen)
[Releases](../../releases) bölümünden `UzaktanBaglanti-vX.Y.Z-win64.zip` dosyasını indir, bir klasöre aç, `baslat.bat`'a çift tıkla. Node.js, ffmpeg ve her şey içinde; kurulum gerekmez. Hesaplar klasörün içindeki `data\`'da durur, klasörü taşıyınca ayarlar da gider.

**Yeni sürüm yayınlamak:** `package.json`'daki sürümü artır, commit'le, sonra:
```
git tag v0.2.0
git push origin v0.2.0
```
GitHub Actions paketi oluşturup Releases'e ekler. Elle paket: `powershell -ExecutionPolicy Bypass -File tools\paketle.ps1` → `dist\`.

## Kaynak koddan çalıştırma
Gereksinim: Windows 10/11, [Node.js](https://nodejs.org) 20 veya üstü.
1. `baslat.bat` dosyasına çift tıkla (ilk açılışta bağımlılıkları indirir).
2. Bu bilgisayarda `http://localhost:3080` adresini açıp yönetici hesabını oluştur.
3. Diğer cihazdan, sunucu penceresinde yazan adrese gir.

İsteğe bağlı:
- `tailscale-kur.bat` — her yerden erişim + HTTPS (H.264 için gerekli)
- `surucu-kur.bat` — ikinci ekran özelliği için sanal monitör sürücüsü
- `usb-baglan.bat` — Android telefonu USB kablosuyla bağla (adb reverse; Wi-Fi gerekmez, telefonda `http://localhost:3080`)

## Ev ağında HTTPS (Tailscale olmadan iPhone'da H.264 ve ses)
iPhone Safari H.264 görüntüyü ve sesi yalnızca şifreli (HTTPS) sayfada çalıştırır. Sunucu ilk açılışta kendi kök sertifikasını
(CA, 10 yıl, "Uzaktan Bağlantı Yerel CA — <bilgisayar adı>") ve onunla imzalı bir sunucu sertifikası (≤ 825 gün; tüm yerel IPv4
adresleri, bilgisayar adı, `ad.local`, `localhost`) üretir ve HTTP'nin yanında **https://<ev ağı IP'si>:3443** adresini de dinler
(`PORT_HTTPS` ile değişir). Dışarıya hiçbir şey gönderilmez; anahtarlar `data\sertifika\` klasöründe, yalnızca bu kullanıcıya açık.
- **Telefona bir kez kurulum:** HTTP adresinden girince ana menüde öneri şeridi, ⋯ menüde **🔒 Ev ağında HTTPS** rehberi çıkar.
  iPhone/iPad: Safari'de "Sertifikayı indir" (.mobileconfig) → Ayarlar → İndirilen Profil → Yükle → **Ayarlar → Genel → Hakkında →
  Sertifika Güven Ayarları → anahtarı aç** (bu adım unutulursa çalışmaz). Android: .cer → Ayarlar → Güvenlik → Sertifika yükle → CA sertifikası.
  Sayfa, cihazın sertifikaya güvenip güvenmediğini kendisi dener ve "Şifreli adrese geç" düğmesini gösterir.
- **Güvenlik:** kök sertifika *Name Constraints* ile yalnızca yerel adlara (localhost, `*.local`, bilgisayar adı) ve özel IP aralıklarına
  (10/8, 172.16/12, 192.168/16, Tailscale 100.64/10, 127/8) kısıtlıdır: anahtarı çalınsa bile internet sitelerini taklit edemez.
  İndirme uçları oturum istemez ama yalnızca ev ağı / Tailscale / bu bilgisayardan erişilir.
- IP adresi değişirse (DHCP) sunucu sertifikası aynı CA ile kendiliğinden yeniden imzalanır; telefondaki profil geçerli kalır.
- Yönetim → **Ev ağı HTTPS**: kapat / aç, kök sertifikayı yeniden üret ya da sil (telefondaki eski profil geçersizleşir).

## Tepsi simgesi (konsol penceresi olmadan)
`tepsi-baslat.bat` sunucuyu arka planda başlatır ve görev çubuğunun sağına bir simge koyar (`baslat.bat` konsol modu olarak çalışmaya devam eder; ikisini aynı anda açmayın, ikisi de aynı portu kullanır).
- Simgeye çift tıkla: arayüzü aç. Sağ tık menüsü: misafir kodunu kopyala, bağlı kişiler / bağlantıyı kes, **Windows açılınca başlat**, günlüğü aç, yeniden başlat, çıkış.
- Biri bağlanınca/ayrılınca bildirim gösterir; biri ekranı izlerken bilgisayarın uykuya geçmesini engeller (ekranın kapanmasına izin verir).
- Sunucu çıktısı `data\sunucu.log` dosyasındadır. Sunucu çökerse birkaç kez kendiliğinden yeniden başlatılır.
- Komut satırı: `helper\Tepsi.exe --cikis` çalışan tepsiyi düzgün kapatır.

### Tepsisiz arka plan (Akıllı Uygulama Denetimi açıksa önerilen)
Windows 11'in **Akıllı Uygulama Denetimi** (Smart App Control) imzasız, yeni derlenmiş exe'leri (ör. `Tepsi.exe`) engelleyebilir.
`arka-plan-baslat.bat` aynı işi yalnızca Windows'un imzalı `powershell.exe`'siyle yapar (`tools\arka-plan.ps1`; yeni exe yok):
- Sunucu konsol penceresi ve tepsi simgesi olmadan çalışır; zaten çalışıyorsa (tepsi ya da konsol dahil) ikinci kopya açılmaz, yalnızca tarayıcıda arayüz açılır.
- Çıktı `data\sunucu.log`'a eklenir (5 MB'ı aşınca `sunucu.log.1`'e taşınır). Sunucu çökerse 2, 5, 15, 60 sn arayla yeniden başlatılır;
  10 dakikada 5 çökmede durur ve günlüğe yazar. Bekçi ve sunucu PID'leri `data\arka-plan.pid`'de.
- `arka-plan-durdur.bat`: yalnızca PID dosyasındaki kendi süreçlerini durdurur (önce düzgün kapanış); tepsi ya da `baslat.bat` ile çalışan sunucuya dokunmaz.
- **Windows açılınca başlat:** Yönetim → "Başlatma ve Windows engelleri" → anahtar + yöntem (*Arka plan (tepsisiz)* / *Tepsi*).
  Kullanıcının başlangıç listesine (`HKCU\...\Run`, değer `UzaktanBaglanti`) yazılır; yönetici izni gerekmez.
- Tepsi yokken biri bağlanınca ya da yeni cihaz onay beklerken sessiz bir **Windows bildirimi** gösterilir.
- Onay penceresi açılamazsa (ör. `RemoteHelper.exe` engellendiyse) bu bilgisayarda tarayıcıda açık yönetici oturumuna onay kutusu gelir.
- Bir yardımcı program (`RemoteHelper`, `Pano`, `Perde`, `Ses`, `Durum`) engellenirse sunucu çökmez: günlüğe ve yönetim paneline
  hangi özelliğin çalışmadığı, Windows günlüğündeki kanıt (Code Integrity 3077/3033) ve seçenekler yazılır; engellenen dosya döngüyle yeniden denenmez.

Yönetici hesabıyla ana menüde **⏻ Güç** düğmesi bilgisayarı kilitler, uyutur, yeniden başlatır ya da kapatır (yeniden başlat/kapat 30 sn içinde iptal edilebilir). Kilitlenince ekran uzaktan görünmez.

## Dosyalar
| Yol | Görevi |
|---|---|
| `server.js` | Sunucu: giriş, oturumlar, görüntü akışı, yönetim |
| `lib/` | Hesap deposu, ağ/Tailscale, H.264 video (+ `sps.js`: tarayıcıda kare bekletmeyi kapatan SPS düzeltmesi), sanal ekran, yardımcı süreç, özellikler arası olaylar (`olaylar.js`) |
| `helper/RemoteHelper.cs` | Ekran yakalama + fare/klavye (Windows'un kendi C# derleyicisiyle derlenir) |
| `helper/Tepsi.cs` | Görev çubuğu simgesi; sunucuyu gizli başlatır (`tepsi-baslat.bat`) |
| `tools/arka-plan.ps1` | Tepsisiz arka plan başlatma / bekçi / durdurma (`arka-plan-baslat.bat`, `arka-plan-durdur.bat`) |
| `helper/Pano.cs`, `Perde.cs`, `Ses.cs`, `Durum.cs` | Pano izleme (metin + resim), gizlilik perdesi, ses yakalama, bilgisayar durumu ölçümü (sunucu açılışta derler) |
| `lib/sertifika.js`, `lib/qr.js` | Ev ağı HTTPS için yerel CA + sertifika (paketsiz X.509), QR kodlayıcı (paketsiz, SVG) |
| `features/` | Özellik modülleri (sunucu tarafı); bkz. [features/README.md](features/README.md) |
| `public/` | Tarayıcı arayüzü (`public/features/` özelliklerin tarayıcı tarafı) |
| `data/` | Hesaplar ve hatırlanan cihazlar (repoya girmez) |
| `tools/paketle.ps1` | Taşınabilir zip oluşturur |
| `.github/workflows/paket.yml` | Etiket gönderilince zip'i Releases'e koyar |

Yol haritası ve piyasa notları: [NOTLAR.md](NOTLAR.md)

## Lisans

Bu proje **GNU Genel Kamu Lisansı 3.0 ve sonrası (GPL-3.0-or-later)** ile lisanslıdır; tam metin [LICENSE](LICENSE). Özgürce kullanabilir, değiştirebilir ve dağıtabilirsiniz; değiştirilmiş sürümü dağıtırsanız kaynak kodunu da aynı lisansla vermeniz gerekir.

Pakete dahil üçüncü taraf bileşenler (FFmpeg, ws, Node.js) ve lisansları: [UCUNCU-TARAF.md](UCUNCU-TARAF.md).

Bu proje yapay zekâ (Claude) desteğiyle geliştirildi.
