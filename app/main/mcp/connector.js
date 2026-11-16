// SPDX-License-Identifier: GPL-3.0-or-later
// MCP: the `ShadowMail.exe --mcp` connector. Claude starts it as a stdio
// server; it forwards newline-delimited JSON-RPC between stdio and the running app's pipe
// (data/mcp/endpoint.json). It knows nothing itself: no endpoint, a refused or dropped connection = every
// request gets an error with a Hungarian text (the app is not running, locked, or Claude access is off).
// Measured (Windows): process.stdin is a stub in the Electron GUI process, so the caller passes fd 0
// read directly as `input`, and `write` is fs.writeSync(1, ...).
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import { endpointFile, helloBytes, tooManyBytes, TOO_MANY } from './server.js'

export const UNAVAILABLE = -32000
export const HELLO_TIMEOUT_MS = 2000

/**
 * @param input  readable stream (the connector's stdin)
 * @param write  (text) => void, synchronous to stdout
 * @param onEnd  the input ended: the connector quits
 * @param text   the error message of an unreachable app (hu.js); tooManyText: the app has its 2 connections
 */
export function runConnector({ dataDir, input, write, onEnd, text, tooManyText = text, log = () => {}, connect = net.connect, helloTimeoutMs = HELLO_TIMEOUT_MS }) {
  let socket = null
  let pending = new Set() // ids sent to the app, not answered yet
  let queue = Promise.resolve()
  let buffer = ''
  let ended = false

  // stdout gone (Claude quit, EPIPE): the connector has no one to answer, it quits
  const out = line => {
    try {
      write(line)
    } catch {
      finish('stdout closed')
    }
  }
  const send = message => out(`${JSON.stringify(message)}\n`)
  const unavailable = (id, reason = null) => send({ jsonrpc: '2.0', id, error: { code: UNAVAILABLE, message: reason === TOO_MANY ? tooManyText : text } })

  const dropped = reason => {
    socket = null
    for (const id of pending) unavailable(id, reason)
    pending = new Set()
  }

  // a fresh endpoint every time there is no connection: the app may have been unlocked again (new key). The
  // connection counts only once the app proved itself: it signed our nonce with the private
  // key of THIS start. Anything else (a squatter behind a stale endpoint.json, a timeout, a close) = not
  // reachable, and nothing it said is ever forwarded. Resolves { socket, rest } | { refused } | null.
  const open = () =>
    new Promise(resolve => {
      let endpoint
      let verifyKey
      try {
        endpoint = JSON.parse(fs.readFileSync(endpointFile(dataDir), 'utf8'))
        if (!endpoint || typeof endpoint.pipe !== 'string' || typeof endpoint.key !== 'string' || typeof endpoint.sign !== 'string') return resolve(null)
        verifyKey = crypto.createPublicKey({ key: Buffer.from(endpoint.sign, 'base64'), format: 'der', type: 'spki' })
      } catch {
        return resolve(null)
      }
      const nonce = crypto.randomBytes(32)
      const s = connect(endpoint.pipe)
      let buf = ''
      let settled = false
      const settle = value => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        s.removeListener('data', onData)
        if (!value || !value.socket) s.destroy()
        resolve(value)
      }
      const timer = setTimeout(() => settle(null), helloTimeoutMs)
      const onData = chunk => {
        buf += chunk
        const i = buf.indexOf('\n')
        if (i < 0) {
          if (buf.length > 4096) settle(null)
          return
        }
        let m = null
        try {
          m = JSON.parse(buf.slice(0, i))
        } catch {
          // not ours
        }
        // "too many" counts only signed by the app (the same key as the hello); unsigned it is a stranger's line
        if (m && m.shadowmail === TOO_MANY) {
          let real = false
          try {
            real = typeof m.sig === 'string' && crypto.verify(null, tooManyBytes(nonce, endpoint.pipe), verifyKey, Buffer.from(m.sig, 'base64'))
          } catch {
            real = false
          }
          if (real) return settle({ refused: TOO_MANY })
          log('mcp connector: the endpoint did not prove itself')
          return settle(null)
        }
        let ok = false
        try {
          ok = Boolean(m && m.shadowmail === 'hello' && typeof m.sig === 'string' && crypto.verify(null, helloBytes(nonce, endpoint.pipe), verifyKey, Buffer.from(m.sig, 'base64')))
        } catch {
          ok = false
        }
        if (!ok) {
          log('mcp connector: the endpoint did not prove itself')
          return settle(null)
        }
        settle({ socket: s, rest: buf.slice(i + 1) })
      }
      s.setEncoding('utf8')
      s.on('data', onData)
      s.once('connect', () => s.write(`${JSON.stringify({ key: endpoint.key, nonce: nonce.toString('hex') })}\n`))
      s.on('error', () => settle(null))
      s.once('close', () => settle(null))
    })

  const attach = (s, rest) => {
    let inBuf = ''
    const take = chunk => {
      inBuf += chunk
      let i
      while ((i = inBuf.indexOf('\n')) >= 0) {
        const line = inBuf.slice(0, i)
        inBuf = inBuf.slice(i + 1)
        if (!line.trim()) continue
        let m = null
        try {
          m = JSON.parse(line)
        } catch {
          // forwarded as it came
        }
        if (m && typeof m === 'object' && 'id' in m) pending.delete(m.id)
        out(`${line}\n`)
      }
    }
    s.on('data', take)
    s.on('close', () => {
      if (socket === s) dropped(null)
    })
    s.on('error', () => {})
    if (rest) take(rest)
  }

  const handle = async line => {
    let message
    let parsed = true
    try {
      message = JSON.parse(line)
    } catch {
      parsed = false // the app answers a parse error when it is there; when it is not, the connector does
    }
    const isObject = parsed && message !== null && typeof message === 'object' && !Array.isArray(message)
    const id = isObject && 'id' in message ? message.id : undefined
    let refused = null
    if (!socket) {
      const opened = await open()
      if (opened && opened.socket) {
        socket = opened.socket
        attach(opened.socket, opened.rest)
      } else if (opened && opened.refused) refused = opened.refused
    }
    if (!socket) {
      // the same answers the app gives to these lines (protocol.js), so Claude sees one behaviour
      if (!parsed) send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
      else if (!isObject || typeof message.method !== 'string') send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } })
      else if (id !== undefined) unavailable(id, refused)
      return
    }
    if (id !== undefined) pending.add(id)
    socket.write(`${line}\n`)
  }

  function finish(reason) {
    if (ended) return
    ended = true
    queue.then(() => {
      log(`mcp connector: input ${reason}`)
      if (socket) socket.end()
      onEnd()
    })
  }

  input.setEncoding('utf8')
  input.on('data', chunk => {
    buffer += chunk
    let i
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).replace(/\r$/, '')
      buffer = buffer.slice(i + 1)
      if (line.trim()) queue = queue.then(() => handle(line))
    }
  })
  input.on('end', () => finish('closed'))
  input.on('error', () => finish('failed'))
}
