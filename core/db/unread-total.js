// SPDX-License-Identifier: GPL-3.0-or-later
// The taskbar badge's number: the unread messages of every account's inbox (assignRoles 'inbox', the folder the sidebar
// marks as Beérkezett), with the sidebar's own unread rule (no \Seen in the flags). And the change signal: TEMP triggers
// on the messages and folders tables call back on every write, whichever code path wrote (sync, POP3 fetch, the reader's
// \Seen, actions, MCP, a deleted folder or account through its cascade), so no write path can be forgotten. TEMP: the
// triggers live on this connection only and are not written to the file. The count reads the partial index of migration 7.
import { assignRoles } from '../imap/folders.js'
import { errCode } from '../log-safe.js'

const CHANGED_FN = 'shadowmail_unread_changed'
/** The count of one inbox: exactly the expression of the partial index idx_messages_unread (core/db/schema.js, 7). */
export const UNREAD_SQL = "SELECT COUNT(*) AS n FROM messages WHERE account_id = ? AND folder = ? AND instr(flags, '\\Seen') = 0"
const TRIGGERS = [
  ['sm_unread_msg_ins', 'AFTER INSERT ON main.messages'],
  ['sm_unread_msg_upd', 'AFTER UPDATE OF flags, folder, account_id ON main.messages'],
  ['sm_unread_msg_del', 'AFTER DELETE ON main.messages'],
  ['sm_unread_fld_ins', 'AFTER INSERT ON main.folders'],
  ['sm_unread_fld_upd', 'AFTER UPDATE OF path, special_use, account_id ON main.folders'],
  ['sm_unread_fld_del', 'AFTER DELETE ON main.folders'],
]

/** The unread total of every account's inbox. */
export function unreadInboxTotal(db) {
  const folders = db.prepare('SELECT account_id, path, special_use FROM folders ORDER BY account_id, path').all()
  const byAccount = new Map()
  for (const f of folders) {
    if (!byAccount.has(f.account_id)) byAccount.set(f.account_id, [])
    byAccount.get(f.account_id).push(f)
  }
  // the partial index of migration 7 (idx_messages_unread): the WHERE repeats its expression letter for letter, or
  // SQLite does not use it (test/unread-total.test.js checks the plan)
  const count = db.prepare(UNREAD_SQL)
  let total = 0
  for (const [accountId, list] of byAccount) {
    for (const [path, role] of assignRoles(list)) if (role === 'inbox') total += count.get(accountId, path).n
  }
  return total
}

/**
 * Calls `onChange()` after every write that may change the total. -> stop(): the triggers dropped. An error of onChange
 * stays here: it would otherwise fail the SQL statement that fired the trigger (a sync's insert, a mark as read, a
 * delete), for a mere display. Each error code is logged once (`log`), with no count and no message data.
 */
export function watchUnreadChanges(db, onChange, { log = () => {} } = {}) {
  const logged = new Set()
  db.function(CHANGED_FN, { deterministic: false }, () => {
    try {
      onChange()
    } catch (err) {
      const code = errCode(err)
      if (!logged.has(code)) {
        logged.add(code)
        log(`taskbar badge: change signal failed (${code})`)
      }
    }
    return null
  })
  for (const [name, when] of TRIGGERS) db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS ${name} ${when} BEGIN SELECT ${CHANGED_FN}(); END`)
  return () => {
    for (const [name] of TRIGGERS) {
      try {
        db.exec(`DROP TRIGGER IF EXISTS temp.${name}`)
      } catch {
        // a closed connection takes its TEMP triggers with it
      }
    }
  }
}
