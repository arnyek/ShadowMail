// SPDX-License-Identifier: GPL-3.0-or-later
// Composing and sending. No Electron import: tested with a local SMTP
// server and the fake IMAP server.
//
// A compose session lives in the main process: its account, its draft (same Message-ID on every save)
// and its attachments (read into memory when added; their contents never go to the renderer).
// - Draft, IMAP: the old version(s) are found by Message-ID in Drafts (works without UIDPLUS), the new one
//   is APPENDed (\Draft \Seen), then the old ones are deleted: there is always exactly one copy.
//   POP3: a row in the local Drafts with its .eml in data/store, replaced on every save.
// - Send: SMTP with the account's security mode; then the copy in Sent (IMAP: APPEND, unless
//   save_sent_to_server = 0, e.g. Gmail saves it itself; POP3: local Sent) and the draft goes.
//   A failed send keeps the message: it is saved as a draft (best effort) and the error is returned.
import { visibleComposeHtml } from '../../core/mime/visible-text.js'
import { expungeMessages } from '../../core/imap/actions.js'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import addressparser from 'nodemailer/lib/addressparser'
import { t, locale } from '../renderer/i18n/index.js'
import { composeMessage, newMessageId, mailtoBodyHtml, replySubject, forwardSubject, replyReferences, replyRecipients, quoteHtml, forwardHtml } from '../../core/smtp/compose.js'
import { changeFlags } from '../../core/imap/actions.js'
import { applyFlagChange } from './actions.js'
import { sendRaw } from '../../core/smtp/send.js'
import { SHOWN_WIDTH, shownWidth } from '../../core/smtp/image-width.js'
import { classifyError } from '../../core/accounts/probe.js'
import { assignRoles } from '../../core/imap/folders.js'
import { safeFileName, parseMessage } from '../../core/mime/message.js'
import { bodyFromSource } from '../../core/mime/text.js'
import { fmtAddrs } from '../../core/mime/envelope.js'
import { ActionError } from './sync-manager.js'
import { errCode } from '../../core/log-safe.js'
import { SIG_CID_RE, unwrapSignature } from '../../core/smtp/signature.js'
import { SIGNATURE_TYPES, prepareInlineImage, SignatureImageError } from '../../core/accounts/signature-image.js'
import { checkSendAt } from '../../core/db/scheduled.js'
import { labelKeyOf } from '../../core/db/label-key.js'

// the session image of a scheduled message: its html names this instead of a session id (a new session sends it)
const SCHEDULED_SESSION = 'scheduled-session'

export const MAX_ATTACHMENTS_BYTES = 25 * 1024 * 1024 // most servers refuse bigger messages
// a pasted image wider than this shows at this width in the sent HTML when no size was chosen (its bytes are not touched)
export const INLINE_IMAGE_SHOWN_WIDTH = SHOWN_WIDTH
// our own inline part of a pasted image, in a saved draft (taken back into the session when the draft opens again)
export const IMG_CID_RE = /^img-[0-9a-f]{24}@shadowmail$/
const INL_IMG_RE = /<img\b[^>]*?\bsrc="inl-img:\/\/session\/([A-Za-z0-9_-]{1,64})\/([0-9a-f]{24})"[^>]*>/g
const EMAIL = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/

/** "Név <a@example.invalid>, c@example.invalid" or a list of such strings -> [{ name, address }]; bad ones -> { bad: [...] }. */
export function parseRecipients(input) {
  const parts = Array.isArray(input) ? input : [input]
  const ok = []
  const bad = []
  for (const p of parts) {
    if (!p || !String(p).trim()) continue
    for (const a of addressparser(String(p), { flatten: true })) {
      if (a.address && EMAIL.test(a.address)) ok.push({ name: a.name || '', address: a.address })
      else bad.push(a.address || a.name || String(p))
    }
  }
  return { ok, bad }
}

/**
 * "Name <address>" for a recipient field. A name with an RFC 5322 special ( ) < > [ ] : ; @ \ , . "
 * is quoted, with " and \ taken out, so the field parses back (a name ending in \
 * or holding "(" made "reply all" fail with bad_address). Same rule in Composer.jsx (fmtContact).
 */
export function displayAddress({ name, address }) {
  if (!name) return address
  const clean = String(name).replace(/["\\]/g, '').trim()
  if (!clean) return address
  return `${/[()<>[\]:;@,.]/.test(clean) ? `"${clean}"` : clean} <${address}>`
}

// Two IMAP accounts on one login (an alias sender): one mailbox, so one Drafts.
const sameImapMailbox = (a, b) =>
  Boolean(a && b) && a.type !== 'pop3' && b.type !== 'pop3' &&
  String(a.in_host || '').trim().toLowerCase() === String(b.in_host || '').trim().toLowerCase() &&
  Number(a.in_port) === Number(b.in_port) && String(a.in_user || '').toLowerCase() === String(b.in_user || '').toLowerCase()

const roleFolder = (index, accountId, role) => {
  for (const [p, r] of assignRoles(index.folderList(accountId))) if (r === role) return p
  return null
}

// a draft Claude made carries this header (gone from the sent message) and
// this IMAP keyword (POP3: the local flags column), which gives it the "Claude" mark in the Drafts list
const escapeHtml = v => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
export const CLAUDE_HEADER = 'X-ShadowMail-Draft-Origin'
export const CLAUDE_KEYWORD = '$ShadowMailClaude'

const draftKeyOf = (accountId, messageId) => `${accountId}\u0000${String(messageId).replace(/^<|>$/g, '')}`

export class Composer {
  // scheduled ids being turned back into drafts ("Időzítés törlése"): held from the scheduler
  #unscheduling = new Set()

  /**
   * @param index, store (getRow, list, passwordsFor), contacts (Contacts)
   * @param storeDir        data/store (POP3 drafts and sent copies; removing them)
   * @param sealed          SealedStore of data/store: a POP3 draft or sent copy is written through it
   * @param withConnection  SyncManager#withConnection (IMAP: drafts, sent copy)
   * @param requestSync     (accountId, folders)
   * @param onChange        ({ accountId, folders }) after a local (POP3) change
   * @param send            sendRaw (injected in tests)
   */
  constructor({ index, store, contacts, storeDir, sealed = null, dataDir = null, withConnection, reader = null, decodeImage = null, uprightImage = null, requestSync = () => {}, onChange = () => {}, send = sendRaw, now = () => Date.now(), log = () => {}, searchText = null, scheduled = null, onScheduledChange = () => {}, labels = null }) {
    this.labels = labels // core/db/labels.js Labels: an IMAP draft saved again keeps its old copy's label keywords, or null
    this.decodeImage = decodeImage // bytes -> { width, height } | null (Electron nativeImage), for a pasted image; null: none
    this.uprightImage = uprightImage // (bytes, type, orientation) -> bytes turned upright (app/main/image-codec.js)
    this.scheduled = scheduled // core/db/scheduled.js Scheduled ("Küldés később"), or null
    this.onScheduledChange = onScheduledChange // () a scheduled row changed from a composer (the list reloads)
    this.searchText = searchText // the worker thread's refiner, or null (the visible text made here)
    this.dataDir = dataDir ? path.resolve(dataDir) : null
    this.reader = reader // the original of a reply / forward (MessageReader.source)
    this.index = index
    this.store = store
    this.contacts = contacts
    this.storeDir = path.resolve(storeDir)
    this.sealed = sealed
    this.withConnection = withConnection
    this.requestSync = requestSync
    this.onChange = onChange
    this.send = send
    this.now = now
    this.log = log
    this.sessions = new Map()
  }

  /** A new compose session (one per composer window). */
  open() {
    const id = crypto.randomUUID()
    // chain: saves, sends and discards of one session run one after the other
    // sent: the message went out; the session saves and sends nothing more
    // staleDrafts: accounts still holding this session's draft after a From change
    this.sessions.set(id, { id, messageId: null, draftAccountId: null, attachments: new Map(), inlineImages: new Map(), saved: false, sent: false, staleDrafts: new Set(), chain: Promise.resolve(), origin: null, initial: null })
    return id
  }

  /** The identity of a saved draft (index id): its account and bare Message-ID, as one string; or null. */
  draftKey(id) {
    const row = this.index.get(id)
    return row && row.message_id ? draftKeyOf(row.account_id, row.message_id) : null
  }

  /**
   * The open session editing this saved draft (index id): the same account and Message-ID, not sent yet; or null.
   * One draft, one composer: two windows would overwrite each other's saves. `except`: a session not to count (the
   * caller's own, e.g. MCP update_draft's, which holds the same draft).
   */
  sessionOfDraft(id, except = null) {
    const key = this.draftKey(id)
    if (!key) return null
    for (const s of this.sessions.values()) {
      if (s.id !== except && !s.sent && s.messageId && draftKeyOf(s.draftAccountId, s.messageId) === key) return s.id
    }
    return null
  }

  close(id) {
    const s = this.sessions.get(id)
    this.sessions.delete(id)
    // a scheduled message's composer closed: the list shows it free again
    if (s && s.scheduledId && !s.sent) this.onScheduledChange()
  }

  #session(id) {
    const s = this.sessions.get(id)
    if (!s) throw new ActionError('no_session')
    return s
  }

  /** Runs fn after everything the session started before it has finished. */
  #exclusive(s, fn) {
    const run = s.chain.then(fn)
    s.chain = run.catch(() => {})
    return run
  }

  /**
   * The app's own data (mail.sqlite, the cache, the vault) is never an attachment.
   * Returns an open descriptor of the checked file: what is read is what was checked.
   */
  #openAttachment(p) {
    const real = fs.realpathSync(p)
    let forbidden = null
    if (this.dataDir) {
      const dataReal = fs.realpathSync(this.dataDir)
      const inside = path.relative(dataReal, real)
      const outside = inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)
      if (!outside) throw new ActionError('forbidden_path')
      // a hard link elsewhere to a file of the data folder's top level: mail.sqlite and its companions,
      // the vault. The cached .eml files under store\ are not walked (thousands of files at every
      // attachment); they are the user's own mail, which the user may attach anyway.
      forbidden = new Set()
      for (const e of fs.readdirSync(dataReal, { withFileTypes: true })) {
        if (!e.isFile()) continue
        try {
          const st = fs.statSync(path.join(dataReal, e.name), { bigint: true })
          // a file system without file ids reports 0 for every file: that would forbid everything there
          if (st.ino !== 0n) forbidden.add(`${st.dev}:${st.ino}`)
        } catch {
          // gone meanwhile
        }
      }
    }
    // only a regular file is opened: a folder cannot be opened on Windows, a FIFO would block the
    // main process on open; the descriptor is checked again below
    if (!fs.statSync(real).isFile()) throw new ActionError('not_a_file')
    const fd = fs.openSync(real, 'r')
    try {
      const st = fs.fstatSync(fd, { bigint: true })
      if (!st.isFile()) throw new ActionError('not_a_file')
      if (forbidden && forbidden.has(`${st.dev}:${st.ino}`)) throw new ActionError('forbidden_path')
      return fd
    } catch (err) {
      fs.closeSync(fd)
      throw err
    }
  }

  /**
   * A mailto: link: the session starts from the link's fields ({ to, cc, subject, body } of
   * parseMailto, body as plain text). No account is chosen: the composer takes its first one.
   */
  prefillMailto(sessionId, { to = '', cc = '', subject = '', body = '' }) {
    const s = this.#session(sessionId)
    s.initial = { accountId: null, to, cc, subject, body: mailtoBodyHtml(body), quote: '', inReplyTo: null, references: [] }
    return s.initial
  }

  /**
   * Fills the session from an original message. mode: reply | replyAll | forward.
   * -> the composer's starting form { accountId, to, cc, subject, quote, inReplyTo, references } (quote is HTML
   * the page sanitizes); a forward also gets the original's attachments (byte for byte, inline images too).
   */
  /** A draft Claude made: the X-ShadowMail-Draft-Origin header and the $ShadowMailClaude keyword. */
  markClaude(sessionId) {
    this.#session(sessionId).claude = true
  }

  /**
   * The index id of an account's draft by its Message-ID (Claude's notice). An IMAP draft appears with the
   * Drafts folder's sync: asked for once, waited for up to `waitMs`; ActionError('not_found') when not there yet.
   */
  async findDraft(accountId, rfcId, { waitMs = 5000 } = {}) {
    const drafts = roleFolder(this.index, accountId, 'drafts')
    if (!drafts) throw new ActionError('not_found')
    const want = String(rfcId).replace(/^<|>$/g, '')
    const find = () =>
      this.index.db
        .prepare('SELECT id FROM messages WHERE account_id = ? AND folder = ? AND message_id IN (?, ?) ORDER BY id DESC')
        .get(accountId, drafts, want, `<${want}>`)
    let row = find()
    if (!row) {
      this.requestSync(accountId, [drafts])
      const until = Date.now() + waitMs
      while (!row && Date.now() < until) {
        await new Promise(r => setTimeout(r, 100))
        row = find()
      }
    }
    if (!row) throw new ActionError('not_found')
    return row.id
  }

  /**
   * The draft with this Message-ID is still in the account's Drafts, as this copy. IMAP: asked from
   * the server (a save or a send by the user replaces or removes it there before the sync tells the index); POP3: the row.
   */
  async draftPresent(accountId, messageId, uid) {
    const account = this.store.getRow(accountId)
    const drafts = account ? roleFolder(this.index, accountId, 'drafts') : null
    if (!drafts || !messageId) return false
    if (account.type === 'pop3') return Boolean(this.index.db.prepare('SELECT 1 FROM messages WHERE account_id = ? AND folder = ? AND message_id = ?').get(accountId, drafts, messageId))
    const want = `<${String(messageId).replace(/^<|>$/g, '')}>`
    const uids = await this.withConnection(accountId, async client => {
      const lock = await client.getMailboxLock(drafts, { readOnly: true })
      try {
        return (await client.search({ header: { 'message-id': want } }, { uid: true })) || []
      } finally {
        lock.release()
      }
    })
    return uids.map(Number).includes(Number(uid))
  }

  /** The session's Message-ID (set by the first save). */
  messageIdOf(sessionId) {
    return this.#session(sessionId).messageId || null
  }

  /**
   * omitBody: a line of text that stands in the quote instead of the original's body (the
   * "[Idézet nélkül]" answer to the shape check); the header line of a reply or a forward stays, and a forward's
   * attachments go as they would. Not for a draft (its body is not rewritten).
   */
  async prepare(sessionId, { mode, messageId, safeQuote = false, omitBody = null }) {
    const s = this.#session(sessionId)
    if (!this.reader) throw new ActionError('not_available')
    const { row, source } = await this.reader.source(messageId)
    const parsed = await parseMessage(source)
    // safeQuote (MCP, no composer window to sanitize it): the quote's body is the original's VISIBLE
    // part as the composer's own HTML (sanitizeCompose's tags, <a href> only), so no foreign HTML or hidden text is
    // written into a draft nobody has looked at yet
    // an empty visible part (all hidden, or too complex to filter) quotes NOTHING: never the text/plain part, which
    // may carry what the HTML hides
    let original = safeQuote && parsed.html ? { ...parsed, html: visibleComposeHtml(parsed.html) || '<p></p>', text: '' } : parsed
    if (typeof omitBody === 'string' && mode !== 'draft') original = { ...original, html: null, text: omitBody }
    const account = this.store.getRow(row.account_id)
    if (!account) throw new ActionError('not_found')
    const fmt = list => list.map(a => displayAddress(a)).join(', ')
    let form
    if (mode === 'draft') {
      // a saved draft opened again ("Megnyitás" on Claude's notice): the same Message-ID, so a
      // save replaces it; its attachments; a draft Claude made stays Claude's (header + keyword)
      const drafts = roleFolder(this.index, account.id, 'drafts')
      if (!drafts || row.folder !== drafts) throw new ActionError('not_a_draft')
      for (const a of parsed.attachments.filter(x => !x.inline)) {
        const att = { id: crypto.randomUUID(), filename: a.filename, content: a.content, contentType: a.contentType }
        s.attachments.set(att.id, att)
      }
      s.messageId = parsed.messageId ? `<${String(parsed.messageId).replace(/^<|>$/g, '')}>` : null
      s.saved = true
      s.draftAccountId = account.id
      s.claude = parsed.draftOrigin === 'claude'
      // our own signature image (a sig-...@shadowmail cid): the draft's OWN bytes, shown again as sig-img://session/<id>
      let html = parsed.html || `<p>${escapeHtml(parsed.text || '').replace(/\r?\n/g, '<br>')}</p>`
      s.signatureImage = null
      for (const a of parsed.attachments) {
        const cid = a.cid ? String(a.cid).replace(/^<|>$/g, '') : ''
        if (!SIG_CID_RE.test(cid) || !SIGNATURE_TYPES.includes(a.contentType) || !html.includes(`cid:${cid}`)) continue
        s.signatureImage = { type: a.contentType, bytes: Buffer.from(a.content) }
        html = html.split(`cid:${cid}`).join(`sig-img://session/${s.id}`)
        break
      }
      // our own pasted images (img-...@shadowmail parts the HTML refers to): the session's images again, checked and
      // cleaned as when pasted (a draft on the server is not trusted more than a paste)
      for (const a of parsed.attachments) {
        const cid = a.cid ? String(a.cid).replace(/^<|>$/g, '') : ''
        if (!IMG_CID_RE.test(cid) || !html.includes(`cid:${cid}`) || !this.decodeImage) continue
        let img
        try {
          img = prepareInlineImage(Buffer.from(a.content), { decode: this.decodeImage, upright: this.uprightImage })
        } catch {
          continue // left as a cid: image, which the editor's sanitizer drops
        }
        const id = crypto.randomBytes(12).toString('hex')
        s.inlineImages.set(id, { type: img.type, bytes: img.bytes, width: img.width, height: img.height })
        html = html.split(`cid:${cid}`).join(`inl-img://session/${s.id}/${id}`)
      }
      form = {
        accountId: account.id,
        to: fmt(parsed.to),
        cc: fmt(parsed.cc),
        bcc: fmt(parsed.bcc),
        subject: parsed.subject || '',
        draftHtml: html,
        inReplyTo: parsed.inReplyTo,
        references: parsed.references,
      }
      s.initial = form
      return form
    }
    if (mode === 'forward') {
      for (const a of original.attachments) {
        const att = { id: crypto.randomUUID(), filename: a.filename, content: a.content, contentType: a.contentType }
        s.attachments.set(att.id, att)
      }
      form = { accountId: account.id, to: '', cc: '', subject: forwardSubject(original.subject), quote: forwardHtml(original, t.outgoingQuote, locale), inReplyTo: null, references: [] }
    } else {
      const own = this.store.list().map(a => a.email).filter(Boolean)
      const { to, cc } = replyRecipients(original, { all: mode === 'replyAll', ownAddresses: own })
      form = {
        accountId: account.id,
        to: fmt(to),
        cc: fmt(cc),
        subject: replySubject(original.subject),
        quote: quoteHtml(original, t.outgoingQuote, locale),
        inReplyTo: original.messageId,
        references: replyReferences(original),
      }
    }
    s.origin = { id: row.id, accountId: row.account_id, messageId: row.message_id || null, flag: mode === 'forward' ? '$Forwarded' : '\\Answered' }
    s.initial = form
    return form
  }

  /** The starting form of a prepared session (or null for a new message) and its attachments. */
  initial(sessionId) {
    const s = this.#session(sessionId)
    return { form: s.initial, attachments: this.attachmentList(sessionId) }
  }

  /** After a reply / forward went out: \Answered or $Forwarded on the original (server for IMAP, here for POP3). */
  async #markOrigin(origin) {
    // Row ids are reused (no AUTOINCREMENT): if the original was deleted meanwhile, the id may be another
    // message's now. So the row must still carry the original's Message-ID; if not,
    // a row of the same account with that Message-ID is taken, or nothing is marked.
    let row = this.index.get(origin.id)
    if (row && origin.messageId && (row.message_id !== origin.messageId || row.account_id !== origin.accountId)) row = null
    if (!row && origin.messageId) {
      row = this.index.db.prepare('SELECT * FROM messages WHERE account_id = ? AND message_id = ? ORDER BY id LIMIT 1').get(origin.accountId, origin.messageId) || null
    }
    if (!row) return
    const change = { add: [origin.flag], remove: [] }
    if (row.uid !== null && row.uid !== undefined) {
      const expect = { uidvalidity: (this.index.getFolder(row.account_id, row.folder) || {}).uidvalidity ?? null }
      await this.withConnection(row.account_id, client => changeFlags(client, row.folder, [row.uid], change, expect))
    }
    this.index.setFlagsById(row.id, applyFlagChange(row.flags, change))
    this.onChange({ accountId: row.account_id, folders: [row.folder] })
  }

  /** Reads files into the session. -> [{ id, filename, size }] */
  addFiles(sessionId, filePaths) {
    const s = this.#session(sessionId)
    let total = this.#sessionBytes(s)
    // every file is read before any joins the session: a bad one in the batch adds none
    const added = []
    const batch = []
    for (const p of filePaths) {
      const fd = this.#openAttachment(p)
      let content
      try {
        if (total + Number(fs.fstatSync(fd).size) > MAX_ATTACHMENTS_BYTES) throw new ActionError('too_large')
        content = fs.readFileSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      if (total + content.length > MAX_ATTACHMENTS_BYTES) throw new ActionError('too_large')
      total += content.length
      batch.push({ id: crypto.randomUUID(), filename: safeFileName(path.basename(p)), content })
    }
    for (const att of batch) {
      s.attachments.set(att.id, att)
      added.push({ id: att.id, filename: att.filename, size: att.content.length })
    }
    return added
  }

  removeAttachment(sessionId, attachmentId) {
    this.#session(sessionId).attachments.delete(attachmentId)
  }

  /** The session's attachments with their SHA-256, what a confirmation request is bound to. */
  attachmentDigests(sessionId) {
    return [...this.#session(sessionId).attachments.values()].map(a => ({ filename: a.filename, size: a.content.length, sha256: crypto.createHash('sha256').update(a.content).digest('hex') }))
  }

  attachmentList(sessionId) {
    return [...this.#session(sessionId).attachments.values()].map(a => ({ id: a.id, filename: a.filename, size: a.content.length }))
  }

  // the session's attachments and pasted images together: one 25 MB limit (MAX_ATTACHMENTS_BYTES)
  #sessionBytes(s) {
    let n = 0
    for (const a of s.attachments.values()) n += a.content.length
    for (const img of s.inlineImages.values()) n += img.bytes.length
    return n
  }

  /**
   * A pasted or dropped image into the session, cleaned like the signature image (prepareInlineImage: PNG / JPEG, the
   * metadata out, the rotation rule) and shown as inl-img://session/<session>/<id>. -> { id, type, width, height, size }.
   * Errors (ActionError, the reason's numbers in `detail`): too_large (over 10 MB as it comes, or the session's
   * attachments and images over 25 MB), not_inline (GIF, WebP, HEIC...: the editor attaches it instead),
   * unsupported_image, not_available (no decoder). A turned photo (an Exif Orientation) is turned upright by `uprightImage`.
   */
  addImage(sessionId, bytes) {
    const s = this.#session(sessionId)
    if (!this.decodeImage) throw new ActionError('not_available')
    let img
    try {
      img = prepareInlineImage(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes), { decode: this.decodeImage, upright: this.uprightImage })
    } catch (err) {
      if (err instanceof SignatureImageError) throw Object.assign(new ActionError(err.code), { detail: err.info })
      throw err
    }
    if (this.#sessionBytes(s) + img.bytes.length > MAX_ATTACHMENTS_BYTES) throw Object.assign(new ActionError('too_large'), { detail: { maxBytes: MAX_ATTACHMENTS_BYTES } })
    const id = crypto.randomBytes(12).toString('hex')
    s.inlineImages.set(id, { type: img.type, bytes: img.bytes, width: img.width, height: img.height })
    return { id, type: img.type, width: img.width, height: img.height, size: img.bytes.length }
  }

  /** The image behind an inl-img://session/<session>/<id> src, for the inl-img scheme: { type, bytes } or null. */
  inlineImageOf(sessionId, id) {
    const s = this.sessions.get(sessionId)
    const img = s && s.inlineImages ? s.inlineImages.get(id) : null
    return img ? { type: img.type, bytes: img.bytes } : null
  }

  /**
   * The pasted images of an outgoing HTML: each inl-img of THIS session -> an inline part (cid:img-<random>@shadowmail,
   * one part per image however often it shows); its width attribute is the composer's choice from the size menu, at
   * most the image's own width, else width="800" for an image wider than INLINE_IMAGE_SHOWN_WIDTH (core/smtp/image-width.js;
   * the bytes stay). Another session's src, or an id the session does not have, is left out; an image the text no longer
   * refers to (deleted in the editor) is not sent. -> { html, inline }
   */
  #inlineParts(s, html) {
    const inline = []
    const cids = new Map()
    const out = html.replace(INL_IMG_RE, (m, sess, id) => {
      const img = sess === s.id ? s.inlineImages.get(id) : null
      if (!img) return ''
      if (!cids.has(id)) {
        const cid = `img-${crypto.randomBytes(12).toString('hex')}@shadowmail`
        inline.push({ filename: img.type === 'image/png' ? 'image.png' : 'image.jpg', content: img.bytes, contentType: img.type, cid, inline: true })
        cids.set(id, cid)
      }
      const asked = /\swidth="([^"]*)"/.exec(m)
      const shown = shownWidth(img.width, asked ? asked[1] : null)
      const width = shown ? ` width="${shown}"` : ''
      return `<img src="cid:${cids.get(id)}" alt=""${width}>`
    })
    return { html: out, inline }
  }

  /**
   * The editor's signature in an outgoing HTML: each sig-img image -> an inline part (cid:sig-<random>@shadowmail, one
   * part per image source) and the marked block unwrapped. Only the sender's own account image or this session's draft
   * image is served; any other sig-img source is left out. A draft save keeps the marker (the reopened draft's sender
   * change still finds its block); the send path always unwraps it. -> { html, inline }
   */
  #signatureParts(s, accountId, html, { keepMarker = false } = {}) {
    const inline = []
    const cids = new Map()
    const out = html.replace(/<img\b[^>]*?\bsrc="sig-img:\/\/(?:account\/(\d{1,12})|session\/([A-Za-z0-9_-]{1,64}))"[^>]*>/g, (m, acc, sess) => {
      const key = acc ? `account/${acc}` : `session/${sess}`
      if (!cids.has(key)) {
        const img = acc ? (Number(acc) === accountId ? this.store.signatureImage(accountId) : null) : sess === s.id ? s.signatureImage : null
        if (!img) cids.set(key, null)
        else {
          const cid = `sig-${crypto.randomBytes(12).toString('hex')}@shadowmail`
          inline.push({ filename: img.type === 'image/png' ? 'signature.png' : 'signature.jpg', content: img.bytes, contentType: img.type, cid, inline: true })
          cids.set(key, cid)
        }
      }
      const cid = cids.get(key)
      return cid ? `<img src="cid:${cid}" alt="">` : ''
    })
    return { html: keepMarker ? out : unwrapSignature(out), inline }
  }

  /** The image behind an editor's sig-img:// src, for the sig-img protocol: { type, bytes } or null. */
  signatureImageOf(kind, ref) {
    if (kind === 'account') return this.store.signatureImage(Number(ref))
    if (kind === 'session') {
      const s = this.sessions.get(ref)
      return s ? s.signatureImage || null : null
    }
    return null
  }

  /** The form -> a composed message (also validates). */
  async #compose(s, form, { claude = false, draft = false } = {}) {
    const account = this.store.getRow(form.accountId)
    if (!account) throw new ActionError('not_found')
    const to = parseRecipients(form.to)
    const cc = parseRecipients(form.cc)
    const bcc = parseRecipients(form.bcc)
    const bad = [...to.bad, ...cc.bad, ...bcc.bad]
    if (bad.length) throw Object.assign(new ActionError('bad_address'), { detail: bad })
    // a session keeps its Message-ID: every draft save replaces the same message
    if (!s.messageId) s.messageId = newMessageId(account.email)
    const signed = this.#signatureParts(s, account.id, form.html || '', { keepMarker: draft })
    const pasted = this.#inlineParts(s, signed.html)
    const body = { html: pasted.html, inline: [...signed.inline, ...pasted.inline] }
    const msg = await composeMessage({
      from: { name: account.display_name || '', address: account.email },
      to: to.ok,
      cc: cc.ok,
      bcc: bcc.ok,
      subject: form.subject || '',
      html: body.html || null,
      attachments: [...s.attachments.values(), ...body.inline],
      inReplyTo: form.inReplyTo || null,
      references: form.references || [],
      messageId: s.messageId,
      date: new Date(this.now()),
      // only on a saved draft: the sent message is composed again without it
      headers: claude ? { [CLAUDE_HEADER]: 'claude' } : {},
    })
    return { account, msg, recipients: [...to.ok, ...cc.ok, ...bcc.ok] }
  }

  /** POP3: one local row for the message in a local folder (replacing an older one with the same Message-ID). */
  async #saveLocal(account, folder, msg, flags) {
    await this.#deleteLocal(account.id, folder, msg.messageId, { notify: false })
    const rel = `${account.id}/${folder.toLowerCase()}-${crypto.createHash('sha256').update(msg.messageId).digest('hex').slice(0, 32)}.eml`
    if (!this.sealed) throw new Error('no sealed store') // never a plain copy
    this.sealed.write(rel, msg.sentCopy)
    const p = await parseMessage(msg.sentCopy)
    const now = this.now()
    this.index.insertMany([{
      account_id: account.id, folder, uid: null, pop3_uidl: null, message_id: msg.messageId, in_reply_to: p.inReplyTo, refs: p.references.join(' ') || null,
      from_addr: account.email, from_name: account.display_name || '', to_addrs: fmtAddrs(p.to), cc_addrs: fmtAddrs(p.cc), bcc_addrs: fmtAddrs(p.bcc), subject: p.subject,
      date: now, idate: now, flags, size: msg.sentCopy.length, has_attachments: p.attachments.some(a => !a.inline) ? 1 : 0, attachments: null,
      store_path: rel, body_state: 0, sender_text: fmtAddrs(p.from), recipients_text: fmtAddrs([...p.to, ...p.cc]),
    }])
    const row = this.index.db.prepare('SELECT id FROM messages WHERE account_id = ? AND folder = ? AND message_id = ? ORDER BY id DESC').get(account.id, folder, msg.messageId)
    const body = await bodyFromSource(msg.sentCopy, { oldText: Boolean(this.searchText) })
    this.index.setBodies([{ id: row.id, text: body.text, state: body.state, preview: body.preview }])
    // the visible text from the worker thread (a local source)
    if (this.searchText && body.state === 1) await this.searchText.refine({ id: row.id, accountId: account.id, local: true, storePath: rel })
    this.onChange({ accountId: account.id, folders: [folder] })
  }

  async #deleteLocal(accountId, folder, messageId, { notify = true } = {}) {
    const rows = this.index.db.prepare('SELECT id, store_path FROM messages WHERE account_id = ? AND folder = ? AND message_id = ?').all(accountId, folder, messageId)
    if (!rows.length) return
    this.index.deleteIds(rows.map(r => r.id))
    for (const r of rows) if (r.store_path) fs.rmSync(path.join(this.storeDir, r.store_path), { force: true })
    if (notify) this.onChange({ accountId, folders: [folder] })
  }

  /**
   * IMAP: APPEND the new copy, then delete the older ones (found by Message-ID before the APPEND). labelKeywords: the old
   * copy's label keywords (a draft saved again); a server that refuses them (NO, false) gets the copy without them, and
   * the labels are then bound locally by the message's key. The Claude keyword goes the same way, last.
   */
  async #replaceOnServer(accountId, folder, raw, messageId, flags, { replace, labelKeywords = [] }) {
    await this.withConnection(accountId, async client => {
      let old = []
      if (replace) {
        const lock = await client.getMailboxLock(folder)
        try {
          old = (await client.search({ header: { 'message-id': messageId } }, { uid: true })) || []
        } finally {
          lock.release()
        }
      }
      // the flag lists tried in turn: everything; without the label keywords; without the Claude keyword too. A server
      // without custom keywords (PERMANENTFLAGS) answers NO or false: the draft is saved, only the marks are missing
      const kws = labelKeywords.map(l => l.keyword)
      const tries = [[...flags, ...kws]]
      if (kws.length) tries.push(flags)
      if (flags.includes(CLAUDE_KEYWORD)) tries.push(flags.filter(f => f !== CLAUDE_KEYWORD))
      let res = false
      for (const [i, list] of tries.entries()) {
        try {
          res = await client.append(folder, raw, list, new Date(this.now()))
        } catch (err) {
          // the server's NO to a keyword: the next list; anything else (network), or the last list, fails
          if (!(i < tries.length - 1 && err && err.responseStatus === 'NO')) throw err
          res = false
        }
        if (res) {
          if (i > 0 && kws.length && this.labels) for (const l of labelKeywords) this.labels.bindKey(accountId, labelKeyOf({ message_id: messageId }), l.id)
          break
        }
      }
      if (!res) throw Object.assign(new Error('APPEND refused'), { code: 'server_refused' })
      if (old.length) {
        const lock = await client.getMailboxLock(folder)
        try {
          await client.messageDelete(old.join(','), { uid: true })
        } finally {
          lock.release()
        }
      }
    })
    this.requestSync(accountId, [folder])
  }

  // a composer opened from the scheduled list saves into the scheduled message (its sealed payload), not into Drafts
  async #saveScheduled(s, form) {
    const { account, recipients } = await this.#compose(s, form, { draft: true })
    // it is still to go out at its time: without a recipient it would only fail then
    if (!recipients.length) throw new ActionError('no_recipients')
    const old = this.scheduled.get(s.scheduledId)
    if (!old) throw new ActionError('not_found')
    const rel = this.#writePayload(s, form, account.id)
    // saved by the user in a composer: from now on the user's scheduled message, whoever scheduled it first
    if (!this.scheduled.setPayload(s.scheduledId, { accountId: account.id, payloadPath: rel, subject: form.subject || '', recipients: recipients.map(r => r.address || r).join(', ').slice(0, 2000), claude: false })) {
      this.#removeSealed(rel)
      throw new ActionError('not_found')
    }
    if (old.payload_path !== rel) this.#removeSealed(old.payload_path)
    this.onScheduledChange()
    return { savedAt: this.now(), oldDraftLeft: false, scheduled: true }
  }

  /** Removes the session's draft ("Elvetés" in the composer); after a save still running, not before it. */
  async discardDraft(sessionId) {
    const s = this.#session(sessionId)
    // opened from the scheduled list: "Elvetés" removes the scheduled message (it has no Drafts copy)
    return this.#exclusive(s, () => (s.scheduledId && !s.sent ? this.#dropScheduled(s) : this.#discard(s)))
  }

  async #discard(s, { afterSend = false } = {}) {
    // Sent, and the draft kept as the only copy (no Sent copy): an "Elvetés" queued behind the send
    // must not remove it; the drafts left by a From change may go.
    if (s.sent && !afterSend) return this.#removeStaleDrafts(s, { throwOnError: true })
    // the current draft first: a refusal in an old account must not keep it
    let failed = null
    if (s.saved && s.messageId) {
      try {
        await this.#deleteDraftIn(s.draftAccountId, s.messageId)
        s.saved = false
      } catch (err) {
        failed = err
      }
    }
    try {
      await this.#removeStaleDrafts(s, { throwOnError: true })
    } catch (err) {
      failed = failed || err
    }
    if (failed) throw failed
  }

  /** The drafts left in other accounts by a From change: tried again at every save, send and discard. */
  async #removeStaleDrafts(s, { throwOnError = false } = {}) {
    let failed = null
    let removedOnServer = false
    const current = s.saved ? this.store.getRow(s.draftAccountId) : null
    for (const accountId of [...s.staleDrafts]) {
      if (s.saved && accountId === s.draftAccountId) {
        s.staleDrafts.delete(accountId) // the current draft lives there again
        continue
      }
      // The old account is the same mailbox under another sender (one login, same Drafts folder): the
      // save's own replace already removed the old copy, a search there would find the NEW one and
      // delete it.
      const old = this.store.getRow(accountId)
      if (current && sameImapMailbox(old, current) && roleFolder(this.index, accountId, 'drafts') === roleFolder(this.index, current.id, 'drafts')) {
        s.staleDrafts.delete(accountId)
        continue
      }
      try {
        await this.#deleteDraftIn(accountId, s.messageId)
        s.staleDrafts.delete(accountId)
        if (old && old.type !== 'pop3') removedOnServer = true
      } catch (err) {
        this.log(`old draft in account ${accountId} not removed: ${errCode(err)}`)
        failed = failed || err
      }
    }
    // One mailbox reached under two names (another host name for the same server): the check above
    // cannot see it, so the current draft is looked for after an old one was removed on a server, and
    // saved again if that removal took it.
    if (removedOnServer && current && current.type !== 'pop3' && s.lastDraft) await this.#ensureDraft(s, current)
    if (failed && throwOnError) throw failed
  }

  /** The current IMAP draft is still in its Drafts folder; if not, it is appended again. */
  async #ensureDraft(s, account) {
    const drafts = roleFolder(this.index, account.id, 'drafts')
    if (!drafts) return
    const found = await this.withConnection(account.id, async client => {
      const lock = await client.getMailboxLock(drafts, { readOnly: true })
      try {
        return (await client.search({ header: { 'message-id': s.messageId } }, { uid: true })) || []
      } finally {
        lock.release()
      }
    })
    if (found.length) return
    this.log('the current draft was gone after an old one was removed (one mailbox, two names): saved again')
    await this.#replaceOnServer(account.id, drafts, s.lastDraft, s.messageId, ['\\Draft', '\\Seen', ...(s.claude ? [CLAUDE_KEYWORD] : [])], { replace: false })
  }

  /** Removes the draft with this Message-ID from the Drafts of one account (POP3: local, IMAP: server). */
  async #deleteDraftIn(accountId, messageId) {
    const account = this.store.getRow(accountId)
    if (!account) return
    const drafts = roleFolder(this.index, account.id, 'drafts')
    if (!drafts) return
    if (account.type === 'pop3') await this.#deleteLocal(account.id, drafts, messageId)
    else {
      const uids = await this.withConnection(account.id, async client => {
        const lock = await client.getMailboxLock(drafts, { readOnly: true })
        try {
          return (await client.search({ header: { 'message-id': messageId } }, { uid: true })) || []
        } finally {
          lock.release()
        }
      })
      // only these messages, also without UIDPLUS (core/imap/actions.js)
      if (uids.length) await this.withConnection(account.id, client => expungeMessages(client, drafts, uids))
      this.requestSync(account.id, [drafts])
    }
  }

  /** Saves the form as the session's draft (one copy in Drafts). */
  async saveDraft(sessionId, form) {
    const s = this.#session(sessionId)
    return this.#exclusive(s, () => this.#saveDraft(s, form))
  }

  async #saveDraft(s, form, { afterSend = false } = {}) {
    // the message went out: a save would make a draft of it
    if (s.sent && !afterSend) throw new ActionError('already_sent')
    // opened from the scheduled list: the save updates the scheduled message (same time), Drafts stays untouched
    if (s.scheduledId && !s.sent) return this.#saveScheduled(s, form)
    const claude = Boolean(s.claude)
    const { account, msg } = await this.#compose(s, form, { claude, draft: true })
    // The draft moved to another account (From changed): the new copy is saved FIRST, the old one goes
    // only after that worked, so a failed save (offline, no Drafts folder) never leaves the text only in
    // the window.
    const oldAccountId = s.saved && s.draftAccountId !== account.id ? s.draftAccountId : null
    const drafts = roleFolder(this.index, account.id, 'drafts')
    if (!drafts) throw new ActionError('no_drafts_folder')
    if (account.type === 'pop3') await this.#saveLocal(account, drafts, msg, `\\Draft \\Seen${claude ? ` ${CLAUDE_KEYWORD}` : ''}`)
    else {
      // the old copy's labels go with the draft (its keywords from the index; the new APPEND is a new message there)
      const labelKeywords = this.labels ? this.labels.keywordsOfCopies(account.id, drafts, labelKeyOf({ message_id: msg.messageId })) : []
      await this.#replaceOnServer(account.id, drafts, msg.sentCopy, msg.messageId, ['\\Draft', '\\Seen', ...(claude ? [CLAUDE_KEYWORD] : [])], { replace: true, labelKeywords })
    }
    s.lastDraft = account.type === 'pop3' ? null : msg.sentCopy
    s.saved = true
    s.draftAccountId = account.id
    if (oldAccountId !== null) s.staleDrafts.add(oldAccountId)
    await this.#removeStaleDrafts(s)
    // the page says so: a draft is still in the old account, tried again at the next save
    return { savedAt: this.now(), oldDraftLeft: s.staleDrafts.size > 0 }
  }

  /**
   * Sends the form. On success: Sent copy, the draft goes, contacts updated -> { sent: true, sentCopy }.
   * On failure: the message is kept as a draft (best effort) and ActionError(code) is thrown with
   * `draftSaved` telling whether that worked.
   */
  async sendNow(sessionId, form, { addPeople = true, draftOnFail = true } = {}) {
    const s = this.#session(sessionId)
    return this.#exclusive(s, () => this.#sendNow(s, form, { addPeople, draftOnFail }))
  }

  /**
   * "Küldés később": the message waits locally (the scheduled row + its sealed payload: the form, the attachments
   * byte for byte, the original's flag, the session's signature image, Claude's mark) until the scheduler sends it.
   * The draft goes from Drafts (it lives only in the scheduled list now), the session is done. -> { id, warnings }
   */
  async schedule(sessionId, form, sendAt, { byClaude = false } = {}) {
    const s = this.#session(sessionId)
    return this.#exclusive(s, () => this.#schedule(s, form, sendAt, byClaude))
  }

  // the row's claude mark says WHO scheduled it (Claude over MCP, or the user in a composer), not where the draft came
  // from: a Claude draft the user scheduled in the app is the user's (cancel_scheduled asks, the address book grows)
  async #schedule(s, form, sendAt, byClaude) {
    if (s.sent) throw new ActionError('already_sent')
    if (!this.scheduled || !this.sealed) throw new ActionError('not_available')
    try {
      checkSendAt(sendAt, this.now())
    } catch (err) {
      throw new ActionError(err.code || 'bad_time')
    }
    // the same checks as a send (the account, the addresses), nothing goes out
    const { account, recipients } = await this.#compose(s, form)
    if (!recipients.length) throw new ActionError('no_recipients')
    const rel = this.#writePayload(s, form, account.id)
    let id
    try {
      id = this.scheduled.add({ accountId: account.id, sendAt, subject: form.subject || '', recipients: recipients.map(r => r.address || r).join(', ').slice(0, 2000), claude: Boolean(byClaude), payloadPath: rel, now: this.now() })
    } catch (err) {
      this.#removeSealed(rel)
      throw err
    }
    s.sent = true // the session saves and sends nothing more
    // opened from the scheduled list and scheduled again: the new row replaces the old one
    this.#dropScheduled(s)
    const warnings = []
    try {
      await this.#discard(s, { afterSend: true })
    } catch (err) {
      warnings.push(`draft_not_removed:${err.code || 'unknown'}`)
    }
    this.log(`scheduled message ${id} saved`)
    return { scheduled: true, id, warnings }
  }

  /** A scheduled message as a new session (to send it, or to save it back as a draft). -> { sessionId, form } */
  restoreScheduled(id) {
    const payload = this.#readPayload(id)
    const sid = this.open()
    return { sessionId: sid, form: this.#fillFromPayload(this.#session(sid), payload) }
  }

  /**
   * "Megnyitás" in the scheduled list: the message in this composer session. Its saves update the scheduled message
   * (not Drafts); a send or a new schedule replaces the row; "Elvetés" removes it; closing leaves it as it was. While
   * the session holds it, the scheduler does not send it (holdsScheduled). -> the composer's starting form
   */
  openScheduled(sessionId, id) {
    const s = this.#session(sessionId)
    // one being sent now may already be out: not opened for editing
    const row = this.scheduled && this.scheduled.get(id)
    if (row && row.state === 'sending') throw new ActionError('scheduled_sending')
    const payload = this.#readPayload(id)
    const form = this.#fillFromPayload(s, payload)
    s.scheduledId = id
    s.initial = { accountId: form.accountId, to: form.to, cc: form.cc, bcc: form.bcc, subject: form.subject, draftHtml: form.html, inReplyTo: form.inReplyTo, references: form.references }
    // an interrupted or uncertain send may have gone out: the composer says so and asks before sending it again
    if (row && row.state === 'failed' && ['interrupted', 'uncertain'].includes(row.last_error)) s.initial.mayHaveGone = row.last_error
    this.onScheduledChange() // the list shows it held
    return s.initial
  }

  /** The session holding this scheduled message (open in a composer), or null. */
  sessionOfScheduled(id) {
    for (const s of this.sessions.values()) if (s.scheduledId === id && !s.sent) return s.id
    return null
  }

  /** The ids of the scheduled messages open in a composer or being turned back into a draft (the scheduler leaves them alone). */
  heldScheduled() {
    return [...this.sessions.values()].filter(s => s.scheduledId && !s.sent).map(s => s.scheduledId).concat([...this.#unscheduling])
  }

  #readPayload(id) {
    const row = this.scheduled && this.scheduled.get(id)
    if (!row) throw new ActionError('not_found')
    try {
      return JSON.parse(this.sealed.read(row.payload_path).toString('utf8'))
    } catch (err) {
      throw new ActionError(err && err.code === 'store_corrupt' ? 'store_corrupt' : 'not_available')
    }
  }

  #writePayload(s, form, accountId) {
    const html = String(form.html || '')
      .split(`sig-img://session/${s.id}"`).join(`sig-img://session/${SCHEDULED_SESSION}"`)
      .split(`inl-img://session/${s.id}/`).join(`inl-img://session/${SCHEDULED_SESSION}/`)
    const payload = {
      v: 1,
      form: { accountId, to: form.to || '', cc: form.cc || '', bcc: form.bcc || '', subject: form.subject || '', html, inReplyTo: form.inReplyTo || null, references: form.references || [] },
      attachments: [...s.attachments.values()].map(a => ({ filename: a.filename, contentType: a.contentType, content: Buffer.from(a.content).toString('base64') })),
      origin: s.origin || null,
      signatureImage: s.signatureImage ? { type: s.signatureImage.type, bytes: Buffer.from(s.signatureImage.bytes).toString('base64') } : null,
      inlineImages: [...s.inlineImages].map(([id, img]) => ({ id, type: img.type, width: img.width, height: img.height, bytes: Buffer.from(img.bytes).toString('base64') })),
      claude: Boolean(s.claude),
    }
    const rel = `${accountId}/scheduled-${crypto.randomUUID()}`
    this.sealed.write(rel, Buffer.from(JSON.stringify(payload), 'utf8'))
    return rel
  }

  // the scheduled row this session was opened from goes (sent, scheduled anew, or discarded), with its file
  #dropScheduled(s) {
    if (!s.scheduledId || !this.scheduled) return
    const rel = this.scheduled.remove(s.scheduledId)
    if (rel) this.#removeSealed(rel)
    s.scheduledId = null
    this.onScheduledChange()
  }

  #fillFromPayload(s, payload) {
    const sid = s.id
    for (const a of payload.attachments || []) {
      const att = { id: crypto.randomUUID(), filename: a.filename, contentType: a.contentType, content: Buffer.from(a.content, 'base64') }
      s.attachments.set(att.id, att)
    }
    s.origin = payload.origin || null
    s.claude = Boolean(payload.claude)
    s.signatureImage = payload.signatureImage ? { type: payload.signatureImage.type, bytes: Buffer.from(payload.signatureImage.bytes, 'base64') } : null
    for (const img of payload.inlineImages || []) {
      if (typeof img.id === 'string' && /^[0-9a-f]{24}$/.test(img.id)) s.inlineImages.set(img.id, { type: img.type, width: img.width, height: img.height, bytes: Buffer.from(img.bytes, 'base64') })
    }
    const html = String(payload.form.html || '')
      .split(`sig-img://session/${SCHEDULED_SESSION}"`).join(`sig-img://session/${sid}"`)
      .split(`inl-img://session/${SCHEDULED_SESSION}/`).join(`inl-img://session/${sid}/`)
    return { ...payload.form, html }
  }

  /** "Időzítés törlése": back to a draft in the account's Drafts; the row and its file go. -> the draft save's answer */
  async unscheduleToDraft(id) {
    const row = this.scheduled && this.scheduled.get(id)
    if (!row) throw new ActionError('not_found')
    // one being sent now may already be out; one open in a composer is that window's
    if (row.state === 'sending') throw new ActionError('scheduled_sending')
    if (this.sessionOfScheduled(id) !== null || this.#unscheduling.has(id)) throw new ActionError('scheduled_open')
    // held while the draft is saved: the scheduler does not pick it meanwhile
    this.#unscheduling.add(id)
    let sessionId = null
    try {
      const restored = this.restoreScheduled(id)
      sessionId = restored.sessionId
      const r = await this.saveDraft(sessionId, restored.form)
      const rel = this.scheduled.remove(id)
      if (rel) this.#removeSealed(rel)
      this.onScheduledChange()
      return r
    } finally {
      this.#unscheduling.delete(id)
      if (sessionId) this.close(sessionId)
    }
  }

  /** The scheduled row went (sent, or removed): its sealed payload too. */
  forgetScheduled(rel) {
    if (rel) this.#removeSealed(rel)
  }

  #removeSealed(rel) {
    try {
      this.sealed.remove(rel)
    } catch (err) {
      this.log(`scheduled payload not removed: ${errCode(err)}`)
    }
  }

  // addPeople false (an MCP send): the recipients are not added to the address book (the send-confirmation switch
  // lets mail go without the Modal only to the book; it must grow only from the user's own decisions)
  async #sendNow(s, form, { addPeople = true, draftOnFail = true } = {}) {
    // Once sent (even with refused recipients) the session sends nothing again: a second send would go
    // to everyone again, with a new Message-ID.
    if (s.sent) throw new ActionError('already_sent')
    const { account, msg, recipients } = await this.#compose(s, form)
    if (!recipients.length) throw new ActionError('no_recipients')
    const { smtp } = this.store.passwordsFor(account.id)
    let rejected = []
    try {
      if (!smtp) throw Object.assign(new Error('no SMTP password'), { code: 'NO_PASSWORD' })
      const result = await this.send({ account, password: smtp, envelope: msg.envelope, raw: msg.raw })
      rejected = (result && result.rejected) || []
    } catch (err) {
      const code = err.code === 'NO_PASSWORD' ? 'no_password' : err.code === 'no_recipient_accepted' ? 'no_recipient_accepted' : classifyError(err)
      this.log(`send failed (${code})`)
      let draftSaved = false
      // a scheduled message stays in the scheduled list with its error: no draft from each try
      if (draftOnFail) {
        try {
          await this.#saveDraft(s, form)
          draftSaved = true
        } catch (e) {
          this.log(`draft after a failed send not saved: ${errCode(e)}`)
        }
      }
      // afterData: the whole message was handed over before the error; it may have gone out
      throw Object.assign(new ActionError(code), { draftSaved, afterData: Boolean(err && err.afterData) })
    }
    // sent: from here on nothing may turn it into a failure (the message is out)
    s.sent = true
    // opened from the scheduled list and sent now: the scheduled row goes
    this.#dropScheduled(s)
    const warnings = []
    let sentCopy = false
    try {
      const sent = roleFolder(this.index, account.id, 'sent')
      if (!sent) warnings.push('no_sent_folder')
      else if (account.type === 'pop3') await this.#saveLocal(account, sent, msg, '\\Seen')
      else if (account.save_sent_to_server !== 0) await this.#replaceOnServer(account.id, sent, msg.sentCopy, msg.messageId, ['\\Seen'], { replace: false })
      sentCopy = Boolean(sent)
    } catch (err) {
      warnings.push(`sent_copy_failed:${err.code || 'unknown'}`)
    }
    if (sentCopy) {
      try {
        await this.#discard(s, { afterSend: true })
      } catch (err) {
        warnings.push(`draft_not_removed:${err.code || 'unknown'}`)
      }
    } else {
      // No Sent copy: the draft is the only copy of what went out, it stays. It is
      // saved with the text that went out, also when an older autosave exists.
      try {
        await this.#saveDraft(s, form, { afterSend: true })
        warnings.push('kept_as_draft')
      } catch (err) {
        this.log(`draft after a send without Sent copy not saved: ${errCode(err)}`)
        // the earlier saved draft is still there, with an older text than what went out
        if (s.saved) warnings.push('kept_older_draft')
      }
    }
    if (s.origin) {
      try {
        await this.#markOrigin(s.origin)
      } catch (err) {
        warnings.push(`origin_flag_failed:${err.code || 'unknown'}`)
      }
    }
    // a refused address is not a contact; the page shows the refused ones
    const refused = new Set(rejected.map(a => String(a).toLowerCase()))
    this.contacts.recordSent(recipients.filter(r => !refused.has(String(r.address || r).toLowerCase())), this.now(), { addPeople })
    return { sent: true, warnings, rejected }
  }
}
