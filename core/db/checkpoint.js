// SPDX-License-Identifier: GPL-3.0-or-later
// The WAL checkpoint off the main thread. SQLite runs a checkpoint inside the commit that grows the WAL past
// `wal_autocheckpoint` pages (1000), on the thread that commits: during a big sync that was the main process's thread
// (the window's), and those commits were its longest stalls (measured: 16 000 synced rows, the writes over 30 ms 100
// -> 3, the longest 352 -> 34 ms without it). Here a worker thread with its own connection (checkpoint-worker.js)
// runs `wal_checkpoint(PASSIVE)`; the main connection's autocheckpoint is 0 ONLY while the worker is ready and
// answers. A timer starts one every EVERY_MS when the -wal file is over TIMER_BYTES (the user and MCP write too), and
// the sync awaits one between its slices when the file is over WAIT_BYTES (a PASSIVE checkpoint does not catch up
// with a writer that never pauses; the main thread is free meanwhile, only the sync waits). journal_size_limit cuts
// the -wal back when it restarts. Any worker error or exit: the main connection's autocheckpoint goes back to 1000 at
// once and the code is logged. Lock and quit: the worker closes FIRST, then the caller closes the main connection
// (whose close makes the last checkpoint).
import fs from 'node:fs'
import { Worker } from 'node:worker_threads'

export const AUTOCHECKPOINT = 1000
export const EVERY_MS = 2000
export const TIMER_BYTES = 4 * 1024 * 1024
export const WAIT_BYTES = 8 * 1024 * 1024
export const JOURNAL_SIZE_LIMIT = 4 * 1024 * 1024
export const CLOSE_WAIT_MS = 1000
export const WAIT_ROUNDS = 5
const WORKER_URL = new URL('./checkpoint-worker.js', import.meta.url)

const walSize = file => {
  try {
    return fs.statSync(`${file}-wal`).size
  } catch {
    return 0
  }
}

/**
 * db: the main connection (better-sqlite3), file: its path, key: the 32-byte key (copied into the worker; the caller
 * wipes its own). -> { ready (false, or { wiped }: the worker's key copy is zero), wait(), checkpoint(), stop(), stopNow(),
 * active() }
 */
export function startCheckpointer({ db, file, key, log = () => {}, workerUrl = WORKER_URL, everyMs = EVERY_MS, timerBytes = TIMER_BYTES, waitBytes = WAIT_BYTES, size = walSize }) {
  // the worker sets it to 1 once its connection is closed: the quit blocks on it (stopNow)
  const closedFlag = new Int32Array(new SharedArrayBuffer(4))
  let worker = new Worker(workerUrl, { workerData: { file, key, closed: closedFlag } })
  let active = false // the worker is ready and the main connection's autocheckpoint is off
  let seq = 0
  const pending = new Map() // id -> resolve
  let running = null // the checkpoint under way (one at a time)
  let timer = null
  let closing = false
  let onClosed = null
  let done = 0 // checkpoints the worker ran (tests, measurements)
  const stats = { partial: 0, busy: 0, maxLog: 0 }
  let holding = null // the gate's wait under way: the other writers hold back until it ends
  // the -wal size when a checkpoint last copied every frame: the file shrinks only at the next write (the WAL restarts,
  // journal_size_limit cuts it), so the same size again means nothing new to copy (without this the waiting refiner and
  // the gate asked for checkpoints of an already copied WAL for ever, measured)
  let copiedAt = -1
  const grown = limit => {
    const n = size(file)
    return n > limit && n !== copiedAt
  }
  let starting = true
  // the worker holds the process only while an answer is awaited (start, a checkpoint, the close); idle, it does not
  const hold = () => {
    if (!worker) return
    if (starting || closing || pending.size) worker.ref()
    else worker.unref()
  }

  const autocheckpoint = n => {
    try {
      if (db.open) db.pragma(`wal_autocheckpoint = ${n}`)
    } catch (err) {
      log(`db checkpoint worker: autocheckpoint not set (${err && err.code ? err.code : 'error'})`)
    }
  }
  // the worker failed or left: the main connection checkpoints itself again, at once
  const fallBack = code => {
    if (!worker) return
    const w = worker
    worker = null
    clearInterval(timer)
    timer = null
    const was = active
    active = false
    autocheckpoint(AUTOCHECKPOINT)
    if (!closing) log(`db checkpoint worker: ${code}, autocheckpoint back on`)
    for (const resolve of pending.values()) resolve(null)
    pending.clear()
    running = null
    if (onClosed) onClosed()
    w.terminate().catch(() => {})
    return was
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
      try {
        db.pragma(`journal_size_limit = ${JOURNAL_SIZE_LIMIT}`)
        db.pragma('wal_autocheckpoint = 0')
        active = true
      } catch (err) {
        fallBack(err && err.code ? err.code : 'error')
        return readyResolve(false)
      }
      timer = setInterval(() => {
        if (grown(timerBytes)) checkpoint()
      }, everyMs)
      if (timer.unref) timer.unref()
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
    if (!m.ok) {
      resolve(null)
      fallBack(m.code || 'checkpoint_failed')
      return
    }
    done++
    if (m.checkpointed >= m.log) copiedAt = size(file)
    if (m.checkpointed < m.log) stats.partial++
    if (m.busy) stats.busy++
    if (m.log > stats.maxLog) stats.maxLog = m.log
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

  /** one PASSIVE checkpoint on the worker (the one under way, if any); -> its result or null (no worker) */
  function checkpoint() {
    if (!active || !worker) return Promise.resolve(null)
    if (running) return running
    const id = ++seq
    running = new Promise(resolve => pending.set(id, resolve)).finally(() => (running = null))
    hold()
    worker.postMessage({ id, op: 'checkpoint' })
    return running
  }

  return {
    ready,
    active: () => active,
    checkpoints: () => done,
    stats: () => ({ done, ...stats }),
    checkpoint,
    /**
     * The sync between its slices: over WAIT_BYTES it waits (the main thread is free meanwhile) until a checkpoint
     * copied EVERY frame, at most WAIT_ROUNDS checkpoints: only then does the next write restart the WAL (and
     * journal_size_limit cut it back). Every sync waiting here pauses, so the other writers (the refiner, the user)
     * are small; with one pass a second account's writes kept every checkpoint partial (measured: the -wal grew to
     * 158 MB in the 2-account probe).
     */
    wait() {
      if (holding) return holding
      if (!active || !grown(waitBytes)) return Promise.resolve(null)
      holding = (async () => {
        let last = null
        for (let i = 0; i < WAIT_ROUNDS && active; i++) {
          last = await checkpoint()
          if (!last || last.checkpointed >= last.log) break
        }
        return last
      })().finally(() => (holding = null))
      return holding
    },
    /** the gate's wait under way (a promise), or null: a writer that can wait (the refiner) holds back until it ends,
     * so the checkpoint catches up and the next write restarts the WAL (measured: with the refiner writing on, every
     * checkpoint was whole and the WAL still grew to 69 MB on 6 500 rows) */
    holding: () => holding,
    /** before a write: the gate's wait under way, or one started now when the WAL is over WAIT_BYTES; null: write on.
     * Every writer that can wait asks this before EVERY write (a check only at the end of a sync chunk let the WAL
     * grow to 27 MB between two checks, measured) */
    gate() {
      if (holding) return holding
      if (!active || !grown(waitBytes)) return null
      return this.wait()
    },
    /** Lock: the worker closes its connection (after the checkpoint under way), then resolves; the main connection is
     * the caller's to close. At most CLOSE_WAIT_MS, then the worker is terminated. */
    stop() {
      closing = true
      clearInterval(timer)
      timer = null
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
        // the main connection checkpoints itself again from here (its close makes the last one)
        autocheckpoint(AUTOCHECKPOINT)
        active = false
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
    /** Tests and measurements: the worker dies as in a crash (its exit is the fallback's trigger). */
    kill() {
      if (worker) worker.terminate().catch(() => {})
    },
    /**
     * Quit: the worker's connection closes first, so the main close is the last one (its checkpoint empties the WAL and
     * removes the -wal and -shm); the quit cannot wait for an event, so the main thread blocks on the worker's signal,
     * at most CLOSE_WAIT_MS. Then the worker is terminated and the main connection checkpoints itself again.
     */
    stopNow() {
      closing = true
      if (worker) {
        clearInterval(timer)
        timer = null
        try {
          worker.postMessage({ op: 'close' })
          Atomics.wait(closedFlag, 0, 0, CLOSE_WAIT_MS)
        } catch (err) {
          log(`db checkpoint worker: quit wait failed (${err && err.code ? err.code : 'error'})`)
        }
      }
      fallBack('quit')
    },
  }
}
