# Дизайн-система pxpipe (Econom) — веб-дашборд

> **Назначение файла.** Полное, точное и самодостаточное описание визуального
> языка веб-интерфейса pxpipe (панель мониторинга на `http://127.0.0.1:47821/`),
> чтобы другой агент или разработчик мог построить **новый проект** (сайт,
> приложение, личную страницу, инструмент) в том же дизайне, с теми же цветами,
> типографикой, компонентами и поведением — **без доступа к исходникам**.
>
> Канонический источник: `src/dashboard/fragments.ts` (CSS + HTML-компоненты),
> `src/dashboard/vendor.ts` (htmx, Alpine), `src/dashboard/types.ts`.
> Документ описывает фактический дизайн, а не план.

---

## 1. Идентичность и философия дизайна

- **Тёплый «пламенный» минимализм.** Дизайн построен вокруг одного фирменного
  цвета — яркого оранжевого **flame** (по-русски «пламя»). Он используется как
  акцент для бренда, ключевых цифр, ссылок, активных состояний и главной кнопки.
- **Пиксельная острота с мягкостью.** Контрастный текст, острые детали и
  моноширинные числа сочетаются с мягкими скруглениями (`--radius: 14px`),
  лёгкими тенями и ненавязчивыми подложками-тинтами.
- **Светлая и тёмная темы** с одинаковой «тёплой» идентичностью: нейтральные
  цвета в обеих темах имеют тёплый (бежево-коричневый) подтон, а не холодный
  серо-синий. В тёмной теме акценты (flame / img / txt) **подняты по яркости**.
- **Честность данных.** Каждая цифра может быть объяснена: у значений есть
  плашки-«?» (`tooltip`), скрываемый блок «Показать формулы и расчёты», подписи
  источников. Отрицательные результаты показываются честно (красным), а не
  прячутся.
- **Язык интерфейса — русский.** Заголовки, подписи, подсказки, тосты — всё на
  русском. Технические идентификаторы, endpoint-ы и формулы — на английском.
- **Микро-детали фирменности:** глянцевый «огонёк» `flame-dot` (логотип +
  фавикон), градиентный текст больших цифр, пунктирные разделители, пульсирующая
  «живая» точка, галочки `✓` на активных чипах, стрелки `▸/▾` в раскрывашках.

---

## 2. Цветовая палитра

Дизайн использует CSS-переменные на `:root`. **Ниже точные значения — копируйте
их как есть.**

### 2.1. Светлая тема (по умолчанию)

```css
:root {
  /* подложки */
  --bg: #faf6f2;            /* фон страницы — тёплый кремовый */
  --surface: #ffffff;       /* карточки, плитки, блоки */
  --surface-2: #fbf4ee;     /* вторичные подложки: формулы, галереи, hover строк */

  /* границы */
  --border: #efe5db;        /* обычные границы (тёплый песочный) */
  --border-strong: #e4d6c8; /* акцентные границы, разделители, рамки полей */

  /* текст */
  --ink: #241f1b;           /* основной текст, заголовки — почти чёрный, тёплый */
  --ink-2: #5d534a;         /* вторичный текст — тёплый тёмно-коричневый */
  --muted: #9b9189;         /* приглушённый текст: подписи, хинты, мета */

  /* фирменный акцент FLAME (оранжевый) */
  --flame: #ff5a1f;         /* основной акцент */
  --flame-strong: #e8420a;  /* глубокий оттенок (градиенты, концы) */
  --flame-ink: #bd3a08;     /* текст на flame / flame-типа (активные ссылки) */
  --flame-tint: #fff1ea;    /* подложка flame-цвета (активные чипы, легенды) */

  /* семантика */
  --good: #1f9d57;          /* успех / положительное / online */
  --good-tint: #e7f6ee;
  --bad: #d8483b;           /* ошибка / отрицательное */
  --bad-tint: #fcebe9;
  --warn: #b7791f;          /* предупреждение (статус 4xx) */
  --warn-tint: #fbf0db;

  /* пара «изображение vs текст» (категории контекста) */
  --img: #ff5a1f;           /* то же, что flame — категория «стало изображением» */
  --img-ink: #bd3a08;
  --img-tint: #fff1ea;
  --txt: #2f7db0;           /* синий — категория «осталось текстом» */
  --txt-ink: #1f5f8b;
  --txt-tint: #e9f3fb;

  /* форма и тени */
  --radius: 14px;
  --shadow: 0 1px 2px rgba(60,35,15,.05), 0 8px 24px rgba(60,35,15,.05);

  /* моноширинный стек для кода, чисел, формул, баров */
  --mono: 'SF Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;

  color-scheme: light;
}
```

### 2.2. Тёмная тема

Включается атрибутом `data-theme="dark"` на `<html>` (сохраняется в
`localStorage['pp-theme']`, иначе — системная настройка; задаётся до первой
отрисовки, чтобы не было «вспышки»).

```css
:root[data-theme="dark"] {
  --bg: #17120f;            /* глубокий тёплый чёрный */
  --surface: #211a15;
  --surface-2: #2a211b;
  --border: #352a22;
  --border-strong: #46382e;

  --ink: #f6efe8;           /* тёплый светло-бежевый текст */
  --ink-2: #cabbac;
  --muted: #9a8c7d;

  --flame: #ff6a33;         /* акценты ПОДНЯТЫ по яркости для контраста */
  --flame-strong: #e8420a;
  --flame-ink: #ff9a63;
  --flame-tint: #3a2318;

  --good: #3fbd76;
  --good-tint: #15291f;
  --bad: #f0645a;
  --bad-tint: #341b18;
  --warn: #d99a3a;
  --warn-tint: #33260f;

  --img: #ff6a33;
  --img-ink: #ff9a63;
  --img-tint: #3a2318;
  --txt: #5aa3d6;
  --txt-ink: #8cc3ea;
  --txt-tint: #142631;

  --shadow: 0 1px 2px rgba(0,0,0,.4), 0 10px 28px rgba(0,0,0,.45);
  color-scheme: dark;
}
```

### 2.3. Жёстко заданные цвета (не переменные)

Эти значения зашиты в CSS напрямую и в тёмной теме заменяются отдельными
правилами:

| Где | Значение |
|---|---|
| `flame-dot` блик (radial-градиент) | `#ffd0a8` (верхний блик) |
| `hero-num` (положительный) градиент | `135deg, #ff9a4d → var(--flame) 55% → var(--flame-strong)` |
| `hero-neg .hero-num` (отрицательный) | `135deg, #f0857a → var(--bad)` |
| `bar-fill` градиент бара | `90deg, #ffa766 → var(--flame)` |
| `.banner` (светлая) | фон `--bad-tint`; рамка `#f3b6af`; текст `#9c2b20`; `strong` `#8a2117` |
| `.banner` (тёмная) | рамка `#6e342c`; текст `#f4b9b1`; `strong` `#ffd6cf` |
| `.toast` (светлая) | рамка `#f0b3ab`; тень `0 8px 24px rgba(60,35,15,.14)`; текст `--bad` |
| `.toast` (тёмная) | тень `0 8px 24px rgba(0,0,0,.5)` |
| `.page`, `.frame` (фото PNG) | фон `#fff` всегда |
| кнопка «Сжать» | фон `var(--flame)`; текст `#fff` |
| `mk-create` значок | текст и рамка `--muted` |

### 2.4. Семантика и сочетаемость

- **Flame** — единственный «главный» акцент. Не сочетайте его с синим `--txt` в
  одном смысловом контексте: `--img` и `--txt` — это строго пара
  «изображение ⇄ текст», `--img` совпадает с flame.
- **Хорошо/плохо:** `good` (зелёный) = экономия, успех, живое состояние, 2xx;
  `bad` (красный) = убыток, ошибка, 5xx, выключенный тумблер; `warn` (жёлтый) =
  4xx, «сбор данных…» и прочие промежуточные состояния.
- **Тинты** (`-tint`) всегда используются как фон под цветной текст/элемент
  того же смысла: `bad` на `bad-tint`, `flame` на `flame-tint`, `img` на
  `img-tint`, `txt` на `txt-tint`. Это фирменный приём.
- Тёплый подтон нейтралей — обязателен. Не заменяйте `#faf6f2` на чистый
  `#fafafa` — потеряется идентичность.

---

## 3. Типографика

### 3.1. Шрифтовые стеки

```css
/* основной текст интерфейса */
font: 14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
      Helvetica, Arial, sans-serif;
-webkit-font-smoothing: antialiased;

/* моноширинный (код, числа, формулы, endpoint-ы, бары, поле ввода) */
--mono: 'SF Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
```

### 3.2. Шкала размеров (полная)

| Роль | Размер / вес | Прочее |
|---|---|---|
| wordmark (лого) | 22px / **800** | `letter-spacing: -0.02em`, цвет `--ink` |
| tagline (слоган) | 12.5px / 400 | цвет `--muted` |
| hero-eyebrow | 11.5px / **700** | `uppercase`, `letter-spacing: 0.08em`, `--muted` |
| hero-headline | 28px / **700** | `letter-spacing: -0.02em`, `line-height: 1.1`, `--ink` |
| hero-num | 56px / **800** | `line-height: 1`, градиент-текст, `tabular-nums` |
| hero-sub | 14.5px / 400 | `--ink-2` |
| hero-meta | 12px / 400 | `--muted` |
| tile-label | 11.5px / **600** | `--ink-2` |
| tile-value | 26px / **800** | `--ink`, `tabular-nums`, `letter-spacing: -0.01em`, `line-height: 1.1` |
| tile-value.muted-val | 18px / **600** | `--muted` |
| tile-sub | 11.5px / 400 | `--muted` |
| section-head | 14px / **700** | `--ink` |
| section-sub | 12px / 400 | `--muted` |
| card-head | 12px / **700**, `uppercase` | `letter-spacing: 0.06em`, `--muted` |
| ctx-big | 22px / **800** | `--flame`, `tabular-nums` |
| formula | 11px / 1.55 | `var(--mono)`, `white-space: pre-wrap` |
| таблицы | 12px | `tabular-nums` в ячейках |
| pill / badge / chip | 11–12px / **600–700** | `tabular-nums` у pill |
| hint / axis / updated | 11px / 400 | `--muted` |
| toast | 12px / 400 | `--bad` |
| `.q` (вопросик) | 9px / **700** | в кружке 14px |
| `mk-create` | 9.5px / **700** | обводка текстом `--muted` |

### 3.3. Правила чисел

- Все числа, включая значения в таблицах и статистике, используют
  `font-variant-numeric: tabular-nums` (моноширинные цифры, не «прыгают» при
  обновлении).
- Колонки чисел в таблицах выравниваются по правому краю (класс `.num`).
- Формат тысяч — `en-US` с разделителем (напр. `13,709`), компактный формат
  заголовков — `12.3k`, `1.2M`.
- Активные элементы с `title="..."` показывают всплывающее объяснение.

---

## 4. Форма, радиусы, тени, эффекты

| Скругление | Применение |
|---|---|
| `--radius: 14px` | карточки, плитки, hero, drawer |
| 10px | split-колонки, empty-note |
| 9px | banner (аварийный), toast |
| 8px | кнопки, формулы, frame, src-pane, gallery `.pages`, drawer-кнопки |
| 7px | mini-btn (мелкие кнопки инспектора) |
| 6px | кнопка «Сжать», pair-head |
| 5px | bar-track / bar-fill |
| 4px | миниатюры `.page` |
| `999px` | пилюли, бейджи, чипы, switch-state |
| `50%` | flame-dot, live-dot, switch-dot, `.q` |

**Тени** — всегда мягкие, тёплого коричневого подтона (`rgba(60,35,15,…)` в
светлой; почти чёрные `rgba(0,0,0,…)` в тёмной). Тень — единственный признак
«поднятости» поверх поверхности.

**Градиенты** (все диагональные `135deg` или горизонтальные `90deg`, тёплые):
- фон hero: `linear-gradient(135deg, var(--flame-tint), var(--surface) 60%)`
- градиентный текст hero-num (положительный): `135deg, #ff9a4d → flame 55% → flame-strong`
- градиентный текст hero-num (отрицательный): `135deg, #f0857a → var(--bad)`
- заливка баров: `90deg, #ffa766 → var(--flame)`
- flame-dot: `radial-gradient(circle at 35% 30%, #ffd0a8, flame 55%, flame-strong)`
- split-img: `linear-gradient(180deg, var(--img-tint), var(--surface) 40%)`
- split-txt: `linear-gradient(180deg, var(--txt-tint), var(--surface) 40%)`

Градиентный текст реализуется через
`background-clip: text; color: transparent` (+ префикс `-webkit-`).

**Разделители:** сплошная линия `1px solid var(--border)` у строк/ячеек;
пунктирная `1px dashed var(--border-strong)` у мета-блока hero и у «пустых»
состояний (`empty-note`, `evicted`). Акцент слева у hero — сплошная полоса
`4px` (flame, у отрицательного — `--bad`). Акцент сверху у split-колонок —
полоса `3px` (`--img` / `--txt`).

---

## 5. Лейаут, сетки и брейкпоинты

```css
body {
  margin: 0;
  padding: 22px 26px 64px;   /* боковые поля 26px, нижнее 64px */
  background: var(--bg);
  color: var(--ink-2);
}
```

**Горизонтальный поток страницы** (сверху вниз):
1. `.topbar` — бренд слева (flame-dot + wordmark + tagline), справа кнопка темы
   + блок kill-switch; `flex; space-between; gap: 16px; margin-bottom: 18px`.
2. Блоки моделей (3 строки `.models`).
3. `.hero` — заголовок сессии.
4. `.strip` — ряд из 4 статистических плиток.
5. Секция «Что произошло с вашим контекстом» — двухколоночный `.xray`
   (слева таблица последних запросов, справа разбивка + инспектор).
6. Секция «Лучшие сессии» — карточка с барами.
7. Секция «Полная история» — карточка с таблицей статистики.
8. Секция «Сжатие текста» — карточка с textarea + кнопкой.
9. Фиксированный `.tray` с тостами в правом нижнем углу.

**Сетки:**

| Класс | Сетка | Брейкпоинты |
|---|---|---|
| `.strip` | `repeat(4, 1fr)`, gap 14px, margin-bottom 14px | ≤1000px → 2 колонки; ≤560px → 1 колонка |
| `.xray` | `1.15fr 1fr`, gap 16px | ≤1000px → 1 колонка |
| `.split` | `1fr 1fr`, gap 10px | ≤560px → 1 колонка |
| `.math-grid` | `repeat(2, 1fr)`, gap 12px | ≤860px → 1 колонка |
| `.models` | flex, `wrap`, gap 8px, margin `0 0 18px` | |
| `.pages` | flex, `wrap`, gap 6px | |
| `.legend` | flex, gap 8px | |

**Отступы секций:** `.section { margin-top: 26px }`. Заголовок секции —
`.section-head` + `.section-sub` через `gap: 10px` на одной строке
(`align-items: baseline`).

---

## 6. Компоненты (каталог)

Ниже — каждый компонент с точными стилями. `var()` ссылается на переменные из
раздела 2.

### 6.1. Topbar и бренд

```css
.topbar { display: flex; align-items: flex-start; justify-content: space-between;
  gap: 16px; flex-wrap: wrap; margin-bottom: 18px; }
.brand  { display: flex; align-items: center; gap: 12px; }
.flame-dot { width: 14px; height: 14px; border-radius: 50%;
  background: radial-gradient(circle at 35% 30%, #ffd0a8, var(--flame) 55%, var(--flame-strong));
  box-shadow: 0 0 0 4px var(--flame-tint); flex: none; }
.wordmark { font-size: 22px; font-weight: 800; color: var(--ink); letter-spacing: -0.02em; }
.tagline  { font-size: 12.5px; color: var(--muted); margin-top: 1px; max-width: 460px; }
.controls { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
```

**flame-dot** — фирменный знак: 14px «шарик пламени» с глянцевым бликом в
верхней левой трети и ореолом `4px` цвета `--flame-tint`. Тот же градиент —
в фавиконе (см. 7).

### 6.2. Кнопки

```css
/* стандартная (switch-btn / theme-btn) */
background: var(--surface); color: var(--ink);
border: 1px solid var(--border-strong); border-radius: 8px;
padding: 6px 13px; font: inherit; font-size: 12px; font-weight: 600;
box-shadow: var(--shadow);
.switch-btn:hover, .theme-btn:hover { border-color: var(--flame); color: var(--flame-ink); }

/* theme-btn — чуть компактнее: padding 5px 11px, inline-flex, gap 6px, line-height 1 */

/* mini-btn (инспектор) */
font-size: 11px; background: var(--surface); color: var(--flame-ink);
border: 1px solid var(--border-strong); border-radius: 7px;
padding: 3px 9px; font-weight: 600;
.mini-btn:hover { border-color: var(--flame); }

/* главная кнопка «Сжать» (inline) */
background: var(--flame); color: #fff; border: none; border-radius: 6px;
padding: 8px 20px; cursor: pointer; font-weight: 600;
```

Паттерн: нейтральная поверхность + рамка, на hover — **рамка становится flame и
текст становится flame-ink**. Единственная «залитая» цветом кнопка — главная
(flame, белый текст).

### 6.3. Kill-switch (переключатель сжатия)

```css
.banner { background: var(--bad-tint); border: 1px solid #f3b6af; border-radius: 9px;
  color: #9c2b20; font-size: 12px; max-width: 520px; padding: 9px 13px; margin: 0 0 8px; }
.banner strong { color: #8a2117; }
.switch { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; justify-content: flex-end; }
.switch-state { display: inline-flex; align-items: center; gap: 6px; font-size: 12px;
  font-weight: 600; padding: 3px 10px; border-radius: 999px; }
.switch-state.on  { color: var(--good); background: var(--good-tint); }
.switch-state.off { color: var(--bad);  background: var(--bad-tint); }
.switch-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.hint { color: var(--muted); font-size: 11px; }
```

### 6.4. Чипы моделей

```css
.models { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0 0 18px; }
.models-label { color: var(--ink-2); font-size: 12px; font-weight: 600; }
.chip { background: var(--surface); color: var(--ink-2); border: 1px solid var(--border-strong);
  border-radius: 999px; padding: 4px 12px; cursor: pointer; font: inherit; font-size: 12px; }
.chip:hover { border-color: var(--flame); color: var(--flame-ink); }
.chip.on { background: var(--flame-tint); color: var(--flame-ink); border-color: var(--flame); font-weight: 600; }
```

Активный чип помечается суффиксом `✓`. Неактивные чипы — пилюли с поверхностью;
активные — flame-тинт с flame-рамкой.

### 6.5. Hero (главный заголовок сессии)

```css
.hero { background: linear-gradient(135deg, var(--flame-tint), var(--surface) 60%);
  border: 1px solid var(--border); border-left: 4px solid var(--flame);
  border-radius: var(--radius); padding: 20px 24px; box-shadow: var(--shadow); }
.hero-neg { border-left-color: var(--bad); }
.hero-eyebrow { font-size: 11.5px; font-weight: 700; letter-spacing: 0.08em;
  text-transform: uppercase; color: var(--muted); margin-bottom: 8px; }
.hero-headline { font-size: 28px; font-weight: 700; color: var(--ink);
  letter-spacing: -0.02em; line-height: 1.1; }
.hero-num { font-size: 56px; font-weight: 800; line-height: 1; margin-right: 8px;
  background: linear-gradient(135deg, #ff9a4d, var(--flame) 55%, var(--flame-strong));
  -webkit-background-clip: text; background-clip: text; color: transparent;
  font-variant-numeric: tabular-nums; }
.hero-neg .hero-num { background: linear-gradient(135deg, #f0857a, var(--bad));
  -webkit-background-clip: text; background-clip: text; color: transparent; }
.hero-sub { font-size: 14.5px; color: var(--ink-2); margin-top: 12px; max-width: 720px; }
.hero-meta { font-size: 12px; color: var(--muted); margin-top: 10px; padding-top: 10px;
  border-top: 1px dashed var(--border-strong); }
.hero-empty .hero-headline { color: var(--muted); font-size: 24px; }
```

Ключевое: **56px градиентная цифра** — визуальное ядро дашборда. При
отрицательном результате меняется цвет левой полосы (`--bad`) и градиент цифры.

### 6.6. Статистические плитки (strip)

```css
.tile { background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 14px 16px; box-shadow: var(--shadow); }
.tile-label { font-size: 11.5px; font-weight: 600; color: var(--ink-2); margin-bottom: 8px;
  display: flex; align-items: center; gap: 5px; }
.tile-value { font-size: 26px; font-weight: 800; color: var(--ink);
  font-variant-numeric: tabular-nums; letter-spacing: -0.01em; line-height: 1.1; }
.tile-value.pos { color: var(--good); } .tile-value.neg { color: var(--bad); }
.tile-value.muted-val { color: var(--muted); font-size: 18px; font-weight: 600; }
.tile-sub { font-size: 11.5px; color: var(--muted); margin-top: 6px; }
.q { display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px;
  border-radius: 50%; background: var(--surface-2); border: 1px solid var(--border-strong);
  color: var(--muted); font-size: 9px; font-weight: 700; cursor: help; }
```

Значение может быть: обычным (`--ink`), положительным (`good`), отрицательным
(`bad`) или «сбор данных…» (`muted-val`).

### 6.7. Drawer «Показать формулы и расчёты»

```css
.drawer { margin: 0 0 14px; background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); box-shadow: var(--shadow); overflow: hidden; }
.drawer > summary { cursor: pointer; user-select: none; list-style: none; padding: 12px 16px;
  font-size: 13px; font-weight: 600; color: var(--flame-ink); display: flex; align-items: center; gap: 8px; }
.drawer > summary::-webkit-details-marker { display: none; }
.drawer > summary::before { content: '▸'; color: var(--flame); font-size: 11px; }
.drawer[open] > summary::before { content: '▾'; }
.drawer > summary:hover { background: var(--surface-2); }
.drawer-intro { padding: 0 16px 10px; font-size: 12px; color: var(--ink-2); }
.drawer-intro em { color: var(--flame-ink); font-style: normal; font-weight: 600; }
.math-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; padding: 0 16px 16px; }
.math-block h4 { margin: 0 0 6px; font-size: 12px; color: var(--ink); }
.formula { background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px;
  padding: 9px 11px; font: 11px/1.55 var(--mono); color: var(--ink-2);
  white-space: pre-wrap; word-break: break-word; }
.formula .k   { color: var(--muted); }
.formula .v   { color: var(--ink); }
.formula .op  { color: var(--flame); }   /* знак = */
.formula .sp  { height: 6px; }
.formula .src { color: var(--muted); font-size: 10px; display: block; margin-top: 7px;
  border-top: 1px solid var(--border); padding-top: 6px; }
.updated { font-size: 11px; color: var(--muted); display: flex; align-items: center; gap: 6px; }
.live-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--good); animation: pulse 2s infinite; }
@keyframes pulse { 50% { opacity: 0.35; } }
```

Раскрывашка — нативных `<details>/<summary>`, стрелка `▸/▾` flame-цвета.

### 6.8. Секции и карточки

```css
.section { margin-top: 26px; }
.section-head { font-size: 14px; font-weight: 700; color: var(--ink); margin: 0 0 12px;
  display: flex; align-items: baseline; gap: 10px; }
.section-sub { font-size: 12px; font-weight: 400; color: var(--muted); }
.card { background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 16px 18px; box-shadow: var(--shadow); min-width: 0; }
.card-head { font-size: 12px; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.06em; color: var(--muted); margin: 0 0 12px; }
.card-head.spaced { margin-top: 22px; padding-top: 16px; border-top: 1px solid var(--border); }
```

### 6.9. Контекст-карта (разбивка изображение ⇄ текст)

```css
.empty-note { color: var(--muted); font-size: 12.5px; padding: 14px; background: var(--surface-2);
  border: 1px dashed var(--border-strong); border-radius: 10px; }
.ctx-headline { font-size: 13px; color: var(--ink-2); margin-bottom: 10px; }
.ctx-title { display: inline-block; font-weight: 700; color: var(--ink); margin-right: 6px; }
.ctx-big { font-size: 22px; font-weight: 800; color: var(--flame); font-variant-numeric: tabular-nums; }
.legend { display: flex; gap: 8px; margin-bottom: 10px; }
.tag { font-size: 11px; font-weight: 600; padding: 3px 9px 3px 22px; border-radius: 999px; position: relative; }
.tag::before { content: ''; position: absolute; left: 9px; top: 50%; transform: translateY(-50%);
  width: 8px; height: 8px; border-radius: 2px; }
.tag-img { background: var(--img-tint); color: var(--img-ink); }
.tag-img::before { background: var(--img); }
.tag-txt { background: var(--txt-tint); color: var(--txt-ink); }
.tag-txt::before { background: var(--txt); }
.split { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.split-col { border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; background: var(--surface); }
.split-img { border-top: 3px solid var(--img); background: linear-gradient(180deg, var(--img-tint), var(--surface) 40%); }
.split-txt { border-top: 3px solid var(--txt); background: linear-gradient(180deg, var(--txt-tint), var(--surface) 40%); }
.split-head { font-size: 12px; font-weight: 700; color: var(--ink); margin-bottom: 8px; display: flex;
  flex-direction: column; gap: 2px; }
.split-sum { font-size: 10.5px; font-weight: 600; color: var(--muted); }
.ctx-row { display: flex; justify-content: space-between; gap: 10px; font-size: 12px; padding: 4px 0;
  border-bottom: 1px solid var(--border); }
.ctx-row:last-of-type { border-bottom: none; }
.ctx-lbl { color: var(--ink-2); } .ctx-val { color: var(--ink); font-variant-numeric: tabular-nums; white-space: nowrap; }
.muted-row { color: var(--muted); font-style: italic; }
.split-note { font-size: 10.5px; color: var(--muted); margin-top: 7px; }
.pages-title { font-size: 11px; color: var(--ink-2); margin: 12px 0 6px; }
.pages { display: flex; flex-wrap: wrap; gap: 6px; max-height: 320px; overflow: auto;
  background: var(--surface-2); padding: 6px; border: 1px solid var(--border); border-radius: 8px; }
.page { height: 130px; width: auto; max-width: 230px; object-fit: contain; object-position: top left;
  image-rendering: pixelated; background: #fff; border: 1px solid var(--border-strong); border-radius: 4px;
  cursor: pointer; transition: border-color .12s, transform .12s; }
.page:hover { border-color: var(--flame); transform: translateY(-1px); }
.page.page-gone { width: 150px; height: 56px; background: var(--surface-2);
  border: 1px dashed var(--border-strong); color: var(--muted); font-size: 10px; cursor: default; }
```

Миниатюры PNG показываются с `image-rendering: pixelated` на белом фоне — это
отсылка к тому, что контент — настоящие изображения.

### 6.10. Таблица последних запросов (и общая таблица)

```css
table.rtable, table.dtable { width: 100%; border-collapse: collapse; font-size: 12px; }
.rtable th, .dtable th { text-align: left; color: var(--muted); font-weight: 600; padding: 7px 8px;
  border-bottom: 1px solid var(--border-strong); white-space: nowrap; }
.rtable td, .dtable td { padding: 7px 8px; border-bottom: 1px solid var(--border);
  font-variant-numeric: tabular-nums; vertical-align: middle; color: var(--ink-2); }
.rtable tr:last-child td, .dtable tr:last-child td { border-bottom: none; }
.rtable tbody tr:hover { background: var(--surface-2); }
th.num, td.num { text-align: right; }
td.pos { color: var(--good); font-weight: 600; }
td.neg { color: var(--bad); font-weight: 600; }
.endp { color: var(--ink); font-family: var(--mono); font-size: 11px; }   /* endpoint */
.empty-cell { color: var(--muted); text-align: center; padding: 18px; }
.pill { display: inline-block; min-width: 38px; text-align: center; font-size: 11px; font-weight: 700;
  padding: 2px 8px; border-radius: 999px; font-variant-numeric: tabular-nums; }
.pill-good { background: var(--good-tint); color: var(--good); }
.pill-warn { background: var(--warn-tint); color: var(--warn); }
.pill-bad  { background: var(--bad-tint); color: var(--bad); }
.badge { font-size: 10.5px; font-weight: 700; padding: 2px 8px; border-radius: 999px; }
.badge-img { background: var(--img-tint); color: var(--img-ink); }   /* «изобр.» */
.badge-txt { background: var(--txt-tint); color: var(--txt-ink); }   /* «текст» */
.mk-create { font-size: 9.5px; font-weight: 700; color: var(--muted); border: 1px solid var(--muted);
  border-radius: 999px; padding: 0 5px; margin-left: 4px; vertical-align: 1px; cursor: help; white-space: nowrap; }
.row-view { color: var(--flame-ink); font-weight: 600; text-decoration: none; cursor: pointer; white-space: nowrap; }
.row-view:hover { text-decoration: underline; }
```

Статусные пилюли (код ответа): `2xx → pill-good`, `4xx → pill-warn`,
`5xx → pill-bad`. Широкие таблицы скроллятся горизонтально внутри карточки
(`overflow-x: auto`), строки не переносятся.

### 6.11. Инспектор «изображение ⇄ исходник»

```css
.viewer-bar { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.mini-label { font-size: 11px; color: var(--muted); }
.frame { background: #fff; border: 1px solid var(--border-strong); border-radius: 8px; padding: 5px;
  overflow: auto; max-height: 360px; scrollbar-width: thin; }
.frame img { display: block; width: auto; height: auto; max-width: none; image-rendering: pixelated; }
.frame-sm { max-height: 260px; }
.viewer-caption { font-size: 11px; color: var(--muted); margin-top: 8px; display: flex;
  align-items: center; gap: 10px; flex-wrap: wrap; }
.pairing { display: grid; grid-template-columns: 1fr; gap: 10px; margin-top: 10px; }
.pair-head { font-size: 11px; font-weight: 700; padding: 3px 9px; border-radius: 6px; display: inline-block; margin-bottom: 6px; }
.pair-img { background: var(--img-tint); color: var(--img-ink); }
.pair-txt { background: var(--txt-tint); color: var(--txt-ink); }
.pair-mid { font-size: 11px; font-weight: 600; color: var(--muted); text-align: center; }
.src-pane { margin: 0; max-height: 280px; overflow: auto; background: var(--surface-2);
  border: 1px solid var(--border); border-radius: 8px; padding: 9px; font: 11px/1.45 var(--mono);
  white-space: pre-wrap; word-break: break-word; color: var(--ink-2); }
.evicted { font-size: 11.5px; color: var(--muted); padding: 12px; background: var(--surface-2);
  border: 1px dashed var(--border-strong); border-radius: 8px; }
```

### 6.12. Бары сессий

```css
.status { margin-bottom: 12px; color: var(--muted); font-size: 12px; }
.bars { display: flex; flex-direction: column; gap: 8px; }
.bar-row { display: flex; align-items: center; gap: 12px; font-size: 12px; }
.bar-label { width: 150px; flex: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--ink); font-family: var(--mono); font-size: 11px; }
.bar-track { flex: 1; min-width: 0; height: 16px; background: var(--surface-2); border-radius: 5px;
  overflow: hidden; border: 1px solid var(--border); }
.bar-fill { height: 100%; border-radius: 5px 0 0 5px;
  background: linear-gradient(90deg, #ffa766, var(--flame)); }
.bar-val { width: 78px; flex: none; text-align: right; font-variant-numeric: tabular-nums;
  color: var(--flame-ink); font-weight: 600; }
.bar-val.neg { color: var(--bad); }
.axis { margin-top: 12px; color: var(--muted); font-size: 11px; }
.empty { text-align: center; color: var(--muted); padding: 22px; font-size: 12px; }
```

### 6.13. Тосты (уведомления об ошибках)

```css
.tray { position: fixed; bottom: 16px; right: 16px; display: flex; flex-direction: column; gap: 8px;
  z-index: 1000; pointer-events: none; }
.toast { background: var(--surface); color: var(--bad); border: 1px solid #f0b3ab; border-radius: 9px;
  padding: 10px 14px; font-size: 12px; box-shadow: 0 8px 24px rgba(60,35,15,.14); display: flex;
  align-items: center; gap: 12px; pointer-events: auto; max-width: 360px; }
.toast button { background: transparent; color: inherit; border: 0; cursor: pointer; font-size: 16px;
  line-height: 1; padding: 0; }
```

Тосты показываются только для ошибок (цвет `--bad`). Авто-скрытие — 5 с.

### 6.14. Пустые состояния

- **Hero без данных:** класс `hero-empty`, заголовок «Прогрев…» muted, 24px,
  текст-инструкция в `hero-sub`.
- **Таблица без запросов:** строка с `empty-cell`.
- **Нет изображений / нет разбора:** `empty-note` («Нажмите *Подробнее*…»).
- **Удалённые данные:** `evicted` («изображение #N удалено из буфера»).
- **Пропавшие миниатюры:** `.page-gone` (пунктирная рамка, подпись).

---

## 7. Иконки и графика

- **flame-dot** (логотип-точка): 14×14, радиальный градиент
  `circle at 35% 30%`, цвета `#ffd0a8 → flame → flame-strong`, внешнее свечение
  `0 0 0 4px var(--flame-tint)`.
- **Фавикон** — тот же мотив: SVG 32×32, круг r=15.5 залит `--flame-tint`
  (`#fff1ea`) как ореол, внутри круг r=10 с радиальным градиентом (cx 35%,
  cy 30%, r 80%): стопы `#ffd0a8` → `#ff5a1f` → `#e8420a`.
- **Стрелки drawer:** `▸` / `▾`, цвет `--flame`, размер 11px.
- **Кнопка темы:** текст `☾ Тёмная` / `☀ Светлая` (emoji-символы).
- **Живая точка:** `.live-dot` 7px, `--good`, анимация `pulse 2s infinite`.
- **Точки статусов:** `.switch-dot` (7px, цвет текущего состояния), квадратики
  в `.tag` (8×8, `border-radius: 2px`, цвет категории).
- **Числа:** везде `tabular-nums`; значки `✓` на активных чипах; `create`
  мини-значок с обводкой.

---

## 8. Поведение и взаимодействие

- **Лайв-обновление** фрагментов по таймеру (htmx): topbar/hero/таблицы — каждые
  2 с; агрегаты (сессии, история) — каждые 5 с; контекст-карта и поле сжатия —
  по загрузке и событиям.
- **Hover-паттерны:** кнопки/чипы → рамка flame + текст flame-ink; строки таблиц
  → фон `--surface-2`; миниатюры → рамка flame + подъём `translateY(-1px)` за
  `.12s`; ссылки «Details →» → подчёркивание.
- **Активный элемент vs неактивный:** чипы — `flame-tint` + flame-рамка + `✓`;
  switch — пилюля с точкой (on: `good`, off: `bad`).
- **Состояние «Сбор данных…»:** значение плитки `muted-val` («сбор данных…») +
  `title` с пояснением минимальной выборки.
- **Тёмная тема:** сохраняется в `localStorage['pp-theme']`; задаётся до первой
  отрисовки скриптом в `<head>`; по умолчанию — системная
  `prefers-color-scheme`.
- **Подтверждение опасного действия:** выключение сжатия требует
  `hx-confirm` (нативный браузерный confirm) с объяснением последствий.

---

## 9. Дополнение: стиль отрисовываемых PNG (страницы контента)

Проект дополнительно рендерит текст в PNG-изображения (это его основная
функция). Если ваш проект тоже «отрисовывает» контент в картинки — используйте
этот стиль как канон пиксельного рендера:

- **Цвет:** чёрный текст на белом фоне (grayscale). Рендер «white-on-black»,
  затем инвертируется в «black-on-white».
- **Клетка глифа:** 5×8 px (ячейка `ATLAS_CELL_W=5`, `ATLAS_CELL_H=8`), без
  межбуквенных отступов. CJK-символы — двойная ширина (10px).
- **Шрифты:** Spleen 5x8 (битовый, для ASCII/кода) + Unifont 16.0.04 @ 8px
  (фолбэк для Unicode/CJK). В assets также лежит JetBrains Mono Regular.
- **Внутренние отступы страницы:** 4px по всем сторонам.
- **Размеры страницы:** плотный контент — 312 колонок → ширина `8 + 312·5 =
  1568px`, высота `8 + n·8` (до 728px, затем пагинация на новую картинку).
- **Разметка переносов:** оригинальные переносы строк помечаются глифом
  `↵` (U+21B5), табы превращаются в `→` + пробелы до следующей позиции таба.
- **Структура диалога (опционально):** теги `<user>`/`<assistant>` красятся
  зелёным/синим (палитра `ROLE_PALETTE`), тело остаётся чёрным.
- **Графика PNG:** цветовая модель grayscale 8-bit (обычный рендер) или
  RGB truecolor (при включении цвета), без сглаживания в продакшене, `filter=None`.

---

## 10. Быстрый старт для нового проекта (шпаргалка)

1. Скопируйте блок `:root` из раздела 2.1 и, при необходимости, `:root[data-theme="dark"]`
   из 2.2 в свой `:root`.
2. Скачайте системный стек шрифтов из 3.1; для моноширинного — стек `--mono`.
3. Задайте `body`: тёплый фон `--bg`, текст `--ink-2`, антиалиасинг, отступы
   `22px 26px 64px`.
4. Соберите layout: топбар с `flame-dot` + wordmark, hero с градиентной цифрой,
   strip из плиток, секции с `card`, при необходимости — бары и таблицы.
5. Кнопки — по шаблону 6.2 (нейтральная + flame на hover); одна главная — flame.
6. Пилюли/бейджи/чипы — `999px` радиус + tint-фон + цветной текст по смыслу.
7. Пустые состояния — `empty-note` с пунктирной рамкой.
8. Все числа — `tabular-nums`, правая колонка `.num`, компактные `k/M`.
9. Проверьте обе темы; в тёмной акценты должны быть ярче.

## 11. Исходники для сверки

| Файл | Что содержит |
|---|---|
| `src/dashboard/fragments.ts` | весь CSS + HTML-компоненты (канон) |
| `src/dashboard/vendor.ts` | вендоренные HTMX и Alpine |
| `src/dashboard/types.ts` | типы данных фрагментов |
| `src/dashboard.ts` | серверная агрегация статистики |
| `src/core/render.ts` | рендер PNG (клетка, палитры, инверсия) |
| `src/core/atlas.ts` | предсобранный атлас глифов (Spleen 5x8 + Unifont 8px) |
| `docs/example-render.png` | образец отрисованной страницы |
