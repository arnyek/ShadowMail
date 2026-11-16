#!/usr/bin/env node
// The schema upgrade in the real app on unlock (backup + migrations in a worker, a notice on the lock
// screen). Not part of `npm test`.
//
//   node test/e2e/db-upgrade-e2e.mjs [--mb 300]
//
// Data folders made here (vault.json + an encrypted mail.sqlite at the previous schema, with --mb MB of filler rows):
//   A: unlock -> the notice goes out within 1 s of the unlock (main.log) and goes when the upgrade ends; the main process answers all
//      along (round trips of app.evaluate, the longest is printed); the app opens; .bak-<old> and mail.sqlite check ok.
//   B: unlock, kill the app (SIGKILL) while the backup is being written; start again: it upgrades and opens, both files
//      check ok, the rows are the same.
//   C: free space made small (the main process' fs.statfsSync answers 4 KB): the unlock error names the MB needed,
//      no notice, nothing written, the schema stays.
//   D: an up-to-date database: no notice at all.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { Vault } from '../../core/vault/vault.js'
import { vaultPath, createVaultedDatabase } from '../../core/vault/vaulted-db.js'
import { databasePath } from '../../core/paths.js'
import { openDatabase, openMailDatabase } from '../../core/db/index.js'
import { currentVersion, backupPath } from '../../core/db/migrate.js'
import { MIGRATIONS } from '../../core/db/schema.js'
import { t, seedLanguage } from './lang.mjs'

const { values } = parseArgs({ options: { mb: { type: 'string', default: '300' } } })
const MBS = Number(values.mb)
const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const MASTER = 'Teszt-mesterjelszo-frissites'
const OLD = MIGRATIONS.length - 1
const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// the "no space" unlock error with any MB needed (999 = a number no locale formats differently)
const noSpaceRe = new RegExp(esc(t.vaultError('db_no_space', { needMb: 999, freeMb: 0 })).replace('999', '[\\d,.\\s]+'))
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-upgrade-e2e-'))

async function oldFolder(name, mb) {
  const dataDir = path.join(work, name)
  fs.mkdirSync(dataDir)
  const vault = new Vault(vaultPath(dataDir))
  await vault.create(MASTER)
  const key = vault.databaseKey()
  const { db } = openMailDatabase(databasePath(dataDir), { key, migrations: MIGRATIONS.slice(0, OLD) })
  key.fill(0)
  db.exec('CREATE TABLE filler (n INTEGER, b BLOB)')
  const ins = db.prepare('INSERT INTO filler (n, b) VALUES (?, randomblob(?))')
  db.transaction(() => {
    for (let i = 0; i < mb * 16; i++) ins.run(i, 64 * 1024)
  })()
  db.close()
  vault.lock()
  seedLanguage(dataDir)
  return dataDir
}

async function inspect(dataDir, file = databasePath(dataDir)) {
  const vault = new Vault(vaultPath(dataDir))
  await vault.unlock(MASTER)
  const key = vault.databaseKey()
  try {
    const db = openDatabase(file, key)
    try {
      const hasFiller = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'filler'").get()
      return { integrity: db.prepare('PRAGMA integrity_check').get().integrity_check, version: currentVersion(db), filler: hasFiller ? db.prepare('SELECT count(*) AS n FROM filler').get().n : null }
    } finally {
      db.close()
    }
  } finally {
    key.fill(0)
    vault.lock()
  }
}

async function launch(dataDir) {
  const app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
  const page = await app.firstWindow()
  const problems = []
  page.on('console', m => (m.type() === 'error' || m.type() === 'warning') && problems.push(m.text()))
  page.on('pageerror', e => problems.push(e.message))
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.locator('#vault-unlock').waitFor({ timeout: 30_000 })
  // whether the notice ever showed (a MutationObserver, so a short one is not missed)
  await page.evaluate(() => {
    window.__sawUpgrade = false
    new MutationObserver(() => {
      if (document.getElementById('vault-db-upgrade')) window.__sawUpgrade = true
    }).observe(document.body, { childList: true, subtree: true })
  })
  return { app, page, problems }
}
const unlockClick = async page => {
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
}
const mainLog = dataDir => {
  const f = path.join(dataDir, 'electron', 'logs', 'main.log')
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''
}

try {
  // A
  const a = await oldFolder('a', MBS)
  const aBefore = await inspect(a)
  const dbMb = Math.round(fs.statSync(databasePath(a)).size / 1024 / 1024)
  {
    const { app, page, problems } = await launch(a)
    try {
      const t0 = performance.now()
      await unlockClick(page)
      await page.locator('#vault-db-upgrade').waitFor({ timeout: 10_000 })
      const shownMs = performance.now() - t0
      const notice = await page.locator('#vault-db-upgrade').innerText().catch(() => '')
      // the main process answers while the upgrade runs
      let longest = 0
      let samples = 0
      // one round = a renderer query + a main-process evaluate; in Electron the main JS thread is the browser's UI
      // thread, so a blocked main process stalls BOTH (the in-thread control: one round as long as the upgrade)
      for (;;) {
        const s = performance.now()
        const busy = (await page.locator('#vault-db-upgrade').count()) > 0
        await app.evaluate(() => 1)
        longest = Math.max(longest, performance.now() - s)
        samples++
        if (!busy) break
        await new Promise(r => setTimeout(r, 50))
      }
      const totalMs = performance.now() - t0
      await page.locator('header.app-header').waitFor({ timeout: 60_000 })
      const text = await page.evaluate(() => document.body.innerText)
      // the card: within 1 s AFTER the unlock. The click -> notice time also holds the password's scrypt (~0.6 s here,
      // more under load), so the check is main.log's "vault unlocked" -> the upgrade's start (the notice
      // is sent with it); the click -> notice time is printed only
      console.log(`INFO A: the click -> the notice on screen ${Math.round(shownMs)} ms (with the password check)`)
      const aLog = mainLog(a)
      const stamp = re => {
        const x = aLog.match(re)
        return x ? Date.parse(x[1]) : null
      }
      const tUnlocked = stamp(/^(\S+) \[\d+\] vault unlocked$/m)
      const tStart = stamp(/^(\S+) \[\d+\] database upgrade \d+ -> \d+: backup and migration in a worker$/m)
      check(`A (${dbMb} MB): after the unlock the notice goes out within 1 s (main.log)`, tUnlocked && tStart && tStart - tUnlocked < 1000, `${tStart - tUnlocked} ms`)
      check('A: the notice text', notice.includes(t.vaultDbUpgrade), notice)
      check('A: the main process answered during the upgrade (longest round trip < 500 ms)', samples > 0 && longest < 500, `${samples} samples, longest ${Math.round(longest)} ms, upgrade + open ${Math.round(totalMs)} ms`)
      check('A: the notice is gone and the app is open', (await page.locator('#vault-db-upgrade').count()) === 0 && !text.includes(t.vaultDbUpgrade.split(':')[0]))
      const log = mainLog(a)
      const m = /database upgrade done in (\d+) ms/.exec(log)
      check('A: main.log has the upgrade and its time, no content', /database upgrade \d+ -> \d+: backup and migration in a worker/.test(log) && m, m ? `${m[1]} ms` : log.slice(-400))
      console.log(`MEASURED A: ${dbMb} MB, notice after ${Math.round(shownMs)} ms, upgrade ${m ? m[1] : '?'} ms (main.log), longest main-process round trip ${Math.round(longest)} ms over ${samples} samples`)
      check('A: no console error or warning', problems.length === 0, problems.join(' | '))
    } finally {
      await app.close().catch(() => {})
    }
    const after = await inspect(a)
    const bak = await inspect(a, backupPath(databasePath(a), OLD))
    check('A: mail.sqlite checks ok at the new schema, the rows are the same', after.integrity === 'ok' && after.version === MIGRATIONS.length && after.filler === aBefore.filler, JSON.stringify(after))
    check('A: the .bak checks ok at the old schema, the same rows', JSON.stringify(bak) === JSON.stringify(aBefore), JSON.stringify(bak))
  }

  // B: killed during the backup
  const b = await oldFolder('b', MBS)
  const bBefore = await inspect(b)
  const tmp = `${backupPath(databasePath(b), OLD)}.tmp`
  {
    const { app, page } = await launch(b)
    await unlockClick(page)
    await page.locator('#vault-db-upgrade').waitFor({ timeout: 10_000 })
    const t0 = performance.now()
    // killed at 40 % of the copy: the leftover is big enough to matter for the space check of the next start
    const dbSize = fs.statSync(databasePath(b)).size
    while (!(fs.existsSync(tmp) && fs.statSync(tmp).size >= 0.4 * dbSize) && performance.now() - t0 < 30_000) await new Promise(r => setTimeout(r, 2))
    const partial = fs.existsSync(tmp) ? fs.statSync(tmp).size : 0
    app.process().kill('SIGKILL')
    await new Promise(r => app.process().once('exit', r))
    check('B: killed while the backup was being written', partial > 0 && !fs.existsSync(backupPath(databasePath(b), OLD)), `${partial} bytes of the copy`)
    const mid = await inspect(b)
    check('B: after the kill mail.sqlite checks ok at the old schema, the same rows', JSON.stringify(mid) === JSON.stringify(bBefore), JSON.stringify(mid))
  }
  {
    const { app, page, problems } = await launch(b)
    try {
      // a volume with room for ONE copy only once the leftovers are gone (free = room - their size)
      const leftover = fs.readdirSync(b).filter(n => n.includes('.tmp')).reduce((a, n) => a + fs.statSync(path.join(b, n)).size, 0)
      const room = Math.floor(fs.statSync(databasePath(b)).size * 1.3)
      await app.evaluate(({}, [dir, room]) => {
        const nfs = process.getBuiltinModule('node:fs')
        const npath = process.getBuiltinModule('node:path')
        nfs.statfsSync = () => ({ bsize: 1, bavail: room - nfs.readdirSync(dir).filter(n => n.includes('.tmp')).reduce((a, n) => a + nfs.statSync(npath.join(dir, n)).size, 0) })
      }, [b, room])
      await unlockClick(page)
      await page.locator('header.app-header').waitFor({ timeout: 120_000 })
      check('B: the next start, with free space for one copy only after the leftover goes, upgrades and opens', true, `leftover ${leftover} bytes, room ${room} bytes`)
      check('B: no console error or warning', problems.length === 0, problems.join(' | '))
    } finally {
      await app.close().catch(() => {})
    }
    const after = await inspect(b)
    const bak = await inspect(b, backupPath(databasePath(b), OLD))
    check('B: mail.sqlite and .bak check ok, the rows are the same, no .tmp left', after.integrity === 'ok' && after.version === MIGRATIONS.length && after.filler === bBefore.filler && JSON.stringify(bak) === JSON.stringify(bBefore) && !fs.existsSync(tmp), `${JSON.stringify(after)} ${JSON.stringify(bak)}`)
  }

  // C: too little free space
  const c = await oldFolder('c', 4)
  const cBefore = await inspect(c)
  {
    const { app, page, problems } = await launch(c)
    try {
      await app.evaluate(() => {
        process.getBuiltinModule('node:fs').statfsSync = () => ({ bavail: 1, bsize: 4096 })
      })
      await unlockClick(page)
      const err = page.locator('.vault [role=alert]')
      await err.waitFor({ timeout: 10_000 })
      const msg = await err.innerText()
      check('C: the unlock error names the space needed', noSpaceRe.test(msg), msg)
      check('C: no notice, still locked', !(await page.evaluate(() => window.__sawUpgrade)) && (await page.locator('#vault-unlock').count()) === 1)
      check('C: no console error or warning', problems.length === 0, problems.join(' | '))
    } finally {
      await app.close().catch(() => {})
    }
    check('C: nothing written: the schema and the rows unchanged, no backup', JSON.stringify(await inspect(c)) === JSON.stringify(cBefore) && !fs.readdirSync(c).some(n => n.includes('.bak-')))
  }

  // D: an up-to-date database
  const d = path.join(work, 'd')
  fs.mkdirSync(d)
  {
    const made = await createVaultedDatabase(d, MASTER)
    made.db.close()
    made.vault.lock()
    seedLanguage(d)
    const { app, page, problems } = await launch(d)
    try {
      await unlockClick(page)
      await page.locator('header.app-header').waitFor({ timeout: 30_000 })
      check('D: an up-to-date database: no notice, no upgrade in main.log', !(await page.evaluate(() => window.__sawUpgrade)) && !/database upgrade/.test(mainLog(d)))
      check('D: no console error or warning', problems.length === 0, problems.join(' | '))
    } finally {
      await app.close().catch(() => {})
    }
  }
} catch (err) {
  check('the run', false, err.stack)
} finally {
  fs.rmSync(work, { recursive: true, force: true })
}
const ok = results.filter(Boolean).length
console.log(`${ok} / ${results.length} ${ok === results.length ? 'OK' : 'FAIL'}`)
process.exit(ok === results.length ? 0 : 1)
