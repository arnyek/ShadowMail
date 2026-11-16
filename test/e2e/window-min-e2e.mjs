// The main window's minimum width in the real app (headless Electron + Playwright). The window itself is sized here
// (BrowserWindow.setSize), not an emulated viewport, so the page gets what the window really allows:
// - setSize(600, 700) gives a window 860 wide (its minimum);
// - at 860 px with the reader on the right and NO saved sidebar width (the default state): the sidebar narrows by itself
//   (between its 180 minimum and its 256 default), the reader is not cut off (its right edge within the panes, the
//   panes' margin within the page), no horizontal scroll; a wider window (1280) gives the sidebar its 256 back, and no
//   sidebar width was saved by all this;
// - a saved 400 px sidebar at 860 px: not cut off either, and the saved 400 stays (back at 1280 it is 400 again);
// - at 860 px with the reader at the bottom, in Címlista and in Beállítások: nothing cut off, no horizontal scroll;
// - the composer window has no minimum of its own (its 900 x 700 is checked in the source, see below).
// Data: test/tools/seed-index.mjs (a dummy IMAP account at 127.0.0.1:1, nothing leaves the machine).
// Needs a fresh renderer build first: npx vite build
//
//   node test/e2e/window-min-e2e.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { t, seedLanguage } from './lang.mjs'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-window-min-e2e-'))
const dataDir = path.join(work, 'data')
const seed = JSON.parse(execFileSync(process.execPath, [path.join(repo, 'test', 'tools', 'seed-index.mjs'), dataDir, '--count', '40', '--previews', '--eml', path.join(repo, 'test', 'fixtures', 'mail')], { encoding: 'utf8' }))
seedLanguage(dataDir)

const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const consoleLines = []
const SUBJECT = 'Beadás képpel és mellékletekkel'

// the composer window's title (no subject yet)
const composeTitle = t.composeTitle
const mainSize = app => app.evaluate(({ BrowserWindow }, title) => {
  const w = BrowserWindow.getAllWindows().find(x => !x.getTitle().startsWith(title))
  return { size: w.getSize(), min: w.getMinimumSize() }
}, composeTitle)
const setMainSize = (app, width, height) => app.evaluate(({ BrowserWindow }, [wd, ht, title]) => {
  BrowserWindow.getAllWindows().find(x => !x.getTitle().startsWith(title)).setSize(wd, ht)
}, [width, height, composeTitle])

// the page's width, its scroll width, and the right edge of the given elements (the widest one counts)
const fit = (page, selectors) =>
  page.evaluate(sels => {
    const doc = document.documentElement
    const rights = sels.map(s => [...document.querySelectorAll(s)].reduce((m, el) => Math.max(m, el.getBoundingClientRect().right), -1))
    return { width: doc.clientWidth, scroll: doc.scrollWidth, inner: window.innerWidth, rights: Object.fromEntries(sels.map((s, i) => [s, Math.round(rights[i] * 10) / 10])) }
  }, selectors)
const fits = f => f.scroll <= f.width && Object.values(f.rights).every(r => r >= 0 && r <= f.width)

let app = null
try {
  app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
  const page = await app.firstWindow()
  page.on('console', m => (m.type() === 'error' || m.type() === 'warning') && consoleLines.push(`${m.type()}: ${m.text()}`))
  page.on('pageerror', e => consoleLines.push(`pageerror: ${e.message}`))
  await page.waitForLoadState('domcontentloaded')

  // the minimum: asked 600 wide, the window is 860
  await setMainSize(app, 600, 700)
  await page.waitForTimeout(300)
  const small = await mainSize(app)
  const inner = await page.evaluate(() => window.innerWidth)
  check('setSize(600, 700): the main window is 860 wide (its minimum), the page too', small.size[0] === 860 && small.size[1] === 700 && small.min[0] === 860 && inner === 860, JSON.stringify({ ...small, inner }))

  await page.locator('#vault-unlock').fill(seed.master)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  await page.locator('.msg-row[data-id]').first().waitFor()

  // the reader on the right, a message open: nothing cut off, no horizontal scroll
  const setPane = async pane => {
    for (let i = 0; i < 3 && (await page.locator(`.mail-panes.pane-${pane}`).count()) === 0; i++) await page.locator('.reader-pane-switch').click()
    await page.locator(`.mail-panes.pane-${pane}`).waitFor({ timeout: 2000 })
  }
  const savedSidebar = () => page.evaluate(() => localStorage.getItem('shadowmail.ui.split.sidebar'))
  const sidebarW = () => page.locator('.sidebar').evaluate(el => Math.round(el.getBoundingClientRect().width))
  // the reader within the panes and the panes' margin within the page
  const readerInside = () =>
    page.evaluate(() => {
      const r = s => document.querySelector(s).getBoundingClientRect()
      return { reader: Math.round(r('.reader:not(.reader-empty)').right), panes: Math.round(r('.mail-panes').right), main: Math.round(r('.mail-main').right), width: document.documentElement.clientWidth }
    })
  const inside = g => g.reader <= g.panes && g.panes <= g.width
  const savedBefore = await savedSidebar()
  await setPane('right')
  await page.locator('.msg-row', { hasText: SUBJECT }).click()
  await page.locator('.reader[data-message-id]:not(.reader-empty)').waitFor()
  await page.waitForTimeout(300)
  const right = await fit(page, ['.reader:not(.reader-empty)', '.reader-toolbar', '.list-area', '.app-header-end'])
  const rightIn = await readerInside()
  const narrowed = await sidebarW()
  check('860 px, reader on the right, NO saved sidebar width: the sidebar narrows (180..256), the reader is not cut off, no horizontal scroll', fits(right) && inside(rightIn) && narrowed >= 180 && narrowed < 256, JSON.stringify({ sidebar: narrowed, ...rightIn, scroll: right.scroll }))

  await setMainSize(app, 1280, 700)
  await page.waitForTimeout(400)
  const back = await sidebarW()
  const savedAfter = await savedSidebar()
  check('back at 1280: the sidebar is 256 again; no sidebar width was saved (before and after the same)', back === 256 && savedBefore === savedAfter && savedAfter === null, JSON.stringify({ back, savedBefore, savedAfter }))

  // a saved 400 px sidebar (keyboard: 256 + 9 x 16), then 860 px: not cut off, the saved 400 stays
  const sep = page.getByRole('separator', { name: t.splitters.sidebar, exact: true })
  await sep.focus()
  for (let i = 0; i < 9; i++) await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(200)
  const set400 = { width: await sidebarW(), saved: await savedSidebar() }
  await setMainSize(app, 600, 700)
  await page.waitForTimeout(400)
  const at860 = { sidebar: await sidebarW(), saved: await savedSidebar(), ...(await readerInside()) }
  const right400 = await fit(page, ['.reader:not(.reader-empty)', '.reader-toolbar', '.list-area', '.app-header-end'])
  await setMainSize(app, 1280, 700)
  await page.waitForTimeout(400)
  const back400 = { sidebar: await sidebarW(), saved: await savedSidebar() }
  check('a saved 400 px sidebar at 860 px: not cut off, no horizontal scroll, the saved 400 stays; at 1280 it is 400 again',
    set400.width === 400 && set400.saved === '400' && inside(at860) && fits(right400) && at860.saved === '400' && back400.sidebar === 400 && back400.saved === '400',
    JSON.stringify({ set400, at860, back400 }))
  // the default again (Home on the divider), and the window at its minimum for the rest
  await sep.focus()
  await page.keyboard.press('Home')
  await setMainSize(app, 600, 700)
  await page.waitForTimeout(400)

  await setPane('bottom')
  await page.waitForTimeout(300)
  const bottom = await fit(page, ['.reader:not(.reader-empty)', '.reader-toolbar', '.list-area', '.app-header-end'])
  check('860 px, reader at the bottom: nothing cut off, no horizontal scroll', fits(bottom), JSON.stringify(bottom))

  await setPane('none')
  await page.getByRole('button', { name: t.viewContacts, exact: true }).click()
  await page.locator('.contacts-count').waitFor()
  await page.locator('.contact-new').click()
  await page.locator('form.contact-editor').waitFor()
  const contacts = await fit(page, ['form.contact-editor', '.contacts-list', '.app-header-end'])
  check('860 px, Címlista with the editor open: nothing cut off, no horizontal scroll', fits(contacts), JSON.stringify(contacts))

  await page.getByRole('button', { name: t.viewSettings, exact: true }).click()
  await page.locator('section.settings').waitFor()
  const settings = {}
  for (const tab of [t.settingsNav.accounts, t.settingsNav.appearance, t.settingsNav.security, t.settingsNav.claude, t.settingsNav.about]) {
    await page.getByRole('button', { name: tab, exact: true }).click()
    await page.waitForTimeout(150)
    settings[tab] = await fit(page, ['.settings-content', '.settings-nav'])
  }
  check('860 px, every Beállítások tab: nothing cut off, no horizontal scroll', Object.values(settings).every(fits), JSON.stringify(settings))
  await page.getByRole('button', { name: t.backToMail, exact: true }).click()
  await page.locator('.msg-row[data-id]').first().waitFor()

  // the composer window: its size and no minimum of its own
  const [win] = await Promise.all([app.waitForEvent('window', { timeout: 15_000 }), page.getByRole('button', { name: t.newMessage, exact: true }).click()])
  await win.locator('.editor').waitFor()
  const composer = await app.evaluate(({ BrowserWindow }, title) => {
    const w = BrowserWindow.getAllWindows().find(x => x.getTitle().startsWith(title))
    return w ? { size: w.getSize(), min: w.getMinimumSize() } : null
  }, composeTitle)
  // headless, a window does not get its asked size at creation (measured: the main window starts at 840 x 1, the composer
  // at 1 x 1), so its 900 x 700 is checked in the source (test/window-size.test.js); here: no minimum of its own
  check('the composer window: no minimum of its own', composer && composer.min[0] === 0 && composer.min[1] === 0, JSON.stringify(composer))

  // a wider window stays as asked
  await setMainSize(app, 1000, 700)
  await page.waitForTimeout(300)
  const wide = await mainSize(app)
  check('setSize(1000, 700): the main window is 1000 wide', wide.size[0] === 1000, JSON.stringify(wide))
} catch (e) {
  check('the run reached its end', false, String(e.message).split('\n')[0])
} finally {
  await app?.close().catch(() => {})
}

const guard = path.join(dataDir, 'electron', 'logs', 'net-guard.log')
const guardText = fs.existsSync(guard) ? fs.readFileSync(guard, 'utf8').trim() : ''
check('net-guard log: no outgoing request', guardText === '', guardText.split('\n').slice(0, 3).join(' | '))
check('no renderer console error or warning', consoleLines.length === 0, consoleLines.slice(0, 3).join(' | '))
fs.rmSync(work, { recursive: true, force: true })
console.log(`\n${results.filter(Boolean).length} / ${results.length} OK`)
process.exit(results.every(Boolean) ? 0 : 1)
