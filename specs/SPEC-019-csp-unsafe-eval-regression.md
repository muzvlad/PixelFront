# SPEC-019: Починка CSP — 'unsafe-eval' для htmx/Alpine

| Поле | Значение |
|---|---|
| **Приоритет** | 🔴 Высокий (дашборд неработоспособен) |
| **Категория** | Bug / regression от SPEC-014 |
| **Файлы** | `src/dashboard/fragments.ts`, `tests/csp.test.ts` |
| **Объём работ** | 30 минут |
| **Breaking change** | Нет |

## Проблема

SPEC-014 включил enforced CSP `script-src 'self' 'sha384-...'` без `'unsafe-eval'`.
Дашборд использует htmx 2.0.4 (`allowEval:true`) и Alpine.js 3.14.9 — оба вычисляют
строки через `new Function`:

- htmx: `hx-vals='js:{...}'`, выражения в `hx-trigger`;
- Alpine: все директивы `x-data`, `@click`, `x-text`, `x-show`.

При инициализации htmx падает на первом eval-узле, цикл `processNode` прерывается,
и узлы с `hx-trigger="load"` не обрабатываются. Итог: блоки «Лучшие сессии»,
«Полная история», «Сжатие текста» остаются пустыми; Alpine-разметка (тосты, трей,
переключатель темы) мертва.

### Симптомы
- Заголовки секций видны, содержимое `#frag-sessions` / `#frag-stats` /
  `#frag-compress` пустое.
- В консоли браузера: `EvalError: ... 'unsafe-eval' is not an allowed source of script`.

### Почему тесты не поймали
SPEC-014 проверял только наличие хэшей в CSP, но не то, что страница оживает
после загрузки (нет smoke-теста на отрисовку фрагментов).

## Требования

1. `dashboardCsp()` добавляет `'unsafe-eval'` в `script-src`.
2. Тест проверяет наличие `'unsafe-eval'` в CSP (регрессионный барьер).
3. Тест проверяет, что рендер страницы содержит контейнеры фрагментов с
   `hx-trigger="load"` (структурная проверка, без живой загрузки).

## Дизайн

```ts
export function dashboardCsp(): string {
  const hashes = [THEME_BOOT_JS, HTMX_JS, GLUE_JS, THEME_JS, ALPINE_JS].map((s) =>
    `'sha384-${createHash('sha384').update(s, 'utf8').digest('base64')}'`,
  );
  // 'unsafe-eval' нужен htmx и Alpine: оба вычисляют строки через new Function.
  return `script-src 'self' 'unsafe-eval' ${hashes.join(' ')}`;
}
```

## Обоснование безопасности

Дашборд слушает loopback (127.0.0.1) по умолчанию. `'unsafe-eval'` расширяет
вектор только при инъекции разметки в страницу; при этом `'unsafe-inline'` остаётся
запрещён, а inline-скрипты по-прежнему подписаны хэшами (tamper-resistance сохранён).
Альтернатива — переписать все `js:`-выражения htmx и заменить Alpine на vanilla —
несоразмерна выгоде. Компромисс: `'unsafe-eval'` здесь, `'unsafe-inline'` — нет.

## Acceptance Criteria

- [x] `dashboardCsp()` содержит `'unsafe-eval'`.
- [x] Тест на наличие `'unsafe-eval'`.
- [x] `tsc --noEmit` и полный vitest — зелёные.
- [x] Ручная проверка: фрагменты грузятся, Alpine-разметка жива.

## Обратная совместимость

- CSP ужесточается/ослабляется в рамках одного хоста; поведение прокси не затрагивается.
