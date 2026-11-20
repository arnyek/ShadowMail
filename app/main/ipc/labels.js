// SPDX-License-Identifier: GPL-3.0-or-later
// IPC of the labels (0.17.0): the label list (labels:*, local only) and putting labels on / taking them off messages
// (mail:label): on an IMAP account the server's keyword (applyLabels), on POP3 and in local folders the database.
// The renderer sends ids only, never a key or a flag. After a change: the mail view's change event for every folder
// that shows a changed message (the other copy of the same message too), and { kind: 'labels' } when the list itself
// changed (names, colors, order, a label gone), so the list and the reader draw again.
import { LabelError, MAX_LABEL_IDS, MAX_LABELS, MAX_STATE_IDS } from '../../../core/db/labels.js'
import { errCode } from '../../../core/log-safe.js'
import { storeKeywords } from '../../../core/imap/actions.js'

export const LABEL_CHANNELS = Object.freeze([
  'labels:list', 'labels:create', 'labels:rename', 'labels:setColor', 'labels:reorder', 'labels:delete', 'mail:label', 'mail:labelState', 'mail:labelsOf',
])

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype
const isId = v => Number.isInteger(v) && v > 0
const hasOnly = (q, keys) => Object.keys(q).every(k => keys.includes(k))
const idArray = (v, max) => Array.isArray(v) && v.length <= max && v.every(isId)

class BadRequest extends Error {}

// the error codes of the label list the renderer shows; anything else of the data layer is a bad request
const LIST_ERRORS = new Set(['bad_name', 'bad_color', 'name_taken', 'not_found', 'order_mismatch', 'too_many'])

// the { kind: 'labels' } event, merged: the UI labels a whole folder in batches of 500 (Mail.jsx runLabel), and every
// event makes the list and Settings / Labels ask labels:list. The first event goes at once (one message labelled: no
// wait); while LABELS_EVENT_MS runs, further ones become ONE closing event at its end (sent after the last batch, so the
// final counts always arrive); then the window opens again. Measured: 100 000 messages in 200 batches, 200 events
// made the main process 4.5-8.5 s busy (a probe), without the event about 1 s.
export const LABELS_EVENT_MS = 250
const REAL_CLOCK = { set: (fn, ms) => { const h = setTimeout(fn, ms); h.unref?.(); return h }, clear: clearTimeout }
// one merged stream per label store (one per open database: the IPC's and the MCP tools' changes together); the
// closing event goes through the latest caller's notify
const merged = new WeakMap()
export function mergedNotify(labels, notify, clock = REAL_CLOCK, ms = LABELS_EVENT_MS) {
  let state = merged.get(labels)
  if (!state) {
    state = { timer: null, pending: false, notify, clock }
    const open = () => {
      state.timer = state.clock.set(() => {
        state.timer = null
        if (state.pending) {
          state.pending = false
          // a timer's throw would be an uncaught error in the main process (e.g. a sender gone with a closed session)
          try {
            state.notify({ kind: 'labels' })
          } catch {
            // the event is only a hint to reload; the next change sends a new one
          }
          open()
        }
      }, ms)
    }
    state.send = () => {
      if (state.timer) {
        state.pending = true
        return
      }
      state.notify({ kind: 'labels' })
      open()
    }
    merged.set(labels, state)
  }
  state.notify = notify
  return state.send
}

/**
 * Labels on / off messages. POP3 and local folders: the database only (the local bindings). An IMAP account's rows: the
 * server, per account + folder ONE interactive connection (storeKeywords: +FLAGS / -FLAGS of the label keywords, the
 * folder's PERMANENTFLAGS decide), and only after the server's yes the rows' stored flags; a folder that does not allow
 * the keyword gets the label locally (`local`), taking off also drops the local binding. A group that cannot reach its
 * server (locked, sync_stopped, connection_lost, uidvalidity_changed...) changes nothing (`failed`); the other groups
 * stand (no atomicity across folders or accounts). Then a change event for every folder that shows a changed message,
 * and { kind: 'labels' } when anything changed (merged, see mergedNotify). The UI's mail:label and Claude's
 * label_messages (app/main/mcp/tools.js) both come through here.
 * withConnection: SyncManager#withConnection; requestSync: (accountId, folders) after a UIDVALIDITY change; clock: tests.
 * -> { changed, folders: [{ accountId, folders }], local: [{ accountId, folder }], failed: [{ accountId, folder, error }] }
 * Throws LabelError (bad_request, not_found) before anything is written.
 */
export async function applyLabels({ labels, withConnection = null, requestSync = () => {}, onChange = () => {}, notify = () => {}, clock }, { ids, add = [], remove = [] }) {
  const plan = labels.writePlan(ids, { add, remove })
  const folders = new Map()
  const touch = (accountId, list) => {
    if (!folders.has(accountId)) folders.set(accountId, new Set())
    for (const f of list) folders.get(accountId).add(f)
  }
  const local = []
  const failed = []
  let changed = 0
  const bind = (rowIds, on, off) => {
    if (!rowIds.length || !(on.length + off.length)) return
    const res = labels.setLabels(rowIds, { add: on, remove: off })
    changed += res.changed
    for (const c of res.folders) touch(c.accountId, c.folders)
  }
  bind(plan.local, plan.add.map(l => l.id), plan.remove.map(l => l.id))

  const keywords = plan.add.filter(l => l.keyword).map(l => l.keyword)
  const offKeywords = plan.remove.filter(l => l.keyword).map(l => l.keyword)
  for (const g of plan.groups) {
    const rowIds = g.rows.map(r => r.id)
    let res
    try {
      if (!withConnection) throw Object.assign(new Error('no connection'), { code: 'not_available' })
      const spellings = offKeywords.length ? labels.keywordSpellings(rowIds, offKeywords) : []
      res = await withConnection(g.accountId, client => storeKeywords(client, g.folder, g.rows.map(r => r.uid), { add: keywords, remove: spellings }, { uidvalidity: g.uidvalidity }))
    } catch (err) {
      const error = (err && typeof err.code === 'string' && err.code) || 'internal'
      if (error === 'uidvalidity_changed') requestSync(g.accountId, [g.folder])
      failed.push({ accountId: g.accountId, folder: g.folder, error })
      continue
    }
    const n = labels.setRowKeywords(rowIds, { add: res.added, remove: offKeywords })
    if (n) touch(g.accountId, [g.folder])
    changed += n
    // the fallback: a label without a keyword, or one the folder does not allow, is bound locally
    const refused = new Set(res.refused)
    const localOn = plan.add.filter(l => !l.keyword || refused.has(l.keyword)).map(l => l.id)
    if (localOn.length) local.push({ accountId: g.accountId, folder: g.folder })
    try {
      bind(rowIds, localOn, plan.remove.map(l => l.id))
    } catch (err) {
      // a row gone during the server call (moved, deleted): its server part is done, the rest stands
      if (!(err instanceof LabelError)) throw err
    }
  }
  const list = [...folders].map(([accountId, set]) => ({ accountId, folders: [...set] }))
  for (const change of list) onChange(change)
  if (changed) mergedNotify(labels, notify, clock)()
  return { changed, folders: list, local, failed }
}

/**
 * Deletes a label, from the server too: every IMAP row whose flags carry its keyword (the local index) loses it, per
 * account + folder one UID STORE -FLAGS on the interactive connection; only when every folder went through is the
 * label deleted (its local bindings with it, CASCADE). A folder that fails (account out of reach, recreated folder, a NO)
 * keeps the label: the folders already done stay done, a second call takes the rest. POP3 and local folders need no
 * server (their bindings go with the label).
 * -> { deleted: true, count } (count: the messages it was on, before) or { deleted: false, count, failed: [{ accountId,
 * folder, error }] }. Throws LabelError not_found.
 */
export async function deleteLabel({ labels, withConnection = null, requestSync = () => {}, onChange = () => {} }, id) {
  const before = labels.list().find(l => l.id === id)
  if (!before) throw new LabelError('not_found')
  const failed = []
  const folders = new Map()
  for (const g of labels.keywordGroups(id)) {
    const ids = g.rows.map(r => r.id)
    try {
      if (!withConnection) throw Object.assign(new Error('no connection'), { code: 'not_available' })
      const spellings = labels.keywordSpellings(ids, [before.keyword])
      await withConnection(g.accountId, client => storeKeywords(client, g.folder, g.rows.map(r => r.uid), { remove: spellings }, { uidvalidity: g.uidvalidity }))
    } catch (err) {
      const error = (err && typeof err.code === 'string' && err.code) || 'internal'
      if (error === 'uidvalidity_changed') requestSync(g.accountId, [g.folder])
      failed.push({ accountId: g.accountId, folder: g.folder, error })
      continue
    }
    if (labels.setRowKeywords(ids, { remove: [before.keyword] })) {
      if (!folders.has(g.accountId)) folders.set(g.accountId, new Set())
      folders.get(g.accountId).add(g.folder)
    }
  }
  for (const [accountId, set] of folders) onChange({ accountId, folders: [...set] })
  if (failed.length) return { deleted: false, count: before.count, failed }
  labels.remove(id)
  return { deleted: true, count: before.count }
}

/**
 * @param labels    Labels (core/db/labels.js)
 * @param withConnection  SyncManager#withConnection (an IMAP account's labels go to its server)
 * @param requestSync     (accountId, folders): a folder whose UIDVALIDITY changed gets synced
 * @param onChange ({ accountId, folders }) => void: the mail view's change event (SyncManager.notifyChange)
 * @param notify    app:status sender; gets { kind: 'labels' } after a change of the list
 */
export function registerLabelIpc({ ipcMain, labels, withConnection = null, requestSync = () => {}, onChange = () => {}, notify = () => {}, isTrustedSender, log = () => {} }) {
  const handle = (channel, fn) =>
    ipcMain.handle(channel, async (event, ...args) => {
      if (!isTrustedSender(event)) return { ok: false, error: 'untrusted_sender' }
      try {
        return { ok: true, ...(await fn(...args)) }
      } catch (err) {
        if (err instanceof BadRequest) return { ok: false, error: 'bad_request' }
        if (err instanceof LabelError) return { ok: false, error: channel !== 'mail:label' && LIST_ERRORS.has(err.code) ? err.code : 'bad_request' }
        log(`${channel} failed: ${errCode(err)}`)
        return { ok: false, error: 'internal' }
      }
    })
  const changed = result => {
    notify({ kind: 'labels' })
    return result
  }

  handle('labels:list', async () => ({ labels: labels.list() }))

  // { name, color } -> { label }
  handle('labels:create', async q => {
    if (!isPlainObject(q) || !hasOnly(q, ['name', 'color'])) throw new BadRequest()
    return changed({ label: labels.create(q.name, q.color) })
  })

  // { id, name } -> { label }
  handle('labels:rename', async q => {
    if (!isPlainObject(q) || !hasOnly(q, ['id', 'name']) || !isId(q.id)) throw new BadRequest()
    return changed({ label: labels.rename(q.id, q.name) })
  })

  // { id, color } -> { label }
  handle('labels:setColor', async q => {
    if (!isPlainObject(q) || !hasOnly(q, ['id', 'color']) || !isId(q.id)) throw new BadRequest()
    return changed({ label: labels.setColor(q.id, q.color) })
  })

  // { ids } (every label id once, in the new order) -> { labels }
  handle('labels:reorder', async q => {
    if (!isPlainObject(q) || !hasOnly(q, ['ids']) || !idArray(q.ids, MAX_LABELS)) throw new BadRequest()
    labels.reorder(q.ids)
    return changed({ labels: labels.list() })
  })

  // { id } -> { deleted: true, count } (the number of messages it was on), or { deleted: false, count, failed: [{ accountId,
  // folder, error }] } when a server could not take the keyword off (the label stays; a second call takes the rest).
  // The UI asks first (Beállítások / Címkék).
  handle('labels:delete', async q => {
    if (!isPlainObject(q) || !hasOnly(q, ['id']) || !isId(q.id)) throw new BadRequest()
    const res = await deleteLabel({ labels, withConnection, requestSync, onChange }, q.id)
    log(res.deleted ? `labels: a label deleted (${res.count} message(s))` : `labels: a label kept, ${res.failed.length} folder(s) failed on the server`)
    return changed(res)
  })

  // { ids (<= 100 000: a whole selected folder) } -> { total, counts: [[label id, rows]] }: the picker's all / some / none.
  // Only reads.
  handle('mail:labelState', async q => {
    if (!isPlainObject(q) || !hasOnly(q, ['ids']) || !Array.isArray(q.ids) || !q.ids.length || !idArray(q.ids, MAX_STATE_IDS)) throw new BadRequest()
    const { total, counts } = labels.stateOf(q.ids)
    return { total, counts: [...counts] }
  })

  // { ids (<= 500) } -> { labels: { <row id>: [label id] } }: the rows' labels as stored now, by the message's (account,
  // label_key), so a view that keeps rows (the search hits, the reader) follows a change made on another copy. Reads.
  handle('mail:labelsOf', async q => {
    if (!isPlainObject(q) || !hasOnly(q, ['ids']) || !Array.isArray(q.ids) || !q.ids.length || !idArray(q.ids, MAX_LABEL_IDS)) throw new BadRequest()
    const of = labels.labelsOfRows(q.ids)
    return { labels: Object.fromEntries([...new Set(q.ids)].map(id => [id, of.get(id) || []])) }
  })

  // { ids (<= 500, any account and folder), add?: [label id], remove?: [label id] } -> { changed, local, failed }
  // (local: [{ accountId, folder }] the server does not allow the keyword there; failed: [{ accountId, folder, error }])
  handle('mail:label', async q => {
    if (!isPlainObject(q) || !hasOnly(q, ['ids', 'add', 'remove'])) throw new BadRequest()
    const add = q.add ?? []
    const remove = q.remove ?? []
    if (!Array.isArray(q.ids) || !q.ids.length || !idArray(q.ids, MAX_LABEL_IDS)) throw new BadRequest()
    if (!idArray(add, MAX_LABELS) || !idArray(remove, MAX_LABELS) || !(add.length + remove.length)) throw new BadRequest()
    const res = await applyLabels({ labels, withConnection, requestSync, onChange, notify }, { ids: q.ids, add, remove })
    return { changed: res.changed, local: res.local, failed: res.failed }
  })
}
