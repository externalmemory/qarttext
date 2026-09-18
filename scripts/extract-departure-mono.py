#!/usr/bin/env python3
"""Writes src/departure.js from the Departure Mono font file.

    pip install fonttools
    python3 scripts/extract-departure-mono.py DepartureMono-1.500/

The argument is the unzipped release directory, which has to hold both the
font and its LICENSE: the licence is copied from there into the generated
file rather than written out here, so it cannot drift from the one the font
actually ships under.

Departure Mono is a pixel font distributed as outlines: every contour vertex
sits on a 50-unit grid, one pixel per 50 units. So the bitmap is read off
exactly -- sample each pixel centre with the nonzero winding rule -- rather
than rasterised at some size and hoped about. The script refuses a vertex off
that grid, since that would mean the premise no longer holds.

Rows run from the cap line (row 7) down to the bottom of the descenders
(row -2), ten rows, with anything drawn above the cap line kept as extra rows
on top: the table format's overhang. Each glyph is written out at its full
seven-pixel cell and compile() trims it to its ink, like every other face.

Source: https://github.com/rektdeckard/departure-mono, release v1.500.

The font is under the SIL Open Font License 1.1, which this repository's MIT
licence does not replace. A table extracted from it is a Modified Version in
the OFL's own terms ("porting the Font Software to a new environment"), so the
generated file carries the copyright notice and the whole licence as its
header, and stays under the OFL. Codes drawn with it are documents created
using the font, which the OFL leaves free.
"""
import os
import sys
from fontTools.ttLib import TTFont
from fontTools.pens.recordingPen import DecomposingRecordingPen

UNIT, CAP, BOTTOM = 50, 7, -2
CHARS = ([chr(c) for c in range(0x20, 0x7f)]
         + list('абвгдеёжзийклмнопрстуфхцчшщъыьэюя')
         + list('АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ')
         + list('ҐЄІЇЎґєіїў'))
SPACE_WIDTH = 3   # the space has no ink to trim to, so it gets a width of its own

def polygons(glyphset, name):
    pen = DecomposingRecordingPen(glyphset)
    glyphset[name].draw(pen)
    polys, cur = [], []
    for op, args in pen.value:
        if op == 'moveTo':
            cur = [args[0]]
        elif op == 'lineTo':
            cur.append(args[0])
        elif op in ('curveTo', 'qCurveTo'):
            raise SystemExit(f'{name}: curves in a pixel font')
        elif op in ('closePath', 'endPath'):
            if cur:
                polys.append(cur)
            cur = []
    return polys


def inside(polys, x, y):
    winding = 0
    for poly in polys:
        for i, (x1, y1) in enumerate(poly):
            x2, y2 = poly[(i + 1) % len(poly)]
            cross = (x2 - x1) * (y - y1) - (x - x1) * (y2 - y1)
            if y1 <= y < y2 and cross > 0:
                winding += 1
            elif y2 <= y < y1 and cross < 0:
                winding -= 1
    return winding != 0


def key(ch):
    if ch.isalnum():
        return ch
    return "'" + ch.replace('\\', '\\\\').replace("'", "\\'") + "'"


def main(release):
    font = TTFont(os.path.join(release, 'DepartureMono-Regular.otf'))
    licence = open(os.path.join(release, 'LICENSE'), encoding='utf-8').read().strip()
    if 'SIL Open Font License, Version 1.1' not in licence:
        raise SystemExit('LICENSE is not the OFL 1.1 this script was written against')
    glyphset, cmap = font.getGlyphSet(), font.getBestCmap()
    lines = []
    for ch in CHARS:
        name = cmap.get(ord(ch))
        if name is None:
            raise SystemExit(f'{ch!r} is not in the font')
        polys = polygons(glyphset, name)
        for poly in polys:
            for x, y in poly:
                if x % UNIT or y % UNIT:
                    raise SystemExit(f'{ch!r}: vertex ({x},{y}) is off the {UNIT}-unit grid')
        advance = font['hmtx'][name][0] // UNIT
        on = {(px, py) for py in range(BOTTOM - 2, CAP + 6) for px in range(advance)
              if inside(polys, px * UNIT + UNIT / 2, py * UNIT + UNIT / 2)}
        if any(py < BOTTOM for _, py in on):
            raise SystemExit(f'{ch!r} drops below row {BOTTOM}')
        if not on:
            rows = ['.' * SPACE_WIDTH] * (CAP - BOTTOM + 1)
        else:
            top = max(CAP, max(py for _, py in on))
            rows = [''.join('#' if (px, py) in on else '.' for px in range(advance))
                    for py in range(top, BOTTOM - 1, -1)]
        lines.append('  %s: [%s],' % (key(ch), ', '.join("'%s'" % r for r in rows)))

    notice = '\n'.join(('// ' + l).rstrip() for l in licence.split('\n'))
    out = f"""// Departure Mono, read off the font file by scripts/extract-departure-mono.py.
// Generated; edit the script rather than this table.
//
// THIS FILE IS NOT UNDER THIS REPOSITORY'S MIT LICENCE. It is a Modified
// Version of the Departure Mono font software, ported to a JavaScript table,
// and is distributed under the SIL Open Font License 1.1, reproduced in full
// below as that licence requires. Codes drawn with it are documents created
// using the font and are not bound by it.
//
{notice}

export const DEPARTURE_HEIGHT = {CAP - BOTTOM + 1};

export const DEPARTURE = {{
{chr(10).join(lines)}
}};
"""
    open('src/departure.js', 'w', encoding='utf-8').write(out)
    print(f'src/departure.js: {len(lines)} glyphs')


if __name__ == '__main__':
    main(sys.argv[1])
