// "Küldés később" end to end without the window: a real Composer (POP3 account, local Drafts / Sent, the sealed store)
// and the scheduler (app/main/scheduler.js) with a given clock and send. Scheduling stores a sealed payload and takes
// the draft out of Drafts; the scheduler sends at the time, once, through the composer's own path (the Sent copy);
// temporary errors retry 1 / 5 / 15 minutes without making drafts, permanent ones fail; at start an interrupted row is
// never sent again and a row more than a day late waits for the user; the lock stops it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { memoryIndex, addAccount, sealedStore } from './helpers/fixtures.js'
import { tempDir } from './helpers/tmp.js'
import { Composer } from '../app/main/compose.js'
import { Contacts } from '../core/db/contacts.js'
import { People } from '../core/db/people.js'
import { Scheduled, RETRY_DELAYS_MS, LATE_LIMIT_MS } from '../core/db/scheduled.js'
import { createScheduler } from '../app/main/scheduler.js'

const NOW = Date.UTC(2026, 10, 18, 9)
const MIN = 60_000

function setup(t, { smtp = 'jelszo' } = {}) {
  const { db, index } = memoryIndex(t)
  const row = addAccount(db, { type: 'pop3', email: 'sajat@example.invalid', display_name: 'Saját' })
  index.ensureLocalFolders(row.id, [{ path: 'INBOX' }, { path: 'Sent', specialUse: '\\Sent' }, { path: 'Drafts', specialUse: '\\Drafts' }, { path: 'Trash', specialUse: '\\Trash' }])
  const store = { list: () => db.prepare('SELECT * FROM accounts').all(), getRow: id => db.prepare('SELECT * FROM accounts WHERE id = ?').get(id), passwordsFor: () => ({ smtp: s.smtp }), signatureImage: () => null }
  const storeDir = path.join(tempDir(t), 'store')
  const clock = { now: NOW }
  const scheduled = new Scheduled(db)
  const sent = []
  const s = {
    smtp,
    sendError: null,
    send: async m => {
      if (s.sendError) throw s.sendError
      sent.push(m)
      return { rejected: [] }
    },
  }
  const people = new People(db, { now: () => clock.now })
  const composer = new Composer({ index, store, contacts: new Contacts(db, { people }), storeDir, sealed: sealedStore(storeDir), withConnection: async () => assert.fail('POP3: no connection'), now: () => clock.now, send: m => s.send(m), scheduled })
  const notices = []
  const scheduler = createScheduler({ scheduled, composer, now: () => clock.now, notify: n => notices.push(n), setTimer: () => 0, clearTimer: () => {} })
  const folder = name => db.prepare('SELECT subject FROM messages WHERE account_id = ? AND folder = ?').all(row.id, name).map(r => r.subject)
  const form = (over = {}) => ({ accountId: row.id, to: 'Anna <anna@example.invalid>', cc: '', bcc: '', subject: 'Időzített', html: '<p>Szia Anna</p>', inReplyTo: null, references: [], ...over })
  return Object.assign(s, { db, index, row, storeDir, clock, scheduled, sent, composer, scheduler, notices, folder, form, people })
}

test('schedule: a sealed payload (no plain text on disk), the row, the draft out of Drafts, the session done; the time limits', async t => {
  const s = setup(t)
  const sid = s.composer.open()
  await s.composer.saveDraft(sid, s.form())
  assert.deepEqual(s.folder('Drafts'), ['Időzített'])
  const r = await s.composer.schedule(sid, s.form({ html: '<p>TITKOS-SZOVEG</p>' }), NOW + 10 * MIN)
  assert.equal(r.scheduled, true)
  assert.deepEqual(s.folder('Drafts'), [], 'the draft went from Drafts')
  const row = s.scheduled.get(r.id)
  assert.deepEqual([row.state, row.send_at, row.subject, row.recipients, row.claude], ['waiting', NOW + 10 * MIN, 'Időzített', 'anna@example.invalid', 0])
  const file = path.join(s.storeDir, row.payload_path)
  assert.ok(fs.existsSync(file))
  assert.ok(!fs.readFileSync(file).includes('TITKOS-SZOVEG'), 'sealed, not plain')
  await assert.rejects(s.composer.saveDraft(sid, s.form()), { code: 'already_sent' })
  assert.equal(s.sent.length, 0, 'nothing went out')
  for (const [at, code] of [[NOW + 30_000, 'too_soon'], [NOW + 400 * 24 * 60 * MIN, 'too_far']]) {
    const x = s.composer.open()
    await assert.rejects(s.composer.schedule(x, s.form(), at), { code })
  }
  const empty = s.composer.open()
  await assert.rejects(s.composer.schedule(empty, s.form({ to: '' }), NOW + 10 * MIN), { code: 'no_recipients' })
  assert.equal(s.scheduled.list().length, 1)
})

test('the scheduler sends at the time, once, through the composer (Sent copy, attachments byte for byte); the row and its file go; the notice says how late', async t => {
  const s = setup(t)
  const sid = s.composer.open()
  const att = path.join(tempDir(t), 'melléklet.bin')
  const bytes = crypto.randomBytes(5000)
  fs.writeFileSync(att, bytes)
  s.composer.addFiles(sid, [att])
  const { id } = await s.composer.schedule(sid, s.form(), NOW + 10 * MIN)
  s.composer.close(sid) // the window closes after scheduling
  const rel = s.scheduled.get(id).payload_path
  s.scheduler.start()
  await s.scheduler.tick()
  assert.equal(s.sent.length, 0, 'not before its time')
  s.clock.now = NOW + 12 * MIN
  await s.scheduler.tick()
  await s.scheduler.tick()
  assert.equal(s.sent.length, 1, 'once')
  assert.ok(s.sent[0].raw.includes(bytes.toString('base64').slice(0, 76)), 'the attachment')
  assert.deepEqual(s.folder('Sent'), ['Időzített'])
  assert.equal(s.scheduled.get(id), null)
  assert.ok(!fs.existsSync(path.join(s.storeDir, rel)), 'the payload file went')
  assert.deepEqual(s.notices.map(n => [n.event, n.id, n.lateMs]), [['sent', id, 2 * MIN]])
  assert.equal(s.composer.sessions.size, 0)
})

test('a temporary error: retries after 1, 5, 15 minutes without a draft, then failed with a notice; a permanent one (no SMTP password) fails at once', async t => {
  const s = setup(t)
  const { id } = await s.composer.schedule(s.composer.open(), s.form(), NOW + 2 * MIN)
  s.sendError = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
  s.scheduler.start()
  let at = NOW + 2 * MIN
  s.clock.now = at
  await s.scheduler.tick()
  for (const d of RETRY_DELAYS_MS) {
    assert.equal(s.scheduled.get(id).state, 'waiting')
    s.clock.now = at + d - 1
    await s.scheduler.tick()
    assert.equal(s.scheduled.get(id).attempts, RETRY_DELAYS_MS.indexOf(d) + 1, 'not before the retry time')
    at += d
    s.clock.now = at
    await s.scheduler.tick()
  }
  assert.deepEqual([s.scheduled.get(id).state, s.scheduled.get(id).attempts], ['failed', 4])
  assert.deepEqual(s.folder('Drafts'), [], 'no draft from the tries')
  assert.deepEqual(s.notices.map(n => n.event), ['retry', 'retry', 'retry', 'failed'])
  s.sendError = null
  s.clock.now += 60 * MIN
  await s.scheduler.tick()
  assert.equal(s.sent.length, 0, 'a failed row is not sent on its own')

  const p = setup(t, { smtp: null })
  const r = await p.composer.schedule(p.composer.open(), p.form(), NOW + 2 * MIN)
  p.scheduler.start()
  p.clock.now = NOW + 3 * MIN
  await p.scheduler.tick()
  assert.deepEqual([p.scheduled.get(r.id).state, p.scheduled.get(r.id).last_error, p.scheduled.get(r.id).attempts], ['failed', 'no_password', 1])
})

test('at start: a row left sending fails (never sent again); more than a day late waits as late; within the day it goes now, the notice says how late', async t => {
  const s = setup(t)
  const a = (await s.composer.schedule(s.composer.open(), s.form({ subject: 'Megszakadt' }), NOW + 2 * MIN)).id
  const b = (await s.composer.schedule(s.composer.open(), s.form({ subject: 'Regi' }), NOW + 3 * MIN)).id
  const c = (await s.composer.schedule(s.composer.open(), s.form({ subject: 'Friss' }), NOW + 4 * MIN)).id
  s.scheduled.begin(a) // the app stopped while sending it
  s.clock.now = NOW + 3 * MIN + LATE_LIMIT_MS + MIN // the app was not running for a day
  s.scheduled.db.prepare('UPDATE scheduled SET send_at = ? WHERE id = ?').run(s.clock.now - LATE_LIMIT_MS + 30 * MIN, c)
  s.scheduler.start()
  await s.scheduler.tick()
  assert.deepEqual([s.scheduled.get(a).state, s.scheduled.get(a).last_error], ['failed', 'interrupted'])
  assert.equal(s.scheduled.get(b).state, 'late')
  assert.equal(s.scheduled.get(c), null, 'within the day: sent')
  assert.deepEqual(s.sent.map(m => m.raw.toString().match(/^Subject: (.*)$/m)[1].trim()), ['Friss'])
  assert.deepEqual(s.notices.map(n => n.event).sort(), ['interrupted', 'late', 'sent'])
  assert.ok(s.notices.find(n => n.event === 'sent').lateMs > LATE_LIMIT_MS - 31 * MIN)
})

test('unscheduleToDraft: back into Drafts, the row and its file go; the lock stops the scheduler before the time', async t => {
  const s = setup(t)
  const w = s.composer.open()
  const { id } = await s.composer.schedule(w, s.form({ subject: 'Vissza' }), NOW + 5 * MIN)
  s.composer.close(w)
  const rel = s.scheduled.get(id).payload_path
  await s.composer.unscheduleToDraft(id)
  assert.deepEqual(s.folder('Drafts'), ['Vissza'])
  assert.equal(s.scheduled.get(id), null)
  assert.ok(!fs.existsSync(path.join(s.storeDir, rel)))
  assert.equal(s.composer.sessions.size, 0)

  const k = (await s.composer.schedule(s.composer.open(), s.form({ subject: 'Zarolt' }), NOW + 5 * MIN)).id
  s.scheduler.start()
  await s.scheduler.stop()
  s.clock.now = NOW + 6 * MIN
  await s.scheduler.tick()
  assert.equal(s.sent.length, 0, 'stopped: nothing sent')
  assert.equal(s.scheduled.get(k).state, 'waiting')
})

test('Claude\'s scheduled message does not add its recipients to the address book; the user\'s does, a Claude draft the user scheduled too', async t => {
  const s = setup(t)
  const c = s.composer.open()
  s.composer.markClaude(c)
  await s.composer.schedule(c, s.form({ to: 'claude-cimzett@example.invalid', subject: 'C' }), NOW + 2 * MIN, { byClaude: true })
  await s.composer.schedule(s.composer.open(), s.form({ to: 'sajat-cimzett@example.invalid', subject: 'U' }), NOW + 2 * MIN)
  // a draft of Claude's origin, scheduled by the user in the composer: the user's
  const d = s.composer.open()
  s.composer.markClaude(d)
  await s.composer.schedule(d, s.form({ to: 'piszkozat-cimzett@example.invalid', subject: 'D' }), NOW + 2 * MIN)
  assert.deepEqual(s.scheduled.list().map(r => [r.subject, r.claude]), [['C', 1], ['U', 0], ['D', 0]])
  s.scheduler.start()
  s.clock.now = NOW + 3 * MIN
  await s.scheduler.tick()
  assert.equal(s.sent.length, 3)
  assert.deepEqual(s.people.unknownOf(['claude-cimzett@example.invalid', 'sajat-cimzett@example.invalid', 'piszkozat-cimzett@example.invalid']), ['claude-cimzett@example.invalid'])
})

test('the computer slept with the app unlocked: at the send, more than a day past its time it waits as late (a retry too); within the day it goes', async t => {
  const s = setup(t)
  const a = (await s.composer.schedule(s.composer.open(), s.form({ subject: 'Alvas' }), NOW + 2 * MIN)).id
  s.scheduler.start() // started before its time: nothing settled
  await s.scheduler.tick()
  assert.equal(s.scheduled.get(a).state, 'waiting')
  s.clock.now = NOW + 2 * MIN + 2 * LATE_LIMIT_MS // two days asleep, the scheduler's timer fires on waking
  await s.scheduler.tick()
  assert.equal(s.sent.length, 0, 'not sent')
  assert.equal(s.scheduled.get(a).state, 'late')
  assert.deepEqual(s.notices.map(n => [n.event, n.id]), [['late', a]])
  assert.ok(s.notices[0].lateMs >= 2 * LATE_LIMIT_MS)
  // a retry (the first try failed) slept past a day: late too, its time is still the user's
  const b = (await s.composer.schedule(s.composer.open(), s.form({ subject: 'Ujra' }), s.clock.now + 2 * MIN)).id
  s.sendError = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
  s.clock.now += 2 * MIN
  await s.scheduler.tick()
  assert.deepEqual([s.scheduled.get(b).state, s.scheduled.get(b).attempts], ['waiting', 1])
  s.sendError = null
  s.clock.now += LATE_LIMIT_MS + MIN
  await s.scheduler.tick()
  assert.equal(s.scheduled.get(b).state, 'late')
  assert.equal(s.sent.length, 0)
  // within the day after a short sleep: sent
  const c = (await s.composer.schedule(s.composer.open(), s.form({ subject: 'Rovid' }), s.clock.now + 2 * MIN)).id
  s.clock.now += LATE_LIMIT_MS - MIN
  await s.scheduler.tick()
  assert.equal(s.scheduled.get(c), null)
  assert.equal(s.sent.length, 1)
})

test('an error after the whole message was handed over: uncertain, no retry on its own, the notice says so; Küldés most sends it again', async t => {
  const s = setup(t)
  const { id } = await s.composer.schedule(s.composer.open(), s.form({ subject: 'Bizonytalan' }), NOW + 2 * MIN)
  s.sendError = Object.assign(new Error('Timeout'), { code: 'ETIMEDOUT', afterData: true })
  s.scheduler.start()
  s.clock.now = NOW + 3 * MIN
  await s.scheduler.tick()
  const row = s.scheduled.get(id)
  assert.deepEqual([row.state, row.last_error, row.attempts, row.next_try_at], ['failed', 'uncertain', 1, null])
  assert.deepEqual(s.notices.map(n => [n.event, n.id]), [['uncertain', id]])
  assert.deepEqual(s.folder('Drafts'), [], 'no draft')
  s.sendError = null
  for (const m of [1, 5, 15, 60, 24 * 60]) {
    s.clock.now = NOW + 3 * MIN + m * MIN
    await s.scheduler.tick()
  }
  assert.equal(s.sent.length, 0, 'never again on its own')
  // the same error before the data: a retry
  const b = (await s.composer.schedule(s.composer.open(), s.form({ subject: 'Elotte' }), s.clock.now + 2 * MIN)).id
  s.sendError = Object.assign(new Error('Timeout'), { code: 'ETIMEDOUT' })
  s.clock.now += 3 * MIN
  await s.scheduler.tick()
  assert.deepEqual([s.scheduled.get(b).state, s.scheduled.get(b).attempts], ['waiting', 1])
  s.sendError = null
  // the user's Küldés most: the row due now, sent once
  assert.equal(s.scheduled.reschedule(id, s.clock.now), true)
  await s.scheduler.tick()
  assert.equal(s.scheduled.get(id), null)
})

test('real SMTP: the server takes the whole message and never answers; one try, uncertain, the server holds one copy after an hour', async t => {
  const { SMTPServer } = await import('smtp-server')
  const { sendRaw } = await import('../core/smtp/send.js')
  const got = []
  const srv = new SMTPServer({
    disabledCommands: ['STARTTLS'], allowInsecureAuth: true, authMethods: ['PLAIN', 'LOGIN'], logger: false,
    onAuth: (a, _s, cb) => cb(null, { user: a.username }),
    onData(stream, _session, _cb) {
      const chunks = []
      stream.on('data', c => chunks.push(c))
      stream.on('end', () => got.push(Buffer.concat(chunks))) // never answered
    },
  })
  srv.on('error', () => {})
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  t.after(() => new Promise(r => srv.close(r)))
  const s = setup(t)
  s.db.prepare("UPDATE accounts SET smtp_host = '127.0.0.1', smtp_port = ?, smtp_security = 'none' WHERE id = ?").run(srv.server.address().port, s.row.id)
  s.send = args => sendRaw({ ...args, timeoutMs: 1000 })
  const { id } = await s.composer.schedule(s.composer.open(), s.form({ subject: 'Valodi' }), NOW + 2 * MIN)
  s.scheduler.start()
  s.clock.now = NOW + 3 * MIN
  await s.scheduler.tick()
  assert.deepEqual([s.scheduled.get(id).state, s.scheduled.get(id).last_error], ['failed', 'uncertain'])
  for (const m of [1, 5, 15, 60]) {
    s.clock.now = NOW + 3 * MIN + m * MIN
    await s.scheduler.tick()
  }
  assert.equal(got.length, 1, 'one copy on the server')
})

test('a lock while a send is under way: stop() waits for it, the row is recorded; closed under it, no unhandled error (the row stays sending: the next unlock settles it as interrupted)', async t => {
  const unhandled = []
  const onUnhandled = e => unhandled.push(e)
  process.on('unhandledRejection', onUnhandled)
  t.after(() => process.off('unhandledRejection', onUnhandled))
  // finishes within the wait: recorded
  const s = setup(t)
  const { id } = await s.composer.schedule(s.composer.open(), s.form({ subject: 'Fut' }), NOW + 2 * MIN)
  let release
  const gate = new Promise(r => (release = r))
  const plain = s.send
  s.send = async m => (await gate, plain(m))
  s.scheduler.start()
  s.clock.now = NOW + 3 * MIN
  const ticking = s.scheduler.tick()
  await new Promise(r => setImmediate(r))
  assert.equal(s.scheduled.get(id).state, 'sending')
  const stopped = s.scheduler.stop()
  release()
  await stopped
  assert.equal(s.scheduled.get(id), null, 'when stop() settles, the send is recorded (the lock waits for it)')
  await ticking
  assert.equal(s.sent.length, 1)
  // the database closed under a send (it ran past the wait): handled, the row left 'sending' for the next unlock
  const k = setup(t)
  const r = await k.composer.schedule(k.composer.open(), k.form({ subject: 'Zarva' }), NOW + 2 * MIN)
  let release2
  const gate2 = new Promise(x => (release2 = x))
  const plain2 = k.send
  k.send = async m => (await gate2, plain2(m))
  const logged = []
  const sched = createScheduler({ scheduled: k.scheduled, composer: k.composer, now: () => k.clock.now, log: l => logged.push(l), setTimer: () => 0, clearTimer: () => {} })
  sched.start()
  k.clock.now = NOW + 3 * MIN
  const run = sched.tick()
  await new Promise(x => setImmediate(x))
  sched.stop()
  k.db.close()
  release2()
  await run
  await new Promise(x => setTimeout(x, 50))
  assert.deepEqual(unhandled, [], 'no unhandled rejection')
  assert.ok(logged.some(l => new RegExp(`^scheduled ${r.id} not recorded`).test(l)), logged.join(' | '))
})
