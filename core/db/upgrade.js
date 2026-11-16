// SPDX-License-Identifier: GPL-3.0-or-later
// Schema upgrade on unlock, off the main thread. The backup (VACUUM INTO, a full copy) and the
// migrations take about 0.1 s per MB (measured); better-sqlite3 is synchronous, so in the main process the
// window froze for that long and Windows marked it "not responding". Here:
//   1. pendingUpgrade: is there a migration to run (an existing database with an older schema)? A new database or an
//      up-to-date one says null: no notice, nothing else happens.
//   2. the leftovers of an unfinished copy go (removeBackupLeftovers), then upgradeSpace: the copy needs as much free space as mail.sqlite (+ its -wal); if it is not there, 'db_no_space'
//      and nothing is written (the data and the schema stay as they are).
//   3. onStart (the lock screen shows the notice), then the backup and the migrations in a worker thread with its own
//      connection (upgrade-worker.js); the main thread only waits on a promise.
// Afterwards the caller opens the database as before (openUnlockedDatabase); its migrate() finds nothing to do.
import fs from 'node:fs'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { openDatabase } from './index.js'
import { currentVersion, removeBackupLeftovers } from './migrate.js'
import { MIGRATIONS } from './schema.js'

export const WORKER_URL = new URL('./upgrade-worker.js', import.meta.url)
const MB = 1024 * 1024

export class UpgradeError extends Error {
  constructor(code, info = null) {
    super(code)
    this.name = 'UpgradeError'
    this.code = code
    this.info = info
  }
}

/** { from, to } when the existing database at `file` has an older schema than `migrations`, else null. */
export function pendingUpgrade(file, key, migrations = MIGRATIONS) {
  if (!fs.existsSync(file)) return null
  const db = openDatabase(file, key)
  try {
    const from = currentVersion(db)
    const to = migrations.length
    return from > 0 && from < to ? { from, to } : null
  } finally {
    db.close()
  }
}

/** The free space the backup needs (the database and its -wal) and what the volume has, in bytes. */
export function upgradeSpace(file, statfs = p => fs.statfsSync(p)) {
  const size = f => {
    try {
      return fs.statSync(f).size
    } catch {
      return 0
    }
  }
  const need = size(file) + size(`${file}-wal`)
  const s = statfs(path.dirname(file))
  const free = Number(s.bavail) * Number(s.bsize)
  return { need, free, ok: free >= need }
}

/** Runs openMailDatabase (backup + migrations) in a worker thread; resolves with its { from, to, backup }. */
export function upgradeInWorker(file, key, { workerUrl = WORKER_URL } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false
    const settle = (fn, value) => {
      if (settled) return
      settled = true
      fn(value)
    }
    // the key is copied into the worker (structured clone); the worker wipes its copy, the caller its own
    const worker = new Worker(workerUrl, { workerData: { file, key } })
    worker.once('message', m => (m && m.ok ? settle(resolve, m.migration) : settle(reject, new UpgradeError((m && m.code) || 'db_open_failed'))))
    worker.once('error', err => settle(reject, err))
    worker.once('exit', code => settle(reject, new UpgradeError('db_open_failed', { exit: code })))
  })
}

/**
 * The whole step: null when there is nothing to upgrade, else the migration's { from, to, backup } after the worker.
 * onStart({ from, to }) runs before the copy starts (the notice). Throws UpgradeError('db_no_space', { needMb,
 * freeMb }) without writing anything, or what opening the database throws (DatabaseKeyError: 'db_key').
 */
export async function upgradeDatabase({ file, key, migrations = MIGRATIONS, onStart = () => {}, statfs, workerUrl } = {}) {
  const pending = pendingUpgrade(file, key, migrations)
  if (!pending) return null
  // the leftovers of a copy that did not finish go BEFORE the space check: they hold space the new copy needs
  // (otherwise every later start would say "no space", while the program's own .tmp holds it)
  removeBackupLeftovers(file)
  const space = upgradeSpace(file, statfs)
  if (!space.ok) throw new UpgradeError('db_no_space', { needMb: Math.ceil(space.need / MB), freeMb: Math.floor(space.free / MB) })
  onStart(pending)
  return upgradeInWorker(file, key, { workerUrl })
}
