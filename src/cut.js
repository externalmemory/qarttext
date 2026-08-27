// Output for machines that cut rather than print: a vinyl cutter, a laser, a
// craft plotter.
//
// Both writers take the same closed outlines from contour.js, so the file a
// cutter follows and the file you preview are the same geometry to the
// micrometer. Coordinates arrive in modules with y running down, the way the
// grid is stored, and leave in millimeters.

const PLACES = 4; // 0.1 micrometer, far below anything a cutter can resolve

function fmt(value) {
  return (Math.abs(value) < 5e-5 ? 0 : value).toFixed(PLACES);
}

/** Physical width, in millimeters, of a symbol drawn at this module size. */
export function widthMm(size, moduleMm, quiet) {
  return (size + quiet * 2) * moduleMm;
}

// ---------------------------------------------------------------------- DXF

// R12 rather than anything newer. LWPOLYLINE would be a third the size, but it
// arrived in R14, and the importers on cutting software are old and narrow.
// A closed POLYLINE with plain VERTEX entities is the widest-supported way to
// say "this is one path, follow it and come back to the start".
const HEADER = [
  '0', 'SECTION', '2', 'HEADER',
  '9', '$ACADVER', '1', 'AC1009',
  // Millimeters. DXF is nominally unitless and importers disagree about what
  // that means, which is why the intended width also goes in the file name.
  '9', '$INSUNITS', '70', '4',
  '9', '$MEASUREMENT', '70', '1',
];

const TABLES = [
  '0', 'SECTION', '2', 'TABLES',
  '0', 'TABLE', '2', 'LTYPE', '70', '1',
  '0', 'LTYPE', '2', 'CONTINUOUS', '70', '0', '3', 'Solid line', '72', '65', '73', '0', '40', '0.0',
  '0', 'ENDTAB',
  // Two layers, because software that assigns a tool or a pass by color needs
  // somewhere to hang the distinction. Everything to be cut is on CUT.
  '0', 'TABLE', '2', 'LAYER', '70', '2',
  '0', 'LAYER', '2', 'CUT', '70', '0', '62', '7', '6', 'CONTINUOUS',
  '0', 'LAYER', '2', 'GUIDE', '70', '0', '62', '1', '6', 'CONTINUOUS',
  '0', 'ENDTAB',
  '0', 'ENDSEC',
];

// Appends into `out` rather than returning a list to be spread. A single loop
// can run to tens of thousands of vertices once corners are joined rather than
// pinched, and spreading an array that long into push() overruns the argument
// limit outright.
function polyline(out, points, layer, project) {
  out.push('0', 'POLYLINE', '8', layer, '66', '1', '70', '1');
  for (const p of points) {
    const [x, y] = project(p);
    out.push('0', 'VERTEX', '8', layer, '10', fmt(x), '20', fmt(y), '30', '0.0');
  }
  out.push('0', 'SEQEND', '8', layer);
}

/**
 * `loops` are module coordinates with the quiet zone already in them.
 *
 * DXF puts y upwards and the grid puts it downwards, so every point is
 * flipped. Getting that wrong produces a mirrored symbol, which is a thing no
 * scanner will read and no amount of staring at the preview will reveal.
 */
export function toDXF(loops, { moduleMm = 3, total, guide = false } = {}) {
  const extent = total * moduleMm;
  const project = (p) => [p.x * moduleMm, extent - p.y * moduleMm];
  const lines = [
    ...HEADER,
    '9', '$EXTMIN', '10', '0.0', '20', '0.0', '30', '0.0',
    '9', '$EXTMAX', '10', fmt(extent), '20', fmt(extent), '30', '0.0',
    '0', 'ENDSEC',
    ...TABLES,
    '0', 'SECTION', '2', 'ENTITIES',
  ];
  for (const loop of loops) polyline(lines, loop, 'CUT', project);
  if (guide) {
    // The quiet zone carries no geometry of its own: it is bare material. This
    // is only a placement rectangle, on its own layer so it is easy to ignore.
    const corners = [
      { x: 0, y: 0 }, { x: total, y: 0 }, { x: total, y: total }, { x: 0, y: total },
    ];
    polyline(lines, corners, 'GUIDE', project);
  }
  lines.push('0', 'ENDSEC', '0', 'EOF');
  return lines.join('\r\n') + '\r\n';
}

// ----------------------------------------------------------------- cut SVG

/**
 * The same outlines as unfilled strokes at true size.
 *
 * Worth having next to the DXF: SVG carries real units, so it lands at the
 * right size instead of depending on what the importer assumes a DXF unit is.
 * Where the software can read it, prefer it.
 */
export function toCutSVG(loops, { moduleMm = 3, total, guide = false, title = null } = {}) {
  const extent = total * moduleMm;
  const path = (loop) => 'M' + loop
    .map(p => `${fmt(p.x * moduleMm)} ${fmt(p.y * moduleMm)}`)
    .join('L') + 'Z';
  const cut = loops.map(path).join('');
  const frame = guide
    ? `\n<rect x="0" y="0" width="${fmt(extent)}" height="${fmt(extent)}" fill="none" stroke="#ff0000" stroke-width="0.05"/>`
    : '';
  const label = title ?? 'QR code cutting path';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(extent)}mm" height="${fmt(extent)}mm" viewBox="0 0 ${fmt(extent)} ${fmt(extent)}" role="img" aria-label="${escapeXml(label)}">
<title>${escapeXml(label)}</title>
<path d="${cut}" fill="none" stroke="#000000" stroke-width="0.05"/>${frame}
</svg>`;
}

function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, c => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
}
