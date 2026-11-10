@echo off
title Hentikan GrabVideo Engine
echo Menghentikan GrabVideo Engine pada port 54321...

for /f "tokens=5" %%a in ('netstat -aon ^| findstr :54321') do (
    taskkill /F /PID %%a >nul 2>&1
)

echo Engine GrabVideo telah dihentikan.
timeout /t 2 >nul
exit
