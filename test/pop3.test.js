// the POP3 client against a real TCP fake server started in the test, and the POP3 download
// (Pop3Fetcher, SyncManager): incremental by UIDL, every message whole into data/store, the body limit
// from the Date header, re-indexing from data/store without network, delete-after-N-days, login safety.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { isFatalSyncError } from '../core/imap/sync.js'
import { Pop3Client, splitChunk } from '../core/pop3/client.js'
import { Pop3Fetcher, pop3StorePath, pop3MessageAge, POP3_LOCAL_FOLDERS } from '../core/pop3/fetcher.js'
import { classifyError } from '../core/accounts/probe.js'
import { SyncManager } from '../app/main/sync-manager.js'
import { MessageReader } from '../app/main/reader.js'
import { FakePop3Server } from './helpers/fake-pop3.js'
import { memoryIndex, addAccount, DAY, sealedStore } from './helpers/fixtures.js'
import { onCleanup, tempDir } from './helpers/tmp.js'

const NOW = Date.UTC(2026, 10, 12, 9, 0, 0)

// Measured on the owner's Windows machine: ESET's mail protection proxies POP3 even on
// 127.0.0.1 and adds an "X-EsetId:" header to every retrieved message. Byte comparisons ignore that
// one header line (and only that); everything else must still match byte for byte.
const AV_HEADER = /^X-EsetId: [^\r\n]*\r\n/m
function withoutAvHeader(buf) {
  const s = buf.toString('latin1')
  const end = s.indexOf('\r\n\r\n')
  const head = end < 0 ? s : s.slice(0, end + 2)
  return Buffer.from(head.replace(AV_HEADER, '') + (end < 0 ? '' : s.slice(end + 2)), 'latin1')
}
const sameMessage = (a, b) => withoutAvHeader(a).equals(withoutAvHeader(b))
const sleep = ms => new Promise(r => setTimeout(r, ms))

function eml({ subject, body, date = new Date(NOW - DAY).toUTCString(), id = Math.random().toString(36).slice(2), extra = '' }) {
  const head = [`From: Feladó Ferenc <ferenc@example.invalid>`, 'To: teszt@example.invalid', `Subject: ${subject}`]
  if (date) head.push(`Date: ${date}`)
  head.push(`Message-ID: <${id}@example.invalid>`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit')
  return Buffer.from(`${head.join('\r\n')}${extra}\r\n\r\n${body}\r\n`, 'utf8')
}

async function startServer(t, opts) {
  const server = await new FakePop3Server(opts).listen()
  onCleanup(t, () => server.close())
  return server
}

async function login(server, pass = server.pass) {
  const c = new Pop3Client({ host: '127.0.0.1', port: server.port, security: 'none', timeoutMs: 5000 })
  await c.connect()
  await c.login(server.user, pass)
  return c
}

test('client: login, STAT, UIDL, RETR byte-exact with dot-stuffed lines, split across packets', async t => {
  const server = await startServer(t)
  const tricky = Buffer.from(
    ['Subject: pontok', '', '.egy pont az elején', '..két pont', '.', ' .', 'utolsó sor ékezettel: árvíztűrő', ''].join('\r\n'),
    'utf8',
  )
  const u1 = server.add(eml({ subject: 'első', body: 'egy' }))
  const u2 = server.add(tricky)
  const c = await login(server)
  assert.deepEqual(await c.stat(), { count: 2, size: server.messages[0].source.length + tricky.length })
  assert.deepEqual(await c.uidl(), [{ n: 1, uidl: u1 }, { n: 2, uidl: u2 }])
  const got = await c.retr(2)
  assert.ok(sameMessage(got, tricky), JSON.stringify(got.toString('utf8')))
  await c.quit()
})

test('client: a 3 MB message arrives whole and fast enough (linear reader)', async t => {
  const server = await startServer(t, { chunk: 400 })
  const line = `${'x'.repeat(70)}\r\n`
  const big = Buffer.concat([Buffer.from('Subject: nagy\r\n\r\n'), Buffer.from(line.repeat(Math.ceil(3_000_000 / line.length)))])
  server.add(big)
  const c = await login(server)
  const t0 = performance.now()
  const got = await c.retr(1)
  const ms = performance.now() - t0
  await c.quit()
  assert.ok(sameMessage(got, big))
  assert.ok(ms < 5000, `${Math.round(ms)} ms`)
})

test('client: a wrong password is an authentication error, the password is not in the message', async t => {
  const server = await startServer(t)
  await assert.rejects(login(server, 'rossz-jelszo-123'), err => {
    assert.equal(err.authenticationFailed, true)
    assert.equal(classifyError(err), 'auth_failed')
    assert.doesNotMatch(err.message, /rossz-jelszo-123/)
    return true
  })
  assert.equal(server.loginAttempts, 1)
  assert.ok(server.log.includes('PASS ***'))
})

test('client: DELE takes effect only with QUIT; a dropped connection deletes nothing; no UIDL is reported', async t => {
  const server = await startServer(t)
  server.add(eml({ subject: 'a', body: 'a' }))
  server.add(eml({ subject: 'b', body: 'b' }))
  let c = await login(server)
  await c.dele(1)
  c.close() // no QUIT
  await sleep(50)
  assert.equal(server.messages.length, 2)
  c = await login(server)
  await c.dele(1)
  await c.quit()
  await sleep(50)
  assert.deepEqual(server.messages.map(m => m.source.toString().match(/Subject: (\w)/)[1]), ['b'])

  const noUidl = await startServer(t, { uidl: false })
  const d = await login(noUidl)
  await assert.rejects(d.uidl(), { code: 'UIDL_UNSUPPORTED' })
  await d.quit()
})

function setupFetcher(t, server, account = {}, { connect = null } = {}) {
  const { db, index } = memoryIndex(t)
  const row = addAccount(db, { type: 'pop3', in_port: server.port, in_host: '127.0.0.1', in_security: 'none', in_user: server.user, ...account })
  const storeDir = path.join(tempDir(t), 'store')
  const clock = { now: NOW }
  const states = []
  const changes = []
  const getRow = () => db.prepare('SELECT * FROM accounts WHERE id = ?').get(row.id)
  const fetcher = new Pop3Fetcher({
    account: row,
    loadAccount: getRow,
    index,
    sealed: sealedStore(storeDir),
    connect: connect ? () => connect(getRow()) : () => login(server),
    now: () => clock.now,
    onState: s => states.push(s),
    onChange: c => changes.push(c),
  })
  onCleanup(t, () => fetcher.stop())
  const list = () => index.listFolder({ accountId: row.id, folder: 'INBOX', limit: 500 })
  const setAccount = patch => {
    for (const [k, v] of Object.entries(patch)) db.prepare(`UPDATE accounts SET ${k} = ? WHERE id = ?`).run(v, row.id)
  }
  return { db, index, row, storeDir, clock, fetcher, list, states, changes, setAccount, getRow }
}

const retrCount = server => server.log.filter(l => l.startsWith('RETR')).length

test('fetcher: local folders, every message whole into data/store, the second run downloads only the new UIDLs', async t => {
  const server = await startServer(t)
  server.add(eml({ subject: 'Első levél', body: 'Szöveg egy' }))
  server.add(eml({ subject: 'Második levél', body: 'Szöveg kettő' }))
  const { index, row, storeDir, fetcher, list, changes } = setupFetcher(t, server)
  await fetcher.run()
  const folders = index.folders(row.id)
  assert.deepEqual(folders.map(f => [f.path, f.special_use, f.is_local]).sort(), POP3_LOCAL_FOLDERS.map(f => [f.path, f.specialUse, 1]).sort())
  assert.deepEqual(list().map(m => m.subject).sort(), ['Első levél', 'Második levél'])
  for (const m of list()) {
    const full = index.get(m.id)
    assert.equal(full.uid, null)
    assert.equal(full.store_path, pop3StorePath(row.id, full.pop3_uidl))
    assert.ok(sameMessage(sealedStore(storeDir).read(full.store_path), server.messages.find(s => s.uidl === full.pop3_uidl).source))
    assert.equal(full.body_state, 1)
  }
  assert.equal(index.search({ accountId: row.id, query: 'kettő' }).length, 1)
  assert.equal(retrCount(server), 2)
  assert.ok(changes.some(c => c.folders.includes('INBOX')))

  server.add(eml({ subject: 'Harmadik levél', body: 'Szöveg három' }))
  await fetcher.run()
  assert.equal(retrCount(server), 3, 'only the new one was downloaded')
  assert.equal(list().length, 3)
  await fetcher.run()
  assert.equal(retrCount(server), 3)
  assert.equal(server.messages.length, 3, '"never": everything stays on the server')
})

test('fetcher: 1-year limit: a 2-year-old message is downloaded and listed, its text is not searchable, its subject is; "all" re-indexes from data/store with the server down', async t => {
  const server = await startServer(t)
  server.add(eml({ subject: 'Régi tárgy', body: 'Ritkaszó-zuzmókalap a régi szövegben', date: new Date(NOW - 2 * 365 * DAY).toUTCString() }))
  server.add(eml({ subject: 'Dátum nélkül', body: 'Ritkaszó-csillagpor dátum nélkül', date: null }))
  server.add(eml({ subject: 'Jövőbeli', body: 'jövő', date: new Date(NOW + 30 * DAY).toUTCString() }))
  const { index, row, fetcher, list, setAccount, clock } = setupFetcher(t, server, { body_index_days: 365 })
  await fetcher.run()
  assert.equal(list().length, 3)
  const old = index.search({ accountId: row.id, query: 'Régi tárgy' })
  assert.equal(old.length, 1, 'the subject is found')
  assert.equal(old[0].body_state, 3)
  assert.equal(index.search({ accountId: row.id, query: 'zuzmokalap' }).length, 0, 'the text is not')
  const undated = index.search({ accountId: row.id, query: 'csillagpor' })
  assert.equal(undated.length, 1, 'no Date header: age = download time, inside the limit')
  assert.equal(undated[0].idate, clock.now)
  assert.equal(index.search({ accountId: row.id, query: 'Jövőbeli' })[0].idate, clock.now, 'a Date in the future counts as the download time')

  await server.close()
  setAccount({ body_index_days: 0 })
  await assert.rejects(fetcher.run(), err => classifyError(err) === 'connection_refused')
  assert.equal(index.search({ accountId: row.id, query: 'zuzmokalap' }).length, 1, 're-indexed from data/store without the server')
})

test('fetcher: "delete after N days": N = 0 deletes after download, kept locally; N = 3 waits three days', async t => {
  const server = await startServer(t)
  server.add(eml({ subject: 'Törlendő', body: 'egy' }))
  const { index, row, fetcher, list, setAccount, clock } = setupFetcher(t, server, { pop3_delete_after_days: 0 })
  await fetcher.run()
  assert.equal(server.messages.length, 0, 'deleted from the server')
  assert.equal(list().length, 1, 'still here')
  const seen = index.pop3Seen(row.id)
  assert.equal([...seen.values()][0].deleted_on_server_at, clock.now)

  setAccount({ pop3_delete_after_days: 3 })
  server.add(eml({ subject: 'Három napig marad', body: 'kettő' }))
  await fetcher.run()
  assert.equal(server.messages.length, 1)
  clock.now += 2 * DAY
  await fetcher.run()
  assert.equal(server.messages.length, 1, 'two days: still there')
  clock.now += 1 * DAY + 1000
  await fetcher.run()
  assert.equal(server.messages.length, 0, 'three days: deleted')
  assert.equal(list().length, 2)
  assert.equal(retrCount(server), 2, 'nothing downloaded twice')
})

test('fetcher: a message whose file vanished is never deleted from the server', async t => {
  const server = await startServer(t)
  server.add(eml({ subject: 'Fájl nélkül', body: 'x' }))
  const { index, storeDir, fetcher, setAccount, list } = setupFetcher(t, server)
  await fetcher.run()
  fs.rmSync(path.join(storeDir, index.get(list()[0].id).store_path))
  setAccount({ pop3_delete_after_days: 0 })
  await fetcher.run()
  assert.equal(server.messages.length, 1)
})

test('manager: a POP3 account is polled; a wrong password is tried once and never again on its own', async t => {
  const server = await startServer(t)
  server.add(eml({ subject: 'Ütemezett', body: 'x' }))
  const { db, index } = memoryIndex(t)
  const row = addAccount(db, { type: 'pop3', in_port: server.port, in_host: '127.0.0.1', in_security: 'none', in_user: server.user })
  const storeDir = path.join(tempDir(t), 'store')
  let pass = server.pass
  const store = {
    list: () => db.prepare('SELECT * FROM accounts ORDER BY id').all(),
    getRow: id => db.prepare('SELECT * FROM accounts WHERE id = ?').get(id),
    passwordsFor: () => ({ incoming: pass }),
  }
  const manager = new SyncManager({ store, index, sealed: sealedStore(storeDir), now: () => NOW, throttleMs: 5, syncerOptions: { retryDelaysMs: [20, 20] } })
  onCleanup(t, () => manager.stopAll())
  manager.startAll()
  for (let i = 0; i < 200 && !index.listFolder({ accountId: row.id, folder: 'INBOX' }).length; i++) await sleep(10)
  assert.equal(index.listFolder({ accountId: row.id, folder: 'INBOX' })[0].subject, 'Ütemezett')
  assert.equal(manager.status()[0].live, false, 'no IDLE for POP3')
  await assert.rejects(manager.withConnection(row.id, async () => {}), { code: 'pop3_local' })

  await manager.stopAll()
  pass = 'rossz-jelszo-123'
  const before = server.loginAttempts
  manager.startAll()
  for (let i = 0; i < 200 && !manager.status()[0]?.stopped; i++) await sleep(10)
  await sleep(150)
  assert.equal(server.loginAttempts, before + 1, 'one attempt, no retry')
  assert.equal(manager.status()[0].errorCode, 'auth_failed')
  assert.equal(manager.status()[0].stopped, true)
})

test('reader: a POP3 message opens from data/store without any connection, read flag set locally', async t => {
  const server = await startServer(t)
  server.add(eml({ subject: 'Olvasandó', body: 'Helyben olvasható szöveg' }))
  const { index, storeDir, fetcher, list } = setupFetcher(t, server)
  await fetcher.run()
  await server.close()
  const reader = new MessageReader({ index, sealed: sealedStore(storeDir), withConnection: () => assert.fail('no connection for POP3') })
  const id = list()[0].id
  const m = await reader.open(id)
  assert.equal(m.subject, 'Olvasandó')
  assert.match(m.text, /Helyben olvasható/)
  assert.equal(m.seenError, null)
  assert.equal(index.get(id).flags, '\\Seen')
})

test('the AV-header allowance removes exactly one X-EsetId header line, nothing in the body', () => {
  const orig = Buffer.from('Subject: a\r\n\r\nX-EsetId: in the body stays\r\n')
  const proxied = Buffer.from('Subject: a\r\nX-EsetId: 37303A29F79D4052667067\r\n\r\nX-EsetId: in the body stays\r\n')
  assert.ok(sameMessage(proxied, orig))
  assert.ok(!sameMessage(Buffer.from('Subject: b\r\n\r\nX-EsetId: in the body stays\r\n'), orig))
  assert.ok(!sameMessage(Buffer.from('Subject: a\r\n\r\n'), orig), 'a body line is never dropped')
})

test('message age: Date header, or the download time when missing, unreadable or in the future', () => {
  assert.equal(pop3MessageAge(1000, 5000), 1000)
  assert.equal(pop3MessageAge(null, 5000), 5000)
  assert.equal(pop3MessageAge(NaN, 5000), 5000)
  assert.equal(pop3MessageAge(6000, 5000), 5000)
})

// ---- busy mailboxes, doubled UIDLs, stops and power cuts ----

test('fetcher: another server/user -> the old UIDLs mean nothing: every message of the new mailbox is downloaded before any DELE', async t => {
  const a = await startServer(t)
  a.add(eml({ subject: 'Régi egy', body: '1' }), 'u1')
  a.add(eml({ subject: 'Régi kettő', body: '2' }), 'u2')
  const b = await startServer(t)
  // connects wherever the account row points, like the app
  const { fetcher, list, setAccount } = setupFetcher(t, a, {}, { connect: row => login(row.in_port === b.port ? b : a) })
  await fetcher.run()
  for (const [k, u] of [[1, 'u1'], [2, 'u2'], [3, 'u3']]) b.add(eml({ subject: `Új ${k}`, body: `új ${k}` }), u)
  setAccount({ in_port: b.port, pop3_delete_after_days: 0 }) // the same user name on another server
  await fetcher.run()
  assert.deepEqual(list().map(r => r.subject).sort(), ['Régi egy', 'Régi kettő', 'Új 1', 'Új 2', 'Új 3'])
  // same host and user, another port: one message we had is downloaded again to compare
  assert.equal(retrCount(b), 4, 'one comparison + all three new messages downloaded')
  assert.equal(b.messages.length, 0, 'deleted only after the download (N = 0)')
})

test('fetcher: a message the server refuses (-ERR on RETR) is skipped, the others come, it is retried next time', async t => {
  const server = await startServer(t)
  for (let i = 1; i <= 5; i++) server.add(eml({ subject: `L${i}`, body: `${i}` }), `r${i}`)
  server.refuseRetr.add('r4')
  const { fetcher, list, states } = setupFetcher(t, server)
  await fetcher.run()
  assert.equal(list().length, 4)
  assert.equal(states.at(-1).errorCode, 'partial')
  assert.ok(states.at(-1).lastFinished, 'the run finished')
  server.refuseRetr.clear()
  await fetcher.run()
  assert.equal(list().length, 5)
  assert.equal(fetcher.state.errorCode, null)
})

test('client: a server that says +OK to STLS and then stays silent times out', async t => {
  const silent = net.createServer(s => {
    s.on('error', () => {})
    s.write('+OK ready\r\n')
    s.on('data', d => {
      const line = d.toString()
      if (/^CAPA/i.test(line)) s.write('+OK\r\nSTLS\r\nUSER\r\n.\r\n')
      else if (/^STLS/i.test(line)) s.write('+OK begin TLS\r\n') // ... and nothing more
    })
  })
  await new Promise(r => silent.listen(0, '127.0.0.1', r))
  t.after(() => silent.close())
  const c = new Pop3Client({ host: '127.0.0.1', port: silent.address().port, security: 'starttls', timeoutMs: 300 })
  const t0 = performance.now()
  await assert.rejects(c.connect(), err => err.code === 'ETIMEDOUT')
  assert.ok(performance.now() - t0 < 3000)
  c.close()
})

test('client: [IN-USE] / [SYS/TEMP] on PASS is a busy mailbox, not a wrong password', async t => {
  const server = await startServer(t)
  server.passReply = '-ERR [IN-USE] mailbox locked by another session'
  const c = new Pop3Client({ host: '127.0.0.1', port: server.port, security: 'none' })
  await c.connect()
  await assert.rejects(c.login(server.user, server.pass), err => err.code === 'POP3_IN_USE' && classifyError(err) === 'mailbox_in_use' && !isFatalSyncError(classifyError(err)))
  c.close()
  server.passReply = '-ERR [SYS/TEMP] try later'
  const d = new Pop3Client({ host: '127.0.0.1', port: server.port, security: 'none' })
  await d.connect()
  await assert.rejects(d.login(server.user, server.pass), err => classifyError(err) === 'mailbox_in_use')
  d.close()
})

test('fetcher: a message deleted here for good is deleted on the server too after N days', async t => {
  const server = await startServer(t)
  server.add(eml({ subject: 'Levélszemét', body: 'x' }), 'spam-1')
  const { index, fetcher, list, setAccount, clock } = setupFetcher(t, server)
  await fetcher.run()
  index.deleteIds([list()[0].id]) // the user's permanent delete
  setAccount({ pop3_delete_after_days: 3 })
  clock.now += 10 * DAY
  await fetcher.run()
  assert.equal(server.messages.length, 0, 'gone from the server')
  assert.equal(retrCount(server), 1, 'never downloaded again')
})

test('fetcher: a UIDL listed twice (server bug): one copy is kept, neither is deleted on the server, no file is overwritten', async t => {
  const server = await startServer(t)
  server.add(eml({ subject: 'Régebbi', body: 'regebbi-tartalom' }), 'dup')
  server.add(eml({ subject: 'Újabb', body: 'ujabb-tartalom' }), 'dup')
  const { index, storeDir, fetcher, list } = setupFetcher(t, server, { pop3_delete_after_days: 0 })
  await fetcher.run()
  assert.equal(list().length, 1)
  assert.equal(server.messages.length, 2, 'nothing deleted')
  const row = index.get(list()[0].id)
  const want = row.subject === 'Újabb' ? 'ujabb-tartalom' : 'regebbi-tartalom'
  assert.ok(sealedStore(storeDir).read(row.store_path).toString('latin1').includes(want), 'the file holds the listed message')
})

test('client: a 4 MB single line arrives in small packets in linear time', async t => {
  const server = await startServer(t) // packets of at most chunk * 50 bytes
  const long = 'x'.repeat(4 * 1024 * 1024)
  server.add(`Subject: hosszu\r\n\r\n${long}\r\nvege\r\n`, 'long')
  const c = await login(server)
  const t0 = performance.now()
  const src = await c.retr(1)
  const ms = performance.now() - t0
  await c.quit()
  assert.ok(src.toString('latin1').includes(`${long}\r\nvege`))
  assert.ok(ms < 2000, `${Math.round(ms)} ms`)
})

// --- mailbox identity, doubled UIDLs, durable deletes ---

test('fetcher: a host typo that never connects resets nothing; the corrected host downloads nothing again, a message deleted here stays deleted', async t => {
  const server = await startServer(t)
  for (const k of [1, 2, 3]) server.add(eml({ subject: `M${k}`, body: `${k}` }), `m${k}`)
  const refused = () => Promise.reject(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))
  const { index, row, fetcher, list, setAccount } = setupFetcher(t, server, {}, { connect: r => (r.in_host === '127.0.0.1' ? login(server) : refused()) })
  await fetcher.run()
  index.deleteIds([list().find(m => m.subject === 'M2').id]) // permanent delete here
  setAccount({ in_host: '127.0.0.l' })
  await fetcher.run().catch(() => {})
  assert.equal(index.pop3Seen(row.id).size, 3, 'a failed run resets nothing')
  setAccount({ in_host: '127.0.0.1' })
  await fetcher.run()
  assert.deepEqual(list().map(m => m.subject).sort(), ['M1', 'M3'])
  assert.equal(retrCount(server), 3, 'nothing downloaded again')
})

test('fetcher: the same mailbox on another port (110/STLS <-> 995/TLS) or with the user name in another case keeps its record', async t => {
  const a = await startServer(t)
  for (const k of [1, 2, 3]) a.add(eml({ subject: `P${k}`, body: `${k}` }), `p${k}`)
  const b = await startServer(t)
  b.messages = a.messages // one mailbox, two ports
  const { index, fetcher, list, setAccount } = setupFetcher(t, a, {}, { connect: r => login(r.in_port === b.port ? b : a) })
  await fetcher.run()
  index.deleteIds([list().find(m => m.subject === 'P2').id])
  setAccount({ in_port: b.port })
  await fetcher.run()
  assert.deepEqual(list().map(m => m.subject).sort(), ['P1', 'P3'], 'no second copy, the deleted one stays deleted')
  assert.ok(retrCount(b) <= 2, 'only the comparison downloads')
  setAccount({ in_user: a.user.toUpperCase() }) // the fake server is reached anyway
  await fetcher.run()
  assert.deepEqual(list().map(m => m.subject).sort(), ['P1', 'P3'])
  // a later run on the same identity compares nothing
  const before = retrCount(b)
  await fetcher.run()
  assert.equal(retrCount(b), before)
})

test('fetcher: the same mailbox under another server name (127.0.0.1 -> localhost) keeps its record, a message deleted here stays deleted (744)', async t => {
  const a = await startServer(t)
  for (const k of [1, 2, 3]) a.add(eml({ subject: `D${k}`, body: `${k}` }), `d${k}`)
  const { index, fetcher, list, setAccount } = setupFetcher(t, a)
  await fetcher.run()
  const first = retrCount(a)
  index.deleteIds([list().find(m => m.subject === 'D2').id])
  setAccount({ in_host: 'localhost' }) // the fake server is reached anyway: one mailbox, two names
  await fetcher.run()
  assert.deepEqual(list().map(m => m.subject).sort(), ['D1', 'D3'], 'no second copy, the deleted one stays deleted')
  assert.ok(retrCount(a) - first <= 2, 'only the comparison downloads')
  const before = retrCount(a)
  await fetcher.run()
  assert.equal(retrCount(a), before, 'the new name is recorded: the next run compares nothing')
})

test('fetcher: another server name, the same user, ANOTHER mailbox with the same UIDLs: a reset, every message downloaded before any DELE (744)', async t => {
  const a = await startServer(t)
  a.add(eml({ subject: 'Régi egy', body: '1' }), 'u1')
  a.add(eml({ subject: 'Régi kettő', body: '2' }), 'u2')
  const b = await startServer(t)
  const { fetcher, list, setAccount } = setupFetcher(t, a, {}, { connect: r => login(r.in_host === 'localhost' ? b : a) })
  await fetcher.run()
  b.add(eml({ subject: 'Más egy', body: 'x1' }), 'u1')
  b.add(eml({ subject: 'Más kettő', body: 'x2' }), 'u2')
  setAccount({ in_host: 'localhost', pop3_delete_after_days: 0 })
  await fetcher.run()
  assert.deepEqual(list().map(r => r.subject).sort(), ['Más egy', 'Más kettő', 'Régi egy', 'Régi kettő'])
  assert.equal(b.messages.length, 0, 'deleted only after the download (N = 0)')
})

test('fetcher: another user name is another mailbox: a reset without any comparison download (744)', async t => {
  const a = await startServer(t)
  a.add(eml({ subject: 'A egy', body: '1' }), 'u1')
  const b = await startServer(t, { user: 'masik' })
  const { fetcher, list, setAccount } = setupFetcher(t, a, {}, { connect: r => login(r.in_user === 'masik' ? b : a) })
  await fetcher.run()
  b.add(eml({ subject: 'B egy', body: '1b' }), 'u1')
  setAccount({ in_host: 'localhost', in_user: 'masik' })
  await fetcher.run()
  assert.deepEqual(list().map(r => r.subject).sort(), ['A egy', 'B egy'])
  assert.equal(retrCount(b), 1, 'the new message only, nothing compared')
})

test('fetcher: a UIDL once listed twice is never deleted on the server, even when it is listed once later', async t => {
  const server = await startServer(t)
  server.add(eml({ subject: 'COPY-A', body: 'a' }), 'dup')
  server.add(eml({ subject: 'COPY-B', body: 'b' }), 'dup')
  const { fetcher, list } = setupFetcher(t, server, { pop3_delete_after_days: 0 })
  await fetcher.run()
  assert.deepEqual(list().map(m => m.subject), ['COPY-B'])
  server.messages = server.messages.filter(m => !m.source.toString().includes('COPY-B')) // gone elsewhere (webmail)
  await fetcher.run()
  assert.deepEqual(server.messages.map(m => m.source.toString().match(/Subject: (\S+)/)[1]), ['COPY-A'], 'the copy never downloaded stays')
})

test('fetcher: a doubled UIDL whose newest copy is refused: the other copy is downloaded', async t => {
  const server = await startServer(t)
  server.add(eml({ subject: 'COPY-A', body: 'a' }), 'dup')
  server.add(eml({ subject: 'COPY-B', body: 'b' }), 'dup')
  server.refuseRetr.add(server.messages[1])
  const { fetcher, list } = setupFetcher(t, server)
  await fetcher.run()
  assert.deepEqual(list().map(m => m.subject), ['COPY-A'])
  assert.equal(fetcher.state.errorCode, null)
})

test('fetcher: stop() while a downloaded message is being processed writes no row, no seen entry, no file', async t => {
  const server = await startServer(t)
  server.add(eml({ subject: 'Régi szerver', body: 'x' }), 'same-uidl')
  let fetcher = null
  const ctx = setupFetcher(t, server, { pop3_delete_after_days: 0 }, {
    connect: async () => {
      const c = await login(server)
      const retr = c.retr.bind(c)
      c.retr = async n => {
        const src = await retr(n)
        fetcher.stop() // the account was saved with another server meanwhile
        return src
      }
      return c
    },
  })
  fetcher = ctx.fetcher
  await fetcher.run().catch(() => {})
  assert.equal(ctx.list().length, 0)
  assert.equal(ctx.index.pop3Seen(ctx.row.id).size, 0)
  assert.equal(fs.existsSync(path.join(ctx.storeDir, ctx.row.id.toString())) ? fs.readdirSync(path.join(ctx.storeDir, ctx.row.id.toString())).length : 0, 0)
  assert.equal(server.messages.length, 1, 'nothing deleted')
})

test('fetcher: the index is made durable before the first DELE', async t => {
  const server = await startServer(t)
  server.add(eml({ subject: 'Megy', body: 'x' }), 'go-1')
  const order = []
  const ctx = setupFetcher(t, server, { pop3_delete_after_days: 0 }, {
    connect: async () => {
      const c = await login(server)
      const dele = c.dele.bind(c)
      c.dele = n => (order.push('dele'), dele(n))
      return c
    },
  })
  const flush = ctx.index.flushDurable.bind(ctx.index)
  ctx.index.flushDurable = () => (order.push('flush'), flush())
  await ctx.fetcher.run()
  assert.deepEqual(order, ['flush', 'dele'])
  assert.equal(server.messages.length, 0)
})

test('client: a response code counts only right after -ERR; [SYS/TEMP] in the text is a wrong password', async t => {
  const server = await startServer(t)
  server.passReply = '-ERR [AUTH] wrong password (see [SYS/TEMP] docs)'
  const c = new Pop3Client({ host: '127.0.0.1', port: server.port, security: 'none' })
  await c.connect()
  await assert.rejects(c.login(server.user, server.pass), err => err.code === 'POP3_AUTH' && classifyError(err) === 'auth_failed')
  c.close()
  server.passReply = '-ERR   [in-use] locked'
  const d = new Pop3Client({ host: '127.0.0.1', port: server.port, security: 'none' })
  await d.connect()
  await assert.rejects(d.login(server.user, server.pass), err => classifyError(err) === 'mailbox_in_use')
  d.close()
})

test('fetcher: an identity written by the previous build ("host:port:user") is the same mailbox, not a reset', async t => {
  const server = await startServer(t)
  server.add(eml({ subject: 'Régi', body: 'x' }), 'old-1')
  const { db, row, fetcher, list } = setupFetcher(t, server)
  await fetcher.run()
  db.prepare("UPDATE folders SET uidvalidity = ? WHERE account_id = ? AND path = 'INBOX'").run(`127.0.0.1:${server.port}:${server.user}`, row.id)
  await fetcher.run()
  assert.equal(list().length, 1)
  assert.equal(retrCount(server), 1, 'nothing compared, nothing downloaded again')
})

// --- a CR at the end of a TCP piece whose LF a mail proxy (ESET) lost --------
// Measured on the owner's Windows machine: when a CR and its LF fall into two TCP pieces, the LF is gone. The fake server's
// `retrPieces` writes the RETR answer in exactly the pieces a test gives (30 ms apart), on Linux too.
const SZABO = Buffer.from('From: Szabó Éva <eva@example.invalid>\r\nTo: teszt@example.invalid\r\nSubject: Három\r\n\r\nközös szó: gyöngyház\r\nmásodik sor\r\n', 'utf8')
// the index of the CR of the n-th CRLF at or after `from` in the answer
const crAt = (buf, needle) => buf.indexOf(Buffer.from(needle, 'latin1')) + Buffer.byteLength(needle, 'latin1') - 2
// a cut after that CR: `lose` drops its LF (the proxy), otherwise the LF opens the next piece (the usual CR|LF split)
const cutAfterCr = (needle, lose) => buf => {
  const cr = crAt(buf, needle)
  assert.equal(buf[cr], 0x0d, `a CR at ${needle}`)
  return [buf.subarray(0, cr + 1), buf.subarray(cr + (lose ? 2 : 1))]
}


// the line rule measured on given pieces, without a socket: on the owner's Windows machine ESET re-chunks the stream (it
// buffers a header block to add X-EsetId), so a socket test there does not get the pieces the fake server wrote
const ANSWER = Buffer.from(`+OK ${SZABO.length} octets\r\n${SZABO.toString('latin1')}.\r\n`, 'latin1')
const LINES = ANSWER.toString('latin1').split('\r\n').slice(0, -1)
const feed = pieces => {
  const st = { partial: [], lines: [] }
  let bare = 0
  for (const piece of pieces) splitChunk(st, piece, () => bare++)
  return { lines: st.lines.map(l => l.toString('latin1')), bare, partial: st.partial.length }
}
const PLACES = [
  ['status line', 'octets\r\n'],
  ['header (From)', 'eva@example.invalid>\r\n'],
  ['body', 'gyöngyház\r\n'],
  ['before the final "."', 'második sor\r\n'],
]

test('lines: the LF lost after a CR at a piece end, in the status line, a header, the body and before the final ".": the same lines', () => {
  for (const [name, needle] of PLACES) {
    const pieces = cutAfterCr(Buffer.from(needle, 'utf8').toString('latin1'), true)(ANSWER)
    const r = feed(pieces)
    assert.deepEqual(r.lines, LINES, name)
    assert.equal(r.bare, 1, `${name}: the lost LF reported once`)
    assert.equal(r.partial, 0, name)
  }
})

test('lines: unchanged: the usual CR|LF split at every place and at every byte, and a bare CR inside a line', () => {
  for (const [name, needle] of PLACES) {
    const r = feed(cutAfterCr(Buffer.from(needle, 'utf8').toString('latin1'), false)(ANSWER))
    assert.deepEqual([r.lines, r.bare], [LINES, 0], name)
  }
  // every cut position of the intact answer (two pieces): the same lines, nothing reported
  for (let i = 1; i < ANSWER.length; i++) {
    const r = feed([ANSWER.subarray(0, i), ANSWER.subarray(i)])
    assert.deepEqual([r.lines, r.bare], [LINES, 0], `cut at ${i}`)
  }
  // a message's own bare CR inside a line (against RFC 5322) stays as it is, when it is not at a piece end
  const inner = Buffer.from('+OK\r\negy\rketto sor\r\n.\r\n', 'latin1')
  const r = feed([inner])
  assert.deepEqual([r.lines, r.bare], [['+OK', 'egy\rketto sor', '.'], 0])
  // at a piece end it becomes a line end (accepted): no byte is lost
  const cr = inner.indexOf(0x0d, 5)
  const r2 = feed([inner.subarray(0, cr + 1), inner.subarray(cr + 1)])
  assert.deepEqual([r2.lines, r2.bare], [['+OK', 'egy', 'ketto sor', '.'], 1])
})

test('manager: messages whose RETR answer lost an LF keep their sender in the index; the log says pop3_bare_cr, no content', async t => {
  const server = await startServer(t)
  // the status line's LF lost (the case measured on Windows)
  server.retrPieces = cutAfterCr('octets\r\n', true)
  const from = ['Kovács Anna <anna@example.invalid>', 'Nagy Béla <bela@example.invalid>', 'Szabó Éva <eva@example.invalid>']
  for (const [i, f] of from.entries()) server.add(Buffer.from(`From: ${f}\r\nTo: teszt@example.invalid\r\nSubject: Levél ${i}\r\nMessage-ID: <m${i}@x>\r\nDate: ${new Date(NOW - DAY).toUTCString()}\r\n\r\ngyöngyház\r\n`, 'utf8'))
  const { db, index } = memoryIndex(t)
  const row = addAccount(db, { type: 'pop3', in_port: server.port, in_host: '127.0.0.1', in_security: 'none', in_user: server.user })
  const store = {
    list: () => db.prepare('SELECT * FROM accounts ORDER BY id').all(),
    getRow: id => db.prepare('SELECT * FROM accounts WHERE id = ?').get(id),
    passwordsFor: () => ({ incoming: server.pass }),
  }
  const logs = []
  const manager = new SyncManager({ store, index, sealed: sealedStore(path.join(tempDir(t), 'store')), log: m => logs.push(m), now: () => NOW, throttleMs: 5, syncerOptions: { retryDelaysMs: [20, 20] } })
  onCleanup(t, () => manager.stopAll())
  manager.startAll()
  // the run's end (the texts are indexed after the download)
  for (let i = 0; i < 500 && !manager.status().find(s => s.accountId === row.id)?.lastFinished; i++) await sleep(10)
  const rows = index.listFolder({ accountId: row.id, folder: 'INBOX', sort: 'subject', dir: 'asc' })
  assert.deepEqual(rows.map(r => [r.subject, r.from_name, r.from_addr]), [['Levél 0', 'Kovács Anna', 'anna@example.invalid'], ['Levél 1', 'Nagy Béla', 'bela@example.invalid'], ['Levél 2', 'Szabó Éva', 'eva@example.invalid']])
  // the sender filter of the search finds it (the step of search.test that failed on Windows)
  assert.deepEqual(index.search({ query: 'gyongyhaz', from: 'Szabo', limit: 10 }).map(r => r.subject), ['Levél 2'])
  const bareLines = logs.filter(l => l.includes('pop3_bare_cr'))
  assert.equal(bareLines.length, 3)
  assert.ok(bareLines.every(l => l === `account ${row.id}: pop3_bare_cr`), 'no content in the log line')
  await manager.stopAll()
})
