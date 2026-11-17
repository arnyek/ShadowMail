// SPDX-License-Identifier: GPL-3.0-or-later
// The account editor on the shared form base in the real app (headless Electron + Playwright):
// - 1280 x 800: the Save button is visible (in the viewport, not covered) without scrolling and with the page scrolled
//   to its bottom; the sticky bar sits on the visible bottom edge of the settings page;
// - 860 px (the window's minimum): no horizontal scroll bar, the field pairs wrap inside the card;
// - the no-encryption notice right under the security control; a new account: the type group first;
// - Save without a change stores the same row; no console error or warning.
// Data: test/tools/seed-index.mjs (a dummy IMAP account at 127.0.0.1:1, nothing leaves the machine).
// Needs a fresh renderer build first: npx vite build
//
//   node test/e2e/account-editor-e2e.mjs [--shots <dir>]      (E2E_THEME=<id>, E2E_LANG=en|hu)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { t, seedLanguage } from './lang.mjs'
import { useTheme } from './theme-env.mjs'

const { values } = parseArgs({ options: { shots: { type: 'string' } } })
const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-account-editor-e2e-'))
const dataDir = path.join(work, 'data')
const seed = JSON.parse(execFileSync(process.execPath, [path.join(repo, 'test', 'tools', 'seed-index.mjs'), dataDir, '--count', '5'], { encoding: 'utf8' }))
seedLanguage(dataDir)
if (values.shots) fs.mkdirSync(values.shots, { recursive: true })

const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const problems = []
const shot = async (page, name) => {
  if (values.shots) await page.screenshot({ path: path.join(values.shots, `${name}.png`) })
}

// the Save button: inside the viewport and the topmost element at its centre (the sticky bar is not covered)
const saveVisible = page => page.evaluate(() => {
  const b = document.querySelector('form.account-editor button[type="submit"]')
  const r = b.getBoundingClientRect()
  const x = r.left + r.width / 2
  const y = r.top + r.height / 2
  const top = document.elementFromPoint(x, y)
  return { inView: r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth, onTop: top === b || b.contains(top), rect: [Math.round(r.top), Math.round(r.bottom)], h: window.innerHeight }
})
const barGap = page => page.evaluate(() => {
  const bar = document.querySelector('form.account-editor .form-actions').getBoundingClientRect()
  const scroller = document.querySelector('section.settings').getBoundingClientRect()
  return Math.round(scroller.bottom - bar.bottom)
})
const scrollSettings = (page, to) => page.evaluate(where => {
  const s = document.querySelector('section.settings')
  s.scrollTop = where === 'bottom' ? s.scrollHeight : 0
  return { top: s.scrollTop, max: s.scrollHeight - s.clientHeight }
}, to)
const horizontal = page => page.evaluate(() => {
  const s = document.querySelector('section.settings')
  const doc = document.scrollingElement
  const card = document.querySelector('form.account-editor').getBoundingClientRect()
  // every field inside the card's box
  const out = [...document.querySelectorAll('form.account-editor .text-field, form.account-editor .checkbox, form.account-editor .form-actions')]
    .map(e => [e.querySelector('[id]')?.id || e.className, Math.round(e.getBoundingClientRect().right - card.right)]).filter(([, d]) => d > 0)
  return { doc: doc.scrollWidth - doc.clientWidth, settings: s.scrollWidth - s.clientWidth, out }
})
const tops = (page, ids) => page.evaluate(list => Object.fromEntries(list.map(id => [id, Math.round(document.getElementById(id).closest('.text-field').getBoundingClientRect().top)])), ids)

let app = null
try {
  app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
  const page = await app.firstWindow()
  await useTheme(app, page)
  page.on('console', m => (m.type() === 'error' || m.type() === 'warning') && !/ERR_CONNECTION_REFUSED|connect ECONNREFUSED/.test(m.text()) && problems.push(`${m.type()}: ${m.text()}`))
  page.on('pageerror', e => problems.push(e.message))
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.locator('#vault-unlock').fill(seed.master)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  await page.getByRole('button', { name: t.viewSettings, exact: true }).waitFor({ timeout: 20_000 })
  await page.getByRole('button', { name: t.viewSettings, exact: true }).click()
  await page.locator('.settings-tab', { hasText: t.settingsNav.accounts }).click()
  const before = await page.evaluate(async () => (await window.shadowMail.accounts.list()).accounts)
  await page.getByRole('button', { name: t.accountEdit, exact: true }).first().click()
  await page.locator('form.account-editor fieldset.folder-roles').waitFor()

  // 1280 x 800: Save visible at the top and at the bottom
  await scrollSettings(page, 'top')
  let s = await saveVisible(page)
  const range = await page.evaluate(() => {
    const el = document.querySelector('section.settings')
    return el.scrollHeight - el.clientHeight
  })
  check('1280 x 800: the editor is taller than the page (the sticky bar is needed)', range > 0, `scroll range ${range} px`)
  // a hidden (.sr-only, absolutely placed) legend low in the form must not make the page itself scroll
  const vdoc = await page.evaluate(() => document.scrollingElement.scrollHeight - document.scrollingElement.clientHeight)
  check('only the settings page scrolls, not the window', vdoc <= 0, `${vdoc} px`)
  check('1280 x 800, not scrolled: Save is visible and not covered', s.inView && s.onTop, JSON.stringify(s))
  const gap = await barGap(page)
  check('the sticky bar sits on the visible bottom edge of the settings page', Math.abs(gap) <= 1, `${gap} px`)
  await shot(page, 'account-editor-top')
  await scrollSettings(page, 'bottom')
  await page.waitForTimeout(100)
  s = await saveVisible(page)
  check('1280 x 800, scrolled to the bottom: Save is visible and not covered', s.inView && s.onTop, JSON.stringify(s))
  const last = await page.evaluate(() => document.querySelector('form.account-editor').lastElementChild.className)
  check('the bar is the end of the card', /form-actions/.test(last), last)
  await shot(page, 'account-editor-bottom')

  // the no-encryption notice right under the security control of its own server (the seed's servers have none)
  const notice = await page.evaluate(() => [...document.querySelectorAll('.field-notice')].map(n => {
    const ctl = n.previousElementSibling
    return { under: ctl.querySelector('.select-trigger')?.id, gap: Math.round(n.getBoundingClientRect().top - ctl.getBoundingClientRect().bottom) }
  }))
  const security = await page.evaluate(() => [document.querySelector('#acc-in_security').textContent, document.querySelector('#acc-smtp_security').textContent])
  const noneLabel = t.securityLabels.none
  const expected = ['acc-in_security', 'acc-smtp_security'].filter((id, i) => security[i] === noneLabel)
  check('the notice is right under each security control set to none, and only there', JSON.stringify(notice.map(n => n.under)) === JSON.stringify(expected) && notice.every(n => n.gap >= 0 && n.gap <= 10), JSON.stringify({ notice, security }))

  // 860 px: no horizontal scroll, the pairs wrap inside the card
  await page.setViewportSize({ width: 860, height: 800 })
  await page.waitForTimeout(300)
  await scrollSettings(page, 'top')
  let hz = await horizontal(page)
  check('860 px: no horizontal scroll bar, every field inside the card', hz.doc <= 0 && hz.settings <= 0 && hz.out.length === 0, JSON.stringify(hz))
  const row = await tops(page, ['acc-in_host', 'acc-in_port', 'acc-in_user', 'acc-in_password'])
  check('860 px: Server + Port wrap (Port under Server)', row['acc-in_port'] > row['acc-in_host'], JSON.stringify(row))
  s = await saveVisible(page)
  check('860 px: Save visible', s.inView && s.onTop, JSON.stringify(s))
  await shot(page, 'account-editor-860')
  await scrollSettings(page, 'bottom')
  await shot(page, 'account-editor-860-bottom')
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.waitForTimeout(200)
  check('1280 px: Server + Port in one row again', (await tops(page, ['acc-in_host', 'acc-in_port']).then(r => r['acc-in_host'] === r['acc-in_port'])))

  // Save without a change: the same row as before
  await page.locator('form.account-editor button[type="submit"]').click()
  await page.locator('form.account-editor').waitFor({ state: 'detached', timeout: 10_000 })
  const after = await page.evaluate(async () => (await window.shadowMail.accounts.list()).accounts)
  const strip = rows => rows.map(r => Object.fromEntries(Object.entries(r).filter(([k]) => !/updated|created/.test(k))))
  check('Save without a change: the stored account is the same', JSON.stringify(strip(after)) === JSON.stringify(strip(before)), JSON.stringify(strip(after)).slice(0, 300))

  // a new account: the type group first, both widths
  await page.getByRole('button', { name: t.accountNew, exact: true }).click()
  await page.locator('form.account-editor fieldset.account-type').waitFor()
  const first = await page.evaluate(() => document.querySelector('form.account-editor .form-section-body').firstElementChild.className)
  check('a new account: the type group is the first element of the Fiók section', first === 'account-type', first)
  await scrollSettings(page, 'top')
  s = await saveVisible(page)
  check('a new account, 1280 x 800: Save visible', s.inView && s.onTop, JSON.stringify(s))
  await shot(page, 'account-editor-new')
  await page.locator('form.account-editor button[type="submit"]').click()
  await page.locator('#acc-type-error').waitFor({ timeout: 5000 })
  check('a new account: Save without a type is refused with the type text', (await page.locator('#acc-type-error').innerText()).includes(t.accountError('bad_type')))
  await shot(page, 'account-editor-new-error')
  await page.locator('#acc-type-pop3').check()
  await page.setViewportSize({ width: 860, height: 800 })
  await page.waitForTimeout(300)
  hz = await horizontal(page)
  check('a new POP3 account, 860 px: no horizontal scroll bar', hz.doc <= 0 && hz.settings <= 0 && hz.out.length === 0, JSON.stringify(hz))
  await shot(page, 'account-editor-new-pop3-860')
  check('no console error or warning, no page error', problems.length === 0, JSON.stringify(problems.slice(0, 3)))
} finally {
  if (app) await app.close().catch(() => {})
  fs.rmSync(work, { recursive: true, force: true })
}
const ok = results.filter(Boolean).length
console.log(`${ok} / ${results.length} OK`)
process.exit(ok === results.length ? 0 : 1)
