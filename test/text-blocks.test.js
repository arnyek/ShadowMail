// Long text in blocks for drawing. Blocks of whole
// lines; only a line longer than LONG_LINE is cut, on a grapheme boundary. The characters are made with
// String.fromCodePoint, so this file holds no invisible character.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { textBlocks, cutPoints, partBlocks, CHUNK, LONG_LINE } from '../core/mime/text-blocks.js'

const cp = n => String.fromCodePoint(n)
const cps = s => [...s].length
const LF = String.fromCharCode(10)
const CR = String.fromCharCode(13)
const TAB = String.fromCharCode(9)
const HEB = cp(0x5d0)
const EMOJI = cp(0x1f600)
const COMB = cp(0x300)
const ZWJ = cp(0x200d)
const FLAG_HU = cp(0x1f1ed) + cp(0x1f1fa)
const THUMB_SKIN = cp(0x1f44d) + cp(0x1f3fd)
const TAG_FLAG = cp(0x1f3f4) + [0xe0067, 0xe0062, 0xe0065, 0xe006e, 0xe0067].map(cp).join('') + cp(0xe007f)
const HANGUL_LVT = cp(0x1100) + cp(0x1161) + cp(0x11a8)
const FAMILY = [0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467].map(cp).join('')
const graphemeBoundaries = s => new Set([...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)].map(x => x.index).concat([s.length]))
const lineEnds = s => {
  const set = new Set([s.length])
  for (let i = s.indexOf(LF); i !== -1; i = s.indexOf(LF, i + 1)) set.add(i + 1)
  return set
}

const LONG = {
  // each longer than LONG_LINE (3000 code points), so it is cut
  hebrew: `x${HEB}`.repeat(6500),
  emoji: `x${EMOJI}`.repeat(6000),
  combining: `x${COMB}`.repeat(6500),
  lonecr: `x${CR}`.repeat(6500),
  tabs: `x${TAB}`.repeat(6500),
  flags: `y${FLAG_HU}`.repeat(4000),
  skin: `y${THUMB_SKIN}`.repeat(4000),
  tagflag: TAG_FLAG.repeat(2000),
  hangul: HANGUL_LVT.repeat(4000),
  family: `${FAMILY} `.repeat(2000),
  nospace: 'a'.repeat(12_500),
  words: 'szó '.repeat(3000),
}

test('the blocks joined are the text, byte for byte; every cut is on a grapheme boundary (CRLF, flag, skin tone, tags, Hangul, ZWJ)', () => {
  assert.equal(CHUNK, 1000)
  assert.equal(LONG_LINE, 3000)
  const all = { ...LONG, ordinary: `Kedves Bence,${CR}${LF}Árvíztűrő tükörfúrógép.${CR}${LF}`.repeat(400), crlfcut: `${'a'.repeat(999)}${CR}${LF}`.repeat(4) }
  for (const [name, s] of Object.entries(all)) {
    const b = textBlocks(s)
    assert.equal(b.join(''), s, name)
    assert.ok(b.every(x => x.length > 0), `${name}: no empty block`)
    const bounds = graphemeBoundaries(s)
    const bad = cutPoints(s).filter(c => !bounds.has(c))
    assert.deepEqual(bad, [], `${name}: cuts inside a grapheme`)
  }
  assert.deepEqual(textBlocks(''), [])
  assert.deepEqual(textBlocks(null), [])
})

test('a line up to LONG_LINE is never cut: blocks are whole lines (a line between CHUNK and LONG_LINE is a block of its own)', () => {
  const para = 'Ez egy hosszú bekezdés, ahogy a format=flowed levélből a mailparser után egy sorban jön. '.repeat(30) // ~2700
  assert.ok(cps(para) > CHUNK && cps(para) <= LONG_LINE)
  const link = `https://example.invalid/${'a1b2c3d4e5'.repeat(250)}`
  const s = `Szia,${LF}${para}${LF}${link}${LF}Üdv,${LF}${'rövid sor'.repeat(5)}${LF}`.repeat(5)
  const cuts = cutPoints(s)
  const ends = lineEnds(s)
  assert.deepEqual(cuts.filter(c => !ends.has(c)), [], 'every cut at a line end')
  for (const b of textBlocks(s)) {
    const lines = b.split(LF).filter(Boolean)
    // a block is either lines that fit CHUNK together, or one long line
    assert.ok(cps(b) <= CHUNK || lines.length === 1, `${cps(b)} code points in ${lines.length} lines`)
  }
  // a line of exactly LONG_LINE code points is one block (not cut); one more code point and it is cut
  const exact = `x${HEB}`.repeat(LONG_LINE / 2)
  assert.deepEqual(textBlocks(`${exact}${LF}vége`).map(cps), [LONG_LINE + 1, 4])
  assert.ok(textBlocks(`${exact}y`).length > 1)
  // short lines: every cut is right after a line feed, and no block passes CHUNK
  const ordinary = `Kedves Bence,${CR}${LF}Árvíztűrő tükörfúrógép, ékezetes sor.${CR}${LF}`.repeat(400)
  const ob = textBlocks(ordinary)
  assert.ok(ob.length > 1 && ob.slice(0, -1).every(x => x.endsWith(LF)) && ob.every(x => cps(x) <= CHUNK))
})

test('only a line longer than LONG_LINE is cut: every CHUNK, after the last space, else hard; no piece over CHUNK', () => {
  for (const [name, s] of Object.entries(LONG)) {
    const b = textBlocks(s)
    assert.ok(b.length > 1, name)
    assert.ok(b.every(x => cps(x) <= CHUNK), `${name}: ${Math.max(...b.map(cps))}`)
  }
  assert.ok(textBlocks(LONG.words).slice(0, -1).every(x => x.endsWith(' ')))
  assert.deepEqual(textBlocks(LONG.nospace).map(x => x.length), [...Array(12).fill(1000), 500])
  // a pair split by a hard cut would break a flag or a skin tone: the cut moves back to the boundary
  const odd = `z${FLAG_HU.repeat(6000)}`
  assert.deepEqual(cutPoints(odd).filter(c => !graphemeBoundaries(odd).has(c)), [])
})

test('partBlocks: a mark counts as one character, a mark run is never cut, the order is kept', () => {
  // a 2000-character line with 900 marks in it is a real line: one block, not cut by the length of its signs
  const runs = []
  for (let i = 0; i < 900; i++) runs.push('ab', { marks: ['U+200D'] })
  runs.push(`${'c'.repeat(200)}${LF}`, 'utolsó sor')
  const blocks = partBlocks(runs)
  const enc = x => (typeof x === 'string' ? x : `<${x.marks.join(',')}>`)
  assert.equal(blocks.flat().map(enc).join(''), runs.map(enc).join(''))
  assert.equal(blocks.length, 2, 'the long line whole, then the last line')
  // a line far over LONG_LINE is cut, but never inside a mark run
  const long = []
  for (let i = 0; i < 3000; i++) long.push('xy', { marks: ['U+0001', 'U+0001'] })
  const lb = partBlocks(long)
  assert.ok(lb.length > 1)
  assert.equal(lb.flat().filter(x => typeof x !== 'string').reduce((n, m) => n + m.marks.length, 0), 6000, 'every mark once, whole')
  assert.deepEqual(partBlocks([]), [])
})

test('speed: 2 MB of each alternating pattern is cut in well under 300 ms', () => {
  for (const unit of [`x${HEB}`, `x${EMOJI}`, `x${COMB}`, `x${CR}`, `y${FLAG_HU}`]) {
    const s = unit.repeat(Math.floor((2 * 1024 * 1024) / unit.length))
    const t0 = performance.now()
    const b = textBlocks(s)
    const ms = performance.now() - t0
    assert.equal(b.join(''), s)
    assert.ok(ms < 300, `${JSON.stringify(unit)}: ${ms} ms`)
  }
})
