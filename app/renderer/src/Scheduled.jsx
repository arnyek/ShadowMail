// SPDX-License-Identifier: GPL-3.0-or-later
// The "Időzített" view: every account's scheduled messages in one list, the earliest first. Per row: the time,
// the account, the recipients, the subject and the state (waiting, a retry's time and error, failed, late,
// interrupted, open in a composer), and the actions: Megnyitás (in a composer), Időpont módosítása, Küldés most
// (an interrupted or uncertain send asks first: it may have gone out), Időzítés törlése (back to Drafts).
// The rows come from the main process (scheduled:list) and reload on its { kind: 'scheduledList' } event.
import { useCallback, useEffect, useState } from 'react'
import { t, locale } from '../i18n/index.js'
import { Button, Modal, PageHeader } from './ui/index.js'
import { ScheduleDialog } from './ScheduleDialog.jsx'

const api = window.shadowMail

/** The scheduled rows of every account (null until the first answer); reloads on the main process's event. */
export function useScheduledRows() {
  const [rows, setRows] = useState(null)
  const load = useCallback(async () => {
    try {
      const r = await api.scheduled.list()
      if (r && r.ok) setRows(r.rows)
    } catch {
      // locked or closing: the list stays as it was
    }
  }, [])
  useEffect(() => {
    load()
    return api.onStatus(e => {
      if (e && (e.kind === 'scheduledList' || e.kind === 'scheduled')) load()
    })
  }, [load])
  return rows
}

const whenFmt = () => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' })

/** A send of it was cut off after it may have reached the server (the app stopped, or no answer after the data). */
export const mayHaveGone = row => row.state === 'failed' && (row.lastError === 'interrupted' || row.lastError === 'uncertain')

/** The state line of a row. */
export function stateText(row, fmt = whenFmt()) {
  const ts = t.scheduledList
  if (row.held) return ts.states.held
  if (row.state === 'sending') return ts.states.sending
  if (row.state === 'late') return ts.states.late
  if (row.state === 'failed') return row.lastError === 'interrupted' ? ts.states.interrupted : row.lastError === 'uncertain' ? ts.states.uncertain : ts.failed(row.lastError)
  if (row.attempts > 0 && row.nextTryAt) return ts.retry(fmt.format(new Date(row.nextTryAt)), row.lastError)
  return ts.states.waiting
}

export function ScheduledList({ rows, onNotice = () => {}, onError = () => {}, now = () => Date.now() }) {
  const ts = t.scheduledList
  const [busy, setBusy] = useState(null) // the row id an action runs on
  const [moving, setMoving] = useState(null) // the row whose time is being changed
  const [asking, setAsking] = useState(null) // the interrupted row "Küldés most" asks about
  const fmt = whenFmt()

  const run = async (id, fn, done = () => {}) => {
    setBusy(id)
    onError(null)
    try {
      const r = await fn()
      if (r && r.ok) done(r)
      else onError(ts.error(r && r.error))
    } catch {
      onError(ts.error('internal'))
    } finally {
      setBusy(null)
    }
  }
  const open = row => run(row.id, () => api.compose.open({ mode: 'scheduled', scheduledId: row.id }))
  const sendNow = row => run(row.id, () => api.scheduled.sendNow(row.id))
  const cancel = row => run(row.id, () => api.scheduled.cancel(row.id), () => onNotice(ts.cancelled(row.subject)))

  if (rows === null) return <section className="scheduled-list" aria-busy="true" />
  return (
    <section className="scheduled-list" aria-label={ts.title}>
      <PageHeader title={ts.title} subtitle={ts.subtitle} />
      {!rows.length ? (
        <p className="hint pad scheduled-empty">{ts.empty}</p>
      ) : (
        <ul className="scheduled-rows">
          {rows.map(row => {
            const locked = row.held || row.state === 'sending' || busy === row.id
            const subject = row.subject || ts.noSubject
            return (
              <li key={row.id} className="scheduled-row" data-id={row.id} data-state={row.held ? 'held' : mayHaveGone(row) ? row.lastError : row.state}>
                <div className="scheduled-main">
                  <span className="scheduled-when">{fmt.format(new Date(row.sendAt))}</span>
                  <span className="scheduled-subject">
                    {subject}
                    {row.claude && <span className="claude-mark" title={t.claudeMarkTitle}>{t.claudeMark}</span>}
                  </span>
                  <span className="scheduled-recipients">{row.recipients || ts.noRecipients}</span>
                  <span className="scheduled-account">{row.accountName}</span>
                  <span className={`scheduled-state${row.state === 'failed' || row.state === 'late' ? ' warn' : ''}`}>{stateText(row, fmt)}</span>
                </div>
                <div className="scheduled-actions" role="group" aria-label={ts.actionsOf(subject)}>
                  <Button variant="outlined" className="scheduled-open" disabled={row.state === 'sending' || busy === row.id} onClick={() => open(row)}>
                    {ts.open}
                  </Button>
                  <Button variant="text" className="scheduled-reschedule" disabled={locked} onClick={() => setMoving(row)}>
                    {ts.reschedule}
                  </Button>
                  <Button variant="text" className="scheduled-send-now" disabled={locked} onClick={() => (mayHaveGone(row) ? setAsking(row) : sendNow(row))}>
                    {ts.sendNow}
                  </Button>
                  <Button variant="text" className="scheduled-cancel" disabled={locked} onClick={() => cancel(row)}>
                    {ts.cancel}
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {moving && (
        <ScheduleDialog
          now={now()}
          title={ts.reschedule}
          okLabel={ts.rescheduleOk}
          className="scheduled-move-modal"
          onCancel={() => setMoving(null)}
          onPick={at => {
            const row = moving
            setMoving(null)
            run(row.id, () => api.scheduled.reschedule(row.id, at))
          }}
        />
      )}
      {asking && (
        <Modal
          title={ts.interruptedTitle}
          role="alertdialog"
          className="scheduled-interrupted-modal"
          onClose={() => setAsking(null)}
          actions={[
            <Button key="no" variant="text" onClick={() => setAsking(null)} data-autofocus>
              {ts.interruptedNo}
            </Button>,
            <Button
              key="yes"
              variant="primary"
              className="scheduled-interrupted-yes"
              onClick={() => {
                const row = asking
                setAsking(null)
                sendNow(row)
              }}
            >
              {ts.interruptedYes}
            </Button>,
          ]}
        >
          <p>{ts.interruptedText}</p>
        </Modal>
      )}
    </section>
  )
}
