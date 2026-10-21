# SPEC-023: Startup prune + digest `prune-history.jsonl`

| Поле | Значение |
|---|---|
| **Приоритет** | 🟡 Средний |
| **Категория** | Disk hygiene / lifecycle |
| **Файлы** | `src/sessions.ts`, `src/node.ts`, `README.md`, `tests/sessions.test.ts` |
| **Связь с аудитом** | продолжение SPEC-016 (prune/sidecar docs) |
| **Зависимость** | SPEC-002/SPEC-005 (suspend/resume) — не обязательна: на старте tracker'а ещё нет |
| **Объём работ** | 2-3 часа |
| **Breaking change** | Нет |

## Проблема

`~/.pxpipe/` копит хлам без ограничения:

1. **`4xx-bodies/` не чистится никогда автоматически.** Ротация
   `events.jsonl` (`FileTracker`, 100 MB → `<path>.1`) упоминает только сам
   JSONL. Sidecar-и удаляются исключительно через `sessions.ts:prune()` —
   **который не вызывается ни из CLI, ни из dashboard, ни при старте**
   (роута Cleanup-вкладки в dashboard.ts нет, хотя SPEC-016 его упоминает).
   Замер на рабочей машине 2026-10-20: `events.jsonl` 4.7 MB против
   **96 MB / 18 файлов** в `4xx-bodies/` (два файла по 14.9 MB).
2. **Сироты после ротации.** `sidecarsBySession` строится сканированием
   текущего `events.jsonl`. Сессии, вытесненные в `events.jsonl.1`
   (перезаписывается при следующей ротации), невидимы для `prune` — их
   sidecar-и остаются навсегда. Даже ручной prune не опустошит каталог.
3. **Нет долгосрочной памяти.** После prune (и после ротации) агрегаты
   сессий исчезают бесследно: дашборд восстанавливает кумулятивы только из
   текущего JSONL (`dashboard.ts:909`), история «сколько сессий/токенов было
   за месяц» недоступна.

## Требования

1. При старте `pxpipe-proxy` — авто-prune сессий старше N дней
   (default 14, env `PXPIPE_PRUNE_DAYS`; `0` — отключает).
2. Перед удалением — дописывать в `~/.pxpipe/prune-history.jsonl` по одной
   JSON-строке на сессию (id, project, firstSeen/lastSeen, requestCount,
   tokensSavedEst, cacheReadTokens, jsonlBytes, sidecarBytes, pruned_at).
3. В том же проходе — удалять **осиротевшие** sidecar-и (не ссылается ни
   одна сессия текущего JSONL AND mtime старше cutoff).
4. Startup-prune не должен ломать старт: ошибки → `warn`, процесс живёт.
5. `tsc --noEmit` чист, существующие тесты зелёные, новые тесты на
   prune/digest/orphan.

## Дизайн

### Точка вызова: `node.ts:main()` до `new FileTracker`

```ts
// main(), после parseCli, ДО new FileTracker (~строка 1064):
const pruneDays = Number(process.env.PXPIPE_PRUNE_DAYS ?? 14);
if (Number.isFinite(pruneDays) && pruneDays > 0) {
  const paths: SessionsPaths = {
    eventsFile: opts.eventsFile,
    sidecarDir: path.join(path.dirname(opts.eventsFile), '4xx-bodies'),
  };
  try {
    const report = await prune(paths, { olderThanDays: pruneDays, force: true });
    if (report.sessionsRemoved.length > 0 || report.sidecarsRemoved > 0) {
      status('process', `автоочистка: ...`);
    }
  } catch (err) { warn(...); }
}
```

Почему до FileTracker: `getActiveTracker()` вернёт `undefined` → prune идёт
мимо suspend/resume, напрямая. Пишуущего процесса ещё нет — нулевой риск
потери событий. `dashboard.replay` ниже уже читает почищенный файл.

### Digest: `sessions.ts`, путь рядом с events.jsonl

- `path.join(path.dirname(eventsFile), 'prune-history.jsonl')` — уважает
  `PXPIPE_LOG`.
- Формат строки (один объект на удалённую сессию):

```json
{"pruned_at":"2026-10-20T12:00:00.000Z","id":"ab12cd34","project":"/w/repo","firstSeen":"...","lastSeen":"...","requestCount":12,"tokensSavedEst":45000,"cacheReadTokens":90000,"jsonlBytes":8123,"sidecarBytes":15200000}
```

- Один `appendFileSync` со всеми строками батча после успешного
  rewrite + unlink. Dry-run (`force:false`) не пишет.
- Осиротевшие sidecar-и: строка с `id:"<orphan>"` и полем `path`.

### Orphan-sweep: в `prune()` при `force`

```
referenced = union всех sidecarsBySession
orphan = readdir(sidecarDir) − referenced
для каждого orphan: statSync.mtimeMs < cutoff → unlink + digest-строка
```

mtime-гейт защищает от clock skew и от «свежий файл, который трекер ещё
не вписал в JSONL» (запись sidecar'а и события — разные шаги).

## Риски

| Риск | Mitigation |
|---|---|
| Prune при старте блокирует старт пропорционально размеру JSONL | На типичных 5-50 MB — миллисекунды/доли секунды. На 100 MB — единичная пауза ~1-2 с приемлема. Отключение: `PXPIPE_PRUNE_DAYS=0` |
| Кто-то захочет постареть конкретный 4xx-боди | Окно 14 дней щедро; digest — аудит-след что и когда удалено |
| Осиротевший sidecar со свежим mtime (clock skew) | Двойной гейт: «не ссылается ни на кого» AND mtime < cutoff |
| `PXPIPE_PRUNE_DAYS=abc` → NaN | `Number.isFinite` + дефолт + warn |

## Альтернативы (отклонены)

- **TTL-свип `4xx-bodies/` отдельно от prune** — дублирует логику удаления
  sidecar-ов; orphan-sweep внутри prune покрывает тот же случай.
- **CLI-подкоманда `pxpipe prune`** — env+рестарт уже покрывает сценарий;
  subcommand parsing в node.ts отсутствует по дизайну (`node.ts:1026`).
- **Ротация самого digest** — строка ~200 B; 100k сессий = ~20 MB. Ceiling
  высок, upgrade path: обычная `tail`-обрезка при желании.

## Чеклист

- [ ] `src/sessions.ts`: digest-запись в `prune()` + `pruneDigestPath()`
- [ ] `src/sessions.ts`: orphan-sweep в `prune()` при `force`
- [ ] `src/node.ts`: import `prune`, startup-блок, help-строка `PXPIPE_PRUNE_DAYS`
- [ ] `README.md`: Operational notes — авто-prune, digest, orphan
- [ ] `tests/sessions.test.ts`: prune отчёт + sidecar-и; digest пишется / dry-run нет; orphan старше cutoff удаляется, свежий остаётся
- [ ] `tsc --noEmit` + `npm test` зелёные
