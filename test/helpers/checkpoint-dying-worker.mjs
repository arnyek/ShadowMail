// A checkpoint worker that opens nothing, says ready, and leaves at the first checkpoint request (the main
// connection must take its checkpoints back at once).
import { parentPort, workerData } from 'node:worker_threads'

const raw = workerData.key
raw.fill(0)
parentPort.postMessage({ ready: true, wiped: true })
parentPort.on('message', m => {
  if (m && m.op === 'checkpoint') process.exit(3)
})
