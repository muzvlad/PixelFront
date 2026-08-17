/**
 * Cloudflare Workers entrypoint. Identical proxy logic to the Node build,
 * just wired up through the Worker `fetch` export.
 *
 * Deploy:
 *   npx wrangler deploy
 *
 * Dev:
 *   npx wrangler dev
 *
 * Config lives in wrangler.toml.
 */

import { createProxy, type ProxyConfig } from './core/proxy.js';
import type { TransformOptions } from './core/transform.js';
import { toTrackEvent, JsonLogTracker, noopTracker, type Tracker } from './core/tracker.js';

export interface Env {
  /** Optional single upstream base for every API family. Family-specific env vars override it. */
  PXPIPE_UPSTREAM?: string;
  ANTHROPIC_UPSTREAM?: string;
  /** Optional override — if set, replaces whatever x-api-key the client sent. */
  ANTHROPIC_API_KEY?: string;
  OPENAI_UPSTREAM?: string;
  /** Optional override — if set, replaces whatever Authorization the client sent. */
  OPENAI_API_KEY?: string;
  /** Optional override — DeepSeek single-tenant deployments. */
  DEEPSEEK_API_KEY?: string;
  /** Optional override — Xiaomi MiMo single-tenant deployments. */
  MIMO_API_KEY?: string;
  /** Optional override — MiniMax single-tenant deployments. */
  MINIMAX_API_KEY?: string;
  COMPRESS?: string;
  COMPRESS_TOOLS?: string;
  COMPRESS_REMINDERS?: string;
  COMPRESS_TOOL_RESULTS?: string;
  MIN_COMPRESS_CHARS?: string;
  MIN_REMINDER_CHARS?: string;
  MIN_TOOL_RESULT_CHARS?: string;
  COLS?: string;
  /** R2 multi-column packing — default 1 (off). 2 squeezes ~2× source rows
   *  per image; OCR-verify before flipping in production. */
  MULTI_COL?: string;
  /** When "0" / "false", disable per-request event JSON logs. Default-on.
   *  Cloudflare ingests console.log as Workers Logs; pipe via Logpush to
   *  R2/S3 for the same JSONL shape Node writes to disk. */
  PXPIPE_TRACK?: string;
  /** Shared secret callers must present via the `x-pxpipe-secret` header
   *  whenever an API-key override is configured. Without this gate a
   *  discovered workers.dev URL is an open key-spender: the Worker would
   *  attach your key to any stranger's request. Set with:
   *    npx wrangler secret put PXPIPE_WORKER_SECRET */
  PXPIPE_WORKER_SECRET?: string;
}

/** Compare SHA-256 digests instead of the raw strings so the comparison
 *  can't leak a prefix-match timing signal. */
async function secretsMatch(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const va = new Uint8Array(da);
  const vb = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= (va[i] ?? 0) ^ (vb[i] ?? 0);
  return diff === 0;
}

/** Env variables whose presence means a single-tenant deployment that
 *  injects its own API credits. When any is set, `PXPIPE_WORKER_SECRET`
 *  becomes mandatory — otherwise a discoverable `workers.dev` URL is an
 *  open key-spender. Keep this list in sync with `Env` above.
 *
 *  Note: `as const` makes this a tuple so `some` returns `boolean` and the
 *  indexed access `(env as Record<string, unknown>)[k]` typechecks. */
export const TENANT_KEY_ENVS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'MIMO_API_KEY',
  'MINIMAX_API_KEY',
] as const;

export type TenantKeyEnv = (typeof TENANT_KEY_ENVS)[number];

/** True when the deployment carries at least one upstream API key
 *  override — i.e. is single-tenant and needs the auth gate. */
export function hasTenantKey(env: Env): boolean {
  return TENANT_KEY_ENVS.some((k) => Boolean((env as Record<string, unknown>)[k]));
}

/** Pure auth check — returns a `Response` to short-circuit, or `null` if
 *  the request may proceed. Exported so unit tests can exercise it
 *  without spinning up a Worker runtime. The caller is responsible for
 *  stripping `x-pxpipe-secret` from the forwarded request once
 *  `checkAuth` returns null. */
export async function checkAuth(env: Env, req: Request): Promise<Response | null> {
  if (!hasTenantKey(env)) return null;

  if (!env.PXPIPE_WORKER_SECRET) {
    return new Response(
      JSON.stringify({
        error:
          'refusing to proxy: an API key override is configured ' +
          '(' + TENANT_KEY_ENVS.join(', ') + ') but PXPIPE_WORKER_SECRET is not, ' +
          'which would let anyone who finds this URL spend the configured key(s). ' +
          'Run `npx wrangler secret put PXPIPE_WORKER_SECRET` and send the value as the x-pxpipe-secret header.',
      }),
      { status: 503, headers: { 'content-type': 'application/json' } },
    );
  }
  const presented = req.headers.get('x-pxpipe-secret') ?? '';
  if (!(await secretsMatch(presented, env.PXPIPE_WORKER_SECRET))) {
    return new Response(
      JSON.stringify({ error: 'missing or invalid x-pxpipe-secret header' }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    );
  }
  return null;
}

const truthy = (v: string | undefined, fallback: boolean): boolean =>
  v == null ? fallback : v === '1' || v.toLowerCase() === 'true';

export default {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    // ── Caller auth ────────────────────────────────────────────────────
    // If this deployment injects API keys, never serve anonymous callers:
    // workers.dev URLs are discoverable, and without this gate anyone who
    // finds the URL spends this deployment's API credits.
    const authFail = await checkAuth(env, req);
    if (authFail) return authFail;
    if (hasTenantKey(env)) {
      // Don't forward the shared secret upstream.
      req = new Request(req);
      req.headers.delete('x-pxpipe-secret');
    }

    const transform: TransformOptions = {
      compress: truthy(env.COMPRESS, true),
      compressTools: truthy(env.COMPRESS_TOOLS, true),
      compressReminders: truthy(env.COMPRESS_REMINDERS, true),
      compressToolResults: truthy(env.COMPRESS_TOOL_RESULTS, true),
      minCompressChars: env.MIN_COMPRESS_CHARS ? Number(env.MIN_COMPRESS_CHARS) : 2000,
      // 500 chars — CPU/latency floor only, not a correctness guard. The
      // No floors — the content-aware `isCompressionProfitable()` gate
      // decides per-block based on actual pixel cost vs text cost. Host
      // can still set a floor via env if they want observability buckets
      // (e.g. MIN_TOOL_RESULT_CHARS=200 to skip absurdly small dumps).
      minReminderChars: env.MIN_REMINDER_CHARS ? Number(env.MIN_REMINDER_CHARS) : 0,
      minToolResultChars: env.MIN_TOOL_RESULT_CHARS ? Number(env.MIN_TOOL_RESULT_CHARS) : 0,
      cols: env.COLS ? Number(env.COLS) : 100,
      // R2 multi-column ON (2 cols) — single-col drops below break-even on
      // real tool-doc slabs. Override via MULTI_COL=1 if OCR misreads layout.
      multiCol: env.MULTI_COL ? Math.max(1, Number(env.MULTI_COL) | 0) : 2,
    };
    const trackingOn = truthy(env.PXPIPE_TRACK, true);
    // Workers Logs ingests stdout as separate log lines. Emit one JSON line
    // per event so downstream (Logpush → R2/S3) reads the same JSONL shape
    // the Node host writes to disk.
    const tracker: Tracker = trackingOn ? new JsonLogTracker((s) => console.log(s)) : noopTracker;

    const sharedUpstream = env.PXPIPE_UPSTREAM;
    const config: ProxyConfig = {
      upstream: env.ANTHROPIC_UPSTREAM ?? sharedUpstream ?? 'https://api.anthropic.com',
      apiKey: env.ANTHROPIC_API_KEY,
      openAIUpstream: env.OPENAI_UPSTREAM ?? sharedUpstream ?? 'https://api.openai.com',
      openAIApiKey: env.OPENAI_API_KEY,
      transform,
      onRequest: (e) => {
        // Terse human-readable line (separate from the JSON event below;
        // shows up in `wrangler tail`).
        const tag = e.info?.compressed
          ? `compressed ${e.info.origChars}ch → ${e.info.imageCount}img/${e.info.imageBytes}B`
          : (e.info?.reason ?? '');
        const cacheRead = e.usage?.cache_read_input_tokens ?? 0;
        console.log(`${e.method} ${e.path} → ${e.status} (${e.durationMs}ms) ${tag} cache_read=${cacheRead}`);

        if (e.info?.unknownStaticTags && e.info.unknownStaticTags.length > 0) {
          console.warn(
            `[pxpipe warn] unknown tag(s) in static slab: ${e.info.unknownStaticTags.join(', ')}`,
          );
        }

        tracker.emit(toTrackEvent(e));
      },
    };
    const handle = createProxy(config);
    return handle(req);
  },
};
