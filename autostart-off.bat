@echo off
title Burrow: stop starting at boot
net session >NUL 2>&1 || (powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs" & exit /b)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0host\autostart.ps1" uninstall
pause
