# SPEC-006: Удаление мёртвого кода `fnv32a`/`sourceShortHash`

| Поле | Значение |
|---|---|
| **Приоритет** | 🟡 Средний |
| **Категория** | Мёртвый код |
| **Файлы** | `src/core/export.ts` |
| **Связь с аудитом** | пункт 3.1 |
| **Объём работ** | 15 минут |
| **Breaking change** | Нет (никто не импортирует) |

## Проблема

В `src/core/export.ts:402-415` определены две функции, которые нигде не используются:

```ts
// src/core/export.ts

/** FNV-1a 32-bit hash — deterministic, no crypto dep. */
function fnv32a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i) & 0xff;
    h = (h * 0x01000193) >>> 0;
  }
  return h;
}

/** 8-char hex hash of the first 512 chars + length of `text`. */
export function sourceShortHash(text: string): string {
  const sample = text.slice(0, 512) + '\x00' + String(text.length);
  return fnv32a(sample).toString(16).padStart(8, '0');
}
```

Проверка по проекту:
- `grep -r "sourceShortHash\|fnv32a" src/ tests/ scripts/` — нет результатов.
- `node.ts:961` использует `fs.mkdtempSync(path.join(opts.out, 'pxpipe-export-'))` — у которого и так случайный суффикс.

Функция `sourceShortHash` экспортирована, но никем не импортирована. Это мёртвый код, который только увеличивает surface area.

## Требования

1. Удалить `fnv32a` (приватный helper).
2. Удалить `sourceShortHash` (экспортируемая функция).
3. Удалить связанные JSDoc-комментарии и секцию «Simple hash for output directory naming».

## Действия

1. Открыть `src/core/export.ts`.
2. Удалить строки 397-415 (включительно):
   ```
   // ---------------------------------------------------------------------------
   // Simple hash for output directory naming
   // ---------------------------------------------------------------------------
   
   /** FNV-1a 32-bit hash — deterministic, no crypto dep. */
   function fnv32a(str: string): number {
     ...
   }
   
   /** 8-char hex hash of the first 512 chars + length of `text`. */
   export function sourceShortHash(text: string): string {
     ...
   }
   ```
3. Убедиться, что комментарий-разделитель, относящийся к следующей секции, не потерян.

## Проверка

```bash
# До:
grep -r "fnv32a\|sourceShortHash" src/ tests/ scripts/
# (пусто — ничего не найдено)

# Удалить функции.

# После:
grep -r "fnv32a\|sourceShortHash" src/ tests/ scripts/
# Должно быть пусто.
```

## Acceptance Criteria

- [ ] `fnv32a` и `sourceShortHash` удалены из `src/core/export.ts`.
- [ ] `grep -r "fnv32a\|sourceShortHash" src/ tests/ scripts/` возвращает пусто.
- [ ] `pnpm typecheck && pnpm test` — чисто.
- [ ] Размер `dist/core/export.js` уменьшился на ~ 200 байт (незначительно).

## Тесты

Не требуются — функционал не удаляется, поскольку никем не использовался.

## Открытые вопросы

- **Q1:** Может ли кто-то из внешних потребителей (npm-пакет) импортировать `sourceShortHash`?
  - Это **экспортируемая** функция, поэтому **теоретически да**. Но:
    - `package.json` exports указывают на `dist/core/index.js`, `dist/core/library.js` и т.д. — `sourceShortHash` экспортируется из `dist/core/export.js`, но **не переэкспортируется** через `index.ts`.
    - Версия 0.8.0 — pre-1.0, semver не гарантирует стабильность. Удаление допустимо с записью в CHANGELOG.
  - **Решение:** записать в CHANGELOG как `Removed (minor breaking for downstream)`.

## Чеклист PR

- [x] `src/core/export.ts`: удалены `fnv32a` и `sourceShortHash`.
- [x] `tests/export.test.ts`: удалены 3 теста `describe('sourceShortHash')` и импорт — спека ошибочно утверждала «никто не импортирует», тест-файл всё же импортировал и проверял функцию. Пришлось удалить и его.
- [x] CHANGELOG.md: «Removed unused exports sourceShortHash and fnv32a in src/core/export.ts» (+ удалены их тесты).
- [x] `pnpm typecheck && pnpm test` — чисто.
