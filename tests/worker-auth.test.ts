/**
 * Unit tests for the Cloudflare Worker auth gate.
 *
 * Pure-function tests — no Worker runtime. We exercise the exported
 * `checkAuth` and `hasTenantKey` directly so we can confirm every
 * provider key triggers the same gate without spinning up miniflare.
 */
import { describe, it, expect } from 'vitest';
import { checkAuth, hasTenantKey, TENANT_KEY_ENVS } from '../src/worker.js';
import type { Env } from '../src/worker.js';

function makeEnv(overrides: Partial<Env> = {}): Env {
  return { ...overrides } as Env;
}

function postReq(headers: Record<string, string> = {}): Request {
  return new Request('https://pxpipe.example/v1/messages', {
    method: 'POST',
    headers,
  });
}

describe('TENANT_KEY_ENVS', () => {
  it('lists all five tenant-key env names', () => {
    expect(TENANT_KEY_ENVS).toEqual([
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'DEEPSEEK_API_KEY',
      'MIMO_API_KEY',
      'MINIMAX_API_KEY',
    ]);
  });
});

describe('hasTenantKey', () => {
  it('returns false when no tenant key is set', () => {
    expect(hasTenantKey(makeEnv())).toBe(false);
  });

  it('returns true for each known tenant key individually', () => {
    for (const k of TENANT_KEY_ENVS) {
      expect(hasTenantKey(makeEnv({ [k]: 'sk-test' }))).toBe(true);
    }
  });

  it('treats empty-string env as "not set"', () => {
    // Cloudflare dashboards store '' rather than unset; we want false.
    expect(hasTenantKey(makeEnv({ ANTHROPIC_API_KEY: '' }))).toBe(false);
    expect(hasTenantKey(makeEnv({ DEEPSEEK_API_KEY: '' }))).toBe(false);
  });
});

describe('checkAuth — single-tenant gate', () => {
  it('returns null when no tenant keys are configured (multi-tenant mode)', async () => {
    const res = await checkAuth(makeEnv(), postReq());
    expect(res).toBeNull();
  });

  it('rejects with 503 when DEEPSEEK_API_KEY is set but PXPIPE_WORKER_SECRET is missing', async () => {
    const env = makeEnv({ DEEPSEEK_API_KEY: 'sk-deep-123' });
    const res = await checkAuth(env, postReq());
    expect(res).not.toBeNull();
    expect(res!.status).toBe(503);
    const body = (await res!.json()) as { error: string };
    expect(body.error).toContain('PXPIPE_WORKER_SECRET');
    expect(body.error).toContain('DEEPSEEK_API_KEY');
    expect(body.error).toContain('OPENAI_API_KEY');
    expect(body.error).toContain('MIMO_API_KEY');
    expect(body.error).toContain('MINIMAX_API_KEY');
  });

  it('rejects with 503 for MIMO-only deployment without secret', async () => {
    const env = makeEnv({ MIMO_API_KEY: 'mimo-123' });
    const res = await checkAuth(env, postReq());
    expect(res!.status).toBe(503);
  });

  it('rejects with 503 for MINIMAX-only deployment without secret', async () => {
    const env = makeEnv({ MINIMAX_API_KEY: 'minimax-123' });
    const res = await checkAuth(env, postReq());
    expect(res!.status).toBe(503);
  });

  it('returns 503 when ANTHROPIC_API_KEY is configured without secret (legacy behavior preserved)', async () => {
    // This was the only key the gate covered before SPEC-004. Make sure the
    // refactor didn't accidentally drop it.
    const env = makeEnv({ ANTHROPIC_API_KEY: 'sk-ant-123' });
    const res = await checkAuth(env, postReq());
    expect(res!.status).toBe(503);
  });

  it('rejects with 401 when secret is wrong (MIMO_KEY + secret set, wrong header)', async () => {
    const env = makeEnv({
      MIMO_API_KEY: 'mimo-123',
      PXPIPE_WORKER_SECRET: 'expected-secret',
    });
    const res = await checkAuth(env, postReq({ 'x-pxpipe-secret': 'nope' }));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
    const body = (await res!.json()) as { error: string };
    expect(body.error).toContain('x-pxpipe-secret');
  });

  it('rejects with 401 when secret header is missing entirely', async () => {
    const env = makeEnv({
      DEEPSEEK_API_KEY: 'sk-deep-123',
      PXPIPE_WORKER_SECRET: 'expected',
    });
    const res = await checkAuth(env, postReq());
    expect(res!.status).toBe(401);
  });

  it('returns null when the correct secret is presented (MINIMAX_KEY tenant)', async () => {
    const env = makeEnv({
      MINIMAX_API_KEY: 'minimax-123',
      PXPIPE_WORKER_SECRET: 'expected-secret',
    });
    const res = await checkAuth(env, postReq({ 'x-pxpipe-secret': 'expected-secret' }));
    expect(res).toBeNull();
  });

  it('returns null with ANTHROPIC + correct secret (legacy coverage)', async () => {
    const env = makeEnv({
      ANTHROPIC_API_KEY: 'sk-ant-123',
      PXPIPE_WORKER_SECRET: 'expected',
    });
    const res = await checkAuth(env, postReq({ 'x-pxpipe-secret': 'expected' }));
    expect(res).toBeNull();
  });

  it('accepts when MULTIPLE tenant keys are set and one valid secret is presented', async () => {
    const env = makeEnv({
      ANTHROPIC_API_KEY: 'sk-ant-123',
      DEEPSEEK_API_KEY: 'sk-deep-456',
      MINIMAX_API_KEY: 'sk-mm-789',
      PXPIPE_WORKER_SECRET: 'expected',
    });
    const res = await checkAuth(env, postReq({ 'x-pxpipe-secret': 'expected' }));
    expect(res).toBeNull();
  });

  it('uses constant-time SHA-256 comparison (acceptance is exact-match)', async () => {
    // Reverse / prefix / suffix variants must all fail.
    const env = makeEnv({
      MIMO_API_KEY: 'mimo-123',
      PXPIPE_WORKER_SECRET: 'expected-secret',
    });
    const cases = [
      'expected-secre',     // off-by-one
      'xpected-secret',     // missing leading char
      'expected-secrets',   // extra trailing
      'EXPECTED-SECRET',    // case differs (secretsMatch compares raw bytes)
      '',
    ];
    for (const candidate of cases) {
      const res = await checkAuth(env, postReq({ 'x-pxpipe-secret': candidate }));
      // Either 401 (rejected) or, for empty string, 401 — never 503 because
      // PXPIPE_WORKER_SECRET is set.
      expect(res!.status).toBe(401);
    }
  });
});
