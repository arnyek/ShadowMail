// SPDX-License-Identifier: GPL-3.0-or-later
// The Shift selection of the message list (rangeSelect): the checkbox's 'set' (the range takes the state the clicked
// row turns to, the rest stays), the row's 'replace' and Ctrl+Shift's 'add'; an anchor or a target not in the list.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rangeSelect } from '../app/renderer/src/range-select.js'

const ids = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]
const set = (...xs) => new Set(xs)
const sorted = s => [...s].sort((a, b) => a - b)

test("'set': selecting from the anchor to an unselected row adds the range, the rest stays", () => {
  assert.deepEqual(sorted(rangeSelect(set(10, 19), ids, 12, 15, 'set')), [10, 12, 13, 14, 15, 19])
  assert.deepEqual(sorted(rangeSelect(set(), ids, 15, 12, 'set')), [12, 13, 14, 15], 'upwards too')
})

test("'set': Shift on a selected row takes the whole range out (the usual webmail way), the rest stays", () => {
  assert.deepEqual(sorted(rangeSelect(set(12, 13, 14, 15, 16, 18), ids, 18, 14, 'set')), [12, 13])
})

test("'replace' and 'add'", () => {
  assert.deepEqual(sorted(rangeSelect(set(10, 19), ids, 12, 14, 'replace')), [12, 13, 14])
  assert.deepEqual(sorted(rangeSelect(set(10, 19), ids, 12, 14, 'add')), [10, 12, 13, 14, 19])
  assert.deepEqual(sorted(rangeSelect(set(12, 13), ids, 12, 14, 'add')), [12, 13, 14], 'a selected target still adds')
})

test('an anchor or a target that is not in the list: null (the caller toggles one row); the input set is not changed', () => {
  const prev = set(11)
  assert.equal(rangeSelect(prev, ids, 99, 12, 'set'), null)
  assert.equal(rangeSelect(prev, ids, 12, 99, 'replace'), null)
  rangeSelect(prev, ids, 10, 14, 'set')
  assert.deepEqual(sorted(prev), [11])
})

test('100 000 ids: a range from one end to the other in well under the 300 ms budget', () => {
  const big = Array.from({ length: 100_000 }, (_, i) => i + 1)
  const t0 = performance.now()
  const next = rangeSelect(new Set(), big, 1, 100_000, 'set')
  const ms = performance.now() - t0
  assert.equal(next.size, 100_000)
  assert.ok(ms < 150, `${ms.toFixed(1)} ms`)
})
