#!/usr/bin/env node
// The replied / forwarded marks in the real app (headless Electron + Playwright). Not part of `npm test`.
//
//   node test/e2e/reply-marks-e2e.mjs        (E2E_LANG=en: the same in English)
//
// In every theme of themes.js (one launch each, the reading pane on the right):
// 1. The list: \Answered -> the reply icon, $Forwarded -> the forward icon, both -> both (reply first), none -> nothing;
//    the words in the title and in the hidden text; the marks first in the text cell, before the label chips; of the
//    row's two copies (text cell, sender cell) exactly one shown, so a screen reader reads the words once.
// 2. The icon's color is --c-text-2 on a read, an unread and a selected row.
// 3. A narrow list: the row's content width at the switch (SWITCH, by density) +-2 px, 30 px above and the narrowest
//    list (280 px): above the switch the marks in the text cell, under it before the sender (with both flags one icon,
//    the reply); one copy shown, whole, inside its cell, over neither the subject nor the labels, the date track
//    unmoved; at 280 px the name keeps >= 31 px (normal) / 43 px (compact).
// 4. The search hits carry the same marks, and around their own switch the same rule; the Sent list (no such flags) none.
// No renderer console error or warning, no outgoing request.
// Data: test/tools/seed-index.mjs (a dummy IMAP account at 127.0.0.1:1, nothing leaves the machine); the flags and four
// labels (as IMAP keywords on the rows) written into the seeded database.
// Needs a fresh renderer build first: npx vite build
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { t, seedLanguage } from './lang.mjs'
import { THEMES } from '../../app/renderer/src/themes.js'
import { openVaultedDatabase } from '../../core/vault/vaulted-db.js'
import { labelKeyword } from '../../core/db/label-keyword.js'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-reply-marks-e2e-'))
const dataDir = path.join(work, 'data')
const seed = JSON.parse(execFileSync(process.execPath, [path.join(repo, 'test', 'tools', 'seed-index.mjs'), dataDir, '--count', '40'], { encoding: 'utf8' }))
seedLanguage(dataDir)

// the seed's message i (uid i + 1, the newest first): its flags; four labels as keywords on rows 1, 2 and 3
const LABELS = ['Számla', 'Ügyfél', 'Nagyon hosszú címkenév', 'Negyedik']
const ROWS = {
  1: { flags: '\\Seen \\Answered', labels: 4, want: ['reply'], words: 'answered' },
  2: { flags: '\\Seen $Forwarded', labels: 1, want: ['forward'], words: 'forwarded' },
  3: { flags: '\\Seen \\Answered $Forwarded', labels: 2, want: ['reply', 'forward'], words: 'both' },
  4: { flags: '\\Seen', labels: 0, want: [], words: null },
  5: { flags: '\\Answered', labels: 0, want: ['reply'], words: 'answered' },
}
{
  const { db } = await openVaultedDatabase(dataDir, seed.master)
  const keywords = []
  const addLabel = db.prepare('INSERT INTO labels (name, color, sort_order, created_at, keyword) VALUES (?, ?, ?, ?, ?)')
  LABELS.forEach((name, i) => {
    const k = labelKeyword(name, keywords)
    keywords.push(k)
    addLabel.run(name, ['#d32f2f', '#fbc02d', '#1976d2', '#388e3c'][i], i, Date.now(), k)
  })
  const setFlags = db.prepare("UPDATE messages SET flags = ? WHERE account_id = ? AND folder = 'INBOX' AND uid = ?")
  for (const [i, r] of Object.entries(ROWS)) setFlags.run([r.flags, ...keywords.slice(0, r.labels)].join(' '), seed.accountId, Number(i) + 1)
  db.close()
}

const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  if (!ok || process.env.E2E_VERBOSE) console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const consoleLines = []

async function launch(theme) {
  const app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
  const page = await app.firstWindow()
  page.on('console', m => (m.type() === 'error' || m.type() === 'warning') && consoleLines.push(`${theme}: ${m.type()}: ${m.text()}`))
  page.on('pageerror', e => consoleLines.push(`${theme}: pageerror: ${e.message}`))
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.locator('#vault-unlock').waitFor({ timeout: 20_000 })
  await page.evaluate(id => {
    localStorage.setItem('shadowmail.ui.theme', JSON.stringify(id))
    localStorage.setItem('shadowmail.ui.readerPane', JSON.stringify('right'))
  }, theme)
  await Promise.all([page.waitForEvent('load', { timeout: 20_000 }), app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(w => w.webContents.reload()))])
  await page.waitForFunction(id => document.documentElement.dataset.theme === id, theme, { timeout: 20_000 })
  await page.locator('#vault-unlock').fill(seed.master)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  await page.locator('.msg-row[data-id]').first().waitFor({ timeout: 20_000 })
  await page.waitForFunction(() => document.querySelectorAll('.msg-row[aria-rowindex="2"] .label-chips, .msg-row[aria-rowindex="2"] .label-chip').length > 0, null, { timeout: 10_000 }).catch(() => {})
  return { app, page }
}

const row = i => `.msg-row[aria-rowindex="${i + 1}"]`
// the marks of a row or a hit: the icons, the title, the hidden words, where they stand, their color
const marksOf = (page, sel) =>
  (typeof sel === 'string' ? page.locator(sel) : sel).evaluate(el => {
    const copies = [...el.querySelectorAll('.reply-marks')]
    const shown = copies.filter(c => getComputedStyle(c).display !== 'none')
    const m = shown[0]
    const text = el.querySelector('.col-text')
    return m
      ? {
          icons: [...m.querySelectorAll('svg')].map(s => s.getAttribute('data-icon')),
          title: m.getAttribute('title'),
          hidden: m.querySelector('.sr-only')?.textContent ?? null,
          shown: shown.length,
          copies: copies.length,
          first: text.firstElementChild === m,
          beforeLabels: !el.querySelector('.label-chips') || Boolean(m.compareDocumentPosition(el.querySelector('.label-chips')) & Node.DOCUMENT_POSITION_FOLLOWING),
          color: getComputedStyle(m.querySelector('svg')).color,
        }
      : null
  })
const text2 = page =>
  page.evaluate(() => {
    const probe = document.createElement('div')
    probe.style.color = 'var(--c-text-2)'
    document.body.appendChild(probe)
    const c = getComputedStyle(probe).color
    probe.remove()
    return c
  })
// the list's box: the message list, or the search hits in its place
const listWidth = page => page.locator('.msg-viewport, .search-results').first().evaluate(el => Math.round(el.getBoundingClientRect().width))
// the row content widths (padding out) under which the marks stand before the sender (app.css @container row-box;
// measured by sweeping the list divider 1 px at a time: there the text cell gets narrower than the two marks' 34 px)
const SWITCH = { normal: { list: 346, hits: 266 }, compact: { list: 326, hits: 258 } }
const rowWidth = (page, sel) =>
  page.locator(sel).first().evaluate(el => {
    const cs = getComputedStyle(el)
    return Math.round(el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight))
  })
// the divider until the row's (or hit's) content box is w px wide
async function dragRowTo(page, sel, w) {
  for (let i = 0; i < 5; i++) {
    const now = await rowWidth(page, sel)
    if (now === w) break
    const b = await page.locator('.splitter[data-split="list"]').boundingBox()
    const x = b.x + b.width / 2
    const y = b.y + b.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + (w - now), y, { steps: 4 })
    await page.mouse.up()
    await page.waitForTimeout(100)
  }
  return rowWidth(page, sel)
}
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
// at a list width: the marks' box against the text cell, the subject and the label group
const fitOf = (page, sel) =>
  page.locator(sel).evaluate(el => {
    const r = e => (e ? e.getBoundingClientRect() : null)
    const copies = [...el.querySelectorAll('.reply-marks')]
    const shownEl = copies.find(c => getComputedStyle(c).display !== 'none')
    const m = r(shownEl)
    if (!m) return null
    const inFrom = shownEl.classList.contains('reply-marks-from')
    const cell = r(el.querySelector(inFrom ? '.col-from' : '.col-text'))
    const overlap = (a, b) => a && b && a.width > 0.5 && b.width > 0.5 && a.left < b.right - 0.5 && b.left < a.right - 0.5
    const subject = r(el.querySelector('.col-subject'))
    const labels = r(el.querySelector('.label-chips'))
    const from = el.querySelector('.col-from')
    const fcs = getComputedStyle(from)
    return {
      width: Math.round(m.width),
      icons: [...shownEl.querySelectorAll('svg')].map(s => s.getAttribute('data-icon')),
      // the name's room: the sender cell's content box less the marks before it
      nameRoom: Math.round(from.clientWidth - parseFloat(fcs.paddingLeft) - parseFloat(fcs.paddingRight) - (inFrom ? m.width + parseFloat(getComputedStyle(shownEl).marginRight) : 0)),
      date: Math.round(el.querySelector('.col-date').getBoundingClientRect().width),
      shown: copies.filter(c => getComputedStyle(c).display !== 'none').length,
      place: inFrom ? 'from' : 'text',
      row: Math.round(el.getBoundingClientRect().width),
      content: Math.round(el.clientWidth - parseFloat(getComputedStyle(el).paddingLeft) - parseFloat(getComputedStyle(el).paddingRight)),
      textCell: Math.round(el.querySelector('.col-text').getBoundingClientRect().width),
      inside: m.left >= cell.left - 0.5 && m.right <= cell.right + 0.5,
      // the marks before the sender: the name follows them (the cell's text node starts after the marks)
      nameAfter: !inFrom || shownEl.nextSibling !== null,
      overSubject: overlap(m, subject),
      overLabels: overlap(m, labels),
    }
  })

let app = null
let page
try {
  for (const { id } of THEMES) {
    ;({ app, page } = await launch(id))
    await page.mouse.move(640, 5)
    const tx2 = await text2(page)

    // 1. the list's marks
    for (const [i, r] of Object.entries(ROWS)) {
      const m = await marksOf(page, row(Number(i)))
      if (!r.want.length) {
        check(`${id}: row ${i} (${r.flags}): no mark`, m === null, JSON.stringify(m))
        continue
      }
      check(`${id}: row ${i} (${r.flags}): ${r.want.join(' + ')}, first in the text cell, before the labels; one copy shown of two`, m && JSON.stringify(m.icons) === JSON.stringify(r.want) && m.first && m.beforeLabels && m.shown === 1 && m.copies === 2, JSON.stringify(m))
      check(`${id}: row ${i}: the title and the hidden text "${t.replyMarks[r.words]}"`, m && m.title === t.replyMarks[r.words] && m.hidden === t.replyMarks[r.words], JSON.stringify(m && [m.title, m.hidden]))
    }

    // 2. the color: --c-text-2 on a read (1), an unread (5) and a selected row (1, selected)
    const onRead = await marksOf(page, row(1))
    const onUnread = await marksOf(page, row(5))
    await page.locator(`${row(1)} .col-check input`).click()
    await page.mouse.move(640, 5)
    await page.waitForFunction(sel => document.querySelector(sel)?.classList.contains('selected'), row(1), { timeout: 2000 }).catch(() => {})
    const onSelected = await marksOf(page, row(1))
    check(`${id}: the icon in --c-text-2 on a read, an unread and a selected row`, [onRead, onUnread, onSelected].every(m => m && m.color === tx2), JSON.stringify({ tx2, read: onRead?.color, unread: onUnread?.color, selected: onSelected?.color }))
    await page.locator(`${row(1)} .col-check input`).click()

    // 3. a narrow list: open a row without marks (the split view); the row's width around the switch (+-2 px), above it
    //    and the narrowest list (280 px): the one copy shown stands in the text cell above, before the sender under it,
    //    whole, inside its cell, over neither the subject nor the labels (and the name follows it)
    await page.locator(`${row(6)} .col-subject`).click()
    await page.locator('.splitter[data-split="list"]').waitFor({ timeout: 10_000 })
    const sw = SWITCH[THEMES.find(x => x.id === id).density === 'compact' ? 'compact' : 'normal']
    const colDate = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.msg-row')).getPropertyValue('--col-date')))
    const marksOk = (fits, where) =>
      Object.entries(fits).filter(([i, f]) => {
        const icons = where === 'from' ? ROWS[i].want.slice(0, 1) : ROWS[i].want
        return !f || f.shown !== 1 || f.place !== where || JSON.stringify(f.icons) !== JSON.stringify(icons) || f.width < 14 * icons.length || !f.inside || f.overSubject || f.overLabels || !f.nameAfter || (where === 'text' && f.textCell < 34) || f.date !== colDate
      })
    for (const want of [sw.list + 30, sw.list + 2, sw.list + 1, sw.list, sw.list - 1, sw.list - 2, 0]) {
      const got = want ? await dragRowTo(page, row(1), want) : (await dragTo(page, 280), await rowWidth(page, row(1)))
      await page.mouse.move(640, 5)
      const fits = {}
      for (const i of [1, 2, 3, 5]) fits[i] = await fitOf(page, row(i))
      const where = got < sw.list ? 'from' : 'text'
      const bad = marksOk(fits, where)
      if (!want) {
        // the narrowest list: the name keeps >= 31 px (normal) / 43 px (compact) next to the marks
        const least = THEMES.find(x => x.id === id).density === 'compact' ? 43 : 31
        const rooms = [1, 2, 3, 5].map(i => fits[i] && fits[i].nameRoom)
        check(`${id}: list 280 px: the name's room next to the marks >= ${least} px (${rooms.join(', ')})`, rooms.every(r => r >= least), JSON.stringify(rooms))
      }
      check(`${id}: list row content ${got} px (switch under ${sw.list}): the marks ${where === 'from' ? 'before the sender' : 'in the text cell'}, one copy, whole, over nothing`, (!want || got === want) && !bad.length, JSON.stringify(bad.length ? bad : fits[3]))
    }

    // 4. the search hits ("Tóth Gábor" is message 3: both marks; "Nagy Péter" message 1: the reply; the INBOX row's own
    //    hit, by its id: the seed copies the rows into Sent too, without the flags) and the Sent list
    const idOf = {}
    for (const i of [1, 3]) idOf[i] = await page.locator(row(i)).getAttribute('data-id')
    const box = page.getByRole('searchbox', { name: t.searchLabel })
    for (const [q, i] of [['Tóth', 3], ['Nagy', 1]]) {
      await box.fill(q)
      const hit = `.result[data-id="${idOf[i]}"]`
      await page.locator(hit).waitFor({ timeout: 10_000 }).catch(() => {})
      const m = (await page.locator(hit).count()) ? await marksOf(page, hit) : null
      check(`${id}: search "${q}": message ${i}'s hit with ${ROWS[i].want.join(' + ')} and its title`, m && JSON.stringify(m.icons) === JSON.stringify(ROWS[i].want) && m.title === t.replyMarks[ROWS[i].words], JSON.stringify(m))
    }
    // the hits next to the reader (a hit opened brings the reader and the divider back): around their switch and at 280 px
    await page.locator('.result:not([data-id="' + idOf[1] + '"]) .result-open').first().click()
    await page.locator('.splitter[data-split="list"]').waitFor({ timeout: 10_000 }).catch(() => {})
    if (await page.locator('.splitter[data-split="list"]').count()) {
      const hit = `.result[data-id="${idOf[1]}"] .result-open`
      // the hit list gains or loses its scrollbar as it narrows (a 15 px step, measured: in the default density the
      // content widths 256-271 px, the switch among them, are then never reached): a window tall enough for every hit
      // without a scrollbar. Every list width from 330 to 280 px, the rule at every content width reached, and the
      // widths reached next to the switch reported
      await page.setViewportSize({ width: 1280, height: 1600 })
      const seen = []
      const wrong = []
      for (let w = 330; w >= 280; w--) {
        await dragTo(page, w)
        await page.mouse.move(640, 5)
        const f = await fitOf(page, hit)
        const where = f && f.content < sw.hits ? 'from' : 'text'
        seen.push(f && f.content)
        if (!f || f.shown !== 1 || f.place !== where || JSON.stringify(f.icons) !== '["reply"]' || f.width < 14 || !f.inside || f.overSubject || !f.nameAfter || (where === 'text' && f.textCell < 34)) wrong.push({ w, ...f })
      }
      const near = [...new Set(seen.filter(c => Math.abs(c - sw.hits) <= 2))].sort((a, b) => a - b)
      check(`${id}: search hits at every list width 280-330 px (switch under ${sw.hits}): the mark in its place, one copy, whole, over no subject`, !wrong.length, JSON.stringify(wrong.slice(0, 3)))
      check(`${id}: search hits: content widths reached at the switch +-2 px on both sides (${near.join(', ')})`, near.some(c => c < sw.hits) && near.some(c => c >= sw.hits), JSON.stringify([...new Set(seen)].sort((a, b) => a - b)))
      await page.setViewportSize({ width: 1280, height: 800 })
    } else check(`${id}: search hits next to the reader: the divider`, false)
    await box.fill('')
    await box.press('Escape')
    await page.locator('.folder-tree .folder[data-path="Sent"]').first().click()
    await page.locator('.msg-row[data-id]').first().waitFor({ timeout: 10_000 })
    check(`${id}: the Sent list: no mark on any row`, (await page.locator('.msg-row .reply-marks').count()) === 0)

    await app.close()
    app = null
  }
} catch (e) {
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
