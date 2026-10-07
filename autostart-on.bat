@echo off
title Burrow: start at boot
rem Makes Ollama and the Burrow host start when Windows boots, even before you sign in.
net session >NUL 2>&1 || (powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs" & exit /b)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0host\autostart.ps1" install
pause
