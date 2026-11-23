// SPDX-License-Identifier: GPL-3.0-or-later
// The text/plain of an outgoing message with a table (core/mime/text.js htmlToPlain `tables`): the composer keeps a table a
// table (rich), and without its own formatter html-to-text wrote a row's cells into one word (the pasted table's old fault,
// in the text part). A line per row, the cells one TAB apart, the caption first, a header cell not marked, a nested table's
// rows where its cell is, an empty line before and after; the lines of a table made lines (div rows) as before; without
// the option (a received message's index and preview) byte for byte as before.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { htmlToPlain, TAB_TABLE_DEPTH } from '../core/mime/text.js'

const tabs = html => htmlToPlain(html, { tables: true })

test('a table: a line per row, the cells TAB apart, a header cell not marked (the measured sample of the plan, in a table)', () => {
  const html = '<table><tr><th>Termék</th><th>Db</th></tr><tr><td>Kazán A</td><td>1</td></tr></table>'
  assert.equal(tabs(html), 'Termék\tDb\nKazán A\t1')
  assert.equal(htmlToPlain(html), 'TermékDbKazán A1', 'without the option: as before (the index of a received message)')
})

test('caption first, thead / tbody / tfoot in tree order, an empty cell keeps its TAB, an empty line before and after', () => {
  const html = '<p>Előtte</p><table><caption>Árlista</caption><thead><tr><th>Termék</th><th>Db</th><th>Ár</th></tr></thead><tbody><tr><td>Kazán A</td><td></td><td>100 Ft</td></tr></tbody><tfoot><tr><td>Össz</td><td>1</td><td>100 Ft</td></tr></tfoot></table><p>Utána</p>'
  assert.equal(tabs(html), 'Előtte\n\nÁrlista\nTermék\tDb\tÁr\nKazán A\t\t100 Ft\nÖssz\t1\t100 Ft\n\nUtána')
})

test('a nested table\'s rows where its cell is; a cell\'s paragraphs one line break; inline formatting and links as text', () => {
  const html = '<table><tr><td><table><tr><td>be1</td><td>be2</td></tr><tr><td>be3</td><td>be4</td></tr></table></td><td>jobb</td></tr><tr><td><p>egy</p><p>kettő</p></td><td><b>vastag</b> <a href="https://example.invalid/">link</a></td></tr></table>'
  assert.equal(tabs(html), 'be1\tbe2\nbe3\tbe4\tjobb\negy\nkettő\tvastag link')
})

test('the rows of a table made lines (div rows, the paste and the quote) and the other elements: the same with and without the option', () => {
  const samples = [
    '<div><div><b>Név</b> Példa Kft</div><div><b>Szám</b> 1234</div></div>',
    '<ul><li>egy</li><li>kettő</li></ul><ol><li>a</li></ol><p>Sima <b>szöveg</b>.</p><blockquote>idézet</blockquote>',
    '<h1>Cím</h1><p>a<br>b</p><pre>  két  szóköz</pre><hr><p>vége</p>',
  ]
  for (const html of samples) assert.equal(tabs(html), htmlToPlain(html), html)
})

test(`past ${TAB_TABLE_DEPTH} nested tables the inner ones are plain text; a deep nesting and a big table stay fast`, () => {
  let deep = 'mag'
  for (let i = 0; i < 300; i++) deep = `<table><tr><td>${deep}</td><td>${i}</td></tr></table>`
  const t0 = performance.now()
  const out = tabs(deep)
  assert.ok(performance.now() - t0 < 2000, `300 levels: ${performance.now() - t0} ms`)
  assert.ok(out.includes('mag') && out.includes('\t299'), out.slice(-40))
  const rows = Array.from({ length: 5000 }, (_, i) => `<tr><td>Sor ${i}</td><td>${i * 2}</td><td>Megjegyzés ${i}</td></tr>`).join('')
  const t1 = performance.now()
  const big = tabs(`<table>${rows}</table>`)
  assert.ok(performance.now() - t1 < 3000, `5000 rows: ${performance.now() - t1} ms`)
  assert.equal(big.split('\n').length, 5000)
  assert.equal(big.split('\n')[4999], 'Sor 4999\t9998\tMegjegyzés 4999')
})

test('a safety net: what stands in a table, a section or a row but in no cell keeps a line of its own; loose cells make a row', () => {
  // the outgoing HTML is the browser's (or the mirror's) structure, where none of these stays in a table; still, no shown text is dropped
  assert.equal(tabs('<p>Szia,</p><table>FIZESS A HU12 SZAMLARA<tr><td>Udv</td></tr></table>'), 'Szia,\n\nFIZESS A HU12 SZAMLARA\nUdv')
  assert.equal(tabs('<table><tbody><div>blokk</div><tr><b>vastag</b><td>a</td><td>b</td></tr></tbody></table>'), 'blokk\nvastag\na\tb')
  assert.equal(tabs('<table><td>x</td><td>y</td><tr><td>z</td></tr></table>'), 'x\ty\nz')
  assert.equal(tabs('<table>\n<colgroup><col></colgroup>\n<tr><td>a</td></tr>\n</table>'), 'a', 'blank text, a col: no line')
})
