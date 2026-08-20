// Turns a URL into a set of modules the solver should force.

import { FONT_BY_ID, glyphFor, measure } from './fonts.js';

// Two choices, crossed: how far the forced region extends, and which way round
// the letters run. Rows of the gallery, against fonts as columns.
export const STYLES = [
  { id: 'plate', name: 'Plate', note: 'Light plate behind the text.', kind: 'plate', invert: false },
  { id: 'plate-inverse', name: 'Plate, inverted', note: 'Dark plate, light letters.', kind: 'plate', invert: true },
  { id: 'halo', name: 'Halo', note: 'Clearance only, noise beyond it.', kind: 'halo', invert: false },
  { id: 'halo-inverse', name: 'Halo, inverted', note: 'Light letters, dark clearance.', kind: 'halo', invert: true },
];
export const STYLE_BY_ID = Object.fromEntries(STYLES.map(s => [s.id, s]));
// earlier names, so saved links and old settings keep working
const STYLE_ALIASES = { band: 'plate', glyph: 'halo', inverse: 'plate-inverse' };
export const resolveStyle = (id) => STYLE_BY_ID[id] ?? STYLE_BY_ID[STYLE_ALIASES[id]] ?? STYLES[0];

export const DEFAULT_CLEARANCE = 2;

// Priority ladder. The solver satisfies constraints in this order and drops
// the lowest first when it runs out of freedom, so letterforms always survive
// and the outer plate is what degrades.
const W_INK = 1000;   // the letterforms themselves
const W_NEAR = 50;    // the module immediately around each stroke
const W_CLEAR = 8;    // the rest of the requested clearance
const W_DITHER = 4;   // the partially-cleared ring of a fractional clearance
const W_PLATE = 1;    // plate area beyond the clearance

// Ordered 4x4 Bayer threshold. A fractional clearance clears only part of its
// outermost ring, and this decides which part: an even, deterministic stipple
// rather than a random scatter, so the edge reads as texture instead of damage.
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const ditherAt = (r, c) => BAYER4[(r & 3) * 4 + (c & 3)] / 16;
const W_PINNED = 5000; // a module the reader has clicked; outranks everything

/** Weight marking a hand-set module, so it survives when freedom runs short. */
export const OVERRIDE_WEIGHT = W_PINNED;

/** Weight marking a letterform module, so callers can count them. */
export const INK_WEIGHT = W_INK;

/**
 * The label to draw: host name for web URLs, something sensible otherwise.
 * The host is pulled out of the raw string rather than via `new URL()`, whose
 * `hostname` is lower-cased by the URL specification -- the label keeps
 * whatever case was typed.
 */
export function domainOf(input) {
  const raw = String(input).trim();
  if (!raw) return '';

  // mailto:/tel:/etc. have no host component, so take the useful part directly
  const scheme = raw.match(/^([a-z][a-z0-9+.-]*):/i);
  if (scheme && !/^https?$/i.test(scheme[1])) {
    const rest = raw.slice(scheme[0].length).replace(/^\/\//, '');
    if (/^mailto$/i.test(scheme[1])) {
      const at = rest.lastIndexOf('@');
      return (at >= 0 ? rest.slice(at + 1) : rest).split(/[?#]/)[0];
    }
    return rest.split(/[?#]/)[0] || scheme[1];
  }

  let host = raw.replace(/^https?:\/\//i, '').split(/[/?#]/)[0];
  const at = host.lastIndexOf('@');
  if (at >= 0) host = host.slice(at + 1);      // drop any userinfo
  host = host.replace(/:\d+$/, '');            // drop any port
  return host.replace(/^www\./i, '') || raw;
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
 * Falls back to hard character wrapping.
 *
 * Breaks are taken after a dot or a hyphen, both of which stay at the end of
 * the line where they read as deliberate. Hyphens matter more than they look:
 * without them a label like "constructive-calculator." is one indivisible
 * chunk, no arrangement narrower than that chunk exists at any line count, and
 * the only way to fit the text is a far larger symbol.
 */
export function wrapText(font, text, maxWidth, maxLines, allowHardWrap = true) {
  if (measure(font, text) <= maxWidth) return [text];
  if (maxLines < 2) return null;

  // breakable chunks: "constructive-" + "calculator." + "dimview." + "org"
  const chunks = [];
  let cur = '';
  for (const ch of text) {
    cur += ch;
    if (ch === '.' || ch === '-') { chunks.push(cur); cur = ''; }
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

/** Rasterises the lines into an ink grid the size of the whole padded box. */
function rasterise(font, lines, width, boxW, boxH, pad) {
  const ink = new Uint8Array(boxW * boxH);
  lines.forEach((line, li) => {
    let x = pad + Math.floor((width - measure(font, line)) / 2);
    const y0 = pad + li * (font.height + font.leading);
    for (const ch of line) {
      const g = glyphFor(font, ch);
      for (let r = 0; r < font.height; r++) {
        for (let c = 0; c < g.width; c++) {
          if (g.rows[r][c] && x + c < boxW && y0 + r < boxH) ink[(y0 + r) * boxW + x + c] = 1;
        }
      }
      x += g.width + font.tracking;
    }
  });
  return ink;
}

/**
 * Chooses where the text sits and emits the target list.
 * `pinned` marks modules whose value cannot be changed; positions are scored so
 * the text lands where the fewest of its modules are stuck.
 */
export function placeText({
  size, pinned, isFunction, functionValue,
  fontId, styleId, lines, clearance = DEFAULT_CLEARANCE, offset = null,
}) {
  const font = FONT_BY_ID[fontId];
  const style = resolveStyle(styleId);
  const { width, height } = blockMetrics(font, lines);

  // A clearance of 2.5 means two rings fully cleared and a third only partly:
  // roughly half the benefit of a third ring for roughly half the forced
  // modules, which is often the difference between two symbol sizes.
  const requested = Math.max(1, clearance);
  const full = Math.max(1, Math.floor(requested));
  const frac = requested - Math.floor(requested);
  const pad = Math.ceil(requested);
  const boxW = width + pad * 2, boxH = height + pad * 2;
  if (boxW > size || boxH > size) return null;

  const ink = rasterise(font, lines, width, boxW, boxH, pad);

  // Chebyshev distance from the nearest stroke, so one pass classifies every
  // module in the box: 0 is ink, 1..pad is clearance, beyond that is plate.
  const dist = chebyshevDistance(ink, boxW, boxH, pad);

  const inkValue = style.invert ? 0 : 1;
  const bgValue = inkValue ^ 1;

  // What each module in the box wants to be, and how much we care.
  const cells = [];
  for (let r = 0; r < boxH; r++) {
    for (let c = 0; c < boxW; c++) {
      const d = dist[r * boxW + c];
      let value = bgValue, weight;
      if (d === 0) { value = inkValue; weight = W_INK; }
      else if (d === 1 && full >= 1) weight = W_NEAR;
      else if (d <= full) weight = W_CLEAR;
      else if (style.kind === 'halo') {
        // the partly-cleared ring, then ordinary noise beyond it
        if (frac > 0 && d === pad && ditherAt(r, c) < frac) weight = W_DITHER;
        else continue;
      } else {
        // plate: its outermost ring is the one that gets stippled
        const toEdge = Math.min(r, c, boxH - 1 - r, boxW - 1 - c);
        if (frac > 0 && toEdge < pad - full) {
          if (ditherAt(r, c) < frac) weight = W_DITHER;
          else continue;
        } else weight = W_PLATE;
      }
      cells.push({ dr: r, dc: c, value, weight });
    }
  }

  const centreX = Math.floor((size - boxW) / 2);
  const centreY = Math.floor((size - boxH) / 2);

  // A module we cannot control only costs us when its fixed value disagrees
  // with what we want. Function patterns have known values, so this lets the
  // text settle where the structure already happens to be right -- a full stop
  // landing on the dark centre of an alignment pattern is free, and snaps
  // there of its own accord.
  const costAt = (idx, want, weight) => {
    if (!pinned[idx]) return 0;
    if (isFunction[idx]) return functionValue[idx] === want ? 0 : weight;
    return weight * 0.5; // payload bit: even odds it lands the right way up
  };

  const place = (x0, y0, ceiling) => {
    let cost = 0;
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      cost += costAt((y0 + cell.dr) * size + (x0 + cell.dc), cell.value, cell.weight);
      if (cost > ceiling) return Infinity;
    }
    return cost;
  };

  let chosen;
  if (offset) {
    chosen = {
      x0: Math.min(Math.max(offset.x, 0), size - boxW),
      y0: Math.min(Math.max(offset.y, 0), size - boxH),
    };
  } else {
    const tol = Math.max(4, Math.round(0.02 * boxW * boxH));
    let bestCost = place(centreX, centreY, Infinity);
    const candidates = [{ x0: centreX, y0: centreY, cost: bestCost }];
    for (let y0 = 0; y0 + boxH <= size; y0++) {
      for (let x0 = 0; x0 + boxW <= size; x0++) {
        if (x0 === centreX && y0 === centreY) continue;
        const cost = place(x0, y0, bestCost + tol);
        if (cost === Infinity) continue;
        if (cost < bestCost) bestCost = cost;
        candidates.push({ x0, y0, cost });
      }
    }
    // Among positions no worse by a few plate modules -- never by a letterform
    // module, which costs 1000 -- sit as close to the middle as possible.
    const viable = candidates.filter(c => c.cost <= bestCost + tol);
    viable.sort((a, b) =>
      (Math.abs(a.y0 - centreY) + Math.abs(a.x0 - centreX)) -
      (Math.abs(b.y0 - centreY) + Math.abs(b.x0 - centreX)));
    chosen = viable[0];
  }

  const { x0, y0 } = chosen;
  const targets = cells.map(cell => ({
    index: (y0 + cell.dr) * size + (x0 + cell.dc),
    value: cell.value,
    weight: cell.weight,
  }));
  const stuck = place(x0, y0, Infinity);

  return {
    targets,
    rect: { x: x0, y: y0, w: boxW, h: boxH },
    offset: { x: x0, y: y0 },
    bounds: { maxX: size - boxW, maxY: size - boxH },
    font, style, lines, clearance: requested, stuck,
  };
}

/** Chebyshev distance to the nearest ink module, saturating just past `cap`. */
function chebyshevDistance(ink, w, h, cap) {
  const far = cap + 1;
  const dist = new Int32Array(w * h).fill(far);
  let front = [];
  for (let i = 0; i < ink.length; i++) if (ink[i]) { dist[i] = 0; front.push(i); }
  for (let d = 1; d <= cap && front.length; d++) {
    const next = [];
    for (const i of front) {
      const r = (i / w) | 0, c = i % w;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr, cc = c + dc;
          if (rr < 0 || rr >= h || cc < 0 || cc >= w) continue;
          const j = rr * w + cc;
          if (dist[j] > d) { dist[j] = d; next.push(j); }
        }
      }
    }
    front = next;
  }
  return dist;
}

