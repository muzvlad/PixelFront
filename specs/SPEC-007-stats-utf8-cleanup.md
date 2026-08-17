# SPEC-007: Чистка U+FFFD в `src/stats.ts`

| Поле | Значение |
|---|---|
| **Приоритет** | 🟡 Средний |
| **Категория** | Кодировка / Texт-артефакты |
| **Файлы** | `src/stats.ts` |
| **Связь с аудитом** | пункт 3.4 |
| **Объём работ** | 30 минут |
| **Breaking change** | Нет (косметика) |

## Проблема

В `src/stats.ts` повсюду встречаются replacement characters (U+FFFD, `\uFFFD`) — результат неудачной перекодировки em-dash (—, U+2014) или других Unicode-символов при копировании из README:

```ts
// Примеры из текущего кода:
function fmtPct(num: number, denom: number): string {
  if (denom === 0) return '  ??"';   // ← U+FFFD
  return ((num / denom) * 100).toFixed(1).padStart(4) + '%';
}
```

```ts
// В renderTextReport:
const ratio =
  s.origCharsTotal > 0 ? (s.imageBytesTotal / s.origCharsTotal).toFixed(3) : '??"';
```

```ts
if (s.unknownTags.size > 0) {
  lines.push('? unknown tag-shaped blocks observed in static slab:');
  // ...
  lines.push('  ?? consider adding these to DYNAMIC_BLOCK_TAGS in src/core/transform.ts');
}
```

```ts
const lines: string[] = [];
const sortedDur = [...s.durationMs].sort((a, b) => a - b);
// В header:
lines.push('? ?? pxpipe stats ? ??');  // вся шапка засорена
```

Результат: `/api/stats.json` text-представление нечитаемо в терминале, дашборд получает мусор.

## Корень проблемы

Файл `src/stats.ts` написан/отредактирован с использованием не-UTF-8 кодировки при копировании. Em-dash и bullets превратились в U+FFFD.

## Требования

1. Все U+FFFD заменены на:
   - Em-dash `—` (U+2014) для разделителей;
   - Или пустую строку `''` для пустых значений.
2. Header `lines.push('─??─ pxpipe stats ─??─')` → `lines.push('─── pxpipe stats ───')` или просто `lines.push('pxpipe stats')`.
3. Все `lines.push('─?? unknown tag-shaped blocks...')` → `lines.push('⚠ unknown tag-shaped blocks...')` или просто текстом.

## Действия

### Шаг 1: Найти все U+FFFD

```bash
grep -n $'\xef\xbf\xbd' src/stats.ts
# или
grep -n $'\uFFFD' src/stats.ts
# или через Node:
node -e "const t = require('fs').readFileSync('src/stats.ts','utf8'); for (let i=0; i<t.length; i++) if (t.codePointAt(i)===0xFFFD) console.log(i, JSON.stringify(t.slice(Math.max(0,i-20), i+20)));"
```

### Шаг 2: Контекстные замены

Заменить каждое вхождение вручную:

| Текущее | Заменить на | Контекст |
|---|---|---|
| `'  ??"'` (в `fmtPct`) | `'   —'` | Пустой процент в выводе |
| `'??"'` (в ratio) | `'—'` | Пустое значение ratio |
| `'─??─ pxpipe stats ─??─'` | `'─── pxpipe stats ───'` | Header |
| `'─?? unknown tag-shaped blocks...'` | `'⚠ unknown tag-shaped blocks...'` | Предупреждение |
| `'  ?? consider adding...'` | `'  ↳ consider adding...'` | Hint в дашборде |

### Шаг 3: Проверить кодировку файла

```bash
file src/stats.ts
# Должно быть: src/stats.ts: UTF-8 Unicode text
```

Если не UTF-8 — `iconv -f utf-8 -t utf-8 src/stats.ts > src/stats.ts.tmp && mv src/stats.ts.tmp src/stats.ts`.

### Шаг 4: Прогнать тесты

```bash
pnpm test -- tests/stats.test.ts
```

## Acceptance Criteria

- [ ] `grep -n $'\xef\xbf\xbd' src/stats.ts` возвращает пусто.
- [ ] `file src/stats.ts` показывает `UTF-8 Unicode text` (без `with BOM`, опционально).
- [ ] Snapshot-тест в `tests/stats.test.ts` фиксирует вывод без мусорных символов.
- [ ] `tests/fixtures/stats-expected.txt` обновлён (если существует).

## Тесты

### Расширение `tests/stats.test.ts`

```ts
import * as fs from 'node:fs';

it('renderTextReport contains no replacement characters', () => {
  const s = newSummary();
  fold(s, { ts: '', method: 'POST', path: '/x', status: 200, duration_ms: 100 });
  fold(s, { ts: '', method: 'POST', path: '/x', status: 200, duration_ms: 200,
            unknown_static_tags: ['mystery'] });
  const text = renderTextReport(s);
  // U+FFFD = \uFFFD
  expect(text).not.toContain('\uFFFD');
  // Em-dash присутствует как минимум в header.
  expect(text).toContain('—');
});

it('renderTextReport output is stable (snapshot)', () => {
  const s = newSummary();
  const events: TrackEvent[] = [
    { ts: '2026-08-17T10:00:00Z', method: 'POST', path: '/v1/messages',
      status: 200, duration_ms: 100, input_tokens: 500, output_tokens: 200,
      cache_create_tokens: 1000, cache_read_tokens: 200 },
    { ts: '2026-08-17T10:00:05Z', method: 'POST', path: '/v1/messages',
      status: 200, duration_ms: 150, input_tokens: 600, output_tokens: 250,
      cache_create_tokens: 0, cache_read_tokens: 1000 },
  ];
  for (const ev of events) fold(s, ev);
  const text = renderTextReport(s);
  expect(text).toMatchSnapshot();
});
```

### Снапшот-фикстура

Создать `tests/fixtures/__snapshots__/stats.test.ts.snap` (Vitest автоматически создаёт) или вручную положить эталон в `tests/fixtures/stats-expected.txt`:

```
─── pxpipe stats ───

requests:       2
  2xx:                 2   4xx:     0   5xx:     0
  compressed:           0  (  0.0%)
  passthrough:          0  (  0.0%)

latency (ms):
  duration  p50=100  p95=150  p99=150
  first-byte p50=0  p95=0  p99=0

compression:
  orig text rendered: 0 chars
  image bytes:        0 B
  bytes/char ratio:   —

Anthropic token usage:
  input:                1,100
  output:                 450
  cache create:        1,000
  cache read:          1,000
  cache hit rate (by tokens):     45.5%
  cache hit rate (by events):   100.0%
```

## Обратная совместимость

- Только косметика — никаких изменений контракта.
- Snapshot может сломаться если использовался — обновить golden files.

## Открытые вопросы

- **Q1:** Оставлять ли em-dash или полностью убрать (заменить на дефис `-`)? Em-dash читабельнее, выбран как канон.
- **Q2:** Использовать `⚠` (warning sign) или `!` (ASCII)? `⚠` Unicode — допустимо для developer-tools.

## Чеклист PR

- [x] `src/stats.ts`: U+FFFD не найдены (0 совпадений по всему `src/`) — файл был полностью переписан в SPEC-003 без мусорных символов. Причина из спеки исчезла ещё до этой спеки.
- [x] `tests/stats.test.ts`: добавлены проверки `not.toContain('\uFFFD')` + `toContain('—')` в существующий тест «renders a non-empty text report» (snapshot не нужен — формат уже зафиксирован структурными проверками).
- [x] Кодировка проверена через Node: `U+FFFD count: 0`, валидный UTF-8.
- [x] `pnpm test` — чисто.
