// SPDX-License-Identifier: GPL-3.0-or-later
// The session's search-text work around the worker
// thread (core/mime/search-text-service.js), Electron-free.
//
// Refiner: a new, opened or sent message's row is in the index at once with the OLD rule's text (the search works as
// before); its raw bytes go to the worker, whose visible text replaces the FTS body (MailIndex.setSearchBody: only while
// the row is still indexed). A batch is registered synchronously before anything waits, so on stop() (lock, quit) every
// local-source message that did not get its text is known: its account's re-index flag is cleared (the re-index makes it
// up after the next unlock). An IMAP row without a local source keeps the old text until it is opened.
//
// Re-index: once per account (settings `fts_visible_v1:<account id>` = 'done'), the indexed rows with a local source
// (POP3, opened and sent messages), newest first, one at a time through the worker; only the FTS body changes (not
// body_state; the preview only of a row that has none: an HTML over the main thread's cap whose worker item was dropped). The flag holds the cursor ({ date, id }) of the last row written, so a lock or a quit loses
// nothing: the next unlock goes on from there. The main thread's share per row is the read, the decryption and one write.
//
// Quiet retry: a message whose visible text came out 'complex' (no body: over the work ceiling or the CPU-time net) is
// tried ONCE more, later, when the worker has nothing else to do; one busy moment should not leave it unsearchable for
// good. Only a message with a stored source (storePath: a path, no bytes held), at most MAX_RETRIES waiting, each id once
// per session; it lives in memory only (a lock or a quit drops it, the account's flag stays as it is).
// Write-back: the worker's results wait in a queue; a drainer writes WRITE_BATCH of them in ONE transaction (at once,
// on setImmediate, when that many wait; otherwise WRITE_WAIT_MS after the first one, with what has come), then yields,
// so the main thread never holds a long run of FTS writes (one autocommit per message cost twice the time, and every
// commit is a new FTS segment to merge). The results come one by one from the worker: without the wait every batch
// was one message (measured: 31 944 transactions for 32 000). A message counts as written (leaves `open`) only after
// its transaction ran: stop() drops the queue and clears the flag of every local account that had one waiting.
export const WRITE_BATCH = 10
export const WRITE_WAIT_MS = 100
export const FLAG = id => `fts_visible_v1:${id}`
export const FLAG_DONE = 'done'
export const RETRY_DELAY_MS = 5 * 60_000
export const MAX_RETRIES = 1000

export function createSearchRefiner({ service, index, settings, sealed = null, log = () => {}, retryDelayMs = RETRY_DELAY_MS, maxRetries = MAX_RETRIES, walGate = null }) {
  let alive = true
  const open = new Map() // token -> meta of a registered message whose text is not written yet
  let token = 0
  const later = new Map() // id -> item: a complex message waiting for its one retry
  const tried = new Set() // ids queued for a retry this session (never twice)
  let timer = null
  const queue = [] // { t, item, r, retry }: results waiting for their write
  let drainer = null // setImmediate: a full batch waits
  let waiter = null // setTimeout: a partial batch waits for more
  const inTx = typeof index.inTransaction === 'function' ? fn => index.inTransaction(fn) : fn => fn()
  const plan = () => {
    if (!alive || !queue.length) return
    if (queue.length >= WRITE_BATCH) {
      clearTimeout(waiter)
      waiter = null
      if (!drainer) drainer = setImmediate(drain)
    } else if (!drainer && !waiter) {
      waiter = setTimeout(drain, WRITE_WAIT_MS)
      if (waiter.unref) waiter.unref()
    }
  }
  const drain = () => {
    drainer = null
    clearTimeout(waiter)
    waiter = null
    if (!alive) return
    // a WAL checkpoint the sync waits for (core/db/checkpoint.js): no write until it ends, so it can catch up
    const hold = walGate && walGate.gate && walGate.gate()
    if (hold) {
      hold.then(() => plan(), () => plan())
      return
    }
    const batch = queue.splice(0, WRITE_BATCH)
    try {
      inTx(() => {
        for (const { item, r } of batch) {
          try {
            index.setSearchBody(item.id, r.text)
            // an HTML over the main thread's cap: its preview comes from here (the row has none until then)
            if (r.preview !== null && r.preview !== undefined) index.setLatePreview(item.id, r.preview)
          } catch (err) {
            log(`search text: not written (${err && err.code ? err.code : 'error'})`)
          }
        }
      })
    } catch (err) {
      log(`search text: not written (${err && err.code ? err.code : 'error'})`)
    }
    for (const { t, item, r, retry } of batch) {
      open.delete(t)
      if (r.complex && !retry) retryLater(item)
    }
    plan()
  }
  const enqueue = entry => {
    queue.push(entry)
    plan()
  }
  const schedule = () => {
    if (timer || !alive || !later.size) return
    timer = setTimeout(retry, retryDelayMs)
    if (timer.unref) timer.unref()
  }
  const retry = async () => {
    timer = null
    if (!alive) return
    // only a quiet worker: a sync or a re-index in work goes first, the retry waits another round
    if (!service.idle()) return schedule()
    const items = [...later.values()]
    later.clear()
    log(`search text: ${items.length} complex message(s) tried again`)
    for (const item of items) {
      if (!alive) return
      await one(++token, item, true)
    }
  }
  /** A complex message (id, accountId, storePath) for its one quiet retry; false when it is not taken. */
  const retryLater = item => {
    if (!alive || !item.storePath || !sealed || tried.has(item.id) || later.size >= maxRetries) return false
    tried.add(item.id)
    later.set(item.id, { id: item.id, accountId: item.accountId, local: true, storePath: item.storePath })
    schedule()
    return true
  }
  const lost = accountId => {
    try {
      settings.set(FLAG(accountId), '')
    } catch (err) {
      log(`search text: re-index flag not cleared (${err && err.code ? err.code : 'error'})`)
    }
  }
  // one message: resolves when it is in the worker queue (or dropped); its text is written later. retry: a quiet retry
  // (not registered in `open`: dropping it does not send its account to a full re-index)
  const one = (t, item, retry = false) => {
    let admitted
    const queued = new Promise(r => (admitted = r))
    ;(async () => {
      try {
        if (!alive) return
        // a stored source: only its id waits; read and decrypted when the worker takes it
        const byPath = item.storePath && sealed
        if (!byPath) {
          const ok = await service.admit(item.source.length)
          if (ok && !alive) service.release(item.source.length)
          if (!ok || !alive) return
        }
        // compute() queues synchronously: the caller goes on only after this message counts in the bound
        const pending = service.compute(byPath ? () => sealed.readAsync(item.storePath) : item.source, { meta: { accountId: item.accountId, local: item.local } })
        admitted()
        const r = await pending
        if (!alive) return
        // written in a batch: it stays in `open` until its transaction ran (a lock before that clears its flag)
        if (r && !r.failed) return enqueue({ t, item, r, retry })
        open.delete(t)
        if (!r && item.local && !retry) lost(item.accountId)
        // r.failed: not for this message (the service logged its code); its row keeps the old text, nothing to redo
      } finally {
        admitted()
      }
    })()
    return queued
  }
  return {
    /**
     * [{ id, accountId, local, source | storePath }]: registered now (synchronously). With `source` (the raw bytes of an
     * IMAP message without a local copy) each waits for room in the worker queue (back-pressure); with `storePath` (a
     * stored source) only its id is queued, nothing waits. Resolves when every one of them is queued.
     */
    async refineMany(items) {
      // after stop() (a sync still finishing its batch): the old text stays, a local message's account is re-indexed
      if (!alive) {
        for (const id of new Set(items.filter(i => i.local).map(i => i.accountId))) lost(id)
        return
      }
      const tokens = items.map(item => {
        const t = ++token
        open.set(t, { accountId: item.accountId, local: item.local })
        return [t, item]
      })
      if (!alive) return
      for (const [t, item] of tokens) {
        if (!alive) return
        await one(t, item) // the admission (back-pressure), not the text
      }
    },
    refine(item) {
      return this.refineMany([item])
    },
    retryLater,
    /** Results waiting for their write (tests, measurements). */
    writesPending() {
      return queue.length
    },
    /** Waiting for their quiet retry (tests, measurements). */
    retrying() {
      return [...later.keys()]
    },
    /** Lock / quit: the worker stops, nothing is written after this; a lost local message clears its account's flag. */
    stop() {
      alive = false
      clearTimeout(timer)
      timer = null
      clearImmediate(drainer)
      drainer = null
      clearTimeout(waiter)
      waiter = null
      queue.length = 0 // nothing is written after this; their messages are still in `open`
      later.clear()
      service.stop()
      const accounts = new Set([...open.values()].filter(m => m.local).map(m => m.accountId))
      open.clear()
      for (const id of accounts) lost(id)
      return [...accounts]
    },
  }
}

const parseCursor = v => {
  try {
    const c = JSON.parse(v)
    return c && Number.isFinite(c.date) && Number.isInteger(c.id) ? c : null
  } catch {
    return null
  }
}

/**
 * The one-time re-index of the local-source rows. run() goes over every account whose flag is not 'done'; stop() ends
 * it after the row in work (its text is dropped, the cursor stays before it). onRow(ms) reports the main thread's
 * share of each row (read + decrypt + write), for the measurements. onComplex({ id, accountId, storePath }): a row whose
 * text came out complex (main.js hands it to the refiner's retryLater).
 */
export function createFtsReindex({ index, store, sealed, settings, service, log = () => {}, batch = 20, onRow = () => {}, onComplex = () => {} }) {
  let stopped = false
  let running = null
  const runAccount = async accountId => {
    const key = FLAG(accountId)
    let state = settings.get(key)
    if (state === FLAG_DONE) return 0
    let cursor = state ? parseCursor(state) : null
    let written = 0
    for (;;) {
      if (stopped) return written
      const rows = index.localSourceRows(accountId, cursor, batch)
      if (!rows.length) {
        settings.set(key, FLAG_DONE)
        log(`search re-index: account ${accountId} done (${written} rows)`)
        return written
      }
      for (const row of rows) {
        if (stopped) return written
        let t0 = performance.now()
        let source = null
        try {
          source = await sealed.readAsync(row.store_path)
        } catch {
          // a damaged or missing file: its row keeps its text
        }
        let ms = performance.now() - t0
        if (source) {
          if (!(await service.admit(source.length))) return written
          if (stopped) {
            service.release(source.length)
            return written
          }
          const r = await service.compute(source, { meta: { accountId, local: true } })
          if (!r || stopped) return written // dropped (lock, a broken worker): the cursor stays before this row
          if (!r.failed) {
            t0 = performance.now()
            index.setSearchBody(row.id, r.text) // only while the row is still indexed
            // an HTML over the main thread's cap whose refiner item was dropped (a lock): its preview comes from here too
            // (setLatePreview writes only a row without one, so a row indexed before keeps its preview)
            if (r.preview !== null && r.preview !== undefined) index.setLatePreview(row.id, r.preview)
            // too complex this time: the refiner's quiet retry (the cursor goes on)
            if (r.complex) onComplex({ id: row.id, accountId, storePath: row.store_path })
            written++
            ms += performance.now() - t0
          }
          // r.failed (e.g. EMAXLEN): this row keeps its old text, the cursor goes past it, like a
          // damaged file; the service logged the code
        }
        cursor = { date: row.date, id: row.id }
        settings.set(key, JSON.stringify(cursor))
        onRow(ms)
      }
    }
  }
  return {
    /** Every account in turn; resolves when all are done or stopped. */
    run() {
      if (running) return running
      running = (async () => {
        let total = 0
        for (const a of store.list()) {
          if (stopped) break
          try {
            total += await runAccount(a.id)
          } catch (err) {
            log(`search re-index: account ${a.id} failed (${err && err.code ? err.code : 'error'})`)
          }
        }
        return total
      })().finally(() => (running = null))
      return running
    },
    stop() {
      stopped = true
    },
  }
}
