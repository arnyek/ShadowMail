// SPDX-License-Identifier: GPL-3.0-or-later
// The upload of an IMAP account's local labels to its server (0.17.0): a label bound locally to an IMAP message (a data
// folder from before the server labels, or a folder that did not allow the keyword then) goes to the server as its
// keyword, on EVERY copy of the message in the account (a local binding shows on all of them, so nothing disappears).
// Run at the end of a full sync, once per account and session (the Syncer instance), on the sync's own connection.
// Per folder and keyword one UID STORE +FLAGS (storeKeywords: the PERMANENTFLAGS decide); a binding goes only when the
// keyword is on every copy; a folder that does not allow it keeps the binding (no error, not tried again this session).
// The log has counts only, never a label name or keyword.
import { storeKeywords } from './actions.js'
import { isConnectionLoss } from './sync.js'

const lost = err => Boolean(err && (isConnectionLoss(err) || err.code === 'SYNC_STOPPED'))

/**
 * @param labels    Labels (core/db/labels.js)
 * @param client    a connected imapflow client (the sync's)
 * @returns { uploaded, kept, done } done = false: the connection went away (or the sync stopped) half-way; the rest
 *          waits for the next full run
 */
export async function uploadLocalLabels({ labels, client, accountId, log = () => {} }) {
  const plan = labels.uploadPlan(accountId)
  if (!plan.length) return { uploaded: 0, kept: 0, done: true }
  // per folder and keyword: the UIDs and the rows
  const jobs = new Map()
  for (const b of plan) {
    b.jobs = []
    for (const r of b.rows) {
      if (!Number.isInteger(r.uid)) {
        b.blocked = true // a row without a UID (not on the server yet): the binding stays
        continue
      }
      const key = `${r.folder}\u0000${b.keyword}`
      if (!jobs.has(key)) jobs.set(key, { folder: r.folder, keyword: b.keyword, uids: new Set(), ids: [], ok: false })
      const job = jobs.get(key)
      job.uids.add(r.uid)
      job.ids.push(r.id)
      if (!b.jobs.includes(job)) b.jobs.push(job)
    }
  }
  let done = true
  for (const job of jobs.values()) {
    try {
      const res = await storeKeywords(client, job.folder, [...job.uids], { add: [job.keyword] }, { uidvalidity: labels.uidvalidity(accountId, job.folder) })
      job.ok = res.added.length === 1
      if (job.ok) labels.setRowKeywords(job.ids, { add: [job.keyword] })
    } catch (err) {
      if (lost(err)) {
        done = false
        break
      }
      // refused, a recreated folder, a folder gone: this folder keeps its bindings
    }
  }
  let uploaded = 0
  let kept = 0
  for (const b of plan) {
    if (!b.blocked && b.jobs.length && b.jobs.every(j => j.ok)) uploaded += labels.unbindKey(accountId, b.key, b.labelId)
    else kept++
  }
  log(`labels: ${uploaded} local label(s) uploaded to the server, ${kept} kept local${done ? '' : ' (the connection went away)'}`)
  return { uploaded, kept, done }
}
