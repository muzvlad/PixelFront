# SPEC-016: Документация `prune` и 4xx-body sidecars

| Поле | Значение |
|---|---|
| **Приоритет** | 🟢 Низкий |
| **Категория** | Документация / DX |
| **Файлы** | `README.md`, `src/sessions.ts`, опционально `src/node.ts` |
| **Связь с аудитом** | пункт 5.6 + раздел 2.2 |
| **Объём работ** | 1 час |
| **Breaking change** | Нет |

## Проблема

Текущая документация поверхностно описывает поведение `prune`:

1. **`prune` теряет события**, записанные во время выполнения (`src/sessions.ts:282-287` признаёт это). Пользователь об этом не знает.
2. **Sidecar files** (`~/.pxpipe/4xx-bodies/${iso-ts}-${sha8}.json.gz`) создаются автоматически для oversized request bodies. В README нет описания формата, как читать, как чистить.
3. **`PXpipe_LOG`** env переменная упомянута в `printHelp()`, но не описаны её edge-cases.

## Требования

1. В README.md добавить секцию «Operational notes»:
   - Поведение `prune` под нагрузкой.
   - Расположение и формат sidecar files.
   - Размер log file до ротации.
2. В `src/sessions.ts:prune` добавить JSDoc-предупреждение.
3. В `src/node.ts:maybeWriteBodySidecar` JSDoc-расширение.

## Дизайн

### README.md — новая секция

```markdown
## Operational notes

### Log file location

By default, `pxpipe-proxy` writes per-request events to:

```
~/.pxpipe/events.jsonl
```

Override with `PXPIPE_LOG=/path/to/file.jsonl`.

The file rotates when it exceeds **100 MB** — the existing file is renamed
to `<path>.1` and a fresh file is opened. We keep **one generation** of
history; for longer retention, archive the file yourself before rotation.

### 4xx body sidecars

Failed upstream requests (4xx) may carry a large response body. Instead of
inflating the JSONL log, gzipped bodies are written to:

```
~/.pxpipe/4xx-bodies/<iso-timestamp>-<sha8[0:8]>.json.gz
```

The path is recorded in the corresponding `events.jsonl` row as
`req_body_sample_path`. To inspect: `zcat ~/.pxpipe/4xx-bodies/2026-08-17T10-00-00-123Z-abcd1234.json.gz | jq`.

### Pruning sessions

The dashboard's «Cleanup» tab prunes old sessions from `events.jsonl` and
deletes their sidecar files.

⚠️ **Concurrency:** `prune` rewrites `events.jsonl` via `rename`. If the
proxy is actively writing events, in-flight events written during the
rewrite may be lost (they target the pre-rename inode). For large prunes,
stop the proxy first:

```bash
pkill -f pxpipe-proxy      # or your process manager
node dist/node.js --help   # verify it stopped
# now safe to prune via dashboard or:
node scripts/prune.js --older-than-days 30
pxpipe-proxy &             # restart
```

Small prunes (single session) are safe to run while proxy is active.

### Process management

`pxpipe-proxy` traps `SIGINT`/`SIGTERM`, flushes events, and force-closes
idle keep-alive sockets. A second Ctrl+C exits immediately. See
`src/node.ts:1283-1305` for shutdown logic.
```

### src/sessions.ts — JSDoc на prune

```ts
/**
 * Rewrite events.jsonl with rows from `toRemove` sessions stripped out, and
 * delete the matching 4xx-body sidecars. Atomic: writes to a sibling `.tmp`
 * file with fsync, then renames over the original.
 *
 * ⚠️ CONCURRENCY WARNING: if the live proxy appends during prune, those new
 * lines will be lost (the proxy holds an fd to the pre-rename inode and
 * keeps writing to it). For a single-user dev tool that's an acceptable
 * tradeoff. For production-grade guarantees, see SPEC-002 (suspend/resume)
 * in the specs/ directory. Stop the proxy before large prunes to avoid loss.
 *
 * @param paths  Resolved events file + sidecar directory.
 * @param opts   Prune criteria (olderThanDays, keepLast, sessionId) + force.
 */
export async function prune( /* ... */ ): Promise<PruneReport> {
  // ...
}
```

### src/node.ts — расширение JSDoc на maybeWriteBodySidecar

```ts
/**
 * Write a gzipped 4xx body sidecar. The path follows the convention:
 *   <dir>/<iso-timestamp>-<sha8[0:8]>.json.gz
 *
 * The path lands in the request's TrackEvent as `reqBodySamplePath`.
 * Sidecars are deleted by prune() when their owning session is pruned.
 * They are NOT auto-cleaned by log rotation. If you keep many sessions,
 * monitor ~/.pxpipe/4xx-bodies/ disk usage separately.
 *
 * Failure mode: directory unwritable or write fails → returns undefined and
 * the body sample is silently dropped (we still keep the sha8 and error_body
 * for diagnostics).
 */
async function maybeWriteBodySidecar(
  bytesGz: Uint8Array,
  sha8: string | undefined,
  dir: string,
): Promise<string | undefined> {
  // ... existing ...
}
```

## Acceptance Criteria

- [ ] README.md содержит секцию «Operational notes» с подсекциями «Log file location», «4xx body sidecars», «Pruning sessions», «Process management».
- [ ] `src/sessions.ts:prune` JSDoc-расширен со warning.
- [ ] `src/node.ts:maybeWriteBodySidecar` JSDoc-расширен.
- [ ] Markdown rendering: ссылки корректные, заголовки иерархичны.
- [ ] (Опционально) ссылка на `/specs/SPEC-002-tracker-suspend-resume.md` из README.

## Тесты

Не требуются — это документация.

Можно добавить **lint** для README (markdownlint), но это вне scope.

## Обратная совместимость

Никаких runtime-изменений.

## Открытые вопросы

- **Q1:** Стоит ли вынести `prune` в отдельный CLI-скрипт (`scripts/prune.ts`) для тех, кто не использует dashboard?
  - **Решение:** оставить в dashboard. CLI добавим по запросу.
- **Q2:** Должна ли README быть переведена на русский? В справке CLI — частично. Это out of scope.

## Чеклист PR

- [x] `README.md` — добавлена секция «Operational notes».
- [x] `src/sessions.ts:prune` — JSDoc warning добавлен.
- [x] `src/node.ts:maybeWriteBodySidecar` — JSDoc расширен.
- [x] (Опционально) Ссылка на SPEC-002.
- [x] Render preview в GitHub/VS Code — заголовки иерархичны, ссылки рабочие.

> Реализация (2026-08-18): отклонения от спеки —
> - Вводная «prune теряет события» устарела: после SPEC-005 prune
>   приостанавливает tracker (suspend/resume) вокруг rename — события
>   буферизуются и flush'атся в новый файл. Документация и JSDoc отражают
>   актуальное поведение + два остаточных окна потери (cap буфера, краш
>   во время prune).
> - `scripts/prune.js` из README-примера спеки не упомянут (такого скрипта нет;
>   prune остаётся в dashboard, Q1 спеки).
