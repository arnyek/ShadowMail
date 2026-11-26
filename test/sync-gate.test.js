// One account's body phase at a time (core/imap/body-gate.js, through the SyncManager): first come first served, a
// batch per turn, two accounts' body writes never interleave, another account's new message waits at most one batch,
// a stop lets the gate go (waiting or holding); and the flag check without CONDSTORE asks in UID ranges of FLAG_CHUNK
// known UIDs with the same result as one FETCH (the CONDSTORE path stays one FETCH), also over real imapflow; a mass
// flag change is written FLAG_TX rows per transaction.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memoryIndex, addAccount, DAY, sealedStore } from './helpers/fixtures.js'
import { onCleanup, tempDir } from './helpers/tmp.js'
import { FakeImapServer } from './helpers/fake-imap.js'
import { FakePop3Server } from './helpers/fake-pop3.js'
import { Pop3Fetcher } from '../core/pop3/fetcher.js'
import { Pop3Client } from '../core/pop3/client.js'
import path from 'node:path'
import { startImapWire } from './helpers/imap-wire.js'
import { seedKnownRows } from './helpers/known-rows.js'
import { BodyGate } from '../core/imap/body-gate.js'
import { Syncer, flagRanges, FLAG_CHUNK } from '../core/imap/sync.js'
import { SyncManager } from '../app/main/sync-manager.js'
import { FLAG_TX } from '../core/db/write-slices.js'

const NOW = Date.UTC(2026, 10, 26, 9, 0, 0)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const until = async (fn, ms = 60_000) => {
  const t0 = performance.now()
  while (!fn()) {
    if (performance.now() - t0 > ms) throw new Error('timed out waiting')
    await sleep(5)
  }
}

test('BodyGate: first come first served; a cancelled wait leaves the queue; a cancelled holder lets it go; release twice is one', async () => {
  const gate = new BodyGate()
  const order = []
  const a = gate.acquire()
  const b = gate.acquire()
  const c = gate.acquire()
  const relA = await a.ready
  assert.deepEqual(gate.state(), { held: true, waiting: 2 })
  b.ready.then(r => order.push(['b', Boolean(r)]))
  c.ready.then(r => order.push(['c', Boolean(r)]))
  b.cancel()
  await sleep(1)
  assert.deepEqual(order, [['b', false]], 'the cancelled wait resolves with null at once')
  assert.deepEqual(gate.state(), { held: true, waiting: 1 })
  relA()
  relA()
  await sleep(1)
  assert.deepEqual(order, [['b', false], ['c', true]])
  assert.deepEqual(gate.state(), { held: true, waiting: 0 })
  // a holder cancelled (a stopped run in a network wait): the next one gets it at once
  const d = gate.acquire()
  c.cancel()
  assert.ok(await d.ready)
  assert.deepEqual(gate.state(), { held: true, waiting: 0 })
})

test('BodyGate: the waiters get it in the order they asked, one at a time', async () => {
  const gate = new BodyGate()
  const order = []
  const reqs = ['a', 'b', 'c', 'd'].map(name => [name, gate.acquire()])
  for (const [name, r] of reqs) r.ready.then(rel => order.push([name, rel]))
  for (let k = 0; k < reqs.length; k++) {
    await sleep(1)
    assert.equal(order.length, k + 1, `one holder at a time: ${order.map(o => o[0])}`)
    order[k][1]()
  }
  assert.deepEqual(order.map(o => o[0]), ['a', 'b', 'c', 'd'])
  assert.deepEqual(gate.state(), { held: false, waiting: 0 })
})

// a manager over accounts with `counts[i]` messages each in INBOX (inside the body limit); every setBodies call
// recorded with its account
function managerSetup(t, counts) {
  const { db, index } = memoryIndex(t)
  const servers = []
  const rows = []
  for (const [i, n] of counts.entries()) {
    rows.push(addAccount(db, { name: `F${i}`, email: `f${i}@example.invalid` }))
    const s = new FakeImapServer().addMailbox('INBOX')
    s.addMessages('INBOX', Array.from({ length: n }, (_, k) => ({ from: `k${k}@example.invalid`, to: 'en@example.invalid', subject: `T ${i} ${k}`, messageId: `<g${i}-${k}@x>`, date: NOW - DAY - k * 60_000, body: `level ${i} ${k}` })))
    servers.push(s)
  }
  const byId = new Map(rows.map(r => [r.id, r]))
  const store = { list: () => rows, getRow: id => byId.get(id), passwordsFor: () => ({ incoming: 'x' }) }
  const writes = [] // account id per setBodies call
  const written = new Map(rows.map(r => [r.id, 0]))
  const accountOf = db.prepare('SELECT account_id FROM messages WHERE id = ?').pluck()
  const setBodies = index.setBodies.bind(index)
  index.setBodies = items => {
    const acc = accountOf.get(items[0].id)
    writes.push(acc)
    written.set(acc, written.get(acc) + items.length)
    return setBodies(items)
  }
  const manager = new SyncManager({ store, index, connect: acc => servers[rows.findIndex(r => r.id === acc.id)].connect(), now: () => NOW, throttleMs: 5, idleOptions: { retryDelaysMs: [60_000] } })
  onCleanup(t, () => manager.stopAll())
  return { db, index, rows, servers, manager, writes, written }
}
const runs = seq => seq.filter((a, i) => i === 0 || seq[i - 1] !== a)

test('two accounts started together: their body phases do not interleave (one batch of 500 each here)', async t => {
  const { rows, manager, writes, written } = managerSetup(t, [300, 300])
  manager.startAll()
  await until(() => written.get(rows[0].id) === 300 && written.get(rows[1].id) === 300)
  assert.equal(runs(writes).length, 2, `one run per account: ${runs(writes)}`)
  assert.deepEqual(manager.bodyGate.state(), { held: false, waiting: 0 }, 'nothing held after the runs')
})

test('a big account in its body phase: another account\'s new message is indexed after at most one more batch', async t => {
  const { rows, servers, manager, written, index } = managerSetup(t, [1300, 0])
  const [a, b] = rows
  manager.startAll()
  // A in its first batch of 500
  await until(() => written.get(a.id) > 0)
  const atRequest = written.get(a.id)
  assert.ok(atRequest < 500, `still in the first batch: ${atRequest}`)
  servers[1].addMessage('INBOX', { from: 'uj@example.invalid', to: 'en@example.invalid', subject: 'Uj', messageId: '<uj@x>', date: NOW - 1000, body: 'uj level' })
  manager.requestSync(b.id, ['INBOX'])
  await until(() => written.get(b.id) === 1)
  const aThen = written.get(a.id)
  assert.ok(aThen <= 1000, `B waited at most one batch after the one in work: A had ${aThen} written`)
  await until(() => written.get(a.id) === 1300)
  assert.equal(index.stats(b.id).bodies, 1)
})

test('a stop while waiting for the gate and while holding it: no deadlock, the gate goes on, the next run starts', async t => {
  const { rows, manager, written } = managerSetup(t, [1200, 400])
  const [a, b] = rows
  manager.startAll()
  await until(() => written.get(a.id) > 0 || written.get(b.id) > 0)
  // one holds, the other waits; stop both accounts' syncers in the order they got the gate
  const first = written.get(a.id) > 0 ? a : b
  const second = first === a ? b : a
  await until(() => manager.bodyGate.state().waiting === 1)
  const e2 = manager.entries.get(second.id)
  e2.syncer.stop()
  assert.deepEqual(manager.bodyGate.state(), { held: true, waiting: 0 }, 'the waiting one left the queue')
  const e1 = manager.entries.get(first.id)
  e1.syncer.stop()
  assert.deepEqual(manager.bodyGate.state(), { held: false, waiting: 0 }, 'the holder let it go at once')
  // restart both: the gate works again and every row gets its body
  await manager.accountSaved(first.id)
  await manager.accountSaved(second.id)
  await until(() => written.get(a.id) >= 1200 && written.get(b.id) >= 400)
})

test('two POP3 accounts waiting for the shared gate: they queue, then their local body batches (200) never interleave', async t => {
  const { db, index } = memoryIndex(t)
  const gate = new BodyGate()
  const n = 210 // one batch of 200, then the 10 left
  const writes = [] // [account id, rows] per setBodies call
  const accountOf = db.prepare('SELECT account_id FROM messages WHERE id = ?').pluck()
  const setBodies = index.setBodies.bind(index)
  index.setBodies = items => {
    writes.push([accountOf.get(items[0].id), items.length])
    return setBodies(items)
  }
  const fetchers = []
  for (let a = 0; a < 2; a++) {
    const server = await new FakePop3Server().listen()
    onCleanup(t, () => server.close())
    for (let i = 0; i < n; i++) {
      server.add(Buffer.from(`From: a@example.invalid\r\nTo: b@example.invalid\r\nSubject: P ${a} ${i}\r\nDate: ${new Date(NOW - DAY).toUTCString()}\r\nMessage-ID: <p${a}-${i}@x>\r\n\r\nA ${i}. level\r\n`))
    }
    const row = addAccount(db, { type: 'pop3', in_port: server.port, in_host: '127.0.0.1', in_security: 'none', in_user: server.user })
    const fetcher = new Pop3Fetcher({
      account: row,
      loadAccount: () => db.prepare('SELECT * FROM accounts WHERE id = ?').get(row.id),
      index,
      sealed: sealedStore(path.join(tempDir(t), `store${a}`)),
      bodyGate: gate,
      connect: async () => {
        const c = new Pop3Client({ host: '127.0.0.1', port: server.port, security: 'none', timeoutMs: 5000 })
        await c.connect()
        await c.login(server.user, server.pass)
        return c
      },
      now: () => NOW,
    })
    onCleanup(t, () => fetcher.stop())
    fetchers.push(fetcher)
  }
  // the test holds the gate first: both fetchers must queue for their body phase (the downloads alone would not
  // overlap them), then they get it one batch at a time
  const held = await gate.acquire().ready
  const done = fetchers.map(f => f.run())
  // only a hang guard: the downloads before it take ~10 s alone, longer in a loaded `npm test`
  await until(() => gate.state().waiting === 2, 120_000)
  held()
  await Promise.all(done)
  // consecutive writes of one account: each such run is one whole batch (200, then the 10 left)
  const runsOf = []
  for (const [acc, k] of writes) {
    if (runsOf.length && runsOf[runsOf.length - 1][0] === acc) runsOf[runsOf.length - 1][1] += k
    else runsOf.push([acc, k])
  }
  for (const [, k] of runsOf) assert.ok(k === 200 || k === 10 || k === 210, `a batch cut by the other account: ${JSON.stringify(runsOf)}`)
  assert.equal(writes.reduce((s, [, k]) => s + k, 0), 2 * n)
  assert.deepEqual(gate.state(), { held: false, waiting: 0 })
})

test('flagRanges: sorted known UIDs in ranges of FLAG_CHUNK', () => {
  assert.equal(FLAG_CHUNK, 2000)
  assert.deepEqual(flagRanges([9, 3, 5, 1, 7], 2), ['1:3', '5:7', '9:9'])
  assert.deepEqual(flagRanges([]), [])
  const uids = Array.from({ length: 12_001 }, (_, i) => 12_001 - i)
  assert.deepEqual(flagRanges(uids), ['1:2000', '2001:4000', '4001:6000', '6001:8000', '8001:10000', '10001:12000', '12001:12001'])
})

test('the flag check without CONDSTORE: UID ranges of FLAG_CHUNK, the same changes as one FETCH; with CONDSTORE one FETCH', async t => {
  const n = 12_001
  const { db, index } = memoryIndex(t)
  // beyond the body limit: headers only, no body phase to wait for
  const account = addAccount(db, { body_index_days: 1 })
  const server = new FakeImapServer().addMailbox('INBOX')
  server.addMessages('INBOX', Array.from({ length: n }, (_, k) => ({ from: 'a@example.invalid', to: 'b@example.invalid', subject: `T ${k}`, messageId: `<f${k}@x>`, date: NOW - 30 * DAY, body: 'x' })))
  const syncer = new Syncer({ account, index, connect: async () => server.client(), now: () => NOW })
  onCleanup(t, () => syncer.stop())
  await syncer.run()
  const uids = [...server.mailboxes.get('INBOX').messages.keys()]
  const flagged = () => db.prepare("SELECT COUNT(*) FROM messages WHERE flags LIKE '%Flagged%'").pluck().get()
  // without CONDSTORE: every known UID, in ranges
  const changed = [uids[0], uids[FLAG_CHUNK - 1], uids[FLAG_CHUNK], uids[n - 1]]
  for (const uid of changed) server.setFlags('INBOX', uid, ['\\Seen', '\\Flagged'])
  server.fetchLog.length = 0
  await syncer.run()
  const flagFetches = server.fetchLog.filter(f => f.kind === 'flags')
  assert.deepEqual(flagFetches.map(f => f.uids.length), [2000, 2000, 2000, 2000, 2000, 2000, 1], 'ranges of FLAG_CHUNK known UIDs')
  assert.deepEqual(flagFetches.flatMap(f => f.uids), uids, 'each known UID once, in order')
  for (const uid of changed) assert.equal(index.getByUid(account.id, 'INBOX', uid).flags, '\\Seen \\Flagged')
  assert.equal(flagged(), changed.length, 'only these changed')
  // with CONDSTORE (a saved HIGHESTMODSEQ): one FETCH from the lowest known UID, as before
  server.modseq = 7
  await syncer.run()
  server.setFlags('INBOX', uids[6000], ['\\Flagged'])
  server.fetchLog.length = 0
  await syncer.run()
  const condstore = server.fetchLog.filter(f => f.kind === 'flags')
  assert.equal(condstore.length, 1, 'one FETCH')
  assert.equal(condstore[0].uids.length, n)
  assert.equal(index.getByUid(account.id, 'INBOX', uids[6000]).flags, '\\Flagged')
  assert.equal(flagged(), changed.length + 1)
})

test('real imapflow over TCP without CONDSTORE: the flag check asks UID ranges of FLAG_CHUNK, every flag as on the server', async t => {
  const n = 12_001
  const mail = Array.from({ length: n }, (_, i) => ({ uid: i + 1, flags: i % 3 ? ['\\Seen'] : i % 7 ? [] : ['\\Seen', '\\Flagged'] }))
  const wire = await startImapWire({ folders: [{ path: 'INBOX', mail }] })
  onCleanup(t, () => wire.close())
  const { db, index } = memoryIndex(t)
  // beyond the body limit: no body phase; the rows are known, so the run asks nothing but their flags
  const account = addAccount(db, { in_host: '127.0.0.1', in_port: wire.port, in_security: 'none', body_index_days: 1 })
  const uids = seedKnownRows(index, account.id, 'INBOX', n, { date: NOW - 30 * DAY })
  const syncer = new Syncer({ account, index, getPassword: async () => 'p', now: () => NOW })
  onCleanup(t, () => syncer.stop())
  await syncer.run()
  assert.equal(syncer.state.lastError, null, syncer.state.lastError)
  const fetches = wire.log.filter(l => /^UID FETCH /i.test(l))
  assert.deepEqual(fetches.map(l => l.split(' ')[2]), ['1:2000', '2001:4000', '4001:6000', '6001:8000', '8001:10000', '10001:12000', '12001:12001'], fetches.join(' | '))
  assert.ok(fetches.every(l => /\(UID FLAGS\)$/i.test(l)), 'flags only')
  const stored = new Map(db.prepare('SELECT uid, flags FROM messages WHERE account_id = ?').all(account.id).map(r => [r.uid, r.flags]))
  assert.equal(stored.size, n)
  for (const uid of uids) assert.equal(stored.get(uid), wire.flagsOf('INBOX', uid).join(' '), `uid ${uid}`)
  assert.ok(!wire.log.some(l => /^(SELECT|STORE|APPEND|EXPUNGE|MOVE|COPY)\b/i.test(l)), 'the sync only reads')
})

test('a mass flag change is written FLAG_TX rows per transaction; a stop between two slices leaves the rest to the next run', async t => {
  const n = 1201
  const { db, index } = memoryIndex(t)
  const account = addAccount(db, { body_index_days: 1 })
  const server = new FakeImapServer().addMailbox('INBOX')
  server.addMessages('INBOX', Array.from({ length: n }, (_, k) => ({ from: 'a@example.invalid', to: 'b@example.invalid', subject: `M ${k}`, messageId: `<m${k}@x>`, date: NOW - 30 * DAY, body: 'x' })))
  const first = new Syncer({ account, index, connect: async () => server.client(), now: () => NOW })
  onCleanup(t, () => first.stop())
  await first.run()
  for (const uid of server.mailboxes.get('INBOX').messages.keys()) server.setFlags('INBOX', uid, ['\\Seen'])
  const seen = () => db.prepare("SELECT COUNT(*) FROM messages WHERE flags = '\\Seen'").pluck().get()
  const sizes = []
  const setFlagsMany = index.setFlagsMany.bind(index)
  let onSlice = () => {}
  index.setFlagsMany = (acc, folder, items) => {
    sizes.push(items.length)
    const r = setFlagsMany(acc, folder, items)
    onSlice(sizes.length)
    return r
  }
  // a stop (lock) right after the first slice: nothing more is written
  onSlice = k => k === 1 && first.stop()
  await assert.rejects(first.run(), err => err.code === 'SYNC_STOPPED')
  assert.deepEqual(sizes, [FLAG_TX])
  assert.equal(seen(), FLAG_TX)
  // the next run (a new syncer, as after an unlock) writes the rest, in slices
  sizes.length = 0
  onSlice = () => {}
  const next = new Syncer({ account, index, connect: async () => server.client(), now: () => NOW })
  onCleanup(t, () => next.stop())
  await next.run()
  assert.deepEqual(sizes, [FLAG_TX, n - 2 * FLAG_TX], 'the 701 left: 500 + 201')
  assert.equal(seen(), n)
})
