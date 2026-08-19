# human-readable-qr

QR codes with the domain name written legibly inside them, in a bitmap font —
and **without spending any of the error-correction redundancy**.

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

The whole technique rests on decoders stopping at the terminator and ignoring
the padding. Every ZXing-lineage reader does this, and the app pins the
terminator to `0000` so a decoder can never mistake the random padding for
another data segment.

That said, it is an assumption about other people's software. The app ships a
**Decoder check** panel that builds three codes — a control with conventional
padding, the same URL with random padding and no artwork, and the real thing —
so you can confirm the behaviour on the scanners you care about (iOS Camera,
Android's Google Lens) rather than take it on trust.

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
| Maximum lines | Whether long domains may wrap. Breaks are made at dots wherever possible. |
| Clearance | Modules of whitespace between the letterforms and the surrounding noise. Default 2. |
| Text override | Draw something other than the domain. |

Three fonts, all authored for this project, times three styles make the nine
variants. The fonts are `Micro 3×5` and `Pixel 5×7`, which hold a single case,
and `Mixed 5×8`, which has real upper and lower case with descenders. The
styles are:

- **Plate** — a light rectangle behind the text.
- **Halo** — clearance around the strokes only; ordinary noise beyond it.
- **Inverse** — a dark plate with light letters.

Whitespace is what makes the text readable, far more than the choice of font.
Clearance of 1 leaves the letterforms fighting the surrounding noise.

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

## Layout

```
index.html            the app shell
app.css  app.js       interface
worker.js             runs generation off the main thread
sw.js  manifest.webmanifest   offline shell
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

The icon is itself a human-readable QR code, generated by this codebase.

## Verification

The encoder was checked against the ISO/IEC 18004 reference vectors (block
capacities for all 40 versions, the four format-information strings, and the
Reed–Solomon codewords for the standard test message) and round-tripped through
an independent decoder that re-reads the rendered grid and confirms every
Reed–Solomon syndrome is zero — that is, the symbol is not merely readable but
carries its full, unspent correction capacity.

A sweep of 380 combinations (10 URLs × 4 correction levels × 3 fonts × 3 styles,
plus controls) decodes to the exact input URL with zero syndromes and zero
SVG/canvas mismatches. The downloaded PNG and SVG files themselves were read
back and decoded to confirm the exported artefacts, not just the in-memory grid.

Codes from this generator have been confirmed to scan correctly on real iOS and
Android camera apps.

## Credits

- Russ Cox, [QArt Codes](https://research.swtch.com/qart), for the construction.
- Departure Mono, PalmOS system fonts and similar pixel faces were the reference
  for the letterforms; the glyph tables here are original, drawn to the QR
  module grid.
