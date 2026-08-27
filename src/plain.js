// A plain QR code: no text inside, no solving, the smallest symbol that will
// carry the payload.
//
// Everything else here spends symbol size to buy free bits, because steering
// letterforms needs somewhere to steer them from. That trade is the whole
// point of the tool, but it is the wrong trade when the code is going to be
// cut, engraved, or etched: there the cost of a module is physical, and the
// smallest possible symbol wins.

import { Skeleton, penaltyScore } from './matrix.js';
import {
  buildDataCodewords, interleave, placeCodewords, applyMask,
  utf8Bytes, smallestVersion, payloadBits,
} from './encode.js';
import { domainOf, normalizeUrl } from './layout.js';

// Weakest to strongest, which is the order the tie-break below relies on.
export const ECLS = ['L', 'M', 'Q', 'H'];

/**
 * Fills everything after the terminator the way the spec asks: zeros up to the
 * next byte boundary, then 0xEC and 0x11 alternating.
 *
 * The solver leaves this region at zero and then treats it as free variables.
 * A plain code has nothing to solve for, and the alternating bytes are worth
 * having anyway: a long run of zeros makes large blank patches that the mask
 * penalty then has to work around.
 */
function padStandard(data, freeStart) {
  const first = Math.ceil(freeStart / 8); // bits below this belong to the terminator
  for (let b = first; b < data.length; b++) {
    data[b] = (b - first) % 2 === 0 ? 0xEC : 0x11;
  }
}

/** One plain code at a fixed error-correction level. */
export function plainCode({ url, payload = null, label: labelIn = null, text = null, ecl = 'M' }) {
  const encoded = payload ?? normalizeUrl(url);
  if (!encoded) return null;
  const bytes = utf8Bytes(encoded);
  const version = smallestVersion(ecl, bytes.length);
  if (version === null) return null;

  const built = buildDataCodewords(version, ecl, bytes);
  if (!built) return null;
  padStandard(built.data, built.freeStart);

  const skeleton = new Skeleton(version, ecl);
  const unmasked = placeCodewords(skeleton, interleave(built.data, built.layout));

  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const modules = applyMask(skeleton, unmasked, mask);
    const penalty = penaltyScore(modules, skeleton.size);
    if (!best || penalty < best.penalty) best = { modules, penalty, mask };
  }

  const payloadCodewords = Math.ceil(payloadBits(version, bytes.length) / 8);
  return {
    plain: true,
    id: `plain-${ecl}`,
    modules: best.modules,
    size: skeleton.size,
    version, ecl, mask: best.mask,
    encoded,
    label: (text ?? labelIn ?? domainOf(encoded)).trim(),
    lines: [],
    fontId: null, styleId: null,
    offset: null, bounds: null,
    // Nothing here is free: every bit is payload, its padding, or error
    // correction. An all-zero map keeps the editor honest about that.
    editable: new Uint8Array(skeleton.size * skeleton.size),
    stats: {
      penalty: best.penalty,
      dataCodewords: built.layout.dataCodewords,
      payloadCodewords,
      padCodewords: built.layout.dataCodewords - payloadCodewords,
      ecCodewords: built.layout.ecPerBlock * built.layout.numBlocks,
      blocks: built.layout.numBlocks,
    },
  };
}

/**
 * The smallest plain code that holds the payload and, among the levels that
 * reach that same size, the most redundant one.
 *
 * Levels do not map one to one onto versions: a payload that needs version 3
 * at level M often still needs version 3 at level Q, and the extra redundancy
 * is then free. Taking it is strictly better, so the tie-break runs weakest
 * to strongest and keeps the last level to match the smallest size.
 */
export function bestPlainCode(opts) {
  let best = null;
  for (const ecl of ECLS) {
    const code = plainCode({ ...opts, ecl });
    if (code && (!best || code.size <= best.size)) best = code;
  }
  return best;
}
