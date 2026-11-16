// SPDX-License-Identifier: GPL-3.0-or-later
// vCard reader (2.1, 3.0, 4.0) and writer (3.0) for the address book (since 0.12.0).
// Pure: no I/O, no network, no IPC. A URL in the file is never fetched: PHOTO, URL and every VALUE=uri
// line is dropped (a TEL;VALUE=uri:tel:... keeps its number).
//
// readVcards(input) -> { cards, errors }
//   input: the file's bytes (Buffer/Uint8Array) or a string. Over IMPORT_LIMITS.maxBytes: ContactsFileError('too_large');
//   over maxCards BEGIN:VCARD lines: ContactsFileError('too_many').
//   cards: { line, version, displayName, givenName, familyName, org, title, note, emails: [{ address, label, isPrimary }],
//            phones: [{ number, label }], vcardExtra } in file order; `line` is the BEGIN line (1-based).
//   errors: { line, code } for a contact that is not read: missing_end, missing_begin, line_too_long (a line, or a folded
//           line, over maxLine bytes). The other contacts are read. A 2.1 AGENT with an embedded vCard (AGENT: followed
//           by BEGIN:VCARD ... END:VCARD) is skipped as a whole; the outer contact is read.
// writeVcards(people) -> string: vCard 3.0, CRLF, lines folded at 75 bytes (a UTF-8 character is never cut), the
//   vcardExtra lines written back unchanged. The N line: the reader keeps the original N in
//   vcardExtra too; the writer writes exactly one N, its family and given name from the person's fields (an edit wins),
//   the middle name, prefix and suffix from that saved N; the saved N itself is not written again.
//
// The file is handled as bytes (a latin1 string, one char = one byte) until a value is decoded, because a 2.1 value may
// be QUOTED-PRINTABLE and in its own CHARSET. Without a CHARSET a value is UTF-8 if valid, otherwise Windows-1250.

import { IMPORT_LIMITS, ContactsFileError, byteLength, decodeCharset, cleanLabel } from './limits.js'

// lines that make the structure or are never kept
const STRUCTURAL = new Set(['BEGIN', 'END', 'VERSION'])
const DROPPED = new Set(['PHOTO', 'URL'])
const HANDLED = new Set(['FN', 'N', 'EMAIL', 'TEL', 'ORG', 'TITLE', 'NOTE'])
// TYPE values that are not a label
const EMAIL_NOT_LABEL = new Set(['internet', 'pref', 'x400', 'x-internet'])
const TEL_NOT_LABEL = new Set(['voice', 'pref'])
// 2.1 bare parameters that are an ENCODING, not a TYPE
const BARE_ENCODINGS = new Set(['QUOTED-PRINTABLE', 'BASE64', 'B', '8BIT', '7BIT'])

/** The file's bytes as a latin1 string (one char per byte). */
function asBinary(input) {
  if (typeof input === 'string') return Buffer.from(input, 'utf8').toString('latin1')
  return Buffer.from(input.buffer, input.byteOffset, input.byteLength).toString('latin1')
}

const isQpHead = head => /QUOTED-PRINTABLE/i.test(head)

/**
 * Physical lines -> logical lines: a line starting with a space or tab continues the previous one. In 3.0 / 4.0 (RFC 2425,
 * RFC 6350) the line break and that one space or tab are removed; in 2.1 (RFC 822 folding) only the line break, the space
 * or tab is part of the value. The version is the card's VERSION line seen so far (reset at
 * each BEGIN:VCARD); before it, or without it, the 3.0 rule. A QUOTED-PRINTABLE value ending in '=' continues on the next
 * line (soft line break). A logical line over maxLine bytes is returned as { tooLong: true } and not built further.
 */
function logicalLines(bin, maxLine) {
  const out = []
  const phys = bin.split('\n')
  let cur = null
  let v21 = false
  const flush = () => {
    if (cur) out.push(cur)
    cur = null
  }
  for (let i = 0; i < phys.length; i++) {
    let s = phys[i]
    if (s.endsWith('\r')) s = s.slice(0, -1)
    const lineNo = i + 1
    if (cur && (s.startsWith(' ') || s.startsWith('\t'))) {
      if (!cur.tooLong) {
        const part = v21 ? s : s.slice(1)
        if (cur.text.length + part.length > maxLine) cur = { line: cur.line, tooLong: true }
        else cur.text += part
      }
      continue
    }
    if (cur && !cur.tooLong && cur.qp && cur.text.endsWith('=') && s !== '' && !/^END:VCARD$/i.test(s.trim())) {
      if (cur.text.length + s.length - 1 > maxLine) cur = { line: cur.line, tooLong: true }
      else cur.text = cur.text.slice(0, -1) + s
      continue
    }
    flush()
    // an empty line ends the logical line and makes none (a run of millions stays cheap)
    if (s === '') continue
    if (s.length > maxLine) {
      cur = { line: lineNo, tooLong: true }
      continue
    }
    const colon = s.indexOf(':')
    if (/^BEGIN:VCARD\s*$/i.test(s)) v21 = false
    else if (/^VERSION:/i.test(s)) v21 = /^VERSION:\s*2\.1\s*$/i.test(s)
    cur = { line: lineNo, text: s, qp: colon > 0 && isQpHead(s.slice(0, colon)) }
  }
  flush()
  return out
}

/** One content line -> { group, name, params: Map(UPPER -> [values]), value, head } or null when it is not one. */
function parseContentLine(text) {
  let i = 0
  const n = text.length
  while (i < n && text[i] !== ';' && text[i] !== ':') i++
  if (i >= n) return null
  const fullName = text.slice(0, i)
  const dot = fullName.lastIndexOf('.')
  const group = dot >= 0 ? fullName.slice(0, dot) : null
  const name = (dot >= 0 ? fullName.slice(dot + 1) : fullName).toUpperCase()
  if (!/^[A-Z0-9-]+$/.test(name) || (group !== null && !/^[A-Za-z0-9-]+$/.test(group))) return null
  const params = new Map()
  const add = (k, v) => {
    if (!params.has(k)) params.set(k, [])
    params.get(k).push(v)
  }
  while (i < n && text[i] === ';') {
    i++
    let k = ''
    while (i < n && text[i] !== '=' && text[i] !== ';' && text[i] !== ':') k += text[i++]
    k = k.trim().toUpperCase()
    if (text[i] !== '=') {
      // 2.1 bare parameter: an encoding or a type
      if (k) add(BARE_ENCODINGS.has(k) ? 'ENCODING' : 'TYPE', k)
      continue
    }
    i++
    // one or more values, comma separated, each may be quoted
    for (;;) {
      let v = ''
      if (text[i] === '"') {
        i++
        while (i < n && text[i] !== '"') v += text[i++]
        i++
      } else {
        while (i < n && text[i] !== ',' && text[i] !== ';' && text[i] !== ':') v += text[i++]
      }
      if (k) add(k, v.trim())
      if (text[i] === ',') {
        i++
        continue
      }
      break
    }
  }
  if (text[i] !== ':') return null
  return { group, name, params, value: text.slice(i + 1), head: text.slice(0, i) }
}

const param = (prop, k) => (prop.params.get(k) || [])[0]
const types = prop => (prop.params.get('TYPE') || []).flatMap(t => t.split(',')).map(t => t.trim().toLowerCase()).filter(Boolean)

/** A QUOTED-PRINTABLE byte string -> bytes; a '=' not followed by two hex digits stays as it is. */
function qpDecode(bin) {
  const out = Buffer.allocUnsafe(bin.length)
  let o = 0
  for (let i = 0; i < bin.length; i++) {
    const c = bin.charCodeAt(i)
    if (c === 0x3d && i + 2 < bin.length && /^[0-9A-Fa-f]{2}$/.test(bin.slice(i + 1, i + 3))) {
      out[o++] = parseInt(bin.slice(i + 1, i + 3), 16)
      i += 2
    } else out[o++] = c & 0xff
  }
  return out.subarray(0, o)
}

/** The value of a property as text: QP / base64 undone, then the CHARSET (or UTF-8 / Windows-1250). Escapes stay. */
function decodeValue(prop) {
  const enc = (param(prop, 'ENCODING') || '').toUpperCase()
  let bytes
  if (enc === 'QUOTED-PRINTABLE') bytes = qpDecode(prop.value)
  else if (enc === 'B' || enc === 'BASE64') bytes = Buffer.from(prop.value.replace(/\s+/g, ''), 'base64')
  else bytes = Buffer.from(prop.value, 'latin1')
  return decodeCharset(bytes, param(prop, 'CHARSET'))
}

/** vCard text unescape: \n \N -> line break, \x -> x. */
const unescape = s => s.replace(/\\(.)/gs, (_, c) => (c === 'n' || c === 'N' ? '\n' : c))

/** Splits on the separator not preceded by a backslash; the parts stay escaped. */
function splitEscaped(s, sep) {
  const out = []
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '\\' && i + 1 < s.length) {
      cur += c + s[i + 1]
      i++
    } else if (c === sep) {
      out.push(cur)
      cur = ''
    } else cur += c
  }
  out.push(cur)
  return out
}

const trimOrNull = s => {
  const t = s.replace(/\r\n?/g, '\n').trim()
  return t || null
}

/** Whether a property is dropped (never kept, never fetched): PHOTO, URL, any VALUE=uri / VALUE=url. */
function isDropped(prop) {
  if (DROPPED.has(prop.name)) return true
  const v = (param(prop, 'VALUE') || '').toLowerCase()
  return v === 'uri' || v === 'url'
}

/** A kept, not handled line in its stored form: Unicode, unfolded, the value still escaped, one line. */
function extraLine(prop, version) {
  const enc = (param(prop, 'ENCODING') || '').toUpperCase()
  const binaryValue = enc === 'B' || enc === 'BASE64'
  let value = binaryValue ? prop.value : decodeValue(prop)
  value = value.replace(/\r\n|\r|\n/g, '\\n')
  const name = (prop.group ? prop.group + '.' : '') + prop.name
  if (version !== '2.1' && enc !== 'QUOTED-PRINTABLE' && !prop.params.has('CHARSET')) {
    // 3.0 / 4.0: the parameters as they were, only the bytes decoded
    return decodeCharset(Buffer.from(prop.head, 'latin1'), null) + ':' + value
  }
  // 2.1 (or a QP / CHARSET line): parameters rewritten in the 3.0 form, without ENCODING=QP and CHARSET
  let head = name
  for (const [k, vals] of prop.params) {
    if (k === 'CHARSET' || (k === 'ENCODING' && !binaryValue)) continue
    const vs = vals.map(v => (/[;:,]/.test(v) ? `"${v.replace(/"/g, '')}"` : v))
    head += `;${k}=${vs.join(',')}`
  }
  return head + ':' + value
}

/** One card's content lines -> the contact. */
function cardOf(lines, startLine) {
  const props = []
  let version = null
  for (const l of lines) {
    const p = parseContentLine(l)
    if (!p) continue
    if (p.name === 'VERSION') version = p.value.trim()
    props.push(p)
  }
  const card = {
    line: startLine,
    version: version || null,
    displayName: null,
    givenName: null,
    familyName: null,
    org: null,
    title: null,
    note: null,
    emails: [],
    phones: [],
    vcardExtra: null,
  }
  const extra = []
  const seen = new Set()
  let primaryTaken = false
  for (const p of props) {
    if (STRUCTURAL.has(p.name) || (isDropped(p) && p.name !== 'TEL')) continue
    if (!HANDLED.has(p.name)) {
      extra.push(extraLine(p, version))
      continue
    }
    if (p.name === 'EMAIL') {
      const address = unescape(decodeValue(p)).trim()
      if (!address) continue
      const ts = types(p)
      const pref = ts.includes('pref') || p.params.has('PREF')
      const label = cleanLabel(ts.filter(t => !EMAIL_NOT_LABEL.has(t))[0] || '')
      card.emails.push({ address, label, isPrimary: pref && !primaryTaken })
      if (pref) primaryTaken = true
      continue
    }
    if (p.name === 'TEL') {
      let number = unescape(decodeValue(p)).trim()
      const v = (param(p, 'VALUE') || '').toLowerCase()
      if (v === 'uri' || v === 'url') {
        // only a tel: URI is a number; anything else (http...) is dropped, never fetched
        if (!/^tel:/i.test(number)) continue
        number = number.slice(4).split(';')[0]
      }
      if (!number) continue
      const label = cleanLabel(types(p).filter(t => !TEL_NOT_LABEL.has(t))[0] || '')
      card.phones.push({ number, label })
      continue
    }
    // FN, N, ORG, TITLE, NOTE: the first is the field, a later one is kept as an extra line
    if (seen.has(p.name)) {
      extra.push(extraLine(p, version))
      continue
    }
    seen.add(p.name)
    const raw = decodeValue(p)
    if (p.name === 'FN') card.displayName = trimOrNull(unescape(raw))
    else if (p.name === 'N') {
      // the whole N stays too: its middle name, prefix and suffix go back on export
      extra.push(extraLine(p, version))
      const parts = splitEscaped(raw, ';').map(x => trimOrNull(unescape(x)))
      card.familyName = parts[0] ?? null
      card.givenName = parts[1] ?? null
    } else if (p.name === 'ORG') {
      card.org = trimOrNull(splitEscaped(raw, ';').map(x => unescape(x).trim()).filter(Boolean).join(', '))
    } else if (p.name === 'TITLE') card.title = trimOrNull(unescape(raw))
    else if (p.name === 'NOTE') card.note = trimOrNull(unescape(raw))
  }
  card.vcardExtra = extra.length ? extra.join('\r\n') : null
  return card
}

export function readVcards(input, limits = IMPORT_LIMITS) {
  if (byteLength(input) > limits.maxBytes) throw new ContactsFileError('too_large')
  const bin = asBinary(input)
  const cards = []
  const errors = []
  let open = null // { line, lines, bad, agentDepth }
  let stray = null // first content line outside a card
  let begins = 0
  for (const l of logicalLines(bin, limits.maxLine)) {
    if (open && open.agentDepth) {
      // inside a 2.1 AGENT's embedded vCard: skipped up to its own END
      const t = l.tooLong ? '' : l.text.trim()
      if (/^BEGIN:VCARD$/i.test(t)) {
        if (++begins > limits.maxCards) throw new ContactsFileError('too_many')
        open.agentDepth++
      } else if (/^END:VCARD$/i.test(t)) open.agentDepth--
      continue
    }
    if (!l.tooLong) {
      const t = l.text.trim()
      if (t === '') continue
      if (/^BEGIN:VCARD$/i.test(t)) {
        if (++begins > limits.maxCards) throw new ContactsFileError('too_many')
        if (open && !open.bad && /^(?:[A-Za-z0-9-]+\.)?AGENT(?:;[^:]*)?:\s*$/i.test(open.lines[open.lines.length - 1] || '')) {
          // AGENT: + an embedded vCard (2.1): the AGENT line and the embedded card are dropped, the outer card goes on
          open.lines.pop()
          open.agentDepth = 1
          continue
        }
        if (open) errors.push({ line: open.line, code: 'missing_end' })
        if (stray !== null) errors.push({ line: stray, code: 'missing_begin' })
        stray = null
        open = { line: l.line, lines: [], bad: null }
        continue
      }
      if (/^END:VCARD$/i.test(t)) {
        if (!open) {
          errors.push({ line: stray ?? l.line, code: 'missing_begin' })
          stray = null
          continue
        }
        if (open.bad) errors.push({ line: open.line, code: open.bad })
        else cards.push(cardOf(open.lines, open.line))
        open = null
        continue
      }
    }
    if (!open) {
      if (stray === null) stray = l.line
      continue
    }
    if (open.bad) continue
    if (l.tooLong) open.bad = 'line_too_long'
    else open.lines.push(l.text)
  }
  if (open) errors.push({ line: open.line, code: 'missing_end' })
  if (stray !== null) errors.push({ line: stray, code: 'missing_begin' })
  errors.sort((a, b) => a.line - b.line)
  return { cards, errors }
}

// --- writer ---------------------------------------------------------------------------------------------------------

// control characters out of a written value (a tab may stay); line breaks are escaped before this runs
const VALUE_CTL = /[\u0000-\u0008\u000a-\u001f\u007f]/g
const esc = s => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n').replace(VALUE_CTL, '')

/** Folds one line at 75 bytes (the continuation lines start with a space, counted in), never inside a character. */
export function foldLine(s) {
  if (Buffer.byteLength(s, 'utf8') <= 75) return s
  const parts = []
  let cur = ''
  let bytes = 0
  let max = 75
  for (const ch of s) {
    const cp = ch.codePointAt(0)
    const b = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4
    if (bytes + b > max) {
      parts.push(cur)
      cur = ''
      bytes = 0
      max = 74
    }
    cur += ch
    bytes += b
  }
  parts.push(cur)
  return parts.join('\r\n ')
}

/** An extra line that may be written back: a content line, not structural, not a dropped (URL-like) one, not the
 * saved N (merged into the one N line), one line. */
function writableExtra(line) {
  if (!line || /[\r\n]/.test(line)) return false
  const p = parseContentLine(line)
  return !!p && !STRUCTURAL.has(p.name) && !isDropped(p) && p.name !== 'N'
}

/** The 3rd-5th N components (middle name, prefix, suffix), still escaped, from the first saved N line; else empty. */
function savedNameRest(extraLines) {
  for (const x of extraLines) {
    if (!x || /[\r\n]/.test(x)) continue
    const p = parseContentLine(x)
    if (!p || p.name !== 'N') continue
    const parts = splitEscaped(p.value.replace(VALUE_CTL, ''), ';')
    // a component ending in a lone backslash (a broken file) would swallow the next ';': that backslash goes
    const whole = x => (/(?:^|[^\\])(?:\\\\)*\\$/.test(x) ? x.slice(0, -1) : x)
    return [parts[2] ?? '', parts[3] ?? '', parts[4] ?? ''].map(whole).join(';')
  }
  return ';;'
}

export function writeVcards(people) {
  const out = []
  for (const p of people) {
    const lines = ['BEGIN:VCARD', 'VERSION:3.0']
    const given = p.givenName || ''
    const family = p.familyName || ''
    const fn = p.displayName || [given, family].filter(Boolean).join(' ') || p.emails?.[0]?.address || ''
    lines.push(`FN:${esc(fn)}`)
    const extraLines = (p.vcardExtra || '').split(/\r\n|\n/)
    lines.push(`N:${esc(family)};${esc(given)};${savedNameRest(extraLines)}`)
    if (p.org) lines.push(`ORG:${esc(p.org)}`)
    if (p.title) lines.push(`TITLE:${esc(p.title)}`)
    for (const e of p.emails || []) {
      const ts = ['INTERNET']
      const label = cleanLabel(e.label || '')
      if (label) ts.push(label)
      if (e.isPrimary) ts.push('PREF')
      lines.push(`EMAIL;TYPE=${ts.join(',')}:${esc(e.address)}`)
    }
    for (const t of p.phones || []) {
      const label = cleanLabel(t.label || '')
      lines.push(`TEL${label ? `;TYPE=${label}` : ''}:${esc(t.number)}`)
    }
    if (p.note) lines.push(`NOTE:${esc(p.note)}`)
    for (const x of extraLines) if (writableExtra(x)) lines.push(x)
    lines.push('END:VCARD')
    out.push(lines.map(foldLine).join('\r\n'))
  }
  return out.length ? out.join('\r\n') + '\r\n' : ''
}

// the 3rd-5th N components of the first N line among the lines (still escaped), ";;" when there is none (import)
export { savedNameRest as vcardNameRest }
