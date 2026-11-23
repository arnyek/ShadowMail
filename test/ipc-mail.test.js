// Mail IPC: argument checks, list pages and ordering, and the 10 000-message folder timing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memoryIndex, addAccount, DAY } from './helpers/fixtures.js'
import { registerMailIpc, MAIL_CHANNELS } from '../app/main/ipc/mail.js'

const NOW = Date.UTC(2026, 10, 11, 12, 0, 0)

function fakeIpc() {
  const handlers = new Map()
  return {
    handlers,
    handle: (channel, fn) => handlers.set(channel, fn),
    call: (channel, ...args) => handlers.get(channel)({ trusted: true }, ...args),
    callUntrusted: (channel, ...args) => handlers.get(channel)({ trusted: false }, ...args),
  }
}

// n messages straight into the index (as the test-data generator does)
function seed(index, accountId, n, folder = 'INBOX') {
  const rows = []
  for (let i = 0; i < n; i++) {
    const from = `kuldo${i % 97}@example.invalid`
    rows.push({
      account_id: accountId, folder, uid: i + 1, message_id: `<seed${i}@x>`, in_reply_to: null, refs: null,
      from_addr: from, from_name: i % 3 ? `Feladó ${String(i % 97).padStart(2, '0')}` : '', to_addrs: 'en@example.invalid', cc_addrs: '',
      subject: `Tárgy ${String(i).padStart(5, '0')}`, date: NOW - i * 60_000, idate: NOW - i * 60_000,
      flags: i % 4 ? '\\Seen' : '', size: 1000, has_attachments: i % 10 === 0 ? 1 : 0, attachments: null,
      body_state: 3, sender_text: from, recipients_text: 'en@example.invalid',
    })
  }
  index.insertMany(rows)
}

function setup(t) {
  const { db, index } = memoryIndex(t)
  const account = addAccount(db)
  index.upsertFolder({ account_id: account.id, path: 'INBOX', uidvalidity: '1' })
  const synced = []
  const manager = { status: () => [{ accountId: account.id }], syncNow: id => synced.push(id) }
  const store = { list: () => [{ ...account }] }
  const ipc = fakeIpc()
  const logs = []
  registerMailIpc({ ipcMain: ipc, store, index, manager, isTrustedSender: e => e.trusted, log: m => logs.push(m) })
  return { db, index, account, ipc, synced, logs }
}

test('mail channels: exactly these, untrusted senders refused, bad arguments refused without touching SQL', async t => {
  const { ipc, account, synced } = setup(t)
  assert.deepEqual([...ipc.handlers.keys()].sort(), [...MAIL_CHANNELS].sort())
  assert.deepEqual(await ipc.callUntrusted('mail:list', { accountId: account.id, folder: 'INBOX' }), { ok: false, error: 'untrusted_sender' })

  const bad = [
    null, 'x', [], { accountId: 0, folder: 'INBOX' }, { accountId: account.id }, { accountId: account.id, folder: '' },
    { accountId: account.id, folder: 'INBOX', sort: 'date; DROP TABLE messages' }, { accountId: account.id, folder: 'INBOX', sort: 'constructor' },
    { accountId: account.id, folder: 'INBOX', dir: 'sideways' }, { accountId: account.id, folder: 'INBOX', limit: 501 },
    { accountId: account.id, folder: 'INBOX', offset: -1 }, { accountId: account.id, folder: 'INBOX', offset: 1.5 },
  ]
  for (const q of bad) assert.deepEqual(await ipc.call('mail:list', q), { ok: false, error: 'bad_request' }, JSON.stringify(q))
  assert.deepEqual(await ipc.call('mail:sync', 'all'), { ok: false, error: 'bad_request' })

  assert.deepEqual(await ipc.call('mail:sync', account.id), { ok: true })
  assert.deepEqual(await ipc.call('mail:sync', null), { ok: true })
  assert.deepEqual(synced, [account.id, null])
  const st = await ipc.call('mail:status')
  assert.deepEqual(st, { ok: true, accounts: [{ accountId: account.id }] })
})

test('folders: counts and unread per folder', async t => {
  const { ipc, index, account } = setup(t)
  seed(index, account.id, 20)
  const res = await ipc.call('mail:folders')
  assert.equal(res.ok, true)
  const inbox = res.accounts[0].folders.find(f => f.path === 'INBOX')
  assert.equal(inbox.count, 20)
  assert.equal(inbox.unread, 5) // every 4th has no \Seen
})

test('list pages: no overlap, every message once, sorted by date / sender / subject both ways', async t => {
  const { ipc, index, account } = setup(t)
  seed(index, account.id, 450)
  const all = async (sort, dir) => {
    const ids = []
    let total = null
    for (let offset = 0; total === null || offset < total; offset += 200) {
      const res = await ipc.call('mail:list', { accountId: account.id, folder: 'INBOX', sort, dir, offset, limit: 200 })
      total = res.total
      ids.push(...res.rows)
    }
    return ids
  }
  for (const [sort, key] of [['date', r => r.date], ['subject', r => r.subject], ['from', r => (r.from_name || r.from_addr).toLowerCase()]]) {
    for (const dir of ['asc', 'desc']) {
      const rows = await all(sort, dir)
      assert.equal(rows.length, 450)
      assert.equal(new Set(rows.map(r => r.id)).size, 450, `${sort} ${dir}: no duplicates across pages`)
      for (let i = 1; i < rows.length; i++) {
        const a = key(rows[i - 1])
        const b = key(rows[i])
        assert.ok(dir === 'asc' ? a <= b : a >= b, `${sort} ${dir} at ${i}: ${a} / ${b}`)
      }
    }
  }
  // only the list's columns cross the bridge (no body); the recipient lines since 0.15.1 (the Sent / Drafts lists show them);
  // stored and size since 0.19.0 (the drag's choice: a 0 / 1 flag, never the store path)
  const one = (await ipc.call('mail:list', { accountId: account.id, folder: 'INBOX', limit: 1 })).rows[0]
  assert.deepEqual(Object.keys(one).sort(), ['bcc_addrs', 'cc_addrs', 'date', 'flags', 'folder', 'from_addr', 'from_name', 'has_attachments', 'id', 'preview', 'size', 'stored', 'subject', 'to_addrs', 'uid'])
})

test('10 000-message folder: opening it (count + first page + folder counts) stays well under 1 s', async t => {
  const { ipc, index, account } = setup(t)
  seed(index, account.id, 10_000)
  const times = {}
  for (const sort of ['date', 'from', 'subject']) {
    const t0 = performance.now()
    const folders = await ipc.call('mail:folders')
    const page = await ipc.call('mail:list', { accountId: account.id, folder: 'INBOX', sort, dir: sort === 'date' ? 'desc' : 'asc', offset: 0, limit: 200 })
    times[sort] = Math.round(performance.now() - t0)
    assert.equal(page.total, 10_000)
    assert.equal(page.rows.length, 200)
    assert.equal(folders.accounts[0].folders[0].count, 10_000)
  }
  // deep page (the end of the scroll bar)
  const t0 = performance.now()
  const tail = await ipc.call('mail:list', { accountId: account.id, folder: 'INBOX', offset: 9_800, limit: 200 })
  times.lastPage = Math.round(performance.now() - t0)
  assert.equal(tail.rows.length, 200)
  t.diagnostic(`10k folder open, ms: ${JSON.stringify(times)}`)
  for (const [k, ms] of Object.entries(times)) assert.ok(ms < 1000, `${k}: ${ms} ms`)
})
