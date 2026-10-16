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
      **(Gerçek telefonda henüz denenmedi; bu bilgisayarda başsız Edge'de WebCodecs ile çözme doğrulandı)**
- [x] Gecikme sayacı (`features/olcum.js`): araç çubuğunda gidiş-dönüş (RTT); dokununca yakalama / ağ / çözme / tahmini toplam,
      kare hızı, bant, sunucu kuyruğu. "Özeti kopyala" oturum boyunca ortalama / orta / %95 / min / maks verir (deneme sonuçları için).
      H.264'te yakalama + kodlama süresi ölçülmüyor (tahmin alt sınırdır); ekran yenileme dahil değil.
- [x] H.264 kare bekletme düzeltmesi (`lib/sps.js`): NVENC SPS'e bitstream_restriction yazmıyordu → tarayıcı ~4 kare bekletiyordu.
      Sayaçla bulundu: çözme 133 ms (x264: 2 ms). SPS'e max_num_reorder_frames=0 eklenince NVENC'te de ~2 ms.
      AMF/x264 zaten yazıyor, onlara dokunulmuyor. **(Ölçüm başsız Edge'de; gerçek telefon çözücüsünde doğrulanmalı)**
- [x] Telefon: touchpad (dokunmatik fare) modu, sıkıştırarak yakınlaştırma (1x–4x), mobil tuş çubuğu (yapışkan Ctrl/Alt/Shift/Win, F1–F12),
      PWA (ana ekrana ekle, ağ öncelikli service worker), `usb-baglan.bat` (adb reverse), kalem olaylarını çekirdekte yok sayma.
      **(henüz gerçek cihazda test edilmedi: gerçek telefon/tablette dokunma hissi ve eşikler (PINCH 24px, PAN 12px, TAP 250ms, çift dokunuş 300ms);
      touchType 'stylus' filtresi; iOS Safari (Apple Pencil, ana ekrana ekleme, tuş çubuğunda klavyenin açık kalması);
      Android ekran klavyesi (Gboard) + yapışkan değiştirici; `usb-baglan.bat` hiç çalıştırılmadı (adb/USB yok);
      PWA'nın gerçek cihazda kurulumu ve Tailscale HTTPS'te service worker; dokunmatik ekranlı bilgisayarda mod düğmeleri.
      Yalnızca başsız Edge'de CDP sahte dokunuşlarıyla doğrulandı)**
      Not: `adb reverse` ile gelen bağlantı 127.0.0.1'den geldiği için "bu bilgisayar" sayılır (onay penceresi çıkmaz; şifre yine gerekir).
- [x] Pano eşitleme (yalnızca metin, `helper/Pano.cs`, iki yönlü, büyük metin `/api/pano/yaz` ile) ve dosya aktarımı
      (8 GB'a kadar akışlı yükleme, klasör gezinme/indirme; yol geçişi, junction, ADS, aygıt adları engellenir).
      **(henüz gerçek cihazda test edilmedi: telefon/tablet tarayıcısında hiç denenmedi (HTTP'de textarea yedeği, iOS/Android
      pano izinleri, mobil dosya seçici ve indirme, gerçek sürükle-bırak); arayüzdeki "Kopyala"/"Bu cihazın panosunu gönder"
      düğmeleri; 8 GB'a yakın ve 5 dakikadan uzun gerçek yükleme; Tailscale/başka bilgisayar üzerinden aktarım; panoyu kilitleyen
      programla yeniden deneme; panoda resim varken davranış; rolü düşürülen yöneticide çalışan Pano.exe; kök içindeki sabit bağlantı (hard link))**
      Not: misafir rolü "control" ise misafir de bilgisayar panosunu ve profil klasörünü görebilir (yönetimden otomatik pano kapatılabilir).
- [x] Tepsi simgesi (`tepsi-baslat.bat`): gizli sunucu, bağlantı bildirimi, bağlantı kesme, Windows açılınca başlatma,
      izlenirken uyku engeli. Güç menüsü (kilitle/uyku/yeniden başlat/kapat, yalnızca yönetici).
      **(henüz gerçek cihazda test edilmedi: balon bildirimleri ve sağ tık menüsü gözle görülmedi, menü öğelerine tıklanmadı;
      ikinci örneğin "arayüzü aç" sinyali; gerçek güç komutları HİÇ çalıştırılmadı (yalnızca kuru mod; hazırda bekletme açıkken
      uyku yerine hazırda bekletme, Modern Standby davranışı); ekran kapalıyken yakalama; uyku engelinin powercfg ile doğrulanması;
      `public/features/guc.js` gerçek tarayıcıda/telefonda; Tailscale'li durum; 2 MB günlük kırpma; port doluyken çökme döngüsü;
      üretilmiş taşınabilir pakette tepsi)**
- [x] Gizlilik perdesi (`helper/Perde.cs`): uzaktan kontrol sırasında bilgisayar ekranını siyah örter, yakalamaya girmez
      (WDA_EXCLUDEFROMCAPTURE; doğrulanamazsa perde hiç açılmaz), Ctrl+Alt+Shift+P ile yerel kapatma.
      Tablet kalemi: basınç, eğim, silgi (`RemoteHelper` içinde sentetik kalem aygıtı).
      **(henüz gerçek cihazda test edilmedi: gerçek tablet kalemiyle uçtan uca girdi (gerçek kalem girdisi hiç enjekte edilmedi);
      tarayıcı tarafı kalem olayları gerçek kalemli cihazda; perde açıkken ikinci bir cihazdan uzaktaki görüntü (yakalama katmanında
      JPEG ve H.264'te görünmediği doğrulandı))**
- [x] Ses aktarımı (`helper/Ses.cs`): WASAPI loopback → Opus (ffmpeg) → tarayıcıda WebCodecs AudioDecoder, ~80 ms tampon.
      **(henüz gerçek cihazda test edilmedi: tarayıcıda çalma hiç denenmedi (çözme, tampon, çıtırtı, düğme durumu, mobil);
      yalnızca sessizlikle denendi, gerçek sesin yakalama → ffmpeg yolu geçmedi; SILENT/DISCONTINUITY bayrakları; varsayılan aygıt
      değişimi/kulaklık takıp çıkarma; 16/24/32 bit tamsayı karışım biçimleri; uçtan uca gecikme; iOS Safari AudioDecoder desteği)**

## Sıradaki
1. Yukarıdaki özelliklerin gerçek telefon/tablet/kalemle denenmesi (ikinci ekran dahil)
2. ddagrab (Desktop Duplication) ile daha hızlı yakalama — DXGI çıkış sırası ↔ \\.\DISPLAYn eşlemesi lazım
3. Gerekirse herkese açık link (Cloudflare Tunnel) — şimdilik gerek yok, sadece kendi cihazlar
4. Windows servisi olarak çalışma (UAC ve kilit ekranı)
5. Yönetim günlüğünde 'dosya' ve 'guc' olaylarının okunur gösterimi (LOG_NAMES), özellik başına "misafire kapalı" seçeneği
6. `adb reverse` bağlantılarını "bu bilgisayar"dan ayırt etme
7. Çekirdeğe izleme başlat/durdur kancası (`api.onStreamStop`): perde şimdilik izlemeyi bırakan/yetkisi düşen bağlantıyı saniyede bir yoklayarak kaldırıyor
8. Tepsi menüsünde "kes" ile "kes ve cihazı unut" ayrımı: şimdilik tepsiden kesilen hatırlanan cihazın kaydı her zaman siliniyor (yeniden girişte şifre sorulur)
9. Android Chrome'da kalemin ürettiği dokunma olaylarının ayıklanması (pointerdown 'pen' sonrası gelen dokunuş kimlikleri) gerçek S-Pen ile doğrulanmalı; salt izleme rolünde hatırlanan touchpad modunun yok sayılması için tarayıcı testi yok
