@echo off
cd /d "%~dp0"
title Marhba - Public Tunnel (4G/5G Access)
color 0B
echo.
echo   ====================================================
echo      MARHBA - ACCES INTERNET / 4G (HORS DU MEME WIFI)
echo   ====================================================
echo.

if not exist "%~dp0cloudflared.exe" (
  echo   cloudflared.exe est absent, telechargement automatique en cours...
  powershell -NoProfile -Command "Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile '%~dp0cloudflared.exe'"
  echo   Telechargement termine.
  echo.
)

echo   Lancement du tunnel Cloudflare vers http://localhost:3005...
echo   (Attendez quelques secondes pour voir votre lien https://...trycloudflare.com)
echo.
echo   GARDEZ CETTE FENETRE OUVERTE tant que vous testez sur votre telephone.
echo   ====================================================
echo.
"%~dp0cloudflared.exe" tunnel --url http://localhost:3005
pause
