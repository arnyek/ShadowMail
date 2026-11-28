// SPDX-License-Identifier: GPL-3.0-or-later
// The worker thread of sync-read.js: its own READ-ONLY connection to the encrypted mail database, for the reads of the
// sync's folder step (the stored rows against the server's UIDs, the rows with an unknown Bcc or a broken header, the
// flag comparison), so a big folder's reads and sets do not stop the main thread (the window's). It writes nothing
// (opened read-only, query_only on: no row, schema or setting; no trigger); the one SQL function it registers is the
// recipient_key the Bcc query needs. The key is copied in (structured clone) and wiped right after the connection
// opened. Messages (each answered with its id, { ok: false, code } on an error):
//   { id, op: 'diff', accountId, folder, server: Uint32Array } -> { snap, gone, fresh: Uint32Array, minKnown, knownCount, ranges }
//   { id, op: 'extra', snap, accountId, folder, bcc, headers } -> { bcc: [{ id, uid }], headers: [{ id, uid }] }
//   { id, op: 'flags', snap, uids: Uint32Array, flags: string[] } -> { changed: [{ uid, flags }] }
//   { op: 'release', snap }; { op: 'close' } -> the connection closes, workerData.closed[0] = 1 (notified), { closed: true }
// A snapshot (the server's UIDs and the known rows' flags of one diff) lives until its release; at most MAX_SNAPS.
import { parentPort, workerData } from 'node:worker_threads'
import Database from 'better-sqlite3-multiple-ciphers'
import { recipientKey } from '../mime/recipient-label.js'
import { changedFlags, flagRanges, folderDiff, onServer } from '../imap/folder-diff.js'

const MAX_SNAPS = 32
const raw = workerData.key
const key = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
let db = null
let code = null
let s = null
try {
  db = new Database(workerData.file, { readonly: true, fileMustExist: true })
  db.pragma("cipher = 'sqlcipher'")
  db.pragma(`key = "x'${key.toString('hex')}'"`)
  // a read tells a wrong key at once (SQLITE_NOTADB)
  db.prepare('SELECT count(*) FROM sqlite_master').get()
  db.pragma('query_only = ON')
  // a sort's temporary file would not be encrypted (core/db/index.js)
  db.pragma('temp_store = MEMORY')
  db.function('recipient_key', { deterministic: true }, (to, cc, bcc) => recipientKey(to, cc, bcc))
  // the same statements as MailIndex (core/db/mail-index.js localUids, bccUnknown, brokenHeadersFolder)
  s = {
    localUids: db.prepare('SELECT id, uid, idate, body_state, flags FROM messages WHERE account_id = ? AND folder = ?'),
    bccUnknown: db.prepare(`SELECT id, uid, store_path FROM messages
      WHERE account_id = @account_id AND folder = @folder AND bcc_addrs IS NULL
        AND recipient_key(to_addrs, cc_addrs, NULL) = ''`),
    brokenHeaders: db.prepare(`SELECT id, uid, folder, store_path FROM messages
      WHERE account_id = @account_id AND folder = @folder AND (@local = 0 OR uid IS NULL)
        AND (instr(subject, @bad) > 0 OR instr(from_name, @bad) > 0 OR instr(to_addrs, @bad) > 0 OR instr(cc_addrs, @bad) > 0)`),
    changes: db.prepare('SELECT total_changes() AS n'),
  }
} catch (err) {
  if (db) db.close()
  db = null
  code = err && typeof err.code === 'string' ? err.code : 'db_open_failed'
} finally {
  key.fill(0)
}
// `wiped`: this thread's copy of the key is zero (tests)
parentPort.postMessage(db ? { ready: true, wiped: key.every(b => b === 0) } : { ready: false, code })

let seq = 0
const snaps = new Map() // snap -> { serverSet, known }

const ops = {
  diff(m) {
    const d = folderDiff(s.localUids.iterate(m.accountId, m.folder), m.server)
    const snap = ++seq
    snaps.set(snap, { serverSet: d.serverSet, known: d.known })
    // the oldest snapshot goes when a caller never released (a stopped sync): the map stays small
    if (snaps.size > MAX_SNAPS) snaps.delete(snaps.keys().next().value)
    const ranges = d.known.size ? flagRanges(d.known.keys()) : []
    return { result: { snap, gone: d.gone, fresh: d.fresh, minKnown: d.minKnown, knownCount: d.known.size, ranges }, transfer: [d.fresh.buffer] }
  },
  extra(m) {
    const snap = snaps.get(m.snap)
    if (!snap) throw Object.assign(new Error('no snapshot'), { code: 'no_snapshot' })
    const bcc = m.bcc ? onServer(s.bccUnknown.iterate({ account_id: m.accountId, folder: m.folder }), snap.serverSet) : []
    const headers = m.headers ? onServer(s.brokenHeaders.iterate({ account_id: m.accountId, folder: m.folder, local: 0, bad: '\uFFFD' }), snap.serverSet) : []
    return { result: { bcc, headers } }
  },
  flags(m) {
    const snap = snaps.get(m.snap)
    if (!snap) throw Object.assign(new Error('no snapshot'), { code: 'no_snapshot' })
    return { result: { changed: changedFlags(snap.known, m.uids, m.flags) } }
  },
}

parentPort.on('message', m => {
  if (!m) return
  if (m.op === 'close') {
    snaps.clear()
    if (db) db.close()
    db = null
    // the quit's main thread blocks on this flag (sync-read.js stopNow)
    if (workerData.closed) {
      Atomics.store(workerData.closed, 0, 1)
      Atomics.notify(workerData.closed, 0)
    }
    parentPort.postMessage({ closed: true })
    parentPort.close()
    return
  }
  if (m.op === 'release') {
    snaps.delete(m.snap)
    return
  }
  const op = ops[m.op]
  if (!op) return
  if (!db) return parentPort.postMessage({ id: m.id, ok: false, code: 'db_closed' })
  try {
    const { result, transfer = [] } = op(m)
    // tests: the connection's own writes (always 0)
    result.changes = s.changes.get().n
    parentPort.postMessage({ id: m.id, ok: true, ...result }, transfer)
  } catch (err) {
    parentPort.postMessage({ id: m.id, ok: false, code: err && typeof err.code === 'string' ? err.code : 'read_failed' })
  }
})
