// SPDX-License-Identifier: GPL-3.0-or-later
// IPC for the mail view: folder tree data, message list pages, sync status, Refresh.
// Every argument is checked here; the list's ORDER BY comes from a whitelist (MailIndex.LIST_SORTS).
import { LIST_SORTS, listFilterSql, parseListFilter } from '../../../core/db/mail-index.js'
import { errCode } from '../../../core/log-safe.js'
import { assignRoles } from '../../../core/imap/folders.js'
import { RECIPIENT_ROLES } from '../../../core/mime/recipient-label.js'

export const MAIL_CHANNELS = Object.freeze(['mail:folders', 'mail:list', 'mail:status', 'mail:sync'])
export const MAX_PAGE = 500

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype
const isId = v => Number.isInteger(v) && v > 0
const isFolder = v => typeof v === 'string' && v.length > 0 && v.length <= 1000

class BadRequest extends Error {}

/**
 * The order the list really uses: in a Sent or Drafts folder (assignRoles, so the hand-picked role counts too) the
 * "from" column shows the recipient, and sorting by it sorts by the recipient. The list and its ids (mail:ids) both
 * come through here, so "select all" and Shift-click take the order the user sees.
 */
export function listSortFor(index, accountId, folder, sort) {
  if (sort !== 'from') return sort
  return RECIPIENT_ROLES.has(assignRoles(index.folderList(accountId)).get(folder)) ? 'recipient' : sort
}

/**
 * @param store    AccountStore
 * @param index    MailIndex
 * @param manager  SyncManager (status, syncNow)
 * @param labels   Labels (core/db/labels.js): every list row gets its `labels: [label id]` (one query per page); null = none
 */
export function registerMailIpc({ ipcMain, store, index, manager, labels = null, isTrustedSender, log = () => {}, onUserSync = () => {} }) {
  const handle = (channel, fn) =>
    ipcMain.handle(channel, async (event, ...args) => {
      if (!isTrustedSender(event)) return { ok: false, error: 'untrusted_sender' }
      try {
        return { ok: true, ...(await fn(...args)) }
      } catch (err) {
        if (err instanceof BadRequest) return { ok: false, error: 'bad_request' }
        log(`${channel} failed: ${errCode(err)}`)
        return { ok: false, error: 'internal' }
      }
    })

  // Every account with its folders and counts; the renderer builds the tree (core/imap/folders.js).
  handle('mail:folders', async () => ({
    accounts: store.list().map(a => ({ id: a.id, name: a.name, email: a.email, type: a.type, folders: index.folders(a.id) })),
  }))

  handle('mail:list', async q => {
    if (!isPlainObject(q) || !isId(q.accountId) || !isFolder(q.folder)) throw new BadRequest()
    const sort = q.sort ?? 'date'
    const dir = q.dir ?? 'desc'
    const offset = q.offset ?? 0
    const limit = q.limit ?? 200
    if (!Object.hasOwn(LIST_SORTS, sort) || !['asc', 'desc'].includes(dir)) throw new BadRequest()
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) throw new BadRequest()
    // an optional filter; total is the filtered count, folderTotal the whole folder's
    const filter = parseListFilter(q.filter)
    if (!filter) throw new BadRequest()
    const folderTotal = index.countFolder(q.accountId, q.folder)
    // the filtered count first: the page uses it to pick the label filter's cheaper side
    const total = listFilterSql(filter).shape ? index.countFolder(q.accountId, q.folder, filter) : folderTotal
    const rows = index.listFolder({ accountId: q.accountId, folder: q.folder, sort: listSortFor(index, q.accountId, q.folder, sort), dir, offset, limit, filter, matches: total })
    return {
      total,
      folderTotal,
      rows: labels ? labels.attach(rows) : rows,
    }
  })

  handle('mail:status', async () => ({ accounts: manager.status() }))

  handle('mail:sync', async accountId => {
    if (accountId !== null && accountId !== undefined && !isId(accountId)) throw new BadRequest()
    manager.syncNow(accountId ?? null)
    onUserSync(accountId ?? null) // the user's Frissítés unlocks MCP test_account (null: every account)
    return {}
  })
}
