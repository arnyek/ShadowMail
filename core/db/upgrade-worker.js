// SPDX-License-Identifier: GPL-3.0-or-later
// The worker thread of upgrade.js: opens the encrypted mail database with its own connection, which
// runs the backup and the pending migrations (openMailDatabase -> migrate), closes it, and reports { from, to, backup }
// or an error code. Nothing else: no logging (the caller logs), no content.
import { parentPort, workerData } from 'node:worker_threads'
import { openMailDatabase } from './index.js'

const raw = workerData.key
const key = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
try {
  const { db, migration } = openMailDatabase(workerData.file, { key })
  db.close()
  parentPort.postMessage({ ok: true, migration })
} catch (err) {
  parentPort.postMessage({ ok: false, code: err && typeof err.code === 'string' ? err.code : 'db_open_failed' })
} finally {
  key.fill(0)
}
