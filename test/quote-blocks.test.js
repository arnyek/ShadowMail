// the quote of a long text/plain body is made of block elements cut by the reader's block cutter.
// The characters are made with String.fromCodePoint / fromCharCode (no invisible character in this file).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { quoteHtml as quoteWith, forwardHtml as forwardWith } from '../core/smtp/compose.js'
import { hu } from '../app/renderer/i18n/hu.js'
// the outgoing quote in Hungarian, as before the words became a parameter
const quoteHtml = o => quoteWith(o, hu.outgoingQuote, 'hu-HU')
const forwardHtml = o => forwardWith(o, hu.outgoingQuote, 'hu-HU')
import { htmlToPlain } from '../core/mime/text.js'
import { textBlocks, LONG_LINE } from '../core/mime/text-blocks.js'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
// the body of the earlier build: the whole text in one <p>
const oldBody = text => `<p>${esc(text).replace(/\r?\n/g, '<br>')}</p>`
const original = text => ({ text, html: null, from: [{ name: 'Kis Pál', address: 'kis@example.invalid' }], to: [{ address: 'to@example.invalid' }], subject: 'Tárgy & <b>', date: Date.UTC(2026, 10, 13, 9, 0) })
const bodyOf = (html, prefix) => {
  assert.ok(html.startsWith(prefix) || html.includes(prefix), 'the header part is the old one')
  return html.slice(html.indexOf(prefix) + prefix.length)
}
// the inner block elements of a body made of blocks -> their texts (<br> -> \n, unescaped)
const blockTexts = body => {
  assert.ok(body.startsWith('<div><div>') && body.endsWith('</div></div>'), body.slice(0, 40))
  return body.slice('<div><div>'.length, -'</div></div>'.length).split('</div><div>')
    .map(h => h.replace(/<br>/g, '\n').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&'))
}
const lines = (n, f) => Array.from({ length: n }, (_, i) => f(i)).join('\n')
const HEB = String.fromCodePoint(0x5d0)
const CR = String.fromCharCode(13)

test('a short (one block) text quotes and forwards byte for byte as before', () => {
  for (const text of ['', 'Egy sor.', 'Két\nsor & <b>"jel"</b>', 'CRLF\r\nsor\r\n\r\nüres sorral', lines(20, i => `sor ${i}`), `x${HEB}`.repeat(400), `a${CR}b`]) {
    assert.equal(textBlocks(text).length <= 1, true, 'one block')
    const q = quoteHtml(original(text))
    const f = forwardHtml(original(text))
    assert.ok(q.endsWith(`<blockquote>${oldBody(text)}</blockquote>`), JSON.stringify(text.slice(0, 20)))
    assert.ok(f.endsWith(`</p>${oldBody(text)}`), JSON.stringify(text.slice(0, 20)))
  }
})

test('a long text of lines: the blocks joined at their boundaries (<br> -> \\n) give the text back; the text part is the old one', () => {
  const cases = {
    lines: lines(400, i => `Ez a(z) ${i}. sor, kicsit hosszabb szöveggel & <jelekkel>.`),
    emptyLines: lines(300, i => (i % 7 === 0 ? '' : `sor ${i} szöveg szöveg szöveg`)).replace(/\n/g, '\r\n'),
    manyEmpty: `a\n${'\n'.repeat(2500)}b\n${'c'.repeat(50)}`,
    emptyEvery: lines(2000, i => (i % 2 ? '' : 'xy')),
    startsAndEndsEmpty: `\n\n${lines(300, i => `sor ${i} szöveg szöveg`)}\n\n`,
  }
  for (const [k, text] of Object.entries(cases)) {
    assert.ok(textBlocks(text).length > 1, `${k}: more than one block`)
    const body = bodyOf(quoteHtml(original(text)), '<blockquote>').replace(/<\/blockquote>$/, '')
    // every boundary of these texts is a line end: one \n between two blocks
    assert.equal(blockTexts(body).join('\n').replace(/\r\n/g, '\n'), text.replace(/\r\n/g, '\n'), `${k}: the text back`)
    assert.ok(!blockTexts(body).includes(''), `${k}: no empty block element`)
    assert.equal(htmlToPlain(body), htmlToPlain(oldBody(text)), `${k}: the same text part as the old <p>`)
    const fb = bodyOf(forwardHtml(original(text)), '</p>')
    assert.equal(fb, body, `${k}: the forward has the same body`)
  }
})

test('a line over LONG_LINE is cut: no character lost or added, no empty line at a cut', () => {
  const longLine = Array.from({ length: 900 }, (_, i) => `szó${i}`).join(' ')
  assert.ok(longLine.length > LONG_LINE)
  for (const text of [`x${HEB}`.repeat(700_000), longLine, `kezdet\n${longLine}\nvége`]) {
    const body = bodyOf(quoteHtml(original(text)), '<blockquote>').replace(/<\/blockquote>$/, '')
    const parts = blockTexts(body)
    assert.ok(parts.length > 1)
    assert.equal(parts.join('').replace(/\n/g, ''), text.replace(/\n/g, ''), 'every character, in order')
    const plain = htmlToPlain(body)
    assert.ok(!/\n\s*\n/.test(plain), 'no empty line')
    assert.equal(plain.replace(/\s/g, ''), htmlToPlain(oldBody(text)).replace(/\s/g, ''), 'the text part differs only in line breaks')
  }
})

test('no second cutter: compose.js takes textBlocks from core/mime/text-blocks.js, the only file that defines it', () => {
  const src = fs.readFileSync(path.join(repo, 'core', 'smtp', 'compose.js'), 'utf8')
  assert.match(src, /import \{ textBlocks \} from '\.\.\/mime\/text-blocks\.js'/)
  const defs = []
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(js|jsx|mjs)$/.test(e.name) && /export function (cutPoints|textBlocks)\b/.test(fs.readFileSync(p, 'utf8'))) defs.push(path.relative(repo, p))
    }
  }
  for (const d of ['core', 'app']) walk(path.join(repo, d))
  assert.deepEqual(defs, [path.join('core', 'mime', 'text-blocks.js')])
})

test('a long run of empty lines is linear: 2 MB of "\\n" <= 500 ms, 160 000 "\\n" + short lines <= 100 ms', () => {
  const LIMIT = { nl2mb: 500, run160k: 100 }
  const cases = { nl2mb: '\n'.repeat(2 * 1024 * 1024), run160k: `${'\n'.repeat(160_000)}x\n${'z\n'.repeat(1500)}` }
  for (const [k, text] of Object.entries(cases)) {
    let t0 = performance.now()
    oldBody(text)
    const oldMs = performance.now() - t0
    t0 = performance.now()
    const q = quoteHtml(original(text))
    const f = forwardHtml(original(text))
    const ms = (performance.now() - t0) / 2
    // the quadratic version: 8-11 s (nl2mb) and 23 s (run160k)
    assert.ok(ms <= LIMIT[k], `${k}: ${Math.round(ms)} ms, the limit ${LIMIT[k]} (old <p>: ${Math.round(oldMs)} ms)`)
    const body = bodyOf(q, '<blockquote>').replace(/<\/blockquote>$/, '')
    assert.equal(htmlToPlain(body), htmlToPlain(oldBody(text)), `${k}: the same text part`)
    assert.equal(bodyOf(f, '</p>'), body)
  }
})
