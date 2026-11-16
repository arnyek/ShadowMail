import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tempDir, onCleanup } from './helpers/tmp.js'
import { MailIndex } from '../core/db/mail-index.js'
import { VaultError } from '../core/vault/vault.js'
import { createVaultedDatabase } from '../core/vault/vaulted-db.js'
import { AccountStore, AccountError, validateAccount, defaultPort, yearsToDays, daysToYears, newAccountDefaults } from '../core/accounts/model.js'
import { hu } from '../app/renderer/i18n/hu.js'

const FAST = { N: 2 ** 12, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
const PW_IN = 'Bejovo-Jelszo-Teszt-7'
const PW_SMTP = 'Kimeno-Jelszo-Teszt-8'

async function setup(t) {
  const dir = tempDir(t)
  const file = path.join(dir, 'mail.sqlite')
  // vault.json + the encrypted mail.sqlite, as the app writes them
  const { db, vault } = await createVaultedDatabase(dir, 'Mesterjelszo-teszthez-1', { kdfParams: FAST, failDelayMs: 0 })
  onCleanup(t, () => db.close())
  const storeDir = path.join(dir, 'store')
  return { dir, file, db, vault, store: new AccountStore(db, vault, { storeDir }), storeDir }
}

const form = (over = {}) => ({
  ...newAccountDefaults('imap'),
  name: 'Teszt fiók',
  email: 'teszt@example.invalid',
  in_host: 'imap.example.invalid',
  in_user: 'teszt@example.invalid',
  in_password: PW_IN,
  smtp_host: 'smtp.example.invalid',
  ...over,
})

test('new account defaults: 3 years for IMAP and POP3, ports by type and security', () => {
  const imap = newAccountDefaults('imap')
  const pop3 = newAccountDefaults('pop3')
  assert.equal(imap.index_years, 3)
  assert.equal(pop3.index_years, 3)
  assert.deepEqual([imap.in_port, imap.smtp_port, pop3.in_port], [993, 465, 995])
  assert.deepEqual(
    [defaultPort('imap', 'tls'), defaultPort('imap', 'starttls'), defaultPort('imap', 'none'), defaultPort('pop3', 'tls'), defaultPort('pop3', 'starttls'),
      defaultPort('smtp', 'tls'), defaultPort('smtp', 'starttls'), defaultPort('smtp', 'none')],
    [993, 143, 143, 995, 110, 465, 587, 587],
  )
})

test('"Indexelt levelek": 0, 51, 2.5 and empty are rejected with a Hungarian message; "mind" = 0, 5 years = 1825 days', () => {
  for (const bad of [0, 51, 2.5, '', null, undefined, '3', -1]) {
    const { errors } = validateAccount(form({ index_years: bad }))
    assert.equal(errors.index_years, 'bad_index_years', String(bad))
  }
  assert.match(hu.accountError('bad_index_years'), /1 és 50/)
  assert.equal(validateAccount(form({ index_years: 'all' })).values.body_index_days, 0)
  assert.equal(validateAccount(form({ index_years: 5 })).values.body_index_days, 1825)
  assert.equal(yearsToDays(3), 1095)
  assert.equal(daysToYears(1825), 5)
  assert.equal(daysToYears(0), 'all')
  assert.equal(daysToYears(1095), 3)
})

test('validation: required fields, ports, security, email; every error code has a Hungarian text', () => {
  const { errors } = validateAccount({ type: 'imap' })
  for (const f of ['name', 'email', 'in_host', 'in_port', 'in_security', 'in_user', 'smtp_host', 'smtp_port', 'smtp_security', 'in_password', 'index_years']) {
    assert.ok(errors[f], f)
  }
  assert.equal(validateAccount(form({ in_port: 70000 })).errors.in_port, 'bad_port')
  assert.equal(validateAccount(form({ in_port: '993' })).errors.in_port, 'bad_port')
  assert.equal(validateAccount(form({ smtp_security: 'ssl' })).errors.smtp_security, 'bad_security')
  assert.equal(validateAccount(form({ email: 'nem email' })).errors.email, 'bad_email')
  assert.equal(validateAccount(form({ in_host: 'van szokoz.hu' })).errors.in_host, 'bad_host')
  assert.equal(validateAccount(form({ smtp_same_password: false })).errors.smtp_password, 'required')
  assert.deepEqual(validateAccount(form()).errors, {})
  for (const code of ['required', 'too_long', 'bad_email', 'bad_type', 'type_locked', 'bad_host', 'bad_security', 'bad_port', 'bad_index_years', 'bad_interval', 'bad_days', 'bad_password']) {
    assert.notEqual(hu.accountError(code), hu.accountErrors.unknown, code)
  }
})

test('saving keeps the passwords only in the vault; the editor gets no password back', async t => {
  const { file, db, vault, store } = await setup(t)
  const { account } = store.save(form({ smtp_same_password: false, smtp_password: PW_SMTP }))
  assert.equal(account.has_incoming_password, true)
  assert.equal(account.has_smtp_password, true)
  assert.equal('in_password' in account || 'smtp_password' in account, false)
  assert.equal(JSON.stringify(store.list()).includes(PW_IN), false)
  assert.deepEqual(store.passwordsFor(account.id), { incoming: PW_IN, smtp: PW_SMTP })

  // edit without retyping: the stored password stays
  const { account: edited } = store.save({ ...form({ name: 'Átnevezett', smtp_same_password: false }), id: account.id, in_password: '', smtp_password: '' })
  assert.equal(edited.name, 'Átnevezett')
  assert.deepEqual(store.passwordsFor(account.id), { incoming: PW_IN, smtp: PW_SMTP })

  db.pragma('wal_checkpoint(TRUNCATE)')
  for (const f of [file, `${file}-wal`].filter(fs.existsSync)) {
    const bytes = fs.readFileSync(f)
    for (const pw of [PW_IN, PW_SMTP]) assert.equal(bytes.includes(Buffer.from(pw)), false, `${pw} in ${path.basename(f)}`)
  }
  assert.ok(vault.hasSecret(account.id, 'incoming'))
})

test('"SMTP-jelszó ugyanaz": no separate SMTP secret, the incoming password is used', async t => {
  const { store, vault } = await setup(t)
  const { account } = store.save(form({ smtp_same_password: false, smtp_password: PW_SMTP }))
  store.save({ ...form({ smtp_same_password: true }), id: account.id, in_password: '' })
  assert.equal(vault.hasSecret(account.id, 'smtp'), false)
  assert.deepEqual(store.passwordsFor(account.id), { incoming: PW_IN, smtp: PW_IN })
})

test('a locked vault refuses saving; the type of an existing account cannot change', async t => {
  const { store, vault } = await setup(t)
  const { account } = store.save(form())
  assert.throws(() => store.save({ ...form({ type: 'pop3', in_port: 995 }), id: account.id }), err => err instanceof AccountError && err.fields.type === 'type_locked')
  vault.lock()
  assert.throws(() => store.save(form({ email: 'masik@example.invalid' })), err => err instanceof VaultError && err.code === 'locked')
})

test('deleting an account leaves 0 rows in messages, folders, account_secrets and removes its store folder', async t => {
  const { db, store, storeDir } = await setup(t)
  const { account } = store.save(form({ smtp_same_password: false, smtp_password: PW_SMTP }))
  const { account: other } = store.save(form({ email: 'masik@example.invalid' }))
  const index = new MailIndex(db)
  for (const acc of [account, other]) {
    index.upsertFolder({ account_id: acc.id, path: 'INBOX', uidvalidity: '1' })
    index.insertMany([{ account_id: acc.id, folder: 'INBOX', uid: 1, message_id: '<x>', in_reply_to: null, refs: null, from_addr: 'a@x', from_name: null, to_addrs: '', cc_addrs: '', subject: 'törlendő', date: 1, idate: 1, flags: '', size: 1, has_attachments: 0, attachments: null, sender_text: 'a@x', recipients_text: '' }])
  }
  fs.mkdirSync(path.join(storeDir, String(account.id)), { recursive: true })
  fs.writeFileSync(path.join(storeDir, String(account.id), '1.eml'), 'x')

  store.remove(account.id)
  const count = table => db.prepare(`SELECT count(*) AS n FROM ${table} WHERE account_id = ?`).get(account.id).n
  assert.deepEqual([count('messages'), count('folders'), count('account_secrets')], [0, 0, 0])
  assert.equal(db.prepare("SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'torlendo'").get().n, 1, 'only the other account remains searchable')
  assert.equal(fs.existsSync(path.join(storeDir, String(account.id))), false)
  assert.equal(store.list().length, 1)
})

test('limitChanged reports a changed index limit (the IPC then runs applyBodyLimit)', async t => {
  const { store } = await setup(t)
  const { account, limitChanged } = store.save(form())
  assert.equal(limitChanged, false)
  assert.equal(store.save({ ...form({ index_years: 3 }), id: account.id, in_password: '' }).limitChanged, false)
  const res = store.save({ ...form({ index_years: 1 }), id: account.id, in_password: '' })
  assert.equal(res.limitChanged, true)
  assert.equal(res.account.index_years, 1)
  assert.equal(res.account.body_index_days, 365)
})
