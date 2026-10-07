@echo off
title Burrow host
cd /d "%~dp0"

rem Start Ollama if it isn't already running
curl -s -o nul -m 2 http://127.0.0.1:11434/api/version && goto run
echo Starting Ollama...
if exist "%LOCALAPPDATA%\Programs\Ollama\ollama app.exe" (
  start "" "%LOCALAPPDATA%\Programs\Ollama\ollama app.exe"
) else (
  start "Ollama" /min ollama serve
)
for /l %%i in (1,1,30) do (
  timeout /t 1 /nobreak >nul
  curl -s -o nul -m 2 http://127.0.0.1:11434/api/version && goto run
)
echo Ollama did not start within 30 seconds. Is it installed? https://ollama.com/download
pause
exit /b 1

:run
echo Ollama is running.
node host/host.js https://burrow-uu7e.onrender.com
pause
