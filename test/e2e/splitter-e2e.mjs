#!/usr/bin/env node
// The four draggable dividers in the real app. Not part of
// `npm test`.
//
//   node test/e2e/splitter-e2e.mjs [--shots docs/ui]
//   node test\e2e\splitter-e2e.mjs --zip <ShadowMail-...-win-x64.zip> --work <empty folder>   (Windows, the package: the exe
//     is driven over CDP with playwright-core (PW), the fuses forbid --inspect; the data folder is the exe's own `data`)
//
// Data: test/tools/seed-index.mjs (a dummy IMAP account at 127.0.0.1:1, nothing leaves the machine).
// Measures: each divider (sidebar | mail, list | reader on the right, list / reader at the bottom, settings menu | content)
// drags with the mouse (the pane follows within 2 px), stops at its minimum and maximum, goes back to the default on a
// double click and on Home, moves 16 px per arrow key with aria-valuenow following; the sizes are the same after a restart;
// in a 900x600 window the saved large sizes are clamped (every pane at least its minimum, no horizontal scroll bar);
// dragging keeps the list's scroll position and selection; a message dragged onto a folder still starts the move; a search
// result opens with the dragged widths; the focused divider shows the focus ring; no console problem; the net-guard log
// is empty. --shots: the default and the dragged layout.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { t, seedLanguage } from './lang.mjs'

const require = createRequire(import.meta.url)
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const arg = name => {
  const i = process.argv.indexOf(name)
  return i > 0 ? path.resolve(process.argv[i + 1]) : null
}
const shots = arg('--shots')
const zip = arg('--zip')
const sleep = ms => new Promise(r => setTimeout(r, ms))

let work
let dataDir
let appDir = null
if (zip) {
  work = arg('--work')
  fs.rmSync(work, { recursive: true, force: true })
  appDir = path.join(work, 'app')
  fs.mkdirSync(appDir, { recursive: true })
  execFileSync('tar', ['-xf', zip, '-C', appDir])
  dataDir = path.join(appDir, 'data')
} else {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-s1-e2e-'))
  dataDir = path.join(work, 'data')
}
const seed = JSON.parse(execFileSync(process.execPath, [path.join(repo, 'test', 'tools', 'seed-index.mjs'), dataDir, '--count', '120', '--previews', '--eml', path.join(repo, 'test', 'fixtures', 'mail')], { encoding: 'utf8' }))
seedLanguage(dataDir)

const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const consoleLines = []
const near = (a, b, tol = 2) => Math.abs(a - b) <= tol

// the package: the exe with a CDP port; closing = closing the main window (a CDP Browser.close does not quit the app)
async function launchPackage() {
  const { chromium } = require(process.env.PW || 'playwright-core')
  const port = 9970 + Math.floor(Math.random() * 20)
  const env = { ...process.env }
  delete env.SHADOWMAIL_DATA
  const proc = spawn(path.join(appDir, 'ShadowMail.exe'), [`--remote-debugging-port=${port}`], { cwd: appDir, env, stdio: 'ignore' })
  let browser = null
  for (let i = 0; i < 60 && !browser; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    } catch {
      await sleep(500)
    }
  }
  const context = browser.contexts()[0]
  let page = context.pages().find(p => p.url().includes('index.html'))
  for (let i = 0; i < 40 && !page; i++) {
    await sleep(250)
    page = context.pages().find(p => p.url().includes('index.html'))
  }
  const close = async () => {
    await page.evaluate(() => window.close()).catch(() => {})
    for (let i = 0; i < 40 && proc.exitCode === null; i++) await sleep(250)
    await browser.close().catch(() => {})
    if (proc.exitCode === null) {
      try {
        execFileSync('taskkill', ['/F', '/T', '/PID', String(proc.pid)])
      } catch {}
    }
  }
  return { app: { close }, page }
}

async function start(size = { width: 1280, height: 800 }) {
  let app
  let page
  if (zip) ({ app, page } = await launchPackage())
  else {
    const { _electron } = require(process.env.PW || 'playwright-core')
    app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
    page = await app.firstWindow()
  }
  page.on('console', m => (m.type() === 'error' || m.type() === 'warning') && consoleLines.push(`${m.type()}: ${m.text()}`))
  page.on('pageerror', e => consoleLines.push(`pageerror: ${e.message}`))
  await page.setViewportSize(size)
  await page.locator('#vault-unlock').fill(seed.master)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  await page.locator('.msg-row[data-id]').first().waitFor({ timeout: 30_000 })
  return { app, page }
}

const box = (page, sel) => page.locator(sel).first().evaluate(el => {
  const r = el.getBoundingClientRect()
  return { w: Math.round(r.width), h: Math.round(r.height) }
})
const splitter = (page, name) => page.locator(`.splitter[data-split="${name}"]`)
// a mouse drag on the divider's centre by (dx, dy)
async function drag(page, name, dx, dy = 0) {
  const b = await splitter(page, name).boundingBox()
  const x = b.x + b.width / 2
  // the middle of the VISIBLE part: a divider beside a tall, scrolled page reaches below the window (measured: 961 px
  // tall in a 600 px window), and the middle of its box is then off-screen, where no pointer event lands
  const vh = page.viewportSize()?.height ?? Infinity
  const y = (Math.max(b.y, 0) + Math.min(b.y + b.height, vh)) / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 })
  await page.mouse.move(x + dx, y + dy, { steps: 4 })
  await page.mouse.up()
  await page.waitForTimeout(80)
}
async function setPane(page, label) {
  await page.getByRole('button', { name: t.viewSettings, exact: true }).click()
  await page.getByRole('button', { name: t.settingsNav.appearance, exact: true }).click()
  await page.getByRole('button', { name: t.readerPaneLabel, exact: true }).click()
  await page.getByRole('menuitemradio', { name: label, exact: true }).click()
  await page.getByRole('button', { name: t.backToMail, exact: true }).click()
  await page.locator('.msg-row[data-id]').first().waitFor()
}
const openFirst = async page => {
  await page.locator('.msg-row[data-id]').nth(3).click()
  await page.locator('.reader[data-message-id]').waitFor()
}
const noHorizontalScroll = page => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth && document.body.scrollWidth <= document.body.clientWidth)

let app
let page
try {
  ;({ app, page } = await start())
  if (shots) {
    fs.mkdirSync(shots, { recursive: true })
    await page.screenshot({ path: path.join(shots, 'splitter-default.png') })
  }

  // 1. sidebar | mail
  const side0 = (await box(page, 'aside.sidebar')).w
  check('the sidebar starts at its default (256 px)', near(side0, 256), String(side0))
  const sep = splitter(page, 'sidebar')
  check('the divider: separator, vertical, named, in the tab order', (await sep.getAttribute('role')) === 'separator' && (await sep.getAttribute('aria-orientation')) === 'vertical' && (await sep.getAttribute('aria-label')) === t.splitters.sidebar && (await sep.getAttribute('tabindex')) === '0')
  await drag(page, 'sidebar', 100)
  const side1 = (await box(page, 'aside.sidebar')).w
  check('sidebar: dragged +100 -> +100 (±2 px)', near(side1, side0 + 100), `${side0} -> ${side1}`)
  const headerCol = await page.locator('.app-header').evaluate(el => Math.round(parseFloat(getComputedStyle(el).gridTemplateColumns.split(' ')[0])))
  check('the header\'s first column follows the sidebar', near(headerCol, side1), `${headerCol} / ${side1}`)
  await drag(page, 'sidebar', 1000)
  check('sidebar: not over 480', near((await box(page, 'aside.sidebar')).w, 480))
  await drag(page, 'sidebar', -1000)
  check('sidebar: not under 180', near((await box(page, 'aside.sidebar')).w, 180))
  await page.locator('.splitter[data-split="sidebar"]').dblclick()
  await page.waitForTimeout(80)
  check('sidebar: a double click gives back 256', near((await box(page, 'aside.sidebar')).w, 256))
  await sep.focus()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(80)
  const kb = (await box(page, 'aside.sidebar')).w
  check('sidebar: two ArrowRight = +32 px, aria-valuenow follows', near(kb, 288) && Number(await sep.getAttribute('aria-valuenow')) === kb, `${kb} / ${await sep.getAttribute('aria-valuenow')}`)
  const ring = await sep.evaluate(el => getComputedStyle(el).outlineStyle)
  check('the focused divider shows the focus ring', ring !== 'none', ring)
  await page.keyboard.press('Home')
  await page.waitForTimeout(80)
  check('sidebar: Home gives back 256', near((await box(page, 'aside.sidebar')).w, 256) && Number(await sep.getAttribute('aria-valuenow')) === 256)

  // 2. list | reader (right)
  await setPane(page, t.readerPaneOptions.right)
  check('no list divider while no message is open', (await splitter(page, 'list').count()) === 0)
  await openFirst(page)
  const panesW = (await box(page, '.mail-panes')).w
  const list0 = (await box(page, '.list-area')).w
  await drag(page, 'list', -100)
  const list1 = (await box(page, '.list-area')).w
  check('list | reader: dragged -100 -> -100 (±2 px)', near(list1, list0 - 100), `${list0} -> ${list1}`)
  await drag(page, 'list', -1000)
  check('list: not under 280', near((await box(page, '.list-area')).w, 280))
  await drag(page, 'list', 2000)
  const readerAtMax = (await box(page, '.mail-panes > .reader')).w
  check('list: the reader keeps its 360', near(readerAtMax, 360) && near((await box(page, '.list-area')).w, panesW - 360), `${readerAtMax}`)
  await page.locator('.splitter[data-split="list"]').dblclick()
  await page.waitForTimeout(80)
  check('list: a double click gives back the default share', near((await box(page, '.list-area')).w, list0), `${(await box(page, '.list-area')).w} / ${list0}`)
  await splitter(page, 'list').focus()
  await page.keyboard.press('ArrowLeft')
  await page.waitForTimeout(80)
  check('list: ArrowLeft = -16 px', near((await box(page, '.list-area')).w, list0 - 16))
  await page.keyboard.press('Home')

  // the list's scroll and selection do not jump while dragging
  // select first (a click scrolls its row into view), then scroll, then drag
  await page.locator('.msg-row[data-id] .col-check input').first().click()
  const scroller = await page.evaluate(() => {
    const el = [...document.querySelectorAll('.list-area *')].find(e => e.scrollHeight > e.clientHeight + 50 && getComputedStyle(e).overflowY !== 'visible')
    if (!el) return null
    el.scrollTop = 600
    el.setAttribute('data-test-scroller', '')
    return el.scrollTop
  })
  await page.waitForTimeout(150)
  const sel0 = await page.locator('.selection-count').textContent().catch(() => null)
  const top0 = await page.locator('[data-test-scroller]').evaluate(el => el.scrollTop)
  await drag(page, 'list', -80)
  const top1 = await page.locator('[data-test-scroller]').evaluate(el => el.scrollTop)
  const sel1 = await page.locator('.selection-count').textContent().catch(() => null)
  check('dragging keeps the list\'s scroll position and selection', scroller !== null && top0 > 0 && near(top0, top1, 1) && sel0 && sel0 === sel1, `${top0} -> ${top1}, ${sel0} -> ${sel1}`)
  const listDragged = (await box(page, '.list-area')).w

  // a message dragged onto a folder still reaches the move (the dummy IMAP server refuses it: the error bar says so)
  const target = page.locator('.folder-tree .folder').filter({ hasNot: page.locator('[aria-current="true"]') }).nth(1)
  await page.locator('.msg-row[data-id]').nth(5).dragTo(target)
  await page.waitForTimeout(500)
  const moved = await page.evaluate(() => Boolean(document.querySelector('.action-error') || document.querySelector('.msg-row.moving, .msg-row[data-overlay]')))
  check('a message dragged onto a folder starts the move (drag-and-drop unchanged)', moved)
  await page.locator('.action-error button').first().click().catch(() => {})

  // 3. settings menu | content
  await page.getByRole('button', { name: t.viewSettings, exact: true }).click()
  const nav0 = (await box(page, '.settings-nav')).w
  check('settings menu starts at 240', near(nav0, 240), String(nav0))
  await drag(page, 'settings', 60)
  check('settings menu: dragged +60', near((await box(page, '.settings-nav')).w, 300))
  await drag(page, 'settings', 1000)
  check('settings menu: not over 400', near((await box(page, '.settings-nav')).w, 400))
  await drag(page, 'settings', -1000)
  check('settings menu: not under 180', near((await box(page, '.settings-nav')).w, 180))
  await drag(page, 'settings', 120)
  const navSaved = (await box(page, '.settings-nav')).w

  // 4. list / reader (bottom)
  await page.getByRole('button', { name: t.backToMail, exact: true }).click()
  await setPane(page, t.readerPaneOptions.bottom)
  await openFirst(page)
  const sepH = splitter(page, 'listh')
  check('the bottom divider is horizontal', (await sepH.getAttribute('aria-orientation')) === 'horizontal')
  const h0 = (await box(page, '.list-area')).h
  await drag(page, 'listh', 0, 60)
  check('list / reader: dragged +60 -> +60 (±2 px)', near((await box(page, '.list-area')).h, h0 + 60), `${h0} -> ${(await box(page, '.list-area')).h}`)
  await drag(page, 'listh', 0, -2000)
  check('list (bottom): not under 120', near((await box(page, '.list-area')).h, 120))
  await drag(page, 'listh', 0, 2000)
  check('list (bottom): the reader keeps its 160', near((await box(page, '.mail-panes > .reader')).h, 160))
  await sepH.focus()
  await page.keyboard.press('Home')
  await page.waitForTimeout(80)
  check('list (bottom): Home gives back the default', near((await box(page, '.list-area')).h, h0))
  await page.keyboard.press('ArrowUp')
  await page.waitForTimeout(80)
  const hSaved = (await box(page, '.list-area')).h
  check('list (bottom): ArrowUp = -16 px', near(hSaved, h0 - 16))

  // back to right, a sidebar width to keep, the search with the dragged widths
  await setPane(page, t.readerPaneOptions.right)
  await drag(page, 'sidebar', 64)
  const sideSaved = (await box(page, 'aside.sidebar')).w
  const search = page.getByRole('searchbox', { name: t.searchLabel })
  await search.fill('Beadás')
  await page.locator('.result-open').first().waitFor({ timeout: 15_000 })
  await page.locator('.result-open').first().click()
  await page.locator('.reader[data-message-id]').waitFor()
  check('a search result opens with the dragged list width (the same divider)', (await splitter(page, 'list').count()) === 1 && near((await box(page, '.list-area')).w, listDragged), `${(await box(page, '.list-area')).w} / ${listDragged}`)
  // the dragged layout: a search result open in the right reader
  if (shots) await page.screenshot({ path: path.join(shots, 'splitter-dragged.png') })
  await page.keyboard.press('Escape')
  await app.close()

  // 5. after a restart: the same sizes
  ;({ app, page } = await start())
  check('after a restart: the sidebar width', near((await box(page, 'aside.sidebar')).w, sideSaved), `${(await box(page, 'aside.sidebar')).w} / ${sideSaved}`)
  await openFirst(page)
  check('after a restart: the list width', near((await box(page, '.list-area')).w, listDragged), `${(await box(page, '.list-area')).w} / ${listDragged}`)
  await page.getByRole('button', { name: t.viewSettings, exact: true }).click()
  check('after a restart: the settings menu width', near((await box(page, '.settings-nav')).w, navSaved))
  await page.getByRole('button', { name: t.backToMail, exact: true }).click()
  await openFirst(page)

  // 6. large saved sizes in a small window
  await drag(page, 'sidebar', 1000)
  await drag(page, 'list', 2000)
  await page.setViewportSize({ width: 900, height: 600 })
  await page.waitForTimeout(300)
  const small = {
    side: (await box(page, 'aside.sidebar')).w,
    list: (await box(page, '.list-area')).w,
    reader: (await box(page, '.mail-panes > .reader')).w,
  }
  check('900x600: every pane at least its minimum (sidebar 180, list 280, reader 360)', small.side >= 179 && small.list >= 279 && small.reader >= 359, JSON.stringify(small))
  check('900x600: no horizontal scroll bar', await noHorizontalScroll(page))
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.waitForTimeout(300)
  check('back to 1280: the saved large sizes return (480)', near((await box(page, 'aside.sidebar')).w, 480))
  // the folded sidebar has no divider, and the width comes back on unfold
  await page.getByRole('button', { name: t.sidebarCollapse, exact: true }).click().catch(() => {})
  await page.waitForTimeout(150)
  const folded = await page.locator('aside.sidebar.collapsed').count()
  check('a folded sidebar has no divider', folded === 1 && (await splitter(page, 'sidebar').count()) === 0)
  await page.getByRole('button', { name: t.sidebarExpand, exact: true }).click().catch(() => {})
  await page.waitForTimeout(150)
  check('unfolded: the saved width is back', near((await box(page, 'aside.sidebar')).w, 480))

  // 7. a sidebar change re-fits the list; nothing slides out of the window
  const fitState = () =>
    page.evaluate(() => {
      const main = document.querySelector('.mail-main')
      const reader = document.querySelector('.mail-panes > .reader')
      const list = document.querySelector('.list-area')
      return {
        overflow: main.scrollWidth - main.clientWidth,
        readerRight: Math.round(reader.getBoundingClientRect().right),
        win: window.innerWidth,
        list: Math.round(list.getBoundingClientRect().width),
        reader: Math.round(reader.getBoundingClientRect().width),
        listMax: Number(document.querySelector('.splitter[data-split="list"]')?.getAttribute('aria-valuemax')),
      }
    })
  const fits = f => f.overflow <= 0 && f.readerRight <= f.win && f.list >= 279 && f.reader >= 359
  await page.locator('.splitter[data-split="sidebar"]').dblclick()
  await drag(page, 'list', 2000)
  await drag(page, 'sidebar', 300)
  const fa = await fitState()
  check('case A: list at its max, then the sidebar +300: the list gives way, the reader stays in the window', fits(fa) && near(fa.listMax, fa.list), JSON.stringify(fa))
  await page.locator('.splitter[data-split="sidebar"]').dblclick()
  await page.getByRole('button', { name: t.sidebarCollapse, exact: true }).click()
  await page.waitForTimeout(150)
  await drag(page, 'list', 2000)
  await page.getByRole('button', { name: t.sidebarExpand, exact: true }).click()
  await page.waitForTimeout(300)
  const fb = await fitState()
  check('case B: list at its max on a folded sidebar, then unfold: the reader stays in the window', fits(fb), JSON.stringify(fb))
  await page.setViewportSize({ width: 1100, height: 720 })
  await page.waitForTimeout(200)
  await page.locator('.splitter[data-split="list"]').dblclick()
  await drag(page, 'sidebar', 1000)
  const fc = await fitState()
  check('case C: 1100x720, the default list share, the sidebar at its max: the reader stays in the window', fits(fc), JSON.stringify(fc))
  await page.locator('.splitter[data-split="sidebar"]').dblclick()
  // E: a saved 400 px menu, then a 760 px window, then a drag to the max there
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.waitForTimeout(200)
  await page.getByRole('button', { name: t.viewSettings, exact: true }).click()
  await page.getByRole('button', { name: t.settingsNav.appearance, exact: true }).click()
  await drag(page, 'settings', 1000)
  check('case E: at 1280 the menu goes to 400', near((await box(page, '.settings-nav')).w, 400))
  const settingsFit = () =>
    page.evaluate(() => {
      const sct = document.querySelector('section.settings')
      return { overflow: sct.scrollWidth - sct.clientWidth, nav: Math.round(document.querySelector('.settings-nav').getBoundingClientRect().width), page: document.documentElement.scrollWidth - document.documentElement.clientWidth }
    })
  await page.setViewportSize({ width: 760, height: 600 })
  await page.waitForTimeout(300)
  const fe = await settingsFit()
  check('case E: 760x600 with the saved 400: the menu narrower, no horizontal scroll bar', fe.overflow <= 0 && fe.page <= 0 && fe.nav >= 180 && fe.nav < 400, JSON.stringify(fe))
  await drag(page, 'settings', 1000)
  const fe2 = await settingsFit()
  check('case E: 760x600, dragged to the max there: no horizontal scroll bar', fe2.overflow <= 0 && fe2.page <= 0, JSON.stringify(fe2))
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.waitForTimeout(300)
  check('case E: back at 1280 the menu is the size dragged at 760 (the drag saved it)', near((await box(page, '.settings-nav')).w, fe2.nav), `${(await box(page, '.settings-nav')).w} / ${fe2.nav}`)
  await page.getByRole('button', { name: t.backToMail, exact: true }).click()

  check('no console error or warning', consoleLines.length === 0, consoleLines.join(' | '))
  const netLog = path.join(dataDir, 'electron', 'logs', 'net-guard.log')
  check('the net-guard log has no outgoing request', !fs.existsSync(netLog) || fs.readFileSync(netLog, 'utf8').trim() === '')
} catch (err) {
  check('the run', false, err.stack)
} finally {
  await app?.close().catch(() => {})
  if (!zip) fs.rmSync(work, { recursive: true, force: true })
}
const ok = results.filter(Boolean).length
console.log(`${ok} / ${results.length} ${ok === results.length ? 'OK' : 'FAIL'}`)
process.exit(ok === results.length ? 0 : 1)
