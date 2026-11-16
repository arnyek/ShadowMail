// The vault and the encrypted database: the DEK in vault.json, the
// database opened with a key derived from it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import Database from 'better-sqlite3-multiple-ciphers'
import { tempDir, onCleanup } from './helpers/tmp.js'
import { addAccount } from './helpers/fixtures.js'
import { openDatabase, openMailDatabase } from '../core/db/index.js'
import { MIGRATIONS } from '../core/db/schema.js'
import { Vault, VaultError, MIN_PASSWORD_CHARS } from '../core/vault/vault.js'
import { vaultPath, dataFolderState, openUnlockedDatabase, createVaultedDatabase } from '../core/vault/vaulted-db.js'
import { DEFAULT_KDF_PARAMS } from '../core/vault/crypto.js'
import { hu } from '../app/renderer/i18n/hu.js'
import { registerVaultIpc } from '../app/main/ipc/vault.js'

// Cheap scrypt for most tests; one test runs the production parameters.
const FAST = { N: 2 ** 12, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
const MASTER = 'Mesterjelszó-teszt-2026'
const SECRET = 'Postafiok-jelszo!42'
const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'latin1')
const head16 = file => fs.readFileSync(file).subarray(0, 16)
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

/** A data folder with vault.json and the encrypted database; the vault unlocked, one account. */
async function setup(t, opts = {}) {
  const dir = tempDir(t)
  const { vault, db } = await createVaultedDatabase(dir, MASTER, { kdfParams: FAST, failDelayMs: 0, ...opts })
  const state = { db }
  // the app's lock: the database closes with it (main.js closeSession)
  vault.onLock(() => {
    if (state.db && state.db.open) state.db.close()
  })
  onCleanup(t, () => {
    if (state.db && state.db.open) state.db.close()
  })
  const account = addAccount(db)
  const reopen = () => {
    state.db = openUnlockedDatabase(vault, dir).db
    return state.db
  }
  return { dir, file: path.join(dir, 'mail.sqlite'), vault, account, state, reopen }
}

const rejectsWith = (promise, code) => assert.rejects(promise, err => err instanceof VaultError && err.code === code)

test('create -> lock -> unlock: vault.json, no vault table in mail.sqlite, the secret decrypts; a wrong password is "Hibás mesterjelszó"', async t => {
  const { dir, vault, account, state, reopen } = await setup(t)
  assert.ok(fs.existsSync(vaultPath(dir)))
  assert.deepEqual(vault.status(), { exists: true, unlocked: true, recoveryConfirmed: false, resetPending: false, vaultProblem: null })
  const tables = state.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name)
  assert.ok(!tables.includes('vault'), 'migration 3 dropped the old vault table')
  vault.setSecret(account.id, 'incoming', SECRET)
  vault.lock()
  assert.deepEqual(vault.status(), { exists: true, unlocked: false, recoveryConfirmed: null, resetPending: false, vaultProblem: null })
  assert.equal(state.db.open, false, 'the lock closed the database')
  assert.throws(() => vault.getSecret(account.id, 'incoming'), err => err.code === 'locked')
  assert.throws(() => vault.databaseKey(), err => err.code === 'locked')

  await rejectsWith(vault.unlock('rossz jelszó 12345'), 'wrong_password')
  assert.equal(hu.vaultErrors.wrong_password, 'Hibás mesterjelszó')
  assert.equal(vault.isUnlocked(), false)

  await vault.unlock(MASTER)
  reopen()
  assert.equal(vault.getSecret(account.id, 'incoming'), SECRET)
  assert.equal(vault.getSecret(account.id, 'smtp'), null)
})

test('the production scrypt parameters (N = 2^17) work end to end', async t => {
  const { vault, account, reopen } = await setup(t, { kdfParams: DEFAULT_KDF_PARAMS })
  const t0 = Date.now()
  vault.setSecret(account.id, 'smtp', SECRET)
  vault.lock()
  await vault.unlock(MASTER)
  reopen()
  assert.equal(vault.getSecret(account.id, 'smtp'), SECRET)
  t.diagnostic(`create + unlock with N=2^17: ${Date.now() - t0} ms`)
})

test('a wrong password waits the configured delay (plan: 1 s)', async t => {
  const { vault } = await setup(t, { failDelayMs: 1000 })
  vault.lock()
  // monotonic clock: the wall clock of a WSL VM may jump while the test runs
  const t0 = performance.now()
  await rejectsWith(vault.unlock('nem ez a jelszó'), 'wrong_password')
  const elapsed = performance.now() - t0
  assert.ok(elapsed >= 990, `${Math.round(elapsed)} ms`)
})

test('mail.sqlite is encrypted: not the SQLite header; without a key or with a wrong key it does not open', async t => {
  const { file, vault, state } = await setup(t)
  state.db.prepare("INSERT INTO contacts (address, name, use_count, last_used) VALUES ('ismert-cim@example.invalid', 'Ismert Név', 1, 0)").run()
  vault.lock()
  assert.ok(!head16(file).equals(SQLITE_HEADER), head16(file).toString('hex'))
  // without a key: the module is an ordinary SQLite reader here
  const plain = new Database(file)
  assert.throws(() => plain.prepare('SELECT count(*) FROM sqlite_master').get(), err => err.code === 'SQLITE_NOTADB')
  plain.close()
  assert.throws(() => openDatabase(file, crypto.randomBytes(32)), err => err.code === 'db_key')
  assert.equal(hu.vaultErrors.db_key, 'Az adatbázis nem nyitható ezzel a kulccsal.')
  for (const f of fs.readdirSync(path.dirname(file)).filter(n => n.startsWith('mail.sqlite'))) {
    assert.equal(fs.readFileSync(path.join(path.dirname(file), f)).includes(Buffer.from('ismert-cim@example.invalid')), false, f)
  }
})

test('the search tests pass on an encrypted database', () => {
  // NODE_TEST_CONTEXT out: inherited, it makes the child report to this run instead of printing
  const { NODE_TEST_CONTEXT, ...env } = process.env
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'test/search.test.js'], { env: { ...env, SHADOWMAIL_TEST_ENCRYPTED: '1' }, encoding: 'utf8', timeout: 120_000 })
  assert.equal(r.status, 0, r.stdout.split('\n').filter(l => /^not ok|^# (pass|fail)/.test(l)).join('\n'))
  assert.match(r.stdout, /^# fail 0$/m)
})

test('changing the master password: the old one no longer opens, the new one does; mail.sqlite unchanged byte for byte', async t => {
  const { dir, file, vault, account, state, reopen } = await setup(t)
  vault.setSecret(account.id, 'incoming', SECRET)
  state.db.pragma('wal_checkpoint(TRUNCATE)')
  const NEW = 'Uj-mesterjelszo-hosszu'
  await rejectsWith(vault.change('rossz-regi-jelszo', NEW), 'wrong_password')
  vault.lock()
  const before = { db: sha(file), vault: sha(vaultPath(dir)) }
  await vault.unlock(MASTER) // unlocked, but the database stays closed while the password changes
  await vault.change(MASTER, NEW)
  assert.equal(vault.isUnlocked(), true, 'an unlocked vault stays unlocked')
  assert.equal(sha(file), before.db, 'mail.sqlite did not change')
  assert.notEqual(sha(vaultPath(dir)), before.vault, 'vault.json did')
  vault.lock()
  await rejectsWith(vault.unlock(MASTER), 'wrong_password')
  await vault.unlock(NEW)
  reopen()
  assert.equal(vault.getSecret(account.id, 'incoming'), SECRET)
})

test('a migration backup (made before a test migration 4) is encrypted too', async t => {
  const { file, vault, state } = await setup(t)
  const key = vault.databaseKey()
  vault.lock()
  assert.equal(state.db.open, false)
  const next = { version: MIGRATIONS.length + 1, name: 'test column', up: db => db.exec('ALTER TABLE contacts ADD COLUMN note TEXT') }
  const { db, migration } = openMailDatabase(file, { key, migrations: [...MIGRATIONS, next] })
  db.close()
  assert.equal(migration.backup, `${file}.bak-${MIGRATIONS.length}`)
  assert.ok(!head16(migration.backup).equals(SQLITE_HEADER))
  const plain = new Database(migration.backup)
  assert.throws(() => plain.prepare('SELECT count(*) FROM sqlite_master').get(), err => err.code === 'SQLITE_NOTADB')
  plain.close()
  const withKey = openDatabase(migration.backup, key)
  assert.equal(withKey.prepare('SELECT version FROM schema_version').get().version, MIGRATIONS.length)
  withKey.close()
})

test('a failure while vault.json is written leaves the old file; the old password still opens', async t => {
  const dir = tempDir(t)
  let fail = false
  const vault = new Vault(vaultPath(dir), { kdfParams: FAST, failDelayMs: 0, hooks: { beforeRename: () => { if (fail) throw new Error('forced') } } })
  await vault.create(MASTER)
  const before = fs.readFileSync(vaultPath(dir))
  fail = true
  await assert.rejects(vault.change(MASTER, 'Uj-jelszo-ami-nem-marad'), /forced/)
  assert.deepEqual(fs.readFileSync(vaultPath(dir)), before)
  assert.deepEqual(fs.readdirSync(dir), ['vault.json'], 'no temporary file left')
  vault.lock()
  await vault.unlock(MASTER)
  assert.equal(vault.isUnlocked(), true)
})

test('a truncated or damaged vault.json: "A vault-fájl sérült", nothing is written', async t => {
  const dir = tempDir(t)
  const vault = new Vault(vaultPath(dir), { kdfParams: FAST, failDelayMs: 0 })
  await vault.create(MASTER)
  vault.lock()
  const good = fs.readFileSync(vaultPath(dir), 'utf8')
  const v = JSON.parse(good)
  const damaged = [
    good.slice(0, Math.floor(good.length / 2)),
    'nem json',
    JSON.stringify({ ...v, format: 'mas' }),
    JSON.stringify({ ...v, password: { ...v.password, salt: 'AAAA' } }),
    JSON.stringify({ ...v, password: { ...v.password, tag: undefined } }),
    JSON.stringify({ ...v, password: undefined }),
  ]
  for (const text of damaged) {
    fs.writeFileSync(vaultPath(dir), text)
    const mtime = fs.statSync(vaultPath(dir)).mtimeMs
    await rejectsWith(vault.unlock(MASTER), 'vault_corrupt')
    await rejectsWith(vault.change(MASTER, 'Uj-jelszo-hosszu-1'), 'vault_corrupt')
    assert.equal(fs.readFileSync(vaultPath(dir), 'utf8'), text)
    assert.equal(fs.statSync(vaultPath(dir)).mtimeMs, mtime)
    assert.deepEqual(fs.readdirSync(dir), ['vault.json'])
  }
  assert.equal(hu.vaultErrors.vault_corrupt, 'A vault-fájl sérült.')
})

test('an unencrypted mail.sqlite without vault.json (an earlier build): recognised, the folder is not touched', async t => {
  const dir = tempDir(t)
  const plain = new Database(path.join(dir, 'mail.sqlite'))
  plain.exec('CREATE TABLE t (a); INSERT INTO t VALUES (1)')
  plain.close()
  fs.mkdirSync(path.join(dir, 'store'))
  fs.writeFileSync(path.join(dir, 'store', 'level.eml'), 'Subject: x\r\n\r\ny')
  const snapshot = () =>
    fs.readdirSync(dir, { recursive: true }).sort().map(n => {
      const st = fs.statSync(path.join(dir, n))
      return [n, st.size, st.mtimeMs]
    })
  const before = snapshot()
  assert.equal(dataFolderState(dir), 'legacy_plain')
  assert.deepEqual(snapshot(), before)
  assert.match(hu.legacyDataFolder, /korábbi, titkosítatlan fejlesztői változatából/)
  // an encrypted database whose vault.json is gone; and an empty folder
  const other = tempDir(t)
  fs.writeFileSync(path.join(other, 'mail.sqlite'), crypto.randomBytes(4096))
  assert.equal(dataFolderState(other), 'no_vault')
  assert.equal(dataFolderState(tempDir(t)), 'new')
})

test('one flipped ciphertext byte, or the secret copied under another account, fails to decrypt (AAD)', async t => {
  const { vault, account, state } = await setup(t)
  const db = state.db
  const other = addAccount(db)
  vault.setSecret(account.id, 'incoming', SECRET)
  const row = db.prepare("SELECT * FROM account_secrets WHERE account_id = ? AND kind = 'incoming'").get(account.id)
  const flipped = Buffer.from(row.ciphertext)
  flipped[0] ^= 0x01
  db.prepare("UPDATE account_secrets SET ciphertext = ? WHERE account_id = ? AND kind = 'incoming'").run(flipped, account.id)
  assert.throws(() => vault.getSecret(account.id, 'incoming'), err => err.code === 'secret_corrupt')
  db.prepare("UPDATE account_secrets SET ciphertext = ? WHERE account_id = ? AND kind = 'incoming'").run(row.ciphertext, account.id)
  assert.equal(vault.getSecret(account.id, 'incoming'), SECRET)
  db.prepare("INSERT INTO account_secrets (account_id, kind, nonce, ciphertext, tag) VALUES (?, 'incoming', ?, ?, ?)").run(other.id, row.nonce, row.ciphertext, row.tag)
  assert.throws(() => vault.getSecret(other.id, 'incoming'), err => err.code === 'secret_corrupt')
  db.prepare("INSERT INTO account_secrets (account_id, kind, nonce, ciphertext, tag) VALUES (?, 'smtp', ?, ?, ?)").run(account.id, row.nonce, row.ciphertext, row.tag)
  assert.throws(() => vault.getSecret(account.id, 'smtp'), err => err.code === 'secret_corrupt')
})

test('the account password and the master password are in no file of the data folder', async t => {
  const { dir, vault, account, state } = await setup(t)
  vault.setSecret(account.id, 'incoming', SECRET)
  vault.setSecret(account.id, 'smtp', SECRET)
  const scan = () => {
    for (const n of fs.readdirSync(dir)) {
      const bytes = fs.readFileSync(path.join(dir, n))
      for (const needle of [SECRET, MASTER]) {
        assert.equal(bytes.includes(Buffer.from(needle, 'utf8')), false, `${needle} in ${n}`)
        assert.equal(bytes.includes(Buffer.from(needle, 'utf16le')), false, `${needle} (utf16) in ${n}`)
      }
    }
  }
  scan()
  state.db.pragma('wal_checkpoint(TRUNCATE)')
  scan()
})

test('the data folder copied elsewhere opens with the same master password (no machine binding)', async t => {
  const { dir, vault, account, state } = await setup(t)
  vault.setSecret(account.id, 'incoming', SECRET)
  state.db.pragma('wal_checkpoint(TRUNCATE)')
  vault.lock()
  const elsewhere = path.join(tempDir(t), 'masolat', 'data')
  fs.mkdirSync(elsewhere, { recursive: true })
  for (const n of ['mail.sqlite', 'vault.json']) fs.copyFileSync(path.join(dir, n), path.join(elsewhere, n))
  const vault2 = new Vault(vaultPath(elsewhere), { failDelayMs: 0 })
  assert.deepEqual(vault2.status(), { exists: true, unlocked: false, recoveryConfirmed: null, resetPending: false, vaultProblem: null })
  await vault2.unlock(MASTER)
  const { db } = openUnlockedDatabase(vault2, elsewhere)
  onCleanup(t, () => db.close())
  assert.equal(vault2.getSecret(account.id, 'incoming'), SECRET)
})

test('password rules: min 10 characters (code points, not bytes), Unicode forms match, one vault only', async t => {
  const vault = new Vault(vaultPath(tempDir(t)), { kdfParams: FAST, failDelayMs: 0 })
  await rejectsWith(Promise.resolve().then(() => vault.create('rovid')), 'password_too_short')
  await rejectsWith(Promise.resolve().then(() => vault.create(null)), 'bad_password')
  assert.equal([...'őőőőőőőőő'].length, MIN_PASSWORD_CHARS - 1)
  await rejectsWith(Promise.resolve().then(() => vault.create('őőőőőőőőő')), 'password_too_short') // 18 bytes, 9 characters
  // "ő" typed as one code point (NFC) and as o + combining double acute (NFD) is the same password
  const nfc = 'árvíztűrő tükörfúrógép'
  const nfd = nfc.normalize('NFD')
  assert.notEqual(nfc, nfd)
  await vault.create(nfc)
  vault.lock()
  await vault.unlock(nfd)
  assert.equal(vault.isUnlocked(), true)
  await rejectsWith(vault.create('masodik-vault-jelszo'), 'vault_exists')
})

test('lock() wipes the key and tells the listeners (the sync stops on it)', async t => {
  const { vault } = await setup(t)
  const calls = []
  const off = vault.onLock(() => calls.push('sync stopped'))
  vault.onLock(() => {
    throw new Error('a broken listener')
  })
  vault.lock()
  assert.deepEqual(calls, ['sync stopped'])
  assert.equal(vault.isUnlocked(), false)
  assert.equal(vault.db, null)
  off()
  await vault.unlock(MASTER)
  vault.lock()
  assert.deepEqual(calls, ['sync stopped'], 'unsubscribed')
})

test('concurrent unlocks are refused while one key derivation runs', async t => {
  const { vault } = await setup(t)
  vault.lock()
  const first = vault.unlock(MASTER)
  await rejectsWith(vault.unlock(MASTER), 'busy')
  await first
  assert.equal(vault.isUnlocked(), true)
})

test('tampered scrypt parameters in vault.json are refused instead of hanging or exhausting memory', async t => {
  const dir = tempDir(t)
  const vault = new Vault(vaultPath(dir), { kdfParams: FAST, failDelayMs: 0 })
  await vault.create(MASTER)
  vault.lock()
  const v = JSON.parse(fs.readFileSync(vaultPath(dir), 'utf8'))
  for (const bad of [{ N: 2 ** 30, r: 8, p: 1, maxmem: 268435456 }, { N: 131072, r: 8, p: 1, maxmem: 99999999999 }, { N: 100000, r: 8, p: 1, maxmem: 268435456 }, 'nem objektum']) {
    fs.writeFileSync(vaultPath(dir), JSON.stringify({ ...v, password: { ...v.password, kdfParams: bad } }))
    await rejectsWith(vault.unlock(MASTER), 'unsupported_kdf')
  }
})

test('a big sort writes no plain temporary file: temp_store = MEMORY', { skip: process.platform !== 'linux' && 'reads /proc/self/fd' }, async t => {
  const MARK = 'TEMPSPILLmarker'
  // the temporary files of this process holding the marker (SQLite names them etilqs_*, deleted but open),
  // looked at from INSIDE the sorting query (a peek() function on its rows), the reviewer's method
  const spillDuringSort = db => {
    let seen = 0
    let checked = false
    db.function('peek', v => {
      if (!checked) {
        checked = true
        for (const fd of fs.readdirSync('/proc/self/fd')) {
          try {
            const target = fs.readlinkSync(`/proc/self/fd/${fd}`)
            if (target.includes('etilqs') && fs.readFileSync(`/proc/self/fd/${fd}`).includes(Buffer.from(MARK))) seen++
          } catch {
            // closed meanwhile
          }
        }
      }
      return v
    })
    db.exec('CREATE TABLE big (s TEXT)')
    const ins = db.prepare('INSERT INTO big (s) VALUES (?)')
    db.transaction(() => {
      for (let i = 0; i < 40_000; i++) ins.run(`${MARK}-${crypto.randomBytes(24).toString('hex')}`)
    })()
    db.pragma('cache_size = 5') // the sort does not fit: it spills
    const n = db.prepare('SELECT count(peek(s)) AS n FROM (SELECT s FROM big ORDER BY s DESC)').get().n
    assert.equal(n, 40_000)
    return seen
  }
  // control: with SQLite's default temp_store the probe does see the plain spill
  const ctrl = openDatabase(path.join(tempDir(t), 'control.sqlite'), crypto.randomBytes(32))
  ctrl.pragma('temp_store = DEFAULT')
  const ctrlSeen = spillDuringSort(ctrl)
  ctrl.close()
  assert.ok(ctrlSeen > 0, 'the control sort spilled to a plain temporary file')
  // the app's settings
  const db = openDatabase(path.join(tempDir(t), 'mail.sqlite'), crypto.randomBytes(32))
  assert.equal(db.pragma('temp_store', { simple: true }), 2, 'MEMORY')
  assert.equal(spillDuringSort(db), 0)
  db.close()
})

test('vault.json without mail.sqlite: the unlock says db_missing and creates nothing; only vault:create starts a new one', async t => {
  const { dir, file, vault } = await setup(t)
  vault.lock()
  for (const n of fs.readdirSync(dir)) if (n.startsWith('mail.sqlite')) fs.rmSync(path.join(dir, n))
  await vault.unlock(MASTER)
  assert.throws(() => openUnlockedDatabase(vault, dir), err => err.code === 'db_missing')
  assert.equal(fs.existsSync(file), false, 'no empty database was made')
  assert.match(hu.vaultErrors.db_missing, /hiányzik/)
  // the IPC: the database open fails -> the vault locks again, the lock screen shows the code
  vault.lock()
  const handlers = new Map()
  registerVaultIpc({
    ipcMain: { handle: (c, fn) => handlers.set(c, fn) },
    vault,
    isTrustedSender: () => true,
    onUnlocked: ({ created }) => {
      try {
        openUnlockedDatabase(vault, dir, { create: created })
      } catch (err) {
        vault.lock()
        throw new VaultError(err.code)
      }
    },
  })
  assert.deepEqual(await handlers.get('vault:unlock')({}, MASTER), { ok: false, error: 'db_missing' })
  assert.equal(vault.isUnlocked(), false)
  assert.equal(fs.existsSync(file), false)
})

test('a plain mail.sqlite.bak-N of an earlier build, the database itself gone: refused like the plain database', async t => {
  const dir = tempDir(t)
  const plain = new Database(path.join(dir, 'mail.sqlite.bak-1'))
  plain.exec('CREATE TABLE t (a)')
  plain.close()
  assert.equal(dataFolderState(dir), 'legacy_plain')
  const other = tempDir(t)
  fs.writeFileSync(path.join(other, 'mail.sqlite.bak-2'), crypto.randomBytes(4096))
  assert.equal(dataFolderState(other), 'no_vault', 'an encrypted backup without vault.json')
})

test('scrypt parameters inside the bounds but over their own memory limit: unsupported_kdf, not an internal error', async t => {
  const dir = tempDir(t)
  const vault = new Vault(vaultPath(dir), { kdfParams: FAST, failDelayMs: 0 })
  await vault.create(MASTER)
  vault.lock()
  const v = JSON.parse(fs.readFileSync(vaultPath(dir), 'utf8'))
  fs.writeFileSync(vaultPath(dir), JSON.stringify({ ...v, password: { ...v.password, kdfParams: { N: 2 ** 20, r: 32, p: 4, maxmem: 1024 ** 3 } } }))
  await rejectsWith(vault.unlock(MASTER), 'unsupported_kdf')
})
