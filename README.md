## human-readable-qr

Generate human readable QR codes like https://research.swtch.com/qart, but instead of an image use the domain name from the URL rendered with bitmap font, e.g.,

* https://departuremono.com/
* https://github.com/urcades/pilot
* https://damieng.com/blog/2006/palmosfontavailable

The result should be a progressive Web app with no external dependencies that takes a URL and generates a QR code with a human readable URL inside, without using up any of the redundancy in QR encoding. Maybe several different options, downloadable as PNG or SVG.
