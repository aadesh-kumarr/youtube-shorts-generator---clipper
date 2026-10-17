@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Clipper.AI - Launcher
set "PROJECT_DIR=%~dp0"

echo ============================================================
echo   Starting Clipper.AI locally
echo ============================================================
echo.

if not exist ".env.local" (
  echo [ERROR] .env.local is missing.
  echo Run setup-local.bat first, then add your OpenAI API key.
  pause
  exit /b 1
)

findstr /C:"sk-your-key-here" ".env.local" >nul
if not errorlevel 1 (
  echo [ERROR] Replace sk-your-key-here in .env.local with your OpenAI API key.
  start "" notepad.exe ".env.local"
  pause
  exit /b 1
)

if not exist "node_modules\.bin\next.cmd" (
  echo [ERROR] Node dependencies are missing. Run setup-local.bat first.
  pause
  exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo [ERROR] Python environment is missing. Run setup-local.bat first.
  pause
  exit /b 1
)

if not exist "whisper-service\models\face_detection_yunet_2023mar.onnx" (
  echo [ERROR] Local AI models are missing. Run setup-local.bat first.
  pause
  exit /b 1
)

echo [1/2] Opening the Whisper and face-tracking service...
start "Clipper.AI - Whisper Service" powershell.exe -NoExit -ExecutionPolicy Bypass -File "%PROJECT_DIR%start-whisper.ps1"

timeout /t 2 /nobreak >nul

echo [2/2] Opening the Next.js dashboard...
start "Clipper.AI - Web Dashboard" cmd.exe /k "cd /d ""%PROJECT_DIR%"" ^&^& npm run dev"

echo.
echo Waiting for the dashboard to become ready...
timeout /t 6 /nobreak >nul
start "" "http://localhost:3010"

echo.
echo Clipper.AI was started in two terminal windows.
echo To stop it, press Ctrl+C in both windows or close them.
timeout /t 4 /nobreak >nul
exit /b 0
