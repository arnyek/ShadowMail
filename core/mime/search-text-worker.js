// SPDX-License-Identifier: GPL-3.0-or-later
// The worker thread of search-text-service.js. It gets
// the raw bytes of one message at a time (never a key, a database or a log) and answers its search text: the visible
// text (searchTextOf), or for the POP3 old-text search the headers and that text (messageText); and, for an HTML over the
// main thread's cap, the preview the main thread left out (latePreviewOf). Nothing else.
import { parentPort } from 'node:worker_threads'
import { searchResultHere } from './search-text-service.js'

parentPort.on('message', async ({ seq, kind, bytes }) => {
  try {
    const { text, preview } = await searchResultHere(bytes, kind)
    parentPort.postMessage({ seq, ok: true, text, preview })
  } catch (err) {
    parentPort.postMessage({ seq, ok: false, code: err && typeof err.code === 'string' ? err.code : 'parse_failed' })
  }
})
