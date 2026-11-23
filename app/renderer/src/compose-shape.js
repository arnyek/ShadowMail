// SPDX-License-Identifier: GPL-3.0-or-later
// The shape check of a composer's starting body (against an "e-mail bomb"), measured on what the composer
// will really hold. The starting HTML goes through sanitizeCompose first; its result is put into an inert <template> (parsed
// by this Chromium, no layout: nothing can freeze here), and the longest run of text with no block boundary is counted on
// that DOM. Over SHAPE_LIMIT the composer does not write the body (Composer.jsx: compose:suspect), and the main window asks.
// A static tokenizer in the main process was tried first and dropped: it could follow neither
// this Chromium's parser (<select>) nor DOMPurify's content rules (<noscript>), and every difference was a gap.
//
// Pure (no React, no window); jsdom-tested. The main process must NOT import this file (not packaged): N is in core/.
import { RICH_TAGS } from './sanitize.js'
import { SHAPE_LIMIT, SWITCH_LIMIT } from '../../../core/mime/shape-limit.js'
import { RUNS, UNICODE_VERSION } from '../../../core/mime/bidi-class.js'

// N and B live in core/ (the main process needs them too, and app/renderer/src is not packaged)
export { SHAPE_LIMIT, SWITCH_LIMIT }

// the block elements of HTML; a boundary is one of them that the composer KEEPS (derived from RICH_TAGS, the widest set it
// keeps: a saved draft opened again keeps its table, and every cell is a block of its own; if the composer's tags change,
// the boundaries follow; test/compose-shape.test.js pins the list)
const HTML_BLOCKS = new Set(['p', 'div', 'br', 'ul', 'ol', 'li', 'blockquote', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'caption', 'tr', 'td', 'th', 'hr', 'dl', 'dt', 'dd'])
export const SHAPE_BLOCKS = Object.freeze(RICH_TAGS.filter(t => HTML_BLOCKS.has(t)))
const BLOCK_NAMES = new Set(SHAPE_BLOCKS.map(t => t.toUpperCase()))

// ASCII whitespace (U+0020, U+0009, U+000A, U+000D) breaks a run OUTSIDE a <pre>: the editor's
// white-space is "normal" there (measured in the app: .editor, p, div, blockquote, b; app/renderer/src/app.css .editor
// sets none), so the browser may wrap the line at it. Every other space (U+00A0, U+2007, U+202F, U+200B, U+2060, U+FEFF
// ...) is NOT a break here: an over-count asks a question, an under-count would be a gap. Inside a <pre> (white-space:
// pre, its inline elements too) nothing breaks the run.
// NOT the form feed (U+000C): measured (Linux, 4 of 4) a 2 MB <p> of 30 000-character pieces split by it passed
// the check and froze until the watchdog; the browser does not seem to wrap at it (a guess, not measured), so it stays in the run
const isAsciiSpace = c => c === 32 || c === 9 || c === 10 || c === 13


// B: the direction switches of one block. Measured (Linux, one spaced <p>): every single writing system is fast even
// at 128 000 characters, but a text that changes its bidi direction class at almost every character is not (Hebrew and
// Latin, Arabic and Latin, Hebrew and digits, Latin letters each in an isolate: 1.9-2.0 s at ~58 000 switches, ~7 s at twice
// that). So the block's count is the number of class changes between neighbouring non-neutral characters, plus
// ISOLATE_WEIGHT for every isolate control.
// The classes are the Unicode Bidi_Class of the character, from a generated table (core/mime/bidi-class.js, made by
// scripts/gen-bidi-class.py from the Unicode Character Database; JS regexps have no Bidi_Class, and a hand-made category
// list let bombs through: RLM, LRM, a superscript, a circled letter, a spacing mark, a danda, Arabic number signs):
//   L  L;  R  R and AL;  EN  EN;  AN  AN;  I  LRI, RLI, FSI, PDI;  E  LRE, RLE, LRO, RLO, PDF;  U  unassigned in the
//   table's Unicode;  every other class is neutral and passed over.
// I, U and E: each one is a weight on its own (I and U +2, E +1), whatever its neighbours, is passed over in the class
// sequence (a run of them alone counts too), and makes the block forget its last strong character (an EN after it stays
// EN). The isolates: with +1, Latin letters each in an isolate at exactly B were the slowest kind (median 1.88 s, once
// 2.04 s). The unassigned: the browser knows a newer Unicode than the table (Electron 45: 17.0, the table: 15.0), and a
// character it knows is unknown here, whatever its real class (Hebrew and the Garay digits, R in a guess, passed with 0
// switches). The embedding and override controls: "a RLE 1 PDF" repeated was slow with the EN counted as L (in an
// embedding the European-number rule starts from the embedding's direction); +1 each keeps a margin under 2 s at B.
// Letters each in an RLO ... PDF were cheap (measured) and now ask at 128 000 characters: an accepted over-count.
// EN after L (the bidi algorithm's rule for European numbers): when the block's last STRONG character (L or R) is L,
// an EN counts as L: Latin and digits alternating is cheap (measured: 48 000 characters ~0.2 s, where Hebrew and Latin
// took ~1.4 s). An EN after R, or before any strong character, stays EN; an AN is always AN.
// The block is a kept block element; a <br> does NOT end it (a <br>-split body is as slow), and inside a <pre> the
// count goes on.
const NEUTRAL = 0
const L = 1
const R = 2
const EN = 3
const AN = 4
const I = 5
const U = 6
const E = 7
/** What one isolate control, or one code point unassigned in the table's Unicode, adds to the block's count (see above). */
export const ISOLATE_WEIGHT = 2
/** What one embedding or override control adds (see above). */
export const EMBEDDING_WEIGHT = 1
// the table: the BMP spelled out (64 KB), the rest by binary search over the run starts
const STARTS = []
const CLASSES = []
for (let i = 0; i < RUNS.length; i += 2) {
  STARTS.push(RUNS[i])
  CLASSES.push(RUNS[i + 1])
}
const BMP = new Uint8Array(0x10000)
for (let r = 0; r < STARTS.length && STARTS[r] < 0x10000; r++) BMP.fill(CLASSES[r], STARTS[r], Math.min(r + 1 < STARTS.length ? STARTS[r + 1] : 0x10000, 0x10000))
/** The direction class of a code point (exported for the tests). */
export function directionClass(cp) {
  if (cp < 0x10000) return BMP[cp]
  let lo = 0
  let hi = STARTS.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (STARTS[mid] <= cp) lo = mid
    else hi = mid - 1
  }
  return CLASSES[lo]
}
export const DIRECTION = Object.freeze({ NEUTRAL, L, R, EN, AN, I, U, E })
export { UNICODE_VERSION }

// the markers pushed after an element's children: the end of a block (a boundary of the run), of a <pre>, and of a block
// for the switch count (every block element but <br>)
const END_BLOCK = 1
const END_PRE = 2
const END_SWITCH = 4

/**
 * The longest run of text without a block boundary (and, outside a <pre>, without ASCII whitespace) under `root` (a
 * DocumentFragment or an Element), in characters (a surrogate pair is one), and the most direction switches of one block.
 * -> { longest, total, switches } (total: every character, whitespace too). Iterative (a deep tree does not overflow the
 * stack), linear in the number of nodes and characters.
 */
export function longestRun(root) {
  const work = []
  for (let c = root.lastChild; c; c = c.previousSibling) work.push(c)
  let run = 0
  let longest = 0
  let total = 0
  let pre = 0 // the depth of open <pre> elements
  let dir = NEUTRAL // the class of the block's last non-neutral character
  let strong = NEUTRAL // the block's last strong character: L or R (the EN rule)
  let count = 0 // the switches of the current block
  let switches = 0
  while (work.length) {
    const n = work.pop()
    if (typeof n === 'number') {
      if (n & END_PRE) pre--
      if (n & END_BLOCK) run = 0
      if (n & END_SWITCH) {
        dir = NEUTRAL
        strong = NEUTRAL
        count = 0
      }
      continue
    }
    if (n.nodeType === 3) {
      const s = n.data
      for (let i = 0; i < s.length; i++) {
        let cp = s.charCodeAt(i)
        total++
        if (!pre && isAsciiSpace(cp)) {
          run = 0
          continue
        }
        // a surrogate pair is one character
        if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < s.length) {
          const d = s.charCodeAt(i + 1)
          if (d >= 0xdc00 && d <= 0xdfff) {
            cp = (cp - 0xd800) * 0x400 + (d - 0xdc00) + 0x10000
            i++
          }
        }
        if (++run > longest) longest = run
        let c = directionClass(cp)
        if (c === NEUTRAL) continue
        // a weight of their own, passed over in the sequence, and the last strong character forgotten
        if (c === I || c === U || c === E) {
          count += c === E ? EMBEDDING_WEIGHT : ISOLATE_WEIGHT
          if (count > switches) switches = count
          strong = NEUTRAL
          continue
        }
        // the European-number rule: an EN after a strong L is L
        if (c === EN && strong === L) c = L
        else if (c === L || c === R) strong = c
        if (dir !== NEUTRAL && c !== dir && ++count > switches) switches = count
        dir = c
      }
      continue
    }
    if (n.nodeType !== 1) continue
    let mark = 0
    if (BLOCK_NAMES.has(n.tagName)) {
      run = 0
      mark |= END_BLOCK
      if (n.tagName !== 'BR') {
        dir = NEUTRAL
        strong = NEUTRAL
        count = 0
        mark |= END_SWITCH
      }
    }
    if (n.tagName === 'PRE') {
      pre++
      mark |= END_PRE
    }
    if (mark) work.push(mark)
    for (let c = n.lastChild; c; c = c.previousSibling) work.push(c)
  }
  return { longest, total, switches }
}

/**
 * The composer's starting HTML (already sanitized) -> { fragment, longest, switches, reason, suspect }: the parsed DOM in an
 * inert template's content (to be moved into the editor as it is), the longest run, the most switches of one block, and
 * why it is suspect: 'run' (over N), 'switches' (over B) or null.
 */
export function shapeOf(doc, cleanHtml) {
  const tpl = doc.createElement('template')
  tpl.innerHTML = cleanHtml
  const { longest, switches } = longestRun(tpl.content)
  const reason = longest > SHAPE_LIMIT ? 'run' : switches > SWITCH_LIMIT ? 'switches' : null
  return { fragment: tpl.content, longest, switches, reason, suspect: reason !== null }
}
