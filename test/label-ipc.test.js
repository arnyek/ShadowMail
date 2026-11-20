// The label IPC (0.17.0): mail:label over accounts and folders with the folder-change events (POP3: the other copy's
// folder too; IMAP: the server's keyword on that copy, a fake IMAP server), the bad requests that change nothing, the
// list rows' `labels`, the label list's own channels with their { kind: 'labels' } event, and 'locked' after the lock.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memoryIndex, addAccount, addMessage } from './helpers/fixtures.js'
import { Labels } from '../core/db/labels.js'
import { registerLabelIpc, LABEL_CHANNELS, applyLabels } from '../app/main/ipc/labels.js'
import { registerMailIpc } from '../app/main/ipc/mail.js'
import { createRoutedIpc } from '../app/main/routed-ipc.js'
import { registerReaderIpc } from '../app/main/ipc/reader.js'
import { tempDir } from './helpers/tmp.js'
import { FakeImapServer } from './helpers/fake-imap.js'

function fakeIpc() {
  const handlers = new Map()
  return {
    handle: (ch, fn) => handlers.set(ch, fn),
    call: (ch, ...args) => handlers.get(ch)({ trusted: true }, ...args),
    callAs: (trusted, ch, ...args) => handlers.get(ch)({ trusted }, ...args),
    handlers,
  }
}

function setup(t) {
  const { db, index } = memoryIndex(t)
  const imap = addAccount(db).id
  const pop = addAccount(db, { type: 'pop3', in_port: 995 }).id
  db.prepare("INSERT INTO folders (account_id, path, delimiter) VALUES (?, 'INBOX', '/'), (?, 'Archív', '/'), (?, 'INBOX', '/')").run(imap, imap, pop)
  const labels = new Labels(db)
  // the IMAP account's server: the label IPC reaches it only through withConnection (counted); a sync never
  const server = new FakeImapServer()
  for (const f of ['INBOX', 'Archív', 'Sent']) server.addMailbox(f)
  const net = { connections: 0, syncs: 0 }
  let client = null
  const withConnection = async (accountId, fn) => {
    assert.equal(accountId, imap, 'only the IMAP account goes to a server')
    net.connections++
    client = client || (await server.connect())
    return fn(client)
  }
  const manager = {
    withConnection,
    requestSync: () => { net.syncs++ },
    syncNow: () => { net.syncs++ },
    status: () => [],
  }
  const changes = []
  const notices = []
  const ipc = fakeIpc()
  registerLabelIpc({ ipcMain: ipc, labels, withConnection, requestSync: () => { net.syncs++ }, onChange: c => changes.push(c), notify: n => notices.push(n), isTrustedSender: e => e.trusted })
  registerMailIpc({ ipcMain: ipc, store: { list: () => [] }, index, manager, labels, isTrustedSender: e => e.trusted })
  // a message on the server at this UID (the index row is the test's own)
  const onServer = (folder, uid, flags = []) => {
    server.mailboxes.get(folder).nextUid = uid
    server.addMessage(folder, { from: 'a@example.invalid', to: 'b@example.invalid', subject: 's', date: 0, messageId: `<${folder}${uid}@example.invalid>`, body: 'x', flags })
  }
  const serverFlags = (folder, uid) => [...server.mailboxes.get(folder).messages.get(uid).flags].sort()
  return { db, index, labels, imap, pop, net, changes, notices, ipc, server, onServer, serverFlags }
}

const snapshot = db => JSON.stringify([db.prepare('SELECT * FROM labels ORDER BY id').all(), db.prepare('SELECT * FROM message_labels ORDER BY 1, 2, 3').all()])

test('mail:label: IMAP rows of two folders get the keyword on the server (that copy only), the POP3 row a local binding (every copy); a change event per folder', async t => {
  const s = setup(t)
  const a = addMessage(s.index, s.imap, { uid: 1, messageId: '<a@example.invalid>' })
  const b = addMessage(s.index, s.imap, { uid: 2, messageId: '<b@example.invalid>' })
  s.index.moveRows([{ id: b, folder: 'Archív', uid: 7 }])
  const c = addMessage(s.index, s.pop, { uid: 1, messageId: '<c@example.invalid>' })
  // the same message as a in another folder of the same account: on IMAP the label is the copy's (the server's rule)
  const a2 = addMessage(s.index, s.imap, { uid: 3, messageId: '<a@example.invalid>' })
  s.db.prepare("UPDATE messages SET folder = 'Sent' WHERE id = ?").run(a2)
  // the same message as c in another POP3 folder: a local binding is the message's, it shows there too
  const c2 = addMessage(s.index, s.pop, { uid: 2, messageId: '<c@example.invalid>' })
  s.db.prepare("UPDATE messages SET folder = 'Drafts' WHERE id = ?").run(c2)
  s.onServer('INBOX', 1, ['\\Seen', '$Forwarded', 'Idegen'])
  s.onServer('Archív', 7)
  s.onServer('Sent', 3)
  const label = (await s.ipc.call('labels:create', { name: 'Ügyfél', color: '#2e7d32' })).label
  s.notices.length = 0

  const res = await s.ipc.call('mail:label', { ids: [a, b, c], add: [label.id] })
  assert.deepEqual(res, { ok: true, changed: 3, local: [], failed: [] })
  assert.deepEqual(s.serverFlags('INBOX', 1), ['$Forwarded', 'Idegen', '\\Seen', label.keyword].sort(), 'the other flags untouched')
  assert.deepEqual(s.serverFlags('Archív', 7), [label.keyword])
  assert.deepEqual(s.serverFlags('Sent', 3), [], 'the other copy on the server: not labelled')
  const stores = s.server.actionLog.filter(x => x.op.startsWith('flags'))
  assert.deepEqual(stores.map(x => [x.op, x.path, x.uids, x.flags]), [['flags+', 'INBOX', [1], [label.keyword]], ['flags+', 'Archív', [7], [label.keyword]]], 'one +FLAGS per folder')
  assert.equal(s.index.get(a).flags.split(' ').includes(label.keyword), true, 'the index follows the server')
  for (const m of [a, b, c, c2]) assert.deepEqual(s.labels.labelsOfRows([m]).get(m), [label.id], `row ${m}`)
  assert.equal(s.labels.labelsOfRows([a2]).get(a2), undefined, 'the IMAP copy in Sent has none')
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM message_labels WHERE account_id = ?').get(s.imap).n, 0, 'no local binding on IMAP')
  const got = s.changes.map(ch => `${ch.accountId}:${[...ch.folders].sort().join(',')}`).sort()
  assert.deepEqual(got, [`${s.imap}:Archív,INBOX`, `${s.pop}:Drafts,INBOX`])
  assert.deepEqual(s.notices, [{ kind: 'labels' }])
  s.notices.length = 0
  s.changes.length = 0
  assert.deepEqual(await s.ipc.call('mail:label', { ids: [a, c], add: [label.id] }), { ok: true, changed: 0, local: [], failed: [] })
  assert.deepEqual(s.notices, [], 'already on: nothing changed, no event')
  assert.deepEqual(s.changes, [])
  assert.equal(s.net.syncs, 0, 'no sync')

  // the list rows carry it (one page)
  const page = await s.ipc.call('mail:list', { accountId: s.imap, folder: 'INBOX' })
  assert.deepEqual(page.rows.map(r => [r.id, r.labels]), [[a, [label.id]]])
  const pop = await s.ipc.call('mail:list', { accountId: s.pop, folder: 'INBOX' })
  assert.deepEqual(pop.rows[0].labels, [label.id])
  assert.deepEqual(s.labels.attach([{ id: a }, { id: a }, { id: b }]).map(r => r.labels), [[label.id], [label.id], [label.id]])

  // and off again: -FLAGS on the server (every spelling the row has), the POP3 binding from the other copy
  s.db.prepare('UPDATE messages SET flags = ? WHERE id = ?').run(`\\Seen ${label.keyword.toUpperCase()}`, b)
  s.server.actionLog.length = 0
  const off = await s.ipc.call('mail:label', { ids: [a, b, c2], remove: [label.id] })
  assert.deepEqual(off, { ok: true, changed: 3, local: [], failed: [] })
  assert.deepEqual(s.serverFlags('INBOX', 1), ['$Forwarded', 'Idegen', '\\Seen'])
  assert.deepEqual(s.serverFlags('Archív', 7), [])
  assert.deepEqual(s.server.actionLog.filter(x => x.op.startsWith('flags')).map(x => [x.op, x.path, [...x.flags].sort()]), [
    ['flags-', 'INBOX', [label.keyword]],
    ['flags-', 'Archív', [label.keyword, label.keyword.toUpperCase()].sort()],
  ])
  assert.equal(s.index.get(b).flags, '\\Seen', 'every spelling off in the index')
  for (const m of [a, b, c]) assert.equal(s.labels.labelsOfRows([m]).get(m), undefined, `row ${m}`)
  assert.equal(s.net.syncs, 0)
})

test('mail:label: an unknown label, a missing row, 501 ids, a string id, a bad shape: bad_request, nothing changes', async t => {
  const s = setup(t)
  const m = addMessage(s.index, s.imap, { uid: 1, messageId: '<m@example.invalid>' })
  const id = s.labels.create('A', '#000000').id
  s.labels.setLabels([m], { add: [id] })
  const before = snapshot(s.db)
  const many = Array.from({ length: 501 }, (_, i) => i + 1)
  for (const bad of [
    { ids: [m], add: [999] },
    { ids: [m], remove: [id], add: [999] },
    { ids: [m, 424242], add: [id] },
    { ids: many, add: [id] },
    { ids: ['1'], add: [id] },
    { ids: [m], add: ['1'] },
    { ids: [m], add: [id], extra: 1 },
    { ids: [m] },
    { ids: [m], add: [], remove: [] },
    { ids: [], add: [id] },
    { ids: [1.5], add: [id] },
    { ids: m, add: [id] },
    [m],
    null,
    'x',
  ]) {
    assert.deepEqual(await s.ipc.call('mail:label', bad), { ok: false, error: 'bad_request' }, JSON.stringify(bad))
  }
  assert.equal(snapshot(s.db), before, 'the database is unchanged')
  assert.deepEqual(s.changes, [])
  assert.deepEqual(await s.ipc.callAs(false, 'mail:label', { ids: [m], remove: [id] }), { ok: false, error: 'untrusted_sender' })
  assert.equal(snapshot(s.db), before)
})

test('the label list over IPC: create, rename, color, order, delete; each change sends { kind: "labels" }; the errors by code', async t => {
  const s = setup(t)
  const m = addMessage(s.index, s.imap, { uid: 1, messageId: '<m@example.invalid>' })
  s.onServer('INBOX', 1)
  const a = await s.ipc.call('labels:create', { name: 'Számla', color: '#D32F2F' })
  assert.deepEqual(a, { ok: true, label: { id: a.label.id, name: 'Számla', color: '#d32f2f', sort_order: 0, keyword: 'sz=c3=a1mla' } })
  const b = (await s.ipc.call('labels:create', { name: 'Ügyfél', color: '#1e88e5' })).label.id
  assert.equal((await s.ipc.call('labels:rename', { id: b, name: 'Partner' })).label.name, 'Partner')
  assert.equal((await s.ipc.call('labels:setColor', { id: b, color: '#00ff00' })).label.color, '#00ff00')
  assert.deepEqual((await s.ipc.call('labels:reorder', { ids: [b, a.label.id] })).labels.map(l => l.id), [b, a.label.id])
  await s.ipc.call('mail:label', { ids: [m], add: [a.label.id, b] })
  const list = await s.ipc.call('labels:list')
  assert.deepEqual(list.labels.map(l => [l.name, l.count]), [['Partner', 1], ['Számla', 1]])
  assert.ok(s.serverFlags('INBOX', 1).includes(a.label.keyword))
  assert.deepEqual(await s.ipc.call('labels:delete', { id: a.label.id }), { ok: true, deleted: true, count: 1 })
  assert.ok(!s.serverFlags('INBOX', 1).includes(a.label.keyword), 'the deletion took the keyword off the server too')
  assert.ok(s.serverFlags('INBOX', 1).includes(s.labels.get(b).keyword), 'the other label stays')
  assert.deepEqual((await s.ipc.call('mail:list', { accountId: s.imap, folder: 'INBOX' })).rows[0].labels, [b])
  assert.equal(s.notices.filter(n => n.kind === 'labels').length, 7, 'create x2, rename, color, order, mail:label, delete')
  assert.ok(s.notices.every(n => JSON.stringify(n) === '{"kind":"labels"}'), 'the event carries nothing else')

  s.notices.length = 0
  const before = snapshot(s.db)
  const cases = [
    ['labels:create', { name: 'partner', color: '#000000' }, 'name_taken'],
    ['labels:create', { name: '', color: '#000000' }, 'bad_name'],
    ['labels:create', { name: 'x', color: 'red' }, 'bad_color'],
    ['labels:create', { name: 'x', color: '#000000', sort_order: 9 }, 'bad_request'],
    ['labels:create', 'x', 'bad_request'],
    ['labels:rename', { id: 999, name: 'x' }, 'not_found'],
    ['labels:rename', { id: '1', name: 'x' }, 'bad_request'],
    ['labels:setColor', { id: b, color: '#12345' }, 'bad_color'],
    ['labels:setColor', { id: 999, color: '#123456' }, 'not_found'],
    ['labels:reorder', { ids: [] }, 'order_mismatch'],
    ['labels:reorder', { ids: [b, b] }, 'order_mismatch'],
    ['labels:reorder', { ids: 'x' }, 'bad_request'],
    ['labels:delete', { id: 999 }, 'not_found'],
    ['labels:delete', { id: 0 }, 'bad_request'],
    ['labels:delete', 5, 'bad_request'],
  ]
  for (const [ch, q, code] of cases) assert.deepEqual(await s.ipc.call(ch, q), { ok: false, error: code }, `${ch} ${JSON.stringify(q)}`)
  assert.equal(snapshot(s.db), before)
  assert.deepEqual(s.notices, [], 'a refused change sends no event')
})

test('every label channel answers "locked" after the lock (routed IPC), and works again after a new unlock', async t => {
  const s = setup(t)
  const ipcMain = fakeIpc()
  const routed = createRoutedIpc(ipcMain)
  routed.reserve(LABEL_CHANNELS)
  for (const ch of LABEL_CHANNELS) assert.deepEqual(await ipcMain.call(ch, {}), { ok: false, error: 'locked' }, `${ch} before the unlock`)
  registerLabelIpc({ ipcMain: routed, labels: s.labels, isTrustedSender: e => e.trusted })
  assert.equal((await ipcMain.call('labels:list')).ok, true)
  routed.clear()
  for (const ch of LABEL_CHANNELS) assert.deepEqual(await ipcMain.call(ch, { ids: [1], add: [1] }), { ok: false, error: 'locked' }, ch)
  registerLabelIpc({ ipcMain: routed, labels: s.labels, isTrustedSender: e => e.trusted })
  assert.equal((await ipcMain.call('labels:list')).ok, true)
  assert.deepEqual([...LABEL_CHANNELS].sort(), ['labels:create', 'labels:delete', 'labels:list', 'labels:rename', 'labels:reorder', 'labels:setColor', 'mail:label', 'mail:labelState', 'mail:labelsOf'])
})

test('mail:labelState: per label how many of the chosen rows carry it, a whole folder at once; mail:open gives the open message\'s labels', async t => {
  const s = setup(t)
  const ids = []
  for (let i = 1; i <= 1200; i++) ids.push(addMessage(s.index, s.imap, { uid: i, messageId: `<st${i}@example.invalid>` }))
  const a = s.labels.create('A', '#000000').id
  const b = s.labels.create('B', '#ffffff').id
  s.labels.setLabels(ids.slice(0, 500), { add: [a] })
  s.labels.setLabels(ids.slice(500, 1000), { add: [a] })
  s.labels.setLabels([ids[0]], { add: [b] })
  const st = await s.ipc.call('mail:labelState', { ids: [...ids, ids[0], 999999] })
  assert.equal(st.ok, true)
  assert.equal(st.total, 1200, 'the existing rows, repeats once')
  assert.deepEqual(new Map(st.counts), new Map([[a, 1000], [b, 1]]))
  const none = await s.ipc.call('mail:labelState', { ids: [ids[1100]] })
  assert.deepEqual([none.total, none.counts], [1, []])
  for (const bad of [{ ids: [] }, { ids: ['1'] }, { ids: [1], x: 1 }, { ids: Array.from({ length: 100001 }, (_, i) => i + 1) }, null]) {
    assert.deepEqual(await s.ipc.call('mail:labelState', bad), { ok: false, error: 'bad_request' }, JSON.stringify(bad)?.slice(0, 40))
  }
  assert.deepEqual(s.net, { connections: 0, syncs: 0 })
  // mail:open carries the open message's labels (the reader's chips), the reader's own fields unchanged
  const rIpc = fakeIpc()
  registerReaderIpc({ ipcMain: rIpc, reader: { open: async id => ({ id, subject: 'Tárgy' }) }, tmpDir: tempDir(t), labels: s.labels, isTrustedSender: () => true })
  assert.deepEqual(await rIpc.call('mail:open', ids[0]), { ok: true, message: { id: ids[0], subject: 'Tárgy', labels: [a, b] } })
  assert.deepEqual((await rIpc.call('mail:open', ids[1100])).message.labels, [])
})

test('mail:labelsOf: the stored labels of rows, by the message: another copy in another folder carries them too', async t => {
  const s = setup(t)
  const a = addMessage(s.index, s.imap, { uid: 1, messageId: '<copy@example.invalid>' })
  const b = addMessage(s.index, s.imap, { uid: 2, messageId: '<copy@example.invalid>' })
  s.db.prepare("UPDATE messages SET folder = 'Sent' WHERE id = ?").run(b)
  const c = addMessage(s.index, s.imap, { uid: 3, messageId: '<other@example.invalid>' })
  const l = s.labels.create('A', '#000000').id
  s.labels.setLabels([a], { add: [l] })
  assert.deepEqual(await s.ipc.call('mail:labelsOf', { ids: [b, c, b] }), { ok: true, labels: { [b]: [l], [c]: [] } })
  for (const bad of [{ ids: [] }, { ids: 5 }, { ids: ['1'] }, { ids: [1.5] }, { ids: [1], x: 1 }, { ids: Array.from({ length: 501 }, (_, i) => i + 1) }, null, [1]]) {
    assert.deepEqual(await s.ipc.call('mail:labelsOf', bad), { ok: false, error: 'bad_request' })
  }
})

test('labels:create at 1000 labels: too_many, nothing written, no event; reorder takes the whole list of 1000', async t => {
  const s = setup(t)
  const ins = s.db.prepare("INSERT INTO labels (name, color, sort_order, created_at) VALUES (?, '#000000', ?, 0)")
  s.db.transaction(() => { for (let i = 0; i < 1000; i++) ins.run(`L${i}`, i) })()
  const before = snapshot(s.db)
  assert.deepEqual(await s.ipc.call('labels:create', { name: 'One more', color: '#000000' }), { ok: false, error: 'too_many' })
  assert.equal(snapshot(s.db), before)
  assert.deepEqual(s.notices, [])
  const ids = (await s.ipc.call('labels:list')).labels.map(l => l.id).reverse()
  assert.deepEqual((await s.ipc.call('labels:reorder', { ids })).labels.map(l => l.id), ids)
})

// --- the merged { kind: 'labels' } event, on a fake clock -----------------------------------------------
function fakeClock() {
  let now = 0
  let timers = []
  return {
    now: () => now,
    set: (fn, ms) => {
      const t = { at: now + ms, fn }
      timers.push(t)
      return t
    },
    clear: t => (timers = timers.filter(x => x !== t)),
    // runs every timer due up to `to`, in time order
    advance(to) {
      for (;;) {
        const due = timers.filter(x => x.at <= to).sort((a, b) => a.at - b.at)[0]
        if (!due) break
        timers = timers.filter(x => x !== due)
        now = due.at
        due.fn()
      }
      now = to
    },
  }
}

test('the labels event merged: 200 batches 5 ms apart -> at most one event per 250 ms plus the closing one, sent after the last batch', async t => {
  const s = setup(t)
  const ids = Array.from({ length: 200 }, (_, i) => addMessage(s.index, s.pop, { uid: 1000 + i, messageId: `<batch${i}@example.invalid>` }))
  const label = (await s.ipc.call('labels:create', { name: 'Köteg', color: '#00897b' })).label.id
  const clock = fakeClock()
  const at = []
  const notify = e => (assert.deepEqual(e, { kind: 'labels' }), at.push(clock.now()))
  const batchAt = []
  for (const [i, id] of ids.entries()) {
    clock.advance(i * 5)
    batchAt.push(clock.now())
    applyLabels({ labels: s.labels, notify, clock }, { ids: [id], add: [label] })
  }
  clock.advance(batchAt.at(-1) + 1000)
  assert.equal(at[0], 0, 'the first at once')
  for (let i = 1; i < at.length; i++) assert.ok(at[i] - at[i - 1] >= 250, `at most one per 250 ms: ${at.join(',')}`)
  assert.ok(at.length <= Math.ceil(batchAt.at(-1) / 250) + 1, `${at.length} events for ${batchAt.at(-1)} ms`)
  assert.ok(at.at(-1) >= batchAt.at(-1), `the closing event after the last batch (${at.at(-1)} >= ${batchAt.at(-1)})`)
  assert.ok(at.at(-1) - batchAt.at(-1) <= 250, 'and within one window')
  assert.equal(s.labels.list().find(l => l.id === label).count, 200)
})

test('the labels event merged: one labelling -> exactly one event, at once; a no-op sends none; later ones open a new window', async t => {
  const s = setup(t)
  const a = addMessage(s.index, s.pop, { uid: 1, messageId: '<one@example.invalid>' })
  const label = (await s.ipc.call('labels:create', { name: 'Egy', color: '#00897b' })).label.id
  const clock = fakeClock()
  const at = []
  const notify = () => at.push(clock.now())
  applyLabels({ labels: s.labels, notify, clock }, { ids: [a], add: [label] })
  clock.advance(1000)
  assert.deepEqual(at, [0], 'one event, no delay (<= 300 ms)')
  applyLabels({ labels: s.labels, notify, clock }, { ids: [a], add: [label] })
  clock.advance(2000)
  assert.deepEqual(at, [0], 'already on: no event')
  applyLabels({ labels: s.labels, notify, clock }, { ids: [a], remove: [label] })
  clock.advance(3000)
  assert.deepEqual(at, [0, 2000], 'after the window: at once again')
})

test('the labels event merged: a closing event whose sender throws (a closed session) is no uncaught error', async t => {
  const s = setup(t)
  const ids = [1, 2].map(i => addMessage(s.index, s.pop, { uid: 500 + i, messageId: `<thr${i}@example.invalid>` }))
  const label = (await s.ipc.call('labels:create', { name: 'Dobó', color: '#00897b' })).label.id
  const clock = fakeClock()
  let calls = 0
  const notify = () => {
    calls++
    if (calls > 1) throw new Error('the database connection is not open')
  }
  applyLabels({ labels: s.labels, notify, clock }, { ids: [ids[0]], add: [label] })
  applyLabels({ labels: s.labels, notify, clock }, { ids: [ids[1]], add: [label] })
  assert.doesNotThrow(() => clock.advance(1000))
  assert.equal(calls, 2, 'the closing event was tried')
})

test('the labels event merged per label store: a new notify function on every call (IPC and MCP alike) is still one stream', async t => {
  const s = setup(t)
  const ids = Array.from({ length: 20 }, (_, i) => addMessage(s.index, s.pop, { uid: 800 + i, messageId: `<fresh${i}@example.invalid>` }))
  const label = (await s.ipc.call('labels:create', { name: 'Friss', color: '#00897b' })).label.id
  const clock = fakeClock()
  const at = []
  for (const [i, id] of ids.entries()) {
    clock.advance(i * 10)
    applyLabels({ labels: s.labels, notify: () => at.push(clock.now()), clock }, { ids: [id], add: [label] })
  }
  clock.advance(5000)
  assert.ok(at.length <= 2, `one stream: ${at.join(',')}`)
  assert.ok(at.at(-1) >= 190, 'the closing one after the last call')
})
