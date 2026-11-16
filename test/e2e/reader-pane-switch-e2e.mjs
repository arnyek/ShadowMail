// The header's reader-pane switch in the real app (headless Electron + Playwright):
// - one click goes to the next layout (none -> right -> bottom -> none) and the mail view shows it AT ONCE (the
//   mail-panes class), without reopening; the name and the tooltip say the layout on now and the next one;
// - the Beállítások / Megjelenés Select shows the same value, and a change there moves the button too;
// - with an open message, an unsaved composer, a selection and a search, a switch loses none of them;
// - each layout keeps its own pane size (right: the list 500 px wide, bottom: 300 px high) over switches;
// - the button is in the mail view only, Tab reaches it, Enter and Space press it;
// - after a restart the chosen layout stays (the readerPane pref); no native control, no unnamed icon button, no
//   console error or warning, no outgoing request.
// Data: test/tools/seed-index.mjs (a dummy IMAP account at 127.0.0.1:1, nothing leaves the machine).
// Needs a fresh renderer build first: npx vite build
//
//   node test/e2e/reader-pane-switch-e2e.mjs
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

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-pane-switch-e2e-'))
const dataDir = path.join(work, 'data')
const seed = JSON.parse(execFileSync(process.execPath, [path.join(repo, 'test', 'tools', 'seed-index.mjs'), dataDir, '--count', '40', '--previews', '--eml', path.join(repo, 'test', 'fixtures', 'mail')], { encoding: 'utf8' }))
seedLanguage(dataDir)

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
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.locator('#vault-unlock').fill(seed.master)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  await page.locator('.folder-tree .folder').first().waitFor()
  await page.locator('.msg-row[data-id]').first().waitFor()
  return { app, page }
}

const NEXT = { none: 'right', right: 'bottom', bottom: 'none' }
const nameOf = now => t.readerPaneButton(now, NEXT[now])
const OPTION = t.readerPaneOptions
const SUBJECT = 'Beadás képpel és mellékletekkel'

// what the mail view shows now
const state = page =>
  page.evaluate(() => {
    const btn = document.querySelector('.reader-pane-switch')
    const reader = document.querySelector('.reader:not(.reader-empty)')
    return {
      panes: document.querySelector('.mail-panes')?.className ?? null,
      button: btn ? { pane: btn.getAttribute('data-pane'), label: btn.getAttribute('aria-label'), title: btn.getAttribute('title'), glyph: btn.querySelector('svg')?.getAttribute('class') } : null,
      readerId: reader?.getAttribute('data-message-id') ?? null,
      readerVisible: Boolean(reader && reader.getBoundingClientRect().width > 0 && reader.getBoundingClientRect().height > 0),
      selection: document.querySelector('.selection-count')?.textContent ?? null,
      search: document.querySelector('.app-header-search input')?.value ?? null,
      results: document.querySelectorAll('.result').length,
    }
  })
const paneOf = s => (s.panes || '').match(/pane-(\w+)/)?.[1]
// the switch shows `now`: the class, the name, the tooltip and the glyph
const shows = (s, now) => paneOf(s) === now && s.button?.pane === now && s.button.label === nameOf(now) && s.button.title === nameOf(now) && (s.button.glyph || '').includes(`own-layout-${now}`)

async function clickSwitch(page, expect) {
  await page.locator('.reader-pane-switch').click()
  // AT ONCE: the next frame already has it (no reopening, no view change); a miss is reported by the caller's check
  await page.locator(`.mail-panes.pane-${expect}`).waitFor({ timeout: 2000 }).catch(() => {})
  return state(page)
}

async function dragTo(page, sepName, axis, target) {
  const sep = page.getByRole('separator', { name: sepName, exact: true })
  const box = await sep.boundingBox()
  const cur = await page.locator('.list-area').evaluate((el, a) => (a === 'x' ? el.getBoundingClientRect().width : el.getBoundingClientRect().height), axis)
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  const d = target - cur
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(axis === 'x' ? x + d / 2 : x, axis === 'y' ? y + d / 2 : y, { steps: 4 })
  await page.mouse.move(axis === 'x' ? x + d : x, axis === 'y' ? y + d : y, { steps: 4 })
  await page.mouse.up()
  await page.waitForTimeout(100)
}
const listW = page => page.locator('.list-area').evaluate(el => Math.round(el.getBoundingClientRect().width))
const listH = page => page.locator('.list-area').evaluate(el => Math.round(el.getBoundingClientRect().height))

let { app, page } = await start()
try {
  // the start: no reader pane, the button in the header between Címlista and Beállítások
  const s0 = await state(page)
  check('start: "none", the button names it and the next one (name = tooltip), the glyph of "none"', shows(s0, 'none'), JSON.stringify(s0.button))
  const order = await page.evaluate(() => [...document.querySelectorAll('.app-header-end button')].map(b => b.getAttribute('aria-label')))
  check('the button sits between Címlista and Beállítások', order[0] === t.viewContacts && order[1] === nameOf('none') && order[2] === t.viewSettings, JSON.stringify(order))

  // only in the mail view
  await page.getByRole('button', { name: t.viewContacts, exact: true }).click()
  await page.locator('.contacts-list, .contacts-count').first().waitFor()
  const inContacts = await page.locator('.reader-pane-switch').count()
  await page.getByRole('button', { name: t.viewSettings, exact: true }).click()
  await page.locator('section.settings').waitFor()
  const inSettings = await page.locator('.reader-pane-switch').count()
  await page.getByRole('button', { name: t.backToMail, exact: true }).click()
  await page.locator('.msg-row[data-id]').first().waitFor()
  check('the button: not in Címlista, not in Beállítások, back in the mail view', inContacts === 0 && inSettings === 0 && (await page.locator('.reader-pane-switch').count()) === 1, `contacts ${inContacts}, settings ${inSettings}`)

  // three clicks: every step at once, the name says now and next, the third is the start
  const steps = []
  for (const expect of ['right', 'bottom', 'none']) {
    const s = await clickSwitch(page, expect)
    steps.push([expect, shows(s, expect), s.button?.label])
  }
  check('three clicks: none -> right -> bottom -> none, each at once, the name/tooltip/glyph follow', steps.every(s => s[1]), JSON.stringify(steps))

  // keyboard: Tab from Címlista reaches it, Enter and Space press it
  await page.getByRole('button', { name: t.viewContacts, exact: true }).focus()
  await page.keyboard.press('Tab')
  const focused = await page.evaluate(() => document.activeElement?.classList.contains('reader-pane-switch'))
  await page.keyboard.press('Enter')
  await page.locator('.mail-panes.pane-right').waitFor({ timeout: 2000 }).catch(() => {})
  const afterEnter = await state(page)
  await page.keyboard.press('Space')
  await page.locator('.mail-panes.pane-bottom').waitFor({ timeout: 2000 }).catch(() => {})
  const afterSpace = await state(page)
  check('keyboard: Tab reaches it after Címlista, Enter and Space switch', focused && shows(afterEnter, 'right') && shows(afterSpace, 'bottom'), `focused ${focused}`)
  await clickSwitch(page, 'none')

  // an open message, a selection and an unsaved composer: a switch round loses none of them
  const rows = page.locator('.msg-row[data-id]')
  await rows.nth(2).click({ modifiers: ['Control'] })
  await rows.nth(3).click({ modifiers: ['Control'] })
  await page.locator('.selection-count').waitFor()
  await page.locator('.msg-row', { hasText: SUBJECT }).click()
  await page.locator('.reader[data-message-id]:not(.reader-empty)').waitFor()
  const [win] = await Promise.all([app.waitForEvent('window', { timeout: 15_000 }), page.getByRole('button', { name: t.newMessage, exact: true }).click()])
  await win.setViewportSize({ width: 1000, height: 700 })
  await win.locator('.editor').waitFor()
  await win.locator('#compose-subject, input[name="subject"]').first().fill('Mentetlen L1-próba')
  await win.locator('.editor').click()
  await win.keyboard.type('Ez a szöveg nincs mentve.')
  const draftBefore = await win.locator('.editor').innerText()
  const before = await state(page)
  const round = []
  for (const expect of ['right', 'bottom', 'none']) {
    const s = await clickSwitch(page, expect)
    const editor = win.isClosed() ? null : await win.locator('.editor').innerText()
    round.push({ pane: paneOf(s), id: s.readerId, visible: s.readerVisible, sel: s.selection, editorSame: editor === draftBefore })
  }
  check(
    'open message: none -> right -> bottom -> none, the same message open and shown at every step',
    before.readerId && round.every(r => r.id === before.readerId && r.visible),
    JSON.stringify({ id: before.readerId, round }),
  )
  check('the selection stays at every step', before.selection && round.every(r => r.sel === before.selection), `${before.selection} -> ${round.map(r => r.sel).join(', ')}`)
  check('the unsaved composer stays open with its text', !win.isClosed() && round.every(r => r.editorSame) && draftBefore.includes('Ez a szöveg nincs mentve.'), draftBefore.replace(/\s+/g, ' ').slice(0, 80))

  // each layout keeps its own size: right 500 px wide, bottom 300 px high, and both back after switching round
  await clickSwitch(page, 'right')
  await dragTo(page, t.splitters.list, 'x', 500)
  const setW = await listW(page)
  await clickSwitch(page, 'bottom')
  await dragTo(page, t.splitters.listh, 'y', 300)
  const setH = await listH(page)
  const back = []
  for (const expect of ['none', 'right', 'bottom', 'none', 'right', 'bottom']) {
    await clickSwitch(page, expect)
    if (expect === 'right') back.push(['right', await listW(page)])
    if (expect === 'bottom') back.push(['bottom', await listH(page)])
  }
  const prefs = await page.evaluate(() => [localStorage.getItem('shadowmail.ui.split.list'), localStorage.getItem('shadowmail.ui.split.listh')])
  check(
    'pane sizes per layout: right 500 px, bottom 300 px, the same after two rounds of switching',
    Math.abs(setW - 500) <= 2 && Math.abs(setH - 300) <= 2 && back.every(([k, v]) => Math.abs(v - (k === 'right' ? setW : setH)) <= 1),
    JSON.stringify({ setW, setH, back, prefs }),
  )
  await clickSwitch(page, 'none')
  await win.close().catch(() => {}) // asks before closing: the app's quit below ends it anyway

  // a search with an open result: the search text, the results and the open message stay
  await page.keyboard.press('Escape')
  const box = page.getByRole('searchbox', { name: t.searchLabel })
  await box.fill('Beadás')
  await page.locator('.result').first().waitFor({ timeout: 10_000 })
  await page.locator('.result', { hasText: SUBJECT }).locator('.result-open').click()
  await page.locator('.reader[data-message-id]:not(.reader-empty)').waitFor()
  const sBefore = await state(page)
  const sRound = []
  for (const expect of ['right', 'bottom', 'none']) {
    const s = await clickSwitch(page, expect)
    sRound.push({ pane: paneOf(s), search: s.search, results: s.results, id: s.readerId, visible: s.readerVisible })
  }
  check(
    'search: the text, the results and the open result stay over a switch round',
    sBefore.search === 'Beadás' && sBefore.results > 0 && sRound.every(r => r.search === sBefore.search && r.results === sBefore.results && r.id === sBefore.readerId && r.visible),
    JSON.stringify({ before: { search: sBefore.search, results: sBefore.results, id: sBefore.readerId }, sRound }),
  )
  await box.fill('')
  await page.keyboard.press('Escape')

  // the Select shows the switch's value, and a change there moves the switch
  await clickSwitch(page, 'right')
  await clickSwitch(page, 'bottom')
  await page.getByRole('button', { name: t.viewSettings, exact: true }).click()
  await page.getByRole('button', { name: t.settingsNav.appearance, exact: true }).click()
  const selectText = await page.locator('#reader-pane').innerText()
  await page.getByRole('button', { name: t.readerPaneLabel, exact: true }).click()
  await page.getByRole('menuitemradio', { name: OPTION.right, exact: true }).click()
  await page.getByRole('button', { name: t.backToMail, exact: true }).click()
  await page.locator('.msg-row[data-id]').first().waitFor()
  const fromSelect = await state(page)
  check('the Select shows the switch\'s value ("Alul"); the Select\'s "Jobbra" moves the switch and the view', selectText.includes(OPTION.bottom) && shows(fromSelect, 'right'), JSON.stringify({ selectText, button: fromSelect.button, panes: fromSelect.panes }))

  // the last choice before the restart: bottom
  await clickSwitch(page, 'bottom')
  const header = await page.evaluate(() => ({
    native: document.querySelectorAll('button:not([class]), select').length,
    unnamed: document.querySelectorAll('button.icon-btn:not([aria-label])').length,
    noTitle: document.querySelectorAll('.app-header button.icon-btn:not([title])').length,
  }))
  check('no native control, no unnamed icon button, every header icon button has a tooltip', header.native === 0 && header.unnamed === 0 && header.noTitle === 0, JSON.stringify(header))
} catch (e) {
  // a step that could not run (an element never came) is a failed check, not a crash without a name
  check('the run reached its end', false, String(e.message).split('\n')[0])
} finally {
  await app.close().catch(() => {})
}

;({ app, page } = await start())
try {
  const s = await state(page)
  const pref = await page.evaluate(() => localStorage.getItem('shadowmail.ui.readerPane'))
  check('after a restart the chosen layout stays (bottom), the switch shows it', shows(s, 'bottom') && pref === '"bottom"', JSON.stringify({ panes: s.panes, button: s.button, pref }))
  await page.locator('.msg-row', { hasText: SUBJECT }).click()
  await page.locator('.reader[data-message-id]:not(.reader-empty)').waitFor()
  const geo = await page.evaluate(() => ({ list: document.querySelector('.list-area').getBoundingClientRect().bottom, reader: document.querySelector('.reader').getBoundingClientRect().top }))
  check('after the restart the reader opens under the list', geo.reader >= geo.list - 1, JSON.stringify(geo))
  await clickSwitch(page, 'none')
} catch (e) {
  // a step that could not run (an element never came) is a failed check, not a crash without a name
  check('the run reached its end', false, String(e.message).split('\n')[0])
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
