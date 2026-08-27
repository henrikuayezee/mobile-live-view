@echo off
REM Runs the server and keeps this window open if it exits with an error.
REM Without the pause, a startup crash closes the window instantly and the
REM user sees nothing at all. Launched by launch.bat.

cd /d "%~dp0"
title Mobile Live View Server
node src/server/index.js

if errorlevel 1 (
  echo.
  echo ----------------------------------------------------
  echo The server stopped with an error. Details are above.
  echo ----------------------------------------------------
  echo.
  pause
)
