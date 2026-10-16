# Piyasa notları ve yol haritası

## Rakiplerin sorunları → bizim çözümümüz

| Uygulama | Kullanıcıların şikayeti | Bizde |
|---|---|---|
| TeamViewer | Kişisel kullanımda bile "ticari kullanım" kilidi | Lisans/sunucu yok, tamamen bizim bilgisayarda çalışır |
| AnyDesk | 2024'te hacklendi, şifreler sıfırlandı | Merkezi sunucu yok; şifreler scrypt ile hash'li, sadece bu PC'de |
| Duet Display | Lisans sunucusu çökünce uygulama çalışmıyor, faturalama sorunları | İnternet olmadan da tam çalışır |
| RustDesk | Kendi sunucunu kurmak Docker/ağ bilgisi istiyor | `baslat.bat` çift tık |
| Splashtop | Ücretsiz sürüm sadece ev ağı, 2 cihaz sınırı | Sınır yok |
| Spacedesk | Wi-Fi'da gecikme birikiyor | Ack sistemi: eski kareler birikmez (yapıldı) |
| Chrome RD / Sunshine | UAC ve kilit ekranında siyah ekran | Yapılacak: SYSTEM servisi |
| Parsec VDD / sanal ekran | GPU sürücüsü güncellenince siyah ekran | Sanal ekranı sadece bağlantı sırasında açıyoruz, ana ekran yapmıyoruz |

## Yapıldı
- [x] Yerel hesaplar (yönetici / kontrol / salt izleme)
- [x] Cihaz hatırlama (cihaz anahtarı, yönetim panelinden iptal)
- [x] Yeni cihaz için bilgisayarda onay penceresi
- [x] Tek seferlik misafir kodu
- [x] Kaba kuvvet koruması (5 hatalı deneme → 5 dk kilit)
- [x] Kısa kopmalarda şifresiz devam (10 dk)
- [x] Bağlantı günlüğü
- [x] Kare onayı (ack) ile gecikme birikmesini önleme
- [x] İkinci ekran (Spacedesk tarzı) — sanal ekran sürücüsü ile **(henüz gerçek cihazda test edilmedi)**
- [x] Her yerden erişim: Tailscale (`tailscale-kur.bat`, HTTPS için `tailscale serve`) **(gerçek kurulumla test edilmedi)**
- [x] İnternetten doğrudan gelen bağlantılar reddedilir (sadece ev ağı + Tailscale + bu PC)
- [x] `tailscale serve` ile gelenler "bu bilgisayar" sayılmaz (kurulum/onay atlatılamaz)

- [x] H.264 görüntü: ffmpeg (gdigrab) + NVIDIA/AMD/Intel donanım kodlayıcı (yoksa x264), tarayıcıda WebCodecs.
      VBR: durağan ekranda ~1 Mbps (JPEG ~25 Mbps). HTTPS/localhost dışında otomatik JPEG.
      **(Gerçek tarayıcıda çözme henüz denenmedi; sunucu tarafı ffmpeg ile doğrulandı)**
- [x] Telefon: touchpad (dokunmatik fare) modu, sıkıştırarak yakınlaştırma (1x–4x), mobil tuş çubuğu (yapışkan Ctrl/Alt/Shift/Win, F1–F12),
      PWA (ana ekrana ekle, ağ öncelikli service worker), `usb-baglan.bat` (adb reverse).
      **(Başsız Edge'de sahte dokunuşlarla doğrulandı; gerçek telefonda ve gerçek USB/adb ile denenmedi)**

## Sıradaki
1. İkinci ekranın gerçek tablet/telefonla testi
2. ddagrab (Desktop Duplication) ile daha hızlı yakalama — DXGI çıkış sırası ↔ \\.\DISPLAYn eşlemesi lazım
3. Gerekirse herkese açık link (Cloudflare Tunnel) — şimdilik gerek yok, sadece kendi cihazlar
5. Pano (kopyala-yapıştır) eşitleme, dosya aktarımı, ses
6. Windows servisi olarak çalışma (UAC ve kilit ekranı, açılışta otomatik başlama)
7. Kalem basıncı (tablet), USB ile bağlantı (adb reverse)
