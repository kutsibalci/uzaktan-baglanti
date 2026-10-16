@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem Taşınabilir pakette Node.js runtime klasöründe gelir; yoksa bilgisayardaki Node.js kullanılır.
if exist "runtime\node.exe" (
  set "NODE=%~dp0runtime\node.exe"
) else (
  where node >nul 2>nul || goto :nonode
  set "NODE=node"
  if not exist node_modules call npm install
)

"%NODE%" server.js
pause
exit /b

:nonode
echo Node.js bulunamadi. https://nodejs.org adresinden kurun
echo ya da GitHub Releases'ten tasinabilir paketi indirin.
pause
exit /b 1
