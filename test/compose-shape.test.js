// the composer page's shape check (app/renderer/src/compose-shape.js), measured on
// what the composer will hold: the real sanitizeCompose (DOMPurify) in jsdom, then the inert template. jsdom's parser is
// parse5 (HTML5); this Chromium differs from it inside <select>: that case is measured in the app
// (test/e2e/reply-blocks-e2e.mjs --cases).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import createDOMPurify from 'dompurify'
import { sanitizeCompose, COMPOSE_TAGS } from '../app/renderer/src/sanitize.js'
import { SHAPE_LIMIT, SWITCH_LIMIT, SHAPE_BLOCKS, longestRun, shapeOf, directionClass, DIRECTION, UNICODE_VERSION } from '../app/renderer/src/compose-shape.js'
import { quoteHtml as quoteWith } from '../core/smtp/compose.js'
import { hu } from '../app/renderer/i18n/hu.js'
// the outgoing quote in Hungarian, as before the words became a parameter
const quoteHtml = o => quoteWith(o, hu.outgoingQuote, 'hu-HU')
import { newsletterHtml } from './helpers/newsletter.js'
import { newsTableHtml } from './helpers/bomb-samples.js'

const { window } = new JSDOM('')
const purify = createDOMPurify(window)
const shape = html => shapeOf(window.document, sanitizeCompose(purify, html)).longest
const cp = n => String.fromCodePoint(n)
const MB2 = 2 * 1024 * 1024
const fill = (unit, bytes) => unit.repeat(Math.floor(bytes / Buffer.byteLength(unit)))
const timed = fn => {
  const t0 = performance.now()
  const r = fn()
  return { r, ms: performance.now() - t0 }
}

test('shape: the boundaries are the block elements the composer keeps, derived from COMPOSE_TAGS', () => {
  // if COMPOSE_TAGS changes, this list must be looked at again (the derivation follows it)
  assert.deepEqual([...SHAPE_BLOCKS], ['p', 'br', 'div', 'ul', 'ol', 'li', 'blockquote', 'pre', 'h1', 'h2', 'h3'])
  assert.ok(SHAPE_BLOCKS.every(t => COMPOSE_TAGS.includes(t)))
  assert.equal(SHAPE_LIMIT, 40_000)
})

test('shape: the basics on the sanitized DOM: tags, boundaries, references and surrogate pairs', () => {
  assert.equal(shape('abc'), 3)
  assert.equal(shape('<p>abc</p><p>de</p>'), 3)
  assert.equal(shape('ab<b>cd</b>ef'), 6, 'an inline tag is no boundary')
  assert.equal(shape('ab<br>cd'), 2)
  assert.equal(shape('<p>xx</p>yyy'), 3, 'the end of a block is a boundary too')
  assert.equal(shape('aaaa<div>b</div>cc'), 4)
  for (const tag of SHAPE_BLOCKS) assert.equal(shape(`xxxx<${tag}>yy</${tag}>zz`), 4, tag)
  assert.equal(shape('a&amp;b&#x5d0;c&#1488;d'), 7)
  assert.equal(shape(`${cp(0x1f600)}${cp(0x1f600)}`), 2)
  const frag = window.document.createElement('template')
  frag.innerHTML = `<p>${'é'.repeat(5)}</p>x${cp(0x1f600)}y`
  assert.deepEqual(longestRun(frag.content), { longest: 5, total: 8, switches: 0 })
})

test('shape: what the sanitizer joins is one run; what it drops is nothing', () => {
  const big = 'x'.repeat(100_000)
  const cases = {
    'td cells': [`<table><tr>${Array.from({ length: 100 }, () => `<td>${'x'.repeat(1000)}</td>`).join('')}</tr></table>`, 100_000],
    'hr between': [`${'x'.repeat(1000)}<hr>`.repeat(100), 100_000],
    'h4 / h5 / h6': [`<h4>${'x'.repeat(1000)}</h4><h5>${'x'.repeat(1000)}</h5><h6>${'x'.repeat(1000)}</h6>`, 3000],
    "a quote in an attribute name (<p x'>)": [`<p x'>${big}`, 100_000],
    '<!--> (an empty comment)': [`<!-->${big}-->`, 100_003],
    "<!x '> (a bogus comment)": [`<!x '>${big}'>`, 100_002],
    '<head> in the body': [`<p>a</p><head>${big}`, 100_000],
    '<textarea>: its tags are text': [`<textarea>${'xxxxxxxxx<br>'.repeat(10_000)}</textarea>`, 130_000],
    '<noscript>: the sanitizer keeps its text': [`<noscript>${big}</noscript>after`, 100_005],
    '<style>: dropped': [`<style>${big}</style>ab`, 2],
    '<script>: dropped': [`<script>${big}</script>ab`, 2],
  }
  for (const [name, [html, want]] of Object.entries(cases)) assert.equal(shape(html), want, name)
})

test('shape: ASCII whitespace breaks a run outside a <pre>; other spaces and anything in a <pre> do not', () => {
  for (const ws of [' ', '\t', '\n', '\r']) assert.equal(shape(`aaaa${ws}bb`), 4, JSON.stringify(ws))
  // the form feed is no break (a measured sample: 30 000-character pieces split by it froze the editor)
  assert.equal(shape('aaaa\fbb'), 7, 'form feed')
  assert.equal(shapeOf(window.document, sanitizeCompose(purify, `<p>${Array.from({ length: 3 }, () => 'x'.repeat(30_000)).join('\f')}</p>`)).suspect, true, 'form-feed pieces: suspect')
  for (const cp of [0xa0, 0x2007, 0x202f, 0x200b, 0x2060, 0xfeff, 0x2002, 0x3000]) assert.equal(shape(`aaaa${String.fromCodePoint(cp)}bb`), 7, cp.toString(16))
  assert.equal(shape('<pre>aa bb\ncc</pre>'), 8, 'a pre: nothing breaks')
  assert.equal(shape('<pre>aa <i>b c</i> d</pre>'), 8, 'an inline element in a pre is in the pre')
  assert.equal(shape('<pre>aaa</pre>bb cc'), 3, 'after the pre the rule holds again')
  assert.equal(shape('<pre><pre>a</pre>w w w w w w</pre>q q'), 11, 'nested: the inner end does not close the outer')
  // the "news" table: no p / div / br, the cells dropped: spaced text, so short runs, no question
  const r = shapeOf(window.document, sanitizeCompose(purify, newsTableHtml()))
  const { total } = longestRun(r.fragment)
  assert.ok(total > 125_000 && total < 145_000, `the text of the news table: ${total} characters`)
  assert.ok(!r.suspect && r.longest < 50, `${r.longest}`)
  // the bypasses split by NBSP (not a break) still ask
  const nb = String.fromCodePoint(0xa0)
  const chunk = Array.from({ length: 100 }, () => `x${cp(0x5d0)}`.repeat(5)).join(nb)
  assert.ok(at(`<table><tr>${`<td>${chunk}</td>`.repeat(100)}</tr></table>`).suspect, 'td + NBSP')
  assert.ok(at(`${`${chunk}<hr>`.repeat(100)}`).suspect, 'hr + NBSP')
})

const at = html => shapeOf(window.document, sanitizeCompose(purify, html))

test('shape: the starting body asks for the table rows (tableRows, as Composer.jsx writeBody): spaced cells are no bomb, the bypasses still ask', () => {
  const rows = html => shapeOf(window.document, sanitizeCompose(purify, html, { tableRows: true }))
  // 100 cells of 1000 x: a line of cells one space apart, the longest run is one cell (the joined 100 000 is gone)
  const cells = rows(`<table><tr>${Array.from({ length: 100 }, () => `<td>${'x'.repeat(1000)}</td>`).join('')}</tr></table>`)
  assert.deepEqual([cells.longest, cells.suspect], [1000, false])
  // one cell over N still asks, a cell is no break
  assert.equal(rows(`<table><tr><td>${'x'.repeat(100_000)}</td></tr></table>`).reason, 'run')
  // the NBSP bypass: a row is one block, its direction switches are counted over all its cells
  const nb = String.fromCodePoint(0xa0)
  const chunk = Array.from({ length: 100 }, () => `x${cp(0x5d0)}`.repeat(5)).join(nb)
  assert.equal(rows(`<table><tr>${`<td>${chunk}</td>`.repeat(100)}</tr></table>`).reason, 'switches', 'td + NBSP')
  // the same cells, a row each: no block is over B (what a reader sees as lines is measured as lines)
  assert.equal(rows(`<table>${`<tr><td>${chunk}</td></tr>`.repeat(100)}</table>`).reason, null)
  // the news table: spaced text, short runs, no question
  const news = rows(newsTableHtml())
  assert.ok(!news.suspect && news.longest < 50, `${news.longest}`)
  // a nested table: a line in a line, the text kept, no question (its time is measured in the real app,
  // quote-table-e2e: jsdom's sanitizing of deep nesting is superlinear on either path, 400 levels 19-30 s)
  const deep = rows(`${'<table><tr><td>'.repeat(100)}x${'</td></tr></table>'.repeat(100)}`)
  assert.deepEqual([deep.suspect, deep.fragment.textContent], [false, 'x'])
})

test('shape: normal mail stays under N, the bombs over it; N exactly passes', () => {
  // the 2 MB one-paragraph Hebrew and emoji HTML
  for (const k of [0x5d0, 0x1f600]) assert.ok(shape(`<p>${fill(`x${cp(k)}`, MB2 - 7)}</p>`) > SHAPE_LIMIT, k.toString(16))
  // a real-structure newsletter (many paragraphs and tables), the blocks of a 2 MB plain text quote
  assert.ok(shape(newsletterHtml({ blocks: 3000, rules: 20 })) < 2000)
  assert.ok(shape(quoteHtml({ text: fill(`x${cp(0x5d0)}`, MB2), from: [], date: null })) <= 3000, 'plain text quote')
  // a short text with a 10 MB data: image and a 200 KB <style>: the image and the style are nothing
  const img = `<img src="data:image/png;base64,${'A'.repeat(10 * 1024 * 1024)}">`
  assert.ok(shape(`<style>${'.a{color:red}'.repeat(200 * 1024 / 13)}</style><p>rövid szöveg ${img}</p>`) < 50)
  // N: 40 000 characters pass, 40 002 do not
  const run = n => `<p>${'x'.repeat(n / 2)}${cp(0x5d0).repeat(n / 2)}</p>`
  assert.deepEqual([at(run(40_000)).longest, at(run(40_000)).suspect], [40_000, false])
  assert.equal(at(run(40_002)).suspect, true)
})

test('shape: the counting is linear and iterative (a deep tree does not overflow the stack)', () => {
  // the counter only walks lastChild / previousSibling / nodeType / tagName / data: a plain object tree of 200 000 levels
  // (jsdom's own DOM is too slow to build one; the speed in Chromium is measured by the e2e)
  const el = (tagName, kids) => {
    const n = { nodeType: 1, tagName, lastChild: null, previousSibling: null }
    let prev = null
    for (const k of kids) {
      k.previousSibling = prev
      prev = k
    }
    n.lastChild = prev
    return n
  }
  const txt = data => ({ nodeType: 3, data, previousSibling: null })
  let deep = el('B', [txt('x'.repeat(10))])
  for (let i = 0; i < 200_000; i++) deep = el(i % 1000 ? 'B' : 'SPAN', [deep])
  assert.equal(longestRun(el('#root', [deep])).longest, 10)
  // 2 MB of text in one node; 300 000 alternating block / inline nodes
  const a = timed(() => longestRun(el('#root', [txt(fill(`x${cp(0x1f600)}`, MB2))])))
  assert.ok(a.r.longest > 600_000 && a.ms < 200, `${a.r.longest} in ${a.ms.toFixed(0)} ms`)
  const b = timed(() => longestRun(el('#root', Array.from({ length: 300_000 }, (_, i) => el(i % 2 ? 'B' : 'P', [txt('xy')])))))
  assert.ok(b.r.longest === 2 && b.ms < 500, `${b.r.longest} in ${b.ms.toFixed(0)} ms`)
})

// ---- B: the direction switches of one block -------------------------------------------------------------------------
const switches = html => shapeOf(window.document, sanitizeCompose(purify, html)).switches
const { NEUTRAL, L, R, EN, AN, I, U, E } = DIRECTION

test('switches: the direction classes are the Unicode Bidi_Class (the generated table); unassigned: U; the embedding controls: E', () => {
  assert.equal(UNICODE_VERSION, '15.0.0')
  const cases = [
    [[0x61, 0x5a, 0xe9, 0x436, 0x3b1, 0x4e00, 0x2160, 0x200e, 0x24b6, 0x903, 0x964, 0x13430, 0x966, 0xe000], L, 'letters, a Roman numeral, LRM, a circled letter, a spacing mark, the danda, a format character, a Devanagari digit, private use'],
    [[0x5d0, 0x627, 0x710, 0x780, 0x7c0, 0xfb1d, 0x10800, 0x1e900, 0x200f, 0x61c, 0x5be, 0x5f3], R, 'Hebrew, Arabic (AL), Syriac, Thaana, an NKo digit, presentation forms, the SMP RTL ranges, RLM, ALM, the maqaf, the geresh'],
    [[0x30, 0x39, 0xb2, 0x2070, 0x6f0, 0x6f9, 0xff10], EN, 'ASCII, superscript, Extended Arabic-Indic, fullwidth digits'],
    [[0x660, 0x669, 0x600, 0x605, 0x66b, 0x66c, 0x6dd, 0x890, 0x891, 0x8e2, 0x10d30, 0x10d39, 0x10e60], AN, 'the Arabic number class'],
    [[0x2066, 0x2067, 0x2068, 0x2069], I, 'the isolate controls'],
    [[0x20, 0x2e, 0xa0, 0x3000, 0x200d, 0x301, 0x5b0, 0x64b, 0xfe0f, 0x2014, 0xad, 0x9, 0x1f600, 0x2460, 0x20ac, 0x60c], NEUTRAL, 'spaces, punctuation, ZWJ, non-spacing marks, VS16, a soft hyphen, a tab, emoji, a circled digit (ON), the euro (ET), the Arabic comma (CS)'],
    [[0x202a, 0x202b, 0x202c, 0x202d, 0x202e], E, 'the embedding and override controls'],
    [[0x5c8, 0x7fb, 0x10856, 0x10d40, 0x10d49, 0x378, 0x380, 0x2fffe, 0x40000], U, 'unassigned in Unicode 15.0 (the Garay digits of 16.0 too), in the RTL ranges and elsewhere'],
  ]
  for (const [cps, want, name] of cases) for (const c of cps) assert.equal(directionClass(c), want, `${name}: U+${c.toString(16)}`)
})

test('switches: the table is what the generator writes (python3 -I scripts/gen-bidi-class.py), byte for byte', t => {
  const which = spawnSync('python3', ['-I', '-c', 'import unicodedata; print(unicodedata.unidata_version)'], { encoding: 'utf8' })
  if (which.status !== 0 || which.stdout.trim() !== UNICODE_VERSION) return t.skip(`python3 with Unicode ${UNICODE_VERSION} is not here (${(which.stdout || which.error || '').toString().trim()})`)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-bidi-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const out = path.join(dir, 'bidi-class.js')
  const r = spawnSync('python3', ['-I', fileURLToPath(new URL('../scripts/gen-bidi-class.py', import.meta.url)), out], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.ok(fs.readFileSync(out).equals(fs.readFileSync(fileURLToPath(new URL('../core/mime/bidi-class.js', import.meta.url)))), 'the generated table differs from the committed one')
})

test('switches: counted between neighbouring non-neutral characters, per block; a <br> does not end the block, a <pre> counts', () => {
  const he = cp(0x5d0)
  const table = [
    ['ab', 0], [`a${he}`, 1], [`a ${he} b`, 2, 'spaces are passed over'], [`1${cp(0x662)}`, 1, 'EN -> AN'],
    ['a1a1a1', 0, 'an EN after a strong L is L'], ['1a1', 1, 'an EN before any strong character stays EN'],
    [`${he}1${he}1`, 3, 'an EN after R stays EN'], [`${he}a1`, 1, 'R, L, then the EN is L'], [`a1${he}1`, 2, 'L, L (EN), R, EN'],
    [`a${cp(0x662)}a`, 2, 'an AN is always AN'], [`<p>a1</p><p>1a</p>`, 1, 'the strong character is per block'],
    [`a${cp(0x2067)}b${cp(0x2069)}c`, 4, 'an isolate is +2 on its own, passed over in the class sequence'],
    [`${cp(0x2067)}${cp(0x2069)}`.repeat(3), 12, 'isolates alone, no letter: two each'],
    [`${cp(0x2067)}a${cp(0x2069)}`, 4, '"a" in an RLI ... PDI'],
    [`${he}${cp(0x2067)}${he}`, 2, 'R isolate R: the isolate only'], [`a${cp(0x2067)}${he}`, 3, 'L isolate R: the isolate and the change'],
    [`a${cp(0x202e)}b${cp(0x202c)}c`, 2, 'an embedding control is +1 on its own, passed over in the sequence'],
    [`x${cp(0x202b)}1${cp(0x202c)}`, 3, 'x RLE 1 PDF: +1, the EN stays EN (L -> EN), +1'],
    [`x${cp(0x202a)}1${cp(0x202c)}`, 3, 'x LRE 1 PDF'], [`x${cp(0x202e)}1${cp(0x202c)}`, 3, 'x RLO 1 PDF'],
    [`a${cp(0x202b)}1${cp(0x202c)}a`, 4, 'and back to L after the PDF'],
    [`x${cp(0x10d40)}1`, 3, 'x U+10D40 1: +2, and the EN after it stays EN'],
    [`a${cp(0x2067)}1`, 3, 'an isolate forgets the strong L too: a RLI 1 = +2 and L -> EN'], ['a 1', 0, 'without it the EN after L is L'],
    [`${he}${cp(0x10d40)}${he}`, 2, 'an unassigned code point is +2 on its own'], [`${cp(0x10d40)}`.repeat(3), 6, 'unassigned alone: two each'], [`1${cp(0x662)}1${cp(0x662)}`, 3, 'EN <-> AN'],
    [`<p>a${he}</p><p>a${he}</p>`, 1, 'a new block starts from zero'], [`a${he}<br>a${he}`, 3, 'a <br> is no block end here'],
    [`<pre>a${he}\na${he}</pre>`, 3, 'a <pre> counts on over its line breaks'], [`a<b>${he}</b>a`, 2, 'inline elements are inside the block'],
    [`${cp(0x1f600)}${he}${cp(0x1f600)}a`, 1, 'an emoji is neutral (ON)'],
    [`a${cp(0x301)}${he}${cp(0x5b0)}a`, 2, 'non-spacing marks are passed over'],
  ]
  for (const [html, want, name] of table) assert.equal(switches(html), want, name || html)
})

test('switches: B is the limit; exactly B asks nothing, B + 1 asks with its own reason; N still wins', () => {
  assert.equal(SWITCH_LIMIT, 50_000)
  // spaced words of x + Hebrew: 9 switches in a word, 1 over each space
  const word = `x${cp(0x5d0)}`.repeat(5)
  const words = Array.from({ length: 5000 }, () => word).join(' ') // 49 999
  const at = shapeOf(window.document, sanitizeCompose(purify, `<p>${words} x</p>`))
  assert.deepEqual([at.switches, at.reason, at.suspect], [SWITCH_LIMIT, null, false])
  const over = shapeOf(window.document, sanitizeCompose(purify, `<p>${words} x${cp(0x5d0)}</p>`))
  assert.deepEqual([over.switches, over.reason, over.suspect], [SWITCH_LIMIT + 1, 'switches', true])
  // the same text split into two blocks: neither is over B
  const half = Array.from({ length: 2600 }, () => word).join(' ')
  assert.equal(shapeOf(window.document, sanitizeCompose(purify, `<p>${half}</p><p>${half}</p>`)).reason, null)
  // and with a <br> in the middle: one block, over B
  assert.equal(shapeOf(window.document, sanitizeCompose(purify, `<p>${half}<br>${half}</p>`)).reason, 'switches')
  // an unbroken run over N is reported as 'run' (the older question), even with switches over B
  assert.equal(shapeOf(window.document, sanitizeCompose(purify, `<p>${`x${cp(0x5d0)}`.repeat(30_000)}</p>`)).reason, 'run')
  // one writing system, as large as you like: no switches (the news table and a 2 MB Latin paragraph ask nothing)
  assert.equal(shapeOf(window.document, sanitizeCompose(purify, newsTableHtml())).reason, null)
  assert.equal(shapeOf(window.document, sanitizeCompose(purify, `<p>${Array.from({ length: 200_000 }, () => 'árvíztűrő').join(' ')}</p>`)).reason, null)
})

test('switches: the check stays linear: 4 MB takes at most 2.5 times as long as 2 MB', () => {
  const doc = window.document
  const el = text => {
    const p = doc.createElement('p')
    p.append(doc.createTextNode(text))
    return p
  }
  const sample = n => Array.from({ length: Math.floor(n / 11) }, () => `x${cp(0x5d0)}`.repeat(5)).join(' ')
  const med = text => {
    const root = el(text)
    const ms = []
    for (let i = 0; i < 9; i++) {
      const t0 = performance.now()
      longestRun(root)
      ms.push(performance.now() - t0)
    }
    return ms.sort((a, b) => a - b)[4]
  }
  med(sample(200_000)) // warm up
  const two = med(sample(2 * 1024 * 1024))
  const four = med(sample(4 * 1024 * 1024))
  console.log(`MEASURED the check: 2 MB ${two.toFixed(1)} ms, 4 MB ${four.toFixed(1)} ms, ratio ${(four / two).toFixed(2)}`)
  assert.ok(four / two <= 2.5, `${two} / ${four}`)
})

test('switches: the e2e samples have exactly the number of switches they are made for', async () => {
  const { switchText, SWITCH_KINDS } = await import('./helpers/bomb-samples.js')
  for (const kind of SWITCH_KINDS) {
    for (const n of [1, 2, 9, 10, 11, 1000, SWITCH_LIMIT, SWITCH_LIMIT + 10_000]) {
      const r = shapeOf(window.document, sanitizeCompose(purify, `<p>${switchText(kind, n)}</p>`))
      assert.equal(r.switches, n, `${kind} ${n}`)
      assert.ok(r.longest <= 12, `${kind}: spaced, no long run (${r.longest})`)
    }
  }
})

test('switches: the characters that once passed as neutral now count: each 128 006-character pair asks', async () => {
  const { BYPASS_PAIRS, pairText } = await import('./helpers/bomb-samples.js')
  for (const [name, pair] of Object.entries(BYPASS_PAIRS)) {
    const r = shapeOf(window.document, sanitizeCompose(purify, `<p>${pairText(pair, 128_006)}</p>`))
    assert.equal(r.reason, 'switches', `${name}: ${r.switches} switches`)
  }
})

test('switches: Latin and digits (128 000 characters) ask nothing; Hebrew and digits ask', async () => {
  const { DIGIT_PAIRS, pairText } = await import('./helpers/bomb-samples.js')
  const latin = shapeOf(window.document, sanitizeCompose(purify, `<p>${pairText(DIGIT_PAIRS.LATIN, 128_000)}</p>`))
  assert.deepEqual([latin.switches, latin.reason], [0, null])
  const hebrew = shapeOf(window.document, sanitizeCompose(purify, `<p>${pairText(DIGIT_PAIRS.HEBREW, 128_000)}</p>`))
  assert.equal(hebrew.reason, 'switches', `${hebrew.switches}`)
})
