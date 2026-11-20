// A labelled IMAP draft saved again keeps its labels (0.17.0): the save is a new APPEND, so the old copy's label keywords
// (from the local index) go into the new copy's flag list; a server that refuses them gets the copy without them and the
// labels are bound locally by the message's key (the fallback). The Claude mark and a label together; the Sent copy of
// the sent message gets no label. Real SyncManager, Composer and Labels on the fake IMAP server.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { memoryIndex, addAccount, addMessage, sealedStore } from './helpers/fixtures.js'
import { FakeImapServer } from './helpers/fake-imap.js'
import { onCleanup, tempDir } from './helpers/tmp.js'
import { SyncManager } from '../app/main/sync-manager.js'
import { MessageReader } from '../app/main/reader.js'
import { Composer, CLAUDE_KEYWORD } from '../app/main/compose.js'
import { Contacts } from '../core/db/contacts.js'
import { Labels } from '../core/db/labels.js'
import { applyLabels } from '../app/main/ipc/labels.js'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const until = async (fn, ms = 5000) => {
  const t0 = Date.now()
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting')
    await sleep(5)
  }
}

async function setup(t) {
  const { db, index } = memoryIndex(t)
  const storeDir = path.join(tempDir(t), 'store')
  const row = addAccount(db, { name: 'Piszkozat-fiók', email: 'sajat@example.invalid', in_port: 49821, smtp_host: 'smtp.example.invalid', smtp_port: 465 })
  const imap = new FakeImapServer().addMailbox('INBOX').addMailbox('Drafts', { specialUse: '\\Drafts' }).addMailbox('Sent', { specialUse: '\\Sent' })
  const store = {
    list: () => db.prepare('SELECT * FROM accounts ORDER BY id').all(),
    getRow: id => db.prepare('SELECT * FROM accounts WHERE id = ?').get(id),
    passwordsFor: () => ({ incoming: 'x', smtp: 'x' }),
  }
  const labels = new Labels(db)
  const manager = new SyncManager({ store, index, labels, sealed: sealedStore(storeDir), notify: () => {}, connect: async () => imap.connect(), throttleMs: 5, syncerOptions: { retryDelaysMs: [60_000] }, idleOptions: { retryDelaysMs: [60_000], debounceMs: 10 } })
  onCleanup(t, () => manager.stopAll())
  manager.startAll()
  await until(() => manager.status().every(s => s.lastFinished))
  const reader = new MessageReader({ index, sealed: sealedStore(storeDir), withConnection: (id, fn) => manager.withConnection(id, fn) })
  const sent = []
  const composer = new Composer({
    index, store, reader, labels, contacts: new Contacts(db), storeDir, sealed: sealedStore(storeDir),
    withConnection: (id, fn) => manager.withConnection(id, fn),
    requestSync: (id, f) => manager.requestSync(id, f),
    send: async ({ envelope, raw }) => (sent.push(raw), { accepted: envelope.to, rejected: [] }),
  })
  const ctx = { labels, withConnection: (id, fn) => manager.withConnection(id, fn) }
  const form = text => ({ accountId: row.id, to: 'anna@example.invalid', cc: '', bcc: '', subject: 'Címkézett piszkozat', html: `<p>${text}</p>`, inReplyTo: null, references: [] })
  const draftRows = () => db.prepare("SELECT * FROM messages WHERE account_id = ? AND folder = 'Drafts'").all(row.id)
  const serverDrafts = () => [...imap.mailboxes.get('Drafts').messages.values()]
  const synced = async n => {
    manager.requestSync(row.id, ['Drafts', 'Sent'])
    // the index holds exactly the server's copies (after a save the old row is there until the sync drops it)
    const same = () => JSON.stringify(draftRows().map(r => r.uid).sort()) === JSON.stringify(serverDrafts().map(m => m.uid).sort())
    await until(() => serverDrafts().length === n && same())
  }
  return { db, index, imap, row, labels, composer, ctx, form, draftRows, serverDrafts, synced, sent, manager }
}

test('a labelled draft saved again: the new APPEND carries the label keyword, the old copy is gone, the label shows on the new row', async t => {
  const s = await setup(t)
  const label = s.labels.create('Ügyfél', '#2e7d32')
  const other = s.labels.create('Másik', '#1e88e5')
  const sid = s.composer.open()
  await s.composer.saveDraft(sid, s.form('első'))
  await s.synced(1)
  await applyLabels(s.ctx, { ids: [s.draftRows()[0].id], add: [label.id] })
  assert.ok(s.serverDrafts()[0].flags.has(label.keyword))
  // a copy of the same message in another folder with another label: not the draft's, it does not come along
  addMessage(s.index, s.row.id, { uid: 99, messageId: s.draftRows()[0].message_id, flags: other.keyword })
  s.imap.actionLog.length = 0
  await s.composer.saveDraft(sid, s.form('második'))
  const append = s.imap.actionLog.find(x => x.op === 'append')
  assert.deepEqual([...append.flags].sort(), ['\\Draft', '\\Seen', label.keyword].sort(), 'the new copy carries it (and not the other label)')
  await s.synced(1)
  assert.ok(s.serverDrafts()[0].flags.has(label.keyword), 'one copy on the server, with the keyword')
  const now = s.draftRows()[0]
  assert.deepEqual(s.labels.labelsOfRows([now.id]).get(now.id), [label.id])
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM message_labels').get().n, 0, 'no local binding needed')
  assert.ok(!s.labels.labelsOfRows([now.id]).get(now.id).includes(other.id))
})

test('the server refuses the keyword on APPEND (NO, then false): saved without it, the label bound locally and still shown; the Claude mark and a label together', async t => {
  const s = await setup(t)
  const label = s.labels.create('Számla', '#d32f2f')
  const sid = s.composer.open()
  s.composer.markClaude(sid)
  await s.composer.saveDraft(sid, s.form('első'))
  await s.synced(1)
  await applyLabels(s.ctx, { ids: [s.draftRows()[0].id], add: [label.id] })
  // both together
  s.imap.actionLog.length = 0
  await s.composer.saveDraft(sid, s.form('második'))
  assert.deepEqual([...s.imap.actionLog.find(x => x.op === 'append').flags].sort(), ['\\Draft', '\\Seen', CLAUDE_KEYWORD, label.keyword].sort())
  await s.synced(1)
  for (const mode of ['no', 'false']) {
    // the same start each round: the keyword on the server copy, no local binding
    s.db.prepare('DELETE FROM message_labels').run()
    await applyLabels(s.ctx, { ids: [s.draftRows()[0].id], add: [label.id] })
    assert.ok(s.serverDrafts()[0].flags.has(label.keyword), `${mode}: the start`)
    // a server without custom label keywords: the APPEND with one is refused, the rest goes
    const realConnect = s.imap.connect.bind(s.imap)
    s.imap.connect = async () => {
      const c = await realConnect()
      const append = c.append.bind(c)
      c.append = async (folder, raw, flags, date) => {
        if (flags.includes(label.keyword)) {
          if (mode === 'no') throw Object.assign(new Error('Command failed'), { responseStatus: 'NO' })
          return false
        }
        return append(folder, raw, flags, date)
      }
      return c
    }
    // a fresh interactive connection (the wrapped one): drop the old
    s.imap.dropConnections()
    s.imap.actionLog.length = 0
    await s.composer.saveDraft(sid, s.form(`harmadik ${mode}`))
    const appends = s.imap.actionLog.filter(x => x.op === 'append')
    assert.equal(appends.length, 1, mode)
    assert.deepEqual([...appends[0].flags].sort(), ['\\Draft', '\\Seen', CLAUDE_KEYWORD].sort(), `${mode}: saved without the label keyword, the Claude mark kept`)
    await s.synced(1)
    const now = s.draftRows()[0]
    assert.deepEqual(s.labels.labelsOfRows([now.id]).get(now.id), [label.id], `${mode}: the label still shows (local binding)`)
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM message_labels WHERE label_key = ?').get(now.label_key).n, 1)
    s.imap.connect = realConnect
    s.imap.dropConnections()
  }
})

test('sent: the Sent copy carries no label keyword; a POP3-less IMAP draft without labels saves as before (no extra flag)', async t => {
  const s = await setup(t)
  const label = s.labels.create('Projekt', '#00897b')
  const sid = s.composer.open()
  await s.composer.saveDraft(sid, s.form('első'))
  await s.synced(1)
  s.imap.actionLog.length = 0
  await s.composer.saveDraft(sid, s.form('címke nélkül'))
  assert.deepEqual([...s.imap.actionLog.find(x => x.op === 'append').flags].sort(), ['\\Draft', '\\Seen'], 'no label: the old flag list')
  await s.synced(1)
  await applyLabels(s.ctx, { ids: [s.draftRows()[0].id], add: [label.id] })
  s.imap.actionLog.length = 0
  await s.composer.sendNow(sid, s.form('elküldve'))
  assert.equal(s.sent.length, 1)
  const sentAppend = s.imap.actionLog.find(x => x.op === 'append' && x.path === 'Sent')
  assert.ok(sentAppend, 'a Sent copy')
  assert.deepEqual([...sentAppend.flags], ['\\Seen'], 'the Sent copy: no label')
})
