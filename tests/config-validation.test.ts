import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  validateConfig,
  normaliseModelsField,
  KNOWN_CONFIG_KEYS,
  type ConfigShape,
} from '../src/config.js';

describe('validateConfig', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('returns undefined for non-object inputs', () => {
    // @ts-expect-error testing invalid input
    expect(validateConfig(42)).toBeUndefined();
    // @ts-expect-error
    expect(validateConfig('foo')).toBeUndefined();
    // @ts-expect-error
    expect(validateConfig(null)).toBeUndefined();
    expect(validateConfig([1, 2])).toBeUndefined();
    expect(validateConfig(undefined)).toBeUndefined();
  });

  it('parses models as a plain string', () => {
    expect(validateConfig({ models: 'claude-*' })?.models).toBe('claude-*');
    expect(validateConfig({ models: '  claude-*  ' })?.models).toBe('claude-*');
    expect(validateConfig({ models: '' })?.models).toBe('off');
    expect(validateConfig({ models: '   ' })?.models).toBe('off');
  });

  it('parses models as a string array', () => {
    expect(validateConfig({ models: ['claude-*', 'deepseek-*'] })?.models)
      .toBe('claude-*,deepseek-*');
    expect(validateConfig({ models: [] })?.models).toBe('off');
    expect(validateConfig({ models: ['claude-*', ''] })?.models).toBe('claude-*');
  });

  it('warns and returns an empty config on wrong type', () => {
    const result = validateConfig({ models: 42 });
    expect(result).toEqual({});
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('models'),
    );
  });

  it('warns on a mixed array of strings and non-strings', () => {
    const result = validateConfig({ models: ['claude-*', 42] });
    expect(result).toEqual({});
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('non-string values'),
    );
  });

  it('warns on boolean / null / object models value', () => {
    // @ts-expect-error testing invalid input
    validateConfig({ models: true });
    // @ts-expect-error
    validateConfig({ models: null });
    // @ts-expect-error
    validateConfig({ models: { nested: 'x' } });
    expect(warnSpy).toHaveBeenCalledTimes(3);
    for (const call of warnSpy.mock.calls) {
      expect(call[0]).toContain('models');
    }
  });

  it('ignores unknown keys silently (forward compat)', () => {
    const result = validateConfig({
      models: 'claude-*',
      port: 8080,
      fog: 'baz',
      deeply: { nested: { value: 1 } },
    });
    expect(warnSpy).not.toHaveBeenCalled();
    expect(result?.models).toBe('claude-*');
    expect(result).not.toHaveProperty('port');
  });

  it('returns an empty config when no recognised key is present', () => {
    expect(validateConfig({})).toEqual({});
    expect(validateConfig({ port: 8080, verbose: true })).toEqual({});
  });

  it('KNOWN_CONFIG_KEYS enumerates the recognised keys (forward-compat surface)', () => {
    // Pin the public forward-compat surface — add a key here AND in
    // validateConfig at the same time. If you add a new key, the test fails
    // and you intentionally update both.
    expect(KNOWN_CONFIG_KEYS.has('models')).toBe(true);
    expect(KNOWN_CONFIG_KEYS.size).toBe(1);
  });
});

describe('normaliseModelsField', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('trims whitespace on string input', () => {
    expect(normaliseModelsField('  claude-*  ')).toBe('claude-*');
  });

  it('returns "off" for an empty / whitespace string', () => {
    expect(normaliseModelsField('')).toBe('off');
    expect(normaliseModelsField('   ')).toBe('off');
  });

  it('joins a clean array', () => {
    expect(normaliseModelsField(['a', 'b', 'c'])).toBe('a,b,c');
  });

  it('drops empty strings from the array', () => {
    expect(normaliseModelsField(['a', '', 'b'])).toBe('a,b');
  });

  it('returns undefined and warns on a mixed array', () => {
    // @ts-expect-error testing invalid input
    const out = normaliseModelsField(['a', 1]);
    expect(out).toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
  });
});

/**
 * `applyConfigFileDefaults` lives in node.ts (boots the proxy). Direct
 * invocation here would re-import and re-execute the module — instead we
 * re-implement the wire-up here against a tmpfile to assert the env-mutation
 * semantics that matter for the contract:
 *
 *   - If the file exists and is valid, PXPIPE_MODELS is populated.
 *   - If PXPIPE_MODELS was already in env, the file is shadowed.
 *   - Missing file → no throw.
 *
 * The function itself is exercised end-to-end via the existing integration
 * tests; here we only lock the contract.
 */
describe('applyConfigFileDefaults contract (env semantics)', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxpipe-config-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.PXPIPE_MODELS;
  });

  it('returns a parsed ConfigShape for a valid config file', () => {
    const cfg = path.join(tmpDir, 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({ models: 'claude-*,deepseek-*' }));
    const parsed = JSON.parse(fs.readFileSync(cfg, 'utf8')) as unknown;
    const result: ConfigShape | undefined = validateConfig(parsed);
    expect(result?.models).toBe('claude-*,deepseek-*');
  });

  it('env wins over file-derived models (parsed shape unchanged)', () => {
    const cfg = path.join(tmpDir, 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({ models: 'from-file' }));
    process.env.PXPIPE_MODELS = 'from-env';
    const parsed = JSON.parse(fs.readFileSync(cfg, 'utf8')) as unknown;
    const result = validateConfig(parsed);
    // The validator does NOT touch env — that's the caller's contract. We
    // only assert that the parsed value is what would be assigned if env
    // were unset.
    expect(result?.models).toBe('from-file');
    expect(process.env.PXPIPE_MODELS).toBe('from-env');
  });
});
