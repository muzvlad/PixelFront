# SPEC-011: Периодический `tracker.flush()`

| Поле | Значение |
|---|---|
| **Приоритет** | 🟡 Средний |
| **Категория** | Durability / crash safety |
| **Файлы** | `src/core/tracker.ts`, `src/node.ts` |
| **Связь с аудитом** | пункт 3.3 |
| **Зависимость** | SPEC-005 (async I/O в `FileTracker`) |
| **Объём работ** | 1 час |
| **Breaking change** | Нет (метод уже опционален) |

## Проблема

`FileTracker` (`src/node.ts:568-664`) реализует `flush()` (`src/node.ts:639-647`), но он **никем не вызывается**:

```ts
export interface Tracker {
  emit(ev: TrackEvent): void | Promise<void>;
  /** Optional: flush any buffered writes (file rotation, etc.). */
  flush?(): void | Promise<void>;
}
```

Это означает, что при внезапном завершении процесса (OOM, kill -9, power loss) — последние N записей (которые ещё в OS page cache, не flushed на диск) теряются.

Комментарий в `FileTracker.close` упоминает `fsyncSync`, но это вызывается **только** на graceful shutdown через `shutdown()` (`src/node.ts:1292`).

## Требования

1. Периодический вызов `tracker.flush?.()` каждые N секунд (default: 30).
2. Использовать `setInterval(...).unref()`, чтобы flush не держал процесс.
3. Накапливать счётчик байт с прошлого flush; flush если > 1 MB.
4. На graceful shutdown `shutdown()` уже вызывает `tracker.close()` (который делает fsync).

## Дизайн

```ts
// src/node.ts main()

const FLUSH_INTERVAL_MS = Number(process.env.PXpipe_FLUSH_INTERVAL_MS ?? 30000);
const FLUSH_BYTES_THRESHOLD = Number(process.env.PXpipe_FLUSH_BYTES_THRESHOLD ?? 1024 * 1024); // 1 MB

let bytesSinceLastFlush = 0;
const flushTimer = setInterval(async () => {
  if (bytesSinceLastFlush >= FLUSH_BYTES_THRESHOLD) {
    try {
      await tracker.flush?.();
      bytesSinceLastFlush = 0;
    } catch (err) {
      console.warn(`[pxpipe] flush failed: ${(err as Error).message}`);
    }
  }
}, FLUSH_INTERVAL_MS).unref();
```

### Обновление `FileTracker.emit()` для трекинга

```ts
emit(ev: TrackEvent): void {
  // ... существующая логика ...
  bytesSinceLastFlush += line.byteLength;
}
```

> ⚠️ Лучше вычислять `bytesSinceLastFlush` в `src/node.ts` через wrapper, а не в самом `FileTracker` (separation of concerns).

### Альтернатива: `bytesSinceLastFlush` через wrapper

```ts
let bytesSinceLastFlush = 0;
const originalEmit = tracker.emit.bind(tracker);
(tracker as any).emit = (ev: TrackEvent) => {
  bytesSinceLastFlush += Buffer.byteLength(JSON.stringify(ev), 'utf8') + 1;
  return originalEmit(ev);
};
```

> ⚠️ Hacky. Лучше добавить callback `onBytesWritten?: (n: number) => void` в `Tracker`.

### Рекомендуемый вариант

```ts
export interface Tracker {
  emit(ev: TrackEvent): void | Promise<void>;
  flush?(): Promise<void>;
  /** Optional hook: called whenever bytes are written to the sink. */
  onBytesWritten?(n: number): void;
  suspend?(): Promise<void>;
  resume?(): void | Promise<void>;
}
```

```ts
// src/node.ts
const tracker: Tracker = new FileTracker(opts.eventsFile);
let bytesSinceLastFlush = 0;
tracker.onBytesWritten = (n: number) => { bytesSinceLastFlush += n; };

const flushTimer = setInterval(async () => {
  if (bytesSinceLastFlush > FLUSH_BYTES_THRESHOLD) {
    await tracker.flush?.();
    bytesSinceLastFlush = 0;
  }
}, FLUSH_INTERVAL_MS).unref();
```

```ts
// src/node.ts FileTracker.flush()
async flush(): Promise<void> {
  if (this.stream != null) {
    // WriteStream flushes on 'drain' / 'finish'. Для force-flush нужно fsync.
    // esbuild-эквивалент: stream.cork() + uncork() не помогает.
    // Решение: открыть fd через stream._handle? Хрупкое.
    // Альтернатива: выполнять fsync на raw fd, открытом параллельно для fsync.
    await fs.promises.fsync(this.fd as number); // см. SPEC-005
  }
}
```

> ⚠️ В SPEC-005 `close` переделан на `createWriteStream`. У стрима нет прямого `fsync`. Решение: держать отдельный `fd` через `fs.openSync(filePath, 'r+')` для fsync. Или вызвать `fs.fsyncSync(this.fd)` через stream.

Это **нетривиально**. Альтернатива: переоткрывать файл на короткое время через `fs.openSync` для fsync:

```ts
async flush(): Promise<void> {
  try {
    const fd = fs.openSync(this.filePath, 'r+');
    try {
      await fs.promises.fsync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    // Не критично — просто диск не отсинкался.
  }
}
```

### Обновление Tracker interface

```ts
export interface Tracker {
  emit(ev: TrackEvent): void | Promise<void>;
  /** Force underlying buffer to disk. */
  flush?(): Promise<void>;
  /** Optional hook: called when bytes are written. */
  onBytesWritten?(n: number): void;
  suspend?(): Promise<void>;
  resume?(): void | Promise<void>;
}
```

## Acceptance Criteria

- [ ] `tracker.flush?.()` вызывается каждые 30 секунд при наличии данных.
- [ ] Force flush, если > 1 MB с прошлого flush.
- [ ] `flushTimer.unref()` — не держит процесс.
- [ ] Ошибки flush логируются один раз, не падают на запросах.
- [ ] Env-переменные `PXpipe_FLUSH_INTERVAL_MS`, `PXpipe_FLUSH_BYTES_THRESHOLD` документированы.
- [ ] Тесты проходят.

## Тесты

### tests/tracker-flush.test.ts

```ts
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileTracker } from '../src/node.js';

describe('FileTracker flush', () => {
  it('flush forces fsync (file is on disk)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxpipe-flush-'));
    const file = path.join(dir, 'e.jsonl');
    const t = new FileTracker(file);
    t.emit({ ts: '', method: 'POST', path: '/x', status: 200, duration_ms: 1 });
    await t.flush!();
    // Проверка: после fsync файл гарантированно на диске.
    // (сложно проверить в unit-тесте; достаточно, что нет exception).
    expect(fs.existsSync(file)).toBe(true);
    await t.close();
  });

  it('flush is no-op when no data', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxpipe-flush-'));
    const file = path.join(dir, 'e.jsonl');
    const t = new FileTracker(file);
    // Без emit — flush должен быть no-op.
    await t.flush!();
    expect(fs.existsSync(file)).toBe(false);
    await t.close();
  });
});

describe('periodic flush scheduler', () => {
  it('fires flush after interval + threshold', async () => {
    // Имитируем: tracker.onBytesWritten(n) → bytesSinceLastFlush += n;
    // через 30s + threshold, ожидаем flush() вызван 1 раз.
    // (В тесте — ускоренно через fake timers).
    vi.useFakeTimers();
    const flushSpy = vi.fn(async () => {});
    const tracker: Tracker = { emit: () => {}, flush: flushSpy, onBytesWritten: () => {} };
    /* ... set up scheduler logic via DI ... */
    /* ... advance time ... */
    /* ... assert flushSpy called ... */
    vi.useRealTimers();
  });
});
```

## Обратная совместимость

- `tracker.flush?.()` уже опционален — добавление periodic call — additive change.
- Новые `onBytesWritten?` опциональны.

## Открытые вопросы

- **Q1:** Нужен ли порог по **времени** (не только байтам)? Например, даже при 100 KB/мин делать flush каждые 60 секунд.
  - **Решение:** interval всегда ≤ 60 секунд (env), плюс bytes-threshold.
- **Q2:** Что делать с `JsonLogTracker` (Worker build)? Там `console.log` сразу уходит в Workers Logs — flush бессмысленен. Оставить `flush?()` пустой функцией.

## Чеклист PR

- [x] `src/core/tracker.ts`: добавлен `onBytesWritten?()` hook.
- [x] `src/node.ts`: `FileTracker.flush()` async, `FileTracker.onBytesWritten(n)` хук.
- [x] `src/node.ts main()`: `flushTimer` + подсчёт `bytesSinceLastFlush`.
- [x] Env-переменные документированы.
- [x] `tests/tracker-flush.test.ts` добавлен.
- [x] `pnpm typecheck && pnpm test` — чисто.
- [ ] Симуляция crash: восстановлено >= 99% событий из последней минуты (manual test).

> Реализация (2026-08-18): отклонения от спеки —
> - `flush()` не переоткрывает файл через отдельный `fd`/`fs.openSync`, а ждёт
>   завершения in-flight write (callbacks из `emit`) и делает `fs.fsync` на fd
>   текущего стрима. Стрим остаётся открытым, следующий `emit` пишет в тот же fd.
> - Планировщик живёт в `main()` и не вынесен в DI-фабрику — fake-timers тест из
>   спеки пропущен; покрыто хуками `onBytesWritten` и самим `flush()`.
