@echo off
title GrabVideo Engine - Live Diagnostic Logs
cd /d "%~dp0"

:loop
echo ==================================================================
echo   Memulai GrabVideo Engine (Live Logs)...
echo ==================================================================
node server.js
echo.
echo [PERINGATAN] Engine terhenti, me-restart otomatis dalam 2 detik...
timeout /t 2 /nobreak >nul
goto loop
