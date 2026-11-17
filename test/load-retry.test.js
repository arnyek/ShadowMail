// SPDX-License-Identifier: GPL-3.0-or-later
// The loaded-machine retry of the visible-text tests (test/helpers/load-retry.js): a failure on a quiet machine is
// thrown at once; on a loaded one the scenario runs again, at most 3 times in all; a success returns its value.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { retryWhenLoaded, LOADED_MS } from './helpers/load-retry.js'

const ctx = () => {
  const notes = []
  return { notes, diagnostic: n => notes.push(n) }
}
const failing = calls => async attempt => {
  calls.push(attempt)
  throw new assert.AssertionError({ message: `fail ${attempt}` })
}

test('a quiet machine: the first failure is thrown, no second run', async () => {
  const calls = []
  const t = ctx()
  await assert.rejects(retryWhenLoaded(t, failing(calls), { measure: () => LOADED_MS - 1 }), /fail 1/)
  assert.deepEqual(calls, [1])
  assert.deepEqual(t.notes, [])
})

test('a loaded machine: again, at most 3 runs, the last failure thrown; each retry says why', async () => {
  const calls = []
  const t = ctx()
  await assert.rejects(retryWhenLoaded(t, failing(calls), { measure: () => 2400 }), /fail 3/)
  assert.deepEqual(calls, [1, 2, 3])
  assert.equal(t.notes.length, 2)
  assert.match(t.notes[0], /attempt 1 .* 2400 ms/)
})

test('a success returns its value; a later success after a loaded failure too', async () => {
  const t = ctx()
  assert.equal(await retryWhenLoaded(t, async () => 42), 42)
  let n = 0
  const v = await retryWhenLoaded(t, async attempt => {
    n++
    if (attempt === 1) throw new Error('loaded')
    return attempt
  }, { measure: () => 3000 })
  assert.deepEqual([v, n], [2, 2])
})
