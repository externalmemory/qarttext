// Core QR Code encoder: GF(256) arithmetic, Reed-Solomon, symbol geometry.
// Tables and placement follow ISO/IEC 18004. No external dependencies.

// ---------------------------------------------------------------- GF(256) --

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function initGf() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // primitive polynomial x^8+x^4+x^3+x^2+1
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

export function gmul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

// Generator polynomial for `degree` error-correction codewords, as coefficients
// of x^degree-1 .. x^0 (the leading 1 is implicit).
const GEN_CACHE = new Map();
function generatorPoly(degree) {
  let g = GEN_CACHE.get(degree);
  if (g) return g;
  // g[j] is the coefficient of x^(degree-1-j); the leading x^degree term is
  // implicit. Multiplying by (x - 2^i) maps g[j] -> g[j]*root + g[j+1].
  g = new Uint8Array(degree);
  g[degree - 1] = 1;
  for (let i = 0; i < degree; i++) {
    const root = EXP[i];
    for (let j = 0; j < degree; j++) {
      g[j] = gmul(g[j], root) ^ (j + 1 < degree ? g[j + 1] : 0);
    }
  }
  GEN_CACHE.set(degree, g);
  return g;
}

// Reed-Solomon remainder of `data` (Uint8Array) with `degree` EC codewords.
export function rsRemainder(data, degree, start = 0, end = data.length) {
  const gen = generatorPoly(degree);
  const rem = new Uint8Array(degree);
  for (let i = start; i < end; i++) {
    const factor = data[i] ^ rem[0];
    rem.copyWithin(0, 1);
    rem[degree - 1] = 0;
    if (factor !== 0) {
      const lf = LOG[factor];
      for (let j = 0; j < degree; j++) {
        const gj = gen[j];
        if (gj !== 0) rem[j] ^= EXP[LOG[gj] + lf];
      }
    }
  }
  return rem;
}

// Remainder when exactly one message byte is non-zero. Cheap because the
// shift register stays zero until position `pos`.
export function rsRemainderSparse(pos, value, msgLen, degree) {
  const gen = generatorPoly(degree);
  const rem = new Uint8Array(degree);
  for (let i = pos; i < msgLen; i++) {
    const factor = (i === pos ? value : 0) ^ rem[0];
    rem.copyWithin(0, 1);
    rem[degree - 1] = 0;
    if (factor !== 0) {
      const lf = LOG[factor];
      for (let j = 0; j < degree; j++) {
        const gj = gen[j];
        if (gj !== 0) rem[j] ^= EXP[LOG[gj] + lf];
      }
    }
  }
  return rem;
}

// ------------------------------------------------------- version geometry --

export const EC_LEVELS = ['L', 'M', 'Q', 'H'];
// Format-information bit patterns per level (not the same as the array order).
const EC_FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };

const ECC_PER_BLOCK = {
  L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  Q: [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  H: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
};

const NUM_BLOCKS = {
  L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  Q: [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  H: [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
};

export const MIN_VERSION = 1;
export const MAX_VERSION = 40;

export function symbolSize(version) {
  return version * 4 + 17;
}

// Total data-region modules (including the 0-7 remainder bits).
export function rawDataModules(version) {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

export function alignmentPositions(version) {
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26
    : Math.floor((version * 4 + numAlign * 2 + 1) / (numAlign * 2 - 2)) * 2;
  const result = new Array(numAlign);
  result[0] = 6;
  for (let i = numAlign - 1, pos = version * 4 + 10; i >= 1; i--, pos -= step) {
    result[i] = pos;
  }
  return result;
}

// Block layout for a (version, level) pair, derived from the two spec tables.
export function blockLayout(version, ecl) {
  const rawCodewords = Math.floor(rawDataModules(version) / 8);
  const numBlocks = NUM_BLOCKS[ecl][version];
  const ecPerBlock = ECC_PER_BLOCK[ecl][version];
  const dataCodewords = rawCodewords - ecPerBlock * numBlocks;
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortDataLen = shortBlockLen - ecPerBlock;
  const blocks = [];
  let offset = 0;
  for (let i = 0; i < numBlocks; i++) {
    const len = shortDataLen + (i < numShortBlocks ? 0 : 1);
    blocks.push({ index: i, offset, length: len });
    offset += len;
  }
  return {
    rawCodewords, numBlocks, ecPerBlock, dataCodewords,
    shortBlockLen, numShortBlocks, shortDataLen, blocks,
  };
}

// Byte-mode character-count field width.
export function charCountBits(version) {
  return version <= 9 ? 8 : 16;
}
