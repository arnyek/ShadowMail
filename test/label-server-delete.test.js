// Deleting a label from the server too, uploading the old local labels, and the other programs' keywords (0.17.0), with
// the real SyncManager on fake IMAP servers. Delete: every IMAP row carrying the keyword loses it (one UID STORE -FLAGS
// per folder), and only when every folder went through is the label gone; a server out of reach keeps it, a second
// call takes the rest. Upload: at the end of the first full run of a session an IMAP account's local bindings go to the
// server as the keyword on every copy, then the binding goes; a folder that does not allow it keeps the binding and is
// not tried again in that session. Other keywords ($label1, NonJunk, $Forwarded, an unknown one) never become labels and
// stay on the server.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { memoryIndex, addAccount, addMessage, DAY, sealedStore } from './helpers/fixtures.js'
import { FakeImapServer } from './helpers/fake-imap.js'
import { onCleanup, tempDir } from './helpers/tmp.js'
import { SyncManager } from '../app/main/sync-manager.js'
import { Labels } from '../core/db/labels.js'
import { applyLabels, deleteLabel } from '../app/main/ipc/labels.js'
import { uploadLocalLabels } from '../core/imap/label-upload.js'

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

function servers() {
  const sa = new FakeImapServer().addMailbox('INBOX').addMailbox('Archív').addMailbox('Szigorú', { permanentFlags: ['\\Seen', '\\Flagged'] })
  const sb = new FakeImapServer().addMailbox('INBOX')
  sa.addMessage('INBOX', mail(1, { flags: ['\\Seen', '$Forwarded', 'NonJunk', '$label1', 'Ismeretlen'] }))
  sa.addMessage('INBOX', mail(2))
  sa.addMessage('Archív', mail(3))
  // the same message as 2 in another folder (a copy): an uploaded label goes on both
  sa.addMessage('Archív', mail(2))
  sa.addMessage('Szigorú', mail(5))
  sb.addMessage('INBOX', mail(4))
  return { sa, sb }
}

async function setup(t, { labelsOn = true, srv = servers(), db: given = null } = {}) {
  const { db, index } = given || memoryIndex(t)
  const storeDir = path.join(tempDir(t), 'store')
  const accounts = db.prepare("SELECT id FROM accounts WHERE type = 'imap' ORDER BY id").all().map(r => r.id)
  const one = accounts[0] ?? addAccount(db, { name: 'Első fiók', in_port: 49811 }).id
  const two = accounts[1] ?? addAccount(db, { name: 'Második fiók', in_port: 49812 }).id
  const { sa, sb } = srv
  const byId = new Map([[one, sa], [two, sb]])
  const store = {
    list: () => db.prepare("SELECT * FROM accounts WHERE type = 'imap' ORDER BY id").all(),
    getRow: id => db.prepare('SELECT * FROM accounts WHERE id = ?').get(id),
    passwordsFor: () => ({ incoming: 'x' }),
  }
  const labels = new Labels(db)
  const logs = []
  const manager = new SyncManager({ store, index, labels: labelsOn ? labels : null, log: l => logs.push(l), sealed: sealedStore(storeDir), notify: () => {}, connect: async account => byId.get(account.id).connect(), now: () => NOW, throttleMs: 5, syncerOptions: { retryDelaysMs: [60_000] }, idleOptions: { retryDelaysMs: [60_000], debounceMs: 10 } })
  onCleanup(t, () => manager.stopAll())
  manager.startAll()
  await until(() => manager.status().filter(s => [one, two].includes(s.accountId)).every(s => s.lastFinished) && index.countFolder(one, 'INBOX') === 2)
  const changes = []
  const syncs = []
  const ctx = { labels, withConnection: (id, fn) => manager.withConnection(id, fn), requestSync: (id, f) => syncs.push([id, f]), onChange: c => changes.push(c), notify: () => {} }
  const row = (account, folder, n) => db.prepare('SELECT * FROM messages WHERE account_id = ? AND folder = ? AND subject = ?').get(account, folder, `Levél ${n}`)
  const serverFlags = (server, folder, uid) => [...server.mailboxes.get(folder).messages.get(uid).flags].sort()
  const stores = server => server.actionLog.filter(x => x.op === 'flags+' || x.op === 'flags-').map(x => [x.op, x.path, x.uids, x.flags])
  return { db, index, manager, labels, ctx, changes, syncs, one, two, sa, sb, row, serverFlags, stores, logs }
}

test('delete: two accounts, three folders -> -FLAGS everywhere, then the label is gone; one account out of reach -> the label stays, the other folders done; again -> the rest, and the label goes', async t => {
  const s = await setup(t)
  const label = s.labels.create('Ügyfél', '#2e7d32')
  const r1 = s.row(s.one, 'INBOX', 1)
  const r3 = s.row(s.one, 'Archív', 3)
  const r4 = s.row(s.two, 'INBOX', 4)
  await applyLabels(s.ctx, { ids: [r1.id, r3.id, r4.id], add: [label.id] })
  assert.equal(s.labels.list()[0].count, 3)
  // another client wrote the keyword in upper case on one copy (the server and the synced index): it comes off too
  const upper = label.keyword.toUpperCase()
  s.sa.setFlags('Archív', r3.uid, [upper])
  s.db.prepare('UPDATE messages SET flags = ? WHERE id = ?').run(upper, r3.id)
  // the second server goes away
  s.sb.down = true
  s.sb.dropConnections()
  s.sa.actionLog.length = 0
  const first = await deleteLabel(s.ctx, label.id)
  assert.equal(first.deleted, false)
  assert.equal(first.count, 3, 'the count before')
  assert.deepEqual(first.failed.map(f => [f.accountId, f.folder]), [[s.two, 'INBOX']])
  assert.ok(['connection_refused', 'connection_lost'].includes(first.failed[0].error), first.failed[0].error)
  assert.ok(s.labels.get(label.id), 'the label stays')
  assert.deepEqual(s.stores(s.sa).map(x => [x[0], x[1]]).sort(), [['flags-', 'Archív'], ['flags-', 'INBOX']])
  assert.ok(!s.serverFlags(s.sa, 'INBOX', r1.uid).includes(label.keyword))
  assert.deepEqual(s.serverFlags(s.sa, 'Archív', r3.uid), [], 'every spelling off the server')
  assert.ok(s.serverFlags(s.sb, 'INBOX', r4.uid).includes(label.keyword), 'the unreachable one still has it')
  assert.deepEqual([s.labels.labelsOfRows([r1.id]).get(r1.id), s.labels.labelsOfRows([r4.id]).get(r4.id)], [undefined, [label.id]])
  // again with the server back: the rest comes off, the label goes; the first account is not asked again
  s.sb.down = false
  s.sa.actionLog.length = 0
  const second = await deleteLabel(s.ctx, label.id)
  assert.deepEqual(second, { deleted: true, count: 1 })
  assert.equal(s.labels.get(label.id), null)
  assert.ok(!s.serverFlags(s.sb, 'INBOX', r4.uid).includes(label.keyword))
  assert.deepEqual(s.stores(s.sa), [], 'nothing left on the first account')
  await assert.rejects(deleteLabel(s.ctx, label.id), { code: 'not_found' })
})

test('delete with only POP3 and local bindings: no server, at once, the bindings go with the label (the old way)', async t => {
  const { db, index } = memoryIndex(t)
  const pop = addAccount(db, { type: 'pop3', in_port: 995 }).id
  const labels = new Labels(db)
  const label = labels.create('Helyi', '#000000')
  const m = addMessage(index, pop, { uid: 1, messageId: '<p@example.invalid>' })
  labels.setLabels([m], { add: [label.id] })
  let connections = 0
  const res = await deleteLabel({ labels, withConnection: async () => connections++ }, label.id)
  assert.deepEqual(res, { deleted: true, count: 1 })
  assert.equal(connections, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM message_labels').get().n, 0)
})

test('upload: the old local bindings on IMAP rows go to the server on every copy at the end of the first full run, then the bindings go; a folder that does not allow it keeps the binding, and the next run does not try again', async t => {
  // a data folder whose IMAP rows carry local labels (as before the server labels): the rows from a sync without upload
  const srv = servers()
  const first = await setup(t, { labelsOn: false, srv })
  const label = first.labels.create('Régi helyi', '#1e88e5')
  const r2 = first.row(first.one, 'INBOX', 2)
  const r5 = first.row(first.one, 'Szigorú', 5)
  first.labels.setLabels([r2.id, r5.id], { add: [label.id] })
  assert.equal(first.db.prepare('SELECT COUNT(*) AS n FROM message_labels').get().n, 2)
  await first.manager.stopAll()
  srv.sa.actionLog.length = 0

  // a new session: the first full run uploads
  const s = await setup(t, { srv, db: { db: first.db, index: first.index } })
  await until(() => s.logs.some(l => /local label\(s\) uploaded/.test(l)))
  const copy = s.row(s.one, 'Archív', 2)
  assert.ok(s.serverFlags(s.sa, 'INBOX', r2.uid).includes(label.keyword), 'the INBOX copy')
  assert.ok(s.serverFlags(s.sa, 'Archív', copy.uid).includes(label.keyword), 'the other copy too')
  assert.deepEqual(s.serverFlags(s.sa, 'Szigorú', r5.uid), [], 'the folder that does not allow it: nothing')
  const bindings = s.db.prepare('SELECT label_key FROM message_labels').all().map(b => b.label_key)
  assert.deepEqual(bindings, [r5.label_key], 'the uploaded binding gone, the refused one kept')
  for (const r of [r2, copy, r5]) assert.deepEqual(s.labels.labelsOfRows([r.id]).get(r.id), [label.id], `row ${r.id} still shows it`)
  assert.ok(s.index.get(r2.id).flags.split(' ').includes(label.keyword), 'the index follows the server')
  assert.ok(s.logs.includes('labels: 1 local label(s) uploaded to the server, 1 kept local'), s.logs.join(' | '))
  assert.ok(!s.logs.some(l => l.includes('Régi helyi') || l.includes(label.keyword)), 'no name or keyword in the log')
  // a second full run in the same session: no STORE, and the refused folder is not even opened for it
  const before = s.stores(s.sa).length
  const opened = s.sa.openLog.filter(o => o.path === 'Szigorú' && !o.readOnly).length
  const runs = s.manager.status().find(x => x.accountId === s.one).runsEnded
  s.manager.syncNow(s.one)
  await until(() => s.manager.status().find(x => x.accountId === s.one).runsEnded > runs)
  assert.equal(s.stores(s.sa).length, before, 'not tried again in this session')
  assert.equal(s.sa.openLog.filter(o => o.path === 'Szigorú' && !o.readOnly).length, opened, 'no read-write SELECT for it either')
  assert.equal(s.logs.filter(l => /local label\(s\) uploaded/.test(l)).length, 1, 'one upload per session')
})

test('upload alone: a binding without a row is left alone; a refused STORE keeps the binding; a lost connection stops (done = false)', async t => {
  const s = await setup(t, { labelsOn: false })
  const label = s.labels.create('Árva', '#000000')
  const r1 = s.row(s.one, 'INBOX', 1)
  s.labels.setLabels([r1.id], { add: [label.id] })
  s.db.prepare("INSERT INTO message_labels (account_id, label_key, label_id, created_at) VALUES (?, 'm:gone@example.invalid', ?, 0)").run(s.one, label.id)
  const client = await s.sa.connect()
  s.sa.refuseOps.add('flags+')
  const refused = await uploadLocalLabels({ labels: s.labels, client, accountId: s.one })
  assert.deepEqual(refused, { uploaded: 0, kept: 1, done: true })
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM message_labels').get().n, 2, 'both kept (the orphan untouched)')
  s.sa.refuseOps.delete('flags+')
  client._closed()
  const lost = await uploadLocalLabels({ labels: s.labels, client, accountId: s.one })
  assert.equal(lost.done, false)
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM message_labels').get().n, 2)
  const fresh = await s.sa.connect()
  assert.deepEqual(await uploadLocalLabels({ labels: s.labels, client: fresh, accountId: s.one }), { uploaded: 1, kept: 0, done: true })
})

test('other programs\' keywords ($label1, NonJunk, $Forwarded, an unknown one): never labels, and a label on, off and deleted leaves them on the server', async t => {
  const s = await setup(t)
  const r1 = s.row(s.one, 'INBOX', 1)
  // a label named like a foreign keyword gets its own keyword, not the foreign one
  const odd = s.labels.create('$label1', '#000000')
  const plain = s.labels.create('Ismeretlen2', '#000000')
  assert.equal(odd.keyword, '=24label1')
  assert.equal(s.labels.labelsOfRows([r1.id]).get(r1.id), undefined, 'none of the server\'s keywords is a label')
  const foreign = ['$Forwarded', '$label1', 'Ismeretlen', 'NonJunk', '\\Seen']
  await applyLabels(s.ctx, { ids: [r1.id], add: [odd.id, plain.id] })
  assert.deepEqual(s.serverFlags(s.sa, 'INBOX', r1.uid), [...foreign, odd.keyword, plain.keyword].sort())
  await applyLabels(s.ctx, { ids: [r1.id], remove: [plain.id] })
  assert.deepEqual((await deleteLabel(s.ctx, odd.id)).deleted, true)
  assert.deepEqual(s.serverFlags(s.sa, 'INBOX', r1.uid), foreign.sort(), 'the foreign ones are all still there')
  assert.deepEqual(s.index.get(r1.id).flags.split(' ').sort(), foreign.sort())
})
