// Local fake IMAP / POP3 servers (just enough for a login) and a self-signed certificate, so the
// connection test can be exercised without a network or a real mailbox.
import net from 'node:net'
import tls from 'node:tls'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { onCleanup, tempDir } from './tmp.js'

/** A self-signed certificate for 127.0.0.1/localhost made with openssl, or null when openssl is missing. */
export function selfSignedCert(t) {
  const dir = tempDir(t)
  const key = path.join(dir, 'key.pem')
  const cert = path.join(dir, 'cert.pem')
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1',
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' })
  } catch {
    return null
  }
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) }
}

function listen(t, server) {
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      onCleanup(t, () => new Promise(r => server.close(() => r())))
      resolve(server.address().port)
    })
  })
}

function track(server) {
  const sockets = new Set()
  server.on('connection', s => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  const close = server.close.bind(server)
  server.close = cb => {
    for (const s of sockets) s.destroy()
    return close(cb)
  }
  return server
}

function lines(socket, onLine) {
  let buf = ''
  // no setEncoding: a plain socket may still be wrapped for STLS, which needs raw bytes
  socket.on('data', d => {
    buf += d.toString('utf8')
    let i
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 2)
      onLine(line)
    }
  })
  socket.on('error', () => {})
}

const unquote = s => (s.startsWith('"') ? s.slice(1, -1).replace(/\\(.)/g, '$1') : s)

/** IMAP: greeting, CAPABILITY, LOGIN, LOGOUT; every other command answers OK. */
export async function startImap(t, { user, pass, tlsCert = null }) {
  const handler = socket => {
    socket.write('* OK [CAPABILITY IMAP4rev1] fake IMAP ready\r\n')
    lines(socket, line => {
      const m = /^(\S+) (\S+)(?: (.*))?$/.exec(line)
      if (!m) return
      const [, tag, cmd, rest = ''] = m
      const c = cmd.toUpperCase()
      if (c === 'CAPABILITY') socket.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK done\r\n`)
      else if (c === 'LOGIN') {
        const [u, p] = rest.match(/"(?:[^"\\]|\\.)*"|\S+/g).map(unquote)
        if (u === user && p === pass) socket.write(`${tag} OK [CAPABILITY IMAP4rev1] logged in\r\n`)
        else socket.write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`)
      } else if (c === 'LOGOUT') {
        socket.write(`* BYE bye\r\n${tag} OK logout\r\n`)
        socket.end()
      } else socket.write(`${tag} OK ${c} done\r\n`)
    })
  }
  const server = track(tlsCert ? tls.createServer(tlsCert, handler) : net.createServer(handler))
  return listen(t, server)
}

/** POP3: greeting, CAPA (optionally with STLS), STLS, USER/PASS, QUIT. */
export async function startPop3(t, { user, pass, tlsCert = null, implicitTls = false, offerStls = false, rejectUnknownUser = false }) {
  const handler = socket => {
    let current = socket
    let gotUser = null
    const serve = s => {
      lines(s, line => {
        const [cmd, ...args] = line.split(' ')
        const c = cmd.toUpperCase()
        if (c === 'CAPA') s.write(`+OK\r\nUSER\r\nUIDL\r\n${offerStls && s === socket ? 'STLS\r\n' : ''}.\r\n`)
        else if (c === 'STLS' && offerStls && tlsCert) {
          s.write('+OK begin TLS\r\n')
          s.removeAllListeners('data')
          const secure = new tls.TLSSocket(s, { isServer: true, ...tlsCert })
          current = secure
          serve(secure)
        } else if (c === 'USER') {
          gotUser = args.join(' ')
          // some servers refuse an unknown user right here
          s.write(rejectUnknownUser && gotUser !== user ? '-ERR unknown user\r\n' : '+OK\r\n')
        } else if (c === 'PASS') {
          s.write(gotUser === user && args.join(' ') === pass ? '+OK logged in\r\n' : '-ERR [AUTH] invalid login\r\n')
        } else if (c === 'QUIT') {
          s.write('+OK bye\r\n')
          s.end()
        } else s.write('-ERR unknown\r\n')
      })
    }
    serve(current)
    current.write('+OK fake POP3 ready\r\n')
  }
  const server = track(implicitTls ? tls.createServer(tlsCert, handler) : net.createServer(handler))
  return listen(t, server)
}

/** Accepts the connection and never says a word (greeting timeout). */
export async function startSilent(t) {
  return listen(t, track(net.createServer(() => {})))
}

/** A port on 127.0.0.1 with nothing listening (connection refused). */
export async function closedPort() {
  const s = net.createServer()
  await new Promise(r => s.listen(0, '127.0.0.1', r))
  const { port } = s.address()
  await new Promise(r => s.close(r))
  return port
}
