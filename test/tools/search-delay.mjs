#!/usr/bin/env node
// The main thread's event loop delay during the IMAP sync and the open of the
// 404 KB newsletter, the old code against the worker, without an order or a load bias: every run is its own process
// (the same warm-up), the modes alternate. Not part of `npm test` (its test files run in parallel and load the CPU).
//
//   node test/tools/search-delay.mjs [--runs 8]               (the parent: spawns the runs, prints the medians)
//   node test/tools/search-delay.mjs --one old|worker         (one run: prints { syncMaxMs, openMs, maxMs })
// The conditions: sync event loop max <= 50 ms with the worker; open: not worse than the old code.
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { monitorEventLoopDelay } from 'node:perf_hooks'

const { values } = parseArgs({ options: { runs: { type: 'string', default: '6' }, one: { type: 'string' } } })
const self = fileURLToPath(import.meta.url)

if (!values.one) {
  const out = { old: [], worker: [] }
  for (let i = 0; i < Number(values.runs); i++) {
    for (const mode of i % 2 ? ['worker', 'old'] : ['old', 'worker']) {
      const r = spawnSync(process.execPath, [self, '--one', mode], { encoding: 'utf8', timeout: 120_000 })
      const line = r.stdout.split('\n').find(l => l.startsWith('{'))
      if (!line) {
        console.log(`${mode} failed: ${r.stderr.slice(-400)}`)
        process.exit(1)
      }
      out[mode].push(JSON.parse(line))
    }
  }
  const med = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]
  for (const mode of ['old', 'worker']) {
    const col = k => out[mode].map(x => x[k])
    console.log(`${mode}: sync event loop max ${col('syncMaxMs').join('/')} ms (median ${med(col('syncMaxMs'))}, max ${Math.max(...col('syncMaxMs'))}); open ${col('openMs').join('/')} ms (median ${med(col('openMs'))}), open event loop max ${col('maxMs').join('/')} ms (median ${med(col('maxMs'))})`)
  }
  console.log(`node=${process.version} platform=${process.platform}`)
  process.exit(0)
}

const repo = path.resolve(path.dirname(self), '..', '..')
// a file URL: an absolute Windows path is not an ESM specifier
const imp = p => import(pathToFileURL(path.join(repo, p)).href)
const { openMailDatabase } = await imp('core/db/index.js')
const { MailIndex } = await imp('core/db/mail-index.js')
const { SealedStore } = await imp('core/store/sealed-file.js')
const { SyncManager } = await imp('app/main/sync-manager.js')
const { MessageReader } = await imp('app/main/reader.js')
const { openSettings } = await imp('app/main/settings.js')
const { SearchTextService } = await imp('core/mime/search-text-service.js')
const { createSearchRefiner } = await imp('app/main/search-index.js')
const { FakeImapServer } = await imp('test/helpers/fake-imap.js')
const { addAccount } = await imp('test/helpers/fixtures.js')
const { newsletterEml } = await imp('test/helpers/newsletter.js')
const os = await import('node:os')
const fs = await import('node:fs')
const crypto = await import('node:crypto')

const sleep = ms => new Promise(r => setTimeout(r, ms))
const { db } = openMailDatabase(':memory:')
const index = new MailIndex(db)
const row = addAccount(db, { name: 'IMAP' })
const imap = new FakeImapServer().addMailbox('INBOX')
const now = Date.UTC(2026, 10, 12, 9)
imap.addMessage('INBOX', { from: 'a@example.invalid', to: 's@example.invalid', subject: 'Warm', messageId: '<w@x>', date: now - 2000, body: '', source: newsletterEml({ subject: 'Warm', hidden: 'warmh', visible: 'warmv' }) })
const store = { list: () => db.prepare('SELECT * FROM accounts').all(), getRow: id => db.prepare('SELECT * FROM accounts WHERE id = ?').get(id), passwordsFor: () => ({ incoming: 'x' }) }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-open-'))
const sealed = new SealedStore(dir, crypto.randomBytes(32))
const OLD = { refineMany: async () => {}, refine: async () => {} }
const svc = values.one === 'worker' ? new SearchTextService() : null
const refiner = svc ? createSearchRefiner({ service: svc, index, settings: openSettings(db), sealed }) : OLD
// mailparser's first parse compiles its code: warmed up as in a running app
await (await import('mailparser')).simpleParser(newsletterEml({ blocks: 50 }))
const manager = new SyncManager({ store, index, sealed, connect: async () => imap.connect(), now: () => now, throttleMs: 5, searchText: refiner })
// the first sync (the Warm newsletter) warms the sync's code up, as in a running app; not measured
manager.startAll()
while (!(manager.status()[0].lastFinished && index.stats(row.id).bodies >= 1)) await sleep(20)
while (svc && (svc.pendingBytes || svc.current)) await sleep(20)
await sleep(100)
// the measured one: a new newsletter arrives, a sync of the INBOX (as after an IDLE event)
imap.addMessage('INBOX', { from: 'a@example.invalid', to: 's@example.invalid', subject: 'Hirlevel', messageId: '<n@x>', date: now - 1000, body: '', source: newsletterEml({ subject: 'Hirlevel' }) })
const hs = monitorEventLoopDelay({ resolution: 5 })
hs.enable()
await manager.syncNow(row.id)
while (!(index.stats(row.id).bodies >= 2)) await sleep(20)
while (svc && (svc.pendingBytes || svc.current)) await sleep(20)
await sleep(50)
hs.disable()
const syncMaxMs = Math.round(hs.max / 1e6)
// the open: a row indexed by the old rule (an IMAP message from before the visible text)
db.prepare("UPDATE messages_fts SET body = 'regi' WHERE rowid IN (SELECT id FROM messages)").run()
const reader = new MessageReader({ index, sealed, withConnection: (id, fn) => manager.withConnection(id, fn), searchText: refiner })
const idOf = s => db.prepare('SELECT id FROM messages WHERE subject = ?').get(s).id
// the same warm-up for both: an open of another newsletter, its worker work finished
await reader.open(idOf('Warm'))
while (svc && (svc.pendingBytes || svc.current)) await sleep(20)
await sleep(100)
const h = monitorEventLoopDelay({ resolution: 5 })
h.enable()
const t0 = performance.now()
await reader.open(idOf('Hirlevel'))
const openMs = performance.now() - t0
await sleep(50)
h.disable()
console.log(JSON.stringify({ syncMaxMs, openMs: Math.round(openMs), maxMs: Math.round(h.max / 1e6) }))
while (svc && (svc.pendingBytes || svc.current)) await sleep(20)
if (refiner.stop) refiner.stop()
await manager.stopAll()
fs.rmSync(dir, { recursive: true, force: true })
process.exit(0)
