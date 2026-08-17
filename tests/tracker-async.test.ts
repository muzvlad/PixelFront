/**
 * SPEC-005: FileTracker async I/O — emit() must not block the event loop.
 *
 * The synchronous fs.writeSync/fs.fsyncSync/fs.closeSync path kept the
 * event loop busy on every hot-path event (and on shutdown). These tests
 * exercise the WriteStream-based implementation: non-blocking emit,
 * backpressure survival, rotation, and idempotent async close().
 *
 * Timing assertions use generous margins so they stay stable on CI (the
 * absolute numbers are a canary, not a benchmark).
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileTracker } from '../src/core/trackers/file-tracker.js';
import type { TrackEvent } from '../src/core/tracker.js';

function mkEvent(i: number): TrackEvent {
  return { ts: new Date(i).toISOString(), method: 'POST', path: '/x', status: 200, duration_ms: i };
}

describe('FileTracker async I/O (SPEC-005)', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxpipe-async-'));
    file = path.join(dir, 'events.jsonl');
  });

  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('emit is non-blocking: 10k events in well under a second', async () => {
    const t = new FileTracker(file);
    const start = performance.now();
    for (let i = 0; i < 10_000; i++) t.emit(mkEvent(i));
    const elapsed = performance.now() - start;
    // WriteStream.write just queues; anything near this ceiling would mean
    // we accidentally blocked per write.
    expect(elapsed).toBeLessThan(1000);
    await t.close!();
  });

  it('backpressure: emit 10k events faster than disk drains → no loss', async () => {
    const t = new FileTracker(file);
    const N = 10_000;
    for (let i = 0; i < N; i++) {
      t.emit({ ts: '', method: 'POST', path: '/x', status: 200, duration_ms: i });
    }
    // close() waits for the WriteStream internal buffer to fully drain.
    await t.close!();

    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(lines.length).toBe(N);
  });

  it('rotates events.jsonl → .1 when MAX_FILE_BYTES is exceeded', async () => {
    const FileTrackerAny = FileTracker as unknown as { MAX_FILE_BYTES: number };
    const orig = FileTrackerAny.MAX_FILE_BYTES;
    FileTrackerAny.MAX_FILE_BYTES = 2000; // force several rotations
    try {
      const t = new FileTracker(file);
      for (let i = 0; i < 200; i++) t.emit(mkEvent(i));
      await t.close!();

      // A rotation happened: the rolled file exists…
      expect(fs.existsSync(file + '.1')).toBe(true);
      // …and the canonical file exists with the post-rotation tail.
      expect(fs.existsSync(file)).toBe(true);
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
      expect(lines.length).toBeGreaterThan(0);
    } finally {
      FileTrackerAny.MAX_FILE_BYTES = orig;
    }
  });

  it('close is idempotent', async () => {
    const t = new FileTracker(file);
    await t.close!();
    await t.close!(); // must not throw
  });

  it('close flushes events even when emit never awaited anything', async () => {
    const t = new FileTracker(file);
    for (let i = 0; i < 100; i++) t.emit(mkEvent(i));
    await t.close!();

    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(lines.length).toBe(100);
  });
});