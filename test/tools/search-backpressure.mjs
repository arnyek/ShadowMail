#!/usr/bin/env node
// the back-pressure of the search-text worker in a real download. Not part of `npm test`
// (about a minute: 200 visible texts of ~390 KB on the worker).
//
//   node test/tools/search-backpressure.mjs [--count 200] [--blocks 2000] [--rules 20] [--old] [--imap]
//
// N newsletters of ~390 KB, each with its own hidden and visible word; the app's SyncManager with the session's refiner
// and the real worker (16 MB bound). POP3 (default; the fake TCP server): a stored source waits as its id only:
// the download time against --old (the code before the worker) must be within 10 %; the background indexing's end is
// reported apart. --imap (the fake IMAP server, no local source: the raw bytes wait, back-pressure): the peak of the
// waiting raw bytes never over 16 MB. Both: the main thread's event loop max, and at the end every hidden word gives 0
// hits, every visible word 1. Exit 0 = all right.
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { parseArgs } from 'node:util'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { openMailDatabase } from '../../core/db/index.js'
import { MailIndex } from '../../core/db/mail-index.js'
import { SealedStore } from '../../core/store/sealed-file.js'
import { SyncManager } from '../../app/main/sync-manager.js'
import { openSettings } from '../../app/main/settings.js'
import { SearchTextService, MAX_PENDING_BYTES } from '../../core/mime/search-text-service.js'
import { createSearchRefiner } from '../../app/main/search-index.js'
import { FakePop3Server } from '../helpers/fake-pop3.js'
import { newsletterEml } from '../helpers/newsletter.js'
import { addAccount } from '../helpers/fixtures.js'
import { FakeImapServer } from '../helpers/fake-imap.js'
import crypto from 'node:crypto'

const { values } = parseArgs({ options: { count: { type: 'string', default: '200' }, blocks: { type: 'string', default: '2000' }, rules: { type: 'string', default: '20' }, old: { type: 'boolean', default: false }, imap: { type: 'boolean', default: false } } })
const N = Number(values.count)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-backpressure-'))
const server = values.imap ? null : await new FakePop3Server({ chunk: 400 }).listen()
const imap = values.imap ? new FakeImapServer().addMailbox('INBOX') : null
let bytes = 0
for (let i = 0; i < N; i++) {
  const m = newsletterEml({ subject: `Hirlevel ${i}`, blocks: Number(values.blocks), rules: Number(values.rules), hidden: `rejtett${i}q`, visible: `latszo${i}q` })
  bytes += m.length
  if (imap) imap.addMessage('INBOX', { from: 'hir@example.invalid', to: 't@example.invalid', subject: `Hirlevel ${i}`, messageId: `<n${i}@x>`, date: Date.now() - (N - i) * 1000, body: '', source: m })
  else server.add(m)
}
const { db } = openMailDatabase(':memory:')
const index = new MailIndex(db)
const acc = imap ? addAccount(db, { name: 'IMAP' }) : addAccount(db, { type: 'pop3', in_port: server.port, in_host: '127.0.0.1', in_security: 'none', in_user: server.user })
const store = { list: () => db.prepare('SELECT * FROM accounts').all(), getRow: id => db.prepare('SELECT * FROM accounts WHERE id = ?').get(id), passwordsFor: () => ({ incoming: server ? server.pass : 'x' }) }
const sealed = new SealedStore(path.join(work, 'store'), crypto.randomBytes(32))
const service = new SearchTextService()
const refiner = createSearchRefiner({ service, index, settings: openSettings(db), sealed })
// --old: the code before the worker (the old text only, no worker), for the event loop comparison
const oldCode = { refineMany: async () => {}, refine: async () => {} }
const manager = new SyncManager({ store, index, sealed, ...(imap ? { connect: async () => imap.connect() } : {}), now: () => Date.now(), throttleMs: 5, syncerOptions: { retryDelaysMs: [20, 20] }, searchText: values.old ? oldCode : refiner })
// mailparser's first parse compiles its code (measured cold: ~110 ms): warmed up as in a running app
await (await import('mailparser')).simpleParser(newsletterEml({ blocks: 50 }))
const h = monitorEventLoopDelay({ resolution: 5 })
h.enable()
const t0 = performance.now()
let peakSeen = 0
const poll = setInterval(() => (peakSeen = Math.max(peakSeen, service.pendingBytes)), 5)
manager.startAll()
while (!(manager.status()[0].lastFinished && index.stats(acc.id).bodies === N)) await sleep(50)
const downloaded = performance.now() - t0
while (service.pendingBytes || service.current) await sleep(50)
clearInterval(poll)
h.disable()
const total = performance.now() - t0
let hidden = 0
let visible = 0
for (let i = 0; i < N; i++) {
  hidden += index.search({ query: `rejtett${i}q` }).length
  visible += index.search({ query: `latszo${i}q` }).length
}
await manager.stopAll()
refiner.stop()
if (server) await server.close()
fs.rmSync(work, { recursive: true, force: true })
const peak = Math.max(service.peakPendingBytes, peakSeen)
const ok = values.old ? true : peak <= MAX_PENDING_BYTES && hidden === 0 && visible === N
console.log(`${imap ? 'IMAP sync' : 'POP3 download'}${values.old ? ' (old code)' : ''}: ${N} messages, ${(bytes / 1024 / 1024).toFixed(1)} MB; downloaded and indexed (old text) in ${(downloaded / 1000).toFixed(1)} s, visible text done in ${(total / 1000).toFixed(1)} s`)
console.log(`peak waiting bytes ${(peak / 1024 / 1024).toFixed(2)} MB (bound ${MAX_PENDING_BYTES / 1024 / 1024} MB); event loop max ${(h.max / 1e6).toFixed(0)} ms`)
console.log(`hidden words found: ${hidden} (want 0); visible words found: ${visible} (want ${N})`)
console.log(ok ? 'OK' : 'FAIL')
process.exit(ok ? 0 : 1)
