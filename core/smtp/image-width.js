// SPDX-License-Identifier: GPL-3.0-or-later
// The width a pasted image is shown at in the outgoing message (its bytes never change). Pure: the composer's size
// menu and the main process's send path share it. The width chosen in the menu (the img's width attribute) wins, but
// never more than the image's own width (no enlarging; the original may be wider than SHOWN_WIDTH); without a choice
// an image wider than SHOWN_WIDTH gets SHOWN_WIDTH, a narrower one no width at all.

export const SHOWN_WIDTH = 800
/** The size menu's widths, in its order. */
export const IMAGE_SIZES = Object.freeze({ small: 320, medium: 640, large: 800 })

/** An img's width attribute -> the chosen width (a whole number of pixels, 1..99999), or null when there is none. */
export function askedWidth(value) {
  const s = value === null || value === undefined ? '' : String(value)
  return /^[1-9]\d{0,4}$/.test(s) ? Number(s) : null
}

/** natural: the image's own width; asked: its width attribute -> the width attribute it goes out with, or null. */
export function shownWidth(natural, asked) {
  const a = askedWidth(asked)
  if (a !== null) return Math.min(a, natural)
  return natural > SHOWN_WIDTH ? SHOWN_WIDTH : null
}

/** The size menu's checked item: 'small' | 'medium' | 'large' | 'original', or null for a width the menu does not offer. */
export function sizeOf(natural, asked) {
  const w = shownWidth(natural, asked) ?? natural
  if (w >= natural) return 'original'
  for (const [key, width] of Object.entries(IMAGE_SIZES)) if (width === w) return key
  return null
}
