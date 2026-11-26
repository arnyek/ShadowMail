// SPDX-License-Identifier: GPL-3.0-or-later
// IPC of the composer. The composer is its own window (compose.html#compose=<session>); closing it
// is asked first: the window's close is held back and the page decides (save / discard / cancel).
// Attachment contents and file paths stay in the main process; the page sees names and sizes only.
import { noRecent } from '../dialog-options.js'
import { ActionError } from '../sync-manager.js'
import { parseMailto } from '../../../core/smtp/compose.js'
import { errCode } from '../../../core/log-safe.js'
import { SHAPE_LIMIT, SWITCH_LIMIT } from '../../../core/mime/shape-limit.js'

// the check runs in the composer page (compose-shape.js); N and B are in core/, which the
// package carries (app/renderer/src is not packaged)
export { SHAPE_LIMIT, SWITCH_LIMIT }
// T: how long the main process waits for a composer to say it holds its starting body (compose:ready)
export const READY_TIMEOUT_MS = 5000

/**
 * The test switch: SHADOWMAIL_TEST_COMPOSE_TIMEOUT_MS may only LOWER T, so the watchdog can be measured on
 * the package with a normal message; an integer 100..T, anything else (missing, 0, negative, not a number, over T) is T.
 * A switch that turns a protection off does not exist.
 */
export function readyTimeoutFrom(value) {
  const s = typeof value === 'string' ? value.trim() : ''
  if (!/^[0-9]{1,6}$/.test(s)) return READY_TIMEOUT_MS
  const n = Number(s)
  return n >= 100 && n <= READY_TIMEOUT_MS ? n : READY_TIMEOUT_MS
}

export const COMPOSE_CHANNELS = Object.freeze([
  'compose:open', 'compose:initial', 'compose:accounts', 'compose:suggest', 'compose:addFiles', 'compose:addImage', 'compose:removeAttachment',
  'compose:saveDraft', 'compose:send', 'compose:discard', 'compose:close', 'compose:lockDone', 'compose:ready',
  'compose:checked', 'compose:suspect', 'compose:schedule',
])

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype
const isId = v => Number.isInteger(v) && v > 0
const isSession = v => typeof v === 'string' && /^[0-9a-f-]{36}$/.test(v)
const str = (v, max) => v === undefined || v === null || (typeof v === 'string' && v.length <= max)

class BadRequest extends Error {}

/** The composer form from the page: only these fields, each checked. */
export function parseForm(f) {
  if (!isPlainObject(f) || !isId(f.accountId)) throw new BadRequest()
  if (!str(f.to, 20_000) || !str(f.cc, 20_000) || !str(f.bcc, 20_000) || !str(f.subject, 2000) || !str(f.html, 10 * 1024 * 1024)) throw new BadRequest()
  if (!str(f.inReplyTo, 1000)) throw new BadRequest()
  if (f.references !== undefined && (!Array.isArray(f.references) || f.references.length > 200 || !f.references.every(r => typeof r === 'string' && r.length <= 1000))) throw new BadRequest()
  return {
    accountId: f.accountId,
    to: f.to || '',
    cc: f.cc || '',
    bcc: f.bcc || '',
    subject: f.subject || '',
    html: f.html || '',
    inReplyTo: f.inReplyTo || null,
    references: f.references || [],
  }
}

/**
 * @param composer     Composer
 * @param store        AccountStore (list: the From choices)
 * @param contacts     Contacts
 * @param openWindow   (sessionId) => BrowserWindow, the composer window
 * @param dialog       Electron dialog (showOpenDialog)
 * @param windowOf     (event) => BrowserWindow of the sender
 * The "e-mail bomb":
 * @param askSuspect   async (window, { mode, limit, reason }) => 'omit' | 'cancel': the shape check's question in the main window
 *                     (reason: 'run', a run over N = limit; 'switches', a block over B = limit direction switches)
 *                     (2.; window: the one that asked for the composer, or null); without it the answer is 'cancel'
 * @param onStalled    ({ kind, seconds }) => void: a composer was closed by the watchdog (1.); the main window tells why
 * @param readyTimeoutMs T (readyTimeoutFrom: never more than READY_TIMEOUT_MS)
 */
export function registerComposeIpc({
  ipcMain, composer, store, contacts, openWindow, dialog, windowOf, isTrustedSender, log = () => {},
  askSuspect = null, onStalled = () => {}, readyTimeoutMs = READY_TIMEOUT_MS, omittedText = '', onScheduled = () => {},
}) {
  const windows = new Map() // sessionId -> window
  const waiting = new Map() // sessionId -> the watchdog's timer, until compose:ready
  const shown = new Set() // sessions whose window its page showed (compose:checked)
  const origins = new Map() // sessionId -> { kind, request, asker }: what to ask (and to reopen) if the page finds it suspect

  const handle = (channel, fn) =>
    ipcMain.handle(channel, async (event, ...args) => {
      if (!isTrustedSender(event)) return { ok: false, error: 'untrusted_sender' }
      try {
        return { ok: true, ...(await fn(event, ...args)) }
      } catch (err) {
        if (err instanceof BadRequest) return { ok: false, error: 'bad_request' }
        if (err instanceof ActionError) return { ok: false, error: err.code, draftSaved: err.draftSaved, detail: err.detail }
        if (err && err.code === 'ENOENT') return { ok: false, error: 'file_not_found' }
        log(`${channel} failed: ${errCode(err)}`)
        return { ok: false, error: 'internal' }
      }
    })

  /**
   * 1. The watchdog. From the window's creation the composer has readyTimeoutMs to say it holds its starting body
   * (compose:ready). If it does not, its renderer is taken as stuck: the window is destroyed (no close question, its
   * page cannot answer; no draft is saved, the autosave lives in that page), the session ends, and the main window says
   * why. A ready that comes later finds nothing to stop. kind: reply | forward | draft | new | mailto (the notice's text).
   * 2. The window is created HIDDEN; it shows on its page's compose:checked (the starting body measured
   * and written), never for a suspect one (compose:suspect). request / asker: for the question and the reopening.
   */
  const openSession = (sessionId, kind = 'new', request = null, asker = null) => {
    const win = openWindow(sessionId)
    windows.set(sessionId, win)
    origins.set(sessionId, { kind, request, asker })
    const timer = setTimeout(() => {
      if (!waiting.delete(sessionId)) return
      log(`compose: the composer was not ready in ${readyTimeoutMs} ms, closed (${kind})`)
      if (!win.isDestroyed()) win.destroy() // 'closed' follows: the session ends there
      onStalled({ kind, seconds: readyTimeoutMs / 1000 })
    }, readyTimeoutMs)
    if (timer.unref) timer.unref() // the watchdog alone keeps no process alive
    waiting.set(sessionId, timer)
    win.on('closed', () => {
      clearTimeout(timer)
      waiting.delete(sessionId)
      origins.delete(sessionId)
      windows.delete(sessionId)
      shown.delete(sessionId)
      composer.close(sessionId)
    })
    return { sessionId }
  }
  // the window of this session, if the event came from it (a page may only speak for itself)
  const ownWindow = (event, sessionId) => {
    const win = windows.get(sessionId)
    return win && windowOf(event) === win && !win.isDestroyed() ? win : null
  }
  const kindOf = mode => (mode === 'forward' ? 'forward' : mode === 'draft' ? 'draft' : mode === 'reply' || mode === 'replyAll' ? 'reply' : 'new')

  // the composer holds its starting body and drew it; only its own window may say so
  handle('compose:ready', async (event, sessionId) => {
    if (!isSession(sessionId)) throw new BadRequest()
    if (!ownWindow(event, sessionId)) return {}
    const timer = waiting.get(sessionId)
    if (timer) {
      clearTimeout(timer)
      waiting.delete(sessionId)
    }
    return {}
  })

  // the page measured its starting body and wrote it: the window shows
  handle('compose:checked', async (event, sessionId) => {
    if (!isSession(sessionId)) throw new BadRequest()
    const win = ownWindow(event, sessionId)
    if (win && waiting.has(sessionId)) {
      win.show()
      shown.add(sessionId)
    }
    return {}
  })

  /**
   * The page found one unbroken run of text over N, or one block with more than B direction switches, in its starting
   * body and wrote nothing. The (hidden) window goes, the session ends, and the MAIN window asks: a reply or a forward may
   * open without the quote (a new session, the header line and one line for the body), anything else (a draft: its body
   * is not rewritten; a mailto link) only cancels. Too late (the watchdog already closed it): nothing.
   * reason: 'switches' (B) or 'run' (N); anything else is 'run'.
   */
  handle('compose:suspect', async (event, sessionId, reason) => {
    if (!isSession(sessionId)) throw new BadRequest()
    const win = ownWindow(event, sessionId)
    if (!win || !waiting.has(sessionId)) return {}
    clearTimeout(waiting.get(sessionId))
    waiting.delete(sessionId)
    const { kind, request, asker } = origins.get(sessionId) || { kind: 'new' }
    win.destroy() // 'closed' follows: the session ends there
    const mode = request ? request.mode : kind
    const canOmit = ['reply', 'replyAll', 'forward'].includes(mode)
    void (async () => {
      const why = reason === 'switches' ? 'switches' : 'run'
      const limit = why === 'switches' ? SWITCH_LIMIT : SHAPE_LIMIT
      const answer = askSuspect ? await askSuspect(asker && !asker.isDestroyed() ? asker : null, { mode, limit, reason: why }) : 'cancel'
      const omit = answer === 'omit' && canOmit
      log(`compose: the starting body has ${why === 'switches' ? 'a block with too many direction switches' : 'a run of text over the limit'} (${kind}): ${omit ? 'opened without the quote' : 'cancelled'}`)
      if (!omit) return
      const again = composer.open()
      try {
        await composer.prepare(again, { ...request, omitBody: omittedText })
      } catch (err) {
        composer.close(again)
        log(`compose: opening without the quote failed: ${errCode(err)}`)
        return
      }
      openSession(again, kind, null, asker)
    })().catch(err => log(`compose: the suspect question failed: ${errCode(err)}`))
    return {}
  })

  // request: undefined (a new message), { mode: reply | replyAll | forward, messageId }, or { mode: 'to', to } (a
  // new message to one address, the address book's "Levél írása"; one line, at most 320 characters, no control character)
  // draft key -> the open of its composer while it is being prepared (settles, never rejects)
  const openingDrafts = new Map()
  handle('compose:open', async (event, request) => {
    const byRfcId = isPlainObject(request) && request.mode === 'draft' && isId(request.accountId) && typeof request.draftMessageId === 'string' && request.draftMessageId.length <= 1000
    // "Megnyitás" in the scheduled list: the message in a composer (an open one comes forward, no second window)
    if (isPlainObject(request) && request.mode === 'scheduled') {
      if (!isId(request.scheduledId)) throw new BadRequest()
      const open = composer.sessionOfScheduled(request.scheduledId)
      const openWin = open ? windows.get(open) : null
      if (openWin && !openWin.isDestroyed()) {
        if (openWin.isMinimized()) openWin.restore()
        openWin.show()
        openWin.focus()
        return { sessionId: open, existing: true }
      }
      const sessionId = composer.open()
      try {
        composer.openScheduled(sessionId, request.scheduledId)
      } catch (err) {
        composer.close(sessionId)
        throw err
      }
      return openSession(sessionId)
    }
    const toOne = isPlainObject(request) && request.mode === 'to' && typeof request.to === 'string' && request.to.length > 0 && request.to.length <= 320 && !/[\u0000-\u001f\u007f,;<>]/.test(request.to)
    if (toOne) {
      const sessionId = composer.open()
      composer.prefillMailto(sessionId, { to: request.to })
      return openSession(sessionId)
    }
    if (request !== undefined && request !== null && !byRfcId && !(isPlainObject(request) && ['reply', 'replyAll', 'forward', 'draft'].includes(request.mode) && isId(request.messageId))) {
      throw new BadRequest()
    }
    // Claude's notice: the draft named by its Message-ID, found in the account's Drafts (waiting for its sync)
    if (byRfcId) request = { mode: 'draft', messageId: await composer.findDraft(request.accountId, request.draftMessageId) }
    // a draft already open in a composer: that window comes forward, no second one. A session knows its draft only
    // after its prepare, so a request for a draft whose composer is still being prepared waits for that one first
    // (a double click, two notices); from the wait to the bookkeeping below nothing awaits, so no two can pass
    const draftKey = request && request.mode === 'draft' ? composer.draftKey(request.messageId) : null
    while (draftKey && openingDrafts.has(draftKey)) await openingDrafts.get(draftKey)
    const editing = draftKey ? composer.sessionOfDraft(request.messageId) : null
    const editingWin = editing ? windows.get(editing) : null
    if (editingWin && !editingWin.isDestroyed()) {
      // only a window its page already showed (compose:checked): one still being checked stays hidden
      if (shown.has(editing)) {
        if (editingWin.isMinimized()) editingWin.restore()
        editingWin.show()
        editingWin.focus()
      }
      return { sessionId: editing, existing: true }
    }
    if (!draftKey) return openPrepared(event, request)
    const run = openPrepared(event, request)
    const done = run.then(() => {}, () => {}).finally(() => openingDrafts.delete(draftKey))
    openingDrafts.set(draftKey, done)
    return run
  })

  const openPrepared = async (event, request) => {
    const sessionId = composer.open()
    if (!request) return openSession(sessionId)
    try {
      await composer.prepare(sessionId, request)
    } catch (err) {
      composer.close(sessionId) // no window for an original that cannot be read
      throw err
    }
    // the shape of the starting body is checked by the composer page itself (compose:suspect / compose:checked)
    return openSession(sessionId, kindOf(request.mode), request, windowOf(event))
  }

  handle('compose:initial', async (_e, sessionId) => {
    if (!isSession(sessionId)) throw new BadRequest()
    return composer.initial(sessionId)
  })

  // the From choices with their signatures; nothing secret (store.list has no passwords)
  handle('compose:accounts', async () => ({
    accounts: store.list().map(a => ({ id: a.id, name: a.name, email: a.email, display_name: a.display_name, signature: a.signature, type: a.type, hasImage: Boolean(a.has_signature_image) })),
  }))

  handle('compose:suggest', async (_e, term) => {
    if (!str(term, 200)) throw new BadRequest()
    return { contacts: contacts.suggest(term || '') }
  })

  // paths: from a drop (webUtils.getPathForFile in the preload); null: the open dialog
  handle('compose:addFiles', async (event, sessionId, paths) => {
    if (!isSession(sessionId)) throw new BadRequest()
    let list = paths
    if (list === null || list === undefined) {
      const res = await dialog.showOpenDialog(windowOf(event), noRecent({ properties: ['openFile', 'multiSelections'] }))
      if (res.canceled) return { attachments: composer.attachmentList(sessionId), added: 0 }
      list = res.filePaths
    }
    if (!Array.isArray(list) || list.length > 100 || !list.every(p => typeof p === 'string' && p.length > 0 && p.length <= 4096)) throw new BadRequest()
    const added = composer.addFiles(sessionId, list)
    return { attachments: composer.attachmentList(sessionId), added: added.length }
  })

  // a pasted / dropped image's bytes (the renderer reads the File): -> { id, type, width, height, size }
  handle('compose:addImage', async (_e, sessionId, bytes) => {
    if (!isSession(sessionId) || !(bytes instanceof Uint8Array)) throw new BadRequest()
    return composer.addImage(sessionId, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
  })

  handle('compose:removeAttachment', async (_e, sessionId, attachmentId) => {
    if (!isSession(sessionId) || typeof attachmentId !== 'string') throw new BadRequest()
    composer.removeAttachment(sessionId, attachmentId)
    return { attachments: composer.attachmentList(sessionId) }
  })

  handle('compose:saveDraft', async (_e, sessionId, form) => {
    if (!isSession(sessionId)) throw new BadRequest()
    return composer.saveDraft(sessionId, parseForm(form))
  })

  // options: { archive: true } "Küldés és archiválás" (the original into the Archive after a successful send)
  handle('compose:send', async (_e, sessionId, form, options) => {
    if (!isSession(sessionId)) throw new BadRequest()
    if (options !== undefined && options !== null && !(isPlainObject(options) && Object.keys(options).every(k => k === 'archive') && (options.archive === undefined || typeof options.archive === 'boolean'))) throw new BadRequest()
    return composer.sendNow(sessionId, parseForm(form), { archive: Boolean(options && options.archive) })
  })

  // "Küldés később": the form as the send checks it, the time as a number of ms (the composer checks the range)
  handle('compose:schedule', async (_e, sessionId, form, sendAt) => {
    if (!isSession(sessionId) || typeof sendAt !== 'number' || !Number.isFinite(sendAt)) throw new BadRequest()
    const f = parseForm(form)
    const r = await composer.schedule(sessionId, f, sendAt)
    onScheduled(r.id, { subject: f.subject, sendAt })
    return r
  })

  handle('compose:discard', async (_e, sessionId) => {
    if (!isSession(sessionId)) throw new BadRequest()
    await composer.discardDraft(sessionId)
    return {}
  })

  // the page decided: the window may close now
  handle('compose:close', async (_e, sessionId) => {
    if (!isSession(sessionId)) throw new BadRequest()
    const win = windows.get(sessionId)
    if (win && !win.isDestroyed()) {
      win.__allowClose = true
      win.close()
    }
    return {}
  })

  /**
   * A mailto: link of the message frame (main.js, setWindowOpenHandler): a composer window
   * filled from the link. A link we do not take (too long, broken encoding) opens nothing. -> true if opened
   */
  const openMailto = href => {
    const fields = parseMailto(href)
    if (!fields) {
      log('mailto link not opened: not a valid or too long mailto: link')
      return false
    }
    const sessionId = composer.open()
    composer.prefillMailto(sessionId, fields)
    openSession(sessionId, 'mailto')
    return true
  }

  // before a lock every composer page saves through its autosave path and answers here
  const lockWaits = new Map() // sessionId -> (ok) => void
  handle('compose:lockDone', async (_e, sessionId, ok) => {
    if (!isSession(sessionId)) throw new BadRequest()
    const done = lockWaits.get(sessionId)
    if (done) done(ok === true)
    return {}
  })

  /**
   * Lock (not quit): every open composer saves its draft, then the windows close without asking. The
   * whole wait is at most timeoutMs; a page that does not answer in time counts as failed. keepFailed (a change of
   * the interface language): a window whose save failed stays open. -> { failed }
   */
  const saveAllForLock = async ({ timeoutMs = 10_000, keepFailed = false } = {}) => {
    const open = [...windows].filter(([, w]) => w && !w.isDestroyed())
    const results = new Map()
    const answers = open.map(
      ([sessionId, win]) =>
        new Promise(resolve => {
          lockWaits.set(sessionId, ok => {
            results.set(sessionId, ok)
            resolve()
          })
          win.webContents.send('compose:lockRequested')
        }),
    )
    let timer = null
    await Promise.race([Promise.all(answers), new Promise(resolve => (timer = setTimeout(resolve, timeoutMs)))])
    clearTimeout(timer)
    lockWaits.clear()
    for (const [sessionId, win] of open) {
      if (win.isDestroyed() || (keepFailed && results.get(sessionId) !== true)) continue
      win.__allowClose = true
      win.close()
    }
    return { failed: open.filter(([sessionId]) => results.get(sessionId) !== true).length }
  }

  return { windows, openMailto, saveAllForLock }
}

/**
 * Holds a composer window's close until its page answered (compose:close). quitting(): the app is
 * quitting (Windows shutdown, the last window, a test harness): then the window closes without asking,
 * otherwise it would keep the app alive forever; the 60 s autosave limits what can be lost.
 */
export function guardComposerClose(win, quitting = () => false) {
  win.on('close', event => {
    if (win.__allowClose || quitting()) return
    event.preventDefault()
    win.webContents.send('compose:closeRequested')
  })
}
