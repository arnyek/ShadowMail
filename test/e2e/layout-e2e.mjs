#!/usr/bin/env node
// The UI frame in the real app, headless Electron + Playwright.
// Not part of `npm test`.
//
//   node test/e2e/layout-e2e.mjs
//
// Data: test/tools/seed-index.mjs (a dummy IMAP account at 127.0.0.1:1, nothing leaves the machine).
// Measures: the header (menu, brand, settings and lock icon buttons with their old names), no unstyled
// native control and no icon button without a name in the header and the sidebar, the folder icons
// and counts, the selected folder, the sidebar folded to 72 px with tooltips, the state kept over a
// restart, the settings view and the way back. The one-line row (weights, preview,
// separator, no preview), the list header (selection -> icon actions, select read / unread, range),
// the hover actions, no native control and no unnamed icon button on the list screen. The reader:
// the message opens in the list's place without selecting the row; "Vissza", Esc and Backspace
// return to the same scroll position and selection; the reader pane setting (right / bottom) is
// applied at once and kept over a restart.
// Playwright: PW=<path of the playwright package> (default: the repo's playwright-core devDependency).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { t, locale, seedLanguage } from './lang.mjs'
import { useTheme } from './theme-env.mjs'
import { openVaultedDatabase } from '../../core/vault/vaulted-db.js'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-ui2-e2e-'))
const dataDir = path.join(work, 'data')
const seed = JSON.parse(execFileSync(process.execPath, [path.join(repo, 'test', 'tools', 'seed-index.mjs'), dataDir, '--count', '40', '--previews', '--eml', path.join(repo, 'test', 'fixtures', 'mail')], { encoding: 'utf8' }))
seedLanguage(dataDir)
// the oldest seeded message (already at the bottom of the list) from an older year: the list shows its full date
const OLD_DATE = new Date(2008, 0, 28, 9, 0).getTime()
{
  const { vault, db } = await openVaultedDatabase(dataDir, seed.master)
  const n = db.prepare("UPDATE messages SET date = ?, idate = ? WHERE message_id = '<seed-39@example.invalid>'").run(OLD_DATE, OLD_DATE).changes
  db.close()
  vault.lock()
  if (n !== 1) throw new Error(`the old-dated seed message: ${n} rows (one INBOX row expected)`)
}
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// a context menu opened on <loc> at a point of the window (x, y; negative = from the right / bottom edge): its box
const menuAt = async (page, loc, x, y) => {
  await loc.evaluate((el, [px, py]) => {
    const cx = px < 0 ? innerWidth + px : px
    const cy = py < 0 ? innerHeight + py : py
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: cx, clientY: cy }))
  }, [x, y])
  const menu = page.getByRole('menu')
  await menu.waitFor()
  const r = await menu.evaluate(el => { const b = el.getBoundingClientRect(); return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, w: innerWidth, h: innerHeight } })
  await page.keyboard.press('Escape')
  await menu.waitFor({ state: 'detached' })
  return r
}
// at the bottom-right corner (2 px in): inside the window, its bottom-right corner at the point (opened up and left)
const cornerOk = r => r.left >= 0 && r.top >= 0 && r.right <= r.w && r.bottom <= r.h && Math.abs(r.right - (r.w - 2)) <= 1 && Math.abs(r.bottom - (r.h - 2)) <= 1
// at a point with room: its top-left corner at the point
const pointOk = (r, x, y) => Math.abs(r.left - x) <= 1 && Math.abs(r.top - y) <= 1
const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const consoleLines = []

async function start() {
  const app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
  const page = await app.firstWindow()
  page.on('console', m => (m.type() === 'error' || m.type() === 'warning') && consoleLines.push(`${m.type()}: ${m.text()}`))
  page.on('pageerror', e => consoleLines.push(`pageerror: ${e.message}`))
  await useTheme(app, page)
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.locator('#vault-unlock').fill(seed.master)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  await page.locator('.folder-tree .folder').first().waitFor()
  return { app, page }
}

const width = (page, sel) => page.locator(sel).evaluate(el => Math.round(el.getBoundingClientRect().width))
const shotsAt = process.argv.indexOf('--shots')
const shots = shotsAt > 0 ? path.resolve(process.argv[shotsAt + 1]) : null

// The list rows at a given list width (the list | reader divider dragged there): sideways overflow of the list and of
// each visible row, the cells' boxes, the date cell cut or out of the row, the star / attachment icons cut.
// the subject's share: at these list widths (the list's box, its scrollbar included; room for a 17 px one too) the
// subject cell is at least this wide, the sender at least 96 px
const SUBJECT_POINTS = [[420, 56], [480, 120]]
// every 20 px from 280 to 600, the narrow mode's edge (350 / 352) and the subject points
const LIST_WIDTHS = [...new Set([...Array.from({ length: 17 }, (_, i) => 280 + 20 * i), 350, 352, ...SUBJECT_POINTS.map(p => p[0])])].sort((a, b) => a - b)
// the sender's floor: 96 px from a 351 px list on (every theme; the default theme's own threshold); under it (the narrow
// mode) the sender still gets up to 96 px first, and at least 48 px
const fromMin = list => (list >= 351 ? 96 : 48)
async function dragListTo(page, w, pane = '.msg-viewport') {
  const now = await width(page, pane)
  const b = await page.locator('.splitter[data-split="list"]').boundingBox()
  const x = b.x + b.width / 2
  const y = b.y + b.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + (w - now) / 2, y, { steps: 4 })
  await page.mouse.move(x + (w - now), y, { steps: 4 })
  await page.mouse.up()
  await page.waitForTimeout(120)
  return width(page, pane)
}
// oldGrid: measured with the old fixed grid set on the rows (CSSOM: the page's CSP blocks an injected style tag)
// (the date column was 12 px narrower: it cut the full date, the only intended change of the wide row)
const OLD_GRID = 'var(--col-check) var(--col-star) var(--col-from) minmax(0, 1fr) var(--col-attach) calc(var(--col-date) - 12px)'
const rowGeometry = (page, oldGrid = null) =>
  page.evaluate(([loc, grid]) => {
    const vp = document.querySelector('.msg-viewport')
    const vb = vp.getBoundingClientRect()
    const rows = [...document.querySelectorAll('.msg-row[data-id]')].filter(r => { const b = r.getBoundingClientRect(); return b.bottom > vb.top && b.top < vb.bottom })
    if (grid) for (const r of rows) r.style.gridTemplateColumns = grid
    const x = (el, r) => Math.round(el.getBoundingClientRect().left - r.getBoundingClientRect().left)
    const w = el => Math.round(el.getBoundingClientRect().width)
    const inside = (el, r) => { const a = el.getBoundingClientRect(), b = r.getBoundingClientRect(); return a.left >= b.left - 0.5 && a.right <= b.right + 0.5 }
    const cells = r => ['col-check', 'col-star', 'col-from', 'col-text', 'col-attachment', 'col-date'].map(c => r.querySelector(`:scope > .${c}`))
    const bad = []
    for (const r of rows) {
      const [check, star, from, , attach, date] = cells(r)
      if (r.scrollWidth > r.clientWidth) bad.push([r.dataset.id, 'row overflow', r.scrollWidth, r.clientWidth])
      if (date.scrollWidth > date.clientWidth || !inside(date, r)) bad.push([r.dataset.id, 'date cut', date.scrollWidth, date.clientWidth])
      for (const [name, cell] of [['check', check], ['star', star], ['attachment', attach]]) {
        if (!inside(cell, r)) bad.push([r.dataset.id, `${name} out of the row`])
        for (const svg of cell.querySelectorAll('svg')) if (!inside(svg, cell)) bad.push([r.dataset.id, `${name} icon cut`])
      }
    }
    const first = rows[0]
    const firstCells = cells(first)
    // the widest date the list writes in the interface's locale (list-format.js): every month of a past year (day 28) and of this year, and 23:59
    const probe = firstCells[5].cloneNode(false)
    probe.style.cssText = 'position:absolute;visibility:hidden;width:auto;overflow:visible'
    first.appendChild(probe)
    const forms = [new Intl.DateTimeFormat(loc, { year: 'numeric', month: '2-digit', day: '2-digit' }), new Intl.DateTimeFormat(loc, { month: 'short', day: 'numeric' })]
    let widest = { text: '', w: 0 }
    for (const f of forms) for (let m = 0; m < 12; m++) for (const y of [2008, 2028]) {
      probe.textContent = f.format(new Date(y, m, 28))
      if (probe.scrollWidth > widest.w) widest = { text: probe.textContent, w: probe.scrollWidth }
    }
    probe.remove()
    const ds = getComputedStyle(firstCells[5])
    const dateRoom = firstCells[5].clientWidth - parseFloat(ds.paddingLeft) - parseFloat(ds.paddingRight)
    const geo = {
      list: Math.round(vb.width), vpScroll: vp.scrollWidth, vpClient: vp.clientWidth, rows: rows.length, bad: bad.slice(0, 5), nBad: bad.length,
      from: w(firstCells[2]), x: firstCells.map(c => x(c, first)), widths: firstCells.map(w), widest, dateRoom,
    }
    if (grid) for (const r of rows) r.style.gridTemplateColumns = ''
    return geo
  }, [locale, oldGrid])
// a size token of the theme on the page, in px (the default theme: the old fixed values)
const token = (page, name) => page.evaluate(n => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(n)), name)
const audit = page =>
  page.evaluate(() => ({
    native: document.querySelectorAll('.app-header button:not([class]), .sidebar button:not([class]), .app-header select, .sidebar select').length,
    unnamed: document.querySelectorAll('button.icon-btn:not([aria-label])').length,
    noTitle: document.querySelectorAll('.app-header button.icon-btn:not([title]), .sidebar button.icon-btn:not([title])').length,
  }))

// the lock screen: only the version; the password field's eye shows it on request only
{
  const lockApp = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
  try {
    const p = await lockApp.firstWindow()
    await useTheme(lockApp, p)
    await p.setViewportSize({ width: 1280, height: 800 })
    await p.locator('#vault-unlock').waitFor()
    const lockText = await p.locator('main').innerText()
    check('the lock screen shows the version, not the data folder or SQLite', new RegExp(`${esc(t.helloVersion)}: \\d+\\.\\d+\\.\\d+`).test(lockText) && !new RegExp(`${esc(t.helloDataDir)}|SQLite`).test(lockText), lockText.replace(/\s+/g, ' ').slice(0, 160))
    const input = p.locator('#vault-unlock')
    await input.fill('titkos-proba')
    const t0 = await input.getAttribute('type')
    await p.getByRole('button', { name: t.passwordShow, exact: true }).click()
    const t1 = await input.getAttribute('type')
    const pressed = await p.getByRole('button', { name: t.passwordHide, exact: true }).getAttribute('aria-pressed')
    await p.getByRole('button', { name: t.passwordHide, exact: true }).click()
    const t2 = await input.getAttribute('type')
    check('the eye: hidden by default, shown on click, hidden again', t0 === 'password' && t1 === 'text' && pressed === 'true' && t2 === 'password', `${t0} ${t1} ${pressed} ${t2}`)
    // shown, then submitted (a wrong password here): the field is a password field again
    await p.getByRole('button', { name: t.passwordShow, exact: true }).click()
    const typeShown = await input.getAttribute('type')
    await input.press('Enter')
    const typeAfterSubmit = await input.getAttribute('type')
    check('a submit hides the shown password at once', typeShown === 'text' && typeAfterSubmit === 'password', `${typeShown} -> ${typeAfterSubmit}`)
    await p.locator('main [role="alert"]').waitFor({ timeout: 10_000 }).catch(() => {})
    const lockAudit = await p.evaluate(() => ({ native: document.querySelectorAll('button:not([class]), select').length, unnamed: document.querySelectorAll('button.icon-btn:not([aria-label])').length }))
    check('lock screen without native controls', lockAudit.native === 0 && lockAudit.unnamed === 0, JSON.stringify(lockAudit))
  } finally {
    await lockApp.close().catch(() => {})
  }
}

let { app, page } = await start()
try {
  // header
  const header = page.locator('header.app-header')
  const headerH = await token(page, '--header-h')
  check(`header as high as --header-h (${headerH} px)`, (await header.evaluate(el => Math.round(el.getBoundingClientRect().height))) === headerH)
  check('brand: icon + "ShadowMail"', (await header.locator('.brand').innerText()).trim() === 'ShadowMail' && (await header.locator('.brand svg').count()) === 1)
  for (const name of [t.sidebarCollapse, t.viewSettings, t.vaultLockButton]) {
    const b = page.getByRole('button', { name, exact: true })
    check(`header icon button "${name}" (aria-label + title)`, (await b.count()) === 1 && (await b.getAttribute('title')) === name && (await b.innerText()).trim() === '')
  }
  check('no "Levelek" view button any more', (await page.getByRole('button', { name: t.viewMail, exact: true }).count()) === 0)

  // sidebar
  const a = await audit(page)
  check('header + sidebar: no unstyled native control', a.native === 0, JSON.stringify(a))
  check('no icon button without aria-label, all with a tooltip', a.unnamed === 0 && a.noTitle === 0, JSON.stringify(a))
  check('sidebar 256 px', (await width(page, '.sidebar')) === 256)
  check('"Új levél" is a tonal button with an icon, 56 px high', (await page.getByRole('button', { name: t.newMessage, exact: true }).evaluate(el => el.classList.contains('btn-tonal') && !!el.querySelector('svg') && Math.round(el.getBoundingClientRect().height) === 56)))
  check('"Frissítés" kept (one icon button, in the list header)', (await page.getByRole('button', { name: t.refresh, exact: true }).count()) === 1 && (await page.locator('.list-header').getByRole('button', { name: t.refresh, exact: true }).count()) === 1)
  const icons = await page.locator('.folder-tree .folder[data-path]').evaluateAll(els => Object.fromEntries(els.map(e => [e.dataset.path, e.querySelector('svg').dataset.icon])))
  check(
    'folder icons by role',
    icons.INBOX === 'inbox' && icons.Drafts === 'drafts' && icons.Sent === 'sent' && icons.Trash === 'trash' && icons.Junk === 'junk' && icons['Ügyfelek'] === 'folder' && icons['Ügyfelek/Példa Kft.'] === 'folder',
    JSON.stringify(icons),
  )
  const inbox = page.locator('.folder[data-path="INBOX"]')
  check('INBOX selected: aria-current="true"', (await inbox.getAttribute('aria-current')) === 'true')
  const geo = await inbox.evaluate(el => {
    const b = el.getBoundingClientRect()
    const c = el.querySelector('.unread-badge').getBoundingClientRect()
    return { gap: Math.round(b.right - c.right), text: el.querySelector('.unread-badge').textContent }
  })
  check('unread count on the right of the row', geo.gap >= 0 && geo.gap <= 16 && Number(geo.text) > 0, JSON.stringify(geo))
  check('no count on a folder without unread mail', (await page.locator('.folder[data-path="Sent"] .unread-badge').count()) === 0)
  check('the account head is kept (.folder-tree .account-name)', (await page.locator('.folder-tree .account-name').innerText()).trim() === 'Mérőfiók')

  // the rows (seed: every 5th unread, every 4th without a text, so #0 unread + preview, #1 read
  // + preview, #3 read without one)
  const rowInfo = n =>
    page.evaluate(n => {
      const r = [...document.querySelectorAll('.msg-row[data-id]')].find(x => x.querySelector('.col-subject')?.textContent.endsWith(`#${n}`))
      if (!r) return null
      const cs = el => (el ? getComputedStyle(el) : null)
      const from = r.querySelector('.col-from')
      const subj = r.querySelector('.col-subject')
      const prev = r.querySelector('.col-preview')
      const text = r.querySelector('.col-text')
      return {
        unread: r.classList.contains('unread'),
        h: Math.round(r.getBoundingClientRect().height),
        fromW: cs(from).fontWeight,
        subjW: cs(subj).fontWeight,
        prevW: prev ? cs(prev).fontWeight : null,
        prevColor: prev ? cs(prev).color : null,
        // the theme's secondary text color, as the browser computes it
        gray: (() => {
          const probe = document.createElement('span')
          probe.style.color = 'var(--c-text-2)'
          document.body.appendChild(probe)
          const c = getComputedStyle(probe).color
          probe.remove()
          return c
        })(),
        sep: prev ? prev.querySelector('.col-sep').textContent : null,
        oneLine: cs(text).whiteSpace === 'nowrap' && Math.round(text.getBoundingClientRect().height) <= 24,
        text: text.innerText,
        subject: subj.textContent,
      }
    }, n)
  const rowH = await token(page, '--row-h')
  const r0 = await rowInfo(0)
  check(`unread row: sender and subject 700, " – " and the preview 400 in gray, one line, --row-h (${rowH} px)`, r0 && r0.unread && r0.fromW === '700' && r0.subjW === '700' && r0.prevW === '400' && r0.prevColor === r0.gray && r0.sep === ' – ' && r0.oneLine && r0.h === rowH, JSON.stringify(r0))
  const r1 = await rowInfo(1)
  check('read row: sender and subject 400', r1 && !r1.unread && r1.fromW === '400' && r1.subjW === '400' && r1.prevW === '400', JSON.stringify(r1))
  const r3 = await rowInfo(3)
  check('no indexed text: only the subject, no separator', r3 && r3.prevW === null && r3.text.trim() === r3.subject, JSON.stringify(r3))
  const listAudit = await page.evaluate(() => ({ native: document.querySelectorAll('button:not([class]), select').length, unnamed: document.querySelectorAll('button.icon-btn:not([aria-label])').length }))
  check('list screen: no unstyled native control, no unnamed icon button', listAudit.native === 0 && listAudit.unnamed === 0, JSON.stringify(listAudit))
  check('range "1–N / 44" on the right', /^1–\d+ \/ 44$/.test((await page.locator('.list-count').innerText()).trim()), await page.locator('.list-count').innerText())
  // after the row's context menu the focus is back on the list
  await page.locator('.msg-row[data-id]').nth(2).click({ button: 'right' })
  await page.getByRole('menu').waitFor()
  await page.keyboard.press('Escape')
  await page.getByRole('menu').waitFor({ state: 'detached' })
  await page.waitForTimeout(100)
  check('context menu closed with Esc: the focus is on the list again', await page.evaluate(() => document.activeElement?.classList.contains('msg-viewport')))
  // the row's menu stays inside the window: at the bottom-right corner it opens up and left, with room at the point
  const rowCorner = await menuAt(page, page.locator('.msg-row[data-id]').nth(2), -2, -2)
  const rowPoint = await menuAt(page, page.locator('.msg-row[data-id]').nth(2), 400, 200)
  check('the row menu: at the window corner up and left, inside; with room at the point', cornerOk(rowCorner) && pointOk(rowPoint, 400, 200), JSON.stringify({ rowCorner, rowPoint }))
  await page.locator('.select-all input').click() // the right click selected the row
  await page.locator('.list-tools').waitFor()
  // hover: the quick actions take the date's place
  const hovered = page.locator('.msg-row[data-id]').nth(2)
  await hovered.hover()
  const hov = await hovered.evaluate(r => ({ quick: getComputedStyle(r.querySelector('.row-quick')).display, date: getComputedStyle(r.querySelector('.col-date')).visibility, hidden: r.querySelector('.row-quick').getAttribute('aria-hidden') }))
  check('hover: the row actions in the date\'s place (hidden from the accessibility tree)', hov.quick === 'flex' && hov.date === 'hidden' && hov.hidden === 'true', JSON.stringify(hov))
  // every target in the row at least 24 x 24 px, and every icon inside the row (a dense row cuts none)
  const hit = await hovered.evaluate(r => {
    const box = el => el.getBoundingClientRect()
    const rb = box(r)
    const targets = [r.querySelector('.col-check .checkbox') || r.querySelector('.col-check'), r.querySelector('.col-star button'), ...r.querySelectorAll('.row-quick button')]
    const small = targets.filter(Boolean).map(el => [el.className, Math.round(box(el).width), Math.round(box(el).height)]).filter(([, w, h]) => w < 24 || h < 24)
    const cut = [...r.querySelectorAll('svg')].map(box).filter(b => b.top < rb.top - 0.5 || b.bottom > rb.bottom + 0.5).length
    return { targets: targets.filter(Boolean).length, small, cut, row: Math.round(rb.height) }
  })
  check('the row: checkbox, star and quick buttons at least 24 x 24 px, no icon cut by the row', hit.targets >= 4 && hit.small.length === 0 && hit.cut === 0, JSON.stringify(hit))
  // selection: the header turns into the icon actions
  check('no selection: refresh + more, no action bar', (await page.locator('.list-tools').getByRole('button', { name: t.moreMenu, exact: true }).count()) === 1 && (await page.locator('.action-bar').count()) === 0)
  await page.locator('.msg-row[data-id]').nth(1).locator('.col-check input').check()
  await page.locator('.action-bar').waitFor()
  const bar = await page.locator('.action-bar').evaluate(el => [...el.querySelectorAll('button')].map(b => b.getAttribute('aria-label')))
  check('a checked row: the icon actions instead of "További", "1 kijelölve"', (await page.locator('.list-tools').count()) === 0 && bar.includes(t.actions.delete) && bar.includes(t.actions.move) && (await page.locator('.selection-count').innerText()) === t.selectedCount(1), JSON.stringify(bar))
  check('"Frissítés" stays while something is selected (a click on a row selects it)', (await page.locator('.list-header').getByRole('button', { name: t.refresh, exact: true }).count()) === 1)
  check('select-all box: partly selected (indeterminate)', await page.locator('.select-all input').evaluate(el => el.indeterminate))
  await page.getByRole('button', { name: t.selectMenu, exact: true }).click()
  await page.getByRole('menuitem', { name: t.selectMenuItems.unread, exact: true }).click()
  await page.waitForFunction(want => document.querySelector('.selection-count')?.innerText === want, t.selectedCount(12))
  check('select unread: the 12 unread of 44 (8 seeded + 4 test letters)', true)
  await page.getByRole('button', { name: t.selectMenu, exact: true }).click()
  await page.getByRole('menuitem', { name: t.selectMenuItems.none, exact: true }).click()
  await page.locator('.list-tools').waitFor()
  check('select none: the tools are back', (await page.locator('.action-bar').count()) === 0)

  // since 0.10.1: without a search the chips filter the
  // folder view; no disabled chip, no help line
  await page.getByRole('button', { name: t.searchFiltersButton, exact: true }).click()
  await page.locator('.search-chips').waitFor()
  const unreadChip = page.locator('.search-chips').getByRole('button', { name: t.searchFilter.unread, exact: true })
  const totalBefore = await page.locator('.list-count').getAttribute('data-total')
  await unreadChip.click()
  await page.waitForFunction(() => document.querySelector('.list-count')?.dataset.total === '12')
  const countText = await page.locator('.list-count').innerText()
  check('(1) no search: "Olvasatlan" filters the folder list (12 of 44), the count says so', (await unreadChip.getAttribute('aria-disabled')) === null && (await unreadChip.getAttribute('aria-pressed')) === 'true' && (await page.locator('.search-results').count()) === 0 && countText.endsWith(t.listFiltered(Number(totalBefore))), countText)
  check('(3) no help line, no disabled chip', (await page.locator('.search-chips-help').count()) === 0 && (await page.locator('.search-chips [aria-disabled]').count()) === 0)
  const box = page.getByRole('searchbox', { name: t.searchLabel })
  await unreadChip.click()
  await page.waitForFunction(n => document.querySelector('.list-count')?.dataset.total === n, totalBefore)
  await box.fill('ajánlat')
  await page.locator('.result').first().waitFor()
  await page.waitForTimeout(300)
  // the field's buttons (filters, clear) and its magnifier on the field's centre line
  const centres = await page.evaluate(() => {
    const mid = el => { const b = el.getBoundingClientRect(); return b.top + b.height / 2 }
    const f = document.querySelector('.search-bar .search-field')
    return { field: mid(f), parts: [f.querySelector(':scope > svg'), ...f.querySelectorAll(':scope > .icon-btn')].map(mid) }
  })
  check('the search field: the magnifier, the clear and the filters button on its centre line', centres.parts.length === 3 && centres.parts.every(c => Math.abs(c - centres.field) <= 0.5), JSON.stringify(centres))
  const allHits = await page.locator('.result').count()
  await unreadChip.click()
  await page.waitForFunction(n => document.querySelectorAll('.result').length > 0 && document.querySelectorAll('.result').length < n, allHits)
  const unreadOnly = await page.locator('.result').evaluateAll(els => els.every(e => e.classList.contains('unread')))
  check('(2) with a search: the chip filters the hits (only unread hits)', (await unreadChip.getAttribute('aria-pressed')) === 'true' && unreadOnly, `${allHits} -> ${await page.locator('.result').count()}`)
  // the query cleared (not Esc): the filter stays and now filters the folder view
  await box.fill('')
  await page.locator('.list-header').waitFor()
  await page.waitForFunction(() => document.querySelector('.list-count')?.dataset.total === '12')
  check('the query cleared: "Olvasatlan" stays on and filters the folder list', (await unreadChip.getAttribute('aria-pressed')) === 'true')
  // Esc leaves the SEARCH only; the folder filter stays until it is switched off
  await box.fill('ajánlat')
  await page.locator('.result').first().waitFor()
  await page.locator('.search-chips').getByRole('button', { name: new RegExp(`^${esc(t.searchFilter.from)}`) }).click()
  await page.getByRole('dialog', { name: t.searchFilter.from }).getByLabel(t.searchFilter.from, { exact: true }).fill('Kovács')
  await page.keyboard.press('Escape') // the panel
  await box.press('Escape') // the search
  await page.waitForFunction(() => document.querySelector('.list-count')?.dataset.total === '12')
  const fromChip = page.locator('.search-chips').getByRole('button', { name: new RegExp(`^${esc(t.searchFilter.from)}`) })
  check('Esc: the search is gone (query and sender empty), "Olvasatlan" stays on and the list stays filtered', (await box.inputValue()) === '' && (await fromChip.getAttribute('aria-pressed')) === 'false' && (await unreadChip.getAttribute('aria-pressed')) === 'true' && (await page.locator('.search-results').count()) === 0)
  await page.locator('.list-header').getByRole('button', { name: t.clearFilters, exact: true }).click()
  await page.waitForFunction(n => document.querySelector('.list-count')?.dataset.total === n, totalBefore)
  check('"Szűrők törlése": every filter off, the whole folder again, the chip row closed', (await page.locator('.search-chips').count()) === 0)
  // at 1280 px the folder view's chip row is ONE line, also in the seed's longest folder
  // (Ügyfelek/Példa Kft.) and with every on/off chip on (check marks); the order chip is short on screen,
  // its full text is the accessible name
  await page.locator('.folder[data-path="Ügyfelek/Példa Kft."]').click()
  await page.getByRole('button', { name: t.searchFiltersButton, exact: true }).click()
  await page.locator('.search-chips').waitFor()
  for (const name of [t.searchFilter.hasAttachment, t.searchFilter.unread, t.searchFilter.flagged]) await page.locator('.search-chips').getByRole('button', { name, exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.search-chips button.chip[aria-pressed="true"]').length === 3)
  const row = await page.locator('.search-chips').evaluate(el => {
    const chips = [...el.querySelectorAll('button.chip')]
    const cs = getComputedStyle(el)
    return { tops: [...new Set(chips.map(e => Math.round(e.getBoundingClientRect().top)))], n: chips.length, width: document.documentElement.clientWidth, row: Math.round(el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)), chips: chips.reduce((s, e) => s + e.getBoundingClientRect().width, 0) + (chips.length - 1) * parseFloat(cs.columnGap) }
  })
  row.chips = Math.round(row.chips)
  const sortChip = page.locator('.search-chips .sort-chip button.chip')
  const folderChip = page.locator('.search-chips .folder-chip button.chip')
  check('one chip row at 1280 px: every chip on the same line (Példa Kft., 3 chips on)', row.tops.length === 1 && row.n === 8 && row.width === 1280, JSON.stringify(row))
  check('the order chip: "Dátum" + arrow on screen, "Rendezés: Dátum, csökkenő" as its name and tooltip', (await sortChip.innerText()).trim() === t.listSortField.date && (await sortChip.locator('[data-icon="sortDesc"]').count()) === 1 && (await sortChip.getAttribute('aria-label')) === t.listSortChip('date', 'desc') && (await sortChip.getAttribute('title')) === t.listSortChip('date', 'desc'))
  const cut = await folderChip.locator('.chip-value').evaluate(el => ({ w: el.getBoundingClientRect().width, full: el.scrollWidth }))
  check('the folder chip: the last level ("Példa Kft.", at most 160 px), the full path as name and tooltip', (await folderChip.innerText()).trim() === `${t.searchFilter.folder}: Példa Kft.` && cut.w <= 160 && (await folderChip.getAttribute('title')) === `${t.searchFilter.folder}: Ügyfelek/Példa Kft.` && (await folderChip.getAttribute('aria-label')) === `${t.searchFilter.folder}: Ügyfelek/Példa Kft.`, JSON.stringify(cut))
  await page.locator('.list-header').getByRole('button', { name: t.clearFilters, exact: true }).click()
  await page.locator('.folder[data-path="INBOX"]').click()
  await page.waitForFunction(n => document.querySelector('.list-count')?.dataset.total === n, totalBefore)
  if (!(await page.locator('.search-chips').count())) await page.getByRole('button', { name: t.searchFiltersButton, exact: true }).click()
  await page.locator('.search-chips').getByRole('button', { name: new RegExp(`^${esc(t.searchFilter.from)}`) }).click()
  await page.getByRole('dialog', { name: t.searchFilter.from }).getByLabel(t.searchFilter.from, { exact: true }).fill('Kovács')
  await page.locator('.result').first().waitFor({ timeout: 5000 })
  const senders = await page.locator('.result .col-from').allInnerTexts()
  check('(4) the sender alone searches, without a query', senders.length > 0 && senders.every(x => x.includes('Kovács')), JSON.stringify(senders.slice(0, 3)))
  await page.keyboard.press('Escape') // the panel
  await box.press('Escape') // the search
  await page.locator('.list-header').waitFor()

  // fold the account and open it again
  await page.locator('.account-toggle').click()
  check('the account folds its folders away', (await page.locator('.folder[data-path]').count()) === 0)
  await page.locator('.account-toggle').click()
  check('and shows them again', (await page.locator('.folder[data-path]').count()) > 0)

  // collapse the sidebar
  await page.getByRole('button', { name: t.sidebarCollapse, exact: true }).click()
  await page.locator('.sidebar.collapsed').waitFor()
  check('collapsed sidebar is 72 px', (await width(page, '.sidebar')) === 72)
  check('the menu button now says "Oldalsáv kinyitása"', (await page.getByRole('button', { name: t.sidebarExpand, exact: true }).count()) === 1)
  check('folders keep their names (accessible) and get tooltips', (await page.getByRole('button', { name: new RegExp(`^${esc(t.folderRoles.inbox)}`) }).getAttribute('title')).startsWith(t.folderRoles.inbox) && (await page.locator('.folder[data-path="Sent"]').getAttribute('title')) === t.folderRoles.sent)
  check('"Új levél" icon only, its name kept, tooltip', (await page.getByRole('button', { name: t.newMessage, exact: true }).getAttribute('title')) === t.newMessage && (await width(page, '.compose-button')) === 56)
  const c = await audit(page)
  check('collapsed: still no native control or unnamed icon button', c.native === 0 && c.unnamed === 0 && c.noTitle === 0, JSON.stringify(c))
  await page.screenshot({ path: path.join(work, 'collapsed.png') })
} finally {
  await app.close().catch(() => {})
}

// restart: the folded state is kept
;({ app, page } = await start())
try {
  check('after a restart the sidebar is still folded (72 px)', (await page.locator('.sidebar.collapsed').count()) === 1 && (await width(page, '.sidebar')) === 72)
  await page.getByRole('button', { name: t.sidebarExpand, exact: true }).click()
  check('unfolds again to 256 px', (await width(page, '.sidebar')) === 256)

  // settings and back
  await page.getByRole('button', { name: t.viewSettings, exact: true }).click()
  await page.locator('.settings').waitFor()
  check('settings: the settings button is pressed', (await page.getByRole('button', { name: t.viewSettings, exact: true }).getAttribute('aria-pressed')) === 'true')
  await page.getByRole('button', { name: t.backToMail, exact: true }).click()
  await page.locator('.folder-tree .folder').first().waitFor()
  check('"Vissza a levelekhez" returns to the mail view', (await page.locator('.settings').count()) === 0)
  await page.getByRole('button', { name: t.viewSettings, exact: true }).click()
  await page.getByRole('button', { name: t.viewSettings, exact: true }).click()
  check('the settings button toggles back too', await page.locator('.folder-tree').waitFor({ timeout: 5000 }).then(() => true, () => false))
} finally {
  await app.close().catch(() => {})
}

// the message in the list's place, back with the same scroll position and selection
;({ app, page } = await start())
try {
  const viewport = page.locator('.msg-viewport')
  await viewport.evaluate(el => (el.scrollTop = 200))
  await page.waitForTimeout(200)
  const rowsInView = await page.locator('.msg-row[data-id]').evaluateAll(rows => {
    const vp = document.querySelector('.msg-viewport').getBoundingClientRect()
    return rows.filter(r => { const b = r.getBoundingClientRect(); return b.top >= vp.top && b.bottom <= vp.bottom }).map(r => r.dataset.id)
  })
  const [selId, openIdA] = rowsInView
  await page.locator(`.msg-row[data-id="${selId}"] .col-check input`).check()
  const before = { top: await viewport.evaluate(el => el.scrollTop), sel: await page.locator('.selection-count').innerText() }
  await page.locator(`.msg-row[data-id="${openIdA}"]`).click()
  await page.locator('.reader:not(.reader-empty)').waitFor()
  check('a click opens the message in the list\'s place: the list is hidden, the row not selected', !(await page.locator('.list-area').isVisible()) && (await page.locator(`.msg-row[data-id="${openIdA}"]`).getAttribute('aria-selected')) === 'false')
  const backBtn = page.getByRole('button', { name: t.backToList, exact: true })
  check('"Vissza a listához" icon button (aria-label + title)', (await backBtn.count()) === 1 && (await backBtn.getAttribute('title')) === t.backToList)
  const same = async () => ({ top: await viewport.evaluate(el => el.scrollTop), sel: await page.locator('.selection-count').innerText() })
  await backBtn.click()
  await page.locator('.list-area').waitFor({ state: 'visible' })
  const afterBack = await same()
  check('back: the same scroll position and selection', JSON.stringify(afterBack) === JSON.stringify(before), `${JSON.stringify(before)} -> ${JSON.stringify(afterBack)}`)
  for (const k of ['Escape', 'Backspace']) {
    await page.locator(`.msg-row[data-id="${openIdA}"]`).click()
    await page.locator('.reader:not(.reader-empty)').waitFor()
    await page.keyboard.press(k)
    await page.locator('.list-area').waitFor({ state: 'visible' })
    check(`${k}: back to the list, same position and selection`, JSON.stringify(await same()) === JSON.stringify(before))
  }
  // an openable message (a test letter at the top): monogram, icon toolbar, attachment cards, no native control
  await viewport.evaluate(el => (el.scrollTop = 0))
  await page.locator('.msg-row', { hasText: 'Beadás képpel és mellékletekkel' }).click()
  await page.locator('.reader[data-message-id] .attachment-card').first().waitFor()
  const rd = await page.evaluate(() => ({
    avatar: document.querySelector('.reader .avatar')?.textContent,
    tools: [...document.querySelectorAll('.reader-tools button')].map(b => b.getAttribute('aria-label')),
    native: document.querySelectorAll('button:not([class]), select').length,
    unnamed: document.querySelectorAll('button.icon-btn:not([aria-label])').length,
    cards: document.querySelectorAll('.reader-attachments li[data-filename].attachment-card').length,
  }))
  check('reader: monogram, the icon toolbar with the old names, cards, no native control', rd.avatar === 'KÁ' && [t.actions.star, t.replyModes.reply, t.replyModes.replyAll, t.replyModes.forward, t.actions.delete, t.actions.move, t.readerMore].every(n => rd.tools.includes(n)) && rd.cards === 3 && rd.native === 0 && rd.unnamed === 0, JSON.stringify(rd))
  await page.keyboard.press('Escape')

  // the setting: right, at once
  const setPane = async label => {
    await page.getByRole('button', { name: t.viewSettings, exact: true }).click()
    await page.getByRole('button', { name: t.settingsNav.appearance, exact: true }).click() // the settings tabs
    await page.getByRole('button', { name: t.readerPaneLabel, exact: true }).click()
    await page.getByRole('menuitemradio', { name: label, exact: true }).click()
    await page.getByRole('button', { name: t.backToMail, exact: true }).click()
    await page.locator('.msg-row[data-id]').first().waitFor()
  }
  await setPane(t.readerPaneOptions.right)
  await page.locator('.msg-row', { hasText: 'Beadás képpel és mellékletekkel' }).click()
  await page.locator('.reader[data-message-id]').waitFor()
  const geoRight = await page.evaluate(() => ({ list: document.querySelector('.list-area').getBoundingClientRect().right, reader: document.querySelector('.reader').getBoundingClientRect().left, panes: document.querySelector('.mail-panes').className }))
  check('"Jobbra": the list stays, the reader on its right, no back button', geoRight.panes.includes('pane-right') && geoRight.reader >= geoRight.list - 1 && (await page.locator('.list-area').isVisible()) && (await page.locator('.reader-back').count()) === 0, JSON.stringify(geoRight))

  // a narrow list: the row never scrolls sideways, the date and the icons stay whole, the sender shrinks (not under
  // fromMin); from 600 px on the row is the old fixed grid, cell for cell
  const colFrom = await token(page, '--col-from')
  for (const want of LIST_WIDTHS) {
    const got = await dragListTo(page, want)
    const g = await rowGeometry(page)
    const tag = `list ${want} px (${got})`
    check(`${tag}: the list does not scroll sideways, no row overflows`, Math.abs(got - want) <= 2 && g.vpScroll <= g.vpClient && g.nBad === 0 && g.rows > 5, JSON.stringify({ vp: [g.vpScroll, g.vpClient], bad: g.bad, rows: g.rows }))
    check(`${tag}: the date whole (the widest form "${g.widest.text}" fits too), star and attachment uncut, the sender at least ${fromMin(want)} px`, g.widest.w <= g.dateRoom && g.from >= fromMin(want), JSON.stringify({ widest: g.widest, room: g.dateRoom, from: g.from }))
    const point = SUBJECT_POINTS.find(p => p[0] === want)
    if (point) check(`${tag}: the subject at least ${point[1]} px, the sender at least 96 px`, g.widths[3] >= point[1] && g.from >= 96, JSON.stringify({ subject: g.widths[3], from: g.from }))
    if (want >= 600) {
      const old = await rowGeometry(page, OLD_GRID)
      // checkbox, star, sender: same place and width; the date 12 px wider to the left (its right edge kept), so the
      // subject 12 px narrower and the attachment 12 px to the left
      const same = [0, 1, 2].every(i => g.x[i] === old.x[i] && g.widths[i] === old.widths[i])
      const shifted = g.widths[3] === old.widths[3] - 12 && g.x[4] === old.x[4] - 12 && g.widths[4] === old.widths[4] && g.x[5] === old.x[5] - 12 && g.x[5] + g.widths[5] === old.x[5] + old.widths[5]
      check(`${tag}: the sender ${colFrom} px, checkbox, star and sender where the old grid puts them, only the date 12 px wider`, g.from === colFrom && same && shifted, JSON.stringify({ now: g.x, old: old.x, w: g.widths, oldW: old.widths }))
    }
    // the old-dated message at the bottom of the list: its full date whole in the cell
    const oldRow = await page.evaluate(async () => {
      const vp = document.querySelector('.msg-viewport')
      const top = vp.scrollTop
      vp.scrollTop = vp.scrollHeight
      await new Promise(r => setTimeout(r, 150))
      const date = [...document.querySelectorAll('.msg-row[data-id] .col-date')].find(d => /2008/.test(d.textContent))
      const res = date && { text: date.textContent, scroll: date.scrollWidth, client: date.clientWidth, inside: date.getBoundingClientRect().right <= date.parentElement.getBoundingClientRect().right + 0.5 }
      vp.scrollTop = top
      await new Promise(r => setTimeout(r, 150))
      return res
    })
    check(`${tag}: a message from an older year: its full date whole`, oldRow && oldRow.scroll <= oldRow.client && oldRow.inside, JSON.stringify(oldRow))
    if (shots && want === 360) {
      fs.mkdirSync(shots, { recursive: true })
      await page.locator('.msg-row[data-id]').nth(1).hover()
      await page.waitForTimeout(100)
      await page.locator('.list-area').screenshot({ path: path.join(shots, `LW1-360-${(await page.evaluate(() => document.documentElement.dataset.theme)) || 'default'}-${process.env.E2E_LANG || 'hu'}.png`) })
      await page.mouse.move(0, 0)
    }
  }
  // the same at 280 px for the search hits (the row's cells in the hit's button): a search closes the message, a hit
  // opened puts the reader (and the list divider) back next to the hits
  await page.getByRole('searchbox', { name: t.searchLabel }).fill('ajánlat')
  await page.locator('.result').first().waitFor()
  await page.waitForTimeout(300)
  await page.locator('.result-open').first().click()
  await page.locator('.splitter[data-split="list"]').waitFor()
  const hitsW = await dragListTo(page, 280, '.search-results')
  const hits = await page.evaluate(() => {
    const list = document.querySelector('.result-list')
    const bad = [...document.querySelectorAll('.result-open')].filter(b => {
      const date = b.querySelector('.col-date')
      const br = b.getBoundingClientRect(), dr = date.getBoundingClientRect()
      return b.scrollWidth > b.clientWidth || date.scrollWidth > date.clientWidth || dr.right > br.right + 0.5
    }).length
    return { scroll: list.scrollWidth, client: list.clientWidth, n: document.querySelectorAll('.result-open').length, bad, from: Math.round(document.querySelector('.result-open .col-from').getBoundingClientRect().width) }
  })
  check(`search hits at 280 px (${hitsW}): the list does not scroll sideways, every date whole`, Math.abs(hitsW - 280) <= 2 && hits.n > 0 && hits.scroll <= hits.client && hits.bad === 0, JSON.stringify(hits))
  // and at the first subject point: the hit's subject cell gets its share too
  const hitsW2 = await dragListTo(page, SUBJECT_POINTS[0][0], '.search-results')
  const hitCells = await page.locator('.result-open').first().evaluate(b => [...b.children].map(c => [c.className.split(' ')[0], Math.round(c.getBoundingClientRect().width)]))
  const hitSubject = (hitCells.find(c => c[0] === 'col-text') || [])[1]
  const hitFrom = (hitCells.find(c => c[0] === 'col-from') || [])[1]
  check(`search hits at ${SUBJECT_POINTS[0][0]} px (${hitsW2}): the subject at least ${SUBJECT_POINTS[0][1]} px, the sender at least 96 px`, Math.abs(hitsW2 - SUBJECT_POINTS[0][0]) <= 2 && hitSubject >= SUBJECT_POINTS[0][1] && hitFrom >= 96, JSON.stringify(hitCells))
  await page.keyboard.press('Escape')
} finally {
  await app.close().catch(() => {})
}
;({ app, page } = await start())
try {
  check('after a restart the setting is kept (right)', (await page.locator('.mail-panes.pane-right').count()) === 1)
  const setPane = async label => {
    await page.getByRole('button', { name: t.viewSettings, exact: true }).click()
    await page.getByRole('button', { name: t.settingsNav.appearance, exact: true }).click() // the settings tabs
    await page.getByRole('button', { name: t.readerPaneLabel, exact: true }).click()
    await page.getByRole('menuitemradio', { name: label, exact: true }).click()
    await page.getByRole('button', { name: t.backToMail, exact: true }).click()
    await page.locator('.msg-row[data-id]').first().waitFor()
  }
  await setPane(t.readerPaneOptions.bottom)
  await page.locator('.msg-row', { hasText: 'Beadás képpel és mellékletekkel' }).click()
  await page.locator('.reader[data-message-id]').waitFor()
  const geoBottom = await page.evaluate(() => ({ list: document.querySelector('.list-area').getBoundingClientRect().bottom, reader: document.querySelector('.reader').getBoundingClientRect().top }))
  check('"Alul": the reader under the list', geoBottom.reader >= geoBottom.list - 1 && (await page.locator('.mail-panes.pane-bottom').count()) === 1, JSON.stringify(geoBottom))
  await setPane(t.readerPaneOptions.none)
  check('back to "in the list\'s place"', (await page.locator('.mail-panes.pane-none').count()) === 1)
  // Beállítások / Névjegy: the data folder, the SQLite version, the version; the tabs without native controls
  await page.getByRole('button', { name: t.viewSettings, exact: true }).click()
  await page.getByRole('button', { name: t.settingsNav.about, exact: true }).click()
  await page.locator('dl.about dd').nth(1).waitFor()
  const about = await page.locator('dl.about').innerText()
  check('Névjegy: data folder, SQLite version, program version', about.includes(dataDir) && new RegExp(`${esc(t.helloSqlite)}\\s+3\\.\\d+`).test(about) && new RegExp(`${esc(t.helloVersion)}\\s+\\d+\\.\\d+\\.\\d+`).test(about), about.replace(/\s+/g, ' '))
  const tabsAudit = {}
  for (const tab of [t.settingsNav.accounts, t.settingsNav.appearance, t.settingsNav.security, t.settingsNav.about]) {
    await page.getByRole('button', { name: tab, exact: true }).click()
    tabsAudit[tab] = await page.evaluate(() => document.querySelectorAll('button:not([class]), select').length + document.querySelectorAll('button.icon-btn:not([aria-label])').length)
  }
  await page.getByRole('button', { name: t.settingsNav.accounts, exact: true }).click()
  await page.getByRole('button', { name: t.accountEdit, exact: true }).click()
  await page.locator('form.account-editor').waitFor()
  tabsAudit.editor = await page.evaluate(() => document.querySelectorAll('button:not([class]), select').length + document.querySelectorAll('button.icon-btn:not([aria-label])').length)
  check('every settings tab and the account editor: no native control, no unnamed icon button', Object.values(tabsAudit).every(n => n === 0), JSON.stringify(tabsAudit))
} finally {
  await app.close().catch(() => {})
}

const guard = path.join(dataDir, 'electron', 'logs', 'net-guard.log')
const guardText = fs.existsSync(guard) ? fs.readFileSync(guard, 'utf8').trim() : ''
check('net-guard log: no outgoing request', guardText === '', guardText.split('\n').slice(0, 3).join(' | '))
check('no renderer console error or warning', consoleLines.length === 0, consoleLines.slice(0, 3).join(' | '))
fs.rmSync(work, { recursive: true, force: true })
console.log(`\n${results.filter(Boolean).length} / ${results.length} OK`)
process.exit(results.every(Boolean) ? 0 : 1)
