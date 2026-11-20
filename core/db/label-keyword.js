// SPDX-License-Identifier: GPL-3.0-or-later
// The IMAP keyword a label is stored as on the server. A label's name can not be a keyword itself (a keyword is an
// atom: no space, no accent, none of ( ) { % * " \ ]), so every label gets one when it is made, and it never changes
// after (a rename keeps it: the messages on the server carry the old one).
//
//   the name, NFC and lower case, byte by byte in UTF-8: a-z, 0-9 and ! # ' + , - . / : ? @ ^ _ | ~ stay, every other
//   byte (space, = and the other specials, controls, every byte of a non-ASCII letter) becomes "=xx" (lower-case hex);
//   longer than 50: the first at most 41 characters in whole units (an "=xx" is not cut) + "_" + the first 8 hex of
//   sha256(the NFC name); taken (in lower case) or one of the server's own words: "_2", "_3"... within the 50.
import crypto from 'node:crypto'

export const KEYWORD_MAX = 50
const HEAD_MAX = 41
// keywords a server or another client gives a meaning of its own (RFC 5788 registry and the common clients)
export const RESERVED_KEYWORDS = new Set(['junk', 'nonjunk', 'notjunk', 'forwarded', 'mdnsent', 'phishing', 'submitted', 'submitpending'])
const KEEP = new Set("abcdefghijklmnopqrstuvwxyz0123456789!#'+,-./:?@^_|~")

// the name as units: a kept character or one "=xx" per byte
function unitsOf(name) {
  const units = []
  for (const byte of Buffer.from(name.normalize('NFC').toLowerCase(), 'utf8')) {
    const ch = String.fromCharCode(byte)
    units.push(byte < 0x80 && KEEP.has(ch) ? ch : `=${byte.toString(16).padStart(2, '0')}`)
  }
  return units
}

// the longest run of whole units from the start that is at most `max` characters long
function headOf(units, max) {
  let out = ''
  for (const u of units) {
    if (out.length + u.length > max) break
    out += u
  }
  return out
}

/**
 * The keyword for a new label of this name. `taken`: the keywords already in use (any iterable; compared in lower case).
 * The result is lower case, at most 50 characters, only [a-z0-9=_!#'+,./:?@^|~-], and neither taken nor reserved.
 */
export function labelKeyword(name, taken = []) {
  const used = new Set([...taken].map(k => String(k).toLowerCase()))
  const units = unitsOf(name)
  let base = units.join('')
  if (base.length > KEYWORD_MAX) {
    const hash = crypto.createHash('sha256').update(name.normalize('NFC'), 'utf8').digest('hex').slice(0, 8)
    base = `${headOf(units, HEAD_MAX)}_${hash}`
  }
  const free = k => !used.has(k) && !RESERVED_KEYWORDS.has(k)
  if (free(base)) return base
  // the base is whole units (or ends in the hash), so it is cut by units to make room for the suffix
  const baseUnits = base.match(/=[0-9a-f]{2}|./g)
  for (let n = 2; ; n++) {
    const suffix = `_${n}`
    const k = headOf(baseUnits, KEYWORD_MAX - suffix.length) + suffix
    if (free(k)) return k
  }
}
