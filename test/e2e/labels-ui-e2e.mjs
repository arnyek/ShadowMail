#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// The label interface in the real app: headless Electron + Playwright. Not part of `npm test`.
//
//   E2E_LANG=hu|en node test/e2e/labels-ui-e2e.mjs [--shots <dir>]
//
// A POP3 account (fake POP3 server) with five downloaded messages. Measured: a row with 4 labels shows 3 chips + "+1"
// with every name in the tooltip, and the row height is the --row-h token in both densities (a row with and one
// without chips); the search hit shows the same chips; 3 selected messages with 1 labelled: the picker shows the label
// indeterminate, a click puts it on all 3, again takes it off all; the right-click "Labels…", the selection toolbar's
// icon and the reader's button open the same picker; the reader's x takes a label off and the list row follows;
// "New label: Teszt" makes the label and puts it on; by keyboard from the menu to the picker and back to the list;
// at 860 px the chips do not push the date out; the chips' name and the reader's x on the chip's centre line in every
// theme and both densities; the page console and main.log stay clean.
// --shots <dir>: list, reader, picker, in the default and the dark theme (labels-<theme>-<screen>.png).
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
const MASTER = 'Teszt-mesterjelszo-cimke-felulet'
const now = Date.now()
const sleep = ms => new Promise(r => setTimeout(r, ms))
const SUBJECTS = ['Alfa levél', 'Béta levél', 'Gamma levél', 'Delta levél', 'Epszilon levél']

const server = await new FakePop3Server().listen()
SUBJECTS.forEach((s, i) => {
  server.add(Buffer.from(`From: f${i}@example.invalid\r\nTo: p@example.invalid\r\nSubject: =?UTF-8?B?${Buffer.from(s).toString('base64')}?=\r\nMessage-ID: <ui${i}@example.invalid>\r\nDate: ${new Date(now - (i + 1) * 60_000).toUTCString()}\r\n\r\nszentjánosbogár ${i}\r\n`))
})
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-labels-ui-e2e-'))
const dataDir = path.join(work, 'data')
fs.mkdirSync(dataDir)
seedLanguage(dataDir)
let pop
{
  const { db, vault } = await createVaultedDatabase(dataDir, MASTER)
  const store = new AccountStore(db, vault, { storeDir: path.join(dataDir, 'store') })
  pop = store.save({ ...newAccountDefaults('pop3'), smtp_host: '127.0.0.1', smtp_port: 1, smtp_security: 'none', in_security: 'none', in_host: '127.0.0.1', name: 'POP3-fiók', email: 'p@example.invalid', in_port: server.port, in_user: server.user, in_password: server.pass }).account.id
  db.close()
}

const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const mainLog = path.join(dataDir, 'electron', 'logs', 'main.log')
const consoleLines = []
const api = (page, group, method, ...args) => page.evaluate(([g, m, a]) => window.shadowMail[g][m](...a), [group, method, args])
const until = async (fn, what, tries = 100) => {
  for (let i = 0; i < tries; i++) {
    if (await fn()) return true
    await sleep(50)
  }
  throw new Error(`timed out: ${what}`)
}

// The chips on their centre line, in every theme and both densities: the name, and on a reader chip its x (the button
// and its icon: the global `button` rule's align-self: flex-start put the x 2 px above the chip's centre).
// A dot (a narrow row) has no name drawn and is not measured. `expected`: how many chips must be measured.
async function chipCentres(page, what, expected) {
  const themes = await page.evaluate(() => [...new Set([...document.styleSheets].flatMap(s => { try { return [...s.cssRules] } catch { return [] } })
    .map(r => r.selectorText || '').flatMap(s => [...s.matchAll(/\[data-theme="([a-z-]+)"\]/g)].map(m => m[1])))])
  const bad = []
  const seen = {}
  let measured = 0
  for (const theme of ['default', ...themes.filter(x => x !== 'default')]) {
    for (const density of ['', 'compact']) {
      await page.evaluate(([th, d]) => { document.documentElement.dataset.theme = th; if (d) document.documentElement.dataset.density = d; else delete document.documentElement.dataset.density }, [theme, density])
      await sleep(150)
      const m = await page.evaluate(() => {
        const mid = el => { const b = el.getBoundingClientRect(); return b.top + b.height / 2 }
        const off = (el, chip) => Math.round((mid(el) - mid(chip)) * 10) / 10
        const drawn = el => el.getBoundingClientRect().height > 0
        return [...document.querySelectorAll('.reader-labels .label-chip, .msg-row .label-chips .label-chip')].filter(chip => drawn(chip.querySelector('.label-chip-name'))).map(chip => {
          const x = chip.querySelector('.label-chip-remove')
          return { name: off(chip.querySelector('.label-chip-name'), chip), x: x ? off(x, chip) : null, icon: x ? off(x.querySelector('svg'), chip) : null }
        })
      })
      for (const c of m) {
        measured++
        ;(seen[`${theme}/${density || 'normal'}`] ??= new Set()).add(c.x === null ? `name ${c.name}` : `name ${c.name} x ${c.x} icon ${c.icon}`)
        if ([c.name, c.x, c.icon].some(v => v !== null && Math.abs(v) > 0.5)) bad.push(c)
      }
    }
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'default'; delete document.documentElement.dataset.density })
  check(`${what} on the chip's centre line (every theme, both densities)`, measured === expected && bad.length === 0,
    `${measured} chips, ${bad.length} off; from the chip's centre (- = higher): ${Object.entries(seen).map(([k, v]) => `${k} ${[...v].join(' | ')}`).join('; ')}`)
}

let app = null
try {
  app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
  const page = await app.firstWindow()
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') consoleLines.push(`${m.type()}: ${m.text()}`) })
  await page.setViewportSize({ width: 1280, height: 860 })
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  await page.locator(`.folder-tree section[data-account="${pop}"] .folder[data-path="INBOX"]`).click({ timeout: 20000 })
  const row = subject => page.locator('.msg-row', { hasText: subject })
  await until(async () => (await page.locator('.msg-row[data-id]').count()) === 5, 'five rows', 300)
  const idOf = async subject => Number(await row(subject).getAttribute('data-id'))
  const ids = Object.fromEntries(await Promise.all(SUBJECTS.map(async s => [s, await idOf(s)])))

  // four labels on Alfa, one on Béta (through the bridge: the list and its event)
  const names = ['Számla', 'Ügyfél', 'Nagyon hosszú címkenév', 'Negyedik']
  const made = []
  for (const n of names) made.push((await api(page, 'labels', 'create', n, ['#d32f2f', '#fbc02d', '#1976d2', '#388e3c'][made.length])).label)
  for (const l of made) await api(page, 'mail', 'label', { ids: [ids['Alfa levél']], add: [l.id] })
  await api(page, 'mail', 'label', { ids: [ids['Béta levél']], add: [made[0].id] })
  await until(async () => (await row('Alfa levél').locator('.label-chip').count()) === 3, 'the chips of Alfa')

  // 1. 3 chips + "+1", the tooltip names all four
  const chipIds = await row('Alfa levél').locator('.label-chip').evaluateAll(els => els.map(e => Number(e.dataset.labelId)))
  const more = await row('Alfa levél').locator('.label-more-3').textContent()
  const title = await row('Alfa levél').locator('.label-chips').getAttribute('title')
  check('a row with 4 labels: 3 chips in the list order + "+1"', JSON.stringify(chipIds) === JSON.stringify(made.slice(0, 3).map(l => l.id)) && more === '+1', `${JSON.stringify(chipIds)} ${more}`)
  check('the tooltip names all four', title === names.join(', '), title)

  // 2. the row height: the --row-h token in both densities, with and without chips
  for (const density of ['normal', 'compact']) {
    await page.evaluate(d => (document.documentElement.dataset.density = d), density)
    await sleep(300)
    const m = await page.evaluate(([a, e]) => {
      const h = id => document.querySelector(`.msg-row[data-id="${id}"]`).getBoundingClientRect().height
      return { token: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--row-h')), withChips: h(a), without: h(e) }
    }, [ids['Alfa levél'], ids['Epszilon levél']])
    check(`row height in the ${density} density: with chips = without = --row-h`, m.withChips === m.token && m.without === m.token, JSON.stringify(m))
  }
  await page.evaluate(() => (document.documentElement.dataset.density = 'normal'))
  await chipCentres(page, 'the list row chips: the name', 4 * 10)

  // 3. the search hit shows the same chips
  await page.locator('.app-header .search-field input').fill('Alfa')
  await until(async () => (await page.locator('.result', { hasText: 'Alfa levél' }).locator('.label-chip').count()) === 3, 'the chips in the search hit')
  check('the search hit: the same 3 chips + "+1"', (await page.locator('.result', { hasText: 'Alfa levél' }).locator('.label-more-3').textContent()) === '+1')
  await page.keyboard.press('Escape')
  await until(async () => (await page.locator('.msg-row[data-id]').count()) === 5, 'back to the list')

  // 4. three selected (Béta has Számla): the toolbar icon, indeterminate, all on, all off
  // the row's checkbox selects without opening the message (a click on the row opens it in the list's place)
  for (const s of ['Béta levél', 'Gamma levél', 'Delta levél']) await row(s).locator('.col-check input').check()
  await page.locator('.action-bar .label-open').click()
  await page.locator('.label-picker').waitFor()
  const item = id => page.locator(`.label-picker-item[data-label-id="${id}"]`)
  await until(async () => (await item(made[0].id).getAttribute('data-state')) === 'some', 'Számla indeterminate')
  check('3 selected, 1 labelled: the label is indeterminate in the picker', await item(made[0].id).locator('input').evaluate(e => e.indeterminate))
  await item(made[0].id).locator('input').click()
  await until(async () => ['Béta levél', 'Gamma levél', 'Delta levél'].every(() => true) && (await row('Gamma levél').locator(`.label-chip[data-label-id="${made[0].id}"]`).count()) === 1, 'on all three')
  const onAll = await Promise.all(['Béta levél', 'Gamma levél', 'Delta levél'].map(s => row(s).locator(`.label-chip[data-label-id="${made[0].id}"]`).count()))
  check('a click puts it on all three (the rows at once)', onAll.every(n => n === 1), JSON.stringify(onAll))
  await item(made[0].id).locator('input').click()
  await until(async () => (await row('Béta levél').locator('.label-chip').count()) === 0, 'off all three')
  const offAll = await Promise.all(['Béta levél', 'Gamma levél', 'Delta levél'].map(s => row(s).locator('.label-chip').count()))
  check('again: it comes off all three', offAll.every(n => n === 0), JSON.stringify(offAll))

  // 5. "New label: Teszt" makes it and puts it on (still on the three)
  await page.locator('.label-picker-filter input').fill('Teszt')
  await page.getByRole('button', { name: t.labels.create('Teszt'), exact: true }).click()
  await until(async () => (await row('Gamma levél').locator('.label-chip', { hasText: 'Teszt' }).count()) === 1, 'Teszt on the rows')
  const listed = await api(page, 'labels', 'list')
  const teszt = listed.labels.find(l => l.name === 'Teszt')
  check('"New label: Teszt": made, in the label list, on the 3 selected', Boolean(teszt) && teszt.count === 3, JSON.stringify(listed.labels.map(l => [l.name, l.count])))
  if (values.shots) {
    fs.mkdirSync(values.shots, { recursive: true })
    await page.screenshot({ path: path.join(values.shots, 'labels-default-picker.png') })
  }
  await page.keyboard.press('Escape')
  await page.locator('.label-picker').waitFor({ state: 'detached' })

  // 6. the right-click menu opens the same picker; by keyboard to a box, Space, Esc, the focus back on the list
  await row('Epszilon levél').click({ button: 'right' })
  await page.getByRole('menuitem', { name: t.labels.menuItem, exact: true }).click()
  await page.locator('.label-picker').waitFor()
  check('right-click "Labels…": the picker', true)
  await page.keyboard.press('Escape')
  await page.locator('.label-picker').waitFor({ state: 'detached' })
  await row('Epszilon levél').click({ button: 'right' })
  const menuItems = page.getByRole('menuitem')
  await menuItems.first().waitFor()
  const n = await menuItems.count()
  let reached = false
  for (let i = 0; i < n + 2 && !reached; i++) {
    reached = (await page.evaluate(() => document.activeElement && document.activeElement.textContent)) === t.labels.menuItem
    if (!reached) await page.keyboard.press('ArrowDown')
  }
  check('by keyboard: the menu reaches "Labels…"', reached)
  await page.keyboard.press('Enter')
  await page.locator('.label-picker').waitFor()
  check('by keyboard: the picker opens with the focus in the filter', await page.evaluate(() => document.activeElement && document.activeElement.closest('.label-picker-filter') !== null))
  // the boxes are disabled until the state of the selection (mail:labelState) is in
  await page.locator('.label-picker-list:not([aria-busy])').waitFor()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press(' ')
  await until(async () => (await row('Epszilon levél').locator('.label-chip').count()) === 1, 'Space put the first label on')
  check('by keyboard: ArrowDown + Space puts the first label on', (await row('Epszilon levél').locator(`.label-chip[data-label-id="${made[0].id}"]`).count()) === 1)
  await page.keyboard.press('Escape')
  await page.locator('.label-picker').waitFor({ state: 'detached' })
  await sleep(100)
  check('Esc: the picker closes, the focus is back on the list', await page.evaluate(() => document.activeElement && document.activeElement.classList.contains('msg-viewport')))

  // 7. the reader: its button opens the picker; its x takes a label off, the list row follows (the reader on the right,
  // so the list row stays in view)
  await page.getByRole('button', { name: t.viewSettings, exact: true }).click()
  await page.getByRole('button', { name: t.settingsNav.appearance, exact: true }).click()
  await page.getByRole('button', { name: t.readerPaneLabel, exact: true }).click()
  await page.getByRole('menuitemradio', { name: t.readerPaneOptions.right, exact: true }).click()
  await page.getByRole('button', { name: t.backToMail, exact: true }).click()
  await page.locator('.msg-row[data-id]').first().waitFor()
  await row('Alfa levél').click()
  await page.locator(`.reader[data-message-id="${ids['Alfa levél']}"]`).waitFor()
  await until(async () => (await page.locator('.reader-labels .label-chip').count()) === 4, 'the reader chips')
  check('the reader: all four chips with the whole name', (await page.locator('.reader-labels .label-chip').nth(2).locator('.label-chip-name').textContent()) === names[2])
  await page.locator('.reader-label-add').click()
  await page.locator('.label-picker-list:not([aria-busy])').waitFor()
  check('the reader button opens the same picker', (await page.locator(`.label-picker-item[data-label-id="${made[3].id}"]`).getAttribute('data-state')) === 'all')
  await page.keyboard.press('Escape')
  await page.locator('.label-picker').waitFor({ state: 'detached' })
  check('the reader: Esc gives the focus back to its button', await page.evaluate(() => document.activeElement && document.activeElement.classList.contains('reader-label-add')))
  await page.locator('.reader-tools .reader-label-open').click()
  await page.locator('.label-picker').waitFor()
  check('the reader toolbar icon opens the same picker', true)
  await page.keyboard.press('Escape')
  await page.locator('.label-picker').waitFor({ state: 'detached' })
  await chipCentres(page, 'the reader chips: the x, its icon and the name', 4 * 10)
  if (values.shots) {
    for (const theme of ['default', 'dark']) {
      await page.evaluate(th => (document.documentElement.dataset.theme = th), theme)
      await sleep(250)
      await page.screenshot({ path: path.join(values.shots, `labels-${theme}-reader.png`) })
    }
    await page.evaluate(() => (document.documentElement.dataset.theme = 'default'))
  }
  await page.getByRole('button', { name: t.labels.remove(names[1]), exact: true }).click()
  await until(async () => (await page.locator('.reader-labels .label-chip').count()) === 3, 'the x took it off in the reader')
  await until(async () => (await row('Alfa levél').locator(`.label-chip[data-label-id="${made[1].id}"]`).count()) === 0, 'the row follows')
  check('the reader x: off in the reader and in the list row', (await row('Alfa levél').locator('.label-more-3').count()) === 0 && (await row('Alfa levél').locator('.label-chip').count()) === 3)

  // 8. 860 px: the chips do not push the date out of the row
  await page.setViewportSize({ width: 860, height: 700 })
  await sleep(400)
  const fit = await row('Alfa levél').evaluate(el => {
    const r = el.getBoundingClientRect()
    const d = el.querySelector('.col-date').getBoundingClientRect()
    const text = el.querySelector('.col-date')
    return { row: [r.left, r.right], date: [d.left, d.right], clipped: text.scrollWidth > text.clientWidth + 1 }
  })
  check('860 px: the date stays inside the row, not clipped', fit.date[1] <= fit.row[1] + 0.5 && !fit.clipped, JSON.stringify(fit))
  if (values.shots) {
    await page.setViewportSize({ width: 1280, height: 860 })
    await page.screenshot({ path: path.join(values.shots, 'labels-default-list.png') })
    await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'))
    await sleep(300)
    await page.screenshot({ path: path.join(values.shots, 'labels-dark-list.png') })
    await page.locator('.reader-label-add').click()
    await page.locator('.label-picker').waitFor()
    await page.screenshot({ path: path.join(values.shots, 'labels-dark-picker.png') })
    await page.keyboard.press('Escape')
    await page.evaluate(() => (document.documentElement.dataset.theme = 'default'))
  }

  // 9. visibility: the group's form by the width of the row's text cell, at many widths, both densities,
  // the list and the search hits: the form matches the cell (>= 240 chips, 90-239 up to 3 dots, 52-89 1 dot, < 52
  // nothing), what is drawn + "+N" = the labels, nothing sticks out of the cell, the subject keeps >= 50% of an
  // unlabelled row's (where that has >= 52 px), >= 120 px at a >= 240 px cell, the cell's tooltip names every label
  const FIT = { chips: 240, dots: 90, dot: 52 }
  const fitOf = w => (w >= FIT.chips ? 'chips' : w >= FIT.dots ? 'dots' : w >= FIT.dot ? 'dot' : 'none')
  const all = (await api(page, 'labels', 'list')).labels
  const extraLong = []
  for (const n of ['Még hosszabb címke neve', 'Harmadik hosszú címke']) extraLong.push((await api(page, 'labels', 'create', n, '#7b1fa2')).label)
  const wanted = {
    'Alfa levél': made.map(l => l.id), // 4
    'Béta levél': [], // none: the reference subject
    'Gamma levél': [made[2].id, ...extraLong.map(l => l.id)], // 3 long names
    'Delta levél': [made[3].id], // 1
    'Epszilon levél': [made[0].id, made[1].id], // 2
  }
  const everyLabel = [...all, ...extraLong]
  for (const [subject, want] of Object.entries(wanted)) {
    const add = everyLabel.filter(l => want.includes(l.id)).map(l => l.id)
    const remove = everyLabel.filter(l => !want.includes(l.id)).map(l => l.id)
    const res = await api(page, 'mail', 'label', { ids: [ids[subject]], add, remove })
    if (!res.ok) throw new Error(`seed ${subject}: ${res.error}`)
  }
  const nameOf = new Map(everyLabel.map(l => [l.id, l.name]))
  await until(async () => (await row('Gamma levél').locator('.label-chips').getAttribute('title')) === wanted['Gamma levél'].map(id => nameOf.get(id)).join(', '), 'the visibility seed', 200)

  // one row's geometry: the text cell (its content box: what the container query sees), what of the group is drawn,
  // the subject's visible part, the tooltip
  const measure = rowSel =>
    page.evaluate(sel => {
      const out = {}
      for (const el of document.querySelectorAll(sel)) {
        const cell = el.querySelector('.col-main') // the container: the text cell after the search hit's account / folder tag
        if (!cell) continue
        const cs = getComputedStyle(cell)
        const cr = cell.getBoundingClientRect()
        const content = cell.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
        const shown = x => x.getClientRects().length > 0 && getComputedStyle(x).display !== 'none'
        const inside = r => r.left >= cr.left - 0.5 && r.right <= cr.right + 0.5
        const chips = [...el.querySelectorAll('.label-chips .label-chip')].filter(shown).map(c => c.getBoundingClientRect())
        const mores = [...el.querySelectorAll('.label-chips .label-chip-more')].filter(shown)
        const subj = el.querySelector('.col-subject').getBoundingClientRect()
        const subject = Math.max(0, Math.min(subj.right, cr.right) - Math.max(subj.left, cr.left))
        out[el.querySelector('.col-subject').textContent] = {
          content,
          chips: chips.map(r => [Math.round(r.width), Math.round(r.height)]),
          more: mores.map(m => Number(m.textContent.replace('+', ''))),
          inside: chips.every(inside) && mores.every(m => inside(m.getBoundingClientRect())),
          subject,
          subjectFull: subj.width, // the subject's whole width (a short one shows whole below 120 px)
          title: el.querySelector('.col-text').getAttribute('title') || '',
          height: el.getBoundingClientRect().height,
        }
      }
      return out
    }, rowSel)
  const judged = []
  const judge = (where, data) => {
    const ref = data['Béta levél']
    for (const [subject, want] of Object.entries(wanted)) {
      if (!want.length) continue
      const d = data[subject]
      if (!d) { judged.push(`${where} ${subject}: not drawn`); continue }
      const fit = fitOf(d.content)
      const dots = d.chips.filter(([w, h]) => w === 8 && h === 8).length
      const chips = d.chips.length - dots
      const form = !d.chips.length && !d.more.length ? 'none' : chips ? 'chips' : dots === 1 && want.length > 1 && d.more[0] === want.length - 1 ? 'dot' : 'dots'
      const formOk = form === fit || (fit === 'dot' && want.length === 1 && form === 'dots') || (fit === 'dots' && want.length === 1 && form === 'dot')
      const counted = form === 'none' || d.chips.length + (d.more[0] || 0) === want.length
      const ok = formOk && counted && d.inside && d.more.length <= 1 &&
        (ref.subject < FIT.dot || d.subject >= 0.5 * ref.subject) &&
        (d.content < FIT.chips || d.subject >= Math.min(120, d.subjectFull) - 0.5) &&
        want.every(id => d.title.includes(nameOf.get(id)))
      if (!ok) judged.push(`${where} ${subject}: cell ${d.content.toFixed(0)} form ${form}/${fit} drawn ${JSON.stringify(d.chips)} +${d.more.join('/')} inside ${d.inside} subject ${d.subject.toFixed(0)}/${ref.subject.toFixed(0)}`)
    }
    return data
  }
  const points = []
  const both = async (where, rowSel) => {
    for (const density of ['normal', 'compact']) {
      await page.evaluate(d => (document.documentElement.dataset.density = d), density)
      await sleep(250)
      const data = judge(`${where} ${density}`, await measure(rowSel))
      const token = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--row-h')))
      if (rowSel.startsWith('.msg-row') && !Object.values(data).every(d => d.height === token)) judged.push(`${where} ${density}: row height ${JSON.stringify(Object.values(data).map(d => d.height))} != ${token}`)
      points.push(`${where}/${density[0]}: ${Object.values(data).map(d => `${d.content.toFixed(0)}:${d.subject.toFixed(0)}`).join(' ')}`)
    }
    await page.evaluate(() => (document.documentElement.dataset.density = 'normal'))
  }
  const listWidth = sel => page.evaluate(q => document.querySelector(q).getBoundingClientRect().width, sel)
  const dragListTo = async (w, sel) => {
    const now = await listWidth(sel)
    const b = await page.locator('.splitter[data-split="list"]').boundingBox()
    const x = b.x + b.width / 2
    const y = b.y + b.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + (w - now) / 2, y, { steps: 4 })
    await page.mouse.move(x + (w - now), y, { steps: 4 })
    await page.mouse.up()
    await sleep(200)
    return listWidth(sel)
  }
  const search = async on => {
    if (on) {
      await page.locator('.app-header .search-field input').fill('levél')
      await until(async () => (await page.locator('.result').count()) === 5, 'five hits')
    } else {
      await page.locator('.app-header .search-field input').focus() // Esc leaves the search from its field
      await page.keyboard.press('Escape')
      await until(async () => (await page.locator('.msg-row[data-id]').count()) === 5, 'back to the list')
    }
  }
  // the reader on the right (set in 7): the windows, then the splitter from 280 to 600 px in 20 px steps
  for (const w of [1280, 1440, 1920]) {
    await page.setViewportSize({ width: w, height: 860 })
    await sleep(300)
    await row('Alfa levél').click() // the reader open: the list | reader split
    await sleep(200)
    await both(`right ${w} list`, '.msg-row[data-id]')
    await search(true)
    await page.locator('.result', { hasText: 'Alfa levél' }).locator('.result-open').click()
    await sleep(200)
    await both(`right ${w} search`, '.result')
    await search(false)
  }
  await page.setViewportSize({ width: 1280, height: 860 })
  await sleep(300)
  await row('Alfa levél').click()
  for (let w = 280; w <= 600; w += 20) {
    const got = await dragListTo(w, '.msg-viewport')
    await both(`right list ${Math.round(got)}`, '.msg-row[data-id]')
  }
  await search(true)
  await page.locator('.result', { hasText: 'Alfa levél' }).locator('.result-open').click()
  await sleep(200)
  for (let w = 280; w <= 600; w += 20) {
    const got = await dragListTo(w, '.search-results')
    await both(`right search ${Math.round(got)}`, '.result')
  }
  await search(false)
  if (values.shots) {
    await page.setViewportSize({ width: 1280, height: 860 })
    await row('Alfa levél').click() // the search closed the message: the split comes back with an open one
    await sleep(200)
    await dragListTo(403, '.msg-viewport')
    // the dots with their ring: the yellow label on the light row, an indigo one (for the picture) on the dark row
    await api(page, 'labels', 'setColor', made[2].id, '#3949ab')
    for (const theme of ['default', 'dark']) {
      await page.evaluate(th => (document.documentElement.dataset.theme = th), theme)
      await sleep(300)
      await page.screenshot({ path: path.join(values.shots, `labels-${theme}-right-1280.png`) })
    }
    await page.evaluate(() => (document.documentElement.dataset.theme = 'default'))
    // a wider list: three dots (red, yellow, indigo) + "+1" in Alfa's row
    await dragListTo(500, '.msg-viewport')
    for (const theme of ['default', 'dark']) {
      await page.evaluate(th => (document.documentElement.dataset.theme = th), theme)
      await sleep(300)
      await page.screenshot({ path: path.join(values.shots, `labels-${theme}-dots-1280.png`) })
    }
    await page.evaluate(() => (document.documentElement.dataset.theme = 'default'))
    await dragListTo(403, '.msg-viewport')
    await api(page, 'labels', 'setColor', made[2].id, made[2].color)
  }
  // no reader pane: 860 and 1280
  await page.getByRole('button', { name: t.viewSettings, exact: true }).click()
  await page.getByRole('button', { name: t.settingsNav.appearance, exact: true }).click()
  await page.getByRole('button', { name: t.readerPaneLabel, exact: true }).click()
  await page.getByRole('menuitemradio', { name: t.readerPaneOptions.none, exact: true }).click()
  await page.getByRole('button', { name: t.backToMail, exact: true }).click()
  await page.locator('.msg-row[data-id]').first().waitFor()
  // 1000 and 1060: a text box just over 240 px, where the chips' half-width cap and their shrinking decide
  for (const w of [860, 1000, 1060, 1280]) {
    await page.setViewportSize({ width: w, height: 860 })
    await sleep(300)
    await both(`none ${w} list`, '.msg-row[data-id]')
    await search(true)
    await both(`none ${w} search`, '.result')
    if (values.shots && w === 860) {
      for (const theme of ['default', 'dark']) {
        await search(false)
        await page.evaluate(th => (document.documentElement.dataset.theme = th), theme)
        await sleep(300)
        await page.screenshot({ path: path.join(values.shots, `labels-${theme}-none-860.png`) })
        await search(true)
      }
      await page.evaluate(() => (document.documentElement.dataset.theme = 'default'))
    }
    await search(false)
  }
  console.log(`INFO cell:subject px per point (Alfa, Béta, Gamma, Delta, Epszilon order of the page): ${points.join(' | ')}`)
  check(`visibility: ${points.length} points (lists and search hits, both densities): the form by the cell, nothing out, the subject kept`, judged.length === 0, judged.slice(0, 12).join(' || '))

  const failed = fs.existsSync(mainLog) ? fs.readFileSync(mainLog, 'utf8').split('\n').filter(l => /(labels:\w+|mail:label\w*|mail:open) failed/.test(l)) : []
  check('main.log: no label failure', failed.length === 0, failed.join(' | '))
  check('the page console: no error or warning', consoleLines.length === 0, consoleLines.join(' | '))
} catch (err) {
  check('run', false, err.stack)
} finally {
  if (app) await app.close().catch(() => {})
  await server.close()
  fs.rmSync(work, { recursive: true, force: true })
}
console.log(`\n${results.filter(Boolean).length} / ${results.length} OK`)
process.exit(results.every(Boolean) ? 0 : 1)
