# SPEC-015: Конфигурируемый log-level

| Поле | Значение |
|---|---|
| **Приоритет** | 🟢 Низкий |
| **Категория** | Observability / DX |
| **Файлы** | `src/node.ts` |
| **Связь с аудитом** | общий (audit обзор, раздел 5 — code smell) |
| **Объём работ** | 2-3 часа |
| **Breaking change** | Нет (default = 'info', как сейчас) |

## Проблема

В коде повсеместно используются `console.log` / `console.warn` / `console.error` с разными уровнями значимости:

- `[pxpipe] listening on http://127.0.0.1:47821` — info
- `[pxpipe] /v1/messages → 200 (180ms) ...` — info (высокая частота)
- `[pxpipe] unknown tag(s) in static slab: ...` — warn
- `[pxpipe] FileTracker disabled — cannot open ...` — error
- `[pxpipe] compressed 1234ch → 3img/54321B` — debug (шумное)

Сейчас невозможно:
1. Подавить info при отладке.
2. Изолировать только warnings при production-monitoring.
3. Получить full trace (`debug`) при расследовании.

## Требования

1. Ввести переменную окружения `PXpipe_LOG_LEVEL` с значениями `'debug' | 'info' | 'warn' | 'error'`.
2. Default = `'info'` (поведение как сейчас).
3. Внутренняя функция `log(level, msg)`, заменяющая `console.log/warn/error` в `node.ts`.
4. Не трогать `tracker`-вывод (там собственная категория данных).
5. Не трогать worker build (`src/worker.ts`) — там работает `wrangler tail` с собственным уровнем.

## Дизайн

```ts
// src/node.ts (в начале файла)

const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type LogLevel = keyof typeof LOG_LEVELS;

function currentLogLevel(): LogLevel {
  const v = (process.env.PXpipe_LOG_LEVEL ?? 'info').toLowerCase();
  if (v in LOG_LEVELS) return v as LogLevel;
  console.warn(`[pxpipe] unknown PXpipe_LOG_LEVEL: ${v}, defaulting to 'info'`);
  return 'info';
}

const ACTIVE_LEVEL = currentLogLevel();

/**
 * Level-aware logging. Уровни ниже ACTIVE_LEVEL подавляются.
 *
 * @param level Минимальный уровень для вывода.
 * @param msg Сообщение; помечается префиксом [pxpipe <level>].
 */
function log(level: LogLevel, ...args: unknown[]): void {
  if (LOG_LEVELS[level] < LOG_LEVELS[ACTIVE_LEVEL]) return;
  const fn =
    level === 'error' ? console.error :
    level === 'warn' ? console.warn :
    console.log;
  fn(`[pxpipe ${level}]`, ...args);
}

function debug(msg: string, ...rest: unknown[]): void { log('debug', msg, ...rest); }
function info(msg: string, ...rest: unknown[]): void { log('info', msg, ...rest); }
function warn(msg: string, ...rest: unknown[]): void { log('warn', msg, ...rest); }
function error(msg: string, ...rest: unknown[]): void { log('error', msg, ...rest); }
```

### Примеры замен в `src/node.ts`

```ts
// Было:
console.log(`[pxpipe] listening on http://${displayHost}:${opts.port}`);
console.warn(`[pxpipe] WARNING: bound to ${opts.host} — ...`);
console.error(`[pxpipe] FileTracker disabled — cannot open ${this.filePath}: ${(err as Error).message}`);

// Стало:
info(`listening on http://${displayHost}:${opts.port}`);
warn(`bound to ${opts.host} — the unauthenticated dashboard ...`);
error(`FileTracker disabled — cannot open ${this.filePath}: ${(err as Error).message}`);
```

### Стратегия замены

Поиск по `src/node.ts` всех `console.*` вызовов и ручная категоризация:

| Шаблон | Новый уровень |
|---|---|
| `console.log('[pxpipe] listening...` | info |
| `console.log('[pxpipe] anthropic upstream...` | info |
| `console.log('[pxpipe] PXPIPE_DUMP_DIR set...` | info |
| `console.log('[pxpipe] PXPIPE_DISABLE set...` | info |
| `console.log('[pxpipe] file dump...` | info |
| `console.log('[pxpipe] PNG dump write failed...` | warn |
| `console.warn('[pxpipe] WARNING: ...` | warn |
| `console.warn('[pxpipe] config.models...` | warn |
| `console.warn('[pxpipe warn] unknown tag...` | warn |
| `console.error('[pxpipe] handler error: ...` | error |
| `console.error('[pxpipe] FileTracker disabled...` | error |
| `console.error('[pxpipe] flushed...` (probes) | debug |
| `console.log('  ↳ dumped ${n}...` | debug |

> Бо́льшая часть метрик per-request — debug, чтобы info был только о system lifecycle.

## Acceptance Criteria

- [ ] `PXpipe_LOG_LEVEL=error` выводит ТОЛЬКО errors, info/warn/debug подавлены.
- [ ] `PXpipe_LOG_LEVEL=debug` показывает per-request dump output.
- [ ] Default (`PXpipe_LOG_LEVEL=info`) — поведение **идентично** текущему.
- [ ] Невалидное значение (`PXpipe_LOG_LEVEL=loud`) → warning + fallback на `info`.
- [ ] `Worker`-сборка (`src/worker.ts`) не затронута.

## Тесты

### tests/log-level.test.ts (новый)

```ts
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

describe('log level', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    delete process.env.PXpipe_LOG_LEVEL;
  });

  it('default level = info (debug suppressed, info emitted)', async () => {
    delete process.env.PXpipe_LOG_LEVEL;
    // Re-import or re-evaluate level cache.
    // (Implementation detail: ACTIVE_LEVEL captured at module load.
    //  Need fresh import per test via dynamic import after env change.)
    const mod = await dynamicImportFresh('../src/node.js');
    mod.debug('debug-msg');
    mod.info('info-msg');
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('debug-msg'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('info-msg'));
  });

  it('level=warn suppresses debug+info', async () => {
    process.env.PXpipe_LOG_LEVEL = 'warn';
    const mod = await dynamicImportFresh('../src/node.js');
    mod.debug('debug-msg');
    mod.info('info-msg');
    mod.warn('warn-msg');
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('warn-msg'));
  });

  it('level=error suppresses everything except errors', async () => {
    process.env.PXpipe_LOG_LEVEL = 'error';
    const mod = await dynamicImportFresh('../src/node.js');
    mod.debug('x');
    mod.info('x');
    mod.warn('x');
    mod.error('error-msg');
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('error-msg'));
  });

  it('invalid level falls back to info with warning', async () => {
    process.env.PXpipe_LOG_LEVEL = 'loud';
    const mod = await dynamicImportFresh('../src/node.js');
    mod.info('info-msg');
    // Initial warning was logged during currentLogLevel() call.
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('PXpipe_LOG_LEVEL'));
  });
});

// Helper: dynamic import with cache busting.
async function dynamicImportFresh(spec: string) {
  // Vitest's vi.resetModules() may help.
  vi.resetModules();
  return import(spec);
}
```

> ⚠️ Тестирование module-level констант (как `ACTIVE_LEVEL`) сложно — нужно `vi.resetModules()` + dynamic import после изменения env.

## Обратная совместимость

- Default уровень info — поведение идентично.
- Кто-то парсил stdout pxpipe (regex `[pxpipe ...]`) — префикс сохраняется: `[pxpipe ${level}]`.

### Опционально: dual-prefix для backward compat

Чтобы старые скрипты не сломались, оставить префикс `[pxpipe]` без подуровня для info, добавлять подуровень только для debug/warn/error:

```ts
function log(level: LogLevel, msg: string): void {
  if (LOG_LEVELS[level] < LOG_LEVELS[ACTIVE_LEVEL]) return;
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  const prefix = level === 'info' ? '[pxpipe]' : `[pxpipe ${level}]`;
  fn(prefix, msg);
}
```

## Открытые вопросы

- **Q1:** Структурированный (JSON) лог? Out of scope, но добавит позже.
- **Q2:** Per-module levels (`PXpipe_PROXY_LOG_LEVEL=debug`)? Out of scope.

## Чеклист PR

- [x] `src/node.ts`: добавлены `LOG_LEVELS`, `log()`, helpers `debug/info/warn/error`.
- [x] Все `console.log/warn/error` в `src/node.ts` заменены на helpers.
- [x] Документация в `printHelp()`.
- [x] `tests/log-level.test.ts` добавлен.
- [x] `pnpm typecheck && pnpm test` — чисто.
- [ ] Manual: `PXpipe_LOG_LEVEL=debug node dist/node.js 2>&1 | grep 'compressed'` показывает per-request вывод.

> Реализация (2026-08-18): отклонения от спеки —
> - Логгер вынесен в отдельный `src/log.ts`: импорт `src/node.js` в тестах
>   запускает `main()` (bind дашборда), поэтому `dynamicImportFresh('../src/node.js')`
>   из спеки невозможен.
> - Уровень читается на каждый вызов (live-flip, как `PXPIPE_MODELS`); warning
>   о невалидном значении печатается один раз.
> - Пер-запросные метрики → `debug`; вывод команд (`--help`, `--version`,
>   `pxpipe export` report) оставлен на `console.log` — это не диагностика.
> - Для экспорт-сообщений префикс `[pxpipe export]` заменён на `export:` в тексте
>   (логгер сам добавляет `[pxpipe warn]`/`[pxpipe error]`).
