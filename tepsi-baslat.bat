@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem Tepsi simgesiyle başlatır: sunucu gizli pencerede çalışır, simgeye sağ tıklayınca menü açılır.
rem (Konsol penceresinde çalıştırmak için baslat.bat kullanılabilir.)

if not exist "runtime\node.exe" (
  where node >nul 2>nul || goto :nonode
  if not exist node_modules call npm install
)

rem Tepsi.exe yoksa ya da Tepsi.cs daha yeniyse Windows'un kendi C# derleyicisiyle derle.
set "DERLE="
if not exist "helper\Tepsi.exe" set "DERLE=1"
if not defined DERLE (
  for /f "delims=" %%F in ('dir /b /o:d "helper\Tepsi.cs" "helper\Tepsi.exe"') do set "YENI=%%F"
)
if not defined DERLE if /i "%YENI%"=="Tepsi.cs" set "DERLE=1"
if defined DERLE (
  echo Tepsi derleniyor...
  "%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /optimize /target:winexe /out:helper\Tepsi.exe /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Web.Extensions.dll helper\Tepsi.cs || goto :hata
)

start "" "helper\Tepsi.exe"
exit /b

:nonode
echo Node.js bulunamadi. https://nodejs.org adresinden kurun
echo ya da GitHub Releases'ten tasinabilir paketi indirin.
pause
exit /b 1

:hata
echo Tepsi derlenemedi.
pause
exit /b 1
