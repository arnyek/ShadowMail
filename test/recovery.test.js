// The recovery code in the vault.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { tempDir, onCleanup } from './helpers/tmp.js'
import { addAccount } from './helpers/fixtures.js'
import { Vault, VaultError } from '../core/vault/vault.js'
import { vaultPath, openUnlockedDatabase, openSealedStore } from '../core/vault/vaulted-db.js'
import { hu } from '../app/renderer/i18n/hu.js'

const FAST = { N: 2 ** 12, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
const MASTER = 'Mesterjelszo-helyreallitas-teszt'
const NEW = 'Uj-mesterjelszo-helyreallitas-teszt'
const SECRET = 'Fiok-jelszo-helyreallitas'
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
const rejectsWith = (p, code) => assert.rejects(p, err => err instanceof VaultError && err.code === code)

// a new vault with a known code: create() hands it out once
async function withCode(t, opts = {}) {
  const dir = tempDir(t)
  const vault = new Vault(vaultPath(dir), { kdfParams: FAST, failDelayMs: 0, ...opts })
  const { code } = await vault.create(MASTER)
  const { db } = openUnlockedDatabase(vault, dir, { create: true })
  const state = { db }
  vault.onLock(() => state.db && state.db.open && state.db.close())
  onCleanup(t, () => state.db && state.db.open && state.db.close())
  const account = addAccount(db)
  vault.setSecret(account.id, 'incoming', SECRET)
  openSealedStore(vault, dir).write(`${account.id}/level.eml`, Buffer.from('Subject: marad\r\n\r\nszoveg'))
  db.pragma('wal_checkpoint(TRUNCATE)')
  return { dir, vault, code, account, state, reopen: () => (state.db = openUnlockedDatabase(vault, dir).db) }
}

const snapshot = dir =>
  fs.readdirSync(dir, { recursive: true }).filter(n => n !== 'vault.json').sort().map(n => {
    const f = path.join(dir, n)
    return [n, fs.statSync(f).isFile() ? sha(f) : 'dir']
  })

test('create hands out a code; the code + a new password: the old password no longer opens, the new one does; mail.sqlite and store\\ unchanged; the used code is dead, the new one works', async t => {
  const { dir, vault, code, account, reopen } = await withCode(t)
  assert.equal(vault.status().recoveryConfirmed, false)
  vault.lock()
  const before = snapshot(dir)
  // typed loosely: lower case, spaces, O for 0 is all the same code
  const loose = code.toLowerCase().replace(/-/g, ' ')
  const { code: next } = await vault.recover(loose, NEW)
  assert.notEqual(next, code)
  assert.equal(vault.isUnlocked(), true)
  assert.deepEqual(snapshot(dir), before, 'mail.sqlite and store\\ byte for byte')
  reopen()
  assert.equal(vault.getSecret(account.id, 'incoming'), SECRET, 'nothing lost')
  vault.lock()
  await rejectsWith(vault.unlock(MASTER), 'wrong_password')
  await rejectsWith(vault.recover(code, 'Harmadik-jelszo-hosszu'), 'wrong_recovery_code')
  await vault.unlock(NEW)
  vault.lock()
  await vault.recover(next, 'Harmadik-jelszo-hosszu')
  assert.equal(vault.isUnlocked(), true)
})

test('a wrong code: "Hibás helyreállító kód" after 1 s, and nothing changes', async t => {
  const { dir, vault, code } = await withCode(t, { failDelayMs: 1000 })
  vault.lock()
  const before = [sha(vaultPath(dir)), ...snapshot(dir).map(x => x.join(':'))]
  const wrong = code.slice(0, -1) + (code.endsWith('0') ? '1' : '0')
  for (const attempt of [wrong, 'nem-kod']) {
    const t0 = performance.now()
    await rejectsWith(vault.recover(attempt, NEW), 'wrong_recovery_code')
    assert.ok(performance.now() - t0 >= 990, `${attempt}: ${Math.round(performance.now() - t0)} ms`)
  }
  assert.equal(hu.vaultErrors.wrong_recovery_code, 'Hibás helyreállító kód')
  assert.deepEqual([sha(vaultPath(dir)), ...snapshot(dir).map(x => x.join(':'))], before)
  await vault.unlock(MASTER)
  // and only from the lock screen
  await rejectsWith(vault.recover(code, NEW), 'unlocked')
})

test('"Új helyreállító kód" with the master password: the old code no longer opens, the new one does; a wrong master password makes none', async t => {
  const { dir, vault, code } = await withCode(t)
  const before = sha(vaultPath(dir))
  await rejectsWith(vault.newRecoveryCode('rossz-mesterjelszo-1'), 'wrong_password')
  assert.equal(sha(vaultPath(dir)), before, 'no new code')
  const { code: fresh } = await vault.newRecoveryCode(MASTER)
  assert.notEqual(fresh, code)
  vault.lock()
  await rejectsWith(vault.recover(code, NEW), 'wrong_recovery_code')
  await vault.recover(fresh, NEW)
  assert.equal(vault.isUnlocked(), true)
})

test('confirming the code clears the bar; a tampered "confirmed" or date is noticed (vault_corrupt)', async t => {
  const { dir, vault, code } = await withCode(t)
  assert.equal(vault.status().recoveryConfirmed, false)
  // checked in the main process against the code just handed out
  await rejectsWith(vault.confirmRecovery(2, code.split('-')[0] === code.split('-')[1] ? 'ZZZZZ' : code.split('-')[0]), 'wrong_group')
  await rejectsWith(vault.confirmRecovery(9, code.split('-')[0]), 'wrong_group')
  assert.equal(vault.isPendingCode(code), true)
  assert.equal(vault.isPendingCode('AAAAA-AAAAA-AAAAA-AAAAA-AAAAA'), false)
  await vault.confirmRecovery(3, code.split('-')[2].toLowerCase())
  await rejectsWith(vault.confirmRecovery(3, code.split('-')[2]), 'no_pending_code')
  assert.equal(vault.status().recoveryConfirmed, true)
  vault.lock()
  const good = fs.readFileSync(vaultPath(dir), 'utf8')
  const v = JSON.parse(good)
  for (const bad of [{ ...v, recovery: { ...v.recovery, confirmed: false } }, { ...v, created_at: v.created_at + 1 }, { ...v, changed_at: 0 }]) {
    fs.writeFileSync(vaultPath(dir), JSON.stringify(bad))
    await rejectsWith(vault.unlock(MASTER), 'vault_corrupt')
  }
  fs.writeFileSync(vaultPath(dir), good)
  await vault.unlock(MASTER)
})

test('the code is in no file of the data folder (grouped or normalized form)', async t => {
  const { dir, vault, code } = await withCode(t)
  await vault.confirmRecovery(1, code.split('-')[0])
  const forms = [code, code.replace(/-/g, '')].flatMap(c => [Buffer.from(c, 'utf8'), Buffer.from(c, 'utf16le')])
  for (const n of fs.readdirSync(dir, { recursive: true })) {
    const f = path.join(dir, n)
    if (!fs.statSync(f).isFile()) continue
    const b = fs.readFileSync(f)
    assert.ok(!forms.some(x => b.includes(x)), n)
  }
})

test('a rewrite does not carry a tampered field over: vault_corrupt', async t => {
  const { dir, vault, code } = await withCode(t)
  const v = JSON.parse(fs.readFileSync(vaultPath(dir), 'utf8'))
  fs.writeFileSync(vaultPath(dir), JSON.stringify({ ...v, recovery: { ...v.recovery, confirmed: true } }))
  await rejectsWith(vault.confirmRecovery(1, code.split('-')[0]), 'vault_corrupt')
  await rejectsWith(vault.newRecoveryCode(MASTER), 'vault_corrupt')
})

test('a vault.json copy from before the swap still opens today\'s data with the old code or the old password; the old code is dead only with the current vault.json', async t => {
  const { dir, vault, code, account, state, reopen } = await withCode(t)
  const file = vaultPath(dir)
  const beforeNewCode = fs.readFileSync(file)
  // swap 1: "Új helyreállító kód" with the master password
  const { code: second } = await vault.newRecoveryCode(MASTER)
  vault.lock()
  // swap 2: recovery with the code and a new password
  const beforeRecover = fs.readFileSync(file)
  const { code: third } = await vault.recover(second, NEW)
  reopen()
  // data written after both swaps
  const later = addAccount(state.db)
  vault.setSecret(later.id, 'incoming', 'Kesobbi-jelszo-helyreallitas')
  openSealedStore(vault, dir).write(`${later.id}/uj.eml`, Buffer.from('Subject: kesobb\r\n\r\nuj'))
  state.db.pragma('wal_checkpoint(TRUNCATE)')
  vault.lock()
  const current = fs.readFileSync(file)
  // with the current vault.json the replaced codes and the old password are dead
  await rejectsWith(vault.recover(code, 'Negyedik-jelszo-hosszu'), 'wrong_recovery_code')
  await rejectsWith(vault.recover(second, 'Negyedik-jelszo-hosszu'), 'wrong_recovery_code')
  await rejectsWith(vault.unlock(MASTER), 'wrong_password')
  assert.deepEqual(fs.readFileSync(file), current)

  const opensToday = () => {
    reopen()
    assert.equal(vault.getSecret(account.id, 'incoming'), SECRET)
    assert.equal(vault.getSecret(later.id, 'incoming'), 'Kesobbi-jelszo-helyreallitas', 'written after the swap')
    assert.equal(openSealedStore(vault, dir).read(`${later.id}/uj.eml`).toString(), 'Subject: kesobb\r\n\r\nuj')
    vault.lock()
  }
  for (const [label, copy, oldCode] of [['before "Új helyreállító kód"', beforeNewCode, code], ['before the recovery', beforeRecover, second]]) {
    fs.writeFileSync(file, copy)
    await vault.recover(oldCode, 'Otodik-jelszo-hosszu')
    assert.equal(vault.isUnlocked(), true, `${label}: the old code`)
    opensToday()
    fs.writeFileSync(file, copy)
    await vault.unlock(MASTER)
    opensToday()
  }
  // and the current vault.json still opens with today's password and code
  fs.writeFileSync(file, current)
  await vault.unlock(NEW)
  opensToday()
  await vault.recover(third, 'Hatodik-jelszo-hosszu')
  assert.equal(vault.isUnlocked(), true)
})
