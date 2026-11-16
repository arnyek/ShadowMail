import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { memoryIndex } from './helpers/fixtures.js'
import { tempDir } from './helpers/tmp.js'
import { Vault } from '../core/vault/vault.js'
import { AccountStore, newAccountDefaults } from '../core/accounts/model.js'
import { registerAccountIpc, ACCOUNT_CHANNELS } from '../app/main/ipc/accounts.js'

const FAST = { N: 2 ** 12, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
const PW = 'Bejovo-Jelszo-IPC-1'
const NOW = Date.UTC(2026, 10, 11, 12)
const DAY = 86_400_000

async function setup(t) {
  const { db, index } = memoryIndex(t)
  const vault = new Vault(path.join(tempDir(t), 'vault.json'), { kdfParams: FAST, failDelayMs: 0 })
  await vault.create('Mesterjelszo-IPC-teszt')
  vault.attach(db)
  const store = new AccountStore(db, vault)
  const handlers = new Map()
  const events = []
  const probes = []
  registerAccountIpc({
    ipcMain: { handle: (c, fn) => handlers.set(c, fn) },
    store,
    index,
    isTrustedSender: e => e.trusted,
    notify: e => events.push({ ...e, at: performance.now() }),
    probe: async (account, passwords) => {
      probes.push({ account, passwords })
      return { incoming: { ok: true, error: null }, smtp: { ok: false, error: 'auth_failed' } }
    },
    now: () => NOW,
  })
  const call = (c, ...args) => handlers.get(c)({ trusted: true }, ...args)
  return { db, index, vault, store, handlers, call, events, probes }
}

const form = (over = {}) => ({
  ...newAccountDefaults('imap'),
  name: 'IPC fiók',
  email: 'ipc@example.invalid',
  in_host: 'imap.example.invalid',
  in_user: 'ipc@example.invalid',
  in_password: PW,
  smtp_host: 'smtp.example.invalid',
  ...over,
})

test('channels; save answers the account without any password; invalid fields come back as codes', async t => {
  const { handlers, call } = await setup(t)
  assert.deepEqual([...handlers.keys()].sort(), [...ACCOUNT_CHANNELS].sort())
  const saved = await call('accounts:save', form())
  assert.equal(saved.ok, true)
  assert.equal(saved.account.has_incoming_password, true)
  const listed = await call('accounts:list')
  for (const reply of [saved, listed]) assert.equal(JSON.stringify(reply).includes(PW), false)
  const bad = await call('accounts:save', form({ in_port: 0, index_years: 51 }))
  assert.deepEqual([bad.ok, bad.error, bad.fields.in_port, bad.fields.index_years], [false, 'invalid', 'bad_port', 'bad_index_years'])
  assert.deepEqual(await call('accounts:save', 'nem objektum'), { ok: false, error: 'invalid', fields: { form: 'bad_form' } })
})

test('the connection test uses the stored password when the field is left blank', async t => {
  const { call, probes } = await setup(t)
  const { account } = await call('accounts:save', form())
  const res = await call('accounts:test', { ...form(), id: account.id, in_password: '' })
  assert.deepEqual([res.ok, res.incoming.ok, res.smtp.error], [true, true, 'auth_failed'])
  assert.deepEqual(probes[0].passwords, { incomingPassword: PW, smtpPassword: PW })
  // a typed (unsaved) password is tested as typed
  await call('accounts:test', { ...form(), id: account.id, in_password: 'Uj-gepelt-jelszo' })
  assert.equal(probes[1].passwords.incomingPassword, 'Uj-gepelt-jelszo')
  assert.equal(JSON.stringify(res).includes(PW), false)
})

test('changing the index limit starts the re-index right after the reply (well under 2 s)', async t => {
  const { call, events, index, db } = await setup(t)
  const { account } = await call('accounts:save', form())
  // one indexed 2-year-old message
  index.insertMany([{ account_id: account.id, folder: 'INBOX', uid: 1, message_id: '<m>', in_reply_to: null, refs: null, from_addr: 'a@x', from_name: null, to_addrs: '', cc_addrs: '', subject: 's', date: NOW - 730 * DAY, idate: NOW - 730 * DAY, flags: '', size: 1, has_attachments: 0, attachments: null, sender_text: 'a@x', recipients_text: '' }])
  const id = db.prepare('SELECT id FROM messages').get().id
  index.setBodies([{ id, text: 'napkollektor', state: 1, preview: 'napkollektor' }])

  const t0 = performance.now()
  const res = await call('accounts:save', { ...form({ index_years: 1 }), id: account.id, in_password: '' })
  assert.equal(res.ok, true)
  await new Promise(r => setTimeout(r, 50))
  assert.equal(events.length, 1)
  assert.deepEqual([events[0].kind, events[0].accountId, events[0].cleared, events[0].requeued], ['reindex', account.id, 1, 0])
  assert.ok(events[0].at - t0 < 2000, `${Math.round(events[0].at - t0)} ms`)
  assert.equal(index.search({ query: 'napkollektor' }).length, 0)

  // saving again without a limit change starts nothing
  await call('accounts:save', { ...form({ index_years: 1 }), id: account.id, in_password: '' })
  await new Promise(r => setTimeout(r, 50))
  assert.equal(events.length, 1)
})

test('delete; a locked vault and a foreign sender are refused', async t => {
  const { call, handlers, vault } = await setup(t)
  const { account } = await call('accounts:save', form())
  assert.deepEqual(await handlers.get('accounts:delete')({ trusted: false }, account.id), { ok: false, error: 'untrusted_sender' })
  vault.lock()
  assert.deepEqual(await call('accounts:save', form({ email: 'masik@example.invalid' })), { ok: false, error: 'locked' })
  assert.deepEqual(await call('accounts:delete', account.id), { ok: true })
  assert.deepEqual((await call('accounts:list')).accounts, [])
  assert.equal((await call('accounts:delete', 'x')).error, 'not_found')
})

test('connection test: the stored password goes ONLY to the server it was saved for', async t => {
  const { call, probes } = await setup(t)
  const { account } = await call('accounts:save', form())
  const blank = over => call('accounts:test', { ...form(), id: account.id, in_password: '', ...over })
  for (const over of [{ in_host: 'masik.example.invalid' }, { in_port: 143 }, { in_security: 'none', in_port: 143 }, { in_user: 'mas@example.invalid' }, { smtp_host: 'masik-smtp.example.invalid' }, { smtp_security: 'none', smtp_port: 587 }]) {
    const res = await blank(over)
    assert.deepEqual([res.ok, res.error, res.fields && res.fields.in_password], [false, 'invalid', 'required'], JSON.stringify(over))
  }
  assert.equal(probes.length, 0, 'nothing was sent to the changed server')
  // the same server: the stored one; a typed password: to the changed server as typed
  await blank({ name: 'Más név', index_years: 5 })
  assert.equal(probes[0].passwords.incomingPassword, PW)
  await call('accounts:test', { ...form(), id: account.id, in_host: 'masik.example.invalid', in_password: 'Begepelt-1' })
  assert.deepEqual(probes[1].passwords, { incomingPassword: 'Begepelt-1', smtpPassword: 'Begepelt-1' })
  // a separate SMTP password: the stored one only for the saved SMTP server
  const sep = (await call('accounts:save', form({ name: 'Külön', smtp_same_password: false, smtp_password: 'Smtp-Jelszo-1' }))).account
  const r1 = await call('accounts:test', { ...form({ smtp_same_password: false }), id: sep.id, in_password: '', smtp_password: '' })
  assert.equal(r1.ok, true)
  assert.deepEqual(probes.at(-1).passwords, { incomingPassword: PW, smtpPassword: 'Smtp-Jelszo-1' })
  const r2 = await call('accounts:test', { ...form({ smtp_same_password: false, smtp_host: 'mas-smtp.example.invalid' }), id: sep.id, in_password: '', smtp_password: '' })
  assert.deepEqual([r2.ok, r2.fields && r2.fields.smtp_password], [false, 'required'])
})

test('account form: CR/LF in the user name or the password is refused (bad_chars / bad_password)', async t => {
  const { call } = await setup(t)
  const res = await call('accounts:save', form({ in_user: 'a@example.invalid\r\nDELE 1', smtp_user: 'b\nX', in_password: 'jo\r\nrossz' }))
  assert.deepEqual([res.ok, res.fields.in_user, res.fields.smtp_user, res.fields.in_password], [false, 'bad_chars', 'bad_chars', 'bad_password'])
})
