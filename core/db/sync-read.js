// SPDX-License-Identifier: GPL-3.0-or-later
// The sync's folder reads off the main thread. Every full sync read, per folder and on the main thread (the window's),
// all the folder's stored rows, the rows with a broken header and, in Sent / Drafts, the rows with an unknown Bcc (one JS
// function per row), and built the sets of the folder against the server's UIDs; on a big encrypted database with a
// cold page cache that was a 100-500 ms stall per folder (the owner's log: 49 folders, no new mail, 50 stalls over
// 100 ms, the longest 478 ms). Here a worker thread with its own read-only connection (sync-read-worker.js) does the
// reads and the sets, and the main thread gets the small results: the rows to delete, the new UIDs, the flag ranges,
// the changed flags. The sync writes as before, on the main connection (one connection writes: the taskbar badge's TEMP
// triggers and folderWriteCount count on it); a delete is guarded by id + account + folder + uid, because a message
// can be moved between the worker's snapshot and the delete.
// Any worker error or exit: the request resolves null and the sync takes its main-thread path (the code is logged);
// a request while the worker is starting waits for it. Lock and quit: the worker closes FIRST (with the checkpoint
// worker), a request under way resolves null (its result dropped), then the caller closes the main connection.
import { Worker } from 'node:worker_threads'

// the lock waits at most this long for the worker's close (a read under way finishes first), then terminates it: the
// connection is read-only, nothing is lost
export const CLOSE_WAIT_MS = 500
const WORKER_URL = new URL('./sync-read-worker.js', import.meta.url)

/**
 * file: the database path, key: the 32-byte key (copied into the worker; the caller wipes its own).
 * -> { ready (false, or { wiped }), active(), diff(), extra(), flags(), release(), stop(), stopNow(), kill(), stats() }
 */
export function startSyncReader({ file, key, log = () => {}, workerUrl = WORKER_URL }) {
  // the worker sets it to 1 once its connection is closed: the quit blocks on it (stopNow)
  const closedFlag = new Int32Array(new SharedArrayBuffer(4))
  let worker = new Worker(workerUrl, { workerData: { file, key, closed: closedFlag } })
  let active = false
  let starting = true
  let closing = false
  let onClosed = null
  let seq = 0
  const pending = new Map() // id -> resolve
  const failed = new Set() // the request error codes logged once
  const stats = { requests: 0, answered: 0, dropped: 0, maxChanges: 0 }
  const hold = () => {
    if (!worker) return
    if (starting || closing || pending.size) worker.ref()
    else worker.unref()
  }

  // the worker failed or left: every request from here resolves null (the sync's main-thread path)
  const fallBack = code => {
    if (!worker) return
    const w = worker
    worker = null
    active = false
    if (!closing) log(`sync read worker: ${code}, main thread`)
    for (const resolve of pending.values()) resolve(null)
    stats.dropped += pending.size
    pending.clear()
    if (onClosed) onClosed()
    w.terminate().catch(() => {})
  }

  let readyResolve
  const ready = new Promise(r => (readyResolve = r))
  worker.on('message', m => {
    if (m && 'ready' in m) {
      starting = false
      hold()
      if (!m.ready) {
        fallBack(m.code || 'db_open_failed')
        return readyResolve(false)
      }
      if (closing) return readyResolve(false)
      active = true
      return readyResolve({ wiped: m.wiped })
    }
    if (m && m.closed) {
      if (onClosed) onClosed()
      return
    }
    const resolve = m && pending.get(m.id)
    if (!resolve) return
    pending.delete(m.id)
    hold()
    stats.answered++
    if (!m.ok) {
      const code = m.code || 'read_failed'
      if (!failed.has(code)) {
        failed.add(code)
        log(`sync read worker: ${code}, main thread`)
      }
      return resolve(null)
    }
    if (m.changes > stats.maxChanges) stats.maxChanges = m.changes
    resolve(m)
  })
  worker.on('error', err => {
    fallBack(err && err.code ? err.code : 'worker_error')
    readyResolve(false)
  })
  worker.on('exit', () => {
    fallBack('worker_exit')
    readyResolve(false)
  })

  const send = (msg, transfer) =>
    ready.then(() => {
      if (!active || !worker || closing) return null
      const id = ++seq
      stats.requests++
      const answer = new Promise(resolve => pending.set(id, resolve))
      hold()
      try {
        worker.postMessage({ ...msg, id }, transfer)
      } catch (err) {
        pending.delete(id)
        fallBack(err && err.code ? err.code : 'post_failed')
        return null
      }
      return answer
    })

  const close = () => {
    closing = true
    active = false
    // the request under way is dropped: its result would come after the lock
    for (const resolve of pending.values()) resolve(null)
    stats.dropped += pending.size
    pending.clear()
  }

  return {
    ready,
    active: () => active,
    stats: () => ({ ...stats }),
    /**
     * The folder's stored rows against `server` (the UIDs on the server, a Uint32Array: transferred, the caller's copy
     * is empty afterwards). -> { snap, gone: [{ id, uid }], fresh: Uint32Array (newest first), minKnown, knownCount,
     * ranges (the FLAG_CHUNK ranges of the known UIDs) } or null (main-thread path)
     */
    diff({ accountId, folder, server }) {
      return send({ op: 'diff', accountId, folder, server }, [server.buffer])
    },
    /** the rows with an unknown Bcc (bcc) and with a broken header (headers) on the server of snapshot `snap`; -> { bcc, headers } or null */
    extra({ snap, accountId, folder, bcc, headers }) {
      return send({ op: 'extra', snap, accountId, folder, bcc: Boolean(bcc), headers: Boolean(headers) })
    },
    /** the flag answers of one range against the snapshot's stored flags: uids (Uint32Array, transferred), flags (strings); -> { changed } or null */
    flags(snap, uids, flags) {
      return send({ op: 'flags', snap, uids, flags }, [uids.buffer])
    },
    /** the snapshot is not needed any more */
    release(snap) {
      if (active && worker && !closing) worker.postMessage({ op: 'release', snap })
    },
    /** Lock: a request under way resolves null, the worker closes its connection, then this resolves (at most CLOSE_WAIT_MS, then terminated). */
    stop() {
      close()
      if (!worker) return Promise.resolve()
      const w = worker
      return new Promise(resolve => {
        const t = setTimeout(() => {
          fallBack('close_timeout')
          resolve()
        }, CLOSE_WAIT_MS)
        onClosed = () => {
          clearTimeout(t)
          onClosed = null
          resolve()
        }
        hold()
        w.postMessage({ op: 'close' })
      }).then(() => {
        if (worker) {
          const w2 = worker
          worker = null
          w2.terminate().catch(() => {})
        }
      })
    },
    /** Quit: the worker's connection closes first; the main thread blocks on its signal, at most CLOSE_WAIT_MS. */
    stopNow() {
      close()
      if (worker) {
        try {
          worker.postMessage({ op: 'close' })
          Atomics.wait(closedFlag, 0, 0, CLOSE_WAIT_MS)
        } catch (err) {
          log(`sync read worker: quit wait failed (${err && err.code ? err.code : 'error'})`)
        }
      }
      fallBack('quit')
    },
    /** Tests and measurements: the worker dies as in a crash. */
    kill() {
      if (worker) worker.terminate().catch(() => {})
    },
  }
}
