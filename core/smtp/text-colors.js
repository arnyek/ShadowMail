// SPDX-License-Identifier: GPL-3.0-or-later
// The composer's colours: a fixed palette for the text colour and one for the highlight (the text's background).
// Pure, and the ONE place they are written: the composer's toolbar, its sanitizer (sanitize.js sanitizeCompose), the main
// process's mirror (visible-text.js visibleComposeHtml) and the composer page's policy (compose.html) all read them here.
//
// What the editor writes, MEASURED (Electron 45.3.0, styleWithCSS off): foreColor writes <font color="#rrggbb">, an
// attribute, which style-src 'self' does not touch; hiliteColor always writes the inline style
// "background-color: rgb(r, g, b);" (on a span, or on the font), which shows only when that exact text's hash is in
// the page's style-src. So a highlight is kept by its exact style text, and compose.html allows exactly these texts
// (test/compose-csp.test.js holds it to this list).
//
// Text colours: at least 5:1 against white. Highlights: black text on them at least 13:1.

const rgbStyle = hex => {
  const n = parseInt(hex.slice(1), 16)
  return `background-color: rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255});`
}

/** The text colours, in the menu's order: { id, hex } (hex: lower case, as the editor writes it). */
export const TEXT_COLORS = Object.freeze(
  [
    { id: 'red', hex: '#c62828' },
    { id: 'orange', hex: '#bf360c' },
    { id: 'green', hex: '#2e7d32' },
    { id: 'blue', hex: '#1565c0' },
    { id: 'purple', hex: '#6a1b9a' },
    { id: 'gray', hex: '#616161' },
  ].map(c => Object.freeze(c)),
)

/** The highlights, in the menu's order: { id, hex, style } (style: the exact inline style the editor writes for it). */
export const HIGHLIGHT_COLORS = Object.freeze(
  [
    { id: 'yellow', hex: '#fff59d' },
    { id: 'green', hex: '#c8e6c9' },
    { id: 'blue', hex: '#bbdefb' },
    { id: 'pink', hex: '#f8bbd0' },
    { id: 'orange', hex: '#ffe0b2' },
    { id: 'gray', hex: '#e0e0e0' },
  ].map(c => Object.freeze({ ...c, style: rgbStyle(c.hex) })),
)

const TEXT_HEXES = new Set(TEXT_COLORS.map(c => c.hex))
const HIGHLIGHT_STYLES = new Set(HIGHLIGHT_COLORS.map(c => c.style))

/** Whether a font's color attribute is a palette text colour, written exactly as the editor writes it. */
export const isTextColor = value => typeof value === 'string' && TEXT_HEXES.has(value)

/** Whether a style attribute is exactly one palette highlight, written exactly as the editor writes it. */
export const isHighlightStyle = value => typeof value === 'string' && HIGHLIGHT_STYLES.has(value)

/**
 * The composer's "Automatic" text colour: a marker, not a colour. The editor writes it with its own command (a
 * <font color="#010203">, one undo step), the editor's CSS shows that text in the colour around it (app.css), and the
 * sanitizer and the mirror (rich-style.js) always take it off, so it never goes out: "Automatic" means "no colour of its
 * own". Not in the palette (test/text-colors.test.js).
 */
export const AUTO_COLOR = '#010203'
// opaque only (the editor writes the marker opaque; a see-through rgb(1, 2, 3) is some other colour, and a transparent
// one the hidden-text rule's)
const AUTO_RGB = /^rgba?\(\s*0*1(?:\.0*)?\s*[,\s]\s*0*2(?:\.0*)?\s*[,\s]\s*0*3(?:\.0*)?\s*(?:[,/]\s*(?:1(?:\.0*)?|100(?:\.0*)?%)\s*)?\)$/
/** Whether a colour value is the "Automatic" marker, in any case or form: the hex (with an opaque alpha too), rgb(1, 2, 3), rgba(...). */
export const isAutoColor = value => {
  if (typeof value !== 'string') return false
  const v = value.trim().toLowerCase()
  return v === AUTO_COLOR || v === `${AUTO_COLOR}ff` || AUTO_RGB.test(v)
}
