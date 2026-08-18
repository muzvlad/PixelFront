import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { HTMX_JS, ALPINE_JS, VENDOR_INTEGRITY } from '../src/dashboard/vendor.js';
import { dashboardCsp } from '../src/dashboard/fragments.js';

describe('vendor integrity (SPEC-014)', () => {
  it('VENDOR_INTEGRITY hashes match the inlined payloads', () => {
    const entries = { HTMX_JS, ALPINE_JS };
    for (const [name, js] of Object.entries(entries)) {
      const expected = 'sha384-' + createHash('sha384').update(js, 'utf8').digest('base64');
      expect(VENDOR_INTEGRITY[name]).toBe(expected);
    }
  });

  it('dashboard CSP hashes every inline script and forbids unsafe-inline', () => {
    const csp = dashboardCsp();
    expect(csp.startsWith('script-src')).toBe(true);
    expect(csp).not.toContain('unsafe-inline');
    // THEME_BOOT_JS + HTMX_JS + GLUE_JS + THEME_JS + ALPINE_JS
    expect(csp.match(/sha384-/g)?.length).toBe(5);
  });
});
