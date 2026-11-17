// The schema upgrade on unlock (core/db/upgrade.js): only when needed, free space checked first, the
// backup + migrations in a worker thread (the main thread keeps running), and a kill during the backup or during a
// migration leaves a database that opens, checks ok and upgrades on the next run.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tempDir } from './helpers/tmp.js'
import { openDatabase, openMailDatabase } from '../core/db/index.js'
import { currentVersion, backupPath, migrate } from '../core/db/migrate.js'
import { MIGRATIONS } from '../core/db/schema.js'
import { pendingUpgrade, upgradeSpace, upgradeDatabase, UpgradeError } from '../core/db/upgrade.js'

const CHILD = fileURLToPath(new URL('./helpers/upgrade-child.mjs', import.meta.url))
const OLD = MIGRATIONS.length - 1 // the schema one release back (0.10.1: 3)
const MB = 1024 * 1024

/** An encrypted database at schema OLD with `mb` MB of filler rows and a few messages. */
function oldDatabase(dir, mb) {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'mail.sqlite')
  const key = crypto.randomBytes(32)
  const { db } = openMailDatabase(file, { key, migrations: MIGRATIONS.slice(0, OLD) })
  db.exec('CREATE TABLE filler (n INTEGER, b BLOB)')
  const ins = db.prepare('INSERT INTO filler (n, b) VALUES (?, randomblob(?))')
  db.transaction(() => {
    for (let i = 0; i < mb * 16; i++) ins.run(i, 64 * 1024)
  })()
  db.close()
  return { file, key }
}

/** integrity_check, schema version and row counts of an encrypted database file. */
function inspect(file, key) {
  const db = openDatabase(file, key)
  try {
    return {
      integrity: db.prepare('PRAGMA integrity_check').get().integrity_check,
      version: currentVersion(db),
      filler: db.prepare('SELECT count(*) AS n FROM filler').get().n,
      messages: db.prepare('SELECT count(*) AS n FROM messages').get().n,
    }
  } finally {
    db.close()
  }
}

/** Starts the child, kills it (SIGKILL) as soon as `when()` is true; resolves with how it ended. */
function killWhen(args, when) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', d => (out += d))
    child.stderr.on('data', d => (out += d))
    const timer = setInterval(() => {
      if (when()) {
        clearInterval(timer)
        child.kill('SIGKILL')
      }
    }, 2)
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      clearInterval(timer)
      resolve({ code, signal, out })
    })
  })
}

test('pendingUpgrade: null for a missing, a new and an up-to-date database; { from, to } for an older one', t => {
  const dir = tempDir(t)
  const key = crypto.randomBytes(32)
  assert.equal(pendingUpgrade(path.join(dir, 'none.sqlite'), key), null)
  const fresh = path.join(dir, 'fresh.sqlite')
  openMailDatabase(fresh, { key }).db.close()
  assert.equal(pendingUpgrade(fresh, key), null)
  const old = oldDatabase(dir, 1)
  assert.deepEqual(pendingUpgrade(old.file, old.key), { from: OLD, to: MIGRATIONS.length })
  assert.throws(() => pendingUpgrade(old.file, crypto.randomBytes(32)), err => err.code === 'db_key')
})

test('too little free space: db_no_space with the sizes, nothing written, schema and data unchanged, no notice', async t => {
  const { file, key } = oldDatabase(tempDir(t), 4)
  const before = inspect(file, key)
  const size = fs.statSync(file).size
  let started = false
  await assert.rejects(
    upgradeDatabase({ file, key, statfs: () => ({ bavail: 10, bsize: 4096 }), onStart: () => (started = true) }),
    err => err instanceof UpgradeError && err.code === 'db_no_space' && err.info.needMb === Math.ceil(size / MB) && err.info.freeMb === 0,
  )
  assert.equal(started, false)
  assert.deepEqual(inspect(file, key), before)
  assert.equal(before.version, OLD)
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter(n => n.includes('.bak-')), [])
  // exactly enough: goes through
  const s = upgradeSpace(file, () => ({ bavail: size, bsize: 1 }))
  assert.equal(s.ok, true)
})

test('the upgrade runs in a worker: the main thread keeps ticking (an in-thread run, the control, does not)', async t => {
  const dir = tempDir(t)
  const a = oldDatabase(dir, 24)
  const before = inspect(a.file, a.key)
  // the event loop's longest gap while the upgrade runs
  const gaps = async run => {
    let last = performance.now()
    let max = 0
    const timer = setInterval(() => {
      const now = performance.now()
      max = Math.max(max, now - last)
      last = now
    }, 5)
    const t0 = performance.now()
    const result = await run()
    const ms = performance.now() - t0
    clearInterval(timer)
    max = Math.max(max, performance.now() - last) // a run that never let the timer in shows here
    return { max, ms, result }
  }
  let notice = null
  const w = await gaps(() => upgradeDatabase({ file: a.file, key: a.key, onStart: p => (notice = p) }))
  assert.deepEqual(notice, { from: OLD, to: MIGRATIONS.length })
  assert.deepEqual(w.result, { from: OLD, to: MIGRATIONS.length, backup: backupPath(a.file, OLD) })
  const after = inspect(a.file, a.key)
  assert.equal(after.version, MIGRATIONS.length)
  assert.equal(after.integrity, 'ok')
  assert.equal(after.filler, before.filler)
  const bak = inspect(backupPath(a.file, OLD), a.key)
  assert.deepEqual(bak, before)
  assert.equal(fs.existsSync(`${backupPath(a.file, OLD)}.tmp`), false)
  // nothing to do the second time
  assert.equal(await upgradeDatabase({ file: a.file, key: a.key, onStart: () => assert.fail('no notice') }), null)

  // control: the same work on the main thread blocks it (the measurement sees a freeze)
  const b = oldDatabase(path.join(dir, 'b'), 24)
  const m = await gaps(async () => openMailDatabase(b.file, { key: b.key }).db.close())
  // the gap is wall-clock: on a loaded machine (`npm test` runs its files in parallel) one run can stretch past 100 ms;
  // an upgrade on the main thread blocks EVERY run, so the best of up to 3 runs (each on a fresh old database) decides
  const fine = r => r.max < 100 && r.max < r.ms / 3
  let best = w
  for (let i = 2; i <= 3 && !fine(best); i++) {
    const again = oldDatabase(path.join(dir, `a${i}`), 24)
    const r = await gaps(() => upgradeDatabase({ file: again.file, key: again.key }))
    if (r.max < best.max) best = r
  }
  console.log(`worker: ${Math.round(best.ms)} ms, longest main-thread gap ${Math.round(best.max)} ms; in-thread control: ${Math.round(m.ms)} ms, gap ${Math.round(m.max)} ms`)
  assert.ok(m.max > 0.8 * m.ms, 'the control blocks')
  assert.ok(fine(best), `worker gap ${best.max} ms of ${best.ms} ms`)
})

test('killed during the backup copy: the database opens and checks ok at the old schema, no .bak-N; the next run upgrades', async t => {
  const dir = tempDir(t)
  const { file, key } = oldDatabase(dir, 48)
  const before = inspect(file, key)
  const tmp = `${backupPath(file, OLD)}.tmp`
  const run = await killWhen([file, key.toString('hex'), 'backup'], () => fs.existsSync(tmp) && fs.statSync(tmp).size > 0)
  assert.equal(run.signal, 'SIGKILL', `the child was still copying when killed: ${run.out}`)
  assert.ok(fs.existsSync(tmp), 'a partial copy was being written')
  // a stale journal of the copy, as a kill on Windows left it (bca-win-smoke); the next run leaves no .tmp* file (measured:
  // SQLite's own VACUUM INTO also removes it, migrate() removes it explicitly as well)
  fs.writeFileSync(`${tmp}-journal`, crypto.randomBytes(4096))
  assert.equal(fs.existsSync(backupPath(file, OLD)), false, 'no half .bak-N')
  assert.deepEqual(inspect(file, key), before)
  const done = await upgradeDatabase({ file, key })
  assert.equal(done.to, MIGRATIONS.length)
  assert.deepEqual(fs.readdirSync(dir).filter(n => n.includes('.tmp')), [], 'the leftover .tmp (and its journal) is gone')
  const after = inspect(file, key)
  assert.equal(after.integrity, 'ok')
  assert.equal(after.filler, before.filler)
  assert.deepEqual(inspect(backupPath(file, OLD), key), before)
})

test('killed inside a migration: the earlier migrations stay, the half one is rolled back, it checks ok and the next run finishes', async t => {
  const dir = tempDir(t)
  const { file, key } = oldDatabase(dir, 2)
  const before = inspect(file, key)
  const mark = path.join(dir, 'slow-started')
  const run = await killWhen([file, key.toString('hex'), 'slow', mark], () => fs.existsSync(mark))
  assert.equal(run.signal, 'SIGKILL', run.out)
  const mid = inspect(file, key)
  assert.equal(mid.integrity, 'ok')
  assert.equal(mid.version, MIGRATIONS.length, 'the real migrations are committed, the slow one is not')
  assert.equal(mid.filler, before.filler)
  const db = openDatabase(file, key)
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'slow_step'").get().n, 0, 'the half migration left nothing')
  db.close()
  assert.deepEqual(inspect(backupPath(file, OLD), key), before)
  // the program as shipped: nothing more to do, and it opens
  assert.equal(await upgradeDatabase({ file, key }), null)
  const { db: again } = openMailDatabase(file, { key })
  assert.equal(currentVersion(again), MIGRATIONS.length)
  again.close()
})

test('the leftovers of an unfinished copy go BEFORE the space check, so they do not block the upgrade', async t => {
  const dir = tempDir(t)
  const { file, key } = oldDatabase(dir, 4)
  const size = fs.statSync(file).size
  const tmp = `${backupPath(file, OLD)}.tmp`
  // a stopped copy: 3/4 of the database, its journal, and a leftover of an older version's copy
  fs.writeFileSync(tmp, Buffer.alloc(Math.floor(size * 0.75)))
  fs.writeFileSync(`${tmp}-journal`, Buffer.alloc(4096))
  fs.writeFileSync(path.join(dir, 'mail.sqlite.bak-2.tmp'), Buffer.alloc(4096))
  // a volume that has room for one copy only when the leftovers are gone: free space = room - what they hold
  const leftovers = () => fs.readdirSync(dir).filter(n => /\.tmp/.test(n)).reduce((a, n) => a + fs.statSync(path.join(dir, n)).size, 0)
  const room = size + Math.floor(size * 0.5)
  const statfs = () => ({ bavail: room - leftovers(), bsize: 1 })
  assert.equal(upgradeSpace(file, statfs).ok, false, 'with the leftovers in place the check would refuse')
  const done = await upgradeDatabase({ file, key, statfs })
  assert.equal(done.to, MIGRATIONS.length)
  assert.deepEqual(fs.readdirSync(dir).filter(n => n.includes('.tmp')), [])
  assert.equal(inspect(file, key).integrity, 'ok')
})

test('a copy that fails (SQLITE_FULL) leaves no partial .tmp; the database stays at the old schema', t => {
  const dir = tempDir(t)
  const { file, key } = oldDatabase(dir, 2)
  const before = inspect(file, key)
  const db = openDatabase(file, key)
  // the copy writes part of its file, then the volume is full
  const full = new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare')
        return sql => {
          if (/^VACUUM INTO/.test(sql))
            return {
              run: out => {
                fs.writeFileSync(out, Buffer.alloc(65536))
                fs.writeFileSync(`${out}-journal`, Buffer.alloc(512))
                throw Object.assign(new Error('database or disk is full'), { code: 'SQLITE_FULL' })
              },
            }
          return target.prepare(sql)
        }
      const v = target[prop]
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
  assert.throws(() => migrate(full, MIGRATIONS, { file }), err => err.code === 'SQLITE_FULL')
  db.close()
  assert.deepEqual(fs.readdirSync(dir).filter(n => n.includes('.bak-')), [], 'no .tmp, no .bak')
  assert.deepEqual(inspect(file, key), before)
})
