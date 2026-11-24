// SPDX-License-Identifier: GPL-3.0-or-later
// A Content-ID and a cid: reference as one key (core/mime/cid.js), shared by the reader and the composer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cidKey, cidRefsIn, cidResolver, imgCidRefsIn, mapImgCidSrc } from '../core/mime/cid.js'
import { retryWhenLoaded } from './helpers/load-retry.js'

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

test('imgCidRefsIn: only <img src> references, as written; linear on 200 000 references and on 20 000 unclosed <img', async t => {
  assert.deepEqual([...imgCidRefsIn('<img src="cid:A@x"><IMG SRC=cid:b@x><img alt=\'x\' src=\'Cid:c@x\'><td background="cid:d@x"><a href="cid:e@x">cid:f@x</a><div style="background:url(cid:g@x)">')], ['A@x', 'b@x', 'c@x'])
  assert.deepEqual([...imgCidRefsIn('')], [])
  // the whole src value is the cid: URL; one inside another URL is no reference
  assert.deepEqual([...imgCidRefsIn('<img src="https://example.invalid/cid:h@x"><img src="x cid:i@x">')], [])
  // the bracket form, as the frame's sanitizer reads it: cid:<x> in an <img src> (closed or not), nowhere else
  assert.deepEqual([...imgCidRefsIn('<img src="cid:<bg@x>"><img src="cid:<lz@x"><td background="cid:<no@x>">')], ['bg@x', 'lz@x'])
  const time = html => {
    let min = Infinity
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now()
      imgCidRefsIn(html)
      min = Math.min(min, performance.now() - t0)
    }
    return Math.round(min)
  }
  // wall-clock limits: `npm test` runs its files in parallel, so a failure is tried again only on a loaded machine
  await retryWhenLoaded(t, () => {
    // the many references: linear (200 000 at most 6 times 50 000; its absolute time is a quiet machine's question)
    const refs = n => time(Array.from({ length: n }, (_, i) => `<img src="cid:a${i}@x">`).join(''))
    const small = refs(50_000)
    const big = refs(200_000)
    assert.ok(big <= Math.max(small, 1) * 6, `50 000: ${small} ms, 200 000: ${big} ms`)
    const ms = {
      unclosedImg: time(`${'<img src="cid:a@x" '.repeat(20_000)}${'x'.repeat(1000)}`),
      // the bracket pass: unclosed <img src="cid:<, an unclosed quote around cid:<a>, a cid:< run without >
      unclosedBracket: time('<img src="cid:<'.repeat(20_000)),
      unclosedQuote: time(`<img src="${'cid:<a>'.repeat(20_000)}`),
      noClose: time('cid:<'.repeat(20_000)),
      // unclosed quotes: the tag scan stops at the next <, a quoted value never runs to the end
      unclosedQuotes: time('<img a '.repeat(20_000) + '<img a="'.repeat(20_000)),
    }
    assert.ok(Object.values(ms).every(v => v < 500), JSON.stringify(ms))
  })
})

test('mapImgCidSrc (the composer\'s): the bracket pass is not its; an unmapped HTML comes back as it was, only an <img src="cid:x"> is mapped', () => {
  const html = '<img src="cid:<a@x>"><td background="cid:<b@x>"><p>cid:<c@x></p><img src="cid:d@x">'
  assert.equal(mapImgCidSrc(html, () => undefined), html)
  assert.equal(mapImgCidSrc(html, c => `X-${c}`), '<img src="cid:<a@x>"><td background="cid:<b@x>"><p>cid:<c@x></p><img src="X-d@x">')
})
