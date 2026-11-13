@echo off
cd /d "%~dp0"
title Marhba - my food ordering app
color 0F
echo.
echo   ====================================================
echo      MARHBA - food ordering app
echo   ====================================================
echo.

where node >nul 2>nul
if errorlevel 1 goto NONODE

node -e "const v=process.versions.node.split('.').map(Number); process.exit((v[0]>22||(v[0]===22&&v[1]>=5))?0:1)"
if errorlevel 1 goto OLDNODE

set PORT=3005
echo   Starting the app...
echo   Your browser will open by itself in a few seconds.
echo.
echo   Addresses:
echo      Customer    http://localhost:3005
echo      Restaurant  http://localhost:3005/restaurant.html
echo      Admin       http://localhost:3005/admin.html
echo.
echo   Test logins:
echo      client@demo.ma / client1234
echo      resto1@demo.ma / resto1234
echo      admin@demo.ma  / admin1234
echo.
echo   To open it on your PHONE: look for the address starting with
echo   192.168 below, and type it in your phone's browser (same wifi).
echo   To open it OUTSIDE your wifi (4G/5G mobile): double-click START-TUNNEL.bat
echo.
echo   KEEP THIS BLACK WINDOW OPEN. Closing it stops the app.
echo   ====================================================
echo.

start /min cmd /c "timeout /t 4 /nobreak >nul & start http://localhost:3005"
node server\src\index.js
echo.
echo   The app stopped. Press a key to close.
pause >nul
exit /b

:NONODE
echo   Node.js is not installed on this computer yet.
echo   The app needs it to run. It is free and safe.
echo.
echo   I am opening the download page now.
echo   Download the Windows Installer, run it, click Next
echo   until it finishes, then double-click this file again.
echo.
start https://nodejs.org/en/download
pause
exit /b

:OLDNODE
echo   Node.js is installed but too old for this app.
node -v
echo.
echo   Version 22.5 or newer is needed.
echo   I am opening the download page. Install the new version,
echo   then double-click this file again.
echo.
start https://nodejs.org/en/download
pause
exit /b



