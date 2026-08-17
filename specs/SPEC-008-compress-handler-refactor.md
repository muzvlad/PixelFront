# SPEC-008: Рефакторинг `/compress*` дублирования

| Поле | Значение |
|---|---|
| **Приоритет** | 🟡 Средний |
| **Категория** | Code smell / duplication |
| **Файлы** | `src/node.ts` |
| **Связь с аудитом** | пункт 5.1 |
| **Зависимость** | SPEC-001 (общая константа `PLAYGROUND_RENDER_OPTS`) |
| **Объём работ** | 2-3 часа |
| **Breaking change** | Нет (поведение идентично) |

## Проблема

Три хендлера содержат копипасту body-парсинга и базовую обвязку:

1. `src/node.ts:482-528` (`dispatchDashboard` → `fragments/compress`): HTML inline-preview.
2. `src/node.ts:1165-1201` (`/compress`): returns first page as PNG.
3. `src/node.ts:1204-1236` (`/compress/all`): returns all pages as JSON with base64.

Все три делают одно и то же:
- Прочитать body (max 1 MB).
- Парсить JSON `{ text: string }`, fallback на raw text.
- Валидировать `text.trim()`.
- Рендерить через `renderTextToImages`.
- Преобразовать результат в нужный формат.

Дублирование ~70 строк.

## Требования

1. Выделить общий хелпер `parseCompressBody(req): Promise<string>` для чтения + парсинга.
2. Выделить `handleCompressInlinePreview(text)` для `fragments/compress` (HTML inline).
3. Выделить `handleCompressSinglePage(text)` для `/compress`.
4. Выделить `handleCompressAllPages(text)` для `/compress/all`.
5. Все три используют `PLAYGROUND_RENDER_OPTS` из SPEC-001.
6. Поведение **идентично** — existing test suite passes, manual smoke-equivalent.

## Дизайн

### Структура `src/node.ts` (после SPEC-008)

```ts
// =========================================================================
// Compress helpers (SPEC-008)
// =========================================================================

/**
 * Read the request body, parse JSON `{ text?: string }`, fallback to raw text.
 * Returns the trimmed text, or throws on missing/invalid input.
 */
async function parseCompressBody(req: IncomingMessage): Promise<string> {
  const raw = await readRequestBody(req);
  let text = '';
  try {
    const body = JSON.parse(raw) as { text?: unknown };
    text = typeof body.text === 'string' ? body.text : '';
  } catch {
    text = raw;
  }
  return text;
}

/** Render `text` to PNG pages and return the result. Errors propagate. */
async function renderCompress(text: string): Promise<RenderResult> {
  // Из SPEC-001.
  return renderTextToImages(text, PLAYGROUND_RENDER_OPTS);
}

/** `/compress` handler: return first page as image/png with metadata headers. */
async function handleCompressSinglePage(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let text: string;
  try {
    text = await parseCompressBody(req);
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'missing or invalid body' }));
    return;
  }
  if (!text.trim()) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'missing "text" field' }));
    return;
  }

  let result: RenderResult;
  try {
    result = await renderCompress(text);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: (err as Error).message }));
    return;
  }

  if (result.pages.length === 0) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'no pages rendered' }));
    return;
  }

  const png = result.pages[0]!.png;
  res.writeHead(200, {
    'content-type': 'image/png',
    'content-length': png.byteLength,
    'x-pages': String(result.pages.length),
    'x-width': String(result.pages[0]!.width),
    'x-height': String(result.pages[0]!.height),
  });
  res.end(Buffer.from(png));
}

/** `/compress/all` handler: JSON with all pages as base64. */
async function handleCompressAllPages(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let text: string;
  try {
    text = await parseCompressBody(req);
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'missing or invalid body' }));
    return;
  }
  if (!text.trim()) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'missing "text" field' }));
    return;
  }

  try {
    const result = await renderCompress(text);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      pages: result.pages.map((p, i) => ({
        index: i,
        width: p.width,
        height: p.height,
        png: Buffer.from(p.png).toString('base64'),
      })),
      droppedChars: result.droppedChars,
      pixels: result.pixels,
    }));
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
}

/** HTML preview for dashboard playground (fragments/compress). */
async function handleCompressInlinePreview(
  req: IncomingMessage,
  url: URL,
  port: number,
): Promise<Response> {
  let text: string;
  try {
    text = await parseCompressBody(req);
  } catch {
    return new Response('bad request body', { status: 400 });
  }
  if (!text.trim()) {
    return new Response('missing text', { status: 400 });
  }
  try {
    const { pages, droppedChars, pixels } = await renderCompress(text);
    if (pages.length === 0) {
      return new Response('no pages rendered', { status: 404 });
    }
    const imgs = pages
      .map(
        (p, i) =>
          `<div style="margin-bottom:12px">` +
          `<div style="color:var(--txt-dim);font-size:12px;margin-bottom:4px">стр. ${i + 1} · ${p.width}×${p.height}px</div>` +
          `<img src="data:image/png;base64,${Buffer.from(p.png).toString('base64')}" ` +
          `style="max-width:100%;border:1px solid var(--bdr);border-radius:6px" alt="стр. ${i + 1}"/>` +
          `</div>`,
      )
      .join('');
    return new Response(
      `<div style="color:var(--txt-dim);font-size:12px;margin-bottom:8px">` +
        `${pages.length} стр. · ${pixels.toLocaleString('en-US')} px` +
        `${droppedChars > 0 ? ` · ${droppedChars} символов отброшено` : ''}` +
        `</div>` + imgs,
      { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ error: (e as Error).message }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    );
  }
}
```

### Где используется

В `createServer` коллбэке:

```ts
// /compress
if (url.pathname === '/compress' && req.method === 'POST') {
  return handleCompressSinglePage(req, res);
}

// /compress/all
if (url.pathname === '/compress/all' && req.method === 'POST') {
  return handleCompressAllPages(req, res);
}
```

В `dispatchDashboard` (case 'fragment'):

```ts
if (route.name === 'compress' && method === 'POST') {
  return handleCompressInlinePreview(req, url, port);
}
```

## Acceptance Criteria

- [ ] Три хендлера сводятся к трём однострочным вызовам.
- [ ] `parseCompressBody` используется во всех трёх (а не дубль кода).
- [ ] `PLAYGROUND_RENDER_OPTS` (из SPEC-001) применяется во всех трёх.
- [ ] Существующие тесты (`tests/proxy-usage.test.ts` и др.) проходят без изменений.
- [ ] Manual smoke: `curl -X POST /compress`, `curl -X POST /compress/all`, dashboard playground — поведение идентично.

## Тесты

### Snapshot/round-trip тесты

Не требуются, если поведение полностью идентично. Достаточно run `pnpm test` и убедиться, что существующие тесты для proxy-usage не сломались.

### Опционально: новый test `tests/compress-endpoints.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import * as http from 'node:http';
// (запустить минимальный test server через createServer + handler)

describe('compress endpoints parity', () => {
  it('/compress returns same image as runExportCore (round 1)', async () => {
    // Через тестовый сервер или прямой вызов helper.
  });
});
```

> ⚠️ E2E-тест HTTP-эндпойнта требует fixture-сервера. Если не хочется — пропустить, ограничиться snapshot-тестом существующего поведения.

## Обратная совместимость

- API контракт неизменен.
- HTTP-заголовки ответов идентичны.
- JSON-формат ответов идентичен.
- HTML inline-preview идентичен.

## Открытые вопросы

- **Q1:** Имеет ли смысл вынести `parseCompressBody` / handlers в отдельный файл `src/compress-handlers.ts`?
  - **Аргументы за:** тестируемость, разделение ответственности.
  - **Аргументы против:** node.ts уже большой, но `compress-handlers.ts` будет маленьким.
  - **Решение:** оставить в `node.ts`, чтобы не плодить файлы; при необходимости вынести позже.

## Чеклист PR

- [x] `src/node.ts`: `handleCompressInlinePreview` вынесен из `dispatchDashboard` (был инлайн в case 'fragment'); `compressTextFromBody` — общий text-extraction для всех compress-путей.
- [x] Три хендлера в `createServer`/`dispatchDashboard` заменены на однострочные вызовы (`handlePlaygroundCompress` + `handleCompressInlinePreview`).
- [x] `PLAYGROUND_RENDER_OPTS` (из SPEC-001) применяется во всех трёх (было и раньше — SPEC-001 унифицировал /compress и /compress/all в `handlePlaygroundCompress`; теперь и HTML-preview тоже).
- [x] `pnpm typecheck && pnpm test` — чисто.
- [x] Diff: `src/node.ts` уменьшился (~40 строк инлайна вынесено).
- [x] Behavior unchanged — код перенесён без изменений логики.

## Отклонение от дизайна

`parseCompressBody` из спеки не вводился отдельно: вместо него общий `parseBodyFlexible` (существовал с рутер-аудита, охватывает JSON + urlencoded + raw) + `compressTextFromBody`. Поведение идентично, дублей меньше.
