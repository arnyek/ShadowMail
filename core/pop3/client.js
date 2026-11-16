// SPDX-License-Identifier: GPL-3.0-or-later
// Minimal POP3 client (RFC 1939, RFC 2595 STLS, RFC 2449 CAPA): the connection test
// (greeting, STLS, USER/PASS, QUIT) and the download (STAT/UIDL/RETR/DELE).
// Own code on purpose: the protocol is small and we do not depend on an unmaintained package.
import net from 'node:net'
import tls from 'node:tls'

export class Pop3Error extends Error {
  constructor(message, { code, response, authenticationFailed = false, tlsFailed = false } = {}) {
    super(message)
    this.name = 'Pop3Error'
    this.code = code
    this.response = response
    this.authenticationFailed = authenticationFailed
    this.tlsFailed = tlsFailed
  }
}

const servername = host => (net.isIP(host) ? undefined : host)
const CRLF = Buffer.from('\r\n')
const CR = 0x0d
const LF = 0x0a
const DOT = 0x2e

// { line, bufs }: the status line and the data lines as Buffers; `lines` as latin1 strings on demand.
function result(line, bufs) {
  return {
    line,
    bufs,
    get lines() {
      return bufs.map(b => b.toString('latin1'))
    },
  }
}

/**
 * The answer's bytes -> lines (Buffers, without their CRLF), linear. `st` holds `partial` (the chunks of the
 * unfinished line, joined once its end arrives) and `lines`. Exported for the tests:
 * on a Windows machine with ESET's mail protection the proxy changes how the pieces arrive, so the line rule is measured on given
 * pieces, without a socket.
 */
export function splitChunk(st, chunk, onBareCr = () => {}) {
  let pos = 0
  if (st.partial.length) {
    const last = st.partial[st.partial.length - 1]
    // a CRLF split between two chunks
    if (last[last.length - 1] === CR && chunk[0] === LF) {
      st.partial[st.partial.length - 1] = last.subarray(0, last.length - 1)
      st.lines.push(Buffer.concat(st.partial))
      st.partial = []
      pos = 1
    } else if (last[last.length - 1] === CR) {
      // some antivirus mail proxies (measured: ESET's mail protection on Windows) handle
      // POP3 (127.0.0.1 too), and when a CR and its LF fall into two TCP pieces the LF is lost: "+OK n octets\r" then
      // "From: ...". So a chunk that ends in CR, followed by one that does not start with LF, ends the line there (the
      // lost LF put back). Only at a chunk boundary: a bare CR inside a line stays as it is. A message's own bare CR
      // (against RFC 5322) that happens to end a chunk becomes a line end too; no byte of it is lost.
      st.partial[st.partial.length - 1] = last.subarray(0, last.length - 1)
      st.lines.push(Buffer.concat(st.partial))
      st.partial = []
      onBareCr()
    } else {
      const i = chunk.indexOf(CRLF)
      if (i < 0) {
        st.partial.push(Buffer.from(chunk))
        return
      }
      st.lines.push(Buffer.concat([...st.partial, chunk.subarray(0, i)]))
      st.partial = []
      pos = i + 2
    }
  }
  for (;;) {
    const i = chunk.indexOf(CRLF, pos)
    if (i < 0) break
    st.lines.push(chunk.subarray(pos, i))
    pos = i + 2
  }
  if (pos < chunk.length) st.partial.push(Buffer.from(chunk.subarray(pos)))
}

export class Pop3Client {
  /**
   * @param opts.host, opts.port
   * @param opts.security 'tls' (implicit, usually 995) | 'starttls' (STLS required) | 'none'
   * @param opts.tlsVerify false = accept any certificate (shared hosting; the UI warns)
   * @param opts.timeoutMs socket inactivity limit
   * @param opts.onBareCr called (no content) when a chunk ended in CR and the next did not start with LF
   */
  constructor({ host, port, security = 'tls', tlsVerify = true, timeoutMs = 15_000, onBareCr = () => {} }) {
    this.opts = { host, port, security, tlsVerify, timeoutMs }
    this.onBareCr = onBareCr
    this.socket = null
    this.partial = [] // chunks of the unfinished line (joined once, when its CRLF arrives: linear)
    this.lines = []
    this.waiters = []
    this.closed = false
    this.capabilities = null
  }

  #attach(socket) {
    this.socket = socket
    // Raw bytes, split into lines here (no setEncoding(): the plain socket may be wrapped for STLS).
    // Line by line, so a large RETR is linear in its size.
    socket.setTimeout(this.opts.timeoutMs)
    socket.on('data', chunk => {
      this.#split(chunk)
      this.#drain()
    })
    socket.on('timeout', () => this.#fail(new Pop3Error('POP3 server timed out', { code: 'ETIMEDOUT' })))
    socket.on('error', err => this.#fail(err))
    socket.on('close', () => {
      this.closed = true
      this.#fail(new Pop3Error('POP3 connection closed', { code: 'ECONNRESET' }))
    })
  }

  #split(chunk) {
    splitChunk(this, chunk, this.onBareCr)
  }

  #fail(err) {
    const waiters = this.waiters
    this.waiters = []
    for (const w of waiters) w.reject(err)
  }

  #drain() {
    while (this.waiters.length && this.lines.length) {
      const w = this.waiters[0]
      if (w.status === undefined) {
        w.status = this.lines.shift().toString('latin1')
        if (!w.multiline || !w.status.startsWith('+OK')) {
          this.waiters.shift()
          w.resolve(result(w.status, []))
          continue
        }
      }
      // data lines up to "." alone; a leading "." of a data line is byte-stuffed ("..")
      while (this.lines.length) {
        const l = this.lines.shift()
        if (l.length === 1 && l[0] === DOT) {
          this.waiters.shift()
          w.resolve(result(w.status, w.body))
          break
        }
        w.body.push(l[0] === DOT ? l.subarray(1) : l)
      }
    }
  }

  #read(multiline = false) {
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject, multiline, status: undefined, body: [] })
      this.#drain()
    })
  }

  async #connectSocket() {
    const { host, port, security, tlsVerify } = this.opts
    return new Promise((resolve, reject) => {
      const onError = err => reject(err)
      const onTimeout = () => {
        socket.destroy()
        reject(new Pop3Error('POP3 connection timed out', { code: 'ETIMEDOUT' }))
      }
      const connected = () => {
        socket.removeListener('error', onError)
        socket.removeListener('timeout', onTimeout)
        resolve(socket)
      }
      const socket =
        security === 'tls'
          ? tls.connect({ host, port, servername: servername(host), rejectUnauthorized: tlsVerify }, connected)
          : net.connect({ host, port }, connected)
      socket.once('error', onError)
      socket.setTimeout(this.opts.timeoutMs)
      socket.once('timeout', onTimeout)
    })
  }

  /** Command with a single-line answer; throws on -ERR. */
  async command(line, { multiline = false, sensitive = false } = {}) {
    if (!this.socket || this.closed) throw new Pop3Error('not connected', { code: 'ENOTCONN' })
    const reply = this.#read(multiline)
    this.socket.write(`${line}\r\n`)
    const res = await reply
    if (!res.line.startsWith('+OK')) {
      const shown = sensitive ? line.split(' ')[0] : line
      throw new Pop3Error(`POP3 ${shown} failed: ${res.line}`, { code: 'POP3_ERR', response: res.line })
    }
    return res
  }

  async connect() {
    const socket = await this.#connectSocket()
    this.#attach(socket)
    const greeting = await this.#read()
    if (!greeting.line.startsWith('+OK')) throw new Pop3Error(`POP3 greeting: ${greeting.line}`, { code: 'POP3_GREETING', response: greeting.line })
    this.capabilities = await this.#capa()
    if (this.opts.security === 'starttls') {
      if (!this.capabilities.has('STLS')) throw new Pop3Error('Server does not support STLS', { code: 'STARTTLS_UNSUPPORTED', tlsFailed: true })
      await this.command('STLS')
      await this.#upgrade()
      this.capabilities = await this.#capa()
    }
    return greeting.line
  }

  async #capa() {
    try {
      const res = await this.command('CAPA', { multiline: true })
      return new Set(res.lines.map(l => l.split(' ')[0].toUpperCase()))
    } catch (err) {
      if (err.code === 'POP3_ERR') return new Set() // CAPA is optional (RFC 2449)
      throw err
    }
  }

  async #upgrade() {
    const plain = this.socket
    plain.removeAllListeners('data')
    plain.removeAllListeners('timeout')
    plain.removeAllListeners('close')
    plain.removeAllListeners('error')
    const { host, tlsVerify, timeoutMs } = this.opts
    // the handshake gets the same limit as everything else: a server that says +OK to STLS and then
    // stays silent must not hang the run forever
    const secure = await new Promise((resolve, reject) => {
      const s = tls.connect({ socket: plain, servername: servername(host), rejectUnauthorized: tlsVerify }, () => {
        clearTimeout(timer)
        resolve(s)
      })
      const timer = setTimeout(() => {
        s.destroy()
        plain.destroy()
        reject(new Pop3Error('POP3 STLS handshake timed out', { code: 'ETIMEDOUT', tlsFailed: true }))
      }, timeoutMs)
      s.once('error', err => {
        clearTimeout(timer)
        reject(err)
      })
    })
    this.partial = []
    this.lines = []
    this.#attach(secure)
  }

  async login(user, pass) {
    // CR/LF would end the command and smuggle in another one (the account form refuses them too)
    if (/[\r\n\0]/.test(user) || /[\r\n\0]/.test(pass)) throw new Pop3Error('POP3 login: control characters in the user or password', { code: 'POP3_AUTH', authenticationFailed: true })
    try {
      // some servers answer -ERR already to USER for an unknown user: that is a login failure too
      await this.command(`USER ${user}`)
      await this.command(`PASS ${pass}`, { sensitive: true })
    } catch (err) {
      if (err.code === 'POP3_ERR') {
        // RFC 2449 response codes: [IN-USE] (the mailbox is locked by another session) and [SYS/TEMP]
        // are not a wrong password; taking them for one would stop the account.
        // The code stands right after "-ERR" (RFC 2449 section 8): "[SYS/TEMP]" elsewhere in the text is
        // not one. A busy mailbox without a code ("-ERR maildrop already locked")
        // stays a login failure on purpose: one attempt and a stop never risks the server's IP ban.
        if (/^-ERR\s+\[(IN-USE|SYS\/TEMP)\]/i.test(err.response || '')) {
          throw new Pop3Error('POP3 mailbox busy', { code: 'POP3_IN_USE', response: err.response })
        }
        throw new Pop3Error('POP3 login failed', { code: 'POP3_AUTH', response: err.response, authenticationFailed: true })
      }
      throw err
    }
  }

  /** -> { count, size } */
  async stat() {
    const { line } = await this.command('STAT')
    const m = /^\+OK\s+(\d+)\s+(\d+)/.exec(line)
    if (!m) throw new Pop3Error(`POP3 STAT: unexpected answer: ${line}`, { code: 'POP3_PROTOCOL', response: line })
    return { count: Number(m[1]), size: Number(m[2]) }
  }

  /** -> [{ n, uidl }]. A server without UIDL cannot be read incrementally: UIDL_UNSUPPORTED. */
  async uidl() {
    let res
    try {
      res = await this.command('UIDL', { multiline: true })
    } catch (err) {
      if (err.code === 'POP3_ERR') throw new Pop3Error('POP3 server does not support UIDL', { code: 'UIDL_UNSUPPORTED', response: err.response })
      throw err
    }
    const out = []
    for (const l of res.lines) {
      const m = /^(\d+)\s+(\S{1,70})$/.exec(l.trim())
      if (!m) throw new Pop3Error(`POP3 UIDL: unexpected line: ${l.slice(0, 80)}`, { code: 'POP3_PROTOCOL' })
      out.push({ n: Number(m[1]), uidl: m[2] })
    }
    return out
  }

  /** The whole message n as raw bytes (CRLF line ends, dot-unstuffed). */
  async retr(n) {
    if (!Number.isInteger(n) || n < 1) throw new Pop3Error(`bad message number ${n}`, { code: 'POP3_ARG' })
    const { bufs } = await this.command(`RETR ${n}`, { multiline: true })
    const parts = []
    for (const b of bufs) parts.push(b, CRLF)
    return Buffer.concat(parts)
  }

  /** Marks message n for deletion; the server deletes it only on a clean QUIT (RFC 1939 UPDATE state). */
  async dele(n) {
    if (!Number.isInteger(n) || n < 1) throw new Pop3Error(`bad message number ${n}`, { code: 'POP3_ARG' })
    await this.command(`DELE ${n}`)
  }

  async quit() {
    try {
      if (this.socket && !this.closed) await this.command('QUIT')
    } finally {
      this.close()
    }
  }

  close() {
    if (this.socket) this.socket.destroy()
    this.closed = true
  }
}
