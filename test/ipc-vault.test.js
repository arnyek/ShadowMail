// The vault IPC and the preload bridge: what the renderer can call and what comes back.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { memoryIndex, addAccount } from './helpers/fixtures.js'
import { tempDir } from './helpers/tmp.js'
import { Vault, VaultError } from '../core/vault/vault.js'
import { registerVaultIpc, VAULT_CHANNELS } from '../app/main/ipc/vault.js'

const FAST = { N: 2 ** 12, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
const MASTER = 'Mesterjelszó-teszt-2026'
const SECRET = 'Postafiok-jelszo!42'

function fakeIpc() {
  const handlers = new Map()
  return {
    handlers,
    handle: (channel, fn) => handlers.set(channel, fn),
    call: (channel, trusted = true, ...args) => handlers.get(channel)({ trusted }, ...args),
  }
}

function setup(t) {
  const { db } = memoryIndex(t)
  const vault = new Vault(path.join(tempDir(t), 'vault.json'), { kdfParams: FAST, failDelayMs: 0 })
  const ipc = fakeIpc()
  const logs = []
  // the app opens the database after create/unlock (main.js openSession); here the test database is attached
  registerVaultIpc({ ipcMain: ipc, vault, isTrustedSender: e => e.trusted, log: m => logs.push(m), onUnlocked: () => vault.attach(db) })
  return { db, vault, ipc, logs }
}

test('the vault channels answer only { exists, unlocked, recoveryConfirmed, resetPending, vaultProblem } (create: and the new recovery code once) or an error code', async t => {
  const { db, vault, ipc, logs } = setup(t)
  assert.deepEqual([...ipc.handlers.keys()].sort(), [...VAULT_CHANNELS].sort())

  const replies = []
  replies.push(await ipc.call('vault:status'))
  replies.push(await ipc.call('vault:create', true, MASTER))
  vault.setSecret(addAccount(db).id, 'incoming', SECRET)
  replies.push(await ipc.call('vault:lock'))
  replies.push(await ipc.call('vault:unlock', true, 'rossz-jelszo-12345'))
  replies.push(await ipc.call('vault:unlock', true, MASTER))
  replies.push(await ipc.call('vault:change', true, MASTER, 'Uj-mesterjelszo-hosszu'))

  // create hands the new recovery code to the code screen, once; no other reply carries it
  const code = replies[1].recoveryCode
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){4}$/)
  delete replies[1].recoveryCode
  assert.deepEqual(replies, [
    { ok: true, status: { exists: false, unlocked: false, recoveryConfirmed: null, resetPending: false, vaultProblem: null } },
    { ok: true, status: { exists: true, unlocked: true, recoveryConfirmed: false, resetPending: false, vaultProblem: null } },
    { ok: true, status: { exists: true, unlocked: false, recoveryConfirmed: null, resetPending: false, vaultProblem: null } },
    { ok: false, error: 'wrong_password' },
    { ok: true, status: { exists: true, unlocked: true, recoveryConfirmed: false, resetPending: false, vaultProblem: null } },
    { ok: true, status: { exists: true, unlocked: true, recoveryConfirmed: false, resetPending: false, vaultProblem: null } },
  ])
  assert.ok(!JSON.stringify(logs).includes(code.slice(0, 5)), 'the code is never logged')
  const everything = JSON.stringify(replies) + JSON.stringify(logs)
  for (const needle of [SECRET, MASTER, 'Uj-mesterjelszo-hosszu']) assert.equal(everything.includes(needle), false, needle)
})

test('a sender other than our own page is refused, and nothing changes', async t => {
  const { vault, ipc } = setup(t)
  assert.deepEqual(await ipc.call('vault:create', false, MASTER), { ok: false, error: 'untrusted_sender' })
  assert.equal(vault.exists(), false)
})

test('bad arguments from the renderer become error codes, not exceptions', async t => {
  const { ipc } = setup(t)
  assert.deepEqual(await ipc.call('vault:create', true, { toString: () => MASTER }), { ok: false, error: 'bad_password' })
  assert.deepEqual(await ipc.call('vault:create', true, 'rovid'), { ok: false, error: 'password_too_short' })
  assert.deepEqual(await ipc.call('vault:unlock', true, 'x'.repeat(5000)), { ok: false, error: 'bad_password' })
  assert.deepEqual(await ipc.call('vault:unlock', true, 'valami-jelszo-123'), { ok: false, error: 'no_vault' })
})

test('the preload bridge exposes exactly these calls, each mapped to one IPC channel', () => {
  const file = fileURLToPath(new URL('../app/preload/preload.cjs', import.meta.url))
  let exposed = null
  const invoked = []
  const listeners = []
  const synced = []
  const electron = {
    contextBridge: { exposeInMainWorld: (name, api) => (exposed = { name, api }) },
    ipcRenderer: {
      sendSync: channel => (synced.push(channel), 'en'),
      invoke: (channel, ...args) => invoked.push({ channel, args }),
      on: (channel, fn) => listeners.push({ channel, fn }),
      removeListener: (channel, fn) => listeners.splice(listeners.findIndex(l => l.fn === fn), 1),
    },
  }
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { require: m => (m === 'electron' ? electron : assert.fail(`require ${m}`)) })
  assert.equal(exposed.name, 'shadowMail')

  const list = []
  const walk = (obj, prefix) => {
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'function') list.push(prefix + k)
      else if (v && typeof v === 'object') walk(v, `${prefix}${k}.`)
    }
  }
  walk(exposed.api, '')
  assert.deepEqual(list.sort(), [
    'accounts.list', 'accounts.remove', 'accounts.reorder', 'accounts.save', 'accounts.signatureImage', 'accounts.signatureImagePick', 'accounts.signatureImageRemove', 'accounts.test',
    'compose.accounts', 'compose.addFiles', 'compose.checked', 'compose.close', 'compose.discard', 'compose.initial', 'compose.lockDone', 'compose.onCloseRequested', 'compose.onLockRequested', 'compose.open', 'compose.ready',
    'compose.removeAttachment', 'compose.saveDraft', 'compose.schedule', 'compose.send', 'compose.suggest', 'compose.suspect',
    'contacts.addFromMessage', 'contacts.count', 'contacts.delete', 'contacts.export', 'contacts.get', 'contacts.importApply', 'contacts.importPreview', 'contacts.list', 'contacts.lookup', 'contacts.save',
    'flushPrefs', 'folders.create', 'folders.deleteCount', 'folders.remove', 'folders.rename', 'folders.reorder', 'folders.resetOrder', 'folders.setRole', 'folders.setSubscribed', 'folders.subscriptions',
    'hello', 'mail.action', 'mail.allowImages', 'mail.folders', 'mail.ids', 'mail.list', 'mail.open', 'mail.openAttachment', 'mail.render', 'mail.saveAttachment', 'mail.saveSource', 'mail.source',
    'mail.status', 'mail.sync', 'mail.thread', 'mcp.confirm', 'mcp.confirmSettings', 'mcp.confirmations', 'mcp.connectInfo', 'mcp.copy', 'mcp.openAck', 'mcp.recent', 'mcp.setConfirm', 'mcp.setEnabled', 'mcp.status', 'onStatus', 'scheduled.cancel', 'scheduled.list', 'scheduled.reschedule', 'scheduled.sendNow', 'search.cancel', 'search.local', 'search.pop3Old', 'search.server', 'setLanguage', 'taskbar.setEnabled', 'taskbar.status', 'vault.change', 'vault.confirmRecovery', 'vault.copyRecoveryCode', 'vault.create', 'vault.finishReset', 'vault.lock', 'vault.lockNotice', 'vault.newRecoveryCode', 'vault.recover', 'vault.reset', 'vault.saveRecoveryCode', 'vault.status', 'vault.unlock',
  ])

  // the language: one synchronous ask at load, a plain value (not a call), only 'en' or 'hu'
  assert.deepEqual(synced, ['app:language'])
  assert.equal(exposed.api.language, 'en')
  for (const answer of ['xx', undefined, null, 'EN', { lang: 'en' }]) {
    let again = null
    const bridge = { ...electron, contextBridge: { exposeInMainWorld: (name, api) => (again = api) }, ipcRenderer: { ...electron.ipcRenderer, sendSync: () => answer } }
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), { require: m => (m === 'electron' ? bridge : assert.fail(`require ${m}`)) })
    assert.equal(again.language, 'hu', String(answer))
  }
  exposed.api.setLanguage('en')
  assert.deepEqual(invoked.pop(), { channel: 'app:setLanguage', args: ['en'] })

  exposed.api.flushPrefs()
  exposed.api.hello()
  exposed.api.vault.status()
  exposed.api.vault.create('a')
  exposed.api.vault.unlock('b')
  exposed.api.vault.lock()
  exposed.api.vault.change('c', 'd')
  exposed.api.vault.reset('TÖRLÉS', 'e')
  exposed.api.vault.lockNotice()
  exposed.api.vault.recover('k', 'f')
  exposed.api.vault.newRecoveryCode('g')
  exposed.api.vault.confirmRecovery()
  exposed.api.vault.saveRecoveryCode('k')
  exposed.api.vault.copyRecoveryCode('k')
  exposed.api.vault.finishReset('TÖRLÉS', 'h')
  exposed.api.accounts.list()
  exposed.api.accounts.save({})
  exposed.api.accounts.remove(1)
  exposed.api.accounts.reorder([2, 1])
  exposed.api.accounts.test({})
  exposed.api.accounts.signatureImagePick(1)
  exposed.api.accounts.signatureImageRemove(1)
  exposed.api.accounts.signatureImage(1)
  exposed.api.mail.folders()
  exposed.api.mail.list({ accountId: 1, folder: 'INBOX' })
  exposed.api.mail.status()
  exposed.api.mail.sync(1)
  exposed.api.mail.open(1)
  exposed.api.mail.thread(1)
  exposed.api.mail.allowImages(1)
  exposed.api.mail.render(1, '<p>x</p>')
  exposed.api.mail.saveAttachment(1, 0)
  exposed.api.mail.openAttachment(1, 0)
  exposed.api.mail.source(1)
  exposed.api.mail.saveSource(1)
  const sid = '00000000-0000-0000-0000-000000000000'
  exposed.api.compose.open()
  exposed.api.compose.initial(sid)
  exposed.api.compose.accounts()
  exposed.api.compose.suggest('ab')
  exposed.api.compose.addFiles(sid, null)
  exposed.api.compose.removeAttachment(sid, 'x')
  exposed.api.compose.saveDraft(sid, {})
  exposed.api.compose.send(sid, {})
  exposed.api.compose.schedule(sid, {}, 1)
  exposed.api.compose.discard(sid)
  exposed.api.compose.close(sid)
  exposed.api.compose.lockDone(sid, true)
  exposed.api.compose.ready(sid)
  exposed.api.compose.checked(sid)
  exposed.api.compose.suspect(sid)
  exposed.api.folders.create({ accountId: 1, name: 'x' })
  exposed.api.folders.rename({ accountId: 1, path: 'x', name: 'y' })
  exposed.api.folders.remove({ accountId: 1, path: 'y' })
  exposed.api.folders.deleteCount({ accountId: 1, path: 'y' })
  exposed.api.folders.reorder({ accountId: 1, parentKey: null, paths: ['y'] })
  exposed.api.folders.resetOrder({ accountId: 1 })
  exposed.api.folders.setRole({ accountId: 1, role: 'sent', path: null })
  exposed.api.folders.subscriptions({ accountId: 1 })
  exposed.api.folders.setSubscribed({ accountId: 1, path: 'Régi', subscribed: false })
  exposed.api.scheduled.list()
  exposed.api.scheduled.reschedule(1, 2)
  exposed.api.scheduled.sendNow(1)
  exposed.api.scheduled.cancel(1)
  exposed.api.mail.action({ ids: [1], action: 'read' })
  exposed.api.mail.ids({ accountId: 1, folder: 'INBOX' })
  exposed.api.search.local({ query: 'x' })
  exposed.api.search.server({ query: 'x' })
  exposed.api.search.pop3Old({ query: 'x' })
  exposed.api.search.cancel(1)
  exposed.api.mcp.status()
  exposed.api.mcp.setEnabled(true)
  exposed.api.mcp.confirm('id-1', false)
  exposed.api.mcp.confirmations()
  exposed.api.mcp.recent()
  exposed.api.mcp.connectInfo()
  exposed.api.mcp.copy('code')
  exposed.api.mcp.confirmSettings()
  exposed.api.mcp.setConfirm('send', true)
  exposed.api.contacts.list({ q: 'a' })
  exposed.api.contacts.get(1)
  exposed.api.contacts.save({})
  exposed.api.contacts.delete([1])
  exposed.api.contacts.addFromMessage(1)
  exposed.api.contacts.count()
  exposed.api.contacts.importPreview()
  exposed.api.contacts.importApply('t')
  exposed.api.contacts.export({ all: true, format: 'vcf' })
  exposed.api.contacts.lookup('a@example.invalid')
  assert.deepEqual(invoked.map(i => i.channel), [
    'app:flushPrefs', 'app:hello', 'vault:status', 'vault:create', 'vault:unlock', 'vault:lock', 'vault:change', 'vault:reset', 'vault:lockNotice',
    'vault:recover', 'vault:newRecoveryCode', 'vault:confirmRecovery', 'vault:saveRecoveryCode',
    'vault:copyRecoveryCode', 'vault:finishReset',
    'accounts:list', 'accounts:save', 'accounts:delete', 'accounts:reorder', 'accounts:test', 'accounts:signatureImagePick', 'accounts:signatureImageRemove', 'accounts:signatureImage',
    'mail:folders', 'mail:list', 'mail:status', 'mail:sync',
    'mail:open', 'mail:thread', 'mail:allowImages', 'mail:render', 'mail:saveAttachment', 'mail:openAttachment', 'mail:source', 'mail:saveSource',
    'compose:open', 'compose:initial', 'compose:accounts', 'compose:suggest', 'compose:addFiles', 'compose:removeAttachment',
    'compose:saveDraft', 'compose:send', 'compose:schedule', 'compose:discard', 'compose:close', 'compose:lockDone', 'compose:ready', 'compose:checked', 'compose:suspect',
    'folder:create', 'folder:rename', 'folder:delete', 'folder:deleteCount', 'folders:reorder', 'folders:resetOrder', 'folders:setRole', 'folders:subscriptions', 'folders:setSubscribed',
    'scheduled:list', 'scheduled:reschedule', 'scheduled:sendNow', 'scheduled:cancel',
    'mail:action', 'mail:ids',
    'search:local', 'search:server', 'search:pop3Old', 'search:cancel',
    'mcp:status', 'mcp:setEnabled', 'mcp:confirm', 'mcp:confirmations', 'mcp:recent', 'mcp:connectInfo', 'mcp:copy', 'mcp:confirmSettings', 'mcp:setConfirm',
    'contacts:list', 'contacts:get', 'contacts:save', 'contacts:delete', 'contacts:addFromMessage', 'contacts:count',
    'contacts:importPreview', 'contacts:importApply', 'contacts:export', 'contacts:lookup',
  ])
  assert.equal(JSON.stringify(invoked.find(i => i.channel === 'mcp:confirm').args), '[{"id":"id-1","approve":false}]', 'only the id and the yes / no')

  // onStatus passes only the payload (never the IPC event object) and can unsubscribe
  const seen = []
  const off = exposed.api.onStatus(payload => seen.push(payload))
  assert.equal(listeners[0].channel, 'app:status')
  listeners[0].fn({ sender: 'secret-event-object' }, { kind: 'reindex' })
  assert.deepEqual(seen, [{ kind: 'reindex' }])
  off()
  assert.equal(listeners.length, 0)
})

test('an awaited onUnlocked that fails with db_no_space gives the error with its info, on unlock and on the recovery-code path', async t => {
  const vault = new Vault(path.join(tempDir(t), 'vault.json'), { kdfParams: FAST, failDelayMs: 0 })
  const ipc = fakeIpc()
  const info = { needMb: 294, freeMb: 204 }
  let fail = false
  registerVaultIpc({
    ipcMain: ipc,
    vault,
    isTrustedSender: e => e.trusted,
    onUnlocked: async () => {
      await new Promise(r => setTimeout(r, 5)) // the app's upgrade is asynchronous: the handler must wait for it
      if (fail) {
        vault.lock()
        throw Object.assign(new VaultError('db_no_space'), { info })
      }
    },
  })
  const created = await ipc.call('vault:create', true, MASTER)
  assert.equal(created.ok, true)
  await ipc.call('vault:lock')
  fail = true
  const unlock = await ipc.call('vault:unlock', true, MASTER)
  assert.deepEqual({ ok: unlock.ok, error: unlock.error, info: unlock.info }, { ok: false, error: 'db_no_space', info })
  const recover = await ipc.call('vault:recover', true, created.recoveryCode, 'Uj-mesterjelszo-2026')
  assert.equal(recover.ok, false)
  assert.equal(recover.error, 'db_no_space')
  assert.deepEqual(recover.info, info)
  assert.equal(typeof recover.recoveryCode, 'string', 'the new code still goes to the page')
})
