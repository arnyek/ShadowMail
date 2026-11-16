// SPDX-License-Identifier: GPL-3.0-or-later
// Folder management: create (also as a subfolder), rename, delete, for IMAP accounts on
// the server and for POP3 accounts in their local folders. No Electron import: tested with fakes.
//
// - The role folders (INBOX, Drafts, Sent, Trash, Junk, Archive: SPECIAL-USE or the usual names, see
//   core/imap/folders.js) cannot be renamed or deleted.
// - A subfolder is "<parent><parent's delimiter><name>": "." or "/" as the server uses it. A top-level
//   folder is the bare name; imapflow adds the namespace prefix (e.g. "INBOX.") where the server needs it.
// - Delete needs confirmed: true (the renderer asks, with a warning when the folder is not empty); a
//   folder with subfolders is refused (has_children): they go first, one by one, with their own question.
// - The index changes only after the server said yes; a rename also moves the subfolders and messages.
import fs from 'node:fs'
import path from 'node:path'
import { createFolder, renameFolder, deleteFolder } from '../../core/imap/actions.js'
import { assignRoles } from '../../core/imap/folders.js'
import { ActionError } from './sync-manager.js'
import { FolderOrderError } from '../../core/db/mail-index.js'
import { errCode } from '../../core/log-safe.js'

export const MAX_FOLDER_NAME = 200
const LOCAL_DELIMITER = '/'

/** A folder name typed by the user: trimmed, no delimiter, no control or IMAP wildcard characters. */
export function checkFolderName(name, delimiter) {
  const n = typeof name === 'string' ? name.normalize('NFC').trim() : ''
  if (!n || n.length > MAX_FOLDER_NAME) return { error: 'bad_name' }
  if (/[\u0000-\u001f\u007f%*"\\]/.test(n)) return { error: 'bad_name' }
  if ((delimiter && n.includes(delimiter)) || n.includes('/')) return { error: 'name_has_delimiter' }
  if (n.toUpperCase() === 'INBOX') return { error: 'bad_name' }
  return { name: n }
}

export class FolderActions {
  /**
   * @param index           MailIndex
   * @param store           AccountStore (getRow)
   * @param storeDir        data/store
   * @param withConnection  SyncManager#withConnection
   * @param onChange        ({ accountId, folders }) the folder tree changed
   * @param requestSync     (accountId, folders | undefined) a sync after a server change
   */
  constructor({ index, store, storeDir, withConnection, onChange = () => {}, requestSync = () => {}, log = () => {} }) {
    this.index = index
    this.store = store
    this.storeDir = path.resolve(storeDir)
    this.withConnection = withConnection
    this.onChange = onChange
    this.requestSync = requestSync
    this.log = log
  }

  #context(accountId) {
    const account = this.store.getRow(accountId)
    if (!account) throw new ActionError('not_found')
    const folders = this.index.folderList(accountId)
    return { account, folders, roles: assignRoles(folders), isImap: account.type === 'imap' }
  }

  #folder(ctx, p) {
    const f = ctx.folders.find(x => x.path === p)
    if (!f) throw new ActionError('not_found')
    return f
  }

  #removeFiles(files) {
    for (const rel of files) {
      const file = path.resolve(this.storeDir, rel)
      if (!file.startsWith(this.storeDir + path.sep)) continue
      try {
        fs.rmSync(file, { force: true })
      } catch (err) {
        this.log(`folder delete: ${rel} kept (${errCode(err)})`)
      }
    }
  }

  /** parent = null: top level. Returns { path } of the new folder. */
  async create({ accountId, parent = null, name }) {
    const ctx = this.#context(accountId)
    const parentRow = parent === null ? null : this.#folder(ctx, parent)
    const delimiter = parentRow ? parentRow.delimiter || LOCAL_DELIMITER : ctx.folders.find(f => f.delimiter)?.delimiter || (ctx.isImap ? null : LOCAL_DELIMITER)
    const checked = checkFolderName(name, delimiter)
    if (checked.error) throw new ActionError(checked.error)
    if (parentRow && !parentRow.delimiter && ctx.isImap) throw new ActionError('no_subfolders') // a flat server
    const wanted = parentRow ? `${parentRow.path}${delimiter}${checked.name}` : checked.name
    if (ctx.folders.some(f => f.path.toLowerCase() === wanted.toLowerCase())) throw new ActionError('folder_exists')
    let created = wanted
    if (ctx.isImap) {
      created = await this.withConnection(accountId, client => createFolder(client, wanted))
      this.index.addFolder(accountId, created, delimiter, false)
      this.requestSync(accountId, [created])
    } else {
      this.index.addFolder(accountId, created, LOCAL_DELIMITER, true)
    }
    this.onChange({ accountId, folders: [created] })
    return { path: created }
  }

  /** Renames the last segment of a folder (it stays under its parent). Returns { path }. */
  async rename({ accountId, path: from, name }) {
    const ctx = this.#context(accountId)
    const f = this.#folder(ctx, from)
    if (ctx.roles.has(from)) throw new ActionError('protected_folder')
    const delimiter = f.delimiter || (ctx.isImap ? null : LOCAL_DELIMITER)
    const checked = checkFolderName(name, delimiter)
    if (checked.error) throw new ActionError(checked.error)
    const cut = delimiter ? from.lastIndexOf(delimiter) : -1
    const to = cut >= 0 ? `${from.slice(0, cut + delimiter.length)}${checked.name}` : checked.name
    if (to === from) return { path: from }
    if (ctx.folders.some(x => x.path.toLowerCase() === to.toLowerCase() && x.path !== from)) throw new ActionError('folder_exists')
    let renamed = to
    if (ctx.isImap) renamed = await this.withConnection(accountId, client => renameFolder(client, from, to))
    this.index.renameFolderTree(accountId, from, renamed, delimiter)
    if (ctx.isImap) this.requestSync(accountId) // a full run: the server may give the moved folders a new UIDVALIDITY
    this.onChange({ accountId, folders: [from, renamed] })
    return { path: renamed }
  }

  /** Deletes a folder (and, locally, its messages and their files). confirmed must be true. */
  async remove({ accountId, path: p, confirmed = false }) {
    const ctx = this.#context(accountId)
    const f = this.#folder(ctx, p)
    if (ctx.roles.has(p)) throw new ActionError('protected_folder')
    if (this.index.folderTree(accountId, p, f.delimiter).length > 1) throw new ActionError('has_children')
    if (!confirmed) throw new ActionError('confirm_needed')
    if (ctx.isImap) await this.withConnection(accountId, client => deleteFolder(client, p))
    const files = this.index.folderFiles(accountId, p)
    this.index.resetFolder(accountId, p)
    this.#removeFiles(files)
    this.onChange({ accountId, folders: [p] })
    return { path: p }
  }

  /**
   * A new order of one displayed sibling list (MailIndex.reorderFolders). Local only: no server call, no path
   * changes. Errors: not_found (account or parent), order_mismatch. Returns { count }.
   */
  reorder({ accountId, parentKey, paths }) {
    this.#context(accountId)
    let count
    try {
      count = this.index.reorderFolders(accountId, parentKey, paths)
    } catch (err) {
      if (err instanceof FolderOrderError) throw new ActionError(err.code)
      throw err
    }
    this.onChange({ accountId, folders: [] })
    return { count }
  }

  /** Every folder of the account back to the default order (role folders first, the rest alphabetical). */
  resetOrder({ accountId }) {
    this.#context(accountId)
    const count = this.index.resetFolderOrder(accountId)
    this.onChange({ accountId, folders: [] })
    return { count }
  }
}
