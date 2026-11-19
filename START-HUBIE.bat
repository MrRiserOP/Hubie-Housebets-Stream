@echo off
REM ============================================================
REM  START-HUBIE.bat  -  double-click to start Hubie on Windows
REM ============================================================
setlocal EnableExtensions
title Hubie - AI Streamer
cd /d "%~dp0"

echo.
echo   =========================================
echo     HUBIE  -  starting your AI streamer
echo   =========================================
echo.

REM ---- 1. Is Node.js installed? ---------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo   [!] Node.js is not installed on this computer.
  echo.
  echo       Hubie needs Node.js version 22 or newer. It is free.
  echo       1. A download page will open in your browser now.
  echo       2. Download the "LTS" Windows Installer ^(.msi^) and run it ^(click Next until Finish^).
  echo       3. Close this window and double-click START-HUBIE.bat again.
  echo.
  start "" "https://nodejs.org/en/download"
  pause
  exit /b 1
)

REM ---- 2. Is it new enough? (22.13+) ----------------------------
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"
if errorlevel 1 (
  echo   [!] Your Node.js is too old. Hubie needs version 22.13 or newer. You have:
  node -v
  echo       Install the current LTS from the page that opens now, then run this file again.
  start "" "https://nodejs.org/en/download"
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node -v') do echo   [ok] Node.js %%v found

REM ---- 3. Is port 8787 free? ------------------------------------
netstat -ano | findstr /R /C:":8787 .*LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo   [!] Something is already using port 8787 - Hubie may already be running.
  echo       Opening the Control Center. If it does not load, close the other Hubie window and try again.
  start "" "http://127.0.0.1:8787/setup"
  pause
  exit /b 1
)

REM ---- 4. Install project dependencies (first run only) ---------
if not exist "node_modules\" (
  echo   [..] Installing Hubie's components. First time only - this can take a few minutes...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo   [!] Installing components failed. Check your internet connection and try again.
    echo       If it keeps failing, send the text above to your technical contact.
    pause
    exit /b 1
  )
)
echo   [ok] Components installed

REM ---- 4b. Game browser (Hubie uses Chrome or Edge if installed, else downloads its own once) ----
if not exist "%LOCALAPPDATA%\ms-playwright\" (
  if not exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
    if not exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (
      echo   [..] Downloading the game browser - first time only...
      call npx --yes playwright install chromium
    )
  )
)

REM ---- 5. Start Hubie and open the setup page -------------------
echo   [..] Starting Hubie. Your browser will open the HUBIE CONTROL CENTER in a few seconds.
echo        KEEP THIS WINDOW OPEN while Hubie is running. Close it to stop Hubie.
echo        Control Center: http://127.0.0.1:8787/setup    Overlay for OBS: http://127.0.0.1:8787/overlay
echo.
start "" /min cmd /c "timeout /t 8 /nobreak >nul && start http://127.0.0.1:8787/setup"
call npm start
if errorlevel 1 (
  echo.
  echo   [!] Hubie stopped with an error. Scroll up to see what happened.
  pause
  exit /b 1
)
endlocal
