// Turns a module grid into closed outlines that a knife can follow.
//
// The PNG and SVG exports draw one filled rectangle per run of dark modules,
// which is right for ink and wrong for a blade: every shared edge between two
// dark modules would become a real cut straight through solid material. A
// cutter wants the boundary of each connected region and nothing else, so this
// walks that boundary directly.

/** Points per quarter turn when a rounded corner is written out as chords. */
export const SEGMENTS_PER_QUARTER = 6;

/** The most a corner may be rounded, in modules. Beyond half a module the
 *  roundings at the two ends of a one-module edge would meet. */
export const MAX_RADIUS = 0.5;

/**
 * How much material is left joining two modules that touch only at a corner.
 *
 * The two concave fillets that meet there each eat back r(sqrt2 - 1) from the
 * shared point, so the waist between them is twice that. The same number is
 * the gap on the other side, where the two convex roundings pull apart, so it
 * governs both the bridges that hold a piece together and the channels the
 * blade has to get through. Everything about sizing a cut follows from it:
 * pick the radius from the narrowest strip of material that survives weeding,
 * not from how the corners look.
 */
export function bridgeWaist(radius) {
  return 2 * radius * (Math.SQRT2 - 1);
}

/**
 * Which colour wins where two modules touch corner to corner.
 *
 * Only one can. The four cells are shared, so joining one diagonal necessarily
 * severs the other, and the choice is which of the two is worth more.
 *
 *   'minimal'  dark wins only where the dark would otherwise fall apart, and
 *              every other corner goes to the light
 *   'all'      dark wins everywhere: the artwork is joined as much as it can
 *              be, at the cost of every light region it encircles
 *   'none'     neither wins; the cut passes through the shared point and both
 *              come apart. Only reachable with square corners, since a cut
 *              through a single point is not one a blade can make.
 *
 * 'minimal' is not a compromise between the other two. Because the dark and
 * light connections across a corner are planar duals, a corner is redundant
 * for the dark exactly when it is essential for the light, so spending the
 * dark's corners on a spanning forest leaves the light with a spanning forest
 * too. It reaches the fewest possible pieces to keep and the fewest possible
 * picks to weed at the same time, and neither extreme does both.
 *
 * It must not be let anywhere near the letterforms, though. A spanning forest
 * of a closed ring leaves exactly one corner over, so the ring of an o loses a
 * quarter of itself and reads as a c, u or n depending on which corner went.
 * In a bitmap font a diagonal contact is a deliberate stroke join, not an
 * artefact to be optimised away, so `protect` hands every corner inside the
 * text to the colour the letters are drawn in and lets the counter of an o
 * become an island. One island is a cheap price for the letter staying legible,
 * which is the only reason any of this exists.
 */
export const BRIDGE_MODES = ['minimal', 'all', 'none'];

/**
 * Closed outlines of the dark region.
 *
 * Coordinates are in modules with the quiet zone already added, y running
 * down, matching the grid. Returns an array of loops, each an array of
 * {x, y}; the last point joins back to the first.
 *
 * With `radius` above zero the corners are rounded and, as a consequence,
 * modules touching corner to corner are bridged rather than pinched: a cut
 * through a single point is not something a blade can make, and the two
 * modules would come away as separate chips.
 */
export function outlines(modules, size, {
  quiet = 4,
  radius = 0,
  bridge = radius > 0 ? 'minimal' : 'none',
  protect = null,
  squareFinders = false,
  segments = SEGMENTS_PER_QUARTER,
} = {}) {
  const r = Math.min(Math.max(radius, 0), MAX_RADIUS);
  const loops = [];
  for (const raw of traceLoops(modules, size, bridge, protect)) {
    const corners = mergeCollinear(raw);
    const shaped = r > 0 ? roundCorners(corners, r, size, squareFinders, segments) : corners;
    loops.push(shaped.map(p => ({ x: p.x + quiet, y: p.y + quiet })));
  }
  return loops;
}

// ------------------------------------------------------------------ tracing

/**
 * Every dark cell contributes its four sides as directed edges, walked in the
 * same rotational order. Two dark cells that share a side contribute that side
 * twice, once in each direction, so cancelling every edge against its reverse
 * leaves exactly the boundary of the union and nothing interior.
 */
function traceLoops(modules, size, bridge, protect = null) {
  const V = size + 1;               // vertices along one side
  const darkWins = bridge === 'minimal' ? minimalDarkCorners(modules, size, protect) : null;
  const N = V * V;
  const vid = (x, y) => y * V + x;
  const edges = new Map();          // from * N + to -> [from, to]
  const add = (x0, y0, x1, y1) => {
    const a = vid(x0, y0), b = vid(x1, y1);
    if (edges.delete(b * N + a)) return; // interior: cancels its own reverse
    edges.set(a * N + b, [a, b]);
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (modules[y * size + x] !== 1) continue;
      add(x, y, x + 1, y);
      add(x + 1, y, x + 1, y + 1);
      add(x + 1, y + 1, x, y + 1);
      add(x, y + 1, x, y);
    }
  }

  const outgoing = new Map(), incoming = new Map();
  const push = (map, key, value) => {
    const list = map.get(key);
    if (list) list.push(value); else map.set(key, [value]);
  };
  for (const [a, b] of edges.values()) { push(outgoing, a, b); push(incoming, b, a); }

  const px = (v) => v % V, py = (v) => (v / V) | 0;
  // Where two dark modules meet corner to corner, four boundary edges meet at
  // one vertex and the walk has a choice of two. Taking the right-hand turn
  // keeps the modules apart, the left-hand turn runs the boundary around both
  // of them at once and joins them. Resolving every such vertex up front means
  // the walk itself never decides, and a loop that passes through the same
  // vertex twice, which is exactly what a bridged corner produces, still
  // chains correctly.
  const wantAt = (v) => {
    if (bridge === 'all') return -1;
    if (bridge === 'none') return 1;
    return darkWins.has(v) ? -1 : 1;
  };
  const successor = new Map();
  for (const [v, ins] of incoming) {
    const outs = outgoing.get(v);
    if (ins.length === 1) { successor.set(ins[0] * N + v, v * N + outs[0]); continue; }
    const want = wantAt(v);
    for (const a of ins) {
      const dx = px(v) - px(a), dy = py(v) - py(a);
      const next = outs.find(c => Math.sign(dx * (py(c) - py(v)) - dy * (px(c) - px(v))) === want);
      successor.set(a * N + v, v * N + next);
    }
  }

  const seen = new Set();
  const loops = [];
  for (const key of edges.keys()) {
    if (seen.has(key)) continue;
    const loop = [];
    let edge = key;
    do {
      seen.add(edge);
      const from = (edge - (edge % N)) / N;
      loop.push({ x: px(from), y: py(from) });
      edge = successor.get(edge);
    } while (edge !== key);
    loops.push(loop);
  }
  return loops;
}

/** Drops the points in the middle of a straight run, keeping only real corners. */
function mergeCollinear(points) {
  const n = points.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const prev = points[(i + n - 1) % n], cur = points[i], next = points[(i + 1) % n];
    const ax = cur.x - prev.x, ay = cur.y - prev.y;
    const bx = next.x - cur.x, by = next.y - cur.y;
    if (ax * by - ay * bx !== 0) out.push(cur);
  }
  return out;
}

// ----------------------------------------------------------------- rounding

/**
 * Replaces each right-angled corner with a quarter circle of radius r, written
 * out as chords.
 *
 * Every corner is handled the same way whichever direction it turns. Outward
 * corners round off, so an isolated module becomes a rounded square; inward
 * corners fillet, which is what relieves the sharp interior angles where vinyl
 * tears and a blade overshoots; and the two inward corners that meet where
 * modules touch diagonally leave the bridge between them.
 */
function roundCorners(points, r, size, squareFinders, segments) {
  const n = points.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = points[i], prev = points[(i + n - 1) % n], next = points[(i + 1) % n];
    const inLen = Math.hypot(p.x - prev.x, p.y - prev.y);
    const outLen = Math.hypot(next.x - p.x, next.y - p.y);
    // Half an edge is the most either of its two corners may eat. Merged edges
    // are at least one module long and r never exceeds half a module, so this
    // only guards the assumption.
    const rr = Math.min(r, inLen / 2, outLen / 2);
    if (rr <= 0 || (squareFinders && inFinder(p, size))) { out.push(p); continue; }

    const inDir = { x: (p.x - prev.x) / inLen, y: (p.y - prev.y) / inLen };
    const outDir = { x: (next.x - p.x) / outLen, y: (next.y - p.y) / outLen };
    const t1 = { x: p.x - rr * inDir.x, y: p.y - rr * inDir.y };
    const t2 = { x: p.x + rr * outDir.x, y: p.y + rr * outDir.y };
    // Tangent to both edges at t1 and t2, on whichever side the corner turns.
    const c = { x: t1.x + rr * outDir.x, y: t1.y + rr * outDir.y };

    const a0 = Math.atan2(t1.y - c.y, t1.x - c.x);
    const a1 = Math.atan2(t2.y - c.y, t2.x - c.x);
    let sweep = a1 - a0;                                  // always a quarter turn
    while (sweep > Math.PI) sweep -= 2 * Math.PI;
    while (sweep < -Math.PI) sweep += 2 * Math.PI;
    for (let s = 0; s <= segments; s++) {
      const a = a0 + (sweep * s) / segments;
      out.push({ x: c.x + rr * Math.cos(a), y: c.y + rr * Math.sin(a) });
    }
  }
  return out;
}

/**
 * Whether a vertex belongs to one of the three finder patterns.
 *
 * The finders are the one structure a decoder looks for before it knows
 * anything else about the symbol, and they are separated from the data by a
 * light ring, so leaving them square costs nothing and takes the only real
 * detection risk off the table for anyone who wants it.
 */
function inFinder({ x, y }, size) {
  const box = (x0, y0) => x >= x0 && x <= x0 + 7 && y >= y0 && y <= y0 + 7;
  return box(0, 0) || box(size - 7, 0) || box(0, size - 7);
}

// ------------------------------------------------------------------ pieces

function unionFind(n) {
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  return {
    find,
    /** Joins two cells, and reports whether they were separate until now. */
    union(a, b) { a = find(a); b = find(b); if (a === b) return false; parent[a] = b; return true; },
  };
}

/** Calls back for every corner where two modules of one colour meet diagonally. */
function forEachCorner(grid, width, height, fn) {
  for (let r = 0; r + 1 < height; r++) {
    for (let c = 0; c + 1 < width; c++) {
      const a = r * width + c, b = a + 1, d = a + width, e = d + 1;
      if (grid[a] !== grid[e] || grid[b] !== grid[d] || grid[a] === grid[b]) continue;
      const upLeftDark = grid[a] === 1;
      fn(c + 1, r + 1, upLeftDark ? [a, e] : [b, d], upLeftDark ? [b, d] : [a, e]);
    }
  }
}

function joinOrthogonal(grid, width, height, u, colour) {
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const i = r * width + c;
      if (grid[i] !== colour) continue;
      if (c + 1 < width && grid[i + 1] === colour) u.union(i, i + 1);
      if (r + 1 < height && grid[i + width] === colour) u.union(i, i + width);
    }
  }
}

function countRegions(grid, u, colour) {
  const roots = new Set();
  for (let i = 0; i < grid.length; i++) if (grid[i] === colour) roots.add(u.find(i));
  return roots.size;
}

/**
 * The corners the dark cannot afford to give away.
 *
 * Orthogonal neighbours are joined first, since those joins cost nothing. A
 * diagonal corner is then kept only when it is the first thing to connect its
 * two modules; anything left over is redundant, and redundant is exactly what
 * the light side needs.
 */
export function minimalDarkCorners(modules, size, protect = null) {
  const u = unionFind(size * size);
  joinOrthogonal(modules, size, size, u, 1);
  const keep = new Set();
  const V = size + 1;
  // Corners inside the text are settled first and are not negotiable: the ink
  // takes them whichever colour it is, so strokes drawn as joined stay joined.
  // Only what is left over goes to the spanning forest.
  const spare = [];
  forEachCorner(modules, size, size, (x, y, dark) => {
    if (inProtected(x, y, protect)) {
      if (protect.color === 1) { u.union(dark[0], dark[1]); keep.add(y * V + x); }
      return; // light ink: the corner is the light's, so the dark never bids
    }
    spare.push([x, y, dark]);
  });
  for (const [x, y, dark] of spare) if (u.union(dark[0], dark[1])) keep.add(y * V + x);
  return keep;
}

/**
 * Whether all four cells around a corner lie inside the protected rectangle.
 *
 * `protect` is `{ rect: {x, y, w, h}, color }` in module coordinates, where
 * `color` is 1 when the letters are dark and 0 when they are light.
 */
function inProtected(x, y, protect) {
  if (!protect) return false;
  const { x: rx, y: ry, w, h } = protect.rect;
  return x > rx && x < rx + w && y > ry && y < ry + h;
}

/** The grid with its quiet zone, so the field around the symbol counts once. */
function padded(modules, size, quiet) {
  const total = size + quiet * 2;
  const grid = new Uint8Array(total * total);
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) grid[(r + quiet) * total + c + quiet] = modules[r * size + c];
  }
  return { grid, total };
}

/**
 * What a cut of this code will cost in handling: how many separate pieces come
 * away as the artwork, and how many have to be picked out of it.
 *
 * Counted under the same corner decisions the tracer makes, so these are the
 * pieces that will actually be in front of you rather than an estimate.
 */
export function cutCounts(modules, size, { quiet = 4, bridge = 'minimal', protect = null } = {}) {
  const { grid, total } = padded(modules, size, quiet);
  const dark = unionFind(total * total), light = unionFind(total * total);
  joinOrthogonal(grid, total, total, dark, 1);
  joinOrthogonal(grid, total, total, light, 0);
  const darkWins = bridge === 'minimal' ? minimalDarkCorners(modules, size, protect) : null;
  const V = size + 1;
  forEachCorner(grid, total, total, (x, y, d, l) => {
    const toDark = bridge === 'all' ? true
      : bridge === 'none' ? false
      : darkWins.has((y - quiet) * V + (x - quiet));
    if (bridge === 'none') return;  // the cut goes through the point; both come apart
    if (toDark) dark.union(d[0], d[1]); else light.union(l[0], l[1]);
  });
  return {
    keep: countRegions(grid, dark, 1),
    weed: countRegions(grid, light, 0),
  };
}

/** Connected regions of one colour, ignoring diagonal contact entirely. */
export function regionCount(modules, size, dark, connectivity = 4) {
  const neighbors = connectivity === 8
    ? [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]
    : [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const want = dark ? 1 : 0;
  const seen = new Uint8Array(size * size);
  let count = 0;
  for (let start = 0; start < size * size; start++) {
    if (seen[start] || modules[start] !== want) continue;
    count++;
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const at = stack.pop();
      const r = (at / size) | 0, c = at % size;
      for (const [dr, dc] of neighbors) {
        const nr = r + dr, nc = c + dc;
        if (nr < 0 || nc < 0 || nr >= size || nc >= size) continue;
        const next = nr * size + nc;
        if (!seen[next] && modules[next] === want) { seen[next] = 1; stack.push(next); }
      }
    }
  }
  return count;
}
