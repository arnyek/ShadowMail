// SPDX-License-Identifier: GPL-3.0-or-later
// IPC of the global search.
//
//   search:local   the index (every account / one account), filters, relevance or date; answers at once
//   search:server  "Keresés a szerveren is": a background job over the IMAP accounts in scope
//   search:pop3Old "Keresés a régi levelek szövegében is": a background job over the POP3 accounts in scope
//   search:cancel  stops a job
// A job answers { jobId } at once; its progress and hits come as app:status events
// { kind: 'search', jobId, source, progress?, hits?, finished? }. One job per source: a new one
// cancels the previous. The hits of both jobs get the same filters as the local search.
import { bodyCutoff } from '../../../core/db/body-limit.js'
import { serverSearch } from '../../../core/imap/server-search.js'
import { searchOldPop3 } from '../../../core/pop3/local-search.js'
import { foldForSearch, searchWords } from '../../../core/mime/text.js'
import { errCode } from '../../../core/log-safe.js'

export const SEARCH_CHANNELS = Object.freeze(['search:local', 'search:server', 'search:pop3Old', 'search:cancel'])
export const MAX_RESULTS = 500

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype
const isId = v => Number.isInteger(v) && v > 0
const optString = (v, max) => v === undefined || v === null || (typeof v === 'string' && v.length <= max)
const optTime = v => v === undefined || v === null || (Number.isFinite(v) && v >= 0 && v < 8.64e15)
const optBool = v => v === undefined || v === null || typeof v === 'boolean'

class BadRequest extends Error {}

/** Validates the search box + filter panel. Returns normalized filters or throws BadRequest. */
export function parseSearchRequest(q) {
  if (!isPlainObject(q)) throw new BadRequest()
  const ok =
    typeof q.query === 'string' && q.query.length <= 500 &&
    (q.accountId === undefined || q.accountId === null || isId(q.accountId)) &&
    optString(q.folder, 1000) && optString(q.from, 200) && optString(q.to, 200) &&
    optTime(q.since) && optTime(q.before) &&
    optBool(q.hasAttachment) && optBool(q.unread) && optBool(q.flagged) &&
    (q.label === undefined || q.label === null || (Number.isSafeInteger(q.label) && q.label > 0)) &&
    (q.sort === undefined || q.sort === 'relevance' || q.sort === 'date')
  if (!ok) throw new BadRequest()
  return {
    query: q.query.trim(),
    accountId: q.accountId ?? null,
    folder: q.folder || null,
    from: q.from ? q.from.trim() : null,
    to: q.to ? q.to.trim() : null,
    since: q.since ?? null,
    before: q.before ?? null,
    hasAttachment: Boolean(q.hasAttachment),
    unread: Boolean(q.unread),
    flagged: Boolean(q.flagged),
    label: q.label ?? null,
    sort: q.sort || 'relevance',
  }
}

const hasFlag = (flags, f) => (flags || '').split(' ').includes(f)

/**
 * The filters of the panel applied to a row found outside the index (server / old POP3 text). `labelsOf`: the rows'
 * label ids (Labels.labelsOfRows); a label filter without it matches nothing.
 */
export function matchesFilters(row, f, labelsOf = null) {
  if (f.accountId && row.account_id !== f.accountId) return false
  if (f.folder && row.folder.toLowerCase() !== f.folder.toLowerCase()) return false
  if (f.since !== null && !(row.date >= f.since)) return false
  if (f.before !== null && !(row.date < f.before)) return false
  if (f.hasAttachment && !row.has_attachments) return false
  if (f.unread && hasFlag(row.flags, '\\Seen')) return false
  if (f.flagged && !hasFlag(row.flags, '\\Flagged')) return false
  if (f.label && !(labelsOf?.get(row.id) || []).includes(f.label)) return false
  const contains = (text, needle) => {
    const t = foldForSearch(text)
    return searchWords(needle).every(w => t.includes(foldForSearch(w)))
  }
  if (f.from && !contains(`${row.from_name || ''} ${row.from_addr || ''}`, f.from)) return false
  if (f.to && !contains(`${row.to_addrs || ''} ${row.cc_addrs || ''}`, f.to)) return false
  return true
}

/** Only what the result list shows; `labels`: the row's label ids (core/db/labels.js). */
export function resultRow(m, accountName, labels = []) {
  return {
    id: m.id,
    account_id: m.account_id,
    account: accountName,
    folder: m.folder,
    from_name: m.from_name,
    from_addr: m.from_addr,
    subject: m.subject,
    date: m.date,
    flags: m.flags,
    has_attachments: m.has_attachments,
    snip: m.snip ?? null,
    labels,
  }
}

/**
 * "Keresés a szerveren is": the IMAP accounts in scope, folder by folder, below their index limit.
 * Shared by the search:server IPC and the MCP search_server tool. onHits(rows, accountName) gets the
 * rows that pass the filters. Returns { hits, errors, failedFolders, cancelled, done, total }.
 */
export async function runServerSearch({ f, accounts, store, index, manager, signal, labels = null, now = () => Date.now(), onProgress = () => {}, onHits = () => {} }) {
  const t = now()
  const plan = accounts
    .map(a => {
      const row = store.getRow(a.id)
      const folders = f.folder ? [f.folder] : index.folderList(a.id).filter(x => !x.is_local).map(x => x.path)
      return { row, folders, cutoff: bodyCutoff(row, t) }
    })
    .filter(p => p.cutoff !== null && p.folders.length)
  const total = plan.reduce((n, p) => n + p.folders.length, 0)
  let base = 0
  let hits = 0
  const errors = []
  const failedFolders = []
  let cancelled = false
  for (const p of plan) {
    if (signal.aborted) {
      cancelled = true
      break
    }
    try {
      const res = await manager.withConnection(p.row.id, client =>
        serverSearch({
          client,
          index,
          account: p.row,
          query: f.query,
          cutoffMs: p.cutoff,
          folders: p.folders,
          signal,
          onProgress: pr => onProgress({ done: base + pr.done, total, folder: pr.folder, account: p.row.name }),
          onHits: rows => {
            const labelsOf = f.label && labels ? labels.labelsOfRows(rows.map(r => r.id)) : null
            const shown = rows.filter(r => matchesFilters(r, f, labelsOf))
            hits += shown.length
            if (shown.length) onHits(shown, p.row.name)
          },
        }),
      )
      failedFolders.push(...res.failedFolders.map(folder => ({ account: p.row.name, folder })))
      if (res.cancelled) cancelled = true
    } catch (err) {
      errors.push({ account: p.row.name, code: err.code || 'unknown' })
    }
    base += p.folders.length
  }
  return { hits, errors, failedFolders, cancelled, done: cancelled ? base : total, total }
}

/**
 * @param db        better-sqlite3 (POP3 old-text rows)
 * @param index     MailIndex
 * @param store     AccountStore (list, getRow)
 * @param manager   SyncManager (withConnection: the IMAP account's interactive connection)
 * @param sealed    SealedStore of data/store: the POP3 old-text search reads through it
 * @param notify    app:status sender
 */
export function registerSearchIpc({ ipcMain, db, index, store, manager, sealed, notify, labels = null, isTrustedSender, log = () => {}, now = () => Date.now(), messageTextOf = undefined }) {
  const jobs = new Map() // source -> { id, controller }
  let seq = 0

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

  const accountsInScope = f => store.list().filter(a => !f.accountId || a.id === f.accountId)
  // the hits with their label ids: one query per batch (the local page, a folder's server hits, a POP3 hit)
  const shown = (rows, nameOf) => {
    const of = labels ? labels.labelsOfRows(rows.map(r => r.id)) : new Map()
    return rows.map(r => resultRow(r, nameOf(r), of.get(r.id) || []))
  }
  const names = () => new Map(store.list().map(a => [a.id, a.name]))

  handle('search:local', async q => {
    const f = parseSearchRequest(q)
    const scope = accountsInScope(f)
    const nameOf = names()
    const empty = !f.query && !f.from && !f.to
    const rows = empty
      ? []
      : index.search({
          accountId: f.accountId,
          query: f.query,
          from: f.from,
          to: f.to,
          folder: f.folder,
          since: f.since !== null ? new Date(f.since) : null,
          before: f.before !== null ? new Date(f.before) : null,
          hasAttachment: f.hasAttachment,
          unread: f.unread,
          flagged: f.flagged,
          label: f.label,
          sort: f.sort,
          limit: MAX_RESULTS,
        })
    // the line under the list: how many messages of the scope are searchable by their headers only
    const headersOnly = scope
      .map(a => ({ accountId: a.id, name: a.name, type: a.type, count: index.stats(a.id).headers_only || 0 }))
      .filter(x => x.count > 0)
    return {
      rows: shown(rows, m => nameOf.get(m.account_id)),
      truncated: rows.length >= MAX_RESULTS,
      headersOnly,
      scope: { imap: scope.some(a => a.type === 'imap'), pop3: scope.some(a => a.type === 'pop3') },
    }
  })

  function startJob(source, run) {
    const prev = jobs.get(source)
    if (prev) prev.controller.abort()
    const id = ++seq
    const controller = new AbortController()
    jobs.set(source, { id, controller })
    const send = payload => notify({ kind: 'search', jobId: id, source, ...payload })
    run({ signal: controller.signal, send })
      .catch(err => {
        log(`search ${source} failed: ${errCode(err)}`)
        send({ finished: { error: 'internal' } })
      })
      .finally(() => {
        if (jobs.get(source) && jobs.get(source).id === id) jobs.delete(source)
      })
    return { jobId: id }
  }

  handle('search:server', async q => {
    const f = parseSearchRequest(q)
    if (!searchWords(f.query).length) throw new BadRequest()
    const accounts = accountsInScope(f).filter(a => a.type === 'imap')
    return startJob('server', async ({ signal, send }) => {
      const finished = await runServerSearch({
        f,
        accounts,
        store,
        index,
        manager,
        signal,
        labels,
        now,
        onProgress: progress => send({ progress }),
        onHits: (rows, accountName) => send({ hits: shown(rows, () => accountName) }),
      })
      send({ progress: { done: finished.done, total: finished.total }, finished: { hits: finished.hits, errors: finished.errors, failedFolders: finished.failedFolders, cancelled: finished.cancelled } })
    })
  })

  handle('search:pop3Old', async q => {
    const f = parseSearchRequest(q)
    if (!searchWords(f.query).length) throw new BadRequest()
    const accounts = accountsInScope(f).filter(a => a.type === 'pop3')
    const nameOf = names()
    return startJob('pop3Old', async ({ signal, send }) => {
      let hits = 0
      const res = await searchOldPop3({
        db,
        sealed,
        accountIds: accounts.map(a => a.id),
        query: f.query,
        signal,
        onProgress: progress => send({ progress }),
        // the message's searchable text on the worker thread (undefined: made here)
        ...(messageTextOf ? { textOf: messageTextOf } : {}),
        onHit: id => {
          const row = index.get(id)
          if (row && matchesFilters(row, f, f.label && labels ? labels.labelsOfRows([row.id]) : null)) {
            hits++
            send({ hits: shown([row], r => nameOf.get(r.account_id)) })
          }
        },
      })
      send({ finished: { hits, skipped: res.skipped, cancelled: res.cancelled, total: res.total } })
    })
  })

  handle('search:cancel', async jobId => {
    if (!isId(jobId)) throw new BadRequest()
    for (const job of jobs.values()) if (job.id === jobId) job.controller.abort()
    return {}
  })

  return { jobs }
}
