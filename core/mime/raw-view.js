// SPDX-License-Identifier: GPL-3.0-or-later
// The "Fejlécek / Eredeti" view of a message, pure.
// The raw message is shown, never interpreted: the header block (up to the first empty line), the whole message as
// UTF-8 text (a broken byte becomes U+FFFD) up to MAX_SOURCE_CHARS, and a short summary read from the headers: the
// sender, recipients, date, subject, Message-ID (RFC 2047 decoded by mailparser) and the SPF / DKIM / DMARC results
// the RECEIVING server wrote into its Authentication-Results header (the topmost one). The app checks no signature.
import { simpleParser } from 'mailparser'

export const MAX_SOURCE_CHARS = 2 * 1024 * 1024 // 2 097 152 characters; the whole message goes out only by saving it
export const AUTH_RESULTS = Object.freeze(['pass', 'fail', 'softfail', 'neutral', 'none', 'temperror', 'permerror', 'policy'])

// a header line: "Name: value" (RFC 5322 field name: printable ASCII but ':'), or a folded continuation
const HEADER_LINE = /^[!-9;-~]+:/
/**
 * The header block's end, in bytes: the first empty line after header lines. A message that does not start with a
 * header line has no header block (0).
 */
export function headerEnd(buf) {
  let i = 0
  let first = true
  while (i < buf.length) {
    let j = buf.indexOf(0x0a, i)
    if (j < 0) j = buf.length
    const line = buf.subarray(i, j).toString('latin1').replace(/\r$/, '')
    if (line === '') return first ? 0 : i
    if (first ? !HEADER_LINE.test(line) : !(HEADER_LINE.test(line) || /^[ \t]/.test(line))) return first ? 0 : i
    first = false
    i = j + 1
  }
  return buf.length // headers only, no body
}

/** The first `max` characters of the buffer as UTF-8 (U+FFFD for a broken byte), never splitting a surrogate pair. */
function decodeCapped(buf, max) {
  // UTF-8 is at most 4 bytes a character: decoding 4 x max bytes always yields more than max characters when there are
  const slice = buf.length > max * 4 ? buf.subarray(0, max * 4) : buf
  let text = new TextDecoder('utf-8', { fatal: false }).decode(slice)
  let truncated = slice.length < buf.length
  if (text.length > max) {
    const cut = /[\ud800-\udbff]/.test(text[max - 1]) ? max - 1 : max
    text = text.slice(0, cut)
    truncated = true
  }
  return { text, truncated }
}

// RFC 8601: the comments (CFWS: parentheses, nested, with quoted pairs) go, a quoted string stays whole. A sender
// controls text inside them (the envelope sender's local part in the server's comment and in smtp.mailfrom="..."):
// it must never be read as a result.
function withoutComments(s) {
  let out = ''
  let depth = 0
  let quoted = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (depth > 0) {
      if (c === '\\') i++
      else if (c === '(') depth++
      else if (c === ')') depth--
      continue
    }
    if (quoted) {
      out += c
      if (c === '\\' && i + 1 < s.length) out += s[++i]
      else if (c === '"') quoted = false
      continue
    }
    if (c === '"') quoted = true
    if (c === '(') {
      depth = 1
      out += ' '
      continue
    }
    out += c
  }
  return out
}
// split on ';' outside quoted strings
function resinfos(s) {
  const parts = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quoted) {
      cur += c
      if (c === '\\' && i + 1 < s.length) cur += s[++i]
      else if (c === '"') quoted = false
    } else if (c === '"') {
      quoted = true
      cur += c
    } else if (c === ';') {
      parts.push(cur)
      cur = ''
    } else cur += c
  }
  parts.push(cur)
  return parts.map(p => p.trim())
}
/**
 * The SPF / DKIM / DMARC results of the TOPMOST Authentication-Results header (the receiving server added it last),
 * with the server that wrote it (`by`, the authserv-id), or null when there is none. Only the FIRST token of a
 * resinfo, "method=result" (method may carry a "/version"), is a result; a property (smtp.mailfrom=, header.from=),
 * a comment or a quoted value never is. For a method given twice the first counts.
 */
export function authenticationResults(headerText) {
  const unfolded = headerText.replace(/\r?\n[ \t]+/g, ' ')
  const line = unfolded.split(/\r?\n/).find(l => /^authentication-results\s*:/i.test(l))
  if (!line) return null
  const [id, ...rest] = resinfos(withoutComments(line.slice(line.indexOf(':') + 1)))
  const out = { by: (id.split(/\s+/)[0] || '').slice(0, 255) || null, spf: null, dkim: null, dmarc: null }
  for (const r of rest) {
    const m = r.match(/^([a-z0-9-]+)(?:\s*\/\s*\d+)?\s*=\s*([a-z]+)(?=$|\s)/i)
    if (!m) continue
    const method = m[1].toLowerCase()
    const result = m[2].toLowerCase()
    if (Object.hasOwn(out, method) && method !== 'by' && out[method] === null && AUTH_RESULTS.includes(result)) out[method] = result
  }
  return out
}

/** buf (the raw message) -> { headers, text, truncated, size, summary } */
export async function rawView(buf) {
  const source = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
  const end = headerEnd(source)
  // the header block has the same cap as the text (measured: 300 000 header lines were 22 MB over the IPC)
  const { text: headers, truncated: headersTruncated } = decodeCapped(source.subarray(0, end), MAX_SOURCE_CHARS)
  const { text, truncated } = decodeCapped(source, MAX_SOURCE_CHARS)
  let parsed = null
  try {
    // only the header block: no body, no attachment is parsed
    parsed = end > 0 ? await simpleParser(Buffer.concat([source.subarray(0, Math.min(end, MAX_SOURCE_CHARS * 4)), Buffer.from('\r\n\r\n')]), { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true }) : null
  } catch {
    parsed = null
  }
  const addresses = a => (a ? (Array.isArray(a) ? a.map(x => x.text).join(', ') : a.text) : null)
  const summary = {
    from: addresses(parsed?.from) || null,
    to: addresses(parsed?.to) || null,
    cc: addresses(parsed?.cc) || null,
    date: parsed?.date instanceof Date && !Number.isNaN(parsed.date.getTime()) ? parsed.date.toISOString() : null,
    subject: parsed?.subject ?? null,
    messageId: parsed?.messageId ?? null,
    auth: authenticationResults(headers),
  }
  return { headers, headersTruncated, text, truncated, size: source.length, summary }
}

/**
 * The .eml file name of a message: its subject, made safe for Windows, at most 100 characters; "<fallback>.eml" without.
 * fallback: the caller's word in the interface language (core does not read the dictionary), no default.
 */
export function sourceFileName(subject, safeFileName, fallback) {
  if (typeof fallback !== 'string' || !fallback) throw new TypeError('sourceFileName: fallback is required')
  // zero-width and direction marks would hide part of the name (safeFileName keeps them)
  const clean = String(subject || '').replace(/[\u200b-\u200f\u2060-\u2064\ufeff]/g, '').trim()
  const base = safeFileName(clean, fallback).slice(0, 100).replace(/[. ]+$/g, '')
  return `${base || fallback}.eml`
}
