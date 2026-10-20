@echo off
title PixelFront — token-saving proxy
echo.
echo  ============================================
echo   PixelFront
echo  ============================================
echo.

:: Config
:: GO subscription provides API keys automatically.
:: Proxy forwards them from OpenCode requests.
:: Leave keys empty for GO subscription.

:: --- API keys (leave empty for GO) ---
:: set ANTHROPIC_API_KEY=
:: set OPENAI_API_KEY=
:: set DEEPSEEK_API_KEY=
:: set MIMO_API_KEY=

:: --- Port (must match baseURL in opencode.jsonc) ---
set PORT=47821
set HOST=127.0.0.1

if "%PORT%"=="" set PORT=47821
if "%HOST%"=="" set HOST=127.0.0.1

echo [*] Port: %PORT%
echo [*] Dashboard: http://127.0.0.1:%PORT%/
echo.
echo [*] Supported models:
echo     - DeepSeek V4 Pro / Flash
echo     - MiMo V2.5 / V2.5 Pro
echo     - Claude (if key provided)
echo     - GPT (if key provided)
echo.
echo [*] Open dashboard: http://127.0.0.1:%PORT%/
echo [*] Ctrl+C to stop
echo.

if not exist "dist\node.js" (
    echo [!] Build not found. Building...
    echo.
    node scripts/build.mjs
    if errorlevel 1 (
        echo.
        echo [ERROR] Install dependencies:
        echo   npm install --legacy-peer-deps
        echo.
        pause
        exit /b 1
    )
    echo.
)

:: Kill any previously running pxpipe on this port so we always start fresh.
echo [*] Stopping old pxpipe instances...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /c:":%PORT%" ^| findstr /c:"LISTENING"') do (
    echo     killing PID %%p
    taskkill /f /pid %%p >nul 2>&1
)
timeout /t 1 /nobreak >nul

:: Open the dashboard in the default browser, then start the proxy.
start "" http://127.0.0.1:%PORT%/
node dist/node.js
if errorlevel 1 (
    echo.
    echo [ERROR] Proxy exited with error.
    pause
)
