// MCP M3B: the confirmation queue. The stored payload runs, only if its hash is still the one of
// the request (a changed request -> hash_mismatch, nothing runs); at most 5 wait; a call waits for the decision or
// answers pending_confirmation; 10 minutes -> expired (injected clock); lock / quit / switch-off reject all.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ConfirmationQueue, canonicalJson, MAX_PENDING, EXPIRE_MS } from '../app/main/mcp/confirm.js'

const make = () => {
  let clock = Date.UTC(2026, 10, 13, 7, 0, 0)
  const seen = { requests: [], settled: [], logs: [] }
  const q = new ConfirmationQueue({ now: () => clock, onRequest: v => seen.requests.push(v), onSettled: v => seen.settled.push(v), log: l => seen.logs.push(l) })
  return { q, seen, tick: ms => (clock += ms) }
}

test('canonicalJson: key order does not matter, values do', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } }), canonicalJson({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }))
  assert.notEqual(canonicalJson({ a: 1 }), canonicalJson({ a: '1' }))
})

test('approve runs the STORED payload; a request changed after it was made never runs (hash_mismatch)', async () => {
  const { q, seen } = make()
  const ran = []
  const id = q.create({ tool: 'send_message', view: { to: 'a@example.invalid' }, payload: { to: ['a@example.invalid'], subject: 'S' }, execute: async p => (ran.push(p), { sent: true }) })
  assert.equal(seen.requests.length, 1)
  assert.equal(seen.requests[0].view.to, 'a@example.invalid')
  assert.ok(!('payload' in seen.requests[0]) && !('hash' in seen.requests[0]), 'the Modal gets the view only')
  const st = await q.approve(id)
  assert.deepEqual(st, { id, status: 'approved', result: { sent: true } })
  assert.deepEqual(ran, [{ to: ['a@example.invalid'], subject: 'S' }])

  const id2 = q.create({ tool: 'send_message', view: {}, payload: { to: ['a@example.invalid'] }, execute: async p => (ran.push(p), {}) })
  q.get(id2).payload.to.push('evil@example.invalid') // the test reaches in, as a bug or an attacker would
  assert.deepEqual(await q.approve(id2), { id: id2, status: 'failed', error: 'hash_mismatch' })
  assert.equal(ran.length, 1, 'nothing ran')
  assert.ok(seen.logs.every(l => !l.includes('a@example.invalid')), 'no content in the log')
})

test('at most 5 pending; the same key gives the waiting request back; reject and rejectAll', async () => {
  const { q } = make()
  const ids = Array.from({ length: MAX_PENDING }, (_, i) => q.create({ tool: 't', view: {}, payload: { i }, execute: async () => ({}) }))
  assert.throws(() => q.create({ tool: 't', view: {}, payload: { i: 9 }, execute: async () => ({}) }), { code: 'too_many_pending' })
  assert.equal(q.reject(ids[0]).status, 'rejected')
  const k1 = q.create({ tool: 'sync_account', view: {}, payload: { a: 1 }, key: 'restart:1', execute: async () => ({}) })
  const k2 = q.create({ tool: 'sync_account', view: {}, payload: { a: 1 }, key: 'restart:1', execute: async () => ({}) })
  assert.equal(k1, k2)
  q.rejectAll('locked')
  for (const id of [...ids.slice(1), k1]) assert.deepEqual(q.status(id), { id, status: 'rejected', error: 'locked' })
  assert.equal(q.pending().length, 0)
})

test('wait: the decision when it comes, pending_confirmation after the limit; 10 minutes -> expired', async () => {
  const { q, tick } = make()
  const id = q.create({ tool: 't', view: {}, payload: {}, execute: async () => ({ ok: 1 }) })
  const short = await q.wait(id, 20)
  assert.deepEqual(short, { id, status: 'pending_confirmation' })
  const waiting = q.wait(id, 5000)
  await q.approve(id)
  assert.deepEqual(await waiting, { id, status: 'approved', result: { ok: 1 } })

  const old = q.create({ tool: 't', view: {}, payload: { x: 1 }, execute: async () => ({}) })
  tick(EXPIRE_MS)
  assert.equal(q.status(old).status, 'expired')
  assert.equal((await q.approve(old)).status, 'expired', 'an expired request is not run')
})

test('a failing execute is failed with its code; an unknown id is not_found', async () => {
  const { q } = make()
  const id = q.create({ tool: 't', view: {}, payload: {}, execute: async () => { throw Object.assign(new Error('x'), { code: 'server_refused' }) } })
  assert.deepEqual(await q.approve(id), { id, status: 'failed', error: 'server_refused' })
  assert.deepEqual(q.status('nincs'), { id: 'nincs', status: 'not_found' })
})

test('a decided request keeps only its status; the expiry comes on its own; only the newest MAX_SETTLED stay', async t => {
  const { MAX_SETTLED } = await import('../app/main/mcp/confirm.js')
  const settled = []
  const q = new ConfirmationQueue({ onSettled: v => settled.push(v) })
  const id = q.create({ tool: 't', view: { big: 'x'.repeat(1000) }, payload: { big: 'y'.repeat(1000) }, execute: async () => ({ text: 'ok' }) })
  await q.approve(id)
  const item = q.get(id)
  assert.deepEqual([item.payload, item.view, item.execute], [null, null, null], 'nothing of the request is kept')
  assert.equal(q.status(id).status, 'approved', 'its status still answers')
  assert.equal(settled[0].view.big.length, 1000, 'onSettled still got the view')
  for (let i = 0; i < MAX_SETTLED + 20; i++) q.reject(q.create({ tool: 't', view: {}, payload: { i }, execute: async () => {} }))
  assert.equal(q.status(id).status, 'not_found', 'the oldest decided ones are dropped')
  // the expiry timer: with a real clock the request lapses without anyone asking
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const q2 = new ConfirmationQueue({ onSettled: v => settled.push(v) })
  const late = q2.create({ tool: 't', view: {}, payload: {}, execute: async () => {} })
  t.mock.timers.tick(EXPIRE_MS + 200)
  assert.equal(settled.at(-1).id, late)
  assert.equal(settled.at(-1).status, 'expired', 'expired with no call to the queue')
})
