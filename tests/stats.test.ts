import { describe, it, expect } from 'vitest';
import { newSummary, fold, renderTextReport, summaryToJson, SUMMARY_RESERVOIR_CAPACITY } from '../src/stats.js';
import type { TrackEvent } from '../src/core/tracker.js';

function ev(partial: Partial<TrackEvent>): TrackEvent {
  return {
    ts: '2026-05-18T00:00:00Z',
    method: 'POST',
    path: '/v1/messages',
    status: 200,
    duration_ms: 100,
    ...partial,
  };
}

describe('stats aggregator', () => {
  it('counts status buckets', () => {
    const s = newSummary();
    fold(s, ev({ status: 200 }));
    fold(s, ev({ status: 201 }));
    fold(s, ev({ status: 404 }));
    fold(s, ev({ status: 503 }));
    fold(s, ev({ status: 500 }));
    expect(s.total).toBe(5);
    expect(s.ok2xx).toBe(2);
    expect(s.err4xx).toBe(1);
    expect(s.err5xx).toBe(2);
  });

  it('separates compressed vs passthrough and collects skip reasons', () => {
    const s = newSummary();
    fold(s, ev({ compressed: true, orig_chars: 1000, image_bytes: 200 }));
    fold(s, ev({ compressed: true, orig_chars: 2000, image_bytes: 300 }));
    fold(s, ev({ compressed: false, reason: 'below_min_chars (50 < 2000)' }));
    fold(s, ev({ compressed: false, reason: 'below_min_chars (60 < 2000)' }));
    fold(s, ev({ compressed: false, reason: 'compress=false' }));
    expect(s.compressed).toBe(2);
    expect(s.passthrough).toBe(3);
    expect(s.origCharsTotal).toBe(3000);
    expect(s.imageBytesTotal).toBe(500);
    // Reasons keep their exact string form (parenthetical char counts and
    // all) — useful for spotting outliers without collapsing detail.
    expect(s.skipReasons.size).toBe(3);
    expect(s.skipReasons.get('below_min_chars (50 < 2000)')).toBe(1);
    expect(s.skipReasons.get('below_min_chars (60 < 2000)')).toBe(1);
    expect(s.skipReasons.get('compress=false')).toBe(1);
  });

  it('aggregates Anthropic token usage and computes cache hit metrics', () => {
    const s = newSummary();
    fold(
      s,
      ev({
        input_tokens: 100,
        output_tokens: 10,
        cache_read_tokens: 0,
        cache_create_tokens: 5000,
      }),
    );
    fold(
      s,
      ev({
        input_tokens: 50,
        output_tokens: 5,
        cache_read_tokens: 5000,
        cache_create_tokens: 0,
      }),
    );
    fold(
      s,
      ev({
        input_tokens: 60,
        output_tokens: 6,
        cache_read_tokens: 5000,
        cache_create_tokens: 0,
      }),
    );
    // 3 events all carried usage; 2 had cache_read > 0.
    expect(s.eventsWithUsage).toBe(3);
    expect(s.cacheHitEvents).toBe(2);
    expect(s.inputTokensTotal).toBe(210);
    expect(s.outputTokensTotal).toBe(21);
    expect(s.cacheReadTokensTotal).toBe(10000);
    expect(s.cacheCreateTokensTotal).toBe(5000);
  });

  it('buckets by cwd and tracks system_sha8 reuse', () => {
    const s = newSummary();
    fold(s, ev({ cwd: '/a', system_sha8: 'aaa', orig_chars: 100, image_bytes: 20 }));
    fold(s, ev({ cwd: '/a', system_sha8: 'aaa', orig_chars: 100, image_bytes: 20 }));
    fold(s, ev({ cwd: '/b', system_sha8: 'bbb', orig_chars: 200, image_bytes: 40 }));
    expect(s.byCwd.size).toBe(2);
    expect(s.byCwd.get('/a')!.count).toBe(2);
    expect(s.byCwd.get('/a')!.origChars).toBe(200);
    expect(s.systemShaHist.get('aaa')).toBe(2);
    expect(s.systemShaHist.get('bbb')).toBe(1);
  });

  it('collects unknown_static_tags across events', () => {
    const s = newSummary();
    fold(s, ev({ unknown_static_tags: ['recent_files', 'todo_list'] }));
    fold(s, ev({ unknown_static_tags: ['recent_files'] }));
    fold(s, ev({}));
    expect(s.unknownTags.get('recent_files')).toBe(2);
    expect(s.unknownTags.get('todo_list')).toBe(1);
  });

  it('renders a non-empty text report for a populated summary', () => {
    const s = newSummary();
    for (let i = 0; i < 100; i++) {
      fold(
        s,
        ev({
          compressed: true,
          orig_chars: 5000,
          image_bytes: 1000,
          input_tokens: 50,
          cache_read_tokens: i % 2 === 0 ? 4000 : 0,
          cache_create_tokens: i % 2 === 0 ? 0 : 4000,
          duration_ms: 100 + i,
          first_byte_ms: 30 + i,
          cwd: '/Users/x/code/pp',
          system_sha8: 'stable',
        }),
      );
    }
    const out = renderTextReport(s);
    expect(out).toContain('pxpipe stats');
    expect(out).toContain('compressed');
    expect(out).toContain('cache hit rate');
    expect(out).toContain('/Users/x/code/pp');
    expect(out).toContain('stable');
    // 50% cache hit rate by event.
    expect(out).toMatch(/cache hit rate \(by events\):\s+50.0%/);
    // SPEC-007: no mojibake — replacement chars (U+FFFD) from a bad
    // re-encode of em-dashes/bullets would make the report unreadable.
    expect(out).not.toContain('\uFFFD');
  });

  it('empty report uses em-dash placeholders and stays FFFD-free (SPEC-007)', () => {
    const s = newSummary();
    const out = renderTextReport(s);
    expect(out).toContain('—');
    expect(out).not.toContain('\uFFFD');
  });

  it('uses bounded reservoir for duration/firstByte on 1M events', () => {
    const s = newSummary();
    for (let i = 0; i < 1_000_000; i++) {
      fold(
        s,
        ev({
          duration_ms: 50 + (i % 950), // 50..999
          first_byte_ms: 5 + (i % 95), // 5..99
        }),
      );
    }
    // Резервуар — ровно capacity, не миллион.
    expect(s.durationSample.size()).toBe(SUMMARY_RESERVOIR_CAPACITY);
    expect(s.firstByteSample.size()).toBe(SUMMARY_RESERVOIR_CAPACITY);
    expect(s.durationSample.seenCount()).toBe(1_000_000);
    // p95 в верхней декаде распределения 50..999.
    expect(s.durationSample.percentile(95)).toBeGreaterThan(900);
    expect(s.durationSample.percentile(95)).toBeLessThan(1000);
  });

  it('summaryToJson carries all percentile keys (p50/p95/p99)', () => {
    const s = newSummary();
    fold(s, ev({ duration_ms: 100, first_byte_ms: 50 }));
    const json = summaryToJson(s) as Record<string, number>;
    expect(json.durationP50).toBeGreaterThan(0);
    expect(json.durationP95).toBeGreaterThan(0);
    expect(json.durationP99).toBeGreaterThan(0);
    expect(json.firstByteP50).toBeGreaterThan(0);
    expect(json.firstByteP95).toBeGreaterThan(0);
    expect(json.firstByteP99).toBeGreaterThan(0);
    // Служебные резервуары не должны утекать в JSON.
    expect((json as any).durationSample).toBeUndefined();
    expect((json as any).firstByteSample).toBeUndefined();
    expect((json as any).durationMs).toBeUndefined();
    expect((json as any).firstByteMs).toBeUndefined();
  });
});
