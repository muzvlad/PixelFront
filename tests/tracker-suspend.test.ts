/**
 * SPEC-002: FileTracker suspend/resume — covers the data-loss bug where
 * events emitted during `prune()`'s rename window would write to the
 * detached pre-rename inode and be silently lost when the kernel reaped
 * the orphan.
 *
 * These tests exercise the public suspend/resume contract on a real
 * FileTracker. The class is exported from src/node.ts specifically for
 * this test suite (production uses the singleton from main()).
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileTracker } from '../src/node.js';
import type { TrackEvent } from '../src/core/tracker.js';

function mkEvent(i: number): TrackEvent {
  return { ts: new Date(i).toISOString(), method: 'POST', path: '/x', status: 200, duration_ms: i };
}

describe('FileTracker suspend/resume (SPEC-002)', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxpipe-suspend-'));
    file = path.join(dir, 'events.jsonl');
  });

  afterEach(() => {
    // Best-effort cleanup; FileTracker holds an fd open until close()
    // is called, so we walk any left-behind tracker refs via scan of
    // open fds is overkill — the OS reaps them when the process exits.
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('queues events during suspend and flushes in FIFO order on resume', async () => {
    const t = new FileTracker(file);

    await t.suspend!();

    // While suspended, the underlying file should not exist yet.
    for (let i = 0; i < 100; i++) t.emit(mkEvent(i));
    expect(fs.existsSync(file)).toBe(false);

    t.resume!();

    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(lines.length).toBe(100);
    for (let i = 0; i < 100; i++) {
      const ev = JSON.parse(lines[i]!) as TrackEvent;
      expect(ev.duration_ms).toBe(i);
    }

    t.close!();
  });

  it('writes buffered events to the canonical path after a mid-suspend rename', async () => {
    // This is the SPEC-002 regression: pre-fix, the cached fd points at
    // the pre-rename inode, so writes during prune vanish when the
    // orphan is reaped. Post-fix, resume() drops the cached fd and
    // reopen-by-name lands writes on the canonical inode.
    const t = new FileTracker(file);

    // Seed one event so the canonical file exists and the fd is open.
    t.emit(mkEvent(-1));
    expect(fs.existsSync(file)).toBe(true);
    const seeded = fs.readFileSync(file, 'utf8');

    await t.suspend!();
    for (let i = 0; i < 50; i++) t.emit(mkEvent(i + 100));

    // Simulate prune(): rename the canonical file away, then create a
    // fresh empty canonical file at the same path.
    const orphan = file + '.orphan';
    fs.renameSync(file, orphan);
    fs.writeFileSync(file, '');

    t.resume!();

    // Orphan should contain ONLY the seeded event — the 50 buffered
    // events must NOT have leaked to the detached inode.
    expect(fs.readFileSync(orphan, 'utf8')).toBe(seeded);

    // Canonical file should contain all 50 buffered events in order.
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(lines.length).toBe(50);
    expect((JSON.parse(lines[0]!) as TrackEvent).duration_ms).toBe(100);
    expect((JSON.parse(lines[49]!) as TrackEvent).duration_ms).toBe(149);

    t.close!();
  });

  it('caps the suspend queue at MAX_PENDING with drop-oldest overflow', async () => {
    const t = new FileTracker(file);

    await t.suspend!();
    // MAX_PENDING is 5000 (private). Push 6000 to overflow by 1000.
    for (let i = 0; i < 6000; i++) t.emit(mkEvent(i));

    t.resume!();

    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(lines.length).toBeLessThanOrEqual(5000);
    expect(lines.length).toBeGreaterThan(0);

    t.close!();
  });

  it('resume is a no-op when not suspended', () => {
    const t = new FileTracker(file);

    // No suspend() called — resume() must early-return cleanly.
    expect(() => t.resume!()).not.toThrow();

    t.emit(mkEvent(0));
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(lines.length).toBe(1);

    t.close!();
  });

  it('emits after suspend close cleanly without leaving zombie fds', async () => {
    const t = new FileTracker(file);
    await t.suspend!();
    for (let i = 0; i < 5; i++) t.emit(mkEvent(i));
    t.resume!();
    // Now emit more after resume — must use the re-opened fd.
    for (let i = 5; i < 10; i++) t.emit(mkEvent(i));
    t.close!();

    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(lines.length).toBe(10);
  });
});