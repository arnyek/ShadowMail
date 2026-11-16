// SPDX-License-Identifier: GPL-3.0-or-later
// The search text of a message is made on ONE worker
// thread, one message at a time: visibleTextInfo costs about 2 ms per KB of a CSS-heavy newsletter (0.2-0.6 s), which on
// the main thread would freeze the window during a sync or an open.
//
// The main thread reads and decrypts the source; the worker gets only a copy of the raw bytes (no key, no database, no
// log) and answers the text. The queue is bounded: at most `maxPendingBytes` raw bytes wait (16 MB); `admit(size)` waits
// for room (back-pressure: the sync / download waits, the memory does not grow). One message bigger than the bound goes
// alone. A message with a LOCAL source (POP3, sent, opened) waits as a loader only (no bytes, no
// back-pressure): the main thread reads and decrypts it when the worker takes it, so a download never waits for the
// worker. stop() (lock, quit) drops what waits, stops the worker, zeroes the copies and returns the dropped items' `meta`;
// a result that comes after it is thrown away. A worker error drops the message in work and restarts the worker ONCE;
// after a second error every message is dropped (null). Without a worker (`inline`: tests, core) the same text is made
// here (searchTextOf).
import { Worker } from 'node:worker_threads'
import { simpleParser } from 'mailparser'
import { searchTextOf, latePreviewOf, SEARCH_PARSE, LATE_PARSE } from './text.js'

export const MAX_PENDING_BYTES = 16 * 1024 * 1024
export const WORKER_URL = new URL('./search-text-worker.js', import.meta.url)

/**
 * What the worker makes, here (no worker): { text, preview }. text: 'body' = searchTextOf, 'message' = headers + body
 * (local-search). preview: only for an HTML over the main thread's cap (latePreviewOf), else null. No mailparser HTML ->
 * text conversion in the parse (SEARCH_PARSE; for a body LATE_PARSE, which over the cap makes the old-rule text with our
 * linear htmlToPlain): searchTextOf reads the HTML itself, and the conversion was the quadratic step.
 */
export async function searchResultHere(bytes, kind = 'body') {
  const p = await simpleParser(Buffer.from(bytes), kind === 'body' ? LATE_PARSE : SEARCH_PARSE)
  const body = searchTextOf(p)
  const text = kind === 'message' ? [p.subject, p.from && p.from.text, p.to && p.to.text, p.cc && p.cc.text, body].filter(Boolean).join('\n') : body
  return { text, preview: kind === 'body' ? latePreviewOf(p) : null }
}

/** The search text alone (searchResultHere's text). */
export async function searchTextHere(bytes, kind = 'body') {
  return (await searchResultHere(bytes, kind)).text
}

export class SearchTextService {
  /**
   * @param createWorker () => Worker (tests: a fake or a broken one); null with `inline` = no worker
   * @param inline       true: no worker, the text is made here (tests, core)
   * @param log          (line): only codes and counts
   */
  constructor({ maxPendingBytes = MAX_PENDING_BYTES, workerUrl = WORKER_URL, createWorker = null, inline = false, log = () => {} } = {}) {
    this.maxPendingBytes = maxPendingBytes
    this.createWorker = createWorker || (() => new Worker(workerUrl))
    this.inline = inline
    this.log = log
    this.queue = [] // { seq, kind, bytes: Uint8Array (own copy), size, meta, resolve }
    this.current = null
    this.pendingBytes = 0 // waiting raw bytes: queued, in work, and reserved by admit() for a compute() to come
    this.reserved = 0
    this.peakPendingBytes = 0
    this.waiters = [] // admit() calls waiting for room: { size, resolve }
    this.worker = null
    this.restarts = 0
    this.broken = false
    this.stopped = false
    this.seq = 0
    this.dropped = 0
  }

  /**
   * Waits until `size` more bytes fit (or nothing waits: a big message goes alone), and RESERVES them for the compute()
   * that follows (with several producers a room seen by one could be taken by another). Resolves false once
   * stopped. A reservation not used must be given back with release(size).
   */
  admit(size) {
    if (this.stopped || this.broken) return Promise.resolve(false)
    if (!this.waiters.length && this.#fits(size)) {
      this.#reserve(size)
      return Promise.resolve(true)
    }
    return new Promise(resolve => this.waiters.push({ size, resolve }))
  }

  /** A reservation of admit() that no compute() used (the caller stopped meanwhile). */
  release(size) {
    const n = Math.min(size, this.reserved)
    this.reserved -= n
    this.pendingBytes -= n
    this.#wake()
  }

  #reserve(size) {
    this.reserved += size
    this.pendingBytes += size
    if (this.pendingBytes > this.peakPendingBytes) this.peakPendingBytes = this.pendingBytes
  }

  #fits(size) {
    return this.pendingBytes === 0 || this.pendingBytes + size <= this.maxPendingBytes
  }

  #wake() {
    // in order; each one let through takes its room at once, so the next one sees it taken
    while (this.waiters.length && this.#fits(this.waiters[0].size)) {
      const w = this.waiters.shift()
      this.#reserve(w.size)
      w.resolve(true)
    }
  }

  /**
   * The search text of a message ->
   *   { text }            made;
   *   { failed: code }    not for THIS message (unparsable, e.g. EMAXLEN: over 1000 MIME parts; unreadable; it made the
   *                       worker fail): the caller goes on without it (the re-index must not stop there);
   *   null                dropped (stopped: lock / quit; the worker broken): the caller tries it another time.
   * `source`: its raw bytes (after admit(): back-pressure, the reservation is used), or an async loader () => bytes for
   * a local source (read when the worker takes it; no admit). `meta` comes back from stop() if dropped there.
   */
  compute(source, { kind = 'body', meta = null } = {}) {
    const load = typeof source === 'function' ? source : null
    if (this.stopped || this.broken) {
      if (!load) this.release(source.length)
      this.dropped++
      return Promise.resolve(null)
    }
    if (this.inline) {
      if (!load) this.release(source.length)
      return (async () => searchResultHere(load ? await load() : source, kind))().then(
        r => (this.stopped ? null : r),
        err => (this.stopped ? null : { failed: err && typeof err.code === 'string' ? err.code : 'parse_failed' }),
      )
    }
    let copy = null
    if (!load) {
      copy = new Uint8Array(source.length)
      copy.set(source)
    }
    return new Promise(resolve => {
      const item = { seq: ++this.seq, kind, bytes: copy, load, size: copy ? copy.length : 0, meta, resolve }
      this.queue.push(item)
      // admit()'s reservation becomes this item's room; without one (no admit) it is taken now
      const used = Math.min(item.size, this.reserved)
      this.reserved -= used
      this.pendingBytes += item.size - used
      if (this.pendingBytes > this.peakPendingBytes) this.peakPendingBytes = this.pendingBytes
      this.#next()
    })
  }

  #ensureWorker() {
    if (this.worker) return this.worker
    const w = this.createWorker()
    w.on('message', m => this.#done(w, m))
    w.on('error', err => this.#failed(w, err))
    w.on('exit', code => {
      if (code !== 0 && w === this.worker && !this.stopped) this.#failed(w, Object.assign(new Error('worker exit'), { code: `exit_${code}` }))
    })
    this.worker = w
    return w
  }

  #next() {
    if (this.current || !this.queue.length || this.stopped || this.broken) return
    const item = (this.current = this.queue.shift())
    if (item.load) {
      // a local source: read and decrypted now; the decrypted buffer is copied for the worker and zeroed here
      item.load().then(
        buf => {
          if (this.current !== item || this.stopped) {
            if (buf) buf.fill(0)
            return
          }
          const copy = new Uint8Array(buf.length)
          copy.set(buf)
          buf.fill(0)
          item.bytes = copy
          this.#post(item)
        },
        err => {
          if (this.current !== item) return
          this.current = null
          const code = err && typeof err.code === 'string' ? err.code : 'read_failed'
          this.log(`search text: source not read (${code})`)
          this.#finish(item, { failed: code })
          this.#next()
        },
      )
      return
    }
    this.#post(item)
  }

  #post(item) {
    const { seq, kind, bytes } = item
    // the copy goes to the worker (transferred: it leaves this thread)
    this.#ensureWorker().postMessage({ seq, kind, bytes }, [bytes.buffer])
  }

  #finish(item, result) {
    this.pendingBytes -= item.size
    if (!result || result.failed) this.dropped++
    item.resolve(result)
    this.#wake()
  }

  #done(w, m) {
    if (w !== this.worker || !this.current || m.seq !== this.current.seq) return
    const item = this.current
    this.current = null
    if (!m.ok) this.log(`search text: message skipped (${m.code})`)
    this.#finish(item, this.stopped ? null : m.ok ? { text: m.text, preview: m.preview ?? null } : { failed: m.code || 'parse_failed' })
    this.#next()
  }

  #failed(w, err) {
    if (w !== this.worker || this.stopped) return
    this.worker = null
    w.terminate().catch(() => {})
    const code = err && typeof err.code === 'string' ? err.code : 'worker_error'
    const item = this.current
    this.current = null
    // the message in work made the worker fail: that message is skipped (not tried forever), the others are not its fault
    if (item) this.#finish(item, { failed: code })
    if (this.restarts >= 1) {
      this.broken = true
      this.log(`search text: worker failed again (${code}), the search text stays as before`)
      for (const q of this.queue.splice(0)) this.#finish(q, null)
      for (const x of this.waiters.splice(0)) x.resolve(false)
      this.pendingBytes -= this.reserved
      this.reserved = 0
      return
    }
    this.restarts++
    this.log(`search text: worker failed (${code}), restarted`)
    this.#next()
  }

  /**
   * Lock / quit: every waiting and running message is dropped (null), the worker stops, the copies are zeroed; no
   * result is given out after this. Returns the dropped messages' `meta` (the caller marks their accounts for a re-index).
   */
  stop() {
    if (this.stopped) return []
    this.stopped = true
    const items = [...(this.current ? [this.current] : []), ...this.queue.splice(0)]
    this.current = null
    for (const it of items) {
      if (it.bytes && it.bytes.buffer.byteLength) it.bytes.fill(0)
      this.#finish(it, null)
    }
    for (const x of this.waiters.splice(0)) x.resolve(false)
    this.pendingBytes -= this.reserved
    this.reserved = 0
    if (this.worker) this.worker.terminate().catch(() => {})
    this.worker = null
    return items.map(it => it.meta).filter(Boolean)
  }
}
