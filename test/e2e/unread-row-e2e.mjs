#!/usr/bin/env node
// The unread row stands out in the real app, headless Electron + Playwright. Not part of `npm test`.
//
//   node test/e2e/unread-row-e2e.mjs            (E2E_LANG=en for the English interface)
//
// In every theme of themes.js (one launch each, the reading pane on the right), on the message list's computed styles:
// 1. An unread row on --c-row-unread, a read one on --c-row-read, the two different, both the theme's expected color;
//    the unread sender, subject and date 700, the read ones 400.
// 2. A starred row's star button: no pressed disc (transparent) on a plain and on a selected row, the hover disc when
//    the mouse is on it; a pressed icon button elsewhere keeps its --c-surface-2 disc.
// 3. A selected row, unread and read, on --c-row-selected.
// 4. The mouse over a read, an unread and a selected row: the row's shadow, the hover actions on the row's own color;
//    a hover action and the star under the mouse: the row's translucent disc (--c-row-hover), composited at least 1.15:1
//    from the row; a button outside the rows (refresh) keeps --c-hover.
// 5. The open row (split view): the 3 px accent stripe stays.
// 6. Search hits: an unread hit on --c-row-unread with a bold sender, subject and date (the date in --c-text), a read
//    one on --c-row-read, the opened (selected) one on --c-row-selected.
// No renderer console error or warning, no outgoing request.
// Data: test/tools/seed-index.mjs (a dummy IMAP account at 127.0.0.1:1, nothing leaves the machine): message i is
// unread when i % 5 == 0, starred when i % 17 == 0, the newest (i = 0) first.
// Needs a fresh renderer build first: npx vite build
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { t, seedLanguage } from './lang.mjs'
import { THEMES } from '../../app/renderer/src/themes.js'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')

// the row colors of each theme, as theme.css gives them (contrast: test/theme-contrast.test.js)
const LIGHT = { read: '#f2f4f7', unread: '#ffffff', selected: '#dae4fc' }
const EXPECTED = {
  default: LIGHT,
  'classic-light': LIGHT,
  'classic-blue': { ...LIGHT, selected: '#d8e4f2' },
  dark: { read: '#1b1d21', unread: '#2a2e35', selected: '#333e50' },
  graphite: { read: '#333c49', unread: '#3e4857', selected: '#455164' },
}
const rgb = hex => `rgb(${[1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`
const CLEAR = 'rgba(0, 0, 0, 0)'
// a computed color -> [r, g, b, a]; a translucent one over another; the WCAG contrast of two
const rgbaOf = v => {
  const m = /rgba?\(([^)]+)\)/.exec(v || '')
  if (!m) return null
  const p = m[1].split(',').map(Number)
  return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]
}
const over = (top, under) => {
  const [r, g, b, a] = rgbaOf(top)
  const u = rgbaOf(under)
  return [r, g, b].map((c, i) => c * a + u[i] * (1 - a))
}
const lum = c => c.slice(0, 3).map(x => x / 255).map(x => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)).reduce((s, x, i) => s + x * [0.2126, 0.7152, 0.0722][i], 0)
const contrastOf = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-unread-row-e2e-'))
const dataDir = path.join(work, 'data')
const seed = JSON.parse(execFileSync(process.execPath, [path.join(repo, 'test', 'tools', 'seed-index.mjs'), dataDir, '--count', '40'], { encoding: 'utf8' }))
seedLanguage(dataDir)

const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const consoleLines = []

async function launch(theme) {
  const app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
  const page = await app.firstWindow()
  page.on('console', m => (m.type() === 'error' || m.type() === 'warning') && consoleLines.push(`${theme}: ${m.type()}: ${m.text()}`))
  page.on('pageerror', e => consoleLines.push(`${theme}: pageerror: ${e.message}`))
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.locator('#vault-unlock').waitFor({ timeout: 20_000 })
  // the theme and the split view as prefs, then a reload: the page starts under them, as after a restart
  await page.evaluate(id => {
    localStorage.setItem('shadowmail.ui.theme', JSON.stringify(id))
    localStorage.setItem('shadowmail.ui.readerPane', JSON.stringify('right'))
  }, theme)
  await Promise.all([page.waitForEvent('load', { timeout: 20_000 }), app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(w => w.webContents.reload()))])
  await page.waitForFunction(id => document.documentElement.dataset.theme === id, theme, { timeout: 20_000 })
  await page.locator('#vault-unlock').fill(seed.master)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  await page.locator('.msg-row[data-id]').first().waitFor({ timeout: 20_000 })
  return { app, page }
}

const row = i => `.msg-row[aria-rowindex="${i + 1}"]`
// a row's (or a hit's) computed look
const lookOf = (page, sel) =>
  page.locator(sel).evaluate(el => {
    const cs = e => (e ? getComputedStyle(e) : null)
    const box = el.matches('.result') ? el.querySelector('.result-open') : el
    const star = el.querySelector('.star-toggle')
    const quick = el.querySelector('.row-quick')
    return {
      cls: el.className,
      bg: cs(box).backgroundColor,
      shadow: cs(box).boxShadow,
      weights: ['.col-from', '.col-subject', '.col-date'].map(c => cs(el.querySelector(c)).fontWeight),
      dateColor: cs(el.querySelector('.col-date')).color,
      star: star ? { pressed: star.getAttribute('aria-pressed'), bg: cs(star).backgroundColor } : null,
      quick: quick ? cs(quick).backgroundColor : null,
    }
  })
// a token's computed color on the page, and a pressed icon button outside the list
const tokens = page =>
  page.evaluate(() => {
    const color = name => {
      const probe = document.createElement('div')
      probe.style.background = `var(${name})`
      document.body.appendChild(probe)
      const v = getComputedStyle(probe).backgroundColor
      probe.remove()
      return v
    }
    const btn = document.createElement('button')
    btn.className = 'icon-btn'
    btn.setAttribute('aria-pressed', 'true')
    document.body.appendChild(btn)
    const pressed = getComputedStyle(btn).backgroundColor
    btn.remove()
    const textProbe = document.createElement('div')
    textProbe.style.color = 'var(--c-text)'
    document.body.appendChild(textProbe)
    const text = getComputedStyle(textProbe).color
    textProbe.remove()
    return {
      read: color('--c-row-read'),
      unread: color('--c-row-unread'),
      selected: color('--c-row-selected'),
      accent: color('--c-accent'),
      hover: color('--c-hover'),
      rowHover: color('--c-row-hover'),
      surface2: color('--c-surface-2'),
      text,
      pressed,
    }
  })
const away = page => page.mouse.move(640, 5) // the header: no row under the mouse

let app = null
let page
try {
  for (const { id } of THEMES) {
    ;({ app, page } = await launch(id))
    const want = EXPECTED[id]
    const tok = await tokens(page)
    check(`${id}: the row tokens are the theme's colors`, want && tok.read === rgb(want.read) && tok.unread === rgb(want.unread) && tok.selected === rgb(want.selected), JSON.stringify(tok))

    // 1. read and unread: background and weight
    await away(page)
    const unread = await lookOf(page, row(5))
    const read = await lookOf(page, row(1))
    check(`${id}: an unread row on --c-row-unread, a read one on --c-row-read, the two different`, unread.cls.includes('unread') && !read.cls.includes('unread') && unread.bg === tok.unread && read.bg === tok.read && unread.bg !== read.bg, JSON.stringify({ unread: [unread.cls, unread.bg], read: [read.cls, read.bg] }))
    check(`${id}: the unread sender, subject and date 700, the read ones 400`, unread.weights.every(w => w === '700') && read.weights.every(w => w === '400'), JSON.stringify({ unread: unread.weights, read: read.weights }))
    check(`${id}: the unread date in --c-text`, unread.dateColor === tok.text, `${unread.dateColor} vs ${tok.text}`)

    // 2. a starred row's star: no disc, on a plain row
    const starredUnread = await lookOf(page, row(0))
    const starredRead = await lookOf(page, row(17))
    check(`${id}: a starred row's star has no disc (unread and read row)`, starredUnread.star?.pressed === 'true' && starredRead.star?.pressed === 'true' && starredUnread.star.bg === CLEAR && starredRead.star.bg === CLEAR, JSON.stringify([starredUnread.star, starredRead.star]))
    check(`${id}: a pressed icon button outside the list keeps its disc`, tok.pressed === tok.surface2 && tok.pressed !== CLEAR, `${tok.pressed} vs ${tok.surface2}`)

    // 3. selected: the starred unread row 0 and the starred read row 17
    for (const i of [0, 17]) await page.locator(`${row(i)} .col-check input`).click()
    await away(page)
    await page.waitForFunction(sel => document.querySelectorAll(sel).length === 2, '.msg-row.selected', { timeout: 2000 }).catch(() => {})
    const selUnread = await lookOf(page, row(0))
    const selRead = await lookOf(page, row(17))
    check(`${id}: a selected row on --c-row-selected, unread and read`, selUnread.cls.includes('selected') && selUnread.cls.includes('unread') && selRead.cls.includes('selected') && selUnread.bg === tok.selected && selRead.bg === tok.selected, JSON.stringify({ unread: [selUnread.cls, selUnread.bg], read: [selRead.cls, selRead.bg] }))
    check(`${id}: a selected starred row's star has no disc`, selUnread.star?.bg === CLEAR && selRead.star?.bg === CLEAR, JSON.stringify([selUnread.star, selRead.star]))
    await page.locator(`${row(0)} .star-toggle`).hover()
    const starHover = await page.locator(`${row(0)} .star-toggle`).evaluate(b => getComputedStyle(b).backgroundColor)
    const starStep = rgbaOf(starHover) ? contrastOf(over(starHover, selUnread.bg), rgbaOf(selUnread.bg)) : 0
    check(`${id}: the mouse on a selected starred row's star: the row's hover disc, 1.15:1 from the row`, starHover === tok.rowHover && starStep >= 1.15, `${starHover} vs ${tok.rowHover}, ${starStep.toFixed(3)}`)

    // 4. the mouse over a read, an unread and a selected row: the shadow, the hover actions on the row's color
    for (const [i, kind] of [[1, 'read'], [5, 'unread'], [17, 'selected']]) {
      await page.locator(`${row(i)} .col-subject`).hover()
      await page.locator(`${row(i)} .row-quick`).waitFor({ timeout: 2000 }).catch(() => {})
      const h = await lookOf(page, row(i))
      check(`${id}: the mouse over a ${kind} row: its shadow, the hover actions on ${kind === 'selected' ? '--c-row-selected' : `--c-row-${kind}`}`, h.bg === tok[kind] && h.shadow !== 'none' && h.quick === tok[kind], JSON.stringify(h))
      // a hover action and the star under the mouse: the row's disc, standing out from this row state
      for (const [what, sel] of [['a hover action', `${row(i)} .row-quick .icon-btn >> nth=0`], ['the star', `${row(i)} .star-toggle`]]) {
        await page.locator(sel).hover()
        const bg = await page.locator(sel).evaluate(b => getComputedStyle(b).backgroundColor)
        const step = rgbaOf(bg) ? contrastOf(over(bg, tok[kind]), rgbaOf(tok[kind])) : 0
        check(`${id}: ${what} under the mouse on a ${kind} row: the row's hover disc, 1.15:1 from the row`, bg === tok.rowHover && step >= 1.15, `${bg} vs ${tok.rowHover}, ${step.toFixed(3)}`)
      }
    }

    // a button outside the rows keeps the shared hover disc
    await page.locator('.list-header .list-refresh').hover()
    const refreshHover = await page.locator('.list-header .list-refresh').evaluate(b => getComputedStyle(b).backgroundColor)
    check(`${id}: refresh under the mouse (outside the rows): --c-hover as before`, refreshHover === tok.hover, `${refreshHover} vs ${tok.hover}`)

    // 5. open a read row in the split view (the selection cleared first): the accent stripe
    for (const i of [0, 17]) await page.locator(`${row(i)} .col-check input`).click()
    await page.locator(`${row(3)} .col-subject`).click()
    await page.locator('.msg-row.open').waitFor({ timeout: 5000 }).catch(() => {})
    await away(page)
    const open = await lookOf(page, row(3))
    check(`${id}: the open row keeps the inset 3 px accent stripe`, open.cls.includes('open') && open.shadow.includes('inset') && open.shadow.includes('3px 0px 0px 0px') && open.shadow.includes(tok.accent), JSON.stringify({ cls: open.cls, shadow: open.shadow, accent: tok.accent }))
    await page.locator(`${row(3)} .col-subject`).hover()
    const openHover = await lookOf(page, row(3))
    check(`${id}: the open row under the mouse: the stripe and the shadow`, openHover.shadow.includes(tok.accent) && openHover.shadow.split('rgb').length > 2, openHover.shadow)

    // 6. search hits: the sender "Kovács Anna" is message 0 (unread) and 8, 16, 24, 32 (read), among others
    await page.getByRole('searchbox', { name: t.searchLabel }).fill('kovacs')
    await page.waitForFunction(() => document.querySelector('.result.unread') && document.querySelector('.result:not(.unread)'), null, { timeout: 10_000 }).catch(() => {})
    await away(page)
    const hits = await page.locator('.result').count()
    const hitUnread = await lookOf(page, '.result.unread >> nth=0')
    const hitRead = await lookOf(page, '.result:not(.unread) >> nth=0')
    check(`${id}: search: an unread hit on --c-row-unread, a read one on --c-row-read`, hits >= 2 && hitUnread.bg === tok.unread && hitRead.bg === tok.read, JSON.stringify({ hits, unread: hitUnread.bg, read: hitRead.bg }))
    check(`${id}: search: the unread hit's sender, subject and date 700, the date in --c-text; the read hit's 400`, hitUnread.weights.every(w => w === '700') && hitUnread.dateColor === tok.text && hitRead.weights.every(w => w === '400'), JSON.stringify({ unread: [hitUnread.weights, hitUnread.dateColor], read: hitRead.weights }))
    await page.locator('.result:not(.unread) >> nth=0').locator('.result-open').hover()
    const hitHover = await lookOf(page, '.result:not(.unread) >> nth=0')
    check(`${id}: search: the mouse over a read hit: its own color and the shadow`, hitHover.bg === tok.read && hitHover.shadow !== 'none', JSON.stringify(hitHover))
    await page.locator('.result:not(.unread) >> nth=1').locator('.result-open').click()
    await page.locator('.result.selected').waitFor({ timeout: 5000 }).catch(() => {})
    await away(page)
    const hitSel = (await page.locator('.result.selected').count()) ? await lookOf(page, '.result.selected') : null
    check(`${id}: search: the opened hit on --c-row-selected`, hitSel && hitSel.bg === tok.selected, JSON.stringify(hitSel))

    await app.close()
    app = null
  }
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
