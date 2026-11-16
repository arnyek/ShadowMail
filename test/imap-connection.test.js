// The interactive IMAP connection over a REAL socket and the real imapflow: when the idle
// connection dies (network change, sleep, a server reset), imapflow emits 'error'. Without a listener
// that was an uncaught exception that took the whole main process down (measured live with the test
// account, a network cut). Now the error is logged, and the next get() connects again.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { ImapConnection, createImapClient } from '../core/imap/client.js'

// The smallest IMAP server imapflow logs in to; it keeps the sockets so the test can reset them.
async function miniImap() {
  const sockets = []
  const server = net.createServer(sock => {
    sockets.push(sock)
    sock.on('error', () => {})
    sock.write('* OK mini ready\r\n')
    let buf = ''
    sock.on('data', d => {
      buf += d
      let i
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const [tag, cmd = ''] = buf.slice(0, i).split(' ')
        buf = buf.slice(i + 2)
        const c = cmd.toUpperCase()
        if (c === 'CAPABILITY') sock.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK done\r\n`)
        else if (c === 'LOGIN') sock.write(`${tag} OK [CAPABILITY IMAP4rev1] logged in\r\n`)
        else if (c === 'LOGOUT') {
          sock.write(`* BYE\r\n${tag} OK bye\r\n`)
          sock.end()
        } else sock.write(`${tag} OK done\r\n`)
      }
    })
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  return { server, sockets, port: server.address().port }
}

test('a reset idle interactive connection: no uncaught exception, logged, the next get() reconnects', async t => {
  const { server, sockets, port } = await miniImap()
  t.after(() => server.close())
  const uncaught = []
  const onUncaught = err => uncaught.push(err)
  // node:test turns an uncaught exception into a failure of some test; catch it here to name it
  process.prependListener('uncaughtException', onUncaught)
  t.after(() => process.removeListener('uncaughtException', onUncaught))

  const account = { in_host: '127.0.0.1', in_port: port, in_security: 'none', in_user: 'u', tls_verify: 1 }
  const errors = []
  let connects = 0
  const ic = new ImapConnection(
    async () => {
      connects++
      const c = createImapClient(account, 'p', { logger: false })
      await c.connect()
      return c
    },
    { onError: err => errors.push(err.code || err.message) },
  )
  const first = await ic.get()
  assert.equal(first.usable, true)
  sockets[0].resetAndDestroy() // RST: the client side sees ECONNRESET
  await new Promise(r => setTimeout(r, 300))
  assert.deepEqual(uncaught.map(e => e.message), [], 'no uncaught exception')
  assert.deepEqual(errors, ['ECONNRESET'])
  assert.equal(ic.client, null, 'the dead client is dropped')
  const second = await ic.get()
  assert.notEqual(second, first)
  assert.equal(second.usable, true)
  assert.equal(connects, 2)
  await ic.close()
})
