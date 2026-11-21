// SPDX-License-Identifier: GPL-3.0-or-later
// A Content-ID and a cid: reference as one key (core/mime/cid.js), shared by the reader and the composer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cidKey, cidRefsIn, cidResolver } from '../core/mime/cid.js'

test('cidKey: without < >, %-decoded where it decodes, lower case', () => {
  assert.equal(cidKey('<Logo.A@X>'), 'logo.a@x')
  assert.equal(cidKey('K%C3%A9p@x'), 'kép@x')
  assert.equal(cidKey('bad%E0%A4%A@x'), 'bad%e0%a4%a@x', 'not decodable: as it is')
  assert.equal(cidKey('logo%40sender.invalid'), cidKey('LOGO@sender.invalid'))
})

test('cidRefsIn: every cid: reference of an HTML as written, any case, in < >, anywhere; a longer cid is another one', () => {
  const refs = cidRefsIn('<img src="CID:Logo@X"><td background=\'cid:<bg@x>\'><a href="cid:icon@xy">x</a> cid:text@x <div style="background:url(cid:css@x)">')
  assert.deepEqual([...refs].sort(), ['Logo@X', 'bg@x', 'css@x', 'icon@xy', 'text@x'])
  assert.equal(cidRefsIn('').size, 0)
  assert.equal(cidRefsIn(null).size, 0)
})

test('cidResolver: the Content-ID written the same way wins, then another case or %-encoded; two parts differing only in case each keep theirs', () => {
  const lower = { cid: '<pair@x>' }
  const upper = { cid: 'PAIR@x' }
  const kep = { cid: 'kép@x' }
  const shows = cidResolver([lower, upper, kep, { filename: 'no cid' }])
  assert.equal(shows('pair@x'), lower)
  assert.equal(shows('<PAIR@x>'), upper)
  assert.equal(shows('Pair@X'), lower, 'neither written so: the first by key')
  assert.equal(shows('K%C3%A9p@x'), kep)
  assert.equal(shows('nincs@x'), null)
  // accept leaves parts out: then the key match falls to the next one
  assert.equal(cidResolver([lower, upper], p => p !== lower)('pair@x'), upper)
})

test('cidRefsIn and cidResolver are linear: 200 000 references take at most 6 times 50 000 (best of 3)', () => {
  const best = n => {
    const html = Array.from({ length: n }, (_, i) => `<img src="cid:a${i}@x">`).join('')
    const parts = Array.from({ length: 1000 }, (_, i) => ({ cid: `A${i}@x` }))
    let min = Infinity
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now()
      const shows = cidResolver(parts)
      for (const r of cidRefsIn(html)) shows(r)
      min = Math.min(min, performance.now() - t0)
    }
    return min
  }
  const small = best(50_000)
  const big = best(200_000)
  assert.ok(big <= small * 6, `50 000: ${Math.round(small)} ms, 200 000: ${Math.round(big)} ms`)
})
