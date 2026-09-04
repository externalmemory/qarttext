// Payload assembly, block interleaving, and module rendering.

import { blockLayout, charCountBits, rsRemainder, symbolSize } from './qr.js';
import { maskBit } from './matrix.js';

export function utf8Bytes(str) {
  return new TextEncoder().encode(str);
}

// The 45 characters alphanumeric mode can encode, in value order. Note what is
// missing: lowercase letters. That single omission is why an ordinary URL is
// byte mode however short it is, and why using this mode at all means folding
// the payload to uppercase first.
export const ALNUM_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

const MODE_BITS = { byte: 0b0100, alnum: 0b0010 };

/**
 * A segment is what actually goes into the bit stream: a mode, the values that
 * mode encodes, and the text those values came from. Byte mode encodes UTF-8
 * bytes at 8 bits each; alphanumeric encodes indices into ALNUM_CHARS, packed
 * two to an 11-bit group, which is 5.5 bits per character instead of 8.
 */
export function byteSegment(text) {
  return { mode: 'byte', values: utf8Bytes(text), text };
}

/** Null when any character falls outside the 45, which includes any lowercase. */
export function alnumSegment(text) {
  const values = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const v = ALNUM_CHARS.indexOf(text[i]);
    if (v < 0) return null;
    values[i] = v;
  }
  return { mode: 'alnum', values, text };
}

/**
 * The segment to encode, given permission to fold case. Alphanumeric is tried
 * first and byte mode is the fallback, so a payload the 45-character set
 * cannot represent quietly keeps working.
 */
export function chooseSegment(text, allowAlnum) {
  if (allowAlnum) {
    const seg = alnumSegment(text.toUpperCase());
    if (seg) return seg;
  }
  return byteSegment(text);
}

// Bits consumed by the payload itself: mode + length field + data + terminator.
// The terminator is deliberately included: it is never treated as a free
// variable, so decoders always stop before the padding region.
export function payloadBits(version, seg) {
  const n = seg.values.length;
  const body = seg.mode === 'alnum'
    ? 11 * (n >> 1) + (n & 1 ? 6 : 0)   // pairs, then a lone 6-bit remainder
    : 8 * n;
  return 4 + charCountBits(version, seg.mode) + body + 4;
}

// Builds the data codeword array with the payload pinned and every bit after
// the terminator set to `fill` (0 for the baseline solve).
export function buildDataCodewords(version, ecl, seg, freeBits = null) {
  const layout = blockLayout(version, ecl);
  const capacityBits = layout.dataCodewords * 8;
  const used = payloadBits(version, seg);
  if (used > capacityBits + 4) return null; // terminator may be truncated

  const data = new Uint8Array(layout.dataCodewords);
  let pos = 0;
  const put = (value, width) => {
    for (let i = width - 1; i >= 0; i--) {
      if ((value >>> i) & 1) data[pos >> 3] |= 0x80 >> (pos & 7);
      pos++;
    }
  };
  put(MODE_BITS[seg.mode], 4);
  put(seg.values.length, charCountBits(version, seg.mode));
  if (seg.mode === 'alnum') {
    const v = seg.values;
    for (let i = 0; i + 1 < v.length; i += 2) put(v[i] * 45 + v[i + 1], 11);
    if (v.length & 1) put(v[v.length - 1], 6);
  } else {
    for (const b of seg.values) put(b, 8);
  }
  const termLen = Math.min(4, capacityBits - pos);
  put(0, termLen);

  const freeStart = pos;
  const freeCount = capacityBits - freeStart;
  if (freeBits) {
    for (let i = 0; i < freeCount; i++) {
      if (freeBits[i]) {
        const p = freeStart + i;
        data[p >> 3] |= 0x80 >> (p & 7);
      }
    }
  }
  return { data, layout, freeStart, freeCount };
}

// Splits data into blocks, appends EC, and interleaves into the final stream.
export function interleave(data, layout) {
  const { blocks, ecPerBlock, numBlocks, shortDataLen } = layout;
  const ec = blocks.map(b => rsRemainder(data, ecPerBlock, b.offset, b.offset + b.length));
  const result = new Uint8Array(layout.rawCodewords);
  let n = 0;
  const maxDataLen = shortDataLen + 1;
  for (let i = 0; i < maxDataLen; i++) {
    for (let j = 0; j < numBlocks; j++) {
      if (i < blocks[j].length) result[n++] = data[blocks[j].offset + i];
    }
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (let j = 0; j < numBlocks; j++) result[n++] = ec[j][i];
  }
  if (n !== layout.rawCodewords) throw new Error(`interleave mismatch ${n}`);
  return result;
}

// Places a codeword stream into the module grid. Returns the *unmasked* grid
// with function modules already filled in (format modules still zero).
export function placeCodewords(skeleton, codewords) {
  const modules = skeleton.functionValue.slice();
  const order = skeleton.order;
  for (let i = 0; i < order.length; i++) {
    const byte = i >> 3;
    const bit = byte < codewords.length ? (codewords[byte] >> (7 - (i & 7))) & 1 : 0;
    modules[order[i]] = bit;
  }
  return modules;
}

export function applyMask(skeleton, unmasked, mask) {
  const size = skeleton.size;
  const out = unmasked.slice();
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const i = r * size + c;
      if (!skeleton.isFunction[i]) out[i] ^= maskBit(mask, r, c);
    }
  }
  skeleton.writeFormat(out, mask);
  return out;
}

export function smallestVersion(ecl, seg, minVersion = 1) {
  for (let v = minVersion; v <= 40; v++) {
    const layout = blockLayout(v, ecl);
    // recomputed per version: the count field widens at v10 and, for
    // alphanumeric, again at v27
    if (payloadBits(v, seg) - 4 <= layout.dataCodewords * 8) return v;
  }
  return null;
}
