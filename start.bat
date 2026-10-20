@echo off
chcp 65001 >nul
title PixelFront

:: --- Settings ---
:: GO subscription provides API keys automatically; the proxy forwards them
:: from OpenCode requests. Leave keys empty for GO.

:: --- API keys (empty for GO) ---
:: set ANTHROPIC_API_KEY=
:: set OPENAI_API_KEY=
:: set DEEPSEEK_API_KEY=
:: set MIMO_API_KEY=

:: --- Port (must match baseURL in opencode.jsonc) ---
set PORT=47821
set HOST=127.0.0.1

if "%PORT%"=="" set PORT=47821
if "%HOST%"=="" set HOST=127.0.0.1

if not exist "dist\node.js" (
    echo [!] Build not found, building...
    node scripts/build.mjs
    if errorlevel 1 (
        echo.
        echo [ERROR] Install dependencies:
        echo   npm install --legacy-peer-deps
        echo.
        pause
        exit /b 1
    )
)

:: Kill previously running instances on this port.
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /c:":%PORT%" ^| findstr /c:"LISTENING"') do (
    taskkill /f /pid %%p >nul 2>&1
)
timeout /t 1 /nobreak >nul

:: Open the dashboard, then start the proxy (the proxy prints its own banner).
start "" http://127.0.0.1:%PORT%/

node dist/node.js
set EXITCODE=%errorlevel%
echo.
echo [PixelFront] proxy stopped (exit code %EXITCODE%).
echo     Press any key to close this window.
pause >nul
