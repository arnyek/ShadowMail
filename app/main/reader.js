// SPDX-License-Identifier: GPL-3.0-or-later
// Opening a message. No Electron import: the tests drive it with a fake IMAP client.
//
// The whole message is downloaded on first open into data/store/<account>/<message id>.eml (the row's
// store_path, relative to the store folder; sealed, core/store/sealed-file.js) and read from there afterwards. Opening pins the message
// and puts its text into the index even beyond the account's limit, and marks it \Seen on
// the server (SELECT, read-write; the background sync only ever EXAMINEs). Only the message opened
// last is kept in memory: its cid: images, its attachments and its "load images" permission.
import crypto from 'node:crypto'
import { parseMessage, externalImageHosts } from '../../core/mime/message.js'
import { t } from '../renderer/i18n/index.js'
import { oldTextOf, previewOf, searchTextOf } from '../../core/mime/text.js'
import { ActionError } from './sync-manager.js'
import { BODY_STATE } from '../../core/db/mail-index.js'
import { assignRoles } from '../../core/imap/folders.js'
import { cidResolver, imgCidRefsIn } from '../../core/mime/cid.js'

// cid: images served to the message frame. SVG is left out on purpose (no scripts in <img>, but no need either).
export const CID_IMAGE_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/x-icon'])

const hasFlag = (flags, flag) => (flags || '').split(' ').includes(flag)
const addFlag = (flags, flag) => (hasFlag(flags, flag) ? flags || '' : [...(flags || '').split(' ').filter(Boolean), flag].join(' '))

/**
 * The attachments a message offers as files: all but the embedded images its body shows. The part a cid: reference shows
 * is the one cidResolver picks (the Content-ID written the same way, else another case or %-encoded): a mail program may
 * write the reference in another case, and the image then showed broken and was offered as a file. Only the parts a
 * reference really shows are left out, so of two parts whose Content-IDs differ only in case none goes missing. Only an
 * <img src> shows a part (imgCidRefsIn): a part referred to only by a background, a CSS url(), a link or the text is
 * shown nowhere, so it is offered; so is one whose <img> is only text (a comment, an attribute value, a script), and one
 * of a type the frame does not serve (CID_IMAGE_TYPES: an SVG part, say).
 */
export function offeredAttachments(parsed) {
  const shows = cidResolver(parsed.attachments)
  const shown = new Set()
  for (const ref of imgCidRefsIn(parsed.html)) {
    const part = shows(ref)
    if (part && CID_IMAGE_TYPES.includes(part.contentType)) shown.add(part)
  }
  return parsed.attachments.filter(a => !(a.inline && shown.has(a)))
}

export class MessageReader {
  /**
   * @param index           MailIndex
   * @param sealed          SealedStore of data/store: every cached .eml is read and written through it
   * @param withConnection  (accountId, client => Promise) => Promise; SyncManager#withConnection
   * @param onChange        ({ accountId, folders }) => void, after a flag changed
   */
  constructor({ index, sealed, withConnection, onChange = () => {}, log = () => {}, searchText = null }) {
    this.searchText = searchText // the worker thread's refiner, or null (the visible text made here)
    this.index = index
    this.sealed = sealed
    this.withConnection = withConnection
    this.onChange = onChange
    this.log = log
    this.current = null
    this.openSeq = 0
  }

  // the cached message, or null when there is none. A damaged file: a local (POP3) message has no other
  // copy, so it cannot be opened (store_corrupt); an IMAP one is downloaded again.
  #readCached(row) {
    if (!row.store_path) return null
    try {
      return this.sealed.read(row.store_path)
    } catch (err) {
      if (err && err.code === 'store_corrupt') {
        this.log(`message ${row.id}: the stored file is damaged`)
        if (row.uid === null || row.uid === undefined) throw new ActionError('store_corrupt')
      }
      return null
    }
  }

  #writeCache(row, source) {
    const rel = `${row.account_id}/${row.id}.eml`
    this.sealed.write(rel, source)
    this.index.setStorePath(row.id, rel)
  }

  /** Downloads the message (and sets \Seen in the same SELECT) or only sets \Seen. */
  async #fromServer(row, { download, markSeen }) {
    return this.withConnection(row.account_id, async client => {
      const lock = await client.getMailboxLock(row.folder) // SELECT: read-write, \Seen may be set
      try {
        const known = this.index.getFolder(row.account_id, row.folder)
        const serverValidity = client.mailbox && client.mailbox.uidValidity != null ? String(client.mailbox.uidValidity) : null
        // a new UIDVALIDITY: our UID may now name another message; the next sync rebuilds the folder
        if (known && known.uidvalidity && serverValidity && known.uidvalidity !== serverValidity) throw new ActionError('stale')
        let source = null
        if (download) {
          const msg = await client.fetchOne(String(row.uid), { uid: true, source: true }, { uid: true })
          if (!msg || !msg.source) throw new ActionError('gone')
          source = msg.source
        }
        if (markSeen) await client.messageFlagsAdd(String(row.uid), ['\\Seen'], { uid: true })
        return source
      } finally {
        lock.release()
      }
    })
  }

  #markSeenLocally(row) {
    const flags = addFlag(row.flags, '\\Seen')
    this.index.setFlagsById(row.id, flags)
    this.onChange({ accountId: row.account_id, folders: [row.folder] })
    return flags
  }

  /**
   * Opens message `id`. Returns what the reader pane shows, without attachment contents.
   * Throws ActionError: not_found, not_downloaded (POP3 row without its file), gone, stale, locked,
   * sync_stopped, no_password, auth_failed, connection_refused, ... (the message is not shown then).
   * Setting \Seen may fail on its own (offline, cached message): the message is still shown, `seenError` says why.
   */
  async open(id) {
    const seq = ++this.openSeq
    this.current = null // "load images" never carries over to another message
    const row = this.index.get(id)
    if (!row) throw new ActionError('not_found')
    const isImap = row.uid !== null && row.uid !== undefined
    const unseen = !hasFlag(row.flags, '\\Seen')
    let source = this.#readCached(row)
    let seenDone = false
    let seenError = null
    if (!source) {
      if (!isImap) throw new ActionError('not_downloaded')
      source = await this.#fromServer(row, { download: true, markSeen: unseen })
      seenDone = unseen
      this.#writeCache(row, source)
    } else if (unseen && isImap) {
      try {
        await this.#fromServer(row, { download: false, markSeen: true })
        seenDone = true
      } catch (err) {
        seenError = err.code || 'unknown'
        this.log(`message ${id}: \\Seen not set (${seenError})`)
      }
    } else if (unseen) {
      seenDone = true // local (POP3) message: the flag lives only here
    }
    let flags = row.flags || ''
    if (seenDone) flags = this.#markSeenLocally(row)

    // an attachment without a name is named in the interface language (read at the open: the language can change)
    // the old rule's text and preview are written only into a row not indexed yet (pinOpened): only then is the
    // (capped) HTML -> text of mailparser made; an HTML over the cap gets its preview from the worker (htmlTextLate)
    const needsText = row.body_state !== BODY_STATE.INDEXED
    const parsed = await parseMessage(source, { attachmentFallback: t.attachmentFallback, htmlText: needsText })
    // pinned; a row not yet indexed gets the old rule's text and preview at once (as
    // before), and the search text becomes the visible text, of an already indexed row too (it was indexed by the old
    // rule: an old IMAP message gets clean on its open). The preview of an indexed row does not change.
    if (this.searchText) {
      const textNow = needsText && !parsed.htmlTextLate
      this.index.pinOpened(id, textNow ? { text: oldTextOf(parsed), preview: previewOf(parsed) } : { text: '', preview: null })
      // not waited for: the open does not wait for the worker (registered now, queued and written later)
      const now = this.index.get(id)
      const storePath = now && now.store_path ? now.store_path : null
      this.searchText.refine(storePath ? { id, accountId: row.account_id, local: true, storePath } : { id, accountId: row.account_id, local: false, source }).catch(() => {})
    } else {
      const text = searchTextOf(parsed)
      // (no worker: tests, core) the preview only for a row that takes it
      this.index.pinOpened(id, { text, preview: needsText ? previewOf(parsed) : null })
      this.index.setSearchBody(id, text)
    }

    const imageHosts = externalImageHosts(parsed.html)
    const view = {
      id,
      accountId: row.account_id,
      folder: row.folder,
      flags,
      subject: parsed.subject || row.subject || '',
      from: parsed.from,
      to: parsed.to,
      cc: parsed.cc,
      replyTo: parsed.replyTo,
      date: parsed.date ?? row.date ?? null,
      html: parsed.html,
      text: parsed.html ? null : parsed.text,
      hasExternalImages: imageHosts.size > 0,
      attachments: offeredAttachments(parsed).map(({ index, filename, contentType, size, executable, browserActive, openable }) => ({ index, filename, contentType, size, executable, browserActive, openable })),
      seenError,
    }
    if (seq === this.openSeq) {
      this.current = { id, parsed, imageHosts, imagesAllowed: false, viewToken: null, viewHtml: null }
    }
    return view
  }

  /**
   * The raw message without opening it (reply / forward): from data/store, or downloaded (and then
   * cached) WITHOUT setting \Seen. Throws ActionError like open().
   */
  async source(id) {
    const row = this.index.get(id)
    if (!row) throw new ActionError('not_found')
    const cached = this.#readCached(row)
    if (cached) return { row, source: cached }
    if (row.uid === null || row.uid === undefined) throw new ActionError('not_downloaded')
    const source = await this.#fromServer(row, { download: true, markSeen: false })
    this.#writeCache(row, source)
    return { row, source }
  }

  #currentFor(id) {
    return this.current && this.current.id === id ? this.current : null
  }

  /** "Képek betöltése": the external image hosts of the open message become allowed. Returns them. */
  allowImages(id) {
    const cur = this.#currentFor(id)
    if (!cur) throw new ActionError('not_open')
    cur.imagesAllowed = true
    return [...cur.imageHosts]
  }

  /** For the net guard: the hosts allowed right now (empty unless the open message's images are on). */
  allowedImageHosts() {
    return this.current && this.current.imagesAllowed ? this.current.imageHosts : new Set()
  }

  /** A cid: image of the open message, or null (other messages, non-images, unknown cid). */
  cidImage(id, cid) {
    const cur = this.#currentFor(id)
    if (!cur) return null
    const part = cidResolver(cur.parsed.attachments)(cid)
    if (!part || !CID_IMAGE_TYPES.includes(part.contentType)) return null
    return { contentType: part.contentType, content: part.content }
  }

  /** The attachments of the open message the reader offers (offeredAttachments), with their content: "Összes mentése". */
  offeredAttachments(id) {
    const cur = this.#currentFor(id)
    if (!cur) throw new ActionError('not_open')
    return offeredAttachments(cur.parsed)
  }

  /** An attachment of the open message, with its content. */
  attachment(id, index) {
    const cur = this.#currentFor(id)
    if (!cur) throw new ActionError('not_open')
    const part = cur.parsed.attachments[index]
    if (!part) throw new ActionError('not_found')
    return part
  }

  /**
   * The sanitized body (from the renderer) for the message frame. Returns the token of its
   * mail-view: URL; only the latest one is served.
   */
  setView(id, html) {
    const cur = this.#currentFor(id)
    if (!cur) throw new ActionError('not_open')
    cur.viewToken = crypto.randomBytes(16).toString('hex')
    cur.viewHtml = html
    return cur.viewToken
  }

  /** The frame's document by token: { html, imagesAllowed } or null. */
  view(token) {
    const cur = this.current
    if (!cur || !cur.viewToken || cur.viewToken !== token) return null
    return { html: cur.viewHtml, imagesAllowed: cur.imagesAllowed }
  }

  /**
   * The reader's replied / forwarded line: the row's \\Answered and $Forwarded (any case), and with \\Answered the
   * latest reply in the account's Sent-role folder (In-Reply-To = this Message-ID): { id, date, count } or null.
   */
  replyInfo(id) {
    const row = this.index.get(id)
    if (!row) throw new ActionError('not_found')
    const flags = new Set((row.flags || '').toLowerCase().split(' '))
    const answered = flags.has('\\answered')
    let reply = null
    if (answered && row.message_id) {
      const roles = assignRoles(this.index.folderList(row.account_id))
      const sent = [...roles].find(([, role]) => role === 'sent')
      if (sent) reply = this.index.replyIn(row.account_id, sent[0], row.message_id)
    }
    return { answered, forwarded: flags.has('$forwarded'), reply }
  }

  /** Thread of a message (same account), oldest first, the list's columns only. */
  /**
   * The thread view: one row per message. Copies of the same message (Message-ID), e.g. a message to
   * oneself in the INBOX and in Sent, become one row: the opened message keeps
   * its own copy; for the others a copy outside Sent/Trash wins, then the smallest id. Rows without a
   * Message-ID are never merged. MailIndex.thread() still returns every copy.
   */
  thread(id) {
    const all = this.index.thread(id)
    const rolesOf = new Map()
    const roleOf = m => {
      if (!rolesOf.has(m.account_id)) rolesOf.set(m.account_id, assignRoles(this.index.folders(m.account_id)))
      return rolesOf.get(m.account_id).get(m.folder) || null
    }
    const rank = m => (m.id === id ? 0 : ['sent', 'trash'].includes(roleOf(m)) ? 2 : 1)
    const best = new Map()
    for (const m of all) {
      const key = m.message_id ? `mid:${m.message_id}` : `id:${m.id}`
      const cur = best.get(key)
      if (!cur || rank(m) < rank(cur) || (rank(m) === rank(cur) && m.id < cur.id)) best.set(key, m)
    }
    const keep = new Set([...best.values()].map(m => m.id))
    return all.filter(m => keep.has(m.id)).map(m => ({
      id: m.id,
      folder: m.folder,
      from_name: m.from_name,
      from_addr: m.from_addr,
      subject: m.subject,
      date: m.date,
      flags: m.flags,
      has_attachments: m.has_attachments,
    }))
  }

  /** Vault locked: forget the open message. */
  clear() {
    this.current = null
  }
}
