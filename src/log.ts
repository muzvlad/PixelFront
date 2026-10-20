// Level-aware logging (SPEC-015) + colored categories (SPEC-021). Imported by
// src/node.ts; kept separate so tests can exercise filtering without main().
const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type LogLevel = keyof typeof LOG_LEVELS;

// Семантические категории для цвета (SPEC-021). Логика цветов:
//   start   — успешный запуск/готовность   (зелёный)
//   process — рабочие процессы/маршруты     (оранжевый, как --img в дашборде)
//   notice  — порт/модели/адрес дашборда    (синий, как --txt в дашборде)
//   restart — остановка/перезапуск          (голубой)
//   error   — сбои и краши                  (красный/бордовый)
//   warn    — предупреждения                (жёлтый)
//   request — обычные запросы               (серый)
//   debug   — отладка                       (тёмно-серый)
export type LogCategory =
  | 'start' | 'process' | 'notice' | 'restart' | 'error' | 'warn' | 'request' | 'debug';

// Truecolor: точное совпадение с палитрой дашборда.
//   --img  #ff5a1f (Сжато в изображения)  → 255;90;31
//   --txt  #2f7db0 (Оставлено как текст)  → 47;125;176
const ANSI: Record<LogCategory, string> = {
  start: '\x1b[38;2;63;189;118m',   // зелёный (--good dark)
  process: '\x1b[38;2;255;90;31m',  // оранжевый (--img)
  notice: '\x1b[38;2;47;125;176m',  // тёмно-голубой (--txt)
  restart: '\x1b[38;2;90;163;214m', // голубой (--txt dark)
  error: '\x1b[38;2;216;72;59m',    // красный (--bad)
  warn: '\x1b[38;2;183;121;31m',    // жёлтый (--warn)
  request: '\x1b[38;2;155;145;137m', // серый (--muted)
  debug: '\x1b[38;2;155;145;137m',  // серый
};
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

const PREFIX = '[PixelFront]';

let warnedInvalid = false;

/** Цвет включаем только в TTY (терминал), чтобы файлы и пайпы оставались
 *  чистым текстом. NO_COLOR/PXPIPE_NO_COLOR всегда выключают; FORCE_COLOR
 *  и PXPIPE_FORCE_COLOR включают принудительно. */
function colorsEnabled(): boolean {
  const env = typeof process !== 'undefined' ? process.env : undefined;
  if (!env) return false;
  if (env.NO_COLOR !== undefined || env.PXPIPE_NO_COLOR !== undefined) return false;
  if (env.FORCE_COLOR !== undefined || env.PXPIPE_FORCE_COLOR !== undefined) return true;
  return Boolean(process.stdout && process.stdout.isTTY);
}

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

const LEVEL_CATEGORY: Record<LogLevel, LogCategory> = {
  debug: 'debug',
  info: 'process',
  warn: 'warn',
  error: 'error',
};

function paint(text: string, cat: LogCategory): string {
  if (!colorsEnabled()) return text;
  return `${ANSI[cat]}${text}${RESET}`;
}

/** Одна строка лога с префиксом категории. */
function emit(level: LogLevel, cat: LogCategory, prefix: string, args: unknown[]): void {
  const fn =
    level === 'error' ? console.error :
    level === 'warn' ? console.warn :
    console.log;
  fn(paint(prefix, cat), ...args);
}

function log(level: LogLevel, ...args: unknown[]): void {
  if (LOG_LEVELS[level] < LOG_LEVELS[currentLogLevel()]) return;
  const cat = LEVEL_CATEGORY[level];
  // info без явной категории: `[PixelFront]`; прочие: `[PixelFront warn]` и т.д.
  const prefix = level === 'info' ? PREFIX : `${PREFIX.slice(0, -1)} ${level}]`;
  emit(level, cat, prefix, args);
}

export const debug = (...args: unknown[]): void => log('debug', ...args);

export const info = (...args: unknown[]): void => log('info', ...args);

export const warn = (...args: unknown[]): void => log('warn', ...args);

export const error = (...args: unknown[]): void => log('error', ...args);

/** Цветное событие с семантической категорией (SPEC-021):
 *  start — зелёный, process — оранжевый, notice — синий, restart — голубой. */
export function status(cat: LogCategory, ...args: unknown[]): void {
  if (LOG_LEVELS.info < LOG_LEVELS[currentLogLevel()]) return;
  const tag = label(cat);
  const prefix = tag ? `${PREFIX} ${tag}` : PREFIX;
  emit('info', cat, prefix, args);
}

/** Русский ярлык категории. Пустой — когда префикс уже говорит сам за себя. */
function label(cat: LogCategory): string {
  switch (cat) {
    case 'start': return 'запуск';
    case 'process': return 'работа';
    case 'notice': return '';
    case 'restart': return 'перезапуск';
    case 'request': return 'запрос';
    default: return '';
  }
}

// Inline-стили для частей сообщения (без цвета при выключенных цветах).
const ITALIC = '\x1b[3m';
const FG_GRAY = '\x1b[38;2;155;145;137m';
const FG_BRIGHT_GREEN = '\x1b[38;2;80;230;120m';

/** Тусклый курсив — для пояснений вроде «(если задан ключ)». */
export function dimItalic(text: string): string {
  if (!colorsEnabled()) return text;
  return `${ITALIC}${FG_GRAY}${text}${RESET}`;
}

/** Ярко-зелёный — для выделения значимых значений (адрес дашборда). */
export function bright(text: string): string {
  if (!colorsEnabled()) return text;
  return `${FG_BRIGHT_GREEN}${text}${RESET}`;
}

export { colorsEnabled, BOLD, RESET };
