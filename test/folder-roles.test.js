// The folder roles: the server's own SPECIAL-USE flag first, then the role a folder already had, then the
// usual names, and between two folders with a usual name of the same role the one with more messages on the server.
// The 0.14.0 fault this guards: imapflow fills `specialUse` from the folder NAME on a server without SPECIAL-USE and
// picks the alphabetically first name ("Elküldött elemek" before "Sent", "Törölt elemek" before "Trash"); the app
// stored that guess as the server's flag, so the Sent role went to another program's folder with 9 messages instead of
// the real Sent with 12 018.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { memoryIndex, addAccount } from './helpers/fixtures.js'
import { FakeImapServer } from './helpers/fake-imap.js'
import { startImapWire } from './helpers/imap-wire.js'
import { tempDir, onCleanup } from './helpers/tmp.js'
import { Syncer } from '../core/imap/sync.js'
import { serverSpecialUse } from '../core/imap/client.js'
import { assignRoles, resolveRoles, buildFolderTree } from '../core/imap/folders.js'
import { openDatabase, openMailDatabase } from '../core/db/index.js'
import { migrate, backupPath } from '../core/db/migrate.js'
import { MIGRATIONS } from '../core/db/schema.js'
import { MailIndex } from '../core/db/mail-index.js'

// a mailbox used by several programs (a Hungarian mail client, a virus scanner): their folders side by side, the traffic in
// Sent/Trash/Drafts/Junk, empty copies under INBOX
const MIXED = [
  { path: 'INBOX', messages: 4200 },
  { path: 'Sent', messages: 12018, flags: ['\\Sent'] },
  { path: 'Trash', messages: 9400, flags: ['\\Trash'] },
  { path: 'Drafts', messages: 12, flags: ['\\Drafts'] },
  { path: 'Junk', messages: 310, flags: ['\\Junk'] },
  { path: 'Elküldött elemek', messages: 9 },
  { path: 'Törölt elemek', messages: 30 },
  { path: 'Levélszemét', messages: 4 },
  { path: 'INBOX.Elküldött elemek', messages: 0 },
  { path: 'INBOX.Törölt elemek', messages: 0 },
  { path: 'Fertőzött elemek', messages: 0 },
  { path: 'Infected Items', messages: 0 },
  { path: 'ESET Antispam', messages: 0 },
]
const WANTED = { inbox: 'INBOX', sent: 'Sent', trash: 'Trash', drafts: 'Drafts', junk: 'Junk' }
const byRole = roles => Object.fromEntries([...roles].map(([p, r]) => [r, p]))
const listed = (set = MIXED) => set.map(f => ({ path: f.path, delimiter: '.', specialUse: null }))
const countsOf = (set = MIXED) => new Map(set.map(f => [f.path, f.messages]))

test('resolveRoles: the mixed set without SPECIAL-USE: the contested roles wait for counts, then the bigger folder wins', () => {
  const first = resolveRoles(listed())
  assert.deepEqual(byRole(first.roles), { inbox: 'INBOX', drafts: 'Drafts' }, 'only the uncontested roles before the counts')
  assert.deepEqual(first.needCounts.sort(), ['Elküldött elemek', 'INBOX.Elküldött elemek', 'INBOX.Törölt elemek', 'Junk', 'Levélszemét', 'Sent', 'Trash', 'Törölt elemek'].sort())
  const { roles, needCounts } = resolveRoles(listed(), { counts: countsOf() })
  assert.deepEqual(byRole(roles), WANTED)
  assert.deepEqual(needCounts, [])
})

test('resolveRoles: the server\'s own flag beats the counts and the names; that role needs no count', () => {
  const folders = listed().map(f => (f.path === 'Elküldött elemek' ? { ...f, specialUse: '\\Sent' } : f))
  const { roles, needCounts } = resolveRoles(folders)
  assert.equal(byRole(roles).sent, 'Elküldött elemek')
  assert.ok(!needCounts.includes('Sent'), 'no STATUS for a role the server named')
  assert.equal(byRole(resolveRoles(folders, { counts: countsOf() }).roles).sent, 'Elküldött elemek')
})

test('resolveRoles: a decided role stays (it does not move with the counts), unless the folder is gone or the server names another', () => {
  const previous = new Map([['INBOX', 'inbox'], ['Elküldött elemek', 'sent'], ['Trash', 'trash']])
  const counts = countsOf()
  const kept = resolveRoles(listed(), { previous, counts })
  assert.equal(byRole(kept.roles).sent, 'Elküldött elemek', 'sticky: the stored role wins over a bigger name candidate')
  const gone = resolveRoles(listed().filter(f => f.path !== 'Elküldött elemek'), { previous, counts })
  assert.equal(byRole(gone.roles).sent, 'Sent', 'the stored folder is gone: decided again')
  const flagged = listed().map(f => (f.path === 'Sent' ? { ...f, specialUse: '\\Sent' } : f))
  assert.equal(byRole(resolveRoles(flagged, { previous, counts }).roles).sent, 'Sent', 'a real server flag overrides the stored role')
  // a folder keeps one role: the stored sent folder is flagged \Trash by the server -> trash; sent decided again
  const both = listed().map(f => (f.path === 'Elküldött elemek' ? { ...f, specialUse: '\\Trash' } : f))
  const r = byRole(resolveRoles(both, { previous, counts }).roles)
  assert.equal(r.trash, 'Elküldött elemek')
  assert.equal(r.sent, 'Sent')
})

test('resolveRoles: ties go to the shallower path, then the English name (ROLE_NAMES order), then the path; a refused STATUS counts as none', () => {
  const f = paths => paths.map(p => ({ path: p, delimiter: '.', specialUse: null }))
  const pick = (paths, counts) => byRole(resolveRoles(f(['INBOX', ...paths]), { counts: new Map(Object.entries(counts)) }).roles).sent
  assert.equal(pick(['INBOX.Sent', 'Sent'], { Sent: 5, 'INBOX.Sent': 5 }), 'Sent', 'equal counts: the top level')
  assert.equal(pick(['Elküldött elemek', 'Sent'], { Sent: 5, 'Elküldött elemek': 5 }), 'Sent', 'equal counts and depth: the English name')
  assert.equal(pick(['Sent Items', 'Sent'], { Sent: 0, 'Sent Items': 0 }), 'Sent', 'ROLE_NAMES order: sent before sent items')
  assert.equal(pick(['Elküldött elemek', 'Sent'], { Sent: null, 'Elküldött elemek': 0 }), 'Elküldött elemek', 'a known 0 beats an unknown count')
  assert.equal(pick(['Elküldött elemek', 'Sent'], { Sent: null, 'Elküldött elemek': null }), 'Sent', 'no count at all: the name order')
  assert.equal(pick(['INBOX.Sent', 'Elküldött elemek'], { 'INBOX.Sent': 900, 'Elküldött elemek': 3 }), 'INBOX.Sent', 'the count comes before the depth')
})

test('assignRoles: stored roles answer for a listed account; without them (POP3, before the first sync) the old rule', () => {
  const rows = MIXED.map(f => ({ path: f.path, delimiter: '.', special_use: null, role: WANTED[Object.keys(WANTED).find(r => WANTED[r] === f.path)] ? Object.keys(WANTED).find(r => WANTED[r] === f.path) : null }))
  assert.deepEqual(byRole(assignRoles(rows)), WANTED)
  // a stored role that names the inbox elsewhere does not move it: INBOX is the inbox by name
  assert.equal(assignRoles([{ path: 'INBOX', role: null }, { path: 'Other', role: 'inbox' }, { path: 'Sent', role: 'sent' }]).get('INBOX'), 'inbox')
  // the 0.14.0 rows (the name guess stored as a flag): the old rule still answers until the first sync stores roles
  const old = MIXED.map(f => ({ path: f.path, delimiter: '.', special_use: { 'Elküldött elemek': '\\Sent', 'Törölt elemek': '\\Trash', Drafts: '\\Drafts', Junk: '\\Junk' }[f.path] || null }))
  assert.equal(byRole(assignRoles(old)).sent, 'Elküldött elemek')
  // POP3's local folders: special_use, no role
  assert.deepEqual(byRole(assignRoles([{ path: 'INBOX', special_use: null }, { path: 'Sent', special_use: '\\Sent' }])), { inbox: 'INBOX', sent: 'Sent' })
})

function fakeMixed({ source = 'name', placeholders = true } = {}) {
  const server = new FakeImapServer()
  server.delimiter = '.'
  // what imapflow's list() reports on this server without SPECIAL-USE: its own guess, the alphabetically first name
  const guess = { 'Elküldött elemek': '\\Sent', 'Törölt elemek': '\\Trash', Drafts: '\\Drafts', Junk: '\\Junk' }
  for (const f of MIXED) {
    server.addMailbox(f.path, guess[f.path] ? { specialUse: guess[f.path], specialUseSource: source } : {})
    if (placeholders) for (let i = 0; i < Math.min(f.messages, 30); i++) server.mailboxes.get(f.path).messages.set(i + 1, { uid: i + 1, flags: new Set(), raw: Buffer.alloc(0) })
  }
  return server
}

function syncerFor(t, index, account, server) {
  const changes = []
  const syncer = new Syncer({ account, index, connect: () => server.connect(), onChange: c => changes.push(c) })
  // the fake's messages are placeholders: only the folder level is synced here (the row, as syncFolder makes it)
  syncer.syncFolder = async (client, f) => {
    if (!index.getFolder(account.id, f.path)) index.upsertFolder({ account_id: account.id, path: f.path, delimiter: f.delimiter, special_use: f.specialUse || null, uidvalidity: '1' })
    return false
  }
  syncer.syncBodies = async () => {}
  onCleanup(t, () => syncer.stop())
  return { syncer, changes }
}

test('sync: the name guess is not stored as special_use; the roles are stored; STATUS only for the contested candidates', async t => {
  const { db, index } = memoryIndex(t)
  const account = addAccount(db)
  const server = fakeMixed()
  // the fake counts as messages what is in it: make Sent and Trash the big ones, as on the real server
  const fill = (p, n) => {
    for (let i = 0; i < n; i++) server.mailboxes.get(p).messages.set(1000 + i, { uid: 1000 + i, flags: new Set(), raw: Buffer.alloc(0) })
  }
  fill('Sent', 60)
  fill('Trash', 50)
  const { syncer, changes } = syncerFor(t, index, account, server)
  await syncer.run()
  assert.deepEqual(byRole(assignRoles(index.folderList(account.id))), WANTED)
  assert.deepEqual(byRole(index.folderRoles(account.id)), WANTED)
  assert.deepEqual(server.statusLog.map(s => s.path).sort(), ['Elküldött elemek', 'INBOX.Elküldött elemek', 'INBOX.Törölt elemek', 'Junk', 'Levélszemét', 'Sent', 'Trash', 'Törölt elemek'].sort())
  assert.ok(server.statusLog.every(s => s.query.messages === true))
  assert.ok(changes.some(c => c.folders.includes('Sent')), 'a role change is reported (the tree is drawn again)')
  // second run: every role decided, no STATUS, no change
  server.statusLog.length = 0
  changes.length = 0
  await syncer.run()
  assert.deepEqual(server.statusLog, [])
  assert.ok(!changes.some(c => c.folders.includes('Sent')))
  // the tree shows the role folders on top, the Outlook ones as ordinary folders
  const tree = buildFolderTree(index.folders(account.id))
  assert.deepEqual(tree.filter(n => n.role).map(n => [n.role, n.path]), [['inbox', 'INBOX'], ['drafts', 'Drafts'], ['sent', 'Sent'], ['trash', 'Trash'], ['junk', 'Junk']])
})

test('sync: the stored special_use is only the server\'s flag; a server that names its folders wins without STATUS', async t => {
  const { db, index } = memoryIndex(t)
  const account = addAccount(db)
  const server = fakeMixed({ placeholders: false })
  const { syncer } = syncerFor(t, index, account, server)
  // the real per-folder sync (empty folders): it is the one that stores special_use
  delete syncer.syncFolder
  await syncer.run()
  assert.equal(syncer.state.lastError, null, syncer.state.lastError)
  const su = Object.fromEntries(index.folderList(account.id).map(f => [f.path, f.special_use]))
  assert.equal(su['Elküldött elemek'], null, 'imapflow\'s name guess is not stored')
  assert.equal(su.Drafts, null)

  const { db: db2, index: index2 } = memoryIndex(t)
  const account2 = addAccount(db2)
  const flagged = new FakeImapServer()
  flagged.delimiter = '.'
  for (const f of MIXED) flagged.addMailbox(f.path, f.flags ? { specialUse: f.flags[0] } : {})
  const { syncer: s2 } = syncerFor(t, index2, account2, flagged)
  await s2.run()
  assert.deepEqual(byRole(index2.folderRoles(account2.id)), WANTED)
  assert.deepEqual(flagged.statusLog, [], 'every contested role named by the server: no STATUS')
})

test('sync: a refused STATUS does not stop the sync; the folder only loses its count', async t => {
  const { db, index } = memoryIndex(t)
  const account = addAccount(db)
  const server = fakeMixed()
  server.refuseStatus.add('Sent')
  for (let i = 0; i < 60; i++) server.mailboxes.get('Trash').messages.set(1000 + i, { uid: 1000 + i, flags: new Set(), raw: Buffer.alloc(0) })
  const { syncer } = syncerFor(t, index, account, server)
  await syncer.run()
  assert.equal(syncer.state.lastError, null)
  const r = byRole(index.folderRoles(account.id))
  assert.equal(r.trash, 'Trash')
  assert.equal(r.sent, 'Elküldött elemek', 'Sent has no count (refused), Elküldött elemek has 9: the known count wins')
})

test('upgrade: a 0.14.0 database (schema 8, the name guess stored as special_use) migrates to the latest and the first sync puts the roles right', async t => {
  const file = path.join(tempDir(t), 'mail.sqlite')
  const key = Buffer.alloc(32, 5)
  const old = openDatabase(file, key)
  migrate(old, MIGRATIONS.slice(0, 8))
  const acc = Number(old.prepare("INSERT INTO accounts (name, email, type, in_host, in_port, in_security, in_user, body_index_days, created_at) VALUES ('Owner', 'z@example.invalid', 'imap', 'h', 993, 'tls', 'u', 1095, 0)").run().lastInsertRowid)
  const guess = { 'Elküldött elemek': '\\Sent', 'Törölt elemek': '\\Trash', Drafts: '\\Drafts', Junk: '\\Junk' }
  const ins = old.prepare("INSERT INTO folders (account_id, path, delimiter, special_use, uidvalidity, is_local) VALUES (?, ?, '.', ?, '1', 0)")
  for (const f of MIXED) ins.run(acc, f.path, guess[f.path] || null)
  old.close()

  const { db, migration } = openMailDatabase(file, { key })
  onCleanup(t, () => db.close())
  assert.deepEqual(migration, { from: 8, to: MIGRATIONS.length, backup: backupPath(file, 8) })
  const index = new MailIndex(db)
  assert.equal(db.prepare('SELECT COUNT(*) FROM folders WHERE role IS NOT NULL').pluck().get(), 0, 'no role before the first sync')
  assert.equal(byRole(assignRoles(index.folderList(acc))).sent, 'Elküldött elemek', 'until the first sync: the 0.14.0 answer')

  const server = fakeMixed()
  for (let i = 0; i < 60; i++) server.mailboxes.get('Sent').messages.set(1000 + i, { uid: 1000 + i, flags: new Set(), raw: Buffer.alloc(0) })
  for (let i = 0; i < 50; i++) server.mailboxes.get('Trash').messages.set(1000 + i, { uid: 1000 + i, flags: new Set(), raw: Buffer.alloc(0) })
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(acc)
  const { syncer } = syncerFor(t, index, account, server)
  await syncer.run()
  assert.deepEqual(byRole(assignRoles(index.folderList(acc))), WANTED, 'after the first sync: Sent and Trash')
})

test('real imapflow over TCP, the mixed set without SPECIAL-USE: imapflow guesses the Outlook names, the app ends with Sent / Trash / Drafts / Junk', async t => {
  const wire = await startImapWire({ folders: MIXED })
  onCleanup(t, () => wire.close())
  const { db, index } = memoryIndex(t)
  const account = addAccount(db, { in_host: '127.0.0.1', in_port: wire.port, in_security: 'none' })
  const syncer = new Syncer({ account, index, getPassword: async () => 'p' })
  onCleanup(t, () => syncer.stop())
  await syncer.run()
  assert.equal(syncer.state.lastError, null, syncer.state.lastError)
  assert.deepEqual(byRole(assignRoles(index.folderList(account.id))), WANTED)
  assert.ok(index.folderList(account.id).every(f => f.special_use === null), 'no flag from the server, none stored')
  const statused = wire.log.filter(l => /^STATUS /i.test(l)).length
  assert.equal(statused, 8, 'STATUS for the contested candidates only')
  assert.ok(!wire.log.some(l => /^(SELECT|STORE|APPEND|EXPUNGE|MOVE|COPY|CREATE|DELETE|RENAME)\b/i.test(l)), wire.log.join(' | '))
  // what imapflow itself says about this list: the guesses the app no longer stores
  const { createImapClient } = await import('../core/imap/client.js')
  const client = createImapClient(account, 'p')
  await client.connect()
  onCleanup(t, () => client.logout().catch(() => {}))
  const list = await client.list()
  const guessed = Object.fromEntries(list.filter(f => f.specialUse && f.specialUse !== '\\Inbox').map(f => [f.specialUse, `${f.path} (${f.specialUseSource})`]))
  assert.deepEqual(guessed, { '\\Sent': 'Elküldött elemek (name)', '\\Trash': 'Törölt elemek (name)', '\\Drafts': 'Drafts (name)', '\\Junk': 'Junk (name)' })
  assert.ok(list.every(f => serverSpecialUse(f) === null))
})

test('real imapflow over TCP, the same set WITH SPECIAL-USE on Sent/Trash/Drafts/Junk: the flags decide, no STATUS', async t => {
  const wire = await startImapWire({ folders: MIXED, specialUse: true })
  onCleanup(t, () => wire.close())
  const { db, index } = memoryIndex(t)
  const account = addAccount(db, { in_host: '127.0.0.1', in_port: wire.port, in_security: 'none' })
  const syncer = new Syncer({ account, index, getPassword: async () => 'p' })
  onCleanup(t, () => syncer.stop())
  await syncer.run()
  assert.equal(syncer.state.lastError, null, syncer.state.lastError)
  assert.deepEqual(byRole(assignRoles(index.folderList(account.id))), WANTED)
  assert.equal(index.getFolder(account.id, 'Sent').special_use, '\\Sent', 'the server\'s flag is stored')
  assert.equal(wire.log.filter(l => /^STATUS /i.test(l)).length, 0, 'every contested role named by the server: no STATUS')
})
