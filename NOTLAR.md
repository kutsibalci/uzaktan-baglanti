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
- [x] Bilgisayardan telefona indirme: her dosya türü (attachment + octet-stream + nosniff; Türkçe ad filename* + ASCII yedek;
      0 bayt, uzantısız, uzun ad; tek aralıklı Range/206, If-Range, 416), klasör satırında "Zip olarak indir", seçme kutuları +
      "Seçilenleri indir" (tek dosya doğrudan, çoklu → zip). Zip `lib/zip.js`: harici paket yok, akışla (belleğe almaz), deflate /
      sıkıştırılmış uzantılarda store, data descriptor ile akışta CRC, ZIP64 (> 4 GB girdi/konum, > 65535 girdi), UTF-8 ad bayrağı,
      klasör ve boş klasör girdileri. Çoklu seçim önce `POST /api/dosya/secim` (yollar gövdede; tahmini boyut gösterilir, kimlik
      15 dk ve yalnızca aynı oturum), indirme `GET /api/dosya/zip?secim=` ile kullanıcının dokunduğu gerçek `<a download>`
      bağlantısından (iOS'ta blob/iframe/yeni sekme yok). Güvenlik gezinmeyle aynı; junction/symlink izlenmez, açılamayan dosyalar
      atlanıp zip sonunda `_atlananlar.txt`; sınır 200000 öğe / 64 GB; istemci iptal edince dosya tanıtıcısı kapanır.
      Testler: `ozellik-zip.js` (kendi okuyucu + Expand-Archive + tar.exe, 4,5 GB seyrek dosya, 70000 girdi), `ozellik-zip64.js`
      (`REMOTE_ZIP64_ESIK=1000` ile ZIP64 küçük dosyalarla zorlanır), `ozellik-dosya.js` (başsız Edge, iPhone boyutu, gerçek indirme).
      Gönderirken "Kaydedilecek yer → Değiştir → Masaüstü" zaten çalışıyordu (bu bilgisayarda kayıt defterindeki Masaüstü profil
      içinde, kısayol olarak çıkıyor); değişiklik gerekmedi.
      **(henüz gerçek cihazda test edilmedi: iPhone Safari / iOS Chrome'da indirme hiç denenmedi (indirme onayı, İndirilenler'e kayıt,
      Dosyalar'da zip'i açma ve Türkçe adlar, uzunluksuz zip akışında ilerleme, ana ekrana eklenmiş PWA'da indirme davranışı,
      Tailscale HTTPS üzerinden büyük indirme ve Range ile sürdürme); WebSocket kopunca oturum anahtarı geçersizleşir — kesilen indirme
      sonradan sürdürülemez; macOS Arşiv İzlencesi ile açma; okuma yarıda hata verirse zip bilerek bozuk kalır)**
- [x] Touchpad modunda sağ tık: iki parmak dokunuşu toleranslı (toplam ≤ 500 ms, parmaklar arası ≤ 150 ms, kayma ≤ 20 px; karar
      `public/dokunmatik.js` → `isTwoFingerTap`, saf ve testli), hareketsiz 500 ms basılı tut → halka, bırakınca sağ tık; çubukta
      **Sağ tık** düğmesi (dokun = sıradaki dokunuş sağ tık, uzun bas = kilitli 🔒); her modun ilk kullanımında küçük ipucu kartı.
      **(henüz gerçek cihazda test edilmedi: gerçek parmakla eşikler (500/150/20) iPhone/iPad'de; Sağ tık düğmesine uzun basınca iOS
      büyüteç/bağlam menüsü çıkıp çıkmadığı)**
- [x] Kumanda modu (ana menü kartı, salt izlemede kapalı): görüntü akışı yok ('start' gönderilmez). Touchpad (göreli imleç: RemoteHelper
      `cursor` = GetCursorPos, salt okur), basılı tutulabilir Sol/Sağ tık, kaydırma şeridi; Medya (oynat/durdur, önceki/sonraki, ses);
      Sunum (PgUp/PgDn, F5, B, Esc); Klavye. Mesaj `{ t:'kumanda', op }` (`features/kumanda.js`); bağlantı kopunca basılılar bırakılır.
      **(henüz gerçek cihazda test edilmedi: iPhone/iPad'de dokunma ve iOS ekran klavyesi (beforeinput/⌫/↵); göreli hareketin hissi ve
      ivme (KAT=2), çoklu monitör geçişi; medya tuşlarının Spotify/YouTube'a, sunum tuşlarının PowerPoint/PDF'e gerçekten gitmesi;
      mobil veride gecikme; kilit ekranında/UAC'de cursor sorgusu)**
- [x] Çizim tableti (ana menü kartı "🎨 Çizim tableti"): sanal ekran sürücüsü varsa ikinci ekran, yoksa seçili ekran; kenar kısayol
      paneli (Geri al/Yinele, basılı Ctrl/Shift/Alt/Boşluk, fırça/silgi, fırça boyutu, yakınlaştırma, renk; profiller Photoshop, Krita,
      Clip Studio Paint, Paint.NET, Paint), `{ t:'cizim-tus' }` mesajı (sunucu basılı tuşları bağlantı kopunca bırakır). Avuç içi reddi
      (kalemden sonraki 1 sn parmak yok sayılır, yarıçap > 25 px her zaman) + "✋ Parmak" ayarı. Kalem: getCoalescedEvents ara noktaları,
      sınır 480/sn, Apple Pencil hover, RemoteHelper'da `pen` ana iş parçacığında. H.264'te 60 fps.
      **(henüz gerçek cihazda test edilmedi: iPad + Apple Pencil hiç denenmedi (basınç/eğim, hover, avuç içi reddi ve 25 px eşiği,
      Safari'de getCoalescedEvents ve requestFullscreen); gerçek çizim programlarında kısayollar; Türkçe Q'da [ ] fırça boyutu (ğ/ü
      üretebilir); Krita/CSP/Paint.NET'te Ctrl+Num± yakınlaştırma; Android S-Pen; iki parmakla Ctrl tut + Geri al; pen ana iş
      parçacığının gecikme kazancı ve 60 fps ölçülmedi)**
- [x] QR ile telefon eşleştirme: bilgisayarda (yalnızca localhost yönetici) ana menü "📱 Telefonu bağla (QR)" ya da tepsi menüsü →
      QR (Tailscale HTTPS adresi varsa o, yoksa ev ağı adresi + `#e=<belirteç>`; 2 dk, tek kullanımlık, SHA-256 özetiyle saklanır).
      Telefon onay bekler, bilgisayarda Onayla / Reddet (60 sn); onaylanınca cihaz hatırlanır. Çekirdeğe `api.onPreAuth` +
      `api.auth`, tarayıcıda `RC.setAuthHook`. QR kodlayıcı `lib/qr.js` paketsiz (referans uygulamayla bit bit, jsQR ile çözülerek doğrulandı).
      **(henüz gerçek cihazda test edilmedi: iPhone kamerasıyla okutma (iOS Safari/Chrome), iPad, #e= parçasının silinmesi ve kamera
      uygulamasından açılan sayfada cihaz anahtarının saklanması, Tailscale HTTPS üzerinden uçtan uca; tepsi menüsü öğesi elle tıklanmadı)**
- [x] Bilgisayar durumu paneli (⋯ menü + ana menü "📊"): CPU, CPU sıcaklığı (yönetici olmadan bu PC'de ölçülemiyor, nedeni yazılır), RAM,
      NVIDIA GPU (nvml.dll), ağ, pil, açık kalma süresi, diskler, 60 sn SVG grafik; en çok CPU/RAM kullanan 15 program; yönetici "Kapat"
      (WM_CLOSE) → 5 sn sonra "Zorla kapat" (ikinci onay; PID + başlama zamanı denetlenir; kritik süreçler, explorer ve sunucu ağacı 🔒).
      Ölçüm kalıcı `helper/Durum.exe` (Windows API; kendi CPU'su ~%0,1), yalnızca panel açıkken ya da CPU/pil izleyicisi varken çalışır.
      Bildirimler: program kapanınca, CPU eşiğin altına inince, pil azalınca, İndirilenler'e dosya gelince; bağlı değilken olanlar sonraki
      girişte gösterilir. Web Push bilerek yok (Apple/Google sunucusu gerekir → "veri dışarı çıkmaz" ilkesine aykırı).
      **(henüz gerçek cihazda test edilmedi: iPhone/iPad'de panel ve kaydırma, iOS'ta bip (WebAudio) — iOS titreşimi desteklemez,
      iOS seçicide disabled pil seçeneği; pil izleyicisinin gerçekten tetiklenmesi; pencereli gerçek programın nazik kapatılması ve
      "kaydetmek ister misiniz"; yönetici olarak çalışan programı kapatma; gerçek tarayıcı indirmesi (.crdownload/.part) ve taşınmış
      İndirilenler; Optimus'ta NVML'nin pile etkisi; sunucu yeniden başlayınca PID yeniden kullanılmışsa "program kapanınca")**
- [x] Pano: resim iki yönde. Bilgisayar → telefon: Pano.exe "PNG" akışı / CF_DIB okur, istemciye yalnızca boyut bildirilir, PNG
      `GET /api/pano/resim`; "Telefona kopyala" (ClipboardItem + Promise, iOS deseni) ve "Kaydet / Paylaş" (HTTP'de "Kaydet (indir)").
      Telefon → bilgisayar: "Telefondan resim gönder" (clipboard.read, yoksa "Resim seç…"; HEIC/WebP tuvalle PNG'ye), `POST /api/pano/resim`
      (≤ 20 MB). Geri yankı piksel SHA-1 özetiyle önlenir; salt izleme erişemez.
      **(henüz gerçek cihazda test edilmedi: iOS'ta "Telefona kopyala", Paylaş → Fotoğraflar'a kaydet, clipboard.read izin balonu, fotoğraf
      seçicisi ve HEIC çevirisi; iPad; HTTP'de iPhone'da indirme; gerçek Win+Shift+S; Paint/Word'de yapıştırma elle denenmedi)**
- [x] Ev ağında HTTPS (Tailscale olmadan): kendi yerel kök CA'mız (ECDSA P-256, Name Constraints ile yalnızca yerel ad/özel IP),
      sunucu sertifikası tüm özel IPv4'ler + ad + `ad.local` + localhost; 3443'te (PORT_HTTPS) aynı işleyici ve WebSocket. ⋯ menü
      "🔒 Ev ağında HTTPS" rehberi (iPhone/iPad .mobileconfig, Android .cer), HTTP sayfasında öneri şeridi ve güven yoklaması
      (`/api/sertifika/yokla`), yönetimde aç/kapat/yeniden üret/sil; IP değişince ya da bitişe 30 gün kala yeniden imza. Paket yok
      (`lib/sertifika.js` kendi DER yazıcısı). Anahtarlar `data/sertifika/` (yalnızca bu kullanıcıya açık ACL).
      **(henüz gerçek cihazda test edilmedi: iPhone/iPad'de .mobileconfig kurulumu ve Sertifika Güven Ayarları; iOS'un Name Constraints'li
      CA'yı kabulü (reddederse `caUret()`'teki 2.5.29.30 uzantısı kaldırılmalı); iOS'ta IP adresli SAN ile HTTPS + wss, H.264 ve ses;
      iOS Chrome'da profil; Android .cer ve Chrome; canlı DHCP değişimi; Windows Güvenlik Duvarı'nın 3443 için izin sorması)**
- [x] Ses testi: Ses.exe başlarken Windows'un biriktirdiği ~1 sn'lik ses tek seferde geliyor (ölçüldü), test ilk 500 ms'yi saymıyor.
- [x] İnceleme düzeltmeleri: Kumanda'da Sol/Sağ tık düğmesini tutup pad'de sürükleme (yalnızca pad'de başlayan parmaklar sayılır;
      eskiden iki parmak/tekerlek sanılıyordu ve sonraki hareket yutuluyordu), pad'de parmak dururken kaydırma şeridi; touchpad'de
      (çekirdek + Kumanda) dokunuştan hemen sonraki iki parmak dokunuşu bekleyen sol tıkı kaybetmiyor; "Sağ tık" düğmesi açıkken iki parmak
      sağ tık hakkı harcıyor; 1x'te art arda iki parmak sağ tıkları yutulmuyor (çift dokunuş yalnızca yakınlaştırılmışken 1x). QR eşleştirme:
      telefonda ve bilgisayardaki onay isteğinde aynı 2 haneli doğrulama kodu ("QR okundu: …"; ekranı izleyen biri QR'ı okuyup araya
      giremesin), Tailscale yoksa ve ev ağı HTTPS'i açıksa QR şifreli `https://<ev-ip>:3443` adresini verir ("sertifika yüklemedin mi?"
      düğmesiyle HTTP). Durum paneli: sunucunun konsol penceresini taşıyan süreç (conhost / OpenConsole + Windows Terminal) 🔒 sayılır;
      "program kapanınca" izleyicisi başlama zamanını (ct) saklar, PID başka sürece geçerse (ör. yeniden başlatma) kapandı sayar.
      **(henüz gerçek cihazda test edilmedi: iPhone'da Sol tık tut + sürükle, şerit ve iki parmak düzeltmeleri; doğrulama kodunun iPhone'da
      görünümü; iPhone'un QR'daki https://<ev-ip>:3443 adresini sertifikayla açması; baslat.bat'ın Windows Terminal'de açıldığı durumda
      konsol korumasının gerçek sunucuda görünmesi — klasik conhost'ta ve bu oturumun Windows Terminal'inde ölçüldü)**
- [x] Akıllı Uygulama Denetimi (SAC) dayanıklılığı: SAC açık ve yeni derlenmiş imzasız exe'leri rastgele engelliyor (Tepsi.exe'nin yeni
      derlemesi engellendi; Code Integrity günlüğünde başka bir kopyanın RemoteHelper.exe'si için 3077 görüldü). Engelli spawn Node'da
      eşzamanlı `UNKNOWN` fırlatıyordu → RemoteHelper engellenince sunucu açılışta çöküyordu. Şimdi `lib/helper.js` `spawnHelper`: engel
      (UNKNOWN/EACCES/EPERM ya da 0xC0000428/4551/1260 çıkışı) kaydedilir, exe bir daha başlatılmaz (döngü yok), RemoteHelper engelliyken
      giriş/yönetim çalışır (ekran listesi boş). Uyarı günlükte, yönetim panelinde (kanıt: CodeIntegrity 3077/3033, yönetici gerekmez,
      yalnızca bu klasörün helper\ exe'leri) ve yöneticiye ana menüde. `arka-plan-baslat.bat` / `arka-plan-durdur.bat` + `tools\arka-plan.ps1`:
      tepsisiz, yalnızca imzalı powershell.exe ile gizli bekçi (yeniden başlatma 2/5/15/60 sn, 10 dk'da 5 çökmede durur, günlük 5 MB döndürme,
      PID dosyası, düzgün kapanış için TRAY_TOKEN'lı /api/tepsi/kapat). "Windows açılınca başlat" yönetim panelinden: HKCU Run değeri
      `UzaktanBaglanti` (arka plan ya da Tepsi). Tepsi yokken Windows bildirimi (WinRT toast, sessiz, oran sınırlı). Onay penceresi açılamazsa
      bu bilgisayardaki yönetici oturumuna onay kutusu (`features/baslatma.js`). Testler: `ozellik-baslatma` (engel taklidi = metin dosyası
      .exe, sahte Run anahtarı), `ozellik-arka-plan`, `ozellik-baslatma-tarayici` (iPhone boyutu). Bildirim bu bilgisayarda bir kez elle
      gösterildi: Bildirim Merkezi geçmişine düştü (sonra silindi), ekranda görünüşü gözle doğrulanmadı.
      Gerçek SAC engelinin Node'daki hatası ölçüldü: bu çalışmada yeni derlenen Perde.exe / Durum.exe engellendi (3077) ve spawn eşzamanlı
      `UNKNOWN` (errno -4094) fırlattı — taklitle aynı.
      **(henüz gerçek cihazda test edilmedi: gerçek oturum açılışında Run değerinden başlama — yalnızca sahte anahtarla sınandı;
      onay kutusunun / uyarının iPhone'da görünümü — yalnızca başsız Edge'de 390x844; bildirimin ekranda açılır görünmesi (Odak
      Yardımı bastırabilir); oturum açılışında powershell -WindowStyle Hidden'ın kısa konsol yanıp sönmesi; Perde engeline özel
      REMOTE_EXE_PERDE taklit testi yok; 0xC0000428/4551/1260 çıkış koduyla engel yolu — gerçek engel eşzamanlı UNKNOWN olarak görüldü;
      gerçek makinede Tepsi + Run aynı anda)**

- [x] Veri kullanımı sayacı + "Veri tasarrufu" kalitesi (mobil veri faturası için). ⏱ panelinde "Veri kullanımı" bölümü (görüntü / ses /
      dosya / diğer, gelen · giden, anlık ve oturum ortalaması, "bu hızla saatte ≈ X" — hız ve tahmine dosya aktarımları girmez), ⋯ menüde
      "📶 Veri · 12 MB" satırı (çubuğa bir şey eklenmedi); cihaz başına bugün / bu ay (localStorage), "Oturumu sıfırla" ve "Bugün/ay sıfırla".
      WebSocket baytları tarayıcıda sayılır (RC.traffic, çerçeve başlığı dahil); HTTP (dosya indirme/yükleme, pano resmi, <a download> dahil)
      sunucuda soket sayaçlarıyla sayılıp 'veri-http' ile gelir. Dahil değil: TLS/Tailscale ek yükü (~%5-10), sayfanın ilk yüklenmesi
      (index.html/js/simgeler). Kalite menüsünde "Veri tasarrufu": H.264 en fazla 500 kbps (VBR, cq 30), 15 fps, uzun kenar 1280;
      JPEG kalite 35 / 15 fps / 1280; ses dinleyenlerin hepsi tasarruftaysa Opus 32 kbps (normal 96; zincir kısa kesintiyle yeniden başlar).
      Ölçüm (test sunucusu, NVENC): sürekli hareketli sentetik görüntüde (testsrc2, sunucunun aynı ffmpeg argümanları) Orta ≈ 1790 MB/saat,
      Veri tasarrufu ≈ 222 MB/saat; gerçek (çoğunlukla durağan) ekranda 12 sn'de Orta ≈ 270-295, tasarruf ≈ 30-95 MB/saat. Ses 32 kbps ≈ 14 MB/saat.
      Mobil veri önerisi: navigator.connection.type === 'cellular' ise ana ekranda bir kerelik şerit (Aç / Hayır, cevap hatırlanır).
      **iOS Safari ve iOS Chrome'da navigator.connection YOK (WebKit uygulamıyor) — iPhone'da şerit hiç çıkmaz; Veri tasarrufu menüden seçilmeli.**
      Sayaç doğruluğu başsız Edge'de CDP ağ çerçeveleriyle karşılaştırıldı (WebSocket birebir, HTTP indirme ±%0,1).
      **(henüz gerçek cihazda test edilmedi: iPhone'da panel/menü görünümü ve sayaçların operatör sayacıyla karşılaştırılması; mobil veride
      gerçek kullanımda saatlik tüketim; Android Chrome'da 'cellular' şeridi; 32 kbps Opus'un iPhone'da ses kalitesi ve bit hızı değişirken kesintinin duyulması; HTTPS (TLS soketi)
      üzerinden HTTP bayt sayımı — testler HTTP'de; JPEG yolunda Veri tasarrufunun bayt ölçümü — yalnızca H.264 ölçüldü)**

- [x] "🖥🖥 Tüm ekranlar" görünümü: birden çok ekran varsa seçicide (ana menü ve ⋯ menü). Bütün monitörler gerçek fiziksel
      dizilimiyle tek görüntüde (sınır kutusu; boşluklar siyah). Hesaplar `public/ekranlar.js` (tarayıcı + sunucu ortak):
      görüntüdeki nokta içinde olduğu ekrana ve o ekrandaki nx, ny'ye çevrilir (boşluk -> en yakın ekran, kumandanın
      ekranaSigdir kuralı); `move`/`kalem` mesajı `s` (ekran adı) taşır, sunucu adı doğrular. Tüm girdi yolları (dokunma,
      touchpad, fare, sürükleme — ekran değişse de düğme basılı kalır, kalem, yakınlaştırma) çekirdekteki `send()` üzerinden geçer.
      H.264: tek gdigrab bölgesi = sınır kutusu (ffmpeg PerMonitorV2; ölçek doğru). Ölçek: Düşük/Orta/Otomatik toplam piksel
      ~1280×720 / ~1920×1080 eşdeğeri (kullanıcı dizilimi Orta: 2716×764), Yüksek tam çözünürlük (en fazla 3840 geniş).
      JPEG: her ekran RemoteHelper'ın ekran başına DXGI çoğaltmasıyla ayrı yakalanır, ikili tür 4'te birlikte gider, tarayıcı
      birleşik görüntüye çizer (RemoteHelper değişmedi: Akıllı Uygulama Denetimi yeni derlenen exe'yi engelliyor).
      Her ekranın köşesinde yarı saydam "1"/"2" etiketi; etikete dokununca o ekran tek başına açılır (iki parmak çift dokunuş
      zaten 1x'e dönüş olduğu için hareket değil etiket). Ekran düzeni 2 sn'de bir yoklanır (yalnızca izleyen varken): değişince
      izleyenlere yeni liste (`ekranlar` mesajı), H.264 yeni bölgeyle yeniden kurulur, çıkarılan tek ekranı izleyen ana ekrana geçer.
      Ölçüm (bu dizüstünde, tek monitörde 1700×1080 bölge): gdigrab + NVENC ~30 kare/sn. Daha önce 1920×1080 gdigrab ~23 kare/sn,
      süre alanla orantılı (960×540 ~48) ölçüldü: iki 1080p ekranda (3840×1080) ~11-15 kare/sn bekleniyor. ddagrab (DXGI) tek
      çıkışta ~46-50 kare/sn ama çıkış ↔ \\.\DISPLAYn eşlemesini vermiyor (iki ekran da 1920×1080, ayrı GPU'larda olabilir) — seçilmedi.
      Test: `test/ozellik-tum-ekranlar.js` (birim + sahte dizilimle uçtan uca: `REMOTE_EKRANLAR_SAHTE`, `REMOTE_GIRDI_KURU=1`),
      `test/ozellik-tum-ekranlar-tarayici.js` (iPhone boyutu, dokunma).
      **(henüz gerçek cihazda test edilmedi: iPhone'da hiç denenmedi; bu bilgisayarda test sırasında yalnızca BİR monitör bağlıydı —
      gerçek iki monitörle yakalama (DISPLAY2 karesi, %125/%100 karışık ölçekte gdigrab birleşimi, iki ekranda kare hızı) ölçülmedi,
      iki ekranlı durum sahte dizilimle sınandı; gerçek fare/kalem girdisi gönderilmedi (mesaj düzeyinde); monitör takıp çıkarma
      yalnızca sahte dizilim dosyasıyla; negatif konumlu ekran yalnızca birim testinde; kalemle tüm ekranlarda çizim yalnızca birim
      testinde — kalem etikete dokunursa kalem olayı da gider; JPEG tür 4'te ekranlar arası birkaç ms zaman farkının yırtılması gözle bakılmadı)**
      Veri sayacı tür 4 kareleri "Görüntü"ye sayar (bütünleştirmede eklendi). "Veri tasarrufu" tüm ekranlarda ~1280×720 piksel eşdeğeri.

- [x] İnceleme düzeltmeleri (paket 3: 7 bulgu + sunucu günlüğünde görülen 2 hata):
      (1) `arka-plan.ps1` bekçisi veri klasörü başına adlı Mutex alır (`Local\UzaktanBaglanti-arka-plan-<özet>`): aynı anda iki
      "başlat" (çift tık, Run + elle) artık ikinci bekçi/sunucu açıp PID dosyasını silmiyor, sunucu `durdur` ile durdurulabilir kalıyor
      (`test/ozellik-arka-plan.js` 7. bölüm; eski betikle PID dosyası siliniyor, `durdur` "dokunulmadı" diyip 3 dönüyordu). Testin
      temizliği PID yeniden kullanımına karşı yalnızca test başladıktan sonra oluşmuş kendi bekçilerini ve onların node çocuklarını kapatır.
      (2) Onay penceresi (RemoteHelper ask) 0/1 dışında bir kodla kapanınca (çökme, ilke kodu) yerel yöneticiye `pencere: false`
      güncellemesi gider ve tepsi varken de (tür aralığına takılmadan) onay bildirimi gösterilir (`test/ozellik-baslatma-onay.js`).
      (3) Tüm ekranlar etiketleri: yer varsa görüntünün dışında, üstteki boşlukta (dikey iPhone'da masaüstünün sol üstünü örtmüyor);
      touchpad modunda (`body.rc-touchpad`) etiket dokunma olaylarını durdurmaz — dokunuş / kaydırma tık ve imleç olarak geçer, tek
      ekrana geçiş ⋯ menüsündeki seçicide; fareyle etiket her modda tek ekran açar.
      (4) Mobil veri şeridi ~250 MB/saat vaadini yalnızca H.264 varken yazar (şifresiz adreste: görüntü JPEG, bit hızı sınırı yok uyarısı);
      README de koşullu. Veri bölümünde ondalık nokta (aynı paneldeki gecikme satırlarıyla aynı).
      (5) `ozellik-tum-ekranlar` düzen değişimi kontrolündeki yarış (kareler düzen yazılmadan önce temizlenir, eski düzenin geç kareleri atlanır).
      (6) `/api/sertifika/durum` sertifikada olmayan bir adla açılan sayfada (ör. `tailscale serve`'ün *.ts.net adı) 500 dönüyordu
      (günlükte `[sertifika] HTTP hatası: Invalid name`): Node 24'te `X509Certificate.checkIP` IP olmayan metinde istisna atıyor.
      Artık ad için yalnızca checkHost, IP için yalnızca checkIP; önerilen adres ev ağı IP'sine düşer (`test/ozellik-sertifika.js`).
      (7) RemoteHelper.exe açılır açılmaz kapanırsa (ör. Windows kapanırken 0xC000026B STATUS_DLL_INIT_FAILED) sabit 0,5 sn arayla
      sonsuz yeniden başlatma yerine bekleme iki katına çıkar (0,5 → 1 → 2 … en fazla 10 sn); 30 sn'den uzun çalıştıktan sonraki
      kapanışta yine 0,5 sn (`test/ozellik-helper-yeniden.js`, sahte yardımcıyla).
      **(henüz gerçek cihazda test edilmedi: iPhone'da etiketlerin üstteki yeri ve touchpad'de etiket üstünden dokunuş — başsız Edge
      390×844 emülasyonunda sınandı; Android Chrome'da HTTP adresinde şeridin JPEG metni; gerçek Tailscale adından açılan sayfada
      sertifika durumu — yalnızca Host başlığı taklidiyle; Windows kapanırken yardımcının bekleme davranışı — sahte yardımcıyla)**
- **Ortak ağdan ev ağı girişini kapat** (2026-10-21; yönetim paneli > Güvenlik, varsayılan açık): okul Wi-Fi'ı Windows'ta "Ortak"
  görünüyordu ama güvenlik duvarında node.exe'ye Ortak ağlarda da izin verilmişti — aynı ağdaki herkes giriş sayfasını açabiliyordu
  (misafir kodu da onaysız giriyor). Artık bağlantının geldiği yerel adresin Windows ağ profili Ortak ise ev ağı bağlantısı (HTTP,
  WebSocket, 3443 HTTPS) reddedilir; bu bilgisayar ve Tailscale (`tailscale serve` dahil) etkilenmez. Profil `Get-NetConnectionProfile`
  ile (yönetici gerektirmez; PowerShell'in açılışı bu bilgisayarda 3-5 sn) adres değişince, reddetmeden önce bilgi eskiyse ve 5 dk'da
  bir okunur (`lib/agprofili.js`); ilk okuma bitene kadar ev ağı kapalı, profili olmayan adres (WSL) açık. Panelde ağlar ve
  profilleri görünür, sunucu açılışında Ortak adresler ayrı satırda. Test: `test/ozellik-ortak-ag.js` (sahte profille bu bilgisayarın
  ev ağı adresinden 403 / WebSocket reddi, localhost ve Tailscale başlığıyla giriş, ayar kapalı/açık; gerçek profil okuma).
  Güvenlik duvarı kuralı yine kullanıcının elinde (Ortak kutusunu kaldırmak ilk katman).
  **(henüz gerçek cihazda test edilmedi: başka bir cihazdan okul ağında erişim denemesi; evde ağ Özel yapılınca telefonun ev ağı
  adresinden girebilmesi)**
- **Arayüz yenilendi** (2026-10-21): mavi → mor marka rengi ve logo (uygulama simgesiyle aynı), emoji yerine kendi çizdiğimiz SVG simge seti
  (`public/ikon.js`, renkli kutucuklar; özelliklerin emojileri merkezden çevrilir), ana menüde renkli kartlar + araçlar ızgarası + baş harfli
  avatar ve yetki rozeti, giriş / kurulum / onay ekranlarında logo, onay kutuları anahtar (switch), yönetimde simgeli bölümler ve bulanık
  yapışkan başlık, araç çubuğu ve ⋯ menüsü yeni görünümde. Ayrıca: girişe dönünce açık kalan paneller (ör. bilgisayar durumu) artık kapanıyor.
  Başsız Edge'de iPhone (390×844) ve masaüstü (1366×820) boyutunda ekran görüntüleriyle kontrol edildi.
  **(henüz gerçek cihazda test edilmedi: iPhone Safari'de görünüm — `color-mix`, `backdrop-filter`, anahtar görünümlü onay kutuları)**
- **Telefonda alt çubuk + ilk bağlantı tanıtımı** (2026-10-21; kullanıcı: "3 noktaya basmayan bu özellikleri göremeyecek"): TeamViewer/RustDesk
  tarzı — telefonda (< 720 px) Klavye, Tuşlar, Fare/Dokunmatik, Sağ tık, Pano ve **Diğer** altta, yazılı; Diğer (⋯) alttan açılan
  (sonradan sade liste oldu, aşağıda); açılır paneller alttan açılır; üst çubukta yalnızca geri, bağlantı/fps ve gecikme. Geniş ekran ve yatay telefon eskisi gibi
  (üst çubuk). İlk görüntü açılışında (cihaz başına bir kez) 3 adımlık tanıtım: alt çubuk → Diğer → hareketler (masaüstünde 2 adım, üst çubuk);
  katman dokunuşları bilgisayara gitmez, Geç / Başla / Esc kapatır, Diğer → "Nasıl kullanılır?" yeniden açar. Testler: güncellenen
  `ozellik-arayuz-tarayici`, yeni `ozellik-tanitim-tarayici` (24 kontrol).
  **(henüz gerçek cihazda test edilmedi: iPhone'da alt çubuk + ekran klavyesi birlikteyken yer, ana ekran çizgisi (safe-area) boşluğu)**
- **Gerçek iPhone geri bildirimi düzeltmeleri** (2026-10-21; kullanıcı: "sağ tık için basılı tutup tekrar ekrana dokunmak gerekiyor",
  "dokunmatik mod hiç hoşuma gitmedi" (parmak tam yere basmıyor, kaydırma/sürükleme karışıyor, hareketler anlaşılmıyor), "Diğer büyük,
  ekranı kaplıyor", "çok AI slop duruyor, profesyonel olsun"):
  (1) **Sağ tık** düğmesi dokununca imlecin olduğu yerde hemen sağ tık (sıradaki dokunuşu beklemiyor). (2) **Basılı tut = hemen sağ tık**
  (bırakmayı beklemeden) iki modda da. (3) Varsayılan mod **Fare** (touchpad; hassas), yeni anahtar `dokunmaModu` herkesi Fare'den başlatır;
  **Dokunmatik** modda tek parmakla sürükleme = sürükleme, iki parmak = kaydırma (iki modda aynı). Çizim tableti açıkken parmak dokunduğu
  yeri tıklar. (4) **Diğer** menüsü sade liste (simge + ad + durum), telefonda ekranın en fazla ~%60'ı; az kullanılanlar (gecikme, veri, HTTPS,
  tanıtım, çubuğu gizle, çizim paneli, parmak) **Daha fazla** altında katlı (`menuItem({ ikincil: true })`; açılınca menü uzar).
  (5) **Sade koyu tasarım** (Linear / Vercel / Tailscale tarzı): gri tonlar + tek mavi vurgu; gradyan, parıltı, renkli simge kutucuğu yok;
  giriş / kurulum ekranları ortalı logo + başlık + etiketli alanlar + gizlilik notu (telefonda çerçevesiz); ana menüde kartlar + "Araçlar"
  ayar listesi; yönetimde düz başlıklar. Testler: `ozellik-telefon-tarayici` (yeni hareketler), `ozellik-arayuz-tarayici` (liste, Daha fazla),
  `ozellik-tanitim-tarayici`, `-sertifika-`, `-veri-`, `-tum-ekranlar-`, `-cizim-tarayici` güncellendi.
  **(henüz gerçek cihazda test edilmedi: iPhone'da yeni sağ tık ve basılı tutma, Fare modunun his/ivmesi, yeni görünüm)**

## Sıradaki
1. Yukarıdaki özelliklerin gerçek telefon/tablet/kalemle denenmesi (ikinci ekran dahil)
2. H.264 için de masaüstü çoğaltma (ffmpeg ddagrab) — JPEG yolunda yapıldı; çıkış ↔ \\.\DISPLAYn eşlemesi DXGI_OUTPUT_DESC.DeviceName ile (`DxgiCapture.Open`).
   "Tüm ekranlar" H.264'te gdigrab (iki 1080p ekranda ~11-15 kare/sn tahmini): gerçek iki monitörde ölçülmeli; düşükse ekran başına ddagrab + overlay
   (RemoteHelper'ın çıkış eşlemesini vermesi gerekir; SAC yeni derlenen exe'ye izin verince)
   - `tepsi-baslat.bat`: Tepsi.exe engellenirse kendiliğinden `arka-plan-baslat.bat`'a düşme (şimdilik Windows'un kendi hatası görünür)
   - `test/ozellik-durum.js` "explorer kapatılamaz" kontrolü, sunucunun atası explorer.exe olan oturumda (Windows Terminal → claude) "kendi süreci" diye düşüyor (temiz HEAD'de de): test ortamdan bağımsız olmalı
3. Gerekirse herkese açık link (Cloudflare Tunnel) — şimdilik gerek yok, sadece kendi cihazlar
4. Windows servisi olarak çalışma (UAC ve kilit ekranı)
5. Yönetim günlüğünde 'dosya' ve 'guc' olaylarının okunur gösterimi (LOG_NAMES), özellik başına "misafire kapalı" seçeneği
6. `adb reverse` bağlantılarını "bu bilgisayar"dan ayırt etme
7. Çekirdeğe izleme başlat/durdur kancası (`api.onStreamStop`): perde şimdilik izlemeyi bırakan/yetkisi düşen bağlantıyı saniyede bir yoklayarak kaldırıyor
8. Tepsi menüsünde "kes" ile "kes ve cihazı unut" ayrımı: şimdilik tepsiden kesilen hatırlanan cihazın kaydı her zaman siliniyor (yeniden girişte şifre sorulur)
9. Android Chrome'da kalemin ürettiği dokunma olaylarının ayıklanması (pointerdown 'pen' sonrası gelen dokunuş kimlikleri) gerçek S-Pen ile doğrulanmalı; salt izleme rolünde hatırlanan touchpad modunun yok sayılması için tarayıcı testi yok
10. Çalışan sunucu yeniden başlatılmalı (tepsiden "Yeniden başlat"): eski RemoteHelper.exe hâlâ kullanımda (kumanda `cursor` ve kalem `pen` değişiklikleri de ancak yeniden derlenince gelir; ilk açılışta data/sertifika üretilir ve 3443 dinlenir); Durum.exe (konsol penceresi koruması) de yeniden derlenir; ikinci ekranın kırpılmaması (PerMonitorV2 DPI), DXGI yakalama ve iş parçacıklı girdi ancak açılışta exe yeniden derlenince devreye girer. Ardından iPhone'da ikinci ekran ve akıcılık yeniden denenmeli. Yatay iPhone + klavye + Tuşlar panelinde (tus-sikisik: araç çubuğu gizlenir) gerçek cihazda denenmeli.
11. "Veri tasarrufu"nda JPEG yolu için sunucu tarafında bayt/sn bütçesi (kbps: 500'ü JPEG kalite/fps seçiminde sınır olarak kullanmak):
    şimdi JPEG'de bit hızı sınırı yok — incelemede hareketli ekranda tasarrufta ~2,6 GB/saat (tek ekran), ~3 GB/saat (tüm ekranlar)
    ölçüldü; şerit ve README şimdilik yalnızca uyarıyor
