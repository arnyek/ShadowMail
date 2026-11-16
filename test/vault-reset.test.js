// Forgotten master password WITHOUT the recovery code: a full reset of the data
// folder, safe against an interruption at every step (core/vault/reset.js).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { MailIndex } from '../core/db/mail-index.js'
import { Vault, VaultError } from '../core/vault/vault.js'
import { vaultPath, openUnlockedDatabase, openSealedStore } from '../core/vault/vaulted-db.js'
import { recoverInterruptedReset, settleReset } from '../core/vault/reset.js'
import { AccountStore } from '../core/accounts/model.js'
import { newAccountDefaults } from '../core/accounts/defaults.js'
import { registerVaultIpc, resetConfirmWord } from '../app/main/ipc/vault.js'
import { onCleanup, tempDir } from './helpers/tmp.js'

const FAST = { N: 2 ** 12, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
const OLD = 'regi-mester-jelszo-1'
const NEW = 'uj-mester-jelszo-12'
const rejectsWith = (p, code) => assert.rejects(p, err => err instanceof VaultError && err.code === code)

/** A data folder with 2 accounts, 20 messages, store\ files, a migration backup; the vault locked. */
async function setup(t, opts = {}) {
  const dir = tempDir(t)
  const vault = new Vault(vaultPath(dir), { kdfParams: FAST, failDelayMs: 0, ...opts })
  const { code } = await vault.create(OLD)
  const { db } = openUnlockedDatabase(vault, dir, { create: true })
  const store = new AccountStore(db, vault, { storeDir: path.join(dir, 'store') })
  const base = { ...newAccountDefaults('imap'), in_host: 'imap.example.invalid', in_port: 993, in_security: 'tls', smtp_host: 'smtp.example.invalid', smtp_port: 465, smtp_security: 'tls', smtp_same_password: false }
  const a = store.save({ ...base, name: 'Egy', email: 'egy@example.invalid', in_user: 'egy', in_password: 'titok-1', smtp_password: 'titok-2' }).account
  const b = store.save({ ...base, name: 'Kettő', email: 'ketto@example.invalid', in_user: 'ketto', in_password: 'titok-3', smtp_password: 'titok-4' }).account
  new MailIndex(db).insertMany(Array.from({ length: 20 }, (_, i) => ({
    account_id: i % 2 ? a.id : b.id, folder: 'INBOX', uid: i + 1, message_id: `<m${i}@x>`, in_reply_to: null, refs: null,
    from_addr: 'f@x.invalid', from_name: 'F', to_addrs: '', cc_addrs: '', subject: `Levél ${i}`, date: i, idate: i,
    flags: '', size: 1, has_attachments: 0, attachments: null, body_state: 0, sender_text: 'f', recipients_text: '',
  })))
  const sealed = openSealedStore(vault, dir)
  for (let i = 0; i < 3; i++) sealed.write(`${a.id}/m${i}.eml`, Buffer.from(`Subject: ${i}\r\n\r\nx`))
  db.prepare('VACUUM INTO ?').run(path.join(dir, 'mail.sqlite.bak-2'))
  db.pragma('wal_checkpoint(TRUNCATE)')
  db.close()
  vault.lock()
  return { dir, vault, code }
}

// opens the folder as the app does after a start: a fresh Vault, unlock, the database
async function openWith(dir, password) {
  const vault = new Vault(vaultPath(dir), { kdfParams: FAST, failDelayMs: 0 })
  await vault.unlock(password)
  const { db } = openUnlockedDatabase(vault, dir)
  const n = sql => db.prepare(sql).get().n
  const res = { accounts: n('SELECT count(*) AS n FROM accounts'), messages: n('SELECT count(*) AS n FROM messages') }
  db.close()
  vault.lock()
  return res
}

test('reset without a code: 0 accounts, 0 messages, store\\ empty, no *.bak-*, a new code; the old password and the old code do not open', async t => {
  const { dir, vault, code } = await setup(t)
  assert.deepEqual(await openWith(dir, OLD), { accounts: 2, messages: 20 })
  const { code: fresh } = await vault.reset(NEW)
  assert.equal(vault.isUnlocked(), true)
  assert.match(fresh, /^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){4}$/)
  assert.notEqual(fresh, code)
  vault.lock()
  assert.deepEqual(fs.readdirSync(dir).filter(n => n.startsWith('mail.sqlite.bak-') || n.startsWith('reset-trash-')), [])
  assert.ok(!fs.existsSync(path.join(dir, 'store')) || fs.readdirSync(path.join(dir, 'store'), { recursive: true }).length === 0, 'store\\ empty')
  assert.deepEqual(await openWith(dir, NEW), { accounts: 0, messages: 0 })
  const again = new Vault(vaultPath(dir), { kdfParams: FAST, failDelayMs: 0 })
  await rejectsWith(again.unlock(OLD), 'wrong_password')
  await rejectsWith(again.recover(code, 'Harmadik-jelszo-hosszu'), 'wrong_recovery_code')
  await again.recover(fresh, 'Harmadik-jelszo-hosszu')
})

test('refused: an open vault, a wrong or missing word, a short password; nothing changes', async t => {
  const { dir, vault } = await setup(t)
  const snapshot = () => fs.readdirSync(dir, { recursive: true }).sort().map(n => [n, fs.statSync(path.join(dir, n)).size, fs.statSync(path.join(dir, n)).mtimeMs])
  const before = snapshot()
  const handlers = new Map()
  registerVaultIpc({ ipcMain: { handle: (c, fn) => handlers.set(c, fn) }, vault, isTrustedSender: () => true })
  const call = (...a) => handlers.get('vault:reset')({}, ...a)
  assert.deepEqual(await call('torles', NEW), { ok: false, error: 'confirm_word' })
  assert.deepEqual(await call('', NEW), { ok: false, error: 'confirm_word' })
  assert.deepEqual(await call(resetConfirmWord(), 'rovid'), { ok: false, error: 'password_too_short' })
  await vault.unlock(OLD)
  assert.deepEqual(await call(resetConfirmWord(), NEW), { ok: false, error: 'unlocked' })
  vault.lock()
  assert.deepEqual(snapshot(), before)
  assert.deepEqual(await openWith(dir, OLD), { accounts: 2, messages: 20 })
})

test('an interruption after any step: at the next start either the old state with the old password or the new, empty one with the new password; no reset-trash-* left', async t => {
  for (const step of [1, 2, 3, 4]) {
    const { dir } = await setup(t)
    const cut = new Vault(vaultPath(dir), {
      kdfParams: FAST,
      failDelayMs: 0,
      resetHooks: { afterStep: n => { if (n === step) throw Object.assign(new Error(`cut after step ${n}`), { code: 'CUT' }) } },
    })
    await assert.rejects(cut.reset(NEW), /cut after step/)
    // the next start
    recoverInterruptedReset(dir)
    assert.deepEqual(fs.readdirSync(dir).filter(n => n.startsWith('reset-trash-')), [], `step ${step}: no trash`)
    if (step < 3) {
      assert.deepEqual(await openWith(dir, OLD), { accounts: 2, messages: 20 }, `step ${step}: the old state`)
      assert.ok(fs.existsSync(path.join(dir, 'mail.sqlite.bak-2')), `step ${step}: the backup is back too`)
    } else {
      assert.deepEqual(await openWith(dir, NEW), { accounts: 0, messages: 0 }, `step ${step}: the new state`)
      assert.ok(!fs.existsSync(path.join(dir, 'mail.sqlite.bak-2')), `step ${step}: the old backup is gone`)
    }
  }
})

// ---- interruptions, the switch marks, the settle before unlock ----

test('a reset cut in step 2, then the recovery code in the SAME process: the old data is there with the new password', async t => {
  const { dir, code } = await setup(t)
  const cut = new Vault(vaultPath(dir), {
    kdfParams: FAST,
    failDelayMs: 0,
    resetHooks: { afterStep: n => { if (n === 2) throw Object.assign(new Error('cut'), { code: 'CUT' }) } },
  })
  await assert.rejects(cut.reset(NEW), /cut/)
  assert.deepEqual(fs.readdirSync(dir).filter(n => n.startsWith('reset-trash-')), [], 'rolled back at once, in this process')
  await cut.recover(code, 'Kodos-uj-jelszo-12')
  cut.lock()
  recoverInterruptedReset(dir) // the next start
  assert.deepEqual(await openWith(dir, 'Kodos-uj-jelszo-12'), { accounts: 2, messages: 20 })
})

test('ENOSPC while the new vault.json is installed: rolled back at once; the old password still opens everything', async t => {
  const { dir, code } = await setup(t)
  let armed = false
  const v = new Vault(vaultPath(dir), {
    kdfParams: FAST,
    failDelayMs: 0,
    hooks: { beforeRename: () => { if (armed) throw Object.assign(new Error('no space'), { code: 'ENOSPC' }) } },
    resetHooks: { afterStep: n => { if (n === 2) armed = true } },
  })
  await assert.rejects(v.reset(NEW), err => err.code === 'ENOSPC')
  armed = false
  assert.deepEqual(fs.readdirSync(dir).filter(n => n.startsWith('reset-trash-')), [])
  assert.deepEqual(await openWith(dir, OLD), { accounts: 2, messages: 20 })
  await v.recover(code, 'Kodos-uj-jelszo-12')
  assert.equal(v.isUnlocked(), true)
})

test('a damaged switch mark while old data is in the trash: nothing is deleted, the vault refuses (reset_pending), state E', async t => {
  const { dir } = await setup(t)
  // a reset cut in step 2 whose in-process settle failed too (as after a power cut): the folder stays
  const cut = new Vault(vaultPath(dir), {
    kdfParams: FAST,
    failDelayMs: 0,
    resetHooks: { afterStep: n => { if (n === 2) throw Object.assign(new Error('power'), { code: 'CUT' }) } },
  })
  // keep the trash: make the in-process settle see an undecidable state by truncating the old mark first
  const origRename = fs.renameSync
  let trashDir = null
  fs.renameSync = (a, b) => {
    if (!trashDir && String(b).includes('reset-trash-')) {
      trashDir = path.dirname(path.dirname(b))
      fs.writeFileSync(path.join(trashDir, 'vault.json.old'), '')
    }
    return origRename(a, b)
  }
  try {
    await assert.rejects(cut.reset(NEW), /power/)
  } finally {
    fs.renameSync = origRename
  }
  const trash = fs.readdirSync(dir).filter(n => n.startsWith('reset-trash-'))
  assert.equal(trash.length, 1, 'kept: it holds the only copy of the old data')
  assert.ok(fs.readdirSync(path.join(dir, trash[0], 'old')).includes('mail.sqlite'))
  assert.equal(settleReset(dir), 1, 'still undecidable')
  const again = new Vault(vaultPath(dir), { kdfParams: FAST, failDelayMs: 0 })
  await assert.rejects(again.unlock(OLD), err => err.code === 'reset_pending')
  await assert.rejects(again.reset(NEW), err => err.code === 'reset_pending')
  assert.ok(fs.existsSync(path.join(dir, trash[0], 'old', 'mail.sqlite')), 'nothing deleted')
})

test('a reset folder left by a cut is settled before the next unlock in the same process', async t => {
  const { dir } = await setup(t)
  const cut = new Vault(vaultPath(dir), {
    kdfParams: FAST,
    failDelayMs: 0,
    resetHooks: { afterStep: n => { if (n === 3) throw Object.assign(new Error('cut'), { code: 'CUT' }) } },
  })
  await assert.rejects(cut.reset(NEW), /cut/)
  // the switch had happened: the new, empty state, and no folder left
  assert.deepEqual(fs.readdirSync(dir).filter(n => n.startsWith('reset-trash-')), [])
  await cut.unlock(NEW)
  cut.lock()
  assert.deepEqual(await openWith(dir, NEW), { accounts: 0, messages: 0 })
})

// the "E" state (a reset cut in step 2, the old mark damaged, the old data in the trash)
async function eState(t) {
  const made = await setup(t)
  const cut = new Vault(vaultPath(made.dir), {
    kdfParams: FAST,
    failDelayMs: 0,
    resetHooks: { afterStep: n => { if (n === 2) throw Object.assign(new Error('power'), { code: 'CUT' }) } },
  })
  const origRename = fs.renameSync
  let trashDir = null
  fs.renameSync = (a, b) => {
    if (!trashDir && String(b).includes('reset-trash-')) {
      trashDir = path.dirname(path.dirname(b))
      fs.writeFileSync(path.join(trashDir, 'vault.json.old'), '')
    }
    return origRename(a, b)
  }
  try {
    await assert.rejects(cut.reset(NEW), /power/)
  } finally {
    fs.renameSync = origRename
  }
  return made
}

const tree = dir =>
  fs.readdirSync(dir, { recursive: true }).sort().map(n => {
    const f = path.join(dir, n)
    return fs.statSync(f).isFile() ? `${n}:${fs.readFileSync(f).toString('base64').slice(-40)}:${fs.statSync(f).size}` : `${n}/`
  })

function ipcFor(vault) {
  const handlers = new Map()
  let opened = 0
  registerVaultIpc({ ipcMain: { handle: (c, fn) => handlers.set(c, fn) }, vault, isTrustedSender: () => true, onUnlocked: () => opened++ })
  return { call: (channel, ...a) => handlers.get(channel)({}, ...a), opened: () => opened }
}

test('"Újrakezdés befejezése" in the E state: the unlock says reset_pending; without TÖRLÉS or with a short password nothing changes; then 0 accounts, 0 messages, no reset-trash-*, the new password opens, the old one does not, a new code', async t => {
  const { dir, code } = await eState(t)
  const finisher = new Vault(vaultPath(dir), { kdfParams: FAST, failDelayMs: 0 })
  const ipc = ipcFor(finisher)
  assert.equal(finisher.status().resetPending, true, 'the lock screen offers the way out')
  assert.deepEqual(await ipc.call('vault:unlock', OLD), { ok: false, error: 'reset_pending' })
  const before = tree(dir)
  assert.deepEqual(await ipc.call('vault:finishReset', 'torles', 'Uj-befejezo-jelszo-1'), { ok: false, error: 'confirm_word' })
  assert.deepEqual(await ipc.call('vault:finishReset', resetConfirmWord(), 'rovid'), { ok: false, error: 'password_too_short' })
  assert.deepEqual(tree(dir), before, 'nothing changed')
  const res = await ipc.call('vault:finishReset', resetConfirmWord(), 'Uj-befejezo-jelszo-1')
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.match(res.recoveryCode, /^[0-9A-Z]{5}(-[0-9A-Z]{5}){4}$/)
  assert.notEqual(res.recoveryCode, code)
  assert.equal(res.status.unlocked, true)
  assert.equal(res.status.resetPending, false)
  assert.equal(ipc.opened(), 1)
  finisher.lock()
  assert.deepEqual(fs.readdirSync(dir).filter(n => n.startsWith('reset-trash-') || n.includes('.bak-') || n === 'store'), [])
  assert.deepEqual(await openWith(dir, 'Uj-befejezo-jelszo-1'), { accounts: 0, messages: 0 })
  const fresh = new Vault(vaultPath(dir), { kdfParams: FAST, failDelayMs: 0 })
  await rejectsWith(fresh.unlock(OLD), 'wrong_password')
  await rejectsWith(fresh.recover(code, 'Kodos-uj-jelszo-12'), 'wrong_recovery_code')
  await fresh.recover(res.recoveryCode, 'Kodos-uj-jelszo-12')
  assert.equal(fresh.isUnlocked(), true)
})

test('vault:finishReset when no reset is pending: not_available, and nothing changes (a plain folder, and one whose reset folder can be settled)', async t => {
  const { dir } = await setup(t)
  const vault = new Vault(vaultPath(dir), { kdfParams: FAST, failDelayMs: 0 })
  const ipc = ipcFor(vault)
  assert.equal(vault.status().resetPending, false)
  const before = tree(dir)
  assert.deepEqual(await ipc.call('vault:finishReset', resetConfirmWord(), 'Uj-befejezo-jelszo-1'), { ok: false, error: 'not_available' })
  assert.deepEqual(tree(dir), before)
  assert.equal(ipc.opened(), 0)
  assert.deepEqual(await openWith(dir, OLD), { accounts: 2, messages: 20 })
  // a cut in step 1 (nothing moved yet) is settled, not finished: the old data stays and the old password opens
  const cut = new Vault(vaultPath(dir), { kdfParams: FAST, failDelayMs: 0, resetHooks: { afterStep: n => { if (n === 1) throw new Error('cut1') } } })
  await assert.rejects(cut.reset(NEW), /cut1/)
  await rejectsWith(vault.finishReset('Uj-befejezo-jelszo-1'), 'not_available')
  assert.deepEqual(await openWith(dir, OLD), { accounts: 2, messages: 20 })
  // and only from the lock screen
  await vault.unlock(OLD)
  await rejectsWith(vault.finishReset('Uj-befejezo-jelszo-1'), 'unlocked')
})
