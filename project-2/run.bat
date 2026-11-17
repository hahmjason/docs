@echo off
REM UGCS vehicle-mounted GCS server (Windows) - no internet required
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
  echo [UGCS] Python 3.10+ is required. Install Python and run again.
  pause
  exit /b 1
)
set PYTHONIOENCODING=utf-8
chcp 65001 >nul
python run.py %*
pause
