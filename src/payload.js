// What to encode, and what to draw, for each kind of code.
//
// Everything downstream takes a payload string and a label string and does not
// care where either came from, so a new kind of code is only these two
// functions -- the encoder, solver, placement and fonts are untouched.

import { normalizeUrl, domainOf } from './layout.js';

export const TYPES = [
  { id: 'url', name: 'URL' },
  { id: 'text', name: 'Text' },
  { id: 'email', name: 'Email' },
  { id: 'tel', name: 'Phone' },
  { id: 'wifi', name: 'Wi-Fi' },
  { id: 'mecard', name: 'Contact' },
];

export const WIFI_AUTH = [
  { id: 'WPA', name: 'WPA/WPA2/WPA3' },
  { id: 'WEP', name: 'WEP' },
  { id: 'nopass', name: 'None (open)' },
];

/**
 * In the WIFI: format, fields are separated by semicolons and values from keys
 * by colons, so those characters -- and the backslash that escapes them, the
 * comma, and the double quote -- have to be escaped inside a value. Getting
 * this wrong does not produce a broken code: it produces a code that scans
 * perfectly and silently joins the wrong network, or truncates the password at
 * the first semicolon.
 */
export function wifiEscape(value) {
  return String(value).replace(/([\\;,:"])/g, '\\$1');
}

/**
 * A value made only of hex digits can be read as hex rather than as text, so
 * it is wrapped in quotes to force the literal reading.
 */
function wifiValue(value) {
  const escaped = wifiEscape(value);
  return /^[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0 ? `"${escaped}"` : escaped;
}

/**
 * MECARD rather than vCard, because the payload is what this tool spends.
 * The same four fields come to 63 bytes as MECARD and 107 as vCard 3.0, and
 * at version 20 that is 531 immovable modules against 1099. Measured with the
 * same label at the same size, the MECARD code holds its letterforms exactly
 * at 99.5% plate where the vCard one drops to 96.8% and starts losing them --
 * and no version from 14 to 30 makes a full vCard clean. The cost is that
 * MECARD is read by iOS, Google Lens and the ZXing lineage rather than by
 * everything, and that it has no field for an employer: a job title belongs in
 * NOTE, which is bytes this format is trying not to spend.
 *
 * A semicolon ends a field and a comma divides a name, so those and the
 * backslash that escapes them are escaped inside a value. Getting it wrong
 * reads the same way the Wi-Fi case does: a code that scans perfectly and
 * hands over a truncated number, or a surname that swallowed the rest of the
 * card.
 *
 * The colon is deliberately left alone, though the format calls it special
 * too. It separates a key from its value and has no meaning after that, so
 * nothing needs it escaped -- and it is in every URL. Escaping it would put a
 * backslash in the common case and make every card with a website depend on
 * the reader unescaping correctly, where the other three only turn up in
 * unusual input.
 */
export function mecardEscape(value) {
  return String(value).replace(/([\\;,])/g, '\\$1');
}

/**
 * A mailto: address. RFC 6068 leaves `@` and ordinary mail punctuation alone,
 * so this encodes only what would otherwise start or split a header: an
 * unencoded `?` would begin the header section, `&` would start another
 * header, `#` a fragment, and a space would end the URI at some readers.
 */
function mailtoAddress(value) {
  return String(value).trim().replace(/[?&#\s]/g, c =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
}

/** Digits and a leading plus: what a dialler actually wants. */
export function telDigits(input) {
  const trimmed = String(input).trim();
  const plus = trimmed.startsWith('+') ? '+' : '';
  return plus + trimmed.replace(/[^0-9]/g, '');
}

/**
 * @returns {{payload: string, label: string, warning?: string}}
 *   payload: the exact bytes to encode. label: the text to draw inside.
 */
export function buildPayload(spec) {
  switch (spec.type) {
    case 'tel': {
      const digits = telDigits(spec.number ?? '');
      return {
        payload: digits ? `tel:${digits}` : '',
        // drawn as typed, punctuation and all; the payload keeps only what a
        // dialler needs, so the two differ on purpose
        label: String(spec.number ?? '').trim(),
      };
    }
    case 'wifi': {
      const ssid = String(spec.ssid ?? '').trim();
      const auth = WIFI_AUTH.some(a => a.id === spec.auth) ? spec.auth : 'WPA';
      const parts = [`T:${auth}`, `S:${wifiValue(ssid)}`];
      if (auth !== 'nopass' && spec.password) parts.push(`P:${wifiValue(spec.password)}`);
      if (spec.hidden) parts.push('H:true');
      return {
        payload: ssid ? `WIFI:${parts.join(';')};;` : '',
        label: ssid,
        warning: auth !== 'nopass' && spec.password
          ? 'This code carries the password in clear text. Anyone who scans or photographs it can join the network.'
          : undefined,
      };
    }
    case 'text': {
      // The payload and the label are the same string, which is as close to
      // the point of this whole tool as a kind gets: the code says what it
      // says, and there is no second version of it to drift out of step.
      // `plain`, not `text`: generate() already takes a `text` option and that
      // one is the label override, which is very nearly the opposite of this
      const plain = String(spec.plain ?? '').trim();
      return { payload: plain, label: plain };
    }
    case 'email': {
      const address = mailtoAddress(spec.address ?? '');
      // encodeURIComponent is stricter than RFC 6068 needs, which costs a few
      // bytes on punctuation and is the right way round to be wrong here
      const subject = String(spec.subject ?? '').trim();
      const query = subject ? `?subject=${encodeURIComponent(subject)}` : '';
      return {
        payload: address ? `mailto:${address}${query}` : '',
        // the address itself, not its domain: the address is the part a
        // reader would want to check before writing to it
        label: String(spec.address ?? '').trim(),
      };
    }
    case 'mecard': {
      const given = String(spec.given ?? '').trim();
      const family = String(spec.family ?? '').trim();
      // MECARD's N is family, comma, given. With only a given name the comma
      // has to stay, or a reader takes the one name it finds as the surname:
      // the drawn code looks right and the imported contact is filed wrong.
      const name = given
        ? `${mecardEscape(family)},${mecardEscape(given)}`
        : mecardEscape(family);
      const tel = telDigits(spec.number ?? '');
      const email = String(spec.email ?? '').trim();
      const site = String(spec.site ?? '').trim();
      const parts = [];
      if (name) parts.push(`N:${name}`);
      if (tel) parts.push(`TEL:${mecardEscape(tel)}`);
      if (email) parts.push(`EMAIL:${mecardEscape(email)}`);
      if (site) parts.push(`URL:${mecardEscape(normalizeUrl(site))}`);
      const payload = parts.length ? `MECARD:${parts.join(';')};;` : '';
      const bytes = new TextEncoder().encode(payload).length;
      return {
        payload,
        // the name as written, which is the whole appeal of a contact code
        label: [given, family].filter(Boolean).join(' '),
        // Bytes buy symbol size here, not stuck letterforms: a card this
        // long still solves cleanly, it just has to be printed large. Name
        // and number land near 28 mm, all five fields near 65 mm.
        warning: bytes > 90
          ? `This card is ${bytes} bytes, and every field is payload the symbol has to carry. A name and a number print at about 28 mm; fill in everything and it is nearer 65 mm. Drop a field if the code has to be small.`
          : undefined,
      };
    }
    default: {
      const payload = normalizeUrl(spec.url ?? '');
      return { payload, label: domainOf(payload) };
    }
  }
}
