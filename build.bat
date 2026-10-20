@echo off
title pxpipe — build

echo.
echo  ===================================
echo   Building pxpipe
echo  ===================================
echo.

:: Check dependencies
if not exist "node_modules" (
    echo [*] Installing dependencies...
    npm install --legacy-peer-deps
    if errorlevel 1 (
        echo [ERROR] Failed to install dependencies.
        pause
        exit /b 1
    )
    echo.
)

echo [*] Building project...
node scripts/build.mjs
if errorlevel 1 (
    echo.
    echo [ERROR] Build failed.
    pause
    exit /b 1
)

echo.
echo [OK] Build completed successfully.
echo     Run: start.bat
echo.
pause
