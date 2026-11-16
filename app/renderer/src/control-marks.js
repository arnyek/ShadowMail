// SPDX-License-Identifier: GPL-3.0-or-later
// Invisible characters made visible in the source view: a header or a body must not be able
// to reverse, hide or smuggle part of the text. Pure (no DOM), so node:test can measure it. The source file holds only
// escapes, never the invisible characters themselves.
//
// Marked: every code point of the Unicode categories Cc (controls, C0 and C1), Cf (format: zero-width
// ones, direction marks and overrides, the BOM, the soft hyphen, the tag characters U+E0000-E007F), Zl and Zp (the line
// and paragraph separators) and of the Default_Ignorable_Code_Point property (variation selectors, fillers...), EXCEPT
// the tab, the line feed and the CR of a CRLF pair: those are the ordinary layout of a mail source. A lone CR is marked.
// With the `u` flag a code point outside the BMP is one match, one mark.
export const CONTROL_RE = /(?![\t\n])(?!\r\n)[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu

/** At most this many marks; past it the marked characters are left out and counted. */
export const MAX_MARKS = 10_000

/** At most this many characters come out, marks and the closing line included (the shown source's cap, H1). */
export const MAX_OUTPUT_CHARS = 2 * 1024 * 1024

/** "U+202E", "U+E0041" for a character (one code point). */
export const codeLabel = ch => `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`

/** The visible sign of a marked character, e.g. "⟨U+202E⟩". */
export const markText = ch => `⟨${codeLabel(ch)}⟩`
/** The visible sign of a mark label, e.g. for { mark: 'U+202E' }. */
export const markOf = label => `⟨${label}⟩`

/**
 * text -> { parts, unmarked, cut }. parts: [string | { mark: 'U+202E' }], the text cut at every marked character, no
 * empty string; at most `maxMarks` marks. unmarked: how many marked characters came after that and were LEFT OUT (never
 * shown raw). cut: the output reached `maxChars` (text + marks; the closing line comes on top) and the rest of the text
 * is not in it.
 */
export function controlParts(text, { maxMarks = MAX_MARKS, maxChars = MAX_OUTPUT_CHARS, reserve = 0 } = {}) {
  const s = String(text ?? '')
  const parts = []
  const budget = Math.max(0, maxChars - reserve)
  let used = 0
  let marks = 0
  let last = 0
  let cut = false
  const push = str => {
    if (!str) return true
    if (used + str.length > budget) {
      const room = budget - used
      // never split a surrogate pair at the cut
      let end = room
      if (end > 0 && /[\ud800-\udbff]/.test(str[end - 1])) end--
      if (end > 0) parts.push(str.slice(0, end))
      used = budget
      cut = true
      return false
    }
    parts.push(str)
    used += str.length
    return true
  }
  CONTROL_RE.lastIndex = 0
  let m
  while (marks < maxMarks && (m = CONTROL_RE.exec(s))) {
    if (!push(s.slice(last, m.index))) return { parts, unmarked: 0, cut }
    const label = codeLabel(m[0])
    if (used + label.length + 2 > budget) {
      cut = true
      return { parts, unmarked: 0, cut }
    }
    parts.push({ mark: label })
    used += label.length + 2
    marks++
    last = m.index + m[0].length
  }
  let rest = s.slice(last)
  let unmarked = 0
  if (marks >= maxMarks) {
    // past the cap: the marked characters are dropped, not shown raw, and counted for the closing line
    rest = rest.replace(CONTROL_RE, () => {
      unmarked++
      return ''
    })
  }
  push(rest)
  return { parts, unmarked, cut }
}

/**
 * parts -> runs: neighbouring marks merged into one { marks: ['U+0001', ...] } (the renderer draws one element per run:
 * 10 000 separate elements cost ~0.25 s to draw), strings as they are.
 */
export function markRuns(parts) {
  const runs = []
  for (const p of parts) {
    if (typeof p === 'string') runs.push(p)
    else if (runs.length && typeof runs[runs.length - 1] !== 'string') runs[runs.length - 1].marks.push(p.mark)
    else runs.push({ marks: [p.mark] })
  }
  return runs
}

/** How many marks a controlParts result stands for: the drawn ones and the left-out ones. */
export const markCount = r => r.parts.reduce((n, p) => (typeof p === 'string' ? n : n + 1), 0) + r.unmarked

/** The text with every marked character replaced by its visible sign (one-line values, titles, tests). No cap. */
export const withMarks = text => String(text ?? '').replace(CONTROL_RE, markText)

/** How many characters of the text are marked (all of them, not capped). */
export const countMarks = text => {
  let n = 0
  String(text ?? '').replace(CONTROL_RE, () => {
    n++
    return ''
  })
  return n
}


// the reader's plain-text body. A long text that alternates a letter with a control
// character froze the renderer for more than 30 s (2 MB of "x" + U+0001, measured), while the main side parsed it in 11 ms.
// Only the DISPLAY changes: the stored message, the index and the reply quote stay as they are.

/** At most this many characters of a plain-text body are drawn in the reader (the rest: the Forrás view). */
export const MAX_READER_TEXT = 1024 * 1024

/** Cc except the tab, LF and CR: left out of the reader's text. Cf and the other invisible ones stay (emoji ZWJ, soft hyphen). */
export const READER_DROP_RE = /[^\P{Cc}\t\n\r]/gu

const isHighSurrogate = code => code >= 0xd800 && code <= 0xdbff

/** Code points in a string (a surrogate pair is one). */
export function codePointLength(s) {
  let n = s.length
  for (let i = 0; i < s.length; i++) if (isHighSurrogate(s.charCodeAt(i)) && i + 1 < s.length) {
    n--
    i++
  }
  return n
}

/**
 * The plain-text body as the reader draws it: { text, removed, hidden }. removed: the control characters left out
 * (exact); hidden: how many characters (code points) did not fit under `max` after that (exact); the cut never splits
 * a surrogate pair.
 */
export function readerText(text, max = MAX_READER_TEXT) {
  let removed = 0
  const clean = String(text ?? '').replace(READER_DROP_RE, () => {
    removed++
    return ''
  })
  if (clean.length <= max) return { text: clean, removed, hidden: 0 }
  let end = max
  if (end > 0 && isHighSurrogate(clean.charCodeAt(end - 1))) end--
  return { text: clean.slice(0, end), removed, hidden: codePointLength(clean.slice(end)) }
}
