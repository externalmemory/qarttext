// Builds the app icons using the app's own encoder, so the icon is itself a
// working human-readable QR code. PNG is written by hand with node:zlib.

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { generate } from '../src/generate.js';
import { FONT_BY_ID, glyphFor, measure } from '../src/fonts.js';

const SITE = 'https://qarttext.pages.dev/';

const CRC = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC[n] = c >>> 0;
}
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** 8-bit RGB PNG from a pixel callback. */
function writePng(path, width, height, pixel) {
  const raw = Buffer.alloc(height * (width * 3 + 1));
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      raw[p++] = r; raw[p++] = g; raw[p++] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  writeFileSync(path, png);
  return png.length;
}

// The icon is a working code for the site itself. Kept short so the modules
// stay chunky: at 192 px this is about 4 pixels per module, comfortably
// scannable, where spelling out the whole domain would be closer to 3.
const code = generate({ url: SITE, text: 'QR', ecl: 'M', fontId: 'pixel', styleId: 'plate', maxLines: 1 });
if (!code) throw new Error('icon code did not generate');
if (code.encoded !== SITE) throw new Error(`icon encodes ${code.encoded}, not ${SITE}`);
console.log(`icon encodes ${code.encoded}: v${code.version}, ${code.size + 8} modules including quiet zone`);
const { modules, size } = code;

const DARK = [16, 16, 20], LIGHT = [246, 246, 244];

function makeSampler(quietModules) {
  const total = size + quietModules * 2;
  return (dim) => (x, y) => {
    const mx = Math.floor(x * total / dim) - quietModules;
    const my = Math.floor(y * total / dim) - quietModules;
    if (mx < 0 || my < 0 || mx >= size || my >= size) return LIGHT;
    return modules[my * size + mx] ? DARK : LIGHT;
  };
}

const plain = makeSampler(2);
// Maskable icons get chopped to a circle, so pad heavily and keep the code small.
const maskable = makeSampler(Math.round(size * 0.3));

for (const [file, dim, sampler] of [
  ['icons/icon-192.png', 192, plain],
  ['icons/icon-512.png', 512, plain],
  ['icons/icon-maskable-512.png', 512, maskable],
]) {
  const bytes = writePng(file, dim, dim, sampler(dim));
  console.log(`${file}  ${dim}x${dim}  ${bytes} bytes`);
}

// SVG version, crisp at any size
const q = 2, total = size + q * 2;
const runs = [];
for (let r = 0; r < size; r++) {
  let start = -1;
  for (let c = 0; c <= size; c++) {
    const on = c < size && modules[r * size + c] === 1;
    if (on && start < 0) start = c;
    else if (!on && start >= 0) { runs.push(`M${start + q} ${r + q}h${c - start}v1h-${c - start}z`); start = -1; }
  }
}
writeFileSync('icons/icon.svg',
`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges">
<rect width="${total}" height="${total}" fill="#f6f6f4"/>
<path fill="#101014" d="${runs.join('')}"/>
</svg>
`);
console.log(`icons/icon.svg  v${code.version} ${size}x${size}`);

// A QR code cannot be read at favicon size: at 16 px this one would be a
// quarter of a pixel per module. So the favicon is the letterforms alone,
// drawn from the same font, where 16 px leaves roughly two pixels per module.
{
  const font = FONT_BY_ID.pixel, text = 'QR', pad = 1;
  const w = measure(font, text) + pad * 2;
  const side = Math.max(w, font.height + pad * 2);
  const ox = Math.floor((side - measure(font, text)) / 2);
  const oy = Math.floor((side - font.height) / 2);
  const runs = [];
  let x = ox;
  for (const ch of text) {
    const g = glyphFor(font, ch);
    for (let r = 0; r < font.height; r++) {
      let start = -1;
      for (let c = 0; c <= g.width; c++) {
        const on = c < g.width && g.rows[r][c] === 1;
        if (on && start < 0) start = c;
        else if (!on && start >= 0) {
          runs.push(`M${x + start} ${oy + r}h${c - start}v1h-${c - start}z`);
          start = -1;
        }
      }
    }
    x += g.width + font.tracking;
  }
  writeFileSync('icons/favicon.svg',
`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" shape-rendering="crispEdges">
<rect width="${side}" height="${side}" fill="#f6f6f4"/>
<path fill="#101014" d="${runs.join('')}"/>
</svg>
`);
  console.log(`icons/favicon.svg  ${side}x${side} modules: ${(16 / side).toFixed(2)} px per module at 16 px`);
}
