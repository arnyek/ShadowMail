// SPDX-License-Identifier: GPL-3.0-or-later
// "Küldés és archiválás", the main process: after a successful send the original of a reply or forward goes into the
// Archive through MailActions (its queue, its yearly mode), after its \Answered / $Forwarded flag. Never after a failed
// or uncertain send, nor with a refused recipient; a moved, deleted or archived original is skipped; a failed archive
// leaves the send successful. The fake IMAP server's action log shows the STORE -> MOVE order and the number of MOVEs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { memoryIndex, addAccount, addMessage, sealedStore } from './helpers/fixtures.js'
import { FakeImapServer } from './helpers/fake-imap.js'
import { onCleanup, tempDir } from './helpers/tmp.js'
import { SyncManager } from '../app/main/sync-manager.js'
import { MessageReader } from '../app/main/reader.js'
import { MailActions } from '../app/main/actions.js'
import { Composer } from '../app/main/compose.js'
import { registerComposeIpc } from '../app/main/ipc/compose.js'
import { Contacts } from '../core/db/contacts.js'
import { hu } from '../app/renderer/i18n/hu.js'
import { en } from '../app/renderer/i18n/en.js'

const ME = 'teszt@example.invalid'
const NOW = Date.UTC(2026, 10, 12, 9, 0, 0)
const DAY = 86_400_000
const sleep = ms => new Promise(r => setTimeout(r, ms))
const until = async (fn, ms = 4000) => {
  const t0 = Date.now()
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting')
    await sleep(5)
  }
}

/**
 * sendMode: 'ok' | 'rejected' | 'fail' | 'afterData' (the injected send); archive: the server has an Archive role
 * folder; mode: the account's archive_mode; inFolder: where the original is.
 */
async function setup(t, { archive = true, mode = 'single', inFolder = 'INBOX', extraFolders = [] } = {}) {
  const { db, index } = memoryIndex(t)
  const row = addAccount(db, { email: ME, display_name: 'Teszt Elek', smtp_host: '127.0.0.1', smtp_port: 2525, smtp_security: 'none', smtp_user: ME })
  db.prepare('UPDATE accounts SET archive_mode = ? WHERE id = ?').run(mode, row.id)
  const imap = new FakeImapServer().addMailbox('INBOX').addMailbox('Drafts', { specialUse: '\\Drafts' }).addMailbox('Sent', { specialUse: '\\Sent' })
  if (archive) imap.addMailbox('Archívum', { specialUse: '\\Archive' })
  for (const f of extraFolders) imap.addMailbox(f)
  const uid = imap.addMessage(inFolder, { from: 'anna@example.invalid', to: ME, subject: 'Kérdés', messageId: '<q1@example.invalid>', date: NOW - DAY, body: 'Szöveg' })
  const store = {
    list: () => db.prepare('SELECT * FROM accounts ORDER BY id').all(),
    getRow: id => db.prepare('SELECT * FROM accounts WHERE id = ?').get(id),
    passwordsFor: () => ({ incoming: 'jelszo', smtp: 'jelszo' }),
  }
  const storeDir = path.join(tempDir(t), 'store')
  const manager = new SyncManager({ store, index, sealed: sealedStore(storeDir), notify: () => {}, connect: () => imap.connect(), now: () => NOW, throttleMs: 5, syncerOptions: { retryDelaysMs: [30, 30] }, idleOptions: { retryDelaysMs: [30], debounceMs: 10 } })
  onCleanup(t, () => manager.stopAll())
  manager.startAll()
  await until(() => manager.entries.get(row.id).idle.connected)
  await until(() => index.getByUid(row.id, inFolder, uid))
  await until(() => !manager.entries.get(row.id).syncer.current)
  const withConnection = (id, fn) => manager.withConnection(id, fn)
  const actions = new MailActions({ index, store, storeDir, withConnection, requestSync: (id, f) => manager.requestSync(id, f), now: () => NOW })
  const reader = new MessageReader({ index, sealed: sealedStore(storeDir), withConnection })
  const smtp = { mode: 'ok', sent: 0, seen: [] }
  const leavingLog = []
  const send = async () => {
    smtp.seen.push(leavingLog.length) // how many main-window notices had gone out when the SMTP send began
    if (smtp.mode === 'fail') throw Object.assign(new Error('refused'), { responseCode: 554 })
    if (smtp.mode === 'afterData') throw Object.assign(new Error('connection lost after DATA'), { code: 'ECONNRESET', afterData: true })
    smtp.sent++
    return { rejected: smtp.mode === 'rejected' ? ['nincs@example.invalid'] : [] }
  }
  const onOriginLeaving = e => leavingLog.push(e)
  const composer = new Composer({ actions, onOriginLeaving, index, store, contacts: new Contacts(db), storeDir, sealed: sealedStore(storeDir), reader, withConnection, requestSync: (id, f) => manager.requestSync(id, f), send, now: () => NOW })
  const original = index.getByUid(row.id, inFolder, uid)
  const ops = () => imap.actionLog.filter(a => a.op === 'flags+' || a.op === 'move' || a.op === 'create').map(a => (a.op === 'move' ? `move ${a.path} -> ${a.destination}` : a.op === 'create' ? `create ${a.path}` : `store ${a.path} ${a.flags.join(' ')}`))
  const moves = () => imap.actionLog.filter(a => a.op === 'move').length
  const messagesIn = box => [...imap.mailboxes.get(box).messages.values()]
  /** prepare(mode) -> sid; sendIt(sid, opts) sends the prepared form with a short answer above the quote */
  const prepare = async (mode = 'reply', messageId = original.id) => {
    const sid = composer.open()
    await composer.prepare(sid, { mode, messageId })
    return sid
  }
  const sendIt = (sid, opts = {}) => {
    const f = composer.initial(sid).form
    return composer.sendNow(sid, { accountId: f.accountId, to: f.to || 'bela@example.invalid', cc: f.cc || '', bcc: '', subject: f.subject, html: `<p>Válaszom.</p>${f.quote}`, inReplyTo: f.inReplyTo, references: f.references }, opts)
  }
  return { db, index, row, imap, manager, actions, composer, original, smtp, ops, moves, messagesIn, prepare, sendIt, leavingLog }
}

test('reply + archive: the original in the Archive with \\Answered; one STORE, then one MOVE', async t => {
  const s = await setup(t)
  const sid = await s.prepare('reply')
  assert.equal(s.composer.initial(sid).archivable, true)
  const res = await s.sendIt(sid, { archive: true })
  assert.deepEqual(res, { sent: true, warnings: [], rejected: [] })
  assert.deepEqual(s.ops(), ['store INBOX \\Answered', 'move INBOX -> Archívum'], 'the flag first, then the move')
  assert.equal(s.messagesIn('INBOX').length, 0)
  const [archived] = s.messagesIn('Archívum')
  assert.ok(archived.flags.has('\\Answered'), 'the flag travelled with the message')
  assert.equal(s.index.get(s.original.id).folder, 'Archívum', 'the row moved too (the same id)')
})

test('reply + archive by year: the missing year folder is created, the original goes there with \\Answered', async t => {
  const s = await setup(t, { mode: 'yearly' })
  const res = await s.sendIt(await s.prepare('reply'), { archive: true })
  assert.deepEqual(res.warnings, [])
  assert.deepEqual(s.ops(), ['store INBOX \\Answered', 'create Archívum/2026', 'move INBOX -> Archívum/2026'])
  const [archived] = s.messagesIn('Archívum/2026')
  assert.ok(archived.flags.has('\\Answered'))
  assert.equal(s.moves(), 1)
})

test('forward + archive: $Forwarded, then the move', async t => {
  const s = await setup(t)
  const res = await s.sendIt(await s.prepare('forward'), { archive: true })
  assert.deepEqual(res.warnings, [])
  assert.deepEqual(s.ops(), ['store INBOX $Forwarded', 'move INBOX -> Archívum'])
  assert.ok(s.messagesIn('Archívum')[0].flags.has('$Forwarded'))
})

test('a reply saved as a draft, opened again and sent with archive: the original is archived', async t => {
  const s = await setup(t)
  const sid = await s.prepare('reply')
  const f = s.composer.initial(sid).form
  await s.composer.saveDraft(sid, { accountId: f.accountId, to: f.to, cc: '', bcc: '', subject: f.subject, html: `<p>Később.</p>${f.quote}`, inReplyTo: f.inReplyTo, references: f.references })
  s.composer.close(sid)
  await s.manager.requestSync(s.row.id, ['Drafts'])
  let draft
  await until(() => (draft = s.index.listFolder({ accountId: s.row.id, folder: 'Drafts', limit: 5 })[0]))
  const again = s.composer.open()
  await s.composer.prepare(again, { mode: 'draft', messageId: draft.id })
  assert.equal(s.composer.initial(again).archivable, true, 'the draft knows its original again')
  const res = await s.sendIt(again, { archive: true })
  assert.deepEqual(res.warnings, [])
  assert.deepEqual(s.ops(), ['store INBOX \\Answered', 'move INBOX -> Archívum'])
})

test('POP3 account: the local row goes into the local Archive, \\Answered on it', async t => {
  const { db, index } = memoryIndex(t)
  const row = addAccount(db, { type: 'pop3', email: ME })
  index.ensureLocalFolders(row.id, [{ path: 'INBOX' }, { path: 'Sent', specialUse: '\\Sent' }, { path: 'Drafts', specialUse: '\\Drafts' }, { path: 'Archive', specialUse: '\\Archive' }])
  const id = addMessage(index, row.id, { uid: 1, messageId: '<p1@example.invalid>', fromAddr: 'anna@example.invalid', subject: 'Kérdés', date: NOW - DAY })
  db.prepare('UPDATE messages SET uid = NULL WHERE id = ?').run(id) // a POP3 row has no IMAP UID
  const store = { list: () => db.prepare('SELECT * FROM accounts ORDER BY id').all(), getRow: x => db.prepare('SELECT * FROM accounts WHERE id = ?').get(x), passwordsFor: () => ({ smtp: 'jelszo' }) }
  const storeDir = path.join(tempDir(t), 'store')
  const noServer = async () => assert.fail('no connection for a POP3 account')
  const actions = new MailActions({ index, store, storeDir, withConnection: noServer, now: () => NOW })
  const composer = new Composer({ actions, index, store, contacts: new Contacts(db), storeDir, sealed: sealedStore(storeDir), withConnection: noServer, send: async () => ({ rejected: [] }), now: () => NOW })
  const sid = composer.open()
  // the reader of a POP3 original is tested elsewhere; here the session's original as prepare sets it
  composer.sessions.get(sid).origin = { id, accountId: row.id, messageId: '<p1@example.invalid>', folder: 'INBOX', flag: '\\Answered' }
  assert.equal(composer.initial(sid).archivable, true)
  const res = await composer.sendNow(sid, { accountId: row.id, to: 'anna@example.invalid', cc: '', bcc: '', subject: 'Re: Kérdés', html: '<p>Igen.</p>', inReplyTo: '<p1@example.invalid>', references: [] }, { archive: true })
  assert.deepEqual(res.warnings, [])
  const after = index.get(id)
  assert.equal(after.folder, 'Archive')
  assert.match(after.flags, /\\Answered/)
})

test('a failed send and an uncertain one (afterData): no flag, no move', async t => {
  for (const mode of ['fail', 'afterData']) {
    await t.test(mode, async t => {
      const s = await setup(t)
      s.smtp.mode = mode
      const sid = await s.prepare('reply')
      await assert.rejects(s.sendIt(sid, { archive: true }), err => (mode === 'afterData' ? err.afterData === true : !err.afterData))
      assert.equal(s.moves(), 0)
      assert.equal(s.index.get(s.original.id).folder, 'INBOX')
    })
  }
})

test('a refused recipient: no move, the sentence in the warning (hu, en)', async t => {
  const s = await setup(t)
  s.smtp.mode = 'rejected'
  const res = await s.sendIt(await s.prepare('reply'), { archive: true })
  assert.equal(res.sent, true)
  assert.deepEqual(res.rejected, ['nincs@example.invalid'])
  assert.deepEqual(res.warnings, ['archive_rejected'])
  assert.equal(s.moves(), 0)
  assert.deepEqual(s.ops(), ['store INBOX \\Answered'], 'the flag is still set (it was answered)')
  assert.match(hu.composeSentWithWarnings(res.rejected, res.warnings), /Az eredeti levelet nem archiváltam, mert egy címzett elutasította\./)
  assert.match(en.composeSentWithWarnings(res.rejected, res.warnings), /The original message was not archived because a recipient was rejected\./)
})

test('the flag fails: the move still happens; the move fails: sent, archive_failed', async t => {
  const a = await setup(t)
  a.imap.refuseOps.add('flags+')
  const ra = await a.sendIt(await a.prepare('reply'), { archive: true })
  assert.equal(ra.sent, true)
  assert.ok(ra.warnings.some(w => w.startsWith('origin_flag_failed')), JSON.stringify(ra.warnings))
  assert.equal(a.moves(), 1)
  assert.equal(a.messagesIn('Archívum').length, 1)

  const b = await setup(t)
  b.imap.refuseOps.add('move')
  const rb = await b.sendIt(await b.prepare('reply'), { archive: true })
  assert.equal(rb.sent, true)
  assert.deepEqual(rb.warnings, ['archive_failed:server_refused'])
  assert.equal(b.index.get(b.original.id).folder, 'INBOX', 'the original stays')
  assert.match(hu.composeSentWithWarnings([], rb.warnings), /Az eredeti levelet nem sikerült archiválni\./)
})

test('archivable false: a new message, an account without an Archive, an original in the Archive or its year folder', async t => {
  const s = await setup(t)
  assert.equal(s.composer.initial(s.composer.open()).archivable, false, 'a new message')
  const n = await setup(t, { archive: false })
  const nsid = await n.prepare('reply')
  assert.equal(n.composer.initial(nsid).archivable, false, 'no Archive')
  const nres = await n.sendIt(nsid, { archive: true })
  assert.deepEqual(nres.warnings, ['archive_skipped'])
  assert.equal(n.moves(), 0)
  for (const inFolder of ['Archívum', 'Archívum/2025']) {
    const x = await setup(t, { inFolder, extraFolders: inFolder === 'Archívum' ? [] : [inFolder] })
    const sid = await x.prepare('reply')
    assert.equal(x.composer.initial(sid).archivable, false, inFolder)
    const res = await x.sendIt(sid, { archive: true })
    assert.deepEqual(res.warnings, ['archive_skipped'], inFolder)
    assert.equal(x.moves(), 0, inFolder)
  }
})

test('the original moved or deleted between prepare and send: sent, no move of ours, archive_skipped', async t => {
  const m = await setup(t, { extraFolders: ['Munka'] })
  const msid = await m.prepare('reply')
  await m.actions.run({ ids: [m.original.id], action: 'move', target: 'Munka' })
  const mres = await m.sendIt(msid, { archive: true })
  assert.equal(mres.sent, true)
  assert.deepEqual(mres.warnings, ['archive_skipped'])
  assert.equal(m.moves(), 1, 'only the move to Munka')
  assert.equal(m.messagesIn('Archívum').length, 0)

  const d = await setup(t)
  const dsid = await d.prepare('reply')
  d.index.deleteIds([d.original.id])
  const dres = await d.sendIt(dsid, { archive: true })
  assert.equal(dres.sent, true)
  assert.deepEqual(dres.warnings, ['archive_skipped'])
  assert.equal(d.moves(), 0)
})

test('without the archive switch (Küldés, the scheduler, Claude): no move', async t => {
  const s = await setup(t)
  const sid = await s.prepare('reply')
  assert.equal(s.composer.initial(sid).archivable, true)
  const res = await s.sendIt(sid)
  assert.deepEqual(res.warnings, [])
  assert.deepEqual(s.ops(), ['store INBOX \\Answered'])
  assert.equal(s.index.get(s.original.id).folder, 'INBOX')
})

/** The next MOVE on the server waits for release(): a list action is still under way while the send runs. */
async function holdMoves(s) {
  let release
  const held = new Promise(r => (release = r))
  const realConnect = s.imap.connect.bind(s.imap)
  s.imap.connect = async () => {
    const client = await realConnect()
    const move = client.messageMove.bind(client)
    client.messageMove = async (...args) => (await held, move(...args))
    return client
  }
  await s.manager.stopAll()
  s.manager.startAll()
  await until(() => s.manager.entries.get(s.row.id).idle.connected)
  return release
}

test('in the MailActions queue: the list archives the same original meanwhile -> one MOVE, no error', async t => {
  // the list first: its MOVE is held; the send's flag and archive wait behind it in the queue / on the connection
  const s = await setup(t)
  const sid = await s.prepare('reply')
  const release = await holdMoves(s)
  const fromList = s.actions.run({ ids: [s.original.id], action: 'archive' })
  const sending = s.sendIt(sid, { archive: true })
  await sleep(50)
  release()
  assert.deepEqual(await fromList, { done: 1, final: false })
  const res = await sending
  assert.equal(res.sent, true)
  assert.deepEqual(res.warnings, ['archive_skipped'], 'already in the Archive: skipped, not failed')
  assert.equal(s.moves(), 1, 'one MOVE only')
  assert.equal(s.messagesIn('Archívum').length, 1)
  assert.ok(s.messagesIn('Archívum')[0].flags.has('\\Answered'), 'the flag found the original in the Archive')
})

test('in the MailActions queue: the list moves the original elsewhere meanwhile -> it stays there, archive_skipped', async t => {
  // the archive request is checked when it runs, not when it was queued: the original is no longer where the reply found it
  const s = await setup(t, { extraFolders: ['Munka'] })
  const sid = await s.prepare('reply')
  const release = await holdMoves(s)
  const fromList = s.actions.run({ ids: [s.original.id], action: 'move', target: 'Munka' })
  const sending = s.sendIt(sid, { archive: true })
  await sleep(50)
  release()
  await fromList
  const res = await sending
  assert.equal(res.sent, true)
  assert.deepEqual(res.warnings, ['archive_skipped'])
  assert.equal(s.moves(), 1, 'only the list\'s move')
  assert.equal(s.messagesIn('Munka').length, 1)
  assert.equal(s.messagesIn('Archívum').length, 0)
})

test('in the MailActions queue: the send archives first, the list asks after -> one MOVE', async t => {
  const s = await setup(t)
  const sid = await s.prepare('reply')
  const sending = s.sendIt(sid, { archive: true })
  await until(() => s.moves() === 1)
  const fromList = s.actions.run({ ids: [s.original.id], action: 'archive' }).then(r => r, e => e)
  const res = await sending
  assert.deepEqual(res.warnings, [])
  const listAnswer = await fromList
  // the list's own request finds the message in the Archive: the existing answer for that (the list hides its button there)
  assert.equal(listAnswer.code, 'bad_target')
  assert.equal(s.moves(), 1, 'no second MOVE')
})

test('the main window is told: the original leaving at the start, archived or back at the end; nothing without archiving', async t => {
  const ok = await setup(t)
  await ok.sendIt(await ok.prepare('reply'), { archive: true })
  assert.deepEqual(ok.smtp.seen, [1], 'leaving told before the SMTP send began')
  assert.deepEqual(ok.leavingLog, [{ id: ok.original.id, leaving: true }, { id: ok.original.id, leaving: false, archived: true }])

  for (const [mode, prep] of [['rejected', null], ['fail', null], ['ok', s => s.imap.refuseOps.add('move')]]) {
    const x = await setup(t)
    if (prep) prep(x)
    x.smtp.mode = mode
    const xs = await x.prepare('reply')
    await x.sendIt(xs, { archive: true }).catch(() => {})
    assert.deepEqual(x.leavingLog, [{ id: x.original.id, leaving: true }, { id: x.original.id, leaving: false, archived: false }], `back: ${mode}${prep ? ' + move refused' : ''}`)
  }
  const plain = await setup(t)
  await plain.sendIt(await plain.prepare('reply'))
  assert.deepEqual(plain.leavingLog, [], 'a plain send: nothing')
  const none = await setup(t, { archive: false })
  await none.sendIt(await none.prepare('reply'), { archive: true })
  assert.deepEqual(none.leavingLog, [], 'nothing to archive: nothing')
})

test('compose:send IPC: { archive } passed on; anything else in the options is a bad request', async t => {
  const calls = []
  const handlers = new Map()
  const SID = '00000000-0000-4000-8000-000000000000'
  registerComposeIpc({
    ipcMain: { handle: (c, fn) => handlers.set(c, fn) },
    composer: { sendNow: async (sid, form, opts) => (calls.push(opts), { sent: true, warnings: [], rejected: [] }) },
    store: { list: () => [] },
    contacts: {},
    openWindow: () => ({ on: () => {}, isDestroyed: () => false, close: () => {}, destroy: () => {} }),
    dialog: {},
    windowOf: () => null,
    isTrustedSender: () => true,
  })
  const call = (...args) => handlers.get('compose:send')({}, SID, { accountId: 1, to: 'a@example.invalid' }, ...args)
  for (const ok of [[], [undefined], [null], [{}], [{ archive: true }], [{ archive: false }]]) assert.equal((await call(...ok)).ok, true, JSON.stringify(ok))
  assert.deepEqual(calls, [{ archive: false }, { archive: false }, { archive: false }, { archive: false }, { archive: true }, { archive: false }])
  for (const bad of [{ archive: 'yes' }, { archive: true, other: 1 }, [true], 'archive']) assert.deepEqual(await call(bad), { ok: false, error: 'bad_request' }, JSON.stringify(bad))
})
