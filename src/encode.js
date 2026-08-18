// Byte-mode payload assembly, block interleaving, and module rendering.

import { blockLayout, charCountBits, rsRemainder, symbolSize } from './qr.js';
import { Skeleton, maskBit } from './matrix.js';

export function utf8Bytes(str) {
  return new TextEncoder().encode(str);
}

// Bits consumed by the URL itself: mode + length field + payload + terminator.
// The terminator is deliberately included: it is never treated as a free
// variable, so decoders always stop before the padding region.
export function payloadBits(version, byteLength) {
  return 4 + charCountBits(version) + 8 * byteLength + 4;
}

// Builds the data codeword array with the payload pinned and every bit after
// the terminator set to `fill` (0 for the baseline solve).
export function buildDataCodewords(version, ecl, bytes, freeBits = null) {
  const layout = blockLayout(version, ecl);
  const capacityBits = layout.dataCodewords * 8;
  const used = payloadBits(version, bytes.length);
  if (used > capacityBits + 4) return null; // terminator may be truncated

  const data = new Uint8Array(layout.dataCodewords);
  let pos = 0;
  const put = (value, width) => {
    for (let i = width - 1; i >= 0; i--) {
      if ((value >>> i) & 1) data[pos >> 3] |= 0x80 >> (pos & 7);
      pos++;
    }
  };
  put(0b0100, 4);
  put(bytes.length, charCountBits(version));
  for (const b of bytes) put(b, 8);
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

// Conventional padding (0xEC/0x11) for a plain, non-QArt code.
export function applyStandardPadding(data, freeStart) {
  let byte = (freeStart + 7) >> 3;
  let alt = 0xec;
  for (; byte < data.length; byte++) {
    data[byte] = alt;
    alt = alt === 0xec ? 0x11 : 0xec;
  }
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

// Plain (non-QArt) encode, used for the decoder-compatibility panel and as a
// fallback when no text will fit.
export function encodePlain(version, ecl, text, mask = null) {
  const bytes = utf8Bytes(text);
  const built = buildDataCodewords(version, ecl, bytes);
  if (!built) return null;
  applyStandardPadding(built.data, built.freeStart);
  const skeleton = new Skeleton(version, ecl);
  const unmasked = placeCodewords(skeleton, interleave(built.data, built.layout));
  return { skeleton, unmasked, mask };
}

export function smallestVersion(ecl, byteLength, minVersion = 1) {
  for (let v = minVersion; v <= 40; v++) {
    const layout = blockLayout(v, ecl);
    if (payloadBits(v, byteLength) - 4 <= layout.dataCodewords * 8) return v;
  }
  return null;
}
