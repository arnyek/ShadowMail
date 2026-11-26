#!/usr/bin/env node
// The replied / forwarded mark in the real app (headless Electron + Playwright). Not part of `npm test`.
//
//   node test/e2e/reply-marks-e2e.mjs [--shots <dir>]      (E2E_LANG=en: the same in English)
//
// In every theme of themes.js (one launch each, the reading pane on the right):
// 1. The list: \Answered -> the reply icon, $Forwarded -> the forward icon, both -> ONE icon (the reply) whose words name
//    both, none -> nothing; ONE .reply-marks per row (the hidden words once), at the end of the sender cell, none in the
//    text cell; the words in the title and in the hidden text.
// 2. The icon's color is --c-text-2 on a read, an unread and a selected row.
// 3. The alignment: with the reader open, the list 280-600 px wide in 20 px steps, and the window 1280 and 860 px wide:
//    the label / subject box (.col-main) starts at the same x (<= 1 px) and the text cell is as wide in a row without a
//    mark, with one and with both; the mark whole and inside its sender cell, after the cell's content box (the name ends
//    before it); at 280 px the name keeps >= 31 px (normal) / 43 px (compact).
// 4. The search hits: a hit with a mark and one without start their .col-main at the same x, the mark whole in the
//    sender cell, one copy, also in a 280 px hit list.
// 5. The Sent list: a replied row with "Name +2": the mark at the cell's right end, the "+2" whole before it, at the
//    list's own width and at 280 px; the rows without the flag carry none.
// --shots <dir>: the list of every theme as a PNG. No renderer console error or warning, no outgoing request.
// Data: test/tools/seed-index.mjs (a dummy IMAP account at 127.0.0.1:1, nothing leaves the machine); the flags, four
// labels (as IMAP keywords on the rows) and one Sent row's recipients written into the seeded database.
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
  6: { flags: '\\Seen', labels: 2, want: [], words: null },
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
  // the Sent copy of message 1: replied, to three recipients ("Name +2" in the recipient cell)
  db.prepare("UPDATE messages SET flags = '\\Seen \\Answered', to_addrs = ? WHERE account_id = ? AND folder = 'Sent' AND uid = 2")
    .run('Hosszú Nevű Első Címzett <elso@example.invalid>, masodik@example.invalid, harmadik@example.invalid', seed.accountId)
  db.close()
}

const shotsAt = process.argv.indexOf('--shots')
const shots = shotsAt > 0 ? path.resolve(process.argv[shotsAt + 1]) : null
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
// the mark of a row or a hit: the icons, the title, the hidden words, where it stands, its color
const marksOf = (page, sel) =>
  page.locator(sel).evaluate(el => {
    const copies = [...el.querySelectorAll('.reply-marks')]
    const m = copies[0]
    const from = el.querySelector('.col-from')
    return m
      ? {
          icons: [...m.querySelectorAll('svg')].map(s => s.getAttribute('data-icon')),
          title: m.getAttribute('title'),
          hidden: m.querySelector('.sr-only')?.textContent ?? null,
          copies: copies.length,
          hiddenWords: el.querySelectorAll('.reply-marks .sr-only').length,
          inFrom: from.contains(m),
          last: from.lastElementChild === m,
          inText: el.querySelectorAll('.col-text .reply-marks').length,
          color: getComputedStyle(m.querySelector('svg')).color,
        }
      : { none: true, copies: copies.length }
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
async function dragTo(page, w) {
  for (let i = 0; i < 4; i++) {
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
// one row or hit: where its label / subject box starts, its text cell's width, its mark against the sender cell
const placeOf = (page, sel) =>
  page.locator(sel).evaluate(el => {
    const r = e => e.getBoundingClientRect()
    const main = el.querySelector('.col-main')
    const text = el.querySelector('.col-text')
    const from = el.querySelector('.col-from')
    const m = el.querySelector('.reply-marks')
    const fr = r(from)
    const fcs = getComputedStyle(from)
    // the sender cell's content box: the name (or "Name +N") lives there
    const contentRight = fr.left + from.clientLeft + from.clientWidth - parseFloat(fcs.paddingRight)
    const out = { main: main ? r(main).left : null, text: r(text).width, copies: el.querySelectorAll('.reply-marks').length, nameRoom: Math.round(from.clientWidth - parseFloat(fcs.paddingLeft) - parseFloat(fcs.paddingRight)) }
    if (m) {
      const mr = r(m)
      const svg = r(m.querySelector('svg'))
      out.mark = {
        width: Math.round(svg.width * 10) / 10,
        inside: mr.left >= fr.left - 0.5 && mr.right <= fr.right + 0.5 && mr.top >= fr.top - 0.5 && mr.bottom <= fr.bottom + 0.5,
        afterName: mr.left >= contentRight - 0.5,
        overText: mr.right > r(text).left + 0.5,
      }
    }
    const more = el.querySelector('.recipient-more')
    if (more) {
      const mo = r(more)
      out.more = { whole: more.scrollWidth <= more.clientWidth + 0.5 && mo.right <= contentRight + 0.5, beforeMark: !m || mo.right <= r(m).left + 0.5, text: more.textContent }
    }
    return out
  })
// rows: the alignment rule over them at the current width; -> the faults
async function alignment(page, sels, where) {
  const p = {}
  for (const s of sels) p[s] = await placeOf(page, s)
  const mains = Object.values(p).map(x => x.main)
  const texts = Object.values(p).map(x => x.text)
  const bad = []
  if (Math.max(...mains) - Math.min(...mains) > 1) bad.push(`${where}: .col-main starts ${mains.map(Math.round).join('/')}`)
  if (Math.max(...texts) - Math.min(...texts) > 1) bad.push(`${where}: text cell ${texts.map(Math.round).join('/')}`)
  for (const [s, x] of Object.entries(p)) {
    if (x.copies > 1) bad.push(`${where} ${s}: ${x.copies} copies`)
    if (x.mark && (x.mark.width < 13.5 || !x.mark.inside || !x.mark.afterName || x.mark.overText)) bad.push(`${where} ${s}: mark ${JSON.stringify(x.mark)}`)
  }
  return { bad, p }
}

let app = null
let page
try {
  for (const { id, density } of THEMES) {
    ;({ app, page } = await launch(id))
    await page.mouse.move(640, 5)
    const tx2 = await text2(page)
    const compact = density === 'compact'

    // 1. the list's marks
    for (const [i, r] of Object.entries(ROWS)) {
      const m = await marksOf(page, row(Number(i)))
      if (!r.want.length) {
        check(`${id}: row ${i} (${r.flags}): no mark`, m.none && m.copies === 0, JSON.stringify(m))
        continue
      }
      const icon = r.want.slice(0, 1)
      check(`${id}: row ${i} (${r.flags}): one ${icon[0]} icon, one copy at the end of the sender cell, none in the text cell`, JSON.stringify(m.icons) === JSON.stringify(icon) && m.copies === 1 && m.hiddenWords === 1 && m.inFrom && m.last && m.inText === 0, JSON.stringify(m))
      check(`${id}: row ${i}: the title and the hidden text "${t.replyMarks[r.words]}"`, m.title === t.replyMarks[r.words] && m.hidden === t.replyMarks[r.words], JSON.stringify([m.title, m.hidden]))
    }

    // 2. the color: --c-text-2 on a read (1), an unread (5) and a selected row (1, selected)
    const onRead = await marksOf(page, row(1))
    const onUnread = await marksOf(page, row(5))
    await page.locator(`${row(1)} .col-check input`).click()
    await page.mouse.move(640, 5)
    await page.waitForFunction(sel => document.querySelector(sel)?.classList.contains('selected'), row(1), { timeout: 2000 }).catch(() => {})
    const onSelected = await marksOf(page, row(1))
    check(`${id}: the icon in --c-text-2 on a read, an unread and a selected row`, [onRead, onUnread, onSelected].every(m => m.color === tx2), JSON.stringify({ tx2, read: onRead.color, unread: onUnread.color, selected: onSelected.color }))
    await page.locator(`${row(1)} .col-check input`).click()
    if (shots) {
      fs.mkdirSync(shots, { recursive: true })
      await page.locator('.list-area').screenshot({ path: path.join(shots, `JA1-list-${id}-${process.env.E2E_LANG || 'hu'}.png`) })
    }

    // 3. the alignment: the rows with no mark (4, 6), one (1, 2, 5) and both (3), labels on 1, 2, 3 and 6
    const sels = [1, 2, 3, 4, 5, 6].map(row)
    const wide = await alignment(page, sels, '1280 px, no reader')
    check(`${id}: 1280 px window, no reader: the label / subject start and the text cell the same in every row, the mark whole in its cell`, !wide.bad.length, JSON.stringify(wide.bad.length ? wide.bad : wide.p[row(3)]))
    await page.locator(`${row(4)} .col-subject`).click()
    await page.locator('.splitter[data-split="list"]').waitFor({ timeout: 10_000 })
    const faults = []
    const reached = []
    for (let w = 280; w <= 600; w += 20) {
      const got = await dragTo(page, w)
      await page.mouse.move(640, 5)
      reached.push(got)
      const a = await alignment(page, sels, `list ${got} px`)
      faults.push(...a.bad)
      if (w === 280) {
        const least = compact ? 43 : 31
        const rooms = [1, 2, 3, 5].map(i => a.p[row(i)].nameRoom)
        check(`${id}: list 280 px: the name's room next to the mark >= ${least} px (${rooms.join(', ')})`, rooms.every(r => r >= least), JSON.stringify(rooms))
      }
    }
    check(`${id}: list 280-600 px every 20 px (${reached.join(', ')}): the label / subject start and the text cell the same in every row, the mark whole in its cell`, !faults.length && reached.every((g, k) => Math.abs(g - (280 + 20 * k)) <= 1), JSON.stringify(faults.slice(0, 4)))
    await page.setViewportSize({ width: 860, height: 640 })
    await page.waitForTimeout(200)
    const small = await alignment(page, sels, '860 px')
    check(`${id}: 860 px window with the reader: the same`, !small.bad.length, JSON.stringify(small.bad.length ? small.bad : small.p[row(3)]))
    await page.setViewportSize({ width: 1280, height: 800 })

    // 4. the search hits: "Nagy" is message 1 (the reply) and message 9 (none), both in INBOX
    const idOf = {}
    for (const i of [1, 9]) idOf[i] = await page.locator(row(i)).getAttribute('data-id')
    const box = page.getByRole('searchbox', { name: t.searchLabel })
    await box.fill('Nagy')
    const hit = i => `.result[data-id="${idOf[i]}"] .result-open`
    await page.locator(hit(9)).waitFor({ timeout: 10_000 }).catch(() => {})
    const hm = await marksOf(page, `.result[data-id="${idOf[1]}"]`)
    check(`${id}: search "Nagy": message 1's hit with the reply icon, one copy, in the sender cell`, JSON.stringify(hm.icons) === '["reply"]' && hm.copies === 1 && hm.inFrom && hm.title === t.replyMarks.answered, JSON.stringify(hm))
    const hits = await alignment(page, [hit(1), hit(9)], 'hits')
    check(`${id}: search hits: the hit with a mark and the one without start their label / subject at the same x`, !hits.bad.length, JSON.stringify(hits.bad.length ? hits.bad : hits.p))
    await page.locator(hit(9)).click()
    await page.locator('.splitter[data-split="list"]').waitFor({ timeout: 10_000 }).catch(() => {})
    if (await page.locator('.splitter[data-split="list"]').count()) {
      const got = await dragTo(page, 280)
      await page.mouse.move(640, 5)
      const narrow = await alignment(page, [hit(1), hit(9)], `hits ${got} px`)
      check(`${id}: search hits in a ${got} px list: the same`, !narrow.bad.length, JSON.stringify(narrow.bad.length ? narrow.bad : narrow.p))
    } else check(`${id}: search hits next to the reader: the divider`, false)
    await box.fill('')
    await box.press('Escape')

    // 5. the Sent list: the replied copy of message 1 ("Name +2") and the others
    await page.locator('.folder-tree .folder[data-path="Sent"]').first().click()
    await page.locator('.msg-row[data-id]').first().waitFor({ timeout: 10_000 })
    const sentRow = '.msg-row:has(.col-recipient.has-reply-marks)'
    await page.locator(sentRow).first().waitFor({ timeout: 5000 }).catch(() => {})
    check(`${id}: the Sent list: one replied row, the others without a mark`, (await page.locator(sentRow).count()) === 1 && (await page.locator('.msg-row .reply-marks').count()) === 1)
    for (const w of [null, 280]) {
      if (w) {
        if (!(await page.locator('.splitter[data-split="list"]').count())) await page.locator('.msg-row:not(:has(.reply-marks)) .col-subject').first().click()
        await page.locator('.splitter[data-split="list"]').waitFor({ timeout: 10_000 }).catch(() => {})
        await dragTo(page, w)
        await page.mouse.move(640, 5)
      }
      const s = (await page.locator(sentRow).count()) ? await placeOf(page, sentRow) : null
      check(`${id}: Sent ${w ? `${w} px list` : 'list'}: "${s?.more?.text?.trim()}" whole, before the mark; the mark whole at the cell's end`, s && s.more && s.more.whole && s.more.beforeMark && s.mark && s.mark.inside && s.mark.afterName && s.mark.width >= 13.5, JSON.stringify(s))
    }

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
