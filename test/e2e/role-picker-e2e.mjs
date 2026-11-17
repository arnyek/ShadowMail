// SPDX-License-Identifier: GPL-3.0-or-later
// The role picker in the real app (headless Electron + Playwright): Beállítások / Fiókok / a saved IMAP account: five
// role selects; "Automatic" names the folder the usual rule gives; choosing a folder is stored at once (the sidebar data
// carries role + role_manual, the old holder loses the role); it survives a restart; "Automatic" undoes it.
// Data: test/tools/seed-index.mjs (a dummy IMAP account at 127.0.0.1:1, nothing leaves the machine; its sync fails,
// which is fine: the choice is local).
// Needs a fresh renderer build first: npx vite build
//
//   node test/e2e/role-picker-e2e.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { t, seedLanguage } from './lang.mjs'
import { assignRoles } from '../../core/imap/folders.js'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-role-picker-e2e-'))
const dataDir = path.join(work, 'data')
const seed = JSON.parse(execFileSync(process.execPath, [path.join(repo, 'test', 'tools', 'seed-index.mjs'), dataDir, '--count', '5'], { encoding: 'utf8' }))
seedLanguage(dataDir)

const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const problems = []
const R = t.folderRolePicker

let app = null
const launch = async () => {
  app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
  const page = await app.firstWindow()
  page.on('console', m => m.type() === 'error' && !/ERR_CONNECTION_REFUSED|connect ECONNREFUSED/.test(m.text()) && problems.push(m.text()))
  page.on('pageerror', e => problems.push(e.message))
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.locator('#vault-unlock').fill(seed.master)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  await page.getByRole('button', { name: t.viewSettings, exact: true }).waitFor({ timeout: 20_000 })
  return page
}
const openEditor = async page => {
  await page.getByRole('button', { name: t.viewSettings, exact: true }).click()
  await page.locator('.settings-tab', { hasText: t.settingsNav.accounts }).click()
  await page.getByRole('button', { name: t.accountEdit, exact: true }).first().click()
  await page.locator('form.account-editor fieldset.folder-roles').waitFor()
}
const folderData = page => page.evaluate(async () => (await window.shadowMail.mail.folders()).accounts[0].folders.map(f => ({ path: f.path, delimiter: f.delimiter, special_use: f.special_use, role: f.role, role_manual: f.role_manual })))
const rolesOf = rows => Object.fromEntries([...assignRoles(rows)].map(([p, r]) => [r, p]))
const pick = async (page, role, label) => {
  await page.locator(`#acc-role-${role}`).click()
  await page.locator('.menu [role^="menuitem"], .menu [role="option"]', { hasText: label }).filter({ hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }).first().click()
  await page.waitForTimeout(300)
}

try {
  let page = await launch()
  await openEditor(page)
  const roles = await page.locator('fieldset.folder-roles .folder-role').evaluateAll(els => els.map(e => e.dataset.role))
  check('five role selects in the account editor', JSON.stringify(roles) === JSON.stringify(['drafts', 'sent', 'trash', 'junk', 'archive']), JSON.stringify(roles))
  check('Automatic names the folder the usual rule gives (Sent)', (await page.locator('#acc-role-sent').textContent()) === R.autoNow('Sent'), await page.locator('#acc-role-sent').textContent())
  check('no archive folder: plain Automatic', (await page.locator('#acc-role-archive').textContent()) === R.auto)

  await pick(page, 'sent', 'Ügyfelek')
  let rows = await folderData(page)
  const chosen = rows.find(r => r.path === 'Ügyfelek')
  check('chosen: the folder carries the role, pinned', chosen.role === 'sent' && chosen.role_manual === 1, JSON.stringify(chosen))
  check('the roles now: sent = Ügyfelek, the old Sent has none', rolesOf(rows).sent === 'Ügyfelek' && !rows.find(r => r.path === 'Sent').role, JSON.stringify(rolesOf(rows)))
  check('the select shows the chosen folder', (await page.locator('#acc-role-sent').textContent()) === 'Ügyfelek')
  // the sidebar draws the role: back to the mail view, the role folder's label is the role's name
  await page.getByRole('button', { name: t.viewSettings, exact: true }).click()
  await page.waitForTimeout(500)
  // the sidebar draws Ügyfelek as the Sent role folder (its label is the role's name), the old Sent as an ordinary one
  const label = p => page.locator(`.folder-tree .folder[data-path="${p}"]`).first().innerText().then(x => x.split('\n')[0].trim())
  const chosenLabel = await label('Ügyfelek')
  const oldLabel = await label('Sent')
  check('the sidebar: Ügyfelek is drawn as the Sent role folder, the old Sent by its own name', chosenLabel === t.folderRoles.sent && oldLabel === 'Sent', JSON.stringify({ chosenLabel, oldLabel }))

  // restart: the choice is in the database
  await app.close()
  page = await launch()
  await openEditor(page)
  check('after a restart the choice is still there', (await page.locator('#acc-role-sent').textContent()) === 'Ügyfelek')

  await pick(page, 'sent', R.auto)
  rows = await folderData(page)
  check('Automatic: nothing pinned, the usual rule again (Sent)', rows.every(r => !r.role_manual) && rolesOf(rows).sent === 'Sent', JSON.stringify(rolesOf(rows)))
  check('the select shows Automatic with the folder', (await page.locator('#acc-role-sent').textContent()) === R.autoNow('Sent'))

  const log = fs.readFileSync(path.join(dataDir, 'electron', 'logs', 'main.log'), 'utf8')
  check('main.log: the role, never the folder name', /folder role sent chosen/.test(log) && /folder role sent automatic/.test(log) && !/Ügyfelek/.test(log))
  check('no console error, no page error', problems.length === 0, JSON.stringify(problems.slice(0, 3)))
} finally {
  if (app) await app.close().catch(() => {})
  fs.rmSync(work, { recursive: true, force: true })
}
const ok = results.filter(Boolean).length
console.log(`${ok} / ${results.length} OK`)
process.exit(ok === results.length ? 0 : 1)
