@echo off
chcp 65001 >nul
echo ============================================================
echo  Sanal ekran surucusu kurulumu (Virtual Display Driver)
echo  Kaynak: github.com/VirtualDrivers/Virtual-Display-Driver
echo  Acik kaynak, imzali surucu. Yonetici izni istenecek.
echo ============================================================
echo.
echo  NOT: Ekran karti surucusunu guncellemeden once bu sanal
echo  ekran surucusunu Aygit Yoneticisi'nden devre disi birakin.
echo.
pause
winget install --id=VirtualDrivers.Virtual-Display-Driver -e --accept-package-agreements --accept-source-agreements
echo.
echo Kurulum bitti. Sunucuyu (baslat.bat) yeniden baslatin.
pause
