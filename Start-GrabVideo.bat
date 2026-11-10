@echo off
title GrabVideo Pro - Windows Download Manager
echo ========================================================
echo    GrabVideo PRO - Windows Video Grabber & Manager
echo ========================================================
echo.

cd /d "%~dp0app"

echo [1/2] Menjalankan Background Engine GrabVideo...
start "GrabVideo Engine" /min node server.js

echo [2/2] Membuka Antarmuka Desktop...
timeout /t 2 /nobreak >nul

if exist "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" (
    start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --app=http://127.0.0.1:54321 --window-size=1200,820
) else if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" (
    start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --app=http://127.0.0.1:54321 --window-size=1200,820
) else (
    start http://127.0.0.1:54321
)

echo.
echo Aplikasi GrabVideo berhasil dijalankan!
echo Silakan gunakan jendela aplikasi yang terbuka.
echo Untuk menutup engine, tutup jendela 'GrabVideo Engine' di taskbar.
echo.
timeout /t 3 >nul
exit
