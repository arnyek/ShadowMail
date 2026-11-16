// SPDX-License-Identifier: GPL-3.0-or-later
// A <pre> drawn in blocks (core/mime/text-blocks.js) copies its TEXT, not its layout: the
// browser's own copy puts a line break at every block boundary (a link copied from a long line would come out
// broken). Only when the whole selection is inside this <pre>; anything else keeps the browser's copy.

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** The end of the grapheme cluster that holds offset `off` (off itself on a boundary). */
function clusterEnd(data, off) {
  for (const { index, segment } of segmenter.segment(data)) {
    if (index === off) return off
    if (index + segment.length > off) return index + segment.length
  }
  return data.length
}

/** A range boundary inside a character (a surrogate pair, a flag, an emoji sequence) moves to its end, as the browser's own copy did. */
function widen(range) {
  const r = range.cloneRange()
  const s = r.startContainer
  // the start moves FORWARD to the next boundary, the end forward too: what the browser's copy did (measured)
  if (s.nodeType === 3 && r.startOffset > 0 && r.startOffset < s.data.length) r.setStart(s, clusterEnd(s.data, r.startOffset))
  const e = r.endContainer
  if (e.nodeType === 3 && r.endOffset > 0 && r.endOffset < e.data.length) r.setEnd(e, clusterEnd(e.data, r.endOffset))
  return r
}

/**
 * onCopy of a blocked <pre>: the selected text as it is in the DOM (Range.cloneContents().textContent). A selection that
 * runs to the end of the <pre> leaves its last line break out, as the browser's own copy did (measured);
 * a boundary inside a character (pair, flag, emoji sequence) moves to its end, as there; nothing left to copy -> the browser's own copy (it did
 * not write).
 */
export function copyAsText(event) {
  const sel = window.getSelection()
  if (!sel || !sel.rangeCount || sel.isCollapsed) return
  const pre = event.currentTarget
  if (!pre.contains(sel.getRangeAt(0).commonAncestorContainer)) return
  const range = widen(sel.getRangeAt(0))
  let text = range.cloneContents().textContent
  const rest = document.createRange()
  rest.setStart(range.endContainer, range.endOffset)
  rest.setEnd(pre, pre.childNodes.length)
  if (rest.toString() === '') text = text.replace(/\r?\n$/, '')
  // nothing left (e.g. only the last line break): the browser's own copy, which did not write either
  if (!text) return
  event.preventDefault()
  event.clipboardData.setData('text/plain', text)
}
