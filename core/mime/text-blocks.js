// SPDX-License-Identifier: GPL-3.0-or-later
// A long text is drawn in blocks, each its own block element inside the <pre>. One huge
// inline formatting context made the bidi / shaping / line-breaking cost superlinear: an alternating Hebrew (or emoji, RLO,
// combining) body froze the window for more than 30 s; in blocks it is linear (measured). Pure (no DOM), so
// node:test can measure it.
//
// A block boundary inside a line is a visible break, so the blocks are made of WHOLE
// lines, and only a line longer than LONG_LINE is cut (every CHUNK code points, after the last space, else hard). A
// format=flowed paragraph is one line after the mailparser, so LONG_LINE stays above a real paragraph. A cut is only made
// on a grapheme boundary (Intl.Segmenter): a CRLF, a flag, a skin tone, an emoji sequence, a combining sequence or a
// Hangul syllable is never split. One cutter for every user (reader, source view, the reply quote).

/** Code points per block (and per piece of a cut long line). Measured. */
export const CHUNK = 1000
/** A line up to this many code points is never cut (its own block when longer than CHUNK). Measured. */
export const LONG_LINE = 3000

const isHigh = c => c >= 0xd800 && c <= 0xdbff
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** Code points in text[from, to) (a surrogate pair is one). */
function cpCount(text, from, to) {
  let n = 0
  for (let i = from; i < to; i++, n++) if (isHigh(text.charCodeAt(i)) && i + 1 < to) i++
  return n
}

/** The code unit index `n` code points after `from` (at most `to`). */
function advance(text, from, n, to) {
  let i = from
  for (let k = 0; k < n && i < to; k++) i += isHigh(text.charCodeAt(i)) && i + 1 < to ? 2 : 1
  return i
}

const isRegional = c => c >= 0x1f1e6 && c <= 0x1f1ff

/**
 * The last grapheme boundary at or before `cut` and after `start`; `cut` itself when none is found (a cluster longer
 * than the window: the size limit wins). Segmented in a small window before the cut. A flag is a PAIR of regional
 * indicators counted from the start of their run, so a window that starts inside a run would pair them the wrong way
 * (a flag at an odd offset): there the window starts at the run's start.
 */
function graphemeBack(text, start, cut) {
  let from = Math.max(start, cut - 32)
  if (from > start && text.charCodeAt(from) >= 0xdc00 && text.charCodeAt(from) <= 0xdfff) from--
  while (from - 2 >= start && isRegional(text.codePointAt(from - 2))) from -= 2
  const to = Math.min(text.length, cut + 32)
  let best = -1
  for (const { index } of segmenter.segment(text.slice(from, to))) {
    const at = from + index
    if (at > cut) break
    // the window's own start is a boundary only when it is the piece's start (else its left context is cut off)
    if (index === 0 && from > start) continue
    if (at > start) best = at
  }
  return best > start ? best : cut
}

/**
 * The cut points (code unit indexes, ascending, without 0 and text.length) of text in blocks: whole lines (a line ends
 * after its LF) gathered up to `chunk` code points; a line longer than `chunk` but not than `longLine` is a block of its
 * own; a longer line is cut every `chunk` code points (after the last space in the piece, else hard), on a grapheme
 * boundary. `protect(i)` (optional) says a cut at i is not allowed (inside a mark of the source view): the cut moves back.
 */
export function cutPoints(text, { chunk = CHUNK, longLine = LONG_LINE, protect = null } = {}) {
  const s = String(text ?? '')
  const cuts = []
  let blockStart = 0
  let blockSize = 0
  const cutAt = i => {
    if (i > blockStart && i < s.length) {
      cuts.push(i)
      blockStart = i
    }
    blockSize = 0
  }
  let lineStart = 0
  while (lineStart < s.length) {
    const lf = s.indexOf('\n', lineStart)
    const lineEnd = lf === -1 ? s.length : lf + 1
    const size = cpCount(s, lineStart, lineEnd)
    // the line's own length, without its line break (LF, or CR LF): "a line of LONG_LINE code points" means its text
    const brk = lf === -1 ? 0 : lf > lineStart && s.charCodeAt(lf - 1) === 13 ? 2 : 1
    if (size <= chunk) {
      if (blockSize + size > chunk) cutAt(lineStart)
      blockSize += size
    } else if (size - brk <= longLine) {
      // a long line, but a real paragraph: its own block, never cut
      cutAt(lineStart)
      cutAt(lineEnd)
    } else {
      cutAt(lineStart)
      let start = lineStart
      let left = size // code points of the line from start on (kept, not recounted: that would be O(n^2))
      while (left > chunk) {
        const limit = advance(s, start, chunk, lineEnd)
        const sp = s.slice(start, limit).lastIndexOf(' ')
        let cut = sp > 0 ? start + sp + 1 : limit
        cut = graphemeBack(s, start, cut)
        if (protect) while (cut > start + 1 && protect(cut)) cut--
        if (cut <= start) cut = limit
        cutAt(cut)
        left -= cpCount(s, start, cut)
        start = cut
      }
      blockSize = left
    }
    lineStart = lineEnd
  }
  return cuts
}

/** text -> [string]: the blocks; joined, exactly the text. */
export function textBlocks(text, opts) {
  const s = String(text ?? '')
  if (!s) return []
  const out = []
  let from = 0
  for (const c of cutPoints(s, opts)) {
    out.push(s.slice(from, c))
    from = c
  }
  out.push(s.slice(from))
  return out
}

/**
 * The source view's marked text (markRuns output: strings and { marks } runs) in blocks: [[run, ...], ...]. The same
 * cutter; a mark counts as ONE character, as the character it stands for (its sign is longer, but the line is the
 * message's line: a real paragraph must not pass LONG_LINE because of its marks, the emoji case); a cut never
 * falls inside a mark run, so a mark is never split.
 */
export function partBlocks(runs, opts = {}) {
  const shown = runs.map(r => (typeof r === 'string' ? r : 'x'.repeat(r.marks.length)))
  const ranges = [] // [from, to) of the mark runs in the shown text
  let at = 0
  runs.forEach((r, i) => {
    if (typeof r !== 'string') ranges.push([at, at + shown[i].length])
    at += shown[i].length
  })
  const text = shown.join('')
  if (!text) return []
  // the ranges are ascending: a binary search keeps the protect check cheap
  const inMark = i => {
    let lo = 0
    let hi = ranges.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const [a, b] = ranges[mid]
      if (i <= a) hi = mid - 1
      else if (i >= b) lo = mid + 1
      else return true
    }
    return false
  }
  const cuts = cutPoints(text, { ...opts, protect: ranges.length ? inMark : null })
  const blocks = []
  let block = []
  let pos = 0
  let k = 0
  runs.forEach((r, i) => {
    const len = shown[i].length
    if (typeof r !== 'string') {
      if (k < cuts.length && cuts[k] <= pos) {
        if (block.length) blocks.push(block)
        block = []
        k++
      }
      block.push(r)
      pos += len
      return
    }
    let from = 0
    while (k < cuts.length && cuts[k] - pos < len) {
      const c = cuts[k] - pos
      if (c > from) block.push(r.slice(from, c))
      if (block.length) blocks.push(block)
      block = []
      from = c
      k++
    }
    if (from < len) block.push(r.slice(from))
    pos += len
  })
  if (block.length) blocks.push(block)
  return blocks
}
