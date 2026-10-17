@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Clipper.AI - First-time setup

echo ============================================================
echo   Clipper.AI - First-time local setup
echo ============================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found. Install Node.js 20.19 or newer.
  echo         https://nodejs.org/
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm was not found. Reinstall Node.js with npm enabled.
  pause
  exit /b 1
)

set "PYTHON_CMD=python"
python --version >nul 2>nul
if errorlevel 1 (
  py -3 --version >nul 2>nul
  if errorlevel 1 (
    echo [ERROR] Python 3.10 or 3.11 was not found.
    echo         https://www.python.org/downloads/
    pause
    exit /b 1
  )
  set "PYTHON_CMD=py -3"
)

if not exist ".env.local" (
  copy /Y ".env.example" ".env.local" >nul
  echo [OK] Created .env.local from .env.example.
) else (
  echo [OK] Existing .env.local preserved.
)

echo.
echo [1/4] Installing Node.js dependencies...
call npm install
if errorlevel 1 goto :failed

echo.
echo [2/4] Creating the Python virtual environment...
if not exist ".venv\Scripts\python.exe" (
  %PYTHON_CMD% -m venv .venv
  if errorlevel 1 goto :failed
) else (
  echo [OK] .venv already exists.
)

echo.
echo [3/4] Installing Python dependencies...
".venv\Scripts\python.exe" -m pip install --upgrade pip
if errorlevel 1 goto :failed
".venv\Scripts\python.exe" -m pip install -r "whisper-service\requirements.txt"
if errorlevel 1 goto :failed

echo.
echo [4/4] Downloading Whisper and YuNet models...
echo       This download is several gigabytes and can take a while.
".venv\Scripts\python.exe" "whisper-service\download_models.py"
if errorlevel 1 goto :failed

echo.
echo ============================================================
echo   Setup complete
echo ============================================================
echo.
echo Add your real OPENAI_API_KEY to .env.local, then double-click:
echo   start-local.bat
echo.
start "" notepad.exe ".env.local"
pause
exit /b 0

:failed
echo.
echo [ERROR] Setup stopped because a command failed.
echo Fix the error shown above, then run setup-local.bat again.
pause
exit /b 1
