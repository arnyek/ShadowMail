// SPDX-License-Identifier: GPL-3.0-or-later
// core/accounts/orientation.js: every Exif Orientation turned upright, against a plain per-pixel reading of the Exif
// definitions; the size swaps for 5..8; linear (a 12 MP photo well under a second); bad input refused.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { uprightBitmap, uprightSize, ORIENTATIONS } from '../core/accounts/orientation.js'

// the kept (x, y) shown at the upright (u, v), straight from the Exif definitions
const DEFINITION = {
  1: (u, v) => [u, v],
  2: (u, v, w) => [w - 1 - u, v],
  3: (u, v, w, h) => [w - 1 - u, h - 1 - v],
  4: (u, v, w, h) => [u, h - 1 - v],
  5: (u, v) => [v, u],
  6: (u, v, w, h) => [v, h - 1 - u],
  7: (u, v, w, h) => [w - 1 - v, h - 1 - u],
  8: (u, v, w) => [w - 1 - v, u],
}
const numbered = (w, h, offset = 0) => {
  const b = Buffer.alloc(offset + w * h * 4)
  for (let i = 0; i < w * h; i++) b.writeUInt32LE(i * 7 + 1, offset + i * 4)
  return offset ? b.subarray(offset) : b
}

test('every orientation: each upright pixel is the kept one the Exif definition names; 5..8 swap the size', () => {
  for (const [w, h] of [[3, 2], [5, 4], [1, 6], [7, 1]]) {
    const data = numbered(w, h)
    for (const o of ORIENTATIONS) {
      const r = uprightBitmap(data, w, h, o)
      assert.deepEqual({ width: r.width, height: r.height }, uprightSize(w, h, o))
      assert.deepEqual({ width: r.width, height: r.height }, o >= 5 ? { width: h, height: w } : { width: w, height: h }, `${o}`)
      for (let v = 0; v < r.height; v++) {
        for (let u = 0; u < r.width; u++) {
          const [x, y] = DEFINITION[o](u, v, w, h)
          assert.equal(r.data.readUInt32LE((v * r.width + u) * 4), (y * w + x) * 7 + 1, `o=${o} ${w}x${h} (${u},${v})`)
        }
      }
    }
  }
})

test('6 turns the top row to the right column; 8 to the left column; 3 twice is the image again', () => {
  const data = numbered(4, 2)
  const six = uprightBitmap(data, 4, 2, 6)
  for (let x = 0; x < 4; x++) assert.equal(six.data.readUInt32LE((x * 2 + 1) * 4), x * 7 + 1, 'the kept top row is the right column, top down')
  const eight = uprightBitmap(data, 4, 2, 8)
  for (let x = 0; x < 4; x++) assert.equal(eight.data.readUInt32LE((3 - x) * 2 * 4), x * 7 + 1, 'the kept top row is the left column, bottom up')
  const back = uprightBitmap(uprightBitmap(data, 4, 2, 3).data, 4, 2, 3)
  assert.ok(back.data.equals(data))
})

test('a Buffer that does not start at a 4-byte boundary of its memory gives the same result', () => {
  const plain = uprightBitmap(numbered(5, 3), 5, 3, 7)
  const shifted = uprightBitmap(numbered(5, 3, 1), 5, 3, 7)
  assert.ok(plain.data.equals(shifted.data))
})

test('linear: a 4000 x 3000 photo turned in well under a second', () => {
  const big = Buffer.alloc(4000 * 3000 * 4)
  const t0 = performance.now()
  const r = uprightBitmap(big, 4000, 3000, 6)
  const ms = performance.now() - t0
  assert.deepEqual([r.width, r.height], [3000, 4000])
  assert.ok(ms < 1000, `${Math.round(ms)} ms`)
})

test('refused: an orientation outside 1..8, a size that does not fit the data', () => {
  for (const o of [0, 9, -1, 1.5, '6', null]) assert.throws(() => uprightBitmap(numbered(2, 2), 2, 2, o), RangeError, String(o))
  assert.throws(() => uprightBitmap(numbered(2, 2), 3, 2, 1), RangeError)
  assert.throws(() => uprightBitmap(Buffer.alloc(0), 0, 0, 1), RangeError)
})
