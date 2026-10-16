@echo off
chcp 65001 >nul
setlocal
set "TS=C:\Program Files\Tailscale\tailscale.exe"
echo ============================================================
echo  Her yerden erisim: Tailscale kurulumu
echo ============================================================
echo.

if exist "%TS%" goto :login
echo [1/3] Tailscale indiriliyor ve kuruluyor (yonetici izni istenecek)...
winget install --id=Tailscale.Tailscale -e --accept-package-agreements --accept-source-agreements
if not exist "%TS%" (
  echo Kurulum basarisiz oldu. https://tailscale.com/download adresinden elle kurabilirsin.
  pause
  exit /b 1
)

:login
echo.
echo [2/3] Tailscale hesabina giris (tarayici acilabilir)...
echo       Google, Microsoft veya GitHub hesabinla giris yapabilirsin.
"%TS%" up
if errorlevel 1 (
  echo Giris tamamlanamadi. Gorev cubugundaki Tailscale simgesinden giris yapip bu dosyayi tekrar calistir.
  pause
  exit /b 1
)

echo.
echo [3/3] HTTPS adresi aciliyor (yalnizca senin Tailscale cihazlarin erisebilir)...
echo       Ilk seferde HTTPS ozelligini acman icin bir baglanti gosterilebilir:
echo       baglantiyi tarayicida acip "Enable" de, sonra burada bekle.
"%TS%" serve --bg 3000
echo.
"%TS%" serve status
echo.
echo ============================================================
echo  Bitti! Simdi:
echo   1. Telefonuna "Tailscale" uygulamasini kur, ayni hesapla giris yap.
echo   2. baslat.bat ile sunucuyu ac; "Her yerden" satirindaki adresi
echo      telefonda ac.
echo  Not: Ilk girisi evdeyken yapip "Bu cihazi hatirla"yi isaretlersen
echo  disarida sifre bile sorulmaz.
echo ============================================================
pause
