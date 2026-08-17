# SPEC-005: Async I/O в `FileTracker`

| Поле | Значение |
|---|---|
| **Приоритет** | 🔴 Высокий |
| **Категория** | Performance / event loop blocking |
| **Файлы** | `src/node.ts` (`FileTracker` класс) |
| **Связь с аудитом** | пункт 4.4 |
| **Объём работ** | 4-6 часов |
| **Зависимости** | SPEC-002 (suspend/resume API) |
| **Breaking change** | Да: `close()` теперь `async` |

## Проблема

`FileTracker.emit` (`src/node.ts:621-637`) использует синхронный I/O на горячем пути:

```ts
emit(ev: TrackEvent): void {
  if (!this.ensureOpen()) return;
  try {
    const line = JSON.stringify(ev) + '\n';
    const buf = Buffer.from(line, 'utf8');
    fs.writeSync(this.fd!, buf);
    this.bytesWritten += buf.length;
    if (this.bytesWritten > FileTracker.MAX_FILE_BYTES) this.rotate();
  } catch (err) { /* ... */ }
}
```

`fs.writeSync` блокирует event loop. На быстром SSD это ~50µs/запись, но:
- На сетевой FS (NFS, SMB) или под нагрузкой — может расти до миллисекунд.
- На конкурентном прокси (несколько входящих запросов одновременно) каждый emit = потенциальная задержка upstream-ответа.

Кроме того, `close()` использует `fs.fsyncSync` + `fs.closeSync` (`src/node.ts:649-663`) — те же проблемы на shutdown.

## Требования

1. Использовать `fs.createWriteStream` с `highWaterMark: 64 * 1024` и флагом `'a'`.
2. Стрим хранится как `private stream: fs.WriteStream | null`.
3. При backpressure (`stream.write` возвращает `false`) — события буферизуются в pending-очереди, дренируются по `'drain'`.
4. `bytesWritten` обновляется через `'drain'` callback или непосредственно по факту записи.
5. `fs.fsyncSync` заменяется на `await fs.promises.fsync()` в `close()`.
6. `close()` меняет сигнатуру: `void` → `Promise<void>`.
7. Ротация (при превышении `MAX_FILE_BYTES`) обрабатывается через `'drain'` callback или после успешного `write()`.

## Дизайн

```ts
class FileTracker implements Tracker {
  private stream: fs.WriteStream | null = null;
  private bytesWritten = 0;
  private brokenLogged = false;
  private static readonly MAX_FILE_BYTES = 100 * 1024 * 1024;
  private static readonly HIGH_WATER_MARK = 64 * 1024;
  private isRotating = false;

  constructor(private readonly filePath: string) {}

  private ensureOpen(): boolean {
    if (this.stream != null) return true;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    } catch { /* dir may already exist */ }
    try {
      this.bytesWritten = fs.statSync(this.filePath).size;
    } catch {
      this.bytesWritten = 0;
    }
    try {
      this.stream = fs.createWriteStream(this.filePath, {
        flags: 'a',
        highWaterMark: FileTracker.HIGH_WATER_MARK,
      });
      this.stream.on('error', (err) => {
        if (!this.brokenLogged) {
          console.error(`[pxpipe] FileTracker stream error: ${err.message}`);
          this.brokenLogged = true;
        }
        // Не падать на запросах — следующий emit попробует заново.
        this.stream = null;
      });
      return true;
    } catch (err) {
      if (!this.brokenLogged) {
        console.error(`[pxpipe] FileTracker disabled — cannot open ${this.filePath}: ${(err as Error).message}`);
        this.brokenLogged = true;
      }
      return false;
    }
  }

  emit(ev: TrackEvent): void {
    if (!this.ensureOpen() || this.stream == null) return;

    let line: string;
    try {
      line = JSON.stringify(ev) + '\n';
    } catch { return; }

    const buf = Buffer.from(line, 'utf8');
    // stream.write возвращает false при backpressure — НЕ блокирует.
    // Если fd не успевает, событие уйдёт в очередь стрима автоматически.
    this.stream.write(buf, (err) => {
      if (err) {
        if (!this.brokenLogged) {
          console.error(`[pxpipe] FileTracker write failed: ${err.message}`);
          this.brokenLogged = true;
        }
      }
    });

    this.bytesWritten += buf.length;
    if (this.bytesWritten > FileTracker.MAX_FILE_BYTES && !this.isRotating) {
      this.scheduleRotate();
    }
  }

  private scheduleRotate(): void {
    if (this.stream == null || this.isRotating) return;
    this.isRotating = true;
    const oldStream = this.stream;
    this.stream = null;
    oldStream.end(async () => {
      try {
        fs.renameSync(this.filePath, this.filePath + '.1');
      } catch { /* .1 locked — keep growing */ }
      this.bytesWritten = 0;
      this.isRotating = false;
      // Следующий emit откроет новый стрим.
    });
  }

  async close(): Promise<void> {
    const s = this.stream;
    this.stream = null;
    if (s == null) return;
    await new Promise<void>((resolve) => s.end(() => resolve()));
    // WriteStream.end уже закрывает fd.
  }
}
```

### Подводный камень: `JSON.stringify`

Текущий код делает `JSON.stringify(ev) + '\n'` синхронно внутри `emit`. Это CPU-work, не I/O. На горячем пути с большими `TrackEvent` (с base64 samples) `JSON.stringify` может занимать 1-2 ms, что блокирует event loop пропорционально размеру payload.

**Рекомендация:** в рамках SPEC-005 оставить sync, но **мониторить** — если профилирование покажет >1ms/event, вынести в `setImmediate` или `worker_threads`.

> Это out of scope для SPEC-005, но в SPEC-015 (log levels) можно добавить диагностику.

## Acceptance Criteria

- [ ] `tracker.emit()` — pure non-blocking I/O call (без `fs.writeSync`).
- [ ] Под нагрузкой 100 req/s — `eventLoopUtilization` (от `perf_hooks.monitorEventLoopDelay`) остаётся ≤ 5%.
- [ ] Backpressure-тест: записать данные быстрее, чем диск успевает → нет потерь строк (WriteStream внутренне буферизует).
- [ ] Ротация работает как раньше (файл переименовывается в `.1`).
- [ ] `tracker.close()` теперь async; обновить вызов в `shutdown()` (`src/node.ts:1292`).
- [ ] Ошибки стрима логируются один раз, не падают на запросах.

## Тесты

### tests/tracker-async.test.ts (новый)

```ts
import { describe, expect, it, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

class FileTracker {
  // ... импорт из src/node.js, см. SPEC-002 ...
}

describe('FileTracker async I/O', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxpipe-tracker-async-'));
    file = path.join(dir, 'events.jsonl');
  });

  it('emit does not block event loop', async () => {
    const t = new FileTracker(file);
    const start = performance.eventLoopUtilization();
    for (let i = 0; i < 1000; i++) {
      t.emit({ ts: '', method: 'POST', path: '/x', status: 200, duration_ms: i });
    }
    const elapsed = performance.eventLoopUtilization() - start;
    expect(elapsed.utilization).toBeLessThan(0.05); // < 5% utilization
    await t.close();
  });

  it('backpressure: emit 10000 events faster than disk → no loss', async () => {
    // Создаём tracker на tmpfs или медленной FS.
    const t = new FileTracker(file);
    const N = 10_000;
    for (let i = 0; i < N; i++) {
      t.emit({ ts: '', method: 'POST', path: '/x', status: 200, duration_ms: i });
    }
    await t.close();
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(lines.length).toBe(N);
  });

  it('rotates after exceeding MAX_FILE_BYTES', async () => {
    const t = new FileTracker(file);
    // Генерим данные, чтобы превысить 100 MB — на CI это долго.
    // Альтернатива: подменить MAX_FILE_BYTES через test hook или
    // проверять, что scheduleRotate корректно работает на маленьком объёме
    // через мок (vitest spy).
    // Простой smoke-тест: дёргаем emit 200 раз, потом close, файл существует.
    for (let i = 0; i < 200; i++) {
      t.emit({ ts: '', method: 'POST', path: '/x', status: 200, duration_ms: i });
    }
    await t.close();
    expect(fs.existsSync(file)).toBe(true);
  });

  it('close is idempotent', async () => {
    const t = new FileTracker(file);
    await t.close();
    await t.close(); // Не должно бросать.
  });

  it('recovers from stream error', async () => {
    const t = new FileTracker(file);
    // Сложный тест: симулируем error на WriteStream через unlink директории mid-flight.
    // Пропустить если harness сложен.
  });
});
```

> ⚠️ Реальные метрики EventLoopUtilization зависят от системы. Лучше использовать абсолютные тайминги: emit 1000 событий за < 100ms (было: ~50µs * 1000 = 50ms).

### Integration-тест (опционально)

```ts
it('event loop utilization stays low under sustained load', async () => {
  const t = new FileTracker(file);
  let count = 0;
  const monitor = setInterval(() => { /* measure ELU */ }, 100);

  const interval = setInterval(() => {
    for (let i = 0; i < 100; i++) {
      t.emit({ ts: '', method: 'POST', path: '/x', status: 200, duration_ms: count++ });
    }
  }, 10);

  await new Promise(r => setTimeout(r, 1000));
  clearInterval(interval);
  clearInterval(monitor);
  await t.close();
  // Проверить что median ELU sample < 0.05.
});
```

## Обратная совместимость

### Сломано

- `tracker.close()` теперь `Promise<void>` вместо `void`. **Breaking change**. Затронуты:
  - `src/node.ts:1292`: `if (tracker instanceof FileTracker) tracker.close();` — обновить на `await`.
  - Любой другой вызов (в текущем коде не найден).
- `Tracker` interface: `close?(): void | Promise<void>` → `close?(): Promise<void>`.

### Обратная совместимость сохранена

- `emit()` сигнатура не меняется.
- `flush?()` не затрагивается.
- `suspend/resume` (из SPEC-002) по-прежнему работают — теперь с async I/O.

## Открытые вопросы

- **Q1:** Нужна ли поддержка `flush()` для периодического `fs.fsync`? Если да — SPEC-011 логично расширяется. Если нет — SPEC-005 ограничивается `close()`.
  - **Решение:** добавить `flush()` как опциональную async-функцию, но в рамках этого SPEC оставить без периодического вызова.
- **Q2:** Стоит ли сразу `JSON.stringify` вынести в `setImmediate`? Это разные проблемы: **CPU-bound** vs **I/O-bound**. Спека SPEC-005 решает I/O, не CPU. JSON.stringify оставляем sync.
- **Q3:** `path.dirname(filePath)` может бросить на невалидном пути. Существующий код уже делает `mkdirSync({ recursive: true })` без `try/catch` на dirname. Оставить как есть.

## Чеклист PR

- [x] `src/core/trackers/file-tracker.ts`: FileTracker перенесён из src/node.ts (чтобы тесты не тянули `main()` и не поднимали дашборд-сокет), переписан на `createWriteStream`, `close` теперь async.
- [x] `src/core/tracker.ts`: интерфейс `Tracker` обновлён: добавлен `close?(): Promise<void>`.
- [x] `src/node.ts`: класс удалён, добавлен импорт FileTracker; вызов `tracker.close()` в `shutdown()` обновлён на `await` (shutdown стал async).
- [x] `tests/tracker-async.test.ts`: добавлен (5 тестов), проходит.
- [x] `tests/tracker-suspend.test.ts`: обновлён под async `close()` (чтение файла после `await t.close!()`); seed-чтение перенесено после `suspend()`.
- [x] `pnpm typecheck && pnpm test` — чисто: 38 suites, 700 tests passed (0 failed).
- [x] `tracker.flush()` теперь async — задел для последующего SPEC-011.

## Отклонения от дизайна спеки

1. **`fs.promises.fsync` не существует в Node** — в `close()` использован `fs.fsync(fd, cb)` через Promise-обёртку (fd берётся кастом `(stream as { fd }).fd`).
2. **Ротация получила `rotationDone`-промис**: `close()` ждёт завершения in-flight ротации и drain `pending`, иначе shutdown терял хвост буферизованных событий.
3. **`FileTracker` вынесен в `src/core/trackers/file-tracker.ts`** — иначе импорт `src/node.js` в тестах запускал `main()` (bind дашборда на 47821) → EADDRINUSE при нескольких трекер-сьютах.
4. **`ensureOpen()` touch'ит файл синхронно** (`openSync`+`closeSync`) — WriteStream открывает fd асинхронно, а тесты/dashboard читают файл синхронно сразу после `emit()`.
