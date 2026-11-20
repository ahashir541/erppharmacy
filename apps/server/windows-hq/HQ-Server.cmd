@echo off
rem Nuskha HQ: runs the HQ server and starts it again if it ever stops (double-click to watch it).
cd /d "%~dp0"
set NODE=node
if exist "%~dp0node\node.exe" set NODE="%~dp0node\node.exe"
:loop
%NODE% medflow-hq.mjs
rem Exit code 3: HQ is already running on this PC.
if %errorlevel%==3 exit /b 3
timeout /t 5 /nobreak >nul
goto loop
