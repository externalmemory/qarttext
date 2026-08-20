# QartText

QR codes with the domain name written legibly inside them, in a bitmap font —
and **without spending any of the error-correction redundancy**.

Named for Russ Cox's [QArt codes](https://research.swtch.com/qart), the
construction it is built on, with type in place of the picture.

Live app: open `index.html` from any static web server. It is a progressive web
app with no external dependencies, no build step, and no network calls.

```
python3 -m http.server 8000     # then visit http://localhost:8000/
```

![the app icon, which is itself a human-readable QR code](icons/icon-512.png)

## What it does

You give it a URL. It gives you nine treatments of that URL as a QR code, each
with the domain name rendered in the middle of the symbol, and lets you download
whichever you prefer as PNG or SVG.

Every code it produces is a **fully valid QR symbol with its error correction
completely intact**. Nothing is painted over the top and no damage is
introduced, so the entire correction budget remains available for real-world
wear: creases, dirt, glare, bad printing.

## How it works

This is Russ Cox's [QArt](https://research.swtch.com/qart) construction, with
type as the artwork instead of an image.

The trick is that a QR code is a linear object:

- Reed–Solomon encoding is linear over GF(256);
- splitting into blocks and interleaving them is a permutation;
- the mask is a fixed XOR.

Compose those and the map from **data bits** to **module colours** is affine
over GF(2).

The URL occupies the first few hundred data bits: a 4-bit mode indicator, a
length field, the bytes themselves, then a 4-bit terminator. Everything after
that terminator is padding, and a conforming decoder never looks at it — it
reads exactly the declared number of bytes and stops. So every padding bit is a
free variable.

Write one matrix column per free bit and one row per module you want to control,
then run Gauss–Jordan elimination over GF(2). The solution is a genuine codeword
that simultaneously spells out the URL and paints the picture.

Cox bought his free bits by appending junk to the URL. Taking them from the
padding instead leaves the URL **byte-for-byte identical** to what you typed.

### The one assumption

The technique rests on decoders stopping at the terminator and ignoring the
padding. Every ZXing-lineage reader does this, and the app pins the terminator
to `0000` so a decoder can never mistake the random padding for another data
segment.

Codes from this generator have been confirmed to scan correctly on real iOS and
Android camera apps.

### What it cannot do

Where a module happens to carry a bit of the URL itself, it cannot be moved;
those pixels come out wherever the URL puts them. The app reports the count as
*fidelity*, searches symbol sizes and vertical positions to minimise it, and
always protects the letterforms ahead of the plate behind them. At levels L and
M the letterforms are typically exact. At level H, where free bits are scarce,
expect a handful of stuck pixels — the card tells you how many before you pick it.

Clearance interacts with this: a smaller clearance lets the text fit in a
smaller symbol, and a smaller symbol has fewer free bits. Raising clearance
often costs you a larger code but buys back fidelity.

## Options

| Control | Effect |
| --- | --- |
| Error correction | `L` leaves the most room for artwork, `H` the least. `M` is a good default. |
| Maximum lines | How many lines a long domain may wrap onto. Breaks are taken after a dot or a hyphen. |
| Clearance | Rings of whitespace between the letterforms and the surrounding noise. Half steps allowed. Default 2. |
| Text override | Draw something other than the domain. |

Three fonts, all authored for this project, times four styles make the twelve
variants, laid out as a grid with fonts named across the top and styles running
down. The styles are not labelled: plate against halo, and upright against
inverted, are plain from the pictures, and on a phone a column of labels costs
more width than the codes. Each card carries its own name for a screen reader
or a hover instead. The fonts are
`Micro 3×5` and `Pixel 5×7`, which hold a single case, and `Mixed 5×8`, which
has real upper and lower case with descenders. The styles cross two choices —
how far the forced region extends, and which way round the letters run:

|  | upright | inverted |
| --- | --- | --- |
| **Plate** — a filled rectangle behind the text | light plate, dark letters | dark plate, light letters |
| **Halo** — clearance around the strokes only, noise beyond | light clearance, dark letters | dark clearance, light letters |

Whitespace is what makes the text readable, far more than the choice of font.
Clearance of 1 leaves the letterforms fighting the surrounding noise.

Clearance takes half steps. A clearance of 2½ means two rings cleared
completely and a third cleared only in part: an ordered 4×4 Bayer threshold
picks half the modules of that outer ring to force light and leaves the rest to
whatever the solver puts there. The edge then fades into the surrounding noise
instead of stopping dead, and the partial ring costs about half the forced
modules of a whole one — roughly 8% fewer across the whole layout, which
matters when free bits are scarce.

It buys texture, not space: the box still extends by the full outer ring, so 2½
occupies what 3 would. Compared against 3 it is close to free; compared against
2 it costs a ring.

Glyph widths are trimmed to their ink, so the one module of tracking between
letters is the *only* gap. Left in, a blank edge column inside a glyph cell
would add a second module of space after that letter alone — which is what made
the gap between `r` and `g` in `dimview.org` wider than every other gap.

Line breaks are taken after a dot or a hyphen, both of which stay at the end of
the line where they read as deliberate. Hyphens matter more than they look:
without them a label such as `constructive-calculator.` is a single indivisible
chunk, so no arrangement narrower than that chunk exists at *any* line count and
the only way to fit the text is a much larger symbol. Allowing hyphen breaks
took `constructive-calculator.dimview.org` at three lines from a 137-module
symbol down to 89.

Text is drawn in **whatever case you type**. The label keeps the case of the
host as entered — `DepartureMono.com` stays mixed — which means the host is
pulled out of the string by hand, since `new URL().hostname` is lower-cased by
the URL specification. Nothing forces case anywhere: a single-case font simply
has no glyph for the other case, so the lookup falls back to the one it does
have.

## Symbol size

There is deliberately no control for this, because there is no fixed ceiling to
expose. Phone cameras do not impose a maximum QR version: a version 40 symbol
reads perfectly well if it is printed large enough, and a version 10 symbol
fails if printed too small. What is bounded is the width of a *single module*,
not the number of them.

So the app searches for the smallest symbol whose letterforms come out exact
and whose plate is clean, and reports the width that code needs to be printed.
The millimetre figures assume 0.4 mm per module, a commonly cited rule of thumb
for phone cameras at arm's length rather than a specification — give a code more
room if it will be read in poor light, at a distance, or off a low-resolution
screen.

The search is bounded two ways. Every forced module needs a free bit, so any
version with fewer than 1.5 free bits per forced module is rejected without
paying for the elimination; that check costs nothing next to a solve and stops
the budget being spent on sizes that were never going to work. Beyond that the
search stops after twelve workable sizes, or as soon as one has exact
letterforms and a plate above 98.5%.

Note that fidelity is *not* monotonic in version — a larger symbol is usually
but not always cleaner — so the search cannot simply stop at the first
improvement.

## Placement

Where the text sits is a real degree of freedom, and the app searches both axes
for the best spot rather than simply centring.

The scoring rule is that **a module we cannot control only costs us when its
fixed value disagrees with what we want.** Function patterns have known values,
so this lets the text settle where the symbol's own structure already happens to
be right: a full stop landing on the dark centre of an alignment pattern is
free, a stroke crossing the dark modules of the timing line is free, and the
light ring inside an alignment pattern can serve as part of the clearance.

Measured over 72 layouts, modules where the text overlaps a function pattern
come out correct 61% of the time, against the ~50% that chance alone would give
— the placement search really is exploiting the structure. Switching from the
old rule (any uncontrollable module is a cost), together with letting the
symbol-size search run to where it is actually useful, cut the number of
variants with any stuck letterform from 93 in 380 to 16 in 380, and lifted the
worst plate fidelity from 87.6% to 95.7%.

The detail panel exposes a nudge pad if you want to place the text by hand;
each nudge re-solves from scratch, and directions with no room are greyed out.

## Editing by hand

The large preview is editable. Click any module and it flips; the solver then
re-runs and rebuilds everything else around it, so the result is still a valid
codeword with its error correction untouched. Hand-set modules outrank the
letterforms in the priority ladder, so a click always wins — what gives way is
the plate behind it.

The preview is colour-coded to show what a click can do:

| | dark | light |
| --- | --- | --- |
| **fixed** — function patterns, and modules carrying bits of the URL itself | black | white |
| **free** — anything the solver can move | dark grey | light grey |

Clicking a fixed module is refused rather than silently ignored. The greys are
a guide for editing only: the gallery images and the exported PNG and SVG are
strictly black and white.

### Rotation: measured, and rejected

Readers establish orientation from the finder patterns, so a symbol can be
turned through any quarter turn and still scan. That looks like four more
degrees of freedom, and one metric says it should pay handsomely: because the
zig-zag lays out codewords in column pairs, the payload's immovable modules
cluster into columns, and a text band turned to run the other way meets **two
to three times fewer of them, often none at all** (0 against 16–31 in direct
measurement).

It makes the output worse. Across the 380-case sweep, searching all four
orientations raised the number of variants with a stuck letterform from 16 to
43, and dropped worst-case plate fidelity from 95.7% to 91.5%.

The reason is that the count of immovable modules is not the binding
constraint. Reed–Solomon blocks are *independent* — a block's error-correction
codewords are a function of that block's data and nothing else — so a target
module can only be steered by free bits belonging to its own block. A band
lying **along** the placement path touches few codewords and concentrates its
demand on a handful of blocks, exhausting their freedom, even though it covers
almost no immovable modules. A band lying **across** the path spreads the same
demand over every block. Measuring per-block shortfall instead of immovable
modules predicts the outcome well, and it says an upright band wins.

Quarter and half turns are therefore not searched. Half turns (0 and 180
degrees) keep the band across the path and are genuinely competitive, but the
difference is small and inconsistent — better on one version, worse on the
next — and it costs a second full elimination per symbol size to find out which.
The version search already covers that ground more cheaply.

## Layout

```
index.html            the app shell
app.css  app.js       interface
worker.js             runs generation off the main thread
sw.js  manifest.webmanifest   offline shell (network-first)
src/qr.js             GF(256), Reed–Solomon, version and block tables
src/matrix.js         function patterns, placement order, masks, penalty
src/encode.js         byte-mode payload, interleaving, module placement
src/qart.js           the GF(2) solver — the heart of it
src/fonts.js          bitmap fonts
src/layout.js         URL to label, wrapping, target selection
src/generate.js       version search and mask choice
src/variants.js       the gallery
src/render.js         SVG and PNG output
scripts/make-icons.mjs  builds the icons using the app's own encoder
```

The icon is itself a working, scannable code for the live site, generated by
this codebase and verified to decode to `https://qarttext.pages.dev/`. The
favicon is separate and is letterforms only: at 16 px a QR code gets about a
quarter of a pixel per module, so no code of any size is legible there.

## Deploying

Published on Cloudflare Pages as `qarttext.pages.dev`. The Pages project name
is independent of this repository's name — it is a separate field when the
project is created — but note that **the `.pages.dev` subdomain cannot be
changed afterwards.** Renaming the project in Settings does not move it; the
only way to a different hostname is to delete the project and create another.
So the name has to be right at creation.

`_headers` sets `Cache-Control: no-cache` on everything, which means revalidate
rather than do not store: the browser keeps its copy and gets a 304 when
nothing changed, so a deploy is live on the next load. GitHub Pages was the
alternative, but it serves a fixed `max-age=600` that cannot be overridden,
which would leave the service worker handing out assets up to ten minutes old.

The same file sets a content security policy. It allows only same-origin
scripts, styles and workers, `data:` and `blob:` images for the canvas exports,
and nothing else — no framing, no object embeds, no base-URI rewriting. The app
makes no network calls, so nothing needs relaxing.

## Updating

The service worker is deliberately **network-first**, falling back to the cache
only when offline. A cache-first worker with a background refresh shows the
*previous* deploy on the first load after a change, and can pair fresh markup
with a stale script — which fails in confusing ways. The footer shows the build
string, so it is always clear which version is actually loaded.

If a browser is still holding an older, cache-first worker, it takes two
reloads to come across: the first is served from the old cache while the new
worker installs, the second gets the new build. A hard reload does it in one.
Bump `BUILD` in both `sw.js` and `app.js` when the shell changes.

## Verification

The encoder was checked against the ISO/IEC 18004 reference vectors (block
capacities for all 40 versions, the four format-information strings, and the
Reed–Solomon codewords for the standard test message) and round-tripped through
an independent decoder that re-reads the rendered grid and confirms every
Reed–Solomon syndrome is zero — that is, the symbol is not merely readable but
carries its full, unspent correction capacity.

A sweep of 600 combinations (12 URLs × 4 correction levels × 3 fonts × 4 styles) decodes to the exact input URL with zero syndromes and zero
SVG/canvas mismatches. The downloaded PNG and SVG files themselves were read
back and decoded to confirm the exported artefacts, not just the in-memory grid.

## Credits

- Russ Cox, [QArt Codes](https://research.swtch.com/qart), for the construction.

Reference faces for the letterforms. The glyph tables in `src/fonts.js` are
original, drawn to the QR module grid, but these are what they are modelled on:

- [Departure Mono](https://departuremono.com/)
- [urcades/pilot](https://github.com/urcades/pilot)
- [PalmOS system fonts](https://damieng.com/blog/palmosfontavailable)
