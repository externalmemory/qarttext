// Turns a URL into a set of modules the solver should force.

import { FONT_BY_ID, fitCase, glyphFor, measure } from './fonts.js';

export const STYLES = [
  { id: 'band', name: 'Plate', note: 'Solid light plate behind the text.', pad: 2 },
  { id: 'halo', name: 'Halo', note: 'One-module outline, noise elsewhere.', pad: 1 },
  { id: 'glyph', name: 'Bare', note: 'Letterforms only, no clearance.', pad: 0 },
];
export const STYLE_BY_ID = Object.fromEntries(STYLES.map(s => [s.id, s]));

const W_INK = 3;      // the letterforms themselves
const W_CLEAR = 2;    // the module ring that separates them from the noise
const W_PLATE = 1;    // the rest of the plate

/** The label to draw: host name for web URLs, something sensible otherwise. */
export function domainOf(input) {
  const raw = String(input).trim();
  if (!raw) return '';

  // mailto:/tel:/etc. have no host component, so take the useful part directly
  const scheme = raw.match(/^([a-z][a-z0-9+.-]*):/i);
  if (scheme && !/^https?$/i.test(scheme[1])) {
    const rest = raw.slice(scheme[0].length).replace(/^\/\//, '');
    if (/^mailto$/i.test(scheme[1])) {
      const at = rest.lastIndexOf('@');
      return (at >= 0 ? rest.slice(at + 1) : rest).split(/[?#]/)[0].toLowerCase();
    }
    return rest.split(/[?#]/)[0].toLowerCase() || scheme[1].toLowerCase();
  }

  const withScheme = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw;
  try {
    return new URL(withScheme).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return raw.toLowerCase();
  }
}

/** Normalises what the user typed into the URL that will actually be encoded. */
export function normaliseUrl(input) {
  const s = String(input).trim();
  if (!s) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s; // mailto:, tel:, ...
  return 'https://' + s;
}

/**
 * Breaks text into at most `maxLines` lines no wider than `maxWidth` modules.
 * Prefers breaking after a dot, so labels stay whole; falls back to hard
 * character wrapping.
 */
export function wrapText(font, text, maxWidth, maxLines, allowHardWrap = true) {
  if (measure(font, text) <= maxWidth) return [text];
  if (maxLines < 2) return null;

  // dot-aware chunks: "departuremono." + "com"
  const chunks = [];
  let cur = '';
  for (const ch of text) {
    cur += ch;
    if (ch === '.') { chunks.push(cur); cur = ''; }
  }
  if (cur) chunks.push(cur);

  const packed = [];
  let line = '';
  for (const chunk of chunks) {
    const candidate = line + chunk;
    if (line && measure(font, candidate) > maxWidth) { packed.push(line); line = chunk; }
    else line = candidate;
  }
  if (line) packed.push(line);
  if (packed.length <= maxLines && packed.every(l => measure(font, l) <= maxWidth)) return packed;

  if (!allowHardWrap) return null;

  // last resort: break mid-label, which reads noticeably worse
  const hard = [];
  line = '';
  for (const ch of text) {
    if (line && measure(font, line + ch) > maxWidth) { hard.push(line); line = ch; }
    else line += ch;
  }
  if (line) hard.push(line);
  return hard.length <= maxLines ? hard : null;
}

function blockMetrics(font, lines) {
  const width = Math.max(...lines.map(l => measure(font, l)));
  const height = lines.length * font.height + (lines.length - 1) * font.leading;
  return { width, height };
}

/** Rasterises the lines into a boolean ink grid of the block's own size. */
function rasterise(font, lines, width) {
  const { height } = blockMetrics(font, lines);
  const ink = new Uint8Array(width * height);
  lines.forEach((line, li) => {
    const text = fitCase(font, line);
    const lw = measure(font, line);
    let x = Math.floor((width - lw) / 2);
    const y0 = li * (font.height + font.leading);
    for (const ch of text) {
      const g = glyphFor(font, ch);
      for (let r = 0; r < font.height; r++) {
        for (let c = 0; c < g.width; c++) {
          if (g.rows[r][c] && x + c < width) ink[(y0 + r) * width + x + c] = 1;
        }
      }
      x += g.width + font.tracking;
    }
  });
  return { ink, width, height };
}

/**
 * Chooses where the text sits and emits the target list.
 * `pinned` marks modules whose value cannot be changed; positions are scored so
 * the text lands where the fewest of its modules are stuck.
 */
export function placeText({ size, pinned, fontId, styleId, lines, dark = 1 }) {
  const font = FONT_BY_ID[fontId];
  const style = STYLE_BY_ID[styleId];
  const { width, height } = blockMetrics(font, lines);
  const pad = style.pad;
  const boxW = width + pad * 2, boxH = height + pad * 2;
  if (boxW > size || boxH > size) return null;

  const raster = rasterise(font, lines, width);

  // clearance = ink dilated by one module (used by halo and plate weighting)
  const near = new Uint8Array(width * height);
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      if (!raster.ink[r * width + c]) continue;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr, cc = c + dc;
          if (rr >= 0 && rr < height && cc >= 0 && cc < width) near[rr * width + cc] = 1;
        }
      }
    }
  }

  const x0 = Math.floor((size - boxW) / 2);
  const centreY = Math.floor((size - boxH) / 2);

  // score every vertical position by how much of the artwork lands on modules
  // we cannot control, with a mild pull toward the centre
  let best = null;
  const candidates = [];
  for (let y0 = 0; y0 + boxH <= size; y0++) {
    let cost = 0;
    for (let r = 0; r < boxH; r++) {
      for (let c = 0; c < boxW; c++) {
        const idx = (y0 + r) * size + (x0 + c);
        if (!pinned[idx]) continue;
        const ir = r - pad, ic = c - pad;
        const inside = ir >= 0 && ir < height && ic >= 0 && ic < width;
        // a stuck letterform module is far worse than a stuck plate module
        if (inside && raster.ink[ir * width + ic]) cost += 1000;
        else if (inside && near[ir * width + ic]) cost += 50;
        else if (style.pad > 0) cost += 1;
      }
    }
    candidates.push({ y0, cost });
    if (!best || cost < best.cost) best = { y0, cost };
  }
  if (!best) return null;

  // The payload's pinned modules follow the zig-zag, which sweeps column pairs
  // across the full height -- so row choice barely changes how many are stuck.
  // Take the lowest cost, then among positions that are no worse by a few
  // plate modules (never by a letterform module, which costs 1000) sit as
  // close to the middle as possible.
  const tol = Math.max(4, Math.round(0.02 * boxW * boxH));
  const tolerated = candidates.filter(c => c.cost <= best.cost + tol);
  tolerated.sort((a, b) => Math.abs(a.y0 - centreY) - Math.abs(b.y0 - centreY));
  const { y0 } = tolerated[0];
  const targets = [];
  const light = dark ^ 1;
  for (let r = 0; r < boxH; r++) {
    for (let c = 0; c < boxW; c++) {
      const index = (y0 + r) * size + (x0 + c);
      const ir = r - pad, ic = c - pad;
      const inside = ir >= 0 && ir < height && ic >= 0 && ic < width;
      const isInk = inside && raster.ink[ir * width + ic];
      const isNear = inside && near[ir * width + ic];
      if (isInk) targets.push({ index, value: dark, weight: W_INK });
      else if (isNear && style.pad > 0) targets.push({ index, value: light, weight: W_CLEAR });
      else if (style.id === 'band') targets.push({ index, value: light, weight: W_PLATE });
    }
  }
  return { targets, rect: { x: x0, y: y0, w: boxW, h: boxH }, font, style, lines, stuck: best.cost };
}
