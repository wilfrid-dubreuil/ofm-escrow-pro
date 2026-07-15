@echo off
chcp 65001 >nul 2>&1
setlocal
cd /d "%~dp0"

set "PORT=3001"

echo ========================================
echo   OFM Escrow Pro - Demarrage
echo ========================================
echo.

netstat -ano 2>nul | findstr ":%PORT% " | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo [OFM] Le port %PORT% est deja utilise.
  echo [OFM] Le serveur semble deja demarre.
  echo.
  pause
  exit /b 0
)

where npm >nul 2>&1
if errorlevel 1 (
  echo [OFM] ERREUR: npm introuvable dans le PATH.
  echo [OFM] Installez Node.js depuis https://nodejs.org
  echo.
  pause
  exit /b 1
)

echo [OFM] Installation des dependances backend...
call npm run install:backend
if errorlevel 1 (
  echo [OFM] Echec installation des dependances.
  echo.
  pause
  exit /b 1
)

echo.
echo [OFM] Demarrage du serveur sur 0.0.0.0:%PORT%...
echo   - Local  : https://localhost:%PORT%
echo.
call npm run start

echo.
echo [OFM] Le serveur s'est arrete.
echo.
pause

