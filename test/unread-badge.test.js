// SPDX-License-Identifier: GPL-3.0-or-later
// The taskbar badge drawing (core/unread-badge.js): checked pixel by pixel, and the approved images byte for byte.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { badgeText, badgeBitmap, badgeBitmaps, badgeLayout, BADGE_SIZES, BADGE_GLYPHS, BADGE_DISC, DIGIT_RATIO } from '../core/unread-badge.js'

const px = (bmp, x, y) => [...bmp.buffer.subarray((y * bmp.width + x) * 4, (y * bmp.width + x) * 4 + 4)]
const isClear = p => p[3] === 0
// the share of white in an opaque pixel (0 = the disc's red, 1 = white), from the green channel (the widest range)
const inkShare = p => (p[1] - BADGE_DISC[1]) / (0xff - BADGE_DISC[1])
// a pixel that reads as ink: at least half white
const isInk = p => p[3] === 255 && inkShare(p) >= 0.5

test('the text: nothing for 0 and less, the number up to 99, "99+" above', () => {
  assert.deepEqual([0, -3, NaN, 1, 9, 10, 99, 100, 12345].map(badgeText), ['', '', '', '1', '9', '10', '99', '99+', '99+'])
})

test('0: no badge at all', () => {
  assert.equal(badgeBitmap(0, 16), null)
  assert.equal(badgeBitmaps(0), null)
})

test('every size: square BGRA, the corners transparent, the disc #E90A3F and opaque, every pixel on the line from that red to white, inside the disc', () => {
  assert.deepEqual(BADGE_DISC, [0x3f, 0x0a, 0xe9, 0xff], '#E90A3F, BGRA')
  for (const n of [1, 9, 10, 42, 99, 100, 12345]) {
    const all = badgeBitmaps(n)
    assert.deepEqual(all.map(b => [b.width, b.height]), BADGE_SIZES.map(s => [s, s]))
    for (const b of all) {
      assert.equal(b.buffer.length, b.width * b.height * 4)
      const last = b.width - 1
      for (const [x, y] of [[0, 0], [last, 0], [0, last], [last, last]]) assert.ok(isClear(px(b, x, y)), `${n} ${b.width}: corner ${x},${y}`)
      assert.deepEqual(px(b, 0, Math.floor(b.height / 2)), BADGE_DISC, `${n} ${b.width}: the disc's edge is the pure red`)
      let ink = 0
      for (let y = 0; y < b.height; y++) {
        for (let x = 0; x < b.width; x++) {
          const p = px(b, x, y)
          const dx = x + 0.5 - b.width / 2
          const dy = y + 0.5 - b.height / 2
          const inDisc = dx * dx + dy * dy <= (b.width / 2) ** 2
          if (!inDisc) {
            assert.deepEqual(p, [0, 0, 0, 0], `${n} ${b.width}: ${x},${y} outside the disc is transparent`)
            continue
          }
          assert.equal(p[3], 255, `${n} ${b.width}: ${x},${y} no partial alpha inside the disc`)
          // a blend of the red and the white: every channel says the same share (within the rounding)
          const c = inkShare(p)
          for (let i = 0; i < 3; i++) assert.ok(Math.abs(p[i] - (BADGE_DISC[i] * (1 - c) + 255 * c)) <= 1, `${n} ${b.width}: ${x},${y} ${p}`)
          if (isInk(p)) ink++
        }
      }
      assert.ok(ink > 0, `${n} ${b.width}: no digit pixels`)
    }
  }
})

test('the digits are drawn: every digit differs from every other at every size; "99+" is the same above 99 and fits the disc', () => {
  for (const size of BADGE_SIZES) {
    const seen = new Map()
    for (let d = 0; d <= 9; d++) {
      if (d === 0) continue // 0 is no badge; "10" carries the 0
      const key = createHash('sha256').update(badgeBitmap(d, size).buffer).digest('hex')
      assert.ok(!seen.has(key), `${size} px: ${d} looks like ${seen.get(key)}`)
      seen.set(key, d)
    }
    assert.notDeepEqual(badgeBitmap(10, size).buffer, badgeBitmap(11, size).buffer)
    assert.deepEqual(badgeBitmap(100, size).buffer, badgeBitmap(12345, size).buffer, '"99+" for every number above 99')
  }
  assert.throws(() => badgeBitmap(5, 18), RangeError)
})

// the ink pixels of a bitmap (at least half white): [[x, y]]
const inkOf = b => {
  const out = []
  for (let y = 0; y < b.height; y++) for (let x = 0; x < b.width; x++) if (isInk(px(b, x, y))) out.push([x, y])
  return out
}
// every pixel touched by the pen (any white in it)
const touchedOf = b => {
  const out = []
  for (let y = 0; y < b.height; y++) for (let x = 0; x < b.width; x++) if (px(b, x, y)[3] === 255 && inkShare(px(b, x, y)) > 0) out.push([x, y])
  return out
}
const extent = (pts, i) => Math.max(...pts.map(p => p[i])) - Math.min(...pts.map(p => p[i])) + 1

test('every size: one and two digits are about 56% of the disc\'s height (the earlier pixel font was 31%); "99+" shrinks to fit, never below the earlier 5/16', () => {
  assert.equal(DIGIT_RATIO, 0.56)
  for (const size of BADGE_SIZES) {
    for (const n of [8, 42, 99]) {
      const ratio = extent(inkOf(badgeBitmap(n, size)), 1) / size
      assert.ok(ratio >= 0.5 && ratio <= 0.6, `${size} px, ${n}: ${ratio.toFixed(3)}`)
    }
    const plus = inkOf(badgeBitmap(100, size))
    assert.ok(extent(plus, 0) <= Math.ceil(size * 0.8) + 1, `${size} px, 99+: ${extent(plus, 0)} px wide`)
    assert.ok(extent(plus, 1) / size >= 5 / 16, `${size} px, 99+: ${extent(plus, 1)} px high`)
  }
})

test('every size: the text stays inside the disc: every ink pixel of "1", "42", "99+" has its 4 side neighbours in the disc, from 20 px all 8', () => {
  // measured: at 16 px the bottom-right end of the "2" in "42" touches the disc's edge diagonally (one pixel); the
  // approved preview has it so. The side neighbours are always in the disc.
  for (const size of BADGE_SIZES) {
    for (const n of [1, 42, 100]) {
      const b = badgeBitmap(n, size)
      const ink = inkOf(b)
      assert.ok(ink.length > 0)
      const around = size >= 20 ? [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]] : [[0, -1], [-1, 0], [1, 0], [0, 1]]
      for (const [x, y] of ink) {
        for (const [dx, dy] of around) {
          const nx = x + dx
          const ny = y + dy
          assert.ok(nx >= 0 && ny >= 0 && nx < size && ny < size && !isClear(px(b, nx, ny)), `${size} px, ${n}: ${x},${y} has no edge at ${nx},${ny}`)
        }
      }
      // and every pixel the pen touches at all is in the disc (no white outside)
      for (const [x, y] of touchedOf(b)) assert.ok(!isClear(px(b, x, y)))
    }
  }
})

test('every size: byte for byte the approved preview (1, 2, 42); "99+" with the thinner plus', () => {
  // sha256 of the BGRA buffers: 1, 2, 42 are the images shown and approved before this code was written (the prototype's
  // output); "99+" differs from the preview only in its plus, which got a thinner pen (with the digits' pen it was a blob)
  const approved = {
    '16:1': '3ee14bdc61a77b1b963063373d4148237b3fc893edd2f13c4bd886394b72bc84',
    '16:2': '89e699d84973eee6b31df76b9ece7d3c91b35c2a8a97dfc7b5aae9e7711d79bc',
    '16:42': '7bf0b0f490c53c046679b62061018f2fec7f41465940fcaa6dded5f3f48aa5bd',
    '16:100': '77215ba694ba0a6dc1a57ced8ec3950aeb0427a9ea920614d7c38faefc3e26fb',
    '20:1': '2d05d3319106bae0d4d39056682d1e1a13b9f57bf5e2e363c7eeeb3250b98ec5',
    '20:2': '22985b5e2653e05b78a9823a59f33df58286913e599e9e7e66a164bf649be421',
    '20:42': '71793bf3b2080b69530ec00b93e317b3d6feffb99d07efc96d33e7e593852f95',
    '20:100': 'f32a96cac8cdb4e1ab4483fff1213dfb4c3ce985800549d3330840ea9c9520b6',
    '24:1': '9d3f4a4debdb4a8a372f4ec2b2bd93925dd330084ae0924165af702b9a26eeae',
    '24:2': 'b16f090aceb01b30b39b0c849fbe3585dff5d3626a150a278ddf0885fea299d3',
    '24:42': 'e7401efa9880d106f8ae2fe3845dcd74b766f7b913832260de9d41ab3e4fa3ff',
    '24:100': '9d3db10fc7616712a5697a10874da005e41d5c2e2b842cc8fda2d3b3cd5daac8',
    '32:1': 'f58cfb5f2013ee6da9c0e0daf6e69bcfc827ee1ae2d375178d775a5af108d29e',
    '32:2': '114846a95eff7b9a494285d5e52489669198cc9f5b7d44770a0a1ee8dbc5ac1d',
    '32:42': '87a4e529259f14e518fc47f7cd31d7f2dda9440f2838f04528e4d1e1e0dd34c0',
    '32:100': '95b82f54b4997d5575f24038bdecb55f01e884a9a63af2c9fa11e918e46110c4',
  }
  for (const [key, hash] of Object.entries(approved)) {
    const [size, n] = key.split(':').map(Number)
    assert.equal(createHash('sha256').update(badgeBitmap(n, size).buffer).digest('hex'), hash, key)
  }
})

test('every size: the "+" of "99+" is a plus, not a dot: ink at least 3 px high and wide, and above and below its bar', () => {
  assert.equal(BADGE_GLYPHS['+'].length, 2, 'two strokes')
  for (const size of BADGE_SIZES) {
    const { segments } = badgeLayout('99+', size)
    const plusSegs = segments.slice(-2) // the last glyph's two strokes
    const xs = plusSegs.flatMap(([a, c]) => [a[0], c[0]])
    const x0 = Math.floor(Math.min(...xs))
    const x1 = Math.ceil(Math.max(...xs))
    const ink = inkOf(badgeBitmap(100, size)).filter(([x]) => x >= x0 && x <= x1 - 1)
    assert.ok(extent(ink, 0) >= 3 && extent(ink, 1) >= 3, `${size} px: ${extent(ink, 0)} x ${extent(ink, 1)}`)
    // the bar: the rows with at least 3 ink pixels; the arms: ink rows above and below them, narrower than the bar
    const perRow = new Map()
    for (const [, y] of ink) perRow.set(y, (perRow.get(y) || 0) + 1)
    const barRows = [...perRow].filter(([, n]) => n >= 3).map(([y]) => y)
    assert.ok(barRows.length >= 1, `${size} px: no bar`)
    const above = [...perRow].filter(([y, n]) => y < Math.min(...barRows) && n < 3)
    const below = [...perRow].filter(([y, n]) => y > Math.max(...barRows) && n < 3)
    assert.ok(above.length >= 1 && below.length >= 1, `${size} px: arms ${above.length} above, ${below.length} below the bar`)
    // a cross, not a blob: from 20 px the ink covers at most 45% of its box (measured: the digits' pen gave 0.52-0.62,
    // the thinner one 0.31-0.40; at 16 px both are the same 3 x 4 cross)
    if (size >= 20) {
      const fill = ink.length / (extent(ink, 0) * extent(ink, 1))
      assert.ok(fill <= 0.45, `${size} px: the plus fills ${fill.toFixed(2)} of its box`)
    }
  }
})

test('the drawing is fast enough for the main process: every count 1..120, all four sizes, median at most 25 ms a call', () => {
  // measured (Linux): median 4 ms, max 6.4 ms; without the per-pixel segment culling the median is ~75 ms. The median,
  // not the max, so a busy machine (the suite runs in parallel) does not make it red.
  const times = []
  for (let n = 1; n <= 120; n++) {
    const t0 = process.hrtime.bigint()
    badgeBitmaps(n)
    times.push(Number(process.hrtime.bigint() - t0) / 1e6)
  }
  times.sort((a, b) => a - b)
  assert.ok(times[60] <= 25, `median ${times[60].toFixed(1)} ms, max ${times[times.length - 1].toFixed(1)} ms`)
})
