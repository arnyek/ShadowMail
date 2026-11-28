// A sync read worker whose diff keeps its thread busy for BUSY_MS (as a long read on a cold, big database does: the
// close waits behind it) and then answers "nothing stored". Opens nothing; wipes its key copy; the close sets the flag.
import { parentPort, workerData } from 'node:worker_threads'

const BUSY_MS = 3000
workerData.key.fill(0)
parentPort.postMessage({ ready: true, wiped: true })
parentPort.on('message', m => {
  if (!m) return
  if (m.op === 'close') {
    Atomics.store(workerData.closed, 0, 1)
    Atomics.notify(workerData.closed, 0)
    parentPort.postMessage({ closed: true })
    parentPort.close()
    return
  }
  if (m.op !== 'diff') return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, BUSY_MS)
  const fresh = Uint32Array.from(m.server).sort().reverse()
  parentPort.postMessage({ id: m.id, ok: true, snap: 1, gone: [], fresh, minKnown: Infinity, knownCount: 0, ranges: [], changes: 0 }, [fresh.buffer])
})
