# Спецификации исправлений pxpipe-proxy

Результат глубокого аудита репозитория `pxpipe-proxy` (v0.8.0) от 2026-08-17.

## Сводка

| Категория | Кол-во |
|---|---|
| Реальные баги (потеря данных / рассогласование) | 2 |
| Тонкие баги | 4 |
| Мёртвый код | 3 экспорта |
| Критичные оптимизации | 2 |
| Архитектурные улучшения | 7 |

## Каталог спецификаций

| ID | Название | Приоритет | Файл |
|---|---|---|---|
| [SPEC-001](./SPEC-001-compress-multicol-align.md) | Единый `multiCol: 'auto'` во всех compress-эндпойнтах | 🔴 Высокий | [📄](./SPEC-001-compress-multicol-align.md) |
| [SPEC-002](./SPEC-002-tracker-suspend-resume.md) | Suspend/Resume в `Tracker` для безопасного `prune` | 🔴 Высокий | [📄](./SPEC-002-tracker-suspend-resume.md) |
| [SPEC-003](./SPEC-003-stats-reservoir-sampling.md) | Резервуарная выборка в `Summary` | 🔴 Высокий | [📄](./SPEC-003-stats-reservoir-sampling.md) |
| [SPEC-004](./SPEC-004-worker-auth-all-providers.md) | Auth-гейт в Worker для всех провайдеров | 🔴 Высокий | [📄](./SPEC-004-worker-auth-all-providers.md) |
| [SPEC-005](./SPEC-005-tracker-async-io.md) | Async I/O в `FileTracker` | 🔴 Высокий | [📄](./SPEC-005-tracker-async-io.md) |
| [SPEC-006](./SPEC-006-remove-dead-code-fnv32a.md) | Удаление мёртвого кода `fnv32a`/`sourceShortHash` | 🟡 Средний | [📄](./SPEC-006-remove-dead-code-fnv32a.md) |
| [SPEC-007](./SPEC-007-stats-utf8-cleanup.md) | Чистка U+FFFD в `stats.ts` | 🟡 Средний | [📄](./SPEC-007-stats-utf8-cleanup.md) |
| [SPEC-008](./SPEC-008-compress-handler-refactor.md) | Рефакторинг `/compress*` дублирования | 🟡 Средний | [📄](./SPEC-008-compress-handler-refactor.md) |
| [SPEC-009](./SPEC-009-configurable-walk-skip-dirs.md) | Конфигурируемые skip-директории | 🟡 Средний | [📄](./SPEC-009-configurable-walk-skip-dirs.md) |
| [SPEC-010](./SPEC-010-atlas-assets-extraction.md) | Атласы в `assets/` + build step | 🟡 Средний | [📄](./SPEC-010-atlas-assets-extraction.md) |
| [SPEC-011](./SPEC-011-tracker-periodic-flush.md) | Периодический `tracker.flush()` | 🟡 Средний | [📄](./SPEC-011-tracker-periodic-flush.md) |
| [SPEC-012](./SPEC-012-pxpipe-models-help-text.md) | Уточнение `PXPIPE_MODELS` help text | 🟡 Средний | [📄](./SPEC-012-pxpipe-models-help-text.md) |
| [SPEC-013](./SPEC-013-config-validation.md) | Schema-валидация `PXPIPE_CONFIG` | 🟢 Низкий | [📄](./SPEC-013-config-validation.md) |
| [SPEC-014](./SPEC-014-vendor-sri-integrity.md) | SRI-хэши для vendored UI | 🟢 Низкий | [📄](./SPEC-014-vendor-sri-integrity.md) |
| [SPEC-015](./SPEC-015-configurable-log-level.md) | Конфигурируемый log-level | 🟢 Низкий | [📄](./SPEC-015-configurable-log-level.md) |
| [SPEC-016](./SPEC-016-prune-and-sidecar-docs.md) | Документация PRUNE и sidecar | 🟢 Низкий | [📄](./SPEC-016-prune-and-sidecar-docs.md) |
| [SPEC-017](./SPEC-017-nvidia-kimi-bigpickle-providers.md) | Провайдеры NVIDIA NIM (Kimi, Nemotron) и Big Pickle | 🟡 Средний | [📄](./SPEC-017-nvidia-kimi-bigpickle-providers.md) |
| [SPEC-018](./SPEC-018-mimo-v2.6-compression.md) | Компрессия MiMo V2.6 (Pro/Flash/Ultraspeed) | 🟡 Средний | [📄](./SPEC-018-mimo-v2.6-compression.md) |
| [SPEC-019](./SPEC-019-csp-unsafe-eval-regression.md) | Убрать CSP 'unsafe-eval' для htmx/Alpine | 🔴 Высокий | [📄](./SPEC-019-csp-unsafe-eval-regression.md) |
| [SPEC-020](./SPEC-020-background-failure-resilience.md) | Устойчивость прокси к фоновым сбоям | 🟡 Средний | [📄](./SPEC-020-background-failure-resilience.md) |
| [SPEC-021](./SPEC-021-colored-russian-logs.md) | Цветные и категоризированные логи запуска | 🟢 Низкий | [📄](./SPEC-021-colored-russian-logs.md) |
| [SPEC-022](./SPEC-022-lora-font-dashboard.md) | Шрифт Lora в дашборде PixelFront | 🟢 Низкий | [📄](./SPEC-022-lora-font-dashboard.md) |
| [SPEC-023](./SPEC-023-startup-prune-digest.md) | Startup prune + digest | 🟡 Средний | [📄](./SPEC-023-startup-prune-digest.md) |

## Рекомендованный порядок выполнения

### Фаза 1 — Критические баги
1. **SPEC-001** (1-2 ч) — рассогласование playground/production-рендера.
2. **SPEC-002** + **SPEC-005** (4-6 ч, вместе) — async-редизайн `Tracker` для устранения потери данных и блокировок event loop.
3. **SPEC-004** (1 ч) — auth-gate на Workers для DeepSeek/MiMo/MiniMax-only деплоев.
4. **SPEC-003** (3-4 ч) — резервуарная выборка в `Summary`.

### Фаза 2 — Чистка
5. **SPEC-006** (15 мин) — удаление мёртвого кода.
6. **SPEC-007** (30 мин) — чистка U+FFFD.
7. **SPEC-008** (2-3 ч) — рефакторинг `/compress*`.
8. **SPEC-009** (30 мин) — `PXPIPE_SKIP_DIRS`.

### Фаза 3 — Улучшения
9. **SPEC-010** (4-6 ч) — атласы в `assets/`.
10. **SPEC-011** (1 ч) — периодический flush (зависит от SPEC-005).
11. Остальные (012-016) по необходимости.

## Связи между спеками

- **SPEC-002 → SPEC-005 → SPEC-011** — единая история «async Tracker redesign».
- **SPEC-003 → SPEC-007** — оба касаются `src/stats.ts`, лучше мержить как один PR.
- **SPEC-008 → SPEC-001** — SPEC-001 вносит часть изменений, которые SPEC-008 потом рефакторит; SPEC-001 можно сделать без ожидания SPEC-008.
