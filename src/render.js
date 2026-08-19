// SVG and PNG output. Both are built from the same module grid.

export const DEFAULT_QUIET = 4; // modules; the spec's required quiet zone

/** Merges runs of dark modules in a row so the SVG stays small. */
function darkRuns(modules, size) {
  const runs = [];
  for (let r = 0; r < size; r++) {
    let start = -1;
    for (let c = 0; c <= size; c++) {
      const on = c < size && modules[r * size + c] === 1;
      if (on && start < 0) start = c;
      else if (!on && start >= 0) { runs.push([start, r, c - start]); start = -1; }
    }
  }
  return runs;
}

export function toSVG(result, {
  scale = 8, quiet = DEFAULT_QUIET, dark = '#000000', light = '#ffffff', title = null,
} = {}) {
  const { modules, size } = result;
  const total = size + quiet * 2;
  const dim = total * scale;
  const parts = [];
  for (const [x, y, w] of darkRuns(modules, size)) {
    parts.push(`M${x + quiet} ${y + quiet}h${w}v1h-${w}z`);
  }
  const label = title ?? `QR code for ${result.encoded}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" role="img" aria-label="${escapeXml(label)}">
<title>${escapeXml(label)}</title>
<rect width="${total}" height="${total}" fill="${light}"/>
<path fill="${dark}" d="${parts.join('')}"/>
</svg>`;
}

function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
}

// ---------------------------------------------------------- editing view --

function parseHex(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function mix(a, b, t) {
  const [ar, ag, ab] = parseHex(a), [br, bg, bb] = parseHex(b);
  const c = (x, y) => Math.round(x + (y - x) * t);
  return `rgb(${c(ar, br)},${c(ag, bg)},${c(ab, bb)})`;
}

/**
 * Preview used for editing. Modules that cannot be changed -- function
 * patterns, and modules carrying bits of the URL itself -- are drawn in full
 * black and white; everything the solver is free to move is drawn in muted
 * greys derived from the same pair, so the two readings stay comparable.
 * Exported PNG and SVG are always plain black and white.
 */
export function drawEditable(result, canvas, {
  scale = 8, quiet = DEFAULT_QUIET, dark = '#000000', light = '#ffffff',
} = {}) {
  const { modules, size, editable } = result;
  const total = size + quiet * 2;
  canvas.width = total * scale;
  canvas.height = total * scale;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const softDark = mix(dark, light, 0.42);
  const softLight = mix(light, dark, 0.16);
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const i = r * size + c;
      const on = modules[i] === 1;
      const free = editable && editable[i] === 1;
      if (!on && !free) continue; // fixed light: the background already
      ctx.fillStyle = on ? (free ? softDark : dark) : softLight;
      ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
    }
  }
  return canvas;
}

/** Which module a point on an editing canvas falls on, or null if outside. */
export function moduleAt(result, canvas, clientX, clientY, quiet = DEFAULT_QUIET) {
  const rect = canvas.getBoundingClientRect();
  const total = result.size + quiet * 2;
  const c = Math.floor(((clientX - rect.left) / rect.width) * total) - quiet;
  const r = Math.floor(((clientY - rect.top) / rect.height) * total) - quiet;
  if (r < 0 || c < 0 || r >= result.size || c >= result.size) return null;
  return r * result.size + c;
}

export function drawToCanvas(result, canvas, {
  scale = 8, quiet = DEFAULT_QUIET, dark = '#000000', light = '#ffffff',
} = {}) {
  const { modules, size } = result;
  const total = size + quiet * 2;
  canvas.width = total * scale;
  canvas.height = total * scale;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = dark;
  for (const [x, y, w] of darkRuns(modules, size)) {
    ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, w * scale, scale);
  }
  return canvas;
}

/** Renders at a scale that lands close to `targetPx` without blurring modules. */
export function scaleFor(size, targetPx, quiet = DEFAULT_QUIET) {
  return Math.max(1, Math.round(targetPx / (size + quiet * 2)));
}

export function svgBlob(svg) {
  return new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
}

export function canvasToPngBlob(canvas) {
  return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}

/** Filename stem: departuremono-com-v14-M-lower-band */
export function filenameFor(result) {
  const host = (result.label || 'qr').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
  const bits = [host, `v${result.version}`, result.ecl];
  if (result.fontId) bits.push(result.fontId);
  if (result.styleId) bits.push(result.styleId);
  return bits.join('-').toLowerCase();
}

/**
 * Roughly how wide the code must be printed to scan reliably.
 *
 * There is no fixed module ceiling imposed by phone cameras -- a version 40
 * symbol reads perfectly well if it is big enough. What matters is the size of
 * one module. 0.4 mm per module is a commonly cited rule of thumb for phone
 * scanning at arm's length; treat it as guidance, not a specification, and
 * give a code more room if it will be read in poor light or at a distance.
 */
export const MM_PER_MODULE = 0.4;

export function minPrintWidthMm(result, mmPerModule = MM_PER_MODULE, quiet = DEFAULT_QUIET) {
  return Math.ceil((result.size + quiet * 2) * mmPerModule);
}
