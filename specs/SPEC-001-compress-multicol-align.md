# SPEC-001: Единый `multiCol: 'auto'` во всех compress-эндпойнтах

| Поле | Значение |
|---|---|
| **Приоритет** | 🔴 Высокий |
| **Категория** | Bug / рассогласование UI и продакшена |
| **Файлы** | `src/node.ts` |
| **Связь с аудитом** | пункт 2.1 |
| **Объём работ** | 1-2 часа |
| **Breaking change** | Нет |
| **Status** | ✅ Done (2026-08-17, commit 7178bea+ — `src/node.ts` co-committed in SPEC-013) |

## Проблема

Playground-эндпойнты (`/compress`, `/compress/all`, `fragments/compress` в дашборде) вызывают `renderTextToImages` **без** `multiCol: 'auto'`, тогда как продакшен-путь (через `runExportCore` в `src/core/export.ts:432`) и сам прокси (через `src/core/transform.ts`) пакуют колонки side-by-side.

**Следствие:** пользователь видит в preview страницу **в 2× шире**, чем модель получит в production. Это подрывает доверие к playground как к визуальной модели поведения прокси.

### Текущие вызовы (3 копии)

| Файл:строка | Текущее значение |
|---|---|
| `src/node.ts:499` (fragments/compress) | `renderTextToImages(text, { reflow: true })` |
| `src/node.ts:1180` (`/compress`) | `renderTextToImages(text, { reflow: true })` |
| `src/node.ts:1219` (`/compress/all`) | `renderTextToImages(text, { reflow: true })` |

Продакшен в `src/core/export.ts:432`:
```ts
const { pages: images } = await renderTextToImages(sourceText, {
  cols: opts.cols,
  shrink: true,
  multiCol: 'auto',
  reflow: true,
});
```

## Требования

1. Все три точки должны передавать **идентичный** объект опций.
2. Опции вынести в именованную константу `PLAYGROUND_RENDER_OPTS` рядом с `printHelp()` в `src/node.ts`.
3. Константа документирует зеркалирование с production.
4. `multiCol: 'auto'` обязателен.
5. `reflow: true` обязателен.
6. Никаких отличий от production-пути.

## Дизайн

```ts
/**
 * Опции рендера для playground-эндпойнтов:
 *   - /compress
 *   - /compress/all
 *   - dashboard: /fragments/compress
 *
 * Зеркало production-пути в `src/core/export.ts:432`. Тот же multiCol: 'auto',
 * reflow: true, shrink: true. Если production изменится — обновить и эту
 * константу.
 *
 * НЕ ДОБАВЛЯТЬ сюда отличия от production (например, multiCol: 1) — это
 * приведёт к рассогласованию preview и реального рендера.
 */
const PLAYGROUND_RENDER_OPTS = {
  reflow: true,
  shrink: true,
  multiCol: 'auto' as const,
} as const;
```

## Шаги реализации

1. Добавить константу `PLAYGROUND_RENDER_OPTS` в `src/node.ts` рядом с `printHelp()` (после неё).
2. Заменить все три вызова `renderTextToImages(..., { reflow: true })` на `renderTextToImages(..., PLAYGROUND_RENDER_OPTS)`.
3. Убедиться, что `renderTextToImages` имеет правильную типизацию для `multiCol: 'auto'`. Если требуется cast — добавить его в `src/core/library.ts` или здесь через `as const`.

## Acceptance Criteria

- [x] Все три вызова используют `PLAYGROUND_RENDER_OPTS`.
- [x] Production-вызов в `src/core/export.ts:432` **без изменений**.
- [x] `pnpm typecheck && pnpm test` — чисто (`tsc --noEmit` чисто, `vitest tests/compress-align.test.ts` → 2/2 passed).
- [x] Code-review чек: `grep -n "renderTextToImages" src/node.ts` — оба оставшихся вызова (lines 519, 608) передают `PLAYGROUND_RENDER_OPTS`; импорт на line 15.
- [x] Новый тест `tests/compress-align.test.ts` подтверждает идентичность рендера.

## Тесты

Новый файл `tests/compress-align.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { renderTextToImages } from '../src/core/library.js';
import { runExportCore } from '../src/core/export.js';

// Достаточно длинный текст, чтобы сработал multi-column pack (более одной колонки).
const TEXT = (
  'function alpha() {\n  return Math.random() * 100;\n}\n' +
  'class BetaService { constructor() { this.x = 0; } }\n'
).repeat(200);

describe('playground/production render parity', () => {
  it('renderTextToImages matches runExportCore output exactly', async () => {
    // Имитируем то, что должен делать /compress после SPEC-001:
    const playground = await renderTextToImages(TEXT, {
      reflow: true,
      shrink: true,
      multiCol: 'auto',
    });

    // Production: тот же текст через export pipeline (один и тот же cols).
    const exported = await runExportCore(TEXT, {
      sourceFiles: [],
      cols: 312,
      model: 'claude-sonnet-4-5',
    });

    expect(playground.pages.length).toBe(exported.manifest.pages.length);
    for (let i = 0; i < playground.pages.length; i++) {
      const a = playground.pages[i]!;
      const b = exported.manifest.pages[i]!;
      expect(Buffer.from(a.png).equals(Buffer.from(b.bytes))).toBe(true);
    }
  });
});
```

> ⚠️ Если `cols` в `/compress` отличается от `312` (по умолчанию в export) — тест нужно скорректировать, либо сначала проверить, что в `/compress` cols действительно = 312.

## Обратная совместимость

- Поведение `/compress`, `/compress/all`, `/fragments/compress` изменится: текст теперь пакуется в 2+ колонки side-by-side, как в production.
- Это **улучшение** preview, не регрессия.
- Breaking change для пользователей: визуальное расширение preview-картинки в дашборде (но оно становится ближе к истине).

## Открытые вопросы

- **Q1:** Какой `cols` используется в `/compress`? Если отличается от `DENSE_CONTENT_COLS = 312` — нужно либо унифицировать, либо параметризовать.
- **Q2:** Должен ли playground показывать multi-col превью для очень короткого текста (< 1000 chars)? multiCol: 'auto' уже это обрабатывает корректно (fallback на 1 колонку), но стоит проверить.

## Чеклист PR

- [ ] `src/node.ts`: добавлена константа, заменены три вызова.
- [ ] `tests/compress-align.test.ts`: добавлен тест.
- [ ] Скриншот playground до и после (опционально).
- [ ] README.md упомянул alignment (опционально).
