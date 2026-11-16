#!/usr/bin/env node
// The view settings survive a forced stop, headless Electron + Playwright. Not part of `npm test`.
//
//   node test/e2e/prefs-kill-e2e.mjs [--rounds 10] [--report]
//
// Each round: a theme chosen in Beállítások / Megjelenés (a different one every round), and the settings menu's
// splitter moved by keyboard; 1 s later the app's main process is killed (SIGKILL, no orderly exit); after a restart the lock screen
// has the chosen theme and the stored splitter width is the new one. --report: only counts (for a run on code without
// the flush), no failed check for a lost value.
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
const arg = (name, dflt) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : dflt)
const ROUNDS = Number(arg('--rounds', 10))
const REPORT = process.argv.includes('--report')

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-prefs-kill-e2e-'))
const dataDir = path.join(work, 'data')
const seed = JSON.parse(execFileSync(process.execPath, [path.join(repo, 'test', 'tools', 'seed-index.mjs'), dataDir, '--count', '10'], { encoding: 'utf8' }))
seedLanguage(dataDir)

const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const launch = async () => {
  const app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.locator('#vault-unlock').waitFor({ timeout: 20_000 })
  return { app, page }
}
const stored = page => page.evaluate(() => ({ theme: localStorage.getItem('shadowmail.ui.theme'), list: localStorage.getItem('shadowmail.ui.split.list') }))

let lostTheme = 0
let lostSplit = 0
let app = null
try {
  // never the default (a lost choice would look kept) and never the one already stored
  const ids = THEMES.map(x => x.id).filter(id => id !== DEFAULT_THEME)
  for (let round = 0; round < ROUNDS; round++) {
    let page
    ;({ app, page } = await launch())
    const before = await stored(page)
    const want = ids.filter(id => JSON.stringify(id) !== before.theme)[round % (ids.length - 1)]
    await page.locator('#vault-unlock').fill(seed.master)
    await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
    await page.locator('.msg-row[data-id]').first().waitFor({ timeout: 20_000 })
    await page.getByRole('button', { name: t.viewSettings, exact: true }).click()
    await page.locator('.settings-tab', { hasText: t.settingsNav.appearance }).click()
    await page.locator('#ui-theme').click()
    await page.getByRole('menuitemradio', { name: t.themes[want], exact: true }).click()
    // the settings menu's splitter, one step by keyboard (the pref is written at once)
    const settingsSplit = page.locator('.splitter[data-split="settings"]')
    await settingsSplit.focus()
    await settingsSplit.press(round % 2 ? 'ArrowLeft' : 'ArrowRight')
    const wantSplit = await page.evaluate(() => localStorage.getItem('shadowmail.ui.split.settings'))
    await page.waitForTimeout(1000)
    // a forced stop: the main process killed, no orderly exit
    const pid = app.process().pid
    process.kill(pid, 'SIGKILL')
    await new Promise(r => setTimeout(r, 1000))
    app = null
    ;({ app, page } = await launch())
    const after = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme, split: localStorage.getItem('shadowmail.ui.split.settings') }))
    if (after.theme !== want) lostTheme++
    if (after.split !== wantSplit) lostSplit++
    console.log(`round ${round + 1}: theme ${want} -> ${after.theme}; splitter ${wantSplit} -> ${after.split}`)
    await app.close()
    app = null
  }
} catch (err) {
  check('the run finished', false, err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : String(err))
} finally {
  if (app) await app.close().catch(() => {})
}
console.log(`lost after a kill 1 s after the change: theme ${lostTheme}/${ROUNDS}, splitter ${lostSplit}/${ROUNDS}`)
if (!REPORT) {
  check(`the theme survives a kill 1 s after the change (${ROUNDS} rounds)`, lostTheme === 0, `${lostTheme} lost`)
  check(`the splitter width survives a kill 1 s after the change (${ROUNDS} rounds)`, lostSplit === 0, `${lostSplit} lost`)
}
fs.rmSync(work, { recursive: true, force: true })
console.log(`\n${results.filter(Boolean).length} / ${results.length} OK`)
process.exit(results.every(Boolean) ? 0 : 1)
