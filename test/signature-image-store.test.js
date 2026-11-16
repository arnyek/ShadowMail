// The signature image in the database: the migration that adds it (a 0.12.0 database keeps every row and value, and
// the 0.12.0 code still reads the new one), the store's methods, and that an account row never carries the bytes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { openMailDatabase } from '../core/db/index.js'
import { migrate, currentVersion } from '../core/db/migrate.js'
import { MIGRATIONS } from '../core/db/schema.js'
import { AccountStore, AccountError } from '../core/accounts/model.js'
import { SIGNATURE_LIMITS } from '../core/accounts/signature-image.js'
import { addAccount } from './helpers/fixtures.js'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const vault = { hasSecret: () => false }
const IMAGE_MIGRATION = MIGRATIONS.findIndex(m => m.name === 'accounts: a signature image per account')
const OLD_COLUMNS = 'id, name, email, display_name, type, in_host, in_port, in_security, in_user, smtp_host, smtp_port, smtp_security, smtp_user, smtp_same_password, tls_verify, body_index_days, sync_interval_min, save_sent_to_server, pop3_delete_after_days, signature, sort_order, created_at'

function databaseBefore(t) {
  const { db } = openMailDatabase(':memory:', { migrations: MIGRATIONS.slice(0, IMAGE_MIGRATION) })
  t.after(() => db.close())
  addAccount(db, { name: 'Régi fiók', signature: 'Üdv,\nKovács Anna\nPélda Kft.', smtp_host: 'smtp.example.invalid', smtp_port: 465, smtp_security: 'tls' })
  addAccount(db, { name: 'Másik', type: 'pop3', in_port: 995, signature: null })
  return db
}

test('the migration: two NULL columns; every account and every old value unchanged', t => {
  assert.ok(IMAGE_MIGRATION > 0, 'the migration is on the list')
  const db = databaseBefore(t)
  const before = db.prepare(`SELECT ${OLD_COLUMNS} FROM accounts ORDER BY id`).all()
  migrate(db, MIGRATIONS)
  assert.equal(currentVersion(db), MIGRATIONS.length)
  assert.deepEqual(db.prepare(`SELECT ${OLD_COLUMNS} FROM accounts ORDER BY id`).all(), before)
  assert.deepEqual(db.prepare('SELECT signature_image, signature_image_type FROM accounts').all(), [
    { signature_image: null, signature_image_type: null },
    { signature_image: null, signature_image_type: null },
  ])
})

// the commit that brought the image column, from the git history; null without git (an exported tree, the Windows build)
function imageCommit() {
  try {
    const hits = execFileSync('git', ['-C', repo, 'log', '--format=%H', '-S', 'accounts: a signature image per account', '--', 'core/db/schema.js'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').filter(Boolean)
    return hits.length ? hits.at(-1) : 'missing'
  } catch {
    return null
  }
}

test('the code before the image column reads the new database (its own store, from git, with an image stored)', async t => {
  const commit = imageCommit()
  if (commit === null) return t.skip('no git history here')
  assert.notEqual(commit, 'missing', 'the migration is committed (this test reads the code before it)')
  const db = databaseBefore(t)
  migrate(db, MIGRATIONS)
  const store = new AccountStore(db, vault)
  store.setSignatureImage(store.list()[0].id, { type: 'image/png', bytes: Buffer.from('png-bytes') })
  // that commit's parent's core, outside the repo, with the repo's node_modules beside it
  const old = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-old-core-'))
  t.after(() => fs.rmSync(old, { recursive: true, force: true }))
  execFileSync('tar', ['-x', '-C', old], { input: execFileSync('git', ['-C', repo, 'archive', `${commit}^`, 'core']) })
  fs.symlinkSync(path.join(repo, 'node_modules'), path.join(old, 'node_modules'))
  assert.ok(!fs.readFileSync(path.join(old, 'core', 'db', 'schema.js'), 'utf8').includes('signature_image'), 'the old code has no image column')
  const { AccountStore: OldStore } = await import(pathToFileURL(path.join(old, 'core', 'accounts', 'model.js')).href)
  const rows = new OldStore(db, vault).list()
  assert.deepEqual(rows.map(r => [r.name, r.signature]), [['Régi fiók', 'Üdv,\nKovács Anna\nPélda Kft.'], ['Másik', null]])
})

test('the store: set, read back byte for byte, a row without the bytes but with has_signature_image, remove', t => {
  const { db } = openMailDatabase(':memory:')
  t.after(() => db.close())
  const store = new AccountStore(db, vault)
  const { id } = addAccount(db, { signature: 'Szia' })
  const other = addAccount(db).id
  assert.equal(store.signatureImage(id), null)
  assert.equal(store.get(id).has_signature_image, 0)
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
  store.setSignatureImage(id, { type: 'image/png', bytes })
  const back = store.signatureImage(id)
  assert.equal(back.type, 'image/png')
  assert.ok(back.bytes.equals(bytes))
  for (const row of [store.get(id), store.getRow(id), store.list().find(a => a.id === id)]) {
    assert.equal(row.has_signature_image, 1)
    assert.equal(row.signature_image_type, 'image/png')
    assert.ok(!('signature_image' in row), 'no bytes in an account row')
    assert.ok(!JSON.stringify(row).includes('"type":"Buffer"'))
  }
  assert.equal(store.get(other).has_signature_image, 0, 'only that account')
  store.removeSignatureImage(id)
  assert.equal(store.signatureImage(id), null)
  assert.equal(store.get(id).has_signature_image, 0)
  assert.equal(store.get(id).signature, 'Szia', 'the text signature stays')
})

test('the store refuses what prepareSignatureImage would not give, and an unknown account', t => {
  const { db } = openMailDatabase(':memory:')
  t.after(() => db.close())
  const store = new AccountStore(db, vault)
  const { id } = addAccount(db)
  const code = fn => {
    try {
      fn()
      return 'ok'
    } catch (err) {
      assert.ok(err instanceof AccountError)
      return err.code
    }
  }
  assert.equal(code(() => store.setSignatureImage(id, { type: 'image/gif', bytes: Buffer.from('x') })), 'invalid')
  assert.equal(code(() => store.setSignatureImage(id, { type: 'image/png', bytes: Buffer.alloc(0) })), 'invalid')
  assert.equal(code(() => store.setSignatureImage(id, { type: 'image/png', bytes: 'not a buffer' })), 'invalid')
  assert.equal(code(() => store.setSignatureImage(id, { type: 'image/png', bytes: Buffer.alloc(SIGNATURE_LIMITS.maxBytes + 1) })), 'invalid')
  assert.equal(code(() => store.setSignatureImage(id, { type: 'image/jpeg', bytes: Buffer.alloc(SIGNATURE_LIMITS.maxBytes) })), 'ok')
  assert.equal(code(() => store.setSignatureImage(id + 99, { type: 'image/png', bytes: Buffer.from('x') })), 'not_found')
  assert.equal(code(() => store.removeSignatureImage(id + 99)), 'not_found')
})
