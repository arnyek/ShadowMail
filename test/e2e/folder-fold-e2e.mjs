#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Folding a folder's subfolders away in the real app (headless Electron + Playwright). Not part of `npm test`.
//
//   node test/e2e/folder-fold-e2e.mjs            (E2E_LANG=en|hu, E2E_THEME=<id>: classic-blue is the compact density)
//
// A POP3 account (fake POP3 server) with local folders "Ügyfelek", "Ügyfelek/Bp", "Ügyfelek/Bp/2024" and "alma"; two
// unread messages moved into Ügyfelek/Bp and one into Ügyfelek/Bp/2024. Measured: a toggle only on the folders with
// children, at least 24 x 24 px and left of the folder's icon; a click folds the subtree away and the parent's count is
// its own plus the hidden ones; a click on the folder itself still selects it; the fold stays after a restart; Enter
// on the focused toggle unfolds; a folded parent of the selected folder is marked faintly; the sidebar folded to icons
// shows every folder and no toggle.
// Playwright: PW=<path of the playwright package> (default: the repo's playwright-core devDependency).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { FakePop3Server } from '../helpers/fake-pop3.js'
import { MailIndex } from '../../core/db/mail-index.js'
import { createVaultedDatabase } from '../../core/vault/vaulted-db.js'
import { AccountStore } from '../../core/accounts/model.js'
import { newAccountDefaults } from '../../core/accounts/defaults.js'
import { t, seedLanguage } from './lang.mjs'
import { useTheme, e2eTheme } from './theme-env.mjs'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const MASTER = 'Teszt-mesterjelszo-almappak'
const sleep = ms => new Promise(r => setTimeout(r, ms))

const server = await new FakePop3Server().listen()
for (let i = 1; i <= 4; i++) server.add(Buffer.from(`From: f@example.invalid\r\nSubject: POP ${i}\r\nDate: ${new Date(Date.now() - i * 60_000).toUTCString()}\r\n\r\nszöveg\r\n`))
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-fold-e2e-'))
const dataDir = path.join(work, 'data')
fs.mkdirSync(dataDir)
seedLanguage(dataDir)
let pop
{
  const { db, vault } = await createVaultedDatabase(dataDir, MASTER)
  const store = new AccountStore(db, vault, { storeDir: path.join(dataDir, 'store') })
  const base = { smtp_host: '127.0.0.1', smtp_port: 1, smtp_security: 'none', in_security: 'none', in_host: '127.0.0.1' }
  pop = store.save({ ...newAccountDefaults('pop3'), ...base, name: 'Első fiók', email: 'p@example.invalid', in_port: server.port, in_user: server.user, in_password: server.pass }).account.id
  const index = new MailIndex(db)
  for (const p of ['Ügyfelek', 'Ügyfelek/Bp', 'Ügyfelek/Bp/2024', 'alma']) index.addFolder(pop, p, '/', true)
  db.close()
}

const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const problems = []
const quits = () => server.log.filter(l => l === 'QUIT').length
const sec = `.folder-tree section[data-account="${pop}"]`
const folderSel = p => `${sec} .folder[data-path="${p}"]`
const toggleOf = (page, p) => page.locator(`${sec} li`, { has: page.locator(`.folder[data-path="${p}"]`) }).locator('.folder-fold')
const shown = page => page.$$eval(`${sec} .folder[data-path]`, els => els.map(e => e.dataset.path))
const until = async (fn, what, ms = 8000) => {
  const t0 = performance.now()
  while (!(await fn())) {
    if (performance.now() - t0 > ms) throw new Error(`timed out: ${what}`)
    await sleep(50)
  }
}

async function start() {
  const app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
  const page = await app.firstWindow()
  page.on('console', m => m.type() === 'error' && !/ERR_CONNECTION_REFUSED|connect ECONNREFUSED/.test(m.text()) && problems.push(m.text()))
  page.on('pageerror', e => problems.push(e.message))
  await page.setViewportSize({ width: 1280, height: 900 })
  await useTheme(app, page)
  const before = quits()
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  await page.locator(folderSel('INBOX')).waitFor({ timeout: 20_000 })
  await until(() => quits() > before, 'a POP3 fetch', 20_000)
  return { app, page }
}

let app
try {
  let page
  ;({ app, page } = await start())
  // two unread into Ügyfelek/Bp, one into Ügyfelek/Bp/2024
  const ids = await page.evaluate(async q => (await window.shadowMail.mail.list(q)).rows.map(r => r.id), { accountId: pop, folder: 'INBOX', sort: 'date', dir: 'desc', offset: 0, limit: 10 })
  const move = (list, target) => page.evaluate(q => window.shadowMail.mail.action(q), { ids: list, action: 'move', target })
  check('moved into the subfolders', (await move(ids.slice(0, 2), 'Ügyfelek/Bp')).ok && (await move(ids.slice(2, 3), 'Ügyfelek/Bp/2024')).ok)
  await until(async () => (await page.locator(`${folderSel('Ügyfelek/Bp')} .unread-badge`).count()) === 1, 'the Bp count')

  // 1. toggles only on the parents, their size and place
  const parents = await page.$$eval(`${sec} li`, lis => lis.filter(li => li.querySelector('.folder-fold')).map(li => li.querySelector('.folder').dataset.path))
  check('a toggle on Ügyfelek and Ügyfelek/Bp only', JSON.stringify(parents) === JSON.stringify(['Ügyfelek', 'Ügyfelek/Bp']), JSON.stringify(parents))
  for (const p of ['Ügyfelek', 'Ügyfelek/Bp']) {
    const tb = await toggleOf(page, p).boundingBox()
    const ib = await page.locator(`${folderSel(p)} .icon`).first().boundingBox()
    check(`${p}: the toggle is >= 24 x 24 and left of the icon`, tb.width >= 24 && tb.height >= 24 && tb.x + tb.width <= ib.x + 0.5, `${JSON.stringify(tb)} icon x ${ib.x}${e2eTheme ? ` (${e2eTheme})` : ''}`)
  }

  // 2. fold (with Ügyfelek/Bp selected): the subtree goes, the count is 0 + 2 + 1, the parent marks the hidden selection
  await page.locator(folderSel('Ügyfelek/Bp')).click()
  await toggleOf(page, 'Ügyfelek').click()
  await until(async () => !(await shown(page)).includes('Ügyfelek/Bp'), 'Bp hidden')
  const after = await shown(page)
  check('folded: Bp and 2024 hidden, Ügyfelek and alma shown', !after.some(p => p.startsWith('Ügyfelek/')) && after.includes('Ügyfelek') && after.includes('alma'), JSON.stringify(after))
  const badge = page.locator(`${folderSel('Ügyfelek')} .unread-badge`)
  check('folded: the count is the hidden ones (3)', (await badge.innerText()).trim() === '3' && (await badge.getAttribute('aria-label')) === t.unreadCountFolded(3))
  check('folded: the parent marks the hidden selected folder', await page.locator(folderSel('Ügyfelek')).evaluate(e => e.classList.contains('holds-selected')))
  check('folded: the list still shows the selected folder (no switch)', (await page.locator('.msg-row', { hasText: 'POP' }).count()) === 2)
  check('folded: aria-expanded false, the label says show', (await toggleOf(page, 'Ügyfelek').getAttribute('aria-expanded')) === 'false' && (await toggleOf(page, 'Ügyfelek').getAttribute('aria-label')) === t.folderFoldShow('Ügyfelek'))

  // 3. a click on the folder itself selects it, the fold stays
  await page.locator(folderSel('Ügyfelek')).click()
  check('a click on the folder selects it; the mark goes', (await page.locator(folderSel('Ügyfelek')).getAttribute('aria-current')) === 'true' && !(await page.locator(folderSel('Ügyfelek')).evaluate(e => e.classList.contains('holds-selected'))))
  check('and does not unfold', !(await shown(page)).includes('Ügyfelek/Bp'))

  // 4. after a restart still folded
  await app.close()
  ;({ app, page } = await start())
  check('after a restart: still folded', !(await shown(page)).includes('Ügyfelek/Bp') && (await toggleOf(page, 'Ügyfelek').getAttribute('aria-expanded')) === 'false')

  // 5. Enter on the focused toggle unfolds
  await toggleOf(page, 'Ügyfelek').focus()
  await page.keyboard.press('Enter')
  await until(async () => (await shown(page)).includes('Ügyfelek/Bp/2024'), 'unfolded')
  check('Enter unfolds; the count is the own one again', (await page.locator(`${folderSel('Ügyfelek')} .unread-badge`).count()) === 0)
  check('the focus stays on the toggle', await toggleOf(page, 'Ügyfelek').evaluate(e => e === document.activeElement))

  // 6. the sidebar folded to icons: every folder, no toggle (fold Bp first: it must show anyway)
  await toggleOf(page, 'Ügyfelek/Bp').click()
  await until(async () => !(await shown(page)).includes('Ügyfelek/Bp/2024'), 'Bp folded')
  await page.getByRole('button', { name: t.sidebarCollapse, exact: true }).click()
  await until(async () => (await shown(page)).includes('Ügyfelek/Bp/2024'), 'all folders on the icon bar')
  check('icon bar: no toggle', (await page.locator(`${sec} .folder-fold`).count()) === 0)
  await page.getByRole('button', { name: t.sidebarExpand, exact: true }).click()
  await until(async () => !(await shown(page)).includes('Ügyfelek/Bp/2024'), 'Bp folded again')
  check('unfolded sidebar: Bp folded again', true)

  check('no console error', problems.length === 0, problems.join(' | '))
} catch (err) {
  check('run', false, err.stack)
} finally {
  if (app) await app.close().catch(() => {})
  await server.close()
  fs.rmSync(work, { recursive: true, force: true })
}
console.log(`\n${results.filter(Boolean).length} / ${results.length} OK`)
process.exit(results.every(Boolean) ? 0 : 1)
