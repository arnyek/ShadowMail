// SPDX-License-Identifier: GPL-3.0-or-later
// Text extraction for the search index and the list preview.
// Derived from an earlier internal tool by the same author.
import { simpleParser } from 'mailparser'
import { convert as htmlToText } from 'html-to-text'
import { visibleTextInfo } from './visible-text.js'
import { htmlTotalActive, exceedsNestingDepth } from './html-total.js' // the `htmlTotal` parser option (the cap on the sum of the converted HTML parts)

export const BODY_MAX_CHARS = 100_000
export const PREVIEW_CHARS = 200

const PLAIN_SELECTORS = [
  { selector: 'img', format: 'skip' },
  { selector: 'a', options: { ignoreHref: true } },
]
// a table of an outgoing message (the composer's rich mode keeps it a table): a line per row, the cells one TAB apart, as
// Chromium's own text/plain of a copied table; the caption the first line, a header cell not marked, a nested table's rows
// where its cell is, an empty line before and after. Without it html-to-text writes the cells of a row into one word.
// Past TAB_TABLE_DEPTH nested tables the inner ones are walked as plain text (each level copies its cells' text up once)
export const TAB_TABLE_DEPTH = 20
const SECTIONS = new Set(['thead', 'tbody', 'tfoot'])
// no text of their own in a table (a caption or a section is read where it stands)
const SKIP_IN_TABLE = new Set(['caption', 'colgroup', 'col', 'thead', 'tbody', 'tfoot', 'style', 'script'])
let tableDepth = 0
function tabTable(elem, walk, builder) {
  if (tableDepth >= TAB_TABLE_DEPTH) {
    walk(elem.children, builder)
    return
  }
  tableDepth++
  try {
    builder.openTable()
    const cell = nodes => {
      builder.openTableCell()
      walk(nodes, builder)
      builder.closeTableCell()
    }
    const line = nodes => {
      builder.openTableRow()
      cell(nodes)
      builder.closeTableRow()
    }
    // a safety net: what stands in a table, a section or a row but in no cell (the outgoing HTML's mirror moves it
    // before the table, as the browser does) still gets its own line, so the text part never drops a shown text
    const stray = n => (n.type === 'text' && /\S/.test(n.data)) || (n.type === 'tag' && !SKIP_IN_TABLE.has(n.name))
    const row = tr => {
      const cells = []
      for (const c of tr.children) {
        if (c.type === 'tag' && (c.name === 'td' || c.name === 'th')) cells.push(c)
        else if (stray(c)) line([c])
      }
      builder.openTableRow()
      for (const c of cells) cell(c.children)
      builder.closeTableRow()
    }
    const rows = (children, inSection) => {
      let loose = []
      const flush = () => {
        if (!loose.length) return
        builder.openTableRow()
        for (const c of loose) cell(c.children)
        builder.closeTableRow()
        loose = []
      }
      for (const c of children) {
        if (c.type === 'tag' && (c.name === 'td' || c.name === 'th')) {
          loose.push(c)
          continue
        }
        flush()
        if (c.type !== 'tag') {
          if (stray(c)) line([c])
        } else if (c.name === 'tr') row(c)
        else if (!inSection && c.name === 'caption') line(c.children)
        else if (!inSection && SECTIONS.has(c.name)) rows(c.children, true)
        else if (stray(c)) line([c])
      }
      flush()
    }
    rows(elem.children, false)
    // a cell's own blank lines (its paragraphs) are one line break: the row stays as close to one line as its text lets
    builder.closeTable({ tableToString: rows => rows.map(r => r.map(x => x.text.replace(/\n{2,}/g, '\n')).join('\t')).join('\n'), leadingLineBreaks: 2, trailingLineBreaks: 2 })
  } finally {
    tableDepth--
  }
}
const TAB_TABLE_OPTIONS = { wordwrap: false, formatters: { tabTable }, selectors: [...PLAIN_SELECTORS, { selector: 'table', format: 'tabTable' }] }

/**
 * An HTML body as plain text (no wrap, no image, a link's text without its target). `tables`: a table as TAB-separated
 * lines (the text/plain part of an outgoing message, the send Modal's text); without it a table's text as html-to-text
 * writes it (the index and the preview of a received message, as before).
 */
export function htmlToPlain(html, { tables = false } = {}) {
  return htmlToText(html, tables ? TAB_TABLE_OPTIONS : { wordwrap: false, selectors: PLAIN_SELECTORS })
}

/** For indexing: collapses blank lines and spaces, caps the length. */
export function normalizeText(text, max = BODY_MAX_CHARS) {
  const t = String(text || '')
    .replace(/\r/g, '')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return t.length > max ? t.slice(0, max) : t
}

export function makePreview(text, max = PREVIEW_CHARS) {
  const t = String(text || '').replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max) : t
}

/**
 * The text the LOCAL search looks in is the text the
 * reader shows. An HTML part -> its visible text (visibleTextInfo, the filter of read_message: hidden preheaders, white on
 * white, display:none... dropped); no HTML -> the text/plain. HTML too complex to filter (cut: 'complex') -> no body at
 * all, NOT the text/plain: that part may carry what the HTML hides. Normalized, at most `maxChars`.
 * `visible` is the HTML filter (the app may run it elsewhere; default: here).
 */
export function searchTextOf(parsed, options) {
  return searchTextInfo(parsed, options).text
}

/** searchTextOf with how it ended: { text, complex } (complex: the HTML was over the work ceiling or the time net, no body). */
export function searchTextInfo(parsed, { maxChars = BODY_MAX_CHARS, visible = visibleTextInfo } = {}) {
  if (parsed.html) {
    let v = visible(parsed.html)
    // a big HTML over the work ceiling is filtered ONCE more on its first COMPLEX_RETRY_BYTES (cut at a
    // UTF-8 character boundary); complex again (or no shorter part): no body. The ceiling does not change, and the
    // text/plain stays out.
    if (v.cut === 'complex') {
      const head = htmlHead(parsed.html, COMPLEX_RETRY_BYTES)
      v = head === null ? v : visible(head)
    }
    return v.cut === 'complex' ? { text: '', complex: true } : { text: normalizeText(v.text, maxChars), complex: false }
  }
  return { text: normalizeText(parsed.text, maxChars), complex: false }
}

export const COMPLEX_RETRY_BYTES = 128 * 1024

/** The first `max` UTF-8 bytes of the HTML, cut where a character starts; null when the whole fits. */
export function htmlHead(html, max) {
  const buf = Buffer.from(html, 'utf8')
  if (buf.length <= max) return null
  let end = max
  // a continuation byte (10xxxxxx) is never the start of a character: step back to one
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--
  return buf.subarray(0, end).toString('utf8')
}

/** The list preview, the OLD rule (the preheader stays in the preview): the text/plain first. */
export function previewOf(parsed, { maxChars = BODY_MAX_CHARS } = {}) {
  return makePreview(oldTextOf(parsed, { maxChars }))
}

/** The parser options of the index (one place: the search text and the preview are made of the same parse). */
export const INDEX_PARSE = Object.freeze({ skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true })

// mailparser's own HTML -> text (html-to-text with its default 80-column wrap) is quadratic in the text inside a table:
// 4 MB of 1000-character cells took 3 s, 5.3 MB of tiny cells 89 s, on the main thread. It still runs, byte for byte as
// before, when the HTML parts it converts are at most MAIN_HTML_LIMIT characters IN ALL (html-total.js: the cap of
// mailparser's own maxHtmlLengthToParse is per part, and a text/plain part does not stop the conversion of the HTML parts
// of a multipart/mixed); over it nothing is converted, and that message's old-rule text and preview are made on the
// worker thread with OUR linear converter (htmlToPlain), later.
export const MAIN_HTML_LIMIT = 256 * 1024
/** The cap on the sum of the converted HTML parts (the parser option of html-total.js). */
export const HTML_TOTAL = Object.freeze({ cap: MAIN_HTML_LIMIT })
/** The parse of the old-rule text and the preview: mailparser's conversion, capped (per part too, as before). */
export const PREVIEW_PARSE = Object.freeze({ ...INDEX_PARSE, maxHtmlLengthToParse: MAIN_HTML_LIMIT, htmlTotal: HTML_TOTAL })
/** The parse of the search text (searchTextOf reads the HTML itself): no HTML -> text at all. */
export const SEARCH_PARSE = Object.freeze({ ...INDEX_PARSE, skipHtmlToText: true })
/**
 * The worker's parse of a message body: the search text as SEARCH_PARSE, and over the cap the old-rule text made with
 * htmlToPlain (the text/plain parts and every converted HTML part, in mailparser's order): latePreviewOf reads it.
 */
export const LATE_PARSE = Object.freeze({ ...SEARCH_PARSE, htmlTotal: Object.freeze({ cap: MAIN_HTML_LIMIT, linear: html => htmlToPlain(html) }) })

/** The converted HTML parts were over the cap (PREVIEW_PARSE, LATE_PARSE): the text and the preview are the worker's. */
export function htmlTooLong(parsed) {
  const err = parsed && parsed.textConversionError
  return Boolean(err && /^HTML too long/.test(String(err.message)))
}

/**
 * The worker's preview of a message the main thread left without one (htmlTooLong): the old rule (the text/plain first),
 * the HTML parts through htmlToPlain. Of a LATE_PARSE parse; null within the cap (the main thread made it). `active`:
 * the hook of html-total.js is on; without it only the per-part cap works, and an HTML over it is told by its length.
 */
export function latePreviewOf(parsed, active = htmlTotalActive) {
  if (!parsed) return null
  const late = active ? htmlTooLong(parsed) : Boolean(parsed.html && parsed.html.length > MAIN_HTML_LIMIT)
  return late ? makePreview(oldTextOf(parsed, { toPlain: html => latePlain(html) })) : null
}

// The late way's HTML (decisions 3842, 3850): our converter is tried, as the old code did after mailparser left a too
// deep HTML without text (it went through or threw a RangeError, by the depth), and a throw gives '' (no failed worker
// result). Over LATE_DEPTH_LIMIT levels it is not tried: html-to-text is superlinear in the depth (an HTML-only 2.45 MB
// message of 200 000 levels held the worker for 32 s, 60 000 levels 1.3 s), and from 10 000 levels it threw in the old
// code on the main thread and in the worker (measured), so there the old code had no preview either.
export const LATE_DEPTH_LIMIT = 10_000
/** The worker's htmlToPlain of the late way: never throws and never goes deeper than LATE_DEPTH_LIMIT ('' then). */
export function latePlain(html, toPlain = htmlToPlain) {
  if (exceedsNestingDepth(html, LATE_DEPTH_LIMIT)) return ''
  try {
    return toPlain(html)
  } catch {
    return ''
  }
}

/** The text of the OLD rule (before the visible text): the text/plain first. Kept for the immediate index text. */
export function oldTextOf(parsed, { maxChars = BODY_MAX_CHARS, toPlain = htmlToPlain } = {}) {
  let text = parsed.text
  if (!text && parsed.html) text = toPlain(parsed.html)
  return normalizeText(text, maxChars)
}

/**
 * Raw message (or its first bytes) -> { text, preview, state }. state 1 = indexed, 2 = failed.
 * `text` is what the local search looks in (searchTextOf: the visible text), `preview` the list's (previewOf, the old
 * rule). `oldText`: the text of the old rule instead (plan 5a: the app writes it at once, the worker thread's visible
 * text replaces it). A truncated source still parses: the text is usually at the start of the message.
 */
export async function bodyFromSource(source, { maxChars = BODY_MAX_CHARS, visible, oldText = false } = {}) {
  if (!source || !source.length) return { text: '', preview: null, state: 2 }
  try {
    const parsed = await simpleParser(source, PREVIEW_PARSE)
    // an HTML part over the cap: with the worker (oldText), the old text and the preview come from it, later (an empty body
    // and no preview until then); without it (tests, core), here, with the linear converter
    const late = oldText && htmlTooLong(parsed)
    const text = oldText ? (late ? '' : oldTextOf(parsed, { maxChars })) : searchTextOf(parsed, { maxChars, visible })
    return { text, preview: late ? null : previewOf(parsed, { maxChars }), state: 1 }
  } catch {
    return { text: '', preview: null, state: 2 }
  }
}

/** For accent-free matching outside FTS (POP3 old-text search, server-search fallback): NFD, marks off, lower case. */
export function foldForSearch(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
}

/**
 * The words of a search box entry for the non-FTS searches: split like toSafeFts (letters, digits, _),
 * FTS operators (AND, OR, NOT, NEAR) dropped, duplicates removed. Every word must occur (AND).
 */
export function searchWords(query) {
  const out = []
  // the same word boundaries as the local search (toSafeFts), so all three searches agree on "a word"
  for (const w of String(query || '').split(/[^\p{L}\p{N}_]+/u)) {
    if (!w || ['AND', 'OR', 'NOT', 'NEAR'].includes(w)) continue
    if (!out.includes(w)) out.push(w)
  }
  return out
}
