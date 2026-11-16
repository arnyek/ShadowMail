// applyBodyLimit: lowering the limit and aging take the text out of the
// index unless the message is pinned; raising it re-queues the rows for the body phase.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memoryIndex, addAccount, DAY } from './helpers/fixtures.js'
import { FakeImapServer } from './helpers/fake-imap.js'
import { Syncer } from '../core/imap/sync.js'
import { applyBodyLimit, bodyCutoff, withinBodyLimit } from '../core/db/body-limit.js'
import { BODY_STATE } from '../core/db/mail-index.js'

const NOW = Date.UTC(2026, 10, 11, 12, 0, 0)
const YEAR = 365 * DAY

function setup(t) {
  const { db, index } = memoryIndex(t)
  let account = addAccount(db, { body_index_days: 1095 })
  const server = new FakeImapServer().addMailbox('INBOX')
  const uid = server.addMessage('INBOX', {
    from: 'partner@example.invalid', to: 'en@example.invalid', subject: 'Keretszerződés', messageId: '<two@x>',
    date: NOW - 2 * YEAR, body: 'A kétéves levél szövege: napkollektor karbantartás.',
  })
  const syncer = new Syncer({ account, index, connect: async () => server.client(), now: () => NOW })
  const row = () => index.getByUid(account.id, 'INBOX', uid)
  const setLimit = days => {
    db.prepare('UPDATE accounts SET body_index_days = ? WHERE id = ?').run(days, account.id)
    account = { ...account, body_index_days: days }
    syncer.account = account
    return account
  }
  const textHits = () => index.search({ query: 'napkollektor' }).length
  const subjectHits = () => index.search({ query: 'keretszerzodes' }).length
  return { db, index, server, syncer, row, setLimit, textHits, subjectHits }
}

test('1095 -> 365: a 2-year-old indexed message loses its text (state 3), keeps subject, row and preview', async t => {
  const { index, syncer, row, setLimit, textHits, subjectHits } = setup(t)
  await syncer.run()
  assert.equal(row().body_state, BODY_STATE.INDEXED)
  assert.equal(textHits(), 1)
  const preview = row().preview
  assert.match(preview, /napkollektor/)

  const result = applyBodyLimit(index, setLimit(365), NOW)
  assert.deepEqual(result, { cleared: 1, requeued: 0 })
  assert.equal(row().body_state, BODY_STATE.BEYOND_LIMIT)
  assert.equal(textHits(), 0, 'the text is no longer searchable')
  assert.equal(subjectHits(), 1, 'the subject still is')
  assert.equal(row().preview, preview, 'the preview stays')
})

test('a pinned (opened) message keeps its text under the lower limit', async t => {
  const { index, syncer, row, setLimit, textHits } = setup(t)
  await syncer.run()
  index.setPinned(row().id)
  assert.deepEqual(applyBodyLimit(index, setLimit(365), NOW), { cleared: 0, requeued: 0 })
  assert.equal(row().body_state, BODY_STATE.INDEXED)
  assert.equal(textHits(), 1)
})

test('back to 1095: the 2-year-old row returns to state 0 and the body phase fills the text in', async t => {
  const { index, server, syncer, row, setLimit, textHits } = setup(t)
  await syncer.run()
  applyBodyLimit(index, setLimit(365), NOW)
  assert.equal(textHits(), 0)

  assert.deepEqual(applyBodyLimit(index, setLimit(1095), NOW), { cleared: 0, requeued: 1 })
  assert.equal(row().body_state, BODY_STATE.PENDING)

  server.fetchLog.length = 0
  await syncer.run()
  assert.equal(row().body_state, BODY_STATE.INDEXED)
  assert.equal(server.sourceFetches().length, 1, 'downloaded again')
  assert.equal(textHits(), 1)
})

test('aging: moving `now` forward takes the text out the same way, and the sync does it on its own', async t => {
  const { index, syncer, row, textHits, subjectHits } = setup(t)
  await syncer.run()
  // two years later the message is 4 years old: beyond 1095 days
  const later = NOW + 2 * YEAR
  syncer.now = () => later
  await syncer.run()
  assert.equal(syncer.state.lastCleared, 1)
  assert.equal(row().body_state, BODY_STATE.BEYOND_LIMIT)
  assert.equal(textHits(), 0)
  assert.equal(subjectHits(), 1)
  // and a pinned one would have stayed
  assert.equal(index.applyBodyLimit(row().account_id, later - 1095 * DAY).cleared, 0)
})

test('a pending (not yet downloaded) row beyond a lowered limit is skipped instead of downloaded', async t => {
  const { index, server, syncer, row, setLimit } = setup(t)
  // metadata only, no body phase yet
  const client = await syncer.connect()
  await syncer.syncFolder(client, { path: 'INBOX', delimiter: '/' }, bodyCutoff(syncer.account, NOW), false)
  assert.equal(row().body_state, BODY_STATE.PENDING)
  assert.deepEqual(applyBodyLimit(index, setLimit(365), NOW), { cleared: 1, requeued: 0 })
  assert.equal(row().body_state, BODY_STATE.BEYOND_LIMIT)
  server.fetchLog.length = 0
  await syncer.run()
  assert.deepEqual(server.sourceFetches(), [])
})

test('limit 0 = all: nothing is beyond; a message without a date counts as inside', () => {
  assert.equal(bodyCutoff({ body_index_days: 0 }, NOW), null)
  assert.equal(bodyCutoff({ body_index_days: 365 }, NOW), NOW - 365 * DAY)
  assert.equal(withinBodyLimit(NOW - 10 * YEAR, null), true)
  assert.equal(withinBodyLimit(null, NOW - YEAR), true)
  assert.equal(withinBodyLimit(NOW - 2 * YEAR, NOW - YEAR), false)
})

test('the reconciler only touches its own account', async t => {
  const { db, index, syncer, row, textHits } = setup(t)
  await syncer.run()
  const other = addAccount(db, { body_index_days: 365 })
  assert.deepEqual(applyBodyLimit(index, other, NOW), { cleared: 0, requeued: 0 })
  assert.equal(row().body_state, BODY_STATE.INDEXED)
  assert.equal(textHits(), 1)
})
