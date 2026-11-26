// The sync's main-thread work in small slices (the window's thread must not stall): the search refiner writes the
// worker's results at most WRITE_BATCH per transaction with a turn of the event loop between two; a lock drops what
// waits (no write after it, the local accounts' re-index flag cleared); the IMAP body phase writes BODY_TX rows per
// transaction, the new rows' metadata INSERT_TX per transaction, a stop between two slices writes nothing more; the
// POP3 local bodies the same. The end state equals the unsliced one (every row indexed, its text searchable).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { memoryIndex, addAccount, DAY, sealedStore } from './helpers/fixtures.js'
import { onCleanup, tempDir } from './helpers/tmp.js'
import { FakeImapServer } from './helpers/fake-imap.js'
import { FakePop3Server } from './helpers/fake-pop3.js'
import { Syncer } from '../core/imap/sync.js'
import { Pop3Fetcher } from '../core/pop3/fetcher.js'
import { Pop3Client } from '../core/pop3/client.js'
import { BODY_STATE } from '../core/db/mail-index.js'
import { BODY_TX, INSERT_TX, inSlices } from '../core/db/write-slices.js'
import { openSettings } from '../app/main/settings.js'
import { createSearchRefiner, FLAG, FLAG_DONE, WRITE_BATCH, WRITE_WAIT_MS } from '../app/main/search-index.js'

const NOW = Date.UTC(2026, 10, 26, 9, 0, 0)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const turns = n => new Promise(r => {
  const step = k => (k ? setImmediate(() => step(k - 1)) : r())
  step(n)
})
const until = async (fn, ms = 20_000) => {
  const t0 = performance.now()
  while (!fn()) {
    if (performance.now() - t0 > ms) throw new Error('timed out waiting')
    await sleep(5)
  }
}

// a worker that answers at once: `lathato <source>` (the tests send the row id as the source)
function instantService() {
  return {
    admit: async () => true,
    release() {},
    idle: () => true,
    stop() {},
    compute(source) {
      return Promise.resolve({ text: `lathato ${source.toString()}`, preview: null, complex: false })
    },
  }
}

// n indexed rows with the old text; their ids
function indexedRows(db, accountId, n, from = 0) {
  const ids = []
  for (let i = 0; i < n; i++) {
    const info = db
      .prepare(`INSERT INTO messages (account_id, folder, uid, subject, date, idate, flags, size, has_attachments, body_state, store_path) VALUES (?, 'INBOX', ?, 'x', 1, 1, '', 1, 0, 1, ?)`)
      .run(accountId, from + i + 1, `${accountId}/${i}.eml`)
    db.prepare("INSERT INTO messages_fts (rowid, subject, sender, recipients, body) VALUES (?, 'x', '', '', 'regi szoveg')").run(info.lastInsertRowid)
    ids.push(Number(info.lastInsertRowid))
  }
  return ids
}
const ftsBody = (db, id) => db.prepare('SELECT body FROM messages_fts WHERE rowid = ?').get(id).body

// the index's transactions recorded: how many search texts each wrote, and what ran on the event loop in between
function recordTransactions(index, events, after = () => {}) {
  const sizes = []
  const inTx = index.inTransaction.bind(index)
  const setSearchBody = index.setSearchBody.bind(index)
  let open = null
  index.setSearchBody = (id, text) => {
    if (open !== null) open++
    return setSearchBody(id, text)
  }
  index.inTransaction = fn => {
    open = 0
    const r = inTx(fn)
    sizes.push(open)
    events.push(`tx${sizes.length}`)
    open = null
    after(sizes.length)
    return r
  }
  return sizes
}

test('the refiner writes the worker results at most WRITE_BATCH per transaction, a turn of the event loop between two', async t => {
  const { db, index } = memoryIndex(t)
  const acc = addAccount(db).id
  const ids = indexedRows(db, acc, 25)
  const events = []
  const sizes = recordTransactions(index, events, n => {
    if (n === 1) setImmediate(() => events.push('other'))
  })
  const refiner = createSearchRefiner({ service: instantService(), index, settings: openSettings(db) })
  onCleanup(t, () => refiner.stop())
  await refiner.refineMany(ids.map(id => ({ id, accountId: acc, local: false, source: Buffer.from(String(id)) })))
  await until(() => refiner.writesPending() === 0 && sizes.reduce((a, b) => a + b, 0) === 25)
  assert.equal(WRITE_BATCH, 10)
  assert.deepEqual(sizes, [10, 10, 5])
  assert.deepEqual(events, ['tx1', 'other', 'tx2', 'tx3'], 'something else ran on the main thread between two batches')
  for (const id of ids) assert.equal(ftsBody(db, id), `lathato ${id}`)
})

test('results that come one by one are still written in batches: WRITE_BATCH at once, the rest after WRITE_WAIT_MS', async t => {
  const { db, index } = memoryIndex(t)
  const acc = addAccount(db).id
  const ids = indexedRows(db, acc, 23)
  const events = []
  const writtenAt = []
  const sizes = recordTransactions(index, events, () => writtenAt.push(performance.now()))
  const refiner = createSearchRefiner({ service: instantService(), index, settings: openSettings(db) })
  onCleanup(t, () => refiner.stop())
  const sentAt = []
  // as the worker answers: one result at a time, a few ms apart. How many fit in WRITE_WAIT_MS depends on the
  // platform's timer (a 2 ms sleep is ~15 ms on Windows), so the batch sizes are not fixed, only their rules.
  for (const id of ids) {
    sentAt.push(performance.now())
    await refiner.refine({ id, accountId: acc, local: false, source: Buffer.from(String(id)) })
    await sleep(2)
  }
  await until(() => refiner.writesPending() === 0 && sizes.reduce((a, b) => a + b, 0) === 23)
  assert.equal(WRITE_WAIT_MS, 100)
  assert.equal(sizes.reduce((a, b) => a + b, 0), 23)
  assert.ok(sizes.every(n => n >= 1 && n <= WRITE_BATCH), `every batch 1..WRITE_BATCH: ${sizes}`)
  assert.ok(sizes.length <= 12, `batched, not one transaction per result: ${sizes}`)
  // a partial batch is written by the timer that its first result started: never before WRITE_WAIT_MS
  let first = 0
  let partial = 0
  sizes.forEach((n, i) => {
    if (n < WRITE_BATCH) {
      partial++
      const waited = writtenAt[i] - sentAt[first]
      assert.ok(waited >= WRITE_WAIT_MS - 1, `batch ${i + 1} (${n}) waited ${waited.toFixed(1)} ms`)
    }
    first += n
  })
  assert.ok(partial >= 1, 'the last, partial batch waited')
  for (const id of ids) assert.equal(ftsBody(db, id), `lathato ${id}`)
})

test('the refiner holds back while a WAL checkpoint is awaited (the gate), and writes right after it', async t => {
  const { db, index } = memoryIndex(t)
  const acc = addAccount(db).id
  const ids = indexedRows(db, acc, 12)
  const events = []
  const sizes = recordTransactions(index, events)
  let release = null
  let hold = new Promise(r => (release = r))
  const walGate = { gate: () => hold }
  const refiner = createSearchRefiner({ service: instantService(), index, settings: openSettings(db), walGate })
  onCleanup(t, () => refiner.stop())
  await refiner.refineMany(ids.map(id => ({ id, accountId: acc, local: false, source: Buffer.from(String(id)) })))
  await sleep(WRITE_WAIT_MS + 50)
  assert.deepEqual(sizes, [], 'nothing written while the checkpoint is awaited')
  assert.equal(refiner.writesPending(), 12)
  hold = null
  release(null)
  await until(() => refiner.writesPending() === 0)
  assert.deepEqual(sizes, [10, 2])
})

test('a lock in the middle of the write-back: nothing written after it, the waiting local accounts are re-indexed', async t => {
  const { db, index } = memoryIndex(t)
  const settings = openSettings(db)
  const imap = addAccount(db, { name: 'IMAP' }).id
  const early = addAccount(db, { name: 'POP3 korai' }).id
  const late = addAccount(db, { name: 'POP3 kesoi' }).id
  for (const a of [imap, early, late]) settings.set(FLAG(a), FLAG_DONE)
  // in queue order: 5 local of `early` and 5 IMAP (the first batch), then 10 IMAP and 5 local of `late`
  const earlyIds = indexedRows(db, early, 5, 0)
  const imapIds = indexedRows(db, imap, 15, 100)
  const lateIds = indexedRows(db, late, 5, 200)
  let refiner = null
  let cleared = null
  const events = []
  // the lock comes on the main thread's next turn after the first batch (before the drainer's next one)
  const sizes = recordTransactions(index, events, n => {
    if (n === 1) setImmediate(() => (cleared = refiner.stop()))
  })
  refiner = createSearchRefiner({ service: instantService(), index, settings })
  const item = (id, accountId, local) => ({ id, accountId, local, source: Buffer.from(String(id)) })
  await refiner.refineMany([
    ...earlyIds.map(id => item(id, early, true)),
    ...imapIds.map(id => item(id, imap, false)),
    ...lateIds.map(id => item(id, late, true)),
  ])
  await until(() => cleared !== null)
  await turns(20)
  await sleep(30)
  assert.deepEqual(sizes, [10], 'one batch, then the lock')
  assert.deepEqual(cleared, [late], 'only the account with a local message still waiting')
  assert.equal(settings.get(FLAG(late)), '', 'its re-index makes the text up after the next unlock')
  assert.equal(settings.get(FLAG(early)), FLAG_DONE, 'every local message of it was written')
  assert.equal(settings.get(FLAG(imap)), FLAG_DONE, 'an IMAP message keeps the old text until opened')
  const written = [...earlyIds, ...imapIds, ...lateIds].filter(id => ftsBody(db, id) !== 'regi szoveg')
  assert.deepEqual(written, [...earlyIds, ...imapIds.slice(0, 5)])
  assert.equal(refiner.writesPending(), 0)
})

test('inSlices: slices of the given size, a turn of the event loop and the check between two, the numbers summed', async () => {
  const seen = []
  const n = await inSlices([1, 2, 3, 4, 5, 6, 7], 3, s => {
    seen.push(s)
    setImmediate(() => seen.push('turn'))
    return s.length
  }, () => seen.push('check'))
  assert.equal(n, 7)
  assert.deepEqual(seen, [[1, 2, 3], 'turn', 'check', [4, 5, 6], 'turn', 'check', [7]])
  // hold(): awaited before every slice, the first too, then the check
  const order = []
  await inSlices([1, 2], 1, sl => order.push(`w${sl[0]}`), () => order.push('check'), () => {
    order.push('hold')
    return new Promise(r => setTimeout(r, 5))
  })
  assert.deepEqual(order, ['hold', 'check', 'w1', 'check', 'hold', 'check', 'w2'])
  // a throwing check (a stopped sync): no further slice
  const written = []
  await assert.rejects(inSlices([1, 2, 3], 1, s => written.push(...s), () => {
    throw new Error('stopped')
  }), /stopped/)
  assert.deepEqual(written, [1])
})

// an IMAP account with n messages inside the body limit; the index's insertMany and setBodies sizes recorded
function imapSetup(t, n, walGate = null) {
  const { db, index } = memoryIndex(t)
  const account = addAccount(db)
  const server = new FakeImapServer().addMailbox('INBOX')
  server.addMessages('INBOX', Array.from({ length: n }, (_, i) => ({
    from: `k${i}@example.invalid`, to: 'en@example.invalid', subject: `Targy ${i}`, messageId: `<s${i}@x>`,
    date: NOW - DAY - i * 60_000, body: `A ${i}. level szovege: egyedi${i}szo.`,
  })))
  // the turns of the event loop so far, as each write sees it
  const ticker = { n: 0, on: true }
  const spin = () => {
    ticker.n++
    if (ticker.on) setImmediate(spin)
  }
  setImmediate(spin)
  onCleanup(t, () => (ticker.on = false))
  const calls = { insertMany: [], setBodies: [], turnAt: [] }
  for (const name of ['insertMany', 'setBodies']) {
    const fn = index[name].bind(index)
    index[name] = rows => {
      calls[name].push(rows.length)
      if (name === 'setBodies') calls.turnAt.push(ticker.n)
      if (calls.hook) calls.hook(name, calls[name].length)
      return fn(rows)
    }
  }
  const syncer = new Syncer({ account, index, connect: async () => server.client(), now: () => NOW, walGate })
  return { db, index, account, syncer, calls }
}

test('IMAP: the new rows go in INSERT_TX per transaction, the bodies BODY_TX per transaction; the end state is whole', async t => {
  const n = 130
  const { index, account, syncer, calls } = imapSetup(t, n)
  await syncer.run()
  assert.equal(INSERT_TX, 50)
  assert.equal(BODY_TX, 5)
  assert.ok(calls.insertMany.length >= 3 && Math.max(...calls.insertMany) <= INSERT_TX, `insertMany ${calls.insertMany}`)
  assert.equal(calls.insertMany.reduce((a, b) => a + b, 0), n)
  assert.ok(Math.max(...calls.setBodies) <= BODY_TX, `setBodies ${calls.setBodies}`)
  assert.equal(calls.setBodies.reduce((a, b) => a + b, 0), n)
  // a fetched chunk of 25 is parsed one message per turn: between the first writes of two chunks at least 24 turns
  const chunkStarts = calls.turnAt.filter((_, i) => i % (25 / BODY_TX) === 0)
  for (let i = 1; i < chunkStarts.length; i++) assert.ok(chunkStarts[i] - chunkStarts[i - 1] >= 24, `turns ${chunkStarts}`)
  const stats = index.stats(account.id)
  assert.equal(stats.total, n)
  assert.equal(stats.bodies, n, 'every row indexed')
  assert.deepEqual(index.search({ query: 'egyedi77szo' }).map(r => r.subject), ['Targy 77'])
})

test('IMAP: after each written chunk the sync awaits the WAL gate (a checkpoint off the main thread); a stop meanwhile ends it', async t => {
  let waits = 0
  let gates = 0
  const gate = { wait: async () => (waits++, null), gate: () => (gates++, null) }
  const { index, account, syncer, calls } = imapSetup(t, 130, gate)
  await syncer.run()
  // 3 metadata chunks of 50 (the 200-message fetch chunk, sliced) -> 1 wait; 6 body chunks (25 each) -> 6 waits
  assert.ok(waits >= 7, `waits ${waits}`)
  // and the gate asked before every write slice
  assert.equal(gates, calls.insertMany.length + calls.setBodies.length)
  assert.equal(index.stats(account.id).bodies, 130)
  // a stop while the gate is awaited: no write after it
  let release
  const slow = { wait: () => new Promise(r => (release = r)) }
  const s2 = imapSetup(t, 60, slow)
  const run = s2.syncer.run()
  await until(() => release)
  const before = s2.calls.setBodies.length + s2.calls.insertMany.length
  s2.syncer.stop()
  release(null)
  await assert.rejects(run, err => err.code === 'SYNC_STOPPED')
  await turns(10)
  assert.equal(s2.calls.setBodies.length + s2.calls.insertMany.length, before)
})

test('IMAP: a stop between two body slices writes nothing more; the rest stays pending for the next run', async t => {
  const { index, account, syncer, calls } = imapSetup(t, 40)
  calls.hook = (name, k) => {
    if (name === 'setBodies' && k === 1) syncer.stop()
  }
  await assert.rejects(syncer.run(), err => err.code === 'SYNC_STOPPED')
  await turns(10)
  assert.deepEqual(calls.setBodies, [BODY_TX], 'the slice in work, nothing after the stop')
  assert.equal(index.stats(account.id).bodies, BODY_TX)
  assert.equal(index.pendingCount(account.id), 40 - BODY_TX)
})

test('IMAP: a stop between two metadata slices writes no more rows', async t => {
  const { index, account, syncer, calls } = imapSetup(t, 130)
  calls.hook = (name, k) => {
    if (name === 'insertMany' && k === 1) syncer.stop()
  }
  await assert.rejects(syncer.run(), err => err.code === 'SYNC_STOPPED')
  await turns(10)
  assert.deepEqual(calls.insertMany, [INSERT_TX])
  assert.equal(index.stats(account.id).total, INSERT_TX)
  assert.deepEqual(calls.setBodies, [])
})

test('POP3: the local bodies BODY_TX per transaction, every row indexed', async t => {
  const server = await new FakePop3Server().listen()
  onCleanup(t, () => server.close())
  const n = 23
  for (let i = 0; i < n; i++) {
    server.add(Buffer.from(`From: a@example.invalid\r\nTo: b@example.invalid\r\nSubject: P ${i}\r\nDate: ${new Date(NOW - DAY).toUTCString()}\r\nMessage-ID: <p${i}@x>\r\n\r\nA ${i}. pop3 level: kulon${i}szo\r\n`))
  }
  const { db, index } = memoryIndex(t)
  const row = addAccount(db, { type: 'pop3', in_port: server.port, in_host: '127.0.0.1', in_security: 'none', in_user: server.user })
  const sizes = []
  const setBodies = index.setBodies.bind(index)
  index.setBodies = rows => {
    sizes.push(rows.length)
    return setBodies(rows)
  }
  const fetcher = new Pop3Fetcher({
    account: row,
    loadAccount: () => db.prepare('SELECT * FROM accounts WHERE id = ?').get(row.id),
    index,
    sealed: sealedStore(path.join(tempDir(t), 'store')),
    connect: async () => {
      const c = new Pop3Client({ host: '127.0.0.1', port: server.port, security: 'none', timeoutMs: 5000 })
      await c.connect()
      await c.login(server.user, server.pass)
      return c
    },
    now: () => NOW,
  })
  onCleanup(t, () => fetcher.stop())
  await fetcher.run()
  assert.ok(sizes.length >= 5 && Math.max(...sizes) <= BODY_TX, `setBodies ${sizes}`)
  assert.equal(sizes.reduce((a, b) => a + b, 0), n)
  const stats = index.stats(row.id)
  assert.equal(stats.bodies, n)
  assert.equal(stats.total, n)
  assert.equal(index.search({ query: 'kulon17szo' }).length, 1)
  assert.equal(BODY_STATE.INDEXED, 1)
})

// a POP3 account with n stored messages, a refiner on the fetcher (its worker answers 'REFINED' after 5 ms), the
// account's re-index flag done; onSlice(k) runs right after the k-th setBodies call
async function pop3Refined(t, n, onSlice) {
  const server = await new FakePop3Server().listen()
  onCleanup(t, () => server.close())
  for (let i = 0; i < n; i++) {
    server.add(Buffer.from(`From: a@example.invalid\r\nTo: b@example.invalid\r\nSubject: P ${i}\r\nDate: ${new Date(NOW - DAY).toUTCString()}\r\nMessage-ID: <q${i}@x>\r\n\r\nA ${i}. pop3 level: kulon${i}szo\r\n`))
  }
  const { db, index } = memoryIndex(t)
  const settings = openSettings(db)
  const row = addAccount(db, { type: 'pop3', in_port: server.port, in_host: '127.0.0.1', in_security: 'none', in_user: server.user })
  settings.set(FLAG(row.id), FLAG_DONE)
  const sealed = sealedStore(path.join(tempDir(t), 'store'))
  const service = {
    admit: async () => true,
    release() {},
    idle: () => true,
    stop() {},
    compute: () => new Promise(r => setTimeout(() => r({ text: 'REFINED', preview: null, complex: false }), 5)),
  }
  const refiner = createSearchRefiner({ service, index, settings, sealed })
  const sizes = []
  const setBodies = index.setBodies.bind(index)
  index.setBodies = rows => {
    sizes.push(rows.length)
    const r = setBodies(rows)
    onSlice(sizes.length, { refiner, fetcher })
    return r
  }
  const fetcher = new Pop3Fetcher({
    account: row,
    loadAccount: () => db.prepare('SELECT * FROM accounts WHERE id = ?').get(row.id),
    index,
    sealed,
    searchText: refiner,
    connect: async () => {
      const c = new Pop3Client({ host: '127.0.0.1', port: server.port, security: 'none', timeoutMs: 5000 })
      await c.connect()
      await c.login(server.user, server.pass)
      return c
    },
    now: () => NOW,
  })
  onCleanup(t, () => fetcher.stop())
  onCleanup(t, () => refiner.stop())
  const count = sql => db.prepare(sql).get(row.id).n
  const indexed = () => count('SELECT count(*) n FROM messages WHERE account_id = ? AND body_state = 1')
  const refined = () => count("SELECT count(*) n FROM messages_fts f JOIN messages m ON m.id = f.rowid WHERE m.account_id = ? AND f.body = 'REFINED'")
  return { fetcher, refiner, settings, sizes, flag: () => settings.get(FLAG(row.id)), indexed, refined }
}

test('POP3: a lock between two body slices (the refiner stops first, then the sync): the written rows send the account to its re-index', async t => {
  const s = await pop3Refined(t, 23, (k, { refiner, fetcher }) => {
    if (k === 1) {
      refiner.stop()
      fetcher.stop()
    }
  })
  await assert.rejects(s.fetcher.run(), err => err.code === 'SYNC_STOPPED')
  await sleep(50)
  assert.deepEqual(s.sizes, [BODY_TX], 'nothing written after the stop')
  assert.equal(s.indexed(), BODY_TX)
  assert.equal(s.refined(), 0)
  assert.equal(s.flag(), '', 'the next unlock re-indexes the rows written with the old text')
})

test('POP3: a sync stopped between two body slices while the refiner goes on: the written rows still get their text', async t => {
  const s = await pop3Refined(t, 23, (k, { fetcher }) => {
    if (k === 1) fetcher.stop()
  })
  await assert.rejects(s.fetcher.run(), err => err.code === 'SYNC_STOPPED')
  await until(() => s.refined() === BODY_TX && s.refiner.writesPending() === 0)
  assert.deepEqual(s.sizes, [BODY_TX])
  assert.equal(s.flag(), FLAG_DONE, 'nothing was lost: no re-index')
})
