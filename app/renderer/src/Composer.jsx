// SPDX-License-Identifier: GPL-3.0-or-later
// The composer window: From, To / Cc / Bcc with completion, Subject, a simple HTML editor
// (bold, italic, underline, lists, link, quote) with the account's signature, attachments (browse or
// drop), a draft every 60 s, Send. Closing asks first when something is not saved.
// The frame: a title strip with the close button, fields with a bottom line only (From is a
// menu), the editor, attachment chips, and the bottom bar: the blue Send pill, the formatting
// toggle, Attach; on the right Save draft and Discard. The formatting bar is icon buttons.
import { useCallback, useEffect, useRef, useState } from 'react'
import DOMPurify from 'dompurify'
import { t } from '../i18n/index.js'
import { sanitizeCompose } from './sanitize.js'
import { shapeOf } from './compose-shape.js'
import { createDraftState } from './draft-state.js'
import { accountSignatureHtml, accountImageSrc, signatureInner, SIGNATURE_ATTR } from '../../../core/smtp/signature.js'
import { Banner, Button, IconButton, Modal, Select, TextField } from './ui/index.js'

const api = window.shadowMail
export const AUTOSAVE_MS = 60_000

const escapeHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
// same rule as displayAddress in app/main/compose.js: quote a name with a special, without " and \
const fmtContact = c => {
  const clean = String(c.name || '').replace(/["\\]/g, '').trim()
  if (!clean) return c.address
  return `${/[()<>[\]:;@,.]/.test(clean) ? `"${clean}"` : clean} <${c.address}>`
}

/** A recipient field: comma-separated text, suggestions for the part being typed. */
function RecipientField({ id, label, value, onChange, disabled = false, children = null }) {
  const [items, setItems] = useState([])
  const [active, setActive] = useState(0)
  const timer = useRef(null)
  const current = v => v.split(/[,;]/).pop().trim()
  const ask = v => {
    clearTimeout(timer.current)
    const term = current(v)
    if (term.length < 2) {
      setItems([])
      return
    }
    timer.current = setTimeout(async () => {
      const res = await api.compose.suggest(term)
      setItems(res.ok ? res.contacts : [])
      setActive(0)
    }, 150)
  }
  const pick = c => {
    const parts = value.split(/([,;])/)
    parts[parts.length - 1] = ` ${fmtContact(c)}`
    onChange(`${parts.join('').replace(/^\s+/, '')}, `)
    setItems([])
  }
  return (
    <div className="compose-row recipient">
      <label className="compose-label" htmlFor={id}>{label}</label>
      <div className="suggest-wrap">
        <input
          disabled={disabled}
          id={id}
          type="text"
          value={value}
          spellCheck={false}
          autoComplete="off"
          onChange={e => {
            onChange(e.target.value)
            ask(e.target.value)
          }}
          onBlur={() => setTimeout(() => setItems([]), 150)}
          onKeyDown={e => {
            if (!items.length) return
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActive(a => (a + 1) % items.length)
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive(a => (a - 1 + items.length) % items.length)
            } else if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault()
              pick(items[active])
            } else if (e.key === 'Escape') setItems([])
          }}
        />
        {items.length > 0 && (
          <ul className="suggestions" role="listbox" aria-label={t.composeSuggestions}>
            {items.map((c, i) => (
              <li key={c.address} role="option" aria-selected={i === active} className={i === active ? 'active' : ''} onMouseDown={() => pick(c)}>
                {c.name ? <><strong>{c.name}</strong> &lt;{c.address}&gt;</> : c.address}
              </li>
            ))}
          </ul>
        )}
      </div>
      {children}
    </div>
  )
}

const TOOLS = [
  ['bold', 'bold'],
  ['italic', 'italic'],
  ['underline', 'underline'],
  ['insertUnorderedList', 'list', 'ul'],
  ['insertOrderedList', 'listOrdered', 'ol'],
  ['link', 'link'],
  ['formatBlock', 'quote', 'quote', 'blockquote'],
  ['removeFormat', 'clearFormat', 'clear'],
]

/** The formatting bar: icon buttons, the old names as aria-label + tooltip. */
function Toolbar({ run }) {
  return (
    <div className="editor-toolbar" role="toolbar" aria-label={t.composeFormatting}>
      {TOOLS.map(([cmd, icon, key = cmd, arg]) => (
        <IconButton key={cmd + (arg || '')} icon={icon} size="s" label={t.composeTools[key]} onMouseDown={e => e.preventDefault()} onClick={() => run(cmd, arg)} />
      ))}
    </div>
  )
}

function Ask({ title, text, buttons, onCancel }) {
  return (
    <Modal
      title={title}
      role="alertdialog"
      onClose={onCancel}
      actions={buttons.map(([label, fn, variant]) => (
        <Button key={label} variant={variant || 'text'} onClick={fn} data-autofocus={variant === 'primary' ? true : undefined}>
          {label}
        </Button>
      ))}
    >
      {text && <p>{text}</p>}
    </Modal>
  )
}

export function Composer({ sessionId }) {
  const [accounts, setAccounts] = useState([])
  const [accountId, setAccountId] = useState(null)
  const [to, setTo] = useState('')
  const [cc, setCc] = useState('')
  const [bcc, setBcc] = useState('')
  const [showCopies, setShowCopies] = useState(false)
  const [showFormat, setShowFormat] = useState(true) // the formatting bar, shown until hidden
  const [subject, setSubject] = useState('')
  const [attachments, setAttachments] = useState([])
  const [busy, setBusy] = useState(null) // 'saving' | 'sending'
  const [error, setError] = useState(null)
  const [savedAt, setSavedAt] = useState(null)
  // { kind: 'close' } | { kind: 'link' }. Not a bare string: 'close'.link is String.prototype.link (truthy)
  const [ask, setAsk] = useState(null)
  const [linkUrl, setLinkUrl] = useState('https://')
  const draft = useRef(createDraftState()) // unsaved changes; see draft-state.js
  const busyRef = useRef(null)
  const [sentNotice, setSentNotice] = useState(null)
  // the message went out: the window only shows what happened, nothing is saved or sent again
  const [sent, setSent] = useState(false)
  const sentRef = useRef(false)
  const bodyTouched = useRef(false)
  const editor = useRef(null)
  const formRef = useRef(null)
  const savedRange = useRef(null) // the selection while the link dialog is open
  const threading = useRef({ inReplyTo: null, references: [] }) // a reply's In-Reply-To / References

  const touch = () => {
    draft.current.touch()
  }
  useEffect(() => {
    busyRef.current = busy
  }, [busy])

  useEffect(() => {
    // the "e-mail bomb" check: the starting body is sanitized, parsed into an inert template and measured
    // BEFORE it goes into the editor; over SHAPE_LIMIT (or SWITCH_LIMIT) it does not go in at all: compose:suspect, the main process closes
    // this (still hidden) window and asks in the main window. Otherwise compose:checked shows the window.
    // 1.: the main process's watchdog waits for this page to say it holds its starting body. The layout is forced first (a
    // body the browser cannot lay out freezes HERE, and then nothing below runs); then the signal goes after the next
    // frame, or after 250 ms if no frame comes (a covered or minimized window may draw none: not measured; a page that
    // runs its timers is not stuck).
    let signalled = false
    const ready = () => {
      if (signalled) return
      signalled = true
      api.compose.ready(sessionId)
    }
    const afterBody = () => {
      if (editor.current) void editor.current.offsetHeight
      requestAnimationFrame(() => setTimeout(ready, 0))
      setTimeout(ready, 250)
    }
    // the starting body into the editor, unless its shape says no -> true, or the reason ('run': a run over N,
    // 'switches': a block over B direction switches; nothing written)
    const writeBody = html => {
      const { fragment, reason } = shapeOf(document, sanitizeCompose(DOMPurify, html))
      if (reason) return reason
      if (editor.current) editor.current.replaceChildren(fragment)
      return true
    }
    Promise.all([api.compose.accounts(), api.compose.initial(sessionId)]).then(([res, init]) => {
      if (!res.ok || !res.accounts.length) return true
      setAccounts(res.accounts)
      const form = init.ok ? init.form : null
      const account = (form && res.accounts.find(a => a.id === form.accountId)) || res.accounts[0]
      setAccountId(account.id)
      if (init.ok && init.attachments.length) setAttachments(init.attachments)
      if (form) {
        // reply / forward, or a mailto: link. The quote, or the link's body (escaped plain
        // text), goes through the composer sanitizer like a paste.
        setTo(form.to)
        setCc(form.cc)
        if (form.cc) setShowCopies(true)
        setSubject(form.subject)
        threading.current = { inReplyTo: form.inReplyTo, references: form.references }
        if (form.body || form.quote || form.draftHtml) bodyTouched.current = true
        if (form.bcc) {
          setBcc(form.bcc)
          setShowCopies(true)
        }
        // a saved draft opened again: its own body, the signature is already in it
        const html = form.draftHtml !== undefined ? form.draftHtml : (form.body || '') + accountSignatureHtml(account) + (form.quote || '')
        document.title = form.subject ? `${form.subject} - ShadowMail` : t.composeTitle
        return writeBody(html)
      }
      document.title = t.composeTitle
      return writeBody(accountSignatureHtml(account))
    })
      // an error on the way (an IPC or a sanitizer failure) is no suspect: the window shows (empty), as before the check
      .catch(() => true)
      .then(ok => {
      if (ok !== true) {
        api.compose.suspect(sessionId, ok)
        return
      }
      api.compose.checked(sessionId)
      afterBody()
    })
  }, [sessionId])

  // another account: its signature replaces the signature block, and only it (the text written, the quote and the
  // attachments stay); no block (the user deleted it): no new one
  const chooseAccount = id => {
    setAccountId(id)
    touch()
    const a = accounts.find(x => x.id === id)
    const block = editor.current && editor.current.querySelector(`[${SIGNATURE_ATTR}]`)
    if (a && block) block.innerHTML = sanitizeCompose(DOMPurify, signatureInner(a.signature || '', a.hasImage ? accountImageSrc(a.id) : null))
  }

  const form = () => ({
    accountId,
    to,
    cc,
    bcc,
    subject,
    html: sanitizeCompose(DOMPurify, editor.current ? editor.current.innerHTML : ''),
    inReplyTo: threading.current.inReplyTo || undefined,
    references: threading.current.references.length ? threading.current.references : undefined,
  })
  formRef.current = form

  const saveDraft = useCallback(async () => {
    if (!accountId || sentRef.current) return false
    setBusy('saving')
    const token = draft.current.beginSave()
    const res = await api.compose.saveDraft(sessionId, formRef.current())
    setBusy(null)
    if (!res.ok) {
      setError(t.composeError(res.error, res.detail, 'save'))
      return false
    }
    draft.current.saved(token) // what was typed during the save stays unsaved
    setError(res.oldDraftLeft ? t.composeOldDraftLeft : null)
    setSavedAt(res.savedAt)
    // the old account still holds a draft: the closing path shows it instead of closing
    return res.oldDraftLeft ? 'old_draft_left' : true
  }, [accountId, sessionId])

  // a draft every 60 s while something changed
  useEffect(() => {
    const timer = setInterval(() => {
      if (draft.current.dirty && !busy && !sentRef.current) saveDraft()
    }, AUTOSAVE_MS)
    return () => clearInterval(timer)
  }, [saveDraft, busy])

  // the window's close button: ask when something is not saved
  useEffect(
    () =>
      api.compose.onCloseRequested(() => {
        if (draft.current.dirty && !sentRef.current) setAsk({ kind: 'close' })
        else api.compose.close(sessionId)
      }),
    [sessionId],
  )

  // a lock is coming. Unsaved text is saved through the autosave path; the main process
  // waits at most 10 s for every window, then closes them. While sending there is nothing to save here.
  useEffect(
    () =>
      api.compose.onLockRequested(async () => {
        let ok = true
        if (draft.current.dirty && !sentRef.current && busyRef.current !== 'sending') ok = (await saveDraft()) !== false
        api.compose.lockDone(sessionId, ok)
      }),
    [sessionId, saveDraft],
  )

  const send = async () => {
    setError(null)
    if (!to.trim() && !cc.trim() && !bcc.trim()) {
      setError(t.composeErrors.no_recipients)
      return
    }
    setBusy('sending')
    const token = draft.current.beginSave()
    const res = await api.compose.send(sessionId, formRef.current())
    setBusy(null)
    if (!res.ok) {
      setError(t.composeError(res.error, res.detail) + (res.draftSaved ? ` ${t.composeKeptAsDraft}` : ''))
      if (res.draftSaved) draft.current.saved(token)
      return
    }
    draft.current.saved(token)
    sentRef.current = true
    setSent(true)
    // typed while it was being sent: that text did not go out
    const changed = draft.current.dirty
    // sent, but a recipient was refused or the Sent copy failed: the user must see it
    if ((res.rejected && res.rejected.length) || (res.warnings && res.warnings.length) || changed) {
      const parts = [t.composeSentWithWarnings(res.rejected || [], res.warnings || [])]
      if (changed) parts.push(t.composeChangedWhileSending)
      parts.push(t.composeSentLocked)
      setSentNotice(parts.join(' '))
      return
    }
    api.compose.close(sessionId)
  }

  const run = (cmd, arg) => {
    if (!editor.current || sentRef.current) return
    editor.current.focus()
    if (cmd === 'link') {
      const sel = window.getSelection()
      savedRange.current = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null
      setLinkUrl('https://')
      setAsk({ kind: 'link' })
      return
    }
    document.execCommand(cmd, false, arg)
    bodyTouched.current = true
    touch()
  }

  // files: File objects (drop) or null (the open dialog); the preload turns them into paths
  const addFiles = async files => {
    const res = await api.compose.addFiles(sessionId, files)
    if (res.ok) {
      setAttachments(res.attachments)
      touch()
    } else setError(t.composeError(res.error, res.detail, 'attach'))
  }

  const discard = async () => {
    // queued behind the send it would come too late to stop it; say so, as for the save
    if (busyRef.current === 'sending') {
      setError(t.composeWaitSending)
      return
    }
    const res = await api.compose.discard(sessionId)
    // a draft left behind is said before the window goes
    if (!res.ok) {
      setError(t.composeError(res.error, res.detail, 'discard'))
      return
    }
    api.compose.close(sessionId)
  }
  const fromOptions = accounts.map(a => ({ value: a.id, label: a.display_name ? `${a.display_name} <${a.email}>` : a.email }))

  return (
    <main
      className="composer"
      onDragOver={e => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault()
      }}
      onDrop={e => {
        if (!e.dataTransfer.files.length || sentRef.current) return
        e.preventDefault()
        addFiles([...e.dataTransfer.files])
      }}
    >
      <header className="compose-title">
        <h1>{subject.trim() || t.newMessage}</h1>
        {/* the window's own close path: the main process asks the page first (onCloseRequested) */}
        <IconButton icon="close" size="s" label={t.composeCloseWindow} onClick={() => window.close()} />
      </header>
      {sentNotice && (
        <Banner kind="warning" className="notice" actions={<Button variant="text" onClick={() => api.compose.close(sessionId)}>{t.close}</Button>}>
          <p>{sentNotice}</p>
        </Banner>
      )}
      {error && (
        <Banner kind="error" className="compose-error">
          {error}
        </Banner>
      )}
      <div className="compose-fields">
        <div className="compose-row">
          <span className="compose-label" id="compose-from-label">{t.composeFrom}</span>
          <Select id="compose-from" label={t.composeFrom} value={accountId} options={fromOptions} disabled={sent} onChange={id => chooseAccount(Number(id))} />
        </div>
        <RecipientField id="compose-to" label={t.composeTo} value={to} disabled={sent} onChange={v => (setTo(v), touch())}>
          {!showCopies && (
            <button type="button" className="link compose-copies" onClick={() => setShowCopies(true)}>{t.composeShowCopies}</button>
          )}
        </RecipientField>
        {showCopies && (
          <>
            <RecipientField id="compose-cc" label={t.composeCc} value={cc} disabled={sent} onChange={v => (setCc(v), touch())} />
            <RecipientField id="compose-bcc" label={t.composeBcc} value={bcc} disabled={sent} onChange={v => (setBcc(v), touch())} />
          </>
        )}
        <div className="compose-row">
          <label className="compose-label" htmlFor="compose-subject">{t.composeSubject}</label>
          <input id="compose-subject" type="text" value={subject} disabled={sent} onChange={e => (setSubject(e.target.value), touch())} />
        </div>
      </div>
      {showFormat && <Toolbar run={run} />}
      <div
        ref={editor}
        className="editor"
        contentEditable={!sent}
        spellCheck={false}
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label={t.composeBody}
        onInput={() => {
          bodyTouched.current = true
          touch()
        }}
        onPaste={e => {
          // only what the composer itself can make survives a paste
          e.preventDefault()
          const html = e.clipboardData.getData('text/html')
          if (html) document.execCommand('insertHTML', false, sanitizeCompose(DOMPurify, html))
          else document.execCommand('insertText', false, e.clipboardData.getData('text/plain'))
          bodyTouched.current = true
          touch()
        }}
      />
      {attachments.length > 0 && (
        <ul className="compose-attachments" aria-label={t.composeAttachmentsLabel(attachments.length)}>
          {attachments.map(a => (
            <li key={a.id} data-filename={a.filename} className="attachment-chip" title={a.filename}>
              <span className="attachment-chip-name">{a.filename}</span> <span className="hint">{t.sizeKb(a.size)}</span>
              <IconButton
                icon="close"
                size="s"
                disabled={sent}
                label={t.composeRemoveAttachment(a.filename)}
                onClick={async () => {
                  const res = await api.compose.removeAttachment(sessionId, a.id)
                  if (res.ok) setAttachments(res.attachments)
                  touch()
                }}
              />
            </li>
          ))}
        </ul>
      )}
      <footer className="compose-actions">
        <Button variant="primary" icon="send" onClick={send} disabled={busy !== null || !accountId || sent}>{busy === 'sending' ? t.composeSending : t.composeSend}</Button>
        <IconButton icon="formatToggle" label={t.composeFormatting} pressed={showFormat} onClick={() => setShowFormat(f => !f)} />
        <IconButton icon="attachment" label={t.composeAttach} disabled={sent} onClick={() => addFiles(null)} />
        <span className="hint compose-saved" role="status">{busy === 'saving' ? t.composeSaving : savedAt ? t.composeSavedAt(new Date(savedAt)) : ''}</span>
        <IconButton icon="save" label={t.composeSaveDraft} onClick={saveDraft} disabled={busy !== null || !accountId || sent} />
        <IconButton icon="trash" label={t.composeDiscard} onClick={() => setAsk({ kind: 'discard' })} disabled={sent} />
      </footer>
      {ask && ask.kind === 'close' && (
        <Ask
          title={t.composeCloseTitle}
          text={t.composeCloseText}
          onCancel={() => setAsk(null)}
          buttons={[
            [t.composeSaveAndClose, async () => {
              setAsk(null)
              // while sending, a draft of the message that is going out must not be left behind; say so
              // instead of doing nothing
              if (busyRef.current === 'sending') {
                setError(t.composeWaitSending)
                return
              }
              if ((await saveDraft()) === true) api.compose.close(sessionId)
            }, 'primary'],
            [t.composeDiscard, async () => {
              setAsk(null)
              await discard()
            }, 'danger'],
            [t.confirmCancel, () => setAsk(null)],
          ]}
        />
      )}
      {ask && ask.kind === 'discard' && (
        <Ask
          title={t.composeDiscardTitle}
          text={t.composeDiscardText}
          onCancel={() => setAsk(null)}
          buttons={[
            [t.confirmCancel, () => setAsk(null)],
            [t.composeDiscard, async () => {
              setAsk(null)
              await discard()
            }, 'danger'],
          ]}
        />
      )}
      {ask && ask.kind === 'link' && (
        <Modal
          title={t.composeTools.link}
          onClose={() => setAsk(null)}
          onSubmit={() => {
            setAsk(null)
            if (/^(https?:\/\/|mailto:)\S+$/i.test(linkUrl)) {
              editor.current.focus()
              const sel = window.getSelection()
              if (savedRange.current && sel) {
                sel.removeAllRanges()
                sel.addRange(savedRange.current)
              }
              // no selection: the address itself becomes the link text
              if (!sel || sel.isCollapsed) document.execCommand('insertHTML', false, `<a href="${escapeHtml(linkUrl)}">${escapeHtml(linkUrl)}</a>`)
              else document.execCommand('createLink', false, linkUrl)
              bodyTouched.current = true
              touch()
            } else setError(t.composeErrors.bad_link)
          }}
          actions={[
            <Button key="cancel" onClick={() => setAsk(null)}>{t.confirmCancel}</Button>,
            <Button key="ok" type="submit" variant="primary">{t.composeLinkOk}</Button>,
          ]}
        >
          <TextField label={t.composeLinkUrl} value={linkUrl} onChange={e => setLinkUrl(e.target.value)} spellCheck={false} data-autofocus />
        </Modal>
      )}
    </main>
  )
}
