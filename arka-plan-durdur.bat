@echo off
cd /d "%~dp0"

rem arka-plan-baslat.bat ile baslatilan sunucuyu durdurur: yalnizca data\arka-plan.pid dosyasindaki kendi bekci ve
rem node surecleri (agaciyla). Tepsi ya da baslat.bat ile calisan sunucuya dokunulmaz.

"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0tools\arka-plan.ps1" -Islem durdur
set "KOD=%ERRORLEVEL%"
timeout /t 4 >nul 2>nul
exit /b %KOD%
