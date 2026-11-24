#!/usr/bin/env node
// The search's order in the real app, headless Electron + Playwright. Not part of `npm test`.
//
//   E2E_LANG=hu|en node test/e2e/search-sort-e2e.mjs
//
// Data: one IMAP account (unreachable on purpose: 127.0.0.1:1; the index is written directly) with three messages where
// the date order and the relevance order differ. Nothing leaves the machine.
// Measures: a fresh data folder searches by date (newest first, the Sort chip says Date), a sender-only search too; the
// chip lists Date first; relevance chosen: the relevance order, kept after Esc and after a restart;
// date chosen again: kept after a restart; relevance chosen and the main process killed 1 s later (no orderly exit): kept;
// a broken or unknown stored value is by date without a console problem; main.log holds no word of the choice.
// Playwright: PW=<path of the playwright package> (default: the repo's playwright-core devDependency).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { MailIndex } from '../../core/db/mail-index.js'
import { createVaultedDatabase } from '../../core/vault/vaulted-db.js'
import { AccountStore } from '../../core/accounts/model.js'
import { newAccountDefaults } from '../../core/accounts/defaults.js'
import { t, seedLanguage } from './lang.mjs'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const MASTER = 'Teszt-mesterjelszo-rendezes'
const DAY = 86_400_000
const now = Date.now()
const STORE = 'shadowmail.ui.searchSort'

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-sort-e2e-'))
const dataDir = path.join(work, 'data')
fs.mkdirSync(dataDir)
seedLanguage(dataDir)
{
  const { db, vault } = await createVaultedDatabase(dataDir, MASTER)
  const store = new AccountStore(db, vault, { storeDir: path.join(dataDir, 'store') })
  const acc = store.save({ ...newAccountDefaults('imap'), name: 'IMAP-fiók', email: 'i@example.invalid', in_host: '127.0.0.1', in_port: 1, in_security: 'none', in_user: 'i', in_password: 'nem-valodi', smtp_host: '127.0.0.1', smtp_port: 1, smtp_security: 'none' }).account
  const index = new MailIndex(db)
  index.upsertFolder({ account_id: acc.id, path: 'INBOX', uidvalidity: '1', synced_at: now })
  const put = (uid, subject, from, body, daysAgo) => {
    index.insertMany([{ account_id: acc.id, folder: 'INBOX', uid, pop3_uidl: null, message_id: null, in_reply_to: null, refs: null, from_addr: `${from}@example.invalid`, from_name: from, to_addrs: 'i@example.invalid', cc_addrs: '', subject, date: now - daysAgo * DAY, idate: now - daysAgo * DAY, flags: '\\Seen', size: 100, has_attachments: 0, attachments: null, body_state: 0, sender_text: `${from} <${from}@example.invalid>`, recipients_text: 'i@example.invalid' }])
    const got = index.getByUid(acc.id, 'INBOX', uid)
    index.setBodies([{ id: got.id, text: body, state: 1, preview: body.slice(0, 200) }])
  }
  // by date: Uj, Kozepes, Regi; by relevance the old one (the word in its subject and three times in its text) first
  put(1, 'Uj level', 'Anna', `Egy hosszabb szoveg, benne egyszer: kazanfutes. ${'tovabbi szoveg '.repeat(40)}`, 1)
  put(2, 'Kozepes level', 'Anna', `Kozepes szoveg kazanfutes ${'kitoltes '.repeat(20)}`, 5)
  put(3, 'Regi kazanfutes', 'Anna', 'kazanfutes kazanfutes kazanfutes', 40)
  db.close()
}
const DATE_ORDER = ['Uj level', 'Kozepes level', 'Regi kazanfutes']

const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const consoleProblems = []
const launch = async () => {
  const app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
  const page = await app.firstWindow()
  page.on('console', m => (m.type() === 'error' || m.type() === 'warning') && consoleProblems.push(m.text()))
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  await page.locator('.msg-row').first().waitFor({ timeout: 30_000 })
  return { app, page }
}
const box = page => page.getByRole('searchbox', { name: t.searchLabel })
const sortChip = page => page.locator('.search-chips button.chip', { hasText: t.searchFilter.sort })
// a search by text; -> { subjects in the list's order, the Sort chip's text }
async function search(page, text) {
  await box(page).fill(text)
  await page.waitForFunction(() => document.querySelectorAll('.result').length === 3)
  await page.waitForTimeout(400) // the order settles (one render after the hits)
  return { subjects: await page.locator('.result .result-subject').allInnerTexts(), chip: (await sortChip(page).innerText()).trim() }
}
const chipSays = which => `${t.searchFilter.sort}: ${t.searchSort[which]}`
async function choose(page, which) {
  await sortChip(page).click()
  await page.getByRole('menuitemradio', { name: t.searchSort[which], exact: true }).click()
  await page.waitForTimeout(400)
}
const stored = page => page.evaluate(k => window.localStorage.getItem(k), STORE)
const leave = async page => {
  await box(page).press('Escape')
  await page.locator('.result').first().waitFor({ state: 'detached' })
}

let app = null
try {
  let page
  ;({ app, page } = await launch())
  // 1. a fresh data folder: by date
  let s = await search(page, 'kazanfutes')
  check('fresh: newest first, the chip says Date', JSON.stringify(s.subjects) === JSON.stringify(DATE_ORDER) && s.chip === chipSays('date'), JSON.stringify(s))
  check('fresh: nothing stored', (await stored(page)) === null, await stored(page))
  await sortChip(page).click()
  const items = await page.getByRole('menuitemradio').allInnerTexts()
  check('the chip lists Date first, then Relevance', JSON.stringify(items.map(x => x.trim())) === JSON.stringify([t.searchSort.date, t.searchSort.relevance]), JSON.stringify(items))
  await page.keyboard.press('Escape')
  await leave(page)
  // a sender-only search (an empty box) by date too
  const esc = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  await page.getByRole('button', { name: t.searchFiltersButton, exact: true }).click()
  await page.locator('.search-chips').getByRole('button', { name: new RegExp(`^${esc(t.searchFilter.from)}`) }).click()
  await page.getByRole('dialog', { name: t.searchFilter.from }).getByLabel(t.searchFilter.from, { exact: true }).fill('Anna')
  await page.keyboard.press('Escape') // the panel
  await page.waitForFunction(() => document.querySelectorAll('.result').length === 3)
  await page.waitForTimeout(400)
  s = { subjects: await page.locator('.result .result-subject').allInnerTexts(), chip: (await sortChip(page).innerText()).trim() }
  check('fresh, sender only: newest first, the chip says Date', JSON.stringify(s.subjects) === JSON.stringify(DATE_ORDER) && s.chip === chipSays('date'), JSON.stringify(s))
  await leave(page)
  // 2. relevance chosen: the relevance order; kept after Esc
  s = await search(page, 'kazanfutes')
  await choose(page, 'relevance')
  s = { subjects: await page.locator('.result .result-subject').allInnerTexts(), chip: (await sortChip(page).innerText()).trim() }
  check('relevance chosen: the most relevant (old) one first, the chip says Relevance, stored', s.subjects[0] === 'Regi kazanfutes' && s.chip === chipSays('relevance') && (await stored(page)) === '"relevance"', JSON.stringify({ ...s, stored: await stored(page) }))
  await leave(page)
  s = await search(page, 'kazanfutes')
  check('after Esc a new search starts with Relevance', s.chip === chipSays('relevance') && s.subjects[0] === 'Regi kazanfutes', JSON.stringify(s))
  // 3. restart: still relevance
  await app.close()
  app = null
  ;({ app, page } = await launch())
  s = await search(page, 'kazanfutes')
  check('after a restart: Relevance', s.chip === chipSays('relevance') && s.subjects[0] === 'Regi kazanfutes', JSON.stringify(s))
  // 4. back to date: kept after a restart
  await choose(page, 'date')
  check('date chosen again: stored', (await stored(page)) === '"date"', await stored(page))
  await app.close()
  app = null
  ;({ app, page } = await launch())
  s = await search(page, 'kazanfutes')
  check('after a restart: Date', s.chip === chipSays('date') && JSON.stringify(s.subjects) === JSON.stringify(DATE_ORDER), JSON.stringify(s))
  // 5. relevance chosen, the main process killed 1 s later (no orderly exit): kept
  await choose(page, 'relevance')
  await page.waitForTimeout(1000)
  process.kill(app.process().pid, 'SIGKILL')
  await new Promise(r => setTimeout(r, 1000))
  app = null
  ;({ app, page } = await launch())
  s = await search(page, 'kazanfutes')
  check('a forced stop 1 s after the choice: Relevance kept', s.chip === chipSays('relevance'), JSON.stringify(s))
  // 6. a broken or unknown stored value: by date, no console problem
  for (const raw of ['"subject"', '{', '5']) {
    await page.evaluate(([k, v]) => window.localStorage.setItem(k, v), [STORE, raw])
    await page.reload()
    await page.locator('#vault-unlock').fill(MASTER).catch(() => {})
    if (await page.locator('#vault-unlock').count()) await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
    await page.locator('.msg-row').first().waitFor({ timeout: 30_000 })
    s = await search(page, 'kazanfutes')
    check(`stored ${raw}: by date`, s.chip === chipSays('date') && JSON.stringify(s.subjects) === JSON.stringify(DATE_ORDER), JSON.stringify(s))
    await leave(page)
  }
  await app.close()
  app = null
} catch (err) {
  check('the run finished', false, err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : String(err))
} finally {
  if (app) await app.close().catch(() => {})
}
const logFile = path.join(dataDir, 'electron', 'logs', 'main.log')
const mainLog = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : ''
check('main.log: no word of the choice and no error line', !/searchSort|relevance|kazanfutes/i.test(mainLog) && !/error|failed/i.test(mainLog), mainLog.split('\n').filter(l => /searchSort|relevance|kazanfutes|error|failed/i.test(l)).slice(0, 3).join(' | '))
check('no renderer console error or warning', consoleProblems.length === 0, consoleProblems.slice(0, 3).join(' | '))
fs.rmSync(work, { recursive: true, force: true })
console.log(`\n${results.filter(Boolean).length} / ${results.length} OK`)
process.exit(results.every(Boolean) ? 0 : 1)
