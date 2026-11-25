// SPDX-License-Identifier: GPL-3.0-or-later
// Reader pane: headers, the body, "load images", attachments, thread.
// The HTML body is sanitized here (DOMPurify) and shown from the main process's mail-view: scheme in
// a frame sandboxed WITHOUT allow-scripts and allow-same-origin; plain text is rendered by React (escaped).
// An icon toolbar (back in the list's place, star, reply, reply all, forward, delete,
// move, more), the sender's monogram, recipients folded, attachment cards, reply pills at the end.
// More -> Headers / Show original (the source view, SourceView.jsx) / Save as .eml.
import { useEffect, useMemo, useRef, useState } from 'react'
import DOMPurify from 'dompurify'
import { t, locale } from '../i18n/index.js'
import { assignRoles } from '../../../core/imap/folders.js'
import { sanitizeMail, MAX_LINKS } from './sanitize.js'
import { Icon } from './Icon.jsx'
import { folderIcon } from './folder-icons.js'
import { formatFullDate, formatListDate } from './list-format.js'
import { Avatar, Banner, Button, IconButton, MenuButton } from './ui/index.js'
import { SourceView } from './SourceView.jsx'
import { readerText } from './control-marks.js'
import { textBlocks } from '../../../core/mime/text-blocks.js'
import { copyAsText } from './copy-text.js'
import { archiveFor } from './reader-nav.js'
import { linkTarget, linkTexts, matchFor } from './link-target.js'
import { LabelChip } from './LabelChip.jsx'
import { changedLabels } from './label-chips.js'

const api = window.shadowMail
const dateTimeFmt = new Intl.DateTimeFormat(locale, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })

const fmtAddr = a => (a.name ? `${a.name} <${a.address}>` : a.address)
const hasFlag = (flags, flag) => (flags || '').split(' ').includes(flag)

function AddressLine({ label, list }) {
  if (!list || !list.length) return null
  return (
    <div className="reader-header-line">
      <span className="reader-label">{label}:</span> <span className="reader-value">{list.map(fmtAddr).join(', ')}</span>
    </div>
  )
}

/** Attachment cards: type icon, name, size; Save always, Open only for the allow-listed types. */
// "Összes mentése": the main process asks for the folder and writes; the line says what happened (saved, left out
// and why, a program or a web-page-like file among them) and offers the folder
function SavedAll({ result }) {
  const saved = result.files.filter(f => f.ok).length
  const skipped = result.files.filter(f => !f.ok)
  return (
    <div className="save-all-result" role="status">
      <p>
        {t.readerSavedAll(saved)}
        {saved > 0 && (
          <Button variant="text" icon="open" className="save-all-show" onClick={() => api.mail.showSavedAttachments()}>
            {t.readerShowInFolder}
          </Button>
        )}
      </p>
      {skipped.map((f, i) => (
        <p key={i} className="hint save-all-skipped">
          {t.readerSaveSkipped(f.name, f.error)}
        </p>
      ))}
      {result.executable > 0 && <p className="hint executable">{t.readerSavedExecutable(result.executable)}</p>}
      {result.browserActive > 0 && <p className="hint executable browser-active">{t.readerSavedBrowserActive(result.browserActive)}</p>}
    </div>
  )
}

function Attachments({ message, onError }) {
  const items = message.attachments
  const [savedAll, setSavedAll] = useState(null)
  if (!items.length) return null
  const run = async (call, index) => {
    const res = await call(message.id, index)
    if (!res.ok) onError(res.error)
  }
  const saveAll = async () => {
    setSavedAll(null)
    const res = await api.mail.saveAllAttachments(message.id)
    if (!res.ok) onError(res.error)
    else if (res.saved) setSavedAll(res)
  }
  return (
    <section className="reader-attachments" aria-label={t.readerAttachments(items.length)}>
      <div className="reader-attachments-head">
        <h3>{t.readerAttachments(items.length)}</h3>
        {items.length >= 2 && (
          <Button variant="text" icon="download" className="save-all" onClick={saveAll}>
            {t.readerSaveAll(items.length)}
          </Button>
        )}
      </div>
      {savedAll && <SavedAll result={savedAll} />}
      <ul>
        {items.map(a => {
          const reason = a.executable ? t.readerExecutable : a.browserActive ? t.readerBrowserActive : !a.openable ? t.readerNotOpenable : null
          return (
            <li key={a.index} data-filename={a.filename} className="attachment-card" title={reason ? `${a.filename}\n${reason}` : a.filename}>
              <Icon name={reason ? 'warning' : 'drafts'} size="m" className="attachment-type" />
              <span className="attachment-text">
                <span className="attachment-name">{a.filename}</span>
                <span className="hint attachment-size">{t.sizeKb(a.size)}</span>
                {reason && <span className="hint executable">{reason}</span>}
              </span>
              <span className="attachment-actions">
                {!reason && <IconButton icon="open" size="s" label={t.readerOpen} onClick={() => run(api.mail.openAttachment, a.index)} />}
                <IconButton icon="download" size="s" label={t.readerSave} onClick={() => run(api.mail.saveAttachment, a.index)} />
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function Thread({ messageId, onOpen }) {
  const [items, setItems] = useState(null)
  useEffect(() => {
    let live = true
    api.mail.thread(messageId).then(res => live && res.ok && setItems(res.messages))
    return () => {
      live = false
    }
  }, [messageId])
  if (!items) return null
  return (
    <section className="reader-thread" aria-label={t.readerThreadHeading(items.length)}>
      <h3>{t.readerThreadHeading(items.length)}</h3>
      <ol>
        {items.map(m => (
          <li key={m.id}>
            {m.id === messageId ? (
              <span className="current">
                {dateTimeFmt.format(new Date(m.date || 0))} · {m.from_name || m.from_addr} · {m.subject || t.noSubject} ({t.readerThreadCurrent})
              </span>
            ) : (
              <button type="button" className="link" onClick={() => onOpen(m.id)}>
                {dateTimeFmt.format(new Date(m.date || 0))} · {m.from_name || m.from_addr} · {m.subject || t.noSubject}
              </button>
            )}
          </li>
        ))}
      </ol>
    </section>
  )
}

/**
 * onBack: the back button (only when the message replaces the list); onAction(action, ids, opts):
 * the list's actions (Mail.runAction), with the message's own account and folder; onLoaded(message
 * or null): tells the mail view which message is open (Delete key, actions); accounts: for Move.
 */
/**
 * "Címlistához ad" next to a sender nobody has; after the click it goes and a banner says so. `known` comes
 * WITH the message (the reader's open looks the sender up before it shows the message): a button appearing in the header
 * after the body was laid out made the browser lay out the whole text again (a 2 MB Hebrew body: +1.5 s, reader-blocks e2e).
 * Its own state, so the click re-renders only this.
 */
function AddSender({ messageId, known }) {
  const [state, setState] = useState(known === false ? 'unknown' : 'known') // 'unknown', 'known', 'added', or an error text
  if (state === 'unknown') {
    return (
      <Button
        variant="text"
        icon="addContact"
        className="reader-add-sender"
        onClick={async () => {
          const r = await api.contacts.addFromMessage(messageId)
          setState(r.ok ? 'added' : t.contacts.error(r.error))
        }}
      >
        {t.contacts.addSender}
      </Button>
    )
  }
  if (state === 'added' || (state && state !== 'known')) {
    return (
      <Banner kind={state === 'added' ? 'info' : 'error'} className="reader-sender-added" onClose={() => setState('known')} closeLabel={t.close}>
        {state === 'added' ? t.contacts.senderAdded : state}
      </Banner>
    )
  }
  return null
}

// the URL's end that stays visible when the middle is cut (the host always stays)
const REST_TAIL = 18

/**
 * The link-target bar: where the link under the mouse or the keyboard focus really goes, floating over the
 * bottom-left corner of the visible part of the message (like a browser's status bubble); never takes the pointer.
 * A red warning when the link's text shows another registered domain. `place`: { left, bottom, maxWidth } in px.
 */
function LinkTargetBar({ info, place }) {
  const warn = Boolean(info.mismatch)
  const long = info.rest.length > REST_TAIL * 2
  const head = long ? info.rest.slice(0, info.rest.length - REST_TAIL) : info.rest
  const tail = long ? info.rest.slice(info.rest.length - REST_TAIL) : ''
  return (
    <div
      className={`link-target${warn ? ' link-target-warn' : ''}`}
      role="status"
      aria-label={t.linkTarget.label}
      style={{ left: place.left, bottom: place.bottom, maxWidth: place.maxWidth }}
    >
      {warn && (
        <div className="link-target-warning">
          <Icon name="warning" />
          <span>{t.linkTarget.mismatch}</span>
        </div>
      )}
      {warn && (
        <div className="link-target-detail">
          {t.linkTarget.realHost} <b className="link-target-real" dir="ltr">{info.host}</b> ({t.linkTarget.textShows} <span dir="ltr">{info.mismatch}</span>)
        </div>
      )}
      <div className="link-target-url" dir="ltr">
        <span className="lt-head">
          <span className="lt-scheme">{info.scheme}</span>
          {info.user && <span className={info.kind === 'web' ? 'lt-user' : 'lt-mailbox'}>{info.user}</span>}
          <span className="lt-host">
            {info.sub && <span className="lt-sub">{info.sub}</span>}
            <b className="lt-domain">{info.domain}</b>
          </span>
        </span>
        {head && <span className="lt-rest">{head}</span>}
        {tail && <span className="lt-tail">{tail}</span>}
      </div>
      {info.unicode && (
        <div className="link-target-detail link-target-idn">
          {t.linkTarget.idn} <span dir="ltr">{info.unicode}</span>
        </div>
      )}
    </div>
  )
}

/**
 * "You replied: <date>" (the date opens the latest reply; with more replies their count in the title) or "You replied"
 * without a reply in Sent, and "You forwarded this": one line, the replied part first. Asked again on every mail change
 * of the message's account (a reply sent, a sync), so the open reader follows without reopening.
 */
function RepliedLine({ message, onOpen }) {
  const [info, setInfo] = useState(null)
  useEffect(() => {
    let live = true
    const load = () => api.mail.replyInfo(message.id).then(res => live && setInfo(res && res.ok ? res : null))
    load()
    const off = api.onStatus(ev => {
      if (ev && ev.kind === 'mail' && ev.changes.some(c => c.accountId === message.accountId)) load()
    })
    return () => {
      live = false
      off()
    }
  }, [message.id, message.accountId])
  if (!info || (!info.answered && !info.forwarded)) return null
  const r = info.reply
  return (
    <div className="reader-replied">
      {info.answered && (
        <span className="reader-replied-part" data-part="replied">
          <Icon name="reply" />
          {r ? (
            <>
              {t.repliedLine.on}
              <button type="button" className="link reader-replied-open" title={r.count > 1 ? t.repliedLine.many(r.count, formatFullDate(r.date)) : formatFullDate(r.date)} onClick={() => onOpen(r.id)}>
                {formatListDate(r.date)}
              </button>
            </>
          ) : (
            t.repliedLine.none
          )}
        </span>
      )}
      {info.answered && info.forwarded && <span className="reader-replied-sep" aria-hidden="true">·</span>}
      {info.forwarded && (
        <span className="reader-replied-part" data-part="forwarded">
          <Icon name="forward" />
          {t.repliedLine.forwarded}
        </span>
      )}
    </div>
  )
}

export function Reader({ messageId, onOpen, onBack = null, onAction = null, onLoaded = null, accounts = [], flagEvent = null, labelList = [], labelEvent = null, onLabel = null, onLabelPick = null }) {
  const [message, setMessage] = useState(null)
  const [labels, setLabels] = useState([]) // the open message's label ids (mail:open, then the changes)
  const [error, setError] = useState(null)
  const [actionError, setActionError] = useState(null)
  const [imagesAllowed, setImagesAllowed] = useState(false)
  const [frameUrl, setFrameUrl] = useState(null)
  const [showThread, setShowThread] = useState(false)
  const [showDetails, setShowDetails] = useState(false)
  const [blockedImages, setBlockedImages] = useState(0)
  const [sourceTab, setSourceTab] = useState(null) // null | 'headers' | 'original': the source view is open
  const [flags, setFlags] = useState('')
  const [hovered, setHovered] = useState(null) // the link-target bar: { info, place } or null
  const current = useRef(null)
  const linksRef = useRef(new Map()) // the shown message's links: linkKey(href) -> visible texts
  const frameRef = useRef(null)
  const accountsRef = useRef(accounts)
  accountsRef.current = accounts
  const loadedRef = useRef(onLoaded)
  loadedRef.current = onLoaded

  useEffect(() => {
    current.current = messageId
    setMessage(null)
    setError(null)
    setActionError(null)
    setImagesAllowed(false)
    setFrameUrl(null)
    setShowThread(false)
    setShowDetails(false)
    setBlockedImages(0)
    setSourceTab(null)
    setHovered(null)
    linksRef.current = new Map()
    loadedRef.current && loadedRef.current(null)
    if (!messageId) return
    api.mail.open(messageId).then(async res => {
      if (current.current !== messageId) return // another message was clicked meanwhile
      // is the sender someone's? Asked before the message shows, so the header is drawn once (see AddSender)
      const from = res.ok ? res.message.from?.[0]?.address : null
      // the user's own account address is not offered (the button is about the senders of RECEIVED mail)
      const own = from && accountsRef.current.some(a => (a.email || '').trim().toLowerCase() === from.trim().toLowerCase())
      if (own) res.message.senderKnown = true
      else if (from && api.contacts?.lookup) {
        const r = await api.contacts.lookup(from).catch(() => null)
        if (current.current !== messageId) return
        res.message.senderKnown = r && r.ok ? r.personId !== null : null
      }
      if (!res.ok) setError(res.error)
      else {
        setMessage(res.message)
        setFlags(res.message.flags || '')
        setLabels(res.message.labels || [])
        loadedRef.current && loadedRef.current(res.message)
      }
    })
  }, [messageId])

  // (re)build the frame's document whenever the message or the image permission changes
  useEffect(() => {
    if (!message || !message.html) return
    const { html, externalImages, links } = sanitizeMail(DOMPurify, message.html, { messageId: message.id, imagesAllowed })
    linksRef.current = linkTexts(links)
    linksRef.current.cut = links.length >= MAX_LINKS
    setBlockedImages(imagesAllowed ? 0 : externalImages)
    let live = true
    api.mail.render(message.id, html).then(res => {
      if (live && res.ok) setFrameUrl(res.url)
      else if (live) setActionError(res.error)
    })
    return () => {
      live = false
    }
  }, [message, imagesAllowed])

  // the link-target bar: the main process reports the link under the mouse or the keyboard focus in any frame of the
  // window. Only the shown message's own links count (the sanitizer's list; all of them if the list was cut). The
  // page gets no mouse event while the pointer is in the frame (measured), so any mouse move or focus on the page
  // itself means the pointer or the focus left the frame: the bar goes.
  useEffect(() => {
    if (!message || !message.html) return
    let shown = false
    const hide = () => {
      if (shown) setHovered(null)
      shown = false
    }
    const off = api.onStatus(ev => {
      if (!ev || ev.kind !== 'linkTarget') return
      const frame = frameRef.current
      if (!ev.url || !frame) return hide()
      // not one of the message's links (the page's own, or a key that does not match): the old bar must not stay. A cut
      // report is shown only through the message's own full link (matchFor), never parsed itself.
      let match = matchFor(linksRef.current, ev.url, ev.cut)
      if (!match && !ev.cut && linksRef.current.cut) match = { target: ev.url, texts: [] }
      if (!match || !match.target) return hide()
      const info = linkTarget(match.target, match.texts)
      if (!info) return hide()
      shown = true
      setHovered({ info, place: barPlace(frame) })
    })
    const onPage = e => e.target !== frameRef.current && hide()
    document.addEventListener('mousemove', onPage, { capture: true, passive: true })
    document.addEventListener('focusin', onPage, true)
    return () => {
      off()
      document.removeEventListener('mousemove', onPage, { capture: true })
      document.removeEventListener('focusin', onPage, true)
    }
  }, [message])

  // the star follows a change made on the list (or goes back when the change failed)
  useEffect(() => {
    if (!flagEvent || !message || !flagEvent.ids.includes(message.id)) return
    const { add, remove } = flagEvent.change
    const undo = flagEvent.failed
    setFlags(f => {
      const set = new Set(f.split(' ').filter(Boolean))
      for (const x of undo ? remove : add) set.add(x)
      for (const x of undo ? add : remove) set.delete(x)
      return [...set].join(' ')
    })
  }, [flagEvent])

  // the chips follow a label change made anywhere (the picker, the list, another copy of the same message in another
  // folder: the event's row ids do not name it), or go back when it failed: the open message's labels asked again
  useEffect(() => {
    if (!labelEvent || !message || !window.shadowMail.mail.labelsOf) return
    const id = message.id
    window.shadowMail.mail.labelsOf([id]).then(res => {
      if (res && res.ok && res.labels[id]) setLabels(res.labels[id])
    })
  }, [labelEvent])

  // the plain-text body as drawn (control characters out, at most MAX_READER_TEXT); the data stays as it is
  const plain = useMemo(() => (message && !message.html ? readerText(message.text) : null), [message])
  // drawn in blocks of CHUNK code points, each its own block element (one huge text node froze the window)
  const plainBlocks = useMemo(() => (plain ? textBlocks(plain.text) : []), [plain])
  const account = message ? accounts.find(a => a.id === message.accountId) : null
  const moveTargets = useMemo(() => {
    if (!account || !message) return []
    const roles = assignRoles(account.folders)
    return account.folders.filter(f => f.path !== message.folder).map(f => ({ path: f.path, role: roles.get(f.path) || null }))
  }, [account, message])
  // the Archive button: only where the list has one too (the account has an Archive, the message is not in it)
  const canArchive = useMemo(() => Boolean(account && message && archiveFor(account.folders, message.folder).archive), [account, message])
  // a message in its account's Drafts folder (the main process's own rule) opens again in the composer
  const isDraft = useMemo(() => Boolean(account && message && assignRoles(account.folders).get(message.folder) === 'drafts'), [account, message])

  const loadImages = async () => {
    const res = await api.mail.allowImages(message.id)
    if (res.ok) setImagesAllowed(true)
    else setActionError(res.error)
  }
  const compose = async mode => {
    const res = await api.compose.open({ mode, messageId: message.id })
    if (!res.ok) setActionError(res.error)
  }
  // the whole, uncut message as .eml (H1 mail:saveSource: the save dialog, Mark-of-the-Web); a cancel says nothing
  const saveSource = async () => {
    const res = await api.mail.saveSource(message.id)
    if (!res.ok) setActionError(res.error)
  }
  const act = (action, opts = {}) => onAction && onAction(action, [message.id], { accountId: message.accountId, folder: message.folder, ...opts })

  const back = onBack && <IconButton icon="back" className="reader-back" label={t.backToList} onClick={onBack} />

  // nothing open, the list takes the whole height (the empty pane is hidden by CSS)
  if (!messageId) return <section className="reader reader-empty"><p className="hint pad">{t.readerEmpty}</p></section>
  if (error)
    return (
      <section className="reader">
        {back && <div className="reader-toolbar">{back}</div>}
        <p className="error pad" role="alert">{t.readerError(error)}</p>
      </section>
    )
  if (!message)
    return (
      <section className="reader" aria-busy="true">
        {back && <div className="reader-toolbar">{back}</div>}
        <p className="hint pad">{t.readerLoading}</p>
      </section>
    )

  const flagged = hasFlag(flags, '\\Flagged')
  const sender = message.from[0] || { name: '', address: '' }
  const recipients = [...(message.to || []), ...(message.cc || [])]
  const toSummary = recipients.length ? t.readerToSummary(recipients.map(a => a.name || a.address).join(', ')) : t.readerNoRecipient
  const moreItems = [
    { key: 'unread', label: t.actions.unread, icon: 'markUnread', onSelect: () => act('unread') },
    { key: 'thread', label: showThread ? t.readerThreadHide : t.readerThread, icon: 'list', onSelect: () => setShowThread(s => !s) },
    { separator: true },
    { key: 'headers', label: t.source.menuHeaders, icon: 'headers', onSelect: () => setSourceTab('headers') },
    { key: 'source', label: t.source.menuOriginal, icon: 'source', onSelect: () => setSourceTab('original') },
    { key: 'saveSource', label: t.source.menuSave, icon: 'download', onSelect: saveSource },
  ]

  return (
    <section className="reader" aria-label={message.subject || t.noSubject} data-message-id={message.id}>
      <div className="reader-toolbar">
        {back}
        <div className="reader-tools" role="toolbar" aria-label={t.readerToolsLabel}>
          <IconButton
            icon="star"
            filled={flagged}
            className={flagged ? 'star-on' : undefined}
            label={flagged ? t.actions.unstar : t.actions.star}
            onClick={() => act(flagged ? 'unstar' : 'star')} // the star follows the result (flagEvent), set or undone
          />
          {isDraft && <IconButton icon="edit" label={t.replyModes.edit} className="reader-edit-draft" onClick={() => compose('draft')} />}
          <IconButton icon="reply" label={t.replyModes.reply} onClick={() => compose('reply')} />
          {/* a draft: the edit button takes this place in the toolbar (a 360 px reader has no room for both); below it stays */}
          {!isDraft && <IconButton icon="replyAll" label={t.replyModes.replyAll} onClick={() => compose('replyAll')} />}
          <IconButton icon="forward" label={t.replyModes.forward} onClick={() => compose('forward')} />
          {canArchive && <IconButton icon="archive" className="reader-archive" label={t.actions.archive} onClick={() => act('archive')} />}
          <IconButton icon="trash" label={t.actions.delete} onClick={() => act('delete')} />
          {moveTargets.length > 0 && (
            <MenuButton
              icon="move"
              label={t.actions.move}
              items={moveTargets.map(f => ({ key: f.path, label: f.role ? `${t.folderRoles[f.role]} (${f.path})` : f.path, icon: folderIcon(f.role), onSelect: () => act('move', { target: f.path }) }))}
            />
          )}
          {onLabelPick && <IconButton icon="tag" className="reader-label-open" label={t.labels.button} onClick={() => onLabelPick(message.id)} />}
          <MenuButton icon="more" label={t.readerMore} items={moreItems} align="end" />
        </div>
      </div>
      <header className="reader-header">
        <h2 className="reader-subject">{message.subject || t.noSubject}</h2>
        {onLabelPick ? (
          <div className="reader-labels" role="group" aria-label={t.labels.pickerTitle}>
            {labelList
              .filter(l => labels.includes(l.id))
              .map(l => (
                <LabelChip
                  key={l.id}
                  label={l}
                  full
                  onRemove={
                    onLabel
                      ? () => {
                          setLabels(ls => changedLabels(ls, l.id, 'remove'))
                          onLabel([message.id], l.id, 'remove')
                        }
                      : null
                  }
                />
              ))}
            <Button className="reader-label-add" icon="tag" onClick={() => onLabelPick(message.id)}>
              {t.labels.button}
            </Button>
          </div>
        ) : null}
        <div className="reader-from-row">
          <Avatar name={sender.name} address={sender.address} />
          <div className="reader-from">
            <div className="reader-from-line">
              <span className="reader-from-name">{sender.name || sender.address}</span>
              {sender.name && <span className="reader-from-address">&lt;{sender.address}&gt;</span>}
              <AddSender key={message.id} messageId={message.id} known={message.senderKnown} />
            </div>
            <button type="button" className="reader-to-toggle" aria-expanded={showDetails} title={showDetails ? t.readerDetailsHide : t.readerDetailsShow} onClick={() => setShowDetails(s => !s)}>
              <span className="reader-to-summary">{toSummary}</span>
              <Icon name="chevronDown" />
            </button>
          </div>
          {message.date && (
            <span className="reader-date" title={dateTimeFmt.format(new Date(message.date))}>
              {formatListDate(message.date)}
            </span>
          )}
        </div>
        {onOpen && <RepliedLine message={message} onOpen={onOpen} />}
        {showDetails && (
          <div className="reader-details">
            <AddressLine label={t.readerHeaders.from} list={message.from} />
            <AddressLine label={t.readerHeaders.to} list={message.to} />
            <AddressLine label={t.readerHeaders.cc} list={message.cc} />
            {message.date && (
              <div className="reader-header-line">
                <span className="reader-label">{t.readerHeaders.date}:</span> <span className="reader-value">{dateTimeFmt.format(new Date(message.date))}</span>
              </div>
            )}
          </div>
        )}
      </header>
      {message.seenError && <p className="hint pad warn">{t.readerSeenFailed(message.seenError)}</p>}
      {actionError && (
        <Banner kind="error" onClose={() => setActionError(null)} closeLabel={t.close}>
          {t.readerError(actionError)}
        </Banner>
      )}
      {showThread && <Thread messageId={message.id} onOpen={onOpen} />}
      {message.html && blockedImages > 0 && !imagesAllowed && (
        <Banner kind="info" className="images-bar" actions={<Button variant="text" icon="images" onClick={loadImages}>{t.readerLoadImages}</Button>}>
          {t.readerImagesBlocked(blockedImages)}
        </Banner>
      )}
      {plain && plain.removed > 0 && (
        <Banner kind="info" className="reader-controls-hidden">
          {t.readerControlsHidden(plain.removed)}
        </Banner>
      )}
      <Attachments key={message.id} message={message} onError={setActionError} />
      <div className={message.html ? 'reader-body' : 'reader-body reader-body-text'}>
        {message.html ? (
          frameUrl && (
            <iframe
              key={frameUrl}
              className="mail-frame"
              title={t.readerFrameTitle}
              src={frameUrl}
              sandbox="allow-popups allow-popups-to-escape-sandbox"
              referrerPolicy="no-referrer"
              ref={frameRef}
            />
          )
        ) : (
          <pre className="mail-text" onCopy={copyAsText}>
            {plainBlocks.map((b, i) => (
              <span key={i} className="text-block">
                {b}
              </span>
            ))}
            {plain.hidden > 0 && <span className="reader-text-cut">{`\n${t.readerTextCut(plain.hidden)}`}</span>}
          </pre>
        )}
      </div>
      {hovered && <LinkTargetBar info={hovered.info} place={hovered.place} />}
      {sourceTab && <SourceView messageId={message.id} initialTab={sourceTab} onClose={() => setSourceTab(null)} />}
      <div className="reader-replies">
        {isDraft && (
          <Button variant="tonal" icon="edit" className="reader-edit-draft" onClick={() => compose('draft')}>
            {t.replyModes.edit}
          </Button>
        )}
        <Button variant="outlined" icon="reply" onClick={() => compose('reply')}>{t.replyModes.reply}</Button>
        <Button variant="outlined" icon="replyAll" onClick={() => compose('replyAll')}>{t.replyModes.replyAll}</Button>
        <Button variant="outlined" icon="forward" onClick={() => compose('forward')}>{t.replyModes.forward}</Button>
      </div>
    </section>
  )
}

/** Where the bar floats: the bottom-left corner of the frame's visible part (the reader may be scrolled). */
function barPlace(frame) {
  const r = frame.getBoundingClientRect()
  const scroller = frame.closest('.reader')
  const v = scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth }
  const bottom = Math.min(r.bottom, v.bottom, window.innerHeight)
  const left = Math.max(r.left, v.left, 0)
  const right = Math.min(r.right, v.right, window.innerWidth)
  return { left: left + 4, bottom: Math.max(window.innerHeight - bottom + 4, 0), maxWidth: Math.max(right - left - 8, 120) }
}
