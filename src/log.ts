// Level-aware logging (SPEC-015). Imported by src/node.ts; kept separate so
// tests can exercise filtering without importing main().
const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type LogLevel = keyof typeof LOG_LEVELS;

let warnedInvalid = false;

/** Live-resolved level — flips take effect without a restart (like
 *  applicability.ts model scope). Unknown values warn once, then 'info'. */
function currentLogLevel(): LogLevel {
  const raw = typeof process !== 'undefined' ? process.env?.PXPIPE_LOG_LEVEL : undefined;
  if (raw === undefined) return 'info';
  const v = raw.trim().toLowerCase();
  if (v in LOG_LEVELS) return v as LogLevel;
  if (!warnedInvalid) {
    warnedInvalid = true;
    console.warn(`[pxpipe] unknown PXPIPE_LOG_LEVEL: ${v}, defaulting to 'info'`);
  }
  return 'info';
}

/** Prefix: plain `[pxpipe]` for info keeps old stdout parsers working; other
 *  levels get an explicit `[pxpipe warn]`/`[pxpipe error]`/`[pxpipe debug]`. */
function log(level: LogLevel, ...args: unknown[]): void {
  if (LOG_LEVELS[level] < LOG_LEVELS[currentLogLevel()]) return;
  const fn =
    level === 'error' ? console.error :
    level === 'warn' ? console.warn :
    console.log;
  const prefix = level === 'info' ? '[pxpipe]' : `[pxpipe ${level}]`;
  fn(prefix, ...args);
}

export const debug = (...args: unknown[]): void => log('debug', ...args);
export const info = (...args: unknown[]): void => log('info', ...args);
export const warn = (...args: unknown[]): void => log('warn', ...args);
export const error = (...args: unknown[]): void => log('error', ...args);
