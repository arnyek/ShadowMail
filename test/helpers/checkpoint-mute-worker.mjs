// A checkpoint worker that opens nothing, says ready, and never answers anything, the close included (the quit must
// not wait on it for longer than its limit).
import { parentPort, workerData } from 'node:worker_threads'

workerData.key.fill(0)
parentPort.postMessage({ ready: true, wiped: true })
parentPort.on('message', () => {})
