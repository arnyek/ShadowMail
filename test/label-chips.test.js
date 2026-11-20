// The label chips' pure rules (0.17.0): the palette and the text color by contrast (>= 4.5:1), the shortened name,
// the "at most 3 + N" of a row, the picker's three states.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  LABEL_PALETTE, CHIP_TEXT_DARK, CHIP_TEXT_LIGHT, contrast, chipTextColor, chipName, rowChips, pickState, pickToggle,
} from '../app/renderer/src/label-chips.js'

test('every palette color and a few custom ones get a text color of at least 4.5:1, the better of black and white', () => {
  assert.equal(LABEL_PALETTE.length, 12)
  assert.equal(new Set(LABEL_PALETTE).size, 12)
  for (const bg of [...LABEL_PALETTE, '#ffff00', '#000080', '#ffffff', '#000000', '#777777', '#767676', '#808080', '#00ff00', '#ff0000']) {
    const fg = chipTextColor(bg)
    const other = fg === CHIP_TEXT_DARK ? CHIP_TEXT_LIGHT : CHIP_TEXT_DARK
    assert.ok(contrast(bg, fg) >= 4.5, `${bg}: ${contrast(bg, fg).toFixed(2)}`)
    assert.ok(contrast(bg, fg) >= contrast(bg, other), `${bg}: the better one`)
  }
  assert.equal(chipTextColor('#ffff00'), CHIP_TEXT_DARK)
  assert.equal(chipTextColor('#000080'), CHIP_TEXT_LIGHT)
  // the worst background of all: a sweep of grays, each one >= 4.5:1
  for (let v = 0; v < 256; v++) {
    const h = v.toString(16).padStart(2, '0')
    const bg = `#${h}${h}${h}`
    assert.ok(contrast(bg, chipTextColor(bg)) >= 4.5, bg)
  }
  for (const bad of [null, 'red', '#fff', '#gggggg']) assert.equal(chipTextColor(bad), CHIP_TEXT_DARK)
  assert.equal(contrast('#000000', '#ffffff').toFixed(0), '21')
})

test('chipName: 12 characters, then an ellipsis; code points, not UTF-16 units', () => {
  assert.equal(chipName('Számla'), 'Számla')
  assert.equal(chipName('123456789012'), '123456789012')
  assert.equal(chipName('1234567890123'), '123456789012…')
  assert.equal(chipName('😀'.repeat(13)), `${'😀'.repeat(12)}…`)
  assert.equal(chipName(''), '')
  assert.equal(chipName(null), '')
})

test('rowChips: the list order, at most 3, the rest counted, unknown ids left out, the title names all', () => {
  const list = [{ id: 7, name: 'Első' }, { id: 3, name: 'Második' }, { id: 9, name: 'Harmadik' }, { id: 1, name: 'Negyedik' }]
  const r = rowChips([1, 9, 3, 7], list)
  assert.deepEqual(r.shown.map(l => l.id), [7, 3, 9])
  assert.equal(r.more, 1)
  assert.equal(r.title, 'Első, Második, Harmadik, Negyedik')
  assert.deepEqual(rowChips([3, 42], list).shown.map(l => l.id), [3], 'a deleted label is not drawn')
  assert.deepEqual(rowChips([3, 42], list).more, 0)
  assert.deepEqual(rowChips([], list), { shown: [], more: 0, all: [], title: '' })
  assert.deepEqual(rowChips(undefined, list).shown, [])
  assert.equal(rowChips([7, 3, 9], list).more, 0, 'exactly 3: no +N')
})

test('the picker: all / some / none over the chosen messages, and what a click does', () => {
  const rows = [[1, 2], [2], []]
  assert.equal(pickState(2, rows.slice(0, 2)), 'all')
  assert.equal(pickState(2, rows), 'some')
  assert.equal(pickState(1, rows), 'some')
  assert.equal(pickState(5, rows), 'none')
  assert.equal(pickState(1, []), 'none')
  assert.equal(pickToggle('all'), 'remove')
  assert.equal(pickToggle('some'), 'add')
  assert.equal(pickToggle('none'), 'add')
})

test('the optimistic view: a pending change applies to its rows only, in order; no change keeps the same array', async () => {
  const { changedLabels, labelsWithDeltas } = await import('../app/renderer/src/label-chips.js')
  const base = [1, 2]
  assert.equal(changedLabels(base, 1, 'add'), base, 'already on: the same array')
  assert.equal(changedLabels(base, 3, 'remove'), base, 'not on: the same array')
  assert.deepEqual(changedLabels(base, 3, 'add'), [1, 2, 3])
  assert.deepEqual(changedLabels(base, 1, 'remove'), [2])
  const deltas = [{ ids: new Set([10, 11]), labelId: 3, action: 'add' }, { ids: new Set([10]), labelId: 1, action: 'remove' }]
  assert.deepEqual(labelsWithDeltas(base, 10, deltas), [2, 3])
  assert.deepEqual(labelsWithDeltas(base, 11, deltas), [1, 2, 3])
  assert.equal(labelsWithDeltas(base, 12, deltas), base, 'another row: the stored array itself')
  assert.deepEqual(labelsWithDeltas(undefined, 12, []), [])
})
