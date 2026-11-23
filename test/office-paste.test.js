// SPDX-License-Identifier: GPL-3.0-or-later
// A paste from Word or Excel (core/mime/paste-prepare.js): Word's lists (paragraphs with mso-list and a typed marker) become
// real ul / ol with their levels; the clipboard's own style sheet (Normal, Heading 1, Excel's cell classes) is written onto
// the elements; Word's own markup (o:p, the marker spans, conditional comments, VML, file:/// images, mso-* styles) does not
// reach the editor. The *-synthetic samples are written after the known clipboard formats; excel-windows.html is a real
// clipboard (Excel 15 on Windows, pasted in Chrome 157), its local file paths made neutral (test/fixtures/paste/).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { JSDOM } from 'jsdom'
import createDOMPurify from 'dompurify'
import { sanitizeCompose } from '../app/renderer/src/sanitize.js'
import { visibleComposeHtml } from '../core/mime/visible-text.js'
import { preparePaste, prepareQuote, hasShownText } from '../core/mime/paste-prepare.js'
import { quoteParts, joinQuote } from '../core/smtp/compose.js'
import { htmlToPlain } from '../core/mime/text.js'

const purify = createDOMPurify(new JSDOM('').window)
const fixture = name => fs.readFileSync(new URL(`./fixtures/paste/${name}`, import.meta.url), 'utf8')
const paste = html => {
  const r = preparePaste(html)
  assert.equal(r.plain, false)
  return sanitizeCompose(purify, r.html, { rich: true, insert: true })
}
const lists = html => paste(html).replace(/ style="[^"]*"/g, '').replace(/\s+/g, ' ').replace(/> </g, '><').trim()
const word = list => `<style>p.MsoListParagraph { margin-left: 36pt; }</style>${list}`
const para = (level, marker, text, id = 'l0', style = '', font = 'Symbol') =>
  `<p class=MsoListParagraph style='${style}text-indent:-18.0pt;mso-list:${id} level${level} lfo1'><![if !supportLists]><span style='font-family:${font}'><span style='mso-list:Ignore'>${marker}<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp;&nbsp; </span></span></span><![endif]>${text}<o:p></o:p></p>\n`

// a style attribute's declarations in order -> the value each property ends with, as the browser reads it: a border
// shorthand resets the four sides (a later longhand wins over it, a later shorthand over the longhands)
const SIDES = ['top', 'right', 'bottom', 'left']
function sideBorders(style) {
  const out = Object.fromEntries(SIDES.map(s => [s, 'initial']))
  for (const decl of style.split(';')) {
    const i = decl.indexOf(':')
    if (i < 0) continue
    const name = decl.slice(0, i).trim()
    const value = decl.slice(i + 1).trim()
    if (name === 'border') for (const s of SIDES) out[s] = value
    else if (/^border-(top|right|bottom|left)$/.test(name)) out[name.slice(7)] = value
  }
  return out
}
const cellStyles = out => [...out.matchAll(/<td[^>]*style="([^"]*)"[^>]*>([^<]*)<\/td>/g)].map(m => ({ text: m[2].replace(/&nbsp;/g, ' ').trim(), style: m[1] }))

test('the synthetic Word sample: heading, colours, highlight, bold, Times, a two-level bullet list, a numbered list, the grid table; no Word markup', () => {
  const out = paste(fixture('word-synthetic.html'))
  assert.match(out, /<h1 style="[^"]*font-family: &quot;calibri light&quot;,sans-serif; color: #2f5496;[^"]*">Címsor egy<\/h1>/, out)
  assert.match(out, /<p style="[^"]*font-size: 11.0pt; font-family: &quot;calibri&quot;,sans-serif;">Ez egy <span style="color: red;">piros<\/span>/, 'the Normal style\'s font from the sheet')
  assert.ok(out.includes('<span style="background-color: yellow;">sárga</span>') && out.includes('<b>félkövér</b>'), out)
  assert.ok(out.includes('font-size: 14.0pt; line-height: 107%; font-family: &quot;Times New Roman&quot;,serif;">Times</span>'), out)
  const shape = out.replace(/ style="[^"]*"/g, '').replace(/\s+/g, ' ').replace(/> </g, '><')
  assert.ok(shape.includes('<ul><li>Első pont<ul><li>Alsó szint</li></ul></li><li><b>Második</b> pont</li></ul>'), shape)
  assert.ok(shape.includes('<ol><li>Egy</li><li>Kettő</li></ol>'), shape)
  assert.match(out, /<td width="302" valign="top" style="width: 226.6pt; border: solid windowtext 1.0pt; background-color: #C5E0B3;[^"]*">/, out)
  for (const bad of ['o:p', 'mso-', 'v:', 'file:', 'Ignore', '·', 'supportLists', 'text-indent', 'margin-left: 36', 'margin-left: 72']) assert.ok(!out.includes(bad), `${bad}: ${out}`)
  assert.ok(out.includes('Kép után') && !/<img/.test(out), 'the local image goes, the text after it stays')
  // the text part: the lists' items a line each
  const plain = htmlToPlain(out, { tables: true })
  for (const line of ['Első pont', 'Alsó szint', 'Második pont', 'Egy', 'Kettő']) assert.match(plain, new RegExp(`^.*${line}$`, 'm'), plain)
})

test('the synthetic Excel sample: the cell classes\' borders, fill and bold header from the sheet', () => {
  const out = paste(fixture('excel-synthetic.html'))
  // the declarations stand in the cascade's order (the td rule's before the class's), so each is looked for on its own
  const cell = text => cellStyles(out).find(c => c.text === text)?.style || ''
  const has = (text, ...decls) => decls.forEach(d => assert.ok(cell(text).includes(d), `${text}: ${d} in ${cell(text)}`))
  has('Fej1', 'font-weight: 700', 'border: .5pt solid windowtext')
  assert.match(out, /<td width="64" style="[^"]*">Fej1<\/td>/, out)
  assert.ok(!cell('Fej1').includes('font-weight: 400'), 'the class\'s bold, not the td rule\'s 400')
  has('kitöltve', 'border: .5pt solid windowtext', 'background-color: #ffc000')
  has('a', 'border: .5pt solid windowtext', 'font-weight: 400')
  assert.deepEqual(sideBorders(cell('kitöltve')), { top: 'none', right: '.5pt solid windowtext', bottom: '.5pt solid windowtext', left: 'none' })
  assert.ok(!out.includes('mso-') && !out.includes('xl6'), out)
})

test('the real Excel sample: a class rule\'s border sides beat the td rule\'s border: none, as in the browser', () => {
  const out = paste(fixture('excel-windows.html'))
  assert.equal((out.match(/<tr>/g) || []).length, 7)
  const cells = cellStyles(out)
  assert.equal(cells.length, 42)
  assert.deepEqual(cells.filter(c => c.text).map(c => c.text).join(' '), '4 5 6 7 8 9 11 12 13 14 15 16 18 19 20 21 22 23')
  const line = '.5pt solid #b4c6e7'
  // .xl70 / .xl72 (the empty rows): right and bottom, the left only on the row's first cell (the others: border-left:none)
  const empty = cells.filter(c => !c.text)
  assert.equal(empty.length, 24)
  for (const [i, c] of empty.entries()) {
    assert.deepEqual(sideBorders(c.style), { top: 'none', right: line, bottom: line, left: i % 6 === 0 ? line : 'none' }, c.style)
  }
  // .xl73 / .xl74 (the numbers): the top from the cell's own border-top:none, the bottom from the class
  for (const c of cells.filter(c => c.text)) {
    assert.deepEqual(sideBorders(c.style), { top: 'none', right: line, bottom: 'none', left: c.text === '4' || c.text === '11' || c.text === '18' ? line : 'none' }, `${c.text}: ${c.style}`)
    assert.match(c.style, /font-size: 12\.0pt;[^"]*text-align: right; vertical-align: middle;/, c.text)
    // the class's padding-left over the td rule's 1px: one value, the class's
    assert.match(c.style, /padding-right: 12px/, c.text)
  }
  assert.ok(!out.includes('mso-') && !out.includes('xl7') && !out.includes('file:'), out)
  // the text part: a line per row, the cells tab-separated
  const lines = htmlToPlain(out, { tables: true }).split('\n').map(l => l.trim()).filter(Boolean)
  assert.deepEqual(lines, ['4\t5\t6\t7\t8\t9', '11\t12\t13\t14\t15\t16', '18\t19\t20\t21\t22\t23'])
})

test('the sheet\'s winners are written in the cascade\'s order: specificity, then the later rule; a shorthand and its longhands', () => {
  const cell = css => cellStyles(paste(`<style>${css}</style><table><tr><td class="a b">x</td></tr></table>`))[0].style
  const solid = '1px solid #ff0000'
  // a type rule's shorthand under a class rule's longhand (Excel's td { border: none } and .xl70 { border-right })
  assert.equal(sideBorders(cell(`td { border: none } .a { border-right: ${solid} }`)).right, solid)
  assert.equal(sideBorders(cell(`.a { border-right: ${solid} } td { border: none }`)).right, solid, 'the source order does not beat specificity')
  // a class rule's shorthand over a type rule's longhand
  assert.equal(sideBorders(cell(`.a { border: none } td { border-right: ${solid} }`)).right, 'none')
  // the same specificity: the later rule
  assert.equal(sideBorders(cell(`.a { border-right: ${solid} } .b { border: none }`)).right, 'none')
  assert.equal(sideBorders(cell(`.b { border: none } .a { border-right: ${solid} }`)).right, solid)
  // a rule's !important over everything, the cell's own style over the rules
  assert.equal(sideBorders(cell(`.a { border: none !important } td.a.b { border-right: ${solid} }`)).right, 'none')
  assert.equal(sideBorders(cellStyles(paste(`<style>.a { border: none }</style><table><tr><td class="a" style="border-right: ${solid}">x</td></tr></table>`))[0].style).right, solid)
})

test('an image or a piece of a page: the clipboard HTML\'s shown text, without the head, style sheet and script', () => {
  // Excel's clipboard: the cells' numbers (the HTML goes in, not the picture beside it)
  assert.equal(hasShownText(fixture('excel-windows.html')), true)
  for (const html of ['', null, '<p>&nbsp;</p>', ' \n\t ', '<img src="https://example.invalid/a.png">', '<!--x--><br>',
    '<html><head><title>Cím</title><style>p { color: red }</style></head><body> </body></html>', '<script>x()</script>',
    '<style>unclosed text', '<template>tpl</template><noscript>ns</noscript>']) {
    assert.equal(hasShownText(html), false, String(html))
  }
  for (const html of ['<style>a</style>b', '<head><title>t</title></head><body>x</body>', 'x', '<b>&#120;</b>', '<td>0</td>']) {
    assert.equal(hasShownText(html), true, html)
  }
  // linear: a 2 MB page with its text at the end
  const big = `${'<span> </span>'.repeat(150_000)}x`
  const t0 = performance.now()
  assert.equal(hasShownText(big), true)
  assert.ok(performance.now() - t0 < 1500, `${Math.round(performance.now() - t0)} ms`)
})

test('the list markers: numbers, letters, roman numerals with their start; bullets', () => {
  const kind = m => lists(word(para(1, m, 'x'))).replace(/<li>x<\/li>/, '')
  assert.equal(kind('1.'), '<ol></ol>')
  assert.equal(kind('3)'), '<ol start="3"></ol>')
  assert.equal(kind('(2)'), '<ol start="2"></ol>')
  assert.equal(kind('a.'), '<ol type="a"></ol>')
  assert.equal(kind('C)'), '<ol start="3" type="A"></ol>')
  assert.equal(kind('i.'), '<ol type="i"></ol>')
  assert.equal(kind('IV.'), '<ol start="4" type="I"></ol>')
  for (const bullet of ['·', 'o', '§', '-', '•', 'Ø']) assert.equal(kind(bullet), '<ul></ul>', bullet)
})

test('a marker with a number or letter that is not a simple one stays a paragraph with its marker as text; bullets and simple numbers stay lists', () => {
  const calibri = (level, marker, text) => para(level, marker, text, 'l0', '', 'Calibri')
  // legal numbering: the 1.1. / 1.2. items are paragraphs, the list goes on after them at its own number
  const legal = paste(word(calibri(1, '1.', 'Elso fejezet') + calibri(2, '1.1.', 'Alpont egy') + calibri(2, '1.2.', 'Alpont ketto') + calibri(1, '2.', 'Masodik fejezet')))
  const shape = s => s.replace(/ style="[^"]*"/g, '').replace(/\s+/g, ' ').replace(/> </g, '><').trim()
  assert.equal(shape(legal), '<ol><li>Elso fejezet</li></ol><p>1.1. Alpont egy</p><p>1.2. Alpont ketto</p><ol start="2"><li>Masodik fejezet</li></ol>')
  const lines = htmlToPlain(legal, { tables: true }).split('\n').map(l => l.trim()).filter(Boolean)
  assert.deepEqual(lines, ['1. Elso fejezet', '1.1. Alpont egy', '1.2. Alpont ketto', '2. Masodik fejezet'], 'the text part')
  // the marker word for word, a space for Word's tab; none is a bullet
  for (const marker of ['1.1', '1.a)', 'Step 1.', '1. §']) {
    const out = shape(paste(word(calibri(1, marker, 'x') + calibri(1, marker, 'y'))))
    assert.equal(out, `<p>${marker} x</p><p>${marker} y</p>`, marker)
  }
  // the indent goes, the paragraph's own formatting stays
  const styled = paste(word(para(1, '1.1.', 'z', 'l0', 'color:#1565c0;margin-left:54.0pt;', 'Calibri')))
  assert.equal(styled.trim(), '<p style="color: #1565c0;">1.1. z</p>', styled)
  // controls: symbol-font bullets (Wingdings' glyphs are letters in Unicode), Courier New "o", a sign alone: ul;
  // simple numbers, letters, roman numerals: ol
  for (const [marker, font] of [['·', 'Symbol'], ['§', 'Wingdings'], ['Ø', 'Wingdings'], ['ü', 'Wingdings'], ['o', '"Courier New"'], ['-', 'Calibri'], ['§', 'Calibri'], ['•', 'Calibri']]) {
    assert.equal(shape(paste(word(para(1, marker, 'x', 'l0', '', font)))), '<ul><li>x</li></ul>', `${marker} ${font}`)
  }
  for (const [marker, out] of [['1.', '<ol><li>x</li></ol>'], ['a)', '<ol type="a"><li>x</li></ol>'], ['iv.', '<ol start="4" type="i"><li>x</li></ol>']]) {
    assert.equal(shape(paste(word(calibri(1, marker, 'x')))), out, marker)
  }
})

test('list structure: levels nest in the item before, a level jump too; another kind or another list at the top a list of its own', () => {
  assert.equal(lists(word(para(1, '·', 'A') + para(2, 'o', 'B') + para(3, '§', 'C') + para(1, '·', 'D'))), '<ul><li>A<ul><li>B<ul><li>C</li></ul></li></ul></li><li>D</li></ul>')
  assert.equal(lists(word(para(1, '·', 'A') + para(3, '§', 'C'))), '<ul><li>A<ul><li>C</li></ul></li></ul>')
  assert.equal(lists(word(para(1, '·', 'A') + para(1, '1.', 'B') + para(1, '2.', 'C'))), '<ul><li>A</li></ul><ol><li>B</li><li>C</li></ol>')
  assert.equal(lists(word(para(1, '1.', 'A') + para(1, '1.', 'B', 'l1'))), '<ol><li>A</li></ol><ol><li>B</li></ol>')
  // a deeper level under a numbered item, back to numbers after it
  assert.equal(lists(word(para(1, '1.', 'A') + para(2, 'a.', 'a1') + para(1, '2.', 'B'))), '<ol><li>A<ol type="a"><li>a1</li></ol></li><li>B</li></ol>')
  // a list paragraph alone, and two runs split by an ordinary paragraph
  assert.equal(lists(word(`<p>előtte</p>${para(1, '·', 'A')}<p>közte</p>${para(1, '·', 'B')}`)), '<p>előtte</p><ul><li>A</li></ul><p>közte</p><ul><li>B</li></ul>')
})

test('the item keeps the paragraph\'s own formatting, the indent and the marker go; a paragraph without mso-list is untouched', () => {
  const out = paste(word(para(1, '·', '<span style="color:#c62828">piros</span> pont', 'l0', 'color:#1565c0;font-size:12.0pt;margin-left:54.0pt;')))
  assert.match(out, /<ul><li style="color: #1565c0; font-size: 12.0pt;"><span style="color: #c62828;">piros<\/span> pont<\/li><\/ul>/, out)
  const plainP = '<p style="text-indent: -18pt; margin-left: 36pt;">· nem lista</p>'
  assert.equal(paste(plainP), '<p style="text-indent: -18pt; margin-left: 36pt;">· nem lista</p>')
})

test('a quote of a Word-written message (Outlook sends the same markup): the lists there too, the composer and Claude the same bytes', () => {
  const TEXT = { wrote: h => `${h} írta:`, forwarded: '-- Továbbított --', labels: { from: 'Feladó', date: 'Dátum', subject: 'Tárgy', to: 'Címzett', cc: 'Másolat' } }
  const parts = quoteParts('reply', { html: fixture('word-synthetic.html'), text: '', from: [{ name: 'A', address: 'a@example.invalid' }], to: [], cc: [], subject: 'S', date: '2026-11-20T10:00:00Z' }, TEXT, 'hu-HU')
  const r = prepareQuote(parts.body)
  const composer = sanitizeCompose(purify, joinQuote({ ...parts, body: r.html }), { rich: true })
  assert.equal(visibleComposeHtml(joinQuote({ ...parts, body: r.html }), { rich: true }), composer)
  assert.ok(composer.replace(/ style="[^"]*"/g, '').replace(/\s+/g, ' ').replace(/> </g, '><').includes('<ul><li>Első pont<ul><li>Alsó szint</li></ul></li>'), composer)
})

test('5000 list paragraphs (nested by fours) stay linear', () => {
  const many = n => word(Array.from({ length: n }, (_, i) => para((i % 4) + 1, '·', `pont ${i}`)).join(''))
  const time = n => {
    const t0 = performance.now()
    const r = preparePaste(many(n))
    assert.equal(r.plain, false)
    return performance.now() - t0
  }
  time(500)
  const small = Math.min(time(1250), time(1250))
  const big = Math.min(time(5000), time(5000))
  assert.ok(big / Math.max(small, 5) < 8, `${Math.round(small)} ms -> ${Math.round(big)} ms`)
})
