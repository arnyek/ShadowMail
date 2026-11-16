// Sync decision logic with a fake IMAP client (no network): the body limit.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { memoryIndex, addAccount, DAY, sealedStore } from './helpers/fixtures.js'
import { tempDir } from './helpers/tmp.js'
import { FakeImapServer } from './helpers/fake-imap.js'
import { Syncer, bodyCutoff } from '../core/imap/sync.js'
import { BODY_STATE } from '../core/db/mail-index.js'

const NOW = Date.UTC(2026, 10, 11, 12, 0, 0)
const YEAR = 365 * DAY

function setup(t, { bodyIndexDays = 1095 } = {}) {
  const { db, index } = memoryIndex(t)
  const account = addAccount(db, { body_index_days: bodyIndexDays })
  const server = new FakeImapServer().addMailbox('INBOX')
  const oldUid = server.addMessage('INBOX', {
    from: 'regi@example.invalid', to: 'en@example.invalid', subject: 'Régi szerződés', messageId: '<old@x>',
    date: NOW - 4 * YEAR, body: 'A négy éves levél szövege: kazánkarbantartás.',
  })
  const newUid = server.addMessage('INBOX', {
    from: 'uj@example.invalid', to: 'en@example.invalid', subject: 'Friss ajánlat', messageId: '<new@x>',
    date: NOW - YEAR, body: 'Az egy éves levél szövege: hőszivattyú ajánlat.',
  })
  const syncer = new Syncer({ account, index, connect: async () => server.client(), now: () => NOW })
  const row = uid => index.getByUid(account.id, 'INBOX', uid)
  return { db, index, account, server, syncer, row, oldUid, newUid }
}

test('1095-day limit: a 4-year-old message is stored headers-only (state 3, no body fetch), a 1-year-old one is indexed', async t => {
  const { index, server, syncer, row, oldUid, newUid } = setup(t)
  await syncer.run()

  assert.equal(row(oldUid).body_state, BODY_STATE.BEYOND_LIMIT)
  assert.equal(row(oldUid).subject, 'Régi szerződés')
  assert.equal(row(oldUid).preview, null)
  assert.equal(row(newUid).body_state, BODY_STATE.INDEXED)
  assert.match(row(newUid).preview, /hőszivattyú ajánlat/)
  assert.deepEqual(server.sourceFetches(), [newUid], 'only the message inside the limit was downloaded')

  // search: the old one by its subject, not by its text; the new one by its text
  assert.deepEqual(index.search({ query: 'szerződés' }).map(r => r.uid), [oldUid])
  assert.deepEqual(index.search({ query: 'kazankarbantartas' }), [])
  assert.deepEqual(index.search({ query: 'hoszivattyu' }).map(r => r.uid), [newUid])
})

test('the sync decision before the body phase: 4-year-old -> 3, 1-year-old -> 0', async t => {
  const { syncer, row, oldUid, newUid } = setup(t)
  // run only the metadata phase of one folder
  const client = await syncer.connect()
  await syncer.syncFolder(client, { path: 'INBOX', delimiter: '/' }, bodyCutoff(syncer.account, NOW), false)
  assert.equal(row(oldUid).body_state, BODY_STATE.BEYOND_LIMIT)
  assert.equal(row(newUid).body_state, BODY_STATE.PENDING)
})

test('setting the limit to 0 (no limit) re-queues the old message and the next run indexes it', async t => {
  const { db, index, server, syncer, row, oldUid, account } = setup(t)
  await syncer.run()
  assert.equal(row(oldUid).body_state, BODY_STATE.BEYOND_LIMIT)

  db.prepare('UPDATE accounts SET body_index_days = 0 WHERE id = ?').run(account.id)
  syncer.account = { ...account, body_index_days: 0 }
  assert.deepEqual(index.applyBodyLimit(account.id, bodyCutoff(syncer.account, NOW)), { cleared: 0, requeued: 1 })
  assert.equal(row(oldUid).body_state, BODY_STATE.PENDING, 'state 3 -> 0 after the limit change')

  server.fetchLog.length = 0
  await syncer.run()
  assert.equal(row(oldUid).body_state, BODY_STATE.INDEXED)
  assert.deepEqual(server.sourceFetches(), [oldUid])
  assert.deepEqual(index.search({ query: 'kazankarbantartas' }).map(r => r.uid), [oldUid])
})

test('the limit never deletes rows: lowering it keeps every row and header', async t => {
  const { index, syncer, row, newUid, oldUid, account } = setup(t)
  await syncer.run()
  syncer.account = { ...account, body_index_days: 30 }
  await syncer.run()
  assert.equal(index.stats(account.id).total, 2)
  assert.equal(row(newUid).subject, 'Friss ajánlat')
  assert.equal(row(oldUid).subject, 'Régi szerződés')
})

test('a message deleted on the server disappears, whatever its age; flags are refreshed', async t => {
  const { index, server, syncer, row, oldUid, newUid, account } = setup(t)
  await syncer.run()
  server.deleteMessage('INBOX', oldUid)
  server.mailboxes.get('INBOX').messages.get(newUid).flags.add('\\Seen')
  await syncer.run()
  assert.equal(row(oldUid), undefined)
  assert.equal(row(newUid).flags, '\\Seen')
  assert.equal(syncer.state.lastRemoved, 1)
  assert.equal(index.stats(account.id).total, 1)
})

test('a message deleted on the server takes its stored file with it', async t => {
  const { db, index, server, account, oldUid, newUid, row } = setup(t)
  const sealed = sealedStore(tempDir(t))
  const syncer = new Syncer({ account, index, connect: async () => server.client(), now: () => NOW, sealed })
  await syncer.run()
  // both opened once: their files are in the store
  for (const uid of [oldUid, newUid]) {
    const r = row(uid)
    sealed.write(`${account.id}/${r.id}.eml`, Buffer.from('Subject: x\r\n\r\ny'))
    db.prepare('UPDATE messages SET store_path = ? WHERE id = ?').run(`${account.id}/${r.id}.eml`, r.id)
  }
  const oldFile = sealed.file(`${account.id}/${row(oldUid).id}.eml`)
  const newFile = sealed.file(`${account.id}/${row(newUid).id}.eml`)
  server.deleteMessage('INBOX', oldUid)
  await syncer.run()
  assert.equal(row(oldUid), undefined)
  assert.equal(fs.existsSync(oldFile), false, 'the file of the deleted message is gone')
  assert.equal(fs.existsSync(newFile), true, 'the other one stays')
})

test('two accounts sync into one index without mixing', async t => {
  const { db, index } = memoryIndex(t)
  const a = addAccount(db)
  const b = addAccount(db)
  const sa = new FakeImapServer().addMailbox('INBOX')
  const sb = new FakeImapServer().addMailbox('INBOX')
  sa.addMessage('INBOX', { from: 'x@example.invalid', to: 'a@example.invalid', subject: 'Közös szó', messageId: '<1@a>', date: NOW - DAY, body: 'tetőcserép' })
  sb.addMessage('INBOX', { from: 'y@example.invalid', to: 'b@example.invalid', subject: 'Közös szó', messageId: '<1@b>', date: NOW - DAY, body: 'tetőcserép' })
  await new Syncer({ account: a, index, connect: async () => sa.client(), now: () => NOW }).run()
  await new Syncer({ account: b, index, connect: async () => sb.client(), now: () => NOW }).run()
  assert.equal(index.search({ query: 'tetocserep' }).length, 2)
  assert.deepEqual(index.search({ accountId: a.id, query: 'tetocserep' }).map(r => r.account_id), [a.id])
  assert.deepEqual(index.folders(b.id).map(f => [f.path, f.count]), [['INBOX', 1]])
})

test('the sync opens mailboxes read-only (EXAMINE)', async t => {
  const { server, syncer } = setup(t)
  const seen = []
  const orig = server.client.bind(server)
  server.client = () => {
    const c = orig()
    const lock = c.getMailboxLock.bind(c)
    c.getMailboxLock = (p, opts) => {
      seen.push(opts && opts.readOnly)
      return lock(p, opts)
    }
    return c
  }
  await syncer.run()
  assert.ok(seen.length > 0)
  assert.ok(seen.every(Boolean), 'every lock is readOnly')
})

// review findings: a refused SEARCH and very large mailboxes.

test('a refused UID SEARCH (imapflow resolves false on NO/BAD) leaves the folder untouched; other folders still sync', async t => {
  const { db, index, server, syncer, account } = setup(t)
  server.addMailbox('Archív')
  await syncer.run()
  const before = index.stats(account.id).total
  const pinned = index.getByUid(account.id, 'INBOX', 1).id
  index.setPinned(pinned)

  server.addMessage('Archív', { from: 'z@example.invalid', to: 'en@example.invalid', subject: 'Új az archívban', messageId: '<arch@x>', date: NOW - DAY, body: 'napelem' })
  const orig = server.client.bind(server)
  server.client = () => {
    const c = orig()
    const search = c.search.bind(c)
    c.search = async (q, o) => (c.mailbox.path === 'INBOX' ? false : search(q, o))
    return c
  }
  await syncer.run() // resolves: one refused folder is not a failed run
  assert.equal(db.prepare("SELECT count(*) AS n FROM messages WHERE folder = 'INBOX'").get().n, 2, 'INBOX rows kept')
  assert.ok(index.get(pinned), 'the pinned message is still there')
  assert.equal(syncer.state.lastRemoved, 0)
  assert.match(syncer.state.lastError, /INBOX: UID SEARCH refused/)
  assert.equal(index.stats(account.id).total, before + 1, 'the other folder synced')
  assert.deepEqual(index.search({ query: 'napelem' }).map(r => r.subject), ['Új az archívban'])
})

test('an empty SEARCH answer for a non-empty mailbox is not taken as "everything deleted"', async t => {
  const { index, server, syncer, account } = setup(t)
  await syncer.run()
  const orig = server.client.bind(server)
  server.client = () => {
    const c = orig()
    c.search = async () => []
    return c
  }
  await syncer.run()
  assert.equal(index.stats(account.id).total, 2)
  assert.match(syncer.state.lastError, /returned nothing for a mailbox with 2 messages/)
})

test('a mailbox with 150 000 messages syncs (no RangeError from spreading the UIDs) and the next run is incremental', async t => {
  const { db, index } = memoryIndex(t)
  const account = addAccount(db, { body_index_days: 1 }) // headers only: keeps the test fast
  const server = new FakeImapServer().addMailbox('INBOX')
  const N = 150_000
  for (let i = 0; i < N; i++) {
    server.addMessage('INBOX', { from: 'a@example.invalid', to: 'b@example.invalid', subject: `L ${i}`, messageId: `<m${i}@x>`, date: NOW - 10 * DAY, body: 'x' })
  }
  const syncer = new Syncer({ account, index, connect: async () => server.client(), now: () => NOW })
  await syncer.run()
  assert.equal(syncer.state.lastError, null)
  assert.equal(index.stats(account.id).total, N)
  assert.equal(index.getFolder(account.id, 'INBOX').last_uid, N)

  const metaFetched = () => server.fetchLog.filter(f => f.kind === 'meta').reduce((a, f) => a + f.uids.length, 0)
  const before = metaFetched()
  server.addMessage('INBOX', { from: 'a@example.invalid', to: 'b@example.invalid', subject: 'utolsó', messageId: '<last@x>', date: NOW, body: 'x' })
  server.mailboxes.get('INBOX').messages.get(1).flags.add('\\Seen')
  await syncer.run()
  assert.equal(syncer.state.lastError, null)
  assert.equal(metaFetched() - before, 1, 'only the new message is fetched again')
  assert.equal(index.getByUid(account.id, 'INBOX', 1).flags, '\\Seen', 'flags of a known message refreshed')
})
