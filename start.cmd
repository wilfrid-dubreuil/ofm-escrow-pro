@echo off
setlocal
cd /d "%~dp0"

echo [OFM] Installation des dependances backend...
call npm run install:backend
if errorlevel 1 (
  echo [OFM] Echec installation des dependances.
  pause
  exit /b 1
)

echo [OFM] Demarrage du serveur...
call npm run start
if errorlevel 1 (
  echo [OFM] Echec demarrage serveur.
  pause
  exit /b 1
)

endlocal
