@echo off
title PixelFront — прокси экономии токенов

:: --- Настройки ---
:: Подписка GO подставляет ключи автоматически; прокси прокидывает их
:: из запросов OpenCode. Оставьте ключи пустыми для GO.

:: --- API-ключи (пусто для GO) ---
:: set ANTHROPIC_API_KEY=
:: set OPENAI_API_KEY=
:: set DEEPSEEK_API_KEY=
:: set MIMO_API_KEY=

:: --- Порт (должен совпадать с baseURL в opencode.jsonc) ---
set PORT=47821
set HOST=127.0.0.1

if "%PORT%"=="" set PORT=47821
if "%HOST%"=="" set HOST=127.0.0.1

if not exist "dist\node.js" (
    echo [!] Сборка не найдена, выполняю сборку...
    node scripts/build.mjs
    if errorlevel 1 (
        echo.
        echo [ОШИБКА] Установите зависимости:
        echo   npm install --legacy-peer-deps
        echo.
        pause
        exit /b 1
    )
)

:: Останавливаю прежние запущенные экземпляры на этом порту.
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /c:":%PORT%" ^| findstr /c:"LISTENING"') do (
    taskkill /f /pid %%p >nul 2>&1
)
timeout /t 1 /nobreak >nul

:: Открываю дашборд в браузере и запускаю прокси (сообщения выводит сам прокси).
start "" http://127.0.0.1:%PORT%/

node dist/node.js
set EXITCODE=%errorlevel%
echo.
echo [PixelFront] прокси остановлен (код выхода %EXITCODE%).
echo     Нажмите любую клавишу, чтобы закрыть окно.
pause >nul
