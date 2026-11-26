// The links of a plain-text message (core/mime/linkify.js): what is a link, where it ends, which schemes never are,
// the cap, linear time on hostile bodies, and the cut to the reader's blocks.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { linkify, linkRuns, MAX_LINKS } from '../core/mime/linkify.js'
import { textBlocks } from '../core/mime/text-blocks.js'
import { retryWhenLoaded } from './helpers/load-retry.js'

const hrefs = text => linkify(text).map(l => l.href)
const shown = text => linkify(text).map(l => text.slice(l.start, l.end))

test('the card\'s examples', () => {
  assert.deepEqual(hrefs('Nezd meg: https://a.example/x.'), ['https://a.example/x'], 'the full stop is not part of it')
  assert.deepEqual(hrefs('(lásd https://a.example/x_(y))'), ['https://a.example/x_(y)'], 'the inner bracket stays, the outer one not')
  assert.deepEqual(hrefs('<https://a.example>'), ['https://a.example'])
  assert.deepEqual(hrefs('www.a.example/b,'), ['https://www.a.example/b'])
  assert.deepEqual(hrefs('info@example.com.'), ['mailto:info@example.com'])
  for (const s of ['javascript:alert(1)', 'file:///c:/x', 'ftp://a.example', 'data:text/html,<b>x</b>']) assert.deepEqual(hrefs(s), [], s)
})

test('ends, words around, and the text itself unchanged', () => {
  assert.deepEqual(shown('Lásd: https://a.example/p?q=1&r=2#h! Vagy?'), ['https://a.example/p?q=1&r=2#h'])
  assert.deepEqual(shown('"https://a.example/x" és \'www.b.example\''), ['https://a.example/x', 'www.b.example'])
  assert.deepEqual(shown('[https://a.example/x] {https://b.example/y}'), ['https://a.example/x', 'https://b.example/y'])
  assert.deepEqual(hrefs('HTTPS://A.example/X'), ['HTTPS://A.example/X'], 'any case of the scheme')
  assert.deepEqual(hrefs('xhttps://a.example nohttp://b.example'), [], 'inside a word: not a link')
  assert.deepEqual(hrefs('awww.a.example x.www.b.example'), [], '"www." inside a word or a host')
  assert.deepEqual(hrefs('http:// semmi, www. sem, www.x sem'), [], 'nothing after the scheme, "www." without a dot')
  assert.deepEqual(hrefs('írj: anna.kovacs+munka@pelda.example.org, köszi'), ['mailto:anna.kovacs+munka@pelda.example.org'])
  assert.deepEqual(hrefs('nem cím: a@b, a@b.c, @x.example, x@.example, x@a..example'), [], 'a domain with a dot and a 2-letter top part')
  assert.deepEqual(hrefs('https://user@host.example/x'), ['https://user@host.example/x'], 'no e-mail inside a web address')
  assert.deepEqual(hrefs('a@x.example@y.example'), ['mailto:a@x.example'], 'one address, the next @ starts nothing new')
  assert.deepEqual(hrefs('mailto:anna@example.org'), ['mailto:anna@example.org'], 'a written mailto: gives the address')
  // a letter or digit of any script before it: the address would be a word's tail, no link (not "cs.anna@...")
  assert.deepEqual(hrefs('kovács.anna@example.com, ő@a.example, 名a@b.example'), [])
  assert.deepEqual(hrefs('áhttps://a.example őwww.b.example'), [])
  assert.deepEqual(hrefs('Írj: anna@example.com, (b@c.example) „d@e.example”'), ['mailto:anna@example.com', 'mailto:b@c.example', 'mailto:d@e.example'])
  const text = 'Első https://a.example/x.\nmásik sor: www.b.example és c@d.example.'
  for (const l of linkify(text)) assert.ok(l.start < l.end && l.end <= text.length)
})

test('at most 1000 links; the rest stays text', () => {
  const text = Array.from({ length: MAX_LINKS + 1 }, (_, i) => `https://a${i}.example/`).join(' ')
  assert.equal(linkify(text).length, MAX_LINKS)
  const mails = Array.from({ length: MAX_LINKS + 1 }, (_, i) => `m${i}@x.example`).join(' ')
  assert.equal(linkify(mails).length, MAX_LINKS)
  // web and e-mail together: still 1000, the first ones in text order
  const mixed = Array.from({ length: 600 }, (_, i) => `https://w${i}.example/ m${i}@x.example`).join(' ')
  const got = linkify(mixed)
  assert.equal(got.length, MAX_LINKS)
  assert.ok(got.every((l, i) => i === 0 || got[i - 1].start < l.start), 'in text order')
})

// a ratio, not an absolute time (a loaded machine stretches both sizes alike): 4x the input must take about 4x
// the time; a quadratic scan takes 16x. Retried only when the machine measures loaded (load-retry.js).
test('linear: 1 MiB hostile bodies take about 4x the time of 256 KiB ones', async t => {
  const bodies = n => ({
    'http:// + a. ...': `http://${'a.'.repeat(n / 2)}`,
    '@ ...': '@'.repeat(n),
    'a@ ...': 'a@'.repeat(n / 2),
    'a. ... @': `${'a.'.repeat(n / 2)}@`,
    'www. ...': 'www.'.repeat(n / 4),
    'brackets': `https://x.example/${')'.repeat(n)}`,
    'trailing marks': `https://x.example/${'.,;:'.repeat(n / 4)}`,
    'http: ...': 'http:'.repeat(n / 5),
    // no link on any round, each round a search for every kind (a search to the end on every round was quadratic)
    'xhttp:// ...': 'xhttp://'.repeat(n / 8),
    'http:// + space ...': 'http:// '.repeat(n / 8),
    'www.x + space ...': 'www.x '.repeat(Math.floor(n / 6)),
    'awww.a.b + space ...': 'awww.a.b '.repeat(Math.floor(n / 9)),
    // valid links up to the cap
    'http://a.b + space ...': 'http://a.b '.repeat(Math.floor(n / 11)),
  })
  const small = bodies(256 * 1024)
  const big = bodies(1024 * 1024)
  const best = s => {
    let b = Infinity
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now()
      linkify(s)
      b = Math.min(b, performance.now() - t0)
    }
    return b
  }
  await retryWhenLoaded(t, () => {
    for (const name of Object.keys(small)) {
      const a = best(small[name])
      const b = best(big[name])
      // under 20 ms the ratio is timer noise; a quadratic 1 MiB scan is far above that
      if (b < 20) continue
      assert.ok(b / a < 8, `${name}: 256 KiB ${a.toFixed(0)} ms, 1 MiB ${b.toFixed(0)} ms (x${(b / a).toFixed(1)})`)
    }
  })
})

test('the runs per block join to the block; a link across a block boundary is in both, to one href', () => {
  // no space before the address: the block cut (every 1000 code points) falls inside it
  const long = `${'-'.repeat(990)}https://hosszu.example/${'p'.repeat(40)} ${'y '.repeat(1200)}`
  const text = `elso sor\n${long}\nutolso c@d.example`
  const blocks = textBlocks(text)
  assert.ok(blocks.length > 2, 'the long line is cut')
  const runs = linkRuns(blocks, linkify(text))
  assert.equal(runs.length, blocks.length)
  runs.forEach((r, i) => assert.equal(r.map(x => x.text).join(''), blocks[i], `block ${i}`))
  const linked = runs.flat().filter(r => r.href)
  const href = `https://hosszu.example/${'p'.repeat(40)}`
  const pieces = linked.filter(r => r.href === href)
  assert.equal(pieces.length, 2, 'cut in two')
  assert.equal(pieces.map(p => p.text).join(''), href, 'the pieces make the address')
  assert.ok(linked.some(r => r.href === 'mailto:c@d.example'))
  assert.deepEqual(linkRuns(['abc'], []), [[{ text: 'abc' }]])
})
