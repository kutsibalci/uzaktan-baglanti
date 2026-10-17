# Uzaktan Bağlantı

Windows bilgisayarı telefondan, tabletten ya da başka bir bilgisayardan **tarayıcı ile** görüp kontrol etmeye yarayan, kendi bilgisayarında çalışan uzaktan masaüstü uygulaması. Karşı tarafa bir şey kurmak gerekmez.

## Özellikler
- Uzaktan kontrol: fare, klavye (Türkçe karakterler dahil), dokunmatik
- H.264 görüntü (NVIDIA / AMD / Intel donanım kodlayıcı), desteklenmeyen tarayıcılarda JPEG (hızlı ekran yakalama, ağa göre "Otomatik" kalite)
- İkinci ekran (Spacedesk tarzı) — sanal monitör sürücüsü ile
- Yerel hesaplar: Yönetici / Kontrol / Salt izleme
- Cihaz hatırlama, yeni cihaz için bilgisayarda onay penceresi, tek seferlik misafir kodu
- Her yerden erişim: Tailscale (HTTPS)
- Telefon: touchpad modu, sıkıştırarak yakınlaştırma, mobil tuş çubuğu (Ctrl/Alt/Win, F1–F12), ana ekrana eklenebilir (PWA), USB ile bağlantı (`usb-baglan.bat`)
- Pano eşitleme (metin) ve dosya aktarımı (yükleme / klasör gezinme / indirme)
- Bilgisayar sesini uzaktan dinleme (Opus; HTTPS ve güncel tarayıcı gerekir)
- Gizlilik perdesi: kontrol sırasında bilgisayar ekranı karartılır, uzaktaki görüntü etkilenmez
- Tablet kalemi: basınç, eğim, silgi
- Gecikme sayacı: ağ, çözme ve tahmini toplam gecikme, kare aralığı / takılma; deneme sonuçlarını kopyalanabilir özet olarak verir
- Tepsi simgesi, Windows açılınca başlatma, bağlantı bildirimleri; yöneticiye güç menüsü (kilitle/uyku/yeniden başlat/kapat)
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
2. Bu bilgisayarda `http://localhost:3000` adresini açıp yönetici hesabını oluştur.
3. Diğer cihazdan, sunucu penceresinde yazan adrese gir.

İsteğe bağlı:
- `tailscale-kur.bat` — her yerden erişim + HTTPS (H.264 için gerekli)
- `surucu-kur.bat` — ikinci ekran özelliği için sanal monitör sürücüsü
- `usb-baglan.bat` — Android telefonu USB kablosuyla bağla (adb reverse; Wi-Fi gerekmez, telefonda `http://localhost:3000`)

## Tepsi simgesi (konsol penceresi olmadan)
`tepsi-baslat.bat` sunucuyu arka planda başlatır ve görev çubuğunun sağına bir simge koyar (`baslat.bat` konsol modu olarak çalışmaya devam eder; ikisini aynı anda açmayın, ikisi de aynı portu kullanır).
- Simgeye çift tıkla: arayüzü aç. Sağ tık menüsü: misafir kodunu kopyala, bağlı kişiler / bağlantıyı kes, **Windows açılınca başlat**, günlüğü aç, yeniden başlat, çıkış.
- Biri bağlanınca/ayrılınca bildirim gösterir; biri ekranı izlerken bilgisayarın uykuya geçmesini engeller (ekranın kapanmasına izin verir).
- Sunucu çıktısı `data\sunucu.log` dosyasındadır. Sunucu çökerse birkaç kez kendiliğinden yeniden başlatılır.
- Komut satırı: `helper\Tepsi.exe --cikis` çalışan tepsiyi düzgün kapatır.

Yönetici hesabıyla ana menüde **⏻ Güç** düğmesi bilgisayarı kilitler, uyutur, yeniden başlatır ya da kapatır (yeniden başlat/kapat 30 sn içinde iptal edilebilir). Kilitlenince ekran uzaktan görünmez.

## Dosyalar
| Yol | Görevi |
|---|---|
| `server.js` | Sunucu: giriş, oturumlar, görüntü akışı, yönetim |
| `lib/` | Hesap deposu, ağ/Tailscale, H.264 video (+ `sps.js`: tarayıcıda kare bekletmeyi kapatan SPS düzeltmesi), sanal ekran, yardımcı süreç |
| `helper/RemoteHelper.cs` | Ekran yakalama + fare/klavye (Windows'un kendi C# derleyicisiyle derlenir) |
| `helper/Tepsi.cs` | Görev çubuğu simgesi; sunucuyu gizli başlatır (`tepsi-baslat.bat`) |
| `helper/Pano.cs`, `Perde.cs`, `Ses.cs` | Pano izleme, gizlilik perdesi, ses yakalama (sunucu açılışta derler) |
| `features/` | Özellik modülleri (sunucu tarafı); bkz. [features/README.md](features/README.md) |
| `public/` | Tarayıcı arayüzü (`public/features/` özelliklerin tarayıcı tarafı) |
| `data/` | Hesaplar ve hatırlanan cihazlar (repoya girmez) |
| `tools/paketle.ps1` | Taşınabilir zip oluşturur |
| `.github/workflows/paket.yml` | Etiket gönderilince zip'i Releases'e koyar |

Yol haritası ve piyasa notları: [NOTLAR.md](NOTLAR.md)
