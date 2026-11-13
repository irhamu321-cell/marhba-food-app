@echo off
cd /d "%~dp0"
title Marhba - diagnose
color 0F
set LOG=diagnose-log.txt

echo. > "%LOG%"
echo   ====================================================
echo      CHECKING WHY THE APP WILL NOT START
echo   ====================================================
echo.
echo   Please wait about 20 seconds. Do not close this window.
echo.

echo ===== DATE ===== >> "%LOG%"
date /t >> "%LOG%" 2>&1
time /t >> "%LOG%" 2>&1

echo. >> "%LOG%"
echo ===== NODE ===== >> "%LOG%"
where node >> "%LOG%" 2>&1
node -v >> "%LOG%" 2>&1

echo. >> "%LOG%"
echo ===== FREE DISK SPACE ===== >> "%LOG%"
dir /-c "%~dp0" | findstr /i "bytes free" >> "%LOG%" 2>&1

echo. >> "%LOG%"
echo ===== FILES ===== >> "%LOG%"
dir /b >> "%LOG%" 2>&1
echo --- data --- >> "%LOG%"
dir /b data >> "%LOG%" 2>&1
echo --- server\src --- >> "%LOG%"
dir /b server\src >> "%LOG%" 2>&1

echo. >> "%LOG%"
echo ===== IS PORT 3000 ALREADY TAKEN ===== >> "%LOG%"
netstat -ano | findstr ":3000" >> "%LOG%" 2>&1
echo (nothing above = port is free) >> "%LOG%"

echo. >> "%LOG%"
echo ===== NODE ALREADY RUNNING ===== >> "%LOG%"
tasklist /fi "imagename eq node.exe" >> "%LOG%" 2>&1

echo. >> "%LOG%"
echo ===== STARTING THE SERVER (15 seconds) ===== >> "%LOG%"
start /b "" cmd /c "node server\src\index.js >> "%LOG%" 2>&1"
timeout /t 15 /nobreak >nul

echo. >> "%LOG%"
echo ===== CAN WE REACH IT ===== >> "%LOG%"
curl -s -m 5 http://localhost:3000/api/health >> "%LOG%" 2>&1
echo. >> "%LOG%"

echo   Done.
echo.
echo   A file called diagnose-log.txt is now in this folder.
echo   Go back to Claude and just say "done" - I will read it.
echo.
pause
exit /b
