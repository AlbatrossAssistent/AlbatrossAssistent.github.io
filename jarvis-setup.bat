@echo off
title Albatross: set up Jarvis
rem Lets the Albatross website start Jarvis on your desktop (not in the hidden background session).
schtasks /Create /TN "Albatross Jarvis" /TR "\"D:\Jarvis\dist\Jarvis\Jarvis.exe\"" /SC ONCE /ST 00:00 /SD 01/01/2030 /IT /F
pause
