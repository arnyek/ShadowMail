// The sync's folder reads on a worker thread (core/db/sync-read.js): the index after every step is byte for byte the
// one the main-thread path makes (rows, flags, FTS, folders: deletions, new mail, flag changes with and without
// CONDSTORE, a UIDVALIDITY change, the header repair, the Bcc fill, a full run); the worker's connection writes nothing
// and its key copy is wiped; a message moved between the worker's read and the delete stays; a lock during a read
// under way does not wait for it and nothing is written after; a worker dying in the middle of a run: the run ends on
// the main thread, with the same index, the code logged and the run's line saying reader=main.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import crypto from 'node:crypto'
import { openMailDatabase } from '../core/db/index.js'
import { MailIndex } from '../core/db/mail-index.js'
import { startSyncReader, CLOSE_WAIT_MS } from '../core/db/sync-read.js'
import { Syncer } from '../core/imap/sync.js'
import { folderDiff, changedFlags, onServer } from '../core/imap/folder-diff.js'
import { SyncManager, syncLogLine } from '../app/main/sync-manager.js'
import { addAccount } from './helpers/fixtures.js'
import { onCleanup, tempDir } from './helpers/tmp.js'
import { FakeImapServer } from './helpers/fake-imap.js'

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0)
const BUSY = new URL('./helpers/sync-read-busy-worker.mjs', import.meta.url)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const until = async (fn, ms = 10_000) => {
  const t0 = performance.now()
  while (!fn()) {
    if (performance.now() - t0 > ms) throw new Error('timed out waiting')
    await sleep(5)
  }
}

const msg = (tag, k, patch = {}) => ({ from: `kuldo${k}@example.invalid`, fromName: `Küldő ${k}`, to: `cimzett${k}@example.invalid`, subject: `${tag} tárgy ${k}`, messageId: `<${tag}-${k}@x>`, date: NOW - (k + 1) * 3_600_000, body: `${tag} szöveg ${k} árvíztűrő`, ...patch })

/** the same mailboxes on every call: INBOX, Archive, Sent (Bcc-only rows among them) */
function makeServer() {
  const server = new FakeImapServer().addMailbox('INBOX').addMailbox('Archive').addMailbox('Sent', { specialUse: '\\Sent' })
  server.addMessages('INBOX', Array.from({ length: 60 }, (_, k) => msg('in', k, k % 3 ? {} : { flags: ['\\Seen'] })))
  server.addMessages('Archive', Array.from({ length: 20 }, (_, k) => msg('ar', k)))
  server.addMessages('Sent', Array.from({ length: 6 }, (_, k) => msg('se', k)))
  for (const uid of [2, 4, 5]) Object.assign(server.mailboxes.get('Sent').messages.get(uid).envelope, { to: [], cc: [], bcc: [{ name: `Titkos ${uid}`, address: `t${uid}@example.invalid` }] })
  return server
}

/** one encrypted database, its fake server and, with worker, the read worker */
async function universe(t, { worker, workerUrl } = {}) {
  const file = path.join(tempDir(t), 'mail.sqlite')
  const key = crypto.randomBytes(32)
  const { db } = openMailDatabase(file, { key })
  onCleanup(t, () => db.open && db.close())
  const index = new MailIndex(db)
  const account = addAccount(db, { name: 'Fiók', email: 'fiok@example.invalid' })
  const logs = []
  let reader = null
  if (worker) {
    reader = startSyncReader({ file, key, log: l => logs.push(l), ...(workerUrl ? { workerUrl } : {}) })
    onCleanup(t, () => reader.stop())
  }
  const server = makeServer()
  const summaries = []
  const syncer = () => {
    const s = new Syncer({ account, index, connect: async () => server.client(), now: () => NOW, syncReader: reader, onRunEnd: x => summaries.push(x) })
    onCleanup(t, () => s.stop())
    return s
  }
  return { file, key, db, index, account, server, reader, logs, summaries, syncer }
}

/** everything the sync writes, in a fixed order */
function dump(db) {
  return {
    messages: db.prepare('SELECT * FROM messages ORDER BY id').all(),
    fts: db.prepare('SELECT rowid, subject, sender, recipients, body FROM messages_fts ORDER BY rowid').all(),
    folders: db.prepare('SELECT * FROM folders ORDER BY path').all(),
  }
}

/** the same step on both: a change on the server (and maybe in the database), then a run */
async function both(A, B, change, run = s => s.run()) {
  for (const u of [A, B]) {
    if (change) change(u)
    u.current ??= u.syncer()
    await run(u.current, u)
  }
  assert.deepEqual(dump(A.db), dump(B.db))
}

test('the folder rules (folder-diff.js): gone, new newest first, known flags, ranges; the answers compared', () => {
  const rows = [{ id: 1, uid: 5, flags: '' }, { id: 2, uid: 3, flags: '\\Seen' }, { id: 3, uid: 9, flags: '' }]
  const d = folderDiff(rows, [3, 4, 5, 7])
  assert.deepEqual(d.gone, [{ id: 3, uid: 9 }])
  assert.deepEqual([...d.fresh], [7, 4])
  assert.deepEqual([...d.known], [[5, ''], [3, '\\Seen']])
  assert.equal(d.minKnown, 3)
  assert.deepEqual(changedFlags(d.known, [3, 5, 8], ['\\Seen', '\\Flagged', '\\Seen']), [{ uid: 5, flags: '\\Flagged' }])
  assert.deepEqual(onServer([{ id: 1, uid: 5, x: 1 }, { id: 3, uid: 9 }], d.serverSet), [{ id: 1, uid: 5 }])
  assert.equal(folderDiff([], []).minKnown, Infinity)
})

test('worker and main thread: the index byte for byte the same after every step; every run read on the worker, which wrote nothing', async t => {
  const A = await universe(t, { worker: true })
  const B = await universe(t)
  assert.deepEqual(await A.reader.ready, { wiped: true }, 'the worker\'s key copy is zero after the open')
  // the clean-up needs the paths only: no folder count is read during a sync (folderList, not folders)
  let counted = 0
  const folders = A.index.folders.bind(A.index)
  A.index.folders = id => {
    counted++
    return folders(id)
  }
  // the first sync
  await both(A, B)
  // deleted on the server, new mail, flag changes, without CONDSTORE; enough known rows for two flag ranges
  await both(A, B, u => {
    for (const uid of [3, 7, 11]) u.server.deleteMessage('INBOX', uid)
    u.server.addMessages('INBOX', Array.from({ length: 2100 }, (_, k) => msg('uj', k)))
    u.server.setFlags('INBOX', 1, ['\\Seen', '\\Flagged'])
    u.server.setFlags('Archive', 2, ['\\Answered'])
  })
  await both(A, B, u => {
    u.server.setFlags('INBOX', 100, ['\\Seen'])
    u.server.setFlags('INBOX', 2150, ['$label1'])
  })
  // CONDSTORE: a saved HIGHESTMODSEQ, one FETCH of the changes
  await both(A, B, u => {
    u.server.modseq = 10
  })
  await both(A, B, u => {
    u.server.setFlags('INBOX', 4, ['\\Flagged'])
    u.server.deleteMessage('Archive', 5)
  })
  // a new UIDVALIDITY: the folder's rows go and come back
  await both(A, B, u => {
    u.server.mailboxes.get('Archive').uidValidity = 2
  })
  // rows stored broken (a U+FFFD header) and Sent rows without a Bcc: a fresh instance repairs and fills them
  await both(A, B, u => {
    u.db.prepare("UPDATE messages SET subject = 'rossz \uFFFD tárgy' WHERE folder = 'INBOX' AND uid IN (5, 6)").run()
    u.db.prepare("UPDATE messages SET bcc_addrs = NULL WHERE folder = 'Sent'").run()
    u.current = u.syncer()
  })
  assert.equal(A.db.prepare("SELECT count(*) FROM messages WHERE instr(subject, '\uFFFD') > 0").pluck().get(), 0, 'repaired')
  assert.equal(A.db.prepare("SELECT bcc_addrs FROM messages WHERE folder = 'Sent' AND uid = 4").pluck().get(), 'Titkos 4 <t4@example.invalid>', 'filled')
  // a full run
  await both(A, B, null, s => s.run({ full: true }))
  // a targeted run (IDLE)
  await both(A, B, u => u.server.addMessage('INBOX', msg('idle', 1)), s => s.run({ folders: ['INBOX'] }))

  assert.ok(A.summaries.length >= 9)
  assert.deepEqual(A.summaries.map(s => s.reader), A.summaries.map(() => 'worker'))
  assert.deepEqual(B.summaries.map(s => s.reader), B.summaries.map(() => 'main'))
  assert.deepEqual(A.summaries.map(s => [s.flags, s.added, s.folders]), B.summaries.map(s => [s.flags, s.added, s.folders]))
  const st = A.reader.stats()
  assert.ok(st.answered >= st.requests && st.requests > 20, JSON.stringify(st))
  assert.equal(st.maxChanges, 0, 'the worker\'s connection wrote nothing')
  assert.deepEqual(A.logs, [])
  assert.equal(counted, 0, 'no folders() (counts) during the runs')
})

test('a message moved between the worker\'s read and the delete stays (the delete is guarded by id + account + folder + uid)', async t => {
  const u = await universe(t, { worker: true })
  const syncer = u.syncer()
  await syncer.run()
  const row = u.index.getByUid(u.account.id, 'INBOX', 5)
  const other = u.index.getByUid(u.account.id, 'INBOX', 6)
  // on the server the user moved #5 to Archive (a new UID there) and deleted #6
  const moved = u.server.mailboxes.get('INBOX').messages.get(5)
  const newUid = u.server.addMessage('Archive', msg('in', 5))
  u.server.mailboxes.get('Archive').messages.get(newUid).flags = new Set(moved.flags)
  u.server.deleteMessage('INBOX', 5)
  u.server.deleteMessage('INBOX', 6)
  // the app's own move lands after the worker read INBOX, before the delete
  const diff = u.reader.diff
  u.reader.diff = async args => {
    const r = await diff(args)
    if (args.folder === 'INBOX') u.index.moveRows([{ id: row.id, folder: 'Archive', uid: newUid }])
    return r
  }
  await syncer.run()
  const after = u.index.get(row.id)
  assert.ok(after, 'the moved message is still there')
  assert.deepEqual([after.folder, after.uid, after.message_id], ['Archive', newUid, row.message_id])
  assert.equal(u.index.get(other.id), undefined, 'the one deleted on the server is gone')
  assert.equal(syncer.state.lastRemoved, 1)
  assert.equal(u.summaries.at(-1).reader, 'worker')
})

test('deleteGuarded: only rows that still match go, with their store paths; one transaction', async t => {
  const u = await universe(t)
  await u.syncer().run()
  const a = u.index.getByUid(u.account.id, 'INBOX', 1)
  const b = u.index.getByUid(u.account.id, 'INBOX', 2)
  const c = u.index.getByUid(u.account.id, 'INBOX', 3)
  u.index.setStorePath(a.id, 'aa/a.eml')
  u.index.moveRows([{ id: c.id, folder: 'Archive', uid: 999 }])
  const out = u.index.deleteGuarded(u.account.id, 'INBOX', [{ id: a.id, uid: 1 }, { id: b.id, uid: 77 }, { id: c.id, uid: 3 }, { id: 424242, uid: 4 }])
  assert.deepEqual(out, [{ id: a.id, storePath: 'aa/a.eml' }])
  assert.equal(u.index.get(a.id), undefined)
  assert.ok(u.index.get(b.id), 'another UID: stays')
  assert.ok(u.index.get(c.id), 'another folder: stays')
})

test('a lock while a worker read is under way: the run stops at once, the worker closes within its limit, nothing is written after', async t => {
  const u = await universe(t, { worker: true, workerUrl: BUSY })
  assert.deepEqual(await u.reader.ready, { wiped: true })
  const syncer = u.syncer()
  const run = syncer.run()
  run.catch(() => {})
  await until(() => u.reader.stats().requests >= 1)
  await sleep(50) // the worker is inside its read
  const changes = u.db.prepare('SELECT total_changes() AS n').get().n
  // after the stop the main thread does not read the folder itself (the database may be closed by then)
  let mainReads = 0
  for (const name of ['localUids', 'bccUnknownRows', 'brokenHeaderRows']) {
    const fn = u.index[name].bind(u.index)
    u.index[name] = (...a) => {
      mainReads++
      return fn(...a)
    }
  }
  const t0 = performance.now()
  syncer.stop()
  const stopped = u.reader.stop()
  await assert.rejects(run, err => err.code === 'SYNC_STOPPED')
  const runMs = performance.now() - t0
  await stopped
  const lockMs = performance.now() - t0
  t.diagnostic(`run settled ${runMs.toFixed(0)} ms, lock ${lockMs.toFixed(0)} ms after the stop`)
  assert.ok(runMs < 200, `the run did not wait for the read: ${runMs} ms`)
  // the card's limit (1 s); the worker's own close wait is CLOSE_WAIT_MS (measured 502 ms on a quiet machine)
  assert.ok(lockMs >= CLOSE_WAIT_MS - 50 && lockMs <= 1000, `the lock: ${lockMs} ms`)
  assert.equal(u.reader.active(), false)
  assert.equal(mainReads, 0, 'no main-thread read after the stop')
  // the busy read would have answered after 3 s: nothing comes, nothing is written
  await sleep(3200)
  assert.equal(u.db.prepare('SELECT total_changes() AS n').get().n, changes, 'no write after the lock')
  assert.equal(u.reader.stats().dropped, 1)
  assert.equal(await u.reader.diff({ accountId: 1, folder: 'INBOX', server: new Uint32Array(1) }), null, 'a stopped reader answers null')
  assert.ok(!u.logs.some(l => /main thread/.test(l)), `a lock is not a failure: ${u.logs.join('; ')}`)
})

test('the worker dies in the middle of a run: the run ends on the main thread, the index is the main path\'s, the code is logged', async t => {
  const A = await universe(t, { worker: true })
  const B = await universe(t)
  await both(A, B)
  // flags and a deletion in INBOX; the worker dies right after INBOX's first read (its flag compare and the other
  // folders go the main-thread way)
  const diff = A.reader.diff
  A.reader.diff = async args => {
    const r = await diff(args)
    if (args.folder === 'INBOX') {
      A.reader.kill()
      await until(() => !A.reader.active())
    }
    return r
  }
  await both(A, B, u => {
    u.server.deleteMessage('INBOX', 9)
    u.server.addMessages('INBOX', Array.from({ length: 3 }, (_, k) => msg('kill', k)))
    u.db.prepare("UPDATE messages SET subject = 'rossz \uFFFD' WHERE folder = 'INBOX' AND uid = 10").run()
    u.server.setFlags('INBOX', 1, ['\\Flagged'])
    u.server.setFlags('Archive', 1, ['\\Seen'])
    u.server.addMessage('Archive', msg('ar', 99))
    u.db.prepare("UPDATE messages SET bcc_addrs = NULL WHERE folder = 'Sent'").run()
    u.current = u.syncer()
  })
  assert.deepEqual(A.logs, ['sync read worker: worker_exit, main thread'])
  assert.equal(A.db.prepare("SELECT subject FROM messages WHERE folder = 'INBOX' AND uid = 10").pluck().get(), 'in tárgy 9', 'repaired on the main thread')
  const last = A.summaries.at(-1)
  assert.equal(last.reader, 'main')
  assert.match(syncLogLine(last), / result=ok reader=main$/)
  // the next run goes the main-thread way from its start, same index
  await both(A, B, u => u.server.setFlags('INBOX', 2, ['\\Seen']))
  assert.equal(A.summaries.at(-1).reader, 'main')
})

test('one read the living worker fails (the next folder still on it): that step on the main thread, same index, reader=main', async t => {
  const A = await universe(t, { worker: true })
  const B = await universe(t)
  await both(A, B)
  const extra = A.reader.extra
  const flags = A.reader.flags
  A.reader.extra = async args => (args.folder === 'INBOX' ? null : extra(args))
  A.reader.flags = async (...a) => (A.failFlags ? null : flags(...a))
  A.failFlags = true
  await both(A, B, u => {
    u.db.prepare("UPDATE messages SET subject = 'rossz \uFFFD' WHERE folder = 'INBOX' AND uid = 12").run()
    u.db.prepare("UPDATE messages SET bcc_addrs = NULL WHERE folder = 'Sent'").run()
    u.server.setFlags('INBOX', 2, ['\\Flagged'])
    u.server.setFlags('Sent', 1, ['\\Seen'])
    u.current = u.syncer()
  })
  assert.equal(A.db.prepare("SELECT subject FROM messages WHERE folder = 'INBOX' AND uid = 12").pluck().get(), 'in tárgy 11', 'repaired on the main thread')
  assert.equal(A.summaries.at(-1).reader, 'main')
  assert.ok(A.reader.active(), 'the worker lives on')
  // the next run without failures: the worker again
  A.failFlags = false
  A.reader.extra = extra
  await both(A, B, u => u.server.setFlags('INBOX', 3, ['\\Seen']))
  assert.equal(A.summaries.at(-1).reader, 'worker')
})

test('SyncManager: the read worker in syncerOptions; the run\'s line says reader=worker', async t => {
  const u = await universe(t, { worker: true })
  const store = { list: () => [u.account], getRow: id => (id === u.account.id ? u.account : null), passwordsFor: () => ({ incoming: 'x' }) }
  const logs = []
  const manager = new SyncManager({ store, index: u.index, log: l => logs.push(l), connect: () => u.server.client(), now: () => NOW, throttleMs: 5, idleOptions: { retryDelaysMs: [60_000] }, syncerOptions: { syncReader: u.reader } })
  onCleanup(t, () => manager.stopAll())
  manager.startAll()
  await until(() => logs.some(l => l.startsWith('sync ')))
  assert.match(logs.find(l => l.startsWith('sync ')), / kind=full .* result=ok reader=worker$/)
})
