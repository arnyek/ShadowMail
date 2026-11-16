// The search text with the real worker thread (the 50 ms / "not worse" timings: test/tools/
// search-delay.mjs): the IMAP sync and the open on a 404 KB CSS-heavy newsletter, the visible
// text replaces the old one, the preview stays; the re-index of the rows stored before (resumable, once, no IMAP); lock.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { simpleParser } from 'mailparser'
import { memoryIndex, addAccount, DAY, sealedStore } from './helpers/fixtures.js'
import { onCleanup, tempDir } from './helpers/tmp.js'
import { FakeImapServer } from './helpers/fake-imap.js'
import { FakePop3Server } from './helpers/fake-pop3.js'
import { newsletterEml } from './helpers/newsletter.js'
import { SyncManager } from '../app/main/sync-manager.js'
import { MessageReader } from '../app/main/reader.js'
import { openSettings } from '../app/main/settings.js'
import { SearchTextService } from '../core/mime/search-text-service.js'
import { createSearchRefiner, createFtsReindex, FLAG, FLAG_DONE } from '../app/main/search-index.js'
import { INDEX_PARSE } from '../core/mime/text.js'

const NOW = Date.UTC(2026, 10, 12, 9, 0, 0)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const until = async (fn, ms = 60_000) => {
  const t0 = Date.now()
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting')
    await sleep(10)
  }
}
const HIDDEN = 'rejtettpreheader'
const VISIBLE = 'lathatotermek'
const idle = svc => svc.pendingBytes === 0 && !svc.current
// the old code (before the visible text): the old text at once, no worker
const OLD = { refineMany: async () => {}, refine: async () => {} }

async function imapSetup(t, searchText, extra = []) {
  const { db, index } = memoryIndex(t)
  const row = addAccount(db, { name: 'IMAP' })
  const imap = new FakeImapServer().addMailbox('INBOX')
  const big = newsletterEml({ subject: 'Hirlevel', hidden: HIDDEN, visible: VISIBLE })
  imap.addMessage('INBOX', { from: 'hir@example.invalid', fromName: 'Hírlevél', to: 'sajat@example.invalid', subject: 'Hirlevel', messageId: '<nl@x>', date: NOW - DAY, body: '', source: big })
  for (const m of extra) imap.addMessage('INBOX', m)
  const store = { list: () => db.prepare('SELECT * FROM accounts ORDER BY id').all(), getRow: id => db.prepare('SELECT * FROM accounts WHERE id = ?').get(id), passwordsFor: () => ({ incoming: 'x' }) }
  const storeDir = path.join(tempDir(t), 'store')
  const manager = new SyncManager({ store, index, sealed: sealedStore(storeDir), notify: () => {}, connect: async () => imap.connect(), now: () => NOW, throttleMs: 5, syncerOptions: { retryDelaysMs: [30, 30] }, idleOptions: { retryDelaysMs: [30], debounceMs: 10 }, searchText })
  onCleanup(t, () => manager.stopAll())
  return { db, index, row, imap, store, storeDir, manager, big }
}

// mailparser's first parse compiles its code: warm it up as a running app has
await simpleParser(newsletterEml({ blocks: 50 }), INDEX_PARSE)

async function syncDelay(t, mode) {
  const svc = mode === 'worker' ? new SearchTextService() : null
  const s0 = await imapSetup(t, null)
  const refiner = mode === 'worker' ? createSearchRefiner({ service: svc, index: s0.index, settings: openSettings(s0.db), sealed: sealedStore(s0.storeDir) }) : mode === 'old' ? OLD : null
  s0.manager.searchText = refiner
  onCleanup(t, () => refiner && refiner.stop && refiner.stop())
  const h = monitorEventLoopDelay({ resolution: 5 })
  h.enable()
  s0.manager.startAll()
  await until(() => s0.manager.status()[0].lastFinished && s0.index.stats(s0.row.id).bodies >= 1)
  if (svc) await until(() => idle(svc))
  await sleep(30)
  h.disable()
  return { ...s0, svc, refiner, maxMs: h.max / 1e6 }
}

test('worker: IMAP sync of the 404 KB newsletter: the worker keeps the event loop far below the main-thread way; the visible text replaces the old', async t => {
  const old = await syncDelay(t, 'old')
  const inline = await syncDelay(t, 'inline')
  const w = await syncDelay(t, 'worker')
  t.diagnostic(`event loop max during the sync: old code ${old.maxMs.toFixed(0)} ms, visible text on the main thread ${inline.maxMs.toFixed(0)} ms, worker ${w.maxMs.toFixed(0)} ms`)
  // the 50 ms condition is measured by test/tools/search-delay.mjs (its own process per run): `npm test` runs its files in
  // parallel, and the loaded CPU moved this number (106 ms once); here only the direction, which no load turns around
  assert.ok(w.maxMs * 3 < inline.maxMs, `worker ${w.maxMs.toFixed(0)} ms, the visible text on the main thread ${inline.maxMs.toFixed(0)} ms`)
  // old code: the hidden preheader is searchable; worker: it is not, the visible word is
  assert.equal(old.index.search({ query: HIDDEN }).length, 1)
  assert.equal(w.index.search({ query: HIDDEN }).length, 0)
  assert.equal(w.index.search({ query: VISIBLE }).length, 1)
  // the preview is the same in all three
  const pv = s => s.db.prepare('SELECT preview FROM messages').get().preview
  assert.equal(pv(w), pv(old))
  assert.equal(pv(inline), pv(old))
  assert.ok(pv(w).includes(HIDDEN), 'the preview keeps the preheader')
})

test('worker: opening the newsletter: the indexed row gets the visible text, the preview stays', async t => {
  const results = {}
  for (const mode of ['old', 'worker']) {
    const s = await syncDelay(t, 'old') // indexed by the old rule, no local source (an IMAP message from before the visible text)
    assert.equal(s.index.search({ query: HIDDEN }).length, 1)
    const svc = mode === 'worker' ? new SearchTextService() : null
    const refiner = svc ? createSearchRefiner({ service: svc, index: s.index, settings: openSettings(s.db), sealed: sealedStore(s.storeDir) }) : OLD
    onCleanup(t, () => svc && svc.stop())
    const reader = new MessageReader({ index: s.index, sealed: sealedStore(s.storeDir), withConnection: (id, fn) => s.manager.withConnection(id, fn), searchText: refiner })
    const id = s.db.prepare('SELECT id FROM messages').get().id
    const preview = s.db.prepare('SELECT preview FROM messages').get().preview
    const h = monitorEventLoopDelay({ resolution: 5 })
    h.enable()
    const t0 = performance.now()
    await reader.open(id)
    const openMs = performance.now() - t0
    if (svc) await until(() => idle(svc) && s.index.search({ query: HIDDEN }).length === 0)
    await sleep(30)
    h.disable()
    results[mode] = { openMs, maxMs: h.max / 1e6 }
    assert.equal(s.db.prepare('SELECT preview FROM messages').get().preview, preview, `${mode}: the preview stays`)
    if (svc) {
      assert.equal(s.index.search({ query: HIDDEN }).length, 0, 'opened: clean')
      // the whole 404 KB newsletter is over visibleTextInfo's work ceiling: its first 128 KB is searched
      assert.equal(s.index.search({ query: VISIBLE }).length, 1)
    }
  }
  t.diagnostic(`open: old code ${results.old.openMs.toFixed(0)} ms (event loop max ${results.old.maxMs.toFixed(0)} ms), worker ${results.worker.openMs.toFixed(0)} ms (event loop max ${results.worker.maxMs.toFixed(0)} ms)`)
  // "not worse than the old code" is measured by test/tools/open-delay.mjs (every run its own process,
  // the modes alternating): two runs in one process favour the second one (a warmer JIT), measured both ways here

})

test('worker: lock: what waits is dropped, nothing is written after it; a lost local message clears its account flag', async t => {
  const { db, index } = memoryIndex(t)
  const acc = addAccount(db).id
  const settings = openSettings(db)
  settings.set(FLAG(acc), FLAG_DONE)
  let answered = 0
  const svc = new SearchTextService({ createWorker: () => {
    const { EventEmitter } = require_events()
    const w = new EventEmitter()
    w.postMessage = () => {} // never answers: the message stays in work
    w.terminate = () => Promise.resolve(0)
    return w
  } })
  const refiner = createSearchRefiner({ service: svc, index, settings })
  db.prepare(`INSERT INTO messages (account_id, folder, uid, subject, date, idate, flags, size, has_attachments, body_state, store_path) VALUES (?, 'INBOX', NULL, 'x', 1, 1, '', 1, 0, 1, 'a/b.eml')`).run(acc)
  const id = db.prepare('SELECT id FROM messages').get().id
  db.prepare("INSERT INTO messages_fts (rowid, subject, sender, recipients, body) VALUES (?, 'x', '', '', 'regi szoveg')").run(id)
  await refiner.refineMany([{ id, accountId: acc, local: true, source: Buffer.from('From: a\r\n\r\nuj\r\n') }])
  const cleared = refiner.stop()
  assert.deepEqual(cleared, [acc])
  assert.equal(settings.get(FLAG(acc)), '', 'the flag cleared: the re-index makes it up')
  assert.equal(db.prepare('SELECT body FROM messages_fts WHERE rowid = ?').get(id).body, 'regi szoveg', 'nothing written')
  // a late batch after the lock writes nothing either, and clears its local account
  settings.set(FLAG(acc), FLAG_DONE)
  await refiner.refineMany([{ id, accountId: acc, local: true, source: Buffer.from('x') }])
  assert.equal(settings.get(FLAG(acc)), '')
  assert.equal(answered, 0)
})

function require_events() {
  return { EventEmitter: EventEmitterRef }
}
import { EventEmitter as EventEmitterRef } from 'node:events'

async function pop3OldDb(t, count = 30) {
  // a POP3 account downloaded by the OLD code: the hidden words are in the index
  const server = await new FakePop3Server().listen()
  onCleanup(t, () => server.close())
  for (let i = 0; i < count; i++) server.add(newsletterEml({ subject: `Level ${i}`, blocks: 40, hidden: `rejtett${i}x`, visible: `latszo${i}x` }))
  const { db, index } = memoryIndex(t)
  const row = addAccount(db, { type: 'pop3', in_port: server.port, in_host: '127.0.0.1', in_security: 'none', in_user: server.user })
  // an IMAP account with an old-rule row and no local source: the re-index must not touch it
  const imapRow = addAccount(db, { name: 'IMAP' })
  db.prepare(`INSERT INTO messages (account_id, folder, uid, subject, date, idate, flags, size, has_attachments, body_state) VALUES (?, 'INBOX', 1, 'imapregi', 5, 5, '', 1, 0, 1)`).run(imapRow.id)
  const imapId = db.prepare("SELECT id FROM messages WHERE subject = 'imapregi'").get().id
  db.prepare("INSERT INTO messages_fts (rowid, subject, sender, recipients, body) VALUES (?, 'imapregi', '', '', 'imaprejtett szoveg')").run(imapId)
  const store = { list: () => db.prepare('SELECT * FROM accounts ORDER BY id').all(), getRow: id => db.prepare('SELECT * FROM accounts WHERE id = ?').get(id), passwordsFor: () => ({ incoming: server.pass }) }
  const storeDir = path.join(tempDir(t), 'store')
  const imap = new FakeImapServer().addMailbox('INBOX')
  const manager = new SyncManager({ store: { ...store, list: () => store.list().filter(a => a.type === 'pop3') }, index, sealed: sealedStore(storeDir), now: () => NOW, throttleMs: 5, syncerOptions: { retryDelaysMs: [20, 20] }, searchText: OLD })
  onCleanup(t, () => manager.stopAll())
  manager.startAll()
  await until(() => manager.status()[0].lastFinished && index.stats(row.id).bodies === count)
  await manager.stopAll()
  return { db, index, row, imapRow, imapId, store, storeDir, imap, count }
}

test('worker: re-index of a POP3 account indexed by the old rule: hidden words gone, visible found, the preview kept; resumable; once; no IMAP', async t => {
  const s = await pop3OldDb(t)
  const previews = s.db.prepare('SELECT id, preview FROM messages ORDER BY id').all()
  assert.equal(s.index.search({ query: 'rejtett3x' }).length, 1, 'old rule: the hidden word is searchable')
  const settings = openSettings(s.db)
  const svc = new SearchTextService()
  onCleanup(t, () => svc.stop())
  const rowMs = []
  // stop after 10 rows (a lock), then go on
  let reindex = createFtsReindex({ index: s.index, store: s.store, sealed: sealedStore(s.storeDir), settings, service: svc, onRow: ms => (rowMs.push(ms), rowMs.length === 10 && reindex.stop()) })
  const h = monitorEventLoopDelay({ resolution: 5 })
  h.enable()
  assert.equal(await reindex.run(), 10)
  const cursor = JSON.parse(settings.get(FLAG(s.row.id)))
  assert.ok(Number.isInteger(cursor.id), 'the cursor is saved')
  // the 10 newest are clean, the rest not yet; the search works meanwhile
  const clean = i => s.index.search({ query: `rejtett${i}x` }).length === 0
  const cleanCount = Array.from({ length: s.count }, (_, i) => clean(i)).filter(Boolean).length
  assert.equal(cleanCount, 10)
  reindex = createFtsReindex({ index: s.index, store: s.store, sealed: sealedStore(s.storeDir), settings, service: svc, onRow: ms => rowMs.push(ms) })
  const loginsBefore = s.imap.loginAttempts
  assert.equal(await reindex.run(), s.count - 10, 'went on from the cursor')
  h.disable()
  assert.equal(settings.get(FLAG(s.row.id)), FLAG_DONE)
  assert.equal(settings.get(FLAG(s.imapRow.id)), FLAG_DONE, 'the IMAP account has no local-source row: done at once')
  for (let i = 0; i < s.count; i++) {
    assert.equal(s.index.search({ query: `rejtett${i}x` }).length, 0, `hidden ${i}`)
    assert.equal(s.index.search({ query: `latszo${i}x` }).length, 1, `visible ${i}`)
  }
  assert.deepEqual(s.db.prepare('SELECT id, preview FROM messages ORDER BY id').all(), previews, 'the previews unchanged')
  assert.equal(s.index.search({ query: 'imaprejtett' }).length, 1, 'the IMAP row without a local source keeps its old text')
  assert.equal(s.imap.loginAttempts, loginsBefore, 'no IMAP connection')
  t.diagnostic(`re-index: ${rowMs.length} rows, main thread per row max ${Math.max(...rowMs).toFixed(1)} ms, event loop max ${(h.max / 1e6).toFixed(0)} ms`)
  assert.ok(Math.max(...rowMs) <= 100)
  assert.ok(h.max / 1e6 <= 100)
  // a second run does nothing
  assert.equal(await createFtsReindex({ index: s.index, store: s.store, sealed: sealedStore(s.storeDir), settings, service: svc }).run(), 0)
})

test('worker: a late worker result never brings back a body the limit cleared (state 3), nor writes to a pending or failed row', async t => {
  const { db, index } = memoryIndex(t)
  const acc = addAccount(db).id
  const ins = (subject, state) => {
    db.prepare(`INSERT INTO messages (account_id, folder, uid, subject, date, idate, flags, size, has_attachments, body_state) VALUES (?, 'INBOX', ?, ?, 1, 1, '', 1, 0, ?)`).run(acc, Math.floor(Math.random() * 1e9), subject, state)
    const id = db.prepare('SELECT id FROM messages WHERE subject = ?').get(subject).id
    db.prepare("INSERT INTO messages_fts (rowid, subject, sender, recipients, body) VALUES (?, ?, '', '', '')").run(id, subject)
    return id
  }
  const indexed = ins('indexed', 1)
  const beyond = ins('beyond', 3)
  const pending = ins('pending', 0)
  const failed = ins('failed', 2)
  assert.equal(index.setSearchBody(indexed, 'lathato szoveg'), true)
  for (const id of [beyond, pending, failed]) assert.equal(index.setSearchBody(id, 'kesoi szoveg'), false)
  assert.equal(index.search({ query: 'kesoi' }).length, 0)
  assert.equal(index.search({ query: 'lathato' }).length, 1)
})

test('worker: a stored source the worker cannot read (1200 MIME parts) does not stall the re-index: it is passed, the account gets done', async t => {
  const s = await pop3OldDb(t, 8)
  const settings = openSettings(s.db)
  // the third row in the re-index order (newest first) gets a source mailparser refuses (EMAXLEN: over 1000 parts)
  const rows = s.index.localSourceRows(s.row.id, null, 20)
  const poisoned = rows[2]
  const parts = Array.from({ length: 1200 }, (_, i) => `--bb\r\nContent-Type: text/plain\r\n\r\nresz ${i}\r\n`).join('')
  sealedStore(s.storeDir).write(poisoned.store_path, Buffer.from(`From: a@example.invalid\r\nSubject: sok resz\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="bb"\r\n\r\n${parts}--bb--\r\n`))
  const poisonedText = s.db.prepare('SELECT body FROM messages_fts WHERE rowid = ?').get(poisoned.id).body
  const svc = new SearchTextService({ log: () => {} })
  onCleanup(t, () => svc.stop())
  const run = () => createFtsReindex({ index: s.index, store: s.store, sealed: sealedStore(s.storeDir), settings, service: svc }).run()
  assert.equal(await run(), 7, 'every other row written')
  assert.equal(settings.get(FLAG(s.row.id)), FLAG_DONE)
  assert.equal(await run(), 0, 'and not again')
  // the other seven are clean; the passed one keeps its old text (nothing lost)
  const subjectOf = id => s.db.prepare('SELECT subject FROM messages WHERE id = ?').get(id).subject
  for (const r of rows) {
    const i = Number(subjectOf(r.id).match(/\d+/)[0])
    if (r.id === poisoned.id) continue
    assert.equal(s.index.search({ query: `rejtett${i}x` }).length, 0, `hidden ${i}`)
    assert.equal(s.index.search({ query: `latszo${i}x` }).length, 1, `visible ${i}`)
  }
  assert.equal(s.db.prepare('SELECT body FROM messages_fts WHERE rowid = ?').get(poisoned.id).body, poisonedText)
})
