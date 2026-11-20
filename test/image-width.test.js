// SPDX-License-Identifier: GPL-3.0-or-later
// The outgoing width of a pasted image (core/smtp/image-width.js): the size menu's choice, never more than the image,
// the original even over 800; without a choice 800 for a wider image, nothing for a narrower one.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { askedWidth, shownWidth, sizeOf, SHOWN_WIDTH, IMAGE_SIZES } from '../core/smtp/image-width.js'

test('askedWidth: only a whole number of pixels, 1..99999', () => {
  for (const [v, want] of [['320', 320], [320, 320], ['1', 1], ['99999', 99999]]) assert.equal(askedWidth(v), want, String(v))
  for (const v of [null, undefined, '', '0', '-1', '100000', '50%', '320px', '3.5', ' 320', '0320', 'x']) assert.equal(askedWidth(v), null, String(v))
})

test('shownWidth: the choice at most the image; without one 800 for a wider image', () => {
  assert.equal(SHOWN_WIDTH, 800)
  assert.equal(shownWidth(1600, null), 800)
  assert.equal(shownWidth(800, null), null)
  assert.equal(shownWidth(600, null), null)
  assert.equal(shownWidth(1600, '320'), 320)
  assert.equal(shownWidth(1600, '1600'), 1600, 'the original over 800')
  assert.equal(shownWidth(600, '640'), 600, 'no enlarging')
  assert.equal(shownWidth(1600, 'x'), 800, 'a bad choice is no choice')
})

test('sizeOf: the menu item that is checked now', () => {
  assert.deepEqual(IMAGE_SIZES, { small: 320, medium: 640, large: 800 })
  assert.equal(sizeOf(1600, null), 'large', 'the default for a wide image is the 800 px one')
  assert.equal(sizeOf(600, null), 'original')
  assert.equal(sizeOf(1600, '320'), 'small')
  assert.equal(sizeOf(1600, '640'), 'medium')
  assert.equal(sizeOf(1600, '1600'), 'original')
  assert.equal(sizeOf(640, '640'), 'original', 'the same as its own size: the original')
  assert.equal(sizeOf(1600, '500'), null, 'a width the menu does not offer')
})
