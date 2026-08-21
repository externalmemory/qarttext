// What to encode, and what to draw, for each kind of code.
//
// Everything downstream takes a payload string and a label string and does not
// care where either came from, so a new kind of code is only these two
// functions -- the encoder, solver, placement and fonts are untouched.

import { normaliseUrl, domainOf } from './layout.js';

export const TYPES = [
  { id: 'url', name: 'URL' },
  { id: 'tel', name: 'Phone' },
  { id: 'wifi', name: 'Wi-Fi' },
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

/** Digits and a leading plus: what a dialler actually wants. */
export function telDigits(input) {
  const trimmed = String(input).trim();
  const plus = trimmed.startsWith('+') ? '+' : '';
  return plus + trimmed.replace(/[^0-9]/g, '');
}

/**
 * @returns {{payload: string, label: string, warning?: string}}
 *   payload — the exact bytes to encode; label — the text to draw inside.
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
    default: {
      const payload = normaliseUrl(spec.url ?? '');
      return { payload, label: domainOf(payload) };
    }
  }
}
