// The folder list's filter (since 0.10.1). The list pages, the count and the "select all" ids come from one
// filter builder, so they must agree on every filter, sort and direction; the IPC refuses anything
// that is not a well-formed filter.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memoryIndex, addAccount, DAY } from './helpers/fixtures.js'
import { listFilterSql, parseListFilter, LIST_SORTS, MAX_KEEP_IDS } from '../core/db/mail-index.js'
import { registerMailIpc } from '../app/main/ipc/mail.js'
import { registerActionIpc } from '../app/main/ipc/actions.js'

const NOW = Date.UTC(2026, 10, 12, 12, 0, 0)
const DATES = [NOW - 40 * DAY, NOW - 10 * DAY, NOW - DAY]

// read/unread x starred x attachment x 3 dates = 24 messages, plus a second folder that must never leak in
function seedFolder(t) {
  const { db, index } = memoryIndex(t)
  const account = addAccount(db)
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
  for (let i = 0; i < 5; i++) rows.push(row(account.id, 'Archív', 100 + i, { flags: '', has_attachments: 1, date: NOW - i * 1000 }))
  index.insertMany(rows)
  return { db, index, account }
}

function row(accountId, folder, uid, { flags, has_attachments, date }) {
  const from = `kuldo${uid % 5}@example.invalid`
  return {
    account_id: accountId, folder, uid, message_id: `<f${folder}${uid}@x>`, in_reply_to: null, refs: null,
    from_addr: from, from_name: uid % 3 ? `Feladó ${uid % 7}` : '', to_addrs: 'en@example.invalid', cc_addrs: '',
    subject: `Tárgy ${(uid * 7) % 24}`, date, idate: date, flags, size: 100, has_attachments, attachments: null,
    body_state: 0, sender_text: from, recipients_text: 'en@example.invalid',
  }
}

const words = m => (m.flags || '').split(' ')
// the expected set, computed in JS from the rows (not from SQL)
const matches = (m, f) =>
  (!f.unread || !words(m).includes('\\Seen')) &&
  (!f.flagged || words(m).includes('\\Flagged')) &&
  (!f.hasAttachment || m.has_attachments === 1) &&
  (f.since == null || m.date >= f.since) &&
  (f.before == null || m.date < f.before)

const SINGLE = {
  unread: { unread: true },
  flagged: { flagged: true },
  hasAttachment: { hasAttachment: true },
  since: { since: NOW - 20 * DAY },
  before: { before: NOW - 5 * DAY },
}

function filterCases() {
  const cases = Object.entries(SINGLE)
  const keys = Object.keys(SINGLE)
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) cases.push([`${keys[i]}+${keys[j]}`, { ...SINGLE[keys[i]], ...SINGLE[keys[j]] }])
  }
  cases.push(['none', {}], ['all off', { unread: false, flagged: false, hasAttachment: false, since: null, before: null }])
  return cases
}

// every page of the list, small pages so the paging itself is tested
function allPages(index, q, total) {
  const out = []
  for (let offset = 0; offset < total + 7; offset += 7) out.push(...index.listFolder({ ...q, offset, limit: 7 }))
  return out
}

test('every filter and every pair: the list pages, the count and the ids give the expected set, in the same order (sort x dir)', t => {
  const { index, account } = seedFolder(t)
  const everything = index.listFolder({ accountId: account.id, folder: 'INBOX', limit: 500 })
  assert.equal(everything.length, 24)
  let checked = 0
  for (const [name, filter] of filterCases()) {
    const expected = new Set(everything.filter(m => matches(m, filter)).map(m => m.id))
    assert.ok(name === 'none' || name === 'all off' || (expected.size > 0 && expected.size < 24), `${name}: the seed must split the folder (${expected.size})`)
    const count = index.countFolder(account.id, 'INBOX', filter)
    assert.equal(count, expected.size, `${name}: count`)
    for (const sort of Object.keys(LIST_SORTS)) {
      for (const dir of ['asc', 'desc']) {
        const q = { accountId: account.id, folder: 'INBOX', sort, dir, filter }
        const listed = allPages(index, q, count).map(m => m.id)
        const ids = index.listIds(q)
        assert.deepEqual(new Set(listed), expected, `${name} ${sort} ${dir}: list = expected set`)
        assert.equal(listed.length, count, `${name} ${sort} ${dir}: no page overlap`)
        assert.deepEqual(ids, listed, `${name} ${sort} ${dir}: ids = list, same order`)
        checked++
      }
    }
  }
  assert.equal(checked, 17 * 6)
})

test('keepIds: an opened (now read) message stays in the Unread filter and is counted; it never brings in another folder', t => {
  const { db, index, account } = seedFolder(t)
  const unreadFilter = { unread: true }
  const before = index.listIds({ accountId: account.id, folder: 'INBOX', filter: unreadFilter })
  const opened = before[0]
  db.prepare("UPDATE messages SET flags = '\\Seen' WHERE id = ?").run(opened) // the reader marked it read
  assert.equal(index.countFolder(account.id, 'INBOX', unreadFilter), before.length - 1, 'without keepIds it drops out')

  const archived = index.listFolder({ accountId: account.id, folder: 'Archív' })[0].id
  const kept = { unread: true, keepIds: [opened, archived] }
  assert.equal(index.countFolder(account.id, 'INBOX', kept), before.length, 'total counts the kept one')
  assert.deepEqual(index.listIds({ accountId: account.id, folder: 'INBOX', filter: kept }), before, 'same set, same order as before it was read')
  assert.deepEqual(index.listFolder({ accountId: account.id, folder: 'INBOX', filter: kept, limit: 500 }).map(m => m.id), before)
  // seen=true (the header's "select read") inside the kept view: just the kept, read one
  assert.deepEqual(index.listIds({ accountId: account.id, folder: 'INBOX', filter: kept, seen: true }), [opened])
  // without a filter keepIds changes nothing
  assert.equal(index.countFolder(account.id, 'INBOX', { keepIds: [archived] }), 24)
})

test('a custom flag containing "Seen" ($NotSeen, \\SeenX) is not \\Seen; \\Flagged likewise', t => {
  const { index, account } = seedFolder(t)
  index.insertMany([
    row(account.id, 'INBOX', 500, { flags: '$NotSeen', has_attachments: 0, date: NOW }),
    row(account.id, 'INBOX', 501, { flags: '\\SeenX $Flagged', has_attachments: 0, date: NOW }),
  ])
  const unread = index.listFolder({ accountId: account.id, folder: 'INBOX', filter: { unread: true }, limit: 500 }).map(m => m.uid)
  assert.ok(unread.includes(500) && unread.includes(501), 'both are unread')
  const starred = index.listFolder({ accountId: account.id, folder: 'INBOX', filter: { flagged: true }, limit: 500 }).map(m => m.uid)
  assert.ok(!starred.includes(501), '$Flagged is not \\Flagged')
})

test('listFilterSql: only ? parameters, never a value in the SQL; the shape names the fields, not the values', () => {
  const f = { unread: true, flagged: true, hasAttachment: true, since: 1234567890123, before: 1234567899999, keepIds: [424242, 434343] }
  const a = listFilterSql(f)
  for (const v of ['1234567890123', '1234567899999', '424242', '434343']) assert.ok(!a.sql.includes(v), `${v} is not in the SQL`)
  assert.deepEqual(a.params, [1234567890123, 1234567899999, '[424242,434343]'])
  assert.equal(a.shape, 'ufasbk')
  const b = listFilterSql({ ...f, since: 1, before: 2, keepIds: Array.from({ length: 300 }, (_, i) => i + 1) })
  assert.equal(b.sql, a.sql, 'same shape, same statement, whatever the values and the number of kept ids')
  assert.equal(b.shape, a.shape)
  assert.deepEqual(listFilterSql(null), { sql: '', params: [], shape: '' })
  assert.deepEqual(listFilterSql({ keepIds: [1] }), { sql: '', params: [], shape: '' })
  // a key outside the whitelist is never read into SQL
  assert.equal(listFilterSql({ "1=1) OR (1": true, unread: false }).sql, '')
})

test('parseListFilter: the whitelist and the types', () => {
  assert.deepEqual(parseListFilter(undefined), {})
  assert.deepEqual(parseListFilter(null), {})
  assert.deepEqual(parseListFilter({ unread: true, since: 0, before: null, keepIds: [] }), { unread: true, since: 0, before: null, keepIds: [] })
  const bad = [
    [], 'unread', 1, true, new Date(), Object.create(null), { unread: 'yes' }, { unread: 1 }, { flagged: null }, { color: 'red' },
    { since: '2026-11-01' }, { since: 1.5 }, { before: -1 }, { before: Number.MAX_SAFE_INTEGER + 2 }, { keepIds: 5 }, { keepIds: [0] },
    { keepIds: ['5'] }, { keepIds: [1.5] }, { keepIds: Array.from({ length: MAX_KEEP_IDS + 1 }, (_, i) => i + 1) },
  ]
  for (const v of bad) assert.equal(parseListFilter(v), null, String(JSON.stringify(v)))
  assert.ok(parseListFilter({ keepIds: Array.from({ length: MAX_KEEP_IDS }, (_, i) => i + 1) }), '500 is allowed')
})

function ipcSetup(t) {
  const s = seedFolder(t)
  const handlers = new Map()
  const ipcMain = { handle: (c, fn) => handlers.set(c, fn) }
  const isTrustedSender = () => true
  registerMailIpc({ ipcMain, store: { list: () => [] }, index: s.index, manager: { status: () => [], syncNow() {} }, isTrustedSender })
  registerActionIpc({ ipcMain, actions: {}, index: s.index, isTrustedSender })
  return { ...s, call: (ch, q) => handlers.get(ch)({}, q) }
}

test('IPC mail:list / mail:ids: a bad filter is bad_request; no filter answers as before (total = folderTotal)', async t => {
  const { account, index, call } = ipcSetup(t)
  const base = { accountId: account.id, folder: 'INBOX' }
  const bad = [
    { color: 'red' }, { unread: true, extra: 1 }, { since: '2026-11-01' }, { before: '1794500000000' }, { since: 1.25 },
    { keepIds: Array.from({ length: 501 }, (_, i) => i + 1) }, [], [true], 'unread', 7,
  ]
  for (const filter of bad) {
    for (const ch of ['mail:list', 'mail:ids']) assert.deepEqual(await call(ch, { ...base, filter }), { ok: false, error: 'bad_request' }, `${ch} ${JSON.stringify(filter)}`)
  }
  const plain = await call('mail:list', base)
  assert.equal(plain.ok, true)
  assert.equal(plain.total, 24)
  assert.equal(plain.folderTotal, 24)
  assert.deepEqual(plain.rows, index.listFolder({ accountId: account.id, folder: 'INBOX' }))
  assert.deepEqual(Object.keys(plain).sort(), ['folderTotal', 'ok', 'rows', 'total'])
  assert.deepEqual(await call('mail:list', { ...base, filter: null }), plain)

  const filtered = await call('mail:list', { ...base, filter: { unread: true, hasAttachment: true }, limit: 5 })
  assert.equal(filtered.total, 6)
  assert.equal(filtered.folderTotal, 24)
  assert.equal(filtered.rows.length, 5)
  const ids = await call('mail:ids', { ...base, filter: { unread: true, hasAttachment: true } })
  assert.equal(ids.ids.length, filtered.total, 'select all = the count')
  assert.deepEqual(ids.ids.slice(0, 5), filtered.rows.map(m => m.id))
  // the old seen parameter still works, together with the filter
  const unreadStarred = await call('mail:ids', { ...base, filter: { flagged: true }, seen: false })
  assert.equal(unreadStarred.ids.length, 6)
})
