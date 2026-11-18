// SPDX-License-Identifier: GPL-3.0-or-later
// "Küldés később": sends the scheduled messages when their time comes, through the composer's own send path (the Sent
// copy, the original's Answered / Forwarded flag). Electron-free: the clock, the timer and the notice are given.
//
// It runs only while the app is unlocked (the session builds it, the lock stops it). At start: a row left 'sending'
// (the app stopped while sending) fails as interrupted and is not sent again (it may have gone out); a row more than a
// day past its time becomes late (the user decides), at the start and at the moment of a send alike (the computer may
// have slept with the app unlocked); one within the day goes now, and the notice says how late. One send at a time.
// A temporary error before the message was handed over retries after 1, 5, 15 minutes, then the row fails; a permanent
// one fails at once; an error after the whole message went to the server (no final answer, the connection lost) leaves
// it 'uncertain': it may have gone out, so it is never sent again on its own (the user's "Küldés most").
// The log says the row id, the state and the lateness, never an address, a subject or a text.

export const TICK_MS = 30_000
// errors a retry cannot help (Scheduled.failed { permanent })
export const PERMANENT_ERRORS = Object.freeze(['auth_failed', 'no_password', 'no_recipient_accepted', 'no_recipients', 'bad_address', 'not_found', 'already_sent', 'store_corrupt', 'no_drafts_folder'])

/**
 * @param scheduled  core/db/scheduled.js Scheduled
 * @param composer   app/main/compose.js Composer (restoreScheduled, sendNow, close, forgetScheduled)
 * @param notify     ({ kind: 'scheduled', event: 'sent'|'retry'|'failed'|'uncertain'|'late'|'interrupted', id, subject, lateMs?, error? })
 */
export function createScheduler({ scheduled, composer, now = () => Date.now(), log = () => {}, notify = () => {}, tickMs = TICK_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer = null
  let running = null
  let stopped = true
  // the scheduled messages open in a composer (from the scheduled list): left alone until the window is done
  const held = () => (composer.heldScheduled ? composer.heldScheduled() : [])

  const arm = () => {
    if (stopped) return
    if (timer) clearTimer(timer)
    // a row held in a composer does not wake it (the composer's close pokes it)
    const next = scheduled.nextAt(held())
    const wait = next === null ? tickMs : Math.max(1000, Math.min(tickMs, next - now()))
    timer = setTimer(() => {
      timer = null
      tick()
    }, wait)
    if (timer && typeof timer.unref === 'function') timer.unref()
  }

  async function sendOne(row) {
    if (!scheduled.begin(row.id)) return
    let sessionId = null
    let result = null
    let failure = null
    try {
      const restored = composer.restoreScheduled(row.id)
      sessionId = restored.sessionId
      // Claude's message never adds its recipients to the address book (the confirmation switch's rule rests on it)
      result = await composer.sendNow(sessionId, restored.form, { addPeople: !row.claude, draftOnFail: false })
    } catch (err) {
      failure = err
    } finally {
      if (sessionId) composer.close(sessionId)
    }
    // the bookkeeping: a lock may have closed the database meanwhile; then the row stays 'sending' and the next
    // unlock settles it as interrupted (it may have gone out). Never an unhandled error.
    try {
      if (!failure) {
        composer.forgetScheduled(scheduled.done(row.id))
        const lateMs = Math.max(0, now() - row.send_at)
        log(`scheduled ${row.id} sent late_s=${Math.round(lateMs / 1000)}${result.warnings && result.warnings.length ? ` warnings=${result.warnings.length}` : ''}`)
        notify({ kind: 'scheduled', event: 'sent', id: row.id, subject: row.subject, lateMs, warnings: result.warnings || [], refused: (result.rejected || []).length })
        return
      }
      const code = typeof failure.code === 'string' ? failure.code : 'internal'
      // the whole message was handed over before the error: it may have gone out; only the user sends it again
      if (failure.afterData) {
        scheduled.uncertain(row.id)
        log(`scheduled ${row.id} uncertain code=${code}`)
        notify({ kind: 'scheduled', event: 'uncertain', id: row.id, subject: row.subject, error: code })
        return
      }
      const res = scheduled.failed(row.id, code, { permanent: PERMANENT_ERRORS.includes(code), now: now() })
      log(`scheduled ${row.id} ${res ? res.state : 'gone'} code=${code}`)
      if (res) notify({ kind: 'scheduled', event: res.state === 'failed' ? 'failed' : 'retry', id: row.id, subject: row.subject, error: code, nextTryAt: res.nextTryAt })
    } catch (err) {
      log(`scheduled ${row.id} not recorded (${err && typeof err.code === 'string' ? err.code : 'database closed'})`)
    }
  }

  async function tick() {
    if (stopped) return
    if (running) return running
    // the work starts in a then(): with nothing due it would otherwise end (and clear `running`) before the assignment,
    // and every later tick would get the old, settled promise and do nothing
    running = Promise.resolve()
      .then(async () => {
        // a message open in a composer (from the scheduled list) waits until the window is done with it; after a stop
        // (the lock) the database is not asked again
        const nextDue = () => (stopped ? null : scheduled.due(now(), held()))
        for (let row = nextDue(); row; row = nextDue()) {
          // the computer slept with the app unlocked: more than a day past its time it waits for the user (5B)
          if (scheduled.lateNow(row, now())) {
            log(`scheduled ${row.id} late`)
            notify({ kind: 'scheduled', event: 'late', id: row.id, subject: row.subject, lateMs: now() - row.send_at })
            continue
          }
          await sendOne(row)
        }
      })
      .catch(err => log(`scheduler stopped a run (${err && typeof err.code === 'string' ? err.code : err && err.name ? err.name : 'unknown'})`))
      .finally(() => {
        running = null
        arm()
      })
    return running
  }

  return {
    /** At unlock: settle the rows the last run left, then send the due ones. -> the settle result */
    start() {
      stopped = false
      const settled = scheduled.settle(now())
      for (const id of settled.interrupted) {
        const row = scheduled.get(id)
        log(`scheduled ${id} interrupted`)
        notify({ kind: 'scheduled', event: 'interrupted', id, subject: row ? row.subject : '' })
      }
      for (const id of settled.late) {
        const row = scheduled.get(id)
        log(`scheduled ${id} late`)
        notify({ kind: 'scheduled', event: 'late', id, subject: row ? row.subject : '', lateMs: row ? now() - row.send_at : null })
      }
      tick()
      return settled
    },
    /** At lock: no new send starts (one under way finishes); the timer goes. */
    stop() {
      stopped = true
      if (timer) clearTimer(timer)
      timer = null
      return running || Promise.resolve()
    },
    /** A new or changed row: look again now. */
    poke: () => tick(),
    tick,
  }
}
