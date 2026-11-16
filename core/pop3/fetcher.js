// SPDX-License-Identifier: GPL-3.0-or-later
// POP3 account download. The schedule (first run, interval, back-off, no
// retry after a rejected login, queued requests, stop) is the IMAP Syncer's: only the run differs.
//
// One run:
//   1. local folders (Beérkezett, Elküldött, Piszkozatok, Kuka), the body limit (applyBodyLimit)
//   2. texts of pending rows from their .eml in data/store: no network, so a raised limit re-indexes
//      even while the server is down
//   3. connect + login, UIDL, every new UIDL downloaded whole into data/store/<account>/pop3-<hash>.eml,
//      then a row (INBOX, uid NULL, pop3_uidl) and its pop3_seen entry in one transaction
//   4. "delete after N days" -> DELE the messages downloaded at least N days ago (only if their
//      file is on disk); they count as deleted only after a clean QUIT (RFC 1939 UPDATE state)
//   5. the limit again (new rows beyond it become headers only), texts of the new rows
// Every message is downloaded whole; the limit decides only what goes into the search index.
import fs from 'node:fs'
import crypto from 'node:crypto'
import { Syncer, isFatalSyncError } from '../imap/sync.js'
import { classifyError } from '../accounts/probe.js'
import { applyBodyLimit, DAY_MS } from '../db/body-limit.js'
import { BODY_STATE } from '../db/mail-index.js'
import { parseMessage } from '../mime/message.js'
import { bodyFromSource } from '../mime/text.js'
import { fmtAddrs } from '../mime/envelope.js'

export const POP3_LOCAL_FOLDERS = Object.freeze([
  { path: 'INBOX', specialUse: null },
  { path: 'Sent', specialUse: '\\Sent' },
  { path: 'Drafts', specialUse: '\\Drafts' },
  { path: 'Trash', specialUse: '\\Trash' },
])

/** The file of a downloaded message, relative to data/store. The UIDL is hashed: it may hold any printable character. */
export function pop3StorePath(accountId, uidl) {
  return `${accountId}/pop3-${crypto.createHash('sha256').update(uidl).digest('hex').slice(0, 32)}.eml`
}

/**
 * The age of a POP3 message (idate): its Date header, unless that is missing, unreadable or in the
 * future; then the moment of the download.
 */
export function pop3MessageAge(headerDate, downloadedAt) {
  return Number.isFinite(headerDate) && headerDate <= downloadedAt ? headerDate : downloadedAt
}

// ESET's mail protection adds one "X-EsetId:" header line to every message it passes (measured)
const AV_HEADER = /^X-EsetId: [^\r\n]*\r?\n/im

function withoutAvHeader(buf) {
  const s = buf.toString('latin1')
  const blank = /\r?\n\r?\n/.exec(s)
  const end = blank ? blank.index + (blank[0].startsWith('\r\n') ? 2 : 1) : s.length
  return Buffer.from(s.slice(0, end).replace(AV_HEADER, '') + s.slice(end), 'latin1')
}

export class Pop3Fetcher extends Syncer {
  /**
   * @param sealed    SealedStore of data/store: every .eml is written and read sealed
   * @param connect   () => Promise<Pop3Client logged in>
   * Other options: see Syncer (account, loadAccount, index, now, onChange, onState, retryDelaysMs).
   */
  constructor({ sealed, ...opts }) {
    super(opts)
    this.sealed = sealed
  }

  #file(rel) {
    return this.sealed.file(rel)
  }

  // on the disk (sealed, fsync, rename) before a later DELE may remove the server copy ("delete after 0
  // days")
  #writeAtomic(rel, source) {
    this.sealed.write(rel, source)
  }

  /** stop() also drops the open POP3 connection, so a restart does not meet "[IN-USE]". */
  stop() {
    super.stop()
    if (this.activeClient) this.activeClient.close()
  }

  /**
   * Same host and user, other port or user case: is it the same mailbox? Up to two messages we already
   * have (newest first) are downloaded again and compared with their files byte for byte (an antivirus
   * header line aside). Any doubt -> false: a needless second download is better than a DELE of a
   * message never downloaded because another mailbox happened to use the same UIDLs.
   */
  async #sameMessages(client, onServer, doubledNow) {
    const accountId = this.account.id
    const seen = this.index.pop3Seen(accountId)
    const doubled = this.index.pop3Doubled(accountId)
    const picks = []
    for (const m of [...onServer].sort((a, b) => b.n - a.n)) {
      if (picks.length === 2) break
      if (!seen.has(m.uidl) || doubled.has(m.uidl) || doubledNow.has(m.uidl)) continue
      const row = this.index.getByUidl(accountId, m.uidl)
      if (!row || !row.store_path) continue
      let stored
      try {
        stored = this.sealed.read(row.store_path)
      } catch {
        continue
      }
      picks.push({ n: m.n, stored })
    }
    if (!picks.length) return false
    for (const p of picks) {
      this._checkStopped()
      let source
      try {
        source = await client.retr(p.n)
      } catch (err) {
        if (err.code !== 'POP3_ERR') throw err
        return false
      }
      if (!withoutAvHeader(source).equals(withoutAvHeader(p.stored))) return false
    }
    return true
  }

  /** Texts of the pending rows from their .eml files (state 1 or 2), newest first. */
  async #localBodies() {
    const accountId = this.account.id
    const total = this.index.pendingLocalBodies(accountId, 1_000_000).length
    let done = 0
    if (!total) return 0
    this._setState({ phase: 'bodies', folder: null, progress: { done, total } })
    for (;;) {
      this._checkStopped()
      const batch = this.index.pendingLocalBodies(accountId, 200)
      if (!batch.length) break
      const items = []
      for (const r of batch) {
        let source = null
        try {
          source = this.sealed.read(r.store_path)
        } catch {
          // the file is gone or damaged: state 2 (failed), the row and its headers stay
        }
        const body = await bodyFromSource(source, { oldText: Boolean(this.searchText) })
        items.push({ id: r.id, text: body.text, state: body.state, preview: body.preview, storePath: this.searchText && body.state === 1 ? r.store_path : null })
      }
      this.index.setBodies(items)
      await this.refineSearchText(items, accountId, true)
      done += items.length
      this._setState({ progress: { done, total } })
    }
    return done
  }

  async _run() {
    this._checkStopped() // a stopped fetcher never logs in (as the IMAP Syncer)
    const t0 = Date.now()
    const st = this.state
    if (this.loadAccount) {
      const fresh = this.loadAccount()
      if (!fresh) throw Object.assign(new Error('sync stopped'), { code: 'SYNC_STOPPED' })
      this.account = fresh
    }
    const account = this.account
    const accountId = account.id
    Object.assign(st, { running: true, phase: 'connecting', lastAdded: 0, lastRemoved: 0, lastCleared: 0, lastRequeued: 0 })
    this._emitState()
    let client = null
    let quitClean = false
    try {
      this.index.ensureLocalFolders(accountId, POP3_LOCAL_FOLDERS)
      const limit = applyBodyLimit(this.index, account, this.now())
      st.lastCleared = limit.cleared
      st.lastRequeued = limit.requeued
      if (await this.#localBodies()) this._changed(['INBOX'])

      this._setState({ phase: 'connecting', progress: null })
      client = await this.connect()
      this.activeClient = client
      this._checkStopped()
      const onServer = await client.uidl()
      this._checkStopped()
      const counts = new Map()
      for (const m of onServer) counts.set(m.uidl, (counts.get(m.uidl) || 0) + 1)
      const doubledNow = [...counts].filter(([, n]) => n > 1).map(([u]) => u)
      // Only now, logged in and listed, is it known which mailbox this is: a host
      // typo that never connects resets nothing, and the same mailbox on another port or under another
      // server name keeps its record once two of its messages compare equal.
      const current = { host: account.in_host, port: account.in_port, user: account.in_user }
      const idState = this.index.pop3IdentityState(accountId, current)
      let sameMailbox = idState === 'same'
      if (idState === 'near') sameMailbox = await this.#sameMessages(client, onServer, new Set(doubledNow))
      this._checkStopped()
      this.index.setPop3Identity(accountId, current, { reset: !sameMailbox })
      const seen = this.index.pop3Seen(accountId)
      // A UIDL listed twice is a server bug: only one copy is downloaded, and none of
      // them is ever deleted on the server (we cannot tell which one we have), not even when a later
      // listing shows it once: that is why it is remembered.
      if (doubledNow.length) this.index.addPop3Doubled(accountId, doubledNow)
      const doubled = this.index.pop3Doubled(accountId)
      // newest first: POP3 numbers grow with arrival; every copy of a doubled UIDL is a candidate, so
      // when the newest is refused the next one is tried
      const fresh = onServer.filter(m => !seen.has(m.uidl)).sort((a, b) => b.n - a.n)
      const freshCount = new Set(fresh.map(m => m.uidl)).size
      this._setState({ phase: 'metadata', folder: 'INBOX', progress: { done: 0, total: freshCount } })
      let added = 0
      const refused = new Set()
      const taken = new Set()
      for (const m of fresh) {
        if (taken.has(m.uidl)) continue
        this._checkStopped()
        let source
        try {
          source = await client.retr(m.n)
        } catch (err) {
          // one message the server refuses (-ERR) must not stall the others; it is not marked seen,
          // so the next run tries it again
          if (err.code !== 'POP3_ERR') throw err
          refused.add(m.uidl)
          continue
        }
        taken.add(m.uidl)
        refused.delete(m.uidl)
        let parsed = null
        try {
          parsed = await parseMessage(source)
        } catch {
          // unreadable MIME: the file stays, the row gets what we know
        }
        // A stop() during a long parse (an account saved with another server) must not write this
        // server's UIDL into the bookkeeping the restarted run uses.
        this._checkStopped()
        const downloadedAt = this.now()
        let rel = pop3StorePath(accountId, m.uidl)
        // never overwrite another message's file (same UIDL after a server change, or a doubled UIDL)
        if (fs.existsSync(this.#file(rel))) rel = pop3StorePath(accountId, `${m.uidl}\u0000${downloadedAt}\u0000${m.n}`)
        this.#writeAtomic(rel, source)
        const from = (parsed && parsed.from[0]) || { name: '', address: '' }
        const headerDate = parsed ? parsed.date : null
        const id = this.index.addPop3Message(
          {
            account_id: accountId,
            folder: 'INBOX',
            pop3_uidl: m.uidl,
            message_id: parsed ? parsed.messageId : null,
            in_reply_to: parsed && parsed.inReplyTo ? parsed.inReplyTo : null,
            refs: parsed && parsed.references.length ? parsed.references.join(' ') : null,
            from_addr: from.address || null,
            from_name: from.name || null,
            to_addrs: parsed ? fmtAddrs(parsed.to) : '',
            cc_addrs: parsed ? fmtAddrs(parsed.cc) : '',
            subject: parsed ? parsed.subject : '',
            date: Number.isFinite(headerDate) ? headerDate : downloadedAt,
            idate: pop3MessageAge(headerDate, downloadedAt),
            flags: '',
            size: source.length,
            has_attachments: parsed && parsed.attachments.some(a => !a.inline) ? 1 : 0,
            attachments: parsed
              ? JSON.stringify(parsed.attachments.map(a => ({ part: String(a.index), filename: a.filename, type: a.contentType, size: a.size, inline: a.inline })))
              : null,
            store_path: rel,
            body_state: BODY_STATE.PENDING,
            sender_text: parsed ? fmtAddrs(parsed.from) : '',
            recipients_text: parsed ? fmtAddrs([...parsed.to, ...parsed.cc]) : '',
          },
          downloadedAt,
        )
        if (id) added++
        this._setState({ progress: { done: added, total: freshCount } })
      }
      const skipped = refused.size
      st.lastAdded = added
      st.lastSkipped = skipped

      // delete from the server N days after the download (NULL = never)
      const days = account.pop3_delete_after_days
      const toDelete = []
      if (days !== null && days !== undefined) {
        const due = this.now() - Number(days) * DAY_MS
        const seenNow = this.index.pop3Seen(accountId)
        // the rows of the messages about to go must survive a power cut
        this.index.flushDurable()
        for (const m of onServer) {
          this._checkStopped()
          if (doubled.has(m.uidl)) continue
          const s = seenNow.get(m.uidl)
          if (!s || s.downloaded_at > due) continue
          const row = this.index.getByUidl(accountId, m.uidl)
          // The row and its pop3_seen entry are written in one transaction, and only the user deletes the
          // row (permanent delete): no row = deleted here, so the server copy goes too.
          // A row whose file is missing is kept on the server: never delete what we could not show.
          if (row && (!row.store_path || !fs.existsSync(this.#file(row.store_path)))) continue
          await client.dele(m.n)
          toDelete.push(m.uidl)
        }
      }
      await client.quit()
      quitClean = true
      if (toDelete.length) {
        this.index.markPop3Deleted(accountId, toDelete, this.now())
        st.lastRemoved = toDelete.length
      }

      // the new rows: beyond the limit -> headers only; inside -> text from the file
      applyBodyLimit(this.index, account, this.now())
      await this.#localBodies()
      if (added) this._changed(['INBOX'])
      Object.assign(st, {
        lastFinished: new Date(this.now()).toISOString(),
        lastError: skipped ? `${skipped} message(s) refused by the server, retried next time` : null,
        errorCode: skipped ? 'partial' : null,
      })
    } catch (err) {
      if (err.code !== 'SYNC_STOPPED') {
        st.lastError = err.message
        st.errorCode = err.code === 'NO_PASSWORD' ? 'no_password' : err.code === 'UIDL_UNSUPPORTED' ? 'uidl_unsupported' : classifyError(err)
      }
      throw err
    } finally {
      Object.assign(st, { running: false, phase: 'idle', folder: null, progress: null, lastDurationMs: Date.now() - t0 })
      this._emitState()
      // without a clean QUIT the server applies no DELE (RFC 1939): just drop the connection
      if (client && !quitClean) client.close()
      this.activeClient = null
    }
  }
}

export { isFatalSyncError }
