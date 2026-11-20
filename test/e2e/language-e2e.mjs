#!/usr/bin/env node
// The interface language in the real app, headless Electron + Playwright. Not part of `npm test`.
//
//   node test/e2e/language-e2e.mjs
//
// 1. A data folder from before the language setting (no data/ui.json), started with an English system locale: the app
//    is Hungarian (the system language does not count), and nothing is written.
// 2. Beállítások / Megjelenés -> English with an open composer holding unsaved text: the draft is saved and the composer
//    closes, the window reloads in English on the same tab, the vault stays open; samples of the interface (header,
//    settings, list count, list date in en-GB, the lock screen and an error message) are English; the saved draft opens
//    again with the same fields, byte for byte.
// 3. After a restart the choice stays.
// 4. Back to Magyar: everything Hungarian again, after a restart too.
// The main log has no error line, the renderer console no error or warning.
// Playwright: PW=<path of the playwright package> (default: the repo's playwright-core devDependency).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { FakePop3Server } from '../helpers/fake-pop3.js'
import { createVaultedDatabase } from '../../core/vault/vaulted-db.js'
import { AccountStore } from '../../core/accounts/model.js'
import { newAccountDefaults } from '../../core/accounts/defaults.js'
import { hu } from '../../app/renderer/i18n/hu.js'
import { en } from '../../app/renderer/i18n/en.js'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const MASTER = 'Teszt-mesterjelszo-nyelv'
const now = new Date()
// a day of this year that is not today (the list shows it as day + month): 5 March, or 5 October in the first months
const spring = new Date(now.getFullYear(), now.getMonth() >= 4 ? 2 : 9, 5, 10, 0, 0)
if (spring > now) spring.setFullYear(now.getFullYear() - 1) // only in January to early March: the full date form then
const SPRING_SUBJECT = 'Tavaszi levél'

const server = await new FakePop3Server().listen()
server.add(Buffer.from(`From: f1@example.invalid\r\nSubject: Mai levél\r\nDate: ${new Date(now.getTime() - 60_000).toUTCString()}\r\n\r\nszöveg 1\r\n`))
server.add(Buffer.from(`From: f2@example.invalid\r\nSubject: =?UTF-8?Q?Tavaszi_lev=C3=A9l?=\r\nDate: ${spring.toUTCString()}\r\n\r\nszöveg 2\r\n`))
server.add(Buffer.from(`From: f3@example.invalid\r\nSubject: Harmadik\r\nDate: ${new Date(now.getTime() - 120_000).toUTCString()}\r\n\r\nszöveg 3\r\n`))
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-lang-e2e-'))
const dataDir = path.join(work, 'data')
fs.mkdirSync(dataDir)
{
  const { db, vault } = await createVaultedDatabase(dataDir, MASTER)
  const store = new AccountStore(db, vault, { storeDir: path.join(dataDir, 'store') })
  store.save({ ...newAccountDefaults('pop3'), name: 'Nyelv-fiók', email: 'n@example.invalid', in_host: '127.0.0.1', in_port: server.port, in_security: 'none', in_user: server.user, in_password: server.pass, smtp_host: '127.0.0.1', smtp_port: 1, smtp_security: 'none' })
  db.close()
}
const uiFile = path.join(dataDir, 'ui.json')
const uiJson = () => (fs.existsSync(uiFile) ? fs.readFileSync(uiFile, 'utf8').trim() : null)

const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const consoleLines = []
// an English system: the environment and Chromium's own switch (app.getLocale() follows them)
const englishEnv = { ...process.env, SHADOWMAIL_DATA: dataDir, LANG: 'en_US.UTF-8', LANGUAGE: 'en_US', LC_ALL: 'en_US.UTF-8' }
const launch = async () => {
  const app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu', '--lang=en-US'], cwd: repo, env: englishEnv })
  const page = await app.firstWindow()
  page.on('console', m => (m.type() === 'error' || m.type() === 'warning') && consoleLines.push(`${m.type()}: ${m.text()}`))
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.locator('#vault-unlock').waitFor({ timeout: 20_000 })
  return { app, page }
}
const unlock = async (page, t) => {
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  await page.getByRole('button', { name: t.viewSettings, exact: true }).waitFor({ timeout: 20_000 })
}
const pageLang = page => page.evaluate(() => document.documentElement.lang)
// Beállítások / Megjelenés, the language menu, the option: the window reloads (the page object stays)
const chooseLanguage = async (page, from, to, label) => {
  await page.getByRole('button', { name: from.viewSettings, exact: true }).click()
  await page.locator('.settings-tab', { hasText: from.settingsNav.appearance }).click()
  await page.locator('#ui-language').click()
  await page.getByRole('menuitemradio', { name: label }).or(page.getByRole('menuitem', { name: label })).first().click()
  await page.waitForFunction(lang => document.documentElement.lang === lang && document.querySelector('header.app-header'), to, { timeout: 20_000 })
}
const settingsTabs = page => page.locator('.settings-tab').allInnerTexts()
// the tabs in the interface's order (App.jsx: Labels after Appearance), not the dictionary's key order
const TAB_ORDER = ['accounts', 'appearance', 'labels', 'security', 'claude', 'about']
const tabNames = dict => TAB_ORDER.map(k => dict.settingsNav[k])

let app = null
try {
  // 1. no ui.json, English system
  let page
  ;({ app, page } = await launch())
  const sysLocale = await app.evaluate(({ app: a }) => a.getLocale())
  check('the system locale of the run is English', /^en/.test(sysLocale), sysLocale)
  check('without data\\ui.json the lock screen is Hungarian', (await pageLang(page)) === 'hu' && (await page.getByRole('button', { name: hu.vaultUnlockButton, exact: true }).count()) === 1 && (await page.locator('.lock-card').innerText()).includes(hu.vaultUnlockHeading))
  await unlock(page, hu)
  await page.locator('.list-count[data-total="3"]').waitFor({ timeout: 20_000 })
  check('unlocked: the interface is Hungarian', (await page.getByRole('button', { name: hu.newMessage, exact: true }).count()) === 1 && (await page.locator('.list-count').getAttribute('title')) === hu.listCount(3))
  check('starting writes no ui.json', uiJson() === null, String(uiJson()))

  // 2. an open composer with unsaved text, then English
  const [win] = await Promise.all([app.waitForEvent('window', { timeout: 15_000 }), page.getByRole('button', { name: hu.newMessage, exact: true }).click()])
  await win.setViewportSize({ width: 900, height: 700 })
  await win.waitForFunction(() => document.querySelector('#compose-from')?.textContent.trim())
  await win.locator('#compose-to').fill('Címzett Árpád <cimzett@example.invalid>')
  await win.locator('#compose-subject').fill('Nyelvváltás előtt: árvíztűrő 🙂')
  await win.locator('.editor').click()
  await win.keyboard.type('Ez a szöveg még nincs mentve: tükörfúrógép.')
  const before = await win.evaluate(() => ({ to: document.querySelector('#compose-to').value, subject: document.querySelector('#compose-subject').value, html: document.querySelector('.editor').innerHTML }))
  const closed = win.waitForEvent('close', { timeout: 20_000 })
  await chooseLanguage(page, hu, 'en', en.languageOptions.en)
  await closed
  check('the composer closed (its draft saved first)', win.isClosed())
  check('data\\ui.json holds the choice', uiJson() === '{"language":"en"}', String(uiJson()))
  check('after the reload: Beállítások / Megjelenés again, the vault still open', (await page.locator('.settings-appearance').count()) === 1 && (await page.locator('#vault-unlock').count()) === 0 && (await page.locator('.settings-tab[aria-current="page"]').innerText()) === en.settingsNav.appearance)
  check('the language menu shows English', (await page.locator('#ui-language').innerText()).trim() === en.languageOptions.en)
  check('the settings menu is English', JSON.stringify(await settingsTabs(page)) === JSON.stringify(tabNames(en)), JSON.stringify(await settingsTabs(page)))
  check('header buttons are English', (await page.getByRole('button', { name: en.viewSettings, exact: true }).count()) === 1 && (await page.getByRole('button', { name: en.vaultLockButton, exact: true }).count()) === 1 && (await page.getByRole('button', { name: en.viewContacts, exact: true }).count()) === 1)
  await page.getByRole('button', { name: en.backToMail }).click()
  await page.locator('.list-count[data-total="3"]').waitFor({ timeout: 20_000 })
  check('the list count is English', (await page.locator('.list-count').getAttribute('title')) === en.listCount(3), await page.locator('.list-count').getAttribute('title'))
  const springRow = page.locator('[role="row"]', { hasText: SPRING_SUBJECT })
  const wantDate = new Intl.DateTimeFormat('en-GB', spring.getFullYear() === now.getFullYear() ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: '2-digit', day: '2-digit' }).format(spring)
  const gotDate = (await springRow.locator('.col-date').innerText()).trim()
  check('the list date is en-GB', gotDate === wantDate, `${gotDate} (want ${wantDate})`)
  check('the new-message button is English', (await page.getByRole('button', { name: en.newMessage, exact: true }).count()) === 1)

  // the saved draft opens again (the IPC Claude's draft notice uses), its fields byte for byte
  const draft = await page.evaluate(async () => {
    const acc = (await window.shadowMail.mail.folders()).accounts[0]
    const res = await window.shadowMail.mail.list({ accountId: acc.id, folder: 'Drafts' })
    return res.ok ? res.rows.map(r => ({ id: r.id, subject: r.subject })) : null
  })
  check('one draft, with the typed subject', draft && draft.length === 1 && draft[0].subject === before.subject, JSON.stringify(draft))
  if (draft && draft.length === 1) {
    const [again] = await Promise.all([app.waitForEvent('window', { timeout: 15_000 }), page.evaluate(id => window.shadowMail.compose.open({ mode: 'draft', messageId: id }), draft[0].id)])
    await again.setViewportSize({ width: 900, height: 700 })
    await again.waitForFunction(() => document.querySelector('#compose-subject')?.value)
    const after = await again.evaluate(() => ({ to: document.querySelector('#compose-to').value, subject: document.querySelector('#compose-subject').value, html: document.querySelector('.editor').innerHTML }))
    check('the reopened draft: recipient, subject and body the same', JSON.stringify(after) === JSON.stringify(before), `${JSON.stringify(after)} vs ${JSON.stringify(before)}`)
    check('the reopened composer is English', (await again.getByRole('button', { name: en.composeSend, exact: true }).count()) === 1 && (await pageLang(again)) === 'en')
    await Promise.all([again.waitForEvent('close', { timeout: 10_000 }), app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.getTitle() !== 'ShadowMail' && !w.isDestroyed()).destroy())])
  }

  // the lock screen and an error message
  await page.getByRole('button', { name: en.vaultLockButton, exact: true }).click()
  await page.locator('#vault-unlock').waitFor({ timeout: 15_000 })
  check('the lock screen is English', (await page.locator('.lock-card').innerText()).includes(en.vaultUnlockHeading) && (await page.getByRole('button', { name: en.vaultUnlockButton, exact: true }).count()) === 1)
  await page.locator('#vault-unlock').fill('Rossz-jelszo-1234')
  await page.getByRole('button', { name: en.vaultUnlockButton, exact: true }).click()
  await page.locator('.lock-card [role="alert"], .lock-card .error').first().waitFor({ timeout: 10_000 })
  const wrong = await page.locator('.lock-card').innerText()
  check('an error message is English', wrong.includes(en.vaultErrors.wrong_password) && !wrong.includes(hu.vaultErrors.wrong_password), wrong.replace(/\s+/g, ' ').slice(0, 200))
  await unlock(page, en)
  await app.close()
  app = null

  // 3. after a restart the choice stays
  ;({ app, page } = await launch())
  check('after a restart: English before the unlock', (await pageLang(page)) === 'en' && (await page.locator('.lock-card').innerText()).includes(en.vaultUnlockHeading))
  await unlock(page, en)
  check('after a restart: English after the unlock', (await page.getByRole('button', { name: en.newMessage, exact: true }).count()) === 1)

  // 4. back to Hungarian
  await chooseLanguage(page, en, 'hu', en.languageOptions.hu)
  check('back to Magyar: data\\ui.json says hu', uiJson() === '{"language":"hu"}', String(uiJson()))
  check('back to Magyar: the settings menu is Hungarian', JSON.stringify(await settingsTabs(page)) === JSON.stringify(tabNames(hu)))
  check('back to Magyar: header buttons are Hungarian', (await page.getByRole('button', { name: hu.viewSettings, exact: true }).count()) === 1 && (await page.getByRole('button', { name: hu.vaultLockButton, exact: true }).count()) === 1)
  await page.getByRole('button', { name: hu.backToMail }).click()
  await page.locator('.list-count[data-total="3"]').waitFor({ timeout: 20_000 })
  const huDate = new Intl.DateTimeFormat('hu-HU', spring.getFullYear() === now.getFullYear() ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: '2-digit', day: '2-digit' }).format(spring)
  check('back to Magyar: list count and date', (await page.locator('.list-count').getAttribute('title')) === hu.listCount(3) && (await page.locator('[role="row"]', { hasText: SPRING_SUBJECT }).locator('.col-date').innerText()).trim() === huDate)
  await app.close()
  app = null
  ;({ app, page } = await launch())
  check('back to Magyar: after a restart Hungarian', (await pageLang(page)) === 'hu' && (await page.getByRole('button', { name: hu.vaultUnlockButton, exact: true }).count()) === 1)
  await app.close()
  app = null
} catch (err) {
  check('the run finished', false, err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : String(err))
} finally {
  if (app) await app.close().catch(() => {})
  await server.close()
}
const mainLog = fs.readFileSync(path.join(dataDir, 'electron', 'logs', 'main.log'), 'utf8')
check('the main log: the two changes are logged', (mainLog.match(/ui language: (en|hu)/g) || []).join(',') === 'ui language: en,ui language: hu')
check('the main log: no error or failure line', !/failed|error/i.test(mainLog), mainLog.trim().split('\n').filter(l => /failed|error/i.test(l)).join(' | '))
check('no renderer console error or warning', consoleLines.length === 0, consoleLines.slice(0, 3).join(' | '))
fs.rmSync(work, { recursive: true, force: true })
console.log(`\n${results.filter(Boolean).length} / ${results.length} OK`)
process.exit(results.every(Boolean) ? 0 : 1)
