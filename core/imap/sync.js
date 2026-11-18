// SPDX-License-Identifier: GPL-3.0-or-later
// Incremental IMAP sync of one account into the index.
// Derived from an earlier internal tool by the same author. Differences:
//  - one instance per account; the account row, the password provider and the client factory are
//    injected (no global config, no environment variables);
//  - METADATA comes for every message (UID SEARCH ALL instead of a SINCE window), the TEXT only
//    for messages inside the account's body_index_days limit; older rows get body_state 3;
//  - no prune: rows and headers always stay; the common applyBodyLimit reconciler (core/db/body-limit.js)
//    runs first on every sync: lowering the limit and aging take the text out unless the message is
//    pinned, raising it re-queues rows (3 -> 0) for the body phase;
//  - deletions on the server are detected for the whole folder;
//  - the list preview is stored together with the indexed text.
import { createImapClient, listSyncFolders, serverSpecialUse } from './client.js'
import { shownFolders, subscriptionsKnown } from './folders.js'
import { assignRoles, resolveRoles } from './folders.js'
import { RECIPIENT_ROLES } from '../mime/recipient-label.js'
import { analyzeStructure, extractReferences, fmtAddr, fmtAddrs } from '../mime/envelope.js'
import { bodyFromSource } from '../mime/text.js'
import { hasBrokenHeader, headerColumns } from '../mime/message.js'
import { BODY_STATE } from '../db/mail-index.js'
import { applyBodyLimit, bodyCutoff, withinBodyLimit } from '../db/body-limit.js'
import { classifyError } from '../accounts/probe.js'

export { bodyCutoff }
const META_CHUNK = 200
const BODY_CHUNK = 25
export const BODY_FETCH_BYTES = 256 * 1024
// The raw header fields a broken envelope is decoded from anew (raw 8-bit, not UTF-8: imapflow reads them as UTF-8 and
// gives U+FFFD); content-type gives the charset (raw-headers.js).
export const HEADER_REPAIR_FIELDS = Object.freeze(['subject', 'from', 'to', 'cc', 'content-type'])

const chunks = (arr, n) => {
  const out = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}

// Loop instead of Math.min(...arr)/Math.max(...arr): spreading a large mailbox's UIDs throws RangeError.
export function minOf(values) {
  let min = Infinity
  for (const v of values) if (v < min) min = v
  return min
}

export function maxOf(values, floor = -Infinity) {
  let max = floor
  for (const v of values) if (v > max) max = v
  return max
}

/** A tagged NO/BAD from the server (imapflow throws with responseStatus), not a dropped connection. */
export const isServerRefusal = err => Boolean(err) && (err.responseStatus === 'NO' || err.responseStatus === 'BAD')

export const isConnectionLoss = err =>
  (err && err.code === 'NoConnection') ||
  /connection not available|connection closed|ECONNRESET|EPIPE|socket/i.test((err && err.message) || '')

// Retry after a failed run (network down, server refusing connections), then the account's interval.
export const RETRY_DELAYS_MS = Object.freeze([15_000, 30_000, 60_000, 120_000, 300_000])

/** Errors after which the app must not try again on its own: a wrong password repeated on a timer
 * gets the IP banned (measured on a test server). The user saves the account or presses Refresh. */
export const isFatalSyncError = code => code === 'auth_failed' || code === 'no_password'

class SyncStopped extends Error {
  constructor() {
    super('sync stopped')
    this.code = 'SYNC_STOPPED'
  }
}

const unionOpts = (a, b) => {
  if (!a) return { ...b }
  const folders = a.folders && b.folders ? [...new Set([...a.folders, ...b.folders])] : undefined
  return { full: Boolean(a.full || b.full), folders }
}

export class Syncer {
  /**
   * @param {object} opts
   * @param {object} opts.account      accounts row (id, in_*, tls_verify, body_index_days, sync_interval_min)
   * @param {() => object|undefined} [opts.loadAccount]  fresh row before every run (settings may change); undefined = deleted
   * @param {MailIndex} opts.index
   * @param {(account) => Promise<string>} [opts.getPassword]  needed by the default connect
   * @param {() => Promise<object>} [opts.connect]  returns a connected imapflow-compatible client
   * @param {(change: {accountId, folders: string[]}) => void} [opts.onChange]  the list of a folder changed
   * @param {(state) => void} [opts.onState]  phase, progress or error changed
   * @param {() => number} [opts.now]
   */
  constructor({
    account,
    loadAccount = null,
    index,
    getPassword,
    connect,
    onChange = () => {},
    onState = () => {},
    now = () => Date.now(),
    bodyFetchBytes = BODY_FETCH_BYTES,
    folderOptions = { skipJunkTrash: false },
    retryDelaysMs = RETRY_DELAYS_MS,
    sealed = null,
    searchText = null,
  }) {
    this.sealed = sealed // SealedStore of data/store: a message gone from the server takes its file
    // { refine({ id, accountId, local, source }) } -> resolves once the worker queue took it (back-pressure);
    // null: the visible text is made here
    this.searchText = searchText
    this.account = account
    this.loadAccount = loadAccount
    this.index = index
    this.now = now
    this.onChange = onChange
    this.onState = onState
    this.bodyFetchBytes = bodyFetchBytes
    this.folderOptions = folderOptions
    this.retryDelaysMs = retryDelaysMs
    this.connect =
      connect ||
      (async () => {
        if (!getPassword) throw new Error('getPassword is required without a custom connect')
        const client = createImapClient(this.account, await getPassword(this.account))
        await client.connect()
        return client
      })
    this.bccFillDone = new Set() // folders whose rows with an unknown Bcc were filled in this instance (fillUnknownBcc)
    this.headerRepairDone = new Set() // folders whose stored rows were checked for broken headers in this instance
    this.current = null
    this.queued = null
    this.queuedPromise = null
    this.timer = null
    this.started = false
    this.stopped = false
    this.failures = 0
    this.state = {
      running: false,
      phase: 'idle',
      folder: null,
      progress: null, // { done, total }
      lastError: null,
      errorCode: null,
      lastFinished: null,
      runsEnded: 0, // MCP sync_account: every run that ended, well or not; a waiter compares it
      lastDurationMs: null,
      lastAdded: 0,
      lastRemoved: 0,
      lastCleared: 0,
      lastRequeued: 0,
    }
  }

  _emitState() {
    try {
      this.onState({ ...this.state })
    } catch {
      // a listener must not break the sync
    }
  }

  _setState(patch) {
    Object.assign(this.state, patch)
    this._emitState()
  }

  _changed(folders) {
    if (!folders.length) return
    try {
      this.onChange({ accountId: this.account.id, folders })
    } catch {
      // see _emitState
    }
  }

  /** Background schedule: a first run right away, then the account's interval; retries back off. */
  start() {
    this.started = true
    this.stopped = false
    this._schedule(0)
  }

  stop() {
    this.stopped = true
    this.started = false
    this.queued = null // a request waiting behind the running one must not log in after a stop
    clearTimeout(this.timer)
    this.timer = null
  }

  _schedule(ms) {
    clearTimeout(this.timer)
    if (!this.started || this.stopped) return
    this.timer = setTimeout(() => this.request().catch(() => {}), ms)
    if (this.timer.unref) this.timer.unref()
  }

  _intervalMs() {
    return Math.max(1, Number(this.account.sync_interval_min) || 5) * 60_000
  }

  /**
   * Asks for a run. While one is running, the request is queued (requests merge: any full one wins,
   * folder lists are united) and runs right after, so a change seen mid-run is never lost.
   * opts.folders: only these folders (e.g. ['INBOX'] after IDLE), no folder list, no clean-up.
   */
  request(opts = {}) {
    if (!this.current) return this.run(opts)
    this.queued = unionOpts(this.queued, opts)
    if (!this.queuedPromise) {
      this.queuedPromise = this.current
        .then(() => null, err => err)
        .then(prev => {
          const next = this.queued
          this.queued = null
          this.queuedPromise = null
          // Login safety (a repeated wrong password gets the IP banned): after a stop, or a run that ended with a rejected
          // login, the queued request does NOT connect again; only the user (Refresh, saving the account)
          // starts a new attempt.
          if (this.stopped || !next) throw new SyncStopped()
          if (prev && isFatalSyncError(this.state.errorCode)) throw prev
          return this.run(next)
        })
    }
    return this.queuedPromise
  }

  /** Returns the running promise when a run is already in progress. */
  run(opts = {}) {
    if (!this.current) {
      this.current = this._run(opts)
        .then(
          result => {
            this.failures = 0
            if (this.started && !this.queued) this._schedule(this._intervalMs())
            return result
          },
          err => {
            this.failures++
            if (this.started && !this.queued && err.code !== 'SYNC_STOPPED') {
              if (isFatalSyncError(this.state.errorCode)) clearTimeout(this.timer)
              else this._schedule(Math.min(this.retryDelaysMs[Math.min(this.failures, this.retryDelaysMs.length) - 1], this._intervalMs()))
            }
            throw err
          },
        )
        .finally(() => {
          this.current = null
          this.state.runsEnded++
        })
    }
    return this.current
  }

  _checkStopped() {
    if (this.stopped) throw new SyncStopped()
  }

  async _run({ full = false, folders: only } = {}) {
    this._checkStopped() // before connecting: a stopped syncer never logs in
    const t0 = Date.now()
    const st = this.state
    if (this.loadAccount) {
      const fresh = this.loadAccount()
      if (!fresh) throw new SyncStopped() // the account was deleted
      this.account = fresh
    }
    const accountId = this.account.id
    Object.assign(st, { running: true, phase: 'connecting', lastAdded: 0, lastRemoved: 0, lastCleared: 0, lastRequeued: 0 })
    this._emitState()
    const connect = async () => {
      const c = await this.connect()
      c.on('error', err => {
        st.lastError = err.message
      })
      return c
    }
    const ctx = { client: null, reconnect: connect }
    try {
      const nowMs = this.now()
      const cutoff = bodyCutoff(this.account, nowMs)
      const limit = applyBodyLimit(this.index, this.account, nowMs)
      st.lastCleared = limit.cleared
      st.lastRequeued = limit.requeued
      const client = (ctx.client = await connect())
      this._checkStopped()
      let folders
      if (only) {
        // a targeted run (IDLE): the folders we already know, no LIST and no clean-up of the others
        folders = only
          .map(path => this.index.getFolder(accountId, path))
          .filter(Boolean)
          .map(f => ({ path: f.path, delimiter: f.delimiter, specialUse: f.special_use }))
      } else {
        // only the server's own SPECIAL-USE flag is stored (special_use), never imapflow's guess from the name
        const listed = (await listSyncFolders(client, this.folderOptions)).map(f => ({ ...f, specialUse: serverSpecialUse(f) }))
        // only the subscribed folders (and the kept and role ones) show and sync; the rows from before the upgrade get
        // their kept flag now, so nothing that showed disappears (migration 12). Only when the LIST tells the subscriptions:
        // with LSUB refused imapflow says "subscribed" of every folder, and deciding then would drop the unsubscribed
        // ones at the next, successful LIST; undecided rows wait for a run that knows
        if (subscriptionsKnown(listed)) this.index.settleKept(accountId, listed)
        const roles = new Set([...this.index.folderRoles(accountId).keys(), ...this.index.manualRoles(accountId).keys()])
        folders = shownFolders(listed, { kept: this.index.keptFolders(accountId), roles })
      }
      const folderErrors = []
      for (const f of folders) {
        this._checkStopped()
        this._setState({ phase: 'metadata', folder: f.path, progress: null })
        try {
          if (await this.syncFolder(client, f, cutoff, full)) this._changed([f.path])
        } catch (err) {
          if (isConnectionLoss(err)) throw err
          // A folder the server refuses (NO/BAD) is skipped untouched; the others still sync.
          folderErrors.push(`${f.path}: ${err.message}`)
        }
      }
      if (!only) {
        const before = new Set(this.index.folders(accountId).filter(f => !f.is_local).map(f => f.path))
        this.index.dropFoldersExcept(accountId, folders.map(f => f.path))
        const dropped = [...before].filter(p => !folders.some(f => f.path === p))
        if (dropped.length) this._changed(dropped)
        await this.updateRoles(client, folders)
      }
      this._checkStopped()
      this._setState({ phase: 'bodies', folder: null, progress: null })
      await this.syncBodies(ctx)
      // connection drops handled on the way no longer count as errors; skipped folders do
      Object.assign(st, {
        lastFinished: new Date(this.now()).toISOString(),
        lastError: folderErrors.length ? folderErrors.join('; ') : null,
        errorCode: folderErrors.length ? 'folder' : null,
      })
    } catch (err) {
      if (err.code !== 'SYNC_STOPPED') {
        st.lastError = err.message
        st.errorCode = err.code === 'NO_PASSWORD' ? 'no_password' : classifyError(err)
      }
      throw err
    } finally {
      Object.assign(st, { running: false, phase: 'idle', folder: null, progress: null, lastDurationMs: Date.now() - t0 })
      this._emitState()
      if (ctx.client) await ctx.client.logout().catch(() => ctx.client.close())
    }
  }

  /**
   * The folder roles after a LIST (resolveRoles): the stored ones stay, a contested role (two folders with a usual name)
   * goes to the one with more messages on the server (STATUS MESSAGES of the candidates only). Stored in folders.role;
   * a change is reported like a folder change, so the tree is drawn again.
   */
  async updateRoles(client, folders) {
    const accountId = this.account.id
    const previous = this.index.folderRoles(accountId)
    const manual = this.index.manualRoles(accountId)
    let { roles, needCounts } = resolveRoles(folders, { previous, manual })
    if (needCounts.length) {
      const counts = new Map()
      for (const path of needCounts) {
        this._checkStopped()
        try {
          const st = await client.status(path, { messages: true })
          counts.set(path, Number.isFinite(st?.messages) ? st.messages : null)
        } catch (err) {
          if (isConnectionLoss(err)) throw err
          counts.set(path, null) // a refused STATUS: the folder only loses the count, the other rules still apply
        }
      }
      roles = resolveRoles(folders, { previous, counts, manual }).roles
    }
    const changed = [...new Set([...previous.keys(), ...roles.keys()])].filter(p => previous.get(p) !== roles.get(p))
    if (!changed.length) return
    this.index.setFolderRoles(accountId, roles)
    this._changed(changed)
  }

  /** Syncs one folder. Returns true when its message list changed (new, gone or changed flags). */
  async syncFolder(client, f, cutoff, full) {
    const accountId = this.account.id
    let changed = false
    // readOnly = EXAMINE: the sync never sets \Seen.
    const lock = await client.getMailboxLock(f.path, { readOnly: true })
    try {
      const mb = client.mailbox
      const uidvalidity = String(mb.uidValidity)
      let saved = this.index.getFolder(accountId, f.path)
      // Only a real UIDVALIDITY change (or an explicit full sync) throws the local rows away. A folder
      // seen for the first time gets its row (with UIDVALIDITY) BEFORE the first batch, so a first sync
      // cut off half-way is continued by the next run instead of starting over (on a
      // shaky line a big mailbox would never finish and the list would shrink). highest_modseq stays empty until
      // the folder is complete: the next run then checks every flag.
      if (saved && (full || saved.uidvalidity !== uidvalidity)) {
        changed = true
        // the messages go, the row stays: the folder is still there, and its local manual order (sort_order) with it;
        // the upsert below writes every sync field anew (a renamed folder often gets a new UIDVALIDITY)
        this.index.clearFolderMessages(accountId, f.path)
        saved = null
      }
      const isNew = !saved
      if (isNew) {
        this.index.upsertFolder({ account_id: accountId, path: f.path, delimiter: f.delimiter || null, special_use: f.specialUse || null, uidvalidity, last_uid: 0, highest_modseq: null, synced_at: null })
      }

      // imapflow resolves search() with false when the server answers NO/BAD. Taking that (or an
      // empty answer for a non-empty mailbox) as "no messages" would delete the whole local folder,
      // pinned messages included, so it is an error and the folder is left as it is.
      let onServer = []
      if (mb.exists) {
        const found = await client.search({ all: true }, { uid: true })
        if (!Array.isArray(found)) throw new Error('UID SEARCH refused by the server')
        if (found.length === 0) throw new Error(`UID SEARCH returned nothing for a mailbox with ${mb.exists} messages`)
        onServer = found
      }
      const serverSet = new Set(onServer)
      const local = this.index.localUids(accountId, f.path)
      const localSet = new Set(local.map(r => r.uid))

      // deleted or moved away on the server (whole folder, there is no window any more)
      const gone = local.filter(r => !serverSet.has(r.uid)).map(r => r.id)
      if (gone.length) {
        const files = this.sealed ? gone.map(id => (this.index.get(id) || {}).store_path).filter(Boolean) : []
        this.index.deleteIds(gone)
        for (const rel of files) {
          try {
            this.sealed.remove(rel)
          } catch {
            // a path outside the store or a held file: the row is gone, the file stays
          }
        }
        this.state.lastRemoved += gone.length
        changed = true
      }

      // new messages, newest first
      const fresh = onServer.filter(u => !localSet.has(u)).sort((a, b) => b - a)
      let done = 0
      for (const part of chunks(fresh, META_CHUNK)) {
        this._checkStopped()
        const rows = []
        for await (const msg of client.fetch(
          part,
          { uid: true, envelope: true, flags: true, internalDate: true, size: true, bodyStructure: true, headers: ['references'] },
          { uid: true },
        )) {
          rows.push(this.toRow(f.path, msg, cutoff))
        }
        await this.repairNewHeaders(client, rows)
        const added = this.index.insertMany(rows)
        this.state.lastAdded += added
        if (added) {
          changed = true
          // the list fills in while a big folder is still coming
          this._changed([f.path])
        }
        done += part.length
        this._setState({ progress: { done, total: fresh.length } })
      }

      // Sent / Drafts rows stored before 0.15.1 without To and Cc: their Bcc from the server's envelope (the recipient
      // column's fallback), once per folder and instance; only these rows, one FETCH of their envelopes
      if (!this.bccFillDone.has(f.path) && RECIPIENT_ROLES.has(assignRoles(this.index.folderList(accountId)).get(f.path))) {
        this.bccFillDone.add(f.path)
        if (await this.fillUnknownBcc(client, accountId, f.path, serverSet)) changed = true
      }

      // rows stored before 0.15.1 with a raw 8-bit header read as UTF-8: decoded anew from the server's header fields, once
      // per folder and instance (the check reads the folder's rows)
      if (!this.headerRepairDone.has(f.path)) {
        this.headerRepairDone.add(f.path)
        if (await this.repairStoredHeaders(client, f.path, serverSet)) changed = true
      }

      // flag changes (read, starred) on messages we already had
      const known = local.filter(r => serverSet.has(r.uid))
      if (known.length) {
        const useModseq = saved && saved.highest_modseq && mb.highestModseq
        const minUid = minOf(known.map(r => r.uid)) // no spread: 100 000+ UIDs overflow the call stack
        const opts = { uid: true }
        if (useModseq) opts.changedSince = BigInt(saved.highest_modseq)
        const flagsByUid = new Map(known.map(r => [r.uid, r.flags]))
        const updates = []
        for await (const msg of client.fetch(`${minUid}:*`, { uid: true, flags: true }, opts)) {
          if (!flagsByUid.has(msg.uid)) continue
          const flags = [...(msg.flags || [])].join(' ')
          if (flags !== flagsByUid.get(msg.uid)) updates.push({ uid: msg.uid, flags })
        }
        if (updates.length) {
          this.index.setFlagsMany(accountId, f.path, updates)
          changed = true
        }
      }

      this.index.upsertFolder({
        account_id: accountId,
        path: f.path,
        delimiter: f.delimiter || null,
        special_use: f.specialUse || null,
        uidvalidity,
        last_uid: maxOf(onServer, 0),
        highest_modseq: mb.highestModseq ? String(mb.highestModseq) : null,
        synced_at: this.now(),
      })
      if (isNew) changed = true // a new folder: the tree must show it
    } finally {
      lock.release()
    }
    return changed
  }

  /** The folder's rows with an unknown Bcc and no To / Cc get it from the server's envelope. -> any row changed? */
  async fillUnknownBcc(client, accountId, folder, serverSet) {
    const rows = this.index.bccUnknownRows(accountId, folder).filter(r => serverSet.has(r.uid))
    if (!rows.length) return false
    const idOf = new Map(rows.map(r => [r.uid, r.id]))
    const items = []
    for (const part of chunks(rows.map(r => r.uid), META_CHUNK)) {
      this._checkStopped()
      for await (const msg of client.fetch(part, { uid: true, envelope: true }, { uid: true })) {
        if (!idOf.has(msg.uid) || !msg.envelope) continue
        items.push({ id: idOf.get(msg.uid), bcc: fmtAddrs(msg.envelope.bcc) })
      }
    }
    return this.index.setBccMany(items) > 0 && items.some(i => i.bcc)
  }

  /** uid -> header columns of the given UIDs, from their raw header fields (one FETCH); a UID the server lacks is left out. */
  async fetchHeaderColumns(client, uids) {
    const out = new Map()
    for (const part of chunks(uids, META_CHUNK)) {
      this._checkStopped()
      for await (const msg of client.fetch(part, { uid: true, headers: [...HEADER_REPAIR_FIELDS] }, { uid: true })) {
        if (!msg.headers || !msg.headers.length) continue
        try {
          out.set(msg.uid, await headerColumns(msg.headers))
        } catch {
          // an unreadable header block: the row keeps what the envelope gave
        }
      }
    }
    return out
  }

  /** New rows whose envelope holds U+FFFD get their header columns from the raw fields (before they are inserted). */
  async repairNewHeaders(client, rows) {
    const broken = rows.filter(hasBrokenHeader)
    if (!broken.length) return
    const cols = await this.fetchHeaderColumns(client, broken.map(r => r.uid))
    for (const r of broken) {
      const c = cols.get(r.uid)
      if (!c) continue
      Object.assign(r, { subject: c.subject, from_name: c.from_name, to_addrs: c.to_addrs, cc_addrs: c.cc_addrs, sender_text: c.sender_text, recipients_text: c.recipients_text })
    }
  }

  /** Stored rows of the folder with a U+FFFD header column: decoded anew from the server. -> any row changed? */
  async repairStoredHeaders(client, folder, serverSet) {
    const rows = this.index.brokenHeaderRows(this.account.id, { folder }).filter(r => serverSet.has(r.uid))
    if (!rows.length) return false
    const cols = await this.fetchHeaderColumns(client, rows.map(r => r.uid))
    let n = 0
    for (const r of rows) {
      const c = cols.get(r.uid)
      if (c && !hasBrokenHeader(c) && this.index.setHeaders(r.id, c)) n++
    }
    return n > 0
  }

  toRow(folder, msg, cutoff) {
    const env = msg.envelope || {}
    const from = env.from && env.from[0]
    const { attachments } = analyzeStructure(msg.bodyStructure)
    const date = env.date ? new Date(env.date).getTime() : null
    const idate = msg.internalDate ? new Date(msg.internalDate).getTime() : date
    const to = fmtAddrs(env.to)
    const cc = fmtAddrs(env.cc)
    const bcc = fmtAddrs(env.bcc)
    const withinLimit = withinBodyLimit(idate, cutoff)
    return {
      account_id: this.account.id,
      folder,
      uid: msg.uid,
      message_id: env.messageId || null,
      in_reply_to: env.inReplyTo || null,
      refs: extractReferences(msg.headers),
      from_addr: (from && from.address) || null,
      from_name: (from && from.name) || null,
      to_addrs: to,
      cc_addrs: cc,
      bcc_addrs: bcc,
      subject: env.subject || '',
      date: Number.isFinite(date) ? date : idate,
      idate,
      flags: [...(msg.flags || [])].join(' '),
      size: msg.size || 0,
      has_attachments: attachments.some(a => !a.inline) ? 1 : 0,
      attachments: attachments.length ? JSON.stringify(attachments) : null,
      body_state: withinLimit ? BODY_STATE.PENDING : BODY_STATE.BEYOND_LIMIT,
      sender_text: fmtAddr(from),
      recipients_text: [to, cc].filter(Boolean).join(', '),
    }
  }

  /** ctx.client may be replaced: when the server drops the connection we reconnect. */
  async syncBodies(ctx) {
    const accountId = this.account.id
    const total = this.index.pendingCount(accountId)
    let done = 0
    while (true) {
      const batch = this.index.pendingBodies(accountId, 500)
      if (!batch.length) break
      const byFolder = new Map()
      for (const r of batch) {
        if (!byFolder.has(r.folder)) byFolder.set(r.folder, [])
        byFolder.get(r.folder).push(r)
      }
      for (const [folder, rows] of byFolder) {
        for (const part of chunks(rows, BODY_CHUNK)) {
          let results
          try {
            results = await this.fetchBodies(ctx, folder, part)
          } catch (err) {
            const lost = isConnectionLoss(err)
            if (!lost && !isServerRefusal(err)) throw err
            // Some servers drop the connection on a broken message (Dovecot), others answer NO for it
            // (Gmail: "Some messages could not be FETCHed"). Retry one by one, mark the
            // culprit as failed and go on, so one message cannot stall the account's text index.
            results = []
            let bad = 0
            for (const r of part) {
              try {
                results.push(...(await this.fetchBodies(ctx, folder, [r])))
              } catch (err2) {
                if (isConnectionLoss(err2)) {
                  // many "broken" messages means the server is the problem: do not mark them
                  if (++bad > 3) throw err2
                } else if (isServerRefusal(err2)) {
                  bad++
                } else throw err2
                results.push({ id: r.id, text: '', preview: null, state: BODY_STATE.FAILED })
              }
            }
            // the server refused EVERY message of the chunk: its problem (busy, folder gone), not theirs
            if (!lost && part.length > 1 && bad === part.length) throw err
          }
          this._checkStopped()
          this.index.setBodies(results)
          await this.refineSearchText(results, accountId, false)
          done += part.length
          this._setState({ progress: { done, total } })
        }
      }
    }
  }

  /** the indexed rows' sources to the worker thread; waits while its queue is full (back-pressure). */
  async refineSearchText(results, accountId, local) {
    if (!this.searchText) return
    // one call: the refiner registers the whole batch before it waits (a lock in between loses none of them unseen)
    // a stored source goes by its path (only the id waits), the rest by its bytes
    const items = results
      .filter(r => r.source || r.storePath)
      .map(r => (r.storePath ? { id: r.id, accountId, local, storePath: r.storePath } : { id: r.id, accountId, local, source: r.source }))
    for (const r of results) r.source = null
    if (items.length) await this.searchText.refineMany(items)
  }

  async fetchBodies(ctx, folder, part) {
    if (!ctx.client.usable) ctx.client = await ctx.reconnect()
    const client = ctx.client
    const lock = await client.getMailboxLock(folder, { readOnly: true })
    const raw = []
    try {
      for await (const msg of client.fetch(
        part.map(r => r.uid),
        { uid: true, source: { start: 0, maxLength: this.bodyFetchBytes } },
        { uid: true },
      )) {
        raw.push(msg)
      }
    } finally {
      lock.release()
    }
    // Parse after the fetch: no other IMAP command may run inside the fetch loop.
    const idByUid = new Map(part.map(r => [r.uid, r.id]))
    const results = []
    for (const msg of raw) {
      if (!idByUid.has(msg.uid)) continue
      const body = await bodyFromSource(msg.source, { oldText: Boolean(this.searchText) })
      results.push({ id: idByUid.get(msg.uid), ...body, source: this.searchText && body.state === BODY_STATE.INDEXED ? msg.source : null })
      idByUid.delete(msg.uid)
    }
    // not returned by the server (deleted meanwhile): do not retry forever
    for (const id of idByUid.values()) results.push({ id, text: '', preview: null, state: BODY_STATE.FAILED })
    return results
  }
}
