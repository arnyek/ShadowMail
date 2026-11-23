// SPDX-License-Identifier: GPL-3.0-or-later
// A table written wrong (text, a div, a link right in a table, a section or a row; a cell, a row or a col outside its
// place) in the rich mode: the main process's mirror (visible-text.js browserTables) builds what the recipient's browser
// builds (HTML5 foster parenting and implied parts), so what goes out, the Modal's text and the text part show the same
// text the recipient sees (before this a text right in a table went out and showed, but was in neither the Modal nor
// the text part). Measured against jsdom (parse5, the HTML5 tree builder) through the composer's own sanitizer, byte for
// byte, on the tester's cases and on a seeded random set of wrong tables.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import createDOMPurify from 'dompurify'
import { sanitizeCompose } from '../app/renderer/src/sanitize.js'
import { visibleComposeHtml } from '../core/mime/visible-text.js'
import { htmlToPlain } from '../core/mime/text.js'

const purify = createDOMPurify(new JSDOM('').window)
const rich = html => sanitizeCompose(purify, html, { rich: true })
const mirror = html => visibleComposeHtml(html, { rich: true })
// the words the recipient's browser shows: every text node's own words (a text node does not run into the next one)
// (one shared document: a new JSDOM window per call is not freed soon enough, 1500 samples ran out of memory)
const shared = new JSDOM('<!doctype html><body></body>').window.document
const seenWords = html => {
  const doc = shared
  doc.body.innerHTML = html
  const w = doc.createTreeWalker(doc.body, 4)
  const out = []
  let n
  while ((n = w.nextNode())) out.push(...(n.data.match(/[A-Za-zÀ-ž0-9]+/g) || []))
  return out
}

const TESTER = {
  'text in table': '<p>Szia,</p><table>FIZESS A HU12 SZAMLARA<tr><td>Udv</td></tr></table>',
  'text in tr': '<table><tr>FIZESS A HU12 SZAMLARA<td>Udv</td></tr></table>',
  'text in tbody': '<table><tbody>FIZESS A HU12 SZAMLARA<tr><td>Udv</td></tr></tbody></table>',
  'div in table': '<table><div>FIZESS A HU12 SZAMLARA</div><tr><td>Udv</td></tr></table>',
  'b in tr': '<table><tr><b>FIZESS A HU12 SZAMLARA</b><td>Udv</td></tr></table>',
  'link in table': '<table><a href="https://evil.example/">FIZESS ITT</a><tr><td>Udv</td></tr></table>',
  'p in colgroup': '<table><colgroup><p>FIZESS A HU12 SZAMLARA</p></colgroup><tr><td>Udv</td></tr></table>',
  'col in p': '<p>a<col span="2" style="width: 10px"></p>',
  'td in p': '<p><td constructor="1">b</td></p>',
  'td at the top': '<p>x</p><td width="\n50">y</td>',
  'a section in a cell': '<table><thead><tr><th>h<tbody><tr><td>b</table>',
  'a row in a caption': '<table><caption>c<tr><td>a</table>',
  'whitespace around rows': '<table>\n<tr><td>a</td></tr>\n</table>',
  'cells right in a table': '<table><td>x<td>y</table>',
  'a col right in a table': '<table><col width="50"><col span="2"><tr><td>a</td></tr></table>',
  'a table in a colgroup': '<table><colgroup><col><table><tr><td>b</td></tr></table>X</colgroup><tr><td>a</td></tr></table>',
  'a table started in a table': '<table><tr><td>a</td></tr><table><tr><td>b</td></tr></table><tr><td>c</td></tr>FIZESS</table>',
}
for (const [name, html] of Object.entries(TESTER)) {
  test(`a wrong table, the tester's case: the mirror = the sanitizer byte for byte, the Modal's text = what the recipient sees: ${name}`, () => {
    const out = mirror(html)
    assert.equal(out, rich(html))
    assert.equal(rich(out), out, 'stable')
    assert.equal(mirror(out), out, 'stable')
    // every word the recipient sees is in the text part (the Modal's text)
    const plain = htmlToPlain(out, { tables: true })
    for (const w of seenWords(out)) assert.ok(plain.includes(w), `${w} in ${JSON.stringify(plain)}`)
  })
}

// seeded random wrong tables: table parts in any order, closed or not, with text and inline / block atoms anywhere
function rng(seed) {
  let x = seed >>> 0
  return () => ((x = (Math.imul(x ^ (x >>> 15), 2246822507) ^ Math.imul(x ^ (x >>> 13), 3266489909) + 0x9e3779b9) >>> 0) / 2 ** 32)
}
const PARTS = ['<table>', '</table>', '<caption>', '</caption>', '<colgroup>', '</colgroup>', '<col>', '<thead>', '</thead>', '<tbody>', '</tbody>', '<tfoot>', '</tfoot>', '<tr>', '</tr>', '<td>', '</td>', '<th>', '</th>']
const ATOMS = ['szó', ' ', '\n', '<b>vastag</b>', '<div>blokk</div>', '<a href="https://example.invalid/">link</a>', '<span style="color: red;">piros</span>', '<p>bekezdés</p>', '<font color="#c62828">f</font>']
function wrongTable(r) {
  const parts = ['<table>']
  const n = 3 + Math.floor(r() * 14)
  for (let i = 0; i < n; i++) parts.push(r() < 0.6 ? PARTS[Math.floor(r() * PARTS.length)] : ATOMS[Math.floor(r() * ATOMS.length)])
  if (r() < 0.7) parts.push('</table>')
  return (r() < 0.5 ? '<p>előtte</p>' : '') + parts.join('') + (r() < 0.5 ? '<p>utána</p>' : '')
}

// The bytes match the sanitizer on most of them, not on all: a browser also reads END tags (a </tr> or a </colgroup> it
// ignores or obeys decides where the next text or space goes), and htmlparser2's tree keeps none. So two texts the
// browser keeps apart may run together (or the other way round): the same letters, other word breaks. What is held on
// every one: the mirror's output is what the recipient's browser builds from it (the sanitizer, jsdom's HTML5 parser,
// gives it back unchanged), it shows the same letters as the sanitizer's (no text lost or added), and the text part
// (the Modal's text) has every word shown.
test('random wrong tables (seeded, 1500): what the mirror writes is what the browser builds, the same letters as the sanitizer, every shown word in the text part', () => {
  const r = rng(20261121)
  const bad = []
  let same = 0
  const letters = html => [...seenWords(html).join('')].sort().join('')
  for (let i = 0; i < 1500; i++) {
    const html = wrongTable(r)
    const out = mirror(html)
    if (out === rich(html)) same++
    if (rich(out) !== out) bad.push(`the browser changes it: ${JSON.stringify(html)}\n  mirror: ${out}\n  again:  ${rich(out)}`)
    if (mirror(out) !== out) bad.push(`unstable: ${JSON.stringify(html)}`)
    if (letters(out) !== letters(rich(html))) bad.push(`other letters: ${JSON.stringify(html)}\n  mirror:    ${out}\n  sanitizer: ${rich(html)}`)
    const plain = htmlToPlain(out, { tables: true })
    for (const w of seenWords(out)) if (!plain.includes(w)) bad.push(`text part lacks ${w}: ${JSON.stringify(html)}`)
  }
  assert.deepEqual(bad.slice(0, 5), [], `${bad.length} problems in 1500`)
  // the byte match itself, for the record (not a limit)
  console.log(`# random wrong tables: ${same} of 1500 byte for byte the sanitizer's`)
})
