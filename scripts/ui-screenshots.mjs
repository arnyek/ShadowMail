#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Screenshots of the main screens for the UI cards, 1280x800, with
// test data only (test/tools/seed-index.mjs: a dummy IMAP account at 127.0.0.1:1, so nothing leaves
// the machine, plus the test/fixtures/mail messages already downloaded).
//
//   node scripts/ui-screenshots.mjs <prefix> [--out docs/ui] [--keep] [--strict] [--set readme] [--lang hu|en] [--theme <id>] [--pane none|right|bottom]
//
// Writes <out>/<prefix>-{unlock,list,collapsed,selected,hover,chips,reader,headers,source,reader-plain,compose,settings}.png (collapsed,
// selected/hover/chips, filter-chips, filtered, filtered-empty, headers, source: when the build has them), and settings-{security,about,appearance,labels}, settings-claude, account-editor, account-editor-bottom, contacts-none, contacts, contacts-editor, contacts-delete, contacts-export-menu,
// and, in a second, empty data folder, create and recovery-code (a code of a throw-away test vault). Prints, per screen, the native
// controls left (`button:not([class]), select`) and the icon buttons without an aria-label, the
// renderer console errors/warnings and the main process' stderr, and the net-guard log lines.
// Exit code 1 if a screen failed, or there was a console error/warning or main-process stderr output;
// with --strict (the whole-app audit) also if any screen has a native control, an icon button
// without an aria-label or a title. --keep keeps the data folder.
// Playwright: PW=<path of the playwright (or playwright-core) package>; default: the repo's playwright-core
// devDependency.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { connectSnippets } from '../app/main/mcp/service.js'

const { values, positionals } = parseArgs({ allowPositionals: true, options: { out: { type: 'string', default: 'docs/ui' }, keep: { type: 'boolean', default: false }, strict: { type: 'boolean', default: false }, set: { type: 'string' }, lang: { type: 'string' }, theme: { type: 'string' }, pane: { type: 'string' } } })
// --lang hu|en: the interface language of the screens (else E2E_LANG, else hu); lang.mjs reads it when it loads
if (values.lang) process.env.E2E_LANG = values.lang
const { t, seedLanguage } = await import('../test/e2e/lang.mjs')
// --theme <id>: the interface theme of the screens (else E2E_THEME, else the default); theme-env.mjs reads it when it loads
if (values.theme) process.env.E2E_THEME = values.theme
const { useTheme } = await import('../test/e2e/theme-env.mjs')
const prefix = positionals[0]
// --set readme|themes: only the screens of that set are written (every step still runs: the later screens build on it)
const SETS = {
  readme: ['unlock', 'list', 'reader', 'headers', 'compose', 'contacts', 'settings-security', 'settings-claude'],
  // a theme's review set: lock, list, an HTML and a plain text message, the composer, the theme setting
  themes: ['unlock', 'list', 'reader', 'reader-plain', 'compose', 'settings-appearance'],
}
if (!prefix || !/^[\w.-]+$/.test(prefix) || (values.set && !SETS[values.set]) || (values.pane && (!['none', 'right', 'bottom'].includes(values.pane) || !values.theme))) {
  console.error(`usage: ui-screenshots.mjs <prefix> [--out docs/ui] [--keep] [--strict] [--set ${Object.keys(SETS).join('|')}] [--lang hu|en] [--theme <id> [--pane none|right|bottom]]`)
  process.exit(2)
}
const only = values.set ? new Set(SETS[values.set]) : null
const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.resolve(repo, values.out)
fs.mkdirSync(outDir, { recursive: true })
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const SIZE = { width: 1280, height: 800 }
const README_READER_SIZE = { width: 1280, height: 900 }

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-shots-'))
const dataDir = path.join(work, 'data')
const seed = JSON.parse(
  execFileSync(process.execPath, [path.join(repo, 'test', 'tools', 'seed-index.mjs'), dataDir, '--count', '120', '--previews', '--marks', '--eml', path.join(repo, 'test', 'fixtures', 'mail')], { encoding: 'utf8' }),
)
// the interface language: E2E_LANG (hu by default); the texts looked for come from the same dictionary
seedLanguage(dataDir)
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// the "(filtered, ..." part of the list count, whatever the number
const filteredMark = (a => {
  const b = t.listFiltered(2)
  let i = 0
  while (i < a.length && a[i] === b[i]) i++
  return a.slice(0, i).trim()
})(t.listFiltered(1))

const problems = []
const consoleLines = []
const written = []
let failed = false

const audits = {}
async function audit(page, name) {
  const native = await page.evaluate(() => document.querySelectorAll('button:not([class]), select').length)
  const unnamed = await page.evaluate(() => document.querySelectorAll('button.icon-btn:not([aria-label])').length)
  const untitled = await page.evaluate(() => document.querySelectorAll('button.icon-btn:not([title])').length)
  const theme = await page.evaluate(() => document.documentElement.dataset.theme || '')
  audits[name] = { native, unnamed, untitled, theme }
  console.log(`  ${name}: native controls ${native}, icon buttons without aria-label ${unnamed}, without title ${untitled}, theme ${theme || '-'}`)
}

async function shot(page, name) {
  if (only && !only.has(name)) return
  const file = path.join(outDir, `${prefix}-${name}.png`)
  await page.screenshot({ path: file })
  written.push(path.relative(repo, file).split(path.sep).join('/'))
  await audit(page, name)
}

function watch(page, label) {
  page.on('console', m => {
    if (m.type() === 'error' || m.type() === 'warning') consoleLines.push(`[${label} ${m.type()}] ${m.text()}`)
  })
  page.on('pageerror', e => consoleLines.push(`[${label} pageerror] ${e.message}`))
}

const app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
const proc = app.process()
let stderr = ''
proc.stderr.on('data', d => (stderr += d))
try {
  const page = await app.firstWindow()
  watch(page, 'main')
  // --pane: the reading pane of the screens (set before the theme's reload, so the first screen has it)
  if (values.pane) await page.evaluate(v => localStorage.setItem('shadowmail.ui.readerPane', JSON.stringify(v)), values.pane)
  await useTheme(app, page)
  await page.setViewportSize(SIZE)

  const step = async (name, fn) => {
    try {
      await fn()
    } catch (err) {
      failed = true
      problems.push(`${name}: ${err.message.split('\n')[0]}`)
    }
  }

  await step('unlock', async () => {
    await page.locator('#vault-unlock').waitFor()
    await shot(page, 'unlock')
  })
  await step('list', async () => {
    await page.locator('#vault-unlock').fill(seed.master)
    await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
    await page.locator('.msg-row[data-id]').first().waitFor()
    await page.waitForTimeout(600) // the sync status line settles (connection refused, on purpose)
    await shot(page, 'list')
  })
  await step('collapsed', async () => {
    const fold = page.getByRole('button', { name: t.sidebarCollapse, exact: true })
    if (!(await fold.count())) return // an older build has no such button
    await fold.click()
    await page.locator('.sidebar.collapsed').waitFor()
    await shot(page, 'collapsed')
    await page.getByRole('button', { name: t.sidebarExpand, exact: true }).click()
  })
  // the list states for the owner's review (selection, hover, an active filter chip)
  await step('selected', async () => {
    if (!(await page.locator('.list-header').count())) return // an older build has no list header
    const boxes = page.locator('.msg-row[data-id] .col-check input')
    await boxes.nth(1).check()
    await boxes.nth(2).check()
    await page.locator('.action-bar').waitFor()
    await shot(page, 'selected')
    await page.locator('.list-header .select-all input').click() // partly selected: a click clears it
    await page.locator('.list-tools').waitFor()
  })
  await step('hover', async () => {
    if (!(await page.locator('.list-header').count())) return
    await page.locator('.msg-row[data-id]').nth(3).hover()
    await page.locator('.msg-row[data-id]').nth(3).locator('.row-quick').waitFor()
    await shot(page, 'hover')
    await page.mouse.move(5, 790)
  })
  await step('chips', async () => {
    if (!(await page.locator('.list-header').count())) return
    await page.getByRole('searchbox', { name: t.searchLabel }).fill('ajánlat')
    await page.locator('.search-chips').waitFor()
    await page.getByRole('button', { name: t.searchFilter.unread, exact: true }).click()
    await page.locator('.result').first().waitFor()
    await page.waitForTimeout(300)
    await shot(page, 'chips')
    await page.getByRole('searchbox', { name: t.searchLabel }).press('Escape')
    await page.locator('.list-header').waitFor()
    // Esc leaves the search, the folder filter stays: off again for the next screens
    const clear = page.locator('.list-header .clear-filters')
    if (await clear.count()) await clear.click()
  })
  // the chips without a search filter the folder view (the row, a filtered list with its
  // count, an empty filtered list with "Szűrők törlése")
  await step('filter-chips', async () => {
    if (!(await page.locator('.list-header').count())) return
    await page.getByRole('button', { name: t.searchFiltersButton, exact: true }).click()
    await page.locator('.search-chips').waitFor()
    await page.waitForTimeout(200)
    await shot(page, 'filter-chips')
  })
  await step('filtered', async () => {
    const unread = page.locator('.search-chips').getByRole('button', { name: t.searchFilter.unread, exact: true })
    if (!(await unread.count()) || !(await page.locator('.folder[data-path="Sent"]').count())) return
    await unread.click()
    await page.waitForFunction(mark => document.querySelector('.list-count')?.innerText.includes(mark), filteredMark)
    await page.waitForTimeout(300)
    await shot(page, 'filtered')
  })
  await step('filtered-empty', async () => {
    if (!(await page.locator('.list-header .clear-filters').count())) return
    await page.locator('.folder[data-path="Sent"]').click() // the seeded Sent messages are all read
    await page.locator('.list-filtered-empty').waitFor()
    await shot(page, 'filtered-empty')
    await page.locator('.list-filtered-empty').getByRole('button', { name: t.clearFilters, exact: true }).click()
    await page.locator('.folder[data-path="INBOX"]').click()
    await page.locator('.msg-row[data-id]').first().waitFor()
  })
  // the menus and dialogs of the list
  await step('context-menu', async () => {
    if (!(await page.locator('.list-header').count())) return
    await page.locator('.msg-row[data-id]').nth(2).click({ button: 'right' })
    await page.getByRole('menu').waitFor()
    await shot(page, 'context-menu')
    await page.keyboard.press('Escape')
    await page.locator('.list-header .select-all input').click() // the right click selected the row
  })
  await step('folder-dialog', async () => {
    const plus = page.getByRole('button', { name: new RegExp(`^${esc(t.newFolderTitle(''))}`) })
    if (!(await plus.count())) return
    await plus.first().click()
    await page.getByRole('dialog').waitFor()
    await shot(page, 'folder-dialog')
    await page.keyboard.press('Escape')
    await page.getByRole('dialog').waitFor({ state: 'detached' })
  })
  // the folder's and the account head's context menus (the manual order: Up / Down, Sort folders A-Z)
  await step('folder-menu', async () => {
    const folder = page.locator('.folder[data-path="INBOX"]').first()
    if (!(await folder.count())) return
    await folder.click({ button: 'right' })
    await page.getByRole('menu').waitFor()
    await shot(page, 'folder-menu')
    await page.keyboard.press('Escape')
    await page.getByRole('menu').waitFor({ state: 'detached' })
  })
  await step('account-menu', async () => {
    const head = page.locator('.folder-tree .account-head').first()
    if (!(await head.count())) return
    await head.click({ button: 'right' })
    const menu = page.getByRole('menu')
    await menu.waitFor()
    await shot(page, 'account-menu')
    await page.keyboard.press('Escape')
    await menu.waitFor({ state: 'detached' })
  })
  await step('confirm-dialog', async () => {
    const folder = page.locator('.folder[data-path="Ügyfelek/Példa Kft."]')
    if (!(await folder.count())) return
    await folder.click({ button: 'right' })
    await page.getByRole('menuitem', { name: t.folderMenu.delete }).click()
    await page.getByRole('alertdialog').waitFor()
    await shot(page, 'confirm-dialog')
    await page.keyboard.press('Escape')
    await page.getByRole('alertdialog').waitFor({ state: 'detached' })
  })
  await step('reader', async () => {
    const msg = seed.eml.find(e => e.file === 'cid-and-attachments.eml') || seed.eml[0]
    await page.locator(`.msg-row[data-id="${msg.id}"]`).click()
    await page.locator(`.reader[data-message-id="${msg.id}"]`).waitFor()
    await page.waitForTimeout(500)
    // the README's reader picture shows the whole message down to its reply row: since the label row it no longer
    // fits in 800 px, so only this one picture of the readme set is taken in a taller window
    const tall = values.set === 'readme'
    if (tall) {
      await page.setViewportSize(README_READER_SIZE)
      await page.waitForTimeout(300)
    }
    // step() catches a failed shot and goes on: the window size comes back either way, so the next screens stay 1280 x 800
    try {
      await shot(page, 'reader')
    } finally {
      if (tall) await page.setViewportSize(SIZE)
    }
  })
  // the source view, both tabs (More -> Fejlécek, then the Eredeti tab); before H2 there is no such item
  await step('headers', async () => {
    await page.locator('.reader-tools').getByRole('button', { name: t.readerMore, exact: true }).click()
    const item = page.getByRole('menuitem', { name: t.source.menuHeaders, exact: true })
    if (!(await item.count())) return page.keyboard.press('Escape')
    await item.click()
    await page.locator('.source-modal .source-panel[aria-busy="false"]').waitFor()
    await shot(page, 'headers')
  })
  await step('source', async () => {
    const modal = page.locator('.source-modal')
    if (!(await modal.count())) return
    await modal.getByRole('tab', { name: t.source.tabs.original, exact: true }).click()
    await modal.locator('pre.source-original').waitFor()
    await shot(page, 'source')
    await page.keyboard.press('Escape')
    await modal.waitFor({ state: 'detached' })
  })
  // a plain text message without any style: the reader draws it in the theme's own colors
  await step('reader-plain', async () => {
    const msg = seed.eml.find(e => e.file === 'iso-8859-2.eml')
    if (!msg) return
    if (await page.locator('.reader-back').count()) await page.locator('.reader-back').click()
    await page.locator(`.msg-row[data-id="${msg.id}"]`).click()
    await page.locator(`.reader[data-message-id="${msg.id}"] pre.mail-text`).waitFor()
    await page.waitForTimeout(300)
    await shot(page, 'reader-plain')
  })
  await step('compose', async () => {
    const [win] = await Promise.all([app.waitForEvent('window'), page.getByRole('button', { name: t.newMessage, exact: true }).click()])
    watch(win, 'compose')
    await win.setViewportSize(SIZE)
    await win.locator('.editor').waitFor()
    await win.waitForTimeout(300)
    await shot(win, 'compose')
  })
  await step('settings', async () => {
    await page.bringToFront()
    await page.getByRole('button', { name: t.viewSettings, exact: true }).click()
    await page.locator('.settings').waitFor()
    await shot(page, 'settings')
  })
  // the settings tabs and the account editor
  for (const [tab, name] of [[t.settingsNav.security, 'settings-security'], [t.settingsNav.about, 'settings-about'], [t.settingsNav.appearance, 'settings-appearance'], [t.settingsNav.labels, 'settings-labels'], [t.settingsNav.claude, 'settings-claude']]) {
    await step(name, async () => {
      const tabButton = page.getByRole('button', { name: tab, exact: true })
      if (!(await tabButton.count())) return // an older build has no settings tabs
      await tabButton.click()
      await page.waitForTimeout(300)
      // a published image shows the snippets of a Windows install (made by the app's own connectSnippets), not the
      // paths of the machine that took it
      if (name === 'settings-labels') {
        // two labels (the build of 0.17.0 has the bridge), so the page shows rows, not only the empty state
        const made = await page.evaluate(async () => {
          const api = window.shadowMail.labels
          if (!api) return false
          if (!(await api.list()).labels.length) {
            await api.create('Számla', '#d32f2f')
            await api.create('Ügyfél', '#fbc02d')
          }
          return true
        })
        if (made) await page.locator('.labels-row').nth(1).waitFor()
      }
      if (only && name === 'settings-claude') {
        const ex = connectSnippets({ exe: 'D:\\Apps\\ShadowMail\\ShadowMail.exe', args: ['--mcp'], platform: 'win32' })
        await page.evaluate(({ desktop, code }) => {
          for (const [id, text] of [['desktop', desktop], ['code', code]]) {
            const el = document.querySelector(`.claude-snippet[data-snippet="${id}"] .claude-snippet-text`)
            if (el) el.textContent = text
          }
        }, ex)
      }
      await shot(page, name)
    })
  }
  await step('account-editor', async () => {
    const tab = page.getByRole('button', { name: t.settingsNav.accounts, exact: true })
    if (await tab.count()) await tab.click()
    await page.getByRole('button', { name: t.accountEdit, exact: true }).click()
    await page.locator('form.account-editor').waitFor()
    await shot(page, 'account-editor')
  })
  // the same editor scrolled to its bottom: the sticky action bar with the last section (an older build: its own bottom)
  await step('account-editor-bottom', async () => {
    await page.evaluate(() => {
      const s = document.querySelector('section.settings')
      s.scrollTop = s.scrollHeight
    })
    await page.waitForTimeout(100)
    await shot(page, 'account-editor-bottom')
  })
  // the address book (Címlista): the list with a person, the editor, the delete question
  await step('contacts', async () => {
    const btn = page.getByRole('button', { name: t.viewContacts, exact: true })
    if (!(await btn.count())) return // an older build has no address book
    await page.evaluate(() => window.shadowMail.contacts.save({ displayName: 'Minta Mária', org: 'Példa Kft.', emails: ['maria@example.invalid', 'maria2@example.invalid'], phones: ['+36 1 234 5678'] }))
    await btn.click()
    // nobody chosen yet: the empty state of the detail pane
    await page.locator('.contacts-choose').waitFor()
    await shot(page, 'contacts-none')
    await page.locator('.contact-item').first().click()
    await page.locator('.contact-details').waitFor()
    await shot(page, 'contacts')
    await page.locator('.contact-edit').click()
    await page.locator('form.contact-editor').waitFor()
    await shot(page, 'contacts-editor')
    await page.getByRole('button', { name: t.contacts.cancel, exact: true }).click()
    await page.locator('.contact-delete').click()
    await page.locator('.contacts-delete-confirm').waitFor()
    await shot(page, 'contacts-delete')
    await page.getByRole('button', { name: t.contacts.cancel, exact: true }).click()
    await page.locator('.contacts-export').click()
    await page.locator('[role="menu"]').waitFor()
    await shot(page, 'contacts-export-menu')
    await page.keyboard.press('Escape')
  })
} finally {
  await app.close().catch(() => {})
}

// the first start (an empty data folder): the create screen and the recovery code screen
{
  const freshDir = path.join(work, 'fresh')
  fs.mkdirSync(freshDir)
  seedLanguage(freshDir)
  const fresh = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: freshDir } })
  try {
    const p = await fresh.firstWindow()
    watch(p, 'first-start')
    await useTheme(fresh, p)
    await p.setViewportSize(SIZE)
    const step = async (name, fn) => {
      try {
        await fn()
      } catch (err) {
        failed = true
        problems.push(`${name}: ${err.message.split('\n')[0]}`)
      }
    }
    await step('create', async () => {
      await p.locator('#vault-new').waitFor()
      await shot(p, 'create')
    })
    await step('recovery-code', async () => {
      await p.locator('#vault-new').fill('Kepernyokep-mesterjelszo')
      await p.locator('#vault-new-again').fill('Kepernyokep-mesterjelszo')
      await p.getByRole('button', { name: t.vaultCreateButton, exact: true }).click()
      await p.locator('#recovery-code').waitFor({ timeout: 30_000 })
      await shot(p, 'recovery-code')
    })
  } finally {
    await fresh.close().catch(() => {})
  }
}

const guard = path.join(dataDir, 'electron', 'logs', 'net-guard.log')
const guardLines = fs.existsSync(guard) ? fs.readFileSync(guard, 'utf8').trim().split('\n').filter(Boolean) : []
// Playwright's own --inspect lines are not the app's
const mainNoise = stderr.split('\n').filter(l => l.trim() && !/^Debugger (listening|ending) on ws:|^For help, see: https:\/\/nodejs\.org/.test(l))

console.log(`\nscreenshots: ${written.length}`)
for (const f of written) console.log(`  ${f}`)
console.log(`renderer console errors/warnings: ${consoleLines.length}`)
for (const l of consoleLines) console.log(`  ${l}`)
console.log(`main process stderr lines: ${mainNoise.length}`)
for (const l of mainNoise.slice(0, 20)) console.log(`  ${l}`)
console.log(`net-guard log lines: ${guardLines.length}`)
for (const l of guardLines.slice(0, 20)) console.log(`  ${l}`)
for (const p of problems) console.log(`FAIL ${p}`)
const badScreens = Object.entries(audits).filter(([, a]) => a.native || a.unnamed || a.untitled)
if (values.strict) console.log(`strict: ${badScreens.length ? `FAIL ${badScreens.map(([n]) => n).join(', ')}` : 'every screen clean'}`)

if (values.keep) console.log(`data folder kept: ${dataDir}`)
else fs.rmSync(work, { recursive: true, force: true })
process.exit(failed || consoleLines.length || mainNoise.length || (values.strict && badScreens.length) ? 1 : 0)
