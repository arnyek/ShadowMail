// Labels read from the server's keywords (0.17.0): on an IMAP account a label is on a row when its keyword is among
// the row's flags (another client put it there; the sync brings it), together with the local bindings; on POP3 only the
// local bindings count. One rule for the list, the search, the reader, the picker, the filter and the MCP.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memoryIndex, addAccount, addMessage } from './helpers/fixtures.js'
import { FakeImapServer } from './helpers/fake-imap.js'
import { Syncer } from '../core/imap/sync.js'
import { Labels, keywordLabelIds, asciiLower, KEYWORD_FLAGS_WHERE } from '../core/db/labels.js'

const NOW = Date.UTC(2026, 10, 18, 12, 0, 0)

function setup(t) {
  const { db, index } = memoryIndex(t)
  const account = addAccount(db)
  const labels = new Labels(db, { now: () => 1 })
  const bill = labels.create('Számla', '#d32f2f') // keyword sz=c3=a1mla
  const todo = labels.create('To Do', '#1976d2') // keyword to=20do
  const server = new FakeImapServer().addMailbox('INBOX').addMailbox('Archive')
  const one = server.addMessage('INBOX', { from: 'a@example.invalid', to: 'en@example.invalid', subject: 'Egy', messageId: '<one@x>', date: NOW - 1000, body: 'egy' })
  const two = server.addMessage('INBOX', { from: 'b@example.invalid', to: 'en@example.invalid', subject: 'Kettő', messageId: '<two@x>', date: NOW - 2000, body: 'kettő' })
  // the same message (Message-ID) in another folder
  const oneCopy = server.addMessage('Archive', { from: 'a@example.invalid', to: 'en@example.invalid', subject: 'Egy', messageId: '<one@x>', date: NOW - 1000, body: 'egy' })
  const syncer = new Syncer({ account, index, connect: async () => server.client(), now: () => NOW })
  const row = (folder, uid) => index.getByUid(account.id, folder, uid)
  return { db, index, labels, account, bill, todo, server, syncer, row, one, two, oneCopy }
}

const idsOf = rows => rows.map(r => r.id).sort((a, b) => a - b)

test('keywordLabelIds and asciiLower: whole words, ASCII lower case only, each label once', () => {
  const by = new Map([['sz=c3=a1mla', 1], ['to=20do', 2]])
  assert.deepEqual(keywordLabelIds('\\Seen sz=c3=a1mla', by), [1])
  assert.deepEqual(keywordLabelIds('SZ=C3=A1MLA to=20DO sz=c3=a1mla', by), [1, 2])
  assert.deepEqual(keywordLabelIds('xsz=c3=a1mla sz=c3=a1mlax', by), [], 'a whole word only')
  assert.deepEqual(keywordLabelIds('', by), [])
  assert.deepEqual(keywordLabelIds(null, by), [])
  assert.equal(asciiLower('ÁRVÍZ K'), 'ÁrvÍz K', 'like SQLite lower(): A-Z only')
})

test('a keyword another client put on the server: after the sync the list, the search, the reader, the picker, the filter and the count show it; after its removal none does', async t => {
  const s = setup(t)
  await s.syncer.run()
  const one = s.row('INBOX', s.one)
  const two = s.row('INBOX', s.two)
  assert.deepEqual(s.labels.labelsOfRows([one.id, two.id]), new Map(), 'nothing yet')

  s.server.setFlags('INBOX', s.one, ['\\Seen', 'sz=c3=a1mla'])
  await s.syncer.run()
  // the list page and the reader (attach / labelsOfRows)
  assert.deepEqual(s.labels.attach([s.row('INBOX', s.one), two]).map(r => r.labels), [[s.bill.id], []])
  // the picker: rows, not messages
  assert.deepEqual(s.labels.stateOf([one.id, two.id]), { total: 2, counts: new Map([[s.bill.id, 1]]) })
  // the folder list's filter: page, count, every id, from both sides of the filter
  const filter = { label: s.bill.id }
  assert.deepEqual(idsOf(s.index.listFolder({ accountId: s.account.id, folder: 'INBOX', filter }).rows ?? s.index.listFolder({ accountId: s.account.id, folder: 'INBOX', filter })), [one.id])
  assert.equal(s.index.countFolder(s.account.id, 'INBOX', filter), 1)
  assert.deepEqual(s.index.listIds({ accountId: s.account.id, folder: 'INBOX', filter }), [one.id])
  // the search's label filter (across the accounts)
  assert.deepEqual(idsOf(s.index.search({ label: s.bill.id })), [one.id])
  // the count of the label list
  assert.equal(s.labels.list().find(l => l.id === s.bill.id).count, 1)
  assert.equal(s.labels.list().find(l => l.id === s.todo.id).count, 0)

  s.server.setFlags('INBOX', s.one, ['\\Seen'])
  await s.syncer.run()
  assert.deepEqual(s.labels.labelsOfRows([one.id]), new Map())
  assert.equal(s.index.countFolder(s.account.id, 'INBOX', filter), 0)
  assert.deepEqual(s.index.search({ label: s.bill.id }), [])
  assert.equal(s.labels.list().find(l => l.id === s.bill.id).count, 0)
})

test('an upper-case keyword from the server is the label; the copy of the same message in another folder does not get it', async t => {
  const s = setup(t)
  s.server.setFlags('INBOX', s.one, ['SZ=C3=A1MLA', 'To=20Do'])
  await s.syncer.run()
  const one = s.row('INBOX', s.one)
  const copy = s.row('Archive', s.oneCopy)
  assert.equal(one.label_key, copy.label_key, 'the same message')
  assert.deepEqual(s.labels.labelsOfRows([one.id, copy.id]), new Map([[one.id, [s.bill.id, s.todo.id]]]), 'in the list order, the copy without')
  assert.equal(s.index.countFolder(s.account.id, 'Archive', { label: s.bill.id }), 0)
  assert.deepEqual(idsOf(s.index.search({ label: s.todo.id })), [one.id])
  // the folder's filter, both its count and its ids, from the label's side too
  assert.equal(s.index.countFolder(s.account.id, 'INBOX', { label: s.todo.id }), 1)
  assert.deepEqual(s.index.listIds({ accountId: s.account.id, folder: 'INBOX', filter: { label: s.todo.id } }), [one.id])
})

test('a flag that only contains the keyword (a longer word) is no label, in JS and in SQL', async t => {
  const s = setup(t)
  s.server.setFlags('INBOX', s.one, ['xsz=c3=a1mla', 'sz=c3=a1mlax'])
  await s.syncer.run()
  const one = s.row('INBOX', s.one)
  assert.deepEqual(s.labels.labelsOfRows([one.id]), new Map())
  assert.equal(s.index.countFolder(s.account.id, 'INBOX', { label: s.bill.id }), 0)
  assert.deepEqual(s.index.listIds({ accountId: s.account.id, folder: 'INBOX', filter: { label: s.bill.id } }), [])
  assert.deepEqual(s.index.search({ label: s.bill.id }), [])
  assert.equal(s.labels.list().find(l => l.id === s.bill.id).count, 0)
})

test('a local binding and the keyword on one IMAP row: the label once on the row, once in the picker', async t => {
  const s = setup(t)
  s.server.setFlags('INBOX', s.one, ['sz=c3=a1mla'])
  await s.syncer.run()
  const one = s.row('INBOX', s.one)
  s.labels.setLabels([one.id], { add: [s.bill.id] })
  assert.deepEqual(s.labels.labelsOfRows([one.id]).get(one.id), [s.bill.id])
  assert.deepEqual(s.labels.stateOf([one.id]).counts, new Map([[s.bill.id, 1]]))
  assert.equal(s.index.countFolder(s.account.id, 'INBOX', { label: s.bill.id }), 1)
  // the local binding is the message's: the Archive copy shows it too, through the binding, not the keyword
  const copy = s.row('Archive', s.oneCopy)
  assert.deepEqual(s.labels.labelsOfRows([copy.id]).get(copy.id), [s.bill.id])
  assert.deepEqual(idsOf(s.index.search({ label: s.bill.id })), [one.id, copy.id].sort((a, b) => a - b))
})

test('POP3: a keyword-looking flag is no label; the local binding works as before', t => {
  const { db, index } = memoryIndex(t)
  const labels = new Labels(db, { now: () => 1 })
  const bill = labels.create('Számla', '#d32f2f')
  const pop = addAccount(db, { type: 'pop3', in_port: 995 })
  const id = addMessage(index, pop.id, { uid: 1, messageId: '<p@x>', flags: 'sz=c3=a1mla' })
  assert.deepEqual(labels.labelsOfRows([id]), new Map())
  assert.equal(index.countFolder(pop.id, 'INBOX', { label: bill.id }), 0)
  assert.deepEqual(index.search({ label: bill.id }), [], 'the search (across the accounts) too')
  assert.equal(labels.list().find(l => l.id === bill.id).count, 0)
  labels.setLabels([id], { add: [bill.id] })
  assert.deepEqual(labels.labelsOfRows([id]).get(id), [bill.id])
  assert.equal(index.countFolder(pop.id, 'INBOX', { label: bill.id }), 1)
})

test('the partial index: its WHERE is the query\'s own text; the count and the filter read it, before and after ANALYZE', async t => {
  const s = setup(t)
  s.server.setFlags('INBOX', s.one, ['sz=c3=a1mla'])
  await s.syncer.run()
  const sql = s.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_messages_keyword_flags'").pluck().get()
  assert.ok(sql && sql.endsWith(`WHERE ${KEYWORD_FLAGS_WHERE}`), sql)
  const plan = (st, ...args) => s.db.prepare(`EXPLAIN QUERY PLAN ${st.source}`).all(...args).map(r => r.detail).join(' | ')
  for (const when of ['before ANALYZE', 'after ANALYZE']) {
    assert.match(plan(s.labels.s.keywordRows), /SEARCH messages USING COVERING INDEX idx_messages_keyword_flags/, `keywordRows ${when}`)
    const filtered = s.db.prepare(`EXPLAIN QUERY PLAN SELECT m.id FROM messages m WHERE m.account_id = ? AND m.folder = ? AND m.id IN (SELECT k.id FROM labels l CROSS JOIN messages k WHERE l.id = ? AND l.keyword IS NOT NULL AND ${KEYWORD_FLAGS_WHERE} AND instr(' ' || lower(k.flags) || ' ', ' ' || l.keyword || ' ') > 0)`).all(1, 'INBOX', 1).map(r => r.detail).join(' | ')
    assert.match(filtered, /USING COVERING INDEX idx_messages_keyword_flags/, `the filter's keyword side ${when}`)
    s.db.exec('ANALYZE')
  }
})

test('with the index and without it (NOT INDEXED) the keyword rows and every count agree after each IMAP change: sync, a keyword on and off, a move, a delete', async t => {
  const s = setup(t)
  const keywordRows = indexed => s.db.prepare(`SELECT account_id, label_key, flags FROM accounts a
      CROSS JOIN messages ${indexed ? '' : 'NOT INDEXED'} ON account_id = a.id
    WHERE a.type = 'imap' AND ${KEYWORD_FLAGS_WHERE} ORDER BY account_id, label_key, flags`).all()
  const counts = () => s.labels.list().map(l => [l.id, l.count])
  const check = async step => {
    await s.syncer.run()
    assert.deepEqual(keywordRows(true), keywordRows(false), `rows after ${step}`)
    // the counts from the index equal a count over every row, by the JS rule
    const by = new Map(s.labels.list().filter(l => l.keyword).map(l => [l.keyword, l.id]))
    const pairs = new Map()
    for (const r of s.db.prepare("SELECT m.account_id, m.label_key, m.flags FROM messages m NOT INDEXED JOIN accounts a ON a.id = m.account_id WHERE a.type = 'imap'").all()) {
      for (const id of keywordLabelIds(r.flags, by)) (pairs.get(id) ?? pairs.set(id, new Set()).get(id)).add(`${r.account_id}|${r.label_key}`)
    }
    assert.deepEqual(counts(), s.labels.list().map(l => [l.id, pairs.get(l.id)?.size ?? 0]), `counts after ${step}`)
  }
  await check('the first sync')
  s.server.setFlags('INBOX', s.one, ['\\Seen', 'sz=c3=a1mla', 'To=20Do'])
  s.server.setFlags('Archive', s.oneCopy, ['sz=c3=a1mla'])
  await check('keywords put on')
  assert.equal(s.labels.list().find(l => l.id === s.bill.id).count, 1, 'two folders, one message: one')
  s.server.setFlags('INBOX', s.one, ['\\Seen'])
  await check('a keyword taken off')
  // a move by another client: the message leaves INBOX and arrives in Archive with its keyword
  const moved = s.server.addMessage('Archive', { from: 'b@example.invalid', to: 'en@example.invalid', subject: 'Kettő', messageId: '<two@x>', date: NOW - 2000, body: 'kettő', flags: ['to=20do'] })
  s.server.deleteMessage('INBOX', s.two)
  await check('a move')
  assert.ok(s.row('Archive', moved))
  s.server.deleteMessage('Archive', s.oneCopy)
  await check('a delete')
  assert.deepEqual(counts(), [[s.bill.id, 0], [s.todo.id, 1]])
})
