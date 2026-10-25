@echo off
title Albatross: set up Jarvis
rem Lets the Albatross website start Jarvis on your desktop (not in the hidden background session).
rem Jarvis sits next to the Burrow folder (this file is in <drive>\Burrow\app)
for %%I in ("%~dp0..\..\Jarvis\dist\Jarvis\Jarvis.exe") do set "JARVIS_EXE=%%~fI"
schtasks /Create /TN "Albatross Jarvis" /TR "\"%JARVIS_EXE%\"" /SC ONCE /ST 00:00 /SD 01/01/2030 /IT /F
pause
