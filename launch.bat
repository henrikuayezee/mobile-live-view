@echo off
REM Mobile Live View - one-click launcher.
REM Starts the server in its own minimized window. The server itself opens
REM the browser once it is genuinely listening, and handles the
REM already-running case, so there is no polling or waiting needed here.

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js is required but was not found.
  echo Install it from https://nodejs.org and then run this again.
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies, this only happens once...
  call npm install
  if errorlevel 1 (
    echo.
    echo npm install failed. See the messages above.
    echo.
    pause
    exit /b 1
  )
)

if not exist "vendor\scrcpy-server-v4.1.jar" (
  echo Downloading the scrcpy server component, this only happens once...
  call npm run fetch-scrcpy-server
  if errorlevel 1 (
    echo.
    echo Could not download the scrcpy server component. Check your connection.
    echo.
    pause
    exit /b 1
  )
)

set AUTO_OPEN_BROWSER=1
REM Runs via server.bat so a startup crash leaves the window open with the
REM error visible, instead of vanishing instantly. Named window so it is
REM findable in the taskbar - closing that window stops the server.
REM Absolute path via %~dp0: a bare "server.bat" is not resolved from the
REM current directory when cmd runs with NoDefaultCurrentDirectoryInExePath
REM set, which fails silently inside a detached window.
start "Mobile Live View Server" /min cmd /c "%~dp0server.bat"
exit /b 0
