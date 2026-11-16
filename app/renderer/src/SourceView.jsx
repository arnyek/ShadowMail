// SPDX-License-Identifier: GPL-3.0-or-later
// Source view: the message's header block with a short summary, and
// its whole raw text, as TEXT only. Everything is a React text node in a <pre> (never innerHTML, never the mail-view:
// frame), so no link is live and no image loads. Control and direction characters are visible marks.
// The data comes from mail:source (H1): the stored copy or a download WITHOUT \Seen; at most 2 MB is shown.
import { useEffect, useId, useMemo, useState } from 'react'
import { t, locale } from '../i18n/index.js'
import { controlParts, markCount, markOf, markRuns } from './control-marks.js'
import { partBlocks } from '../../../core/mime/text-blocks.js'
import { copyAsText } from './copy-text.js'
import { Banner, Button, Modal } from './ui/index.js'

const api = window.shadowMail
export const SOURCE_TABS = ['headers', 'original']
const dateTimeFmt = new Intl.DateTimeFormat(locale, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' })

/**
 * The text, every invisible character as its own, differently colored "⟨U+XXXX⟩" element (control-marks.js: the same
 * set everywhere, the summary included). Past MAX_MARKS no more marks: the rest of them are left out and a closing line
 * says how many; a text that would grow past the 2 MB cap with its marks is cut, and the closing line says so.
 */
function Marked({ text, result = null }) {
  const own = useMemo(() => (result ? null : controlParts(text)), [text, result])
  const { parts, unmarked, cut } = result || own
  // in blocks (a run of marks is never cut), each its own block element
  const blocks = useMemo(() => partBlocks(markRuns(parts)), [parts])
  return (
    <>
      {blocks.map((block, b) => (
        <span key={b} className="text-block">
          {block.map((p, i) =>
            typeof p === 'string' ? (
              p
            ) : (
              // neighbouring marks share one element (drawing cost); each still reads "⟨U+XXXX⟩"
              <span key={i} className="ctl-mark" title={p.marks.length === 1 ? t.source.markTitle(p.marks[0]) : undefined}>
                {p.marks.map(markOf).join('')}
              </span>
            ),
          )}
        </span>
      ))}
      {unmarked > 0 && <span className="ctl-summary">{`\n${t.source.unmarked(unmarked)}`}</span>}
      {cut && <span className="ctl-summary">{`\n${t.source.cutByMarks}`}</span>}
    </>
  )
}

/** pass = green, fail/softfail = red, anything else (and none at all) = grey; always with its text. */
export function authTone(result) {
  if (result === 'pass') return 'ok'
  if (result === 'fail' || result === 'softfail') return 'bad'
  return 'neutral'
}

function AuthValue({ result }) {
  return (
    <span className={`auth-value auth-${authTone(result)}`} data-result={result || 'missing'}>
      <span className="auth-dot" aria-hidden="true" />
      {result ? t.source.authResults[result] || result : t.source.authMissing}
    </span>
  )
}

function Summary({ summary }) {
  const r = t.source.rows
  const auth = summary.auth
  const rows = [
    ['from', summary.from],
    ['to', summary.to],
    ['cc', summary.cc],
    ['date', summary.date && dateTimeFmt.format(new Date(summary.date))],
    ['subject', summary.subject],
    ['messageId', summary.messageId],
  ].filter(([key, value]) => value || key !== 'cc')
  return (
    <div className="source-summary">
      <table aria-label={t.source.summaryLabel}>
        <tbody>
          {rows.map(([key, value]) => (
            <tr key={key} data-row={key}>
              <th scope="row">{r[key]}</th>
              <td><Marked text={value || '–'} /></td>
            </tr>
          ))}
          {['spf', 'dkim', 'dmarc'].map(m => (
            <tr key={m} data-row={m}>
              <th scope="row">{r[m]}</th>
              <td><AuthValue result={auth ? auth[m] : null} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint source-auth-note">{auth && auth.by ? <Marked text={t.source.authBy(auth.by)} /> : t.source.authNone}</p>
    </div>
  )
}

/**
 * messageId: the message; initialTab: 'headers' | 'original'; onClose: Esc and the Close button (the Modal gives the
 * focus back to where it was, the reader's More button).
 */
export function SourceView({ messageId, initialTab = 'headers', onClose }) {
  const [view, setView] = useState(null)
  const [error, setError] = useState(null)
  const [tab, setTab] = useState(SOURCE_TABS.includes(initialTab) ? initialTab : 'headers')
  const [notice, setNotice] = useState(null)
  const [saving, setSaving] = useState(false)
  const uid = useId()

  useEffect(() => {
    let live = true
    api.mail.source(messageId).then(res => {
      if (!live) return
      if (res.ok) setView(res)
      else setError(res.error)
    })
    return () => {
      live = false
    }
  }, [messageId])

  const save = async () => {
    setSaving(true)
    setNotice(null)
    const res = await api.mail.saveSource(messageId)
    setSaving(false)
    if (!res.ok) setNotice({ kind: 'error', text: t.readerError(res.error) })
    else if (res.saved) setNotice({ kind: 'info', text: t.source.saved })
  }

  const onTabKey = e => {
    const i = SOURCE_TABS.indexOf(tab)
    let next = null
    if (e.key === 'ArrowRight') next = SOURCE_TABS[(i + 1) % SOURCE_TABS.length]
    else if (e.key === 'ArrowLeft') next = SOURCE_TABS[(i - 1 + SOURCE_TABS.length) % SOURCE_TABS.length]
    else if (e.key === 'Home') next = SOURCE_TABS[0]
    else if (e.key === 'End') next = SOURCE_TABS[SOURCE_TABS.length - 1]
    if (!next) return
    e.preventDefault()
    setTab(next)
    const el = document.getElementById(`${uid}-tab-${next}`)
    if (el) el.focus()
  }

  const shown = view ? (tab === 'headers' ? view.headers : view.text) : ''
  // one pass over the shown text: the marks of the <pre> and their count
  const shownMarks = useMemo(() => controlParts(shown), [shown])
  // the hint names the drawn marks, and the left-out ones apart (the sum alone would read as all of them drawn)
  const marks = markCount(shownMarks) - shownMarks.unmarked

  return (
    <Modal title={t.source.title} className="source-modal" onClose={onClose} actions={<Button variant="primary" onClick={onClose}>{t.close}</Button>}>
      <div className="source-bar">
        <div className="source-tabs" role="tablist" aria-label={t.source.tabsLabel} onKeyDown={onTabKey}>
          {SOURCE_TABS.map(id => (
            <button
              key={id}
              type="button"
              role="tab"
              id={`${uid}-tab-${id}`}
              className={`source-tab${tab === id ? ' selected' : ''}`}
              aria-selected={tab === id}
              aria-controls={`${uid}-panel`}
              tabIndex={tab === id ? 0 : -1}
              data-tab={id}
              data-autofocus={tab === id ? true : undefined}
              onClick={() => setTab(id)}
            >
              {t.source.tabs[id]}
            </button>
          ))}
        </div>
        <Button variant="outlined" icon="download" className="source-save" disabled={saving} onClick={save}>
          {t.source.save}
        </Button>
      </div>
      {notice && (
        <Banner kind={notice.kind} className="source-notice" onClose={() => setNotice(null)} closeLabel={t.close}>
          {notice.text}
        </Banner>
      )}
      <div className="source-panel" role="tabpanel" id={`${uid}-panel`} aria-labelledby={`${uid}-tab-${tab}`} tabIndex={0} aria-busy={!view && !error}>
        {error && <p className="error" role="alert">{t.readerError(error)}</p>}
        {!view && !error && <p className="hint">{t.source.loading}</p>}
        {view && tab === 'headers' && (
          <>
            <Summary summary={view.summary} />
            {view.headersTruncated && <Banner kind="warning" className="source-truncated">{t.source.headersTruncated}</Banner>}
            {marks > 0 && <p className="hint source-marks">{t.source.marks(marks, shownMarks.unmarked)}</p>}
            <h3 className="source-heading">{t.source.rawHeaders}</h3>
            {view.headers ? <pre className="source-text source-headers" onCopy={copyAsText}><Marked text={view.headers} result={shownMarks} /></pre> : <p className="hint">{t.source.noHeaders}</p>}
          </>
        )}
        {view && tab === 'original' && (
          <>
            {view.truncated && (
              <Banner kind="warning" className="source-truncated" id={`${uid}-truncated`}>
                {t.source.truncated(t.sizeKb(view.size))}
              </Banner>
            )}
            {marks > 0 && <p className="hint source-marks">{t.source.marks(marks, shownMarks.unmarked)}</p>}
            <pre className="source-text source-original" onCopy={copyAsText}><Marked text={view.text} result={shownMarks} /></pre>
          </>
        )}
      </div>
    </Modal>
  )
}
