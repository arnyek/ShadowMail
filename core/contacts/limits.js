// SPDX-License-Identifier: GPL-3.0-or-later
// Limits of a contacts import file. Pure: no I/O, no network.
// Over MAX_BYTES or MAX_CARDS the whole file is refused (too_large / too_many); a line (vCard) or a row (CSV) over
// MAX_LINE makes only its own contact faulty, the rest goes on.
export const IMPORT_LIMITS = Object.freeze({ maxBytes: 10 * 1024 * 1024, maxCards: 10_000, maxLine: 64 * 1024 })

export class ContactsFileError extends Error {
  constructor(code) {
    super(code)
    this.name = 'ContactsFileError'
    this.code = code
  }
}

/** Byte length of the input (a Buffer/Uint8Array or a string, counted as UTF-8). */
export function byteLength(input) {
  if (typeof input === 'string') return Buffer.byteLength(input, 'utf8')
  if (input instanceof Uint8Array) return input.byteLength
  throw new ContactsFileError('bad_input')
}

const utf8 = new TextDecoder('utf-8', { fatal: true })
const cp1250 = new TextDecoder('windows-1250')

/** Bytes to text: UTF-8 when it is valid, otherwise Windows-1250 (the Hungarian Windows code page). */
export function decodeAuto(bytes) {
  try {
    return { text: utf8.decode(bytes), charset: 'utf-8' }
  } catch {
    return { text: cp1250.decode(bytes), charset: 'windows-1250' }
  }
}

/** Bytes to text in a named charset; an unknown or unsupported name falls back to decodeAuto. */
export function decodeCharset(bytes, charset) {
  if (charset) {
    let dec
    try {
      dec = new TextDecoder(charset.trim().toLowerCase())
    } catch {
      dec = null // unknown label: RangeError
    }
    if (dec) return dec.decode(bytes)
  }
  return decodeAuto(bytes).text
}

/** Phone and e-mail labels as one lower-case token (letters, digits, '-'), at most 50 characters; empty -> null. */
export function cleanLabel(v) {
  if (typeof v !== 'string') return null
  const t = v.toLowerCase().replace(/[^\p{L}\p{N}-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 50)
  return t || null
}
