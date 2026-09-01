@echo off
title Script2Video Studio Launcher
cd /d "%~dp0"

where python >nul 2>nul
if not %errorlevel%==0 (
    echo Python was not found. Install it once from python.org, then run this file again.
    pause
    exit /b
)

echo Starting the studio helper...
where pythonw >nul 2>nul
if %errorlevel%==0 (
    start "" pythonw fetcher.py
) else (
    start /min "" python fetcher.py
)

timeout /t 2 /nobreak >nul
start "" "%~dp0index.html"
echo.
echo   Studio is running:
echo     - Helper: active in background (full-web search + reliable voices)
echo     - App:    opened in your browser
echo.

rem Optional gameplay support (YouTube): install quietly in background,
rem never blocking the app. The helper picks it up automatically.
python -c "import yt_dlp, imageio_ffmpeg" >nul 2>nul
if not %errorlevel%==0 (
    echo   First-run setup: gameplay search support is downloading in
    echo   the background. It will be active the next time you generate.
    start /b "" cmd /c "python -m pip install --quiet --disable-pip-version-check --no-input yt-dlp imageio-ffmpeg >nul 2>nul"
)

echo.
echo   You can close this window now. To stop everything,
echo   close the small Python icon in the system tray area
echo   or run Task Manager and end the "python" task.
timeout /t 5 /nobreak >nul
