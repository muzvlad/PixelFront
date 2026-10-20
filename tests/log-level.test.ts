import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { debug, info, warn, error, status, colorsEnabled } from '../src/log.js';

describe('log level (SPEC-015)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    delete process.env.PXPIPE_LOG_LEVEL;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    delete process.env.PXPIPE_LOG_LEVEL;
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('default level = info (debug suppressed, info emitted with plain [pxpipe] prefix)', () => {
    debug('debug-msg');
    info('info-msg');
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('debug-msg'));
    expect(logSpy).toHaveBeenCalledWith('[pxpipe]', 'info-msg');
  });

  it('level=warn suppresses debug+info, keeps warn', () => {
    process.env.PXPIPE_LOG_LEVEL = 'warn';
    debug('debug-msg');
    info('info-msg');
    warn('warn-msg');
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith('[pxpipe warn]', 'warn-msg');
  });

  it('level=error suppresses everything except errors', () => {
    process.env.PXPIPE_LOG_LEVEL = 'error';
    debug('d');
    info('i');
    warn('w');
    error('error-msg');
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith('[pxpipe error]', 'error-msg');
  });

  it('level=debug shows per-request output', () => {
    process.env.PXPIPE_LOG_LEVEL = 'debug';
    debug('debug-msg');
    info('info-msg');
    expect(logSpy).toHaveBeenCalledWith('[pxpipe debug]', 'debug-msg');
    expect(logSpy).toHaveBeenCalledWith('[pxpipe]', 'info-msg');
  });

  it('invalid level falls back to info with a warning', () => {
    process.env.PXPIPE_LOG_LEVEL = 'loud';
    expect(info('info-msg')).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('unknown PXPIPE_LOG_LEVEL: loud'),
    );
    expect(logSpy).toHaveBeenCalledWith('[pxpipe]', 'info-msg');
  });

  it('colors gating: NO_COLOR off, FORCE_COLOR on (SPEC-021)', () => {
    const savedNoColor = process.env.NO_COLOR;
    const savedForce = process.env.FORCE_COLOR;
    try {
      process.env.NO_COLOR = '1';
      delete process.env.FORCE_COLOR;
      expect(colorsEnabled()).toBe(false);
      delete process.env.NO_COLOR;
      process.env.FORCE_COLOR = '1';
      expect(colorsEnabled()).toBe(true);
    } finally {
      if (savedNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = savedNoColor;
      if (savedForce === undefined) delete process.env.FORCE_COLOR;
      else process.env.FORCE_COLOR = savedForce;
    }
  });

  it('status() carries the category label in the prefix (SPEC-021)', () => {
    status('start', 'готово');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[pxpipe] запуск'), 'готово');
    status('restart', 'стоп');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[pxpipe] перезапуск'), 'стоп');
  });
});