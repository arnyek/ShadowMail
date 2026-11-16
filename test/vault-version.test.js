// A vault.json of another version is an honest error, not "damaged";
// nothing is converted and nothing is written. An older one can still start over (no code), a newer one
// is not touched at all.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { Vault, VaultError } from '../core/vault/vault.js'
import { VAULT_VERSION } from '../core/vault/vault-file.js'
import { vaultPath, openUnlockedDatabase, openSealedStore } from '../core/vault/vaulted-db.js'
import { registerVaultIpc, resetConfirmWord } from '../app/main/ipc/vault.js'
import { addAccount } from './helpers/fixtures.js'
import { tempDir } from './helpers/tmp.js'
import { hu } from '../app/renderer/i18n/hu.js'

const FAST = { N: 2 ** 12, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
const OLD = 'regi-mester-jelszo-1'
const NEW = 'uj-mester-jelszo-12'
const rejectsWith = (p, code) => assert.rejects(p, err => err instanceof VaultError && err.code === code)
const newVault = dir => new Vault(vaultPath(dir), { kdfParams: FAST, failDelayMs: 0 })

/** A data folder with an account, a store file, a locked vault; then vault.json's fields changed. */
async function folderWith(t, change) {
  const dir = tempDir(t)
  const vault = newVault(dir)
  const { code } = await vault.create(OLD)
  const { db } = openUnlockedDatabase(vault, dir, { create: true })
  addAccount(db)
  openSealedStore(vault, dir).write('1/level.eml', Buffer.from('Subject: x\r\n\r\ny'))
  db.pragma('wal_checkpoint(TRUNCATE)')
  db.close()
  vault.lock()
  const v = JSON.parse(fs.readFileSync(vaultPath(dir), 'utf8'))
  fs.writeFileSync(vaultPath(dir), JSON.stringify(change(v)))
  return { dir, code }
}

// list, size, mtime and content of every file and folder
const tree = dir =>
  fs.readdirSync(dir, { recursive: true }).sort().map(n => {
    const st = fs.statSync(path.join(dir, n))
    return st.isFile() ? `${n}|${st.size}|${st.mtimeMs}|${fs.readFileSync(path.join(dir, n)).toString('base64')}` : `${n}/|${st.mtimeMs}`
  })

function ipcFor(vault) {
  const handlers = new Map()
  registerVaultIpc({ ipcMain: { handle: (c, fn) => handlers.set(c, fn) }, vault, isTrustedSender: () => true })
  return (channel, ...a) => handlers.get(channel)({}, ...a)
}

test('a version 1 vault.json (an earlier development build): vault_old_version for the unlock and the recovery, the status says it, the data folder is unchanged (list, size, mtime)', async t => {
  assert.equal(VAULT_VERSION, 2)
  const { dir, code } = await folderWith(t, v => ({ ...v, version: 1 }))
  const before = tree(dir)
  const vault = newVault(dir)
  const call = ipcFor(vault)
  assert.equal(vault.status().vaultProblem, 'vault_old_version')
  assert.deepEqual(await call('vault:unlock', OLD), { ok: false, error: 'vault_old_version' })
  assert.deepEqual(await call('vault:recover', code, NEW), { ok: false, error: 'vault_old_version' })
  assert.deepEqual(tree(dir), before)
  assert.equal(hu.vaultError('vault_old_version'), 'Ez az adatmappa a ShadowMail egy korábbi fejlesztői változatából van, ez a változat nem nyitja meg. Kezdd újra (Elfelejtettem a mesterjelszót → Nincs kódom; minden helyi adat törlődik), vagy nevezd át vagy töröld a data mappát.')
})

test('the same version 1 folder: the reset without a code (TÖRLÉS + a new password) runs; then the new password opens an empty program', async t => {
  const { dir } = await folderWith(t, v => ({ ...v, version: 1 }))
  const vault = newVault(dir)
  const call = ipcFor(vault)
  const res = await call('vault:reset', resetConfirmWord(), NEW)
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.equal(res.status.vaultProblem, null)
  vault.lock()
  const again = newVault(dir)
  await again.unlock(NEW)
  const { db } = openUnlockedDatabase(again, dir)
  assert.equal(db.prepare('SELECT count(*) AS n FROM accounts').get().n, 0)
  db.close()
  again.lock()
  assert.ok(!fs.readdirSync(dir).some(n => n.startsWith('reset-trash-')))
})

test('version 3 (a newer program): vault_newer_version; the unlock, the recovery, the reset and the finish all refuse, and nothing is written (a reset folder is left alone too)', async t => {
  const { dir, code } = await folderWith(t, v => ({ ...v, version: 3 }))
  fs.mkdirSync(path.join(dir, 'reset-trash-1', 'old'), { recursive: true }) // a newer program's leftover: not ours to settle
  fs.writeFileSync(path.join(dir, 'reset-trash-1', 'old', 'x'), 'y')
  const before = tree(dir)
  const vault = newVault(dir)
  const call = ipcFor(vault)
  assert.equal(vault.status().vaultProblem, 'vault_newer_version')
  for (const [channel, args] of [['vault:unlock', [OLD]], ['vault:recover', [code, NEW]], ['vault:reset', [resetConfirmWord(), NEW]], ['vault:finishReset', [resetConfirmWord(), NEW]]])
    assert.deepEqual(await call(channel, ...args), { ok: false, error: 'vault_newer_version' }, channel)
  await rejectsWith(vault.reset(NEW), 'vault_newer_version')
  assert.deepEqual(tree(dir), before, 'nothing written')
  assert.equal(hu.vaultError('vault_newer_version'), 'Ezt az adatmappát egy újabb ShadowMail-változat készítette. Indítsd azt a változatot, vagy egy még újabbat; ez a régebbi változat nem nyitja meg, és nem is módosítja.')
})

test('every other mismatch stays vault_corrupt: version "2" (text), 2.5, no format, a foreign format', async t => {
  for (const change of [v => ({ ...v, version: '2' }), v => ({ ...v, version: 2.5 }), ({ format, ...v }) => v, v => ({ ...v, format: 'mas-program' }), v => ({ ...v, format: 'mas-program', version: 1 })]) {
    const { dir } = await folderWith(t, change)
    const vault = newVault(dir)
    assert.equal(vault.status().vaultProblem, null)
    await rejectsWith(vault.unlock(OLD), 'vault_corrupt')
  }
})
