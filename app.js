import { FONTS, FONT_BY_ID } from './src/fonts.js';
import { STYLES, STYLE_BY_ID } from './src/layout.js';
import { buildPayload } from './src/payload.js';
import { installHint, isInstalled } from './src/install.js';
import { toSVG, drawToCanvas, drawEditable, moduleAt, scaleFor, svgBlob, canvasToPngBlob, filenameFor, minPrintWidthMm, MM_PER_MODULE, DEFAULT_QUIET } from './src/render.js';

const $ = (id) => document.getElementById(id);
const els = {
  form: $('form'), url: $('url'), go: $('go'), type: $('type'),
  tel: $('tel'), ssid: $('ssid'), wifiPass: $('wifiPass'), wifiAuth: $('wifiAuth'),
  wifiHidden: $('wifiHidden'), payloadWarn: $('payloadWarn'),
  ecl: $('ecl'), maxLines: $('maxLines'), label: $('label'),
  clearance: $('clearance'), offsetOut: $('offsetOut'), autoPlace: $('autoPlace'),
  editState: $('editState'), clearEdits: $('clearEdits'),
  status: $('status'), galleryWrap: $('galleryWrap'), gallery: $('gallery'),
  detail: $('detail'), detailTitle: $('detailTitle'), detailCaption: $('detailCaption'),
  bigCanvas: $('bigCanvas'), stats: $('stats'),
  scale: $('scale'), scaleOut: $('scaleOut'), dark: $('dark'), light: $('light'),
  contrastWarn: $('contrastWarn'), dlPng: $('dlPng'), dlSvg: $('dlSvg'),
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
  const type = els.type.value;
  const { payload, label, warning } = buildPayload({
    type,
    url: els.url.value,
    number: els.tel.value,
    ssid: els.ssid.value,
    password: els.wifiPass.value,
    auth: els.wifiAuth.value,
    hidden: els.wifiHidden.checked,
  });
  els.payloadWarn.textContent = warning ?? '';
  els.payloadWarn.hidden = !warning;
  return {
    payload, label,
    ecl: els.ecl.value,
    maxLines: Number(els.maxLines.value),
    clearance: Number(els.clearance.value),
    text: override || null,
  };
}

// Only the fields belonging to the selected kind are shown.
function showFields() {
  const type = els.type.value;
  for (const id of ['url', 'tel', 'wifi']) {
    document.getElementById(`fields-${id}`).hidden = id !== type;
  }
}
els.type.addEventListener('change', () => { showFields(); run(); });
showFields();

function colors() {
  return { dark: els.dark.value, light: els.light.value };
}

// ------------------------------------------------------------------ gallery

// Fonts across, extent and inversion down. The skeleton goes up first so
// results can drop into the right cell as they arrive.
function buildTable() {
  const thead = document.createElement('thead');
  const head = document.createElement('tr');
  for (const f of FONTS) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = f.name;
    head.append(th);
  }
  thead.append(head);

  // No row headings: Plate against Halo, and upright against inverted, are
  // obvious from the pictures, and on a phone the column of labels cost more
  // width than the codes themselves. Each card names its own style instead,
  // so nothing is lost to a screen reader or to a hover.
  const tbody = document.createElement('tbody');
  cells.clear();
  for (const style of STYLES) {
    const tr = document.createElement('tr');
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
  card.title = variantName(r);

  if (r.unfit || !r.modules) {
    card.classList.add('unfit');
    card.disabled = true;
    card.innerHTML = `<div class="meta">${r.error ? 'failed' : 'will not fit'}</div>`;
    return card;
  }

  const canvas = document.createElement('canvas');
  drawToCanvas(r, canvas, { scale: scaleFor(r.size, 320), quiet: DEFAULT_QUIET, ...colors() });

  const perfect = r.stats.inkMisses === 0;
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.innerHTML = `v${r.version}-${r.ecl} &middot; ${r.size}&times;${r.size} &middot; &ge;${minPrintWidthMm(r)}&thinsp;mm<br>`
    + `<span class="badge${perfect ? '' : ' imperfect'}">`
    + (perfect ? 'letterforms exact' : `${r.stats.inkMisses} stuck in text`)
    + `</span> &middot; ${(r.stats.fidelity * 100).toFixed(1)}% plate`
    + (r.hardWrapped ? '<br>broken mid-label' : '');

  card.append(canvas, meta);
  card.setAttribute('aria-label',
    `${variantName(r)}, version ${r.version} level ${r.ecl}, ${r.size} by ${r.size} modules`);
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
  // Built as nodes rather than markup: the label comes from whatever was typed
  // in, and interpolating that into innerHTML would make it executable.
  els.stats.replaceChildren(...[
    ['symbol', `version ${r.version}, level ${r.ecl}, ${r.size}×${r.size}, mask ${r.mask}`],
    ['text', r.lines.map(l => `“${l}”`).join(' / ')],
    ['free bits', `${s.freeBits} of ${s.dataCodewords * 8} data bits`],
    ['modules forced', `${s.forced} (rank ${s.rank})`],
    ['letterforms', s.inkMisses === 0 ? `all ${s.inkTotal} exact` : `${s.inkMisses} of ${s.inkTotal} stuck`],
    ['plate fidelity', `${(s.fidelity * 100).toFixed(2)}%`],
    ['print at least', `${minPrintWidthMm(r)} mm wide (${MM_PER_MODULE} mm per module, a rule of thumb rather than a spec)`],
  ].flatMap(([key, value]) => {
    const dt = document.createElement('dt');
    dt.textContent = key;
    const dd = document.createElement('dd');
    dd.textContent = value;
    return [dt, dd];
  }));

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
    ?? (n === 0 ? 'Click a gray module in the preview to flip it.'
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
// all, and a dead button that silently does nothing is worse than a grayed one.
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
        drawToCanvas(msg.result, canvas, { scale: scaleFor(msg.result.size, 320), quiet: DEFAULT_QUIET, ...colors() });
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
  drawEditable(selected, els.bigCanvas, { scale, quiet: DEFAULT_QUIET, ...colors() });
  els.contrastWarn.hidden = contrastRatio(els.dark.value, els.light.value) >= 3;
}

// Warns on inverted *and* merely weak pairings; both defeat a binariser.
function contrastRatio(darkHex, lightHex) {
  const d = luminance(darkHex), l = luminance(lightHex);
  if (d >= l) return 0; // inverted: dark modules must be the darker color
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
  const svg = toSVG(selected, { scale: Number(els.scale.value), quiet: DEFAULT_QUIET, ...colors() });
  saveBlob(svgBlob(svg), `${filenameFor(selected)}.svg`);
});

els.dlPng.addEventListener('click', async () => {
  if (!selected) return;
  const canvas = document.createElement('canvas');
  drawToCanvas(selected, canvas, { scale: Number(els.scale.value), quiet: DEFAULT_QUIET, ...colors() });
  saveBlob(await canvasToPngBlob(canvas), `${filenameFor(selected)}.png`);
});

els.scale.addEventListener('input', redrawBig);
els.dark.addEventListener('input', () => { redrawBig(); repaintGallery(); });
els.light.addEventListener('input', () => { redrawBig(); repaintGallery(); });

const painted = new Map();
function repaintGallery() {
  for (const [canvas, r] of painted) {
    drawToCanvas(r, canvas, { scale: scaleFor(r.size, 320), quiet: DEFAULT_QUIET, ...colors() });
  }
}

// ----------------------------------------------------------------- generate

els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  run();
});

function run() {
  const opts = readOptions();
  if (!opts.payload) { setStatus('Fill in the field above first.', true); return; }
  if (!opts.label) { setStatus('Nothing to write inside the code.', true); return; }

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
        ? `${fitted} variants in ${Math.round(performance.now() - started)} ms.`
        : 'Nothing fits. Try a lower error-correction level, more lines, or less clearance.', !fitted);
    }
  });
}

function setStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.classList.toggle('error', isError);
}

// ------------------------------------------------------------------ install

// "Progressive web app" means nothing to most people, so this says what
// installing actually gets you and how to do it here. Chrome and Edge offer a
// real prompt, which is exact; everywhere else the best available is a short
// instruction, and iOS in particular never prompts at all.
(() => {
  const section = document.getElementById('install');
  const how = document.getElementById('installHow');
  const button = document.getElementById('installGo');

  if (isInstalled({
    standaloneDisplay: matchMedia('(display-mode: standalone)').matches
      || matchMedia('(display-mode: window-controls-overlay)').matches,
    iosStandalone: navigator.standalone === true,
  })) return;

  how.textContent = installHint(navigator);
  section.hidden = false;

  // Chrome and Edge tell us when the app genuinely qualifies; prefer their
  // prompt to any guess of ours.
  let deferred = null;
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferred = event;
    how.textContent = 'Your browser can install it directly:';
    button.hidden = false;
  });
  button.addEventListener('click', async () => {
    if (!deferred) return;
    button.disabled = true;
    deferred.prompt();
    const { outcome } = await deferred.userChoice;
    deferred = null;
    button.hidden = true;
    how.textContent = outcome === 'accepted'
      ? 'Installed. Look for QartText alongside your other apps.'
      : 'Not installed. You can install it later from the browser menu.';
  });
  window.addEventListener('appinstalled', () => { section.hidden = true; });
})();

// ------------------------------------------------------------------ offline

// Keep in step with BUILD in sw.js; shown in the footer so it is obvious which
// version is loaded when something looks out of date.
const BUILD = '2026-08-21.5';
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
