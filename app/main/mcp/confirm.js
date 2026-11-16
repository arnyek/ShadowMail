// SPDX-License-Identifier: GPL-3.0-or-later
// MCP: the user's confirmation of Claude's dangerous requests (send, delete for good,
// delete a folder or an account, change an account, restart a stopped account's login).
//
// A request holds WHAT will run: the tool, the view the Modal shows, and the payload, whose canonical JSON is
// hashed (SHA-256) when the request is made. On approval the main process runs the STORED payload, after hashing
// it again: a request changed after it was shown never runs (hash_mismatch). Nothing coming back from the renderer
// is run, only its yes or no. At most MAX_PENDING requests wait at once; a call waits WAIT_MS for the decision, then
// answers pending_confirmation (confirmation_status tells the rest); a request expires after EXPIRE_MS; lock, quit
// and switching the access off reject every waiting request. No message content is logged.
import crypto from 'node:crypto'

export const MAX_PENDING = 5
export const WAIT_MS = 60_000
export const EXPIRE_MS = 10 * 60_000
// a decided request keeps only its status (for confirmation_status), and only the newest ones
export const MAX_SETTLED = 200

/** JSON with sorted keys at every level: the same content always hashes the same. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`
  return JSON.stringify(value === undefined ? null : value)
}
const sha256 = text => crypto.createHash('sha256').update(text).digest('hex')

export class ConfirmationError extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}

export class ConfirmationQueue {
  /**
   * @param onRequest (view) => void: a new request for the Modal (the main window comes forward)
   * @param onSettled (view) => void: a request decided, expired or failed (the Modal goes)
   */
  constructor({ now = () => Date.now(), onRequest = () => {}, onSettled = () => {}, log = () => {} } = {}) {
    this.now = now
    this.onRequest = onRequest
    this.onSettled = onSettled
    this.log = log
  }

  #items = new Map()

  /** The Modal's data of one request: never the payload's hash or the execute function. */
  #view(item) {
    return { id: item.id, tool: item.tool, view: item.view, status: item.status, count: item.count, createdAt: item.createdAt }
  }

  #expire() {
    for (const item of this.#items.values()) {
      if (item.status === 'pending' && this.now() - item.createdAt >= EXPIRE_MS) this.#settle(item, 'expired')
    }
  }

  #settle(item, status, { result = null, error = null, message = null } = {}) {
    item.status = status
    item.result = result
    item.error = error
    item.message = message
    item.settledAt = this.now()
    if (item.timer) clearTimeout(item.timer)
    // the request's own resources (e.g. a compose session holding a forward's attachments) go with its decision
    try {
      item.dispose()
    } catch (err) {
      this.log(`mcp confirm tool=${item.tool} dispose failed`)
    }
    this.log(`mcp confirm tool=${item.tool} result=${status}${error ? ` error=${error}` : ''} items=${item.count}`)
    for (const resolve of item.waiters.splice(0)) resolve(this.status(item.id))
    this.onSettled(this.#view(item))
    // what it would have run is not needed any more: the payload (a message, an account form), the view, the closures
    item.payload = null
    item.view = null
    item.execute = null
    item.dispose = () => {}
    const settled = [...this.#items.values()].filter(x => x.settledAt !== undefined)
    for (const old of settled.slice(0, Math.max(0, settled.length - MAX_SETTLED))) this.#items.delete(old.id)
  }

  /** The waiting requests, oldest first (the Modal shows them one after the other). */
  pending() {
    this.#expire()
    return [...this.#items.values()].filter(x => x.status === 'pending').map(x => this.#view(x))
  }

  /**
   * A new request -> its id. `key` makes a request unique while it waits (the restart of one account): a second
   * call with the same key gets the waiting request's id, no second Modal.
   */
  create({ tool, view, payload, execute, key = null, count = 1, dispose = () => {} }) {
    this.#expire()
    if (key !== null) {
      const same = [...this.#items.values()].find(x => x.key === key && x.status === 'pending')
      if (same) return same.id
    }
    if ([...this.#items.values()].filter(x => x.status === 'pending').length >= MAX_PENDING) throw new ConfirmationError('too_many_pending')
    const id = crypto.randomUUID()
    const item = { id, tool, view, payload, hash: sha256(canonicalJson(payload)), execute, dispose, key, count, status: 'pending', createdAt: this.now(), waiters: [], result: null, error: null }
    this.#items.set(id, item)
    // the expiry also comes on its own: the Modal and the taskbar flash go when it lapses
    item.timer = setTimeout(() => this.#expire(), EXPIRE_MS + 100)
    if (item.timer.unref) item.timer.unref()
    this.log(`mcp confirm tool=${tool} result=requested items=${count}`)
    this.onRequest(this.#view(item))
    return id
  }

  /** For the tests and the main process only: the stored request. */
  get(id) {
    return this.#items.get(id) || null
  }

  /** The user said yes: the stored payload runs, if it is still the one they saw. */
  async approve(id) {
    this.#expire()
    const item = this.#items.get(id)
    if (!item) throw new ConfirmationError('not_found')
    if (item.status !== 'pending') return this.status(id)
    if (sha256(canonicalJson(item.payload)) !== item.hash) {
      this.#settle(item, 'failed', { error: 'hash_mismatch' })
      return this.status(id)
    }
    item.status = 'running'
    try {
      const result = await item.execute(item.payload)
      this.#settle(item, 'approved', { result })
    } catch (err) {
      // the code, and our own user text if the error has one (ToolError): never a server's or a message's words
      this.#settle(item, 'failed', { error: err && typeof err.code === 'string' ? err.code : 'internal', message: err && typeof err.userMessage === 'string' ? err.userMessage : null })
    }
    return this.status(id)
  }

  /** The user said no (or the lock, the quit, the switch). */
  reject(id, reason = 'rejected') {
    const item = this.#items.get(id)
    if (!item) throw new ConfirmationError('not_found')
    // a lock / quit / switch-off rejects too, with its reason (e.g. 'locked') as the error
    if (item.status === 'pending') this.#settle(item, 'rejected', { error: reason === 'rejected' ? null : reason })
    return this.status(id)
  }

  rejectAll(reason) {
    for (const item of this.#items.values()) if (item.status === 'pending') this.reject(item.id, reason)
  }

  /** pending / running / approved (+ result) / rejected / expired / failed (+ error); not_found for an unknown id. */
  status(id) {
    this.#expire()
    const item = this.#items.get(id)
    if (!item) return { id, status: 'not_found' }
    const out = { id, status: item.status }
    if (item.status === 'approved') out.result = item.result
    if (item.error) out.error = item.error
    if (item.message) out.message = item.message
    return out
  }

  /** The decision, or after `ms` { status: 'pending_confirmation', id }. */
  wait(id, ms = WAIT_MS) {
    const now = this.status(id)
    if (now.status !== 'pending' && now.status !== 'running') return Promise.resolve(now)
    const item = this.#items.get(id)
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        item.waiters = item.waiters.filter(r => r !== done)
        resolve({ id, status: 'pending_confirmation' })
      }, ms)
      const done = st => {
        clearTimeout(timer)
        resolve(st)
      }
      item.waiters.push(done)
    })
  }
}
