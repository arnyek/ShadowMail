// SPDX-License-Identifier: GPL-3.0-or-later
// Global search: the search box, the filter panel and the result list. The local
// search runs 300 ms after typing stops; "Keresés a szerveren is" (IMAP) and "Keresés a régi levelek
// szövegében is" (POP3) are background jobs whose hits are added under the local ones, marked, without
// duplicates. Esc leaves the search (the folder view comes back).
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { t } from '../i18n/index.js'
import { Button, Chip, ChipMenu, ChipPanel, ChipSelect, IconButton, SearchField, TextField } from './ui/index.js'
import { RowText } from './RowText.jsx'
import { Icon } from './Icon.jsx'
import { assignRoles } from '../../../core/imap/folders.js'
import { RECIPIENT_ROLES } from '../../../core/mime/recipient-label.js'

const api = window.shadowMail
export const SEARCH_DELAY_MS = 300
export const EMPTY_FILTERS = Object.freeze({ accountId: null, folder: '', from: '', to: '', since: '', until: '', hasAttachment: false, unread: false, flagged: false, label: null, sort: 'relevance' })

const hasFlag = (flags, flag) => (flags || '').split(' ').includes(flag)

/** Is anything to search for? (a query, or a sender / recipient filter) */
export function searchActive(text, filters) {
  return Boolean(text.trim() || filters.from.trim() || filters.to.trim())
}

// A date field's local day (yyyy-mm-dd) -> epoch ms of its local midnight, `plus` days later:
// setFullYear keeps the years 0-99 (new Date(y, ...) maps them to 1900-1999), and the next
// day's midnight is a calendar day, so a DST day is 23 or 25 hours long, not 24
const day = (s, plus = 0) => {
  const [y, m, d] = s.split('-').map(Number)
  const t = new Date(2000, 0, 1)
  t.setFullYear(y, m - 1, d + plus)
  t.setHours(0, 0, 0, 0)
  return t.getTime()
}

/**
 * The panel's state -> the IPC request. Dates are local days: "until" includes the whole day. Mail dates are after
 * 1970: a day before it searches the same as 0, which search:local accepts (it refused a negative time).
 */
export function toRequest(text, f) {
  return {
    query: text.trim(),
    accountId: f.accountId,
    folder: f.folder || null,
    from: f.from.trim() || null,
    to: f.to.trim() || null,
    since: f.since ? Math.max(0, day(f.since)) : null,
    before: f.until ? Math.max(0, day(f.until, 1)) : null,
    hasAttachment: f.hasAttachment,
    unread: f.unread,
    flagged: f.flagged,
    label: f.label,
    sort: f.sort,
  }
}

/**
 * Since 0.10.1: the chips that filter the folder view as well -> the mail:list /
 * mail:ids filter (only the ones that are on; the same day rule as the search).
 */
export function toListFilter(f) {
  const out = {}
  if (f.unread) out.unread = true
  if (f.flagged) out.flagged = true
  if (f.label) out.label = f.label
  if (f.hasAttachment) out.hasAttachment = true
  // mail dates are after 1970: a day before it filters the same as 0, which the list accepts (#3)
  if (f.since) out.since = Math.max(0, day(f.since))
  if (f.until) out.before = Math.max(0, day(f.until, 1))
  return out
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
/**
 * Claude's show_search conditions (app/main/mcp/tools.js searchConditions, already checked there)
 * -> the panel's state. Anything else is the empty filter's value: an event never puts a foreign type into the state.
 */
export function fromConditions(c) {
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '')
  return {
    accountId: Number.isInteger(c.accountId) && c.accountId > 0 ? c.accountId : null,
    folder: str(c.folder, 1000),
    from: str(c.from, 200),
    to: str(c.to, 200),
    since: typeof c.since === 'string' && DAY_RE.test(c.since) ? c.since : '',
    until: typeof c.until === 'string' && DAY_RE.test(c.until) ? c.until : '',
    hasAttachment: c.hasAttachment === true,
    unread: c.unread === true,
    flagged: c.flagged === true,
    label: null,
    sort: c.sort === 'date' ? 'date' : 'relevance',
  }
}

/** Is a folder-view filter on? (then the chip row stays open and the list says "szűrve") */
export function listFilterOn(f) {
  return Object.keys(toListFilter(f)).length > 0
}

/**
 * Esc in the search field leaves the SEARCH only: the query's own fields go
 * (sender, recipient, the account / folder scope, the relevance order); the folder filters stay, they
 * end only when switched off or with "Szűrők törlése".
 */
export function leftSearch(f) {
  return { ...f, from: '', to: '', accountId: null, folder: '', sort: EMPTY_FILTERS.sort }
}

/** Every filter off, the search's own order kept (Szűrők törlése). */
export function clearedFilters(f) {
  return { ...EMPTY_FILTERS, sort: f.sort }
}

/** "…a «számla» összege…" -> text with <mark> parts; React escapes the rest. */
function Snippet({ text }) {
  if (!text) return null
  const parts = []
  let rest = text
  let key = 0
  while (rest) {
    const a = rest.indexOf('«')
    const b = a >= 0 ? rest.indexOf('»', a) : -1
    if (a < 0 || b < 0) {
      parts.push(rest)
      break
    }
    if (a > 0) parts.push(rest.slice(0, a))
    parts.push(<mark key={key++}>{rest.slice(a + 1, b)}</mark>)
    rest = rest.slice(b + 1)
  }
  return parts
}

/** "Fiók: <name>" with the name cut at 160 px (CSS .chip-value); the full text is the chip's title. */
function ChipValue({ label, value }) {
  return (
    <>
      {label}: <span className="chip-value">{value}</span>
    </>
  )
}

/**
 * The filter chips. With a search: account (and its folder), sender /
 * recipient, dates, attachment, unread, starred and the order of the hits, the same request as the
 * search panel. Without one (`view` = the open folder): the attachment / unread / starred / date chips filter
 * the folder list, the account and folder chips open that account's INBOX or that folder
 * (`onNavigate`), and the order is the list's own (`listSort`, `sortItems`: the More menu's items).
 * `labels`: the label list (0.17.0); the Label chip (one label, in the search and in the folder view alike) shows
 * when there is a label or one is chosen.
 * The folder view's row fits one line at 1280 px: names cut at 160 px, the order as
 * "Dátum ↓"; the full texts stay the accessible names and tooltips.
 */
export function SearchChips({ accounts, filters, onChange, searching = true, view = null, onNavigate, listSort, sortItems, labels = [] }) {
  const set = patch => onChange({ ...filters, ...patch })
  const folderView = !searching && view
  const account = accounts.find(a => a.id === (folderView ? view.accountId : filters.accountId))
  const people = t.searchPeople(filters.from.trim(), filters.to.trim())
  const dated = Boolean(filters.since || filters.until)
  const inboxOf = a => (a.folders.find(f => f.path.toUpperCase() === 'INBOX') || a.folders[0])?.path
  // the role's Hungarian name, as the tree and the Move menu show it ("Beérkezett (INBOX)" in the menu)
  const roles = folderView && account ? assignRoles(account.folders) : new Map()
  // Sent / Drafts: the "from" order is by the recipient there (Mail.jsx isRecipientFolder), and the chip says so
  const sortField = listSort && listSort.sort === 'from' && RECIPIENT_ROLES.has(roles.get(view?.folder)) ? 'recipient' : listSort?.sort
  const folderName = (path, withPath = false) => {
    const role = roles.get(path)
    if (!role) return path
    return withPath ? `${t.folderRoles[role]} (${path})` : t.folderRoles[role]
  }
  // on the chip only the last level ("Példa Kft."); the full path is its name and tooltip
  const folderLeaf = path => {
    if (roles.get(path)) return folderName(path)
    const d = account?.folders.find(f => f.path === path)?.delimiter
    return d ? path.split(d).pop() : path
  }
  return (
    <div className="search-chips" role="group" aria-label={t.searchFiltersLabel}>
      {folderView ? (
        // where the list is: never "active" (no check mark), a pick navigates
        <>
          <ChipMenu
            label={t.searchFilter.account}
            text={`${t.searchFilter.account}: ${account ? account.name : ''}`}
            display={<ChipValue label={t.searchFilter.account} value={account ? account.name : ''} />}
            className="account-chip"
            items={accounts
              .filter(a => inboxOf(a))
              .map(a => ({ key: String(a.id), label: a.name, checked: a.id === view.accountId, onSelect: () => onNavigate({ accountId: a.id, folder: inboxOf(a) }) }))}
          />
          {account && (
            <ChipMenu
              label={t.searchFilter.folder}
              text={`${t.searchFilter.folder}: ${folderName(view.folder)}`}
              display={<ChipValue label={t.searchFilter.folder} value={folderLeaf(view.folder)} />}
              className="folder-chip"
              items={account.folders.map(f => ({ key: f.path, label: folderName(f.path, true), checked: f.path === view.folder, onSelect: () => onNavigate({ accountId: account.id, folder: f.path }) }))}
            />
          )}
        </>
      ) : (
        <>
          <ChipSelect
            label={t.searchFilter.account}
            value={filters.accountId}
            options={[{ value: null, label: t.searchAllAccounts }, ...accounts.map(a => ({ value: a.id, label: a.name }))]}
            onChange={v => set({ accountId: v, folder: '' })}
          />
          {/* a folder set without an account (Claude's show_search: that folder in every account), or one the
              account does not list, is still the chip's value; otherwise the chip would say "every folder" */}
          {(account || filters.folder) && (
            <ChipSelect
              label={t.searchFilter.folder}
              value={filters.folder}
              options={[
                { value: '', label: t.searchAllFolders },
                ...(account ? account.folders.map(f => ({ value: f.path, label: f.path })) : []),
                ...(filters.folder && !(account && account.folders.some(f => f.path === filters.folder)) ? [{ value: filters.folder, label: filters.folder }] : []),
              ]}
              onChange={v => set({ folder: v })}
            />
          )}
        </>
      )}
      <ChipPanel label={t.searchFilter.from} active={Boolean(people)} value={people}>
        <TextField label={t.searchFilter.from} value={filters.from} onChange={e => set({ from: e.target.value })} spellCheck={false} />
        <TextField label={t.searchFilter.to} value={filters.to} onChange={e => set({ to: e.target.value })} spellCheck={false} />
      </ChipPanel>
      <ChipPanel label={t.searchAnyTime} active={dated} value={dated ? t.searchDateRange(filters.since, filters.until) : null}>
        <TextField type="date" label={t.searchFilter.since} value={filters.since} onChange={e => set({ since: e.target.value })} />
        <TextField type="date" label={t.searchFilter.until} value={filters.until} onChange={e => set({ until: e.target.value })} />
      </ChipPanel>
      <Chip active={filters.hasAttachment} onClick={() => set({ hasAttachment: !filters.hasAttachment })}>{t.searchFilter.hasAttachment}</Chip>
      <Chip active={filters.unread} onClick={() => set({ unread: !filters.unread })}>{t.searchFilter.unread}</Chip>
      <Chip active={filters.flagged} onClick={() => set({ flagged: !filters.flagged })}>{t.searchFilter.flagged}</Chip>
      {labels.length || filters.label ? (
        <ChipSelect
          label={t.searchFilter.label}
          value={filters.label}
          className="label-filter-chip"
          options={[{ value: null, label: t.searchAnyLabel }, ...labels.map(l => ({ value: l.id, label: l.name, swatch: l.color }))]}
          onChange={v => set({ label: v })}
        />
      ) : null}
      <span className="search-chips-end">
        {folderView ? (
          <ChipMenu
            label={t.searchFilter.sort}
            text={t.listSortChip(sortField, listSort.dir)}
            display={
              <>
                {t.listSortField[sortField]}
                <Icon name={listSort.dir === 'asc' ? 'sortAsc' : 'sortDesc'} />
              </>
            }
            items={sortItems}
            className="sort-chip"
          />
        ) : (
          <ChipSelect
            label={t.searchFilter.sort}
            value={filters.sort}
            showValue
            options={[
              { value: 'relevance', label: t.searchSort.relevance },
              { value: 'date', label: t.searchSort.date },
            ]}
            onChange={v => set({ sort: v })}
          />
        )}
      </span>
    </div>
  )
}

function JobLine({ job, source, onCancel }) {
  if (!job) return null
  const p = job.progress
  const label = source === 'server' ? t.searchServerProgress : t.searchPop3Progress
  if (!job.finished) {
    return (
      <div className="search-job" role="status" data-source={source}>
        <span>{label(p)}</span>
        <Button variant="text" icon="close" onClick={onCancel}>{t.searchCancel}</Button>
      </div>
    )
  }
  return (
    <div className="search-job done" role="status" data-source={source}>
      <span>{source === 'server' ? t.searchServerDone(job.finished) : t.searchPop3Done(job.finished)}</span>
    </div>
  )
}

/** One hit, memoized: a background job adds hits by the thousand, the old rows stay as they are. */
const ResultRow = memo(function ResultRow({ m, source, selected, onOpen, labels = null, labelList = null }) {
  return (
    <li data-id={m.id} data-source={source} className={`result${selected ? ' selected' : ''}${hasFlag(m.flags, '\\Seen') ? '' : ' unread'}`}>
      <button type="button" className="result-open" onClick={() => onOpen.current(m.id)}>
        <RowText
          m={m}
          cell="span"
          subjectClass="result-subject"
          previewClass="result-snippet"
          preview={m.snip ? <Snippet text={m.snip} /> : null}
          labels={labels}
          labelList={labelList}
          before={
            <>
              <span className="tag result-where" title={`${m.account} · ${m.folder}`}>{m.account} · {m.folder}</span>
              {source === 'server' && <span className="badge">{t.searchFoundOnServer}</span>}
              {source === 'pop3Old' && <span className="badge">{t.searchFoundInOld}</span>}
            </>
          }
        />
      </button>
    </li>
  )
})

export function SearchResults({ request, accounts, selectedId, onOpen, idsRef = null, labelList = null, labelEvent = null }) {
  const openRef = useRef(onOpen)
  openRef.current = onOpen
  const [local, setLocal] = useState(null)
  const [extra, setExtra] = useState([]) // [{ row, source }]
  const [jobs, setJobs] = useState({}) // source -> { id, progress, finished }
  const jobIds = useRef({})
  // events of a job may arrive before its id does (the job starts before the invoke answers): kept here
  const early = useRef([])
  const reqKey = JSON.stringify(request)
  // the hits are not searched again on a change: a label put on or taken off (Mail's labelEvent) follows here, by id
  const [fixes, setFixes] = useState(() => new Map())

  useEffect(() => {
    if (!labelEvent || !api.mail.labelsOf) return
    // every shown hit asked again (mail:labelsOf, by the message's account and key): another copy of a changed message
    // (the same letter in another folder) follows too, not only the changed row ids
    const ids = [...new Set([...(local && local.rows ? local.rows : []), ...extra.map(x => x.row)].map(r => r.id))]
    let live = true
    ;(async () => {
      for (let i = 0; i < ids.length && live; i += 500) {
        const res = await api.mail.labelsOf(ids.slice(i, i + 500))
        if (!live || !res || !res.ok) return
        setFixes(prev => {
          const next = new Map(prev)
          for (const [id, ls] of Object.entries(res.labels)) next.set(Number(id), ls)
          return next
        })
      }
    })()
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [labelEvent])

  const cancelAll = () => {
    for (const id of Object.values(jobIds.current)) api.search.cancel(id)
    jobIds.current = {}
  }

  // a new request: the local search again, the background jobs of the old one stop
  useEffect(() => {
    let live = true
    cancelAll()
    setExtra([])
    setJobs({})
    setFixes(new Map())
    api.search.local(request).then(res => live && setLocal(res.ok ? res : { error: res.error }))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reqKey])

  useEffect(() => () => cancelAll(), [])

  const apply = ev => {
    if (ev.hits) setExtra(list => [...list, ...ev.hits.map(row => ({ row, source: ev.source }))])
    if (ev.progress || ev.finished) {
      setJobs(j => ({ ...j, [ev.source]: { ...j[ev.source], progress: ev.progress || (j[ev.source] && j[ev.source].progress), finished: ev.finished || null } }))
    }
  }

  useEffect(
    () =>
      api.onStatus(ev => {
        if (ev.kind !== 'search') return
        if (jobIds.current[ev.source] === ev.jobId) apply(ev)
        else if (!Object.values(jobIds.current).includes(ev.jobId)) early.current = [...early.current.slice(-200), ev]
      }),
    [],
  )

  const start = async source => {
    const res = await (source === 'server' ? api.search.server(request) : api.search.pop3Old(request))
    if (!res.ok) return
    jobIds.current = { ...jobIds.current, [source]: res.jobId }
    setExtra(list => list.filter(x => x.source !== source))
    setJobs(j => ({ ...j, [source]: { id: res.jobId, progress: null, finished: null } }))
    const mine = early.current.filter(ev => ev.jobId === res.jobId)
    early.current = early.current.filter(ev => ev.jobId !== res.jobId)
    mine.forEach(apply)
  }

  // local hits first; a message found again by a job is not repeated
  const rows = useMemo(() => {
    if (!local || !local.rows) return []
    const seen = new Set(local.rows.map(r => r.id))
    const out = local.rows.map(row => ({ row, source: 'local' }))
    for (const x of extra) {
      if (seen.has(x.row.id)) continue
      seen.add(x.row.id)
      out.push(x)
    }
    return out
  }, [local, extra])

  if (!local) return <section className="search-results" aria-busy="true"><p className="hint pad">{t.searchRunning}</p></section>
  if (local.error) return <section className="search-results"><p className="error pad">{t.readerError(local.error)}</p></section>
  // the reader's Up / Down and the next hit after a delete go by the shown order
  if (idsRef) idsRef.current = () => (rows ? rows.map(x => x.row.id) : [])
  const hasWords = /[\p{L}\p{N}]/u.test(request.query)

  return (
    <section className="search-results" aria-label={t.searchResultsLabel}>
      {/* the same row cells as the message list, with the account / folder chip in front */}
      <ol className="result-list" tabIndex={-1}>
        {rows.map(({ row: m, source }) => (
          <ResultRow key={m.id} m={m} source={source} selected={selectedId === m.id} onOpen={openRef} labels={fixes.get(m.id) ?? m.labels} labelList={labelList} />
        ))}
      </ol>
      {!rows.length && <p className="hint pad">{t.searchNoHits}</p>}
      <footer className="search-footer">
        <div className="hint">{t.searchCount(rows.length, local.truncated)}</div>
        {local.headersOnly.length > 0 && <div className="hint">{t.searchHeadersOnly(local.headersOnly.reduce((n, x) => n + x.count, 0))}</div>}
        {hasWords && (
          <div className="search-more">
            {local.scope.imap && (
              <span>
                <Button variant="outlined" icon="search" onClick={() => start('server')} disabled={jobs.server && !jobs.server.finished}>{t.searchOnServer}</Button>
                <span className="hint"> {t.searchOnServerHelp}</span>
              </span>
            )}
            {local.scope.pop3 && (
              <Button variant="outlined" icon="search" onClick={() => start('pop3Old')} disabled={jobs.pop3Old && !jobs.pop3Old.finished}>{t.searchInOld}</Button>
            )}
          </div>
        )}
        <JobLine job={jobs.server} source="server" onCancel={() => api.search.cancel(jobIds.current.server)} />
        <JobLine job={jobs.pop3Old} source="pop3Old" onCancel={() => api.search.cancel(jobIds.current.pop3Old)} />
      </footer>
    </section>
  )
}

/**
 * The search field in the header. Reports the debounced text; Esc leaves the search (the folder
 * filters stay). The
 * "Szűrők" button shows / hides the filter chips (they also show while a search runs, and while a
 * filter is on: `filtersLocked`).
 */
export function SearchBox({ text, onText, filtersOpen, filtersLocked = false, onFiltersOpen, onEscape }) {
  const [value, setValue] = useState(text)
  const timer = useRef(null)
  useEffect(() => setValue(text), [text])
  useEffect(() => () => clearTimeout(timer.current), [])
  const change = v => {
    setValue(v)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => onText(v), SEARCH_DELAY_MS)
  }
  const key = e => {
    if (e.key === 'Escape') {
      clearTimeout(timer.current)
      setValue('')
      onEscape()
    }
  }
  return (
    <div className="search-bar" onKeyDown={key}>
      <SearchField
        label={t.searchLabel}
        clearLabel={t.searchClear}
        placeholder={t.searchPlaceholder}
        value={value}
        onChange={e => change(e.target.value)}
        onClear={() => {
          clearTimeout(timer.current)
          setValue('')
          onText('')
        }}
        spellCheck={false}
      >
        {/* while a filter is on the row stays (a filter never hides itself) */}
        <IconButton
          icon="filters"
          className={filtersLocked ? 'filters-on' : undefined}
          label={t.searchFiltersButton}
          aria-expanded={filtersOpen || filtersLocked}
          onClick={() => onFiltersOpen(filtersLocked ? true : !filtersOpen)}
        />
      </SearchField>
    </div>
  )
}
