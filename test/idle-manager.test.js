// IDLE watcher and the sync manager with the fake IMAP server: a new message reaches the index
// without a manual refresh, the connection comes back after a drop, a rejected login stops
// everything after a single attempt, locking closes every connection.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memoryIndex, addAccount, DAY } from './helpers/fixtures.js'
import { FakeImapServer } from './helpers/fake-imap.js'
import { IdleWatcher } from '../core/imap/idle.js'
import { SyncManager } from '../app/main/sync-manager.js'
import { onCleanup } from './helpers/tmp.js'

const NOW = Date.UTC(2026, 10, 11, 12, 0, 0)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const until = async (fn, ms = 2000) => {
  const t0 = Date.now()
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting')
    await sleep(5)
  }
}
const msg = n => ({ from: `k${n}@example.invalid`, to: 'en@example.invalid', subject: `Levél ${n}`, messageId: `<m${n}@x>`, date: NOW - DAY, body: `Szöveg ${n}` })

test('IdleWatcher: opens INBOX read-only, a burst of changes gives one debounced call, a drop reconnects and asks for a catch-up', async t => {
  const server = new FakeImapServer().addMailbox('INBOX')
  const calls = []
  let reconnects = 0
  const w = new IdleWatcher({ connect: () => server.connect(), onChange: p => calls.push(p), onReconnect: () => reconnects++, retryDelaysMs: [20], debounceMs: 20 })
  onCleanup(t, () => w.stop())
  w.start()
  await until(() => w.connected)
  assert.deepEqual(server.openLog, [{ path: 'INBOX', readOnly: true, via: 'open' }])

  server.addMessage('INBOX', msg(1))
  server.addMessage('INBOX', msg(2))
  server.setFlags('INBOX', 1, ['\\Seen'])
  await until(() => calls.length === 1)
  await sleep(40)
  assert.deepEqual(calls, ['INBOX'])

  server.dropConnections()
  assert.equal(w.connected, false)
  await until(() => w.connected)
  assert.equal(reconnects, 1)
})

test('IdleWatcher: a rejected login is fatal, no retry', async t => {
  const server = new FakeImapServer().addMailbox('INBOX')
  server.rejectLogin = true
  let fatal = null
  const w = new IdleWatcher({ connect: () => server.connect(), onChange: () => {}, onFatal: code => (fatal = code), retryDelaysMs: [5] })
  onCleanup(t, () => w.stop())
  w.start()
  await until(() => fatal)
  await sleep(40)
  assert.equal(fatal, 'auth_failed')
  assert.equal(server.loginAttempts, 1)
  assert.equal(w.running, false)
})

function setupManager(t, { accounts = 1 } = {}) {
  const { db, index } = memoryIndex(t)
  const servers = new Map()
  const rows = []
  for (let i = 0; i < accounts; i++) {
    const row = addAccount(db)
    rows.push(row)
    servers.set(row.id, new FakeImapServer().addMailbox('INBOX').addMailbox('Sent', { specialUse: '\\Sent' }))
  }
  const store = {
    list: () => db.prepare('SELECT * FROM accounts ORDER BY id').all(),
    getRow: id => db.prepare('SELECT * FROM accounts WHERE id = ?').get(id),
  }
  const events = []
  const manager = new SyncManager({
    store,
    index,
    notify: e => events.push(e),
    connect: account => servers.get(account.id).connect(),
    now: () => NOW,
    throttleMs: 5,
    syncerOptions: { retryDelaysMs: [30, 30] },
    idleOptions: { retryDelaysMs: [30], debounceMs: 10 },
  })
  onCleanup(t, () => manager.stopAll())
  const list = id => index.listFolder({ accountId: id, folder: 'INBOX', limit: 500 })
  return { db, index, manager, servers, rows, events, list }
}

test('manager: unlock starts the sync, IDLE starts after it; a new message is in the INBOX list without a refresh, with a change event', async t => {
  const { manager, servers, rows, events, list } = setupManager(t)
  const server = servers.get(rows[0].id)
  server.addMessage('INBOX', msg(1))
  manager.startAll()
  const entry = () => manager.entries.get(rows[0].id)
  await until(() => entry().idle.connected)
  assert.equal(list(rows[0].id).length, 1)

  events.length = 0
  const t0 = performance.now()
  server.addMessage('INBOX', msg(2))
  await until(() => list(rows[0].id).length === 2)
  const ms = performance.now() - t0
  assert.ok(ms < 1000, `new message indexed in ${ms} ms`)
  await until(() => events.some(e => e.kind === 'mail'))
  const mail = events.find(e => e.kind === 'mail')
  assert.deepEqual(mail.changes, [{ accountId: rows[0].id, folders: ['INBOX'] }])
  const st = manager.status()[0]
  assert.equal(st.live, true)
  assert.equal(st.errorCode, null)
})

test('manager: network drop shows an error, then it clears by itself when the server is back', async t => {
  const { manager, servers, rows, list } = setupManager(t)
  const server = servers.get(rows[0].id)
  manager.startAll()
  const entry = () => manager.entries.get(rows[0].id)
  await until(() => entry().idle.connected)

  server.down = true
  server.dropConnections()
  await until(() => manager.status()[0].idleError === 'connection_lost' || manager.status()[0].errorCode)
  const failing = manager.status()[0]
  assert.equal(failing.live, false)

  server.addMessage('INBOX', msg(5)) // arrives while we are offline
  server.down = false
  await until(() => entry().idle.connected && list(rows[0].id).length === 1)
  await until(() => !manager.status()[0].idleError && !manager.status()[0].errorCode && !manager.status()[0].running)
})

test('manager: a rejected login stops sync and IDLE after ONE attempt; Refresh tries again', async t => {
  const { manager, servers, rows } = setupManager(t)
  const server = servers.get(rows[0].id)
  server.rejectLogin = true
  manager.startAll()
  await until(() => manager.status()[0].stopped)
  await sleep(100)
  assert.equal(server.loginAttempts, 1)
  assert.equal(manager.status()[0].errorCode, 'auth_failed')
  assert.equal(manager.entries.get(rows[0].id).idle.running, false)

  server.rejectLogin = false
  manager.syncNow(rows[0].id)
  await until(() => manager.entries.get(rows[0].id).idle.connected)
  assert.equal(manager.status()[0].stopped, false)
  assert.equal(manager.status()[0].errorCode, null)

  // the password changes on the server while IDLE is up: the next sync's rejected login also
  // closes the IDLE connection, so its reconnect loop cannot keep trying the old password
  server.rejectLogin = true
  const before = server.loginAttempts
  manager.syncNow(rows[0].id)
  await until(() => manager.status()[0].stopped)
  await until(() => !manager.entries.get(rows[0].id).idle.running)
  server.dropConnections()
  await sleep(100)
  assert.equal(server.loginAttempts, before + 1)
})

test('manager: locking (stopAll) closes every connection; a removed account stops; accounts are independent', async t => {
  const { manager, servers, rows, list } = setupManager(t, { accounts: 2 })
  servers.get(rows[0].id).addMessage('INBOX', msg(1))
  servers.get(rows[1].id).addMessage('INBOX', msg(2))
  manager.startAll()
  await until(() => rows.every(r => manager.entries.get(r.id).idle.connected))
  assert.equal(list(rows[0].id)[0].subject, 'Levél 1')
  assert.equal(list(rows[1].id)[0].subject, 'Levél 2')

  await manager.accountRemoved(rows[0].id)
  assert.equal(servers.get(rows[0].id).clients.size, 0)
  assert.equal(manager.status().length, 1)

  await manager.stopAll()
  assert.equal(servers.get(rows[1].id).clients.size, 0)
  assert.equal(manager.status().length, 0)
  manager.syncNow(null) // locked: nothing starts
  assert.equal(manager.entries.size, 0)
})

// a stable connection resets the delay, and the orphan suspicion
const nap = ms => new Promise(r => setTimeout(r, ms))

test('IDLE: a connection dropped right after opening keeps the retry delay growing; one that lived long enough resets it', async t => {
  const server = new FakeImapServer().addMailbox('INBOX')
  let clock = 0
  const opened = []
  const connect = async () => {
    const c = await server.connect()
    opened.push(clock)
    return c
  }
  const w = new IdleWatcher({ connect, onChange: () => {}, retryDelaysMs: [20, 40, 80, 160], stableMs: 1000, now: () => clock })
  onCleanup(t, () => w.stop())
  w.start()
  // drop every connection right after it opened (virus scanner proxy, NAT): delays 20, 40, 80, 160
  const delays = []
  let last = Date.now()
  for (let i = 0; i < 4; i++) {
    await nap(5)
    const n = opened.length
    w.client._closed()
    while (opened.length === n) await nap(2)
    delays.push(Date.now() - last)
    last = Date.now()
  }
  assert.equal(w.attempt, 4, 'the attempt counter kept growing (it was reset on every open before)')
  // now a connection that lived "long" (the injected clock moves 2 s): the next drop starts over at 20 ms
  clock += 2000
  w.client._closed()
  assert.equal(w.attempt, 1, 'reset after a stable connection, then one retry scheduled')
})

test('IDLE: stop() + start() while a connect is on its way -> the old connection is logged out, no orphan client', async t => {
  const server = new FakeImapServer().addMailbox('INBOX')
  const clients = []
  const connect = async () => {
    const c = await server.connect()
    clients.push(c)
    await nap(30) // a slow login
    return c
  }
  const w = new IdleWatcher({ connect, onChange: () => {}, retryDelaysMs: [1000] })
  onCleanup(t, () => w.stop())
  w.start()
  await nap(5)
  await w.stop() // e.g. account saved: restart
  w.start()
  await nap(100)
  assert.equal(clients.length, 2)
  assert.equal(w.client, clients[1], 'the watcher holds the new client')
  assert.equal(clients[0].usable, false, 'the first client was logged out, not left connected')
  assert.equal(server.clients.size, 1, 'one live connection on the server')
})
