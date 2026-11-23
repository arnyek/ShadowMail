// SPDX-License-Identifier: GPL-3.0-or-later
// The composer's paste step (core/mime/paste-prepare.js), before the rich sanitizer: hidden text out by the visible-text
// rules (each one), a text the colour of its background stays; an unreadable colour (under 3:1 against the background
// that survives the sanitizer) goes, a readable dark island stays; a table over the cell or depth limit becomes lines; a
// clipboard too complex or over the tag cut is handed back for the old way; the output through the rich sanitizer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import createDOMPurify from 'dompurify'
import { preparePaste, MIN_CONTRAST, MAX_PASTE_CELLS, MAX_PASTE_TABLE_DEPTH, PASTE_TIME_LIMIT_MS } from '../core/mime/paste-prepare.js'
import { contrastRatio, MAX_TAGS, visibleTextInfo, TIME_LIMIT_MS } from '../core/mime/visible-text.js'
import { newsletterHtml } from './helpers/newsletter.js'
import { retryWhenLoaded } from './helpers/load-retry.js'
import { sanitizeCompose } from '../app/renderer/src/sanitize.js'

const purify = createDOMPurify(new JSDOM('').window)
const ready = html => preparePaste(html).html
const paste = html => sanitizeCompose(purify, ready(html), { rich: true })
const text = html => new JSDOM(`<body>${html}</body>`).window.document.body.textContent

test('hidden text goes with its element, rule by rule; the visible text around it stays', () => {
  const hidden = {
    'display: none': '<span style="display: none">REJTETT</span>',
    'the hidden attribute': '<span hidden>REJTETT</span>',
    'visibility: hidden': '<span style="visibility: hidden">REJTETT</span>',
    'opacity: 0': '<span style="opacity: 0">REJTETT</span>',
    'opacity multiplied down under 0.1': '<span style="opacity: 0.3"><span style="opacity: 0.3">REJTETT</span></span>',
    'font-size: 0': '<span style="font-size: 0px">REJTETT</span>',
    'a font under 3 px': '<span style="font-size: 2px">REJTETT</span>',
    'a transparent colour': '<span style="color: transparent">REJTETT</span>',
    'an alpha 0 colour': '<span style="color: rgba(0, 0, 0, 0)">REJTETT</span>',
    'sr-only (absolute, 1 px, clip)': '<span style="position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0px, 0px, 0px, 0px)">REJTETT</span>',
    'zero size, overflow hidden': '<div style="height: 0; overflow: hidden">REJTETT</div>',
    'scale(0)': '<span style="transform: scale(0)">REJTETT</span>',
    'off screen': '<span style="position: absolute; left: -9999px">REJTETT</span>',
    'a closed details': '<details><summary>Cím</summary>REJTETT</details>',
    'a stylesheet class': '<style>.h { display: none }</style><span class="h">REJTETT</span>',
  }
  for (const [name, h] of Object.entries(hidden)) {
    const out = paste(`<p>előtte ${h} utána</p>`)
    assert.ok(!out.includes('REJTETT'), `${name}: ${out}`)
    assert.ok(out.includes('előtte') && out.includes('utána'), name)
  }
  // a script, a template, a comment and the <style> itself: nothing of them
  // (the <style> rule itself is written onto the element: the clipboard's own rules, one rule with the quote)
  assert.equal(ready('<p>a<script>alert(1)</script><template>t</template><!-- c --><style>p{color:red}</style>b</p>'), '<p style="color: red">ab</p>')
})

test('readability: a colour under 3:1 against the background that survives goes, up the chain; if even the default is unreadable there, the background goes; a readable dark island stays', () => {
  // white on the message's white (the background did not come with it): the colour goes, the text stays
  assert.equal(paste('<p><span style="color: rgb(232, 232, 232); font-weight: bold;">világos</span></p>'), '<p><span style="font-weight: bold;">világos</span></p>')
  assert.equal(paste('<p><font color="#ffffff" face="Arial">fehér</font></p>'), '<p><font face="Arial">fehér</font></p>')
  // the same colour as its own background: not hidden here, the colour goes
  assert.equal(paste('<p style="background-color: #ffff00"><span style="color: #ffff00">sárga a sárgán</span></p>'), '<p style="background-color: #ffff00;">sárga a sárgán</p>')
  // a dark page's block: dark background, light text, readable: stays as it was
  const island = '<div style="background-color: rgb(18, 18, 18); color: rgb(232, 232, 232); padding: 8px;">sötét sziget</div>'
  assert.equal(paste(island), island.replace('padding: 8px;"', 'padding: 8px;"'))
  // dark text on a dark background: the text colour goes, and the default dark is unreadable there too: the background goes
  assert.equal(ready('<div style="background-color: #111111"><span style="color: #222222">x</span></div>'), '<div style><span style>x</span></div>')
  // the bgcolor attribute is a background that survives
  assert.equal(ready('<table bgcolor="#000000"><tr><td><font color="#ffffff">fehér a feketén</font></td></tr></table>'), '<table bgcolor="#000000"><tbody><tr><td><font color="#ffffff">fehér a feketén</font></td></tr></tbody></table>')
  // a background from a <style> rule is written onto its element, so it goes into the editor: the light text over it stays
  assert.equal(ready('<style>.d { background: #000 }</style><div class="d"><span style="color: #ffffff">x</span></div>'), '<div class="d" style="background: #000"><span style="color: #ffffff">x</span></div>')
  // an image or a gradient background does not survive the sanitizer: the white text over it would stand on white
  assert.equal(ready('<p style="background-image: url(x.png)"><span style="color: #ffffff">kép</span></p>'), '<p style="background-image: url(x.png)"><span style>kép</span></p>')
  assert.equal(ready('<p><span style="color: var(--c)">v</span></p>'), '<p><span style="color: var(--c)">v</span></p>')
  // the limit on both sides (against white)
  assert.ok(contrastRatio('#949494', '#ffffff') >= MIN_CONTRAST && contrastRatio('#959595', '#ffffff') < MIN_CONTRAST)
  assert.equal(ready('<p><span style="color: #949494">a</span></p>'), '<p><span style="color: #949494">a</span></p>')
  assert.equal(ready('<p><span style="color: #959595">a</span></p>'), '<p><span style>a</span></p>')
  // only the colour declaration goes, the rest of the style stays (the sanitizer cleans it)
  assert.equal(ready('<p><span style="font-size: 14px; COLOR: #fff ; font-weight: 700">a</span></p>'), '<p><span style="font-size: 14px; font-weight: 700">a</span></p>')
  assert.equal(preparePaste('<p><span style="color: #fff">a</span><span style="color: #fff">b</span></p>').faded, 2)
})

const cellsTable = (n, cols = 5) => `<table>${Array.from({ length: Math.ceil(n / cols) }, (_, r) => `<tr>${Array.from({ length: Math.min(cols, n - r * cols) }, (_, c) => `<td>c${r * cols + c}</td>`).join('')}</tr>`).join('')}</table>`
const nested = (levels, inner = 'mag') => {
  let h = inner
  for (let i = 0; i < levels; i++) h = `<table><tr><td>${h}</td><td>s${i}</td></tr></table>`
  return h
}
const tablesIn = html => (html.match(/<table/g) || []).length

test(`a table over ${MAX_PASTE_CELLS} cells or deeper than ${MAX_PASTE_TABLE_DEPTH} tables becomes lines (as tableToLines writes them); within the limits it stays a table`, () => {
  assert.equal(tablesIn(ready(cellsTable(MAX_PASTE_CELLS))), 1)
  const over = preparePaste(cellsTable(MAX_PASTE_CELLS + 1))
  assert.equal(over.lined, 1)
  assert.equal(tablesIn(over.html), 0)
  assert.ok(over.html.startsWith('<div><div>c0 c1 c2 c3 c4</div><div>c5'), over.html.slice(0, 60))
  // the cells of a nested table count into the outer one
  const outer = `<table><tr><td>${cellsTable(MAX_PASTE_CELLS)}</td><td>x</td></tr></table>`
  const r = preparePaste(outer)
  assert.equal(r.lined, 1, 'the outer table (20 001 cells with its nested one) became lines')
  assert.equal(tablesIn(r.html), 1, 'the nested one (20 000) stays a table')
  // depth: 20 tables in tables stay, the 21st and deeper become lines
  assert.equal(tablesIn(ready(nested(MAX_PASTE_TABLE_DEPTH))), MAX_PASTE_TABLE_DEPTH)
  const deep = preparePaste(nested(MAX_PASTE_TABLE_DEPTH + 3))
  assert.equal(tablesIn(deep.html), MAX_PASTE_TABLE_DEPTH)
  assert.equal(deep.lined, 3)
  assert.ok(text(deep.html).includes('mag'), 'the innermost text stays')
  // the shape of the lines: the caption first, a header cell bold, the cells one space apart, no wrapper around a cell (the
  // editor's insertHTML is quadratic in bare spans, MEASURED); through the sanitizer
  const big = `<table><caption>Cím</caption><thead><tr><th>Név</th><th>Db</th></tr></thead><tbody>${Array.from({ length: MAX_PASTE_CELLS / 2 }, (_, i) => `<tr><td>T${i}</td><td>${i}</td></tr>`).join('')}</tbody></table>`
  const lines = paste(big)
  assert.ok(lines.startsWith('<div><div>Cím</div><div><b>Név</b> <b>Db</b></div><div>T0 0</div>'), lines.slice(0, 120))
})

test('too complex or over the tag cut: handed back for the old way (never a part of the clipboard)', () => {
  const cut = preparePaste('<p>a</p>' + '<i>x</i>'.repeat(MAX_TAGS + 1))
  assert.deepEqual(cut, { html: null, plain: true, reason: 'cut' })
  // the time net: a clock past the limit at once
  let t = 0
  const clocks = { cpu: () => null, wall: () => (t += 10_000) }
  assert.deepEqual(preparePaste(`<style>.a{color:red}</style>${'<p class="a">x</p>'.repeat(600)}`, { clocks }), { html: null, plain: true, reason: 'complex' })
  // empty, null: nothing, no throw
  assert.deepEqual(preparePaste(''), { html: '', plain: false, faded: 0, lined: 0 })
  assert.deepEqual(preparePaste(null), { html: '', plain: false, faded: 0, lined: 0 })
})

test('a Chromium copy of a web page through the step and the rich sanitizer: the table grid, colours, lists, headings stay; the noise and the hidden go', () => {
  const copy = '<meta charset="utf-8"><h2 style="color: rgb(32, 33, 36); font-size: 20px; font-weight: 600; margin: 16px 0px 8px; orphans: 2;">Ajánlat</h2>' +
    '<table style="border-collapse: collapse; width: 100%; color: rgb(32, 33, 36);"><tbody><tr><th colspan="2" style="background-color: rgb(238, 238, 238); border: 1px solid rgb(153, 153, 153);">Fej</th></tr>' +
    '<tr><td style="border: 1px solid rgb(153, 153, 153); padding: 2px 6px;">Kazán A</td><td style="text-align: right;">1</td></tr></tbody></table>' +
    '<ul style="margin: 0px; padding-left: 20px;"><li><span style="color: rgb(198, 40, 40);">piros</span> x<sup>2</sup></li></ul>' +
    '<p><span style="font-size: 0px;">preheader</span><span style="position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0px, 0px, 0px, 0px);">csak képernyőolvasó</span>látható <a href="https://example.invalid/" style="color: rgb(26, 13, 171);">link</a></p>'
  const out = paste(copy)
  assert.equal(out,
    '<h2 style="color: rgb(32, 33, 36); font-size: 20px; font-weight: 600; margin: 16px 0px 8px;">Ajánlat</h2>' +
    '<table style="border-collapse: collapse; width: 100%; color: rgb(32, 33, 36);"><tbody><tr><th colspan="2" style="background-color: rgb(238, 238, 238); border: 1px solid rgb(153, 153, 153);">Fej</th></tr>' +
    '<tr><td style="border: 1px solid rgb(153, 153, 153); padding: 2px 6px;">Kazán A</td><td style="text-align: right;">1</td></tr></tbody></table>' +
    '<ul style="margin: 0px; padding-left: 20px;"><li><span style="color: rgb(198, 40, 40);">piros</span> x<sup>2</sup></li></ul>' +
    '<p>látható <a href="https://example.invalid/" style="color: rgb(26, 13, 171);">link</a></p>')
})

test('linear enough: a 1 MB web page copy in well under a second', () => {
  const block = '<p style="margin: 0px 0px 10px; line-height: 1.5; color: rgb(32, 33, 36);">Bekezdés <span style="font-weight: 700;">vastag</span> <span style="font-size: 0px;">rejtett</span> <a href="https://example.invalid/" style="color: rgb(26, 13, 171);">link</a></p>'
  const html = block.repeat(Math.ceil((1024 * 1024) / block.length))
  const runs = []
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now()
    const r = preparePaste(html)
    runs.push(performance.now() - t0)
    assert.equal(r.plain, false)
  }
  assert.ok(Math.min(...runs) < 1000, `best of 3: ${Math.min(...runs)} ms`)
})

test(`the paste's own time net: ${PASTE_TIME_LIMIT_MS} ms (the planner's decision), the reader's filter keeps its ${TIME_LIMIT_MS} ms`, () => {
  assert.equal(PASTE_TIME_LIMIT_MS, 500)
  assert.equal(TIME_LIMIT_MS, 1500)
  // a CPU clock that is 700 ms on at its second look: over the paste's net, under the reader's
  const clockAt = ms => {
    let calls = 0
    return { cpu: () => (calls++ ? ms : 0), wall: () => 0 }
  }
  const html = `<style>.a{color:red}</style>${'<p class="a">x</p>'.repeat(600)}`
  assert.deepEqual(preparePaste(html, { clocks: clockAt(700) }), { html: null, plain: true, reason: 'complex' })
  assert.equal(visibleTextInfo(html, undefined, { clocks: clockAt(700) }).cut, null, 'the reader\'s filter: 1500 ms')
  assert.equal(preparePaste(html, { clocks: clockAt(400) }).plain, false, 'under 500 ms: formatted')
})

test('a stylesheet-heavy newsletter (the reader\'s complex case) falls back within 900 ms', async t => {
  // a wall-clock limit: `npm test` runs its files in parallel, so a failure is tried again only on a machine that
  // measures as loaded (load-retry.js); on a quiet one the first failure stands
  await retryWhenLoaded(t, () => {
    const runs = []
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now()
      const r = preparePaste(newsletterHtml({ blocks: 2000 }))
      runs.push(performance.now() - t0)
      assert.equal(r.plain, true)
    }
    // the planner's limit for the whole paste (5230, 5243); here a guard of the step's 500 ms net
    assert.ok(Math.min(...runs) <= 900, `best of 3: ${Math.round(Math.min(...runs))} ms`)
  })
})

test('a clipboard with a text in a table but in no cell: judged where the browser puts it (before the table), so no hidden text is pasted', () => {
  // the parent is white on white, the table sets a dark colour: in the written tree the text looks dark (shown), in the
  // browser's tree (the sanitizer's) it stands before the table, white on white (hidden)
  const cases = [
    '<div style="color: #ffffff; background-color: #ffffff;"><table style="color: #000000;">REJTETT<tr><td>Udv</td></tr></table></div><p>látható</p>',
    '<div style="color: #ffffff; background-color: #ffffff;"><table style="color: #000000;"><tr><b>REJTETT</b><td>Udv</td></tr></table></div>',
    '<div style="color: #ffffff; background-color: #ffffff;"><table style="color: #000000;"><tbody><span>REJTETT</span><tr><td>Udv</td></tr></tbody></table></div>',
  ]
  for (const html of cases) {
    const out = paste(html)
    // every word the pasted HTML holds is a word its reader's filter shows (nothing pasted that the user cannot see)
    const shown = visibleTextInfo(out).text
    const doc = new JSDOM(`<body>${out}</body>`).window.document
    const walk = doc.createTreeWalker(doc.body, 4)
    let n
    while ((n = walk.nextNode())) for (const w of n.data.match(/\S+/g) || []) assert.ok(shown.includes(w), `${w} hidden in ${out}`)
    assert.ok(text(out).includes('Udv'), out)
  }
})

// a clipboard as Chromium writes it: the computed colour on every block (the tester's eight cases, 1642)
const BLOCK = 'style="color: rgb(0, 0, 0);"'
const UNREADABLE = {
  'black on black (span)': [`<p ${BLOCK}>a <span style="background-color: rgb(0, 0, 0); color: rgb(0, 0, 0);">FEKETE</span> b</p>`, '<p>a FEKETE b</p>'],
  'dark on dark (span)': [`<p ${BLOCK}>a <span style="background-color: rgb(17, 17, 17); color: rgb(34, 34, 34);">SOTET</span> b</p>`, '<p>a SOTET b</p>'],
  'a black font in a black bgcolor table': [`<table bgcolor="#000000" ${BLOCK}><tbody><tr><td><font color="#000000">CELLA</font></td></tr></tbody></table>`, '<table><tbody><tr><td>CELLA</td></tr></tbody></table>'],
  'white on a gradient (it does not survive)': [`<div style="color: rgb(0, 0, 0); background-image: linear-gradient(rgb(0, 0, 0), rgb(0, 0, 0));"><span style="color: rgb(255, 255, 255);">GRADIENS</span></div>`, '<div style="color: rgb(0, 0, 0);">GRADIENS</div>'],
  'white on black with an image (the shorthand does not survive)': ['<div style="color: rgb(0, 0, 0); background: url(&quot;x.png&quot;) rgb(0, 0, 0);"><span style="color: rgb(255, 255, 255);">KEPES</span></div>', '<div style="color: rgb(0, 0, 0);">KEPES</div>'],
  'text-indent -200px with no left space of its own': ['<p style="color: rgb(0, 0, 0); text-indent: -200px;">BEHUZAS</p>', '<p style="color: rgb(0, 0, 0);">BEHUZAS</p>'],
  'a faint alpha 0.12 (mixed into its background)': [`<p ${BLOCK}>a <span style="color: rgba(0, 0, 0, 0.12);">HALVANY</span> b</p>`, '<p style="color: rgb(0, 0, 0);">a HALVANY b</p>'],
  'black through a transparent div on black': ['<div style="color: rgb(0, 0, 0); background-color: rgb(0, 0, 0);"><div style="background-color: transparent;"><span style="color: rgb(0, 0, 0);">ATLATSZO</span></div></div>', '<div><div style="background-color: transparent;">ATLATSZO</div></div>'],
}
for (const [name, [html, want]] of Object.entries(UNREADABLE)) {
  test(`readable in the editor and sent (3:1, inside the editor), the text kept: ${name}`, () => {
    assert.equal(sanitizeCompose(purify, ready(html), { rich: true }), want)
  })
}

test('a background that went is checked again for every text under it (the guard runs again), in either order', () => {
  // the black text takes the black background off; the white text, readable on black, stood on white then: its colour goes too
  // (the tree is walked from the last child too: both orders, so one of them needs the guard to run again)
  const white = '<span style="color: rgb(255, 255, 255);">FEHER</span>'
  const black = '<span style="color: rgb(0, 0, 0);">FEKETE</span>'
  assert.equal(sanitizeCompose(purify, ready(`<div style="background-color: rgb(0, 0, 0);">${white} ${black}</div>`), { rich: true }), '<div>FEHER FEKETE</div>')
  assert.equal(sanitizeCompose(purify, ready(`<div style="background-color: rgb(0, 0, 0);">${black} ${white}</div>`), { rich: true }), '<div>FEKETE FEHER</div>')
})

test('a background on a tag the sanitizer unwraps (center, body) is no background: a white text on it goes default', () => {
  assert.equal(sanitizeCompose(purify, ready('<center style="background-color: #000000;"><span style="color: #ffffff;">KOZEP</span></center>'), { rich: true }), 'KOZEP')
})

test('a clipboard\'s own <style> rules are written onto the elements too (one rule with the quote): a class colour and background stay', () => {
  assert.equal(sanitizeCompose(purify, ready('<style>.d { background-color: #000000; } .w { color: #ffffff; }</style><div class="d"><span class="w">fehér a feketén</span></div>'), { rich: true }),
    '<div style="background-color: #000000;"><span style="color: #ffffff;">fehér a feketén</span></div>')
})
