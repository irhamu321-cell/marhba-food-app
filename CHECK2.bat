@echo off
cd /d "%~dp0"
title Marhba - check 2
color 0F
set LOG=check-log.txt
echo. > "%LOG%"

echo   ====================================================
echo      CHECK 2 - why the browser cannot reach the app
echo   ====================================================
echo.
echo   Please wait about 30 seconds. Do not close this window.
echo.

echo ===== IS THE SERVER STILL RUNNING ===== >> "%LOG%"
tasklist /fi "imagename eq node.exe" >> "%LOG%" 2>&1
netstat -ano | findstr ":3000" >> "%LOG%" 2>&1
echo (no LISTENING line above = server is NOT running) >> "%LOG%"

echo. >> "%LOG%"
echo ===== WINDOWS PROXY SETTINGS ===== >> "%LOG%"
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyEnable >> "%LOG%" 2>&1
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyServer >> "%LOG%" 2>&1
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyOverride >> "%LOG%" 2>&1
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v AutoConfigURL >> "%LOG%" 2>&1

echo. >> "%LOG%"
echo ===== NETWORK ADAPTERS / VPN ===== >> "%LOG%"
ipconfig | findstr /i "adapter IPv4" >> "%LOG%" 2>&1

echo. >> "%LOG%"
echo ===== START SERVER IN A SEPARATE WINDOW ===== >> "%LOG%"
start "Marhba server" cmd /c "node server\src\index.js > server-log.txt 2>&1"
timeout /t 10 /nobreak >nul
echo server started in its own window >> "%LOG%"

echo. >> "%LOG%"
echo ===== CURL localhost ===== >> "%LOG%"
curl -s -m 8 -v http://localhost:3000/api/health >> "%LOG%" 2>&1

echo. >> "%LOG%"
echo ===== CURL 127.0.0.1 ===== >> "%LOG%"
curl -s -m 8 http://127.0.0.1:3000/api/health >> "%LOG%" 2>&1

echo. >> "%LOG%"
echo ===== CURL 192.168.1.11 ===== >> "%LOG%"
curl -s -m 8 http://192.168.1.11:3000/api/health >> "%LOG%" 2>&1

echo. >> "%LOG%"
echo ===== PORT 3000 NOW ===== >> "%LOG%"
netstat -ano | findstr ":3000" >> "%LOG%" 2>&1

echo. >> "%LOG%"
echo ===== FIREWALL RULES FOR NODE ===== >> "%LOG%"
netsh advfirewall firewall show rule name=all | findstr /i "node" >> "%LOG%" 2>&1
echo (nothing above = no firewall rule for node yet) >> "%LOG%"

echo   Done.
echo.
echo   TWO files are now in this folder:
echo      check-log.txt    and    server-log.txt
echo.
echo   Go back to Claude and say "done 2".
echo.
pause
exit /b
