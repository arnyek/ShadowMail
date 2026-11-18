// sendRaw against a real smtp-server: `afterData` on the error tells whether the whole message had been handed over
// (after the server's 354) when the send failed. Before DATA (refused login, refused recipient, refused DATA, nothing
// listening) it is not set: a retry cannot make a second copy. After the message (no final answer in time, the
// connection dropped after the data) it is set: the server may have taken it. A good send is byte for byte the message.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { SMTPServer } from 'smtp-server'
import { sendRaw } from '../core/smtp/send.js'

const RAW = Buffer.from('From: a@example.invalid\r\nTo: b@example.invalid\r\nSubject: x\r\nMessage-ID: <x@example.invalid>\r\n\r\n' + 'sor\r\n'.repeat(20000))

async function server(t, opts = {}) {
  const got = []
  const srv = new SMTPServer({
    disabledCommands: ['STARTTLS'], allowInsecureAuth: true, authMethods: ['PLAIN', 'LOGIN'], logger: false,
    onAuth: opts.onAuth || ((a, _s, cb) => cb(null, { user: a.username })),
    onRcptTo: opts.onRcptTo || ((_a, _s, cb) => cb()),
    onData(stream, session, cb) {
      const chunks = []
      stream.on('data', c => chunks.push(c))
      stream.on('end', () => {
        got.push(Buffer.concat(chunks))
        if (opts.onDataEnd) return opts.onDataEnd(session, cb)
        cb()
      })
    },
  })
  srv.on('error', () => {})
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  t.after(() => new Promise(r => srv.close(r)))
  return { port: srv.server.address().port, got, srv }
}

const account = port => ({ smtp_host: '127.0.0.1', smtp_port: port, smtp_security: 'none', smtp_user: 'u', tls_verify: 1 })
const send = (port, timeoutMs = 2000) => sendRaw({ account: account(port), password: 'p', envelope: { from: 'a@example.invalid', to: ['b@example.invalid'] }, raw: RAW, timeoutMs })

test('a good send: the server gets the message byte for byte', async t => {
  const s = await server(t)
  const r = await send(s.port)
  assert.deepEqual(r.accepted, ['b@example.invalid'])
  assert.equal(s.got.length, 1)
  assert.ok(s.got[0].equals(RAW), 'byte for byte')
})

test('errors before the message: no afterData (refused login, refused recipient, refused at the end of DATA is after)', async t => {
  const login = await server(t, { onAuth: (_a, _s, cb) => cb(new Error('nope')) })
  const e1 = await send(login.port).catch(e => e)
  assert.ok(e1 instanceof Error)
  assert.equal(e1.afterData, undefined, 'refused login')
  const rcpt = await server(t, { onRcptTo: (_a, _s, cb) => cb(Object.assign(new Error('no such user'), { responseCode: 550 })) })
  const e2 = await send(rcpt.port).catch(e => e)
  assert.ok(e2 instanceof Error)
  assert.equal(e2.afterData, undefined, 'refused recipient')
  assert.equal(rcpt.got.length, 0)
  // nothing listening
  const free = net.createServer()
  await new Promise(r => free.listen(0, '127.0.0.1', r))
  const port = free.address().port
  await new Promise(r => free.close(r))
  const e3 = await send(port).catch(e => e)
  assert.ok(e3 instanceof Error)
  assert.equal(e3.afterData, undefined, 'nothing listening')
})

test('after the whole message: no final answer in time, or the connection dropped -> afterData', async t => {
  const hang = await server(t, { onDataEnd: () => {} }) // the message taken, never answered
  const started = Date.now()
  const e1 = await send(hang.port, 1500).catch(e => e)
  assert.ok(e1 instanceof Error)
  assert.equal(e1.afterData, true, `no final answer (${e1.code})`)
  assert.equal(hang.got.length, 1, 'the server has the whole message')
  assert.ok(Date.now() - started < 10_000)
  const drop = await server(t, { onDataEnd: session => setImmediate(() => drop.srv.connections && [...drop.srv.connections].forEach(c => c._socket.destroy())) })
  const e2 = await send(drop.port).catch(e => e)
  assert.ok(e2 instanceof Error)
  assert.equal(e2.afterData, true, `dropped after the data (${e2.code})`)
  // a 5xx answer to the message itself: also after the data (the server says no, but a retry is still not automatic)
  const no = await server(t, { onDataEnd: (_s, cb) => cb(Object.assign(new Error('rejected'), { responseCode: 554 })) })
  const e3 = await send(no.port).catch(e => e)
  assert.ok(e3 instanceof Error)
  assert.equal(e3.afterData, true)
})
