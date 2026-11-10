@echo off
title GrabVideo Engine Daemon
cd /d "%~dp0"

:loop
echo [%date% %time%] Menjalankan GrabVideo Engine... >> engine.log
node server.js >> engine.log 2>&1
echo [%date% %time%] Engine terhenti, me-restart dalam 1 detik... >> engine.log
timeout /t 1 /nobreak >nul
goto loop
