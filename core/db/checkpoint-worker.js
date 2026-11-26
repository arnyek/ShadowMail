// SPDX-License-Identifier: GPL-3.0-or-later
// The worker thread of checkpoint.js: its own connection to the encrypted mail database that runs ONLY
// `PRAGMA wal_checkpoint(PASSIVE)` (it writes no row, schema or setting; no journal mode, no function, no trigger), so
// the WAL is copied back into the database off the main thread. The key is copied in (structured clone) and wiped
// right after the connection opened. Messages: { id, op: 'checkpoint' } -> { id, ok, busy, log, checkpointed } or
// { id, ok: false, code }; { op: 'close' } -> the connection closes, workerData.closed[0] = 1 (notified), { closed: true }.
import { parentPort, workerData } from 'node:worker_threads'
import Database from 'better-sqlite3-multiple-ciphers'

const raw = workerData.key
const key = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
let db = null
let code = null
try {
  db = new Database(workerData.file, { fileMustExist: true })
  db.pragma("cipher = 'sqlcipher'")
  db.pragma(`key = "x'${key.toString('hex')}'"`)
  // a read tells a wrong key at once (SQLITE_NOTADB)
  db.prepare('SELECT count(*) FROM sqlite_master').get()
} catch (err) {
  if (db) db.close()
  db = null
  code = err && typeof err.code === 'string' ? err.code : 'db_open_failed'
} finally {
  key.fill(0)
}
// `wiped`: this thread's copy of the key is zero (tests)
parentPort.postMessage(db ? { ready: true, wiped: key.every(b => b === 0) } : { ready: false, code })

parentPort.on('message', m => {
  if (!m) return
  if (m.op === 'close') {
    if (db) db.close()
    db = null
    // the quit's main thread blocks on this flag (checkpoint.js stopNow)
    if (workerData.closed) {
      Atomics.store(workerData.closed, 0, 1)
      Atomics.notify(workerData.closed, 0)
    }
    parentPort.postMessage({ closed: true })
    parentPort.close()
    return
  }
  if (!db || m.op !== 'checkpoint') return
  try {
    const [r] = db.pragma('wal_checkpoint(PASSIVE)')
    parentPort.postMessage({ id: m.id, ok: true, busy: r.busy, log: r.log, checkpointed: r.checkpointed, changes: db.prepare('SELECT total_changes() AS n').get().n })
  } catch (err) {
    parentPort.postMessage({ id: m.id, ok: false, code: err && typeof err.code === 'string' ? err.code : 'checkpoint_failed' })
  }
})
