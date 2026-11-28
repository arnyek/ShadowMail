// The body phase's pending rows (migration 18, idx_messages_pending_idate): MailIndex.pendingBodies and
// pendingLocalBodies read the new index (the query plan, before and after ANALYZE, few and many pending rows) and give
// the very rows and order of the old query (on idx_messages_idate, ties of one date included); with nothing pending the
// IMAP body phase and the POP3 local body phase ask for no rows at all (a count first).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { MailIndex, BODY_STATE } from '../core/db/mail-index.js'
import { Syncer } from '../core/imap/sync.js'
import { Pop3Fetcher } from '../core/pop3/fetcher.js'
import { Pop3Client } from '../core/pop3/client.js'
import { memoryIndex, addAccount, sealedStore } from './helpers/fixtures.js'
import { onCleanup, tempDir } from './helpers/tmp.js'
import { FakeImapServer } from './helpers/fake-imap.js'
import { FakePop3Server } from './helpers/fake-pop3.js'

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0)
// the old queries, on the old index (the order the body phase had until migration 18)
const OLD_PENDING = `SELECT id, folder, uid FROM messages INDEXED BY idx_messages_idate
  WHERE account_id = ? AND body_state = 0 AND uid IS NOT NULL ORDER BY idate DESC LIMIT ?`
const OLD_LOCAL = `SELECT id, store_path FROM messages INDEXED BY idx_messages_idate
  WHERE account_id = ? AND body_state = 0 AND uid IS NULL AND store_path IS NOT NULL ORDER BY idate DESC LIMIT ?`
// MailIndex's own statements (pinned with INDEXED BY: unpinned, the planner left the index for the local rows after
// ANALYZE with many pending, measured)
const NEW_PENDING = 'SELECT id, folder, uid FROM messages INDEXED BY idx_messages_pending_idate WHERE account_id = ? AND body_state = 0 AND uid IS NOT NULL ORDER BY idate DESC LIMIT ?'
const NEW_LOCAL = 'SELECT id, store_path FROM messages INDEXED BY idx_messages_pending_idate WHERE account_id = ? AND body_state = 0 AND uid IS NULL AND store_path IS NOT NULL ORDER BY idate DESC LIMIT ?'
const plan = (db, sql) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(1, 500).map(r => r.detail).join(' | ')

/** two accounts: IMAP rows (uid) and POP3-like rows (no uid, a store path), every body state, many on one date */
function seed(t, { pendingShare }) {
  const { db, index } = memoryIndex(t)
  const a = addAccount(db)
  const b = addAccount(db)
  let rnd = 7
  const next = () => (rnd = (rnd * 48271) % 2147483647)
  const rows = []
  for (let i = 0; i < 6000; i++) {
    const acc = i % 5 ? a.id : b.id
    const local = i % 3 === 0
    const state = next() % 1000 < pendingShare * 1000 ? BODY_STATE.PENDING : [1, 2, 3][next() % 3]
    // a tenth share one date (ties), a few have none
    const idate = i % 10 === 0 ? NOW - 86_400_000 : i % 97 === 0 ? null : NOW - (next() % 500) * 3_600_000
    rows.push({ account_id: acc, folder: local ? 'INBOX' : ['INBOX', 'Sent', 'Régi'][i % 3], uid: local ? null : i + 1, pop3_uidl: local ? `u${i}` : null, message_id: `<p${i}@x>`, in_reply_to: null, refs: null, from_addr: 'a@example.invalid', from_name: 'A', to_addrs: 'b@example.invalid', cc_addrs: '', subject: `T ${i}`, date: idate, idate, flags: '', size: 1, has_attachments: 0, attachments: null, store_path: local && i % 2 ? `s/${i}.eml` : null, body_state: state, sender_text: 'a', recipients_text: 'b' })
  }
  for (let i = 0; i < rows.length; i += 1000) index.insertMany(rows.slice(i, i + 1000))
  return { db, index, a, b }
}

for (const pendingShare of [0, 0.02, 0.6]) {
  test(`pending ${pendingShare * 100}%: the new index in the plan (before and after ANALYZE), the rows and order of the old query`, t => {
    const { db, index, a, b } = seed(t, { pendingShare })
    // the statements under test are MailIndex's own
    assert.equal(index.s.pending.source.replace(/\s+/g, ' '), NEW_PENDING)
    assert.equal(index.s.pendingLocal.source.replace(/\s+/g, ' '), NEW_LOCAL)
    for (const when of ['before ANALYZE', 'after ANALYZE']) {
      if (when === 'after ANALYZE') db.exec('ANALYZE')
      assert.match(plan(db, NEW_PENDING), /USING (COVERING )?INDEX idx_messages_pending_idate \(account_id=\? AND body_state=\?/, `${when}: ${plan(db, NEW_PENDING)}`)
      assert.match(plan(db, NEW_LOCAL), /USING (COVERING )?INDEX idx_messages_pending_idate \(account_id=\? AND body_state=\?/, `${when}: ${plan(db, NEW_LOCAL)}`)
      assert.doesNotMatch(plan(db, NEW_PENDING), /TEMP B-TREE/, 'no sort: the index gives the order')
      assert.doesNotMatch(plan(db, NEW_LOCAL), /TEMP B-TREE/)
      for (const acc of [a.id, b.id]) {
        for (const limit of [1, 7, 500, 1_000_000]) {
          assert.deepEqual(index.pendingBodies(acc, limit), db.prepare(OLD_PENDING).all(acc, limit), `${when} IMAP ${acc} ${limit}`)
          assert.deepEqual(index.pendingLocalBodies(acc, limit), db.prepare(OLD_LOCAL).all(acc, limit), `${when} local ${acc} ${limit}`)
        }
        assert.equal(index.pendingCount(acc), db.prepare(OLD_PENDING).all(acc, 1_000_000).length)
        assert.equal(index.pendingLocalCount(acc), db.prepare(OLD_LOCAL).all(acc, 1_000_000).length)
      }
    }
    if (pendingShare) assert.ok(index.pendingBodies(a.id, 1_000_000).length > 10, 'pending rows are there')
  })
}

test('IMAP: nothing pending, the body phase asks for no rows and takes no gate; pending rows still come', async t => {
  const { db, index } = memoryIndex(t)
  const account = addAccount(db)
  const server = new FakeImapServer().addMailbox('INBOX')
  server.addMessages('INBOX', Array.from({ length: 5 }, (_, k) => ({ from: 'f@example.invalid', to: 't@example.invalid', subject: `S ${k}`, messageId: `<s${k}@x>`, date: NOW - k * 3_600_000, body: `szöveg ${k}` })))
  const calls = { pending: 0, gate: 0 }
  const pendingBodies = index.pendingBodies.bind(index)
  index.pendingBodies = (...a) => {
    calls.pending++
    return pendingBodies(...a)
  }
  const bodyGate = { acquire: () => (calls.gate++, { ready: Promise.resolve(() => {}), cancel() {} }) }
  const syncer = new Syncer({ account, index, connect: async () => server.client(), now: () => NOW, bodyGate })
  onCleanup(t, () => syncer.stop())
  await syncer.run()
  assert.ok(calls.pending >= 1 && calls.gate >= 1, 'the first run fetched the bodies')
  assert.equal(index.pendingCount(account.id), 0)
  calls.pending = calls.gate = 0
  await syncer.run()
  assert.deepEqual(calls, { pending: 0, gate: 0 }, 'nothing pending: no pendingBodies, no gate')
  server.addMessage('INBOX', { from: 'f@example.invalid', to: 't@example.invalid', subject: 'Új', messageId: '<new@x>', date: NOW, body: 'új szöveg' })
  await syncer.run()
  assert.ok(calls.pending >= 1, 'a new message: the body phase runs')
  assert.equal(db.prepare("SELECT body_state FROM messages WHERE subject = 'Új'").pluck().get(), BODY_STATE.INDEXED)
})

test('POP3: the local body phase counts first; nothing pending, no row is read', async t => {
  const server = await new FakePop3Server().listen()
  onCleanup(t, () => server.close())
  for (let i = 0; i < 3; i++) server.add(Buffer.from(`From: a@example.invalid\r\nSubject: P ${i}\r\nDate: ${new Date(NOW - i * 3_600_000).toUTCString()}\r\nMessage-ID: <q${i}@x>\r\n\r\nszöveg ${i}\r\n`))
  const { db, index } = memoryIndex(t)
  const account = addAccount(db, { type: 'pop3', in_port: server.port, in_host: '127.0.0.1', in_security: 'none', in_user: server.user })
  const calls = { local: 0 }
  const pendingLocalBodies = index.pendingLocalBodies.bind(index)
  index.pendingLocalBodies = (...a) => {
    calls.local++
    return pendingLocalBodies(...a)
  }
  const fetcher = new Pop3Fetcher({
    account,
    index,
    sealed: sealedStore(path.join(tempDir(t), 'store')),
    now: () => NOW,
    connect: async () => {
      const c = new Pop3Client({ host: '127.0.0.1', port: server.port, security: 'none', timeoutMs: 5000 })
      await c.connect()
      await c.login(server.user, server.pass)
      return c
    },
  })
  onCleanup(t, () => fetcher.stop())
  await fetcher.run()
  assert.equal(index.pendingLocalCount(account.id), 0)
  assert.equal(db.prepare('SELECT count(*) FROM messages WHERE body_state = 1').pluck().get(), 3)
  calls.local = 0
  await fetcher.run()
  assert.equal(calls.local, 0, 'nothing pending: no row read')
})

test('MailIndex.pendingLocalCount counts what pendingLocalBodies gives', t => {
  const { index, a, b } = seed(t, { pendingShare: 0.3 })
  for (const acc of [a.id, b.id]) assert.equal(index.pendingLocalCount(acc), index.pendingLocalBodies(acc, 1_000_000).length)
  assert.ok(MailIndex.prototype.pendingLocalCount)
})
