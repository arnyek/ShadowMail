// SPDX-License-Identifier: GPL-3.0-or-later
// The composer's text colour and highlight helpers (the palette itself: core/smtp/text-colors.js). Pure DOM, no React:
// the composer page uses them, test/compose-colors-ui.test.js measures them on jsdom.
//
// The colouring itself is the editor's native foreColor / hiliteColor (styleWithCSS off): MEASURED (Electron 45.3.0), with
// the composer page's free style attribute it is clean in the nested cases too (a colour around a bold, part of a word,
// the start or end of a paragraph, a list item, a quote), and one Ctrl+Z takes it back.

// the inline elements whose formatting a copied piece keeps when it is cut out of the middle of one
const INLINE_FORMAT = new Set(['FONT', 'SPAN', 'B', 'STRONG', 'I', 'EM', 'U', 'S'])
const BLOCK = /^(P|DIV|LI|UL|OL|BLOCKQUOTE|PRE|H1|H2|H3)$/

const elementOf = node => (node && node.nodeType === 3 ? node.parentElement : node)

/**
 * The HTML of a selection in the editor `root`: its contents, and around them a shallow copy of every font / span / b /
 * strong / i / em / u / s it sits in (up to its block), so a piece of one coloured or bold word keeps its colour and
 * weight. Not sanitized: the caller passes it through sanitizeCompose.
 */
export function selectionHtml(range, root) {
  const doc = root.ownerDocument
  let piece = range.cloneContents()
  for (let el = elementOf(range.commonAncestorContainer); el && el !== root && !BLOCK.test(el.nodeName); el = el.parentElement) {
    if (!INLINE_FORMAT.has(el.nodeName)) continue
    const copy = el.cloneNode(false)
    copy.append(piece)
    piece = doc.createDocumentFragment()
    piece.append(copy)
  }
  const box = doc.createElement('div')
  box.append(piece)
  return box.innerHTML
}

/**
 * The colour the selected text has without any text colour ("Automatikus"): the computed colour of the element around the
 * outermost coloured font the selection sits in, or of the selection's own element (a quote's grey stays grey).
 */
export function plainColorAt(range, root) {
  const start = elementOf(range.commonAncestorContainer)
  let base = start && root.contains(start) ? start : root
  for (let el = base; el && el !== root; el = el.parentElement) if (el.nodeName === 'FONT' && el.hasAttribute('color')) base = el.parentElement
  return root.ownerDocument.defaultView.getComputedStyle(base).color
}
