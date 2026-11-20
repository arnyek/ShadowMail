#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Settings / Labels in the real app: headless Electron + Playwright. Not part of `npm test`.
//
//   E2E_LANG=hu|en node test/e2e/labels-settings-e2e.mjs [--shots <dir>]
//
// A POP3 account (fake POP3 server) with two downloaded messages. Measured: the picker's "Manage labels…" opens the
// tab; a label made in the tab; renamed in place (the same id, the messages keep it, the list chip follows); a name
// taken in another case is a field error and changes nothing; a new color (the list chip follows); up / down; delete
// asks with the real number of messages, Cancel changes nothing, Delete takes it off them; the empty state; the tab
// is out of reach while locked; the page console and main.log stay clean, the POP3 server hears nothing meanwhile.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { FakePop3Server } from '../helpers/fake-pop3.js'
import { createVaultedDatabase } from '../../core/vault/vaulted-db.js'
import { AccountStore } from '../../core/accounts/model.js'
import { newAccountDefaults } from '../../core/accounts/defaults.js'
import { t, seedLanguage } from './lang.mjs'

const { values } = parseArgs({ options: { shots: { type: 'string' } } })
const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const MASTER = 'Teszt-mesterjelszo-cimke-beallitas'
const now = Date.now()
const sleep = ms => new Promise(r => setTimeout(r, ms))

const server = await new FakePop3Server().listen()
for (const [i, s] of [[1, 'Első levél'], [2, 'Második levél']]) {
  server.add(Buffer.from(`From: f${i}@example.invalid\r\nTo: p@example.invalid\r\nSubject: =?UTF-8?B?${Buffer.from(s).toString('base64')}?=\r\nMessage-ID: <set${i}@example.invalid>\r\nDate: ${new Date(now - i * 60_000).toUTCString()}\r\n\r\nszöveg ${i}\r\n`))
}
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-labels-settings-e2e-'))
const dataDir = path.join(work, 'data')
fs.mkdirSync(dataDir)
seedLanguage(dataDir)
let pop
{
  const { db, vault } = await createVaultedDatabase(dataDir, MASTER)
  const store = new AccountStore(db, vault, { storeDir: path.join(dataDir, 'store') })
  pop = store.save({ ...newAccountDefaults('pop3'), smtp_host: '127.0.0.1', smtp_port: 1, smtp_security: 'none', in_security: 'none', in_host: '127.0.0.1', name: 'POP3-fiók', email: 'p@example.invalid', in_port: server.port, in_user: server.user, in_password: server.pass }).account.id
  db.close()
}

const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const mainLog = path.join(dataDir, 'electron', 'logs', 'main.log')
const consoleLines = []
const quits = () => server.log.filter(l => l === 'QUIT').length
const api = (page, group, method, ...args) => page.evaluate(([g, m, a]) => window.shadowMail[g][m](...a), [group, method, args])
const until = async (fn, what, tries = 100) => {
  for (let i = 0; i < tries; i++) {
    if (await fn()) return true
    await sleep(50)
  }
  throw new Error(`timed out: ${what}`)
}

let app = null
try {
  app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
  const page = await app.firstWindow()
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') consoleLines.push(`${m.type()}: ${m.text()}`) })
  await page.setViewportSize({ width: 1280, height: 860 })
  const before = quits()
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  await page.locator(`.folder-tree section[data-account="${pop}"] .folder[data-path="INBOX"]`).click({ timeout: 20000 })
  for (let i = 0; quits() === before; i++) {
    if (i > 400) throw new Error('the first POP3 fetch did not end')
    await sleep(50)
  }
  const logAt = server.log.length
  const row = subject => page.locator('.msg-row', { hasText: subject })
  await until(async () => (await page.locator('.msg-row[data-id]').count()) === 2, 'two rows', 300)
  const first = Number(await row('Első levél').getAttribute('data-id'))
  const seed = await api(page, 'labels', 'create', 'Számla', '#d32f2f')
  await api(page, 'mail', 'label', { ids: [first], add: [seed.label.id] })
  await until(async () => (await row('Első levél').locator('.label-chip').count()) === 1, 'the seed chip')

  // 1. the picker's "Manage labels…" opens the tab
  await row('Első levél').click({ button: 'right' })
  await page.getByRole('menuitem', { name: t.labels.menuItem, exact: true }).click()
  await page.getByRole('button', { name: t.labels.manage, exact: true }).click()
  await page.locator('.labels-settings').waitFor()
  check('the picker\'s "Manage labels…" opens Settings / Labels', (await page.locator('.labels-row').count()) === 1 && !(await page.locator('.label-picker').count()))
  const rowOf = id => page.locator(`.labels-row[data-label-id="${id}"]`)
  check('the row: the number of messages', (await rowOf(seed.label.id).locator('.labels-count').textContent()) === t.labelsPage.count(1))

  // 2. a new label from the tab
  await page.locator('.labels-add').click()
  await page.locator('.labels-new-name input').fill('Ügyfél')
  await page.locator('.labels-create').click()
  await until(async () => (await page.locator('.labels-row').count()) === 2, 'the new row')
  const listed = (await api(page, 'labels', 'list')).labels
  const client = listed.find(l => l.name === 'Ügyfél')
  check('New label: made, at the end of the list', Boolean(client) && listed.at(-1).id === client.id)

  // 3. rename in place: the same id, the messages keep it
  const nameInput = rowOf(seed.label.id).locator('.labels-name')
  await nameInput.fill('Számlák')
  await nameInput.press('Enter')
  await until(async () => (await api(page, 'labels', 'list')).labels.some(l => l.id === seed.label.id && l.name === 'Számlák'), 'the rename')
  const kept = (await api(page, 'mail', 'list', { accountId: pop, folder: 'INBOX' })).rows.find(r => r.id === first)
  check('rename: the same label id, the message keeps it', JSON.stringify(kept.labels) === JSON.stringify([seed.label.id]))

  // 4. a name taken in another case: a field error, nothing changes
  const clientInput = rowOf(client.id).locator('.labels-name')
  await clientInput.fill('számlák')
  await clientInput.press('Enter')
  await rowOf(client.id).locator('.labels-row-error').waitFor()
  check('a taken name in another case: the field error', (await rowOf(client.id).locator('.labels-row-error').textContent()) === t.labels.error('name_taken'))
  check('… and nothing changed', (await api(page, 'labels', 'list')).labels.find(l => l.id === client.id).name === 'Ügyfél')
  await clientInput.press('Escape')

  // 5. a new color
  await rowOf(seed.label.id).locator('.labels-color').fill('#00897b')
  await until(async () => (await api(page, 'labels', 'list')).labels.find(l => l.id === seed.label.id).color === '#00897b', 'the color')
  check('the color: stored', true)

  // 6. up / down by keyboard: at the edge the focus goes to the row's other button, never to the page's body
  const focused = () => page.evaluate(() => {
    const el = document.activeElement
    const row = el && el.closest('.labels-row')
    return { tag: el ? el.tagName : null, cls: el ? el.className : '', row: row ? row.dataset.labelId : null }
  })
  await rowOf(client.id).locator('.labels-up').focus()
  await page.keyboard.press('Enter')
  await until(async () => (await page.locator('.labels-row').first().getAttribute('data-label-id')) === String(client.id), 'up by keyboard')
  await sleep(150)
  const atTop = await focused()
  check('by keyboard to the top: Up disabled, the focus on the row\'s Down (not the body)', atTop.row === String(client.id) && /labels-down/.test(atTop.cls), JSON.stringify(atTop))
  await page.keyboard.press('Enter')
  await until(async () => (await page.locator('.labels-row').last().getAttribute('data-label-id')) === String(client.id), 'down by keyboard')
  await sleep(150)
  const atBottom = await focused()
  check('by keyboard to the bottom: the focus on the row\'s Up', atBottom.row === String(client.id) && /labels-up/.test(atBottom.cls), JSON.stringify(atBottom))
  await page.keyboard.press('Enter')
  await until(async () => (await page.locator('.labels-row').first().getAttribute('data-label-id')) === String(client.id), 'up in the page', 100).catch(() => {})
  check('up: the label first in the page and in the stored list', (await page.locator('.labels-row').first().getAttribute('data-label-id')) === String(client.id) && (await api(page, 'labels', 'list')).labels[0].id === client.id)
  check('the first row cannot go up, the last cannot go down', await rowOf(client.id).locator('.labels-up').isDisabled() && await rowOf(seed.label.id).locator('.labels-down').isDisabled())
  if (values.shots) {
    fs.mkdirSync(values.shots, { recursive: true })
    for (const theme of ['default', 'dark']) {
      await page.evaluate(th => (document.documentElement.dataset.theme = th), theme)
      await sleep(250)
      await page.screenshot({ path: path.join(values.shots, `labels-settings-${theme}.png`) })
    }
    await page.evaluate(() => (document.documentElement.dataset.theme = 'default'))
  }

  // 7. the list chip follows the rename and the color
  await page.getByRole('button', { name: t.viewSettings, exact: true }).click()
  await page.locator('.labels-settings').waitFor({ state: 'detached' })
  await until(async () => (await row('Első levél').locator('.label-chip').getAttribute('title')) === 'Számlák', 'the chip follows the rename')
  const bg = await row('Első levél').locator('.label-chip').evaluate(e => getComputedStyle(e).backgroundColor)
  check('the list chip follows the new name and color', bg === 'rgb(0, 137, 123)', bg)

  // 8. a color picked, the tab left at once (inside the 250 ms wait): the color is stored all the same
  await page.getByRole('button', { name: t.viewSettings, exact: true }).click()
  await page.getByRole('button', { name: t.settingsNav.labels, exact: true }).click()
  await rowOf(seed.label.id).locator('.labels-color').fill('#3949ab')
  await page.getByRole('button', { name: t.settingsNav.appearance, exact: true }).click()
  await page.locator('.labels-settings').waitFor({ state: 'detached' })
  await until(async () => (await api(page, 'labels', 'list')).labels.find(l => l.id === seed.label.id).color === '#3949ab', 'the color after the tab switch').catch(() => {})
  check('a color picked and the tab left at once: stored', (await api(page, 'labels', 'list')).labels.find(l => l.id === seed.label.id).color === '#3949ab')
  await page.getByRole('button', { name: t.settingsNav.labels, exact: true }).click()
  check('back on the tab: the new color in the picker', (await rowOf(seed.label.id).locator('.labels-color').inputValue()) === '#3949ab')

  // 9. delete: the real count in the question; Cancel changes nothing; Delete takes it off the message
  await rowOf(seed.label.id).locator('.labels-delete').click()
  await page.locator('.labels-delete-modal').waitFor()
  const text = await page.locator('.labels-delete-modal .confirm-text').textContent()
  check('delete asks with the real number of messages', text === t.labelsPage.deleteText('Számlák', 1), text)
  await page.locator('.labels-delete-cancel').click()
  await sleep(200)
  check('Cancel: nothing changed', (await api(page, 'labels', 'list')).labels.length === 2)
  await rowOf(seed.label.id).locator('.labels-delete').click()
  await page.locator('.labels-delete-yes').click()
  await until(async () => (await page.locator('.labels-row').count()) === 1, 'the row gone')
  const after = (await api(page, 'mail', 'list', { accountId: pop, folder: 'INBOX' })).rows.find(r => r.id === first)
  check('Delete: the label gone, off the message too', JSON.stringify(after.labels) === '[]')
  await rowOf(client.id).locator('.labels-delete').click()
  await page.locator('.labels-delete-yes').click()
  await page.locator('.labels-empty').waitFor()
  check('no label: the empty state with the sentence and New label', (await page.locator('.labels-empty').textContent()) === t.labelsPage.empty && (await page.locator('.labels-add').count()) === 1)

  // 10. locked: the tab is out of reach
  await page.getByRole('button', { name: t.vaultLockButton, exact: true }).click()
  await page.locator('#vault-unlock').waitFor({ timeout: 10000 })
  check('locked: the lock screen, no Settings / Labels', (await page.locator('.labels-settings').count()) === 0 && (await api(page, 'labels', 'list')).error === 'locked')

  check('no command reached the POP3 server meanwhile', server.log.length === logAt, JSON.stringify(server.log.slice(logAt)))
  const failed = fs.existsSync(mainLog) ? fs.readFileSync(mainLog, 'utf8').split('\n').filter(l => /(labels:\w+|mail:label\w*) failed/.test(l)) : []
  check('main.log: no label failure', failed.length === 0, failed.join(' | '))
  check('the page console: no error or warning', consoleLines.length === 0, consoleLines.join(' | '))
} catch (err) {
  check('run', false, err.stack)
} finally {
  if (app) await app.close().catch(() => {})
  await server.close()
  fs.rmSync(work, { recursive: true, force: true })
}
console.log(`\n${results.filter(Boolean).length} / ${results.length} OK`)
process.exit(results.every(Boolean) ? 0 : 1)
