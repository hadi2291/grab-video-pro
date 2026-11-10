@echo off
title Membuka Browser dengan Ekstensi GrabVideo
echo ========================================================
echo    Membuka Browser dengan Ekstensi GrabVideo Otomatis
echo ========================================================
echo.

set EXTENSION_DIR=%~dp0extension

if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" (
    echo Membuka Google Chrome...
    start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --load-extension="%EXTENSION_DIR%" "http://127.0.0.1:54321"
) else if exist "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" (
    echo Membuka Microsoft Edge...
    start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --load-extension="%EXTENSION_DIR%" "http://127.0.0.1:54321"
) else (
    echo Browser Chrome atau Edge tidak ditemukan di lokasi standar.
    echo Silakan muat folder 'extension' secara manual via chrome://extensions atau edge://extensions
    pause
    exit /b
)

echo Browser berhasil dibuka dengan ekstensi GrabVideo aktif!
timeout /t 2 >nul
exit
