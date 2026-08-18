// Builds the gallery: one candidate per font and style combination.

import { generate, generatePlain } from './generate.js';
import { FONTS } from './fonts.js';
import { STYLES } from './layout.js';

export function variantSpecs({ fonts = null, styles = null } = {}) {
  const fs = fonts ?? FONTS.map(f => f.id);
  const ss = styles ?? STYLES.map(s => s.id);
  const out = [];
  for (const styleId of ss) for (const fontId of fs) out.push({ fontId, styleId });
  return out;
}

/**
 * Generates every variant, calling `onResult` as each completes so the UI can
 * fill in progressively. Ordered so the most legible combinations arrive first.
 */
export function buildVariants(opts, onResult) {
  const specs = variantSpecs(opts);
  const results = [];
  specs.forEach((spec, i) => {
    let res = null;
    try {
      res = generate({ ...opts, ...spec });
    } catch (err) {
      res = { error: String(err && err.message || err), ...spec };
    }
    if (res) {
      res.id = `${spec.fontId}-${spec.styleId}`;
      results.push(res);
      onResult?.(res, i, specs.length);
    } else {
      onResult?.({ id: `${spec.fontId}-${spec.styleId}`, ...spec, unfit: true }, i, specs.length);
    }
  });
  return results;
}

export { generatePlain };
