// SPDX-License-Identifier: GPL-3.0-or-later
// IPC of the "Időzített" list (the scheduled messages): scheduled:list, scheduled:reschedule, scheduled:sendNow,
// scheduled:cancel. Only the main window may call them (a composer page cannot move or cancel a scheduled message).
// A row open in a composer is that window's: it is not moved, sent or cancelled from the list (scheduled_open); a row
// being sent is not touched (scheduled_sending). Opening a row in a composer is compose:open { mode: 'scheduled' }.
// The log says the row id and the result, never an address, a subject or a text.
import { ActionError } from '../sync-manager.js'
import { checkSendAt } from '../../../core/db/scheduled.js'
import { errCode } from '../../../core/log-safe.js'

export const SCHEDULED_CHANNELS = Object.freeze(['scheduled:list', 'scheduled:reschedule', 'scheduled:sendNow', 'scheduled:cancel'])

const isId = v => Number.isInteger(v) && v > 0
const isTime = v => Number.isSafeInteger(v) && v > 0

class BadRequest extends Error {}

/** The list's row: what the view shows, no payload. */
export function scheduledView(row, { held = false, account = null } = {}) {
  return {
    id: row.id,
    accountId: row.account_id,
    accountName: account ? account.name || account.email || '' : '',
    accountEmail: account ? account.email || '' : '',
    sendAt: row.send_at,
    state: row.state,
    attempts: row.attempts,
    nextTryAt: row.next_try_at,
    lastError: row.last_error,
    subject: row.subject || '',
    recipients: row.recipients || '',
    claude: Boolean(row.claude),
    held,
  }
}

/**
 * @param scheduled  core/db/scheduled.js Scheduled
 * @param composer   app/main/compose.js Composer (heldScheduled, unscheduleToDraft)
 * @param store      AccountStore (the account's name in the list)
 * @param isMainSender  (event) -> the main window
 * @param onChanged  () after a change (the list reloads; the scheduler looks again)
 */
export function registerScheduledIpc({ ipcMain, scheduled, composer, store, isMainSender, now = () => Date.now(), onChanged = () => {}, log = () => {} }) {
  const handle = (channel, fn) =>
    ipcMain.handle(channel, async (event, ...args) => {
      if (!isMainSender(event)) return { ok: false, error: 'untrusted_sender' }
      try {
        return { ok: true, ...(await fn(...args)) }
      } catch (err) {
        if (err instanceof BadRequest) return { ok: false, error: 'bad_request' }
        if (err instanceof ActionError) return { ok: false, error: err.code }
        log(`${channel} failed: ${errCode(err)}`)
        return { ok: false, error: 'internal' }
      }
    })

  // the row as it is now, refused when the list may not touch it
  const editable = id => {
    const row = scheduled.get(id)
    if (!row) throw new ActionError('not_found')
    if (row.state === 'sending') throw new ActionError('scheduled_sending')
    if (composer.heldScheduled().includes(id)) throw new ActionError('scheduled_open')
    return row
  }

  handle('scheduled:list', async (...args) => {
    if (args.length) throw new BadRequest()
    const held = new Set(composer.heldScheduled())
    const accounts = new Map(store.list().map(a => [a.id, a]))
    return { rows: scheduled.list().map(r => scheduledView(r, { held: held.has(r.id), account: accounts.get(r.account_id) })) }
  })

  // "Időpont módosítása": the same limits as scheduling (at least a minute ahead, at most a year); a failed or late
  // row waits again with its tries counted anew
  handle('scheduled:reschedule', async (id, sendAt, ...rest) => {
    if (!isId(id) || !isTime(sendAt) || rest.length) throw new BadRequest()
    editable(id)
    try {
      checkSendAt(sendAt, now())
    } catch (err) {
      throw new ActionError(err.code || 'bad_time')
    }
    if (!scheduled.reschedule(id, sendAt)) throw new ActionError('scheduled_sending')
    log(`scheduled ${id} rescheduled`)
    onChanged()
    return { id, sendAt }
  })

  // "Küldés most": due now; the scheduler sends it through the composer's path (the retries as for any row)
  handle('scheduled:sendNow', async (id, ...rest) => {
    if (!isId(id) || rest.length) throw new BadRequest()
    editable(id)
    if (!scheduled.reschedule(id, now())) throw new ActionError('scheduled_sending')
    log(`scheduled ${id} send now`)
    onChanged()
    return { id }
  })

  // "Időzítés törlése": back to a draft in the account's Drafts
  handle('scheduled:cancel', async (id, ...rest) => {
    if (!isId(id) || rest.length) throw new BadRequest()
    editable(id)
    const r = await composer.unscheduleToDraft(id)
    log(`scheduled ${id} back to drafts`)
    onChanged()
    return { id, oldDraftLeft: Boolean(r && r.oldDraftLeft) }
  })
}
