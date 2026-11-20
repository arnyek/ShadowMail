// SPDX-License-Identifier: GPL-3.0-or-later
// The folder list's label filter (0.17.0): one label id, bound to (account, label_key) like the label itself. The list
// pages, the count and the "select all" ids agree with the label alone and with every other filter, in every order;
// the copy of a labelled message in another folder is listed there, the same Message-ID in another account is not;
// a message whose label is taken off in the filtered view stays until the refresh (keepIds); the value only as a
// parameter; the IPC refuses a bad label; and 100 000 messages: the first page with a rare label is fast.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memoryIndex, addAccount, DAY } from './helpers/fixtures.js'
import { listFilterSql, parseListFilter, LIST_SORTS, MailIndex } from '../core/db/mail-index.js'
import { Labels } from '../core/db/labels.js'
import { registerMailIpc } from '../app/main/ipc/mail.js'
import { registerActionIpc } from '../app/main/ipc/actions.js'

const NOW = Date.UTC(2026, 10, 18, 12, 0, 0)
const DATES = [NOW - 40 * DAY, NOW - 10 * DAY, NOW - DAY]

function row(accountId, folder, uid, { flags = '', has_attachments = 0, date = NOW, messageId = `<${folder}${uid}@x>` } = {}) {
  const from = `kuldo${uid % 5}@example.invalid`
  return {
    account_id: accountId, folder, uid, message_id: messageId, in_reply_to: null, refs: null,
    from_addr: from, from_name: uid % 3 ? `Feladó ${uid % 7}` : '', to_addrs: 'en@example.invalid', cc_addrs: '',
    subject: `Tárgy ${(uid * 7) % 24}`, date, idate: date, flags, size: 100, has_attachments, attachments: null,
    body_state: 0, sender_text: from, recipients_text: 'en@example.invalid',
  }
}

// read/unread x starred x attachment x 3 dates = 24 in INBOX; every fifth carries "Számla", every fourth "Ügyfél" (each
// spread over the three dates), "Sok" on all but two of them and on 12 Archív messages (more rows in the account than the
// folder has: the count starts from the folder, a page too); a copy of INBOX uid 5 (labelled) in Archív (same Message-ID),
// and the same Message-ID in a second account
function seed(t) {
  const { db, index } = memoryIndex(t)
  const account = addAccount(db)
  const other = addAccount(db, { name: 'Másik' })
  const rows = []
  let uid = 0
  for (const seen of [true, false]) {
    for (const flagged of [true, false]) {
      for (const att of [true, false]) {
        for (const date of DATES) {
          uid++
          const flags = [seen && '\\Seen', flagged && '\\Flagged'].filter(Boolean).join(' ')
          rows.push(row(account.id, 'INBOX', uid, { flags, has_attachments: att ? 1 : 0, date: date + uid * 1000 }))
        }
      }
    }
  }
  rows.push(row(account.id, 'Archív', 100, { messageId: '<INBOX5@x>' }), row(account.id, 'Archív', 101))
  for (let i = 0; i < 12; i++) rows.push(row(account.id, 'Archív', 200 + i))
  rows.push(row(other.id, 'INBOX', 1, { messageId: '<INBOX5@x>' }))
  index.insertMany(rows)
  const labels = new Labels(db)
  const invoice = labels.create('Számla', '#d32f2f').id
  const client = labels.create('Ügyfél', '#fbc02d').id
  const ids = db.prepare("SELECT id, uid FROM messages WHERE account_id = ? AND folder = 'INBOX' ORDER BY uid").all(account.id)
  labels.setLabels(ids.filter(m => m.uid % 5 === 0).map(m => m.id), { add: [invoice] })
  labels.setLabels(ids.filter(m => m.uid % 4 === 0).map(m => m.id), { add: [client] })
  const many = labels.create('Sok', '#616161').id
  const archived = db.prepare("SELECT id FROM messages WHERE account_id = ? AND folder = 'Archív' AND uid >= 200").pluck().all(account.id)
  labels.setLabels([...ids.filter(m => m.uid > 2).map(m => m.id), ...archived], { add: [many] })
  return { db, index, labels, account, other, invoice, client, many }
}

const words = m => (m.flags || '').split(' ')
const matches = (m, f, labelled) =>
  (!f.unread || !words(m).includes('\\Seen')) &&
  (!f.flagged || words(m).includes('\\Flagged')) &&
  (!f.hasAttachment || m.has_attachments === 1) &&
  (f.since == null || m.date >= f.since) &&
  (f.before == null || m.date < f.before) &&
  (f.label == null || labelled(m.id, f.label))

function allPages(index, q, total) {
  const out = []
  for (let offset = 0; offset < total + 7; offset += 7) out.push(...index.listFolder({ ...q, offset, limit: 7 }))
  return out
}

test('the label alone and with every other filter, from either side: the pages, the count and the ids are the labelled set, in the same order (sort x dir)', t => {
  const { index, labels, account, invoice, client, many } = seed(t)
  // which shape each statement got (the statements are cached by shape, so each is prepared once)
  const prepared = []
  const prepare = index.db.prepare.bind(index.db)
  index.db.prepare = sql => (prepared.push(sql), prepare(sql))
  const everything = index.listFolder({ accountId: account.id, folder: 'INBOX', limit: 500 })
  assert.equal(everything.length, 24)
  const of = labels.labelsOfRows(everything.map(m => m.id))
  const labelled = (id, label) => (of.get(id) || []).includes(label)
  const cases = []
  for (const label of [invoice, client, many]) {
    cases.push([`label ${label}`, { label }])
    for (const [k, v] of Object.entries({ unread: true, flagged: true, hasAttachment: true, since: NOW - 20 * DAY, before: NOW - 5 * DAY })) cases.push([`label ${label} + ${k}`, { label, [k]: v }])
  }
  cases.push(['label null = no label filter', { label: null }])
  let checked = 0
  for (const [name, filter] of cases) {
    const expected = new Set(everything.filter(m => matches(m, filter, labelled)).map(m => m.id))
    assert.ok(filter.label == null || (expected.size > 0 && expected.size < 24) || (filter.label === many && name.endsWith('before')), `${name}: the seed must split the folder (${expected.size})`)
    const count = index.countFolder(account.id, 'INBOX', filter)
    assert.equal(count, expected.size, `${name}: count`)
    for (const sort of Object.keys(LIST_SORTS)) {
      for (const dir of ['asc', 'desc']) {
        const q = { accountId: account.id, folder: 'INBOX', sort, dir, filter }
        const listed = allPages(index, q, count).map(m => m.id)
        assert.deepEqual(new Set(listed), expected, `${name} ${sort} ${dir}: list = expected set`)
        assert.equal(listed.length, count, `${name} ${sort} ${dir}: no page overlap`)
        assert.deepEqual(index.listIds(q), listed, `${name} ${sort} ${dir}: ids = list, same order`)
        checked++
      }
    }
  }
  assert.equal(checked, 19 * 4 * 2)
  // both shapes ran for the count, the pages and the ids: a rare label from the label, "Sok" from the folder
  const by = (start, needle) => prepared.some(sql => sql.startsWith(start) && sql.includes(needle))
  const FROM_LABEL = 'm.label_key) IN (SELECT ml.account_id'
  const FROM_FOLDER = 'EXISTS (SELECT 1 FROM message_labels'
  for (const start of ['SELECT COUNT(*) AS n FROM messages m', 'SELECT m.id, m.uid', 'SELECT m.id FROM messages m']) {
    assert.ok(by(start, FROM_LABEL), `${start}: from the label`)
    assert.ok(by(start, FROM_FOLDER), `${start}: from the folder`)
  }
  // unread + label together (the card's case), counted by hand: uid 13..24 are unread, of them 15 and 20 are labelled
  assert.equal(index.countFolder(account.id, 'INBOX', { unread: true, label: invoice }), 2)
})

test('the copy in another folder is listed there by its label; the same Message-ID in another account is not', t => {
  const { index, account, other, invoice, client } = seed(t)
  const archive = index.listFolder({ accountId: account.id, folder: 'Archív', filter: { label: invoice } })
  assert.deepEqual(archive.map(m => m.uid), [100], 'the copy of a labelled message (same Message-ID) carries the label')
  assert.equal(index.countFolder(account.id, 'Archív', { label: invoice }), 1)
  assert.equal(index.countFolder(account.id, 'Archív', { label: client }), 0)
  assert.equal(index.countFolder(other.id, 'INBOX', { label: invoice }), 0, 'another account: its own labels only')
  assert.equal(index.countFolder(account.id, 'INBOX', { label: 999 }), 0, 'an unknown label: nothing, not everything')
})

test('keepIds: a message whose label is taken off in the filtered view stays (counted, same order) until the refresh', t => {
  const { index, labels, account, invoice } = seed(t)
  const filter = { label: invoice }
  const before = index.listIds({ accountId: account.id, folder: 'INBOX', filter })
  const off = before[1]
  labels.setLabels([off], { remove: [invoice] })
  assert.equal(index.countFolder(account.id, 'INBOX', filter), before.length - 1, 'without keepIds it drops out')
  const kept = { ...filter, keepIds: [off] }
  assert.equal(index.countFolder(account.id, 'INBOX', kept), before.length)
  assert.deepEqual(index.listIds({ accountId: account.id, folder: 'INBOX', filter: kept }), before)
  assert.deepEqual(index.listFolder({ accountId: account.id, folder: 'INBOX', filter: kept, limit: 500 }).map(m => m.id), before)
})

test('listFilterSql: the label only as a parameter, in its place among the others; the shape names it; parseListFilter', () => {
  const f = { unread: true, since: 1234567890123, before: 1234567899999, label: 424242, keepIds: [434343] }
  const a = listFilterSql(f)
  for (const v of ['424242', '434343', '1234567890123']) assert.ok(!a.sql.includes(v), `${v} is not in the SQL`)
  assert.deepEqual(a.params, [1234567890123, 1234567899999, 424242, 424242, '[434343]'])
  assert.equal(a.shape, 'usblk')
  assert.equal(listFilterSql({ ...f, label: 1 }).sql, a.sql, 'same shape, same statement')
  assert.equal(listFilterSql({ label: 7 }).shape, 'l')
  assert.deepEqual(listFilterSql({ label: null }), { sql: '', params: [], shape: '' })
  assert.deepEqual(listFilterSql({ label: 0 }), { sql: '', params: [], shape: '' })
  assert.deepEqual(parseListFilter({ label: 3 }), { label: 3 })
  assert.deepEqual(parseListFilter({ label: null, unread: true }), { label: null, unread: true })
  for (const label of [0, -1, 1.5, '3', true, [3], { id: 3 }, Number.MAX_SAFE_INTEGER + 2]) assert.equal(parseListFilter({ label }), null, JSON.stringify(label))
})

test('IPC mail:list / mail:ids with the label: the filtered total and the folder total; a bad label is bad_request', async t => {
  const s = seed(t)
  const handlers = new Map()
  const ipcMain = { handle: (c, fn) => handlers.set(c, fn) }
  registerMailIpc({ ipcMain, store: { list: () => [] }, index: s.index, labels: s.labels, manager: { status: () => [], syncNow() {} }, isTrustedSender: () => true })
  registerActionIpc({ ipcMain, actions: {}, index: s.index, isTrustedSender: () => true })
  const call = (ch, q) => handlers.get(ch)({}, q)
  const base = { accountId: s.account.id, folder: 'INBOX' }
  const res = await call('mail:list', { ...base, filter: { label: s.invoice }, limit: 3 })
  assert.equal(res.total, 4)
  assert.equal(res.folderTotal, 24)
  assert.equal(res.rows.length, 3)
  assert.ok(res.rows.every(r => r.labels.includes(s.invoice)), 'the rows carry their labels')
  const ids = await call('mail:ids', { ...base, filter: { label: s.invoice } })
  assert.equal(ids.ids.length, 4)
  assert.deepEqual(ids.ids.slice(0, 3), res.rows.map(r => r.id))
  for (const label of [0, '1', 1.5, true]) {
    for (const ch of ['mail:list', 'mail:ids']) assert.deepEqual(await call(ch, { ...base, filter: { label } }), { ok: false, error: 'bad_request' }, `${ch} ${JSON.stringify(label)}`)
  }
})

test('the plans: from the folder = its date index + a key lookup per row; from the label = the label index, then messages by key; with keepIds too; never a scan', t => {
  const { db, account, invoice } = seed(t)
  const planOf = (f, extra = '') => db.prepare(`EXPLAIN QUERY PLAN SELECT m.id FROM messages m WHERE m.account_id = ? AND m.folder = ?${f.sql} ORDER BY m.date DESC, m.id DESC LIMIT 200`)
    .all(account.id, 'INBOX', ...f.params).map(r => r.detail).join('; ') + extra
  for (const analyzed of [false, true]) {
    if (analyzed) db.exec('ANALYZE')
    for (const filter of [{ label: invoice }, { label: invoice, unread: true }, { label: invoice, keepIds: [1, 2] }]) {
      const folder = planOf(listFilterSql(filter))
      assert.match(folder, /SEARCH m USING INDEX idx_messages_folder_date/, folder)
      assert.match(folder, /SEARCH ml (EXISTS )?USING (COVERING INDEX|PRIMARY KEY|INDEX)/, folder)
      const label = planOf(listFilterSql(filter, { byLabel: true }))
      assert.match(label, /SEARCH ml USING COVERING INDEX idx_message_labels_label \(label_id=\?\)/, label)
      // the messages by key, or (a small folder: the planner may) the folder's index against the label's key list, built
      // once; the 100 000-message test below holds it to the key index
      assert.match(label, /SEARCH m USING (INDEX idx_messages_label_key|INDEX idx_messages_folder_date|INTEGER PRIMARY KEY)/, label)
      for (const plan of [folder, label]) assert.doesNotMatch(plan, /SCAN (m|ml|messages|message_labels)\b/, plan)
    }
  }
})

test('100 000 messages, a label on 0.1% of them: from the label (its index, then messages by key), the first page (count, page, filtered count, labels) in < 200 ms (median of 5)', t => {
  const { db, index } = memoryIndex(t)
  const account = addAccount(db)
  for (let i = 0; i < 100_000; i += 5000) index.insertMany(Array.from({ length: 5000 }, (_, k) => row(account.id, 'INBOX', i + k + 1, { date: NOW - (i + k) * 1000, flags: (i + k) % 3 ? '\\Seen' : '' })))
  const labels = new Labels(db)
  const rare = labels.create('Ritka', '#000000').id
  db.prepare("INSERT INTO message_labels (account_id, label_key, label_id, created_at) SELECT account_id, label_key, ?, 0 FROM messages WHERE uid % 1000 = 7").run(rare)
  db.exec('ANALYZE')
  const filter = { label: rare }
  for (const f of [filter, { ...filter, unread: true }]) {
    const q = listFilterSql(f, { byLabel: true })
    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT m.id FROM messages m WHERE m.account_id = ? AND m.folder = ?${q.sql} ORDER BY m.date DESC, m.id DESC LIMIT 200`)
      .all(account.id, 'INBOX', ...q.params).map(r => r.detail).join('; ')
    assert.match(plan, /SEARCH m USING INDEX idx_messages_label_key \(account_id=\? AND label_key=\?\)/, plan)
  }
  const page = () => {
    index.countFolder(account.id, 'INBOX')
    const rows = index.listFolder({ accountId: account.id, folder: 'INBOX', limit: 200, filter })
    const total = index.countFolder(account.id, 'INBOX', filter)
    labels.attach(rows)
    return [rows.length, total]
  }
  assert.deepEqual(page(), [100, 100])
  const ts = []
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now()
    page()
    ts.push(performance.now() - t0)
  }
  ts.sort((a, b) => a - b)
  assert.ok(ts[2] < 200, `median ${ts[2].toFixed(1)} ms`)
})

test('the two shapes give the same set in every account, folder and label, with the other filters and keepIds too', t => {
  const { db, account, other, invoice, client, many } = seed(t)
  const ids = (accountId, folder, f) => db.prepare(`SELECT m.id FROM messages m WHERE m.account_id = ? AND m.folder = ?${f.sql} ORDER BY m.id`).pluck().all(accountId, folder, ...f.params)
  let compared = 0
  for (const [accountId, folder] of [[account.id, 'INBOX'], [account.id, 'Archív'], [other.id, 'INBOX']]) {
    for (const label of [invoice, client, many, 999]) {
      for (const extra of [{}, { unread: true }, { keepIds: [1, 30] }]) {
        const filter = { label, ...extra }
        const a = ids(accountId, folder, listFilterSql(filter))
        const b = ids(accountId, folder, listFilterSql(filter, { byLabel: true }))
        assert.deepEqual(b, a, `${accountId} ${folder} ${JSON.stringify(filter)}`)
        compared++
      }
    }
  }
  assert.equal(compared, 36)
  // the other account's copy of a labelled message (same Message-ID) carries none of the first account's labels
  assert.deepEqual(ids(other.id, 'INBOX', listFilterSql({ label: invoice })), [])
  assert.deepEqual(ids(other.id, 'INBOX', listFilterSql({ label: invoice }, { byLabel: true })), [])
})

test('the side each statement starts from: a rare label from the label; a common one\'s date page from the folder; a label big elsewhere from the label once the count is known', t => {
  const { db, index } = memoryIndex(t)
  const account = addAccount(db)
  const rows = []
  for (let i = 1; i <= 2000; i++) rows.push(row(account.id, 'INBOX', i, { date: NOW - i * 1000 }))
  for (let i = 1; i <= 1500; i++) rows.push(row(account.id, 'Archív', i, { date: NOW - i * 1000 }))
  index.insertMany(rows)
  const labels = new Labels(db)
  const tag = (name, where) => {
    const id = labels.create(name, '#000000').id
    db.prepare(`INSERT INTO message_labels (account_id, label_key, label_id, created_at) SELECT account_id, label_key, ?, 0 FROM messages WHERE ${where}`).run(id)
    return id
  }
  const rare = tag('rare', "folder = 'INBOX' AND uid % 100 = 1") // 20 in the inbox
  const common = tag('common', "folder = 'INBOX' AND uid % 2 = 0") // 1000 in the inbox
  const elsewhere = tag('elsewhere', "folder = 'Archív' OR (folder = 'INBOX' AND uid % 400 = 1)") // 1500 + 5
  const prepared = []
  const prepare = db.prepare.bind(db)
  db.prepare = sql => (prepared.push(sql), prepare(sql))
  // each MailIndex keeps its own statements: a new one prepares (and so shows) the side it picks
  const sideOf = fn => {
    const from = prepared.length
    fn()
    const sql = prepared.slice(from).find(s => s.includes('message_labels ml'))
    return !sql ? 'cached' : sql.includes('IN (SELECT ml.account_id') ? 'label' : 'folder'
  }
  const q = (label, extra = {}) => ({ accountId: account.id, folder: 'INBOX', filter: { label }, limit: 200, ...extra })
  assert.equal(sideOf(() => index.countFolder(account.id, 'INBOX', { label: rare })), 'label', 'count, rare')
  assert.equal(sideOf(() => index.listFolder(q(rare))), 'label', 'page, rare')
  assert.equal(sideOf(() => index.listIds(q(rare))), 'label', 'ids, rare')
  assert.equal(sideOf(() => index.listFolder(q(common, { sort: 'from' }))), 'label', 'a page in another order: the whole-set rule (1000 <= 2000)')
  const fresh = new MailIndex(db)
  assert.equal(sideOf(() => fresh.listFolder(q(common))), 'folder', 'the date page of a common label: the folder index stops early')
  assert.equal(sideOf(() => fresh.countFolder(account.id, 'INBOX', { label: elsewhere })), 'label', 'count: 1505 label rows <= 2000 messages')
  const third = new MailIndex(db)
  assert.equal(sideOf(() => third.listFolder(q(elsewhere))), 'folder', 'without the count the label rows stand for the matches')
  const fourth = new MailIndex(db)
  assert.equal(sideOf(() => fourth.listFolder(q(elsewhere, { matches: 5 }))), 'label', 'with the count (5): from the label')
  db.prepare = prepare
  // whichever side: the same page
  assert.deepEqual(third.listFolder(q(elsewhere)).map(m => m.id), fourth.listFolder(q(elsewhere, { matches: 5 })).map(m => m.id))
})

test('IPC mail:list passes the filtered count to the page (the label filter\'s side)', async t => {
  const s = seed(t)
  const handlers = new Map()
  registerMailIpc({ ipcMain: { handle: (c, fn) => handlers.set(c, fn) }, store: { list: () => [] }, index: s.index, labels: s.labels, manager: { status: () => [], syncNow() {} }, isTrustedSender: () => true })
  const seen = []
  const list = s.index.listFolder.bind(s.index)
  s.index.listFolder = q => (seen.push(q.matches), list(q))
  const res = await handlers.get('mail:list')({}, { accountId: s.account.id, folder: 'INBOX', filter: { label: s.invoice } })
  assert.deepEqual(seen, [res.total])
  assert.equal(res.total, 4)
})
