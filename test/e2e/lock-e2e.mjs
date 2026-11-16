#!/usr/bin/env node
// The encrypted database in the real app, headless Electron + Playwright. Not part of `npm test`.
//
//   node test/e2e/lock-e2e.mjs
//
// 1. Locked start: no database open (app:hello has no SQLite version, the account/mail IPC answers
//    'locked', the main process holds no mail.sqlite* descriptor); unlock -> the mail list.
// 2. "Zárolás": the IPC answers 'locked' again, and once the sync stopped no mail.sqlite* descriptor is
//    left (Linux: /proc/<pid>/fd; on Windows the same is measured by renaming the file while locked);
//    a second unlock opens it again. The main log has no error line.
// 3. An unencrypted data folder of an earlier build: the app exits (code 3) and touches no file.
// Playwright: PW=<path of the playwright package> (default: the repo's playwright-core devDependency).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import Database from 'better-sqlite3-multiple-ciphers'
import { createVaultedDatabase } from '../../core/vault/vaulted-db.js'
import { AccountStore } from '../../core/accounts/model.js'
import { newAccountDefaults } from '../../core/accounts/defaults.js'
import { t, seedLanguage } from './lang.mjs'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const MASTER = 'Teszt-mesterjelszo-zarolas'
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-k17-'))
const dataDir = path.join(work, 'data')
fs.mkdirSync(dataDir)
{
  const { db, vault } = await createVaultedDatabase(dataDir, MASTER)
  const store = new AccountStore(db, vault, { storeDir: path.join(dataDir, 'store') })
  // unreachable on purpose: the sync fails fast and quietly, nothing leaves the machine
  store.save({ ...newAccountDefaults('pop3'), name: 'Helyi fiók', email: 'h@example.invalid', in_host: '127.0.0.1', in_port: 1, in_security: 'none', in_user: 'h', in_password: 'x', smtp_host: '127.0.0.1', smtp_port: 1, smtp_security: 'none' })
  db.close()
}
seedLanguage(dataDir)
const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
// the main process's open files under the data folder named mail.sqlite* (Linux)
const dbHandles = pid => {
  if (process.platform !== 'linux') return null
  const out = []
  for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
    try {
      const target = fs.readlinkSync(`/proc/${pid}/fd/${fd}`)
      if (target.startsWith(dataDir) && path.basename(target).startsWith('mail.sqlite')) out.push(target)
    } catch {
      // closed meanwhile
    }
  }
  return out
}
// the "drafts not saved at the lock" bar, whatever the count: the text after the number
const lockBarText = (a => {
  const b = t.lockDraftsFailed(2)
  let i = 0
  while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++
  return a.slice(a.length - i)
})(t.lockDraftsFailed(1))
const until = async (fn, ms = 10_000) => {
  const t0 = Date.now()
  while (!(await fn())) {
    if (Date.now() - t0 > ms) return false
    await new Promise(r => setTimeout(r, 100))
  }
  return true
}

const watchdog = setTimeout(() => {
  console.log('FAIL watchdog: the run took more than 3 minutes')
  process.exit(1)
}, 180_000)
watchdog.unref()

const app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
try {
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1280, height: 900 })
  const pid = await app.evaluate(() => process.pid)
  await page.locator('#vault-unlock').waitFor()
  // 1. locked start
  const hello = await page.evaluate(() => window.shadowMail.hello())
  check('locked: app:hello answers, without a SQLite version', hello.dataDir === dataDir && hello.sqliteVersion === null, JSON.stringify(hello))
  const lockedCalls = await page.evaluate(async () => [await window.shadowMail.accounts.list(), await window.shadowMail.mail.folders()])
  check('locked: the account and mail IPC answer "locked"', lockedCalls.every(r => r && r.ok === false && r.error === 'locked'), JSON.stringify(lockedCalls))
  check('locked: no mail.sqlite descriptor in the main process', JSON.stringify(dbHandles(pid)) === '[]', JSON.stringify(dbHandles(pid)))
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  await page.getByRole('button', { name: t.newMessage, exact: true }).waitFor({ timeout: 20_000 })
  const open = await page.evaluate(async () => [await window.shadowMail.accounts.list(), await window.shadowMail.hello()])
  check('unlocked: the accounts come, app:hello has the SQLite version', open[0].ok && open[0].accounts.length === 1 && /^3\./.test(open[1].sqliteVersion || ''), JSON.stringify(open[1]))
  check('unlocked: the database is open', (dbHandles(pid) || ['x']).length > 0, JSON.stringify(dbHandles(pid)))

  // 2. lock
  const lockRes = await page.evaluate(() => window.shadowMail.vault.lock())
  check('lock answers ok, locked', lockRes.ok && lockRes.status.unlocked === false, JSON.stringify(lockRes))
  const after = await page.evaluate(async () => [await window.shadowMail.accounts.list(), await window.shadowMail.mail.list({ accountId: 1, folder: 'INBOX' })])
  check('after the lock the account and mail IPC answer "locked"', after.every(r => r && r.ok === false && r.error === 'locked'), JSON.stringify(after))
  const released = await until(() => JSON.stringify(dbHandles(pid)) === '[]')
  check('after the lock no mail.sqlite descriptor is left in the main process', released, JSON.stringify(dbHandles(pid)))
  await page.reload()
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  await page.getByRole('button', { name: t.newMessage, exact: true }).waitFor({ timeout: 20_000 })
  const again = await page.evaluate(() => window.shadowMail.accounts.list())
  check('a second unlock opens it again', again.ok && again.accounts.length === 1)

  // 2b. Zárolás with an open composer: typed, not saved -> saved, the window closes, one draft
  const openComposer = async () => {
    const [win] = await Promise.all([app.waitForEvent('window', { timeout: 15_000 }), page.getByRole('button', { name: t.newMessage, exact: true }).click()])
    await win.setViewportSize({ width: 900, height: 700 })
    await win.waitForFunction(() => document.querySelector('#compose-from')?.textContent.trim())
    return win
  }
  const unlockUi = async () => {
    await page.locator('#vault-unlock').fill(MASTER)
    await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
    await page.getByRole('button', { name: t.newMessage, exact: true }).waitFor({ timeout: 20_000 })
  }
  const draftSubjects = () =>
    page.evaluate(async () => {
      const acc = (await window.shadowMail.mail.folders()).accounts[0]
      const res = await window.shadowMail.mail.list({ accountId: acc.id, folder: 'Drafts' })
      return res.ok ? res.rows.map(r => r.subject) : ['(error)']
    })
  let win = await openComposer()
  await win.locator('#compose-to').fill('cimzett@example.invalid')
  await win.locator('#compose-subject').fill('Zárolás előtt begépelve')
  await win.locator('.editor').click()
  await win.keyboard.type('Ez a szöveg nincs még elmentve.')
  await Promise.all([win.waitForEvent('close', { timeout: 15_000 }), page.getByRole('button', { name: t.vaultLockButton, exact: true }).click()])
  await page.locator('#vault-unlock').waitFor({ timeout: 15_000 })
  check('Zárolás with an open composer: the window closed without asking, the lock screen is shown', win.isClosed())
  await unlockUi()
  await page.waitForTimeout(500)
  const drafts = await draftSubjects()
  check('after the unlock: one draft, with the typed text', JSON.stringify(drafts) === JSON.stringify(['Zárolás előtt begépelve']), JSON.stringify(drafts))
  check('no "not saved" bar when every draft was saved', (await page.locator('.notice', { hasText: lockBarText }).count()) === 0)

  // 2c. the save fails: the lock still comes, and the next unlock shows the bar
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('compose:saveDraft')
    ipcMain.handle('compose:saveDraft', () => ({ ok: false, error: 'server_refused' }))
  })
  win = await openComposer()
  await win.locator('#compose-subject').fill('Ez nem tud elmenteni')
  await Promise.all([win.waitForEvent('close', { timeout: 15_000 }), page.getByRole('button', { name: t.vaultLockButton, exact: true }).click()])
  await page.locator('#vault-unlock').waitFor({ timeout: 15_000 })
  check('a failing save: the lock still comes, the window closed', win.isClosed())
  await unlockUi()
  const bar = page.locator('.notice', { hasText: lockBarText })
  await bar.waitFor({ timeout: 5000 }).catch(() => {})
  check('after the unlock the bar says 1 draft was not saved', (await bar.innerText().catch(() => '')).includes(t.lockDraftsFailed(1)), await bar.innerText().catch(() => 'no bar'))
  const wrong = await page.evaluate(async () => {
    await window.shadowMail.vault.lock()
    return window.shadowMail.vault.unlock('Rossz-mesterjelszo-123')
  })
  check('a wrong password: "wrong_password", still locked', !wrong.ok && wrong.error === 'wrong_password', JSON.stringify(wrong))
} catch (err) {
  check('run', false, err.stack)
} finally {
  await app.close().catch(() => {})
}
const mainLog = fs.readFileSync(path.join(dataDir, 'electron', 'logs', 'main.log'), 'utf8')
check('the main log: no error or failure line', !/failed|error/i.test(mainLog), mainLog.trim().split('\n').filter(l => /failed|error/i.test(l)).join(' | '))

// 3. an unencrypted data folder of an earlier build
const legacy = path.join(work, 'legacy')
fs.mkdirSync(path.join(legacy, 'store'), { recursive: true })
const plain = new Database(path.join(legacy, 'mail.sqlite'))
plain.exec('CREATE TABLE t (a); INSERT INTO t VALUES (1)')
plain.close()
fs.writeFileSync(path.join(legacy, 'store', 'level.eml'), 'Subject: x\r\n\r\ny')
seedLanguage(legacy)
const snapshot = () => fs.readdirSync(legacy, { recursive: true }).sort().map(n => [n, fs.statSync(path.join(legacy, n)).size, fs.statSync(path.join(legacy, n)).mtimeMs])
const before = snapshot()
// a fresh HOME: nothing may be created outside the data folder either (Electron's default profile folder)
const home = path.join(work, 'home')
fs.mkdirSync(home)
// SHADOWMAIL_SMOKE: the refusal goes to stderr instead of a dialog nobody can close headless
const r = spawnSync(electronBin, [repo, '--ozone-platform=headless', '--disable-gpu'], { env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), SHADOWMAIL_DATA: legacy, SHADOWMAIL_SMOKE: '1' }, encoding: 'utf8', timeout: 60_000 })
check('unencrypted folder of an earlier build: exit code 3, refused', r.status === 3 && /data folder refused: legacy_plain/.test(r.stderr), `status=${r.status} ${r.stderr.trim().split('\n').slice(-2).join(' | ')}`)
check('unencrypted folder: nothing in it created or changed (names, sizes, mtimes; no electron\\ folder)', JSON.stringify(snapshot()) === JSON.stringify(before), JSON.stringify(snapshot()))
// Linux only: fontconfig writes its font cache (~/.cache/fontconfig) when Chromium starts; not a profile
const created = fs.readdirSync(home, { recursive: true }).filter(n => !/^\.cache($|\/fontconfig)/.test(n))
check('unencrypted folder: no Electron profile folder created outside it either', created.length === 0, JSON.stringify(created))

fs.rmSync(work, { recursive: true, force: true })
console.log(`\n${results.filter(Boolean).length} / ${results.length} OK`)
process.exit(results.every(Boolean) ? 0 : 1)
