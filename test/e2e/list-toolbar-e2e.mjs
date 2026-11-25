#!/usr/bin/env node
// The list header while rows are selected, on a narrow list, in the real app (headless Electron + Playwright). Not part
// of `npm test`.
//
//   node test/e2e/list-toolbar-e2e.mjs        (E2E_LANG=en, E2E_THEME=classic-blue: the same in English / compact)
//
// Split view, the list | reader divider dragged to 600 / 400 / 351 / 300 / 280 px; 1, 2 and every row selected; an
// account without and one with an Archive folder (two data folders); without and with an active filter (its clear
// button in the header). In every case: every visible button of the header lies wholly inside it, overlaps no other
// button and no label, and elementFromPoint at its centre is the button; "N selected" and the range do not overlap and
// do not stick out, a cut one keeps its whole text in its title; every action is there, as a button or as an item of
// "More" (and only there). Without a selection: refresh and the sort tools whole and hit, no "More"; without a filter the
// range whole with its old title; with a filter (a long range) the range may be cut, its title then the whole shown text,
// and it overlaps no button. At 600 px without Archive and filter the selection's header is the full one (no "More", full size).
// "More": Star and Label from it do what the buttons do; reached with Tab and Enter, the arrows skip the hidden items.
// No renderer console error or warning, no outgoing request.
// Data: test/tools/seed-index.mjs (a dummy IMAP account at 127.0.0.1:1, nothing leaves the machine), 1234 messages.
// Needs a fresh renderer build first: npx vite build
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { t, seedLanguage } from './lang.mjs'
import { useTheme, e2eTheme } from './theme-env.mjs'
import { openVaultedDatabase } from '../../core/vault/vaulted-db.js'
import { MailIndex } from '../../core/db/mail-index.js'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const WIDTHS = [600, 400, 351, 300, 280]
const COUNT = 1234

const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  if (!ok || process.env.E2E_VERBOSE) console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const consoleLines = []
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-list-toolbar-e2e-'))

/** A data folder of the seed; with `archive`, the account gets an Archive folder (its Archive action). */
async function dataFolder(name, archive) {
  const dataDir = path.join(work, name)
  const seed = JSON.parse(execFileSync(process.execPath, [path.join(repo, 'test', 'tools', 'seed-index.mjs'), dataDir, '--count', String(COUNT)], { encoding: 'utf8' }))
  seedLanguage(dataDir)
  if (archive) {
    const { db } = await openVaultedDatabase(dataDir, seed.master)
    new MailIndex(db).upsertFolder({ account_id: seed.accountId, path: 'Archive', delimiter: '/', special_use: '\\Archive', uidvalidity: '1', synced_at: Date.now() })
    db.close()
  }
  return { dataDir, seed }
}

async function launch({ dataDir, seed }) {
  const app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
  const page = await app.firstWindow()
  page.on('console', m => (m.type() === 'error' || m.type() === 'warning') && consoleLines.push(`${m.type()}: ${m.text()}`))
  page.on('pageerror', e => consoleLines.push(`pageerror: ${e.message}`))
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.locator('#vault-unlock').waitFor({ timeout: 20_000 })
  await page.evaluate(() => localStorage.setItem('shadowmail.ui.readerPane', JSON.stringify('right')))
  await Promise.all([page.waitForEvent('load', { timeout: 20_000 }), app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(w => w.webContents.reload()))])
  await useTheme(app, page)
  await page.locator('#vault-unlock').fill(seed.master)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  await page.locator('.msg-row[data-id]').first().waitFor({ timeout: 20_000 })
  await page.waitForFunction(n => document.querySelector('.list-count')?.dataset.total === String(n), COUNT, { timeout: 20_000 })
  return { app, page }
}

const listWidth = page => page.locator('.msg-viewport').evaluate(el => Math.round(el.getBoundingClientRect().width))
async function dragTo(page, w) {
  for (let i = 0; i < 3; i++) {
    const now = await listWidth(page)
    if (Math.abs(now - w) <= 1) break
    const b = await page.locator('.splitter[data-split="list"]').boundingBox()
    const x = b.x + b.width / 2
    const y = b.y + b.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + (w - now), y, { steps: 6 })
    await page.mouse.up()
    await page.waitForTimeout(150)
  }
  return listWidth(page)
}
async function openReader(page) {
  if (await page.locator('.splitter[data-split="list"]').count()) return
  await page.locator('.msg-row[aria-rowindex="1"] .col-subject').click()
  await page.locator('.splitter[data-split="list"]').waitFor({ timeout: 10_000 })
}
let step = ''
async function clearSelection(page) {
  if (await page.locator('.action-bar').count()) {
    step = 'clear the selection'
    await page.getByRole('button', { name: t.selectMenu, exact: true }).click()
    await page.getByRole('menuitem', { name: t.selectMenuItems.none, exact: true }).click()
    // attached, not visible: without a selection a long filtered range squeezes the sort tools to nothing (not this test's)
    await page.locator('.list-tools').waitFor({ state: 'attached', timeout: 3000 })
  }
}
async function select(page, n, total) {
  await clearSelection(page)
  step = `select ${n}`
  if (n === 'all') await page.locator('.list-select .select-all input').click()
  else for (let i = 0; i < n; i++) await page.locator(`.msg-row[aria-rowindex="${i + 2}"] .col-check input`).click()
  await page.waitForFunction(want => document.querySelector('.selection-count')?.textContent === want, t.selectedCount(n === 'all' ? total : n), { timeout: 3000 })
  await page.mouse.move(640, 5)
  step = ''
}

// the header's geometry: visible buttons, the two labels, what "More" holds (its items counted while hidden too)
const geometry = page =>
  page.evaluate(() => {
    const header = document.querySelector('.list-header')
    const hb = header.getBoundingClientRect()
    const shown = el => el.getClientRects().length > 0
    const rect = el => { const b = el.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width } }
    const name = b => b.getAttribute('aria-label') || b.textContent.trim()
    const buttons = [...header.querySelectorAll('button')].filter(b => shown(b) && !b.closest('.menu')).map(b => {
      const r = rect(b)
      const at = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2)
      return { name: name(b), ...r, hit: Boolean(at && (at === b || b.contains(at))), cls: b.className }
    })
    const label = sel => { const el = header.querySelector(sel); return el && shown(el) ? { ...rect(el), text: el.textContent, title: el.getAttribute('title'), cut: el.scrollWidth > el.clientWidth + 0.5 } : null }
    const more = header.querySelector('.action-more')
    return {
      header: rect(header),
      pad: getComputedStyle(header).paddingLeft,
      buttons,
      sel: label('.selection-count'),
      cnt: label('.list-count'),
      more: Boolean(more && shown(more)),
    }
  })
// the items "More" shows (it is opened and closed again with Escape)
async function moreItems(page) {
  const more = page.locator('.action-more button')
  if (!(await more.isVisible())) return []
  await more.click()
  await page.locator('.action-more .menu').waitFor({ timeout: 2000 })
  const items = await page.locator('.action-more .menu [role="menuitem"]').evaluateAll(els => els.filter(e => e.getClientRects().length > 0).map(e => e.textContent.trim()))
  await page.keyboard.press('Escape')
  return items
}
const overlap = (a, b) => a && b && a.width > 0.5 && b.width > 0.5 && a.left < b.right - 0.5 && b.left < a.right - 0.5

function caseChecks(tag, g, items, { archive, n, total }) {
  const hb = g.header
  const inside = b => b.left >= hb.left - 0.5 && b.right <= hb.right + 0.5 && b.top >= hb.top - 0.5 && b.bottom <= hb.bottom + 0.5
  const out = g.buttons.filter(b => !inside(b)).map(b => b.name)
  const pairs = []
  for (let i = 0; i < g.buttons.length; i++) for (let j = i + 1; j < g.buttons.length; j++) if (overlap(g.buttons[i], g.buttons[j])) pairs.push(`${g.buttons[i].name}/${g.buttons[j].name}`)
  const onLabels = g.buttons.filter(b => overlap(b, g.sel) || overlap(b, g.cnt)).map(b => b.name)
  const missed = g.buttons.filter(b => !b.hit).map(b => b.name)
  check(`${tag}: every visible button inside the header, none over another or a label, each hit at its centre`, !out.length && !pairs.length && !onLabels.length && !missed.length, JSON.stringify({ out, pairs, onLabels, missed, header: [hb.left, hb.right] }))
  const labelOut = l => l && (l.left < hb.left - 0.5 || l.right > hb.right + 0.5)
  check(`${tag}: "N selected" and the range do not overlap or stick out`, !overlap(g.sel, g.cnt) && !labelOut(g.sel) && !labelOut(g.cnt), JSON.stringify({ sel: g.sel, cnt: g.cnt }))
  const selText = t.selectedCount(n === 'all' ? total : n)
  check(`${tag}: a cut label keeps its whole text in its title`, (!g.sel || !g.sel.cut || g.sel.title === selText) && (!g.cnt || !g.cnt.cut || (g.cnt.title && g.cnt.title === g.cnt.text)), JSON.stringify({ sel: g.sel && [g.sel.cut, g.sel.title], cnt: g.cnt && [g.cnt.cut, g.cnt.title, g.cnt.text] }))
  // every action, as a button or a "More" item, exactly once
  const names = g.buttons.map(b => b.name)
  const want = [...(archive ? [t.actions.archive] : []), t.actions.delete, t.actions.move, t.labels.button, t.refresh]
  const either = [[t.actions.read, t.actions.unread], [t.actions.star, t.actions.unstar]]
  const where = a => names.filter(x => x === a).length + items.filter(x => x === a).length
  const missing = want.filter(a => where(a) !== 1).concat(either.filter(p => p.map(where).reduce((s, x) => s + x, 0) !== 1).map(p => p.join('|')))
  check(`${tag}: every action once, as a button or in "More"`, !missing.length, JSON.stringify({ missing, buttons: names, items }))
}

let app = null
let page
const summary = []
try {
  for (const archive of [false, true]) {
    ;({ app, page } = await launch(await dataFolder(archive ? 'with-archive' : 'plain', archive)))
    const unreadChip = page.locator('.search-chips').getByRole('button', { name: t.searchFilter.unread, exact: true })
    for (const filter of [false, true]) {
      if (filter) {
        // without a search the chips (behind the filters button) filter the folder view
        if (!(await unreadChip.isVisible())) await page.getByRole('button', { name: t.searchFiltersButton, exact: true }).click()
        await unreadChip.click()
        await page.locator('.list-header .clear-filters').waitFor({ timeout: 5000 })
      }
      await openReader(page)
      const total = Number(await page.locator('.list-count').getAttribute('data-total'))
      for (const w of WIDTHS) {
        const got = await dragTo(page, w)
        const base = `${e2eTheme || 'default'} archive ${archive ? 'yes' : 'no'} filter ${filter ? 'on' : 'off'} list ${w}`
        check(`${base}: the list dragged to ${w} px`, Math.abs(got - w) <= 1, String(got))
        // no selection: the header as before at every width
        await clearSelection(page)
        await page.mouse.move(640, 5)
        const g0 = await geometry(page)
        const refresh = g0.buttons.find(b => b.cls.includes('list-refresh'))
        const iconBtn = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--icon-btn')))
        const range = await page.locator('.list-count').evaluate(el => ({ title: el.getAttribute('title'), text: el.textContent, cut: el.scrollWidth > el.clientWidth }))
        const tools = await page.locator('.list-tools').evaluate(el => Math.round(el.getBoundingClientRect().width))
        const sortBtn = g0.buttons.find(b => b.name === t.moreMenu)
        const rangeOk = filter ? (!range.cut || range.title === range.text) && range.title === range.text : !range.cut && range.title === t.listCount(total)
        check(`${base}, no selection: refresh and the sort button full size and hit, the sort tools not squeezed, no "More"`, refresh && Math.round(refresh.width) === iconBtn && refresh.hit && sortBtn && Math.round(sortBtn.width) === iconBtn && sortBtn.hit && tools >= iconBtn && !g0.more && g0.pad === '8px', JSON.stringify({ refresh: refresh && [refresh.width, refresh.hit], sort: sortBtn && [sortBtn.width, sortBtn.hit], tools, iconBtn, more: g0.more, pad: g0.pad }))
        check(`${base}, no selection: ${filter ? 'the range cut at most, its title the whole shown text' : 'the range whole with its old title'}`, rangeOk, JSON.stringify(range))
        const hb0 = g0.header
        const out0 = g0.buttons.filter(b => b.left < hb0.left - 0.5 || b.right > hb0.right + 0.5).map(b => b.name)
        const onRange = g0.buttons.filter(b => overlap(b, g0.cnt)).map(b => b.name)
        check(`${base}, no selection: every button inside the header, none over the range`, !out0.length && !onRange.length, JSON.stringify({ out0, onRange, cnt: g0.cnt }))
        if (w === 600) check(`${base}, no selection: at 600 px the range whole`, !range.cut, JSON.stringify(range))
        for (const n of [1, 2, 'all']) {
          await select(page, n, total)
          const g = await geometry(page)
          const items = await moreItems(page)
          caseChecks(`${base} selected ${n}`, g, items, { archive, n, total })
          if (w === 600 && !archive && !filter) {
            check(`${base} selected ${n}: the full header (no "More", buttons at ${iconBtn} px)`, !g.more && g.buttons.filter(b => !b.cls.includes('select-menu') && b.name !== t.selectMenu).every(b => Math.round(b.width) === iconBtn), JSON.stringify(g.buttons.map(b => [b.name, Math.round(b.width)])))
          }
          summary.push({ archive, filter, w, n, more: g.more, buttons: g.buttons.map(b => b.name), items, bar: Math.round(Math.max(...g.buttons.map(b => b.right)) - g.header.left), pad: g.pad })
        }
        await clearSelection(page)
      }
      if (filter) {
        await page.locator('.list-header .clear-filters').click()
        await page.waitForFunction(n => document.querySelector('.list-count')?.dataset.total === String(n), COUNT, { timeout: 5000 })
      }
    }

    // "More" does what the buttons do: Star and Label, at 300 px with two rows selected; with the keyboard
    if (archive) {
      await openReader(page)
      await dragTo(page, 300)
      await select(page, 2, COUNT)
      // the seed's IMAP account is unreachable on purpose: the star action runs, the server part fails with the action's
      // own error line (as in actions-e2e), which names the action
      await page.locator('.action-more button').click()
      await page.locator('.action-more .menu').getByRole('menuitem', { name: t.actions.star, exact: true }).click()
      const starError = t.actionError('star', 'connection_refused').split(':')[0]
      await page.waitForFunction(text => (document.querySelector('.action-error')?.innerText || '').includes(text), starError, { timeout: 15_000 }).catch(() => {})
      const errText = await page.locator('.action-error').innerText().catch(() => '')
      check('"More" > Star: the star action runs on the selection (its error line, the account being unreachable)', errText.includes(starError), errText)
      await page.locator('.action-more button').click()
      await page.locator('.action-more .menu').getByRole('menuitem', { name: t.labels.button, exact: true }).click()
      await page.locator('.label-picker').waitFor({ timeout: 5000 }).catch(() => {})
      check('"More" > Label: the label picker opens', (await page.locator('.label-picker').count()) === 1)
      await page.keyboard.press('Escape')
      await page.locator('.label-picker').waitFor({ state: 'detached', timeout: 3000 }).catch(() => {})
      // the keyboard: Tab from the last visible bar button reaches "More", Enter opens it, the arrows walk the shown items
      await select(page, 2, COUNT)
      await page.locator('.action-bar .menu-anchor:not(.action-more) button').first().focus() // the move menu's button
      await page.keyboard.press('Tab')
      const focused = await page.evaluate(() => document.activeElement?.closest('.action-more') !== null)
      check('Tab from the move button reaches "More" (the hidden buttons take no focus)', focused)
      await page.keyboard.press('Enter')
      await page.locator('.action-more .menu').waitFor({ timeout: 2000 }).catch(() => {})
      const walked = []
      for (let i = 0; i < 6; i++) {
        walked.push(await page.evaluate(() => document.activeElement?.textContent.trim() ?? null))
        await page.keyboard.press('ArrowDown')
      }
      const shownItems = await page.locator('.action-more .menu [role="menuitem"]').evaluateAll(els => els.filter(e => e.getClientRects().length > 0).map(e => e.textContent.trim()))
      // in order and round: a hidden item taking the focus would hold it (the focus stays on the last shown item)
      check('"More" with Enter, the arrows go round the shown items only, in order', shownItems.length >= 2 && walked.every((x, i) => x === shownItems[i % shownItems.length]), JSON.stringify({ walked, shownItems }))
      await page.keyboard.press('Escape')
    }
    await app.close()
    app = null
  }
} catch (e) {
  check('the run reached its end', false, `${step ? `at "${step}": ` : ''}${String(e.message).split('\n')[0]}`)
  if (process.env.E2E_SHOT && page) await page.screenshot({ path: process.env.E2E_SHOT }).catch(() => {})
} finally {
  if (app) await app.close().catch(() => {})
}

if (process.env.E2E_SUMMARY) fs.writeFileSync(process.env.E2E_SUMMARY, JSON.stringify(summary, null, 1))
for (const dir of ['plain', 'with-archive']) {
  const guard = path.join(work, dir, 'electron', 'logs', 'net-guard.log')
  const guardText = fs.existsSync(guard) ? fs.readFileSync(guard, 'utf8').trim() : ''
  check(`net-guard log (${dir}): no outgoing request`, guardText === '', guardText.split('\n').slice(0, 3).join(' | '))
}
check('no renderer console error or warning', consoleLines.length === 0, consoleLines.slice(0, 3).join(' | '))
fs.rmSync(work, { recursive: true, force: true })
console.log(`\n${results.filter(Boolean).length} / ${results.length} OK`)
process.exit(results.every(Boolean) ? 0 : 1)
