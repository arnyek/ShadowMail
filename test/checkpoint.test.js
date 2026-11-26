// The WAL checkpoint off the main thread (core/db/checkpoint.js): the worker's own connection checkpoints and writes
// nothing, its key copy is wiped; the main connection's autocheckpoint is off only while the worker answers; the timer
// and the sync's wait; a dying worker gives the checkpoints back to the main connection (logged, the WAL stays
// bounded); a lock during a checkpoint closes the worker first, no deadlock, then the main close removes the -wal; the
// quit (stopNow) also closes the worker first, blocking at most CLOSE_WAIT_MS.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { openMailDatabase } from '../core/db/index.js'
import { MailIndex } from '../core/db/mail-index.js'
import { startCheckpointer, AUTOCHECKPOINT, JOURNAL_SIZE_LIMIT, CLOSE_WAIT_MS } from '../core/db/checkpoint.js'
import { onCleanup, tempDir } from './helpers/tmp.js'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const until = async (fn, ms = 10_000) => {
  const t0 = performance.now()
  while (!fn()) {
    if (performance.now() - t0 > ms) throw new Error('timed out waiting')
    await sleep(5)
  }
}
const DYING = new URL('./helpers/checkpoint-dying-worker.mjs', import.meta.url)
const MUTE = new URL('./helpers/checkpoint-mute-worker.mjs', import.meta.url)

function encrypted(t) {
  const file = path.join(tempDir(t), 'mail.sqlite')
  const key = crypto.randomBytes(32)
  const { db } = openMailDatabase(file, { key })
  onCleanup(t, () => db.open && db.close())
  db.prepare("INSERT INTO accounts (name, email, type, in_host, in_port, in_security, in_user, created_at) VALUES ('a', 'a@x', 'imap', 'h', 993, 'tls', 'u', 0)").run()
  const index = new MailIndex(db)
  index.upsertFolder({ account_id: 1, path: 'INBOX', delimiter: '/', special_use: null, uidvalidity: '1', synced_at: 1 })
  return { file, key, db, index }
}
let uid = 0
// n new rows with a 4 KB body each: the WAL grows by about n * 2 pages
function write(index, n) {
  const rows = Array.from({ length: n }, () => {
    uid++
    return { account_id: 1, folder: 'INBOX', uid, message_id: `<${uid}@x>`, in_reply_to: null, refs: null, from_addr: 'a@x', from_name: 'A', to_addrs: 'b@x', cc_addrs: '', subject: `T ${uid}`, date: uid, idate: uid, flags: '', size: 1, has_attachments: 0, attachments: null, body_state: 0, sender_text: 'a', recipients_text: 'b' }
  })
  index.insertMany(rows)
  const ids = index.db.prepare('SELECT id FROM messages ORDER BY id DESC LIMIT ?').all(n).map(r => r.id)
  index.setBodies(ids.map(id => ({ id, text: `szoveg ${id} `.repeat(400), state: 1, preview: 'p' })))
}
const walBytes = file => (fs.existsSync(`${file}-wal`) ? fs.statSync(`${file}-wal`).size : 0)
const autocheckpoint = db => db.pragma('wal_autocheckpoint', { simple: true })

test('the worker checkpoints on its own connection, writes nothing, wipes its key; the main autocheckpoint is off meanwhile', async t => {
  const { file, key, db, index } = encrypted(t)
  const logs = []
  const c = startCheckpointer({ db, file, key, log: l => logs.push(l), everyMs: 60_000 })
  onCleanup(t, () => c.stop())
  const ready = await c.ready
  assert.deepEqual(ready, { wiped: true }, 'the worker\'s key copy is zero after the open')
  assert.ok(key.some(b => b !== 0), 'the caller\'s own key is the caller\'s to wipe')
  assert.equal(autocheckpoint(db), 0)
  assert.equal(db.pragma('journal_size_limit', { simple: true }), JOURNAL_SIZE_LIMIT)
  write(index, 300)
  const before = walBytes(file)
  assert.ok(before > 1024 * 1024, `the WAL grew: ${before}`)
  const r = await c.checkpoint()
  assert.ok(r.log > 0 && r.checkpointed === r.log, `all frames copied: ${JSON.stringify(r)}`)
  assert.equal(r.changes, 0, 'the worker\'s connection wrote nothing')
  // the next write restarts the WAL and journal_size_limit cuts it back
  write(index, 1)
  assert.ok(walBytes(file) <= JOURNAL_SIZE_LIMIT, `cut back: ${walBytes(file)}`)
  assert.deepEqual(logs, [])
})

test('the sync waits for a checkpoint only over the limit; the timer checkpoints a grown WAL by itself', async t => {
  const { file, key, db, index } = encrypted(t)
  let fake = 0
  const c = startCheckpointer({ db, file, key, everyMs: 20, timerBytes: 1000, waitBytes: 5000, size: () => fake })
  onCleanup(t, () => c.stop())
  await c.ready
  write(index, 50)
  fake = 4000
  assert.equal(await c.wait(), null, 'under the wait limit: no checkpoint awaited')
  fake = 6000
  const r = await c.wait()
  assert.ok(r && r.ok, 'over the limit: one checkpoint awaited')
  // every frame copied at this size: until the file changes (the next write restarts the WAL) no new checkpoint is
  // asked for (a waiting writer would ask for ever)
  assert.equal(c.gate(), null)
  assert.equal(await c.wait(), null)
  fake = 6500
  const g = c.gate()
  assert.ok(g, 'grown again: the gate holds')
  assert.equal(c.holding(), g, 'every writer gets the same wait')
  assert.ok((await g).ok)
  // the timer: over timerBytes it starts one by itself
  const n = c.checkpoints()
  fake = 2000
  await until(() => c.checkpoints() > n)
  // under it: none
  fake = 500
  await sleep(40)
  const m = c.checkpoints()
  await sleep(80)
  assert.equal(c.checkpoints(), m)
})

test('a worker that dies: the main connection checkpoints itself again at once, logged; the WAL stays bounded; the sync goes on', async t => {
  const { file, key, db, index } = encrypted(t)
  const logs = []
  const c = startCheckpointer({ db, file, key, log: l => logs.push(l), workerUrl: DYING, everyMs: 60_000, waitBytes: 0 })
  onCleanup(t, () => c.stop())
  await c.ready
  assert.equal(autocheckpoint(db), 0)
  write(index, 20)
  assert.equal(await c.wait(), null, 'the waiting sync is let go')
  await until(() => logs.length > 0)
  assert.deepEqual(logs, ['db checkpoint worker: worker_exit, autocheckpoint back on'])
  assert.equal(autocheckpoint(db), AUTOCHECKPOINT)
  assert.equal(c.active(), false)
  assert.equal(await c.wait(), null)
  // bounded again: 1000 pages autocheckpoint + journal_size_limit; 3000 rows would be ~25 MB without it
  for (let i = 0; i < 30; i++) write(index, 100)
  assert.ok(walBytes(file) < 12 * 1024 * 1024, `bounded: ${walBytes(file)}`)
})

test('a wrong key: no worker, the main autocheckpoint stays on, logged', async t => {
  const { file, db } = encrypted(t)
  const logs = []
  const c = startCheckpointer({ db, file, key: crypto.randomBytes(32), log: l => logs.push(l), everyMs: 60_000 })
  assert.equal(await c.ready, false)
  assert.equal(autocheckpoint(db), AUTOCHECKPOINT)
  await until(() => logs.length > 0)
  assert.match(logs[0], /^db checkpoint worker: \S+, autocheckpoint back on$/)
  assert.ok(!/[0-9a-f]{64}/.test(logs[0]), 'no key in the log')
  await c.stop()
})

test('a lock during a checkpoint: the worker closes first, within the limit, then the main close removes the -wal', async t => {
  const { file, key, db, index } = encrypted(t)
  const c = startCheckpointer({ db, file, key, everyMs: 60_000 })
  onCleanup(t, () => c.stop())
  await c.ready
  for (let i = 0; i < 20; i++) write(index, 100)
  assert.ok(walBytes(file) > 8 * 1024 * 1024)
  const running = c.checkpoint()
  const t0 = performance.now()
  await c.stop()
  const ms = performance.now() - t0
  assert.ok(ms <= CLOSE_WAIT_MS, `the lock waited ${ms.toFixed(0)} ms`)
  await running
  assert.equal(autocheckpoint(db), AUTOCHECKPOINT)
  db.close()
  assert.equal(fs.existsSync(`${file}-wal`) ? fs.statSync(`${file}-wal`).size : 0, 0, 'the last close checkpointed and removed the WAL')
  // the next unlock opens it as before
  const again = openMailDatabase(file, { key })
  assert.equal(again.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 2000)
  again.db.close()
})

test('quit: the worker closes first (the main thread blocks on its signal), then the main close removes the -wal and the -shm', async t => {
  // no MailIndex on this connection: the close of its many prepared statements gave a terminated worker time to close
  // first, so the old stopNow (terminate, no wait) left the -wal only without it (measured)
  const file = path.join(tempDir(t), 'mail.sqlite')
  const key = crypto.randomBytes(32)
  const { db } = openMailDatabase(file, { key })
  onCleanup(t, () => db.open && db.close())
  const c = startCheckpointer({ db, file, key, everyMs: 60_000 })
  await c.ready
  const ins = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
  for (let i = 0; i < 2000; i++) ins.run(`k${i}`, 'x'.repeat(3000))
  await c.checkpoint()
  ins.run('last', 'y')
  assert.ok(walBytes(file) > 0)
  const t0 = performance.now()
  c.stopNow()
  const ms = performance.now() - t0
  assert.ok(ms < CLOSE_WAIT_MS * 0.9, `the worker's signal ended the wait, not the limit (${ms.toFixed(0)} ms)`)
  assert.equal(autocheckpoint(db), AUTOCHECKPOINT)
  assert.equal(c.active(), false)
  db.close()
  assert.equal(fs.existsSync(`${file}-wal`), false, 'the last close checkpointed and removed the WAL')
  assert.equal(fs.existsSync(`${file}-shm`), false)
  const again = openMailDatabase(file, { key })
  assert.equal(again.db.prepare("SELECT value FROM settings WHERE key = 'last'").get().value, 'y')
  again.db.close()
})

test('quit with a worker that never answers: stopNow gives up after its limit, the main connection checkpoints itself again', async t => {
  const { file, key, db } = encrypted(t)
  const c = startCheckpointer({ db, file, key, workerUrl: MUTE, everyMs: 60_000 })
  await c.ready
  assert.equal(autocheckpoint(db), 0)
  const t0 = performance.now()
  c.stopNow()
  const ms = performance.now() - t0
  assert.ok(ms >= CLOSE_WAIT_MS * 0.9, `it waited for the worker (${ms.toFixed(0)} ms)`)
  assert.equal(autocheckpoint(db), AUTOCHECKPOINT)
  assert.equal(c.active(), false)
})
