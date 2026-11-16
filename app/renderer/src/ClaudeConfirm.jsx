// SPDX-License-Identifier: GPL-3.0-or-later
// MCP: the user's confirmation of a request Claude made (send, delete for good,
// delete a folder or an account, change an account, restart a stopped login). One Modal at a time, the oldest
// first. Safe by default: the focus is on Elutasítás, Enter and Esc reject, Jóváhagyás works only after APPROVE_DELAY_MS.
// Everything here is React text: message content is never HTML. The main process runs what IT stored, never anything
// from this page: the page only says yes or no.
import { useEffect, useRef, useState } from 'react'
import { t } from '../i18n/index.js'
import { Button, Modal } from './ui/index.js'

export const APPROVE_DELAY_MS = 1500
export const TEXT_START = 1000
const ct = t.claudeConfirm

const join = list => (list && list.length ? list.join(', ') : null)

function Field({ label, children, className }) {
  return (
    <div className={['confirm-field', className].filter(Boolean).join(' ')}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

function SendView({ v }) {
  const [all, setAll] = useState(false)
  const text = v.text || ''
  const long = text.length > TEXT_START
  return (
    <>
      <dl className="confirm-fields">
        <Field label={ct.from}>{v.from.name ? `${v.from.name} <${v.from.address}>` : v.from.address}</Field>
        <Field label={ct.to}>{join(v.to) || ct.empty}</Field>
        {join(v.cc) && <Field label={ct.cc}>{join(v.cc)}</Field>}
        {join(v.bcc) && <Field label={ct.bcc}>{join(v.bcc)}</Field>}
        <Field label={ct.subject}>{v.subject || ct.noSubject}</Field>
        {v.attachments.length > 0 && (
          <Field label={ct.attachments}>
            <ul className="confirm-list">
              {v.attachments.map((a, i) => (
                <li key={i}>{`${a.name} (${t.sizeKb(a.size)})`}</li>
              ))}
            </ul>
          </Field>
        )}
      </dl>
      {v.links && v.links.length > 0 && (
        <>
          <p className="confirm-label">{ct.links}</p>
          <ul className="confirm-list confirm-links">
            {v.links.map((l, i) => (
              <li key={i}>
                <span>{l.text || ct.noText}</span>
                {' -> '}
                <span className="confirm-href">{l.href}</span>
              </li>
            ))}
          </ul>
          {v.linkCount > v.links.length && <p className="hint">{ct.linksMore(v.linkCount - v.links.length)}</p>}
        </>
      )}
      <p className="confirm-label">{ct.text}</p>
      <pre className="confirm-text">{(all || !long ? text : text.slice(0, TEXT_START) + '…') || ct.noText}</pre>
      {long && (
        <Button variant="text" className="confirm-expand" onClick={() => setAll(x => !x)}>
          {all ? ct.showStart : ct.showAll(text.length)}
        </Button>
      )}
    </>
  )
}

function DeleteMessagesView({ v }) {
  return (
    <>
      <p>{v.inTrash ? t.confirmDeleteTrash(v.count) : t.confirmDeleteNoTrash(v.count)}</p>
      <dl className="confirm-fields">
        <Field label={ct.account}>{`${v.account.name} <${v.account.email}>`}</Field>
        <Field label={ct.folder}>{v.folder}</Field>
      </dl>
      <ul className="confirm-list confirm-messages">
        {v.items.map((m, i) => (
          <li key={i}>
            <span className="confirm-subject">{m.subject || ct.noSubject}</span>
            {' – '}
            <span>{m.from}</span>
            {` (${m.folder})`}
          </li>
        ))}
      </ul>
      {v.count > v.items.length && <p className="hint">{ct.listMore(v.count - v.items.length)}</p>}
    </>
  )
}

const valueText = (field, value) => {
  if (value === null || value === undefined || value === '') return field === 'pop3_delete_after_days' ? ct.never : ct.empty
  if (typeof value === 'boolean') return value ? ct.on : ct.off
  if (field.endsWith('_security')) return t.securityLabels[value] || String(value)
  if (field === 'index_years' && value === 'all') return t.accountFields.index_all
  return String(value)
}
const fieldLabel = field => {
  const label = t.accountFields[field] || field
  if (field.startsWith('in_')) return `${t.accountFields.incoming}: ${label}`
  if (field.startsWith('smtp_')) return `${t.accountFields.smtp}: ${label}`
  return label
}

function UpdateAccountView({ v }) {
  const tlsOff = v.changes.some(c => c.field === 'tls_verify' && c.new === false)
  return (
    <>
      <dl className="confirm-fields">
        <Field label={ct.account}>{`${v.account.name} <${v.account.email}>`}</Field>
      </dl>
      <p className="confirm-label">{ct.changesHead}</p>
      <dl className="confirm-fields confirm-changes">
        {v.changes.map(c => (
          <Field key={c.field} label={fieldLabel(c.field)}>
            <span className="confirm-old">{valueText(c.field, c.old)}</span>
            {' -> '}
            <span className="confirm-new">{valueText(c.field, c.new)}</span>
          </Field>
        ))}
      </dl>
      {v.loginChanged && <p className="confirm-warning">{ct.loginChanged}</p>}
      {tlsOff && <p className="confirm-warning">{t.tlsVerifyOffWarning}</p>}
      {v.deletesSooner && <p className="confirm-warning">{ct.deletesSooner}</p>}
      {v.restartsLogin && <p className="confirm-warning">{ct.restartsLogin}</p>}
    </>
  )
}

function AccountLine({ account }) {
  return (
    <dl className="confirm-fields">
      <Field label={ct.account}>{`${account.name} <${account.email}>`}</Field>
    </dl>
  )
}

function Body({ v }) {
  switch (v.kind) {
    case 'send':
      return <SendView v={v} />
    case 'deleteMessages':
      return <DeleteMessagesView v={v} />
    case 'deleteFolder':
      return (
        <>
          <AccountLine account={v.account} />
          <dl className="confirm-fields">
            <Field label={ct.folder}>{v.path}</Field>
          </dl>
          <p>{ct.folderDelete(v.count)}</p>
        </>
      )
    case 'updateAccount':
      return <UpdateAccountView v={v} />
    case 'deleteAccount':
      return (
        <>
          <AccountLine account={v.account} />
          <p>{ct.accountDelete(v.count)}</p>
        </>
      )
    case 'restartLogin':
      return (
        <>
          <AccountLine account={v.account} />
          <p>{ct.restartReason(v.reason)}</p>
          <p className="confirm-warning">{ct.restartWarning}</p>
        </>
      )
    default:
      return null
  }
}

/**
 * @param request  the oldest waiting request { id, tool, view } (main's ConfirmationQueue view), or null
 * @param waiting  how many wait in all (this one included)
 * @param onDecide (id, approve: boolean) => void
 */
export function ClaudeConfirm({ request, waiting = 1, onDecide, onLock = null, onRejectAllOff = null }) {
  // the delay belongs to the request: a new one is never shown with the previous one's enabled button
  const [readyId, setReadyId] = useState(null)
  const approveRef = useRef(null)
  const id = request ? request.id : null
  const ready = id !== null && readyId === id
  useEffect(() => {
    if (!id) return undefined
    const timer = setTimeout(() => setReadyId(id), APPROVE_DELAY_MS)
    return () => clearTimeout(timer)
  }, [id])
  if (!request) return null
  const v = request.view || {}
  const reject = () => onDecide(request.id, false)
  const approve = () => ready && onDecide(request.id, true)
  // Enter rejects, wherever the focus is, except on the (enabled) approve button itself: approving with the keyboard
  // takes a deliberate Tab to it
  const onKeyDownCapture = e => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    e.stopPropagation()
    if (ready && e.target === approveRef.current) approve()
    else reject()
  }
  return (
    <div className="claude-confirm" data-request-id={request.id} data-kind={v.kind} onKeyDownCapture={onKeyDownCapture}>
      <Modal
        key={request.id}
        role="alertdialog"
        className="claude-confirm-modal"
        title={ct.titles[v.kind] || ct.unknownTitle}
        onClose={reject}
        actions={
          <>
            <Button variant="outlined" className="confirm-reject" data-autofocus onClick={reject}>
              {ct.reject}
            </Button>
            <Button ref={approveRef} variant="danger" className="confirm-approve" disabled={!ready} aria-disabled={!ready} onClick={approve}>
              {ct.approve}
            </Button>
          </>
        }
      >
        <p className="confirm-header">{ct.header}</p>
        <Body v={v} />
        {waiting > 1 && <p className="hint confirm-more">{ct.more(waiting - 1)}</p>}
        {/* the way out: the Modal covers the header's Zárolás and the access switch. Never focused first,
            Enter does not press them (the capture above rejects), no delay: both are safe */}
        {(onLock || onRejectAllOff) && (
          <div className="confirm-escape">
            {onLock && (
              <Button variant="text" icon="lock" className="confirm-lock" onClick={onLock}>
                {ct.lock}
              </Button>
            )}
            {onRejectAllOff && (
              <Button variant="text" className="confirm-off" onClick={onRejectAllOff}>
                {ct.rejectAllOff}
              </Button>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}
