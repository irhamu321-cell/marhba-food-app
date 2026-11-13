@echo off
cd /d "%~dp0"
title Marhba - install the new demo data
color 0F
echo.
echo   ====================================================
echo      INSTALL THE NEW DEMO DATA
echo   ====================================================
echo.
echo   This version adds 10 new demo restaurants with full
echo   menus, the two service types (immediate / pre-order),
echo   and cuisine tags.
echo.
echo   Your current data\app.db was made by an older version,
echo   so it does not contain them.
echo.
echo   This will:
echo      1. Rename  data\app.db       to  data\app-OLD.db
echo      2. Rename  data\app-neuf.db  to  data\app.db
echo.
echo   Nothing is deleted. Your old file stays as app-OLD.db.
echo   Close the black app window first if it is still open.
echo.
pause

if not exist "data\app-neuf.db" goto NOFRESH

if exist "data\app.db" (
  if exist "data\app-OLD.db" del "data\app-OLD.db"
  ren "data\app.db" "app-OLD.db"
)
if exist "data\app.db-wal" del "data\app.db-wal"
if exist "data\app.db-shm" del "data\app.db-shm"
ren "data\app-neuf.db" "app.db"

echo.
echo   Done. Now double-click START-APP.bat
echo.
pause
exit /b

:NOFRESH
echo.
echo   data\app-neuf.db was not found - nothing to do.
echo   Either you already ran this, or the file is missing.
echo.
pause
exit /b
