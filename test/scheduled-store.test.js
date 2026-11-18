// "Küldés később" (scheduled): the row rules of core/db/scheduled.js on the real schema (migration 13): the due order,
// the three retries 1 / 5 / 15 minutes, a permanent error, the 24-hour late rule, a row left 'sending', the send-time limits.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memoryIndex, addAccount } from './helpers/fixtures.js'
import { Scheduled, checkSendAt, RETRY_DELAYS_MS, LATE_LIMIT_MS, MIN_AHEAD_MS, MAX_AHEAD_MS, INTERRUPTED } from '../core/db/scheduled.js'

const NOW = Date.UTC(2026, 10, 18, 9)
const MIN = 60_000

function setup(t) {
  const { db } = memoryIndex(t)
  const acc = addAccount(db).id
  const s = new Scheduled(db)
  const add = (sendAt, extra = {}) => s.add({ accountId: acc, sendAt, subject: 'T', recipients: 'a@example.invalid', payloadPath: `${acc}/scheduled-${sendAt}`, now: NOW, ...extra })
  return { db, s, acc, add }
}

test('the send time: at least a minute ahead, at most about a year, a number', () => {
  assert.equal(checkSendAt(NOW + MIN_AHEAD_MS, NOW), NOW + MIN_AHEAD_MS)
  assert.equal(checkSendAt(NOW + MAX_AHEAD_MS, NOW), NOW + MAX_AHEAD_MS)
  for (const [v, code] of [[NOW + MIN_AHEAD_MS - 1, 'too_soon'], [NOW - 1, 'too_soon'], [NOW + MAX_AHEAD_MS + 1, 'too_far'], [NaN, 'bad_time'], ['1', 'bad_time'], [Infinity, 'bad_time']]) {
    assert.throws(() => checkSendAt(v, NOW), { code }, String(v))
  }
})

test('due: only waiting rows whose time (or retry time) has come, the earliest first; nextAt is the next wake-up', t => {
  const { s, add } = setup(t)
  assert.equal(s.due(NOW), null)
  assert.equal(s.nextAt(), null)
  const later = add(NOW + 10 * MIN)
  const sooner = add(NOW + 5 * MIN)
  assert.equal(s.nextAt(), NOW + 5 * MIN)
  assert.equal(s.due(NOW + 4 * MIN), null)
  assert.equal(s.due(NOW + 5 * MIN).id, sooner)
  assert.equal(s.due(NOW + 20 * MIN).id, sooner, 'the earliest first')
  assert.ok(s.begin(sooner))
  assert.equal(s.begin(sooner), false, 'not waiting any more: not picked up twice')
  assert.equal(s.due(NOW + 20 * MIN).id, later)
  assert.equal(s.get(sooner).state, 'sending')
  assert.equal(s.done(sooner), `${s.get(later).account_id}/scheduled-${NOW + 5 * MIN}`)
  assert.equal(s.get(sooner), null, 'sent: the row goes')
})

test('a temporary error: three retries after 1, 5 and 15 minutes, then failed; a permanent one fails at once; the tries are counted', t => {
  const { s, add } = setup(t)
  const id = add(NOW + MIN)
  let at = NOW + MIN
  for (let i = 0; i < RETRY_DELAYS_MS.length; i++) {
    assert.equal(s.due(at).id, id)
    assert.ok(s.begin(id))
    const r = s.failed(id, 'timeout', { now: at })
    assert.deepEqual(r, { state: 'waiting', nextTryAt: at + RETRY_DELAYS_MS[i] })
    assert.equal(s.due(at + RETRY_DELAYS_MS[i] - 1), null, 'not before its retry time')
    at += RETRY_DELAYS_MS[i]
  }
  assert.deepEqual(RETRY_DELAYS_MS, [MIN, 5 * MIN, 15 * MIN])
  assert.ok(s.begin(s.due(at).id))
  assert.deepEqual(s.failed(id, 'timeout', { now: at }), { state: 'failed', nextTryAt: null })
  assert.deepEqual([s.get(id).state, s.get(id).attempts, s.get(id).last_error], ['failed', 4, 'timeout'])
  assert.equal(s.due(at + 60 * MIN), null, 'a failed row is never picked up on its own')
  const p = add(NOW + 2 * MIN)
  s.begin(p)
  assert.deepEqual(s.failed(p, 'auth_failed', { permanent: true, now: NOW }), { state: 'failed', nextTryAt: null })
  assert.equal(s.get(p).attempts, 1)
})

test('settle: a row left sending fails as interrupted (it may have gone out, never sent again on its own); more than 24 hours past its time: late (a retry too: measured at the moment it would go); within 24 hours: still due', t => {
  const { s, add } = setup(t)
  const sending = add(NOW - 10 * MIN)
  s.begin(sending)
  const old = add(NOW - LATE_LIMIT_MS - 1)
  const recent = add(NOW - LATE_LIMIT_MS + MIN)
  const retried = add(NOW - LATE_LIMIT_MS - 5 * MIN)
  s.begin(retried)
  s.failed(retried, 'timeout', { now: NOW - LATE_LIMIT_MS - 4 * MIN })
  const r = s.settle(NOW)
  assert.deepEqual(r.interrupted, [sending])
  assert.deepEqual(r.late.sort(), [old, retried].sort())
  assert.deepEqual([s.get(sending).state, s.get(sending).last_error], ['failed', INTERRUPTED])
  assert.equal(s.get(old).state, 'late')
  assert.equal(s.get(recent).state, 'waiting')
  assert.equal(s.get(retried).state, 'late', 'a retry more than a day past its time is late too')
  assert.equal(s.due(NOW).id, recent)
})

test('reschedule: a failed or late row waits again with a new time, its tries counted anew; a sending row is left alone; remove gives the payload path', t => {
  const { s, add } = setup(t)
  const a = add(NOW + MIN)
  s.begin(a)
  s.failed(a, 'auth_failed', { permanent: true, now: NOW })
  assert.ok(s.reschedule(a, NOW + 30 * MIN))
  assert.deepEqual([s.get(a).state, s.get(a).attempts, s.get(a).last_error, s.get(a).send_at], ['waiting', 0, null, NOW + 30 * MIN])
  const b = add(NOW + MIN)
  s.begin(b)
  assert.equal(s.reschedule(b, NOW + 30 * MIN), false)
  assert.equal(s.remove(b), null, 'sending: not removed')
  assert.ok(s.remove(a).endsWith(`scheduled-${NOW + MIN}`))
  assert.equal(s.get(a), null)
})
