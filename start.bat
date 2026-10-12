@echo off
rem Starts Higgsfield Studio: the back end (port 4000) and the front end (port 5173), then opens the browser.
rem Double-click this file. To stop the app, close the two black windows it opens.
setlocal
cd /d "%~dp0"
title Higgsfield Studio launcher

if not exist "backend\node_modules" (
  echo First run: installing what the app needs. This takes a few minutes...
  call npm run install:all
  if errorlevel 1 (
    echo.
    echo Installing failed. Is Node.js installed? Get it from https://nodejs.org and try again.
    pause
    exit /b 1
  )
)

netstat -ano | findstr /R /C:":4000 .*LISTENING" >nul
if %errorlevel%==0 (
  echo Back end is already running on port 4000, leaving it alone.
) else (
  echo Starting the back end...
  start "Higgsfield Studio - back end (leave open)" cmd /k "cd /d %~dp0 && npm run dev:backend"
)

netstat -ano | findstr /R /C:":5173 .*LISTENING" >nul
if %errorlevel%==0 (
  echo Front end is already running on port 5173, leaving it alone.
) else (
  echo Starting the front end...
  start "Higgsfield Studio - front end (leave open)" cmd /k "cd /d %~dp0 && npm run dev:frontend"
)

echo Opening the app in your browser in a few seconds...
timeout /t 8 /nobreak >nul
start "" http://localhost:5173
endlocal