// SPDX-License-Identifier: GPL-3.0-or-later
// IPC of folder management: folder:create, folder:rename, folder:delete, and the manual order (folders:reorder,
// folders:resetOrder).
import { ActionError } from '../sync-manager.js'
import { errCode } from '../../../core/log-safe.js'

export const FOLDER_CHANNELS = Object.freeze(['folder:create', 'folder:rename', 'folder:delete', 'folders:reorder', 'folders:resetOrder'])
// a sibling list longer than this is not a list of one parent's folders
export const MAX_REORDER_PATHS = 5000

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype
const isId = v => Number.isInteger(v) && v > 0
const isPath = v => typeof v === 'string' && v.length > 0 && v.length <= 1000
const isName = v => typeof v === 'string' && v.length <= 1000

class BadRequest extends Error {}

export function registerFolderIpc({ ipcMain, folders, isTrustedSender, log = () => {} }) {
  const handle = (channel, fn) =>
    ipcMain.handle(channel, async (event, ...args) => {
      if (!isTrustedSender(event)) return { ok: false, error: 'untrusted_sender' }
      try {
        return { ok: true, ...(await fn(...args)) }
      } catch (err) {
        if (err instanceof BadRequest) return { ok: false, error: 'bad_request' }
        if (err instanceof ActionError) return { ok: false, error: err.code }
        log(`${channel} failed: ${errCode(err)}`)
        return { ok: false, error: 'internal' }
      }
    })

  handle('folder:create', async q => {
    if (!isPlainObject(q) || !isId(q.accountId) || !isName(q.name) || !(q.parent === null || q.parent === undefined || isPath(q.parent))) throw new BadRequest()
    return folders.create({ accountId: q.accountId, parent: q.parent ?? null, name: q.name })
  })
  handle('folder:rename', async q => {
    if (!isPlainObject(q) || !isId(q.accountId) || !isPath(q.path) || !isName(q.name)) throw new BadRequest()
    return folders.rename({ accountId: q.accountId, path: q.path, name: q.name })
  })
  handle('folder:delete', async q => {
    if (!isPlainObject(q) || !isId(q.accountId) || !isPath(q.path) || (q.confirmed !== undefined && typeof q.confirmed !== 'boolean')) throw new BadRequest()
    return folders.remove({ accountId: q.accountId, path: q.path, confirmed: q.confirmed === true })
  })
  // the manual order (local only): a malformed request is bad_request, a list that is not exactly the displayed
  // siblings is order_mismatch; either way nothing is written
  handle('folders:reorder', async q => {
    if (!isPlainObject(q) || !isId(q.accountId) || !(q.parentKey === null || isPath(q.parentKey))) throw new BadRequest()
    if (!Array.isArray(q.paths) || q.paths.length > MAX_REORDER_PATHS || !q.paths.every(isPath)) throw new BadRequest()
    return folders.reorder({ accountId: q.accountId, parentKey: q.parentKey, paths: [...q.paths] })
  })
  handle('folders:resetOrder', async q => {
    if (!isPlainObject(q) || !isId(q.accountId)) throw new BadRequest()
    return folders.resetOrder({ accountId: q.accountId })
  })
}
