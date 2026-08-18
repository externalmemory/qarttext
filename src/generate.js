// Ties everything together: pick a version, lay out the text, solve, choose a mask.

import { blockLayout, symbolSize } from './qr.js';
import { penaltyScore } from './matrix.js';
import { applyMask, utf8Bytes, smallestVersion, encodePlain, payloadBits, buildDataCodewords, interleave, placeCodewords } from './encode.js';
import { Skeleton } from './matrix.js';
import { solve, pinnedModuleMap, randomFreeBits } from './qart.js';
import { FONT_BY_ID } from './fonts.js';
import { STYLE_BY_ID, placeText, wrapText, domainOf, normaliseUrl } from './layout.js';

export const DEFAULT_MAX_VERSION = 20;

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
  maxVersion = DEFAULT_MAX_VERSION,
  versionOverride = null,
  margin = 1,
}) {
  const encoded = normaliseUrl(url);
  const bytes = utf8Bytes(encoded);
  const label = (text ?? domainOf(encoded)).trim();
  if (!label) return null;

  const font = FONT_BY_ID[fontId];
  const style = STYLE_BY_ID[styleId];
  if (!font || !style) return null;

  const start = versionOverride ?? smallestVersion(ecl, bytes.length);
  if (start === null) return null;
  const end = versionOverride ?? maxVersion;

  let best = null;
  // Two passes: keep domain labels whole if any version can manage it, and
  // only break mid-label as a last resort.
  for (const allowHardWrap of [false, true]) {
    for (let version = start; version <= end; version++) {
      const attempt = attemptVersion({
        version, ecl, bytes, label, font, style, fontId, styleId,
        maxLines, margin, allowHardWrap, encoded,
      });
      if (!attempt) continue;
      attempt.hardWrapped = allowHardWrap;
      if (!best || attempt.stats.score > best.stats.score) best = attempt;
      // good enough: every letterform module correct and a near-clean plate
      if (attempt.stats.inkMisses === 0 && attempt.stats.fidelity >= 0.985) return attempt;
    }
    if (best) return best;
  }
  return best;
}

function attemptVersion({ version, ecl, bytes, label, font, style, fontId, styleId, maxLines, margin, allowHardWrap, encoded }) {
  const size = symbolSize(version);
  const usable = size - 2 * margin - 2 * style.pad;
  if (usable <= 0) return null;

  const lines = wrapText(font, label, usable, maxLines, allowHardWrap);
  if (!lines) return null;

  const pin = pinnedModuleMap(version, ecl, bytes.length);
  if (!pin) return null;

  const placed = placeText({ size, pinned: pin.map, fontId, styleId, lines });
  if (!placed) return null;

  const res = solve({ version, ecl, bytes, targets: placed.targets });
  if (!res) return null;

  const scored = res.results.map(r => {
    const modules = applyMask(res.skeleton, r.unmasked, r.mask);
    return { ...r, modules, penalty: penaltyScore(modules, size) };
  });
  scored.sort((a, b) => (a.weightedMisses - b.weightedMisses) || (a.penalty - b.penalty));
  const bestMask = scored[0];

  const inkTargets = placed.targets.filter(t => t.weight === 3);
  const inkMisses = inkTargets.filter(t => bestMask.modules[t.index] !== t.value).length;
  const fidelity = 1 - bestMask.misses / placed.targets.length;
  // letterform accuracy dominates; ties broken toward smaller symbols
  const score = (1 - inkMisses / Math.max(1, inkTargets.length)) * 100 + fidelity * 10 - version * 0.05;

  return {
    modules: bestMask.modules,
    size, version, ecl, mask: bestMask.mask,
    encoded, label, lines,
    fontId, styleId, margin,
    rect: placed.rect,
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
