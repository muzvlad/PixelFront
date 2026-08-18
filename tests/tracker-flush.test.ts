import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileTracker } from '../src/core/trackers/file-tracker.js';

const ev = { ts: '', method: 'POST', path: '/x', status: 200, duration_ms: 1 };

describe('FileTracker flush (SPEC-011)', () => {
  it('flush() is a no-op when nothing was written', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxpipe-flush-'));
    const file = path.join(dir, 'e.jsonl');
    const t = new FileTracker(file);
    await t.flush!();
    expect(fs.existsSync(file)).toBe(false);
    await t.close();
  });

  it('flush() waits for in-flight writes and leaves the stream open', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxpipe-flush-'));
    const file = path.join(dir, 'e.jsonl');
    const t = new FileTracker(file);
    t.emit(ev);
    await t.flush!();
    const afterFlush = fs.readFileSync(file, 'utf8');
    expect(afterFlush).toContain('duration_ms');
    // Stream stays open: the next emit lands in the same file, appended.
    t.emit(ev);
    await t.close();
    const afterClose = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
    expect(afterClose).toHaveLength(2);
  });

  it('onBytesWritten hook reports every written byte', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxpipe-flush-'));
    const file = path.join(dir, 'e.jsonl');
    const t = new FileTracker(file);
    const seen: number[] = [];
    t.onBytesWritten = (n: number) => seen.push(n);
    t.emit(ev);
    await t.flush!();
    await t.close();
    const raw = fs.readFileSync(file, 'utf8');
    expect(seen.reduce((a, b) => a + b, 0)).toBe(Buffer.byteLength(raw, 'utf8'));
    expect(seen.length).toBeGreaterThan(0);
  });
});
