// Ties everything together: pick a version, lay out the text, solve, choose a mask.

import { blockLayout, symbolSize } from './qr.js';
import { penaltyScore } from './matrix.js';
import { applyMask, utf8Bytes, smallestVersion, encodePlain, payloadBits, buildDataCodewords, interleave, placeCodewords } from './encode.js';
import { Skeleton } from './matrix.js';
import { solve, pinnedModuleMap, randomFreeBits } from './qart.js';
import { FONT_BY_ID } from './fonts.js';
import { resolveStyle, placeText, wrapText, domainOf, normaliseUrl, DEFAULT_CLEARANCE, INK_WEIGHT, OVERRIDE_WEIGHT } from './layout.js';

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
  text = null,
  ecl = 'M',
  fontId = 'lower',
  styleId = 'band',
  maxLines = 2,
  versionOverride = null,
  margin = 1,
  clearance = DEFAULT_CLEARANCE,
  offset = null,
  overrides = null,
}) {
  const encoded = normaliseUrl(url);
  const bytes = utf8Bytes(encoded);
  const label = (text ?? domainOf(encoded)).trim();
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
          maxLines, margin, allowHardWrap, encoded, clearance, offset, minRatio, overrides,
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

function attemptVersion({ version, ecl, bytes, label, font, style, fontId, styleId, maxLines, margin, allowHardWrap, encoded, clearance, offset, minRatio = 0, overrides = null }) {
  const size = symbolSize(version);
  const usable = size - 2 * margin - 2 * clearance;
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

  // Hand-set modules replace whatever the layout wanted there and outrank it,
  // so a module the reader has clicked survives even when freedom runs short.
  let targets = placed.targets;
  if (overrides && overrides.length) {
    const byIndex = new Map(targets.map(t => [t.index, t]));
    for (const o of overrides) {
      if (pin.map[o.index]) continue; // that module cannot be moved at all
      byIndex.set(o.index, { index: o.index, value: o.value, weight: OVERRIDE_WEIGHT });
    }
    targets = [...byIndex.values()];
  }

  const res = solve({ version, ecl, bytes, targets });
  if (!res) return null;

  const scored = res.results.map(r => {
    const modules = applyMask(res.skeleton, r.unmasked, r.mask);
    return { ...r, modules, penalty: penaltyScore(modules, size) };
  });
  scored.sort((a, b) => (a.weightedMisses - b.weightedMisses) || (a.penalty - b.penalty));
  const bestMask = scored[0];

  const inkTargets = targets.filter(t => t.weight === INK_WEIGHT);
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
    // which clicks are possible and to colour the preview
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

/** A conventional QR code with standard padding, for side-by-side comparison. */
export function generatePlain({ url, ecl = 'M', versionOverride = null, margin = 1 }) {
  const encoded = normaliseUrl(url);
  const bytes = utf8Bytes(encoded);
  const version = versionOverride ?? smallestVersion(ecl, bytes.length);
  if (version === null) return null;
  const enc = encodePlain(version, ecl, encoded);
  if (!enc) return null;
  const size = symbolSize(version);
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const modules = applyMask(enc.skeleton, enc.unmasked, mask);
    const penalty = penaltyScore(modules, size);
    if (!best || penalty < best.penalty) best = { mask, modules, penalty };
  }
  return { modules: best.modules, size, version, ecl, mask: best.mask, encoded, margin, label: domainOf(encoded) };
}

/**
 * The same URL with random bits after the terminator but no artwork. This
 * isolates the one assumption the whole approach rests on: that a decoder
 * stops at the terminator and never looks at the padding. If a scanner reads
 * this correctly, it will read any code this app produces.
 */
export function generateNoisyPadding({ url, ecl = 'M', versionOverride = null, margin = 1 }) {
  const encoded = normaliseUrl(url);
  const bytes = utf8Bytes(encoded);
  const version = versionOverride ?? smallestVersion(ecl, bytes.length);
  if (version === null) return null;
  const built = buildDataCodewords(version, ecl, bytes);
  if (!built) return null;
  const noise = randomFreeBits(built.freeCount, 0x5bf03635);
  const filled = buildDataCodewords(version, ecl, bytes, noise);
  const skeleton = new Skeleton(version, ecl);
  const unmasked = placeCodewords(skeleton, interleave(filled.data, filled.layout));
  const size = symbolSize(version);
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const modules = applyMask(skeleton, unmasked, mask);
    const penalty = penaltyScore(modules, size);
    if (!best || penalty < best.penalty) best = { mask, modules, penalty };
  }
  return { modules: best.modules, size, version, ecl, mask: best.mask, encoded, margin, label: domainOf(encoded) };
}
