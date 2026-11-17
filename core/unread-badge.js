// SPDX-License-Identifier: GPL-3.0-or-later
// The taskbar icon's unread badge: a red disc with the count in white, drawn here pixel by pixel (no font, no canvas,
// no dependency), so the main process can hand it to Electron (nativeImage.createFromBitmap, BGRA). Pure.
//
//   0          -> no badge (null)
//   1 .. 99    -> the number
//   100 and up -> "99+"

export const BADGE_SIZES = Object.freeze([16, 20, 24, 32])
export const BADGE_MAX = 99

// red disc, white digits (BGRA). The red is the one a Windows mail client uses for its badge (#E90A3F): brighter than
// the earlier #D62B26, which looked smaller on a dark taskbar.
const DISC = [0x3f, 0x0a, 0xe9, 0xff]
const INK = [0xff, 0xff, 0xff, 0xff]

// The digit's height as a share of the disc (the earlier 3 x 5 pixel font was 31%, hard to read at 100%), its width as a
// share of its height, the stroke as a share of the height (never thinner than 1.4 px), the gap between two glyphs.
export const DIGIT_RATIO = 0.56
const ASPECT = 0.6
const STROKE = 0.19
const MIN_STROKE = 1.4
const GAP = 0.12
// the widest text may take this share of the disc ("99+" and the two-digit numbers shrink to fit it)
const MAX_TEXT_WIDTH = 0.8
// anti-aliasing: SS x SS samples a pixel
const SS = 5

// The glyphs as stroke centerlines in a unit box (x right, y down): each glyph a list of polylines. Arcs in degrees,
// 0 = right, 90 = down. Drawn with a round pen, so every size comes from the same shapes.
const arc = (cx, cy, rx, ry, a0, a1, n = 24) =>
  Array.from({ length: n + 1 }, (_, i) => {
    const a = ((a0 + ((a1 - a0) * i) / n) * Math.PI) / 180
    return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)]
  })
const SIX = [arc(0.5, 0.5, 0.5, 0.5, 300, 160), arc(0.5, 0.68, 0.5, 0.32, 0, 360)]
const GLYPHS = {
  0: [arc(0.5, 0.5, 0.5, 0.5, 0, 360, 40)],
  1: [[[0.1, 0.22], [0.6, 0], [0.6, 1]]],
  2: [[...arc(0.5, 0.27, 0.5, 0.27, 190, 380), [0, 1], [1, 1]]],
  3: [arc(0.5, 0.25, 0.48, 0.25, 200, 450), arc(0.5, 0.74, 0.5, 0.26, 270, 520)],
  4: [[[0.78, 1], [0.78, 0], [0, 0.7], [1, 0.7]]],
  5: [[[0.95, 0], [0.15, 0], [0.05, 0.47], ...arc(0.5, 0.68, 0.5, 0.32, 235, 500)]],
  6: SIX,
  7: [[[0, 0], [1, 0], [0.35, 1]]],
  8: [arc(0.5, 0.24, 0.42, 0.24, 0, 360), arc(0.5, 0.73, 0.5, 0.27, 0, 360)],
  9: SIX.map(line => line.map(([x, y]) => [1 - x, 1 - y])),
  '+': [[[0.5, 0.1], [0.5, 0.9]], [[0, 0.5], [1, 0.5]]],
}
// the "+" is drawn narrower than a digit, centered in its box
const GLYPH_SCALE = { '+': 1 }
// the "+" with the digits' pen is a blob at these sizes (measured): it gets a thinner one
const GLYPH_STROKE = { '+': 0.6 }
const MIN_PLUS_STROKE = 1
/** The glyph shapes (read-only, for the tests). */
export const BADGE_GLYPHS = Object.freeze(Object.fromEntries(Object.entries(GLYPHS).map(([k, v]) => [k, Object.freeze(v)])))

function segmentDistance(px, py, [ax, ay], [bx, by]) {
  const vx = bx - ax
  const vy = by - ay
  const len2 = vx * vx + vy * vy
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2)) : 0
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy))
}

/** The text's layout at `size`: the digit height h, the stroke, and the segments in pixel coordinates ([a, b, pen radius]). */
export function badgeLayout(text, size) {
  const widthOf = hh => text.length * hh * ASPECT + (text.length - 1) * Math.max(1, hh * GAP)
  let h = Math.round(size * DIGIT_RATIO)
  while (widthOf(h) > size * MAX_TEXT_WIDTH && h > 5) h--
  const stroke = Math.max(MIN_STROKE, h * STROKE)
  const gw = h * ASPECT
  const gap = Math.max(1, h * GAP)
  const x0 = (size - widthOf(h)) / 2
  const y0 = Math.round((size - h) / 2) // a whole pixel: the horizontal strokes stay sharp
  const segments = []
  ;[...text].forEach((ch, i) => {
    const bx = x0 + i * (gw + gap)
    const sc = GLYPH_SCALE[ch] ?? 1
    const pen = GLYPH_STROKE[ch] ? Math.max(MIN_PLUS_STROKE, stroke * GLYPH_STROKE[ch]) : stroke
    for (const line of GLYPHS[ch]) {
      // the centerlines are inset by half a stroke, so the ink fills the glyph box
      const pts = line.map(([u, v]) => [bx + pen / 2 + (u * sc + (1 - sc) / 2) * (gw - pen), y0 + pen / 2 + v * (h - pen)])
      for (let k = 0; k + 1 < pts.length; k++) segments.push([pts[k], pts[k + 1], pen / 2])
    }
  })
  return { h, stroke, width: widthOf(h), segments }
}

/** The badge's text: '' for no badge, the number, or "99+". */
export function badgeText(count) {
  const n = Number.isFinite(count) ? Math.floor(count) : 0
  if (n <= 0) return ''
  return n > BADGE_MAX ? `${BADGE_MAX}+` : String(n)
}

/**
 * The badge of `count` at `size` x `size` px: { width, height, buffer } (BGRA, 4 bytes a pixel, row by row), or null for
 * no badge. Outside the disc every pixel is fully transparent, inside every pixel is opaque (no partial alpha: the edge
 * of the disc is a hard one, so the overlay needs no premultiplied alpha); the text is centered and anti-aliased, each
 * pixel between the red and the white by the share of its samples under the pen.
 */
export function badgeBitmap(count, size) {
  const text = badgeText(count)
  if (!text) return null
  if (!BADGE_SIZES.includes(size)) throw new RangeError(`badge size ${size}`)
  const buf = Buffer.alloc(size * size * 4) // transparent
  const { stroke, segments } = badgeLayout(text, size)
  const half = stroke / 2
  // only the pixels near the text are sampled
  const xs = segments.flatMap(([a, b]) => [a[0], b[0]])
  const ys = segments.flatMap(([a, b]) => [a[1], b[1]])
  const minX = Math.floor(Math.min(...xs) - half)
  const maxX = Math.ceil(Math.max(...xs) + half)
  const minY = Math.floor(Math.min(...ys) - half)
  const maxY = Math.ceil(Math.max(...ys) + half)
  const boxes = segments.map(([a, b, r]) => ({
    a,
    b,
    r,
    x0: Math.min(a[0], b[0]) - r,
    x1: Math.max(a[0], b[0]) + r,
    y0: Math.min(a[1], b[1]) - r,
    y1: Math.max(a[1], b[1]) + r,
  }))
  const r = size / 2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // the disc: a pixel belongs to it when its center is inside the circle
      const dx = x + 0.5 - r
      const dy = y + 0.5 - r
      if (dx * dx + dy * dy > r * r) continue
      let hit = 0
      if (x >= minX && x <= maxX && y >= minY && y <= maxY) {
        // the segments whose pen can reach this pixel
        const near = boxes.filter(bx => bx.x0 <= x + 1 && bx.x1 >= x && bx.y0 <= y + 1 && bx.y1 >= y)
        if (near.length) {
          for (let sy = 0; sy < SS; sy++) {
            for (let sx = 0; sx < SS; sx++) {
              const px = x + (sx + 0.5) / SS
              const py = y + (sy + 0.5) / SS
              for (const bx of near) {
                if (segmentDistance(px, py, bx.a, bx.b) <= bx.r) {
                  hit++
                  break
                }
              }
            }
          }
        }
      }
      const c = hit / (SS * SS)
      const o = (y * size + x) * 4
      for (let i = 0; i < 3; i++) buf[o + i] = Math.round(DISC[i] * (1 - c) + INK[i] * c)
      buf[o + 3] = 0xff
    }
  }
  return { width: size, height: size, buffer: buf }
}

/** The disc's color (BGRA), for the tests. */
export const BADGE_DISC = Object.freeze([...DISC])

/** Every size of the badge (BADGE_SIZES order), or null for no badge. */
export function badgeBitmaps(count) {
  if (!badgeText(count)) return null
  return BADGE_SIZES.map(size => badgeBitmap(count, size))
}
