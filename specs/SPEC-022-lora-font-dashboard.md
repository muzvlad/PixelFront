# SPEC-022 — Шрифт Lora в дашборде PixelFront

Статус: done

## Задача
Привести типографику дашборда к стилю проекта TheAgeOfReason: основной
шрифт — Lora (serif), как в `project_main/public/styles/fonts.css`.

## Решение
Дашборд — самодостаточная inline-HTML-страница с self-CSP (без внешних
origin). Чтобы не заводить статический роут и не править `font-src`, файлы
шрифта встраиваются в CSS как `@font-face { src: url(data:font/woff2;base64,...) }`.

Нужны только два сабсета: **latin** и **cyrillic** (UI дашборда русский +
английский). `latin-ext` и `cyrillic-ext` не нужны — экономия ~44KB base64.

### Артефакты
- `assets/fonts/lora-latin.woff2`, `assets/fonts/lora-cyrillic.woff2` —
  копии self-hosted файлов из TheAgeOfReason (OFL).
- `src/dashboard/font-data.ts` — сгенерированный модуль с двумя base64-строками.
- `fragments.ts` — `@font-face` в начало `CSS`, `Lora` в `font-family` для
  `body`; `--mono` и пиксельные превью не трогаем.

### Почему base64, а не роут
Дашборд локальный, single-user, HTML грузится один раз. Роут `/fonts/*.woff2`
+ правка CSP `font-src 'self'` — лишний код и внешний запрос ради файла,
который и так кэшируется вместе с HTML. Ladder: встроить — короче.

## Критерии готовности
- [x] `@font-face` присутствует, `font-src`/CSP не менялись.
- [x] `body` использует `Lora` с serif-fallback.
- [x] build + tsc + полный vitest зелёные (722/722).
- [x] Визуально дашборд на Lora (проверяется визуально).

## Риски
- Размер HTML растёт ~на 79KB base64. Для локального дашборда приемлемо.
- Шрифт не подгрузится — фолбэк на Georgia/serif (не ломает верстку).
