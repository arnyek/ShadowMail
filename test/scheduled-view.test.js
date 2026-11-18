// "Küldés később", the "Időzített" list without the window: a real Composer (POP3 account, local Drafts / Sent, the
// sealed store), the scheduler with a given clock and send, and the list's IPC (app/main/ipc/scheduled.js) on a fake
// ipcMain. A scheduled message opened in a composer saves into the scheduled row (not Drafts), is not sent by the
// scheduler while open, and a send / a new schedule / Elvetés replaces or removes the row; closing leaves it. The list's
// actions: Időpont módosítása, Küldés most, Időzítés törlése (back to Drafts); a row open in a composer or being sent
// is not touched; only the main window may call them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { memoryIndex, addAccount, sealedStore } from './helpers/fixtures.js'
import { tempDir } from './helpers/tmp.js'
import { Composer } from '../app/main/compose.js'
import { Contacts } from '../core/db/contacts.js'
import { People } from '../core/db/people.js'
import { Scheduled } from '../core/db/scheduled.js'
import { createScheduler } from '../app/main/scheduler.js'
import { registerScheduledIpc, SCHEDULED_CHANNELS, scheduledView } from '../app/main/ipc/scheduled.js'

const NOW = Date.UTC(2026, 10, 18, 9)
const MIN = 60_000
const MAIN = { main: true }
const OTHER = { main: false }

function setup(t) {
  const { db, index } = memoryIndex(t)
  const row = addAccount(db, { type: 'pop3', name: 'Munka', email: 'sajat@example.invalid', display_name: 'Saját' })
  index.ensureLocalFolders(row.id, [{ path: 'INBOX' }, { path: 'Sent', specialUse: '\\Sent' }, { path: 'Drafts', specialUse: '\\Drafts' }, { path: 'Trash', specialUse: '\\Trash' }])
  const store = { list: () => db.prepare('SELECT * FROM accounts').all(), getRow: id => db.prepare('SELECT * FROM accounts WHERE id = ?').get(id), passwordsFor: () => ({ smtp: 'jelszo' }), signatureImage: () => null }
  const storeDir = path.join(tempDir(t), 'store')
  const clock = { now: NOW }
  const scheduled = new Scheduled(db)
  const sent = []
  const changes = []
  const s = { sendError: null }
  const people = new People(db, { now: () => clock.now })
  const composer = new Composer({
    index, store, contacts: new Contacts(db, { people }), storeDir, sealed: sealedStore(storeDir), scheduled,
    withConnection: async () => assert.fail('POP3: no connection'), now: () => clock.now,
    send: async m => {
      if (s.sendError) throw s.sendError
      sent.push(m)
      return { rejected: [] }
    },
    onScheduledChange: () => changes.push('composer'),
  })
  const scheduler = createScheduler({ scheduled, composer, now: () => clock.now, setTimer: () => 0, clearTimer: () => {} })
  const handlers = new Map()
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) }
  const log = []
  registerScheduledIpc({ ipcMain, scheduled, composer, store, isMainSender: e => e.main === true, now: () => clock.now, onChanged: () => changes.push('ipc'), log: l => log.push(l) })
  const call = (channel, ...args) => handlers.get(channel)(MAIN, ...args)
  const folder = name => db.prepare('SELECT subject FROM messages WHERE account_id = ? AND folder = ?').all(row.id, name).map(r => r.subject)
  const form = (over = {}) => ({ accountId: row.id, to: 'Anna <anna@example.invalid>', cc: '', bcc: '', subject: 'Időzített', html: '<p>Szia Anna</p>', inReplyTo: null, references: [], ...over })
  const schedule = async (over = {}, at = NOW + 10 * MIN) => {
    const sid = composer.open()
    const { id } = await composer.schedule(sid, form(over), at)
    composer.close(sid)
    return id
  }
  return Object.assign(s, { db, row, storeDir, clock, scheduled, sent, changes, composer, scheduler, handlers, call, folder, form, schedule, log })
}

test('the channels; only the main window; malformed calls are bad_request and change nothing', async t => {
  const s = setup(t)
  assert.deepEqual([...s.handlers.keys()].sort(), [...SCHEDULED_CHANNELS].sort())
  const id = await s.schedule()
  for (const [channel, ...args] of [['scheduled:list'], ['scheduled:reschedule', id, NOW + 60 * MIN], ['scheduled:sendNow', id], ['scheduled:cancel', id]]) {
    assert.deepEqual(await s.handlers.get(channel)(OTHER, ...args), { ok: false, error: 'untrusted_sender' }, channel)
  }
  for (const [channel, ...args] of [
    ['scheduled:list', 1],
    ['scheduled:reschedule', id],
    ['scheduled:reschedule', String(id), NOW + 60 * MIN],
    ['scheduled:reschedule', id, NOW + 60 * MIN, 'x'],
    ['scheduled:reschedule', id, 1.5],
    ['scheduled:sendNow', 0],
    ['scheduled:sendNow', id, true],
    ['scheduled:cancel', -1],
    ['scheduled:cancel'],
  ]) {
    assert.deepEqual(await s.call(channel, ...args), { ok: false, error: 'bad_request' }, `${channel} ${JSON.stringify(args)}`)
  }
  const row = s.scheduled.get(id)
  assert.deepEqual([row.state, row.send_at], ['waiting', NOW + 10 * MIN])
  assert.deepEqual(s.changes, [], 'nothing changed')
})

test('scheduled:list: every row, the earliest first, with its account, state, Claude mark and whether a composer holds it; no payload', async t => {
  const s = setup(t)
  const later = await s.schedule({ subject: 'Később' }, NOW + 60 * MIN)
  const sooner = await s.schedule({ subject: 'Hamarabb', to: 'Béla <bela@example.invalid>, anna@example.invalid' }, NOW + 5 * MIN)
  const sid = s.composer.open()
  s.composer.openScheduled(sid, later)
  const r = await s.call('scheduled:list')
  assert.equal(r.ok, true)
  assert.deepEqual(r.rows.map(x => [x.id, x.subject, x.held, x.state, x.accountName, x.sendAt]), [
    [sooner, 'Hamarabb', false, 'waiting', 'Munka', NOW + 5 * MIN],
    [later, 'Később', true, 'waiting', 'Munka', NOW + 60 * MIN],
  ])
  assert.equal(r.rows[0].recipients, 'bela@example.invalid, anna@example.invalid')
  assert.ok(!JSON.stringify(r).includes('payload') && !JSON.stringify(r).includes('Szia Anna'), 'no payload, no text')
  assert.deepEqual(Object.keys(scheduledView(s.scheduled.get(sooner))).sort(), ['accountEmail', 'accountId', 'accountName', 'attempts', 'claude', 'held', 'id', 'lastError', 'nextTryAt', 'recipients', 'sendAt', 'state', 'subject'])
})

test('Időpont módosítása: the scheduling limits; a failed or late row waits again with its tries anew; a held or sending row is refused', async t => {
  const s = setup(t)
  const id = await s.schedule()
  assert.deepEqual(await s.call('scheduled:reschedule', id, NOW + 30_000), { ok: false, error: 'too_soon' })
  assert.deepEqual(await s.call('scheduled:reschedule', id, NOW + 400 * 24 * 60 * MIN), { ok: false, error: 'too_far' })
  assert.deepEqual(await s.call('scheduled:reschedule', 999, NOW + 60 * MIN), { ok: false, error: 'not_found' })
  assert.deepEqual(s.changes, [])
  assert.deepEqual(await s.call('scheduled:reschedule', id, NOW + 60 * MIN), { ok: true, id, sendAt: NOW + 60 * MIN })
  assert.deepEqual(s.changes, ['ipc'])
  assert.equal(s.scheduled.get(id).send_at, NOW + 60 * MIN)
  // a failed row
  s.scheduled.failed(id, 'auth_failed', { permanent: true, now: NOW })
  assert.equal(s.scheduled.get(id).state, 'failed')
  assert.equal((await s.call('scheduled:reschedule', id, NOW + 90 * MIN)).ok, true)
  assert.deepEqual([s.scheduled.get(id).state, s.scheduled.get(id).attempts, s.scheduled.get(id).last_error], ['waiting', 0, null])
  // held by a composer
  const sid = s.composer.open()
  s.composer.openScheduled(sid, id)
  assert.deepEqual(await s.call('scheduled:reschedule', id, NOW + 120 * MIN), { ok: false, error: 'scheduled_open' })
  s.composer.close(sid)
  // being sent
  s.scheduled.begin(id)
  assert.deepEqual(await s.call('scheduled:reschedule', id, NOW + 120 * MIN), { ok: false, error: 'scheduled_sending' })
  assert.equal(s.scheduled.get(id).send_at, NOW + 90 * MIN)
})

test('Küldés most: due now, the scheduler sends it once; an interrupted row goes too (the list asked first); held: refused', async t => {
  const s = setup(t)
  const id = await s.schedule({}, NOW + 60 * MIN)
  s.scheduler.start()
  await s.scheduler.tick() // the start's own run
  const sid = s.composer.open()
  s.composer.openScheduled(sid, id)
  assert.deepEqual(await s.call('scheduled:sendNow', id), { ok: false, error: 'scheduled_open' })
  s.composer.close(sid)
  assert.deepEqual(await s.call('scheduled:sendNow', id), { ok: true, id })
  assert.equal(s.scheduled.get(id).send_at, NOW)
  await s.scheduler.tick()
  assert.equal(s.sent.length, 1)
  assert.equal(s.scheduled.get(id), null)
  assert.deepEqual(s.folder('Sent'), ['Időzített'])
  // interrupted: failed + 'interrupted' (settled at start), sent only when the user says so
  const again = await s.schedule({ subject: 'Megszakadt' })
  s.scheduled.begin(again)
  s.scheduler.stop()
  s.scheduler.start() // settles: failed, interrupted
  assert.deepEqual([s.scheduled.get(again).state, s.scheduled.get(again).last_error], ['failed', 'interrupted'])
  await s.scheduler.tick()
  assert.equal(s.sent.length, 1, 'not on its own')
  assert.equal((await s.call('scheduled:sendNow', again)).ok, true)
  await s.scheduler.tick()
  assert.equal(s.sent.length, 2)
})

test('Időzítés törlése: back to Drafts (the attachments and the text), the row and its sealed file go; held, sending or gone: refused', async t => {
  const s = setup(t)
  const sid = s.composer.open()
  const att = path.join(tempDir(t), 'terv.txt')
  fs.writeFileSync(att, 'MELLEKLET-TARTALOM')
  s.composer.addFiles(sid, [att])
  const { id } = await s.composer.schedule(sid, s.form({ subject: 'Vissza' }), NOW + 10 * MIN)
  s.composer.close(sid)
  const rel = s.scheduled.get(id).payload_path
  assert.deepEqual(s.folder('Drafts'), [])
  const holder = s.composer.open()
  s.composer.openScheduled(holder, id)
  assert.deepEqual(await s.call('scheduled:cancel', id), { ok: false, error: 'scheduled_open' })
  s.composer.close(holder)
  const r = await s.call('scheduled:cancel', id)
  assert.deepEqual(r, { ok: true, id, oldDraftLeft: false })
  assert.deepEqual(s.folder('Drafts'), ['Vissza'])
  assert.equal(s.scheduled.get(id), null)
  assert.ok(!fs.existsSync(path.join(s.storeDir, rel)), 'the sealed payload went')
  assert.equal(s.composer.sessions.size, 0)
  assert.equal(s.sent.length, 0)
  // the draft (its sealed .eml) holds the attachment
  const draftRow = s.db.prepare("SELECT store_path FROM messages WHERE folder = 'Drafts'").get()
  const eml = sealedStore(s.storeDir).read(draftRow.store_path).toString('utf8')
  assert.ok(eml.includes('terv.txt') && eml.includes(Buffer.from('MELLEKLET-TARTALOM').toString('base64')), 'the attachment in the draft')
  assert.deepEqual(await s.call('scheduled:cancel', id), { ok: false, error: 'not_found' })
  const sending = await s.schedule()
  s.scheduled.begin(sending)
  assert.deepEqual(await s.call('scheduled:cancel', sending), { ok: false, error: 'scheduled_sending' })
  assert.equal(s.scheduled.get(sending).state, 'sending')
  assert.ok(s.log.every(l => !/Vissza|anna@/.test(l)), 'the log names no subject or address')
})

test('while Időzítés törlése saves the draft, the scheduler does not pick the row (held); a second cancel meanwhile is refused', async t => {
  const s = setup(t)
  const id = await s.schedule({}, NOW + 2 * MIN)
  s.clock.now = NOW + 3 * MIN // due
  let release
  const gate = new Promise(r => (release = r))
  const realSave = s.composer.saveDraft.bind(s.composer)
  s.composer.saveDraft = async (...args) => {
    await gate
    return realSave(...args)
  }
  const cancel = s.call('scheduled:cancel', id)
  await new Promise(r => setImmediate(r))
  assert.deepEqual(s.composer.heldScheduled(), [id])
  assert.equal(s.scheduled.due(s.clock.now, s.composer.heldScheduled()), null)
  s.scheduler.start()
  await s.scheduler.tick()
  assert.equal(s.sent.length, 0, 'not sent while it becomes a draft')
  assert.deepEqual(await s.call('scheduled:cancel', id), { ok: false, error: 'scheduled_open' })
  release()
  assert.equal((await cancel).ok, true)
  assert.deepEqual(s.composer.heldScheduled(), [])
  await s.scheduler.tick()
  assert.equal(s.sent.length, 0)
  assert.deepEqual(s.folder('Drafts'), ['Időzített'])
})

test('Megnyitás: the composer gets the message; its saves update the scheduled row (not Drafts); the scheduler leaves it while open; closing keeps it', async t => {
  const s = setup(t)
  const id = await s.schedule({ subject: 'Eredeti' }, NOW + 2 * MIN)
  const rel = s.scheduled.get(id).payload_path
  const sid = s.composer.open()
  s.changes.length = 0
  const initial = s.composer.openScheduled(sid, id)
  assert.deepEqual(s.changes, ['composer'], 'opening tells the list (held)')
  assert.deepEqual([initial.subject, initial.to], ['Eredeti', 'Anna <anna@example.invalid>'])
  assert.ok(initial.draftHtml.includes('Szia Anna'))
  assert.equal(s.composer.sessionOfScheduled(id), sid)
  s.changes.length = 0
  const saved = await s.composer.saveDraft(sid, s.form({ subject: 'Javított', to: 'Béla <bela@example.invalid>' }))
  assert.deepEqual(s.changes, ['composer'], 'the save tells the list')
  assert.equal(saved.scheduled, true)
  assert.deepEqual(s.folder('Drafts'), [], 'not into Drafts')
  const row = s.scheduled.get(id)
  assert.deepEqual([row.subject, row.recipients, row.state, row.send_at], ['Javított', 'bela@example.invalid', 'waiting', NOW + 2 * MIN])
  assert.notEqual(row.payload_path, rel)
  assert.ok(!fs.existsSync(path.join(s.storeDir, rel)), 'the old payload file went')
  // due, but held
  s.clock.now = NOW + 5 * MIN
  s.scheduler.start()
  await s.scheduler.tick()
  assert.equal(s.sent.length, 0, 'not sent while open')
  // closing keeps it (with the saved content); then it goes as saved
  s.changes.length = 0
  s.composer.close(sid)
  assert.deepEqual(s.changes, ['composer'], 'closing tells the list (free again)')
  assert.equal(s.composer.sessionOfScheduled(id), null)
  await s.scheduler.tick()
  assert.equal(s.sent.length, 1)
  assert.ok(s.sent[0].raw.includes('Javított') || s.sent[0].raw.includes('Jav'), 'the saved subject')
  assert.ok(s.sent[0].envelope ? s.sent[0].envelope.to.includes('bela@example.invalid') : s.sent[0].raw.includes('bela@example.invalid'))
})

test('Megnyitás, then Küldés in the composer: sent once, the row and its file go; a new schedule replaces the row; Elvetés removes it', async t => {
  const s = setup(t)
  // send from the composer
  const a = await s.schedule({ subject: 'A' })
  const relA = s.scheduled.get(a).payload_path
  const sa = s.composer.open()
  s.composer.openScheduled(sa, a)
  await s.composer.sendNow(sa, s.form({ subject: 'A' }))
  assert.equal(s.sent.length, 1)
  assert.equal(s.scheduled.get(a), null)
  assert.ok(!fs.existsSync(path.join(s.storeDir, relA)))
  assert.deepEqual(s.folder('Drafts'), [])
  // a new time from the composer: one row, the new time
  const b = await s.schedule({ subject: 'B' })
  const sb = s.composer.open()
  s.composer.openScheduled(sb, b)
  const r = await s.composer.schedule(sb, s.form({ subject: 'B2' }), NOW + 90 * MIN)
  assert.deepEqual(s.scheduled.list().map(x => [x.subject, x.send_at]), [['B2', NOW + 90 * MIN]])
  assert.notEqual(r.id, b)
  // Elvetés
  const sc = s.composer.open()
  s.composer.openScheduled(sc, r.id)
  const relC = s.scheduled.get(r.id).payload_path
  await s.composer.discardDraft(sc)
  assert.deepEqual(s.scheduled.list(), [])
  assert.ok(!fs.existsSync(path.join(s.storeDir, relC)))
  assert.deepEqual(s.folder('Drafts'), [])
  assert.equal(s.sent.length, 1)
})

test('a row being sent cannot be opened in a composer', async t => {
  const s = setup(t)
  const id = await s.schedule()
  s.scheduled.begin(id)
  const sid = s.composer.open()
  assert.throws(() => s.composer.openScheduled(sid, id), { code: 'scheduled_sending' })
  assert.equal(s.composer.sessionOfScheduled(id), null)
})

test('a scheduled message saved from another account (From changed in its composer): the row follows the account', async t => {
  const s = setup(t)
  const other = addAccount(s.db, { type: 'pop3', name: 'Otthon', email: 'otthon@example.invalid' })
  s.db.prepare('UPDATE accounts SET smtp_host = ? WHERE id = ?').run('127.0.0.1', other.id)
  const id = await s.schedule()
  const sid = s.composer.open()
  s.composer.openScheduled(sid, id)
  await s.composer.saveDraft(sid, s.form({ accountId: other.id }))
  assert.equal(s.scheduled.get(id).account_id, other.id)
  assert.ok(s.scheduled.get(id).payload_path.startsWith(`${other.id}/`))
  const r = await s.call('scheduled:list')
  assert.equal(r.rows[0].accountName, 'Otthon')
})

test('Megnyitás of a row whose send may have gone out: the composer is told (mayHaveGone); a waiting row is not', async t => {
  const s = setup(t)
  const a = await s.schedule({ subject: 'Bizonytalan' })
  const b = await s.schedule({ subject: 'Megszakadt' })
  const c = await s.schedule({ subject: 'Vár' })
  const d = await s.schedule({ subject: 'Hibás' })
  s.scheduled.begin(a)
  s.scheduled.uncertain(a)
  s.scheduled.begin(b)
  s.scheduled.settle(NOW) // b: interrupted
  s.scheduled.begin(d)
  s.scheduled.failed(d, 'auth_failed', { permanent: true, now: NOW })
  const states = {}
  for (const [name, id] of Object.entries({ a, b, c, d })) {
    const sid = s.composer.open()
    states[name] = s.composer.openScheduled(sid, id).mayHaveGone
    s.composer.close(sid)
  }
  assert.deepEqual(states, { a: 'uncertain', b: 'interrupted', c: undefined, d: undefined })
})

test('a scheduled message saved in its composer without a recipient is refused (it would only fail at its time); the row keeps its content', async t => {
  const s = setup(t)
  const id = await s.schedule({ subject: 'Címzettel' })
  const sid = s.composer.open()
  s.composer.openScheduled(sid, id)
  await assert.rejects(s.composer.saveDraft(sid, s.form({ to: '', subject: 'Üres' })), { code: 'no_recipients' })
  const row = s.scheduled.get(id)
  assert.deepEqual([row.subject, row.recipients], ['Címzettel', 'anna@example.invalid'])
})

test('a due row held in a composer does not wake the scheduler every second; its close pokes it; after the stop the database is not asked', async t => {
  const s = setup(t)
  const id = await s.schedule({}, NOW + 2 * MIN)
  const waits = []
  const sched = createScheduler({ scheduled: s.scheduled, composer: s.composer, now: () => s.clock.now, setTimer: (fn, ms) => (waits.push(ms), 0), clearTimer: () => {} })
  const sid = s.composer.open()
  s.composer.openScheduled(sid, id)
  s.clock.now = NOW + 3 * MIN // due, but held
  sched.start()
  await sched.tick()
  assert.equal(s.scheduled.nextAt(s.composer.heldScheduled()), null, 'held: not the next wake-up')
  assert.equal(s.scheduled.nextAt(), NOW + 2 * MIN)
  assert.ok(waits.length && waits.every(w => w === 30_000), `waits ${waits.join(',')}`)
  assert.equal(s.sent.length, 0)
  // a stop (the lock) while a send runs: once it is done, the database is not asked again (the lock closes it)
  s.composer.close(sid)
  await s.schedule({ subject: 'Második' }, s.clock.now + 2 * MIN)
  s.clock.now += 3 * MIN // both due now: the first (freed) one goes, then the stop
  let release
  const gate = new Promise(r => (release = r))
  const plain = s.send
  s.send = async m => (await gate, plain(m))
  const running = sched.tick()
  await new Promise(r => setImmediate(r))
  let asked = 0
  const due = s.scheduled.due.bind(s.scheduled)
  s.scheduled.due = (...a) => (asked++, due(...a))
  const stopped = sched.stop()
  release()
  await stopped
  await running
  assert.equal(s.sent.length, 1, 'the send under way finished, nothing after the stop')
  assert.equal(asked, 0, 'no due() after the stop')
})
