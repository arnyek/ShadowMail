// SPDX-License-Identifier: GPL-3.0-or-later
// IPC of the message actions: mail:action and mail:ids (every id of a folder, for Ctrl+A; with a filter: of the filtered list).
import { ACTIONS } from '../actions.js'
import { ActionError } from '../sync-manager.js'
import { LIST_SORTS, parseListFilter } from '../../../core/db/mail-index.js'
import { errCode } from '../../../core/log-safe.js'
import { listSortFor } from './mail.js'

export const ACTION_CHANNELS = Object.freeze(['mail:action', 'mail:ids'])
export const MAX_SELECTION = 100_000

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype
const isId = v => Number.isInteger(v) && v > 0
const isFolder = v => typeof v === 'string' && v.length > 0 && v.length <= 1000

class BadRequest extends Error {}

export function registerActionIpc({ ipcMain, actions, index, isTrustedSender, log = () => {} }) {
  const handle = (channel, fn) =>
    ipcMain.handle(channel, async (event, ...args) => {
      if (!isTrustedSender(event)) return { ok: false, error: 'untrusted_sender' }
      try {
        return { ok: true, ...(await fn(...args)) }
      } catch (err) {
        if (err instanceof BadRequest) return { ok: false, error: 'bad_request' }
        if (err instanceof ActionError) return { ok: false, error: err.code, ...(typeof err.inTrash === 'boolean' ? { inTrash: err.inTrash } : {}) }
        if (err && err.code === 'server_refused') return { ok: false, error: 'server_refused' }
        log(`${channel} failed: ${errCode(err)}`)
        return { ok: false, error: 'internal' }
      }
    })

  // { ids, action, target?, permanent? } -> { done, final, created? } (archive by year: the year folders it created)
  handle('mail:action', async q => {
    if (!isPlainObject(q) || !Array.isArray(q.ids) || !q.ids.length || q.ids.length > MAX_SELECTION || !q.ids.every(isId)) throw new BadRequest()
    if (!ACTIONS.includes(q.action)) throw new BadRequest()
    if (q.action === 'move' && !isFolder(q.target)) throw new BadRequest()
    if (q.action === 'archive' && q.target !== undefined) throw new BadRequest() // the main process picks the folder
    if (q.permanent !== undefined && typeof q.permanent !== 'boolean') throw new BadRequest()
    return actions.run({ ids: [...new Set(q.ids)], action: q.action, target: q.target ?? null, permanent: q.permanent === true })
  })

  handle('mail:ids', async q => {
    if (!isPlainObject(q) || !isId(q.accountId) || !isFolder(q.folder)) throw new BadRequest()
    const sort = q.sort ?? 'date'
    const dir = q.dir ?? 'desc'
    const seen = q.seen ?? null
    if (!Object.hasOwn(LIST_SORTS, sort) || !['asc', 'desc'].includes(dir) || (seen !== null && typeof seen !== 'boolean')) throw new BadRequest()
    // the list's filter, so "select all" takes exactly the listed (filtered) set
    const filter = parseListFilter(q.filter)
    if (!filter) throw new BadRequest()
    return { ids: index.listIds({ accountId: q.accountId, folder: q.folder, sort: listSortFor(index, q.accountId, q.folder, sort), dir, seen, filter }) }
  })
}
