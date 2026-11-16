// SPDX-License-Identifier: GPL-3.0-or-later
// The taskbar icon's unread badge: a red disc with the count in white, drawn here pixel by pixel (no font, no canvas,
// no dependency), so the main process can hand it to Electron (nativeImage.createFromBitmap, BGRA). Pure.
//
//   0          -> no badge (null)
//   1 .. 99    -> the number
//   100 and up -> "99+"

export const BADGE_SIZES = Object.freeze([16, 20, 24, 32])
export const BADGE_MAX = 99

// red disc, white digits (BGRA)
const DISC = [0x26, 0x2b, 0xd6, 0xff]
const INK = [0xff, 0xff, 0xff, 0xff]

// 3 x 5 pixel glyphs, one string per row (16 px, and 32 px doubled)
const GLYPHS_3X5 = {
  0: ['111', '101', '101', '101', '111'],
  1: ['010', '110', '010', '010', '111'],
  2: ['111', '001', '111', '100', '111'],
  3: ['111', '001', '111', '001', '111'],
  4: ['101', '101', '111', '001', '001'],
  5: ['111', '100', '111', '001', '111'],
  6: ['111', '100', '111', '101', '111'],
  7: ['111', '001', '001', '001', '001'],
  8: ['111', '101', '111', '101', '111'],
  9: ['111', '101', '111', '001', '111'],
  '+': ['000', '010', '111', '010', '000'],
}
// 4 x 6 (20 px: 6/20 = 0.30 of the disc)
const GLYPHS_4X6 = {
  0: ['0110', '1001', '1001', '1001', '1001', '0110'],
  1: ['0100', '1100', '0100', '0100', '0100', '1110'],
  2: ['0110', '1001', '0001', '0010', '0100', '1111'],
  3: ['1110', '0001', '0110', '0001', '0001', '1110'],
  4: ['0010', '0110', '1010', '1111', '0010', '0010'],
  5: ['1111', '1000', '1110', '0001', '0001', '1110'],
  6: ['0110', '1000', '1110', '1001', '1001', '0110'],
  7: ['1111', '0001', '0010', '0100', '0100', '0100'],
  8: ['0110', '1001', '0110', '1001', '1001', '0110'],
  9: ['0110', '1001', '1001', '0111', '0001', '0110'],
  '+': ['0110', '0110', '1111', '1111', '0110', '0110'], // arms longer than their width: a plus, not a dot
}
// 5 x 7 (24 px: 7/24 = 0.29 of the disc)
const GLYPHS_5X7 = {
  0: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'],
}
// The glyphs of each size: the digit is 28-34% of the disc's height at every size. A whole-number scale of the 3 x 5
// set gives that only at 16 (5/16) and 32 px (2 x 5/32); at 20 and 24 px it is 5 px (0.25, 0.21) or 10 px (0.50, 0.42),
// and no one set fits both of them (4 x 6: 0.30 / 0.25; 5 x 7: 0.35 / 0.29), so each of the two has its own.
const FACES = Object.freeze({
  16: Object.freeze({ glyphs: GLYPHS_3X5, w: 3, h: 5, scale: 1 }),
  20: Object.freeze({ glyphs: GLYPHS_4X6, w: 4, h: 6, scale: 1 }),
  24: Object.freeze({ glyphs: GLYPHS_5X7, w: 5, h: 7, scale: 1 }),
  32: Object.freeze({ glyphs: GLYPHS_3X5, w: 3, h: 5, scale: 2 }),
})
/** The glyphs of each size (read-only, for the tests). */
export const BADGE_FACES = FACES

/** The badge's text: '' for no badge, the number, or "99+". */
export function badgeText(count) {
  const n = Number.isFinite(count) ? Math.floor(count) : 0
  if (n <= 0) return ''
  return n > BADGE_MAX ? `${BADGE_MAX}+` : String(n)
}

/**
 * The badge of `count` at `size` x `size` px: { width, height, buffer } (BGRA, 4 bytes a pixel, row by row), or null for
 * no badge. Outside the disc every pixel is fully transparent; the text is centered, in the size's glyphs (FACES).
 */
export function badgeBitmap(count, size) {
  const text = badgeText(count)
  if (!text) return null
  if (!BADGE_SIZES.includes(size)) throw new RangeError(`badge size ${size}`)
  const buf = Buffer.alloc(size * size * 4) // transparent
  const put = (x, y, px) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return
    buf.set(px, (y * size + x) * 4)
  }
  // the disc: a pixel belongs to it when its center is inside the circle
  const r = size / 2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - r
      const dy = y + 0.5 - r
      if (dx * dx + dy * dy <= r * r) put(x, y, DISC)
    }
  }
  const { glyphs, w, h, scale } = FACES[size]
  const gap = scale
  const glyphW = w * scale
  const textW = text.length * glyphW + (text.length - 1) * gap
  const textH = h * scale
  const x0 = Math.floor((size - textW) / 2)
  const y0 = Math.floor((size - textH) / 2)
  ;[...text].forEach((ch, i) => {
    const rows = glyphs[ch]
    const gx = x0 + i * (glyphW + gap)
    rows.forEach((row, ry) => {
      for (let rx = 0; rx < w; rx++) {
        if (row[rx] !== '1') continue
        for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) put(gx + rx * scale + sx, y0 + ry * scale + sy, INK)
      }
    })
  })
  return { width: size, height: size, buffer: buf }
}

/** Every size of the badge (BADGE_SIZES order), or null for no badge. */
export function badgeBitmaps(count) {
  if (!badgeText(count)) return null
  return BADGE_SIZES.map(size => badgeBitmap(count, size))
}
