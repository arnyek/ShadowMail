// SPDX-License-Identifier: GPL-3.0-or-later
// Header fields sent as raw 8-bit bytes, without RFC 2047 encoding. Some web form mailers (old PHP) write the subject
// and the sender's name in the body's charset straight into the header ("Subject: \xc1rv\xedzt\xfbr\xf5"); read as UTF-8 every
// such byte turns into U+FFFD. The big clients decode them as follows, and so does this module: a raw field that is valid
// UTF-8 stays UTF-8; any other raw field is decoded with the charset of the message's top-level Content-Type, or with
// windows-1250 (the Hungarian Windows code page) when that is missing or unusable. The result is the same message with
// those fields rewritten as UTF-8 bytes, so mailparser (encoded words, address lists) reads it like any other.
// Only the top-level header block is touched; the body and the parts' own headers stay byte for byte.

const utf8 = new TextDecoder('utf-8', { fatal: true })
const FALLBACK = 'windows-1250'
// the end of the header block is looked for this far; a block longer than this is left alone
const HEADER_LIMIT = 1024 * 1024
// labels that cannot be the charset of a raw 8-bit field: in the WHATWG table "us-ascii" is windows-1252 (it would turn a
// Hungarian ő into õ)
const UNUSABLE_LABELS = new Set(['us-ascii', 'ascii', 'ansi_x3.4-1968'])
// what the decoder resolves a label to, unusable here: UTF-8 already failed, and UTF-16 would read two bytes as one
// character, swallowing the line end and the next field ("ucs-2", "unicode", "unicodefffe" ... resolve to these)
const UNUSABLE_ENCODINGS = new Set(['utf-8', 'utf-16le', 'utf-16be'])

const has8bit = (buf, start, end) => {
  for (let i = start; i < end; i++) if (buf[i] >= 0x80) return true
  return false
}

const validUtf8 = bytes => {
  try {
    utf8.decode(bytes)
    return true
  } catch {
    return false
  }
}

/** The offset where the header block ends (its blank line excluded), or -1 when no blank line is found in the limit. */
export function headerEnd(buf) {
  const max = Math.min(buf.length, HEADER_LIMIT)
  for (let i = 0; i < max; i++) {
    if (buf[i] !== 0x0a) continue
    if (buf[i + 1] === 0x0a) return i + 1
    if (buf[i + 1] === 0x0d && buf[i + 2] === 0x0a) return i + 1
  }
  return buf.length <= HEADER_LIMIT ? buf.length : -1
}

/** Splits a header block into its fields, each with its folded continuation lines: [{ start, end }]. */
function fields(buf, end) {
  const out = []
  let start = 0
  for (let i = 0; i < end; i++) {
    if (buf[i] !== 0x0a) continue
    const next = buf[i + 1]
    if (i + 1 < end && (next === 0x20 || next === 0x09)) continue // a folded line belongs to this field
    out.push({ start, end: i + 1 })
    start = i + 1
  }
  if (start < end) out.push({ start, end })
  return out
}

/** The charset to decode raw 8-bit fields with: the top-level Content-Type's, when the decoder knows it, else windows-1250. */
export function headerCharset(block) {
  const text = block.toString('latin1').replace(/\r?\n[ \t]+/g, ' ')
  const ct = text.match(/^content-type:[^\n]*/im)
  const m = ct && ct[0].match(/;\s*charset\s*=\s*"?([^";\s]+)/i)
  const label = m ? m[1].trim().toLowerCase() : ''
  if (label && !UNUSABLE_LABELS.has(label)) {
    try {
      const encoding = new TextDecoder(label).encoding
      if (!UNUSABLE_ENCODINGS.has(encoding)) return encoding
    } catch {
      // unknown to the decoder (or "replacement"): the fallback
    }
  }
  return FALLBACK
}

/**
 * The message with every top-level header field that is raw 8-bit and not valid UTF-8 rewritten as UTF-8 (decoded with
 * headerCharset). The same Buffer when there is nothing to rewrite (the usual case: no 8-bit byte in the header block),
 * and for anything that is not a Buffer.
 */
export function utf8Headers(source) {
  if (!Buffer.isBuffer(source)) return source
  const end = headerEnd(source)
  if (end <= 0 || !has8bit(source, 0, end)) return source
  const list = fields(source, end)
  const bad = list.filter(f => has8bit(source, f.start, f.end) && !validUtf8(source.subarray(f.start, f.end)))
  if (!bad.length) return source
  const decoder = new TextDecoder(headerCharset(source.subarray(0, end)))
  const parts = []
  let at = 0
  for (const f of bad) {
    parts.push(source.subarray(at, f.start), Buffer.from(decoder.decode(source.subarray(f.start, f.end)), 'utf8'))
    at = f.end
  }
  parts.push(source.subarray(at))
  return Buffer.concat(parts)
}
