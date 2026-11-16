// A real (TCP, plain text) POP3 server for the POP3 tests: CAPA, USER/PASS, STAT, UIDL, RETR (dot-stuffed),
// DELE (applied only on QUIT, RFC 1939 UPDATE state), RSET, NOOP, QUIT. Answers are written in small
// random pieces, so the client meets lines and the "." terminator split across packets.
// It counts logins, logs commands (without the password) and can reject logins or be stopped.
import net from 'node:net'

export class FakePop3Server {
  constructor({ user = 'teszt', pass = 'jo-jelszo', uidl = true, chunk = 7 } = {}) {
    this.user = user
    this.pass = pass
    this.supportsUidl = uidl
    this.chunk = chunk
    this.messages = [] // { uidl, source: Buffer }
    this.loginAttempts = 0
    this.log = [] // commands, PASS masked
    this.refuseRetr = new Set() // UIDLs (or entries of `messages`) answered with -ERR on RETR (a corrupt message)
    this.passReply = null // a custom -ERR line for PASS, e.g. '-ERR [IN-USE] mailbox locked'
    // (the whole RETR answer as bytes) -> the pieces to write instead, each after a 30 ms pause, so a TCP
    // piece ends exactly where the test wants (e.g. after a CR, its LF dropped, as a Windows mail proxy (ESET) does).
    // null = the usual small random pieces.
    this.retrPieces = null
    this.sockets = new Set()
    this.server = net.createServer(s => this.#session(s))
  }

  add(source, uidl = `uid-${this.messages.length + 1}-${Math.random().toString(36).slice(2, 8)}`) {
    this.messages.push({ uidl, source: Buffer.isBuffer(source) ? source : Buffer.from(source) })
    return uidl
  }

  async listen() {
    await new Promise(r => this.server.listen(0, '127.0.0.1', r))
    this.port = this.server.address().port
    return this
  }

  async close() {
    for (const s of this.sockets) s.destroy()
    await new Promise(r => this.server.close(() => r()))
  }

  account() {
    return { in_host: '127.0.0.1', in_port: this.port, in_security: 'none', in_user: this.user, tls_verify: 1 }
  }

  #write(socket, data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'latin1')
    // small random pieces: lines and the terminator arrive split
    for (let i = 0; i < buf.length; ) {
      const n = 1 + Math.floor(Math.random() * this.chunk * 50)
      socket.write(buf.subarray(i, i + n))
      i += n
    }
  }

  #session(socket) {
    this.sockets.add(socket)
    socket.on('close', () => this.sockets.delete(socket))
    socket.on('error', () => {})
    let authed = false
    let user = null
    const deleted = new Set()
    // a snapshot like a real maildrop lock: numbering is fixed for the session
    let drop = null
    let pending = ''
    const ok = (t = '') => this.#write(socket, `+OK${t ? ` ${t}` : ''}\r\n`)
    const err = t => this.#write(socket, `-ERR ${t}\r\n`)
    const msg = n => (drop && n >= 1 && n <= drop.length && !deleted.has(n) ? drop[n - 1] : null)
    this.#write(socket, '+OK fake POP3 ready\r\n')
    socket.on('data', chunk => {
      pending += chunk.toString('latin1')
      let i
      while ((i = pending.indexOf('\r\n')) >= 0) {
        const line = pending.slice(0, i)
        pending = pending.slice(i + 2)
        const [cmd, ...args] = line.split(' ')
        const c = cmd.toUpperCase()
        this.log.push(c === 'PASS' ? 'PASS ***' : line)
        if (c === 'CAPA') {
          this.#write(socket, `+OK\r\nUSER\r\n${this.supportsUidl ? 'UIDL\r\n' : ''}.\r\n`)
        } else if (c === 'USER') {
          user = args.join(' ')
          ok()
        } else if (c === 'PASS') {
          this.loginAttempts++
          if (this.passReply) this.#write(socket, `${this.passReply}\r\n`)
          else if (user === this.user && args.join(' ') === this.pass && !this.rejectLogin) {
            authed = true
            drop = [...this.messages]
            ok('logged in')
          } else err('[AUTH] invalid user name or password')
        } else if (c === 'QUIT') {
          if (authed) {
            const gone = new Set([...deleted].map(n => drop[n - 1]))
            this.messages = this.messages.filter(m => !gone.has(m))
          }
          ok('bye')
          socket.end()
        } else if (!authed) {
          err('not logged in')
        } else if (c === 'STAT') {
          const live = drop.filter((_, k) => !deleted.has(k + 1))
          ok(`${live.length} ${live.reduce((a, m) => a + m.source.length, 0)}`)
        } else if (c === 'UIDL') {
          if (!this.supportsUidl) {
            err('command not supported')
            continue
          }
          const lines = drop.map((m, k) => (deleted.has(k + 1) ? null : `${k + 1} ${m.uidl}`)).filter(Boolean)
          this.#write(socket, `+OK\r\n${lines.map(l => `${l}\r\n`).join('')}.\r\n`)
        } else if (c === 'RETR') {
          const m = msg(Number(args[0]))
          if (!m) {
            err('no such message')
            continue
          }
          if (this.refuseRetr.has(m.uidl) || this.refuseRetr.has(m)) {
            err(`message ${args[0]} is corrupted`)
            continue
          }
          // byte-stuffing: a line starting with "." gets one more
          const text = m.source.toString('latin1').replace(/\r?\n/g, '\r\n')
          const body = text.split('\r\n').map(l => (l.startsWith('.') ? `.${l}` : l))
          if (body[body.length - 1] === '') body.pop()
          const answer = Buffer.from(`+OK ${m.source.length} octets\r\n${body.join('\r\n')}\r\n.\r\n`, 'latin1')
          if (this.retrPieces) {
            const pieces = this.retrPieces(answer)
            ;(async () => {
              for (const p of pieces) {
                if (socket.destroyed) return
                socket.write(p)
                await new Promise(r => setTimeout(r, 30))
              }
            })()
          } else this.#write(socket, answer)
        } else if (c === 'DELE') {
          const n = Number(args[0])
          if (!msg(n)) err('no such message')
          else {
            deleted.add(n)
            ok('deleted')
          }
        } else if (c === 'RSET') {
          deleted.clear()
          ok()
        } else if (c === 'NOOP') {
          ok()
        } else {
          err('unknown command')
        }
      }
    })
  }
}
