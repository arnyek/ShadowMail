// SPDX-License-Identifier: GPL-3.0-or-later
// The composer's colours (core/smtp/text-colors.js) in the composer sanitizer's `rich` mode (sanitize.js sanitizeCompose,
// core/smtp/rich-style.js): the palette, its contrast, the exact style text the editor writes for a highlight; with `rich`
// the palette stays byte for byte (with every other checked colour); without it the output is
// byte for byte what it was before colours (test/fixtures/compose-colors-off.json: the sanitizer of the release before
// this change on the same samples; regenerate with the old sanitize.js only, never with the new one).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { JSDOM } from 'jsdom'
import createDOMPurify from 'dompurify'
import { TEXT_COLORS, HIGHLIGHT_COLORS, isTextColor, isHighlightStyle } from '../core/smtp/text-colors.js'
import { sanitizeCompose, COMPOSE_TAGS } from '../app/renderer/src/sanitize.js'
import { SAMPLES } from './helpers/color-samples.js'

const purify = createDOMPurify(new JSDOM('').window)
const on = html => sanitizeCompose(purify, html, { rich: true })
const off = html => sanitizeCompose(purify, html)

// WCAG 2 relative luminance and contrast
const lum = hex => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

test('the palette: six text colours and six highlights, the decided values, in the menu order, frozen', () => {
  assert.deepEqual(TEXT_COLORS.map(c => [c.id, c.hex]), [['red', '#c62828'], ['orange', '#bf360c'], ['green', '#2e7d32'], ['blue', '#1565c0'], ['purple', '#6a1b9a'], ['gray', '#616161']])
  assert.deepEqual(HIGHLIGHT_COLORS.map(c => [c.id, c.hex]), [['yellow', '#fff59d'], ['green', '#c8e6c9'], ['blue', '#bbdefb'], ['pink', '#f8bbd0'], ['orange', '#ffe0b2'], ['gray', '#e0e0e0']])
  assert.ok(Object.isFrozen(TEXT_COLORS) && Object.isFrozen(HIGHLIGHT_COLORS) && TEXT_COLORS.every(Object.isFrozen) && HIGHLIGHT_COLORS.every(Object.isFrozen))
  for (const list of [TEXT_COLORS, HIGHLIGHT_COLORS]) {
    assert.equal(new Set(list.map(c => c.id)).size, list.length, 'ids differ')
    for (const c of list) assert.match(c.hex, /^#[0-9a-f]{6}$/, 'lower case hex, as the editor writes it')
  }
})

test('contrast: every text colour at least 5:1 on white, black text at least 13:1 on every highlight', () => {
  for (const c of TEXT_COLORS) assert.ok(contrast(c.hex, '#ffffff') >= 5, `${c.id} ${contrast(c.hex, '#ffffff').toFixed(2)}`)
  for (const c of HIGHLIGHT_COLORS) assert.ok(contrast('#000000', c.hex) >= 13, `${c.id} ${contrast('#000000', c.hex).toFixed(2)}`)
})

test('a highlight\'s style is the text the editor writes: "background-color: rgb(r, g, b);" of its hex', () => {
  for (const c of HIGHLIGHT_COLORS) {
    const n = parseInt(c.hex.slice(1), 16)
    assert.equal(c.style, `background-color: rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255});`)
  }
  assert.equal(HIGHLIGHT_COLORS[0].style, 'background-color: rgb(255, 245, 157);')
})

test('isTextColor / isHighlightStyle: exactly the palette, written exactly so', () => {
  for (const c of TEXT_COLORS) assert.ok(isTextColor(c.hex))
  for (const c of HIGHLIGHT_COLORS) assert.ok(isHighlightStyle(c.style))
  for (const v of ['#C62828', ' #c62828', '#c62829', 'rgb(198, 40, 40)', 'red', '', null, undefined, 1, HIGHLIGHT_COLORS[0].hex]) assert.equal(isTextColor(v), false, String(v))
  for (const v of ['background-color: rgb(255,245,157);', 'background-color: rgb(255, 245, 157)', 'background-color: rgb(255, 245, 157); ', 'background-color: #fff59d;', 'color: rgb(255, 245, 157);', '', null, undefined]) assert.equal(isHighlightStyle(v), false, String(v))
})

// the palette is a part of the rich mode (sanitizeCompose `rich`, core/smtp/rich-style.js); the whole rich allow-list is
// test/rich-style.test.js, here only how the toolbar's own colours fare in it
test('rich: the palette text colour on a font and a palette highlight on a span or a font stay, byte for byte', () => {
  for (const c of TEXT_COLORS) assert.equal(on(`<p><font color="${c.hex}">x</font></p>`), `<p><font color="${c.hex}">x</font></p>`)
  for (const c of HIGHLIGHT_COLORS) {
    assert.equal(on(`<p><span style="${c.style}">x</span></p>`), `<p><span style="${c.style}">x</span></p>`)
    assert.equal(on(`<p><font style="${c.style}">x</font></p>`), `<p><font style="${c.style}">x</font></p>`)
  }
  const both = `<p><font color="${TEXT_COLORS[3].hex}" style="${HIGHLIGHT_COLORS[0].style}">x</font></p>`
  assert.equal(on(both), both)
  const nested = `<p><span style="${HIGHLIGHT_COLORS[0].style}">a <font color="${TEXT_COLORS[0].hex}">b <b>c</b></font></span></p>`
  assert.equal(on(nested), nested)
})

test('rich: a colour outside the palette stays when it is a colour; code, loading and a font left with nothing go', () => {
  const R = TEXT_COLORS[0].hex
  const Y = HIGHLIGHT_COLORS[0].style
  const cases = [
    // not in the palette, another form: a colour all the same (the owner's decision: as much formatting as it can)
    ['<p><font color="#d32f2f">x</font></p>', '<p><font color="#d32f2f">x</font></p>'],
    [`<p><font color="${R.toUpperCase()}">x</font></p>`, `<p><font color="${R.toUpperCase()}">x</font></p>`],
    ['<p><font color="rgb(198, 40, 40)">x</font></p>', '<p><font color="rgb(198, 40, 40)">x</font></p>'],
    ['<p><font color="red">x</font></p>', '<p><font color="red">x</font></p>'],
    ['<p><font color="javascript:alert(1)">x</font></p>', '<p>x</p>'],
    ['<p><font color="chucknorris">x</font></p>', '<p>x</p>'],
    // a font's other attributes (in RICH_ATTRS order), an empty font
    ['<p><font face="Arial" size="7">x</font></p>', '<p><font face="Arial" size="7">x</font></p>'],
    [`<p><font size="1" face="Arial" color="${R}">x</font></p>`, `<p><font color="${R}" face="Arial" size="1">x</font></p>`],
    ['<p><font size="8" face="a<b">x</font></p>', '<p>x</p>'],
    ['<p><font>x</font></p>', '<p>x</p>'],
    // style: the kept declarations, the rest out
    [`<p><span style="${Y} position: fixed">x</span></p>`, `<p><span style="${Y}">x</span></p>`],
    [`<p><span style="position: fixed; ${Y}">x</span></p>`, `<p><span style="${Y}">x</span></p>`],
    ['<p><span style="background-color: rgb(255,245,157);">x</span></p>', '<p><span style="background-color: rgb(255,245,157);">x</span></p>'],
    ['<p><span style="background-color: #fff59d !important">x</span></p>', '<p><span style="background-color: #fff59d;">x</span></p>'],
    [`<p><span style="color: ${R}; ${Y}">x</span></p>`, `<p><span style="color: ${R}; ${Y}">x</span></p>`],
    ['<p><span style="background: url(https://evil.invalid/x.png)">x</span></p>', '<p>x</p>'],
    ['<p><span style="">x</span></p>', '<p>x</p>'],
    ['<p><font style="">x</font></p>', '<p>x</p>'],
    // a style on any kept element; a color attribute on a font only
    [`<p style="${Y}">x</p>`, `<p style="${Y}">x</p>`],
    [`<a href="https://example.invalid/" style="${Y} color: red;">x</a>`, `<a href="https://example.invalid/" style="${Y} color: red;">x</a>`],
    [`<p><span color="${R}">x</span></p>`, '<p>x</p>'],
    [`<p><b color="${R}">x</b></p>`, '<p><b>x</b></p>'],
    // handlers and the rest of the allow-list as before
    [`<p><font color="${R}" onclick="alert(1)" class="c">x</font><img src="https://evil.invalid/t.png" style="${Y}"><script>alert(1)</script></p>`, `<p><font color="${R}">x</font></p>`],
  ]
  for (const [html, want] of cases) assert.equal(on(html), want, html)
})

test('rich: the values trimmed as DOMPurify trims every attribute value; entities decoded', () => {
  assert.equal(on(`<p><font color=" ${TEXT_COLORS[0].hex}\n">x</font></p>`), `<p><font color="${TEXT_COLORS[0].hex}">x</font></p>`)
  assert.equal(on('<p><font color="&#35;c62828">x</font></p>'), '<p><font color="#c62828">x</font></p>')
})

test('rich: the composer\'s other rules hold with it (signature marker, own images, links, tables as lines with tableRows)', () => {
  const sid = '11111111-2222-3333-4444-555555555555'
  const img = `inl-img://session/${sid}/${'a'.repeat(24)}`
  const html = `<p><font color="${TEXT_COLORS[0].hex}">x</font> <a href="javascript:x">j</a></p><div data-sm-signature=""><p>-- <br>Aláírás</p></div><p><img src="${img}" width="320"><img src="https://evil.invalid/x.png"></p>`
  assert.equal(sanitizeCompose(purify, html, { sessionId: sid, rich: true }), `<p><font color="#c62828">x</font> <a>j</a></p><div data-sm-signature=""><p>-- <br>Aláírás</p></div><p><img src="${img}" alt="" width="320"></p>`)
  assert.equal(sanitizeCompose(purify, html, { sessionId: sid }), `<p>x <a>j</a></p><div data-sm-signature=""><p>-- <br>Aláírás</p></div><p><img src="${img}" width="320" alt=""></p>`)
  const table = `<table><tr><th><font color="${TEXT_COLORS[0].hex}">A</font></th><td>B</td></tr></table>`
  assert.equal(sanitizeCompose(purify, table, { tableRows: true, rich: true }), '<div><div><b><font color="#c62828">A</font></b> B</div></div>')
  assert.equal(sanitizeCompose(purify, table, { rich: true }), '<table><tbody><tr><th><font color="#c62828">A</font></th><td>B</td></tr></tbody></table>')
})

test('without colors: the output byte for byte the release\'s before colours, on every colour sample (with and without tableRows)', () => {
  const golden = JSON.parse(fs.readFileSync(new URL('./fixtures/compose-colors-off.json', import.meta.url), 'utf8'))
  assert.deepEqual(Object.keys(golden).sort(), Object.keys(SAMPLES).sort(), 'the fixture covers the samples (regenerate it with the OLD sanitize.js)')
  for (const [name, html] of Object.entries(SAMPLES)) {
    assert.equal(off(html), golden[name][0], name)
    assert.equal(sanitizeCompose(purify, html, { tableRows: true }), golden[name][1], name)
    assert.ok(!/<font|style=|color=/.test(off(html)), name)
  }
  assert.ok(!COMPOSE_TAGS.includes('font'), 'font is not a tag of the plain allow-list')
})

test('no hook is left behind: a rich call leaves the next plain call as before', () => {
  const html = SAMPLES['colour and highlight on one font']
  const before = off(html)
  on(html)
  assert.equal(off(html), before)
  assert.equal(off(html), '<p>mindkettő</p>')
})
