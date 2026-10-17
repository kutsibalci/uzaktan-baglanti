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
- [x] Telefon: touchpad (dokunmatik fare) modu, sıkıştırarak yakınlaştırma (1x–4x), mobil tuş çubuğu (artık "Tuşlar" paneli, aşağıda),
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
- [x] Farklı ölçekli monitörler: `RemoteHelper` artık Per-Monitor v2 DPI farkında (önceden sistem DPI'ı). Bu bilgisayarda
      DISPLAY1 %125, DISPLAY2 %100: eskiden DISPLAY2 2400x1350 @2400 (sanal, ölçeklenmiş) görünüyordu, yakalama ise fiziksel
      okuduğundan karenin yalnızca 1440 pikseli o ekrandı, gerisi siyahtı; H.264 bölgesi de sanal masaüstünün dışına taşıyordu.
      Şimdi tüm koordinatlar fiziksel (JPEG, gdigrab, fare, kalem aynı sistem). `info` ekranlara `dpi`/`scale`/`adapter`,
      sunucu `title` ("Ekran 2 (1920×1080)", sanal ekran için "Sanal ekran (…)") ve `virtual` ekler. `map` komutu: fareyi
      oynatmadan eşlemeyi verir. Ekran seçicide sunucunun okunur adı görünür. Test: `test/ozellik-ekran.js`.
      **(henüz gerçek cihazda test edilmedi: telefonda ikinci ekrana geçince tam göründüğü doğrulanmadı; gerçek fare/kalem hareketi
      gönderilmedi (eşleme yalnızca `map` ile hesap olarak); negatif konumlu (solda/üstte) monitör ve sanal ekran sürücüsü bu bilgisayarda yok
      (yalnızca birim testi); Per-Monitor v2 olmayan eski Windows yedekleri; oturum açıkken ölçek/çözünürlük değiştirme)**
      Not: kullanıcının çalışan sunucusu eski RemoteHelper.exe'yi kullanır; düzeltme için sunucu yeniden başlatılmalı (kaynak yeni olduğundan exe yeniden derlenir).
- [x] JPEG yolunda akıcılık (HTTP'den bağlanan telefon; ilk iPhone denemesinde "takılıyor" denmişti):
      2 kare onaysız yolda (ack penceresi), kare zamanlaması yakalamanın başından, ack gelince döngü hemen uyanır
      (Node zamanlayıcıları Windows'ta ~15.6 ms adımlı), yollar doluyken sıradaki kare önceden yakalanır;
      ekran yakalama masaüstü çoğaltmayla (DXGI Desktop Duplication, `RemoteHelper.cs` → `DxgiCapture`; GDI 30-80 ms → 1-15 ms,
      durağan ekranda kopyalama/sıkıştırma atlanır, olmazsa GDI'ye döner, `REMOTE_YAKALAMA=gdi` ile kapatılır);
      yardımcı programda fare/klavye komutları yakalamayı beklemez (ayrı iş parçacığı);
      "Otomatik" kalite (varsayılan; JPEG kalitesi/genişliği kare onay süresi − ağ gidiş-dönüşüne göre);
      tarayıcıda tek kare çözülür, bekleyen eski kare atılır, çizim requestAnimationFrame ile;
      gecikme sayacında kare aralığı, titreşim, takılma/sn, ack süresi, kalite. Ölçüm: `test/ozellik-akicilik.js` (Wi-Fi taklidi).
      **(henüz gerçek cihazda test edilmedi: iPhone Safari + gerçek Wi-Fi'da hiç denenmedi (ölçümler taklit ağ ve başsız Edge);
      iOS'ta createImageBitmap/rAF zamanlaması ve çözme süresi; Otomatik kalitenin gerçek Wi-Fi'da salınıp salınmadığı;
      çoğaltma: UAC/kilit ekranı geçişi, ekran çözünürlüğü değişimi, HDR ekran, sanal ekran (IddCx) sürücüsü, uyku sonrası;
      sabit kalite + yavaş hatta 2 kare penceresi gecikmeyi bir kare iletimi kadar artırıyor (taklitte 102 → ~115 ms);
      yardımcı programda girdinin ayrı iş parçacığına alınmasının girdi gecikmesine etkisi ölçülmedi; H.264 yolu hâlâ gdigrab)**
- [x] Doğrudan dokunma modu yeniden (ilk iPhone denemesinde "basılı tutuyor" denmişti: 10 px'i aşan her tek parmak hareketi
      sol tuşla sürüklemeye başlıyordu, 'up' bazı yollarda kayboluyordu). Yeni hareketler: dokun = sol tık (art arda iki dokunuş aynı
      noktaya gider → çift tık), hızlı sürükle = kaydırma (eksen kilitli), basılı tut (~0,45 sn, mavi halka) + sürükle = sürükleme,
      basılı tut + bırak = sağ tık. Basılı düğme her durumda bırakılır: parmaklar kalkınca, touchcancel, sekme/uygulama değişince
      (visibilitychange/pagehide/blur), kaçırılmış touchend'de, 'stop'tan önce; sunucu da izleme bitince/bağlantı kopunca bırakır.
      Ekran klavyesi açılınca görüntüleyici görünür alana (visualViewport) yerleşir: görüntü klavyenin üstüne sığar, Tuşlar paneli
      klavyenin üstünde kalır. **(henüz gerçek cihazda test edilmedi: gerçek iPhone Safari'de hiç denenmedi (başsız Edge CDP
      dokunuşları); iOS'ta visualViewport.offsetTop + position:fixed yerleşimi, scrollTo(0,0) ve klavye animasyonu; sol üste taşınan
      gizli #kbInput ile klavyenin açılması; Android Gboard; iOS'ta titreşim yok (yalnızca halka), eşikler 450 ms / 10 px / 30 px
      gerçek elde denenmedi; sunucunun stop/kopmada düğme bırakması için otomatik test yok (gerçek girdi gerekirdi); iOS uyumluluk
      fare olayları; dokunmatik ekranlı Windows dizüstünde fare + parmak)**
- [x] Görüntüleyici arayüzü: telefonda tek satır araç çubuğu (geri, ●, ⌨, Tuşlar, dokunmatik modu, gecikme, ⋯ Menü);
      kalite, ekran, pano, dosya, ses, perde, gecikme ayrıntısı, tam ekran, çubuğu gizle menüde durumlarıyla. Ortak panel kabuğu
      (`RC.ui.panel`/`menuItem`/`closable`): köşede ✕, Esc, dışarı dokununca kapanır, kapatma dokunuşu bilgisayara tıklama gitmez.
      Tek "Tuşlar" paneli (görüntünün altına kenetli, 3 sekme): Kısayollar (Kopyala/Yapıştır/Kes/Tümünü seç/Geri al/Yinele/Kaydet/
      Bul/Alt+Tab/Alt+F4 onaylı/Win/Win+D/Win+E/Ctrl+Shift+Esc/Win+Shift+S/Kilitle), yapışkan Ctrl/Alt/Shift/Win + gezinme +
      oklar, F1–F12. iPhone'da tam ekran yerine "Ana Ekrana Ekle" ipucu.
      **(henüz gerçek cihazda test edilmedi: gerçek iPhone Safari'de olay sırası, dışarı dokunmada kapatma/yutma, Tuşlar paneline
      basınca ekran klavyesinin açık kalması, menü içindeki select seçicisi, safe-area boşlukları, "Ana Ekrana Ekle" ipucu (yalnızca
      UA taklidiyle); Android Chrome; Kilitle kısayolu gerçek bilgisayarda çalıştırılmadı (güç özelliğinin kilitle komutu, yalnızca
      yönetici); ikinci ekran (genişletme) modunda gizlenen öğeler; dosya tam ekran paneli ve güç panelinin Esc ile kapanması)**
- [x] Dosya gönderirken kaydedilecek yer: "Kaydedilecek yer: İndirilenler › Uzaktan Bağlantı" + tam yol, "Değiştir" ile klasör
      seçici (Masaüstü/Belgeler/İndirilenler/Resimler kısayolları, gezinme, yeni klasör; seçim cihazda hatırlanır), yükleme sonrası
      "Kaydedildi: … › IMG_0676.jpeg" + tam yol + "Bilgisayarda göster" (explorer /select), "Son gönderilenler" listesi, tepside
      "Dosya geldi" balonu (`lib/olaylar.js` → `dosya-geldi`). Uçlar: `?klasor=` ile yükleme, `/api/dosya/hedef`, `/api/dosya/klasor`,
      `/api/dosya/goster` (control rolü; yol doğrulaması gezinmeyle aynı). Testlerde `REMOTE_DOSYA_KURU=1`: Gezgin açılmaz.
      **(henüz gerçek cihazda test edilmedi: gerçek iPhone Safari'de hiç denenmedi (fotoğraf seçicinin adı ve HEIC→JPEG, 16 px kutu,
      seçici listesinin kaydırılması, gizli sekmede localStorage); explorer.exe /select hiç gerçekten çalıştırılmadı (boşluklu/Türkçe
      yol); tepsi "Dosya geldi" balonu gözle görülmedi; OneDrive'a taşınmış Türkçe adlı klasör; seçilen klasörde yükleme sırasında
      çökme olursa yarım dosya açılışta silinmez; sunucu yeniden başlayınca "Son gönderilenler"deki göster düğmesi göreli yola düşer)**
      Not: ilk denemede gönderilen fotoğraf `%USERPROFILE%\Downloads\Uzaktan Bağlantı\IMG_0676.jpeg`'de.

## Sıradaki
1. Yukarıdaki özelliklerin gerçek telefon/tablet/kalemle denenmesi (ikinci ekran dahil)
2. H.264 için de masaüstü çoğaltma (ffmpeg ddagrab) — JPEG yolunda yapıldı; çıkış ↔ \\.\DISPLAYn eşlemesi DXGI_OUTPUT_DESC.DeviceName ile (`DxgiCapture.Open`)
3. Gerekirse herkese açık link (Cloudflare Tunnel) — şimdilik gerek yok, sadece kendi cihazlar
4. Windows servisi olarak çalışma (UAC ve kilit ekranı)
5. Yönetim günlüğünde 'dosya' ve 'guc' olaylarının okunur gösterimi (LOG_NAMES), özellik başına "misafire kapalı" seçeneği
6. `adb reverse` bağlantılarını "bu bilgisayar"dan ayırt etme
7. Çekirdeğe izleme başlat/durdur kancası (`api.onStreamStop`): perde şimdilik izlemeyi bırakan/yetkisi düşen bağlantıyı saniyede bir yoklayarak kaldırıyor
8. Tepsi menüsünde "kes" ile "kes ve cihazı unut" ayrımı: şimdilik tepsiden kesilen hatırlanan cihazın kaydı her zaman siliniyor (yeniden girişte şifre sorulur)
9. Android Chrome'da kalemin ürettiği dokunma olaylarının ayıklanması (pointerdown 'pen' sonrası gelen dokunuş kimlikleri) gerçek S-Pen ile doğrulanmalı; salt izleme rolünde hatırlanan touchpad modunun yok sayılması için tarayıcı testi yok
10. Çalışan sunucu yeniden başlatılmalı (tepsiden "Yeniden başlat"): eski RemoteHelper.exe hâlâ kullanımda; ikinci ekranın kırpılmaması (PerMonitorV2 DPI), DXGI yakalama ve iş parçacıklı girdi ancak açılışta exe yeniden derlenince devreye girer. Ardından iPhone'da ikinci ekran ve akıcılık yeniden denenmeli. Yatay iPhone + klavye + Tuşlar panelinde (tus-sikisik: araç çubuğu gizlenir) gerçek cihazda denenmeli.
