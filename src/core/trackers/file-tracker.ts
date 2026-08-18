/**
 * Node-only append-only JSONL tracker with size-based rotation and
 * suspend/resume. Lives outside src/node.ts so unit tests can import it
 * without pulling in `main()` (which would bind a real dashboard socket).
 *
 * Rotation: when the current file exceeds MAX_FILE_BYTES (100 MB by default),
 * it's renamed to `<path>.1` (overwriting any previous .1) and a fresh file
 * is opened. Keeps one generation of history; for longer retention pipe
 * the file off-host yourself.
 *
 * Failures here NEVER propagate — the proxy must keep serving requests even
 * if the disk is full or the path is unwritable.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TrackEvent, Tracker } from '../tracker.js';

/** Append-only JSONL tracker. Exported for tests (SPEC-002/SPEC-005). */
export class FileTracker implements Tracker {
  private stream: fs.WriteStream | null = null;
  private bytesWritten = 0;
  private brokenLogged = false;
  /** Optional hook (SPEC-011): called with bytes handed to the stream.
   *  Lets the host throttle periodic fsync by write volume. */
  onBytesWritten?: (n: number) => void;
  /** Writes handed to WriteStream whose 'drain'/completion callback hasn't
   *  fired yet. flush() waits for this to reach 0 before fsync. */
  private pendingWrites = 0;
  /** Resolvers parked by flush() waiting for the next write-completion. */
  private drainWaiters: Array<() => void> = [];
  private static readonly MAX_FILE_BYTES = 100 * 1024 * 1024;
  /** WriteStream internal buffer — large enough that the disk stays busy
   *  while emit() never blocks the event loop (SPEC-005). */
  private static readonly HIGH_WATER_MARK = 64 * 1024;
  /** Hard cap for in-memory queue while suspended. Drops oldest on overflow. */
  private static readonly MAX_PENDING = 5000;

  /** While true, emit() buffers into `pending` instead of writing to the stream. */
  private suspended = false;
  /** Set during a file rotation; emit() buffers so post-rotation events
   *  land in the fresh file, not the renamed one (same FIFO as suspend). */
  private isRotating = false;
  /** Resolves when the in-flight rotation (incl. pending drain) completes.
   *  close() awaits it so shutdown never loses the buffered tail. */
  private rotationDone: Promise<void> | null = null;
  private pending: TrackEvent[] = [];
  private droppedDuringSuspend = 0;
  private suspendOverflowLogged = false;

  constructor(private readonly filePath: string) {}

  private ensureOpen(): boolean {
    if (this.stream != null) return true;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    } catch {
      /* dir may already exist or be unmkable; the open below will surface */
    }
    try {
      this.bytesWritten = fs.statSync(this.filePath).size;
    } catch {
      this.bytesWritten = 0;
    }
    try {
      // Touch the file synchronously so a subsequent readFileSync (tests,
      // dashboard) sees it even though WriteStream opens its fd asynchronously.
      const touch = fs.openSync(this.filePath, 'a');
      fs.closeSync(touch);
    } catch {
      /* unwritable dir — the stream 'error' handler will log once */
    }
    try {
      this.stream = fs.createWriteStream(this.filePath, {
        flags: 'a',
        highWaterMark: FileTracker.HIGH_WATER_MARK,
      });
      this.stream.on('error', (err) => {
        // Never let a broken tracker take down a request; the next emit()
        // will try to reopen.
        if (!this.brokenLogged) {
          console.error(`[pxpipe] FileTracker stream error: ${err.message}`);
          this.brokenLogged = true;
        }
        this.stream = null;
      });
      return true;
    } catch (err) {
      if (!this.brokenLogged) {
        console.error(
          `[pxpipe] FileTracker disabled — cannot open ${this.filePath}: ${(err as Error).message}`,
        );
        this.brokenLogged = true;
      }
      return false;
    }
  }

  private scheduleRotate(): void {
    if (this.stream == null || this.isRotating) return;
    this.isRotating = true;
    const oldStream = this.stream;
    this.stream = null;
    // Wait for WriteStream to flush before renaming — closing the old inode
    // first avoids Windows rename-of-open-file failures.
    this.rotationDone = new Promise<void>((resolve) => {
      oldStream.end(() => {
        try {
          fs.renameSync(this.filePath, this.filePath + '.1');
        } catch {
          /* if rename fails (e.g. .1 locked) we'll just keep growing — better
             than dropping events */
        }
        this.bytesWritten = 0;
        this.isRotating = false;
        if (!this.suspended) this.drainPending();
        resolve();
      });
    });
  }

  private drainPending(): void {
    const q = this.pending;
    this.pending = [];
    for (const ev of q) this.emit(ev);
  }

  emit(ev: TrackEvent): void {
    if (this.suspended || this.isRotating) {
      if (this.pending.length < FileTracker.MAX_PENDING) {
        this.pending.push(ev);
      } else {
        this.droppedDuringSuspend++;
      }
      return;
    }
    if (!this.ensureOpen() || this.stream == null) return;
    let line: string;
    try {
      line = JSON.stringify(ev) + '\n';
    } catch {
      return;
    }
    const buf = Buffer.from(line, 'utf8');
    // stream.write never blocks: on backpressure the chunk stays in the
    // WriteStream's internal buffer until 'drain'. No own queue needed.
    // The completion callback fires once the chunk has been handed to the
    // kernel — flush() awaits these before fsync (SPEC-011).
    this.pendingWrites++;
    this.stream.write(buf, () => {
      this.pendingWrites--;
      const waiter = this.drainWaiters.shift();
      waiter?.();
    });
    this.onBytesWritten?.(buf.length);
    this.bytesWritten += buf.length;
    if (this.bytesWritten > FileTracker.MAX_FILE_BYTES && !this.isRotating) {
      this.scheduleRotate();
    }
  }

  /** Wait for every in-flight write to reach the kernel, then fsync the
   *  file — periodic crash-safety (SPEC-011). Keeps the stream open, so the
   *  next emit() writes through the same fd. */
  async flush(): Promise<void> {
    const s = this.stream;
    if (s == null) return;
    while (this.pendingWrites > 0) {
      await new Promise<void>((resolve) => this.drainWaiters.push(resolve));
    }
    const fd = (s as unknown as { fd: number | null }).fd;
    if (fd != null) {
      try {
        await new Promise<void>((resolve, reject) => {
          fs.fsync(fd, (err) => (err ? reject(err) : resolve()));
        });
      } catch {
        /* ignore — tracker never propagates */
      }
    }
  }

  async close(): Promise<void> {
    // If a rotation is in flight, wait for it to finish and drain `pending`
    // first — otherwise buffered events could be lost on shutdown.
    if (this.rotationDone) {
      await this.rotationDone;
      this.rotationDone = null;
    }
    const s = this.stream;
    this.stream = null;
    if (s == null) return;
    const fd = (s as unknown as { fd: number | null }).fd;
    if (fd != null) {
      try {
        await new Promise<void>((resolve, reject) => {
          fs.fsync(fd, (err) => (err ? reject(err) : resolve()));
        });
      } catch {
        /* ignore */
      }
    }
    await new Promise<void>((resolve) => s.end(() => resolve()));
  }

  /**
   * Stop writing to the underlying stream. emit() will buffer events into
   * `pending` until resume() is called. The stream is torn down so the
   * already-buffered bytes are flushed to the file before the caller does
   * destructive ops (e.g. sessions.ts:prune renames events.jsonl). Errors
   * are swallowed — tracker never propagates failures.
   */
  async suspend(): Promise<void> {
    this.suspended = true;
    const s = this.stream;
    this.stream = null;
    if (s != null) {
      await new Promise<void>((resolve) => s.end(() => resolve()));
    }
  }

  /**
   * Re-enable emission. The stream was torn down by suspend(), so the next
   * emit() reopens the path by name — critical after prune's rename(),
   * because the old stream pointed at the orphaned pre-rename inode. Then
   * drains `pending` in FIFO order. If the queue overflowed during suspend,
   * log once.
   */
  resume(): void {
    if (!this.suspended) return;
    this.suspended = false;
    try {
      const st = fs.statSync(this.filePath);
      this.bytesWritten = st.size;
    } catch {
      this.bytesWritten = 0;
    }
    if (this.isRotating) return; // the rotation callback drains
    this.drainPending();
    if (this.droppedDuringSuspend > 0 && !this.suspendOverflowLogged) {
      console.warn(
        `[pxpipe] FileTracker dropped ${this.droppedDuringSuspend} events ` +
          `(suspend queue full at ${FileTracker.MAX_PENDING}); consider shorter prune windows.`,
      );
      this.suspendOverflowLogged = true;
    }
  }
}