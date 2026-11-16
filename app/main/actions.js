// SPDX-License-Identifier: GPL-3.0-or-later
// Message actions for IMAP and POP3 accounts. No Electron import: tested with fakes.
//
// The index follows the server: it changes only after the server said yes, so a failed action leaves
// nothing to roll back here (the renderer shows the change at once and drops it on an error).
// IMAP: one folder of one account per call, on the interactive connection (SyncManager.withConnection).
// POP3 (local folders): the same actions, only in the database (and data/store for a final delete).
//
// Delete: to the Trash; inside the Trash, or on an account without a Trash, it is FINAL and needs
// `permanent: true` (the renderer asks first), otherwise the answer is 'confirm_needed'.
import fs from 'node:fs'
import path from 'node:path'
import { changeFlags, moveMessages, expungeMessages } from '../../core/imap/actions.js'
import { assignRoles } from '../../core/imap/folders.js'
import { ActionError } from './sync-manager.js'
import { errCode } from '../../core/log-safe.js'

export const ACTIONS = Object.freeze(['read', 'unread', 'star', 'unstar', 'move', 'delete'])

const FLAG_CHANGE = {
  read: { add: ['\\Seen'], remove: [] },
  unread: { add: [], remove: ['\\Seen'] },
  star: { add: ['\\Flagged'], remove: [] },
  unstar: { add: [], remove: ['\\Flagged'] },
}

export function applyFlagChange(flags, { add, remove }) {
  const set = new Set((flags || '').split(' ').filter(Boolean))
  for (const f of add) set.add(f)
  for (const f of remove) set.delete(f)
  return [...set].join(' ')
}

/** The account's Trash folder path, or null (no SPECIAL-USE \Trash and no usual name). */
export function trashFolder(folders) {
  for (const [p, role] of assignRoles(folders)) if (role === 'trash') return p
  return null
}

export class MailActions {
  /**
   * @param index           MailIndex
   * @param store           AccountStore (getRow)
   * @param storeDir        data/store (downloaded .eml files)
   * @param withConnection  SyncManager#withConnection
   * @param onChange        ({ accountId, folders }) after the index changed
   * @param requestSync     (accountId, folders) a targeted sync (a moved message without a UID map)
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

  #removeFiles(rows) {
    for (const r of rows) {
      if (!r.store_path) continue
      const file = path.resolve(this.storeDir, r.store_path)
      if (!file.startsWith(this.storeDir + path.sep)) continue
      try {
        fs.rmSync(file, { force: true })
      } catch (err) {
        this.log(`delete: ${r.store_path} kept (${errCode(err)})`)
      }
    }
  }

  /**
   * @param ids        message ids, all in one folder of one account
   * @param action     one of ACTIONS
   * @param target     folder path for 'move'
   * @param permanent  'delete' inside the Trash / without a Trash: the user confirmed
   * @returns { done, final: boolean } final = deleted for good
   * Throws ActionError: not_found, mixed_selection, bad_target, confirm_needed, server_refused,
   * sync_stopped, locked, connection_refused, connection_lost, ...
   */
  run(request) {
    // One action at a time: two quick requests for the same message (a double click
    // on the row's trash icon) used to read the rows before either had moved them; the second MOVE then
    // found no UID on the server and deleted the moved row and its file locally. Queued, each request
    // reads its rows only when it runs, so the second sees the first one's result.
    const next = this.#queue.then(() => this.#run(request))
    this.#queue = next.catch(() => {})
    return next
  }

  #queue = Promise.resolve()

  async #run({ ids, action, target = null, permanent = false }) {
    const rows = ids.map(id => this.index.get(id))
    if (!rows.length || rows.some(r => !r)) throw new ActionError('not_found')
    const { account_id: accountId, folder } = rows[0]
    if (rows.some(r => r.account_id !== accountId || r.folder !== folder)) throw new ActionError('mixed_selection')
    const account = this.store.getRow(accountId)
    if (!account) throw new ActionError('not_found')
    const isImap = account.type === 'imap'
    const folders = this.index.folderList(accountId)

    let kind = action
    let dest = target
    if (action === 'delete') {
      const trash = trashFolder(folders)
      if (!trash || trash === folder) {
        // inTrash: the dialog says the right thing even when the list still showed the old folder
        if (!permanent) throw Object.assign(new ActionError('confirm_needed'), { inTrash: Boolean(trash) })
        kind = 'expunge'
      } else {
        kind = 'move'
        dest = trash
      }
    }
    if (kind === 'move') {
      const f = folders.find(x => x.path === dest)
      if (!f || dest === folder || (!isImap && !f.is_local)) throw new ActionError('bad_target')
    }

    // the UIDVALIDITY our UIDs belong to: the server must still have it
    const expect = { uidvalidity: (this.index.getFolder(accountId, folder) || {}).uidvalidity ?? null }
    const guarded = async fn => {
      try {
        return await fn()
      } catch (err) {
        // the folder was recreated on the server: nothing was done; a full sync brings the new state
        if (err && err.code === 'uidvalidity_changed') this.requestSync(accountId, [folder])
        throw err
      }
    }

    if (FLAG_CHANGE[kind]) {
      const change = FLAG_CHANGE[kind]
      if (isImap) {
        await guarded(() => this.withConnection(accountId, client => changeFlags(client, folder, rows.map(r => r.uid), change, expect)))
      }
      for (const r of rows) this.index.setFlagsById(r.id, applyFlagChange(r.flags, change))
      this.onChange({ accountId, folders: [folder] })
      return { done: rows.length, final: false }
    }

    if (kind === 'move') {
      if (!isImap) {
        this.index.moveRows(rows.map(r => ({ id: r.id, folder: dest, uid: null })))
      } else {
        const uidMap = await guarded(() => this.withConnection(accountId, client => moveMessages(client, folder, rows.map(r => r.uid), dest, expect)))
        const kept = []
        const dropped = []
        for (const r of rows) {
          const newUid = uidMap && uidMap.get(r.uid)
          if (newUid) kept.push({ id: r.id, folder: dest, uid: newUid })
          else dropped.push(r)
        }
        // with the new UID the row keeps its text, pin and downloaded file; without it the target's sync brings it back
        this.index.moveRows(kept)
        if (dropped.length) {
          this.index.deleteIds(dropped.map(r => r.id))
          this.#removeFiles(dropped)
          this.requestSync(accountId, [dest])
        }
      }
      this.onChange({ accountId, folders: [folder, dest] })
      return { done: rows.length, final: false }
    }

    // expunge: for good
    if (isImap) await guarded(() => this.withConnection(accountId, client => expungeMessages(client, folder, rows.map(r => r.uid), expect)))
    this.index.deleteIds(rows.map(r => r.id))
    this.#removeFiles(rows)
    this.onChange({ accountId, folders: [folder] })
    return { done: rows.length, final: true }
  }
}
