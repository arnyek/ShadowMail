// SPDX-License-Identifier: GPL-3.0-or-later
// MCP: the local pipe the `--mcp` connector talks to. It exists only while
// Claude access is ON and the app is unlocked: a named pipe on Windows (\\.\pipe\shadowmail-<random>), a unix
// socket in the data folder elsewhere (tests). A new 256-bit key per start; the pipe and the key go into
// data/mcp/endpoint.json, which is deleted on stop. The first line of a connection is the key (compared in
// constant time); a wrong key closes it. At most MAX_CONNECTIONS authenticated connections: a new one takes the
// place of the one idle the longest (no request in flight; the connector of that conversation connects again at its
// next request), and only when every connection has a request in flight does it get a "too many" line before the
// close. A connection without its key gets AUTH_TIMEOUT_MS, and at most MAX_PENDING wait at once.
// Electron-free, testable.
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'

export const MAX_CONNECTIONS = 2
export const MAX_PENDING = 8
// the connector sends its key right after the connect: 1 s is generous, and a slot is not held long
export const AUTH_TIMEOUT_MS = 1000
export const TOO_MANY = 'too_many'
// the server proves itself to the connector. A per-start Ed25519 key pair (the private key
// only in memory); endpoint.json carries the public key; the connector sends a 32-byte nonce with its key,
// the server signs HELLO_LABEL || nonce || pipe name. A squatter behind a stale endpoint.json cannot sign.
export const HELLO_LABEL = 'shadowmail-mcp-v1'
export function helloBytes(nonce, pipe) {
  return Buffer.concat([Buffer.from(HELLO_LABEL, 'utf8'), nonce, Buffer.from(pipe, 'utf8')])
}
// the "too many connections" answer is signed too, under its own label, so only the real app can
// make the connector say it
export const TOO_MANY_LABEL = 'shadowmail-mcp-v1-too-many'
export function tooManyBytes(nonce, pipe) {
  return Buffer.concat([Buffer.from(TOO_MANY_LABEL, 'utf8'), nonce, Buffer.from(pipe, 'utf8')])
}
const RATE_LOG_MS = 10_000
const MAX_LINE = 1024 * 1024
// before the key a line is a { key, nonce } of about 150 bytes: a much smaller limit
export const PRE_AUTH_MAX_LINE = 4096
// unix sockets: sun_path is 108 bytes on Linux; a longer path would be cut and land OUTSIDE the data folder
const MAX_SOCKET_PATH = 100

export const endpointFile = dataDir => path.join(dataDir, 'mcp', 'endpoint.json')

// the key never stays in a temporary file: a failed write removes it and throws
function writeEndpoint(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 })
    fs.renameSync(tmp, file)
  } catch (err) {
    fs.rmSync(tmp, { force: true })
    throw err
  }
}

export class McpPipeServer {
  /**
   * @param dispatch  async (line) -> answer object | null (protocol.js)
   * @param log       a line without content
   */
  constructor({ dataDir, dispatch, log = () => {}, platform = process.platform, maxConnections = MAX_CONNECTIONS, maxPending = MAX_PENDING, authTimeoutMs = AUTH_TIMEOUT_MS, now = () => performance.now() }) {
    this.dataDir = dataDir
    this.dispatch = dispatch
    this.log = log
    this.platform = platform
    this.maxConnections = maxConnections
    this.maxPending = maxPending
    this.authTimeoutMs = authTimeoutMs
    // a monotonic clock: the wall clock can step back (it does on WSL), and the idle order must not
    this.now = now
    this.server = null
    this.key = null
    this.address = null
    this.sockets = new Set() // authenticated
    this.activity = new Map() // authenticated socket -> { inflight, lastActive }
    this.pending = new Set() // connected, key not seen yet
    this.wanted = false // the last start() / stop() decides (ON -> OFF -> ON without waiting)
    this.starting = null // the start in flight: a second start() waits for it
    this.generation = 0 // bumped by stop(): a request queued before it never runs after it
    this.signer = null // the per-start Ed25519 private key
    this.rates = new Map() // log kind -> { count, timer }: a flood of refused connections is one line per 10 s (p3b)
  }

  // the first line of a kind at once, then at most one summary line per RATE_LOG_MS with the count
  #rateLog(kind, message) {
    const r = this.rates.get(kind)
    if (!r) {
      this.log(message)
      const entry = { count: 0, timer: null }
      entry.timer = setTimeout(() => {
        if (entry.count) this.log(`${message} (+${entry.count} in ${RATE_LOG_MS / 1000} s)`)
        this.rates.delete(kind)
      }, RATE_LOG_MS)
      entry.timer.unref?.()
      this.rates.set(kind, entry)
      return
    }
    r.count++
  }

  get running() {
    return Boolean(this.server)
  }

  get connections() {
    return this.sockets.size
  }

  /** Opens the pipe (or waits for the opening in flight). Resolves when the wanted state is reached. */
  start() {
    this.wanted = true
    if (this.server) return Promise.resolve()
    if (!this.starting) this.starting = this.#open().finally(() => (this.starting = null))
    return this.starting
  }

  async #open() {
    // ON -> OFF -> ON while listen() waits: whatever is wanted when it is done decides (one listen is enough)
    {
      const id = crypto.randomBytes(16).toString('hex')
      const address = this.platform === 'win32' ? `\\\\.\\pipe\\shadowmail-${id}` : path.join(this.dataDir, 'mcp', `s-${id.slice(0, 12)}.sock`)
      if (this.platform !== 'win32' && Buffer.byteLength(address) > MAX_SOCKET_PATH) {
        this.log('mcp pipe not opened: socket path too long')
        throw Object.assign(new Error('socket path too long'), { code: 'path_too_long' })
      }
      fs.mkdirSync(path.join(this.dataDir, 'mcp'), { recursive: true })
      const server = net.createServer(socket => this.#accept(socket))
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(address, () => {
          server.off('error', reject)
          resolve()
        })
      })
      if (!this.wanted) {
        // locked or switched off meanwhile: this pipe never gets an endpoint
        this.#closeServer(server, address)
        return
      }
      server.on('error', err => this.log(`mcp pipe error: ${err && err.code ? err.code : 'unknown'}`))
      const key = crypto.randomBytes(32)
      const pair = crypto.generateKeyPairSync('ed25519')
      try {
        writeEndpoint(endpointFile(this.dataDir), {
          version: 2,
          pipe: address,
          key: key.toString('hex'),
          sign: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
        })
      } catch (err) {
        key.fill(0)
        this.#closeServer(server, address)
        this.log(`mcp pipe not opened: endpoint write failed: ${err && err.code ? err.code : 'unknown'}`)
        throw err
      }
      this.server = server
      this.address = address
      this.key = key
      this.signer = pair.privateKey
      this.log('mcp pipe open')
    }
  }

  #closeServer(server, address) {
    server.close()
    if (this.platform !== 'win32') fs.rmSync(address, { force: true })
  }

  /** Lock, quit, switched off: the pipe closes, the connections drop, endpoint.json goes, the key is wiped. */
  stop() {
    this.wanted = false
    this.generation++
    for (const s of this.pending) s.destroy()
    this.pending.clear()
    if (!this.server) {
      this.#removeEndpoint()
      return
    }
    for (const s of this.sockets) s.destroy()
    this.sockets.clear()
    this.activity.clear()
    this.server.close()
    this.server = null
    if (this.key) this.key.fill(0)
    this.key = null
    this.signer = null // the private key goes with the session: an old endpoint.json can never be answered
    this.#removeEndpoint()
    if (this.platform !== 'win32' && this.address) fs.rmSync(this.address, { force: true })
    this.address = null
    this.log('mcp pipe closed')
  }

  #removeEndpoint() {
    try {
      fs.rmSync(endpointFile(this.dataDir), { force: true })
    } catch (err) {
      this.log(`mcp endpoint remove failed: ${err && err.code ? err.code : 'unknown'}`)
    }
  }

  #accept(socket) {
    socket.on('error', () => {})
    if (this.pending.size >= this.maxPending) {
      this.#rateLog('pending', 'mcp connection refused: too many without a key')
      socket.destroy()
      return
    }
    this.pending.add(socket)
    const gen = this.generation
    let alive = true
    socket.on('close', () => {
      alive = false
      this.pending.delete(socket)
      this.sockets.delete(socket)
      this.activity.delete(socket)
    })
    socket.setEncoding('utf8')
    let authed = false
    let activity = null // this connection's { inflight, lastActive } once authenticated
    let buffer = ''
    let chain = Promise.resolve()
    const timer = setTimeout(() => {
      if (!authed) {
        this.#rateLog('nokey', 'mcp connection closed: no key')
        socket.destroy()
      }
    }, this.authTimeoutMs)
    timer.unref?.()
    socket.on('data', chunk => {
      buffer += chunk
      // before the key only the key LINE (up to its newline) has the small limit; what follows it in the same chunk is
      // a request, read once the key is right
      const firstLine = authed ? buffer.length : buffer.indexOf('\n') < 0 ? buffer.length : buffer.indexOf('\n')
      if ((authed && buffer.length > MAX_LINE) || (!authed && (firstLine > PRE_AUTH_MAX_LINE || buffer.length > MAX_LINE))) {
        // before the key the line is a stranger's: its log line is thinned like the other refusals
        if (authed) this.log('mcp connection closed: line too long')
        else this.#rateLog('toolong', 'mcp connection closed: line too long')
        socket.destroy()
        return
      }
      let i
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i).replace(/\r$/, '')
        buffer = buffer.slice(i + 1)
        if (!line.trim()) continue
        if (!authed) {
          const hello = this.#hello(line)
          if (!hello) {
            this.#rateLog('wrongkey', 'mcp connection closed: wrong key')
            socket.destroy()
            return
          }
          clearTimeout(timer)
          this.pending.delete(socket)
          // the limit counts authenticated connections. At the limit the one idle the longest makes room (a connector
          // whose conversation was left open holds its place until it quits); a connection with a request in flight is
          // never closed. Only when all of them work is the new one told why (the connector says it)
          if (this.sockets.size >= this.maxConnections) {
            const idle = this.#idlest()
            if (!idle) {
              this.log('mcp connection refused: limit')
              socket.end(`${JSON.stringify({ shadowmail: TOO_MANY, sig: hello.tooMany })}\n`)
              alive = false
              return
            }
            // out of the set at once, not on its (later) close: the new one takes the place in the same turn
            this.sockets.delete(idle)
            this.activity.delete(idle)
            idle.destroy()
            this.log('mcp connection closed: idle, replaced')
          }
          this.sockets.add(socket)
          activity = { inflight: 0, lastActive: this.now() }
          this.activity.set(socket, activity)
          authed = true
          socket.write(`${JSON.stringify({ shadowmail: 'hello', sig: hello.sig })}\n`)
          continue
        }
        // answers in request order; a request queued before a stop() (lock, switched off) or the close of
        // its connection never runs. In flight from its arrival to the end of its step (answered, failed or skipped);
        // a connection is active until its last step ends, when its lastActive is taken
        activity.inflight++
        chain = chain.then(async () => {
          const live = () => alive && gen === this.generation && Boolean(this.server)
          if (!live()) return
          const answer = await this.dispatch(line, { alive: live })
          if (answer && alive && !socket.destroyed) socket.write(`${JSON.stringify(answer)}\n`)
        }).catch(err => this.log(`mcp dispatch failed: ${err && err.code ? err.code : 'internal'}`)).finally(() => {
          activity.inflight--
          activity.lastActive = this.now()
        })
      }
    })
  }

  /** The authenticated connection without a request in flight that was active the longest ago, or null. */
  #idlest() {
    let best = null
    let bestAt = Infinity
    for (const [socket, a] of this.activity) {
      if (a.inflight === 0 && a.lastActive < bestAt) {
        best = socket
        bestAt = a.lastActive
      }
    }
    return best
  }

  /** The first line: { key, nonce }. The right key -> { sig, tooMany } signatures for the connector (base64), else null. */
  #hello(line) {
    if (!this.key || !this.signer) return null
    let given = null
    let nonce = null
    try {
      const m = JSON.parse(line)
      given = m && typeof m.key === 'string' && /^[0-9a-f]{64}$/.test(m.key) ? Buffer.from(m.key, 'hex') : null
      nonce = m && typeof m.nonce === 'string' && /^[0-9a-f]{64}$/.test(m.nonce) ? Buffer.from(m.nonce, 'hex') : null
    } catch {
      given = null
    }
    // constant time over the 32 bytes; a malformed key compares a zero buffer (same time) and fails
    const candidate = given || Buffer.alloc(32)
    const ok = crypto.timingSafeEqual(candidate, this.key) && given !== null
    if (!ok || !nonce) return null
    return {
      sig: crypto.sign(null, helloBytes(nonce, this.address), this.signer).toString('base64'),
      tooMany: crypto.sign(null, tooManyBytes(nonce, this.address), this.signer).toString('base64'),
    }
  }
}
