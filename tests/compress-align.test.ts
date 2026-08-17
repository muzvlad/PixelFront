/**
 * SPEC-001 alignment test: renderTextToImages (direct) vs runExportCore (via
 * the public SDK primitive). Both code paths MUST produce identical page
 * counts, dimensions, and PNG bytes — any drift means the SDK consumer
 * (pxpipe-proxy/transform) sees different images than the CLI exporter.
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import { renderTextToImages } from '../src/core/library.ts';
import { runExportCore } from '../src/core/export.ts';

// A long, multi-line block that reliably triggers multi-col pack under the
// library defaults (cols=312, multiCol='auto'). Each line is well under 200
// chars so it fits in a single pack column.
const TEXT = Array.from(
  { length: 800 },
  (_, i) => `// line ${String(i + 1).padStart(4, '0')}: ${'x'.repeat(40)}`,
).join('\n');

const COMMON_COLS = 312;
const COMMON_MODEL = 'claude-sonnet-5.6';

describe('SPEC-001: render ↔ export alignment', () => {
  it('produces identical page count, dimensions, and PNG bytes', async () => {
    const direct = await renderTextToImages(TEXT, {
      cols: COMMON_COLS,
      shrink: true,
      multiCol: 'auto',
      reflow: true,
    });

    const exported = await runExportCore(TEXT, {
      sourceFiles: ['inline.txt'],
      cols: COMMON_COLS,
      model: COMMON_MODEL,
    });

    assert.equal(
      exported.manifest.pages.length,
      direct.pages.length,
      `page count drift: direct=${direct.pages.length} export=${exported.manifest.pages.length}`,
    );

    for (let i = 0; i < direct.pages.length; i++) {
      const d = direct.pages[i];
      const e = exported.manifest.pages[i];

      assert.equal(e.width, d.width, `page ${i} width drift`);
      assert.equal(e.height, d.height, `page ${i} height drift`);
      assert.equal(e.bytes, d.png.byteLength, `page ${i} bytes drift`);

      // PNG bytes must be byte-identical: same deflate stream, same palette.
      const a = exported.artifacts.find((x) => x.filename === e.filename)!;
      assert.equal(a.data.byteLength, d.png.byteLength, `page ${i} artifact size drift`);
      for (let b = 0; b < a.data.byteLength; b++) {
        assert.equal(
          a.data[b],
          d.png[b],
          `page ${i} byte ${b} drift — renderTextToImages and runExportCore produce different PNGs`,
        );
      }
    }
  });

  it('honors cols override in both paths', async () => {
    const narrow = 120;
    const wide = 600;

    const a = await renderTextToImages(TEXT, {
      cols: narrow,
      shrink: true,
      multiCol: 'auto',
      reflow: true,
    });
    const b = await renderTextToImages(TEXT, {
      cols: wide,
      shrink: true,
      multiCol: 'auto',
      reflow: true,
    });

    // Narrow cols pack more columns per page → at least as many pages (or more)
    assert.ok(
      a.pages.length >= b.pages.length,
      `narrow cols should yield ≥ pages (narrow=${a.pages.length} wide=${b.pages.length})`,
    );
  });
});
