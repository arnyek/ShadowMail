// MCP: update_account and delete_account with the user's confirmation, on the
// real AccountStore and vault and the editor's own save / delete path (ipc/accounts.js saveAccount, deleteAccount).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { memoryIndex, addMessage, DAY } from './helpers/fixtures.js'
import { tempDir } from './helpers/tmp.js'
import { Vault } from '../core/vault/vault.js'
import { AccountStore, newAccountDefaults } from '../core/accounts/model.js'
import { saveAccount, deleteAccount } from '../app/main/ipc/accounts.js'
import { createMcpTools } from '../app/main/mcp/tools.js'
import { ConfirmationQueue } from '../app/main/mcp/confirm.js'
import { createDispatcher } from '../app/main/mcp/protocol.js'

const FAST = { N: 2 ** 12, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
const PW = 'Bejovo-Jelszo-MCP-77'
const NOW = Date.UTC(2026, 10, 13, 9)

async function setup(t) {
  const { db, index } = memoryIndex(t)
  const vault = new Vault(path.join(tempDir(t), 'vault.json'), { kdfParams: FAST, failDelayMs: 0 })
  await vault.create('Mesterjelszo-MCP-teszt')
  vault.attach(db)
  const store = new AccountStore(db, vault)
  const { account } = store.save({
    ...newAccountDefaults('imap'),
    name: 'Munka',
    email: 'munka@example.invalid',
    in_host: 'imap.example.invalid',
    in_user: 'munka@example.invalid',
    in_password: PW,
    smtp_host: 'smtp.example.invalid',
  })
  index.addFolder(account.id, 'INBOX', '.', false)
  for (let i = 0; i < 3; i++) addMessage(index, account.id, { folder: 'INBOX', uid: i + 1, subject: `Levél ${i}`, date: NOW - i * DAY })
  const saved = []
  const deleted = []
  const logs = []
  const requests = []
  const policy = { decide: null }
  const queue = new ConfirmationQueue({
    now: () => NOW,
    log: m => logs.push(m),
    onRequest: v => {
      requests.push(v)
      const d = policy.decide && policy.decide(v)
      if (d) setTimeout(() => (d === 'approve' ? queue.approve(v.id) : queue.reject(v.id)), 0)
    },
  })
  const manager = { status: () => [], syncNow: () => {} }
  const tools = createMcpTools({
    appVersion: '0.11.0', store, index, reader: null, manager, now: () => NOW, confirm: queue, confirmWaitMs: 5000,
    saveAccount: form => saveAccount(form, { store, index, log: m => logs.push(m), now: () => NOW, onSaved: id => saved.push(id) }),
    deleteAccount: id => deleteAccount(id, { store, log: m => logs.push(m), onDeleted: async x => deleted.push(x) }),
  })
  const dispatch = createDispatcher({ serverInfo: { name: 's', version: '1' }, tools, log: m => logs.push(m) })
  let n = 0
  const call = async (name, args = {}) => (await dispatch(JSON.stringify({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } }))).result
  return { db, index, vault, store, account, tools, call, queue, requests, policy, saved, deleted, logs }
}

test('update_account: the Modal shows old -> new; rejected -> unchanged; approved -> saved by the editor\'s path, the password kept', async t => {
  const s = await setup(t)
  const before = s.store.getRow(s.account.id)
  s.policy.decide = () => 'reject'
  const no = await s.call('update_account', { account_id: s.account.id, smtp_host: 'smtp.uj-szerver.invalid', smtp_port: 587, smtp_security: 'starttls' })
  assert.equal(no._meta['shadowmail/data'].error, 'rejected')
  assert.deepEqual(s.store.getRow(s.account.id), before, 'rejected: the account is unchanged')
  const v = s.requests[0].view
  assert.equal(v.kind, 'updateAccount')
  assert.deepEqual(v.changes, [
    { field: 'smtp_host', old: 'smtp.example.invalid', new: 'smtp.uj-szerver.invalid' },
    { field: 'smtp_port', old: 465, new: 587 },
    { field: 'smtp_security', old: 'tls', new: 'starttls' },
  ])
  assert.equal(v.loginChanged, true, 'the stored password would go to the new server: the Modal warns')
  assert.deepEqual(v.account, { name: 'Munka', email: 'munka@example.invalid', type: 'imap' })

  s.policy.decide = () => 'approve'
  const yes = await s.call('update_account', { account_id: s.account.id, smtp_host: 'smtp.uj-szerver.invalid', signature: 'Üdv,\nBence' })
  assert.equal(yes.isError, false, yes.content[0].text)
  assert.deepEqual(yes._meta['shadowmail/data'].fields, ['smtp_host', 'signature'])
  const after = s.store.getRow(s.account.id)
  assert.deepEqual([after.smtp_host, after.signature, after.in_host, after.smtp_port], ['smtp.uj-szerver.invalid', 'Üdv,\nBence', 'imap.example.invalid', 465])
  assert.equal(s.store.passwordsFor(s.account.id).incoming, PW, 'the stored password stays')
  assert.deepEqual(s.saved, [s.account.id], 'the sync restarts as after the editor\'s save')
  const out = JSON.stringify([no, yes]) + s.logs.join('\n')
  for (const word of ['smtp.uj-szerver.invalid', 'smtp.example.invalid', PW, 'Üdv']) assert.ok(!out.includes(word), word)
})

test('update_account: a password-like field -> error, no Modal; no change, a bad value, a POP3 field on IMAP -> error, no Modal', async t => {
  const s = await setup(t)
  for (const k of ['in_password', 'smtp_password', 'password', 'Passwd', 'api_key', 'token', 'secret', 'smtp_same_password']) {
    const r = await s.call('update_account', { account_id: s.account.id, [k]: 'x' })
    assert.equal(r._meta['shadowmail/data'].error, 'password_not_allowed', k)
  }
  assert.equal((await s.call('update_account', { account_id: s.account.id, smtp_host: 'smtp.example.invalid' }))._meta['shadowmail/data'].error, 'no_change')
  const bad = await s.call('update_account', { account_id: s.account.id, in_host: 'nem jo host' })
  assert.deepEqual([bad._meta['shadowmail/data'].error, bad._meta['shadowmail/data'].fields], ['invalid', { in_host: 'bad_host' }])
  assert.equal((await s.call('update_account', { account_id: s.account.id, pop3_delete_after_days: 1 }))._meta['shadowmail/data'].error, 'bad_arguments')
  assert.equal((await s.call('update_account', { account_id: s.account.id, type: 'pop3' }))._meta['shadowmail/data'].error, 'bad_arguments')
  assert.equal((await s.call('update_account', { account_id: s.account.id, index_years: 0 }))._meta['shadowmail/data'].error, 'bad_arguments')
  assert.equal((await s.call('update_account', { account_id: 99, name: 'x' }))._meta['shadowmail/data'].error, 'not_found')
  assert.equal(s.requests.length, 0)
})

test('update_account: the account saved by the user meanwhile -> account_changed, their change stays', async t => {
  const s = await setup(t)
  s.policy.decide = v => {
    const form = { ...s.store.list()[0], in_password: '', smtp_password: '', name: 'Bence átnevezte' }
    s.store.save(form)
    return 'approve'
  }
  const r = await s.call('update_account', { account_id: s.account.id, smtp_host: 'smtp.uj-szerver.invalid' })
  assert.equal(r._meta['shadowmail/data'].error, 'account_changed')
  const row = s.store.getRow(s.account.id)
  assert.deepEqual([row.name, row.smtp_host], ['Bence átnevezte', 'smtp.example.invalid'])
})

test('delete_account: the Modal shows name, address, message count; rejected -> unchanged; approved -> as the account list\'s Delete', async t => {
  const s = await setup(t)
  s.policy.decide = () => 'reject'
  assert.equal((await s.call('delete_account', { account_id: s.account.id }))._meta['shadowmail/data'].error, 'rejected')
  assert.ok(s.store.getRow(s.account.id))
  assert.deepEqual(s.requests[0].view, { kind: 'deleteAccount', account: { name: 'Munka', email: 'munka@example.invalid', type: 'imap' }, count: 3 })
  s.policy.decide = () => 'approve'
  const yes = await s.call('delete_account', { account_id: s.account.id })
  assert.equal(yes.isError, false, yes.content[0].text)
  assert.equal(s.store.getRow(s.account.id), undefined)
  assert.equal(s.vault.hasSecret(s.account.id, 'incoming'), false, 'the password went with it')
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 0)
  assert.deepEqual(s.deleted, [s.account.id], 'its sync stopped first')
  assert.equal((await s.call('delete_account', { account_id: s.account.id }))._meta['shadowmail/data'].error, 'not_found')
})
