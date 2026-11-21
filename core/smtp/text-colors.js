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
