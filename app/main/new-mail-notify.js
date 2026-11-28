// SPDX-License-Identifier: GPL-3.0-or-later
// A system notice for new mail (Windows: a toast). Electron-free core, the Electron layer is given to it (show):
// - which rows: every row the index inserts (MailIndex.onInsert) waits for the end of its account's sync run; a run's
//   rows are told only if the account's first FULL run already ended (the mail of the night, downloaded at start,
//   never gives a notice), and only those still in a folder of the inbox role, unread; junk never (not the inbox).
// - what: the sender's name (its address without one) as the title, the subject as the text, never a preview; over
//   NOTICE_MAX rows from one run of an account, one summary for them ("N new messages (<account>)").
// - the text is cleaned: control, direction and zero-width characters out, the name at most NAME_MAX and the subject at
//   most SUBJECT_MAX characters (an ellipsis when cut); plain text.
// The switch lives in the encrypted settings (new_mail_notify, OFF by default: missing or broken is OFF). A locked
// program tells nothing (the notifier goes with the session). Logged: the number of notices only.
import { assignRoles } from '../../core/imap/folders.js'

export const NOTIFY_KEY = 'new_mail_notify'
export const notifyOn = value => value === 'on'
export const NOTICE_MAX = 3
export const NAME_MAX = 64
export const SUBJECT_MAX = 120
// rows waiting for their run's end, per account: a bound, so a huge first download keeps no long list
export const PENDING_MAX = 1000

// C0 / C1 controls, the direction marks and embeddings / isolates, the zero-width characters, line / paragraph separators
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g

/** One line of plain text: the unsafe characters out (a space where they split words), spaces folded, at most `max` code points. */
export function cleanNoticeText(value, max) {
  const s = String(value ?? '').replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim()
  const chars = Array.from(s)
  return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : s
}

/**
 * The notices for one run's new rows of one account: each row its own (NOTICE_MAX or fewer), else one summary.
 * -> [{ kind: 'message', title, body, accountId, folder, messageId } | { kind: 'summary', title, body, accountId, folder, count }]
 * texts: { noSubject, summary(n, account) }
 */
export function noticesFor(rows, account, texts) {
  if (!rows.length) return []
  if (rows.length > NOTICE_MAX) {
    const inbox = rows[0].folder
    return [{ kind: 'summary', title: cleanNoticeText(texts.summary(rows.length, account.name || account.email || ''), NAME_MAX + 40), body: '', accountId: account.id, folder: inbox, count: rows.length }]
  }
  return rows.map(r => {
    const name = cleanNoticeText(r.from_name, NAME_MAX)
    const address = cleanNoticeText(r.from_addr, NAME_MAX)
    const title = name ? (address && Array.from(`${name} <${address}>`).length <= NAME_MAX ? `${name} <${address}>` : name) : address || cleanNoticeText(texts.noSubject, NAME_MAX)
    return { kind: 'message', title, body: cleanNoticeText(r.subject, SUBJECT_MAX) || cleanNoticeText(texts.noSubject, SUBJECT_MAX), accountId: r.account_id, folder: r.folder, messageId: r.id }
  })
}

/**
 * The notifier of one unlocked session.
 * @param index    MailIndex (get, folderList)
 * @param store    the accounts (getRow)
 * @param enabled  () => the switch is on
 * @param show     (notice) => void, the Electron layer
 * @param texts    { noSubject, summary(n, account) }: read at every notice (the language may change)
 * -> { inserted(items), runEnd(summary), stop() }: wire inserted to MailIndex.onInsert, runEnd to the sync's onRunEnd
 */
export function createNewMailNotifier({ index, store, enabled, show, texts, log = () => {} }) {
  const primed = new Set() // accounts whose first full run ended
  const pending = new Map() // accountId -> ids inserted since its last run end
  let stopped = false
  return {
    inserted(items) {
      if (stopped) return
      for (const { id, account_id: accountId } of items) {
        const list = pending.get(accountId) || []
        if (list.length < PENDING_MAX) list.push(id)
        pending.set(accountId, list)
      }
    },
    runEnd(summary) {
      if (stopped || !summary) return
      const accountId = summary.accountId
      const ids = pending.get(accountId) || []
      pending.delete(accountId)
      const wasPrimed = primed.has(accountId)
      if (summary.kind !== 'targeted' && ['ok', 'folder', 'partial'].includes(summary.result)) primed.add(accountId)
      if (!wasPrimed || !ids.length || !enabled()) return
      const account = store.getRow(accountId)
      if (!account) return
      const roles = assignRoles(index.folderList(accountId))
      const rows = ids
        .map(id => index.get(id))
        .filter(r => r && r.account_id === accountId && roles.get(r.folder) === 'inbox' && !/(^|\s)\\Seen(\s|$)/i.test(r.flags || ''))
      const notices = noticesFor(rows, account, typeof texts === 'function' ? texts() : texts)
      for (const n of notices) {
        try {
          show(n)
        } catch {
          // the system may refuse it: quiet
        }
      }
      if (notices.length) log(`new mail notice: ${notices.length}`)
    },
    /** Lock and quit: nothing more is told, the waiting rows are dropped. */
    stop() {
      stopped = true
      pending.clear()
      primed.clear()
    },
  }
}

/**
 * The switch and the notifier of one unlocked session.
 * @param settings  the encrypted settings (get, set)
 * @param shortcut  notifyShortcut(...) (ensure, write, remove, applies)
 * @param settleMs  after a shortcut write, the first notice waits this long (Windows takes the shortcut in)
 * -> { enabled(), status(), setEnabled(on) -> { enabled, error? }, inserted, runEnd, stop() }
 * At start an enabled switch checks the shortcut; if it cannot be written the switch goes off (status: lost).
 */
export function startNewMailNotice({ index, store, settings, shortcut, show, texts, log = () => {}, now = () => Date.now(), settleMs = 3000, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let on = notifyOn(settings.get(NOTIFY_KEY))
  let lost = false
  let holdUntil = 0
  const timers = new Set()
  if (on && !shortcut.ensure()) {
    on = false
    lost = true
    settings.set(NOTIFY_KEY, 'off')
    log('new mail notice switch off (no shortcut)')
  }
  const later = notice => {
    const wait = holdUntil - now()
    if (wait <= 0) return show(notice)
    const timer = setTimer(() => {
      timers.delete(timer)
      if (on) show(notice)
    }, wait)
    if (timer && timer.unref) timer.unref()
    timers.add(timer)
  }
  const notifier = createNewMailNotifier({ index, store, enabled: () => on, show: later, texts, log })
  return {
    enabled: () => on,
    status: () => ({ enabled: on, lost }),
    setEnabled(want) {
      lost = false
      if (want) {
        if (!shortcut.write()) return { enabled: on, error: 'shortcut_failed' }
        if (shortcut.applies) holdUntil = now() + settleMs
        on = true
        settings.set(NOTIFY_KEY, 'on')
      } else {
        on = false
        settings.set(NOTIFY_KEY, 'off')
        shortcut.remove()
      }
      log(`new mail notice switch ${on ? 'on' : 'off'}`)
      return { enabled: on }
    },
    inserted: items => notifier.inserted(items),
    runEnd: summary => notifier.runEnd(summary),
    stop() {
      notifier.stop()
      for (const t of timers) clearTimer(t)
      timers.clear()
    },
  }
}

export const NOTIFY_CHANNELS = Object.freeze(['notify:status', 'notify:setEnabled'])

export function registerNotifyIpc({ ipcMain, notice, isTrustedSender, log = () => {} }) {
  const handle = (channel, fn) =>
    ipcMain.handle(channel, async (event, ...args) => {
      if (!isTrustedSender(event)) return { ok: false, error: 'untrusted_sender' }
      try {
        return fn(...args)
      } catch (err) {
        if (err && err.badRequest) return { ok: false, error: 'bad_request' }
        log(`${channel} failed: ${(err && (err.code || err.name)) || 'error'}`)
        return { ok: false, error: 'internal' }
      }
    })
  const bad = () => Object.assign(new Error('bad request'), { badRequest: true })
  handle('notify:status', (...args) => {
    if (args.length) throw bad()
    return { ok: true, ...notice.status() }
  })
  handle('notify:setEnabled', (on, ...rest) => {
    if (typeof on !== 'boolean' || rest.length) throw bad()
    const r = notice.setEnabled(on)
    return r.error ? { ok: false, error: r.error, enabled: r.enabled } : { ok: true, enabled: r.enabled }
  })
}
