// The sync run's diagnostic log line (app/main/sync-manager.js syncLogLine, app/main/loop-watch.js): one line per full
// and POP3 run, the keys in a fixed order with the run's own numbers, condstore from the connection's ENABLE, the main
// thread's gaps of the run (a 250 ms block shows; without one no gap over 100 ms on a quiet machine), a targeted run only
// when slow, no folder name, address, server or user anywhere in the log, the gap timer on only while a run is.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { memoryIndex, addAccount, DAY, sealedStore } from './helpers/fixtures.js'
import { onCleanup, tempDir } from './helpers/tmp.js'
import { FakeImapServer } from './helpers/fake-imap.js'
import { FakePop3Server } from './helpers/fake-pop3.js'
import { retryWhenLoaded } from './helpers/load-retry.js'
import { Pop3Fetcher } from '../core/pop3/fetcher.js'
import { Pop3Client } from '../core/pop3/client.js'
import { SyncManager, syncLogLine, logsRun, TARGETED_LOG_MS } from '../app/main/sync-manager.js'
import { createLoopWatch } from '../app/main/loop-watch.js'

const NOW = Date.UTC(2026, 10, 26, 9, 0, 0)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const until = async (fn, ms = 30_000) => {
  const t0 = performance.now()
  while (!fn()) {
    if (performance.now() - t0 > ms) throw new Error('timed out waiting')
    await sleep(5)
  }
}
const busy = ms => {
  const t0 = performance.now()
  while (performance.now() - t0 < ms);
}
const LINE = /^sync account=(\d+) kind=(full|targeted|pop3) condstore=(yes|no|-) folders=(\d+) flags=(\d+) new=(\d+) bodies=(\d+) ms=(\d+) list_ms=(\d+) meta_ms=(\d+) bodies_ms=(\d+) loop_max=(\d+) loop_over100=(\d+) result=([a-z_]+)$/
const KEYS = ['account', 'kind', 'condstore', 'folders', 'flags', 'new', 'bodies', 'ms', 'list_ms', 'meta_ms', 'bodies_ms', 'loop_max', 'loop_over100', 'result']
const parse = line => {
  const m = LINE.exec(line)
  assert.ok(m, `the line's form: ${line}`)
  return Object.fromEntries(KEYS.map((k, i) => [k, i === 1 || i === 2 || i === 13 ? m[i + 1] : Number(m[i + 1])]))
}

// a manager over one IMAP account: INBOX with `inbox` messages and "Projekt Titok" with `other` (inside the body limit);
// every log line kept; hook(name) runs inside index.insertMany (a block during the run)
function setup(t, { inbox = 30, other = 5, modseq = null } = {}) {
  const { db, index } = memoryIndex(t)
  const row = addAccount(db, { name: 'Titkos Fiok', email: 'titkos.cim@example.invalid', in_host: 'imap.titkos-szerver.example.invalid', in_user: 'titkos.felhasznalo' })
  const server = new FakeImapServer().addMailbox('INBOX').addMailbox('Projekt Titok')
  server.modseq = modseq
  const msg = (k, folder) => ({ from: `kuldo${k}@felado-domain.example.invalid`, to: 'titkos.cim@example.invalid', subject: `Targy ${folder} ${k}`, messageId: `<l${folder}-${k}@x>`, date: NOW - DAY - k * 60_000, body: `level ${k}` })
  server.addMessages('INBOX', Array.from({ length: inbox }, (_, k) => msg(k, 'i')))
  server.addMessages('Projekt Titok', Array.from({ length: other }, (_, k) => msg(k, 'p')))
  const store = { list: () => [row], getRow: id => (id === row.id ? row : null), passwordsFor: () => ({ incoming: 'x' }) }
  const logs = []
  const hooks = { insertMany: null }
  const insertMany = index.insertMany
  index.insertMany = rows => {
    if (hooks.insertMany) hooks.insertMany(rows)
    return insertMany(rows)
  }
  const manager = new SyncManager({ store, index, log: l => logs.push(l), connect: () => server.connect(), now: () => NOW, throttleMs: 5, idleOptions: { retryDelaysMs: [60_000] } })
  onCleanup(t, () => manager.stopAll())
  const runsEnded = () => manager.status().reduce((n, s) => n + s.runsEnded, 0)
  const lines = () => logs.filter(l => l.startsWith('sync '))
  return { db, index, row, server, manager, logs, lines, hooks, runsEnded, msg }
}

test('a full run: exactly one line, the keys in order, the run\'s own numbers; the next full run counts the flags', async t => {
  const s = setup(t)
  s.manager.startAll()
  await until(() => s.runsEnded() >= 1)
  assert.equal(s.lines().length, 1, s.lines().join('\n'))
  const l = parse(s.lines()[0])
  assert.equal(l.account, s.row.id)
  assert.equal(l.kind, 'full')
  assert.equal(l.condstore, 'no')
  assert.equal(l.folders, 2)
  assert.equal(l.flags, 0, 'nothing known before the first run')
  assert.equal(l.new, 35)
  assert.equal(l.bodies, 35)
  assert.equal(l.result, 'ok')
  assert.ok(l.ms >= l.list_ms && l.ms >= l.bodies_ms, JSON.stringify(l))
  // a second full run: the 35 known messages' flags, nothing new
  await s.manager.requestSync(s.row.id)
  await until(() => s.lines().length === 2)
  const l2 = parse(s.lines()[1])
  assert.deepEqual([l2.kind, l2.folders, l2.flags, l2.new, l2.bodies, l2.result], ['full', 2, 35, 0, 0, 'ok'])
})

test('condstore=yes when the connection ENABLEd it (a saved HIGHESTMODSEQ: one FETCH of the changes)', async t => {
  const s = setup(t, { modseq: 9 })
  s.manager.startAll()
  await until(() => s.lines().length >= 1)
  assert.equal(parse(s.lines()[0]).condstore, 'yes')
})

test('a 250 ms block during the run shows (loop_max >= 240, loop_over100 >= 1); without one no gap over 100 ms', async t => {
  const s = setup(t)
  let blocked = false
  s.hooks.insertMany = () => {
    if (blocked) return
    blocked = true
    busy(250)
  }
  s.manager.startAll()
  await until(() => s.lines().length >= 1)
  const l = parse(s.lines()[0])
  assert.ok(l.loop_max >= 240, `loop_max ${l.loop_max}`)
  assert.ok(l.loop_over100 >= 1, `loop_over100 ${l.loop_over100}`)
  // the same run without the block: no gap over 100 ms (on a loaded machine: measured again, see load-retry.js)
  await retryWhenLoaded(t, async () => {
    const q = setup(t)
    q.manager.startAll()
    await until(() => q.lines().length >= 1)
    const lq = parse(q.lines()[0])
    await q.manager.stopAll()
    assert.equal(lq.loop_over100, 0, `quiet run: ${q.lines()[0]}`)
  })
})

test('a targeted run: no line when quick, a line when it blocked the main thread', async t => {
  const s = setup(t)
  s.manager.startAll()
  await until(() => s.lines().length === 1 && !s.manager.status()[0].busy)
  // quick: a new message, the INBOX only
  s.server.addMessage('INBOX', s.msg(900, 'i'))
  let before = s.runsEnded()
  s.manager.requestSync(s.row.id, ['INBOX'])
  await until(() => s.runsEnded() > before)
  assert.equal(s.lines().length, 1, 'no line for a quick targeted run')
  // slow: a 250 ms block in it
  s.hooks.insertMany = () => busy(250)
  s.server.addMessage('INBOX', s.msg(901, 'i'))
  before = s.runsEnded()
  s.manager.requestSync(s.row.id, ['INBOX'])
  await until(() => s.runsEnded() > before)
  assert.equal(s.lines().length, 2)
  const l = parse(s.lines()[1])
  assert.deepEqual([l.kind, l.folders, l.new], ['targeted', 1, 1])
  assert.ok(l.loop_over100 >= 1)
  // the rule itself
  assert.equal(logsRun({ kind: 'targeted', ms: TARGETED_LOG_MS, loopOver100: 0 }), false)
  assert.equal(logsRun({ kind: 'targeted', ms: TARGETED_LOG_MS + 1, loopOver100: 0 }), true)
  assert.equal(logsRun({ kind: 'full', ms: 1, loopOver100: 0 }), true)
  assert.equal(logsRun({ kind: 'pop3', ms: 1, loopOver100: 0 }), true)
})

test('the log carries no folder name, address, server or user: only the keys and numbers', async t => {
  const s = setup(t)
  s.manager.startAll()
  await until(() => s.lines().length >= 1)
  await s.manager.requestSync(s.row.id)
  await until(() => s.lines().length >= 2)
  const all = s.logs.join('\n')
  for (const secret of ['Projekt', 'Titok', 'INBOX', 'titkos', 'example.invalid', 'felado-domain', 'kuldo', 'Targy', 'imap.', 'Fiok']) {
    assert.ok(!all.includes(secret), `"${secret}" in the log:\n${all}`)
  }
  for (const l of s.lines()) assert.match(l, LINE)
})

test('the gap timer runs only while a run is; stopAll ends it', async t => {
  const s = setup(t, { inbox: 200 })
  let seenOn = false
  s.hooks.insertMany = () => {
    if (s.manager.loopWatch.running()) seenOn = true
  }
  assert.equal(s.manager.loopWatch.running(), false, 'off before any run')
  s.manager.startAll()
  await until(() => s.lines().length >= 1)
  assert.ok(seenOn, 'on during the run')
  await until(() => !s.manager.loopWatch.running(), 5000)
  // stopAll during a run (a lock): the timer stops at once
  s.hooks.insertMany = () => busy(1)
  s.server.addMessages('INBOX', Array.from({ length: 300 }, (_, k) => s.msg(1000 + k, 'i')))
  s.manager.requestSync(s.row.id)
  await until(() => s.manager.loopWatch.running())
  await s.manager.stopAll()
  assert.equal(s.manager.loopWatch.running(), false)
})

test('POP3: kind=pop3 condstore=- folders=1, new and bodies the run\'s', async t => {
  const server = await new FakePop3Server().listen()
  onCleanup(t, () => server.close())
  const n = 12
  for (let i = 0; i < n; i++) {
    server.add(Buffer.from(`From: a@example.invalid\r\nTo: b@example.invalid\r\nSubject: P ${i}\r\nDate: ${new Date(NOW - DAY).toUTCString()}\r\nMessage-ID: <q${i}@x>\r\n\r\nA ${i}.\r\n`))
  }
  const { db, index } = memoryIndex(t)
  const row = addAccount(db, { type: 'pop3', in_port: server.port, in_host: '127.0.0.1', in_security: 'none', in_user: server.user })
  const summaries = []
  const fetcher = new Pop3Fetcher({
    account: row,
    loadAccount: () => db.prepare('SELECT * FROM accounts WHERE id = ?').get(row.id),
    index,
    sealed: sealedStore(path.join(tempDir(t), 'store')),
    onRunEnd: s => summaries.push(s),
    loopWatch: createLoopWatch(),
    connect: async () => {
      const c = new Pop3Client({ host: '127.0.0.1', port: server.port, security: 'none', timeoutMs: 5000 })
      await c.connect()
      await c.login(server.user, server.pass)
      return c
    },
    now: () => NOW,
  })
  onCleanup(t, () => fetcher.stop())
  await fetcher.run()
  assert.equal(summaries.length, 1)
  const l = parse(syncLogLine(summaries[0]))
  assert.deepEqual([l.kind, l.condstore, l.folders, l.flags, l.new, l.bodies, l.result], ['pop3', '-', 1, 0, n, n, 'ok'])
})

test('syncLogLine: a stopped run, an unknown result code, a missing number', () => {
  const base = { accountId: 3, kind: 'full', condstore: false, folders: 1, flags: 2, added: 3, bodies: 4, ms: 5.4, listMs: 1, metaMs: 2, bodiesMs: 3, loopMax: 7.6, loopOver100: 0 }
  assert.equal(syncLogLine({ ...base, result: 'stopped' }), 'sync account=3 kind=full condstore=no folders=1 flags=2 new=3 bodies=4 ms=5 list_ms=1 meta_ms=2 bodies_ms=3 loop_max=8 loop_over100=0 result=stopped')
  assert.match(syncLogLine({ ...base, result: 'Bad Thing: x@y' }), / result=error$/, 'only a code goes in the line')
  assert.match(syncLogLine({ ...base, flags: undefined, result: 'ok' }), / flags=0 /)
})

test('createLoopWatch: two windows see the same gap; each end once; the timer off after the last', async () => {
  const w = createLoopWatch()
  const a = w.begin()
  await sleep(30)
  const b = w.begin()
  await sleep(15)
  busy(150)
  await sleep(15)
  const ra = a.end()
  assert.ok(w.running(), 'b is still open')
  const rb = b.end()
  assert.equal(w.running(), false)
  assert.ok(ra.max >= 130 && rb.max >= 130, `${ra.max} ${rb.max}`)
  assert.ok(ra.over >= 1 && rb.over >= 1)
  assert.deepEqual(a.end(), ra, 'a second end gives the same numbers')
  // stop() (the manager's stopAll): the timer off even with a window still open; its end still answers
  const c = w.begin()
  assert.ok(w.running())
  w.stop()
  assert.equal(w.running(), false)
  assert.deepEqual(Object.keys(c.end()), ['max', 'over'])
  assert.equal(w.running(), false)
})
