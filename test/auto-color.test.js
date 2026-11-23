// SPDX-License-Identifier: GPL-3.0-or-later
// The composer's "Automatic" text colour (core/smtp/text-colors.js AUTO_COLOR): a marker, not a colour. The editor writes
// it with its own command, its CSS shows that text in the colour around it, and the sanitizer and the mirror (rich-style.js)
// always take it off, in every form, on both ways byte for byte: "Automatic" means "no colour of its own", so it never goes
// out. A body without the marker (an older draft) comes out as before.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { JSDOM } from 'jsdom'
import createDOMPurify from 'dompurify'
import { AUTO_COLOR, isAutoColor, TEXT_COLORS, HIGHLIGHT_COLORS } from '../core/smtp/text-colors.js'
import { cleanAttr, cleanStyle } from '../core/smtp/rich-style.js'
import { sanitizeCompose } from '../app/renderer/src/sanitize.js'
import { visibleComposeHtml } from '../core/mime/visible-text.js'
import { htmlToPlain } from '../core/mime/text.js'

const purify = createDOMPurify(new JSDOM('').window)
const rich = html => sanitizeCompose(purify, html, { rich: true })
const mirror = html => visibleComposeHtml(html, { rich: true })
const both = (html, want) => {
  assert.equal(rich(html), want, `sanitizer: ${html}`)
  assert.equal(mirror(html), want, `mirror: ${html}`)
}

const FORMS = ['#010203', '#010203FF', '#010203ff', ' #010203 ', 'rgb(1, 2, 3)', 'RGB(1,2,3)', 'rgb(1 2 3)', 'rgba(1, 2, 3, 1)', 'rgb(1 2 3 / 100%)', 'rgb(1.0, 2, 3)', 'rgb(01, 02, 03)']
// see-through forms are not the marker (it is written opaque): a colour of their own, or the hidden-text rule's
const NEAR = ['#010204', '#110203', '#0102030', '#01020', 'rgb(1, 2, 33)', 'rgb(11, 2, 3)', 'rgb(1, 2)', 'rgb(1, 2, 3, 4, 5)', 'rgb(10, 2, 3)', 'black', '#000000', 'rgba(1, 2, 3, 0.5)', 'rgb(1 2 3 / 50%)', 'rgba(1, 2, 3, 0)', '#01020300', '#01020380']

test('the marker: not a palette colour or highlight, and only the marker in any case or form is it', () => {
  assert.equal(AUTO_COLOR, '#010203')
  assert.ok(!TEXT_COLORS.some(c => c.hex === AUTO_COLOR))
  assert.ok(!HIGHLIGHT_COLORS.some(c => c.hex === AUTO_COLOR))
  for (const v of FORMS) assert.ok(isAutoColor(v), v)
  for (const v of [...NEAR, '', null, undefined, 1]) assert.ok(!isAutoColor(v), String(v))
})

test('rich-style: a text colour of the marker goes (a font\'s color, a color declaration), every other colour stays; the background is not a text colour', () => {
  for (const v of FORMS) {
    assert.equal(cleanAttr('font', 'color', v), null, v)
    assert.equal(cleanStyle(`color: ${v}; font-family: Arial;`, 'span'), 'font-family: Arial;', v)
  }
  assert.equal(cleanAttr('font', 'color', '#010204'), '#010204')
  assert.equal(cleanStyle('color: rgb(1, 2, 33);', 'span'), 'color: rgb(1, 2, 33);')
  // only the text colour is the marker: a background or a table's bgcolor of that value is a colour
  assert.equal(cleanStyle('background-color: rgb(1, 2, 3);', 'span'), 'background-color: rgb(1, 2, 3);')
  assert.equal(cleanAttr('td', 'bgcolor', '#010203'), '#010203')
})

test('the sanitizer and the mirror, byte for byte: the marker font unwrapped, its other attributes kept; a palette font around or beside it stays', () => {
  both('<p>a <font color="#010203">b</font> c</p>', '<p>a b c</p>')
  both('<p><font color="#010203" face="Arial">b</font></p>', '<p><font face="Arial">b</font></p>')
  both('<p><font color="#C62828">pi</font><font color="#010203"><b>ro</b></font><font color="#c62828">s</font></p>', '<p><font color="#C62828">pi</font><b>ro</b><font color="#c62828">s</font></p>')
  both('<p><span style="color: rgb(1, 2, 3); font-family: Arial;">b</span></p>', '<p><span style="font-family: Arial;">b</span></p>')
  both('<blockquote><p><font color="#010203">idézet</font></p></blockquote>', '<blockquote><p>idézet</p></blockquote>')
  both('<ul><li><font color="RGB(1,2,3)">tétel</font></li></ul>', '<ul><li>tétel</li></ul>')
  // stable: a second cleaning changes nothing
  for (const h of ['<p>a <font color="#010203">b</font> c</p>', '<p><span style="color: #010203; font-size: 18px;">b</span></p>']) {
    const out = rich(h)
    assert.equal(rich(out), out)
    assert.equal(mirror(out), out)
    assert.ok(!/010203|rgb\(1,\s*2,\s*3\)/i.test(out), out)
  }
})

test('the text part: the marker text is plain text, no colour anywhere', () => {
  const out = rich('<p>Szia <font color="#010203">Anna</font>!</p>')
  assert.equal(htmlToPlain(out, { tables: true }), 'Szia Anna!')
})

test('a body without the marker (an older draft) comes out as before: the rich samples byte for byte the output of the code before the marker (test/fixtures/rich-before-auto.json)', async () => {
  const { SAMPLES } = await import('./helpers/color-samples.js')
  const { RICH_SAMPLES } = await import('./helpers/rich-samples.js')
  const golden = JSON.parse(fs.readFileSync(new URL('./fixtures/rich-before-auto.json', import.meta.url), 'utf8'))
  const samples = { ...SAMPLES, ...RICH_SAMPLES }
  assert.equal(Object.keys(golden).length, Object.keys(samples).length)
  for (const [name, html] of Object.entries(samples)) {
    assert.equal(rich(html), golden[name].rich, `sanitizer: ${name}`)
    assert.equal(mirror(html), golden[name].mirror, `mirror: ${name}`)
  }
})
