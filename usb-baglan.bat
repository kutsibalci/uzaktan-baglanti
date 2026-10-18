@echo off
rem USB ile Android telefondan baglanti (adb reverse).
rem Telefondaki "localhost:3080" adresi USB kablosu uzerinden bu bilgisayardaki sunucuya yonlendirilir.
rem localhost guvenli baglam sayildigi icin H.264 goruntu de calisir; Wi-Fi gerekmez.
rem Metinler konsolda bozulmasin diye ASCII yazildi (i, s, g, o, u, c).
setlocal
cd /d "%~dp0"

rem Sunucunun varsayilan portu (server.js). Ortam degiskeni okunmaz: komut satirina dogrulanmamis metin girmesin.
set "PORT_NO=3080"

echo ============================================================
echo  USB ile baglanti (Android)
echo ============================================================
echo.

rem ---------- 1. adb bul ya da indir ----------
set "ADB=%~dp0tools\platform-tools\adb.exe"
if exist "%ADB%" goto :adb_hazir
where adb >nul 2>nul
if errorlevel 1 goto :indir
set "ADB=adb"
goto :adb_hazir

:indir
echo Android platform-tools (adb) bulunamadi.
echo Google'in resmi adresinden indirilecek (yaklasik 10 MB):
echo   https://dl.google.com/android/repository/platform-tools-latest-windows.zip
echo Kurulum yapilmaz; sadece bu klasordeki tools\platform-tools altina acilir.
echo.
choice /c EH /m "Indirilsin mi? (E = Evet, H = Hayir)"
if errorlevel 2 (
  echo Iptal edildi.
  pause
  exit /b 1
)
set "ZIP=%TEMP%\platform-tools-latest-windows.zip"
set "HEDEF=%~dp0tools"
echo Indiriliyor...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing -Uri 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip' -OutFile $env:ZIP; Expand-Archive -LiteralPath $env:ZIP -DestinationPath $env:HEDEF -Force; Remove-Item -LiteralPath $env:ZIP -Force"
if not exist "%ADB%" (
  echo.
  echo Indirme ya da acma basarisiz oldu. Internet baglantini kontrol et
  echo ya da zip dosyasini elle indirip tools\platform-tools klasorune ac.
  pause
  exit /b 1
)
echo Hazir: tools\platform-tools
echo.

:adb_hazir
"%ADB%" start-server >nul 2>nul

echo ---------- Telefonda yapilacaklar (bir kez) ----------
echo  1. Ayarlar ^> Telefon hakkinda ^> "Yapim numarasi"na 7 kez dokun
echo     (Gelistirici secenekleri acilir. Bazi telefonlarda: Yazilim bilgileri altinda.)
echo  2. Ayarlar ^> Sistem ^> Gelistirici secenekleri ^> "USB hata ayiklama"yi ac
echo  3. Telefonu USB kablosuyla bu bilgisayara bagla
echo  4. Telefonda "USB hata ayiklamaya izin verilsin mi?" sorusuna
echo     "Bu bilgisayara her zaman izin ver" isaretleyip Izin ver de
echo.
echo Telefon bekleniyor... (vazgecmek icin Ctrl+C)
"%ADB%" wait-for-device
if errorlevel 1 goto :hata

"%ADB%" reverse tcp:%PORT_NO% tcp:%PORT_NO%
if errorlevel 1 goto :hata

echo.
echo ============================================================
echo  Baglanti hazir.
echo  Telefonda Chrome'u ac ve su adrese git:
echo.
echo      http://localhost:%PORT_NO%
echo.
echo  - Sunucu bu bilgisayarda acik olmali (baslat.bat).
echo  - Ana ekrana eklemek icin: Chrome menusu ^> "Ana ekrana ekle".
echo  - Not: USB ile gelen baglanti sunucuya "bu bilgisayar" olarak
echo    gorunur (onay penceresi cikmaz). Sadece kendi telefonunu bagla.
echo ============================================================
echo.
echo Isin bitince bu pencerede bir tusa bas: USB yonlendirmesi kaldirilir.
pause >nul
"%ADB%" reverse --remove tcp:%PORT_NO% >nul 2>nul
echo Yonlendirme kaldirildi.
timeout /t 2 >nul
exit /b 0

:hata
echo.
echo Yonlendirme kurulamadi. Kontrol et:
echo  - Telefonda USB hata ayiklama acik ve bu bilgisayara izin verildi mi?
echo  - Kablo veri aktarimini destekliyor mu? (Bazi kablolar sadece sarj eder.)
echo  - Birden fazla Android cihaz bagliysa digerlerini cikar.
pause
exit /b 1
