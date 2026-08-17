# SPEC-004: Auth-гейт в Worker для всех провайдеров

| Поле | Значение |
|---|---|
| **Приоритет** | 🔴 Высокий |
| **Категория** | Security / Authorization bypass |
| **Файлы** | `src/worker.ts` |
| **Связь с аудитом** | пункт 2.5 |
| **Объём работ** | 1 час |
| **Breaking change** | Да: новые env-переменные в `Env` интерфейсе; auth при более широком наборе условий |
| **Статус** | ✅ DONE — 6/6 AC проверены, 15/15 worker-auth тестов зелёные, 674/674 full suite |

## Проблема

Текущий auth-гейт в `src/worker.ts:74` срабатывает только при наличии `ANTHROPIC_API_KEY` или `OPENAI_API_KEY`:

```ts
if (env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY) {
  if (!env.PXPIPE_WORKER_SECRET) {
    return new Response(/* 503: refusing to proxy ... */);
  }
  /* ... header check ... */
}
```

Если на Cloudflare Worker установлен **только** `DEEPSEEK_API_KEY` override (без Anthropic/OpenAI), gейт не срабатывает. `workers.dev` URL открыт миру → кто угодно может слать трафик, расходуя квоту.

### Почему это серьёзно

1. **По умолчанию Worker-деплой** не имеет `*_API_KEY` overrides — клиенты пробрасывают свои. Тогда auth не нужен.
2. Если деплой настроен на single-tenant (один аккаунт оплачивает DeepSeek через API key), и auth-gate не работает — это превращает публичный URL в **открытый bill-shock-генератор**.
3. Поскольку `workers.dev` URL — discoverable, атакующему достаточно найти URL и слать запросы.

## Требования

1. Auth-gate срабатывает при наличии **любого** API-key override:
   - `ANTHROPIC_API_KEY`
   - `OPENAI_API_KEY`
   - `DEEPSEEK_API_KEY`
   - `MIMO_API_KEY`
   - `MINIMAX_API_KEY`
2. В Node build (опционально) — симметричное поведение: при задании любых key overrides через env, server должен требовать `PXPIPE_WORKER_SECRET`-аналог (или хотя бы логировать warning, что bind на 0.0.0.0 + ключи = бомба). Сейчас `node.ts` не имеет такого гейта — это отдельная история, не блокирует SPEC-004.
3. Сообщение об ошибке упоминает **все** ключи, не только первые два.

## Дизайн

### src/worker.ts

```ts
export interface Env {
  // ... существующие поля ...
  PXPIPE_UPSTREAM?: string;
  ANTHROPIC_UPSTREAM?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_UPSTREAM?: string;
  OPENAI_API_KEY?: string;
  // === ДОБАВИТЬ: ===
  DEEPSEEK_API_KEY?: string;
  MIMO_API_KEY?: string;
  MINIMAX_API_KEY?: string;
  // === ===
  COMPRESS?: string;
  // ... остальное без изменений ...
}

/**
 * Список env-переменных, при наличии которых деплой
 * считается single-tenant и требует PXPIPE_WORKER_SECRET.
 */
const TENANT_KEY_ENVS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'MIMO_API_KEY',
  'MINIMAX_API_KEY',
] as const;

function hasTenantKey(env: Env): boolean {
  return TENANT_KEY_ENVS.some((k) => Boolean((env as Record<string, unknown>)[k]));
}

function tenantKeyNames(): string {
  return TENANT_KEY_ENVS.join(', ');
}

export default {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    // ── Caller auth ────────────────────────────────────────────────────
    if (hasTenantKey(env)) {
      if (!env.PXPIPE_WORKER_SECRET) {
        return new Response(
          JSON.stringify({
            error:
              'refusing to proxy: an API key override is configured ' +
              '(' + tenantKeyNames() + ') but PXPIPE_WORKER_SECRET is not, ' +
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
      req = new Request(req);
      req.headers.delete('x-pxpipe-secret');
    }
    // ... остальная логика без изменений
  },
};
```

> ⚠️ Зачем нужен `TENANT_KEY_ENVS` массив: перечень может расширяться (Yandex, Mistral и т.д.). Один источник истины.

> ⚠️ `as const` для массива даёт tuple тип — `TENANT_KEY_ENVS.some(...)` возвращает boolean, и TypeScript не ругается на обращение `(env as Record<string, unknown>)[k]`.

## Acceptance Criteria

- [x] Worker отвергает запросы (503 + PXPIPE_WORKER_SECRET-not-configured) если задан **любой** из `*_API_KEY` и `PXPIPE_WORKER_SECRET` не задан.
- [x] Worker отвергает с 401 если задан ключ и `x-pxpipe-secret` отсутствует/неверен.
- [x] Если ни один ключ не задан — auth не требуется (как сейчас, для multi-tenant deployments).
- [x] Сообщение об ошибке 503 содержит все 5 имён env-переменных.
- [x] Все остальные тесты проходят. (674/674 passed after SPEC-004)
- [x] `CHANGELOG.md` обновлён: раздел `Unreleased > Security` описывает расширение auth-gate на все 5 провайдеров и команду `npx wrangler secret put PXPIPE_WORKER_SECRET` для миграции.

## Тесты

### tests/worker-auth.test.ts (новый, через vitest-environment-miniflare или просто unit-тест функции)

```ts
import { describe, expect, it } from 'vitest';
import worker from '../src/worker.js'; // или через хелпер

// Реальные Worker-тесты обычно через @cloudflare/vitest-pool-workers,
// но для этой изолированной функции достаточно прямого unit-теста.

describe('Worker auth gate', () => {
  function makeEnv(overrides: Partial<Env>): Env {
    return {
      ANTHROPIC_UPSTREAM: 'https://api.anthropic.com',
      OPENAI_UPSTREAM: 'https://api.openai.com',
      ...overrides,
    } as Env;
  }

  it('rejects when only DEEPSEEK_API_KEY is set, no secret', async () => {
    const env = makeEnv({ DEEPSEEK_API_KEY: 'sk-deep-123' });
    const req = new Request('https://pxpipe.example/v1/messages', { method: 'POST' });
    const res = await worker.default.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(503);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('DEEPSEEK_API_KEY');
    expect(body.error).toContain('MIMO_API_KEY');
    expect(body.error).toContain('MINIMAX_API_KEY');
    expect(body.error).toContain('PXPIPE_WORKER_SECRET');
  });

  it('rejects MIMO-only with 401 when secret wrong', async () => {
    const env = makeEnv({
      MIMO_API_KEY: 'mimo-123',
      PXPIPE_WORKER_SECRET: 'expected',
    });
    const req = new Request('https://pxpipe.example/v1/messages', {
      method: 'POST',
      headers: { 'x-pxpipe-secret': 'wrong' },
    });
    const res = await worker.default.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(401);
  });

  it('accepts MINI_MAX-only with correct secret', async () => {
    const env = makeEnv({
      MINIMAX_API_KEY: 'minimax-123',
      PXPIPE_WORKER_SECRET: 'expected',
    });
    const req = new Request('https://pxpipe.example/v1/messages', {
      method: 'POST',
      headers: { 'x-pxpipe-secret': 'expected' },
    });
    const res = await worker.default.fetch(req, env, {} as ExecutionContext);
    // Дошёл до proxy (статус может быть любым — 200/4xx/5xx — главное не 401/503).
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(503);
  });

  it('passes through when no tenant keys are set', async () => {
    const env = makeEnv({});
    const req = new Request('https://pxpipe.example/v1/messages', { method: 'POST' });
    const res = await worker.default.fetch(req, env, {} as ExecutionContext);
    expect(res.status).not.toBe(503);
    // (Auth не требовался, дошли до proxy.)
  });

  it('does NOT forward x-pxpipe-secret upstream', async () => {
    // Сложнее: нужно подменить upstream или проверить через mock.
    // Пропустить если нет test harness.
  });
});
```

> ⚠️ Полноценный Worker-тест требует `vitest-pool-workers` или `vitest-environment-miniflare`. Альтернатива — рефакторинг auth-гейта в отдельную функцию `checkAuth(env, req)` в `src/worker.ts`, экспортируемую и покрываемую unit-тестом без Worker runtime.

### Альтернативный рефакторинг (рекомендуется)

```ts
// src/worker.ts
export async function checkAuth(env: Env, req: Request): Promise<Response | null> {
  if (!hasTenantKey(env)) return null;
  if (!env.PXPIPE_WORKER_SECRET) {
    return new Response(/* 503 */, { status: 503, headers: { 'content-type': 'application/json' } });
  }
  const presented = req.headers.get('x-pxpipe-secret') ?? '';
  if (!(await secretsMatch(presented, env.PXPIPE_WORKER_SECRET))) {
    return new Response(/* 401 */, { status: 401, headers: { 'content-type': 'application/json' } });
  }
  return null; // Auth passed.
}

export default {
  async fetch(req, env, ctx) {
    const authFail = await checkAuth(env, req);
    if (authFail) return authFail;
    if (hasTenantKey(env)) {
      // Strip header before forwarding.
      req = new Request(req);
      req.headers.delete('x-pxpipe-secret');
    }
    // ... continue
  },
};
```

Преимущество: `checkAuth` — чистая функция, легко тестируется без Worker harness.

## Обратная совместимость

- **Cloudflare деплои с PXPIPE_WORKER_SECRET** (правильно настроенные): поведение не меняется.
- **Cloudflare деплои только с DEEPSEEK_API_KEY/MIMO_API_KEY/MINIMAX_API_KEY** (single-tenant без secret): были уязвимы → станут безопасны. Это **breaking change в security posture**, но **улучшение**.
- **Cloudflare деплои multi-tenant (только client keys)**: поведение не меняется (gate не срабатывает).
- **Env interface**: добавлены 3 новых опциональных поля. Никто их не читал до этого, но если в каком-то wrangler.toml они случайно заданы — auth теперь будет требовать secret.

> ⚠️ **Важно:** если у пользователя уже есть wrangler.toml с `MINIMAX_API_KEY=...` без `PXPIPE_WORKER_SECRET` — после деплоя он получит 503. Документировать в release notes как «теперь auth-gate применяется ко всем провайдерам».

## Открытые вопросы

- **Q1:** Аналогичный gate в Node-сборке (`src/node.ts`)? Сейчас отсутствует. Bind на `HOST=0.0.0.0` + `ANTHROPIC_API_KEY=...` тоже опасен — `node.ts:1264` уже выводит WARNING, но это **не enforce**. Можно вынести в отдельный SPEC-004b.
- **Q2:** `Worker` располагает `secretsMatch` через SHA-256, что корректно. Но `x-pxpipe-secret` пересылается по HTTPS → безопасно. Подтверждено.
- **Q3:** Нужен ли rate-limit поверх auth? Это уже out of scope для этой спеки.

## Чеклист PR

- [ ] `src/worker.ts`: добавлены 3 env-поля, экспортируется `checkAuth`, обновлён `default.fetch`.
- [ ] `tests/worker-auth.test.ts`: 4-5 тестов на все комбинации ключей.
- [ ] README.md: добавлены примеры с DeepSeek/MiMo/MiniMax single-tenant deployments.
- [ ] CHANGELOG: «Security: auth-gate теперь покрывает все провайдеры, не только Anthropic+OpenAI».
- [ ] Wrangler types regenerated: `npx wrangler types`.
- [ ] `pnpm typecheck && pnpm test` — чисто.
