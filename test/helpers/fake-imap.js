// A small in-memory stand-in for an imapflow client, enough for the Syncer and the IdleWatcher:
// list, mailbox lock, mailboxOpen (IDLE: the open folder's changes come as 'exists' / 'expunge' /
// 'flags' events), UID SEARCH ALL, UID FETCH (envelope/flags/structure or a source slice), fetchOne
// (the whole source), messageFlagsAdd (needs a read-write lock, like a real EXAMINE would refuse), logout.
// It records every fetch and every mailbox open, so a test can tell what was downloaded and whether
// anything was opened read-write. connect() can fail like a real server: down (ECONNREFUSED) or
// a rejected login (authenticationFailed), and dropConnections() cuts every live client.
import { EventEmitter } from 'node:events'
import { foldForSearch } from '../../core/mime/text.js'
import { simpleParser } from 'mailparser'

export function rawMessage({ from, to, subject, date, messageId, body }) {
  return Buffer.from(
    [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      `Date: ${new Date(date).toUTCString()}`,
      `Message-ID: ${messageId}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      body,
      '',
    ].join('\r\n'),
  )
}

export class FakeImapServer {
  constructor() {
    this.mailboxes = new Map()
    this.fetchLog = [] // { path, uids, kind: 'meta' | 'flags' | 'source' }
    this.openLog = [] // { path, readOnly, via: 'lock' | 'open' }
    this.clients = new Set()
    this.down = false
    this.rejectLogin = false
    this.loginAttempts = 0
    // server search: { path, text, before, startedAt, endedAt }; options below
    this.searchLog = []
    this.rejectCharset = false // a server that answers BAD to CHARSET UTF-8 (non-ASCII TEXT)
    this.searchDelayMs = 0
    this.runningSearches = 0
    this.uidplus = true // MOVE answers with a UID map (COPYUID) only with UIDPLUS
    this.actionLog = [] // { op, path, uids, ... }
    this.delimiter = '/' // '.' for Courier/cPanel-like servers
    this.prefix = '' // personal namespace prefix, e.g. 'INBOX.'
    this.subscribed = new Set()
    this.refuseOps = new Set() // 'flags+', 'flags-', 'move', 'expunge': answered NO (imapflow: false)
  }

  /** Like ImapFlow#connect(): resolves with a connected client or fails as a real server would. */
  async connect() {
    if (this.down) {
      const err = new Error('connect ECONNREFUSED 127.0.0.1:993')
      err.code = 'ECONNREFUSED'
      throw err
    }
    this.loginAttempts++
    if (this.rejectLogin) {
      const err = new Error('Command failed')
      err.authenticationFailed = true
      throw err
    }
    const c = new FakeImapClient(this)
    this.clients.add(c)
    return c
  }

  /** The network goes away: every live client closes. */
  dropConnections() {
    for (const c of [...this.clients]) c._closed()
  }

  _event(path, name, payload) {
    for (const c of this.clients) if (c.opened === path) c.emit(name, { path, ...payload })
  }

  setFlags(path, uid, flags) {
    this.mailboxes.get(path).messages.get(uid).flags = new Set(flags)
    this._event(path, 'flags', { uid, flags: new Set(flags) })
  }

  addMailbox(path, { uidValidity = 1, specialUse = null } = {}) {
    this.mailboxes.set(path, { path, uidValidity, specialUse, messages: new Map(), nextUid: 1 })
    return this
  }

  // m: { from, to, subject, date (ms), idate (ms), messageId, body, flags, source (raw message, overrides body) }
  addMessage(path, m) {
    const mb = this.mailboxes.get(path)
    const uid = mb.nextUid++
    mb.messages.set(uid, {
      uid,
      flags: new Set(m.flags || []),
      internalDate: new Date(m.idate ?? m.date),
      size: m.source ? m.source.length : m.body.length,
      envelope: {
        date: new Date(m.date),
        subject: m.subject,
        messageId: m.messageId,
        inReplyTo: m.inReplyTo || null,
        from: [{ name: m.fromName || '', address: m.from }],
        to: [{ name: '', address: m.to }],
        cc: [],
      },
      bodyStructure: { type: 'text/plain', part: '1', size: m.body.length },
      headers: Buffer.from(m.refs ? `References: ${m.refs}\r\n` : ''),
      source: m.source ? Buffer.from(m.source) : rawMessage(m),
    })
    this._event(path, 'exists', { count: mb.messages.size, prevCount: mb.messages.size - 1 })
    return uid
  }

  /** Bulk load without events (big folders). */
  addMessages(path, list) {
    const emit = this._event
    this._event = () => {}
    try {
      return list.map(m => this.addMessage(path, m))
    } finally {
      this._event = emit
    }
  }

  deleteMessage(path, uid) {
    this.mailboxes.get(path).messages.delete(uid)
    this._event(path, 'expunge', { uid })
  }

  sourceFetches() {
    return this.fetchLog.filter(f => f.kind === 'source').flatMap(f => f.uids)
  }

  client() {
    const c = new FakeImapClient(this)
    this.clients.add(c)
    return c
  }
}

class FakeImapClient extends EventEmitter {
  constructor(server) {
    super()
    this.server = server
    this.usable = true
    this.mailbox = null
    this.opened = null
    // like imapflow: an 'error' without a listener must not throw
    this.on('error', () => {})
  }

  async connect() {}

  // like imapflow's client.capabilities (a Map); MOVE unless server.move === false, UIDPLUS per server.uidplus
  get capabilities() {
    const caps = new Map([['IMAP4rev1', true]])
    if (this.server.move !== false) caps.set('MOVE', true)
    if (this.server.uidplus) caps.set('UIDPLUS', true)
    return caps
  }

  _closed() {
    if (!this.usable) return
    this.usable = false
    this.opened = null
    this.server.clients.delete(this)
    this.emit('close')
  }

  async mailboxOpen(path, { readOnly = false } = {}) {
    if (!this.usable) throw Object.assign(new Error('Connection not available'), { code: 'NoConnection' })
    if (!this.server.mailboxes.has(path)) throw new Error(`no mailbox ${path}`)
    this.server.openLog.push({ path, readOnly, via: 'open' })
    this.opened = path
    return { path }
  }

  async list() {
    const d = this.server.delimiter
    return [...this.server.mailboxes.values()].map(mb => ({
      path: mb.path,
      name: mb.path.split(d).pop(),
      delimiter: d,
      flags: new Set(),
      specialUse: mb.specialUse,
    }))
  }

  async getMailboxLock(path, { readOnly = false } = {}) {
    if (!this.usable) throw Object.assign(new Error('Connection not available'), { code: 'NoConnection' })
    const mb = this.server.mailboxes.get(path)
    if (!mb) throw new Error(`no mailbox ${path}`)
    this.server.openLog.push({ path, readOnly, via: 'lock' })
    const uids = [...mb.messages.keys()]
    this.mailbox = { path, uidValidity: BigInt(mb.uidValidity), exists: uids.length, highestModseq: null, readOnly }
    return { release: () => {} }
  }

  async search(query) {
    const mb = this.server.mailboxes.get(this.mailbox.path)
    if (query.all) return [...mb.messages.keys()].sort((a, b) => a - b)
    if (query.deleted) return [...mb.messages.values()].filter(m => m.flags.has('\\Deleted')).map(m => m.uid).sort((a, b) => a - b)
    if (query.header) {
      // { header: { 'message-id': '<x@y>' } }
      const [[name, value]] = Object.entries(query.header)
      const re = new RegExp(`^${name}:[ \\t]*${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*$`, 'im')
      return [...mb.messages.values()].filter(m => re.test(m.source.toString('utf8').split(/\r?\n\r?\n/)[0])).map(m => m.uid)
    }
    if (query.text === undefined) throw new Error('fake search supports { all } or { text, before }')
    const entry = { path: mb.path, text: query.text, before: query.before || null, startedAt: Date.now(), endedAt: null }
    this.server.searchLog.push(entry)
    this.server.runningSearches++
    try {
      if (this.server.searchDelayMs) {
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, this.server.searchDelayMs)
          this.once('close', () => {
            clearTimeout(t)
            reject(Object.assign(new Error('Connection not available'), { code: 'NoConnection' }))
          })
        })
      }
      // like imapflow: a NO/BAD answer is returned as false
      if (this.server.rejectCharset && /[^\x20-\x7e]/.test(query.text)) return false
      const needle = foldForSearch(query.text)
      return [...mb.messages.values()]
        .filter(m => !query.before || m.internalDate < query.before)
        .filter(m => foldForSearch(m.source.toString('utf8')).includes(needle))
        .map(m => m.uid)
        .sort((a, b) => a - b)
    } finally {
      this.server.runningSearches--
      entry.endedAt = Date.now()
    }
  }

  async *fetch(range, query) {
    const mb = this.server.mailboxes.get(this.mailbox.path)
    let uids
    if (typeof range === 'string') {
      const min = Number(range.split(':')[0])
      uids = [...mb.messages.keys()].filter(u => u >= min)
    } else {
      uids = range
    }
    const kind = query.source ? 'source' : query.envelope ? 'meta' : 'flags'
    this.server.fetchLog.push({ path: mb.path, uids: [...uids], kind })
    for (const uid of uids) {
      const m = mb.messages.get(uid)
      if (!m) continue
      if (kind === 'source') {
        const max = query.source.maxLength || m.source.length
        yield { uid, source: m.source.subarray(0, max) }
      } else if (kind === 'flags') {
        yield { uid, flags: m.flags }
      } else {
        yield { uid, flags: m.flags, envelope: m.envelope, internalDate: m.internalDate, size: m.size, bodyStructure: m.bodyStructure, headers: m.headers }
      }
    }
  }

  async fetchOne(uid, query, { uid: byUid } = {}) {
    if (!this.usable) throw Object.assign(new Error('Connection not available'), { code: 'NoConnection' })
    if (!byUid) throw new Error('fake fetchOne supports UIDs only')
    const mb = this.server.mailboxes.get(this.mailbox.path)
    const m = mb.messages.get(Number(uid))
    this.server.fetchLog.push({ path: mb.path, uids: [Number(uid)], kind: query.source ? 'full' : 'meta' })
    if (!m) return false
    return { uid: m.uid, source: query.source ? m.source : undefined, flags: m.flags }
  }

  // "1,2,3" or "1:5,7" UID sets, read-write only
  _uids(range, byUid) {
    if (!this.usable) throw Object.assign(new Error('Connection not available'), { code: 'NoConnection' })
    if (!byUid) throw new Error('fake actions support UIDs only')
    if (this.mailbox.readOnly) throw new Error('mailbox is read-only (EXAMINE)')
    this.server.actionLog.push({ op: 'uidset', path: this.mailbox.path, set: String(range) })
    return String(range).split(',').flatMap(part => {
      const [a, b] = part.split(':').map(Number)
      return b === undefined ? [a] : Array.from({ length: b - a + 1 }, (_, k) => a + k)
    })
  }

  async messageFlagsAdd(range, flags, { uid: byUid } = {}) {
    const uids = this._uids(range, byUid)
    const mb = this.server.mailboxes.get(this.mailbox.path)
    if (this.server.refuseOps.has('flags+')) return false
    this.server.actionLog.push({ op: 'flags+', path: mb.path, uids, flags })
    let any = false
    for (const u of uids) {
      const m = mb.messages.get(u)
      if (!m) continue
      for (const f of flags) m.flags.add(f)
      any = true
    }
    return any
  }

  async messageFlagsRemove(range, flags, { uid: byUid } = {}) {
    const uids = this._uids(range, byUid)
    const mb = this.server.mailboxes.get(this.mailbox.path)
    this.server.actionLog.push({ op: 'flags-', path: mb.path, uids, flags })
    for (const u of uids) {
      const m = mb.messages.get(u)
      if (m) for (const f of flags) m.flags.delete(f)
    }
    return true
  }

  async messageMove(range, destination, { uid: byUid } = {}) {
    // like imapflow on a server without MOVE: COPY, then \Deleted + EXPUNGE (plain without UIDPLUS)
    if (this.server.move === false) {
      const copied = await this.messageCopy(range, destination, { uid: byUid })
      if (copied === false) return false
      await this.messageDelete(range, { uid: byUid })
      return { path: this.mailbox.path, destination }
    }
    const uids = this._uids(range, byUid)
    const from = this.server.mailboxes.get(this.mailbox.path)
    const to = this.server.mailboxes.get(destination)
    if (!to || this.server.refuseOps.has('move')) return false
    this.server.actionLog.push({ op: 'move', path: from.path, uids, destination })
    const uidMap = new Map()
    for (const u of uids) {
      const m = from.messages.get(u)
      if (!m) continue
      const nu = to.nextUid++
      from.messages.delete(u)
      to.messages.set(nu, { ...m, uid: nu, flags: new Set(m.flags) })
      uidMap.set(u, nu)
    }
    return { path: from.path, destination, uidMap: this.server.uidplus ? uidMap : undefined }
  }

  // like imapflow: \Deleted on the UIDs, then UID EXPUNGE with UIDPLUS, or a plain EXPUNGE without it,
  // which removes EVERY \Deleted message of the folder
  async messageDelete(range, { uid: byUid } = {}) {
    const uids = this._uids(range, byUid)
    const mb = this.server.mailboxes.get(this.mailbox.path)
    if (this.server.refuseOps.has('expunge')) return false
    this.server.actionLog.push({ op: 'expunge', path: mb.path, uids })
    for (const u of uids) mb.messages.get(u)?.flags.add('\\Deleted')
    if (this.server.uidplus) for (const u of uids) mb.messages.delete(u)
    else for (const [u, m] of [...mb.messages]) if (m.flags.has('\\Deleted')) mb.messages.delete(u)
    return true
  }

  async messageCopy(range, destination, { uid: byUid } = {}) {
    const uids = this._uids(range, byUid)
    const from = this.server.mailboxes.get(this.mailbox.path)
    const to = this.server.mailboxes.get(destination)
    if (!to || this.server.refuseOps.has('move')) return false
    this.server.actionLog.push({ op: 'copy', path: from.path, uids, destination })
    for (const u of uids) {
      const m = from.messages.get(u)
      if (!m) continue
      const nu = to.nextUid++
      to.messages.set(nu, { ...m, uid: nu, flags: new Set(m.flags) })
    }
    return { path: from.path, destination }
  }

  // folders, like imapflow: the namespace prefix is added to a path that lacks it
  _norm(path) {
    const { prefix } = this.server
    return path.toUpperCase() === 'INBOX' || !prefix || path.startsWith(prefix) ? path : prefix + path
  }

  async mailboxCreate(path) {
    const p = this._norm(path)
    if (this.server.refuseOps.has('create')) throw Object.assign(new Error('Command failed'), { responseStatus: 'NO', responseText: 'refused' })
    if (this.server.mailboxes.has(p)) return { path: p, created: false }
    this.server.addMailbox(p)
    this.server.actionLog.push({ op: 'create', path: p })
    return { path: p, created: true }
  }

  async mailboxRename(from, to) {
    const f = this._norm(from)
    const t = this._norm(to)
    if (!this.server.mailboxes.has(f) || this.server.mailboxes.has(t)) throw Object.assign(new Error('Command failed'), { responseStatus: 'NO' })
    const d = this.server.delimiter
    for (const [p, mb] of [...this.server.mailboxes]) {
      if (p !== f && !p.startsWith(f + d)) continue
      const np = t + p.slice(f.length)
      this.server.mailboxes.delete(p)
      this.server.mailboxes.set(np, { ...mb, path: np, uidValidity: mb.uidValidity + 1000 })
    }
    this.server.actionLog.push({ op: 'rename', path: f, to: t })
    return { path: f, newPath: t }
  }

  async mailboxDelete(path) {
    const p = this._norm(path)
    if (!this.server.mailboxes.has(p)) throw Object.assign(new Error('Command failed'), { responseStatus: 'NO' })
    this.server.mailboxes.delete(p)
    this.server.actionLog.push({ op: 'delete', path: p })
    return { path: p }
  }

  // APPEND (Drafts, Sent). Like imapflow: { destination, uid } (uid only with UIDPLUS)
  async append(path, content, flags = [], idate = new Date()) {
    if (!this.usable) throw Object.assign(new Error('Connection not available'), { code: 'NoConnection' })
    const mb = this.server.mailboxes.get(this._norm(path))
    if (!mb || this.server.refuseOps.has('append')) return false
    // a server that answers NO to a custom keyword (imapflow throws, with responseStatus), or drops the line
    if (this.server.appendKeywordNo && flags.some(f => f.startsWith('$'))) throw Object.assign(new Error('Command failed'), { responseStatus: 'NO' })
    if (this.server.appendKeywordDrop && flags.some(f => f.startsWith('$'))) throw Object.assign(new Error('Connection not available'), { code: 'NoConnection' })
    const uid = mb.nextUid++
    const source = Buffer.from(content)
    // the envelope from the message itself, as a server builds it (threads of sent replies)
    const p = await simpleParser(source, { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true })
    const addrs = f => (f ? f.value.map(a => ({ name: a.name || '', address: a.address })) : [])
    const refs = Array.isArray(p.references) ? p.references.join(' ') : p.references || ''
    mb.messages.set(uid, {
      uid,
      flags: new Set(flags),
      internalDate: new Date(idate),
      size: source.length,
      envelope: { date: p.date || new Date(idate), subject: p.subject || '', messageId: p.messageId || null, inReplyTo: p.inReplyTo || null, from: addrs(p.from), to: addrs(p.to), cc: addrs(p.cc) },
      bodyStructure: { type: 'text/plain', part: '1', size: source.length },
      headers: Buffer.from(refs ? `References: ${refs}\r\n` : ''),
      source,
    })
    this.server.actionLog.push({ op: 'append', path: mb.path, uid, flags })
    return { destination: mb.path, uid: this.server.uidplus ? uid : undefined }
  }

  async mailboxSubscribe(path) {
    this.server.subscribed.add(this._norm(path))
    return true
  }

  async mailboxUnsubscribe(path) {
    this.server.subscribed.delete(this._norm(path))
    return true
  }

  async logout() {
    this._closed()
  }

  close() {
    this._closed()
  }
}
