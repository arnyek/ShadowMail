#!/usr/bin/env node
// The interface theme in the real app, headless Electron + Playwright. Not part of `npm test`.
//
//   node test/e2e/theme-e2e.mjs
//
// 1. A data folder without a theme pref: <html data-theme data-density> is the default theme already on the lock screen,
//    set before the first paint (the 'shadowmail-theme-applied' mark comes before the paint entries), and the page
//    background is the theme's --c-bg.
// 2. Beállítások / Megjelenés: the Téma Select lists the themes of themes.js by their names; choosing each one sets
//    data-theme / data-density at once, without a reload (a mark on window survives), and saves the pref.
// 3. After a restart the last choice stays, on the lock screen too.
// 4. A broken pref (not JSON, an unknown id, a number) gives the default theme, with no console error.
// 5. A classic style sets the reading pane once when chosen (blue: right, light: bottom); a manual change after it
//    stays, after a restart too, until the style is chosen again; the other themes never change it.
// The list rows are as high as the density's --row-h. No renderer console error or warning, no outgoing request.
// Data: test/tools/seed-index.mjs (a dummy IMAP account at 127.0.0.1:1, nothing leaves the machine).
// Needs a fresh renderer build first: npx vite build
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { t, seedLanguage } from './lang.mjs'
import { THEMES, DEFAULT_THEME } from '../../app/renderer/src/themes.js'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-theme-e2e-'))
const dataDir = path.join(work, 'data')
const seed = JSON.parse(execFileSync(process.execPath, [path.join(repo, 'test', 'tools', 'seed-index.mjs'), dataDir, '--count', '20'], { encoding: 'utf8' }))
seedLanguage(dataDir)
const PREF = 'shadowmail.ui.theme'
const densityOf = id => THEMES.find(x => x.id === id).density

const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const consoleLines = []

async function launch() {
  const app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
  const page = await app.firstWindow()
  page.on('console', m => (m.type() === 'error' || m.type() === 'warning') && consoleLines.push(`${m.type()}: ${m.text()}`))
  page.on('pageerror', e => consoleLines.push(`pageerror: ${e.message}`))
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.locator('#vault-unlock').waitFor({ timeout: 20_000 })
  return { app, page }
}
async function unlock(page) {
  await page.locator('#vault-unlock').fill(seed.master)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  await page.locator('.msg-row[data-id]').first().waitFor({ timeout: 20_000 })
}
// the html attributes, the theme mark against the paint entries, the page background against the --c-bg token
const look = page =>
  page.evaluate(() => {
    const html = document.documentElement
    const mark = performance.getEntriesByName('shadowmail-theme-applied')[0]
    const paints = performance.getEntriesByType('paint').map(p => ({ name: p.name, at: p.startTime }))
    const probe = document.createElement('div')
    probe.style.background = 'var(--c-bg)'
    document.body.appendChild(probe)
    const token = getComputedStyle(probe).backgroundColor
    probe.remove()
    return { theme: html.dataset.theme ?? null, density: html.dataset.density ?? null, mark: mark ? mark.startTime : null, paints, token, body: getComputedStyle(document.body).backgroundColor }
  })
const settled = s => s.theme && s.density
const rowHeights = page =>
  page.evaluate(() => ({
    token: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--row-h')),
    rows: [...document.querySelectorAll('.msg-row[data-id]')].slice(0, 5).map(r => Math.round(r.getBoundingClientRect().height)),
  }))
async function openAppearance(page) {
  await page.getByRole('button', { name: t.viewSettings, exact: true }).click()
  await page.locator('.settings-tab', { hasText: t.settingsNav.appearance }).click()
  await page.locator('#ui-theme').waitFor()
}

let app = null
let page
try {
  // 1. no theme pref
  ;({ app, page } = await launch())
  // the paint entries can come a little after the lock screen is in the DOM (measured: an empty list on some launches)
  await page.waitForFunction(() => performance.getEntriesByType('paint').length > 0, null, { timeout: 5000 }).catch(() => {})
  let s = await look(page)
  check('no pref: the lock screen has the default theme and its density', s.theme === DEFAULT_THEME && s.density === densityOf(DEFAULT_THEME), JSON.stringify(s))
  const firstPaint = s.paints.length ? Math.min(...s.paints.map(p => p.at)) : null
  check('the theme is set before the first paint', s.mark !== null && firstPaint !== null && s.mark < firstPaint, JSON.stringify({ mark: s.mark, paints: s.paints }))
  check('the page background is the theme\'s --c-bg', s.body === s.token && s.token !== 'rgba(0, 0, 0, 0)', `${s.body} vs ${s.token}`)
  check('starting writes no theme pref', (await page.evaluate(k => localStorage.getItem(k), PREF)) === null)
  await unlock(page)
  const rh = await rowHeights(page)
  check('the list rows are as high as --row-h', rh.rows.length > 0 && rh.rows.every(h => h === Math.round(rh.token)), JSON.stringify(rh))

  // 2. the Select: every theme, at once, no reload
  await openAppearance(page)
  await page.evaluate(() => { window.__noReload = true })
  await page.locator('#ui-theme').click()
  const names = (await page.getByRole('menuitemradio').allInnerTexts()).map(x => x.trim())
  check('the Téma menu lists the themes by name', JSON.stringify(names) === JSON.stringify(THEMES.map(x => t.themes[x.id])), JSON.stringify(names))
  await page.keyboard.press('Escape')
  // the last theme first, so with two or more themes each choice is a change
  const order = [...THEMES.slice(1).map(x => x.id), DEFAULT_THEME]
  let last = DEFAULT_THEME
  const backgrounds = new Map()
  for (const id of order) {
    await page.locator('#ui-theme').click()
    await page.getByRole('menuitemradio', { name: t.themes[id], exact: true }).click()
    await page.waitForFunction(want => document.documentElement.dataset.theme === want, id, { timeout: 2000 }).catch(() => {})
    s = await look(page)
    const kept = await page.evaluate(() => window.__noReload === true)
    const pref = await page.evaluate(k => localStorage.getItem(k), PREF)
    check(`choose ${id}: data-theme and data-density at once, no reload, the pref saved`, s.theme === id && s.density === densityOf(id) && kept && pref === JSON.stringify(id), JSON.stringify({ theme: s.theme, density: s.density, kept, pref }))
    check(`choose ${id}: the page background is that theme's --c-bg at once`, s.body === s.token, `${s.body} vs ${s.token}`)
    backgrounds.set(id, s.body)
    check(`choose ${id}: the Select shows it`, (await page.locator('#ui-theme').innerText()).trim() === t.themes[id])
    last = id
  }
  // the dark schemes have a page of their own; the light classic styles keep the default's white page
  const dark = ['dark', 'graphite'].filter(id => backgrounds.has(id))
  const pages = new Set([backgrounds.get(DEFAULT_THEME), ...dark.map(id => backgrounds.get(id))])
  check('every dark theme has its own page background', dark.length === 2 && pages.size === 3, JSON.stringify([...backgrounds]))
  await app.close()
  app = null

  // 3. after a restart the choice stays
  ;({ app, page } = await launch())
  s = await look(page)
  check('after a restart: the lock screen has the chosen theme', s.theme === last && s.density === densityOf(last), JSON.stringify(s))
  await unlock(page)
  await openAppearance(page)
  check('after a restart: the Select shows it', (await page.locator('#ui-theme').innerText()).trim() === t.themes[last])

  // 4. broken prefs
  for (const raw of ['{not json', '"no-such-theme"', '42']) {
    await page.evaluate(([k, v]) => localStorage.setItem(k, v), [PREF, raw])
    await app.close()
    app = null
    ;({ app, page } = await launch())
    s = await look(page)
    check(`a broken pref ${raw}: the default theme`, settled(s) && s.theme === DEFAULT_THEME && s.density === densityOf(DEFAULT_THEME), JSON.stringify(s))
  }
  await unlock(page)
  await openAppearance(page)
  check('a broken pref: the Select shows the default', (await page.locator('#ui-theme').innerText()).trim() === t.themes[DEFAULT_THEME])

  // 5. a classic style sets the reading pane once, when chosen; a manual change after it stays, a restart too, until
  //    the style is chosen again; the other themes never touch it
  const PANE = 'shadowmail.ui.readerPane'
  const pane = async () => ({ pref: await page.evaluate(k => localStorage.getItem(k), PANE), shown: (await page.locator('#reader-pane').innerText()).trim() })
  const shows = (p, v) => p.pref === JSON.stringify(v) && p.shown === t.readerPaneOptions[v]
  const choose = async id => {
    await page.locator('#ui-theme').click()
    await page.getByRole('menuitemradio', { name: t.themes[id], exact: true }).click()
    await page.waitForFunction(want => document.documentElement.dataset.theme === want, id, { timeout: 2000 }).catch(() => {})
  }
  const choosePane = async v => {
    await page.locator('#reader-pane').click()
    await page.getByRole('menuitemradio', { name: t.readerPaneOptions[v], exact: true }).click()
  }
  const classic = THEMES.filter(x => x.readerPane)
  const plain = THEMES.filter(x => !x.readerPane)
  check('the classic styles have a reading pane each, the others none', classic.length === 2 && classic.every(x => ['right', 'bottom'].includes(x.readerPane)), JSON.stringify(classic))
  for (const th of classic) {
    await choose(th.id)
    const p = await pane()
    check(`choose ${th.id}: the reading pane ${th.readerPane}, in the setting too`, shows(p, th.readerPane), JSON.stringify(p))
  }
  await choosePane('none')
  for (const th of plain) {
    await choose(th.id)
    const p = await pane()
    check(`choose ${th.id}: the reading pane stays (none)`, shows(p, 'none'), JSON.stringify(p))
  }
  const blue = classic.find(x => x.readerPane === 'right') || classic[0]
  await choose(blue.id)
  await choosePane('none') // a manual change after the style
  await app.close()
  app = null
  ;({ app, page } = await launch())
  s = await look(page)
  await unlock(page)
  const after = await page.evaluate(() => document.querySelector('.reader-pane-switch')?.getAttribute('data-pane') ?? null)
  check(`after a restart: ${blue.id} and the manual reading pane (none), not the style's`, s.theme === blue.id && after === 'none' && (await page.evaluate(k => localStorage.getItem(k), PANE)) === '"none"', JSON.stringify({ theme: s.theme, after }))
  await openAppearance(page)
  await choose(blue.id)
  check(`${blue.id} chosen again: its reading pane again (${blue.readerPane})`, shows(await pane(), blue.readerPane))
  await choose(DEFAULT_THEME)
  check('back to the default theme: the reading pane stays', shows(await pane(), blue.readerPane))
  await app.close()
  app = null
} catch (e) {
  // a step that could not run (an element never came) is a failed check, not a crash without a name
  check('the run reached its end', false, String(e.message).split('\n')[0])
} finally {
  if (app) await app.close().catch(() => {})
}

const guard = path.join(dataDir, 'electron', 'logs', 'net-guard.log')
const guardText = fs.existsSync(guard) ? fs.readFileSync(guard, 'utf8').trim() : ''
check('net-guard log: no outgoing request', guardText === '', guardText.split('\n').slice(0, 3).join(' | '))
check('no renderer console error or warning', consoleLines.length === 0, consoleLines.slice(0, 3).join(' | '))
fs.rmSync(work, { recursive: true, force: true })
console.log(`\n${results.filter(Boolean).length} / ${results.length} OK`)
process.exit(results.every(Boolean) ? 0 : 1)
