// SPDX-License-Identifier: GPL-3.0-or-later
// Message index: folders, message metadata, full-text search and threads, per account.
// Derived from an earlier internal tool by the same author. Differences:
// every query is scoped by account_id, `prune` is gone (rows and headers always stay), the TEXT of a
// message follows the account's body limit (body_state 3) unless the user opened it (body_pinned),
// and the list preview is stored with the body.
import { FTS_OPERATORS, toSafeFts, isFtsSyntaxError } from './fts.js'
import { buildFolderTree, resolveRoles, siblingsOf } from '../imap/folders.js'
import { UNREAD_SQL } from './unread-total.js'
import { labelKeyOf } from './label-key.js'
import { KEYWORD_ON_ROW, KEYWORD_FLAGS_WHERE } from './labels.js'

/** a refused folder order (MailIndex.reorderFolders); `code`: not_found | order_mismatch */
export class FolderOrderError extends Error {
  constructor(code) {
    super(code)
    this.name = 'FolderOrderError'
    this.code = code
  }
}

export const BODY_STATE = Object.freeze({ PENDING: 0, INDEXED: 1, FAILED: 2, BEYOND_LIMIT: 3 })

// Message list ordering. Whitelisted SQL: the IPC layer passes only these keys. NOCASE folds
// ASCII only, accented capitals sort after Z (no Hungarian collation in SQLite without an extension).
export const LIST_SORTS = Object.freeze({
  date: 'm.date',
  from: "COALESCE(NULLIF(m.from_name, ''), m.from_addr, '') COLLATE NOCASE",
  subject: "COALESCE(m.subject, '') COLLATE NOCASE",
  // the Sent and Drafts lists' "from" column shows the recipient (core/mime/recipient-label.js): the IPC maps 'from'
  // to this there (listSortFor); recipient_key is registered on every connection (core/db/index.js)
  recipient: 'recipient_key(m.to_addrs, m.cc_addrs, m.bcc_addrs) COLLATE NOCASE',
})
// + preview (one line of the text under the subject; empty until the body is indexed)
// + the recipients (the Sent and Drafts lists show them in the sender's place)
// stored and size: the list's drag decides at once whether a row can go out as a file (its source is here, the size
// within the limit); the main process measures the real bytes again
export const LIST_COLUMNS = 'm.id, m.uid, m.folder, m.from_name, m.from_addr, m.to_addrs, m.cc_addrs, m.bcc_addrs, m.subject, m.date, m.flags, m.has_attachments, m.preview, m.store_path IS NOT NULL AS stored, m.size'

// the folder list's filter (since 0.10.1). The list, its count and every id (the "select all") are built
// from this one function, so they always see the same set. Whitelisted fields, every value a parameter.
export const LIST_FILTER_KEYS = Object.freeze(['unread', 'flagged', 'hasAttachment', 'since', 'before', 'label', 'keepIds'])
export const MAX_KEEP_IDS = 500
// Flags are space-separated words: a word match, so a custom flag like $NotSeen is not \Seen.
const hasFlagSql = flag => `instr(' ' || COALESCE(m.flags, '') || ' ', ' ${flag} ') > 0`
const IS_SEEN = hasFlagSql('\\Seen')
const IS_FLAGGED = hasFlagSql('\\Flagged')
// a local label (0.17.0) on the message: bound to (account, label_key), so every copy of the message carries it.
// Two shapes of the same set (measured equal, tools/l5-filter-variants.mjs): HAS_LABEL checks each row of the folder
// (the folder's date index; a page stops early when the label is common), BY_LABEL starts from the label's own rows
// (its index, then messages by (account_id, label_key)): a rare label costs its own size, not the folder's.
// 0.17.0: on an IMAP account's row the label is also there when its keyword is among the row's flags (KEYWORD_ON_ROW,
// the rule of Labels.labelsOfRows); both shapes take the label id twice. The keyword is the ROW's (the copy of the
// message in another folder does not get it), so BY_LABEL's keyword side gives row ids, from the partial index of the
// rows that can carry a keyword (KEYWORD_FLAGS_WHERE, migration 17; its own text, so SQLite takes the index).
const KEYWORD_LABEL = `EXISTS (SELECT 1 FROM labels l WHERE l.id = ? AND ${KEYWORD_ON_ROW})`
const KEYWORD_ROWS = `SELECT k.id FROM labels l CROSS JOIN messages k
  WHERE l.id = ? AND l.keyword IS NOT NULL AND ${KEYWORD_FLAGS_WHERE}
    AND instr(' ' || lower(k.flags) || ' ', ' ' || l.keyword || ' ') > 0
    AND EXISTS (SELECT 1 FROM accounts a WHERE a.id = k.account_id AND a.type = 'imap')`
const HAS_LABEL = `(EXISTS (SELECT 1 FROM message_labels ml WHERE ml.account_id = m.account_id AND ml.label_key = m.label_key AND ml.label_id = ?) OR ${KEYWORD_LABEL})`
const BY_LABEL = `((m.account_id, m.label_key) IN (SELECT ml.account_id, ml.label_key FROM message_labels ml WHERE ml.label_id = ?) OR m.id IN (${KEYWORD_ROWS}))`
const isRowId = v => Number.isInteger(v) && v > 0
const isLabelId = v => Number.isSafeInteger(v) && v > 0
const isEpochMs = v => Number.isSafeInteger(v) && v >= 0

/**
 * A list filter from the renderer, checked: a plain object with the keys above only (booleans, epoch ms
 * integers or null for the dates, a label id or null, at most MAX_KEEP_IDS row ids). null / undefined = no filter.
 * Returns the filter, or null when it is not valid.
 */
export function parseListFilter(value) {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null
  for (const key of Object.keys(value)) if (!LIST_FILTER_KEYS.includes(key)) return null
  const { unread, flagged, hasAttachment, since, before, label, keepIds } = value
  for (const b of [unread, flagged, hasAttachment]) if (b !== undefined && typeof b !== 'boolean') return null
  for (const d of [since, before]) if (d !== undefined && d !== null && !isEpochMs(d)) return null
  if (label !== undefined && label !== null && !isLabelId(label)) return null
  if (keepIds !== undefined && (!Array.isArray(keepIds) || keepIds.length > MAX_KEEP_IDS || !keepIds.every(isRowId))) return null
  return { ...value }
}

/**
 * The filter's WHERE part (starting with " AND", empty without a filter), its parameters, and its shape:
 * which fields are on, used as the prepared-statement key (never the values). keepIds (a message
 * the user opened or acted on stays in the view) is OR-ed with the rest, and only matters when a filter is on.
 * byLabel: the label's BY_LABEL shape (shape letter 'L') instead of HAS_LABEL ('l'); the same set either way.
 */
export function listFilterSql(filter, { byLabel = false } = {}) {
  const where = []
  const params = []
  let shape = ''
  if (filter?.unread === true) (where.push(`NOT ${IS_SEEN}`), (shape += 'u'))
  if (filter?.flagged === true) (where.push(IS_FLAGGED), (shape += 'f'))
  if (filter?.hasAttachment === true) (where.push('m.has_attachments = 1'), (shape += 'a'))
  if (isEpochMs(filter?.since)) (where.push('m.date >= ?'), params.push(filter.since), (shape += 's'))
  if (isEpochMs(filter?.before)) (where.push('m.date < ?'), params.push(filter.before), (shape += 'b'))
  if (isLabelId(filter?.label)) (where.push(byLabel ? BY_LABEL : HAS_LABEL), params.push(filter.label, filter.label), (shape += byLabel ? 'L' : 'l'))
  if (!where.length) return { sql: '', params: [], shape: '' }
  let sql = where.join(' AND ')
  const keep = Array.isArray(filter.keepIds) ? [...new Set(filter.keepIds.filter(isRowId))].slice(-MAX_KEEP_IDS) : []
  if (keep.length) {
    // one JSON parameter: the statement does not depend on how many ids are kept
    sql = `(${sql}) OR m.id IN (SELECT value FROM json_each(?))`
    params.push(JSON.stringify(keep))
    shape += 'k'
  }
  return { sql: ` AND (${sql})`, params, shape }
}

/** POP3 mailbox identity: host (case-folded), port and user. */
export function pop3Identity({ host, port, user }) {
  return JSON.stringify({ pop3: 2, host: String(host).trim().toLowerCase(), port: Number(port), user: String(user) })
}

function parseIdentity(stored) {
  if (stored === null || stored === undefined || stored === '') return null
  const s = String(stored)
  try {
    const o = JSON.parse(s)
    if (o && o.pop3 === 2) return o
  } catch {
    // an identity written by an earlier build: "host:port:user"
  }
  const m = /^([^:]*):(\d+):(.*)$/s.exec(s)
  return m ? { host: m[1], port: Number(m[2]), user: m[3] } : { host: s, port: null, user: null }
}

export class MailIndex {
  constructor(db) {
    this.db = db
    // per account: how many times the app wrote a folder path (create, rename, move); a full sync reads it before its
    // LIST and skips its clean-up when it changed meanwhile (the LIST does not show the new paths)
    this.folderWrites = new Map()
    const p = sql => db.prepare(sql)
    this.s = {
      getFolder: p('SELECT * FROM folders WHERE account_id = ? AND path = ?'),
      upsertFolder: p(`INSERT INTO folders (account_id, path, delimiter, special_use, uidvalidity, last_uid, highest_modseq, synced_at)
        VALUES (@account_id, @path, @delimiter, @special_use, @uidvalidity, @last_uid, @highest_modseq, @synced_at)
        ON CONFLICT (account_id, path) DO UPDATE SET delimiter = excluded.delimiter, special_use = excluded.special_use,
          uidvalidity = excluded.uidvalidity, last_uid = excluded.last_uid, highest_modseq = excluded.highest_modseq,
          synced_at = excluded.synced_at`),
      deleteFolderMessages: p('DELETE FROM messages WHERE account_id = ? AND folder = ?'),
      deleteFolder: p('DELETE FROM folders WHERE account_id = ? AND path = ?'),
      folderPaths: p('SELECT path FROM folders WHERE account_id = ? AND is_local = 0'),
      insertMsg: p(`INSERT OR IGNORE INTO messages (account_id, folder, uid, pop3_uidl, message_id, in_reply_to, refs,
          from_addr, from_name, to_addrs, cc_addrs, bcc_addrs, subject, date, idate, flags, size, has_attachments, attachments,
          store_path, body_state, label_key)
        VALUES (@account_id, @folder, @uid, @pop3_uidl, @message_id, @in_reply_to, @refs,
          @from_addr, @from_name, @to_addrs, @cc_addrs, @bcc_addrs, @subject, @date, @idate, @flags, @size, @has_attachments, @attachments,
          @store_path, @body_state, @label_key)`),
      insertFts: p('INSERT INTO messages_fts (rowid, subject, sender, recipients, body) VALUES (?, ?, ?, ?, ?)'),
      setBody: p('UPDATE messages_fts SET body = ? WHERE rowid = ?'),
      setBodyState: p('UPDATE messages SET body_state = ?, preview = COALESCE(?, preview) WHERE id = ?'),
      setFlags: p('UPDATE messages SET flags = ? WHERE account_id = ? AND folder = ? AND uid = ?'),
      delMsg: p('DELETE FROM messages WHERE id = ?'),
      localUids: p('SELECT id, uid, idate, body_state, flags FROM messages WHERE account_id = ? AND folder = ?'),
      // (a) beyond the limit, not pinned: indexed text goes (pending rows simply skip the download)
      beyondLimit: p(`SELECT id, body_state FROM messages
        WHERE account_id = @account_id AND @cutoff IS NOT NULL AND idate IS NOT NULL AND idate < @cutoff
          AND body_pinned = 0 AND body_state IN (0, 1)`),
      clearBody: p("UPDATE messages_fts SET body = '' WHERE rowid = ?"),
      // the worker thread's search text, only while the row is indexed (a late result must not bring back a text the
      // body limit cleared)
      setSearchBody: p(`UPDATE messages_fts SET body = @text WHERE rowid = @id
        AND EXISTS (SELECT 1 FROM messages WHERE id = @id AND body_state = ${BODY_STATE.INDEXED})`),
      // the worker's preview of a message whose HTML was over the main thread's cap: only into an indexed row that has none
      setLatePreview: p(`UPDATE messages SET preview = @preview WHERE id = @id AND preview IS NULL AND body_state = ${BODY_STATE.INDEXED}`),
      localSourceRows: p(`SELECT id, store_path, date FROM messages
        WHERE account_id = @account_id AND store_path IS NOT NULL AND body_state = ${BODY_STATE.INDEXED}
          AND (@before_date IS NULL OR date < @before_date OR (date = @before_date AND id < @before_id))
        ORDER BY date DESC, id DESC LIMIT @limit`),
      markBeyondLimit: p('UPDATE messages SET body_state = 3 WHERE id = ?'),
      // (b) inside the limit again: back to pending, the body phase fetches the text
      requeue: p(`UPDATE messages SET body_state = 0
        WHERE account_id = @account_id AND body_state = 3 AND (@cutoff IS NULL OR idate IS NULL OR idate >= @cutoff)`),
      setPinned: p('UPDATE messages SET body_pinned = ? WHERE id = ?'),
      setStorePath: p('UPDATE messages SET store_path = ? WHERE id = ?'),
      // rows stored before 0.15.1 whose To and Cc give no recipient (empty, or only a group name such as
      // "undisclosed-recipients <>": the list's own rule, recipient_key): their Bcc (the column's fallback) is not known yet
      bccUnknown: p(`SELECT id, uid, store_path FROM messages
        WHERE account_id = @account_id AND folder = @folder AND bcc_addrs IS NULL
          AND recipient_key(to_addrs, cc_addrs, NULL) = ''`),
      setBcc: p('UPDATE messages SET bcc_addrs = ? WHERE id = ?'),
      // rows whose header columns hold U+FFFD (raw 8-bit fields read as UTF-8 before 0.15.1); folder null = every folder,
      // local = only rows without a UID (POP3)
      brokenHeaders: p(`SELECT id, uid, folder, store_path FROM messages
        WHERE account_id = @account_id AND (@folder IS NULL OR folder = @folder) AND (@local = 0 OR uid IS NULL)
          AND (instr(subject, @bad) > 0 OR instr(from_name, @bad) > 0 OR instr(to_addrs, @bad) > 0 OR instr(cc_addrs, @bad) > 0)`),
      setHeaders: p(`UPDATE messages SET subject = @subject, from_name = @from_name, to_addrs = @to_addrs, cc_addrs = @cc_addrs
        WHERE id = @id`),
      setFtsHeaders: p('UPDATE messages_fts SET subject = @subject, sender = @sender_text, recipients = @recipients_text WHERE rowid = @id'),
      setFlagsById: p('UPDATE messages SET flags = ? WHERE id = ?'),
      moveRow: p('UPDATE messages SET folder = ?, uid = ? WHERE id = ?'),
      // a folder and its subfolders (path = p, or starts with p + delimiter; substr, not LIKE: _ and % are legal in names)
      treeFolders: p(`SELECT path FROM folders WHERE account_id = @a AND (path = @p OR substr(path, 1, length(@p) + length(@d)) = @p || @d)`),
      // in place: the folder keeps its manual order (sort_order) under the new name
      renameFolderPath: p('UPDATE folders SET path = ? WHERE account_id = ? AND path = ?'),
      setFolderOrder: p('UPDATE folders SET sort_order = ? WHERE account_id = ? AND path = ?'),
      resetFolderOrder: p('UPDATE folders SET sort_order = NULL WHERE account_id = ? AND sort_order IS NOT NULL'),
      renameMessagesFolder: p('UPDATE messages SET folder = ? WHERE account_id = ? AND folder = ?'),
      folderFiles: p('SELECT store_path FROM messages WHERE account_id = ? AND folder = ? AND store_path IS NOT NULL'),
      addFolder: p(`INSERT INTO folders (account_id, path, delimiter, special_use, is_local) VALUES (?, ?, ?, NULL, ?)
        ON CONFLICT (account_id, path) DO NOTHING`),
      // POP3: local folders, downloaded UIDLs, texts read from data/store
      localFolder: p(`INSERT INTO folders (account_id, path, delimiter, special_use, is_local) VALUES (?, ?, '/', ?, 1)
        ON CONFLICT (account_id, path) DO NOTHING`),
      pop3Seen: p('SELECT uidl, downloaded_at, deleted_on_server_at FROM pop3_seen WHERE account_id = ?'),
      addPop3Seen: p('INSERT OR IGNORE INTO pop3_seen (account_id, uidl, downloaded_at) VALUES (?, ?, ?)'),
      pop3Deleted: p('UPDATE pop3_seen SET deleted_on_server_at = ? WHERE account_id = ? AND uidl = ?'),
      byUidl: p('SELECT * FROM messages WHERE account_id = ? AND pop3_uidl = ?'),
      pop3Doubled: p('SELECT uidl FROM pop3_doubled WHERE account_id = ?'),
      addPop3Doubled: p('INSERT OR IGNORE INTO pop3_doubled (account_id, uidl) VALUES (?, ?)'),
      pendingLocal: p(`SELECT id, store_path FROM messages
        WHERE account_id = ? AND body_state = 0 AND uid IS NULL AND store_path IS NOT NULL ORDER BY idate DESC LIMIT ?`),
      pending: p(`SELECT id, folder, uid FROM messages
        WHERE account_id = ? AND body_state = 0 AND uid IS NOT NULL ORDER BY idate DESC LIMIT ?`),
      pendingCount: p('SELECT COUNT(*) AS n FROM messages WHERE account_id = ? AND body_state = 0 AND uid IS NOT NULL'),
      get: p('SELECT * FROM messages WHERE id = ?'),
      getByUid: p('SELECT * FROM messages WHERE account_id = ? AND folder = ? AND uid = ?'),
      byMsgId: p('SELECT * FROM messages WHERE account_id = ? AND message_id = ?'),
      byInReplyTo: p('SELECT * FROM messages WHERE account_id = ? AND in_reply_to = ?'),
      // the replies to a message in one folder of the account (the reader's "You replied" line): the latest and how many
      // the unary + keeps the planner on idx_messages_inreply: a message has few replies, a Sent folder has thousands of rows
      latestReply: p('SELECT id, date FROM messages WHERE in_reply_to = ? AND +account_id = ? AND +folder = ? ORDER BY date DESC, id DESC LIMIT 1'),
      replyCount: p('SELECT COUNT(*) AS n FROM messages WHERE in_reply_to = ? AND +account_id = ? AND +folder = ?'),
      // instr, not LIKE: a Message-ID may contain _ or %, which LIKE would read as wildcards
      byRef: p('SELECT * FROM messages WHERE account_id = ? AND instr(refs, ?) > 0'),
      // the folder rows alone (no messages read): folderList, and the base of folders()
      folderList: p('SELECT path, delimiter, special_use, is_local, synced_at, sort_order, role, role_manual, kept FROM folders WHERE account_id = ? ORDER BY path'),
      keptRows: p('SELECT path, kept FROM folders WHERE account_id = ? AND is_local = 0'),
      setKept: p('UPDATE folders SET kept = ? WHERE account_id = ? AND path = ? AND is_local = 0'),
      // the roles the IMAP sync decided (core/imap/folders.js resolveRoles); local folders keep NULL
      folderRoles: p('SELECT path, role FROM folders WHERE account_id = ? AND is_local = 0 AND role IS NOT NULL'),
      clearFolderRoles: p('UPDATE folders SET role = NULL WHERE account_id = ? AND is_local = 0 AND role IS NOT NULL AND role_manual = 0'),
      setFolderRole: p('UPDATE folders SET role = ? WHERE account_id = ? AND path = ? AND is_local = 0'),
      // the roles chosen by hand (role_manual = 1): they survive every sync, the sync's own roles go around them
      manualRoles: p('SELECT path, role FROM folders WHERE account_id = ? AND is_local = 0 AND role_manual = 1 AND role IS NOT NULL'),
      dropRole: p('UPDATE folders SET role = NULL, role_manual = 0 WHERE account_id = ? AND is_local = 0 AND role = ?'),
      pinRole: p('UPDATE folders SET role = ?, role_manual = 1 WHERE account_id = ? AND path = ? AND is_local = 0'),
      countFolder: p('SELECT COUNT(*) AS n FROM messages WHERE account_id = ? AND folder = ?'),
      // the unread count: the taskbar's query letter for letter (its partial index idx_messages_unread is used only so)
      unreadFolder: p(UNREAD_SQL),
      stats: p(`SELECT COUNT(*) AS total, SUM(body_state = 1) AS bodies, SUM(body_state = 2) AS failed,
          SUM(body_state = 3) AS headers_only, MIN(idate) AS oldest, MAX(idate) AS newest
        FROM messages WHERE (@account_id IS NULL OR account_id = @account_id)`),
    }
    this.deleteIds = db.transaction(ids => {
      for (const id of ids) this.s.delMsg.run(id) // the FTS row goes with it (trigger)
    })
    this.setBccTx = db.transaction(items => {
      let n = 0
      for (const { id, bcc } of items) n += this.s.setBcc.run(bcc || '', id).changes
      return n
    })
    this.setHeadersTx = db.transaction((id, h) => {
      const row = { id, subject: h.subject || '', from_name: h.from_name || null, to_addrs: h.to_addrs || '', cc_addrs: h.cc_addrs || '' }
      if (!this.s.setHeaders.run(row).changes) return false
      this.s.setFtsHeaders.run({ id, subject: row.subject, sender_text: h.sender_text || '', recipients_text: h.recipients_text || '' })
      return true
    })
    this.insertMany = db.transaction(rows => {
      let n = 0
      for (const r of rows) {
        // the label key from the columns as stored: the one place every new row gets it (sync, POP3, compose)
        const info = this.s.insertMsg.run({ pop3_uidl: null, store_path: null, body_state: 0, bcc_addrs: null, ...r, label_key: labelKeyOf(r) })
        if (info.changes) {
          this.s.insertFts.run(info.lastInsertRowid, r.subject || '', r.sender_text || '', r.recipients_text || '', '')
          n++
        }
      }
      return n
    })
    this.setBodies = db.transaction(items => {
      for (const { id, text, state, preview = null } of items) {
        if (text) this.s.setBody.run(text, id)
        this.s.setBodyState.run(state, preview, id)
      }
    })
    this.setFlagsMany = db.transaction((accountId, folder, items) => {
      for (const { uid, flags } of items) this.s.setFlags.run(flags, accountId, folder, uid)
    })
    this.applyBodyLimitTx = db.transaction((accountId, cutoff) => {
      let cleared = 0
      for (const r of this.s.beyondLimit.all({ account_id: accountId, cutoff })) {
        if (r.body_state === BODY_STATE.INDEXED) this.s.clearBody.run(r.id)
        this.s.markBeyondLimit.run(r.id)
        cleared++
      }
      const requeued = this.s.requeue.run({ account_id: accountId, cutoff }).changes
      return { cleared, requeued }
    })
    this.pinOpenedTx = db.transaction((id, text, preview) => {
      this.s.setPinned.run(1, id)
      const row = this.s.get.get(id)
      if (row && row.body_state !== BODY_STATE.INDEXED) {
        this.s.setBody.run(text || '', id)
        this.s.setBodyState.run(BODY_STATE.INDEXED, preview || null, id)
      }
    })
    this.addPop3Tx = db.transaction((row, downloadedAt) => {
      this.s.addPop3Seen.run(row.account_id, row.pop3_uidl, downloadedAt)
      if (!this.insertMany([{ ...row, uid: null }])) return null
      return this.s.byUidl.get(row.account_id, row.pop3_uidl).id
    })
    this.markPop3DeletedTx = db.transaction((accountId, uidls, at) => {
      for (const u of uidls) this.s.pop3Deleted.run(at, accountId, u)
    })
    // a moved message keeps its row (text, pin, downloaded file). A row the sync already made for
    // the same message in the target (same UID) is the duplicate and goes.
    this.moveRows = db.transaction(items => {
      for (const { id, folder, uid } of items) {
        const row = this.s.get.get(id)
        if (!row) continue
        if (uid !== null && uid !== undefined) {
          const dup = this.s.getByUid.get(row.account_id, folder, uid)
          if (dup && dup.id !== id) this.s.delMsg.run(dup.id)
        }
        this.s.moveRow.run(folder, uid ?? null, id)
      }
    })
    // renames a folder and every subfolder (and their messages) from oldPath to newPath
    this.renameFolderTreeTx = db.transaction((accountId, oldPath, newPath, delimiter) => {
      const paths = this.s.treeFolders.all({ a: accountId, p: oldPath, d: delimiter || '\u0000' }).map(r => r.path)
      for (const path of paths) {
        const next = newPath + path.slice(oldPath.length)
        this.s.renameFolderPath.run(next, accountId, path)
        this.s.renameMessagesFolder.run(next, accountId, path)
      }
      return paths.length
    })
    // a folder moved under another parent (or to the top level): the subtree and its messages under the new path,
    // and the moved root's manual order dropped (it joins another sibling list; its old place means nothing there)
    this.moveFolderTreeTx = db.transaction((accountId, oldPath, newPath, delimiter) => {
      const n = this.renameFolderTreeTx(accountId, oldPath, newPath, delimiter)
      this.s.setFolderOrder.run(null, accountId, newPath)
      return n
    })
    this.resetFolder = db.transaction((accountId, path) => {
      this.s.deleteFolderMessages.run(accountId, path)
      this.s.deleteFolder.run(accountId, path)
    })
    // a new UIDVALIDITY (or a full sync) of a folder still on the server: its messages go, the row (and the manual
    // order on it) stays; the caller writes the sync fields anew with upsertFolder
    this.clearFolderMessages = db.transaction((accountId, path) => {
      this.s.deleteFolderMessages.run(accountId, path)
    })
    // checked against the tree in the same transaction as the write: nothing is written unless the whole list matches
    this.reorderFoldersTx = db.transaction((accountId, parentKey, paths) => {
      const siblings = siblingsOf(buildFolderTree(this.s.folderList.all(accountId)), parentKey)
      if (!siblings) throw new FolderOrderError('not_found')
      const members = new Set(siblings.filter(n => n.selectable).map(n => n.path))
      if (paths.length !== members.size || new Set(paths).size !== paths.length || !paths.every(p => members.has(p))) {
        throw new FolderOrderError('order_mismatch')
      }
      paths.forEach((path, i) => this.s.setFolderOrder.run(i, accountId, path))
      return paths.length
    })
  }

  /** The stored roles of an IMAP account's server folders: Map path -> role. */
  folderRoles(accountId) {
    return new Map(this.s.folderRoles.all(accountId).map(r => [r.path, r.role]))
  }

  /** The roles the user chose by hand: Map path -> role. */
  manualRoles(accountId) {
    return new Map(this.s.manualRoles.all(accountId).map(r => [r.path, r.role]))
  }

  /**
   * The user's choice for one role (drafts, sent, trash, junk, archive) of an IMAP account: a server folder's path, or
   * null for "Automatic". In one transaction the role leaves the folder that had it (chosen or automatic), the chosen
   * folder gets it, pinned (role_manual = 1), and then EVERY role is decided again at once, the way the sync does
   * (resolveRoles), with the local message counts in place of the server's STATUS: so a role that "Automatic" or the
   * choice left without a folder goes to the right one now, not only at the next full sync (before this,
   * the gap went by the alphabet, "Elküldött elemek" before "Sent"). INBOX cannot be chosen (bad_request).
   * -> the paths whose role changed. Throws not_found for a path that is not a server folder.
   */
  setManualRole(accountId, role, path) {
    if (path !== null && path.toUpperCase() === 'INBOX') throw Object.assign(new Error('INBOX is the inbox'), { code: 'bad_request' })
    return this.db.transaction(() => {
      const before = new Map(this.s.folderList.all(accountId).filter(f => f.role).map(f => [f.path, f.role]))
      if (path !== null && !this.s.folderList.all(accountId).some(f => f.path === path && !f.is_local)) {
        throw Object.assign(new Error('no such server folder'), { code: 'not_found' })
      }
      this.s.dropRole.run(accountId, role)
      if (path !== null) this.s.pinRole.run(role, accountId, path)
      const rows = this.s.folderList.all(accountId).filter(f => !f.is_local)
      if (rows.some(f => f.role && !f.role_manual)) {
        // an account the sync has listed: decide the rest again now (before its first full sync the old rule answers)
        const previous = new Map(rows.filter(f => f.role && !f.role_manual).map(f => [f.path, f.role]))
        const counts = new Map(rows.map(f => [f.path, this.s.countFolder.get(accountId, f.path).n]))
        const listed = rows.map(f => ({ path: f.path, delimiter: f.delimiter, specialUse: f.special_use }))
        const { roles } = resolveRoles(listed, { previous, counts, manual: this.manualRoles(accountId) })
        this.s.clearFolderRoles.run(accountId)
        for (const [p, r] of roles) this.s.setFolderRole.run(r, accountId, p)
      }
      const after = new Map(this.s.folderList.all(accountId).filter(f => f.role).map(f => [f.path, f.role]))
      return [...new Set([...before.keys(), ...after.keys()])].filter(p => before.get(p) !== after.get(p))
    })()
  }

  /** Stores the roles the sync decided (Map path -> role) in one transaction: every other server folder gets none. */
  setFolderRoles(accountId, roles) {
    this.db.transaction(() => {
      this.s.clearFolderRoles.run(accountId)
      for (const [path, role] of roles) this.s.setFolderRole.run(role, accountId, path)
    })()
  }

  getFolder(accountId, path) {
    return this.s.getFolder.get(accountId, path)
  }

  /** The kept flags of an IMAP account's server folders: Map path -> 1 | 0 | null (null: not decided yet). */
  keptFolders(accountId) {
    return new Map(this.s.keptRows.all(accountId).map(r => [r.path, r.kept]))
  }

  /**
   * After a LIST: every server folder whose kept flag is not decided yet (the rows from before the upgrade) gets 1 when
   * the server lists it as unsubscribed (it stays visible), else 0. -> the paths that got 1.
   */
  settleKept(accountId, listed) {
    return this.db.transaction(() => {
      const kept = []
      const byPath = new Map(listed.map(f => [f.path, f]))
      for (const r of this.s.keptRows.all(accountId)) {
        if (r.kept !== null) continue
        const f = byPath.get(r.path)
        const value = f && f.subscribed !== true ? 1 : 0
        this.s.setKept.run(value, accountId, r.path)
        if (value) kept.push(r.path)
      }
      return kept
    })()
  }

  /** The kept flag of one server folder (0 when the user unsubscribes it in the app). */
  setKept(accountId, path, kept) {
    this.s.setKept.run(kept ? 1 : 0, accountId, path)
  }

  upsertFolder(f) {
    this.s.upsertFolder.run({ delimiter: null, special_use: null, highest_modseq: null, synced_at: null, last_uid: 0, ...f })
  }

  // Drops server folders that no longer exist (or are no longer synced). Local folders stay.
  dropFoldersExcept(accountId, paths) {
    const keep = new Set(paths)
    for (const { path } of this.s.folderPaths.all(accountId)) {
      if (!keep.has(path)) this.resetFolder(accountId, path)
    }
  }

  localUids(accountId, folder) {
    return this.s.localUids.all(accountId, folder)
  }

  /**
   * Reconciles the indexed text with the account's body limit (cutoffMs, or null = no limit):
   * (a) older than the cut-off and not pinned: the FTS text is emptied, body_state 3 (preview and headers stay);
   * (b) inside the limit with body_state 3: back to 0, the body phase fills it in.
   * A message without any date counts as inside. Returns { cleared, requeued }.
   */
  applyBodyLimit(accountId, cutoffMs) {
    return this.applyBodyLimitTx(accountId, cutoffMs)
  }

  // Opened by the user: the text stays indexed regardless of the limit.
  setPinned(id, pinned = true) {
    this.s.setPinned.run(pinned ? 1 : 0, id)
  }

  /**
   * The user opened the message: pinned, and its text goes into the index even beyond the
   * account's limit (body_state 3 -> 1), so a later, smaller limit does not take it out again.
   */
  /** the search text made on the worker thread; written only if the row is still indexed. -> written? */
  setSearchBody(id, text) {
    return this.s.setSearchBody.run({ id, text: text || '' }).changes > 0
  }

  /** the worker's late preview (an HTML over the main thread's cap); written only into an indexed row without one. */
  setLatePreview(id, preview) {
    return typeof preview === 'string' && this.s.setLatePreview.run({ id, preview }).changes > 0
  }

  /** re-index: the indexed rows of an account with a local source, newest first, after `cursor` ({ date, id }). */
  localSourceRows(accountId, cursor = null, limit = 20) {
    return this.s.localSourceRows.all({ account_id: accountId, before_date: cursor ? cursor.date : null, before_id: cursor ? cursor.id : null, limit })
  }

  pinOpened(id, { text, preview }) {
    this.pinOpenedTx(id, text, preview)
  }

  /** [{ id, uid, store_path }] of the folder's rows with no To / Cc recipient whose Bcc is not known (stored before 0.15.1). */
  bccUnknownRows(accountId, folder) {
    return this.s.bccUnknown.all({ account_id: accountId, folder })
  }

  /** The Bcc line of the given rows: [{ id, bcc }] ('' = none). One transaction. -> rows written */
  setBccMany(items) {
    return this.setBccTx(items)
  }

  /** [{ id, uid, folder, store_path }] of the rows with a U+FFFD header column; folder null = every folder; local: POP3 rows only. */
  brokenHeaderRows(accountId, { folder = null, local = false } = {}) {
    return this.s.brokenHeaders.all({ account_id: accountId, folder, local: local ? 1 : 0, bad: '\uFFFD' })
  }

  /**
   * The header columns decoded anew (headerColumns): subject, sender name, recipients, and the FTS row's subject, sender
   * and recipients. The address (from_addr) stays. -> written?
   */
  setHeaders(id, h) {
    return this.setHeadersTx(id, h)
  }

  // Downloaded full message (.eml), relative to the data folder's store directory.
  setStorePath(id, relPath) {
    this.s.setStorePath.run(relPath, id)
  }

  setFlagsById(id, flags) {
    this.s.setFlagsById.run(flags, id)
  }

  /** POP3: the account's local folders (is_local = 1); existing ones stay as they are. */
  ensureLocalFolders(accountId, folders) {
    for (const { path, specialUse = null } of folders) this.s.localFolder.run(accountId, path, specialUse)
  }

  /**
   * POP3: which mailbox the UIDLs belong to, kept in the local INBOX row's unused uidvalidity, the POP3
   * counterpart of IMAP's UIDVALIDITY. Asked only after a successful login and UIDL.
   *   'same'  - the same server, port and user (or nothing stored yet: the first run)
   *   'near'  - the same user (any case), but another host or port: maybe the same mailbox (110/STLS <->
   *             995/TLS, an IP for the name, another name of the provider's server), maybe another one;
   *             the caller compares messages
   *   'other' - another user: another mailbox
   */
  pop3IdentityState(accountId, current) {
    const row = this.db.prepare("SELECT uidvalidity FROM folders WHERE account_id = ? AND path = 'INBOX'").get(accountId)
    const before = parseIdentity(row ? row.uidvalidity : null)
    if (!before) return 'same'
    const host = String(current.host).trim().toLowerCase()
    if (before.host === host && before.port === Number(current.port) && before.user === String(current.user)) return 'same'
    if (before.user !== null && before.user.toLowerCase() === String(current.user).toLowerCase()) return 'near'
    return 'other'
  }

  /**
   * POP3: records the mailbox identity. reset = true: another mailbox, the UIDL bookkeeping starts over,
   * the downloaded messages stay.
   */
  setPop3Identity(accountId, current, { reset = false } = {}) {
    this.db.transaction(() => {
      if (reset) {
        this.db.prepare('DELETE FROM pop3_seen WHERE account_id = ?').run(accountId)
        this.db.prepare('DELETE FROM pop3_doubled WHERE account_id = ?').run(accountId)
        this.db.prepare('UPDATE messages SET pop3_uidl = NULL WHERE account_id = ? AND pop3_uidl IS NOT NULL').run(accountId)
      }
      this.db.prepare("UPDATE folders SET uidvalidity = ? WHERE account_id = ? AND path = 'INBOX'").run(pop3Identity(current), accountId)
    })()
  }

  /** POP3: the UIDLs the server ever listed twice (never deleted on the server). */
  pop3Doubled(accountId) {
    return new Set(this.s.pop3Doubled.all(accountId).map(r => r.uidl))
  }

  addPop3Doubled(accountId, uidls) {
    this.db.transaction(() => {
      for (const u of uidls) this.s.addPop3Doubled.run(accountId, u)
    })()
  }

  /**
   * Makes every committed transaction durable (WAL + synchronous = NORMAL syncs only at checkpoints).
   * Called before a POP3 DELE: the row must survive a power cut once the server copy is gone.
   * A checkpoint syncs the WAL first, so it holds even if it cannot finish.
   */
  flushDurable() {
    this.db.pragma('wal_checkpoint(FULL)')
  }

  /** POP3: Map uidl -> { downloaded_at, deleted_on_server_at } */
  pop3Seen(accountId) {
    return new Map(this.s.pop3Seen.all(accountId).map(r => [r.uidl, r]))
  }

  /** POP3: one downloaded message, its row and its pop3_seen entry together. Returns the row id or null (already there). */
  addPop3Message(row, downloadedAt) {
    return this.addPop3Tx(row, downloadedAt)
  }

  markPop3Deleted(accountId, uidls, at) {
    this.markPop3DeletedTx(accountId, uidls, at)
  }

  getByUidl(accountId, uidl) {
    return this.s.byUidl.get(accountId, uidl)
  }

  /** POP3: rows whose text still has to be read from their .eml (no network). */
  pendingLocalBodies(accountId, limit = 500) {
    return this.s.pendingLocal.all(accountId, limit)
  }

  pendingBodies(accountId, limit = 500) {
    return this.s.pending.all(accountId, limit)
  }

  pendingCount(accountId) {
    return this.s.pendingCount.get(accountId).n
  }

  /** The replies to Message-ID `messageId` in `folder` of the account: { id, date, count } of the latest, or null. */
  replyIn(accountId, folder, messageId) {
    if (!messageId || !folder) return null
    const latest = this.s.latestReply.get(messageId, accountId, folder)
    if (!latest) return null
    return { id: latest.id, date: latest.date, count: this.s.replyCount.get(messageId, accountId, folder).n }
  }

  get(id) {
    return this.s.get.get(id)
  }

  getByUid(accountId, folder, uid) {
    return this.s.getByUid.get(accountId, folder, uid)
  }

  /**
   * The account's folders with their message and unread counts (the sidebar): { path, delimiter, special_use, is_local,
   * synced_at, sort_order, count, unread }, by path. Two index lookups per folder: the message count on
   * idx_messages_folder_date (covering), the unread count with UNREAD_SQL on idx_messages_unread. The former LEFT JOIN read
   * every message row of the account (flags is in no index): 100 000 messages on the encrypted file ~240 ms, now ~6 ms.
   */
  folders(accountId) {
    return this.s.folderList.all(accountId).map(f => ({ ...f, count: this.s.countFolder.get(accountId, f.path).n, unread: this.s.unreadFolder.get(accountId, f.path).n }))
  }

  /**
   * The label filter's side to start from (listFilterSql byLabel), by the rows each side walks (measured,
   * tools/l5-filter-variants.mjs): from the label = the label's rows in the account; from the folder = the folder's
   * messages, but a date-ordered page stops early, after about pageRows x folder / matches rows. The whole set (a count,
   * every id) or a page in another order: from the label when it has no more rows than the folder. matches: the
   * filtered count when the caller knows it (mail:list), else the label's rows stand for it. Both counts come from
   * indexes (no message row is read).
   */
  #byLabel(accountId, folder, filter, { pageRows = null, matches = null } = {}) {
    if (!isLabelId(filter?.label)) return false
    this.s.labelRows ??= this.db.prepare('SELECT COUNT(*) AS n FROM message_labels WHERE label_id = ? AND account_id = ?')
    // the label's rows through its keyword, from the partial index (the rows of the other accounts left out)
    this.s.keywordLabelRows ??= this.db.prepare(`SELECT COUNT(*) AS n FROM (${KEYWORD_ROWS} AND k.account_id = ?)`)
    const tagged = this.s.labelRows.get(filter.label, accountId).n + this.s.keywordLabelRows.get(filter.label, accountId).n
    const total = this.s.countFolder.get(accountId, folder).n
    if (pageRows === null) return tagged <= total
    const hits = Math.max(Number.isSafeInteger(matches) ? matches : tagged, 1)
    return tagged <= total * Math.min(1, pageRows / hits)
  }

  /** The account's folder rows without counts (existence, roles, paths): no message is read. */
  folderList(accountId) {
    return this.s.folderList.all(accountId)
  }

  /** Number of messages in one folder (the virtual list's height); with a filter, the filtered count. */
  countFolder(accountId, folder, filter = null) {
    const f = listFilterSql(filter, { byLabel: this.#byLabel(accountId, folder, filter) })
    if (!f.shape) return this.s.countFolder.get(accountId, folder).n
    const key = `count:${f.shape}`
    this.s[key] ??= this.db.prepare(`SELECT COUNT(*) AS n FROM messages m WHERE m.account_id = ? AND m.folder = ?${f.sql}`)
    return this.s[key].get(accountId, folder, ...f.params).n
  }

  /**
   * One page of a folder's message list: the list's columns only, sorted by LIST_SORTS[sort]
   * (ties by id, so pages never overlap). dir: 'asc' | 'desc'. filter: see listFilterSql. matches: the filtered count,
   * when known (only a hint for the label filter's side, never the result).
   */
  listFolder({ accountId, folder, sort = 'date', dir = 'desc', offset = 0, limit = 200, filter = null, matches = null }) {
    const expr = LIST_SORTS[sort]
    if (!expr) throw new Error(`unknown sort: ${sort}`)
    const d = dir === 'asc' ? 'ASC' : 'DESC'
    // only the date order has an index to stop early on; any other order reads every match
    const f = listFilterSql(filter, { byLabel: this.#byLabel(accountId, folder, filter, sort === 'date' ? { pageRows: offset + limit, matches } : {}) })
    const key = `list:${sort}:${d}:${f.shape}`
    if (!this.s[key]) {
      this.s[key] = this.db.prepare(
        `SELECT ${LIST_COLUMNS} FROM messages m WHERE m.account_id = ? AND m.folder = ?${f.sql}
          ORDER BY ${expr} ${d}, m.id ${d} LIMIT ? OFFSET ?`,
      )
    }
    return this.s[key].all(accountId, folder, ...f.params, limit, offset)
  }

  /** a new folder row (IMAP after CREATE, or a POP3 local folder). */
  addFolder(accountId, path, delimiter, isLocal) {
    this.s.addFolder.run(accountId, path, delimiter, isLocal ? 1 : 0)
    this.#folderWritten(accountId)
  }

  /** How many folder paths the app wrote for the account (create, rename, move) since the index opened. */
  folderWriteCount(accountId) {
    return this.folderWrites.get(accountId) || 0
  }

  #folderWritten(accountId) {
    this.folderWrites.set(accountId, this.folderWriteCount(accountId) + 1)
  }

  /** the folder and its subfolders (by the delimiter). */
  folderTree(accountId, path, delimiter) {
    return this.s.treeFolders.all({ a: accountId, p: path, d: delimiter || '\u0000' }).map(r => r.path)
  }

  /**
   * A manual order for one DISPLAYED sibling list (buildFolderTree): parentKey null = the top level, else the
   * displayed parent's path (a role folder that lives under INBOX on the server is a top-level sibling). `paths` is
   * the list's every real folder (not the placeholders, which have no row), each once, in the new order; they get
   * sort_order 0..n-1. Only sort_order changes, never a path. Throws FolderOrderError: not_found (no such parent),
   * order_mismatch (a missing, foreign, repeated or placeholder path); then nothing is written. -> rows written
   */
  reorderFolders(accountId, parentKey, paths) {
    return this.reorderFoldersTx(accountId, parentKey, paths)
  }

  /** every folder of the account back to no manual order (the default rule of buildFolderTree). -> rows changed */
  resetFolderOrder(accountId) {
    return this.s.resetFolderOrder.run(accountId).changes
  }

  renameFolderTree(accountId, oldPath, newPath, delimiter) {
    const n = this.renameFolderTreeTx(accountId, oldPath, newPath, delimiter)
    this.#folderWritten(accountId)
    return n
  }

  /** renameFolderTree for a folder moved under another parent: also the moved root's sort_order to NULL, in one transaction. */
  moveFolderTree(accountId, oldPath, newPath, delimiter) {
    const n = this.moveFolderTreeTx(accountId, oldPath, newPath, delimiter)
    this.#folderWritten(accountId)
    return n
  }

  /** the downloaded .eml files of a folder's messages (deleted with the folder). */
  folderFiles(accountId, path) {
    return this.s.folderFiles.all(accountId, path).map(r => r.store_path)
  }

  /**
   * Every id of a folder in the list's order (Ctrl+A on a virtual list). `seen` true/false
   * keeps only the read / unread ones (the "select read / unread" of the list header). `filter` is the
   * list's filter, so the ids are exactly the listed set; `seen` narrows that further.
   */
  listIds({ accountId, folder, sort = 'date', dir = 'desc', seen = null, filter = null }) {
    const expr = LIST_SORTS[sort]
    if (!expr) throw new Error(`unknown sort: ${sort}`)
    const d = dir === 'asc' ? 'ASC' : 'DESC'
    const s = seen === null ? 'all' : seen ? 'seen' : 'unseen'
    const f = listFilterSql(filter, { byLabel: this.#byLabel(accountId, folder, filter) })
    const key = `ids:${sort}:${d}:${s}:${f.shape}`
    if (!this.s[key]) {
      const bySeen = s === 'all' ? '' : s === 'seen' ? ` AND ${IS_SEEN}` : ` AND NOT ${IS_SEEN}`
      this.s[key] = this.db
        .prepare(`SELECT m.id FROM messages m WHERE m.account_id = ? AND m.folder = ?${f.sql}${bySeen} ORDER BY ${expr} ${d}, m.id ${d}`)
        .pluck()
    }
    return this.s[key].all(accountId, folder, ...f.params)
  }

  stats(accountId = null) {
    return this.s.stats.get({ account_id: accountId })
  }

  /**
   * Search. `query` is free text (accents optional) or FTS5 syntax ("exact phrase", OR, NOT, word*,
   * subject:word). Invalid FTS5 syntax never throws: it falls back to free text.
   * accountId = null searches every account.
   */
  search({ accountId = null, query, from, to, folder, since, before, hasAttachment, unread, flagged, label = null, limit = 50, sort } = {}) {
    const run = ftsQuery => {
      const where = []
      const params = []
      if (ftsQuery) {
        where.push('messages_fts MATCH ?')
        params.push(ftsQuery)
      }
      if (accountId != null) {
        where.push('m.account_id = ?')
        params.push(accountId)
      }
      if (folder) {
        where.push('m.folder = ? COLLATE NOCASE')
        params.push(folder)
      }
      if (since) {
        where.push('m.date >= ?')
        params.push(since.getTime())
      }
      if (before) {
        where.push('m.date < ?')
        params.push(before.getTime())
      }
      if (hasAttachment) where.push('m.has_attachments = 1')
      if (unread) where.push("instr(m.flags, '\\Seen') = 0")
      if (flagged) where.push("instr(m.flags, '\\Flagged') > 0")
      if (isLabelId(label)) {
        where.push(HAS_LABEL)
        params.push(label, label)
      }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
      if (ftsQuery && sort === 'date') {
        // By date, SQLite computes snippet() for EVERY hit before it sorts (measured: 95 000 hits, 1.1 s); so the inner
        // query picks the newest `limit` ids under every condition (the filters decide which ones), and the outer one
        // computes the snippet for those only. The same rows and snippets as one query; ties by id, as in the folder list.
        const inner = where.map(w => (w === 'messages_fts MATCH ?' ? 'f2.messages_fts MATCH ?' : w.replace(/\bm\./g, 'm2.')))
        const sql = `SELECT m.*, snippet(messages_fts, 3, '«', '»', '…', 14) AS snip
            FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid
            WHERE messages_fts MATCH ? AND m.id IN (
              SELECT m2.id FROM messages_fts f2 JOIN messages m2 ON m2.id = f2.rowid
               WHERE ${inner.join(' AND ')} ORDER BY m2.date DESC, m2.id DESC LIMIT ?)
            ORDER BY m.date DESC, m.id DESC`
        return this.db.prepare(sql).all(ftsQuery, ...params, limit)
      }
      const sql = ftsQuery
        ? `SELECT m.*, snippet(messages_fts, 3, '«', '»', '…', 14) AS snip,
              bm25(messages_fts, 8.0, 4.0, 2.0, 1.0) AS rank
            FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid
            ${whereSql} ORDER BY rank LIMIT ?`
        : `SELECT m.*, NULL AS snip FROM messages m ${whereSql} ORDER BY m.date DESC, m.id DESC LIMIT ?`
      return this.db.prepare(sql).all(...params, limit)
    }

    const extra = []
    if (from && toSafeFts(from)) extra.push(`sender : (${toSafeFts(from)})`)
    if (to && toSafeFts(to)) extra.push(`recipients : (${toSafeFts(to)})`)
    const build = q => [q && `(${q})`, ...extra].filter(Boolean).join(' AND ')

    if (query && FTS_OPERATORS.test(query)) {
      try {
        return run(build(query))
      } catch (err) {
        if (!isFtsSyntaxError(err)) throw err
        // invalid FTS5 syntax: retry as free text
      }
    }
    const safe = query ? toSafeFts(query) : ''
    // A query made only of punctuation has no words to match: no hits rather than "everything".
    if (query && !safe && !extra.length) return []
    return run(build(safe))
  }

  /** Every indexed message of the thread (Message-ID / In-Reply-To / References), oldest first, same account. */
  thread(id) {
    const root = this.get(id)
    if (!root) return []
    const acc = root.account_id
    const found = new Map([[root.id, root]])
    const seenIds = new Set()
    const queue = [root]
    while (queue.length && found.size < 500) {
      const m = queue.shift()
      const ids = [m.message_id, m.in_reply_to, ...(m.refs ? m.refs.split(/\s+/) : [])].filter(Boolean)
      for (const mid of ids) {
        if (seenIds.has(mid)) continue
        seenIds.add(mid)
        for (const r of [...this.s.byMsgId.all(acc, mid), ...this.s.byInReplyTo.all(acc, mid), ...this.s.byRef.all(acc, mid)]) {
          if (!found.has(r.id)) {
            found.set(r.id, r)
            queue.push(r)
          }
        }
      }
    }
    return [...found.values()].sort((a, b) => (a.date || 0) - (b.date || 0) || (a.idate || 0) - (b.idate || 0) || a.id - b.id)
  }
}
