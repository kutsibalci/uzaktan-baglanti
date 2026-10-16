# Uzaktan Bağlantı

Windows bilgisayarı telefondan, tabletten ya da başka bir bilgisayardan **tarayıcı ile** görüp kontrol etmeye yarayan, kendi bilgisayarında çalışan uzaktan masaüstü uygulaması. Karşı tarafa bir şey kurmak gerekmez.

## Özellikler
- Uzaktan kontrol: fare, klavye (Türkçe karakterler dahil), dokunmatik
- H.264 görüntü (NVIDIA / AMD / Intel donanım kodlayıcı), desteklenmeyen tarayıcılarda JPEG
- İkinci ekran (Spacedesk tarzı) — sanal monitör sürücüsü ile
- Yerel hesaplar: Yönetici / Kontrol / Salt izleme
- Cihaz hatırlama, yeni cihaz için bilgisayarda onay penceresi, tek seferlik misafir kodu
- Her yerden erişim: Tailscale (HTTPS)
- Dış sunucu, lisans, abonelik yok — internet olmadan da çalışır

## Gereksinimler
- Windows 10/11
- [Node.js](https://nodejs.org) 20 veya üstü

## Kurulum
1. `baslat.bat` dosyasına çift tıkla (ilk açılışta bağımlılıkları indirir).
2. Bu bilgisayarda `http://localhost:3000` adresini açıp yönetici hesabını oluştur.
3. Diğer cihazdan, sunucu penceresinde yazan adrese gir.

İsteğe bağlı:
- `tailscale-kur.bat` — her yerden erişim + HTTPS (H.264 için gerekli)
- `surucu-kur.bat` — ikinci ekran özelliği için sanal monitör sürücüsü

## Dosyalar
| Yol | Görevi |
|---|---|
| `server.js` | Sunucu: giriş, oturumlar, görüntü akışı, yönetim |
| `lib/` | Hesap deposu, ağ/Tailscale, H.264 video, sanal ekran, yardımcı süreç |
| `helper/RemoteHelper.cs` | Ekran yakalama + fare/klavye (Windows'un kendi C# derleyicisiyle derlenir) |
| `public/` | Tarayıcı arayüzü |
| `data/` | Hesaplar ve hatırlanan cihazlar (repoya girmez) |

Yol haritası ve piyasa notları: [NOTLAR.md](NOTLAR.md)
