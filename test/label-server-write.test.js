// Putting labels on / taking them off on an IMAP account's server (0.17.0): applyLabels with the real SyncManager on
// fake IMAP servers. The keyword goes as UID STORE +FLAGS / -FLAGS (never a FLAGS replace), one command per folder and
// call, and the index follows only the server's yes; the folder's PERMANENTFLAGS decide (\* or the keyword listed,
// none sent = allowed), a folder that does not allow it keeps the label locally (`local`); an account out of reach and a
// recreated folder (UIDVALIDITY) change nothing (`failed`), the other groups stand.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { memoryIndex, addAccount, addMessage, DAY, sealedStore } from './helpers/fixtures.js'
import { FakeImapServer } from './helpers/fake-imap.js'
import { onCleanup, tempDir } from './helpers/tmp.js'
import { SyncManager } from '../app/main/sync-manager.js'
import { Labels } from '../core/db/labels.js'
import { applyLabels } from '../app/main/ipc/labels.js'
import { storeKeywords } from '../core/imap/actions.js'

const NOW = Date.UTC(2026, 10, 18, 9, 0, 0)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const until = async (fn, ms = 5000) => {
  const t0 = Date.now()
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting')
    await sleep(5)
  }
}
const mail = (n, extra = {}) => ({ from: 'a@example.invalid', to: 'b@example.invalid', subject: `Levél ${n}`, messageId: `<m${n}@example.invalid>`, date: NOW - DAY - n * 1000, body: `szöveg ${n}`, ...extra })

async function setup(t) {
  const { db, index } = memoryIndex(t)
  const storeDir = path.join(tempDir(t), 'store')
  const one = addAccount(db, { name: 'Első fiók', in_port: 49801 })
  const two = addAccount(db, { name: 'Második fiók', in_port: 49802 })
  const pop = addAccount(db, { name: 'POP3-fiók', type: 'pop3', in_port: 995 })
  const sa = new FakeImapServer().addMailbox('INBOX').addMailbox('Archív')
  const sb = new FakeImapServer().addMailbox('INBOX')
  sa.addMessage('INBOX', mail(1, { flags: ['\\Seen', '$Forwarded', 'Idegen'] }))
  sa.addMessage('INBOX', mail(2))
  sa.addMessage('Archív', mail(3))
  sb.addMessage('INBOX', mail(4))
  const servers = new Map([[one.id, sa], [two.id, sb]])
  const store = {
    list: () => db.prepare("SELECT * FROM accounts WHERE type = 'imap' ORDER BY id").all(),
    getRow: id => db.prepare('SELECT * FROM accounts WHERE id = ?').get(id),
    passwordsFor: () => ({ incoming: 'x' }),
  }
  const manager = new SyncManager({ store, index, sealed: sealedStore(storeDir), notify: () => {}, connect: async account => servers.get(account.id).connect(), now: () => NOW, throttleMs: 5, syncerOptions: { retryDelaysMs: [60_000] }, idleOptions: { retryDelaysMs: [60_000], debounceMs: 10 } })
  onCleanup(t, () => manager.stopAll())
  manager.startAll()
  await until(() => manager.status().every(s => s.lastFinished) && index.countFolder(one.id, 'INBOX') === 2 && index.countFolder(two.id, 'INBOX') === 1)
  const labels = new Labels(db)
  const changes = []
  const notices = []
  const syncs = []
  const ctx = {
    labels,
    withConnection: (id, fn) => manager.withConnection(id, fn),
    requestSync: (id, folders) => syncs.push([id, folders]),
    onChange: c => changes.push(c),
    notify: n => notices.push(n),
  }
  const row = (account, folder, n) => db.prepare('SELECT * FROM messages WHERE account_id = ? AND folder = ? AND subject = ?').get(account, folder, `Levél ${n}`)
  const popRow = addMessage(index, pop.id, { uid: 1, messageId: '<p1@example.invalid>' })
  const serverFlags = (server, folder, uid) => [...server.mailboxes.get(folder).messages.get(uid).flags].sort()
  const stores = server => server.actionLog.filter(x => x.op === 'flags+' || x.op === 'flags-').map(x => [x.op, x.path, x.uids, x.flags])
  return { db, index, manager, labels, ctx, changes, notices, syncs, one, two, pop, sa, sb, row, popRow, serverFlags, stores }
}

test('\\* in PERMANENTFLAGS: on -> one +FLAGS per folder on the server, then the index; off -> -FLAGS; the other flags untouched, no FLAGS replace', async t => {
  const s = await setup(t)
  const label = s.labels.create('Ügyfél', '#2e7d32')
  const r1 = s.row(s.one.id, 'INBOX', 1)
  const r2 = s.row(s.one.id, 'INBOX', 2)
  const r3 = s.row(s.one.id, 'Archív', 3)
  s.sa.actionLog.length = 0
  const res = await applyLabels(s.ctx, { ids: [r1.id, r2.id, r3.id], add: [label.id] })
  assert.deepEqual(res.failed, [])
  assert.deepEqual(res.local, [])
  assert.equal(res.changed, 3)
  assert.deepEqual(s.stores(s.sa), [['flags+', 'INBOX', [r1.uid, r2.uid], [label.keyword]], ['flags+', 'Archív', [r3.uid], [label.keyword]]])
  assert.deepEqual(s.serverFlags(s.sa, 'INBOX', r1.uid), ['$Forwarded', 'Idegen', '\\Seen', label.keyword].sort())
  assert.deepEqual(s.index.get(r1.id).flags.split(' ').sort(), ['$Forwarded', 'Idegen', '\\Seen', label.keyword].sort())
  for (const r of [r1, r2, r3]) assert.deepEqual(s.labels.labelsOfRows([r.id]).get(r.id), [label.id])
  assert.deepEqual(s.changes.map(c => [c.accountId, [...c.folders].sort()]), [[s.one.id, ['Archív', 'INBOX']]], 'one event per account')
  assert.deepEqual(s.notices, [{ kind: 'labels' }])
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM message_labels').get().n, 0, 'no local binding')

  s.sa.actionLog.length = 0
  const off = await applyLabels(s.ctx, { ids: [r1.id], remove: [label.id] })
  assert.equal(off.changed, 1)
  assert.deepEqual(s.stores(s.sa), [['flags-', 'INBOX', [r1.uid], [label.keyword]]])
  assert.deepEqual(s.serverFlags(s.sa, 'INBOX', r1.uid), ['$Forwarded', 'Idegen', '\\Seen'])
  assert.deepEqual(s.index.get(r1.id).flags.split(' ').sort(), ['$Forwarded', 'Idegen', '\\Seen'])
  assert.ok(!s.sa.actionLog.some(x => !['flags+', 'flags-', 'uidset'].includes(x.op)), 'nothing but +FLAGS / -FLAGS')
})

test('no \\* and the keyword not listed: no STORE, the label bound locally, `local` in the answer; listed without \\*: the STORE goes (the server\'s spelling); no PERMANENTFLAGS at all: allowed', async t => {
  const s = await setup(t)
  const label = s.labels.create('Számla', '#d32f2f')
  const r1 = s.row(s.one.id, 'INBOX', 1)
  const r3 = s.row(s.one.id, 'Archív', 3)
  s.sa.mailboxes.get('Archív').permanentFlags = ['\\Seen', '\\Flagged', '$Forwarded']
  s.sa.actionLog.length = 0
  const res = await applyLabels(s.ctx, { ids: [r1.id, r3.id], add: [label.id] })
  assert.deepEqual(res.local, [{ accountId: s.one.id, folder: 'Archív' }])
  assert.deepEqual(res.failed, [])
  assert.deepEqual(s.stores(s.sa), [['flags+', 'INBOX', [r1.uid], [label.keyword]]], 'no STORE in Archív')
  assert.deepEqual(s.serverFlags(s.sa, 'Archív', r3.uid), [])
  assert.deepEqual(s.labels.labelsOfRows([r3.id]).get(r3.id), [label.id], 'shown from the local binding')
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM message_labels WHERE account_id = ?').get(s.one.id).n, 1)
  // taking off: -FLAGS there too (always allowed) and the local binding goes
  s.sa.actionLog.length = 0
  const off = await applyLabels(s.ctx, { ids: [r3.id], remove: [label.id] })
  assert.deepEqual(off.local, [])
  assert.deepEqual(s.stores(s.sa), [['flags-', 'Archív', [r3.uid], [label.keyword]]])
  assert.equal(s.labels.labelsOfRows([r3.id]).get(r3.id), undefined)
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM message_labels').get().n, 0)

  // the keyword listed (another spelling), no \*: it goes, in the server's spelling
  s.sa.mailboxes.get('Archív').permanentFlags = ['\\Seen', label.keyword.toUpperCase()]
  s.sa.actionLog.length = 0
  const listed = await applyLabels(s.ctx, { ids: [r3.id], add: [label.id] })
  assert.deepEqual([listed.local, listed.failed], [[], []])
  assert.deepEqual(s.stores(s.sa), [['flags+', 'Archív', [r3.uid], [label.keyword.toUpperCase()]]])
  assert.deepEqual(s.labels.labelsOfRows([r3.id]).get(r3.id), [label.id])

  // no PERMANENTFLAGS sent (RFC 3501: every flag is permanent)
  s.sa.mailboxes.get('INBOX').permanentFlags = null
  const r2 = s.row(s.one.id, 'INBOX', 2)
  s.sa.actionLog.length = 0
  const none = await applyLabels(s.ctx, { ids: [r2.id], add: [label.id] })
  assert.deepEqual([none.local, none.failed], [[], []])
  assert.deepEqual(s.stores(s.sa), [['flags+', 'INBOX', [r2.uid], [label.keyword]]])
})

test('two accounts, three folders and a POP3 row in one call: one group per folder; the stopped account fails (sync_stopped), the rest is done', async t => {
  const s = await setup(t)
  const label = s.labels.create('Projekt', '#1e88e5')
  const r1 = s.row(s.one.id, 'INBOX', 1)
  const r3 = s.row(s.one.id, 'Archív', 3)
  const r4 = s.row(s.two.id, 'INBOX', 4)
  // the second account's login is refused: its sync stops, the interactive connection is not tried
  s.sb.rejectLogin = true
  s.sb.dropConnections()
  s.manager.syncNow(s.two.id)
  await until(() => s.manager.status().find(x => x.accountId === s.two.id).errorCode === 'auth_failed')
  const attempts = s.sb.loginAttempts
  const res = await applyLabels(s.ctx, { ids: [r1.id, r3.id, r4.id, s.popRow], add: [label.id] })
  assert.deepEqual(res.failed, [{ accountId: s.two.id, folder: 'INBOX', error: 'sync_stopped' }])
  assert.equal(s.sb.loginAttempts, attempts, 'no login tried on the stopped account')
  assert.equal(res.changed, 3, 'two server rows + the POP3 binding')
  for (const r of [r1.id, r3.id, s.popRow]) assert.deepEqual(s.labels.labelsOfRows([r]).get(r), [label.id], `row ${r}`)
  assert.equal(s.labels.labelsOfRows([r4.id]).get(r4.id), undefined, 'the stopped account: nothing')
  assert.ok(!s.index.get(r4.id).flags.split(' ').includes(label.keyword))
  assert.deepEqual(s.serverFlags(s.sb, 'INBOX', r4.uid), [])
  assert.deepEqual(s.changes.map(c => `${c.accountId}:${[...c.folders].sort().join(',')}`).sort(), [`${s.one.id}:Archív,INBOX`, `${s.pop.id}:INBOX`].sort())
})

test('UIDVALIDITY changed on the server: that folder changes nothing (and gets a sync), the other folder is done; a server NO is server_refused', async t => {
  const s = await setup(t)
  const label = s.labels.create('Régi', '#00897b')
  const r1 = s.row(s.one.id, 'INBOX', 1)
  const r3 = s.row(s.one.id, 'Archív', 3)
  s.sa.mailboxes.get('Archív').uidValidity = 999
  s.sa.actionLog.length = 0
  const res = await applyLabels(s.ctx, { ids: [r1.id, r3.id], add: [label.id] })
  assert.deepEqual(res.failed, [{ accountId: s.one.id, folder: 'Archív', error: 'uidvalidity_changed' }])
  assert.deepEqual(s.syncs, [[s.one.id, ['Archív']]])
  assert.deepEqual(s.stores(s.sa).map(x => x[1]), ['INBOX'])
  assert.equal(s.labels.labelsOfRows([r3.id]).get(r3.id), undefined)
  assert.deepEqual(s.labels.labelsOfRows([r1.id]).get(r1.id), [label.id])

  s.sa.mailboxes.get('Archív').uidValidity = s.index.getFolder(s.one.id, 'Archív').uidvalidity
  s.sa.refuseOps.add('flags+')
  const refused = await applyLabels(s.ctx, { ids: [r3.id], add: [label.id] })
  assert.deepEqual(refused.failed, [{ accountId: s.one.id, folder: 'Archív', error: 'server_refused' }])
  assert.equal(refused.changed, 0)
  assert.equal(s.labels.labelsOfRows([r3.id]).get(r3.id), undefined, 'not bound locally either')
})

test('the checks come first: an unknown label or a missing row changes nothing on the server or in the database', async t => {
  const s = await setup(t)
  const label = s.labels.create('A', '#000000')
  const r1 = s.row(s.one.id, 'INBOX', 1)
  s.sa.actionLog.length = 0
  await assert.rejects(applyLabels(s.ctx, { ids: [r1.id], add: [label.id, 999] }), { code: 'bad_request' })
  await assert.rejects(applyLabels(s.ctx, { ids: [r1.id, 424242], add: [label.id] }), { code: 'not_found' })
  assert.deepEqual(s.stores(s.sa), [])
  assert.ok(!s.index.get(r1.id).flags.split(' ').includes(label.keyword))
})

test('storeKeywords alone: nothing to do sends nothing; a refused keyword is never sent; the decision is read in the folder\'s lock', async () => {
  const log = []
  const client = {
    mailbox: null,
    async getMailboxLock(folder) {
      this.mailbox = { path: folder, uidValidity: 5n, permanentFlags: new Set(['\\Seen']) }
      return { release: () => {} }
    },
    async messageFlagsAdd(range, flags) {
      log.push(['+', range, flags])
      return true
    },
    async messageFlagsRemove(range, flags) {
      log.push(['-', range, flags])
      return true
    },
  }
  assert.deepEqual(await storeKeywords(client, 'INBOX', [], { add: ['a'] }), { added: [], refused: [] })
  assert.deepEqual(await storeKeywords(client, 'INBOX', [1], {}), { added: [], refused: [] })
  assert.deepEqual(log, [])
  assert.deepEqual(await storeKeywords(client, 'INBOX', [3, 1, 2], { add: ['a'], remove: ['b', 'B'] }, { uidvalidity: 5 }), { added: [], refused: ['a'] })
  assert.deepEqual(log, [['-', '1:3', ['b', 'B']]])
  await assert.rejects(storeKeywords(client, 'INBOX', [1], { add: ['a'] }, { uidvalidity: 6 }), { code: 'uidvalidity_changed' })
})

test('the real imapflow on a TCP server: the PERMANENTFLAGS of the SELECT decide, the wire carries UID STORE +FLAGS / -FLAGS only', async t => {
  const { ImapFlow } = await import('imapflow')
  const { startImapWire } = await import('./helpers/imap-wire.js')
  const wire = await startImapWire({
    folders: [
      { path: 'INBOX', mail: [{ uid: 1, flags: ['\\Seen', 'Idegen'] }, { uid: 2 }, { uid: 5 }] },
      { path: 'Szigoru', permanentFlags: ['\\Seen', '\\Flagged'], mail: [{ uid: 3 }] },
    ],
  })
  onCleanup(t, () => wire.close())
  const client = new ImapFlow({ host: '127.0.0.1', port: wire.port, secure: false, doSTARTTLS: false, auth: { user: 'u', pass: 'p' }, logger: false })
  await client.connect()
  onCleanup(t, () => client.logout().catch(() => {}))
  assert.deepEqual(await storeKeywords(client, 'INBOX', [1, 2], { add: ['sz=c3=a1mla'] }, { uidvalidity: 7 }), { added: ['sz=c3=a1mla'], refused: [] })
  assert.deepEqual(wire.flagsOf('INBOX', 1).sort(), ['Idegen', '\\Seen', 'sz=c3=a1mla'].sort())
  assert.deepEqual(await storeKeywords(client, 'Szigoru', [3], { add: ['sz=c3=a1mla'] }), { added: [], refused: ['sz=c3=a1mla'] })
  assert.deepEqual(wire.flagsOf('Szigoru', 3), [])
  await storeKeywords(client, 'INBOX', [1], { remove: ['sz=c3=a1mla'] })
  assert.deepEqual(wire.flagsOf('INBOX', 1).sort(), ['Idegen', '\\Seen'])
  const stores = wire.log.filter(l => /STORE/i.test(l)).map(l => l.replace(/^UID /, ''))
  assert.deepEqual(stores, ['STORE 1:2 +FLAGS (sz=c3=a1mla)', 'STORE 1 -FLAGS (sz=c3=a1mla)'], 'one +FLAGS for the two UIDs, no STORE in Szigoru, no FLAGS replace')
  await assert.rejects(storeKeywords(client, 'INBOX', [1], { add: ['x'] }, { uidvalidity: 8 }), { code: 'uidvalidity_changed' })
})
