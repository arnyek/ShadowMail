// the mail view in a filtered folder (jsdom), on the REAL index and IPC handlers
// (mail:list, mail:ids, mail:folders; the actions only change the rows, as a local POP3 action would).
// #1 a Refresh drops kept rows: the selection follows, Delete takes nothing unlisted; #2 more than 500
// rows acted on: the top of the list stays, the selection is narrowed to the listed ones; #5 a message
// opened from the reader's thread is kept like one opened from the list; #3 a refused list request is
// shown, the list does not stay "busy".
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupDom, mount, inAct, key } from './helpers/react-dom-env.js'
import { openMailDatabase } from '../core/db/index.js'
import { MailIndex } from '../core/db/mail-index.js'
import { addAccount } from './helpers/fixtures.js'
import { registerMailIpc } from '../app/main/ipc/mail.js'
import { registerActionIpc } from '../app/main/ipc/actions.js'

setupDom()
globalThis.ResizeObserver = window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const { db } = openMailDatabase(':memory:')
const index = new MailIndex(db)
const account = addAccount(db)
for (const p of ['INBOX', 'Trash']) index.upsertFolder({ account_id: account.id, path: p, uidvalidity: '1', ...(p === 'Trash' ? { special_use: '\\Trash' } : {}) })
const NOW = Date.UTC(2026, 10, 12, 12)

const handlers = new Map()
const ipcMain = { handle: (c, fn) => handlers.set(c, fn) }
const call = (c, ...a) => handlers.get(c)({}, ...a)
const log = []
let statusCb = null
const flagsOf = id => db.prepare('SELECT flags FROM messages WHERE id = ?').get(id).flags || ''
const actions = {
  run: async ({ ids, action }) => {
    log.push({ action, ids })
    for (const id of ids) {
      if (action === 'read' && !flagsOf(id).split(' ').includes('\\Seen')) db.prepare("UPDATE messages SET flags = trim(COALESCE(flags, '') || ' \\Seen') WHERE id = ?").run(id)
      if (action === 'delete') db.prepare("UPDATE messages SET folder = 'Trash' WHERE id = ?").run(id)
    }
    return { done: ids.length, final: true }
  },
}
registerMailIpc({ ipcMain, store: { list: () => [{ ...account }] }, index, manager: { status: () => [], syncNow() {} }, isTrustedSender: () => true })
registerActionIpc({ ipcMain, actions, index, isTrustedSender: () => true })

let listOverride = null
let countOverride = null
window.shadowMail = {
  onStatus: cb => ((statusCb = cb), () => {}),
  compose: { open() {} },
  search: { local: async () => ({ ok: true, rows: [], scope: { imap: false, pop3: false }, headersOnly: [], truncated: false }), cancel() {} },
  mail: {
    folders: () => call('mail:folders'),
    status: async () => ({ ok: true, accounts: [] }),
    list: q => (listOverride ? listOverride(q) : call('mail:list', q)),
    count: q => (countOverride ? countOverride(q) : call('mail:count', q)),
    ids: q => call('mail:ids', q),
    action: q => call('mail:action', q),
    sync: async () => ({ ok: true }),
    render: async () => ({ ok: false }),
    // the reader marks an opened message read, and the main process reports the folder change
    open: async id => {
      db.prepare("UPDATE messages SET flags = '\\Seen' WHERE id = ?").run(id)
      setTimeout(() => statusCb && statusCb({ kind: 'mail', changes: [{ accountId: account.id, folders: ['INBOX'] }] }), 5)
      const m = index.get(id)
      return { ok: true, message: { id, accountId: account.id, folder: 'INBOX', flags: m.flags, subject: m.subject, from: [{ name: 'X', address: 'x@example.invalid' }], to: [], cc: [], attachments: [], text: 'x', html: null } }
    },
    thread: async () => ({ ok: true, messages: index.listFolder({ accountId: account.id, folder: 'INBOX', limit: 2 }) }),
    replyInfo: async () => ({ ok: true, answered: false, forwarded: false, reply: null }),
  },
}

// n unread messages, newest first (id 1 is the top of the list)
function seed(n) {
  db.prepare('DELETE FROM messages').run()
  const rows = []
  for (let i = 1; i <= n; i++) {
    rows.push({ account_id: account.id, folder: 'INBOX', uid: i, message_id: `<v${i}@x>`, in_reply_to: null, refs: null, from_addr: 'x@example.invalid', from_name: 'X', to_addrs: '', cc_addrs: '',
      subject: `S${i}`, date: NOW - i * 1000, idate: NOW - i * 1000, flags: '', size: 1, has_attachments: 0, attachments: null, body_state: 3, sender_text: '', recipients_text: '' })
  }
  index.insertMany(rows)
  return index.listIds({ accountId: account.id, folder: 'INBOX' }) // in the list's order
}

const { createElement: h } = await import('react')
const { Mail } = await import('../app/renderer/src/Mail.jsx')
const wait = ms => new Promise(r => setTimeout(r, ms))
const settle = (ms = 40) => inAct(() => wait(ms))
const click = (el, extra = {}) => inAct(async () => {
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, ...extra }))
  await wait(30)
})
const button = (root, name) => [...root.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') || b.textContent.trim()) === name)
const shown = root => [...root.querySelectorAll('.msg-row[data-id]')].map(r => Number(r.dataset.id))
const total = root => root.querySelector('.list-count')?.dataset.total

async function unreadView(t) {
  const v = await mount(h(Mail, {}))
  t.after(v.unmount)
  const root = v.container
  await settle()
  await click(button(root, 'Szűrők'))
  await click([...root.querySelectorAll('.search-chips button.chip')].find(b => b.textContent === 'Olvasatlan'))
  await settle()
  return root
}

test('Refresh drops the kept (now read) rows: their selection goes too, Delete takes nothing unlisted', async t => {
  const ids = seed(6)
  const root = await unreadView(t)
  await click(root.querySelector(`.msg-row[data-id="${ids[0]}"]`), { ctrlKey: true })
  await click(root.querySelector(`.msg-row[data-id="${ids[1]}"]`), { ctrlKey: true })
  await click(button(root.querySelector('.action-bar'), 'Olvasott'))
  await settle(80)
  assert.equal(total(root), '6', 'kept after the action')
  assert.equal(root.querySelector('.selection-count')?.textContent, '2 kijelölve')
  await click(root.querySelector('.list-refresh'))
  await settle(80)
  const after = { total: total(root), selection: root.querySelector('.selection-count')?.textContent ?? null }
  log.length = 0
  await inAct(async () => {
    key(document.body, 'Delete')
    await wait(40)
  })
  const deleted = log.map(x => x.ids)
  assert.deepEqual(after, { total: '4', selection: null }, 'the two rows left the list, so did their selection')
  assert.deepEqual(deleted, [], 'Delete takes nothing (nothing listed is selected)')
})

test('more than 500 rows acted on: the top of the list stays (500 kept), the selection narrows to the listed', async t => {
  const ids = seed(600)
  const root = await unreadView(t)
  await inAct(async () => {
    key(root.querySelector('.msg-viewport'), 'a', { ctrlKey: true })
    await wait(40)
  })
  assert.equal(root.querySelector('.selection-count')?.textContent, '600 kijelölve')
  await click(button(root.querySelector('.action-bar'), 'Olvasott'))
  await settle(120)
  assert.equal(total(root), '500', 'the card allows 500 kept ids')
  assert.equal(shown(root)[0], ids[0], 'the top of the list stays (not the bottom 500)')
  assert.equal(root.querySelector('.selection-count')?.textContent, '500 kijelölve', 'no selected message outside the list')
  // the listed set before the delete: the top 500, all read now and kept
  const listed = new Set(index.listIds({ accountId: account.id, folder: 'INBOX', filter: { unread: true, keepIds: ids.slice(0, 500) } }))
  assert.equal(listed.size, 500)
  log.length = 0
  await inAct(async () => {
    key(document.body, 'Delete')
    await wait(60)
  })
  assert.equal(log.length, 1)
  assert.ok(log[0].ids.length === 500 && log[0].ids.every(id => listed.has(id)), 'Delete takes the 500 listed only')
})

test('a message opened from the reader thread is kept like one opened from the list', async t => {
  const ids = seed(6)
  const root = await unreadView(t)
  await click(root.querySelector(`.msg-row[data-id="${ids[0]}"]`))
  await settle(60)
  await click(button(root.querySelector('.reader-tools'), 'További'))
  await click([...document.querySelectorAll('[role^="menuitem"]')].find(e => e.textContent.trim() === 'Szál'))
  await settle(60)
  const link = [...root.querySelectorAll('.reader-thread button')].find(b => b.textContent.includes('S2'))
  await click(link)
  await settle(100)
  assert.equal(flagsOf(ids[1]), '\\Seen', 'opened from the thread: read now')
  assert.ok(shown(root).includes(ids[1]) && shown(root).includes(ids[0]), 'both opened ones stay listed')
  assert.equal(total(root), '6')
})

test('a refused list request is said (role="alert"), the list is not left "busy"', async t => {
  seed(3)
  listOverride = async () => ({ ok: false, error: 'bad_request' })
  t.after(() => (listOverride = null))
  const v = await mount(h(Mail, {}))
  t.after(v.unmount)
  await settle(60)
  const root = v.container
  assert.ok(root.querySelector('.msg-viewport [role="alert"]')?.textContent.startsWith('A levéllista nem tölthető be'))
  assert.equal(root.querySelector('.msg-viewport').getAttribute('aria-busy'), 'false')
})

// a filtered count reads the whole folder: the page comes first, its count after it (mail:list deferCount + mail:count)
test('IPC: deferCount leaves only the filtered count out; mail:count gives it; bad input is bad_request', async () => {
  const ids = seed(8)
  db.prepare("UPDATE messages SET flags = '\\Seen' WHERE id IN (?, ?, ?)").run(ids[0], ids[3], ids[5])
  const q = { accountId: account.id, folder: 'INBOX', sort: 'date', dir: 'desc', offset: 0, limit: 50, filter: { unread: true } }
  const full = await call('mail:list', q)
  const later = await call('mail:list', { ...q, deferCount: true })
  assert.deepEqual({ total: later.total, folderTotal: later.folderTotal, rows: later.rows.map(r => r.id) }, { total: null, folderTotal: 8, rows: full.rows.map(r => r.id) })
  assert.equal(full.total, 5)
  assert.deepEqual(await call('mail:count', { accountId: account.id, folder: 'INBOX', filter: { unread: true } }), { ok: true, total: 5, folderTotal: 8 })
  // no filter: nothing to defer, the total is the folder's
  const plain = await call('mail:list', { ...q, filter: undefined, deferCount: true })
  assert.equal(plain.total, 8)
  assert.deepEqual(await call('mail:count', { accountId: account.id, folder: 'INBOX' }), { ok: true, total: 8, folderTotal: 8 })
  for (const bad of [{ ...q, deferCount: 'yes' }, { ...q, deferCount: 1 }]) assert.deepEqual(await call('mail:list', bad), { ok: false, error: 'bad_request' })
  for (const bad of [null, { accountId: account.id }, { accountId: 0, folder: 'INBOX' }, { accountId: account.id, folder: 'INBOX', filter: { unread: 'x' } }, { accountId: account.id, folder: 'INBOX', offset: 0 }]) {
    assert.deepEqual(await call('mail:count', bad), { ok: false, error: 'bad_request' }, JSON.stringify(bad))
  }
})

test('a filtered view shows its rows before the count ("1–N / …"), then the count; the list asks with deferCount', async t => {
  seed(6)
  const asked = []
  listOverride = q => (asked.push(q), call('mail:list', q))
  let release
  countOverride = q => new Promise(r => (release = () => r(call('mail:count', q))))
  t.after(() => ((listOverride = null), (countOverride = null)))
  const root = await unreadView(t)
  assert.equal(shown(root).length, 6, 'the rows are there before the count')
  assert.equal(total(root), '', 'no total yet')
  assert.match(root.querySelector('.list-count').textContent, /^1–\d+ \/ …/, root.querySelector('.list-count').textContent)
  assert.ok(asked.some(q => q.deferCount === true && q.filter && q.filter.unread === true), 'the filtered list asked to defer its count')
  await inAct(async () => {
    release()
    await wait(30)
  })
  assert.equal(total(root), '6')
  assert.doesNotMatch(root.querySelector('.list-count').textContent, /…/)
})

test('a quick filter change: the count of the filter before never shows', async t => {
  const ids = seed(6)
  db.prepare("UPDATE messages SET flags = '\\Flagged' WHERE id IN (?, ?)").run(ids[0], ids[1])
  const pending = []
  countOverride = q => new Promise(r => pending.push({ q, done: () => r(call('mail:count', q)) }))
  t.after(() => (countOverride = null))
  const root = await unreadView(t) // Unread on: its count is pending
  await click([...root.querySelectorAll('.search-chips button.chip')].find(b => b.textContent === 'Olvasatlan')) // off
  await click([...root.querySelectorAll('.search-chips button.chip')].find(b => b.textContent === 'Csillagos')) // starred on
  await settle(60)
  const unreadAsk = pending.find(p => p.q.filter && p.q.filter.unread === true)
  const starAsk = pending.find(p => p.q.filter && p.q.filter.flagged === true)
  assert.ok(unreadAsk && starAsk, JSON.stringify(pending.map(p => p.q.filter)))
  // the newer count first, then the old one arrives late
  await inAct(async () => {
    starAsk.done()
    await wait(30)
  })
  assert.equal(total(root), '2', 'the starred count')
  await inAct(async () => {
    unreadAsk.done()
    await wait(30)
  })
  assert.equal(total(root), '2', 'the late unread count (6) is dropped')
  assert.deepEqual(shown(root).sort(), [ids[0], ids[1]].sort())
})

test('a filtered view of several pages: the count is asked once, a later page (without a count) keeps the total', async t => {
  const ids = seed(450)
  const asked = []
  countOverride = q => (asked.push(q), call('mail:count', q))
  t.after(() => (countOverride = null))
  const root = await unreadView(t)
  await settle(60)
  assert.equal(total(root), '450')
  const rows = [...root.querySelectorAll('.msg-row[data-id]')]
  const rowH = parseFloat(rows[1].style.top) - parseFloat(rows[0].style.top)
  assert.ok(rowH > 0, `row height ${rowH}`)
  const vp = root.querySelector('.msg-viewport')
  // jsdom has no layout: the scroll position is set by hand, then the scroll event tells the list
  Object.defineProperty(vp, 'scrollTop', { configurable: true, writable: true, value: 300 * rowH })
  await inAct(async () => {
    vp.dispatchEvent(new window.Event('scroll'))
    await wait(60)
  })
  const after = { total: total(root), asked: asked.length, page2: shown(root).includes(ids[300]) }
  assert.deepEqual(after, { total: '450', asked: 1, page2: true })
})

test('a change (version) in a filtered view: the old count is never shown beside the new rows ("1–N / …" until the new count)', async t => {
  seed(6)
  const pending = []
  countOverride = q => (pending.length ? new Promise(r => pending.push(() => r(call('mail:count', q)))) : (pending.push(null), call('mail:count', q)))
  const asked = []
  listOverride = q => (asked.push(q), call('mail:list', q))
  t.after(() => ((countOverride = null), (listOverride = null)))
  const root = await unreadView(t)
  await settle(40)
  assert.equal(total(root), '6')
  // a new unread message arrives
  index.insertMany([{ account_id: account.id, folder: 'INBOX', uid: 99, message_id: '<v99@x>', in_reply_to: null, refs: null, from_addr: 'x@example.invalid', from_name: 'X', to_addrs: '', cc_addrs: '',
    subject: 'Uj', date: NOW + 1000, idate: NOW + 1000, flags: '', size: 1, has_attachments: 0, attachments: null, body_state: 3, sender_text: '', recipients_text: '' }])
  const newId = db.prepare("SELECT id FROM messages WHERE subject = 'Uj'").pluck().get()
  // Refresh (a sync, an action and a label change step the list's version the same way)
  await click(root.querySelector('.list-refresh'))
  await settle(80)
  const during = { top: shown(root)[0], total: total(root), text: root.querySelector('.list-count').textContent }
  assert.equal(pending.length, 2, `the new generation asked for its count: ${JSON.stringify(asked.map(q => [q.offset, q.deferCount ?? null]))}`)
  await inAct(async () => {
    pending[1]()
    await wait(30)
  })
  assert.deepEqual({ top: during.top, total: during.total, open: /^1–\d+ \/ …/.test(during.text) }, { top: newId, total: '', open: true }, during.text)
  assert.equal(total(root), '7')
})
