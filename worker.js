// Generation runs off the main thread: a full gallery is roughly a second of
// Gauss-Jordan elimination and would otherwise freeze the page.

import { buildVariants } from './src/variants.js';
import { generate, generatePlain, generateNoisyPadding } from './src/generate.js';

// Structured clone handles the Uint8Array; drop everything the UI never reads.
function pack(r) {
  if (!r) return null;
  return {
    id: r.id, unfit: r.unfit, error: r.error,
    modules: r.modules, size: r.size, version: r.version, ecl: r.ecl, mask: r.mask,
    encoded: r.encoded, label: r.label, lines: r.lines,
    fontId: r.fontId, styleId: r.styleId, hardWrapped: r.hardWrapped,
    clearance: r.clearance, offset: r.offset, bounds: r.bounds, editable: r.editable,
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
    } else if (type === 'check') {
      const tests = [
        {
          key: 'plain',
          name: '1. Control',
          note: 'An ordinary QR code with the conventional EC/11 padding. Establishes that the scanner, screen and lighting are fine.',
          result: generatePlain(opts),
        },
        {
          key: 'noisy',
          name: '2. Padding',
          note: 'Same URL, same size, but the padding after the terminator is random. No artwork. This is the assumption under test.',
          result: generateNoisyPadding(opts),
        },
        {
          key: 'qart',
          name: '3. The real thing',
          note: 'Padding solved to spell the domain name inside the code.',
          result: generate({ ...opts, fontId: 'lower', styleId: 'plate' })
               ?? generate({ ...opts, fontId: 'micro', styleId: 'plate' }),
        },
      ];
      for (const t of tests) {
        self.postMessage({ type: 'check', token, key: t.key, name: t.name, note: t.note, result: pack(t.result) });
      }
      self.postMessage({ type: 'done', token });
    }
  } catch (err) {
    self.postMessage({ type: 'error', token, message: String(err && err.stack || err) });
  }
};
