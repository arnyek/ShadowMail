#!/usr/bin/env node
// Search measurements (not part of npm test):
//   1. one-word search on 50 000 indexed messages (file database, realistic text), through the same
//      IPC handler the app uses (search:local, with the header-only count); goal: < 300 ms
//   2. the POP3 old-text search over 5000 generated .eml files: total time, progress events,
//      event-loop delay while it runs (the app stays usable), cancel latency (goal: < 2 s)
//
//   node test/tools/search-bench.mjs [--messages 50000] [--files 5000]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { openMailDatabase } from '../../core/db/index.js'
import { MailIndex } from '../../core/db/mail-index.js'
import { registerSearchIpc } from '../../app/main/ipc/search.js'
import { searchOldPop3 } from '../../core/pop3/local-search.js'

const { values } = parseArgs({ options: { messages: { type: 'string', default: '50000' }, files: { type: 'string', default: '5000' } } })
const N = Number(values.messages)
const F = Number(values.files)
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-k11-bench-'))
const DAY = 86_400_000
const now = Date.now()

// a deterministic vocabulary: Hungarian business words + filler, so FTS has realistic posting lists
const vocab = ('ajánlat számla egyeztetés kazán karbantartás szerződés időpont hírlevél rendelés visszaigazolás ' +
  'szállítás garancia alkatrész szerviz ügyfél határidő fizetés átutalás díjbekérő árajánlat telepítés beüzemelés ' +
  'hőszivattyú radiátor termosztát kémény gázszerelő tervezés engedély műszaki átadás jegyzőkönyv').split(' ')
// mulberry32: integer-exact (a float LCG loses precision and collapses to 0)
let seed = 42
const rnd = n => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) % n
}
const filler = Array.from({ length: 2000 }, (_, i) => `szo${i.toString(36)}`)
const text = len => Array.from({ length: len }, () => (rnd(4) ? filler[rnd(filler.length)] : vocab[rnd(vocab.length)])).join(' ')

const { db } = openMailDatabase(path.join(work, 'mail.sqlite'))
const index = new MailIndex(db)
const acc = db.prepare(`INSERT INTO accounts (name, email, type, in_host, in_port, in_security, in_user, created_at) VALUES ('Mérő', 'm@x.invalid', 'imap', 'h', 1, 'tls', 'u', 0)`).run().lastInsertRowid
const pop = db.prepare(`INSERT INTO accounts (name, email, type, in_host, in_port, in_security, in_user, created_at) VALUES ('POP3', 'p@x.invalid', 'pop3', 'h', 1, 'tls', 'u', 0)`).run().lastInsertRowid
index.upsertFolder({ account_id: Number(acc), path: 'INBOX', uidvalidity: '1' })

let t0 = performance.now()
const BATCH = 5000
for (let b = 0; b < N; b += BATCH) {
  const rows = []
  for (let i = b; i < Math.min(N, b + BATCH); i++) {
    rows.push({
      account_id: Number(acc), folder: 'INBOX', uid: i + 1, message_id: `<b${i}@x>`, in_reply_to: null, refs: null,
      from_addr: `f${i % 300}@example.invalid`, from_name: `Feladó ${i % 300}`, to_addrs: 'm@x.invalid', cc_addrs: '',
      subject: text(6), date: now - i * 600_000, idate: now - i * 600_000, flags: i % 3 ? '\\Seen' : '', size: 4000,
      has_attachments: i % 7 === 0 ? 1 : 0, attachments: null, body_state: 0, sender_text: `f${i % 300}@example.invalid`, recipients_text: 'm@x.invalid',
    })
  }
  index.insertMany(rows)
  const items = rows.map(r => ({ id: index.getByUid(Number(acc), 'INBOX', r.uid).id, text: text(150), state: 1, preview: null }))
  index.setBodies(items)
}
db.prepare("INSERT INTO messages_fts(messages_fts) VALUES ('optimize')").run()
console.log(`seeded ${N} indexed messages in ${Math.round(performance.now() - t0)} ms`)

const handlers = new Map()
const store = { list: () => db.prepare('SELECT * FROM accounts ORDER BY id').all(), getRow: id => db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) }
registerSearchIpc({ ipcMain: { handle: (c, fn) => handlers.set(c, fn) }, db, index, store, manager: null, storeDir: path.join(work, 'store'), notify: () => {}, isTrustedSender: () => true })
const local = q => handlers.get('search:local')({}, q)

const median = xs => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]
for (const [label, q] of [
  ['common word "számla"', { query: 'számla' }],
  ['accent-free "szamla"', { query: 'szamla' }],
  ['rare word "jegyzőkönyv"', { query: 'jegyzokonyv' }],
  ['filler word', { query: filler[17] }],
  ['two words', { query: 'kazán garancia' }],
  ['date order', { query: 'számla', sort: 'date' }],
  ['with unread + attachment filter', { query: 'számla', unread: true, hasAttachment: true }],
]) {
  const times = []
  let res
  for (let i = 0; i < 9; i++) {
    const s = performance.now()
    res = await local(q)
    times.push(performance.now() - s)
  }
  console.log(`search:local ${label}: median ${median(times).toFixed(1)} ms, max ${Math.max(...times).toFixed(1)} ms, rows ${res.rows.length}${res.truncated ? ' (capped)' : ''}`)
}

// POP3 old text: F generated files, every one beyond the limit
const storeDir = path.join(work, 'store')
fs.mkdirSync(path.join(storeDir, String(pop)), { recursive: true })
t0 = performance.now()
const prows = []
for (let i = 0; i < F; i++) {
  const rel = `${pop}/pop3-${i}.eml`
  const body = `${text(200)}${i === F - 10 ? ' egyedivarazsszo' : ''}`
  fs.writeFileSync(path.join(storeDir, rel), `From: a@x.invalid\r\nTo: p@x.invalid\r\nSubject: régi ${i}\r\nDate: ${new Date(now - 5 * 365 * DAY - i * DAY).toUTCString()}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${body}\r\n`)
  prows.push({ account_id: Number(pop), folder: 'INBOX', uid: null, pop3_uidl: `u${i}`, message_id: `<p${i}@x>`, in_reply_to: null, refs: null,
    from_addr: 'a@x.invalid', from_name: '', to_addrs: '', cc_addrs: '', subject: `régi ${i}`, date: now - 5 * 365 * DAY - i * DAY, idate: now - 5 * 365 * DAY - i * DAY,
    flags: '\\Seen', size: 2000, has_attachments: 0, attachments: null, store_path: rel, body_state: 3, sender_text: '', recipients_text: '' })
}
index.insertMany(prows)
console.log(`wrote ${F} POP3 files in ${Math.round(performance.now() - t0)} ms`)

async function pop3Run(cancelAtFraction = null) {
  const controller = new AbortController()
  let progressEvents = 0
  let maxLag = 0
  let lastTick = performance.now()
  const lagTimer = setInterval(() => {
    const t = performance.now()
    maxLag = Math.max(maxLag, t - lastTick - 20)
    lastTick = t
  }, 20)
  let cancelAt = null
  const start = performance.now()
  const res = await searchOldPop3({
    db, storeDir, accountIds: [Number(pop)], query: 'egyedivarazsszo', signal: controller.signal,
    onProgress: p => {
      progressEvents++
      if (cancelAtFraction !== null && !cancelAt && p.done >= p.total * cancelAtFraction) {
        cancelAt = performance.now()
        controller.abort()
      }
    },
  })
  const end = performance.now()
  clearInterval(lagTimer)
  return { ...res, ms: end - start, progressEvents, maxLag, cancelLatency: cancelAt ? end - cancelAt : null }
}
const full = await pop3Run()
console.log(`pop3Old full: ${full.done}/${full.total} files in ${Math.round(full.ms)} ms, hits ${full.hits}, skipped ${full.skipped}, progress events ${full.progressEvents}, max event-loop delay ${full.maxLag.toFixed(1)} ms`)
const cut = await pop3Run(0.5)
console.log(`pop3Old cancelled at 50%: stopped after ${cut.done}/${cut.total}, cancel latency ${cut.cancelLatency.toFixed(1)} ms`)

db.close()
fs.rmSync(work, { recursive: true, force: true })
