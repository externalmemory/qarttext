// Ties everything together: pick a version, lay out the text, solve, choose a mask.

import { blockLayout, symbolSize } from './qr.js';
import { penaltyScore } from './matrix.js';
import { applyMask, utf8Bytes, smallestVersion, payloadBits } from './encode.js';
import { solve, pinnedModuleMap } from './qart.js';
import { FONT_BY_ID } from './fonts.js';
import { resolveStyle, placeText, wrapText, domainOf, normalizeUrl, DEFAULT_CLEARANCE, INK_WEIGHT } from './layout.js';

// How many workable symbol sizes to try before settling for the best so far.
// There is no fixed ceiling imposed by scanners: a large symbol reads fine if
// it is printed large enough. This only bounds the search.
export const SEARCH_DEPTH = 12;
export const MAX_VERSION = 40;
// Every forced module needs a free bit, so a version with barely more free
// bits than modules to force cannot possibly come out clean. Checking the
// ratio costs nothing next to a solve, and skipping these stops the search
// budget being spent on symbol sizes that were never going to work.
export const MIN_FREE_RATIO = 1.5;

/**
 * Builds one human-readable QR code.
 * Returns null if the text cannot be made to fit within `maxVersion`.
 */
export function generate({
  url,
  payload = null,
  label: labelIn = null,
  text = null,
  ecl = 'M',
  fontId = 'lower',
  styleId = 'band',
  maxLines = 2,
  versionOverride = null,
  margin = 1,
  clearance = DEFAULT_CLEARANCE,
  offset = null,
}) {
  // Callers may hand over exactly what to encode and exactly what to draw; a
  // bare url is the shorthand for the common case.
  const encoded = payload ?? normalizeUrl(url);
  if (!encoded) return null;
  const bytes = utf8Bytes(encoded);
  const label = (text ?? labelIn ?? domainOf(encoded)).trim();
  if (!label) return null;

  const font = FONT_BY_ID[fontId];
  const style = resolveStyle(styleId);
  if (!font || !style) return null;

  const start = versionOverride ?? smallestVersion(ecl, bytes.length);
  if (start === null) return null;
  const end = versionOverride ?? MAX_VERSION;

  let best = null;
  // Passes, cheapest acceptable first: skip under-provisioned symbol sizes,
  // keep domain labels whole, and only relax each of those if nothing works.
  for (const minRatio of [MIN_FREE_RATIO, 0]) {
    for (const allowHardWrap of [false, true]) {
      let tried = 0;
      for (let version = start; version <= end; version++) {
        const attempt = attemptVersion({
          version, ecl, bytes, label, font, style, fontId, styleId,
          maxLines, margin, allowHardWrap, encoded, clearance, offset, minRatio,
        });
        if (!attempt) continue;
        attempt.hardWrapped = allowHardWrap;
        if (!best || attempt.stats.score > best.stats.score) best = attempt;
        // good enough: every letterform module correct and a near-clean plate
        if (attempt.stats.inkMisses === 0 && attempt.stats.fidelity >= 0.985) return attempt;
        if (++tried >= SEARCH_DEPTH) break;
      }
      if (best) return best;
    }
  }
  return best;
}

function attemptVersion({ version, ecl, bytes, label, font, style, fontId, styleId, maxLines, margin, allowHardWrap, encoded, clearance, offset, minRatio = 0 }) {
  const size = symbolSize(version);
  const usable = size - 2 * margin - 2 * Math.ceil(clearance);
  if (usable <= 0) return null;

  const lines = wrapText(font, label, usable, maxLines, allowHardWrap);
  if (!lines) return null;

  const pin = pinnedModuleMap(version, ecl, bytes.length);
  if (!pin) return null;

  const placed = placeText({
    size, pinned: pin.map,
    isFunction: pin.skeleton.isFunction, functionValue: pin.skeleton.functionValue,
    fontId, styleId, lines, clearance, offset,
  });
  if (!placed) return null;
  // Cheap rejection, before paying for the elimination.
  if (pin.freeBits < placed.targets.length * minRatio) return null;

  const res = solve({ version, ecl, bytes, targets: placed.targets });
  if (!res) return null;

  const scored = res.results.map(r => {
    const modules = applyMask(res.skeleton, r.unmasked, r.mask);
    return { ...r, modules, penalty: penaltyScore(modules, size) };
  });
  scored.sort((a, b) => (a.weightedMisses - b.weightedMisses) || (a.penalty - b.penalty));
  const bestMask = scored[0];

  const inkTargets = placed.targets.filter(t => t.weight === INK_WEIGHT);
  const inkMisses = inkTargets.filter(t => bestMask.modules[t.index] !== t.value).length;
  const fidelity = 1 - bestMask.misses / placed.targets.length;
  // letterform accuracy dominates; ties broken toward smaller symbols
  const score = (1 - inkMisses / Math.max(1, inkTargets.length)) * 100 + fidelity * 10 - version * 0.05;

  return {
    modules: bestMask.modules,
    size, version, ecl, mask: bestMask.mask,
    encoded, label, lines,
    fontId, styleId, margin, clearance: placed.clearance,
    rect: placed.rect, offset: placed.offset, bounds: placed.bounds,
    // 1 where a module can still be changed; the editor needs this to know
    // which clicks are possible and to color the preview
    editable: pin.map.map(v => v ^ 1),
    stats: {
      freeBits: res.freeBits,
      forced: placed.targets.length,
      rank: res.rank,
      misses: bestMask.misses,
      inkTotal: inkTargets.length,
      inkMisses,
      fidelity,
      score,
      penalty: bestMask.penalty,
      dataCodewords: blockLayout(version, ecl).dataCodewords,
      payloadCodewords: Math.ceil(payloadBits(version, bytes.length) / 8),
    },
  };
}
