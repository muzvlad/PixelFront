/**
 * Dashboard HONESTY invariants — the savings math can never OVERCLAIM.
 *
 * dashboard-api.test.ts checks specific hand-picked scenarios with hardcoded
 * expected numbers. This file is the categorical complement: it sweeps a grid of
 * inputs through the pure cost/baseline functions and asserts universal honesty
 * properties that must hold for EVERY input — so a regression that overclaims in
 * a case nobody thought to hardcode still goes red.
 *
 * The displayed "Saved" = baseline_eff − actual_eff. The two ways to overclaim:
 *   (a) inflate the baseline (the "as text" counterfactual), or
 *   (b) price the counterfactual WARM when this turn was actually COLD (claiming
 *       savings on a prefix that would have been cached as text anyway).
 * The invariants below pin both down on the Anthropic and GPT paths.
 *
 * These are the pure formula functions (no dashboard plumbing) on purpose — they
 * ARE the honesty math; testing them directly makes the guarantees categorical.
 *
 * Run just this file:  pnpm vitest run tests/savings-honesty.test.ts
 */
import { describe, expect, it } from 'vitest';
import {
  computeBaselineInputEff,
  computeActualInputEff,
  computeEstimatedBaselineInputEff,
  computeRealizedInputRate,
  CACHE_CREATE_RATE,
  CACHE_READ_RATE,
} from '../src/core/baseline.js';
import {
  computeOpenAIBaselineInputEff,
  computeOpenAIActualInputEff,
  computeOpenAIBaselineRawTokens,
  openAICacheReadRate,
} from '../src/core/openai-savings.js';

const GPT = 'gpt-5.6';

// ===========================================================================
describe('GPT savings honesty (vs the real o200k cached-rate model)', () => {
  const inputs = [0, 1_000, 10_000];
  const cacheds = [0, 500, 2_000, 50_000]; // last exceeds input → must clamp
  const imageToks = [0, 800, 8_000];
  const baselineImaged = [0, 5_000, 50_000];

  const sweep = (f: (i: number, c: number, im: number, b: number) => void) => {
    for (const i of inputs) for (const c of cacheds) for (const im of imageToks) for (const b of baselineImaged) f(i, c, im, b);
  };

  it('credits ZERO when nothing was imaged (no phantom savings on passthrough)', () => {
    sweep((i, c, im, b) => {
      if (im > 0 && b > 0 && i > 0) return; // imaging-active case handled elsewhere
      const actual = computeOpenAIActualInputEff(i, c, GPT);
      const baseline = computeOpenAIBaselineInputEff(i, c, im, b, GPT);
      expect(baseline - actual).toBe(0);
    });
  });

  it('saved == (textTokens − imageTokens) × cache-weight, EXACTLY (no inflation)', () => {
    sweep((i, c, im, b) => {
      if (!(im > 0 && b > 0 && i > 0)) return;
      const actual = computeOpenAIActualInputEff(i, c, GPT);
      const baseline = computeOpenAIBaselineInputEff(i, c, im, b, GPT);
      const saved = baseline - actual;
      const weight = c > 0 ? openAICacheReadRate(GPT) : 1.0;
      expect(saved).toBeCloseTo((b - im) * weight, 6);
    });
  });

  it('OVERCLAIM GUARD: a warm turn never claims more savings than the same turn cold', () => {
    sweep((i, c, im, b) => {
      if (!(im > 0 && b > 0 && i > 0)) return;
      if (b - im < 0) return; // post-gate reality: imaging is only chosen when it saves
      const savedWarm =
        computeOpenAIBaselineInputEff(i, Math.max(1, c), im, b, GPT) -
        computeOpenAIActualInputEff(i, Math.max(1, c), GPT);
      const savedCold =
        computeOpenAIBaselineInputEff(i, 0, im, b, GPT) - computeOpenAIActualInputEff(i, 0, GPT);
      expect(savedWarm).toBeLessThanOrEqual(savedCold + 1e-9);
    });
  });

  it('saved sign is honest: a real win is positive, a (hypothetical) loss is negative — never fabricated', () => {
    sweep((i, c, im, b) => {
      if (!(im > 0 && b > 0 && i > 0)) return;
      const saved = computeOpenAIBaselineInputEff(i, c, im, b, GPT) - computeOpenAIActualInputEff(i, c, GPT);
      expect(Math.sign(saved)).toBe(Math.sign(b - im));
      // Ceiling: the cache weight is ≤ 1, so |saved| can never exceed the raw delta.
      expect(Math.abs(saved)).toBeLessThanOrEqual(Math.abs(b - im) + 1e-9);
    });
  });

  it('raw-token counterfactual has MORE tokens than what we sent (when imaging saved)', () => {
    sweep((i, c, im, b) => {
      if (!(i > 0)) return;
      const raw = computeOpenAIBaselineRawTokens(i, im, b);
      expect(raw).toBeGreaterThanOrEqual(0);
      if (b - im >= 0) expect(raw).toBeGreaterThanOrEqual(i);
    });
  });
});

// ===========================================================================
describe('Anthropic savings honesty (cache-create / cache-read aware)', () => {
  const baselines = [0, 1_000, 30_000];
  const cacheables = [0, 5_000, 20_000];
  const inputs = [100, 10_000];
  const ccs = [0, 20_000];
  const crs = [0, 20_000];
  const prevs = [0, 10_000, 25_000];

  const sweep = (
    f: (baseline: number, cacheable: number, input: number, cc: number, cr: number, prev: number) => void,
  ) => {
    for (const baseline of baselines)
      for (const cacheable of cacheables)
        for (const input of inputs)
          for (const cc of ccs) for (const cr of crs) for (const prev of prevs) f(baseline, cacheable, input, cc, cr, prev);
  };

  it('credits ZERO when the cacheable-prefix probe is missing (can not measure → claim nothing)', () => {
    sweep((baseline, cacheable, input, cc, cr, prev) => {
      if (cacheable > 0) return;
      const actual = computeActualInputEff(input, cc, cr);
      // baseline<=0 returns 0 (no baseline); baselineCacheable<=0 returns actual (no credit).
      const eff = computeBaselineInputEff(baseline, cacheable, input, cc, cr, false, prev);
      if (baseline <= 0) expect(eff).toBe(0);
      else expect(eff - actual).toBe(0); // saved 0
    });
  });

  it('OVERCLAIM GUARD: pricing the text counterfactual WARM never claims more than COLD', () => {
    sweep((baseline, cacheable, input, cc, cr, prev) => {
      if (!(baseline > 0 && cacheable > 0)) return;
      const warm = computeBaselineInputEff(baseline, cacheable, input, cc, cr, true, prev);
      const cold = computeBaselineInputEff(baseline, cacheable, input, cc, cr, false, prev);
      expect(warm).toBeLessThanOrEqual(cold + 1e-9); // warm counterfactual is cheaper → less saved
    });
  });

  it('baseline-eff is non-negative and never exceeds re-creating the whole baseline at 1.25×', () => {
    sweep((baseline, cacheable, input, cc, cr, prev) => {
      if (!(baseline > 0 && cacheable > 0)) return;
      const cold = computeBaselineInputEff(baseline, cacheable, input, cc, cr, false, prev);
      expect(cold).toBeGreaterThanOrEqual(0);
      expect(cold).toBeLessThanOrEqual(baseline * 1.25 + 1e-9); // can't fabricate a bigger counterfactual
    });
  });
});

// ===========================================================================
// Estimate rows: the provider has no count_tokens, so the text counterfactual
// is a pxpipe-side token estimate. Crediting it raw would hand the provider's
// cache discount to pxpipe - the same overclaim the 'ok' path guards against.
describe('estimated baseline (no count_tokens) is priced with the observed cache state', () => {
  const baselines = [0, 1_000, 30_000, 500_000];
  const inputs = [0, 100, 10_000];
  const ccs = [0, 20_000];
  const crs = [0, 20_000, 200_000];

  const sweep = (f: (b: number, i: number, cc: number, cr: number) => void) => {
    for (const b of baselines) for (const i of inputs) for (const cc of ccs) for (const cr of crs) f(b, i, cc, cr);
  };

  it('realized rate stays inside the published price band (0.1x .. 1.25x)', () => {
    sweep((b, i, cc, cr) => {
      if (i + cc + cr <= 0) return;
      const rate = computeRealizedInputRate(i, cc, cr);
      expect(rate).toBeGreaterThanOrEqual(CACHE_READ_RATE - 1e-9);
      expect(rate).toBeLessThanOrEqual(CACHE_CREATE_RATE + 1e-9);
    });
  });

  it('a warm turn NEVER claims more savings than the same turn with a fresh cache write', () => {
    sweep((b, i, cc, cr) => {
      if (!(b > 0 && i + cc + cr > 0)) return;
      const billed = i + cc + cr;
      // Cold counterpart: the very same request, but the whole prefix is
      // (re)written at the cache-create rate instead of read at 0.1x.
      const coldPrice = b * ((i + CACHE_CREATE_RATE * (cc + cr)) / billed);
      expect(computeEstimatedBaselineInputEff(b, i, cc, cr)).toBeLessThanOrEqual(coldPrice + 1e-9);
    });
  });

  it('the counterfactual can never exceed re-creating the whole baseline at 1.25x', () => {
    sweep((b, i, cc, cr) => {
      if (!(b > 0 && i + cc + cr > 0)) return;
      const eff = computeEstimatedBaselineInputEff(b, i, cc, cr);
      expect(eff).toBeGreaterThanOrEqual(0);
      expect(eff).toBeLessThanOrEqual(b * CACHE_CREATE_RATE + 1e-9);
    });
  });

  it('the cache-blind raw estimate is NEVER credited when there is no cache write', () => {
    sweep((b, i, cc, cr) => {
      if (!(b > 0 && i + cc + cr > 0 && cc === 0)) return;
      const eff = computeEstimatedBaselineInputEff(b, i, cc, cr);
      expect(eff).toBeLessThanOrEqual(b + 1e-9);
      if (cr > 0) expect(eff).toBeLessThan(b + 1e-9); // strictly below the raw full-rate price
    });
  });

  it('no usage at all ⇒ no credit (nothing was measured, nothing is claimed)', () => {
    expect(computeEstimatedBaselineInputEff(500_000, 0, 0, 0)).toBe(0);
    expect(computeEstimatedBaselineInputEff(0, 1_000, 0, 0)).toBe(0);
  });

  it('prices the baseline with the SAME bucket mix the provider billed (proportional)', () => {
    sweep((b, i, cc, cr) => {
      if (!(b > 0 && i + cc + cr > 0)) return;
      const billed = i + cc + cr;
      const proportional =
        b * ((i / billed) * 1.0 + (cc / billed) * CACHE_CREATE_RATE + (cr / billed) * CACHE_READ_RATE);
      expect(computeEstimatedBaselineInputEff(b, i, cc, cr)).toBeCloseTo(proportional, 6);
    });
  });
});

// ===========================================================================
// Different models price/tokenize differently — the savings math must use the
// RIGHT per-model figures, or the dashboard silently misprices a family.
describe('per-model pricing is applied correctly (Fable vs Opus vs GPT)', () => {
  it('Anthropic cache multipliers are SHARED policy across Claude models (Fable AND Opus)', () => {
    // 1.25× create / 0.1× read is Anthropic ephemeral-cache POLICY, identical for
    // every Claude model — so the Anthropic baseline math is intentionally model-
    // independent. (Per-model TEXT token counts come from the real count_tokens
    // probe, NOT a static tokenizer — so Fable-vs-Opus tokenizer differences are
    // resolved upstream, not here.)
    expect(CACHE_CREATE_RATE).toBe(1.25);
    expect(CACHE_READ_RATE).toBe(0.1);
  });

  it('GPT cached-read discount is model-GATED: gpt-5.x → 0.1×, others must NOT get it', () => {
    // pxpipe images gpt-5.x only; pricing a non-gpt-5 row at the aggressive 0.1×
    // would overstate its cache savings. The gate keeps families from bleeding
    // each other's rates.
    expect(openAICacheReadRate('gpt-5.6')).toBe(0.1);
    expect(openAICacheReadRate('gpt-5.5')).toBe(0.1);
    expect(openAICacheReadRate('gpt-4o')).not.toBe(0.1);
    expect(openAICacheReadRate(undefined)).not.toBe(0.1);
  });

  it('GPT and Anthropic read rates happen to coincide (0.1×) but are sourced independently', () => {
    // Guard against a refactor that unifies them: they are the same number today
    // for different reasons (GPT cached-input vs Anthropic cache_read). If one
    // provider changes, only its own constant should move.
    expect(openAICacheReadRate('gpt-5.6')).toBe(CACHE_READ_RATE);
  });
});
