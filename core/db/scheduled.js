// SPDX-License-Identifier: GPL-3.0-or-later
// "Küldés később": the rows of the scheduled table (migration 13). A row says what the list shows and when the message
// goes; the message itself (form, attachments, the original's flag, the signature image) is a sealed file in the store
// (payload_path). The rules here are pure (no network, no clock of their own): the scheduler (app/main/scheduler.js)
// asks for the next due row, marks it while sending, and reports the outcome.
//
// States: waiting (until send_at, or next_try_at after a temporary error) -> sending -> the row is removed when sent;
// failed (a permanent error, the retries used up, or the app stopped while sending: it may have gone out, so it is never
// sent again on its own); late (the app was not running and the time passed more than LATE_LIMIT_MS ago: the user
// decides). Only a waiting row is ever picked up.

export const RETRY_DELAYS_MS = Object.freeze([60_000, 5 * 60_000, 15 * 60_000])
export const LATE_LIMIT_MS = 24 * 60 * 60_000
export const MIN_AHEAD_MS = 60_000
export const MAX_AHEAD_MS = 366 * 24 * 60 * 60_000
// the error a row stopped while sending carries
export const INTERRUPTED = 'interrupted'
// the send failed after the whole message was handed to the server: it may have gone out (never sent again on its own)
export const UNCERTAIN = 'uncertain'

export class ScheduledError extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}

/** A send time the user or Claude may choose: a number of ms, at least a minute ahead, at most about a year. */
export function checkSendAt(sendAt, now) {
  if (typeof sendAt !== 'number' || !Number.isFinite(sendAt)) throw new ScheduledError('bad_time')
  if (sendAt < now + MIN_AHEAD_MS) throw new ScheduledError('too_soon')
  if (sendAt > now + MAX_AHEAD_MS) throw new ScheduledError('too_far')
  return sendAt
}

export class Scheduled {
  constructor(db) {
    this.db = db
    this.s = {
      add: db.prepare(`INSERT INTO scheduled (account_id, send_at, created_at, subject, recipients, claude, payload_path)
        VALUES (@accountId, @sendAt, @now, @subject, @recipients, @claude, @payloadPath)`),
      get: db.prepare('SELECT * FROM scheduled WHERE id = ?'),
      list: db.prepare('SELECT * FROM scheduled ORDER BY send_at, id'),
      due: db.prepare(`SELECT * FROM scheduled WHERE state = 'waiting' AND COALESCE(next_try_at, send_at) <= ?
        AND id NOT IN (SELECT value FROM json_each(?)) ORDER BY COALESCE(next_try_at, send_at), id LIMIT 1`),
      payload: db.prepare('UPDATE scheduled SET account_id = @accountId, payload_path = @payloadPath, subject = @subject, recipients = @recipients, claude = @claude WHERE id = @id'),
      next: db.prepare(`SELECT MIN(COALESCE(next_try_at, send_at)) AS at FROM scheduled WHERE state = 'waiting' AND id NOT IN (SELECT value FROM json_each(?))`),
      sendingIds: db.prepare(`SELECT id FROM scheduled WHERE state = 'sending'`),
      interrupted: db.prepare(`UPDATE scheduled SET state = 'failed', last_error = '${INTERRUPTED}' WHERE id = ? AND state = 'sending'`),
      lateIds: db.prepare(`SELECT id FROM scheduled WHERE state = 'waiting' AND send_at < ?`),
      setLate: db.prepare(`UPDATE scheduled SET state = 'late' WHERE id = ? AND state = 'waiting'`),
      uncertain: db.prepare(`UPDATE scheduled SET state = 'failed', attempts = attempts + 1, next_try_at = NULL, last_error = '${UNCERTAIN}' WHERE id = ? AND state = 'sending'`),
      begin: db.prepare(`UPDATE scheduled SET state = 'sending' WHERE id = ? AND state = 'waiting'`),
      retry: db.prepare(`UPDATE scheduled SET state = 'waiting', attempts = @attempts, next_try_at = @at, last_error = @code WHERE id = @id`),
      fail: db.prepare(`UPDATE scheduled SET state = 'failed', attempts = @attempts, next_try_at = NULL, last_error = @code WHERE id = @id`),
      requeue: db.prepare(`UPDATE scheduled SET state = 'waiting', send_at = @sendAt, attempts = 0, next_try_at = NULL, last_error = NULL WHERE id = @id AND state <> 'sending'`),
      remove: db.prepare('DELETE FROM scheduled WHERE id = ?'),
    }
  }

  add({ accountId, sendAt, subject = '', recipients = '', claude = false, payloadPath, now }) {
    return Number(this.s.add.run({ accountId, sendAt, now, subject: String(subject), recipients: String(recipients), claude: claude ? 1 : 0, payloadPath }).lastInsertRowid)
  }

  get(id) {
    return this.s.get.get(id) || null
  }

  list() {
    return this.s.list.all()
  }

  /** The next waiting row whose time (or retry time) has come, or null; `skip`: ids not to pick (open in a composer). */
  due(now, skip = []) {
    return this.s.due.get(now, JSON.stringify([...skip])) || null
  }

  /** The message itself was changed (saved in a composer): its new payload and what the list shows. */
  setPayload(id, { accountId, payloadPath, subject = '', recipients = '', claude = false }) {
    return this.s.payload.run({ id, accountId, payloadPath, subject: String(subject), recipients: String(recipients), claude: claude ? 1 : 0 }).changes === 1
  }

  /** The earliest time a waiting row comes due, or null (the scheduler's next wake-up); `skip`: ids held in a composer. */
  nextAt(skip = []) {
    const r = this.s.next.get(JSON.stringify([...skip]))
    return r && r.at !== null ? r.at : null
  }

  /**
   * At start (or unlock): a row left 'sending' (the app stopped while sending) becomes failed: it may have gone out, so
   * it is not sent again on its own. A waiting row more than LATE_LIMIT_MS past its time becomes late (a retry too:
   * its time is still the one the user chose).
   * -> { interrupted: [ids], late: [ids] }
   */
  settle(now) {
    const interrupted = []
    for (const { id } of this.s.sendingIds.all()) if (this.s.interrupted.run(id).changes) interrupted.push(id)
    const late = []
    for (const { id } of this.s.lateIds.all(now - LATE_LIMIT_MS)) if (this.s.setLate.run(id).changes) late.push(id)
    return { interrupted, late }
  }

  /**
   * The 5B rule at the moment of the send (the app ran on, but the computer slept): a waiting row more than
   * LATE_LIMIT_MS past its time is late, the user decides. -> true when it became late now
   */
  lateNow(row, now) {
    return now - row.send_at > LATE_LIMIT_MS && this.s.setLate.run(row.id).changes === 1
  }

  /** sending -> failed 'uncertain': the whole message was handed over before the error; only the user sends it again. */
  uncertain(id) {
    return this.s.uncertain.run(id).changes === 1
  }

  /** waiting -> sending; false when it is not waiting any more (cancelled, picked up meanwhile). */
  begin(id) {
    return this.s.begin.run(id).changes === 1
  }

  /** Sent: the row goes; -> its payload path (the caller removes the file). */
  done(id) {
    const row = this.get(id)
    this.s.remove.run(id)
    return row ? row.payload_path : null
  }

  /**
   * The send failed. A permanent error, or the retries used up: failed. Otherwise waiting again after the next delay
   * (1, 5, 15 minutes: at most three retries). -> { state, nextTryAt }
   */
  failed(id, code, { permanent = false, now }) {
    const row = this.get(id)
    if (!row) return null
    const attempts = row.attempts + 1
    if (permanent || attempts > RETRY_DELAYS_MS.length) {
      this.s.fail.run({ id, attempts, code: String(code) })
      return { state: 'failed', nextTryAt: null }
    }
    const at = now + RETRY_DELAYS_MS[attempts - 1]
    this.s.retry.run({ id, attempts, at, code: String(code) })
    return { state: 'waiting', nextTryAt: at }
  }

  /** A new time (the user, from a failed or late row too): waiting again, the tries counted anew. */
  reschedule(id, sendAt) {
    return this.s.requeue.run({ id, sendAt }).changes === 1
  }

  /** Removed (cancelled back to a draft, or the account's own removal): -> its payload path, or null. */
  remove(id) {
    const row = this.get(id)
    if (!row || row.state === 'sending') return null
    this.s.remove.run(id)
    return row.payload_path
  }
}
