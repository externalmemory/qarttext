// Ties everything together: pick a version, lay out the text, solve, choose a mask.

import { blockLayout, symbolSize } from './qr.js';
import { penaltyScore } from './matrix.js';
import { applyMask, chooseSegment, smallestVersion, payloadBits } from './encode.js';
import { solve, pinnedModuleMap } from './qart.js';
import { FONT_BY_ID, drawableText } from './fonts.js';
import { resolveStyle, placeText, wrapText, domainOf, normalizeUrl, caseFoldableUrl, DEFAULT_CLEARANCE, INK_WEIGHT, NEAR_WEIGHT } from './layout.js';

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
// How many versions the search will pay to put the label on fewer lines.
//
// Wrapping is what lets a smaller symbol hold the text, so the first version
// that works is often the one that broke the label in two. That reads badly:
// two short lines span far less of the code than one long one -- 75% of the
// width against 86% for the same domain -- and the label ends up floating in
// the middle of a field of noise. Paying a version or three to keep it whole
// is usually the better picture, and past that the symbol has grown enough
// that the wrap was the right call after all.
export const LINE_PREMIUM = 3;

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
  alnum = true,
  versionOverride = null,
  margin = 1,
  clearance = DEFAULT_CLEARANCE,
  offset = null,
  rotation = 0,
}) {
  // Callers may hand over exactly what to encode and exactly what to draw; a
  // bare url is the shorthand for the common case.
  const raw = payload ?? normalizeUrl(url);
  if (!raw) return null;
  // The label is taken before any case folding, so what gets drawn keeps the
  // case that was typed even when the payload goes uppercase to buy a mode.
  const label = (text ?? labelIn ?? domainOf(raw)).trim();
  if (!label) return null;
  const seg = chooseSegment(raw, alnum && caseFoldableUrl(raw));
  const encoded = seg.text;

  const font = FONT_BY_ID[fontId];
  const style = resolveStyle(styleId);
  if (!font || !style) return null;
  // What gets drawn may differ from what gets reported: an accent this face
  // cannot draw comes off the letter rather than turning it into a question
  // mark. The label keeps the accent, so the caption and the file name do too.
  const drawn = drawableText(font, label) || label;

  if (!TURNS.has(rotation)) return null;
  const start = versionOverride ?? smallestVersion(ecl, seg);
  if (start === null) return null;
  const end = versionOverride ?? MAX_VERSION;

  let best = null;
  // Passes, cheapest acceptable first: skip under-provisioned symbol sizes,
  // keep domain labels whole, and only relax each of those if nothing works.
  for (const minRatio of [MIN_FREE_RATIO, 0]) {
    for (const allowHardWrap of [false, true]) {
      let tried = 0;
      // the first workable symbol size, and the fewest lines seen since
      let good = null;
      for (let version = start; version <= end; version++) {
        const attempt = attemptVersion({
          version, ecl, seg, label, drawn, font, style, fontId, styleId,
          maxLines, margin, allowHardWrap, encoded, clearance, offset, minRatio, rotation,
        });
        if (!attempt) continue;
        attempt.hardWrapped = allowHardWrap;
        if (!best || attempt.stats.score > best.stats.score) best = attempt;
        // good enough: every letterform module correct, nothing touching a stroke
        // the wrong colour, and a near-clean plate
        if (attempt.stats.inkMisses === 0 && attempt.stats.nearMisses === 0 && attempt.stats.fidelity >= 0.985) {
          if (!good || attempt.lines.length < good.lines.length) good = attempt;
          // one line cannot be beaten, and past the premium the wrap has won
          if (good.lines.length === 1 || version >= good.version + LINE_PREMIUM) return good;
        }
        if (++tried >= SEARCH_DEPTH) break;
      }
      if (good) return good;
      if (best) return best;
    }
  }
  return best;
}

// Quarter turns a finished symbol can be shown at: readers find the finder
// patterns before anything else, so a turned code scans like any other.
const TURNS = new Set([0, 90, 180, 270]);

/**
 * For a symbol turned clockwise by `rotation` degrees, the standard-frame
 * index behind each module as shown; null for no turn.
 */
function turnMap(size, rotation) {
  if (!rotation) return null;
  const at = {
    90: (r, c) => (size - 1 - c) * size + r,
    180: (r, c) => (size - 1 - r) * size + (size - 1 - c),
    270: (r, c) => c * size + (size - 1 - r),
  }[rotation];
  const map = new Int32Array(size * size);
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) map[r * size + c] = at(r, c);
  return map;
}

function attemptVersion({ version, ecl, seg, label, drawn, font, style, fontId, styleId, maxLines, margin, allowHardWrap, encoded, clearance, offset, minRatio = 0, rotation = 0 }) {
  const size = symbolSize(version);
  const usable = size - 2 * margin - 2 * Math.ceil(clearance);
  if (usable <= 0) return null;

  const lines = wrapText(font, drawn, usable, maxLines, allowHardWrap);
  if (!lines) return null;

  const pin = pinnedModuleMap(version, ecl, seg);
  if (!pin) return null;

  // The text is laid out upright on the symbol as it will be shown, turned;
  // only the solver works in the standard frame.
  const turn = turnMap(size, rotation);
  const shown = (a) => turn ? Uint8Array.from(turn, j => a[j]) : a;
  const placed = placeText({
    size, pinned: shown(pin.map),
    isFunction: shown(pin.skeleton.isFunction), functionValue: shown(pin.skeleton.functionValue),
    fontId, styleId, lines, clearance, offset,
  });
  if (!placed) return null;
  const targets = turn ? placed.targets.map(t => ({ ...t, index: turn[t.index] })) : placed.targets;
  // Cheap rejection, before paying for the elimination.
  if (pin.freeBits < placed.targets.length * minRatio) return null;

  const res = solve({ version, ecl, seg, targets });
  if (!res) return null;

  const scored = res.results.map(r => {
    const modules = applyMask(res.skeleton, r.unmasked, r.mask);
    return { ...r, modules, penalty: penaltyScore(modules, size) };
  });
  scored.sort((a, b) => (a.weightedMisses - b.weightedMisses) || (a.penalty - b.penalty));
  const bestMask = scored[0];

  // Counted in the frame the result is shown in, which is the frame the
  // targets were laid out in.
  const modules = shown(bestMask.modules);
  const inkTargets = placed.targets.filter(t => t.weight === INK_WEIGHT);
  const inkMisses = inkTargets.filter(t => modules[t.index] !== t.value).length;
  const nearTargets = placed.targets.filter(t => t.weight === NEAR_WEIGHT);
  const nearMisses = nearTargets.filter(t => modules[t.index] !== t.value).length;
  const fidelity = 1 - bestMask.misses / placed.targets.length;
  // letterform accuracy dominates; ties broken toward smaller symbols
  const score = (1 - inkMisses / Math.max(1, inkTargets.length)) * 100
    + (1 - nearMisses / Math.max(1, nearTargets.length)) * 30
    + fidelity * 10 - version * 0.05;

  return {
    modules,
    size, version, ecl, mask: bestMask.mask, rotation,
    encoded, mode: seg.mode, label, lines,
    fontId, styleId, margin, clearance: placed.clearance,
    rect: placed.rect, offset: placed.offset, bounds: placed.bounds,
    // 1 where a module can still be changed; the editor needs this to know
    // which clicks are possible and to color the preview
    editable: shown(pin.map).map(v => v ^ 1),
    // The modules that decide legibility, kept so a hand edit can be recounted
    // against them rather than leaving the solver's figures in place.
    checks: {
      ink: inkTargets.map(t => [t.index, t.value]),
      near: nearTargets.map(t => [t.index, t.value]),
    },
    stats: {
      freeBits: res.freeBits,
      forced: placed.targets.length,
      rank: res.rank,
      misses: bestMask.misses,
      inkTotal: inkTargets.length,
      inkMisses,
      nearTotal: nearTargets.length,
      nearMisses,
      fidelity,
      score,
      penalty: bestMask.penalty,
      dataCodewords: blockLayout(version, ecl).dataCodewords,
      payloadCodewords: Math.ceil(payloadBits(version, seg) / 8),
    },
  };
}
