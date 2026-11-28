// SPDX-License-Identifier: GPL-3.0-or-later
// Background sync of every IMAP account while the vault is unlocked: one Syncer (folder list,
// metadata, texts; on the account's interval) and one IdleWatcher on the INBOX per account.
// No Electron import: the tests drive it with fake clients.
//
// Login safety (a repeated wrong password gets the IP banned): the IDLE connection starts only
// after the first successful sync, and a rejected login stops both until the user saves the account
// or presses Refresh. Other errors (network down, refused connection) are retried with back-off.
import { Syncer, isFatalSyncError, isConnectionLoss } from '../../core/imap/sync.js'
import { IdleWatcher } from '../../core/imap/idle.js'
import { createImapClient, ImapConnection } from '../../core/imap/client.js'
import { classifyError } from '../../core/accounts/probe.js'
import { Pop3Client } from '../../core/pop3/client.js'
import { Pop3Fetcher } from '../../core/pop3/fetcher.js'
import { errCode } from '../../core/log-safe.js'
import { uploadLocalLabels } from '../../core/imap/label-upload.js'
import { BodyGate } from '../../core/imap/body-gate.js'
import { createLoopWatch } from './loop-watch.js'

export const STATUS_THROTTLE_MS = 250
export const IDLE_MAX_MS = 5 * 60_000 // re-issue IDLE before servers drop a quiet connection
// a targeted (IDLE) run writes its log line only when it was slow: over this, or with a main-thread gap over 100 ms
export const TARGETED_LOG_MS = 1000

/**
 * One sync run's diagnostic line (main.log), numbers and codes only: no folder name, address, server or user. The
 * keys and their order are fixed (the line is read after a release to see what a startup costs on real data); `reader`
 * came last: worker = every folder's reads on the read worker (core/db/sync-read.js), main = at least one on the main
 * thread, - = POP3 (no folder reads).
 */
export function syncLogLine(s) {
  const condstore = s.kind === 'pop3' || s.condstore === null ? '-' : s.condstore ? 'yes' : 'no'
  const n = v => (Number.isFinite(v) ? Math.round(v) : 0)
  return `sync account=${n(s.accountId)} kind=${s.kind} condstore=${condstore} folders=${n(s.folders)} flags=${n(s.flags)} new=${n(s.added)} bodies=${n(s.bodies)} ms=${n(s.ms)} list_ms=${n(s.listMs)} meta_ms=${n(s.metaMs)} bodies_ms=${n(s.bodiesMs)} loop_max=${n(s.loopMax)} loop_over100=${n(s.loopOver100)} result=${/^[a-z_]+$/.test(s.result) ? s.result : 'error'} reader=${s.kind !== 'pop3' && (s.reader === 'worker' || s.reader === 'main') ? s.reader : '-'}`
}

/** a targeted run only when it was slow (TARGETED_LOG_MS) or blocked the main thread over 100 ms; the others always */
export function logsRun(s) {
  return s.kind !== 'targeted' || s.ms > TARGETED_LOG_MS || s.loopOver100 > 0
}

/** Error of an interactive action (open, message actions); `code` is a stable, translatable key. */
export class ActionError extends Error {
  constructor(code, cause) {
    super(`${code}${cause && cause.message ? `: ${cause.message}` : ''}`)
    this.code = code
  }
}

// POP3 has no IDLE: the account is polled on its interval. Stands in for the IdleWatcher.
const NO_IDLE = Object.freeze({ connected: false, running: false, start() {}, async stop() {} })

function noPassword() {
  const err = new Error('no stored password for the account')
  err.code = 'NO_PASSWORD'
  return err
}

export class SyncManager {
  /**
   * @param store    AccountStore (getRow, list, passwordsFor)
   * @param index    MailIndex
   * @param notify   (payload) => void: { kind: 'sync', accounts } and { kind: 'mail', changes }
   * @param connect  (accountRow, { idle }) => Promise<connected client>; default: imapflow with the stored password
   */
  constructor({ store, index, notify = () => {}, log = () => {}, connect = null, connectPop3 = null, sealed = null, now = () => Date.now(), throttleMs = STATUS_THROTTLE_MS, syncerOptions = {}, idleOptions = {}, searchText = null, labels = null, onRunEnd = null }) {
    // every run's summary after its log line (the new-mail notice decides there); its error never reaches the sync
    this.onRunEnd = onRunEnd
    this.labels = labels // Labels: an IMAP account's local labels go to its server after the first full run (label-upload.js)
    this.searchText = searchText // the worker thread's refiner, or null (the visible text made in the syncer)
    this.store = store
    this.index = index
    this.notify = notify
    this.log = log
    this.now = now
    this.throttleMs = throttleMs
    // one account's body phase at a time (core/imap/body-gate.js); the tests may give their own in syncerOptions
    this.bodyGate = new BodyGate()
    // the main thread's gaps during the runs, for their log lines (app/main/loop-watch.js): on only while a run is
    this.loopWatch = createLoopWatch()
    this.syncerOptions = { bodyGate: this.bodyGate, loopWatch: this.loopWatch, ...syncerOptions }
    this.idleOptions = idleOptions
    this.connect = connect || ((account, opts) => this.#connectImap(account, opts))
    this.connectPop3 = connectPop3 || (account => this.#connectPop3(account))
    this.sealed = sealed // SealedStore of data/store, the POP3 fetchers write and read through it
    this.entries = new Map()
    this.active = false
    this.flushTimer = null
    this.pendingStatus = false
    this.pendingChanges = new Map()
  }

  async #connectImap(account, { idle = false } = {}) {
    const { incoming } = this.store.passwordsFor(account.id)
    if (!incoming) throw noPassword()
    const client = createImapClient(account, incoming, idle ? { maxIdleTime: IDLE_MAX_MS } : {})
    await client.connect()
    return client
  }

  // POP3: connected and logged in. One login per run; a rejected one stops the account (isFatalSyncError).
  async #connectPop3(account) {
    const { incoming } = this.store.passwordsFor(account.id)
    if (!incoming) throw noPassword()
    // an LF lost at a chunk boundary (a piece ending in CR, the next not starting with LF), anywhere in an
    // answer, is put back by the client (splitChunk); each one is logged here, without content
    const client = new Pop3Client({ host: account.in_host, port: account.in_port, security: account.in_security, tlsVerify: account.tls_verify !== 0, onBareCr: () => this.log(`account ${account.id}: pop3_bare_cr`) })
    try {
      await client.connect()
      await client.login(account.in_user, incoming)
    } catch (err) {
      client.close()
      throw err
    }
    return client
  }

  /** Vault unlocked: start every account (IMAP: sync + IDLE, POP3: download on the interval). */
  startAll() {
    this.active = true
    for (const account of this.store.list()) this.#startAccount(account.id)
    this.#queueStatus()
  }

  /** Vault locked (or quitting): stop everything, close the connections. */
  async stopAll() {
    this.active = false
    const ids = [...this.entries.keys()]
    await Promise.all(ids.map(id => this.#stopAccount(id)))
    this.loopWatch.stop()
    this.#queueStatus()
  }

  #logRun(summary) {
    if (logsRun(summary)) this.log(syncLogLine(summary))
    if (this.onRunEnd) {
      try {
        this.onRunEnd(summary)
      } catch {
        // a listener's error never fails the sync
      }
    }
  }

  /** Settings changed (or a new account): restart it with the fresh row. */
  async accountSaved(id) {
    if (!this.active) return
    await this.#stopAccount(id)
    this.#startAccount(id)
    this.#queueStatus()
  }

  async accountRemoved(id) {
    await this.#stopAccount(id)
    this.#queueStatus()
  }

  /**
   * Refresh button: a full run now; also the way back after a rejected login. id = null: every account.
   * restart (MCP, an approved restart of a stopped login): ONE run logs in; the stop stays in
   * force for every other connection (interactive, IDLE, MCP test_account) until that run has ended, so one approval
   * is at most one login attempt. A refused login keeps the account stopped; a success or another error lifts it.
   */
  syncNow(id = null, { restart = false } = {}) {
    if (!this.active) return
    const ids = id === null ? [...this.entries.keys()] : [id]
    for (const accountId of ids) {
      const entry = this.entries.get(accountId)
      if (!entry) {
        this.#startAccount(accountId)
        continue
      }
      if (restart && entry.fatal) {
        entry.restarting = true
        entry.restartRan = false
      } else {
        entry.fatal = false
      }
      entry.syncer.start() // re-arms the timer if a fatal error had stopped it; queues behind a running run
    }
    this.#queueStatus()
  }

  status() {
    return [...this.entries.values()].map(e => this.#statusOf(e))
  }

  /**
   * Runs fn(client) on the account's interactive connection (the third one next to sync and IDLE),
   * so opening a message does not wait for the background sync. Login safety: while
   * the account is stopped by a rejected login no connection is attempted at all, and a rejected
   * login here stops the sync and IDLE too. Errors come as ActionError with a translatable code.
   */
  async withConnection(accountId, fn) {
    if (!this.active) throw new ActionError('locked')
    const entry = this.entries.get(accountId)
    if (!entry) throw new ActionError('no_account')
    if (entry.fatal) throw new ActionError('sync_stopped')
    if (entry.idle === NO_IDLE) throw new ActionError('pop3_local') // POP3 messages live here, nothing to do on a server
    if (!entry.interactive) {
      entry.interactive = new ImapConnection(() => this.connect(entry.syncer.account, { idle: false }), {
        onError: err => this.log(`account ${accountId}: interactive connection lost (${errCode(err)}), reconnecting on the next use`),
      })
    }
    let client
    try {
      client = await entry.interactive.get()
    } catch (err) {
      const code = err && err.code === 'NO_PASSWORD' ? 'no_password' : classifyError(err)
      if (isFatalSyncError(code)) {
        this.log(`account ${accountId}: login rejected on the interactive connection (${code}), sync stopped until the user acts`)
        entry.fatal = true
        entry.fatalCode = code
        entry.syncer.stop()
        entry.idle.stop().catch(() => {})
        this.#queueStatus()
      }
      throw new ActionError(code, err)
    }
    try {
      return await fn(client)
    } catch (err) {
      if (err instanceof ActionError) throw err
      // core/imap/actions.js codes, and a command imapflow rejected with NO/BAD (it throws for CREATE/RENAME/DELETE)
      if (err && ['server_refused', 'folder_exists', 'uidvalidity_changed'].includes(err.code)) throw new ActionError(err.code, err)
      if (err && (err.responseStatus === 'NO' || err.responseStatus === 'BAD')) throw new ActionError('server_refused', err)
      throw new ActionError(isConnectionLoss(err) ? 'connection_lost' : classifyError(err), err)
    }
  }

  /** A targeted run of some folders (a moved message without a UID map comes back through the target's sync). */
  requestSync(accountId, folders) {
    const entry = this.entries.get(accountId)
    if (entry && !entry.fatal) entry.syncer.request({ folders }).catch(() => {})
  }

  /** A change made outside the sync (e.g. \\Seen on open): the list and the counts refresh. */
  notifyChange(change) {
    this.#queueChange(change)
  }

  #statusOf(e) {
    const s = e.syncer.state
    return {
      accountId: e.accountId,
      name: e.name,
      running: s.running,
      phase: s.phase,
      gateWait: Boolean(s.gateWait), // in the body phase, waiting for another account's batch (core/imap/body-gate.js)
      folder: s.folder,
      progress: s.progress,
      requeued: s.lastRequeued, // texts put back in the queue by a raised limit: "Újraindexelés"
      errorCode: e.fatalCode || s.errorCode,
      lastFinished: s.lastFinished,
      runsEnded: s.runsEnded,
      gen: e.gen,
      busy: Boolean(e.syncer.current), // a run going on in any phase (its logout too): MCP sync_account counts on it
      live: e.idle.connected,
      idleError: e.idle.connected ? null : e.idleError,
      stopped: e.fatal,
      restarting: Boolean(e.restarting), // M3B: an approved restart's one run is on its way
    }
  }

  #startAccount(id) {
    const row = this.store.getRow(id)
    if (!row || this.entries.has(id)) return
    // gen: a new number for every start of an account (a re-save too): MCP sync_account tells a restart by it
    const entry = { accountId: id, gen: (this.genSeq = (this.genSeq || 0) + 1), name: row.name, fatal: false, fatalCode: null, idleError: null, idleStarted: false, seenFinished: null }
    if (row.type === 'pop3') {
      if (!this.sealed) return // POP3 needs data/store
      entry.syncer = new Pop3Fetcher({
        account: row,
        loadAccount: () => this.store.getRow(id),
        index: this.index,
        sealed: this.sealed,
        connect: () => this.connectPop3(entry.syncer.account),
        now: this.now,
        onChange: change => this.#queueChange(change),
        onState: state => this.#onSyncState(entry, state),
        onRunEnd: summary => this.#logRun(summary),
        searchText: this.searchText,
        ...this.syncerOptions,
      })
      entry.idle = NO_IDLE
      this.entries.set(id, entry)
      entry.syncer.start()
      return
    }
    if (row.type !== 'imap') return
    entry.syncer = new Syncer({
      account: row,
      loadAccount: () => this.store.getRow(id),
      index: this.index,
      sealed: this.sealed,
      connect: () => this.connect(entry.syncer.account, { idle: false }),
      now: this.now,
      onChange: change => this.#queueChange(change),
      onState: state => this.#onSyncState(entry, state),
      onRunEnd: summary => this.#logRun(summary),
      searchText: this.searchText,
      uploadLabels: this.labels ? client => uploadLocalLabels({ labels: this.labels, client, accountId: id, log: this.log }) : null,
      ...this.syncerOptions,
    })
    entry.idle = new IdleWatcher({
      connect: () => this.connect(entry.syncer.account, { idle: true }),
      // an IDLE event or reconnect that arrives after a rejected login stopped the account
      // must not start a login, as requestSync does not
      onChange: path => !entry.fatal && entry.syncer.request({ folders: [path] }).catch(() => {}),
      onReconnect: () => {
        entry.idleError = null
        if (!entry.fatal) entry.syncer.request().catch(() => {}) // back online: catch up everything
        this.#queueStatus()
      },
      onError: code => {
        entry.idleError = code
        this.#queueStatus()
      },
      onFatal: code => {
        this.log(`account ${id}: IDLE login rejected (${code}), sync stopped until the user acts`)
        entry.fatal = true
        entry.fatalCode = code
        entry.syncer.stop()
        this.#queueStatus()
      },
      ...this.idleOptions,
    })
    this.entries.set(id, entry)
    entry.syncer.start()
  }

  async #stopAccount(id) {
    const entry = this.entries.get(id)
    if (!entry) return
    this.entries.delete(id)
    entry.syncer.stop()
    // the old run must be gone before a new one starts: a POP3 server keeps the mailbox locked for the
    // old session and answers the new login with [IN-USE]; at most 10 s
    const running = entry.syncer.current
    const waitRun = running ? Promise.race([running.catch(() => {}), new Promise(r => setTimeout(r, 10_000).unref?.())]) : null
    await Promise.all([entry.idle.stop(), entry.interactive ? entry.interactive.close() : null, waitRun])
  }

  #onSyncState(entry, state) {
    if (!state.running && state.lastFinished && state.lastFinished !== entry.seenFinished) {
      // a run finished successfully
      entry.seenFinished = state.lastFinished
      entry.fatal = false
      entry.fatalCode = null
      if (this.entries.get(entry.accountId) === entry && !entry.idle.running) entry.idle.start()
    } else if (!state.running && isFatalSyncError(state.errorCode)) {
      if (!entry.fatal) this.log(`account ${entry.accountId}: sync stopped (${state.errorCode}) until the user acts`)
      entry.fatal = true
      entry.idle.stop().catch(() => {})
    }
    // the restart's one run ended: refused again -> it stays stopped (above); any other end lifts the stop, as a Refresh
    // (the Syncer counts runsEnded after its last state event, so the end is seen as running -> not running)
    if (entry.restarting && state.running) entry.restartRan = true
    else if (entry.restarting && entry.restartRan && !state.running) {
      entry.restarting = false
      if (!isFatalSyncError(state.errorCode)) entry.fatal = false
    }
    this.#queueStatus()
  }

  #queueChange({ accountId, folders }) {
    if (!this.pendingChanges.has(accountId)) this.pendingChanges.set(accountId, new Set())
    for (const f of folders) this.pendingChanges.get(accountId).add(f)
    this.#arm()
  }

  #queueStatus() {
    this.pendingStatus = true
    this.#arm()
  }

  // One timer for both kinds: at most one status and one change event per throttle window.
  #arm() {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => this.flush(), this.throttleMs)
    if (this.flushTimer.unref) this.flushTimer.unref()
  }

  flush() {
    clearTimeout(this.flushTimer)
    this.flushTimer = null
    if (this.pendingChanges.size) {
      const changes = [...this.pendingChanges].map(([accountId, set]) => ({ accountId, folders: [...set] }))
      this.pendingChanges.clear()
      this.notify({ kind: 'mail', changes })
    }
    if (this.pendingStatus) {
      this.pendingStatus = false
      this.notify({ kind: 'sync', accounts: this.status() })
    }
  }
}
