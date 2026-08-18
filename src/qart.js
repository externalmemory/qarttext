// QArt-style solver.
//
// Reed-Solomon over GF(256) is linear, interleaving is a permutation, and the
// mask is a fixed XOR. So the map from data bits to module values is affine
// over GF(2). Every bit after the payload's terminator is a free variable, and
// Gauss-Jordan elimination finds an assignment that forces chosen modules to
// chosen values while producing a fully valid codeword. No error-correction
// capacity is spent: the result is a legitimate QR code that happens to have a
// picture in it.

import { blockLayout, rsRemainderSparse, gmul } from './qr.js';
import { Skeleton, maskBit } from './matrix.js';
import { buildDataCodewords, interleave, placeCodewords } from './encode.js';

// xorshift32, so a given URL always produces the same code.
export function randomFreeBits(count, seed) {
  const out = new Uint8Array(count);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < count; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    out[i] = x & 1;
  }
  return out;
}

// Maps positions in the data/EC arrays to their index in the interleaved stream.
function streamIndexMaps(layout) {
  const { blocks, numBlocks, ecPerBlock, shortDataLen, dataCodewords } = layout;
  const dataToStream = new Int32Array(dataCodewords);
  const ecToStream = [];
  for (let j = 0; j < numBlocks; j++) ecToStream.push(new Int32Array(ecPerBlock));
  let n = 0;
  for (let i = 0; i <= shortDataLen; i++) {
    for (let j = 0; j < numBlocks; j++) {
      if (i < blocks[j].length) dataToStream[blocks[j].offset + i] = n++;
    }
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (let j = 0; j < numBlocks; j++) ecToStream[j][i] = n++;
  }
  return { dataToStream, ecToStream };
}

/**
 * Modules whose value cannot be changed at all: they carry bits of the pinned
 * payload codewords (mode indicator, length, URL bytes, terminator), or they
 * are function patterns, or they are unused remainder bits. Interleaving puts
 * the payload early in the codeword stream, and placement starts at the
 * bottom-right corner -- so these cluster low and to the right, and artwork
 * placed higher in the symbol reproduces far more faithfully.
 */
export function pinnedModuleMap(version, ecl, byteLength) {
  const built = buildDataCodewords(version, ecl, new Uint8Array(byteLength));
  if (!built) return null;
  const { layout, freeStart, freeCount } = built;
  const skeleton = new Skeleton(version, ecl);
  const { dataToStream } = streamIndexMaps(layout);

  const pinnedCodeword = new Uint8Array(layout.rawCodewords);
  const lastPinnedByte = (freeStart - 1) >> 3;
  for (let i = 0; i <= lastPinnedByte && i < layout.dataCodewords; i++) {
    // the final byte is only partly pinned, but any target in it is at best
    // partly controllable, so treat the whole codeword as unavailable
    pinnedCodeword[dataToStream[i]] = 1;
  }

  const size = skeleton.size;
  const map = new Uint8Array(size * size);
  for (let i = 0; i < map.length; i++) {
    const s = skeleton.bitAt[i];
    if (s < 0) { map[i] = 1; continue; }
    const cw = s >> 3;
    if (cw >= layout.rawCodewords || pinnedCodeword[cw]) map[i] = 1;
  }
  return { skeleton, map, freeBits: freeCount, dataCodewords: layout.dataCodewords };
}

/**
 * @param {object} opts
 * @param {number} opts.version
 * @param {string} opts.ecl
 * @param {Uint8Array} opts.bytes      URL bytes, pinned
 * @param {Array<{index:number,value:number,weight:number}>} opts.targets
 * @returns {null | {skeleton, results: Array}}  one result per mask
 */
export function solve({ version, ecl, bytes, targets, seed = 0x9e3779b9 }) {
  const probe = buildDataCodewords(version, ecl, bytes);
  if (!probe) return null;
  const { freeStart, freeCount } = probe;

  // Fill the free bits with deterministic noise before solving. Only the
  // pivot columns get overwritten by the solution, so without this the
  // remaining freedom would stay at zero and render as a large patch of bare
  // mask pattern -- visually obvious and bad for the penalty score.
  const noise = randomFreeBits(freeCount, seed);
  const built = buildDataCodewords(version, ecl, bytes, noise);
  const { data, layout } = built;
  const skeleton = new Skeleton(version, ecl);
  const size = skeleton.size;

  const baselineStream = interleave(data, layout);
  const baseUnmasked = placeCodewords(skeleton, baselineStream);

  // ---- select controllable targets, highest weight first -------------------
  const usable = [];
  const fixed = [];
  for (const t of targets) {
    const s = skeleton.bitAt[t.index];
    if (s < 0 || (s >> 3) >= layout.rawCodewords) { fixed.push(t); continue; }
    usable.push({ ...t, stream: s });
  }
  usable.sort((a, b) => b.weight - a.weight);

  const T = usable.length;
  const F = freeCount;
  if (T === 0 || F === 0) return null;

  // codeword index -> targets landing in it
  const byCodeword = new Map();
  for (let r = 0; r < T; r++) {
    const c = usable[r].stream >> 3;
    let list = byCodeword.get(c);
    if (!list) byCodeword.set(c, list = []);
    list.push({ row: r, bit: 7 - (usable[r].stream & 7) });
  }

  const { dataToStream, ecToStream } = streamIndexMaps(layout);

  // block index for each data byte
  const blockOf = new Int32Array(layout.dataCodewords);
  for (const b of layout.blocks) blockOf.fill(b.index, b.offset, b.offset + b.length);

  // ---- build the influence matrix -----------------------------------------
  const W = (F + 31) >> 5;
  const rows = new Uint32Array(T * W);
  const setBit = (row, col) => { rows[row * W + (col >> 5)] ^= 1 << (col & 31); };

  const firstFreeByte = freeStart >> 3;
  const lastByte = layout.dataCodewords - 1;
  // unit remainder per data byte position, reused across that byte's 8 bits
  for (let byteIdx = firstFreeByte; byteIdx <= lastByte; byteIdx++) {
    const blk = layout.blocks[blockOf[byteIdx]];
    const posInBlock = byteIdx - blk.offset;
    const unit = rsRemainderSparse(posInBlock, 1, blk.length, layout.ecPerBlock);
    const ecStream = ecToStream[blk.index];
    const dataStreamIdx = dataToStream[byteIdx];
    const dataTargets = byCodeword.get(dataStreamIdx);

    for (let b = 0; b < 8; b++) {
      const bitPos = byteIdx * 8 + (7 - b);
      if (bitPos < freeStart) continue;
      const col = bitPos - freeStart;
      const delta = 1 << b;

      // effect on the data codeword itself
      if (dataTargets) {
        for (const { row, bit } of dataTargets) {
          if (bit === b) setBit(row, col);
        }
      }
      // effect on that block's error-correction codewords
      for (let j = 0; j < layout.ecPerBlock; j++) {
        if (unit[j] === 0) continue;
        const list = byCodeword.get(ecStream[j]);
        if (!list) continue;
        const v = gmul(delta, unit[j]);
        for (const { row, bit } of list) {
          if ((v >> bit) & 1) setBit(row, col);
        }
      }
    }
  }

  // ---- right-hand sides: one bit per mask ---------------------------------
  const rhs = new Uint8Array(T);
  for (let r = 0; r < T; r++) {
    const idx = usable[r].index;
    const base = baseUnmasked[idx];
    const row = (idx / size) | 0, col = idx % size;
    let packed = 0;
    for (let m = 0; m < 8; m++) {
      if ((usable[r].value ^ base ^ maskBit(m, row, col)) & 1) packed |= 1 << m;
    }
    rhs[r] = packed;
  }

  // ---- Gauss-Jordan over GF(2), eight right-hand sides at once ------------
  const pivotCols = new Int32Array(Math.min(T, F));
  let rank = 0;
  const tmp = new Uint32Array(W);
  for (let col = 0; col < F && rank < T; col++) {
    const w = col >> 5, m = 1 << (col & 31);
    let pivot = -1;
    for (let r = rank; r < T; r++) {
      if (rows[r * W + w] & m) { pivot = r; break; }
    }
    if (pivot < 0) continue;
    if (pivot !== rank) {
      tmp.set(rows.subarray(pivot * W, pivot * W + W));
      rows.copyWithin(pivot * W, rank * W, rank * W + W);
      rows.set(tmp, rank * W);
      const t = rhs[pivot]; rhs[pivot] = rhs[rank]; rhs[rank] = t;
    }
    const pBase = rank * W;
    for (let r = 0; r < T; r++) {
      if (r === rank) continue;
      const rBase = r * W;
      if (!(rows[rBase + w] & m)) continue;
      for (let k = w; k < W; k++) rows[rBase + k] ^= rows[pBase + k];
      rhs[r] ^= rhs[rank];
    }
    pivotCols[rank++] = col;
  }

  // ---- one solution per mask ---------------------------------------------
  const results = [];
  for (let mask = 0; mask < 8; mask++) {
    // solution = noise XOR correction, with the correction zero off the pivots
    const free = noise.slice();
    for (let k = 0; k < rank; k++) free[pivotCols[k]] ^= (rhs[k] >> mask) & 1;
    const solved = buildDataCodewords(version, ecl, bytes, free);
    const stream = interleave(solved.data, solved.layout);
    const unmasked = placeCodewords(skeleton, stream);
    // count how many requested modules actually came out right under this mask
    let misses = 0, weightedMisses = 0;
    for (let r = 0; r < T; r++) {
      const idx = usable[r].index;
      const row = (idx / size) | 0, col = idx % size;
      const got = unmasked[idx] ^ maskBit(mask, row, col);
      if (got !== usable[r].value) { misses++; weightedMisses += usable[r].weight; }
    }
    for (const t of fixed) {
      const row = (t.index / size) | 0, col = t.index % size;
      const got = skeleton.isFunction[t.index]
        ? skeleton.functionValue[t.index]
        : (baseUnmasked[t.index] ^ maskBit(mask, row, col));
      if (got !== t.value) { misses++; weightedMisses += t.weight; }
    }
    results.push({ mask, unmasked, dataCodewords: solved.data, misses, weightedMisses });
  }
  return { skeleton, results, rank, freeBits: F, targetCount: T, uncontrollable: fixed };
}
