// Generation runs off the main thread: a full gallery is roughly a second of
// Gauss-Jordan elimination and would otherwise freeze the page.

import { buildVariants } from './src/variants.js';
import { generate } from './src/generate.js';

// Structured clone handles the Uint8Array; drop everything the UI never reads.
function pack(r) {
  if (!r) return null;
  return {
    id: r.id, unfit: r.unfit, error: r.error,
    modules: r.modules, size: r.size, version: r.version, ecl: r.ecl, mask: r.mask,
    encoded: r.encoded, label: r.label, lines: r.lines,
    fontId: r.fontId, styleId: r.styleId, hardWrapped: r.hardWrapped,
    clearance: r.clearance, offset: r.offset, bounds: r.bounds, editable: r.editable,
    // the text box: the cut output needs it to know which corners are letterform
    rect: r.rect, plain: r.plain,
    stats: r.stats,
  };
}

self.onmessage = (event) => {
  const { type, token, ...opts } = event.data;
  try {
    if (type === 'variants') {
      buildVariants(opts, (result, i, n) => {
        self.postMessage({ type: 'variant', token, result: pack(result), i, n });
      });
      self.postMessage({ type: 'done', token });
    } else if (type === 'nudge') {
      // Re-solve at a fixed version with the text pinned to an exact offset.
      self.postMessage({ type: 'nudged', token, result: pack(generate(opts)) });
    }
  } catch (err) {
    self.postMessage({ type: 'error', token, message: String(err && err.stack || err) });
  }
};
