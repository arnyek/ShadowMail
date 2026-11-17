// SPDX-License-Identifier: GPL-3.0-or-later
// Archiving into year folders: the Archive role folder's direct children named by a 4-digit year are the year folders;
// the account's archive_mode (single / yearly / none = by the year folders) decides; by year, each message goes into
// the year of its Date (else its arrival), a missing year folder is created on the server and reported. Real
// SyncManager + MailActions with the fake IMAP server, the pure helpers, the IPC and the account field.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { memoryIndex, addAccount, addMessage } from './helpers/fixtures.js'
import { FakeImapServer } from './helpers/fake-imap.js'
import { onCleanup, tempDir } from './helpers/tmp.js'
import { SyncManager } from '../app/main/sync-manager.js'
import { MailActions } from '../app/main/actions.js'
import { registerActionIpc } from '../app/main/ipc/actions.js'
import { archiveModeOf, archiveYear, inArchive, yearFolders } from '../core/imap/folders.js'
import { validateAccount } from '../core/accounts/model.js'
import { newAccountDefaults } from '../core/accounts/defaults.js'

const NOW = Date.UTC(2026, 10, 16, 9, 0, 0)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const until = async (fn, ms = 4000) => {
  const t0 = Date.now()
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting')
    await sleep(5)
  }
}
const at = (y, m = 5, d = 15) => new Date(y, m, d, 12).getTime() // local noon
const msg = (n, date) => ({ from: `k${n}@example.invalid`, to: 'en@example.invalid', subject: `Levél ${n}`, messageId: `<a${n}@x>`, date, body: `Szöveg ${n}` })

const row = (path, delimiter = '/') => ({ path, delimiter })

test('the helpers: year folders, the mode in effect, in the Archive, the year of a message', () => {
  const folders = [row('INBOX'), row('Archívum'), row('Archívum/2024'), row('Archívum/2025'), row('Archívum/Régi'), row('Archívum/2024/Q1'), row('Más/2023')]
  assert.deepEqual([...yearFolders(folders, 'Archívum')], [[2024, 'Archívum/2024'], [2025, 'Archívum/2025']], 'direct children with 4 digits only')
  assert.equal(archiveModeOf(null, folders, 'Archívum'), 'yearly', 'none set + year folders: by year')
  assert.equal(archiveModeOf(null, [row('Archívum')], 'Archívum'), 'single', 'none set, no year folder: one folder')
  assert.equal(archiveModeOf('single', folders, 'Archívum'), 'single')
  assert.equal(archiveModeOf('yearly', [row('Archívum')], 'Archívum'), 'yearly')
  assert.equal(archiveModeOf('yearly', [row('Archívum', null)], 'Archívum'), 'single', 'a flat server cannot have year folders')
  assert.equal(inArchive(folders, 'Archívum', 'Archívum'), true)
  assert.equal(inArchive(folders, 'Archívum', 'Archívum/2024'), true)
  assert.equal(inArchive(folders, 'Archívum', 'Archívumok'), false, 'a prefix of the name is not inside')
  assert.equal(inArchive(folders, 'Archívum', 'INBOX'), false)
  // the year: the Date header, else the arrival, else now; local time (the date the user reads)
  assert.equal(archiveYear({ date: at(2023), idate: at(2025) }), 2023)
  assert.equal(archiveYear({ date: null, idate: at(2022) }), 2022)
  assert.equal(archiveYear({ date: null, idate: null }, at(2026)), 2026)
  assert.equal(archiveYear({ date: new Date(2024, 11, 31, 23, 30).getTime() }), 2024, 'New Year\'s Eve stays in its year')
  // a plausible year only (1970 .. next year): else the arrival's, else null (= the Archive itself)
  const y = (year, m = 5) => { const d = new Date(2000, m, 15, 12); d.setFullYear(year); return d.getTime() }
  const now = at(2026)
  assert.equal(archiveYear({ date: y(999), idate: at(2024) }, now), 2024, 'year 999: the arrival')
  assert.equal(archiveYear({ date: y(999), idate: null }, now), null, 'year 999, no arrival')
  assert.equal(archiveYear({ date: y(10000), idate: y(999) }, now), null, 'neither plausible')
  assert.equal(archiveYear({ date: y(1969), idate: at(2023) }, now), 2023, '1969: the arrival')
  assert.equal(archiveYear({ date: y(1970), idate: at(2023) }, now), 1970, '1970 is the first plausible year')
  assert.equal(archiveYear({ date: y(2027), idate: at(2023) }, now), 2027, 'next year is plausible (clock skew)')
  assert.equal(archiveYear({ date: y(2028), idate: at(2023) }, now), 2023, 'the year after next is not')
  assert.equal(archiveYear({ date: y(2028), idate: y(2030) }, now), null)
})

async function setup(t, { mode = null, years = [], flat = false, messages = null } = {}) {
  const { db, index } = memoryIndex(t)
  const account = addAccount(db)
  if (mode) db.prepare('UPDATE accounts SET archive_mode = ? WHERE id = ?').run(mode, account.id)
  const server = new FakeImapServer()
  if (flat) server.delimiter = null
  server.addMailbox('INBOX').addMailbox('Archívum', { specialUse: '\\Archive' })
  for (const y of years) server.addMailbox(`Archívum/${y}`)
  server.addMessages('INBOX', messages || [msg(1, at(2025, 2)), msg(2, at(2024, 7)), msg(3, at(2024, 1)), msg(4, at(2026, 0))])
  const store = {
    list: () => db.prepare('SELECT * FROM accounts ORDER BY id').all(),
    getRow: id => db.prepare('SELECT * FROM accounts WHERE id = ?').get(id),
  }
  const manager = new SyncManager({ store, index, notify: () => {}, connect: () => server.connect(), now: () => NOW, throttleMs: 5, syncerOptions: { retryDelaysMs: [30, 30] }, idleOptions: { retryDelaysMs: [30], debounceMs: 10 } })
  onCleanup(t, () => manager.stopAll())
  manager.startAll()
  await until(() => manager.entries.get(account.id).idle.connected)
  await until(() => !manager.entries.get(account.id).syncer.current)
  const changes = []
  const logs = []
  const actions = new MailActions({
    index, store, storeDir: path.join(tempDir(t), 'store'),
    withConnection: (id, fn) => manager.withConnection(id, fn),
    onChange: c => changes.push(c),
    requestSync: (id, folders) => manager.requestSync(id, folders),
    log: l => logs.push(l),
    now: () => NOW,
  })
  const inFolder = f => index.listFolder({ accountId: account.id, folder: f, limit: 100 }).map(m => m.subject).sort()
  const ids = () => index.listFolder({ accountId: account.id, folder: 'INBOX', limit: 100 }).map(m => m.id)
  const onServer = f => (server.mailboxes.get(f) ? [...server.mailboxes.get(f).messages.values()].length : null)
  return { db, index, account, server, manager, actions, changes, logs, inFolder, ids, onServer }
}

test('no year folder, no setting: everything into the Archive itself (as before)', async t => {
  const s = await setup(t)
  const res = await s.actions.run({ ids: s.ids(), action: 'archive' })
  assert.deepEqual(res, { done: 4, final: false })
  assert.deepEqual(s.inFolder('Archívum'), ['Levél 1', 'Levél 2', 'Levél 3', 'Levél 4'])
  assert.equal(s.onServer('Archívum'), 4)
  assert.equal(s.onServer('INBOX'), 0)
})

test('a year folder exists: by year; the missing years are created on the server and reported', async t => {
  const s = await setup(t, { years: [2024] })
  const res = await s.actions.run({ ids: s.ids(), action: 'archive' })
  assert.equal(res.done, 4)
  assert.deepEqual(res.created, ['Archívum/2025', 'Archívum/2026'], 'oldest first, only the missing ones')
  assert.deepEqual(s.inFolder('Archívum/2024'), ['Levél 2', 'Levél 3'])
  assert.deepEqual(s.inFolder('Archívum/2025'), ['Levél 1'])
  assert.deepEqual(s.inFolder('Archívum/2026'), ['Levél 4'])
  assert.deepEqual([s.onServer('Archívum/2024'), s.onServer('Archívum/2025'), s.onServer('Archívum/2026'), s.onServer('INBOX')], [2, 1, 1, 0])
  assert.ok(s.server.subscribed.has('Archívum/2025'), 'a created folder is subscribed (other clients show it)')
  assert.equal(s.inFolder('Archívum').length, 0, 'nothing into the Archive itself')
  assert.ok(s.changes.at(-1).folders.includes('INBOX') && s.changes.at(-1).folders.includes('Archívum/2025'))
  // a second archive of a 2025 message: the year folder is there now, nothing created
  s.server.addMessages('INBOX', [msg(9, at(2025, 9))])
  s.manager.requestSync(s.account.id)
  await sleep(30)
  await until(() => !s.manager.entries.get(s.account.id).syncer.current)
  const again = await s.actions.run({ ids: s.ids(), action: 'archive' })
  assert.deepEqual(again.created, [])
  assert.deepEqual(s.inFolder('Archívum/2025'), ['Levél 1', 'Levél 9'])
  assert.ok(s.logs.every(l => !/Levél|example/.test(l)), 'the log names no message')
})

test('the setting decides: single with year folders, yearly without any', async t => {
  const single = await setup(t, { mode: 'single', years: [2024] })
  await single.actions.run({ ids: single.ids(), action: 'archive' })
  assert.equal(single.inFolder('Archívum').length, 4)
  assert.equal(single.inFolder('Archívum/2024').length, 0)
  const yearly = await setup(t, { mode: 'yearly' })
  const res = await yearly.actions.run({ ids: yearly.ids(), action: 'archive' })
  assert.deepEqual(res.created, ['Archívum/2024', 'Archívum/2025', 'Archívum/2026'])
  assert.equal(yearly.inFolder('Archívum').length, 0)
})

test('no Archive action in the Archive, in a year folder, or without an Archive', async t => {
  const s = await setup(t, { years: [2024] })
  await s.actions.run({ ids: s.ids(), action: 'archive' })
  const inYear = s.index.listFolder({ accountId: s.account.id, folder: 'Archívum/2024', limit: 10 }).map(m => m.id)
  await assert.rejects(() => s.actions.run({ ids: inYear, action: 'archive' }), { code: 'bad_target' })
  // without an Archive role folder
  const { db, index } = memoryIndex(t)
  const account = addAccount(db)
  index.upsertFolder({ account_id: account.id, path: 'INBOX', delimiter: '/', uidvalidity: '1' })
  addMessage(index, account.id, { uid: 1, messageId: '<z@x>', subject: 'z', date: at(2024) })
  const actions = new MailActions({ index, store: { getRow: () => db.prepare('SELECT * FROM accounts WHERE id = ?').get(account.id) }, storeDir: tempDir(t), withConnection: () => assert.fail('no server call') })
  const id = index.listFolder({ accountId: account.id, folder: 'INBOX', limit: 1 })[0].id
  await assert.rejects(() => actions.run({ ids: [id], action: 'archive' }), { code: 'bad_target' })
})

test('a flat server (no delimiter): yearly is not possible, everything into the Archive', async t => {
  const s = await setup(t, { mode: 'yearly', flat: true })
  const res = await s.actions.run({ ids: s.ids(), action: 'archive' })
  assert.equal(res.created, undefined)
  assert.equal(s.inFolder('Archívum').length, 4)
})

test('the IPC: archive takes no target; the account field: single / yearly / empty, IMAP only', async t => {
  const handlers = new Map()
  const calls = []
  registerActionIpc({ ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) }, actions: { run: async q => (calls.push(q), { done: q.ids.length, final: false, created: [] }) }, index: {}, isTrustedSender: () => true })
  const call = q => handlers.get('mail:action')({}, q)
  assert.deepEqual(await call({ ids: [1], action: 'archive', target: 'Archívum' }), { ok: false, error: 'bad_request' })
  assert.deepEqual(await call({ ids: [1, 1, 2], action: 'archive' }), { ok: true, done: 2, final: false, created: [] })
  assert.deepEqual(calls[0], { ids: [1, 2], action: 'archive', target: null, permanent: false })

  const base = { ...newAccountDefaults('imap'), name: 'A', email: 'a@example.invalid', in_host: 'h', in_user: 'u', smtp_host: 'h', index_years: 3 }
  for (const [v, want] of [['', null], [null, null], [undefined, null], ['single', 'single'], ['yearly', 'yearly']]) {
    const r = validateAccount({ ...base, archive_mode: v })
    assert.equal(r.errors.archive_mode, undefined, String(v))
    assert.equal(r.values.archive_mode, want, String(v))
  }
  assert.equal(validateAccount({ ...base, archive_mode: 'monthly' }).errors.archive_mode, 'bad_archive_mode')
  assert.equal(validateAccount({ ...base, ...newAccountDefaults('pop3'), name: 'B', email: 'b@example.invalid', in_host: 'h', in_user: 'u', smtp_host: 'h', index_years: 3, archive_mode: 'yearly' }).values.archive_mode, null, 'POP3: none')
})

test('POP3: a local Archive with a year folder: by year, the missing year is a new LOCAL folder, no server call', async t => {
  const { db, index } = memoryIndex(t)
  const account = addAccount(db, { type: 'pop3' })
  index.ensureLocalFolders(account.id, [{ path: 'INBOX', specialUse: null }, { path: 'Trash', specialUse: '\\Trash' }])
  index.addFolder(account.id, 'Archívum', '/', true)
  index.addFolder(account.id, 'Archívum/2024', '/', true)
  addMessage(index, account.id, { uid: 1, messageId: '<p1@x>', subject: 'p1', date: at(2024) })
  addMessage(index, account.id, { uid: 2, messageId: '<p2@x>', subject: 'p2', date: at(2025) })
  const actions = new MailActions({ index, store: { getRow: () => db.prepare('SELECT * FROM accounts WHERE id = ?').get(account.id) }, storeDir: tempDir(t), withConnection: () => assert.fail('no server call for POP3') })
  const ids = index.listFolder({ accountId: account.id, folder: 'INBOX', limit: 10 }).map(m => m.id)
  const res = await actions.run({ ids, action: 'archive' })
  assert.deepEqual(res.created, ['Archívum/2025'])
  const f = index.folderList(account.id).find(x => x.path === 'Archívum/2025')
  assert.equal(f.is_local, 1, 'a local folder')
  assert.equal(f.delimiter, '/')
  const where = id => index.get(id).folder
  assert.deepEqual(ids.map(where).sort(), ['Archívum/2024', 'Archívum/2025'])
})

test('a Date header of an implausible year (999, 10000): into the Archive itself, no year folder made; twice the same', async t => {
  const y = year => { const d = new Date(2000, 5, 15, 12); d.setFullYear(year); return d.getTime() }
  const odd = (n, year) => ({ ...msg(n, y(year)), idate: y(year) }) // the arrival as odd as the header
  const s = await setup(t, { years: [2024], messages: [odd(1, 999), msg(2, at(2024)), odd(3, 10000), msg(4, at(2025, 3))] })
  assert.equal(archiveYear(s.index.listFolder({ accountId: s.account.id, folder: 'INBOX', limit: 10 }).find(m => m.subject === 'Levél 1'), NOW), null, 'the synced row keeps the odd year')
  const res = await s.actions.run({ ids: s.ids(), action: 'archive' })
  assert.deepEqual(res.created, ['Archívum/2025'], 'only the plausible missing year is made')
  assert.deepEqual(s.inFolder('Archívum'), ['Levél 1', 'Levél 3'])
  assert.deepEqual(s.inFolder('Archívum/2024'), ['Levél 2'])
  assert.deepEqual(s.inFolder('Archívum/2025'), ['Levél 4'])
  assert.deepEqual(s.inFolder('INBOX'), [])
  assert.ok(![...s.server.mailboxes.keys()].some(p => /Archívum\/(999|10000)$/.test(p)), 'no Archívum/999 or /10000 on the server')
  assert.equal(s.onServer('Archívum'), 2)
  // another such message later: the same, no folder_exists
  s.server.addMessages('INBOX', [odd(5, 999)])
  await s.manager.requestSync(s.account.id, ['INBOX'])
  await until(() => s.ids().length === 1)
  const again = await s.actions.run({ ids: s.ids(), action: 'archive' })
  assert.deepEqual(again.created, [])
  assert.deepEqual(s.inFolder('Archívum'), ['Levél 1', 'Levél 3', 'Levél 5'])
  assert.ok(!s.logs.some(l => /\(999\)|\(10000\)|\(null\)/.test(l)), s.logs.join(' | '))
})
