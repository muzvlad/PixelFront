/**
 * Node entrypoint — `node:http` server + minimal CLI flag parsing.
 *
 * Wraps the runtime-agnostic `createProxy` from src/core/proxy.ts. The
 * heavy lifting (transform, render, PNG) is identical to the Worker
 * version; only the request/response plumbing differs.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { renderTextToImages } from './core/library.js';
import { createProxy, parseGatewayHeaders, resolveUpstreams, type ProxyConfig, type CompatibleProvider } from './core/proxy.js';
import {
  parseExportArgv,
  runExportCore,
  type ExportParsed,
  type ExportResult,
} from './core/export.js';
import { readExportTextFile } from './export-collect.js';
import {
  toTrackEvent,
  TRACK_BODY_INLINE_MAX,
  type Tracker,
  type TrackEvent,
} from './core/tracker.js';
import {
  DashboardState,
  dashboardPath,
  type DashboardRoute,
} from './dashboard.js';
import { setActiveTracker } from './tracker-coordinator.js';
import { validateConfig, buildWalkSkipDirs } from './config.js';
import { FileTracker } from './core/trackers/file-tracker.js';

/** Runtime config. The core transform tuning comes from DEFAULTS in
 *  transform.ts; startup knobs cover deployment plus emergency GPT scope
 *  control. No CLI flags beyond --help/--version. */
interface RuntimeConfig {
  port: number;
  /** Interface to bind. Defaults to 127.0.0.1 (loopback only) — the dashboard
   *  is unauthenticated and serves captured request context, so it must not be
   *  exposed to the LAN by default. Set HOST=0.0.0.0 to opt into all interfaces
   *  (e.g. reaching the dashboard from another device / the host of a container). */
  host: string;
  upstream: string;
  openAIUpstream: string;
  openAIApiKey?: string;
  compatibleProviders?: CompatibleProvider[];
  provider?: 'cloudflare-ai-gateway';
  gatewayBaseUrl?: string;
  gatewayHeaders?: Record<string, string>;
  eventsFile: string;
}

const DEFAULT_CONFIG_FILE = path.join(os.homedir(), '.config', 'pxpipe', 'config.json');

function applyConfigFileDefaults(): void {
  const file = process.env.PXPIPE_CONFIG ?? DEFAULT_CONFIG_FILE;
  if (!fs.existsSync(file)) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch (e) {
    console.warn(`[pxpipe] ignored invalid config ${file}: ${(e as Error).message}`);
    return;
  }
  const cfg = validateConfig(parsed);
  if (!cfg) return;

  // Env wins over file config. The dashboard can still override the scope at
  // runtime (in-memory) for an emergency live flip.
  if (cfg.models !== undefined && process.env.PXPIPE_MODELS === undefined) {
    process.env.PXPIPE_MODELS = cfg.models;
  }
}

function parseCli(argv: string[]): RuntimeConfig {
  // Only flags accepted are --help and --version. Anything else is an
  // error — there is exactly ONE way to run pxpipe and the dashboard
  // exposes every metric the operator might want to inspect.
  for (const a of argv) {
    if (a === '-h' || a === '--help') {
      printHelp();
      process.exit(0);
    }
    if (a === '--version') {
      printVersion();
      process.exit(0);
    }
    if (a.startsWith('-')) {
      console.error(`[pxpipe] unknown option: ${a}`);
      console.error(`[pxpipe] this build accepts no flags; run \`pxpipe --help\` for env vars`);
      process.exit(2);
    }
  }
  applyConfigFileDefaults();
  const sharedUpstream = process.env.PXPIPE_UPSTREAM;
  return {
    port: Number(process.env.PORT ?? 47821),
    // Loopback by default; opt into all-interfaces exposure explicitly via HOST.
    host: process.env.HOST?.trim() || '127.0.0.1',
    upstream: process.env.ANTHROPIC_UPSTREAM ?? sharedUpstream ?? 'https://api.anthropic.com',
    openAIUpstream: process.env.OPENAI_UPSTREAM ?? sharedUpstream ?? 'https://api.openai.com',
    openAIApiKey: process.env.OPENAI_API_KEY,
    compatibleProviders: buildCompatibleProviders(),
    provider: parseProvider(process.env.PXPIPE_PROVIDER),
    gatewayBaseUrl: process.env.PXPIPE_GATEWAY_BASE_URL,
    gatewayHeaders: parseGatewayHeaders(process.env.PXPIPE_GATEWAY_HEADERS),
    eventsFile:
      process.env.PXPIPE_LOG ??
      path.join(os.homedir(), '.pxpipe', 'events.jsonl'),
  };
}

/**
 * Build compatible provider list from env vars.
 * Each provider needs an upstream URL; API key is optional (forwarded from client if unset).
 *
 * GO-subscription users (no explicit API keys — auth is forwarded from OpenCode)
 * route through the OpenCode Zen gateway at https://opencode.ai/zen/v1
 * (the OpenAI-compatible endpoint used by the `opencode` provider for
 * `deepseek-*` / `mimo-*` models). When a DEEPSEEK or MIMO key or upstream
 * override is set, we route to the direct provider API instead
 * (api.deepseek.com / api.xiaomimimo.com).
 */
function buildCompatibleProviders(): CompatibleProvider[] | undefined {
  // pxpipe appends `/v1/chat/completions` itself, so the base is the gateway
  // origin + `/zen` (no trailing `/v1`).
  const GO_UPSTREAM = 'https://opencode.ai/zen';
  const providers: CompatibleProvider[] = [];
  const dsUpstream = process.env.DEEPSEEK_UPSTREAM ?? (process.env.DEEPSEEK_API_KEY ? 'https://api.deepseek.com' : GO_UPSTREAM);
  const dsKey = process.env.DEEPSEEK_API_KEY;
  providers.push({
    modelPrefix: 'deepseek',
    upstream: dsUpstream,
    apiKey: dsKey,
  });
  const mimoUpstream = process.env.MIMO_UPSTREAM ?? (process.env.MIMO_API_KEY ? 'https://api.xiaomimimo.com' : GO_UPSTREAM);
  const mimoKey = process.env.MIMO_API_KEY;
  providers.push({
    modelPrefix: 'mimo',
    upstream: mimoUpstream,
    apiKey: mimoKey,
    // Direct Xiaomi MiMo API uses the `api-key` header; the GO gateway is
    // OpenAI-compatible and expects `Authorization: Bearer`, so only use the
    // api-key style when a direct key is configured.
    authStyle: mimoKey ? 'api-key' : undefined,
  });
  // MiniMax M3 — multimodal (image-capable), so pxpipe may compress it. GO
  // subscriptions route through the GO gateway at opencode.ai/zen/go (the
  // flat-subscription endpoint that actually serves MiniMax M3; the Zen
  // workspace endpoint /zen bills it against paid balance and 401s when the
  // balance is empty). A direct MINIMAX_API_KEY switches to api.minimaxi.com's
  // OpenAI-compatible endpoint. pxpipe appends `/v1/chat/completions`, so the
  // direct base omits the `/v1` suffix.
  const GO_ANTHROPIC_UPSTREAM = 'https://opencode.ai/zen/go';
  const miniUpstream = process.env.MINIMAX_UPSTREAM ?? (process.env.MINIMAX_API_KEY ? 'https://api.minimaxi.com' : GO_ANTHROPIC_UPSTREAM);
  const miniKey = process.env.MINIMAX_API_KEY;
  providers.push({
    modelPrefix: 'minimax',
    upstream: miniUpstream,
    apiKey: miniKey,
  });
  return providers.length > 0 ? providers : undefined;
}

function parseProvider(v: string | undefined): 'cloudflare-ai-gateway' | undefined {
  if (v === undefined || v === '') return undefined;
  if (v === 'cloudflare-ai-gateway') return v;
  console.error(`[pxpipe] unknown PXPIPE_PROVIDER: ${v}`);
  process.exit(2);
}

function printHelp(): void {
  console.log(`pxpipe — прокси для экономии токенов

Использование:
  pxpipe                запустить прокси (без флагов)
  pxpipe export [...]   отрисовать файлы/diff в PNG страницы + отчёт о стоимости

Прокси сжимает инструменты, схемы, напоминания, результаты инструментов
и историю диалога; записывает события на диск; измеряет экономию через
/v1/messages/count_tokens. Управление сжатием через дашборд в реальном времени.

Статистика, сессии и инструменты очистки — в дашборде:
  http://127.0.0.1:<порт>/  (по умолчанию 47821)

Флаги:
  -h, --help              показать эту справку
      --version           показать версию

Переменные окружения:
  PORT                    порт (по умолчанию 47821)
  HOST                    интерфейс (по умолчанию 127.0.0.1, только loopback).
                          0.0.0.0 — доступ с других устройств (дашборд без авторизации!)
  PXPIPE_UPSTREAM         базовый URL API для всех семейств
  ANTHROPIC_UPSTREAM      базовый URL Anthropic; перезаписывает PXPIPE_UPSTREAM
                           (по умолчанию https://api.anthropic.com)
  OPENAI_UPSTREAM         базовый URL OpenAI; перезаписывает PXPIPE_UPSTREAM
                           (по умолчанию https://api.openai.com)
  OPENAI_API_KEY          ключ OpenAI (если не задан, пробрасывается от клиента)
  DEEPSEEK_UPSTREAM       базовый URL DeepSeek. По умолчанию для пользователей
                           подписки OpenCode GO (без DEEPSEEK_API_KEY) —
                           https://opencode.ai/zen (шлюз opencode-провайдера);
                           иначе https://api.deepseek.com
  DEEPSEEK_API_KEY        ключ DeepSeek; если задан, upstream = api.deepseek.com
  MIMO_UPSTREAM           базовый URL MiMo. По умолчанию для пользователей
                           подписки OpenCode GO (без MIMO_API_KEY) —
                           https://opencode.ai/zen (шлюз opencode-провайдера);
                           иначе https://api.xiaomimimo.com
  MIMO_API_KEY            ключ MiMo; если задан, upstream = api.xiaomimimo.com
  MINIMAX_UPSTREAM        базовый URL MiniMax. По умолчанию для пользователей
                           подписки OpenCode GO (без MINIMAX_API_KEY) —
                           https://opencode.ai/zen/go (шлюз подписки GO);
                           иначе https://api.minimaxi.com
  MINIMAX_API_KEY         ключ MiniMax; если задан, upstream = api.minimaxi.com
  PXPIPE_PROVIDER         'cloudflare-ai-gateway' — проксировать через шлюз
  PXPIPE_GATEWAY_BASE_URL базовый URL шлюза (обязателен с PXPIPE_PROVIDER)
  PXPIPE_GATEWAY_HEADERS  доп. заголовки: JSON объект или k=v;k2=v2
  PXPIPE_MODELS           модели через запятую для сжатия (Claude + GPT + DeepSeek + MiMo + MiniMax);
                          по умолчанию claude-fable-5,gpt-5.6,deepseek-v4-pro,deepseek-v4-flash,
                          deepseek-v4-flash-free,deepseek-v3,mimo-v2.5-pro,mimo-v2.5,minimax-m3; off — выкл
  PXPIPE_CONFIG           путь к JSON конфигу (по умолчанию ~/.config/pxpipe/config.json)
  PXPIPE_LOG              путь к JSONL журналу (по умолчанию ~/.pxpipe/events.jsonl)
  PXPIPE_DUMP_DIR         отладка: сохранять PNG сюда; off если не задано

Использование с Claude Code:
  ANTHROPIC_BASE_URL=http://127.0.0.1:47821 claude

Использование с OpenAI-совместимыми клиентами:
  OPENAI_BASE_URL=http://127.0.0.1:47821/v1

Использование с DeepSeek (прямой API):
  DEEPSEEK_API_KEY=ваш_ключ OPENAI_BASE_URL=http://127.0.0.1:47821/v1

Использование с DeepSeek V4 Flash Free (подписка OpenCode GO):
  OPENAI_BASE_URL=http://127.0.0.1:47821/v1   (ключ пробрасывается из OpenCode)

Использование с MiMo:
  MIMO_API_KEY=ваш_ключ OPENAI_BASE_URL=http://127.0.0.1:47821/v1
`);
}

// Package version, inlined at bundle time by scripts/build.mjs via esbuild
// `define`. Under a non-bundled dev runner (tsx) the identifier is not defined;
// `typeof` returns "undefined" instead of throwing (ECMA-262 §13.5.3), so the
// guard is safe. `npm_package_version` is only a dev fallback: npm sets it just
// inside its own run-script env, so for `npx pxpipe-proxy` or a global bin it is
// undefined (or reflects the *consumer's* package), never this tool's version.
declare const __PXPIPE_VERSION__: string | undefined;

function printVersion(): void {
  const injected = typeof __PXPIPE_VERSION__ === 'string' ? __PXPIPE_VERSION__ : undefined;
  console.log(injected ?? process.env.npm_package_version ?? 'unknown');
}

// ---- Playground render options (SPEC-001) ---------------------------------

/**
 * Опции рендера для playground-эндпойнтов:
 *   - /compress
 *   - /compress/all
 *   - dashboard: /fragments/compress (handleCompressInlinePreview)
 *
 * Зеркало production-пути в src/core/export.ts:runExportCore (shrink: true,
 * multiCol: 'auto', reflow: true). Если production изменится — обновить и эту
 * константу.
 *
 * НЕ ДОБАВЛЯТЬ сюда отличия от production (например, multiCol: 1) — это
 * приведёт к рассогласованию preview и реального рендера: пользователь
 * увидит в дашборде страницу в 2× шире, чем модель получит в продакшене.
 */
const PLAYGROUND_RENDER_OPTS = {
  reflow: true,
  shrink: true,
  multiCol: 'auto' as const,
} as const;

// ---- node:http <-> Web Request/Response bridge ---------------------------

function toWebRequest(req: IncomingMessage): Request {
  const proto = (req.headers['x-forwarded-proto'] as string) ?? 'http';
  const host = req.headers.host ?? 'localhost';
  const url = `${proto}://${host}${req.url ?? '/'}`;

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v == null) continue;
    if (Array.isArray(v)) v.forEach((vv) => headers.append(k, vv));
    else headers.append(k, v);
  }

  const method = req.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD';

  // Buffer the body — proxy needs to read /v1/messages bodies fully anyway,
  // and Node's IncomingMessage → ReadableStream conversion has duplex quirks.
  let body: BodyInit | undefined;
  if (hasBody) {
    body = new ReadableStream<Uint8Array>({
      start(controller) {
        req.on('data', (chunk) => controller.enqueue(chunk));
        req.on('end', () => controller.close());
        req.on('error', (e) => controller.error(e));
      },
    });
  }

  return new Request(url, {
    method,
    headers,
    body,
    // @ts-expect-error — duplex is required for streamed request bodies in Node 18+
    duplex: hasBody ? 'half' : undefined,
  });
}

function isConnectionAbort(err: unknown): boolean {
  const e = err as {
    name?: unknown;
    message?: unknown;
    code?: unknown;
    cause?: { code?: unknown; message?: unknown };
  };
  const name = typeof e?.name === 'string' ? e.name : '';
  const code = typeof e?.code === 'string'
    ? e.code
    : typeof e?.cause?.code === 'string'
      ? e.cause.code
      : '';
  const message = typeof e?.message === 'string' ? e.message : '';
  const causeMessage = typeof e?.cause?.message === 'string' ? e.cause.message : '';
  return name === 'AbortError' ||
    code === 'UND_ERR_SOCKET' ||
    code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    message === 'client response closed' ||
    message === 'terminated' ||
    message.includes('aborted') ||
    causeMessage.includes('other side closed');
}

async function waitForDrain(out: ServerResponse): Promise<void> {
  const event = await Promise.race([
    once(out, 'drain').then(() => 'drain'),
    once(out, 'close').then(() => 'close'),
  ]);
  if (event === 'close') throw new Error('client response closed');
}

async function writeWebResponse(res: Response, out: ServerResponse): Promise<void> {
  out.statusCode = res.status;
  res.headers.forEach((v, k) => out.setHeader(k, v));
  if (!res.body) {
    out.end();
    return;
  }
  const reader = res.body.getReader();
  let finished = false;
  const cancelBody = () => {
    if (!finished) void reader.cancel().catch(() => undefined);
  };
  out.once('close', cancelBody);
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value && !out.write(value)) await waitForDrain(out);
    }
    if (!out.writableEnded) out.end();
  } catch (err) {
    if (isConnectionAbort(err) || out.destroyed || out.writableEnded) {
      if (!out.destroyed && !out.writableEnded) out.destroy(err instanceof Error ? err : undefined);
      return;
    }
    throw err;
  } finally {
    finished = true;
    out.off('close', cancelBody);
    reader.releaseLock();
  }
}

/** Read the entire request body as text. Bounded at 1 MiB — every dashboard
 *  POST is tiny JSON (a few hundred bytes). The cap is a defense against a
 *  pathological/malicious client; legitimate proxy traffic doesn't hit these
 *  routes. */
async function readRequestBody(req: IncomingMessage): Promise<string> {
  const MAX = 1024 * 1024;
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const b = chunk as Buffer;
    bytes += b.byteLength;
    if (bytes > MAX) throw new Error('request body too large');
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Parse a small dashboard body that arrives as either JSON (htmx `hx-vals`),
 *  form-urlencoded (standard form submit / `hx-include`), or plain text (for
 *  /fragments/compress where the body is a transcript). Returns the raw text
 *  plus the JSON object (if it parsed as a non-array object) and a
 *  URLSearchParams view of the same string (empty for JSON bodies). Call sites
 *  pick whichever representation carries the field they need. */
async function parseBodyFlexible(
  req: IncomingMessage,
): Promise<{ raw: string; json: Record<string, unknown> | null; url: URLSearchParams }> {
  const raw = await readRequestBody(req);
  let json: Record<string, unknown> | null = null;
  try {
    const v: unknown = JSON.parse(raw);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      json = v as Record<string, unknown>;
    }
  } catch {
    // not JSON — urlencoded fallback handled by `url`
  }
  return { raw, json, url: new URLSearchParams(raw) };
}

/**
 * Dispatch a matched DashboardRoute to the appropriate handler. Returns
 * undefined when the method/route combination doesn't apply so the caller
 * can fall through to the upstream proxy (e.g. a GET path that's only
 * defined for POST). Keeps the createServer body small + readable.
 */
async function dispatchDashboard(
  dashboard: DashboardState,
  route: DashboardRoute,
  req: IncomingMessage,
  url: URL,
  port: number,
): Promise<Response | undefined> {
  const method = req.method ?? 'GET';
  switch (route.kind) {
    case 'html':
      if (method !== 'GET') return undefined;
      return dashboard.serveHtml(port);
    case 'stats':
      if (method !== 'GET') return undefined;
      return dashboard.serveStats();
    case 'recent':
      if (method !== 'GET') return undefined;
      return dashboard.serveRecent();
    case 'png': {
      if (method !== 'GET') return undefined;
      const idRaw = url.searchParams.get('id');
      const idNum = idRaw != null ? Number(idRaw) : NaN;
      return dashboard.servePng(Number.isFinite(idNum) ? idNum : undefined);
    }
    case 'api-image-source': {
      if (method !== 'GET') return undefined;
      const idRaw = url.searchParams.get('id');
      const idNum = idRaw != null ? Number(idRaw) : NaN;
      return dashboard.serveImageSource(Number.isFinite(idNum) ? idNum : undefined);
    }
    case 'api-sessions': {
      if (method !== 'GET') return undefined;
      return dashboard.serveSessionsJson({
        project: url.searchParams.get('project') ?? undefined,
        since: url.searchParams.get('since') ?? undefined,
      });
    }
    case 'api-stats':
      if (method !== 'GET') return undefined;
      return dashboard.serveApiStats();
    case 'current-session':
      if (method !== 'GET') return undefined;
      return dashboard.serveCurrentSessionJson();
    case 'fragment': {
      // /fragments/toggle is the one mutating fragment - htmx POSTs the next
      // state (urlencoded hx-vals or JSON), the server flips the switch and
      // returns the re-rendered toggle markup.
      if (route.name === 'toggle' && method === 'POST') {
        let body: { raw: string; json: Record<string, unknown> | null; url: URLSearchParams };
        try {
          body = await parseBodyFlexible(req);
        } catch {
          return new Response('bad request body', { status: 400 });
        }
        const enabled = body.json?.enabled === true || body.url.get('enabled') === 'true';
        dashboard.handleCompressionToggle({ enabled });
        return dashboard.serveFragment('toggle', url, port);
      }
      // /fragments/models POSTs one chip flip: {model, on}. Server mutates the
      // runtime compress scope and returns the re-rendered chip row.
      if (route.name === 'models' && method === 'POST') {
        let body: { raw: string; json: Record<string, unknown> | null; url: URLSearchParams };
        try {
          body = await parseBodyFlexible(req);
        } catch {
          return new Response('bad request body', { status: 400 });
        }
        const model =
          typeof body.json?.model === 'string' ? body.json.model : body.url.get('model') ?? '';
        const on = body.json?.on === true || body.url.get('on') === 'true';
        if (model) dashboard.handleModelsToggle(model, on);
        return dashboard.serveFragment('models', url, port);
      }
      // /fragments/compress POSTs {text} from the "Сжать текст в PNG"
      // playground — render it to PNG page(s) and return the preview HTML.
      if (route.name === 'compress' && method === 'POST') {
        return handleCompressInlinePreview(req);
      }
      if (method !== 'GET') return undefined;
      return dashboard.serveFragment(route.name, url, port);
    }
    case 'api-compression': {
      if (method !== 'POST') {
        return new Response(
          JSON.stringify({ error: 'use POST' }),
          { status: 405, headers: { 'content-type': 'application/json' } },
        );
      }
      let body: Record<string, unknown> = {};
      try {
        const raw = await readRequestBody(req);
        body = raw ? JSON.parse(raw) : {};
      } catch (e) {
        return new Response(
          JSON.stringify({ error: 'bad request body', detail: (e as Error).message }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        );
      }
      return dashboard.handleCompressionToggle({ enabled: body.enabled });
    }
    case 'playground-compress':
      return handlePlaygroundCompress(req, /* allPages */ false);
    case 'playground-compress-all':
      return handlePlaygroundCompress(req, /* allPages */ true);
  }
}

/** Text to render from a flexible compress body: JSON `{text}` preferred,
 *  raw fallback (plain-text transcript body). Shared by all /compress paths. */
function compressTextFromBody(
  body: { raw: string; json: Record<string, unknown> | null },
): string {
  return typeof body.json?.text === 'string' ? body.json.text : body.raw;
}

/** Manual playground: POST { "text": "..." } → rendered PNG(s).
 *  Same renderer as the dashboard's /fragments/compress (PLAYGROUND_RENDER_OPTS)
 *  but as a standalone JSON/PNG endpoint so curl users can pipe text straight in
 *  without htmx. Centralised here so the `/compress` and `/compress/all` shapes
 *  can't drift apart — both call renderTextToImages with identical opts. */
async function handlePlaygroundCompress(
  req: IncomingMessage,
  allPages: boolean,
): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'use POST' }),
      { status: 405, headers: { 'content-type': 'application/json' } },
    );
  }
  let body: { raw: string; json: Record<string, unknown> | null; url: URLSearchParams };
  try {
    body = await parseBodyFlexible(req);
  } catch {
    return new Response(
      JSON.stringify({ error: 'bad request body' }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
  }
  const text = compressTextFromBody(body);
  if (!text) {
    return new Response(
      JSON.stringify({ error: 'missing "text" field' }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
  }
  try {
    const { pages, droppedChars, pixels } = await renderTextToImages(text, PLAYGROUND_RENDER_OPTS);
    if (allPages) {
      return new Response(
        JSON.stringify({
          pages: pages.map((p, i) => ({
            index: i,
            width: p.width,
            height: p.height,
            png: Buffer.from(p.png).toString('base64'),
          })),
          droppedChars,
          pixels,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (pages.length === 0) {
      return new Response(
        JSON.stringify({ error: 'no pages rendered' }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      );
    }
    const png = pages[0]!.png;
    return new Response(Buffer.from(png), {
      status: 200,
      headers: {
        'content-type': 'image/png',
        'content-length': String(png.byteLength),
        'x-pages': String(pages.length),
        'x-width': String(pages[0]!.width),
        'x-height': String(pages[0]!.height),
      },
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ error: (e as Error).message }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    );
  }
}

/** HTML preview for the dashboard playground (`/fragments/compress` POST):
 *  renders {text} with the same PLAYGROUND_RENDER_OPTS as /compress and
 *  /compress/all, returning inline <img> tags with page metadata. */
async function handleCompressInlinePreview(req: IncomingMessage): Promise<Response> {
  let body: { raw: string; json: Record<string, unknown> | null; url: URLSearchParams };
  try {
    body = await parseBodyFlexible(req);
  } catch {
    return new Response('bad request body', { status: 400 });
  }
  const text = compressTextFromBody(body);
  if (!text.trim()) {
    return new Response('missing text', { status: 400 });
  }
  try {
    const { pages, droppedChars, pixels } = await renderTextToImages(text, PLAYGROUND_RENDER_OPTS);
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

// ---- 4xx body sidecar writer ---------------------------------------------

/**
 * For oversized 4xx body samples that won't fit inline in the JSONL row, we
 * write them to a sidecar file at `<dir>/${ts}-${sha8}.json.gz`. The path
 * lands in the event as `req_body_sample_path`. Survives log rotation and
 * stays out of the streaming dashboard.
 *
 * Failure mode: directory unwritable or write fails → returns undefined and
 * the body sample is silently dropped (we still keep the sha8 and error_body
 * for diagnostics; the request itself was never blocked by this).
 */
async function maybeWriteBodySidecar(
  bytesGz: Uint8Array,
  sha8: string | undefined,
  dir: string,
): Promise<string | undefined> {
  try {
    // Lazy mkdir — only when we actually need to write.
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return undefined;
  }
  // Filename: timestamp + sha8 keeps collisions effectively impossible and
  // makes the file naturally sortable. Sha8 fallback covers the edge case
  // where the hash wasn't computed (zero-byte body, etc.).
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const tag = sha8 ?? 'nohash';
  const filePath = path.join(dir, `${ts}-${tag}.json.gz`);
  try {
    await fs.promises.writeFile(filePath, bytesGz);
    return filePath;
  } catch {
    return undefined;
  }
}

// ---- pxpipe export -------------------------------------------------------

function printExportHelp(): void {
  console.log(`pxpipe export — render code/text to PNG pages for compressed LLM context

Usage:
  pxpipe export [target ...]    default target is "." (current directory)

Targets:
  Files or directories to include. Multiple targets are joined with a header
  separator line. Defaults to "." when none are given.

Options:
  --include <glob>   include only files matching glob (repeatable)
  --exclude <glob>   exclude files matching glob (repeatable)
  --git              render "git diff HEAD" plus untracked files
  --diff <ref>       render "git diff <ref>"
  --stdin            read source text from stdin instead of files
  --out <dir>        base output directory (default \$TMPDIR or /tmp)
  --model <id>       model id for vision-token estimate (default claude-sonnet-4-5)
  --json             print report as JSON
  --open             reveal the output folder when done (macOS) so you can
                     drag the PNG pages straight into your chat
  -h, --help         show this help

Output:
  <out>/pxpipe-export-<hash>/
    page-001.png ...  rendered image pages
    factsheet.txt     verbatim precision tokens (paths, SHAs, ids, numbers)
    manifest.json     metadata + token report
    prompt.txt        paste-ready agent instruction referencing the images

Report columns:
  text tokens   approximate tokens if the source were sent as plain text
  image tokens  estimated tokens to send the rendered PNG pages
  % saved       (text − image) / text × 100

Environment variables:
  PXPIPE_SKIP_DIRS   comma-separated extra dirs to skip during the walk
                     (defaults: node_modules, .git, .svn, .hg, dist, build,
                     __pycache__, .cache, .next, .nuxt, .turbo). Add e.g.
                     ".venv,target,vendor" for Python/Rust/Go projects.

Examples:
  pxpipe export .                              # whole directory
  pxpipe export --include "*.ts" src/          # TypeScript files only
  pxpipe export --git                          # uncommitted changes
  pxpipe export --diff HEAD~3                  # last 3 commits
  pxpipe export --open src/                    # render src/, then reveal the folder
  cat big-file.txt | pxpipe export --stdin
`);
}

/** Directories never descended into when walking files. Defaults ∪
 *  PXPIPE_SKIP_DIRS (see buildWalkSkipDirs in config.ts). */
const WALK_SKIP_DIRS = buildWalkSkipDirs();

interface CollectedFile {
  relPath: string;
  content: string;
}

/** Recursively walk a directory, collecting text files that pass include/exclude filters. */
function walkDir(
  dir: string,
  rootDir: string,
  include: string[],
  exclude: string[],
  out: CollectedFile[],
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(rootDir, full).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      if (WALK_SKIP_DIRS.has(entry.name)) continue;
      walkDir(full, rootDir, include, exclude, out);
    } else if (entry.isFile()) {
      // Bulk directory walk: skip silently on any gate miss (per-file warnings
      // would be noise across a whole tree).
      const r = readExportTextFile(full, rel, include, exclude);
      if (r.kind === 'ok') out.push({ relPath: rel, content: r.content });
    }
  }
}

/** Collect files from a list of targets (files or directories). */
function collectFilesFromTargets(
  targets: string[],
  include: string[],
  exclude: string[],
): CollectedFile[] {
  const files: CollectedFile[] = [];
  for (const target of targets) {
    let st: fs.Stats;
    try { st = fs.statSync(target); } catch {
      console.warn(`[pxpipe export] skipping inaccessible target: ${target}`);
      continue;
    }
    if (st.isDirectory()) {
      walkDir(target, target, include, exclude, files);
    } else if (st.isFile()) {
      const rel = path.basename(target);
      const r = readExportTextFile(target, rel, include, exclude);
      if (r.kind === 'ok') files.push({ relPath: rel, content: r.content });
      else if (r.kind !== 'excluded') {
        console.warn(`[pxpipe export] skipping ${r.kind} file: ${target}`);
      }
    }
  }
  return files;
}

/** Run a git command in `cwd`, return stdout string or null on failure. */
function gitRun(args: string[], cwd: string): string | null {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0 || result.error) return null;
  return result.stdout ?? null;
}

/** Collect source text for the export run. Returns [sourceText, sourceFiles[]] */
async function collectSource(opts: ExportParsed): Promise<[string, string[]]> {
  // --stdin
  if (opts.stdin) {
    const chunks: string[] = [];
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
      if (typeof chunk === 'string') chunks.push(chunk);
    }
    return [chunks.join(''), []];
  }

  // --diff <ref>
  if (opts.diff !== undefined) {
    const cwd = opts.targets.length > 0 ? opts.targets[0]! : process.cwd();
    const diff = gitRun(['diff', opts.diff], cwd);
    if (diff === null) {
      console.error(`[pxpipe export] git diff ${opts.diff} failed`);
      process.exit(1);
    }
    return [diff, []];
  }

  // --git
  if (opts.git) {
    const cwd = opts.targets.length > 0 ? opts.targets[0]! : process.cwd();
    const diff = gitRun(['diff', 'HEAD'], cwd) ?? '';
    // Collect untracked files
    const untrackedOut = gitRun(['ls-files', '--others', '--exclude-standard'], cwd) ?? '';
    const untrackedFiles = untrackedOut
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    let untracked = '';
    for (const rel of untrackedFiles) {
      const full = path.join(cwd, rel);
      // Same include/exclude + size + binary gate as directory mode. Untracked
      // files previously bypassed all of it: --include/--exclude were ignored
      // and an oversized file was read fully into memory.
      const r = readExportTextFile(full, rel, opts.include, opts.exclude);
      if (r.kind === 'ok') untracked += `\n===== ${rel} =====\n` + r.content;
      else if (r.kind !== 'excluded') {
        console.warn(`[pxpipe export] skipping ${r.kind} untracked file: ${rel}`);
      }
    }
    const sourceText = diff + untracked;
    return [sourceText, []];
  }

  // File/directory mode (default)
  const targets = opts.targets.length > 0 ? opts.targets : ['.'];
  const files = collectFilesFromTargets(targets, opts.include, opts.exclude);
  if (files.length === 0) {
    console.warn('[pxpipe export] no files collected');
  }
  const sourceText = files
    .map((f) => `===== ${f.relPath} =====\n${f.content}`)
    .join('\n\n');
  const sourceFiles = files.map((f) => f.relPath);
  return [sourceText, sourceFiles];
}

function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

function printExportReport(opts: ExportParsed, outDir: string, sourceFiles: string[], result: ExportResult): void {
  const { manifest } = result;
  const { tokenReport, pages } = manifest;
  const totalPngBytes = pages.reduce((s, p) => s + p.bytes, 0);

  if (opts.json) {
    process.stdout.write(
      JSON.stringify({
        outDir,
        fileCount: sourceFiles.length,
        sourceChars: manifest.sourceChars,
        pageCount: pages.length,
        totalPngBytes,
        textTokens: tokenReport.textTokens,
        imageTokens: tokenReport.imageTokens,
        percentSaved: tokenReport.percentSaved,
        factsheetItemCount: tokenReport.factsheetItemCount,
        factsheetDropped: tokenReport.factsheetDropped,
        model: manifest.model,
        cols: manifest.cols,
        generatedAt: manifest.generatedAt,
      }) + '\n',
    );
    return;
  }

  const saved = tokenReport.percentSaved;
  const savedStr = saved >= 0 ? `${saved.toFixed(1)}% saved` : `${Math.abs(saved).toFixed(1)}% more expensive`;
  const droppedNote = tokenReport.factsheetDropped > 0
    ? ` (${tokenReport.factsheetDropped} dropped)`
    : '';
  console.log(
    `\npxpipe export\n` +
    `  out:            ${outDir}\n` +
    `  files:          ${formatNumber(sourceFiles.length)}\n` +
    `  source chars:   ${formatNumber(manifest.sourceChars)}\n` +
    `  pages:          ${pages.length} (${formatNumber(totalPngBytes)} bytes)\n` +
    `  text tokens:    ~${formatNumber(tokenReport.textTokens)}\n` +
    `  image tokens:   ~${formatNumber(tokenReport.imageTokens)}  (${savedStr})\n` +
    `  factsheet:      ${tokenReport.factsheetItemCount} items${droppedNote}\n`,
  );
  console.log(
    `next — get this into your chat:\n` +
    `  1. attach the ${pages.length} page-*.png file${pages.length === 1 ? '' : 's'} from that folder\n` +
    `  2. paste prompt.txt alongside them (it tells the model what the images are)\n` +
    `     factsheet.txt has the verbatim paths / ids / numbers if you need exact strings\n` +
    (opts.open ? `  opening the folder…\n` : `  tip: add --open to reveal the folder automatically\n`),
  );
}

async function runExport(argv: string[]): Promise<void> {
  const parseResult = parseExportArgv(argv);

  if (parseResult.kind === 'help') {
    printExportHelp();
    process.exit(0);
  }
  if (parseResult.kind === 'error') {
    console.error(`[pxpipe export] ${parseResult.message}`);
    console.error(`[pxpipe export] run \`pxpipe export --help\` for usage`);
    process.exit(2);
  }

  const opts = parseResult.parsed;

  // Collect source text
  const [sourceText, sourceFiles] = await collectSource(opts);

  // Unique output dir: <out>/pxpipe-export-XXXXXX/. mkdtemp guarantees a fresh, random
  // directory so concurrent runs never collide and stale page-NNN.png never bleed in.
  fs.mkdirSync(opts.out, { recursive: true });
  const outDir = fs.mkdtempSync(path.join(opts.out, 'pxpipe-export-'));

  // Run core export
  const result = await runExportCore(sourceText, {
    sourceFiles,
    cols: opts.cols,
    model: opts.model,
  });

  // Write artifacts
  for (const artifact of result.artifacts) {
    fs.writeFileSync(path.join(outDir, artifact.filename), artifact.data);
  }

  // Print report
  printExportReport(opts, outDir, sourceFiles, result);

  // --open: reveal the output folder (macOS `open`) so the PNG pages can be
  // dragged straight into a chat. Best-effort; a failed open is non-fatal
  // since the report already printed the path.
  if (opts.open) {
    spawnSync('open', [outDir], { stdio: 'ignore' });
  }
}

// ---- main ----------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === 'export') {
    await runExport(argv.slice(1));
    return; // server never starts
  }
  // No subcommands — pxpipe is just the proxy. Stats / sessions / cleanup
  // tools live in the dashboard (see http://127.0.0.1:${port}/).
  const opts = parseCli(argv);
  // A/B harness passthrough switch (see the `transform` callback below).
  const forcePassthrough = /^(1|true|yes|on)$/i.test(process.env.PXPIPE_DISABLE ?? '');
  if (forcePassthrough) {
    console.log('[pxpipe] PXPIPE_DISABLE set — passthrough mode (compress=false), still logging usage + baselines');
  }
  // Debug aid: when PXPIPE_DUMP_DIR is set, persist every rendered PNG this
  // process emits, so you can eyeball exactly what the model received (OCR /
  // legibility audits, demo inspection). Best-effort — never affects requests.
  // Note: the PXPIPE_DISABLE arm renders nothing, so only the compress proxy
  // produces files here.
  let imageDumpDir: string | undefined = process.env.PXPIPE_DUMP_DIR?.trim() || undefined;
  let imageDumpSeq = 0;
  if (imageDumpDir) {
    try {
      fs.mkdirSync(imageDumpDir, { recursive: true });
      console.log(`[pxpipe] PXPIPE_DUMP_DIR set — dumping rendered PNGs to ${imageDumpDir}`);
    } catch (err) {
      console.warn(`[pxpipe] PXPIPE_DUMP_DIR unusable (${(err as Error).message}) — image dumping disabled`);
      imageDumpDir = undefined;
    }
  }
  // Transform options pass through empty — the proxy uses the DEFAULTS
  // baked into transform.ts. There are no behavior toggles: system slab,
  // reminders, tool_results, and history compression all run
  // unconditionally; the per-block break-even gate decides per-call
  // whether to actually image each piece. The function-form `transform`
  // below is ONLY a kill switch (PXPIPE_DISABLE / dashboard toggle →
  // compress:false); on the active path it returns {}, so the gate always
  // runs on static DEFAULTS — charsPerToken=4, priorWarm*=0 — which leaves
  // the warm-baseline and anti-flapping burn terms inert. That is
  // deliberate, NOT an oversight: there is no live-α feedback loop from
  // the dashboard. Telemetry (2026-06, 897 sessions / 21,347 measured
  // rows) showed 5 mode flips ever and losses at 0.8% of wins — all
  // one-time cache-create amortization — so closing the loop would not
  // change decisions. Re-run that reconciliation before wiring one in.
  const tracker: Tracker = new FileTracker(opts.eventsFile);
  // Register with the singleton coordinator so destructive ops like
  // sessions.ts:prune can wrap their rewrites in suspend/resume and avoid
  // losing events written during the rename window.
  setActiveTracker(tracker);

  // Periodic durability: write() hands chunks to the OS page cache; without
  // fsync a crash (OOM, kill -9) can lose the tail. Flush every
  // FLUSH_INTERVAL_MS when at least FLUSH_BYTES_THRESHOLD bytes accumulated.
  // .unref() so the timer never keeps the process alive.
  const FLUSH_INTERVAL_MS = Number(process.env.PXPIPE_FLUSH_INTERVAL_MS ?? 30000);
  const FLUSH_BYTES_THRESHOLD = Number(process.env.PXPIPE_FLUSH_BYTES_THRESHOLD ?? 1024 * 1024);
  let bytesSinceLastFlush = 0;
  tracker.onBytesWritten = (n: number) => {
    bytesSinceLastFlush += n;
  };
  const flushTimer = setInterval(async () => {
    if (bytesSinceLastFlush >= FLUSH_BYTES_THRESHOLD) {
      try {
        await tracker.flush?.();
        bytesSinceLastFlush = 0;
      } catch (err) {
        console.warn(`[pxpipe] tracker flush failed: ${(err as Error).message}`);
      }
    }
  }, FLUSH_INTERVAL_MS);
  flushTimer.unref();

  // Sidecar dir for oversized 4xx request-body samples. Lives next to the
  // events.jsonl so a single `rm -rf` cleans up both. Lazy-mkdir'd on first
  // sidecar write (see maybeWriteBodySidecar).
  const bodySidecarDir = path.join(path.dirname(opts.eventsFile), '4xx-bodies');

  // Live dashboard state — populated on every request via onRequest below,
  // served via the route interception in front of the proxy handler. The
  // SessionsPaths handle lets the dashboard surface session/disk/stats data
  // without reaching back into module-scope globals.
  const dashboard = new DashboardState({
    eventsFile: opts.eventsFile,
    sidecarDir: bodySidecarDir,
  });
  // Seed the "recent requests" table from the JSONL log so a process restart
  // doesn't reset what you can see in the UI. Best-effort; ignored on error.
  await dashboard.replay(opts.eventsFile).catch(() => {});

  const config: ProxyConfig = {
    provider: opts.provider,
    gatewayBaseUrl: opts.gatewayBaseUrl,
    gatewayHeaders: opts.gatewayHeaders,
    upstream: opts.upstream,
    openAIUpstream: opts.openAIUpstream,
    openAIApiKey: opts.openAIApiKey,
    compatibleProviders: opts.compatibleProviders,
    // Per-request transform options:
    //   1. Runtime kill switch — when the dashboard "passthrough" toggle
    //      is off, force compress=false so /v1/messages forwards
    //      untransformed. Lets the operator instantly disable the proxy
    //      when upstream is unhealthy without restarting.
    //   2. Otherwise use DEFAULTS in transform.ts for break-even gating.
    transform: () => {
      // A/B harness: PXPIPE_DISABLE=1 forces passthrough (compress=false) for the
      // whole process, so the "normal" arm can be scripted on its own port while
      // still logging real usage + count_tokens baselines to its own PXPIPE_LOG.
      // (The dashboard kill switch does the same thing at runtime.)
      if (forcePassthrough || !dashboard.getCompressionEnabled()) return { compress: false };
      // Active path: use DEFAULTS in transform.ts for break-even gating.
      return {};
    },
    onRequest: async (e) => {
      // Feed the dashboard BEFORE tracker.emit — toTrackEvent strips
      // info.firstImagePng, so capturing has to happen on the raw event.
      dashboard.update(e);
      // Debug: persist this request's rendered PNGs (see PXPIPE_DUMP_DIR above).
      // Filenames sort by request order: <stamp>_reqNNN_<model>_pNN.png.
      if (imageDumpDir && e.info?.imagePngs && e.info.imagePngs.length > 0) {
        const seq = ++imageDumpSeq;
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const modelTag = (e.model ?? 'model').replace(/[^A-Za-z0-9._-]+/g, '_');
        const pngs = e.info.imagePngs;
        for (let i = 0; i < pngs.length; i++) {
          const name = `${stamp}_req${String(seq).padStart(3, '0')}_${modelTag}_p${String(i + 1).padStart(2, '0')}.png`;
          try {
            fs.writeFileSync(path.join(imageDumpDir, name), pngs[i]!);
          } catch (err) {
            console.warn(`[pxpipe] PNG dump write failed: ${(err as Error).message}`);
            break; // dir vanished / full — stop hammering it this request
          }
        }
        console.log(`  ↳ dumped ${pngs.length} rendered png(s) → ${imageDumpDir}`);
      }
      // Terse human-readable console line.
      const extra: string[] = [];
      if (e.info?.reminderImgs) extra.push(`rem+${e.info.reminderImgs}`);
      if (e.info?.toolResultImgs) extra.push(`tr+${e.info.toolResultImgs}`);
      const extraTag = extra.length > 0 ? ` (${extra.join(' ')})` : '';
      const tag = e.info?.compressed
        ? `compressed ${e.info.origChars}ch → ${e.info.imageCount}img/${e.info.imageBytes}B${extraTag}`
        : (e.info?.reason ?? '');
      const cacheRead = e.usage?.cache_read_input_tokens ?? 0;
      const inputTokens = e.usage?.input_tokens ?? 0;
      const usageTag =
        e.usage !== undefined
          ? ` tokens=${inputTokens}+${e.usage.output_tokens ?? 0} cache_read=${cacheRead}`
          : '';
      console.log(
        `[${new Date().toISOString()}] ${e.method} ${e.path} → ${e.status} (${e.durationMs}ms) ${tag}${usageTag}`,
      );

      // Surface upstream 4xx error bodies inline so a regression in the
      // request shape is obvious without having to grep events.jsonl. The
      // tracker JSONL already has the full ~2 KiB capture.
      if (e.errorBody) {
        const trimmed = e.errorBody.length > 400
          ? e.errorBody.slice(0, 400) + '…'
          : e.errorBody;
        console.warn(`[pxpipe ${e.status}] upstream body: ${trimmed}`);
      }

      // Canary: surface unknown tag-shaped blocks so a Claude Code release
      // that adds a new dynamic tag is caught within hours.
      if (e.info?.unknownStaticTags && e.info.unknownStaticTags.length > 0) {
        console.warn(
          `[pxpipe warn] unknown tag(s) in static slab: ${e.info.unknownStaticTags.join(', ')}  ` +
            `— may need to add to DYNAMIC_BLOCK_TAGS (per-turn) or KNOWN_STATIC_TAGS (static) in src/core/transform.ts`,
        );
      }

      // If the proxy captured a gzipped 4xx body that won't fit inline in
      // the JSONL row, write it to a sidecar file and put the path on the
      // event instead. Threshold: gz_bytes * 4/3 > inline cap (b64 expansion).
      if (e.reqBodyGz && e.reqBodyGz.byteLength * 4 > TRACK_BODY_INLINE_MAX * 3) {
        const writtenPath = await maybeWriteBodySidecar(
          e.reqBodyGz,
          e.reqBodySha8,
          bodySidecarDir,
        );
        if (writtenPath) {
          e.reqBodySamplePath = writtenPath;
          e.reqBodyGz = undefined; // tracker will pick up the path instead
        }
        // If write failed: leave reqBodyGz; the tracker will silently drop
        // it (still too big to inline). We never lose the sha8 / error_body.
      }

      // Persistent JSONL event for offline analysis (pxpipe stats etc.).
      tracker.emit(toTrackEvent(e));
    },
  };
  const handle = createProxy(config);

  const server = createServer((req, res) => {
    Promise.resolve()
      .then(async () => {
        // Local dashboard routes — handled BEFORE the proxy so they never hit
        // api.anthropic.com (which would 404 them).
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

        const route = dashboardPath(url.pathname);
        if (route) {
          const webRes = await dispatchDashboard(dashboard, route, req, url, opts.port);
          if (webRes) {
            await writeWebResponse(webRes, res);
            return;
          }
        }
        const webReq = toWebRequest(req);
        const webRes = await handle(webReq);
        await writeWebResponse(webRes, res);
      })
      .catch((err) => {
        console.error('[pxpipe] handler error:', err);
        if (!res.headersSent) res.statusCode = 500;
        res.end();
      });
  });

  // IPv6 literals need bracket notation to form a valid URL (http://[::1]:47821).
  const displayHost = opts.host.includes(':') ? `[${opts.host}]` : opts.host;
  const isLoopbackHost =
    opts.host === '127.0.0.1' || opts.host === 'localhost' || opts.host === '::1';
  server.listen(opts.port, opts.host, () => {
    console.log(`[pxpipe] listening on http://${displayHost}:${opts.port}`);
    if (!isLoopbackHost) {
      console.warn(
        `[pxpipe] WARNING: bound to ${opts.host} — the unauthenticated dashboard ` +
          `(captured request context + kill switch) is reachable off-host. ` +
          `Unset HOST to restrict to loopback.`,
      );
    }
    const routes = resolveUpstreams(config);
    console.log(`[pxpipe] anthropic upstream → ${routes.anthropic}`);
    console.log(`[pxpipe] openai upstream → ${routes.openai}`);
    console.log(`[pxpipe] tracking events → ${opts.eventsFile}`);
    console.log(`[pxpipe] dashboard → http://127.0.0.1:${opts.port}/`);
  });

  // server.close() only stops accepting new connections and waits for open
  // ones to drain — it does NOT end idle keep-alive sockets. The dashboard tab
  // (htmx polls every 2s) and the Claude Code client both hold keep-alive
  // sockets open, so a naive close() never fires its callback and the first
  // Ctrl+C appears to hang. We drop idle sockets immediately, force-close any
  // in-flight ones after a short grace period, and let a second signal exit now.
  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) {
      console.log(`[pxpipe] ${sig} again — forcing exit`);
      process.exit(130);
    }
    shuttingDown = true;
    console.log(`[pxpipe] ${sig} — shutting down`);
    // Flush+close the tracker so we don't drop the last few events on exit.
    if (tracker instanceof FileTracker) await tracker.close();
    setActiveTracker(null);
    server.close(() => process.exit(0));
    // Drop idle keep-alive sockets so close()'s callback can actually fire.
    server.closeIdleConnections?.();
    // Hard deadline: if a streaming /v1/messages response (or slow upstream)
    // is still in flight, force the rest closed and exit anyway.
    const deadline = setTimeout(() => {
      server.closeAllConnections?.();
      process.exit(0);
    }, 1500);
    deadline.unref();
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[pxpipe] fatal:', err);
  process.exit(1);
});
