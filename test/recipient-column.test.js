// The Sent and Drafts lists show the recipient in the sender's place ("Name +2"), sorted by it; every other folder and
// the search stay as they were. The Bcc line (migration 14) is the fallback for a message sent with Bcc only: new rows
// get it from the envelope / the message, old rows without To and Cc get it once from the server (IMAP, only those rows)
// or their own .eml (POP3).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { memoryIndex, addAccount, DAY, sealedStore } from './helpers/fixtures.js'
import { FakeImapServer } from './helpers/fake-imap.js'
import { onCleanup, tempDir } from './helpers/tmp.js'
import { setupDom, mount } from './helpers/react-dom-env.js'
import { parseAddrList, recipientLabel, recipientKey, RECIPIENT_ROLES } from '../core/mime/recipient-label.js'
import { LIST_SORTS } from '../core/db/mail-index.js'
import { fmtAddrs } from '../core/mime/envelope.js'
import { registerMailIpc, listSortFor } from '../app/main/ipc/mail.js'
import { registerActionIpc } from '../app/main/ipc/actions.js'
import { Syncer } from '../core/imap/sync.js'
import { Pop3Fetcher } from '../core/pop3/fetcher.js'
import { composeMessage } from '../core/smtp/compose.js'

const NOW = Date.UTC(2026, 10, 17, 12, 0, 0)

test('parseAddrList: the stored "Name <a@b>, c@d" back to its addresses; a comma inside a name; a group name is no recipient', () => {
  assert.deepEqual(parseAddrList(''), [])
  assert.deepEqual(parseAddrList(null), [])
  assert.deepEqual(parseAddrList('a@example.invalid'), [{ name: '', address: 'a@example.invalid' }])
  assert.deepEqual(parseAddrList('Kiss Anna <anna@example.invalid>, b@example.invalid'), [
    { name: 'Kiss Anna', address: 'anna@example.invalid' },
    { name: '', address: 'b@example.invalid' },
  ])
  // a name with a comma stays one name: quoted by fmtAddrs since 0.15.1, unquoted in the rows stored before
  const list = [{ name: 'Doe, John', address: 'j@example.invalid' }, { name: '', address: 'x@example.invalid' }, { name: 'Ő, Ű, és Á', address: 'u@example.invalid' }]
  assert.deepEqual(parseAddrList(fmtAddrs(list)), list)
  // imapflow: an RFC 5322 group's name with an empty address ("undisclosed-recipients:;")
  assert.deepEqual(parseAddrList(fmtAddrs([{ name: 'undisclosed-recipients', address: '' }])), [])
  assert.deepEqual(parseAddrList('undisclosed-recipients <>, c@example.invalid'), [{ name: '', address: 'c@example.invalid' }])
  // a leftover without an address (a name cut short) is dropped, not shown as an address
  assert.deepEqual(parseAddrList('Kiss Anna'), [])
})

test('fmtAddrs quotes a name holding a comma, quote, angle bracket or backslash; parseAddrList reads it back as one recipient', () => {
  // a name that looks like an address list: unquoted it made a false first recipient ("a@evil.example +1")
  const hostile = [
    { name: 'a@evil.example, Real', address: 'r@example.invalid' },
    { name: 'b@x.invalid, c@y.invalid, "Q"', address: 'q@example.invalid' },
    { name: 'x <y@z.invalid>', address: 'w@example.invalid' },
    { name: 'Back\\slash, "quote"', address: 'bs@example.invalid' },
    { name: 'Lone " quote', address: 'lq@example.invalid' },
    { name: '', address: 'bare@example.invalid' },
    { name: 'Kiss Anna', address: 'anna@example.invalid' },
  ]
  const stored = fmtAddrs(hostile)
  assert.deepEqual(parseAddrList(stored), hostile)
  for (const a of hostile) assert.deepEqual(parseAddrList(fmtAddrs([a])), a.address ? [a] : [], JSON.stringify(a))
  // every one first, after any other: the label and the sort key name it
  for (const a of hostile) for (const b of hostile) {
    const to = fmtAddrs([a, b])
    const r = recipientLabel({ to_addrs: to })
    assert.deepEqual([r.name, r.address], [a.name, a.address], to)
    assert.equal(recipientKey(to, '', null), a.name || a.address, to)
  }
  // a plain name is stored as before (old and new rows of the same person sort together)
  assert.equal(fmtAddrs([{ name: 'Kiss Anna', address: 'anna@example.invalid' }, { name: 'Ő. Ű-Á (x)', address: 'u@example.invalid' }]), 'Kiss Anna <anna@example.invalid>, Ő. Ű-Á (x) <u@example.invalid>')
  assert.equal(fmtAddrs([{ name: 'a@evil.example, Real', address: 'r@example.invalid' }]), '"a@evil.example, Real" <r@example.invalid>')
  // rows stored before 0.15.1: a stray quote in an unquoted name does not swallow the next recipient, an open quote
  // falls back to the old reading
  assert.deepEqual(parseAddrList('O"Neil <a@example.invalid>, B"rown <b@example.invalid>').map(a => a.address), ['a@example.invalid', 'b@example.invalid'])
  assert.deepEqual(parseAddrList('"open <a@example.invalid>, b@example.invalid').map(a => a.address), ['a@example.invalid', 'b@example.invalid'])
  assert.deepEqual(parseAddrList('Doe, "Jr" <j@example.invalid>, c@example.invalid'), [{ name: 'Doe, "Jr"', address: 'j@example.invalid' }, { name: '', address: 'c@example.invalid' }])
  // an old unquoted name that only opens with a quote: the quoting is not trusted, the old reading stays
  assert.deepEqual(parseAddrList('"Hi, there <h@example.invalid>, "Bob" <b@example.invalid>'), [{ name: '"Hi, there', address: 'h@example.invalid' }, { name: 'Bob', address: 'b@example.invalid' }], 'a name that is one quoted string shows unquoted')
  assert.deepEqual(parseAddrList('"Hi" there <h@example.invalid>, c@example.invalid').map(a => a.address), ['h@example.invalid', 'c@example.invalid'])
})

test('recipientLabel: the first To, "+N" for the other distinct To / Cc addresses; empty To -> Cc, then Bcc; none -> null', () => {
  const one = recipientLabel({ to_addrs: 'Kiss Anna <anna@example.invalid>' })
  assert.deepEqual([one.name, one.address, one.more], ['Kiss Anna', 'anna@example.invalid', 0])
  const three = recipientLabel({ to_addrs: 'Kiss Anna <anna@example.invalid>, b@example.invalid', cc_addrs: 'C <c@example.invalid>, ANNA@example.invalid', bcc_addrs: 'z@example.invalid' })
  assert.equal(three.more, 2, 'To + Cc, an address once (any case); the Bcc does not count')
  assert.deepEqual(three.all.map(a => a.address), ['anna@example.invalid', 'b@example.invalid', 'c@example.invalid'])
  const bare = recipientLabel({ to_addrs: 'b@example.invalid' })
  assert.deepEqual([bare.name, bare.address], ['', 'b@example.invalid'], 'no name: the address')
  const ccOnly = recipientLabel({ to_addrs: '', cc_addrs: 'C <c@example.invalid>', bcc_addrs: 'z@example.invalid' })
  assert.deepEqual([ccOnly.name, ccOnly.more], ['C', 0])
  const bccOnly = recipientLabel({ to_addrs: '', cc_addrs: '', bcc_addrs: 'Z <z@example.invalid>, y@example.invalid' })
  assert.deepEqual([bccOnly.name, bccOnly.address, bccOnly.more], ['Z', 'z@example.invalid', 1])
  assert.equal(recipientLabel({ to_addrs: '', cc_addrs: '', bcc_addrs: null }), null)
  assert.equal(recipientLabel({}), null)
  assert.equal(recipientKey('Kiss Anna <anna@example.invalid>', '', null), 'Kiss Anna')
  assert.equal(recipientKey('b@example.invalid', '', ''), 'b@example.invalid')
  assert.equal(recipientKey('', '', 'Z <z@example.invalid>'), 'Z')
  assert.equal(recipientKey('', '', null), '')
  assert.deepEqual([...RECIPIENT_ROLES].sort(), ['drafts', 'sent'])
  // the sort key (read only up to the first recipient) is always the label's first recipient
  const lines = ['', 'a@example.invalid', 'Doe, John <j@example.invalid>, b@example.invalid', 'undisclosed-recipients <>, c@example.invalid', 'Kiss Anna', 'Név <>, ', 'Z <z@example.invalid>']
  for (const to of lines) for (const cc of lines) for (const bcc of [...lines, null]) {
    const r = recipientLabel({ to_addrs: to, cc_addrs: cc, bcc_addrs: bcc })
    assert.equal(recipientKey(to, cc, bcc), r ? r.name || r.address : '', JSON.stringify([to, cc, bcc]))
  }
})

function fakeIpc() {
  const handlers = new Map()
  return { handle: (c, fn) => handlers.set(c, fn), call: (c, ...a) => handlers.get(c)({ trusted: true }, ...a) }
}

const row = (accountId, folder, uid, { from = 'en@example.invalid', fromName = 'Én', to = '', cc = '', bcc = '', subject = `Levél ${uid}` } = {}) => ({
  account_id: accountId, folder, uid, message_id: `<r${folder}${uid}@x>`, in_reply_to: null, refs: null,
  from_addr: from, from_name: fromName, to_addrs: to, cc_addrs: cc, bcc_addrs: bcc, subject, date: NOW - uid * 60_000, idate: NOW - uid * 60_000,
  flags: '\\Seen', size: 100, has_attachments: 0, attachments: null, body_state: 3, sender_text: from, recipients_text: [to, cc].filter(Boolean).join(', '),
})

function listSetup(t) {
  const { db, index } = memoryIndex(t)
  const account = addAccount(db)
  for (const p of ['INBOX', 'Sent', 'Drafts', 'Régi']) index.upsertFolder({ account_id: account.id, path: p, uidvalidity: '1' })
  // Sent: the order by recipient differs from the order by sender (all from "Én") and from the date
  const sent = [
    { to: 'Zoltán <z@example.invalid>' },
    { to: 'b@example.invalid, Cecil <c@example.invalid>' },
    { to: '', cc: '', bcc: 'Aladár <a@example.invalid>' },
    { to: '', cc: '', bcc: '' },
    { to: 'Doe, John <j@example.invalid>', cc: 'k@example.invalid' },
    { to: 'Mária <m@example.invalid>', fromName: 'Más Név' },
  ]
  index.insertMany(sent.map((o, i) => row(account.id, 'Sent', i + 1, o)))
  index.insertMany(sent.map((o, i) => row(account.id, 'Régi', i + 1, o)))
  index.insertMany([
    row(account.id, 'INBOX', 1, { from: 'y@example.invalid', fromName: 'Yvett', to: 'Aladár <a@example.invalid>' }),
    row(account.id, 'INBOX', 2, { from: 'b@example.invalid', fromName: 'Béla', to: 'Zoltán <z@example.invalid>' }),
  ])
  const ipc = fakeIpc()
  registerMailIpc({ ipcMain: ipc, store: { list: () => [account] }, index, manager: { status: () => [], syncNow: () => {} }, isTrustedSender: e => e.trusted })
  registerActionIpc({ ipcMain: ipc, actions: { run: async () => ({}) }, index, isTrustedSender: e => e.trusted })
  return { db, index, account, ipc }
}

const keyOf = r => recipientKey(r.to_addrs, r.cc_addrs, r.bcc_addrs).toLowerCase()

test('the list: in Sent the "from" order is by the recipient (both ways, ids = list); INBOX and a plain folder by the sender', async t => {
  const { index, account, ipc } = listSetup(t)
  for (const dir of ['asc', 'desc']) {
    const res = await ipc.call('mail:list', { accountId: account.id, folder: 'Sent', sort: 'from', dir, limit: 50 })
    assert.equal(res.ok, true)
    const keys = res.rows.map(keyOf)
    const sorted = [...keys].sort()
    assert.deepEqual(keys, dir === 'asc' ? sorted : sorted.reverse(), `Sent ${dir}: ${keys}`)
    assert.deepEqual(keys, dir === 'asc' ? ['', 'aladár', 'b@example.invalid', 'doe, john', 'mária', 'zoltán'] : ['zoltán', 'mária', 'doe, john', 'b@example.invalid', 'aladár', ''])
    // the rows carry the recipient lines (the renderer shows them)
    assert.ok(res.rows.every(r => 'to_addrs' in r && 'cc_addrs' in r && 'bcc_addrs' in r))
    const ids = await ipc.call('mail:ids', { accountId: account.id, folder: 'Sent', sort: 'from', dir })
    assert.deepEqual(ids.ids, res.rows.map(r => r.id), `Sent ${dir}: "select all" in the shown order`)
  }
  // a folder without the role: by the sender, as before (two rows "Más Név" / "Én")
  const plain = await ipc.call('mail:list', { accountId: account.id, folder: 'Régi', sort: 'from', dir: 'asc', limit: 50 })
  // NOCASE folds ASCII only: the accented capital sorts after the plain letters (the old rule, unchanged)
  assert.deepEqual(plain.rows.map(r => r.from_name), ['Más Név', 'Én', 'Én', 'Én', 'Én', 'Én'])
  const inbox = await ipc.call('mail:list', { accountId: account.id, folder: 'INBOX', sort: 'from', dir: 'asc', limit: 50 })
  assert.deepEqual(inbox.rows.map(r => r.from_name), ['Béla', 'Yvett'])
  // the other orders are not touched
  assert.equal(listSortFor(index, account.id, 'Sent', 'date'), 'date')
  assert.equal(listSortFor(index, account.id, 'Sent', 'subject'), 'subject')
  assert.equal(listSortFor(index, account.id, 'INBOX', 'from'), 'from')
  assert.ok(Object.hasOwn(LIST_SORTS, 'recipient'))
})

test('the role decides, not the name: Drafts too, and a hand-picked Sent folder (setManualRole) switches the order with it', async t => {
  const { db, index, account, ipc } = listSetup(t)
  assert.equal(listSortFor(index, account.id, 'Drafts', 'from'), 'recipient')
  // stored roles (as after a full sync), then the user picks "Régi" as Sent
  index.setFolderRoles(account.id, new Map([['INBOX', 'inbox'], ['Sent', 'sent'], ['Drafts', 'drafts']]))
  assert.equal(listSortFor(index, account.id, 'Régi', 'from'), 'from')
  index.setManualRole(account.id, 'sent', 'Régi')
  assert.equal(db.prepare("SELECT role FROM folders WHERE account_id = ? AND path = 'Régi'").pluck().get(account.id), 'sent')
  assert.equal(listSortFor(index, account.id, 'Régi', 'from'), 'recipient')
  assert.equal(listSortFor(index, account.id, 'Sent', 'from'), 'from', 'the old Sent lost the role')
  const res = await ipc.call('mail:list', { accountId: account.id, folder: 'Régi', sort: 'from', dir: 'asc', limit: 50 })
  assert.deepEqual(res.rows.map(keyOf), ['', 'aladár', 'b@example.invalid', 'doe, john', 'mária', 'zoltán'])
})

async function imapSetup(t) {
  const { db, index } = memoryIndex(t)
  const account = addAccount(db)
  const server = new FakeImapServer()
  server.addMailbox('INBOX').addMailbox('Sent', { specialUse: '\\Sent' }).addMailbox('Drafts', { specialUse: '\\Drafts' }).addMailbox('Régi')
  const env = (path, uid, patch) => Object.assign(server.mailboxes.get(path).messages.get(uid).envelope, patch)
  const add = (path, n, patch) => {
    const uid = server.addMessage(path, { from: account.email, to: `t${n}@example.invalid`, subject: `Levél ${n}`, messageId: `<s${n}@x>`, date: NOW - n * DAY, body: `Szöveg ${n}` })
    env(path, uid, patch)
    return uid
  }
  const syncer = new Syncer({ account, index, connect: () => server.connect(), now: () => NOW })
  syncer.syncBodies = async () => {}
  onCleanup(t, () => syncer.stop())
  return { db, index, account, server, add, syncer }
}

test('sync: a new row stores its Bcc from the envelope (\'\' = none); an old Sent row without To / Cc gets it once, only that row is fetched', async t => {
  const { db, index, account, server, add, syncer } = await imapSetup(t)
  const bccOnly = { to: [], cc: [], bcc: [{ name: 'Titkos Tóbiás', address: 'tobias@example.invalid' }, { name: '', address: 'u@example.invalid' }] }
  add('Sent', 1, bccOnly)
  add('Sent', 2, { bcc: [] })
  add('Sent', 3, { to: [], cc: [], bcc: [{ name: 'Régi Rita', address: 'rita@example.invalid' }] })
  add('Sent', 4, { to: [], cc: [] })
  // a group as the To (imapflow: the group name, no address): no To recipient, so the Bcc is needed
  add('Sent', 6, { to: [{ name: 'undisclosed-recipients', address: '' }], cc: [], bcc: [{ name: 'Csoport Bcc', address: 'g@example.invalid' }] })
  add('Régi', 5, { to: [], cc: [], bcc: [{ name: 'Nem Kell', address: 'n@example.invalid' }] })
  await syncer.run()
  const bccOf = (folder, uid) => db.prepare('SELECT bcc_addrs FROM messages WHERE account_id = ? AND folder = ? AND uid = ?').pluck().get(account.id, folder, uid)
  assert.equal(bccOf('Sent', 1), 'Titkos Tóbiás <tobias@example.invalid>, u@example.invalid')
  assert.equal(bccOf('Sent', 2), '')
  assert.equal(bccOf('Régi', 1), 'Nem Kell <n@example.invalid>', 'every new row keeps its Bcc line')

  // rows as 0.15.0 stored them: Bcc unknown
  db.prepare('UPDATE messages SET bcc_addrs = NULL WHERE account_id = ?').run(account.id)
  server.fetchLog.length = 0
  // a fresh instance (the fill runs once per folder and instance)
  const again = new Syncer({ account, index, connect: () => server.connect(), now: () => NOW })
  again.syncBodies = async () => {}
  onCleanup(t, () => again.stop())
  await again.run()
  assert.equal(bccOf('Sent', 1), 'Titkos Tóbiás <tobias@example.invalid>, u@example.invalid')
  assert.equal(bccOf('Sent', 3), 'Régi Rita <rita@example.invalid>')
  assert.equal(bccOf('Sent', 4), '', 'known now: none')
  assert.equal(bccOf('Sent', 2), null, 'a row with a To is not fetched (its Bcc is never shown)')
  assert.equal(bccOf('Régi', 1), null, 'a folder without the role is not fetched')
  const envelopeFetches = server.fetchLog.filter(f => f.kind === 'meta')
  assert.equal(bccOf('Sent', 5), 'Csoport Bcc <g@example.invalid>', 'a group-only To counts as no To')
  assert.deepEqual(envelopeFetches.map(f => [f.path, f.uids]), [['Sent', [1, 3, 4, 5]]], 'one FETCH, only the rows with no To / Cc recipient')

  // the next run of the same instance does not fetch them again
  server.fetchLog.length = 0
  db.prepare("UPDATE messages SET bcc_addrs = NULL WHERE account_id = ? AND folder = 'Sent' AND uid = 4").run(account.id)
  await again.run()
  assert.deepEqual(server.fetchLog.filter(f => f.kind === 'meta'), [])

  // the list shows it: Sent ordered by the recipient, the Bcc-only rows by their Bcc
  const rows = index.listFolder({ accountId: account.id, folder: 'Sent', sort: 'recipient', dir: 'asc', limit: 10 })
  assert.deepEqual(rows.map(keyOf), ['', 'csoport bcc', 'régi rita', 't2@example.invalid', 'titkos tóbiás'])
})

test('sync: a To name that looks like an address list is stored quoted; the Sent list names the real first recipient', async t => {
  const { db, index, account, add, syncer } = await imapSetup(t)
  add('Sent', 1, { to: [{ name: 'a@evil.example, Real', address: 'r@example.invalid' }], cc: [{ name: 'Doe, John', address: 'j@example.invalid' }] })
  await syncer.run()
  const r = db.prepare("SELECT to_addrs, cc_addrs, bcc_addrs FROM messages WHERE account_id = ? AND folder = 'Sent'").get(account.id)
  assert.equal(r.to_addrs, '"a@evil.example, Real" <r@example.invalid>')
  assert.equal(r.cc_addrs, '"Doe, John" <j@example.invalid>')
  const label = recipientLabel(r)
  assert.deepEqual([label.name, label.address, label.more], ['a@evil.example, Real', 'r@example.invalid', 1])
  const [listed] = index.listFolder({ accountId: account.id, folder: 'Sent', sort: 'recipient', dir: 'asc', limit: 10 })
  assert.equal(keyOf(listed), 'a@evil.example, real')
})

test('POP3: a local Sent row stored before 0.15.1 without To / Cc gets its Bcc from its own .eml, no network', async t => {
  const { db, index } = memoryIndex(t)
  const account = addAccount(db, { type: 'pop3' })
  const storeDir = path.join(tempDir(t), 'store')
  const sealed = sealedStore(storeDir)
  const { sentCopy } = await composeMessage({ from: { name: 'Én', address: account.email }, bcc: [{ name: 'Titkos Tóbiás', address: 'tobias@example.invalid' }], subject: 'Csak titkos', text: 'x' })
  const rel = `${account.id}/sent-a.eml`
  sealed.write(rel, sentCopy)
  index.ensureLocalFolders(account.id, [{ path: 'INBOX', specialUse: null }, { path: 'Sent', specialUse: '\\Sent' }, { path: 'Drafts', specialUse: '\\Drafts' }])
  index.insertMany([{ ...row(account.id, 'Sent', null, { to: '', cc: '', bcc: null }), message_id: '<p1@x>', store_path: rel, body_state: 1 }])
  const changes = []
  let connects = 0
  const fetcher = new Pop3Fetcher({
    account, loadAccount: () => db.prepare('SELECT * FROM accounts WHERE id = ?').get(account.id), index, sealed, now: () => NOW,
    connect: async () => {
      connects++
      throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' })
    },
    onChange: c => changes.push(c),
  })
  onCleanup(t, () => fetcher.stop())
  await fetcher.run().catch(() => {})
  assert.equal(db.prepare("SELECT bcc_addrs FROM messages WHERE account_id = ? AND folder = 'Sent'").pluck().get(account.id), 'Titkos Tóbiás <tobias@example.invalid>')
  assert.equal(connects, 1, 'filled before the login: the server is not needed')
  assert.ok(changes.some(c => c.folders.includes('Sent')), 'the list redraws')
})

setupDom()
const { createElement: h } = await import('react')
const { RowText } = await import('../app/renderer/src/RowText.jsx')
const { t: tr } = await import('../app/renderer/i18n/index.js')

test('the row: "Name +2" in the sender cell with the recipient flag (the count apart, the tooltip lists all); without it the sender', async () => {
  const m = { id: 1, from_addr: 'en@example.invalid', from_name: 'Én', to_addrs: 'Kiss Anna <anna@example.invalid>, b@example.invalid', cc_addrs: 'c@example.invalid', bcc_addrs: '', subject: 'S', date: NOW, has_attachments: 0, flags: '' }
  const r = await mount(h('div', null, h(RowText, { m, recipient: true })))
  const cell = r.container.querySelector('.col-from')
  assert.ok(cell.classList.contains('col-recipient'))
  assert.equal(cell.querySelector('.recipient-name').textContent, 'Kiss Anna')
  assert.equal(cell.querySelector('.recipient-more').textContent, ' +2')
  assert.equal(cell.textContent, 'Kiss Anna +2')
  assert.equal(cell.getAttribute('title'), 'Kiss Anna <anna@example.invalid>, b@example.invalid, c@example.invalid')
  const one = await mount(h('div', null, h(RowText, { m: { ...m, to_addrs: 'b@example.invalid', cc_addrs: '' }, recipient: true })))
  assert.equal(one.container.querySelector('.col-from').textContent, 'b@example.invalid')
  assert.equal(one.container.querySelector('.recipient-more'), null)
  const none = await mount(h('div', null, h(RowText, { m: { ...m, to_addrs: '', cc_addrs: '', bcc_addrs: null }, recipient: true })))
  assert.equal(none.container.querySelector('.col-from').textContent, tr.noRecipient)
  assert.equal(none.container.querySelector('.col-from').dataset.recipient, 'none')
  const sender = await mount(h('div', null, h(RowText, { m })))
  assert.equal(sender.container.querySelector('.col-from').textContent, 'Én')
  assert.equal(sender.container.querySelector('.col-recipient'), null)
})
