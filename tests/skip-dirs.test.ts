/**
 * SPEC-009: configurable skip dirs for pxpipe export. Unit tests for
 * buildWalkSkipDirs() — pure function in src/config.ts (no CLI build needed).
 */
import { describe, expect, it } from 'vitest';
import { buildWalkSkipDirs, DEFAULT_WALK_SKIP_DIRS } from '../src/config.js';

describe('buildWalkSkipDirs (SPEC-009)', () => {
  it('returns the defaults when env is unset', () => {
    const set = buildWalkSkipDirs({});
    expect(set).toContain('node_modules');
    expect(set).toContain('.git');
    expect(set.size).toBe(DEFAULT_WALK_SKIP_DIRS.length);
  });

  it('extends defaults with custom dirs (trimmed, empties filtered)', () => {
    const set = buildWalkSkipDirs({ PXPIPE_SKIP_DIRS: '.venv, target , ,vendor' });
    expect(set).toContain('node_modules'); // default preserved
    expect(set).toContain('.venv');
    expect(set).toContain('target');
    expect(set).toContain('vendor');
    expect(set.size).toBe(DEFAULT_WALK_SKIP_DIRS.length + 3);
  });

  it('handles empty env gracefully', () => {
    const set = buildWalkSkipDirs({ PXPIPE_SKIP_DIRS: '' });
    expect(set.size).toBe(DEFAULT_WALK_SKIP_DIRS.length);
  });
});