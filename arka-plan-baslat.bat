@echo off
cd /d "%~dp0"

rem Sunucuyu konsol penceresi ve tepsi simgesi olmadan arka planda baslatir (yalnizca Windows'un imzali powershell.exe'si;
rem Akilli Uygulama Denetimi'ne takilmaz). Zaten calisiyorsa ikinci kopya acilmaz, yalnizca tarayicida arayuz acilir.
rem Gunluk: data\sunucu.log   Durdurmak icin: arka-plan-durdur.bat
rem (Bu dosya bilerek ASCII: cmd, UTF-8 karakterli toplu is dosyalarini kod sayfasi degisince yanlis okuyabiliyor.)

if not exist "runtime\node.exe" (
  where node >nul 2>nul || goto :nonode
  if not exist node_modules call npm install
)

start "" "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0tools\arka-plan.ps1" -Islem baslat
exit /b 0

:nonode
echo Node.js bulunamadi. https://nodejs.org adresinden kurun
echo ya da GitHub Releases'ten tasinabilir paketi indirin.
pause
exit /b 1
