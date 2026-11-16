// Sync behaviour with the fake IMAP server (no network): read-only access, flag and delete
// propagation, change events, targeted runs, queued requests, retry and the no-retry rule for a
// rejected login.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memoryIndex, addAccount, DAY } from './helpers/fixtures.js'
import { FakeImapServer } from './helpers/fake-imap.js'
import { Syncer } from '../core/imap/sync.js'
import { onCleanup } from './helpers/tmp.js'

const NOW = Date.UTC(2026, 10, 11, 12, 0, 0)
const sleep = ms => new Promise(r => setTimeout(r, ms))

function msg(n, extra = {}) {
  return { from: `kuldo${n}@example.invalid`, to: 'en@example.invalid', subject: `Levél ${n}`, messageId: `<m${n}@x>`, date: NOW - n * DAY, body: `Szöveg ${n}`, ...extra }
}

function setup(t, opts = {}) {
  const { db, index } = memoryIndex(t)
  const account = addAccount(db)
  const server = new FakeImapServer().addMailbox('INBOX').addMailbox('Sent', { specialUse: '\\Sent' })
  const changes = []
  const states = []
  const syncer = new Syncer({
    account,
    index,
    connect: () => server.connect(),
    now: () => NOW,
    onChange: c => changes.push(c),
    onState: s => states.push(s),
    ...opts,
  })
  onCleanup(t, () => syncer.stop())
  const rows = (folder = 'INBOX') => index.listFolder({ accountId: account.id, folder, limit: 500 })
  return { db, index, account, server, syncer, changes, states, rows }
}

test('the sync opens every folder read-only (EXAMINE) and never changes a flag', async t => {
  const { server, syncer } = setup(t)
  const unread = server.addMessage('INBOX', msg(1))
  const read = server.addMessage('INBOX', msg(2, { flags: ['\\Seen'] }))
  server.addMessage('Sent', msg(3, { flags: ['\\Seen'] }))
  await syncer.run()
  await syncer.run({ full: true })
  assert.ok(server.openLog.length >= 4)
  assert.ok(server.openLog.every(o => o.readOnly === true), JSON.stringify(server.openLog))
  const flags = uid => [...server.mailboxes.get('INBOX').messages.get(uid).flags]
  assert.deepEqual(flags(unread), [])
  assert.deepEqual(flags(read), ['\\Seen'])
})

test('a flag set elsewhere arrives with the next run; a message deleted elsewhere disappears; both report the folder', async t => {
  const { server, syncer, changes, rows } = setup(t)
  const a = server.addMessage('INBOX', msg(1))
  const b = server.addMessage('INBOX', msg(2))
  await syncer.run()
  assert.equal(rows().length, 2)
  assert.ok(changes.some(c => c.folders.includes('INBOX')))

  changes.length = 0
  await syncer.run()
  assert.deepEqual(changes, [], 'nothing changed, no change event')

  server.setFlags('INBOX', a, ['\\Seen'])
  server.deleteMessage('INBOX', b)
  await syncer.run()
  const now = rows()
  assert.deepEqual(now.map(r => r.uid), [a])
  assert.equal(now[0].flags, '\\Seen')
  assert.deepEqual(changes.map(c => c.folders), [['INBOX']])
})

test('a targeted run (IDLE) touches only the given folder and does not drop the others', async t => {
  const { server, syncer, rows } = setup(t)
  server.addMessage('INBOX', msg(1))
  server.addMessage('Sent', msg(2))
  await syncer.run()
  server.fetchLog.length = 0
  server.openLog.length = 0
  server.addMessage('INBOX', msg(3))
  await syncer.run({ folders: ['INBOX'] })
  assert.deepEqual([...new Set(server.openLog.map(o => o.path))], ['INBOX'])
  assert.equal(rows().length, 2)
  assert.equal(rows('Sent').length, 1, 'Sent stays')
})

test('a request during a run is queued (merged) and runs right after, so a change mid-run is not lost', async t => {
  const { server, syncer, rows } = setup(t)
  server.addMessage('INBOX', msg(1))
  const first = syncer.request()
  const a = syncer.request({ folders: ['INBOX'] })
  const b = syncer.request({ folders: ['Sent'] })
  assert.equal(a, b, 'one queued run for both')
  assert.deepEqual(syncer.queued, { full: false, folders: ['INBOX', 'Sent'] })
  server.addMessage('INBOX', msg(2)) // arrives while the first run is going
  await first
  await a
  assert.equal(rows().length, 2)
  assert.equal(syncer.queued, null)
})

test('network down: the error shows, the run is retried on its own and the error clears when the server is back', async t => {
  const { server, syncer, rows } = setup(t, { retryDelaysMs: [30, 30] })
  server.addMessage('INBOX', msg(1))
  server.down = true
  syncer.start()
  for (let i = 0; i < 50 && !syncer.state.errorCode; i++) await sleep(5)
  assert.equal(syncer.state.errorCode, 'connection_refused')
  server.down = false
  for (let i = 0; i < 100 && syncer.state.errorCode; i++) await sleep(5)
  assert.equal(syncer.state.errorCode, null)
  assert.equal(syncer.state.lastError, null)
  assert.equal(rows().length, 1)
})

test('a rejected login is not retried on a timer (IP ban protection): one attempt, then wait for the user', async t => {
  const { server, syncer } = setup(t, { retryDelaysMs: [10, 10] })
  server.rejectLogin = true
  syncer.start()
  for (let i = 0; i < 50 && !syncer.state.errorCode; i++) await sleep(5)
  assert.equal(syncer.state.errorCode, 'auth_failed')
  await sleep(80)
  assert.equal(server.loginAttempts, 1)
})

test('stop() aborts a running sync between batches: nothing more is written', async t => {
  const { server, syncer, rows } = setup(t)
  server.addMessages('INBOX', Array.from({ length: 1000 }, (_, i) => msg(i + 1)))
  const running = syncer.run().catch(err => err)
  syncer.stop()
  const err = await running
  assert.equal(err.code, 'SYNC_STOPPED')
  assert.ok(rows().length < 1000)
})

// login safety (a repeated wrong password gets the IP banned): a request queued behind a run must not log in again
// when that run ended with a rejected login, or when the syncer was stopped meanwhile.
test('login safety: a request queued during a run rejected with auth_failed does not log in again', async t => {
  const { db, index } = memoryIndex(t)
  const account = addAccount(db)
  const server = new FakeImapServer().addMailbox('INBOX')
  server.rejectLogin = true
  const slow = async () => {
    await sleep(40)
    return server.connect()
  }
  const syncer = new Syncer({ account, index, connect: slow, now: () => NOW, retryDelaysMs: [20] })
  onCleanup(t, () => syncer.stop())
  syncer.start() // run 1: connecting
  await sleep(5)
  const queued = syncer.request({ folders: ['INBOX'] }) // e.g. an IDLE change or Refresh meanwhile
  await assert.rejects(queued)
  await sleep(150)
  assert.equal(server.loginAttempts, 1, 'exactly one rejected login')
  assert.equal(syncer.state.errorCode, 'auth_failed')
})

test('login safety: stop() while a run connects -> the queued request never connects; a stopped syncer does not run', async t => {
  const { db, index } = memoryIndex(t)
  const account = addAccount(db)
  const server = new FakeImapServer().addMailbox('INBOX')
  const slow = async () => {
    await sleep(40)
    return server.connect()
  }
  const syncer = new Syncer({ account, index, connect: slow, now: () => NOW })
  const first = syncer.run().catch(e => e)
  const queued = syncer.request().catch(e => e)
  syncer.stop() // IDLE auth error, account saved, vault locked
  assert.equal((await first).code, 'SYNC_STOPPED')
  assert.equal((await queued).code, 'SYNC_STOPPED')
  await sleep(100)
  assert.equal(server.loginAttempts, 1, 'only the run that was already connecting logged in')
  assert.equal((await syncer.run().catch(e => e)).code, 'SYNC_STOPPED', 'a direct run after stop() does not connect')
  assert.equal(server.loginAttempts, 1)
})

// a tagged NO for one message's body (Gmail "Some messages could not be FETCHed")
function refusingFetch(server, refuse) {
  const orig = server.connect.bind(server)
  server.connect = async () => {
    const c = await orig()
    const f = c.fetch.bind(c)
    c.fetch = function (range, query, opts) {
      if (query.source && Array.isArray(range) && refuse(range)) {
        return (async function* () {
          const e = new Error('Command failed')
          e.responseStatus = 'NO'
          throw e
        })()
      }
      return f(range, query, opts)
    }
    return c
  }
}

test('bodies: one message the server refuses (NO) is marked failed, the other texts are indexed, the run finishes', async t => {
  const { db, index } = memoryIndex(t)
  const account = addAccount(db)
  const server = new FakeImapServer().addMailbox('INBOX')
  for (let n = 1; n <= 60; n++) server.addMessage('INBOX', msg(n, { date: NOW - (61 - n) * DAY, body: `szoveg${n}` }))
  refusingFetch(server, range => range.includes(60))
  const syncer = new Syncer({ account, index, connect: () => server.connect(), now: () => NOW })
  await syncer.run()
  const s = db.prepare('SELECT SUM(body_state = 0) AS p, SUM(body_state = 1) AS i, SUM(body_state = 2) AS f FROM messages').get()
  assert.deepEqual({ ...s }, { p: 0, i: 59, f: 1 })
  assert.ok(syncer.state.lastFinished && !syncer.state.errorCode)
})

test('bodies: the server refuses every message of a chunk -> nothing is marked failed, the run fails and retries later', async t => {
  const { db, index } = memoryIndex(t)
  const account = addAccount(db)
  const server = new FakeImapServer().addMailbox('INBOX')
  for (let n = 1; n <= 5; n++) server.addMessage('INBOX', msg(n, { date: NOW - n * DAY, body: `szoveg${n}` }))
  refusingFetch(server, () => true)
  const syncer = new Syncer({ account, index, connect: () => server.connect(), now: () => NOW })
  await assert.rejects(syncer.run())
  const s = db.prepare('SELECT SUM(body_state = 0) AS p, SUM(body_state = 2) AS f FROM messages').get()
  assert.deepEqual({ ...s }, { p: 5, f: 0 })
})

test('first sync cut off half-way: the next run continues, the rows already fetched stay; a real UIDVALIDITY change still resets', async t => {
  const { db, index } = memoryIndex(t)
  const account = addAccount(db)
  const server = new FakeImapServer().addMailbox('INBOX')
  server.addMessages('INBOX', Array.from({ length: 1000 }, (_, i) => msg(i + 1, { date: NOW - ((i % 900) + 1) * DAY })))
  let chunksLeft = 3 // the connection dies in the 4th 200-message metadata chunk
  const orig = server.connect.bind(server)
  server.connect = async () => {
    const c = await orig()
    const f = c.fetch.bind(c)
    c.fetch = function (range, q, o) {
      if (q.envelope && chunksLeft-- <= 0) {
        return (async function* () {
          c._closed()
          throw Object.assign(new Error('Connection not available'), { code: 'NoConnection' })
        })()
      }
      return f(range, q, o)
    }
    return c
  }
  const syncer = new Syncer({ account, index, connect: () => server.connect(), now: () => NOW })
  const count = () => db.prepare("SELECT COUNT(*) AS n FROM messages WHERE folder = 'INBOX'").get().n
  await assert.rejects(syncer.run())
  assert.equal(count(), 600)
  assert.ok(index.getFolder(account.id, 'INBOX'), 'the folder row (UIDVALIDITY) is there after the first chunk')
  chunksLeft = 1
  await assert.rejects(syncer.run())
  assert.equal(count(), 800, 'run 2 continued: 600 + 200, nothing thrown away')
  chunksLeft = Infinity
  await syncer.run()
  assert.equal(count(), 1000)
  // a real UIDVALIDITY change: the old rows go, the folder is fetched again
  server.mailboxes.get('INBOX').uidValidity = 999
  await syncer.run()
  assert.equal(count(), 1000)
  assert.equal(index.getFolder(account.id, 'INBOX').uidvalidity, '999')
})
