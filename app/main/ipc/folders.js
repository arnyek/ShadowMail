// SPDX-License-Identifier: GPL-3.0-or-later
// IPC of folder management: folder:create, folder:rename, folder:move, folder:delete (folder:deleteCount for its warning), the manual order (folders:reorder,
// folders:resetOrder) and the role picker (folders:setRole).
import { ActionError } from '../sync-manager.js'
import { errCode } from '../../../core/log-safe.js'

export const FOLDER_CHANNELS = Object.freeze(['folder:create', 'folder:rename', 'folder:move', 'folder:delete', 'folder:deleteCount', 'folders:reorder', 'folders:resetOrder', 'folders:setRole', 'folders:subscriptions', 'folders:setSubscribed'])
// the roles the account settings can choose a folder for (INBOX is always the inbox)
export const CHOOSABLE_ROLES = Object.freeze(['drafts', 'sent', 'trash', 'junk', 'archive'])
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
  // exactly { accountId, path, parent }: parent null = the top level
  handle('folder:move', async q => {
    if (!isPlainObject(q) || Object.keys(q).length !== 3 || !isId(q.accountId) || !isPath(q.path) || !(q.parent === null || isPath(q.parent))) throw new BadRequest()
    return folders.move({ accountId: q.accountId, path: q.path, parent: q.parent })
  })
  handle('folder:delete', async q => {
    if (!isPlainObject(q) || !isId(q.accountId) || !isPath(q.path) || (q.confirmed !== undefined && typeof q.confirmed !== 'boolean')) throw new BadRequest()
    return folders.remove({ accountId: q.accountId, path: q.path, confirmed: q.confirmed === true })
  })
  // the count the delete warning names: { count, exact } (exact false = the local count, a lower bound)
  handle('folder:deleteCount', async q => {
    if (!isPlainObject(q) || !isId(q.accountId) || !isPath(q.path) || Object.keys(q).length !== 2) throw new BadRequest()
    return folders.deleteCount({ accountId: q.accountId, path: q.path })
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
  // the role picker: { accountId, role, path } with path null = Automatic
  handle('folders:setRole', async q => {
    if (!isPlainObject(q) || !isId(q.accountId) || !CHOOSABLE_ROLES.includes(q.role) || !(q.path === null || isPath(q.path))) throw new BadRequest()
    if (Object.keys(q).some(k => !['accountId', 'role', 'path'].includes(k))) throw new BadRequest()
    if (q.path !== null && q.path.toUpperCase() === 'INBOX') throw new BadRequest() // INBOX is always the inbox
    return folders.setRole({ accountId: q.accountId, role: q.role, path: q.path })
  })
  // subscriptions: the server's folders with what shows; one folder on or off (a role folder cannot go off)
  handle('folders:subscriptions', async q => {
    if (!isPlainObject(q) || !isId(q.accountId) || Object.keys(q).length !== 1) throw new BadRequest()
    return folders.subscriptions({ accountId: q.accountId })
  })
  handle('folders:setSubscribed', async q => {
    if (!isPlainObject(q) || !isId(q.accountId) || !isPath(q.path) || typeof q.subscribed !== 'boolean') throw new BadRequest()
    if (Object.keys(q).some(k => !['accountId', 'path', 'subscribed'].includes(k))) throw new BadRequest()
    return folders.setSubscribed({ accountId: q.accountId, path: q.path, subscribed: q.subscribed })
  })
}
