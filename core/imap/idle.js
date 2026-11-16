// SPDX-License-Identifier: GPL-3.0-or-later
// IDLE on one folder (the INBOX) over its own connection (sync, IDLE and actions use
// separate connections). The folder is opened with EXAMINE (read-only), so nothing gets \Seen here;
// imapflow enters IDLE by itself on a selected, quiet connection. Any EXISTS / EXPUNGE / FETCH
// (flags) notification asks the Syncer for a targeted run of that folder.
//
// The connection comes back on its own after a drop, with a growing delay. A rejected login is
// fatal: no retry on a timer (a repeated wrong password gets the IP banned, measured).
import { classifyError } from '../accounts/probe.js'

export const IDLE_RETRY_DELAYS_MS = Object.freeze([5_000, 15_000, 30_000, 60_000, 120_000])
export const IDLE_DEBOUNCE_MS = 400
// the retry delay starts over only after a connection that lived this long
export const IDLE_STABLE_MS = 60_000

export class IdleWatcher {
  /**
   * @param {object} opts
   * @param {() => Promise<object>} opts.connect   returns a connected imapflow-compatible client
   * @param {string} [opts.path]
   * @param {(path) => void} opts.onChange        something changed in the folder (debounced)
   * @param {() => void} [opts.onReconnect]       connected again after a drop: catch up
   * @param {(code, err) => void} [opts.onError]  connection error (code from classifyError)
   * @param {(code, err) => void} [opts.onFatal]  login rejected: the watcher stopped itself
   */
  constructor({ connect, path = 'INBOX', onChange, onReconnect = () => {}, onError = () => {}, onFatal = () => {}, retryDelaysMs = IDLE_RETRY_DELAYS_MS, debounceMs = IDLE_DEBOUNCE_MS, stableMs = IDLE_STABLE_MS, now = () => Date.now() }) {
    this.connectFn = connect
    this.path = path
    this.onChange = onChange
    this.onReconnect = onReconnect
    this.onError = onError
    this.onFatal = onFatal
    this.retryDelaysMs = retryDelaysMs
    this.debounceMs = debounceMs
    this.stableMs = stableMs
    this.now = now
    this.gen = 0 // every start()/stop() starts a new generation; a connect of an older one is dropped
    this.client = null
    this.running = false
    this.attempt = 0
    this.everConnected = false
    this.retryTimer = null
    this.debounceTimer = null
  }

  get connected() {
    return Boolean(this.client && this.client.usable)
  }

  start() {
    if (this.running) return
    this.running = true
    this.gen++
    this.attempt = 0
    this._open()
  }

  async stop() {
    this.running = false
    this.gen++
    clearTimeout(this.retryTimer)
    clearTimeout(this.debounceTimer)
    const c = this.client
    this.client = null
    if (c) await c.logout().catch(() => c.close())
  }

  _notify() {
    clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      if (this.running) this.onChange(this.path)
    }, this.debounceMs)
  }

  _retry() {
    if (!this.running) return
    const delay = this.retryDelaysMs[Math.min(this.attempt, this.retryDelaysMs.length - 1)]
    this.attempt++
    clearTimeout(this.retryTimer)
    const gen = this.gen
    this.retryTimer = setTimeout(() => gen === this.gen && this._open(), delay)
    if (this.retryTimer.unref) this.retryTimer.unref()
  }

  async _open() {
    if (!this.running) return
    const gen = this.gen
    // stopped, or stopped and started again while this connect was on its way: this client is not
    // ours any more (it would stay connected as an orphan next to the new one)
    const stale = () => !this.running || gen !== this.gen
    let client
    try {
      client = await this.connectFn()
      if (stale()) {
        await client.logout().catch(() => client.close())
        return
      }
      client.on('exists', () => this._notify())
      client.on('expunge', () => this._notify())
      client.on('flags', () => this._notify())
      client.on('error', err => this.onError(classifyError(err), err))
      let openedAt = null
      client.on('close', () => {
        if (this.client !== client) return
        this.client = null
        if (this.running) {
          // only a connection that lived a while resets the delay; one dropped right after opening
          // (virus scanner proxy, NAT, server limit) keeps it growing, no 5-second login storm
          if (openedAt !== null && this.now() - openedAt >= this.stableMs) this.attempt = 0
          this.onError('connection_lost', null)
          this._retry()
        }
      })
      this.client = client
      // readOnly = EXAMINE: IDLE must never mark anything as read
      await client.mailboxOpen(this.path, { readOnly: true })
      if (stale()) {
        if (this.client === client) this.client = null
        await client.logout().catch(() => client.close())
        return
      }
      openedAt = this.now()
      const again = this.everConnected
      this.everConnected = true
      if (again) this.onReconnect()
    } catch (err) {
      const code = classifyError(err)
      if (client) {
        if (this.client === client) this.client = null
        client.close?.()
      }
      if (code === 'auth_failed') {
        this.running = false
        this.onFatal(code, err)
        return
      }
      this.onError(code, err)
      this._retry()
    }
  }
}
