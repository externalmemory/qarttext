# QArtText

QR codes with what they point at written legibly inside them (a domain name,
a phone number, a network, a person, or any text you like) in a bitmap font,
and **without spending any of the error-correction redundancy**.

Named for Russ Cox's [QArt codes](https://research.swtch.com/qart), the
construction it is built on, with text in place of the picture.

Live app: open `index.html` from any static web server or go to
[qarttext.pages.dev](https://qarttext.pages.dev/). It is a progressive web
app with no external dependencies, no build step, and no network calls.

```
python3 -m http.server 8000     # then visit http://localhost:8000/
```

![a QR code reading QArtText, which scans to this project's own site](examples/qarttext-v11-l-lower-plate.png)

For technical details, see [qarttext.md](qarttext.md).

## Credits

- Russ Cox, [QArt Codes](https://research.swtch.com/qart), for the construction.

- Maurycy Zarzycki, [mcufont](https://maurycyz.com/projects/mcufont/) (CC0),
  for the letters, digits and nine punctuation marks of `Compact 5×5`. Its own
  ancestor is lcamtuf's `font-inline.h`. The remaining twenty-four punctuation
  glyphs of that face are drawn here to match it.

The `Micro 3×5` and `Mixed 5×8` tables are original, drawn to the QR module
grid. These are the faces they are modeled on:

- [Departure Mono](https://departuremono.com/)
- [urcades/pilot](https://github.com/urcades/pilot)
- [PalmOS system fonts](https://damieng.com/typography/palmos-font/)

