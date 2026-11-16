#!/usr/bin/env node
// the way back from 0.11.0 to 0.10.1 ON THE PACKAGES, run on Windows with the Windows Node from the
// build folder (as package-smoke.mjs: CDP over --remote-debugging-port, PW=<playwright-core>):
//
//   node test\e2e\rollback-smoke.mjs --new <ShadowMail-0.11.0 zip> --old <ShadowMail-0.10.1 zip> --data <a 0.10.1 data folder>
//                                     --master <its master password> --work <empty folder> [--search <a word of its mail>]
//
// 1. the new package opens a copy of the 0.10.1 data folder: the database goes to schema 4, mail.sqlite.bak-3 is made;
// 2. the old package on that folder: it does NOT open it (newer schema), and changes nothing in it;
// 3. the way back: mail.sqlite.bak-3 copied over mail.sqlite (its -wal / -shm removed): the old package opens it, the
//    account and the messages are there, the search answers.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { parseArgs } from 'node:util'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PW || 'playwright-core')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const { values } = parseArgs({ options: { new: { type: 'string' }, old: { type: 'string' }, data: { type: 'string' }, master: { type: 'string' }, work: { type: 'string' }, search: { type: 'string' } } })
if (!values.new || !values.old || !values.data || !values.master || !values.work) {
  console.error('usage: rollback-smoke.mjs --new <zip> --old <zip> --data <0.10.1 data folder> --master <password> --work <empty folder> [--search <word>]')
  process.exit(2)
}
const work = path.resolve(values.work)
fs.mkdirSync(work, { recursive: true })
if (fs.readdirSync(work).length) {
  console.error('the work folder must be empty')
  process.exit(2)
}
const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const unpack = (zip, dir) => {
  fs.mkdirSync(dir)
  execFileSync('tar', ['-xf', path.resolve(zip), '-C', dir])
}
const hash = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')

let port = 9800 + Math.floor(Math.random() * 100)
async function launch(dir) {
  port++
  const env = { ...process.env }
  delete env.SHADOWMAIL_DATA
  delete env.SHADOWMAIL_SMOKE
  const proc = spawn(path.join(dir, 'ShadowMail.exe'), [`--remote-debugging-port=${port}`], { cwd: dir, env, stdio: 'ignore' })
  let browser = null
  for (let i = 0; i < 60 && !browser; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    } catch {
      await sleep(500)
    }
  }
  if (!browser) throw new Error('no DevTools endpoint')
  const context = browser.contexts()[0]
  let page = context.pages().find(p => p.url().includes('index.html'))
  for (let i = 0; i < 40 && !page; i++) {
    await sleep(250)
    page = context.pages().find(p => p.url().includes('index.html'))
  }
  await page.setViewportSize({ width: 1280, height: 900 })
  return { proc, browser, page }
}
async function quit({ proc, browser, page }) {
  await page.evaluate(() => window.close()).catch(() => {})
  for (let i = 0; i < 40 && proc.exitCode === null; i++) await sleep(250)
  await browser.close().catch(() => {})
  if (proc.exitCode === null) proc.kill()
}
const unlock = async app => {
  await app.page.locator('#vault-unlock').fill(values.master)
  await app.page.getByRole('button', { name: 'Feloldás', exact: true }).click()
}

try {
  // 1. the new package migrates a copy of the old folder
  const newDir = path.join(work, 'new')
  unpack(values.new, newDir)
  fs.cpSync(path.resolve(values.data), path.join(newDir, 'data'), { recursive: true })
  let app = await launch(newDir)
  await unlock(app)
  await app.page.locator('.folder-tree .account-name').first().waitFor({ timeout: 30_000 })
  const newVersion = await app.page.evaluate(() => window.shadowMail.hello().then(h => h.appVersion))
  await quit(app)
  const data = path.join(newDir, 'data')
  check('0.11.0 opened the 0.10.1 folder and kept the schema-3 copy (mail.sqlite.bak-3)', fs.existsSync(path.join(data, 'mail.sqlite.bak-3')), `version ${newVersion}`)

  // 2. the old package on the migrated folder: refused, nothing changed
  const oldDir = path.join(work, 'old')
  unpack(values.old, oldDir)
  fs.cpSync(data, path.join(oldDir, 'data'), { recursive: true })
  const oldData = path.join(oldDir, 'data')
  const before = hash(path.join(oldData, 'mail.sqlite'))
  app = await launch(oldDir)
  const oldVersion = await app.page.evaluate(() => window.shadowMail.hello().then(h => h.appVersion))
  await unlock(app)
  const opened = await app.page.locator('.folder-tree .account-name').first().waitFor({ timeout: 10_000 }).then(() => true, () => false)
  const message = await app.page.locator('[role="alert"], .error').allInnerTexts().catch(() => [])
  await quit(app)
  check('0.10.1 does NOT open the schema-4 folder, it says why', !opened && message.join(' ').trim().length > 0, `version ${oldVersion}; "${message.join(' | ').trim()}"`)
  check('0.10.1 changed nothing in mail.sqlite', hash(path.join(oldData, 'mail.sqlite')) === before)

  // 3. the way back: the schema-3 copy over mail.sqlite
  for (const x of ['mail.sqlite-wal', 'mail.sqlite-shm']) fs.rmSync(path.join(oldData, x), { force: true })
  fs.copyFileSync(path.join(oldData, 'mail.sqlite.bak-3'), path.join(oldData, 'mail.sqlite'))
  app = await launch(oldDir)
  await unlock(app)
  const back = await app.page.locator('.folder-tree .account-name').first().waitFor({ timeout: 30_000 }).then(() => true, () => false)
  const accounts = back ? await app.page.locator('.folder-tree .account-name').allInnerTexts() : []
  const total = back ? await app.page.locator('.list-count').getAttribute('data-total').catch(() => '') : ''
  let found = 0
  if (back && values.search) {
    await app.page.getByRole('searchbox', { name: 'Keresés' }).fill(values.search)
    await app.page.locator('.result').first().waitFor({ timeout: 10_000 }).catch(() => {})
    found = await app.page.locator('.result').count()
  }
  await quit(app)
  check('the way back: with mail.sqlite.bak-3 the 0.10.1 opens it, account and messages there', back && accounts.length > 0 && Number(total) > 0, `${accounts.join(',')} | ${total}`)
  if (values.search) check('the way back: the search answers', found > 0, `${found} hits`)
} catch (err) {
  check('run', false, err.stack)
}
console.log(`\n${results.filter(Boolean).length} / ${results.length} OK`)
process.exit(results.every(Boolean) ? 0 : 1)
