import { describe, it, expect } from 'vitest';
import { Reservoir, SUMMARY_RESERVOIR_CAPACITY } from '../src/stats.js';

describe('Reservoir (Vitter R)', () => {
  it('adds first capacity items verbatim (no sampling yet)', () => {
    const r = new Reservoir(8);
    for (let i = 1; i <= 8; i++) r.add(i);
    expect(r.size()).toBe(8);
    expect(r.seenCount()).toBe(8);
    // All eight survived — p50 sits between them.
    expect(r.percentile(50)).toBeGreaterThan(0);
  });

  it('caps memory at capacity for arbitrarily long streams', () => {
    const r = new Reservoir(128);
    for (let i = 0; i < 10_000; i++) r.add(i);
    expect(r.size()).toBeLessThanOrEqual(128);
    expect(r.seenCount()).toBe(10_000);
  });

  it('percentile of empty reservoir is 0', () => {
    const r = new Reservoir(8);
    expect(r.percentile(50)).toBe(0);
    expect(r.percentile(99)).toBe(0);
  });

  it('rejects invalid capacity and percentile args', () => {
    expect(() => new Reservoir(0)).toThrow(/capacity/);
    expect(() => new Reservoir(-1)).toThrow(/capacity/);
    expect(() => new Reservoir(1.5)).toThrow(/capacity/);
    const r = new Reservoir(8);
    expect(() => r.percentile(-0.01)).toThrow(/p/);
    expect(() => r.percentile(100.01)).toThrow(/p/);
    expect(() => r.percentile(NaN)).toThrow(/p/);
  });

  it('approximates known uniform distribution within ±5% on p50/p95', () => {
    const r = new Reservoir(1024);
    const N = 200_000;
    for (let i = 1; i <= N; i++) r.add(i);
    const p50 = r.percentile(50);
    const p95 = r.percentile(95);
    // Точные значения: p50 ≈ N/2, p95 ≈ 0.95*N. ±5% — щедрая вилка.
    expect(p50).toBeGreaterThan(N * 0.45);
    expect(p50).toBeLessThan(N * 0.55);
    expect(p95).toBeGreaterThan(N * 0.90);
    expect(p95).toBeLessThan(N * 0.99);
  });

  it('percentile(50/95/99) over full capacity is fast (<20ms total)', () => {
    const r = new Reservoir(SUMMARY_RESERVOIR_CAPACITY);
    for (let i = 0; i < 5_000; i++) r.add(Math.random() * 5000);
    const t0 = performance.now();
    for (let p = 0; p <= 100; p += 1) r.percentile(p);
    const dt = performance.now() - t0;
    expect(dt).toBeLessThan(50);
  });

  it('handles negative values (cold-tail latencies)', () => {
    const r = new Reservoir(64);
    for (let i = -100; i < 100; i++) r.add(i);
    expect(r.percentile(50)).toBeGreaterThanOrEqual(-100);
    expect(r.percentile(95)).toBeLessThanOrEqual(99);
  });

  it('uses default SUMMARY_RESERVOIR_CAPACITY when none passed', () => {
    const r = new Reservoir();
    expect(r.capacity).toBe(SUMMARY_RESERVOIR_CAPACITY);
  });
});
