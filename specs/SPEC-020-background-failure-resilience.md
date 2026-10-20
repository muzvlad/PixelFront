# SPEC-020: Устойчивость прокси к фоновым сбоям

| Поле | Значение |
|---|---|
| **Приоритет** | 🔴 Высокий (потеря процесса во время работы) |
| **Категория** | Reliability |
| **Файлы** | `src/node.ts`, `start.bat` |
| **Объём работ** | 20 минут |
| **Breaking change** | Нет |

## Проблема

Во время работы с PixelFront окно терминала неожиданно закрылось. `main().catch`
ловит только стартовый промис; HTTP-хендлер обёрнут в `.catch` (node.ts:1233), но
**фоновые** async-задачи (таймеры, сокеты, fire-and-forget промисы) не защищены.

Node по умолчанию на `unhandledRejection`/`uncaughtException` печатает стек и
**завершает процесс**. Если `start.bat` запущен двойным щелчком (или через ярлык),
окно закрывается вместе с процессом — пользователь видит «терминал крашнулся».

Дополнительно: `start.bat` вызывал `pause` только при `errorlevel 1`; при иных
кодах выхода окно исчезало без возможности прочитать причину.

## Требования

1. Глобальные обработчики `unhandledRejection` и `uncaughtException` регистрируются
   при загрузке `node.ts`: логируют стек и **не** завершают процесс.
2. `start.bat` при любом завершении показывает код выхода и делает `pause`,
   чтобы окно не пропадало.

## Дизайн

```ts
// src/node.ts — перед вызовом main()
process.on('unhandledRejection', (reason) => {
  warn(`unhandled rejection (kept alive): ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
});
process.on('uncaughtException', (err) => {
  error(`uncaught exception (kept alive): ${err.stack ?? err.message}`);
});
```

```bat
:: start.bat
node dist/node.js
set EXITCODE=%errorlevel%
echo [*] Proxy stopped (exit code %EXITCODE%).
pause >nul
```

## Обоснование

Прокси — локальный инструмент (loopback, single-user). Выгоднее сохранить
обслуживание при единичном сбое (дозаписать событие, ответить 500 на запрос),
чем упасть целиком и потерять kill-switch/телеметрию. Per-request ошибки уже
изолированы, поэтому срабатывание глобального хендлера — сигнал о фоновой задаче,
а не о постоянной поломке.

Риск: `uncaughtException` после повреждённого состояния может дать неверное
поведение. Для локального прокси это приемлемо; сообщение в stderr с полным стеком
позволяет диагностировать. Если станет шумно — переключить на fail-fast за флагом.

## Acceptance Criteria

- [x] `unhandledRejection` не роняет процесс, пишет `warn` в stderr.
- [x] `uncaughtException` не роняет процесс, пишет `error` в stderr.
- [x] `start.bat` показывает код выхода и ждёт клавишу.
- [x] `tsc --noEmit` и целевые тесты — зелёные.

## Обратная совместимость

Поведение запросов не меняется; меняется только реакция процесса на фоновые сбои.
