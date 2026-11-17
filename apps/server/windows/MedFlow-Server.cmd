@echo off
rem Runs MedFlow Local and starts it again if it ever stops (double-click to watch it in a window).
cd /d "%~dp0"
set NODE=node
if exist "%~dp0node\node.exe" set NODE="%~dp0node\node.exe"
:loop
%NODE% medflow-server.mjs
rem Exit code 3: MedFlow is already running on this PC, so do not start a second copy.
if %errorlevel%==3 exit /b 3
timeout /t 5 /nobreak >nul
goto loop
