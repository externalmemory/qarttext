// Symbol geometry: function patterns, module placement order, masks, penalty.

import { symbolSize, alignmentPositions, rawDataModules } from './qr.js';

const EC_FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };

// A Symbol holds the fixed skeleton of a QR code for one (version, level):
// which modules are function modules, what their values are, and the order in
// which data-region modules receive bits.
export class Skeleton {
  constructor(version, ecl) {
    this.version = version;
    this.ecl = ecl;
    const size = this.size = symbolSize(version);
    this.isFunction = new Uint8Array(size * size);
    this.functionValue = new Uint8Array(size * size);

    this.#drawTiming();
    this.#drawFinder(3, 3);
    this.#drawFinder(size - 4, 3);
    this.#drawFinder(3, size - 4);
    this.#drawAlignment();
    this.#reserveFormat();
    this.#drawVersion();

    this.order = this.#placementOrder();
    // module index -> bit position in the codeword stream (-1 for function)
    this.bitAt = new Int32Array(size * size).fill(-1);
    for (let i = 0; i < this.order.length; i++) this.bitAt[this.order[i]] = i;
  }

  #set(row, col, dark) {
    const i = row * this.size + col;
    this.isFunction[i] = 1;
    this.functionValue[i] = dark ? 1 : 0;
  }

  #drawTiming() {
    for (let i = 0; i < this.size; i++) {
      const dark = i % 2 === 0;
      this.#set(6, i, dark);
      this.#set(i, 6, dark);
    }
  }

  // Finder plus its separator: dark at Chebyshev distance 0, 1 and 3.
  #drawFinder(centerRow, centerCol) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const r = centerRow + dy, c = centerCol + dx;
        if (r >= 0 && r < this.size && c >= 0 && c < this.size) {
          this.#set(r, c, dist !== 2 && dist !== 4);
        }
      }
    }
  }

  #drawAlignment() {
    const pos = alignmentPositions(this.version);
    const n = pos.length;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        // The three finder corners have no alignment pattern.
        if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            this.#set(pos[i] + dy, pos[j] + dx, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
          }
        }
      }
    }
  }

  // Format modules are reserved here; their values depend on the mask and are
  // written at render time.
  #reserveFormat() {
    const size = this.size;
    this.formatCells = [];
    for (let i = 0; i <= 5; i++) this.formatCells.push([[i, 8], [8, size - 1 - i]]);
    this.formatCells.push([[7, 8], [8, size - 1 - 6]]);
    this.formatCells.push([[8, 8], [8, size - 1 - 7]]);
    this.formatCells.push([[8, 7], [size - 15 + 8, 8]]);
    for (let i = 9; i < 15; i++) this.formatCells.push([[8, 14 - i], [size - 15 + i, 8]]);
    for (const [a, b] of this.formatCells) {
      this.#set(a[0], a[1], false);
      this.#set(b[0], b[1], false);
    }
    this.#set(size - 8, 8, true); // always-dark module
  }

  #drawVersion() {
    if (this.version < 7) return;
    let rem = this.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (this.version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = ((bits >>> i) & 1) === 1;
      const a = this.size - 11 + (i % 3), b = Math.floor(i / 3);
      this.#set(b, a, bit);
      this.#set(a, b, bit);
    }
  }

  // Zig-zag: two columns at a time, right to left, skipping the timing column.
  #placementOrder() {
    const size = this.size;
    const total = rawDataModules(this.version);
    const order = new Int32Array(total);
    let n = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const col = right - j;
          const upward = ((right + 1) & 2) === 0;
          const row = upward ? size - 1 - vert : vert;
          const idx = row * size + col;
          if (!this.isFunction[idx]) order[n++] = idx;
        }
      }
    }
    if (n !== total) throw new Error(`placement mismatch: ${n} vs ${total}`);
    return order;
  }

  formatBits(mask) {
    const data = (EC_FORMAT_BITS[this.ecl] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    return ((data << 10) | rem) ^ 0x5412;
  }

  // Writes the format modules for `mask` into a module array.
  writeFormat(modules, mask) {
    const bits = this.formatBits(mask);
    for (let i = 0; i < 15; i++) {
      const v = (bits >>> i) & 1;
      const [a, b] = this.formatCells[i];
      modules[a[0] * this.size + a[1]] = v;
      modules[b[0] * this.size + b[1]] = v;
    }
  }
}

export function maskBit(mask, row, col) {
  switch (mask) {
    case 0: return (row + col) % 2 === 0 ? 1 : 0;
    case 1: return row % 2 === 0 ? 1 : 0;
    case 2: return col % 3 === 0 ? 1 : 0;
    case 3: return (row + col) % 3 === 0 ? 1 : 0;
    case 4: return (Math.floor(col / 3) + Math.floor(row / 2)) % 2 === 0 ? 1 : 0;
    case 5: return ((row * col) % 2) + ((row * col) % 3) === 0 ? 1 : 0;
    case 6: return ((((row * col) % 2) + ((row * col) % 3)) % 2) === 0 ? 1 : 0;
    case 7: return ((((row + col) % 2) + ((row * col) % 3)) % 2) === 0 ? 1 : 0;
    default: throw new Error('bad mask');
  }
}

// Standard four-rule penalty. Used only to choose between masks.
export function penaltyScore(modules, size) {
  const at = (r, c) => modules[r * size + c];
  let result = 0;

  // Rule 1: runs of five or more same-coloured modules in a row or column.
  for (let i = 0; i < size; i++) {
    for (const horizontal of [true, false]) {
      let run = 1;
      for (let j = 1; j < size; j++) {
        const prev = horizontal ? at(i, j - 1) : at(j - 1, i);
        const cur = horizontal ? at(i, j) : at(j, i);
        if (cur === prev) { run++; if (run === 5) result += 3; else if (run > 5) result += 1; }
        else run = 1;
      }
    }
  }

  // Rule 2: 2x2 blocks of one colour.
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = at(r, c);
      if (v === at(r, c + 1) && v === at(r + 1, c) && v === at(r + 1, c + 1)) result += 3;
    }
  }

  // Rule 3: finder-like 1:1:3:1:1 sequences with four light modules on a side.
  const A = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const B = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  for (let i = 0; i < size; i++) {
    for (let j = 0; j + 11 <= size; j++) {
      let mh = true, mv = true, nh = true, nv = true;
      for (let k = 0; k < 11; k++) {
        const h = at(i, j + k), v = at(j + k, i);
        if (h !== A[k]) mh = false;
        if (v !== A[k]) mv = false;
        if (h !== B[k]) nh = false;
        if (v !== B[k]) nv = false;
      }
      if (mh) result += 40;
      if (mv) result += 40;
      if (nh) result += 40;
      if (nv) result += 40;
    }
  }

  // Rule 4: deviation from an even split of dark and light.
  let dark = 0;
  for (let i = 0; i < modules.length; i++) dark += modules[i];
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  return result + k * 10;
}
