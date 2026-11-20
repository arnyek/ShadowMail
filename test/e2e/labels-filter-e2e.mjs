#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// The Label filter chip in the real app: headless Electron + Playwright. Not part of `npm test`.
//
//   E2E_LANG=hu|en node test/e2e/labels-filter-e2e.mjs [--shots <dir>]
//
// Two POP3 accounts (fake POP3 servers): six messages in the first, three in the second, "Számla" on three of the
// first and one of the second, "Ügyfél" on one. Measured: no label, no chip; the chip's menu (the labels with their
// color); the folder view lists only the labelled, "(szűrve, összesen 6)"; with Unread too; a label taken off in the
// filtered view stays until Frissítés (keepIds); the search with the label: only the labelled hits, in both accounts;
// Esc keeps the label for the folder view; Szűrők törlése takes it off; a label deleted while it filters: the filter
// goes; the page console and main.log stay clean, the POP3 servers hear nothing meanwhile. The chip row at 1280 x 800:
// one line without a label; with the Label chip (off and on) it may wrap, but every chip lies whole
// inside the row, the second line is a full chip line, and the list starts below the row (the heights are printed).
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
const MASTER = 'Teszt-mesterjelszo-cimke-szuro'
const now = Date.now()
const sleep = ms => new Promise(r => setTimeout(r, ms))
const b64 = s => `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`

const FIRST = ['Egy', 'Kettő', 'Három', 'Négy', 'Öt', 'Hat'].map(w => `${w} galagonya`)
const SECOND = ['Másik egy', 'Másik kettő', 'Másik három'].map(w => `${w} galagonya`)
const servers = []
for (const subjects of [FIRST, SECOND]) {
  const server = await new FakePop3Server().listen()
  subjects.forEach((s, i) => server.add(Buffer.from(`From: f${i}@example.invalid\r\nTo: p@example.invalid\r\nSubject: ${b64(s)}\r\nMessage-ID: <flt${servers.length}-${i}@example.invalid>\r\nDate: ${new Date(now - (i + 1) * 60_000).toUTCString()}\r\n\r\ngalagonya ${i}\r\n`)))
  servers.push(server)
}
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-labels-filter-e2e-'))
const dataDir = path.join(work, 'data')
fs.mkdirSync(dataDir)
seedLanguage(dataDir)
const accountIds = []
{
  const { db, vault } = await createVaultedDatabase(dataDir, MASTER)
  const store = new AccountStore(db, vault, { storeDir: path.join(dataDir, 'store') })
  servers.forEach((server, n) => {
    accountIds.push(store.save({ ...newAccountDefaults('pop3'), smtp_host: '127.0.0.1', smtp_port: 1, smtp_security: 'none', in_security: 'none', in_host: '127.0.0.1', name: `POP3-fiók ${n + 1}`, email: `p${n}@example.invalid`, in_port: server.port, in_user: server.user, in_password: server.pass }).account.id)
  })
  db.close()
}

const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const mainLog = path.join(dataDir, 'electron', 'logs', 'main.log')
const consoleLines = []
const quits = s => s.log.filter(l => l === 'QUIT').length
const api = (page, group, method, ...args) => page.evaluate(([g, m, a]) => window.shadowMail[g][m](...a), [group, method, args])
const until = async (fn, what, tries = 200) => {
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
  page.on('pageerror', e => consoleLines.push(`pageerror: ${e}`))
  await page.setViewportSize({ width: 1280, height: 800 })
  const before = servers.map(quits)
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  await page.locator(`.folder-tree section[data-account="${accountIds[0]}"] .folder[data-path="INBOX"]`).click({ timeout: 20000 })
  await until(() => servers.every((s, i) => quits(s) > before[i]), 'both first POP3 fetches', 400)
  let logAt = servers.map(s => s.log.length)
  const row = subject => page.locator('.msg-row[data-id]', { hasText: subject })
  const subjects = async () => (await page.locator('.msg-row[data-id] .col-subject').allInnerTexts()).map(s => s.trim()).sort()
  const waitTotal = (n, folderTotal = null) =>
    page.waitForFunction(([n, ft]) => {
      const c = document.querySelector('.list-count')
      return c && c.dataset.total === String(n) && (ft === null || c.dataset.folderTotal === String(ft))
    }, [n, folderTotal], { timeout: 15000 })
  await waitTotal(6)
  const idOf = async (accountId, subject) => (await api(page, 'mail', 'list', { accountId, folder: 'INBOX', limit: 50 })).rows.find(r => r.subject === subject).id

  // the chip row: its lines, its height, every chip whole inside it, the list header below it
  const chipRow = () => page.evaluate(() => {
    const row = document.querySelector('.search-chips')
    const r = row.getBoundingClientRect()
    const cs = getComputedStyle(row)
    const chips = [...row.querySelectorAll('button.chip')].map(b => b.getBoundingClientRect())
    const lines = [...new Set(chips.map(c => Math.round(c.top)))].sort((a, b) => a - b)
    const chipH = Math.round(Math.max(...chips.map(c => c.height)))
    const inside = chips.every(c => c.left >= r.left - 0.5 && c.right <= r.right + 0.5 && c.top >= r.top - 0.5 && c.bottom <= r.bottom + 0.5)
    const header = document.querySelector('.list-header').getBoundingClientRect()
    const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderBottomWidth)
    const fullLines = Math.round(r.height - pad) >= lines.length * chipH + (lines.length - 1) * parseFloat(cs.rowGap) - 1
    return { lines: lines.length, height: Math.round(r.height), chipH, inside, fullLines, below: header.top >= r.bottom - 0.5, headerTop: Math.round(header.top), width: document.documentElement.clientWidth }
  })
  // 0. no label yet: no Label chip, one chip line
  const filtersButton = page.getByRole('button', { name: t.searchFiltersButton, exact: true })
  await filtersButton.click()
  const chips = page.locator('.search-chips')
  await chips.waitFor()
  check('no label: no Label chip', (await page.locator('.label-filter-chip').count()) === 0)
  const rowNone = await chipRow()
  check('1280 x 800 without a label: one chip line, the list below it', rowNone.width === 1280 && rowNone.lines === 1 && rowNone.inside && rowNone.below, JSON.stringify(rowNone))
  const invoice = (await api(page, 'labels', 'create', 'Számla', '#d32f2f')).label.id
  const client = (await api(page, 'labels', 'create', 'Ügyfél', '#fbc02d')).label.id
  const firstIds = await Promise.all(FIRST.map(s => idOf(accountIds[0], s)))
  const secondIds = await Promise.all(SECOND.map(s => idOf(accountIds[1], s)))
  await api(page, 'mail', 'label', { ids: [firstIds[0], firstIds[1], firstIds[2], secondIds[0]], add: [invoice] })
  await api(page, 'mail', 'label', { ids: [firstIds[3]], add: [client] })
  await page.locator('.label-filter-chip').waitFor()
  check('labels made: the Label chip is there, not active', (await page.locator('.label-filter-chip button.chip').getAttribute('aria-pressed')) === 'false')
  const rowOff = await chipRow()
  check('with the Label chip (off): every chip whole inside the row, full lines, the list moved down below it, no overlap', rowOff.inside && rowOff.fullLines && rowOff.below && rowOff.headerTop - rowNone.headerTop === rowOff.height - rowNone.height, JSON.stringify(rowOff))
  // the order: the Label chip after the on/off chips, before the order chip
  const order = await page.locator('.search-chips').evaluate(el => [...el.querySelectorAll('button.chip')].map(b => (b.closest('.label-filter-chip') ? 'label' : b.closest('.sort-chip') ? 'sort' : b.getAttribute('aria-pressed') !== null && !b.closest('.menu-anchor') ? 'toggle' : 'other')))
  check('the Label chip right after the on/off chips, the order chip last', order.at(-1) === 'sort' && order.at(-2) === 'label' && order.at(-3) === 'toggle', JSON.stringify(order))

  // 1. the menu: "any label" + the labels with their color; the pick filters the folder view
  await page.locator('.label-filter-chip button.chip').click()
  const items = page.locator('.label-filter-chip [role="menuitemradio"]')
  const names = await items.allInnerTexts()
  check('the menu: any label, then the labels in the list order', JSON.stringify(names.map(s => s.trim())) === JSON.stringify([t.searchAnyLabel, 'Számla', 'Ügyfél']), JSON.stringify(names))
  const dot = await items.nth(1).locator('.label-swatch').evaluate(e => getComputedStyle(e).backgroundColor)
  check('the menu item shows the label color', dot === 'rgb(211, 47, 47)', dot)
  if (values.shots) {
    fs.mkdirSync(values.shots, { recursive: true })
    await page.screenshot({ path: path.join(values.shots, 'labels-filter-menu.png') })
  }
  await items.nth(1).click()
  await waitTotal(3, 6)
  check('the folder view: only the three labelled', JSON.stringify(await subjects()) === JSON.stringify(FIRST.slice(0, 3).sort()), JSON.stringify(await subjects()))
  const countText = await page.locator('.list-count').innerText()
  check('the count says filtered, of 6', countText.endsWith(t.listFiltered(6).trim()), countText)
  check('the chip: active, with the label name', (await page.locator('.label-filter-chip button.chip').getAttribute('aria-pressed')) === 'true' && (await page.locator('.label-filter-chip button.chip').innerText()).includes('Számla'))
  const rowOn = await chipRow()
  check('with the Label chip (on): every chip whole inside the row, full lines, the list below it', rowOn.inside && rowOn.fullLines && rowOn.below, JSON.stringify(rowOn))
  console.log(`chip row at 1280 x 800: no label ${rowNone.height} px (${rowNone.lines} line), Label chip off ${rowOff.height} px (${rowOff.lines}), on ${rowOn.height} px (${rowOn.lines}); chip ${rowNone.chipH} px`)

  // 2. with Unread too: one of the three read (through the bridge, not kept)
  await api(page, 'mail', 'action', { ids: [firstIds[1]], action: 'read' })
  await chips.getByRole('button', { name: t.searchFilter.unread, exact: true }).click()
  await waitTotal(2, 6)
  check('Unread + label: the two unread labelled', JSON.stringify(await subjects()) === JSON.stringify([FIRST[0], FIRST[2]].sort()), JSON.stringify(await subjects()))
  await chips.getByRole('button', { name: t.searchFilter.unread, exact: true }).click()
  await waitTotal(3, 6)
  // "Mind" / "All" (the menu's first item) switches the label filter off; then Számla again
  await page.locator('.label-filter-chip button.chip').click()
  const first = page.locator('.label-filter-chip [role="menuitemradio"]').first()
  check('the menu\'s first item: "Mind" / "All"', (await first.innerText()).trim() === t.searchAnyLabel && ['Mind', 'All'].includes(t.searchAnyLabel), await first.innerText())
  await first.click()
  await waitTotal(6, 6)
  check('"Mind": the label filter off, the whole folder', (await page.locator('.label-filter-chip button.chip').getAttribute('aria-pressed')) === 'false')
  await page.locator('.label-filter-chip button.chip').click()
  await page.locator('.label-filter-chip [role="menuitemradio"]').nth(1).click()
  await waitTotal(3, 6)
  if (values.shots) {
    for (const theme of ['default', 'dark']) {
      await page.evaluate(th => (document.documentElement.dataset.theme = th), theme)
      await sleep(250)
      await page.screenshot({ path: path.join(values.shots, `labels-filter-${theme}.png`) })
    }
    await page.evaluate(() => (document.documentElement.dataset.theme = 'default'))
  }

  // 3. the label taken off in the filtered view (the right-click picker): the row stays until Frissítés
  await row(FIRST[2]).click({ button: 'right' })
  await page.getByRole('menuitem', { name: t.labels.menuItem, exact: true }).click()
  await page.locator('.label-picker').waitFor()
  await page.locator(`.label-picker-item[data-label-id="${invoice}"] input`).click()
  await until(async () => JSON.stringify((await api(page, 'mail', 'labelsOf', [firstIds[2]])).labels[firstIds[2]] || []) === '[]', 'the label off')
  await page.keyboard.press('Escape')
  await page.locator('.label-picker').waitFor({ state: 'detached' })
  await sleep(600)
  check('taken off in the filtered view: the row stays (kept), the count with it', (await row(FIRST[2]).count()) === 1 && (await page.locator('.list-count').getAttribute('data-total')) === '3')
  const quitsAt = servers.map(quits)
  check('no command reached the POP3 servers before Frissítés', servers.every((s, i) => s.log.length === logAt[i]))
  await page.getByRole('button', { name: t.refresh, exact: true }).click()
  await waitTotal(2, 6)
  check('Frissítés: the row is gone', (await row(FIRST[2]).count()) === 0)
  // Frissítés is a fetch of every account (its own job): from its end on, the servers hear nothing again
  await until(() => servers.every((s, i) => quits(s) > quitsAt[i]), 'the Frissítés fetches')
  logAt = servers.map(s => s.log.length)

  // 4. the search with the label: only the labelled hits, in both accounts
  const box = page.getByRole('searchbox', { name: t.searchLabel })
  await box.fill('galagonya')
  await page.locator('.result').first().waitFor()
  await until(async () => (await page.locator('.result').count()) === 3, 'three hits')
  const hits = (await page.locator('.result .col-subject').allInnerTexts()).map(s => s.trim()).sort()
  check('search + label: the labelled hits of both accounts only', JSON.stringify(hits) === JSON.stringify([FIRST[0], FIRST[1], SECOND[0]].sort()), JSON.stringify(hits))
  await page.locator('.label-filter-chip button.chip').click()
  await page.locator('.label-filter-chip [role="menuitemradio"]').nth(2).click()
  await until(async () => (await page.locator('.result').count()) === 1, 'one hit')
  check('search + the other label: its one hit', (await page.locator('.result .col-subject').innerText()).trim() === FIRST[3])
  await box.focus()
  await page.keyboard.press('Escape')
  await waitTotal(1, 6)
  check('Esc: the label stays for the folder view', JSON.stringify(await subjects()) === JSON.stringify([FIRST[3]]))

  // 5. Szűrők törlése takes the label off
  await page.getByRole('button', { name: t.clearFilters, exact: true }).first().click()
  await waitTotal(6, 6)
  // no filter left: the chip row closes, as with the other chips; opened again, the Label chip is off
  await filtersButton.click()
  await page.locator('.label-filter-chip').waitFor()
  check('Szűrők törlése: the whole folder, the chip not active', (await page.locator('.label-filter-chip button.chip').getAttribute('aria-pressed')) === 'false')

  // 6. a label deleted while it filters: the filter goes, not an empty list
  await page.locator('.label-filter-chip button.chip').click()
  await page.locator('.label-filter-chip [role="menuitemradio"]').nth(2).click()
  await waitTotal(1, 6)
  await api(page, 'labels', 'remove', client)
  await waitTotal(6, 6)
  // one label left (Számla): the chip stays, off; or the row closed with no filter left (then opened again)
  if (!(await page.locator('.label-filter-chip').count())) await filtersButton.click()
  await page.locator('.label-filter-chip').waitFor()
  check('the filtering label deleted: the whole folder, the chip off', (await page.locator('.label-filter-chip button.chip').getAttribute('aria-pressed')) === 'false')

  check('no command reached the POP3 servers after Frissítés', servers.every((s, i) => s.log.length === logAt[i]), JSON.stringify(servers.map((s, i) => s.log.slice(logAt[i]))))
  const failed = fs.existsSync(mainLog) ? fs.readFileSync(mainLog, 'utf8').split('\n').filter(l => /(labels:\w+|mail:\w+|search:\w+) failed/.test(l)) : []
  check('main.log: no failure on the path', failed.length === 0, failed.join(' | '))
  check('the page console: no error or warning', consoleLines.length === 0, consoleLines.join(' | '))
} catch (err) {
  check('run', false, err.stack)
} finally {
  if (app) await app.close().catch(() => {})
  for (const s of servers) await s.close()
  fs.rmSync(work, { recursive: true, force: true })
}
console.log(`\n${results.filter(Boolean).length} / ${results.length} OK`)
process.exit(results.every(Boolean) ? 0 : 1)
