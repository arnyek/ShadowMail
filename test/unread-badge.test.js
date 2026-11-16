// SPDX-License-Identifier: GPL-3.0-or-later
// The taskbar badge drawing (core/unread-badge.js): checked pixel by pixel, not against a snapshot.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { badgeText, badgeBitmap, badgeBitmaps, BADGE_SIZES, BADGE_FACES } from '../core/unread-badge.js'

const px = (bmp, x, y) => [...bmp.buffer.subarray((y * bmp.width + x) * 4, (y * bmp.width + x) * 4 + 4)]
const isWhite = p => p[0] === 255 && p[1] === 255 && p[2] === 255 && p[3] === 255
const isRed = p => p[2] > 0xc0 && p[1] < 0x60 && p[0] < 0x60 && p[3] === 255
const isClear = p => p[3] === 0

test('the text: nothing for 0 and less, the number up to 99, "99+" above', () => {
  assert.deepEqual([0, -3, NaN, 1, 9, 10, 99, 100, 12345].map(badgeText), ['', '', '', '1', '9', '10', '99', '99+', '99+'])
})

test('0: no badge at all', () => {
  assert.equal(badgeBitmap(0, 16), null)
  assert.equal(badgeBitmaps(0), null)
})

test('every size: square BGRA, the corners transparent, the disc red, white digit pixels inside the disc', () => {
  for (const n of [1, 9, 10, 99, 100, 12345]) {
    const all = badgeBitmaps(n)
    assert.deepEqual(all.map(b => [b.width, b.height]), BADGE_SIZES.map(s => [s, s]))
    for (const b of all) {
      assert.equal(b.buffer.length, b.width * b.height * 4)
      const last = b.width - 1
      for (const [x, y] of [[0, 0], [last, 0], [0, last], [last, last]]) assert.ok(isClear(px(b, x, y)), `${n} ${b.width}: corner ${x},${y}`)
      // the disc's edge, left middle: red; the center column has digit pixels or red, nothing transparent
      assert.ok(isRed(px(b, 1, Math.floor(b.height / 2))), `${n} ${b.width}: the disc's edge`)
      let white = 0
      let other = 0
      for (let y = 0; y < b.height; y++) {
        for (let x = 0; x < b.width; x++) {
          const p = px(b, x, y)
          if (isWhite(p)) {
            white++
            const dx = x + 0.5 - b.width / 2
            const dy = y + 0.5 - b.height / 2
            assert.ok(dx * dx + dy * dy <= (b.width / 2) ** 2, `${n} ${b.width}: a white pixel outside the disc`)
          } else if (!isRed(p) && !isClear(p)) other++
        }
      }
      assert.ok(white > 0, `${n} ${b.width}: no digit pixels`)
      assert.equal(other, 0, `${n} ${b.width}: only red, white and transparent pixels`)
    }
  }
})

test('the digits are drawn: "1" and "8" differ, "99+" has the plus and is wider than "9"', () => {
  const whites = b => {
    const xs = []
    for (let y = 0; y < b.height; y++) for (let x = 0; x < b.width; x++) if (isWhite(px(b, x, y))) xs.push(x)
    return { count: xs.length, width: Math.max(...xs) - Math.min(...xs) + 1 }
  }
  assert.notEqual(whites(badgeBitmap(1, 16)).count, whites(badgeBitmap(8, 16)).count)
  assert.ok(whites(badgeBitmap(100, 16)).width > whites(badgeBitmap(9, 16)).width)
  assert.deepEqual(badgeBitmap(100, 16).buffer, badgeBitmap(12345, 16).buffer, '"99+" for every number above 99')
  assert.equal(whites(badgeBitmap(100, 16)).width, 11, '"99+" fits a 16 px disc: 3 glyphs of 3 px and 2 gaps')
  assert.equal(whites(badgeBitmap(100, 32)).width, 22, 'at 32 px the glyphs are doubled')
  assert.throws(() => badgeBitmap(5, 18), RangeError)
})

// the ink (white) pixels of a bitmap: [[x, y]]
const inkOf = b => {
  const out = []
  for (let y = 0; y < b.height; y++) for (let x = 0; x < b.width; x++) if (isWhite(px(b, x, y))) out.push([x, y])
  return out
}

test('every size: the digit is 28-34% of the disc\'s height (an "8" fills its whole glyph height)', () => {
  for (const size of BADGE_SIZES) {
    const ys = inkOf(badgeBitmap(8, size)).map(([, y]) => y)
    const ratio = (Math.max(...ys) - Math.min(...ys) + 1) / size
    assert.ok(ratio >= 0.28 && ratio <= 0.34, `${size} px: ${ratio.toFixed(3)}`)
  }
})

test('every size: every pixel of "1", "42" and "99+" is inside the disc with at least a 1 px edge (its 8 neighbours are disc or ink)', () => {
  for (const size of BADGE_SIZES) {
    for (const n of [1, 42, 100]) {
      const b = badgeBitmap(n, size)
      const ink = inkOf(b)
      assert.ok(ink.length > 0)
      for (const [x, y] of ink) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx
            const ny = y + dy
            assert.ok(nx >= 0 && ny >= 0 && nx < size && ny < size && !isClear(px(b, nx, ny)), `${size} px, ${n}: ${x},${y} has no edge at ${nx},${ny}`)
          }
        }
      }
    }
  }
})

test('16 and 32 px: the bitmap is byte for byte the one before the 20/24 px glyphs (1, 42, 99+)', async () => {
  const { createHash } = await import('node:crypto')
  // sha256 of the BGRA buffers, from the code before the 20/24 px glyphs
  const before = {
    '16:1': '5abf008c0fe19a1e64d957f2d9cedbf8ec6d3480b313d2413f576142828517c2',
    '16:42': 'ba854c7d33a15e411a2bc3f0ff54419035074fb428a6e49148b1409e6d34dc37',
    '16:100': 'cbb478a236c668c032a20484afcaf784ce64b92b4b6c8bdacb7142c602cbe9f7',
    '32:1': '30ca58fc7e347fcfebcc6000cdb6a56385b707c3936b948a063eb83dd84ad45d',
    '32:42': '829582e44eb42c7e8234a1ade2734303a70465c9bffb84a354f444f65f67fd7d',
    '32:100': 'd87cb6280a2e87af8639386337e2f12df89608fed3c472328a8bb612bc7d1873',
  }
  for (const [key, hash] of Object.entries(before)) {
    const [size, n] = key.split(':').map(Number)
    assert.equal(createHash('sha256').update(badgeBitmap(n, size).buffer).digest('hex'), hash, key)
  }
})

test('every size: the "+" is a plus, not a dot: its arms reach beyond the bar at least as far as the bar is thick', () => {
  for (const size of BADGE_SIZES) {
    const { glyphs, w } = BADGE_FACES[size]
    const rows = glyphs['+']
    const full = rows.map((r, i) => (r === '1'.repeat(w) ? i : -1)).filter(i => i >= 0)
    assert.ok(full.length >= 1, `${size} px: a horizontal bar`)
    const thick = full.length
    const above = rows.slice(0, full[0]).filter(r => r.includes('1')).length
    const below = rows.slice(full[full.length - 1] + 1).filter(r => r.includes('1')).length
    assert.ok(above >= thick && below >= thick, `${size} px: arms ${above} / ${below} rows, bar ${thick} rows`)
    // the vertical arm keeps the bar's middle columns, the corners stay empty
    for (const r of [rows[0], rows[rows.length - 1]].filter(r => r.includes('1'))) assert.ok(r[0] === '0' && r[w - 1] === '0', `${size} px: ${r}`)
  }
})
