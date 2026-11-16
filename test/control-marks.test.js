// Every invisible character of the source view becomes a visible
// mark. This file holds the characters only as escapes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONTROL_RE, controlParts, withMarks, markText, markOf, codeLabel, countMarks, markRuns, markCount, readerText, codePointLength, MAX_MARKS, MAX_OUTPUT_CHARS, MAX_READER_TEXT } from '../app/renderer/src/control-marks.js'

const cp = n => String.fromCodePoint(n)
const flat = r => r.parts.map(p => (typeof p === 'string' ? p : markOf(p.mark))).join('')
const marksOf = r => r.parts.filter(p => typeof p !== 'string').map(p => p.mark)

// the card's list + the H2 ones: C0, DEL, C1, Cf (zero-width, bidi, BOM, soft hyphen, tags), Zl/Zp, ignorables
const MARKED = [0x0000, 0x0007, 0x000b, 0x000c, 0x000e, 0x001b, 0x001f, 0x007f, 0x0080, 0x0085, 0x009b, 0x009f, 0x00ad, 0x061c, 0x180e,
  0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2028, 0x2029, 0x202a, 0x202e, 0x2060, 0x2064, 0x2066, 0x2069, 0x206f, 0x3164, 0xfe00, 0xfe0f, 0xfeff,
  0xe0001, 0xe0020, 0xe0041, 0xe007f, 0xe0100]
const KEPT = ['\t', '\n', '\r\n', 'a', cp(0xe9), cp(0xa0), ' ', cp(0x2070), cp(0x1f600), cp(0x4e2d)]

test('every code point of the card is marked with its exact code, one mark each (a tag character too)', () => {
  for (const n of MARKED) {
    const ch = cp(n)
    const r = controlParts(`a${ch}b`)
    assert.deepEqual(r.parts, ['a', { mark: codeLabel(ch) }, 'b'], codeLabel(ch))
    assert.equal(codeLabel(ch), `U+${n.toString(16).toUpperCase().padStart(4, '0')}`)
    assert.equal(withMarks(ch), markText(ch))
    assert.equal(countMarks(ch), 1, `${codeLabel(ch)} is one mark, not two surrogates`)
  }
  assert.equal(markText(cp(0xe0041)), '⟨U+E0041⟩')
})

test('tab, line feed, CRLF and ordinary text (accents, nbsp, emoji, CJK) stay as they are', () => {
  for (const ch of KEPT) assert.deepEqual(controlParts(`a${ch}b`).parts, [`a${ch}b`], JSON.stringify(ch))
  assert.equal(withMarks('Subject: x\r\n\tfolded\r\n'), 'Subject: x\r\n\tfolded\r\n')
})

test('a lone CR (not before a LF) is marked; the CR of a CRLF is not', () => {
  assert.deepEqual(controlParts('a\rb\r\nc\r').parts, ['a', { mark: 'U+000D' }, 'b\r\nc', { mark: 'U+000D' }])
})

test('a word hidden in tag characters: every character of it is marked', () => {
  const hidden = [...'hi there'].map(c => cp(0xe0000 + c.codePointAt(0))).join('')
  const r = controlParts(`Invoice${hidden}.pdf`)
  assert.deepEqual(marksOf(r), ['U+E0068', 'U+E0069', 'U+E0020', 'U+E0074', 'U+E0068', 'U+E0065', 'U+E0072', 'U+E0065'])
  assert.equal(flat(r), 'Invoice⟨U+E0068⟩⟨U+E0069⟩⟨U+E0020⟩⟨U+E0074⟩⟨U+E0068⟩⟨U+E0065⟩⟨U+E0072⟩⟨U+E0065⟩.pdf')
})

test('the raw character never survives: the output has none of them', () => {
  const s = `Subject: ${MARKED.map(cp).join('x')} end`
  const out = flat(controlParts(s))
  CONTROL_RE.lastIndex = 0
  assert.equal(new RegExp(CONTROL_RE.source, 'u').test(out), false)
  assert.equal(out, withMarks(s))
})

test('past maxMarks no more marks, the rest are left out (not raw) and counted', () => {
  const s = `a${cp(0x202e)}b${cp(0x200b)}c${cp(0xe0041)}d`
  const r = controlParts(s, { maxMarks: 1 })
  assert.deepEqual(r.parts, ['a', { mark: 'U+202E' }, 'bcd'])
  assert.equal(r.unmarked, 2)
  assert.equal(r.cut, false)
  assert.deepEqual(controlParts(cp(0x202e).repeat(2), { maxMarks: 0 }), { parts: [], unmarked: 2, cut: false })
  assert.equal(MAX_MARKS, 10_000)
})

test('2 MB of control characters -> 10 000 marks, the exact count of the rest, the output within 2 MB, fast', () => {
  const s = '\u0001'.repeat(2 * 1024 * 1024)
  const t0 = performance.now()
  const r = controlParts(s)
  const ms = performance.now() - t0
  const out = flat(r)
  assert.equal(marksOf(r).length, MAX_MARKS)
  assert.equal(r.unmarked, s.length - MAX_MARKS)
  assert.ok(out.length <= MAX_OUTPUT_CHARS, `${out.length}`)
  assert.ok(!out.includes('\u0001'))
  assert.ok(ms < 1000, `${ms} ms`)
})

test('a text that would grow past the cap with its marks is cut there (cut: true), never past it, no half surrogate', () => {
  const s = `${'x'.repeat(1000)}${cp(0x202e).repeat(50)}${cp(0x1f600).repeat(500)}`
  const r = controlParts(s, { maxChars: 1500, reserve: 100 })
  const out = flat(r)
  assert.equal(r.cut, true)
  assert.ok(out.length <= 1400, `${out.length}`)
  assert.ok(!/[\ud800-\udbff]$/.test(out), 'no lone high surrogate at the end')
  // a 2 MB source with 10 000 marks: the marks do not push it past 2 MB
  const big = `${cp(0x200b)}y`.repeat(10_000) + 'z'.repeat(MAX_OUTPUT_CHARS - 20_000)
  const rb = controlParts(big)
  assert.equal(rb.cut, true)
  assert.ok(flat(rb).length <= MAX_OUTPUT_CHARS)
  // a source of exactly the cap without marks is not cut (the closing line comes on top)
  assert.equal(controlParts('q'.repeat(MAX_OUTPUT_CHARS)).cut, false)
})

test('empty and missing input', () => {
  assert.deepEqual(controlParts(''), { parts: [], unmarked: 0, cut: false })
  assert.deepEqual(controlParts(null), { parts: [], unmarked: 0, cut: false })
  assert.equal(withMarks(undefined), '')
  assert.equal(countMarks(null), 0)
})

test('markRuns merges neighbouring marks into one run; markCount counts the drawn and the left-out ones', () => {
  const r = controlParts(`a${'\u0001'.repeat(3)}b${cp(0xe0041)}`)
  assert.deepEqual(markRuns(r.parts), ['a', { marks: ['U+0001', 'U+0001', 'U+0001'] }, 'b', { marks: ['U+E0041'] }])
  assert.equal(markCount(r), 4)
  assert.equal(markCount(controlParts('\u0001'.repeat(15), { maxMarks: 10 })), 15)
})

test('readerText keeps tab, LF, CR, U+200B, U+200D, U+00AD (and emoji); leaves out U+0001, U+001F, U+007F, U+0085, U+009F, counted', () => {
  const keep = ['\t', '\n', '\r', cp(0x200b), cp(0x200d), cp(0xad), cp(0x1f600), cp(0xe0041)]
  const drop = [0x0001, 0x001f, 0x007f, 0x0085, 0x009f].map(cp)
  const r = readerText(`a${keep.join('')}${drop.join('')}b${drop.join('')}`)
  assert.equal(r.text, `a${keep.join('')}b`)
  assert.equal(r.removed, 10)
  assert.equal(r.hidden, 0)
})

test('past the limit the rest is not drawn, its exact code point count; a pair outside the BMP is never split', () => {
  assert.equal(MAX_READER_TEXT, 1024 * 1024)
  const r = readerText('abcdef', 4)
  assert.deepEqual(r, { text: 'abcd', removed: 0, hidden: 2 })
  const e = cp(0x1f600)
  const r2 = readerText(`ab${e}cd`, 3) // the cut would fall inside the emoji
  assert.deepEqual(r2, { text: 'ab', removed: 0, hidden: 3 })
  const r3 = readerText(`${cp(1)}x${cp(1)}y${e}z`, 3) // the limit counts the drawn text, after the drop
  assert.deepEqual(r3, { text: `xy`, removed: 2, hidden: 2 })
  assert.equal(codePointLength(`a${e}${e}b`), 4)
  const big = readerText(`x${cp(1)}`.repeat(1024 * 1024))
  assert.deepEqual([big.text.length, big.removed, big.hidden], [1024 * 1024, 1024 * 1024, 0])
})
