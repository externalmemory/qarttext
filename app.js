import { FONTS, FONT_BY_ID } from './src/fonts.js';
import { STYLES, STYLE_BY_ID } from './src/layout.js';
import { toSVG, drawToCanvas, drawEditable, moduleAt, scaleFor, svgBlob, canvasToPngBlob, filenameFor, minPrintWidthMm, MM_PER_MODULE, DEFAULT_QUIET } from './src/render.js';

const $ = (id) => document.getElementById(id);
const els = {
  form: $('form'), url: $('url'), go: $('go'),
  ecl: $('ecl'), maxLines: $('maxLines'), label: $('label'),
  clearance: $('clearance'), offsetOut: $('offsetOut'), autoPlace: $('autoPlace'),
  editState: $('editState'), clearEdits: $('clearEdits'),
  status: $('status'), galleryWrap: $('galleryWrap'), gallery: $('gallery'),
  detail: $('detail'), detailTitle: $('detailTitle'), detailCaption: $('detailCaption'),
  bigCanvas: $('bigCanvas'), stats: $('stats'),
  scale: $('scale'), scaleOut: $('scaleOut'), dark: $('dark'), light: $('light'),
  contrastWarn: $('contrastWarn'), dlPng: $('dlPng'), dlSvg: $('dlSvg'),
  runCheck: $('runCheck'), checkGallery: $('checkGallery'), verdict: $('verdict'),
};

let selected = null;
let selectedCard = null;
let token = 0;
/** Modules the reader has flipped by hand: module index -> wanted value. */
const overrides = new Map();
const cells = new Map();

// --------------------------------------------------------------- the worker

let worker = null;
try {
  worker = new Worker('./worker.js', { type: 'module' });
} catch {
  worker = null; // module workers unsupported; fall back below
}

let fallback = null;
async function runFallback(message, onMessage) {
  fallback ??= {
    variants: (await import('./src/variants.js')).buildVariants,
    gen: await import('./src/generate.js'),
  };
  // Same protocol as the worker, just synchronous.
  const { type, token: tk, ...opts } = message;
  if (type === 'variants') {
    fallback.variants(opts, (result, i, n) => onMessage({ type: 'variant', token: tk, result, i, n }));
    onMessage({ type: 'done', token: tk });
  } else if (type === 'nudge') {
    onMessage({ type: 'nudged', token: tk, result: fallback.gen.generate(opts) });
  } else if (type === 'check') {
    const { generate, generatePlain, generateNoisyPadding } = fallback.gen;
    const tests = [
      ['plain', '1. Control', 'An ordinary QR code with the conventional EC/11 padding.', generatePlain(opts)],
      ['noisy', '2. Padding', 'Same URL, random padding after the terminator, no artwork.', generateNoisyPadding(opts)],
      ['qart', '3. The real thing', 'Padding solved to spell the domain name inside the code.', generate({ ...opts, fontId: 'lower', styleId: 'band' })],
    ];
    for (const [key, name, note, result] of tests) onMessage({ type: 'check', token: tk, key, name, note, result });
    onMessage({ type: 'done', token: tk });
  }
}

function send(message, onMessage) {
  if (worker) {
    worker.onmessage = (e) => onMessage(e.data);
    worker.postMessage(message);
  } else {
    runFallback(message, onMessage).catch(err => onMessage({ type: 'error', message: String(err) }));
  }
}

// ------------------------------------------------------------------ options

function readOptions() {
  const override = els.label.value.trim();
  return {
    url: els.url.value.trim(),
    ecl: els.ecl.value,
    maxLines: Number(els.maxLines.value),
    clearance: Number(els.clearance.value),
    text: override || null,
  };
}

function colours() {
  return { dark: els.dark.value, light: els.light.value };
}

// ------------------------------------------------------------------ gallery

// Fonts across, extent and inversion down. The skeleton goes up first so
// results can drop into the right cell as they arrive.
function buildTable() {
  const thead = document.createElement('thead');
  const head = document.createElement('tr');
  head.append(document.createElement('td'));
  for (const f of FONTS) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = f.name;
    head.append(th);
  }
  thead.append(head);

  const tbody = document.createElement('tbody');
  cells.clear();
  for (const style of STYLES) {
    const tr = document.createElement('tr');
    const th = document.createElement('th');
    th.scope = 'row';
    th.textContent = style.name;
    tr.append(th);
    for (const f of FONTS) {
      const td = document.createElement('td');
      td.textContent = '…';
      cells.set(`${f.id}-${style.id}`, td);
      tr.append(td);
    }
    tbody.append(tr);
  }
  els.gallery.replaceChildren(thead, tbody);
}

function variantName(r) {
  const font = FONT_BY_ID[r.fontId], style = STYLE_BY_ID[r.styleId];
  return `${style?.name ?? r.styleId} · ${font?.name ?? r.fontId}`;
}

function makeCard(r) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'card';
  card.setAttribute('aria-pressed', 'false');

  if (r.unfit || !r.modules) {
    card.classList.add('unfit');
    card.disabled = true;
    card.innerHTML = `<div class="meta">${r.error ? 'failed' : 'will not fit'}</div>`;
    return card;
  }

  const canvas = document.createElement('canvas');
  drawToCanvas(r, canvas, { scale: scaleFor(r.size, 320), quiet: DEFAULT_QUIET, ...colours() });

  const perfect = r.stats.inkMisses === 0;
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.innerHTML = `v${r.version}-${r.ecl} &middot; ${r.size}&times;${r.size} &middot; &ge;${minPrintWidthMm(r)}&thinsp;mm<br>`
    + `<span class="badge${perfect ? '' : ' imperfect'}">`
    + (perfect ? 'letterforms exact' : `${r.stats.inkMisses} stuck in text`)
    + `</span> &middot; ${(r.stats.fidelity * 100).toFixed(1)}% plate`
    + (r.hardWrapped ? '<br>broken mid-label' : '');

  card.append(canvas, meta);
  card.addEventListener('click', () => select(r, card));
  return card;
}

function select(r, card, keepEdits = false) {
  if (!keepEdits && (!selected || selected.id !== r.id || selected.size !== r.size)) overrides.clear();
  selected = r;
  if (card !== undefined) selectedCard = card;
  for (const c of els.gallery.querySelectorAll('.card')) c.setAttribute('aria-pressed', 'false');
  selectedCard?.setAttribute('aria-pressed', 'true');

  els.detail.hidden = false;
  els.detailTitle.textContent = variantName(r);
  els.detailCaption.textContent = `Encodes exactly: ${r.encoded}`;
  redrawBig();

  const s = r.stats;
  els.stats.innerHTML = [
    ['symbol', `version ${r.version}, level ${r.ecl}, ${r.size}×${r.size}, mask ${r.mask}`],
    ['text', r.lines.map(l => `“${l}”`).join(' / ')],
    ['free bits', `${s.freeBits} of ${s.dataCodewords * 8} data bits`],
    ['modules forced', `${s.forced} (rank ${s.rank})`],
    ['letterforms', s.inkMisses === 0 ? `all ${s.inkTotal} exact` : `${s.inkMisses} of ${s.inkTotal} stuck`],
    ['plate fidelity', `${(s.fidelity * 100).toFixed(2)}%`],
    ['print at least', `${minPrintWidthMm(r)} mm wide (${MM_PER_MODULE} mm per module — a rule of thumb, not a spec)`],
    ['error correction', 'fully intact — nothing spent'],
  ].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');

  els.offsetOut.textContent = r.offset
    ? `x ${r.offset.x} of ${r.bounds.maxX}, y ${r.offset.y} of ${r.bounds.maxY}`
    : '';
  setNudgeEnabled(true);
  showEditState();
}

// ------------------------------------------------------------------ editing

function showEditState(message = null) {
  const n = overrides.size;
  els.clearEdits.hidden = n === 0;
  els.editState.textContent = message
    ?? (n === 0 ? 'Click a grey module in the preview to flip it.'
                : `${n} module${n === 1 ? '' : 's'} set by hand.`);
}

els.bigCanvas.addEventListener('click', (event) => {
  if (!selected) return;
  const index = moduleAt(selected, els.bigCanvas, event.clientX, event.clientY);
  if (index === null) return;
  if (!selected.editable?.[index]) {
    showEditState('That module is fixed: it is a function pattern, or it carries a bit of the URL.');
    return;
  }
  // Flipping one module means re-solving; the rest of the code moves with it.
  overrides.set(index, selected.modules[index] ^ 1);
  showEditState('Re-solving…');
  replace({ offset: selected.offset, versionOverride: selected.version });
});

els.clearEdits.addEventListener('click', () => {
  if (!selected || overrides.size === 0) return;
  overrides.clear();
  replace({ offset: selected.offset, versionOverride: selected.version });
});

// ---------------------------------------------------------------- placement

// A direction is only offered when the box can actually travel that way: with
// a text block nearly as wide as the symbol there may be no horizontal room at
// all, and a dead button that silently does nothing is worse than a greyed one.
function setNudgeEnabled(on) {
  const auto = document.getElementById('autoPlace');
  auto.disabled = !on;
  for (const b of document.querySelectorAll('.nudge button[data-dx]')) {
    if (!on || !selected?.offset) { b.disabled = true; continue; }
    const dx = Number(b.dataset.dx), dy = Number(b.dataset.dy);
    const { maxX, maxY } = selected.bounds;
    const nx = Math.min(Math.max(selected.offset.x + dx, 0), maxX);
    const ny = Math.min(Math.max(selected.offset.y + dy, 0), maxY);
    b.disabled = nx === selected.offset.x && ny === selected.offset.y;
  }
}

function nudge(dx, dy) {
  if (!selected?.offset) return;
  const b = selected.bounds ?? { maxX: selected.size, maxY: selected.size };
  const offset = {
    x: Math.min(Math.max(selected.offset.x + dx, 0), b.maxX),
    y: Math.min(Math.max(selected.offset.y + dy, 0), b.maxY),
  };
  if (offset.x === selected.offset.x && offset.y === selected.offset.y) return;
  replace({ offset, versionOverride: selected.version });
}

function replace(extra) {
  const tk = ++token;
  setNudgeEnabled(false);
  send({
    type: 'nudge', token: tk, ...readOptions(),
    fontId: selected.fontId, styleId: selected.styleId,
    overrides: [...overrides].map(([index, value]) => ({ index, value })),
    ...extra,
  }, (msg) => {
    if (msg.token !== tk) return;
    setNudgeEnabled(true);
    if (msg.type !== 'nudged' || !msg.result) { setStatus('That placement has no solution.', true); return; }
    if (selectedCard) {
      const canvas = selectedCard.querySelector('canvas');
      if (canvas) {
        drawToCanvas(msg.result, canvas, { scale: scaleFor(msg.result.size, 320), quiet: DEFAULT_QUIET, ...colours() });
        painted.set(canvas, msg.result);
      }
    }
    select(msg.result, undefined, true);
    // Report any click the solver could not honour rather than silently losing it.
    const ignored = [...overrides].filter(([i, v]) => msg.result.modules[i] !== v).length;
    showEditState(ignored ? `${overrides.size} set by hand, ${ignored} could not be honoured.` : null);
  });
}

for (const b of document.querySelectorAll('.nudge button[data-dx]')) {
  b.addEventListener('click', () => nudge(Number(b.dataset.dx), Number(b.dataset.dy)));
}
els.autoPlace.addEventListener('click', () => {
  if (selected) replace({ offset: null, versionOverride: selected.version });
});

function redrawBig() {
  if (!selected) return;
  const scale = Number(els.scale.value);
  els.scaleOut.textContent = scale;
  drawEditable(selected, els.bigCanvas, { scale, quiet: DEFAULT_QUIET, ...colours() });
  els.contrastWarn.hidden = contrastRatio(els.dark.value, els.light.value) >= 3;
}

// Warns on inverted *and* merely weak pairings; both defeat a binariser.
function contrastRatio(darkHex, lightHex) {
  const d = luminance(darkHex), l = luminance(lightHex);
  if (d >= l) return 0; // inverted: dark modules must be the darker colour
  return (l + 0.05) / (d + 0.05);
}

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// ---------------------------------------------------------------- downloads

function saveBlob(blob, filename) {
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 2000);
}

els.dlSvg.addEventListener('click', () => {
  if (!selected) return;
  const svg = toSVG(selected, { scale: Number(els.scale.value), quiet: DEFAULT_QUIET, ...colours() });
  saveBlob(svgBlob(svg), `${filenameFor(selected)}.svg`);
});

els.dlPng.addEventListener('click', async () => {
  if (!selected) return;
  const canvas = document.createElement('canvas');
  drawToCanvas(selected, canvas, { scale: Number(els.scale.value), quiet: DEFAULT_QUIET, ...colours() });
  saveBlob(await canvasToPngBlob(canvas), `${filenameFor(selected)}.png`);
});

els.scale.addEventListener('input', redrawBig);
els.dark.addEventListener('input', () => { redrawBig(); repaintGallery(); });
els.light.addEventListener('input', () => { redrawBig(); repaintGallery(); });

const painted = new Map();
function repaintGallery() {
  for (const [canvas, r] of painted) {
    drawToCanvas(r, canvas, { scale: scaleFor(r.size, 320), quiet: DEFAULT_QUIET, ...colours() });
  }
}

// ----------------------------------------------------------------- generate

els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  run();
});

function run() {
  const opts = readOptions();
  if (!opts.url) { setStatus('Enter a URL first.', true); return; }

  const tk = ++token;
  els.go.disabled = true;
  buildTable();
  painted.clear();
  overrides.clear();
  els.galleryWrap.hidden = false;
  els.detail.hidden = true;
  selected = null;
  selectedCard = null;
  setStatus('Solving…');

  const started = performance.now();
  send({ type: 'variants', token: tk, ...opts }, (msg) => {
    if (msg.token !== tk) return;
    if (msg.type === 'error') { setStatus(msg.message, true); els.go.disabled = false; return; }
    if (msg.type === 'variant') {
      const card = makeCard(msg.result);
      const canvas = card.querySelector('canvas');
      if (canvas) painted.set(canvas, msg.result);
      cells.get(msg.result.id)?.replaceChildren(card);
      setStatus(`Solving… ${msg.i + 1} of ${msg.n}`);
      if (!selected && msg.result.modules) select(msg.result, card);
    }
    if (msg.type === 'done') {
      els.go.disabled = false;
      const fitted = els.gallery.querySelectorAll('.card:not(.unfit)').length;
      setStatus(fitted
        ? `${fitted} variants in ${Math.round(performance.now() - started)} ms. Every one is a valid QR code with its error correction untouched.`
        : 'Nothing fits. Try a larger maximum symbol, a lower error-correction level, or more lines.', !fitted);
    }
  });
}

function setStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.classList.toggle('error', isError);
}

// ------------------------------------------------------------ decoder check

els.runCheck.addEventListener('click', () => {
  const opts = readOptions();
  if (!opts.url) { setStatus('Enter a URL first.', true); return; }
  const tk = ++token;
  els.runCheck.disabled = true;
  els.checkGallery.replaceChildren();
  els.verdict.hidden = false;

  send({ type: 'check', token: tk, ...opts }, (msg) => {
    if (msg.token !== tk) return;
    if (msg.type === 'error') { setStatus(msg.message, true); els.runCheck.disabled = false; return; }
    if (msg.type === 'check' && msg.result) {
      const wrap = document.createElement('div');
      wrap.className = 'card';
      wrap.style.cursor = 'default';
      const canvas = document.createElement('canvas');
      drawToCanvas(msg.result, canvas, { scale: scaleFor(msg.result.size, 360), quiet: DEFAULT_QUIET });
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = msg.name;
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = msg.note;
      const expect = document.createElement('div');
      expect.className = 'meta';
      expect.innerHTML = `<strong>must scan as</strong><br>${msg.result.encoded}`;
      wrap.append(canvas, name, meta, expect);
      els.checkGallery.append(wrap);
    }
    if (msg.type === 'done') els.runCheck.disabled = false;
  });
});

// ------------------------------------------------------------------ offline

// Keep in step with BUILD in sw.js; shown in the footer so it is obvious which
// version is loaded when something looks out of date.
const BUILD = '2026-08-19.2';
document.getElementById('build').textContent = BUILD;

if ('serviceWorker' in navigator) {
  // If a worker was already in charge and a new one takes over, the page is
  // running the old scripts: reload once so a deploy is never a version behind.
  let reloading = false;
  if (navigator.serviceWorker.controller) {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return;
      reloading = true;
      location.reload();
    });
  }
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then(reg => reg.update())
      .catch(() => { /* offline is a bonus, not a requirement */ });
  });
}

run();
