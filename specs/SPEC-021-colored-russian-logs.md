# SPEC-021: Цветной русский лог терминала

| Поле | Значение |
|---|---|
| **Приоритет** | 🟢 Низкий (UX) |
| **Категория** | DX / usability |
| **Файлы** | `src/log.ts`, `src/node.ts`, `tests/log-level.test.ts` |
| **Объём работ** | 1 час |
| **Breaking change** | Нет |

## Проблема

Сервисные сообщения прокси печатаются по-английски и без цвета. Пользователь
не может с одного взгляда отличить успешный запуск от предупреждения или сбоя.

## Требования

1. `src/log.ts`: ANSI-цвета по семантическим категориям.
2. Цвет только в TTY; `NO_COLOR`/`PXPIPE_NO_COLOR` выключают,
   `FORCE_COLOR`/`PXPIPE_FORCE_COLOR` включают принудительно.
3. Новая функция `status(category, ...)` с русским ярлыком категории.
4. Сервисные логи `node.ts` (запуск, upstreams, shutdown, режимы) — на русском.
5. `info()`/`warn()`/`error()` остаются с прежними префиксами `[pxpipe]` /
   `[pxpipe warn]` / `[pxpipe error]` (старые парсеры stdout не ломаются).

## Цветовые категории

| Категория | Цвет | Событие |
|---|---|---|
| `start` | зелёный | успешный запуск, готовность |
| `process` | оранжевый | рабочие процессы, маршруты upstream |
| `restart` | голубой | остановка, перезапуск, режим пропуска |
| `error` | красный | сбой обработчика, фатальная ошибка |
| `warn` | жёлтый | предупреждения |
| `request` | серый | обычные запросы (per-request debug) |

## Дизайн

```ts
export type LogCategory = 'start' | 'process' | 'restart' | 'error' | 'warn' | 'request' | 'debug';

function colorsEnabled(): boolean {
  const env = process.env;
  if (env.NO_COLOR !== undefined || env.PXPIPE_NO_COLOR !== undefined) return false;
  if (env.FORCE_COLOR !== undefined || env.PXPIPE_FORCE_COLOR !== undefined) return true;
  return Boolean(process.stdout && process.stdout.isTTY);
}

export function status(cat: LogCategory, ...args: unknown[]): void {
  if (LOG_LEVELS.info < LOG_LEVELS[currentLogLevel()]) return;
  emit('info', cat, `[pxpipe] ${label(cat)}`, args);
}
```

## Обоснование

- TTY-gating: пайпы и файлы получают чистый текст без escape-мусора.
- Отдельная `status()` вместо расширения `info()`: ярлык категории — только для
  сервисных событий, `info()` сохраняет совместимость с тестами и парсерами.
- `NO_COLOR` — де-факто стандарт (no-color.org).

## Acceptance Criteria

- [x] Цвета включаются только в TTY (или при FORCE_COLOR).
- [x] `NO_COLOR` отключает цвет.
- [x] Сервисные логи node.ts переведены на русский.
- [x] Тесты на gating и ярлык категории.
- [x] `tsc --noEmit` и полный vitest (722) — зелёные.

## Обратная совместимость

Префиксы `info/warn/error/debug` не менялись. Цвет — только в интерактивном
терминале, перенаправленный вывод идентичен прежнему по структуре строк.
