// SPDX-License-Identifier: GPL-3.0-or-later
// IMAP connection helpers, per account (no global config, no environment variables).
// Derived from an earlier internal tool by the same author.
import { ImapFlow } from 'imapflow'

/** imapflow options for an account row (in_security = tls | starttls | none). */
export function imapOptions(account, password, extra = {}) {
  const security = account.in_security
  if (!['tls', 'starttls', 'none'].includes(security)) throw new Error(`unknown in_security: ${security}`)
  return {
    host: account.in_host,
    port: account.in_port,
    secure: security === 'tls',
    // true = STARTTLS required (no silent fallback to plain text), false = never upgrade
    doSTARTTLS: security === 'starttls' ? true : security === 'none' ? false : undefined,
    auth: { user: account.in_user, pass: password },
    tls: { rejectUnauthorized: account.tls_verify !== 0 },
    logger: false,
    ...extra,
  }
}

/** extra: further imapflow options (e.g. maxIdleTime for the IDLE connection). */
export function createImapClient(account, password, extra = {}) {
  return new ImapFlow(imapOptions(account, password, extra))
}

/**
 * One long-lived connection for interactive actions (open, download, flags) so they do not wait
 * for the background sync. `connect` is an async factory returning a connected client.
 * The client gets an 'error' listener: an idle connection that dies (network change, sleep, a
 * server reset) makes imapflow emit 'error', and without a listener that is an uncaught exception
 * that takes the whole main process down (measured live, with a network cut). The next get() reconnects.
 */
export class ImapConnection {
  constructor(connect, { onError = () => {} } = {}) {
    this.connectFn = connect
    this.onError = onError
    this.client = null
    this.connecting = null
  }

  async get() {
    if (this.client && this.client.usable) return this.client
    if (this.connecting) return this.connecting
    this.connecting = (async () => {
      const c = await this.connectFn()
      c.on('error', err => {
        if (this.client === c) this.client = null
        try {
          this.onError(err)
        } catch {}
      })
      c.on('close', () => {
        if (this.client === c) this.client = null
      })
      this.client = c
      return c
    })().finally(() => {
      this.connecting = null
    })
    return this.connecting
  }

  async close() {
    if (this.client) await this.client.logout().catch(() => {})
    this.client = null
  }
}

const SKIP_SPECIAL_USE = new Set(['\\Junk', '\\Trash', '\\All'])

// Many servers do not mark trash/spam with SPECIAL-USE, so they are matched by name too,
// on any path level ("Trash.old", "INBOX.Levélszemét").
const SKIP_NAMES = new Set([
  'trash', 'deleted items', 'deleted messages', 'törölt elemek', 'kuka',
  'junk', 'junk e-mail', 'junk email', 'spam', 'levélszemét',
  'infected items', 'fertőzött elemek', 'eset antispam',
])

/** Whether a LIST entry is junk / trash / "All Mail" (by SPECIAL-USE or by name). */
export function isJunkOrTrash(f) {
  if (f.specialUse && SKIP_SPECIAL_USE.has(f.specialUse)) return true
  const segments = f.path.toLowerCase().split(f.delimiter || '/')
  return segments.some(s => SKIP_NAMES.has(s))
}

/**
 * Folders to sync: selectable ones, minus `exclude` (paths or names, case-insensitive).
 * skipJunkTrash = true keeps the earlier tool's behaviour. The app syncs trash and junk too (they are
 * shown in the folder tree), only Gmail's "All Mail" (\\All) stays out: it repeats every message.
 */
export async function listSyncFolders(client, { skipJunkTrash = true, exclude = [] } = {}) {
  const ex = exclude.map(x => x.toLowerCase())
  const list = await client.list()
  return list.filter(f => {
    if (f.flags && (f.flags.has('\\Noselect') || f.flags.has('\\NonExistent'))) return false
    if (f.specialUse === '\\All') return false
    if (skipJunkTrash && isJunkOrTrash(f)) return false
    const p = f.path.toLowerCase()
    const n = (f.name || '').toLowerCase()
    return !ex.some(x => x === p || x === n)
  })
}

export async function findSpecialFolder(client, specialUse, fallbacks) {
  const list = await client.list()
  const hit = list.find(f => f.specialUse === specialUse)
  if (hit) return hit.path
  const lower = fallbacks.map(x => x.toLowerCase())
  const byName = list.find(f => lower.includes(f.path.toLowerCase()) || lower.includes((f.name || '').toLowerCase()))
  if (byName) return byName.path
  throw new Error(`special folder not found: ${specialUse}`)
}
