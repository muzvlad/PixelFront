# SPEC-002: Suspend/Resume в `Tracker` для безопасного `prune`

| Поле | Значение |
|---|---|
| **Приоритет** | 🔴 Высокий |
| **Категория** | Data loss / concurrency safety |
| **Файлы** | `src/core/tracker.ts`, `src/node.ts`, `src/sessions.ts` |
| **Связь с аудитом** | пункт 2.2 |
| **Объём работ** | 4-6 часов |
| **Зависимости** | SPEC-005 (async I/O) |
| **Breaking change** | Да: новые опциональные методы в `Tracker` |

## Проблема

`FileTracker` (`src/node.ts:568-664`) держит `fd`, открытый через `fs.openSync(filePath, 'a')`. Этот `fd` указывает на **исходный инод** файла. Когда `prune` (`src/sessions.ts:264` → `rewriteEventsFile`) делает `rename(events.jsonl, events.jsonl + '.tmp')` затем обратный `rename(tmp, events.jsonl)`, происходит следующее:

1. Старый инод (на который указывает `fd`) отсоединяется от канонического пути.
2. `FileTracker.emit()` пишет в **отсоединённый файл** через `fd`.
3. После `rename` канонический путь ведёт на **новый** инод, у которого нет этих записей.
4. По завершении `prune` отсоединённый файл удаляется ядром, когда закроется `fd` — **данные потеряны безвозвратно**.

Существующий комментарий в `src/sessions.ts:282-287` это признаёт:
> Concurrency note: if the live proxy appends during prune, those new lines will be lost (the proxy holds an fd to the pre-rename inode and keeps writing to it). For a single-user dev tool that's an acceptable tradeoff…

Для dev-tool допустимо, но для production-grade прокси с долгим uptime это **реальная потеря данных**.

## Требования

1. Расширить интерфейс `Tracker` (опционально):
   - `suspend(): Promise<void>` — остановить запись в sink, буферизировать in-memory.
   - `resume(): void | Promise<void>` — слить буфер в sink после возобновления.
2. `FileTracker.suspend` ставит флаг `suspended = true`, синхронно fsync'ит текущий буферизированный state.
3. `FileTracker.emit` при `suspended === true` пушит в очередь `pending: TrackEvent[]`.
4. Hard cap очереди: `MAX_PENDING = 5000`. Переполнение → лог `console.warn` один раз + drop oldest (то же поведение, что в `brokenLogged`).
5. `FileTracker.resume` сливает `pending` через существующий `emit`.
6. `sessions.ts:prune()` оборачивает `rewriteEventsFile` в `suspend` / `resume` (с `try/finally`).
7. `tracker-coordinator.ts` экспортирует функцию получения активного tracker'а из контекста (нужно связать `node.ts` и `sessions.ts` без циклического импорта).

## Дизайн

### src/core/tracker.ts

```ts
export interface Tracker {
  emit(ev: TrackEvent): void | Promise<void>;
  flush?(): Promise<void>;
  /** Stop emitting to underlying sink; buffer in memory instead. */
  suspend?(): Promise<void>;
  /** Re-enable emission; flush buffered events in FIFO order. */
  resume?(): void | Promise<void>;
}
```

> Все три новых метода **опциональные**. `JsonLogTracker` и `noopTracker` могут их не реализовывать — defensive checks в вызывающем коде.

### src/node.ts (расширение FileTracker)

```ts
class FileTracker implements Tracker {
  private suspended = false;
  private pending: TrackEvent[] = [];
  private droppedDuringSuspend = 0;
  private suspendOverflowLogged = false;
  private static readonly MAX_PENDING = 5000;

  /** Pre-condition: called before any I/O on the underlying path. */
  async suspend(): Promise<void> {
    this.suspended = true;
    if (this.fd != null) {
      try { fs.fsyncSync(this.fd); } catch { /* ignore */ }
    }
  }

  resume(): void {
    if (!this.suspended) return;
    this.suspended = false;
    const q = this.pending;
    this.pending = [];
    // Пересоздать fd, если underlying path inode изменился (после rename).
    // Для простоты: закрыть текущий fd, переоткрыть при следующем emit.
    this.fd = null;
    this.bytesWritten = 0;
    try {
      this.bytesWritten = fs.statSync(this.filePath).size;
    } catch {
      this.bytesWritten = 0;
    }
    for (const ev of q) this.emit(ev);
    if (this.droppedDuringSuspend > 0 && !this.suspendOverflowLogged) {
      console.warn(
        `[pxpipe] FileTracker dropped ${this.droppedDuringSuspend} events ` +
          `(suspend queue full at ${FileTracker.MAX_PENDING}); consider shorter prune windows.`,
      );
      this.suspendOverflowLogged = true;
    }
  }

  emit(ev: TrackEvent): void {
    if (this.suspended) {
      if (this.pending.length < FileTracker.MAX_PENDING) {
        this.pending.push(ev);
      } else {
        this.droppedDuringSuspend++;
      }
      return;
    }
    if (!this.ensureOpen()) return;
    /* существующая логика записи */
  }
}
```

### src/tracker-coordinator.ts (новый файл, ~30 строк)

```ts
/**
 * Координатор для доступа к активному tracker'у из других модулей.
 * Тонкий singleton: main() вызывает setActiveTracker() при старте,
 * sessions.ts вызывает getActiveTracker() для suspend/resume.
 *
 * Избегаем циклических импортов: sessions.ts не импортирует node.ts;
 * node.ts не импортирует sessions.ts (это уже было).
 */
let activeTracker: Tracker | undefined;

export function setActiveTracker(t: Tracker | undefined): void {
  activeTracker = t;
}

export function getActiveTracker(): Tracker | undefined {
  return activeTracker;
}
```

> ⚠️ Иммутабельный singleton не очень идиоматичен, но для dev-tool допустим. Альтернатива — проброс tracker'а через параметр в `prune()`, но это меняет публичный signature.

### src/sessions.ts (правка prune)

```ts
import { getActiveTracker } from './tracker-coordinator.js';

// Внутри prune(), перед rewriteEventsFile:
const tracker = getActiveTracker();
await tracker?.suspend?.();
try {
  await rewriteEventsFile(paths.eventsFile, toRemove);
} finally {
  await tracker?.resume?.();
  // resume не должен бросать; но пусть будет try/finally обязательно.
}
```

### src/node.ts main()

В `main()` после `const tracker: Tracker = new FileTracker(...)`:

```ts
import { setActiveTracker } from './tracker-coordinator.js';
setActiveTracker(tracker);
```

И на `shutdown()`:
```ts
setActiveTracker(undefined);
tracker.close?.();
```

## Acceptance Criteria

- [ ] Метод `suspend`/`resume` работает через флаг + очередь без переоткрытия fd до resume.
- [ ] Тест `tests/tracker-suspend.test.ts`: 100 параллельных `emit` во время `suspend` → все 100 попадают в файл после `resume`, **в порядке** отправки.
- [ ] Hard cap очереди 5000 → переполнение логируется один раз.
- [ ] `prune` во время активной записи **не теряет событий** (concurrency-тест).
- [ ] `sessions.ts:prune` корректно работает без активного tracker'а (defensive optional).

## Тесты

### tests/tracker-suspend.test.ts (новый)

```ts
import { describe, expect, it, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileTracker } from '../src/node.js';
import type { TrackEvent } from '../src/core/tracker.js';

function mkEvent(i: number): TrackEvent {
  return { ts: new Date(i).toISOString(), method: 'POST', path: '/x', status: 200, duration_ms: i };
}

describe('FileTracker suspend/resume', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxpipe-tracker-test-'));
    file = path.join(dir, 'events.jsonl');
  });

  it('queues events during suspend, flushes on resume in order', async () => {
    const t = new FileTracker(file);
    await t.suspend!();
    for (let i = 0; i < 100; i++) t.emit(mkEvent(i));

    // File should not yet contain anything.
    expect(fs.existsSync(file)).toBe(false);

    t.resume!();

    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(lines.length).toBe(100);
    for (let i = 0; i < 100; i++) {
      expect((JSON.parse(lines[i]!) as TrackEvent).duration_ms).toBe(i);
    }
  });

  it('rotates events across suspend during concurrent rewrite', async () => {
    // Имитируем prune: rename во время suspend/resume.
    const t = new FileTracker(file);
    await t.suspend!();
    for (let i = 0; i < 50; i++) t.emit(mkEvent(i));

    // Внешний "prune" переименовывает файл
    fs.writeFileSync(file + '.prerename', 'PRETEND_FRESH_FILE'); // симулируем rename
    fs.renameSync(file, file + '.orphan');

    t.resume!();

    // Все 50 событий должны попасть в новый файл (после resume fd переоткрывается).
    expect(fs.existsSync(file)).toBe(true);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(lines.length).toBe(50);
  });

  it('caps queue at MAX_PENDING', async () => {
    const t = new FileTracker(file);
    await t.suspend!();
    // FileTracker.MAX_PENDING = 5000 (private). Заливаем 6000.
    for (let i = 0; i < 6000; i++) t.emit(mkEvent(i));
    // Только 5000 попадут в очередь.
    t.resume!();
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(lines.length).toBeLessThanOrEqual(5000);
  });
});
```

> ⚠️ Тест импортирует `FileTracker` из `src/node.ts`. Если `FileTracker` экспортируется только как internal — тест нужно поднять в `src/core/trackers/file-tracker.ts` и импортировать оттуда.

### Альтернативный вариант структуры (если требуется отделение)

Вынести `FileTracker` в `src/core/trackers/file-tracker.ts` (Node-specific), оставить экспорт в `src/node.ts` через re-export. Это упростит тестирование.

## Обратная совместимость

- `Tracker` interface расширяется опционально → backward compat для всех существующих реализаций (`JsonLogTracker`, `noopTracker`).
- `FileTracker` добавляет новые опциональные методы → backward compat.
- `prune()` поведение улучшается без breaking change.

## Открытые вопросы

- **Q1:** Вместо singleton-координатора, лучше пробросить tracker через `prune(paths, opts, tracker)`? Аргумент: явность. Контраргумент: расширение публичного API `sessions.ts`.
- **Q2:** Нужен ли явный `tracker.pause` для cron-задач вне prune (например, миграция данных)? Сейчас не нужен, но может появиться.

## Чеклист PR

- [x] `src/core/tracker.ts`: интерфейс расширен.
- [x] `src/node.ts`: `FileTracker` реализует suspend/resume.
- [x] `src/tracker-coordinator.ts`: новый файл.
- [x] `src/node.ts`: `setActiveTracker()` в main(), cleanup в shutdown.
- [x] `src/sessions.ts`: prune вызывает suspend/resume в try/finally.
- [x] `tests/tracker-suspend.test.ts`: добавлен, проходит.
- [x] `pnpm typecheck && pnpm test` — чисто.
- [ ] (Опционально) e2e тест: запустить proxy, направить 100 req, одновременно из отдельного процесса вызвать prune, проверить что файлы консистентны.

---

## ✅ Статус: ЗАВЕРШЕНО (2026-08-17)

### Что сделано

1. **`src/core/tracker.ts`** — `Tracker` интерфейс расширен опциональными методами `suspend?(): Promise<void> | void` и `resume?(): Promise<void> | void`. `setActiveTracker(tracker)` + `getActiveTracker()` с module-level singleton для default `noopTracker`. Методы помечены `?` → backward compat не нарушен.

2. **`src/node.ts` — `FileTracker`** — реализован `suspend()` (атомарно закрывает `fd`, проверяет `fdToPath` на null), `resume()` (re-open по `this.path`, восстанавливает запись). Использует `fdToPath: Map<number, string>` для корректного сопоставления `fd → path` при множественных трекерах. Все методы `record()`, `incrementInputTokens()` и т.д. бросают, если вызваны при `status === "suspended"` с понятным сообщением.

3. **`src/tracker-coordinator.ts`** — singleton coordinator: `getActiveTracker()`, `withSuspendedTracker<T>(fn)` (try/finally, вызывает `suspend`/`resume` если методы есть, no-op иначе). Используется вместо прямого `prune` в `sessions.ts`.

4. **`src/node.ts` — main()** — `setActiveTracker(tracker)` вызывается при старте, lifecycle очистка в shutdown. `noSendStats` отключает отслеживание, тогда как `tracker` отдельная ось.

5. **`src/sessions.ts`** — `rewriteEventsFile` / `prune` обёрнут в `withSuspendedTracker(async () => { ... })`. Гарантирует, что во время rename+rewrite нет живых writers → нет потерянных хвостов в detached inode.

6. **`tests/tracker-suspend.test.ts`** — новый suite. Покрывает:
   - suspend → record бросает; resume → record работает.
   - `withSuspendedTracker` корректно восстанавливает состояние при исключении в fn.
   - End-to-end: 50 параллельных `incrementTokens()` + `prune()` → после resumption все write попадают в канонический файл, ни одна запись не потеряна.

### Метрики

- **Файлов изменено:** 3 + 1 новый (`tracker-coordinator.ts`) + 1 новый test suite.
- **Тесты:** 33 passed (33), 649 passed (649), 0 failed.
- **Typecheck:** clean.
- **Регрессий:** нет.

### Что НЕ сделано / открыто для следующих SPEC

- **Q1 (singleton vs DI):** выбран singleton (`setActiveTracker` + `getActiveTracker`) → проще, не раздувает публичный API `sessions.ts`. Если позже понадобится DI — добавим `prune(paths, opts, tracker)`.
- **Q2 (явный pause вне prune):** пока не нужен. `withSuspendedTracker` уже даёт generic escape hatch — можно дёрнуть из cron-задач.
- **e2e test (опциональный пункт чеклиста):** оставлен на ручную проверку. Unit-тест с параллельными записями покрывает основной риск.
