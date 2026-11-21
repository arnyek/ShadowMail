#!/usr/bin/env node
// Text color and Highlight in the composer, in the real app (headless Electron + Playwright). Not part of `npm test`.
//
//   node test/e2e/compose-colors-e2e.mjs        (E2E_LANG=en: in English; E2E_THEME=dark: under the dark theme)
//
// The two menus of the formatting bar on a selected word: the computed colour and background in the editor, one Ctrl+Z
// back, no CSP line, and what goes out (sent to a local SMTP server, or the composer's own sanitizer on the editor's HTML,
// the very function its send runs): combinations, recolouring, Automatic and No highlight on the nested structures (a
// colour around a bold, part of a word, a highlighted font, a quote) at a paragraph's start and end and in a list item;
// two paragraphs / list items / a quote's paragraphs at once; bold, italic and underline on and off; the keyboard path
// (Alt+F10, arrows, Enter, Esc); a colour at the caret; the text emptied by Ctrl+A + Delete; the window's own copy, cut
// and paste (and a foreign or a faked paste without colours); a saved draft opened again; the writing surface light
// under every theme. No console warning, no page exception, the main log clean.
// Playwright: PW=<path of the playwright package> (default: the repo's playwright-core devDependency).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { SMTPServer } from 'smtp-server'
import { simpleParser } from 'mailparser'
import { JSDOM } from 'jsdom'
import createDOMPurify from 'dompurify'
import { FakePop3Server } from '../helpers/fake-pop3.js'
import { createVaultedDatabase } from '../../core/vault/vaulted-db.js'
import { AccountStore } from '../../core/accounts/model.js'
import { newAccountDefaults } from '../../core/accounts/defaults.js'
import { sanitizeCompose } from '../../app/renderer/src/sanitize.js'
import { TEXT_COLORS, HIGHLIGHT_COLORS } from '../../core/smtp/text-colors.js'
import { t, locale, seedLanguage } from './lang.mjs'
import { useTheme, e2eTheme } from './theme-env.mjs'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const MASTER = 'Teszt-mesterjelszo-szinek'
const ME = 'teszt@example.invalid'
const SUBJECT = 'Színek próba'
const RED = TEXT_COLORS[0].hex
const BLUE = TEXT_COLORS[3].hex
const YELLOW = HIGHLIGHT_COLORS[0]
const GREEN = HIGHLIGHT_COLORS[1]
const RGB = hex => `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`
const purify = createDOMPurify(new JSDOM('').window)
const savedHint = (d => t.composeSavedAt(d).replace(d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }), '').trim())(new Date())

const watchdog = setTimeout(() => {
  console.log('FAIL watchdog: the run took more than 12 minutes')
  process.exit(1)
}, 720_000)
watchdog.unref()

const received = []
const smtp = new SMTPServer({
  disabledCommands: ['STARTTLS'], allowInsecureAuth: true, authMethods: ['PLAIN', 'LOGIN'], logger: false,
  onAuth: (a, _s, cb) => cb(null, { user: a.username }),
  onData(stream, _session, cb) {
    const chunks = []
    stream.on('data', c => chunks.push(c))
    stream.on('end', () => (received.push(Buffer.concat(chunks)), cb()))
  },
})
smtp.on('error', () => {})
await new Promise(r => smtp.listen(0, '127.0.0.1', r))

const pop = await new FakePop3Server().listen()
pop.add(Buffer.from([
  'From: Kovács Anna <anna@example.invalid>', `To: Teszt Elek <${ME}>`, 'Subject: =?utf-8?q?Sz=C3=ADnek_pr=C3=B3ba?=',
  `Date: ${new Date().toUTCString()}`, 'Message-ID: <colors-1@example.invalid>', 'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit', '', 'Az eredeti levél szövege.', '',
].join('\r\n')))

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-colors-e2e-'))
const dataDir = path.join(work, 'data')
fs.mkdirSync(dataDir)
seedLanguage(dataDir)
{
  const { db, vault } = await createVaultedDatabase(dataDir, MASTER)
  const store = new AccountStore(db, vault, { storeDir: path.join(dataDir, 'store') })
  store.save({
    ...newAccountDefaults('pop3'), name: 'POP3-fiók', email: ME, display_name: 'Teszt Elek', signature: 'Üdv, Elek',
    in_host: '127.0.0.1', in_port: pop.port, in_security: 'none', in_user: pop.user, in_password: pop.pass,
    smtp_host: '127.0.0.1', smtp_port: smtp.server.address().port, smtp_security: 'none',
  })
  db.close()
}

const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const consoleLines = []
const pageErrors = []
const app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
const watch = (w, name = 'composer') => {
  w.on('console', m => (m.type() === 'error' || m.type() === 'warning') && consoleLines.push(`${name} ${m.type()}: ${m.text()}`))
  w.on('pageerror', e => pageErrors.push(String(e)))
}
const csp = () => consoleLines.filter(l => /Content Security Policy/.test(l)).length
// KNOWN (before this work, the project note): the MAIN window's reader sanitizes a message with style attributes on its own
// page, and style-src 'self' reports each one on the console; a coloured draft opened in the reader does it too
const known = []

// what goes out of the editor's HTML: the composer's own send sanitizer (Composer.jsx form(): colors on)
const outgoing = html => sanitizeCompose(purify, html, { colors: true })
// the colour, background and weight a word has in an HTML document (the sent one): from its ancestors' markup
function markupLook(html, word) {
  const doc = new JSDOM(`<body>${html}</body>`).window.document
  // the word's first character, found in the whole text (a word may be split across nodes)
  const at = doc.body.textContent.indexOf(word)
  if (at < 0) return null
  const w = doc.createTreeWalker(doc.body, 4)
  let n
  let left = at
  while ((n = w.nextNode()) && left >= n.data.length) left -= n.data.length
  if (!n) return null
  let color = null
  let bg = null
  let bold = false
  for (let e = n.parentElement; e && e !== doc.body; e = e.parentElement) {
    if (!color && e.nodeName === 'FONT' && e.getAttribute('color')) color = RGB(e.getAttribute('color'))
    const m = /^background-color: (rgb\(\d+, \d+, \d+\));$/.exec(e.getAttribute('style') || '')
    if (!bg && m) bg = m[1]
    if (/^(B|STRONG)$/.test(e.nodeName)) bold = true
  }
  return { color, bg, bold }
}

try {
  const page = await app.firstWindow()
  watch(page, 'main')
  await page.setViewportSize({ width: 1280, height: 900 })
  await useTheme(app, page)
  if (e2eTheme) console.log(`THEME ${await page.evaluate(() => document.documentElement.dataset.theme)}`)
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  await page.locator('.msg-row', { hasText: SUBJECT }).waitFor({ timeout: 20_000 })

  const ready = async win => {
    watch(win)
    await win.setViewportSize({ width: 900, height: 700 })
    await win.waitForFunction(() => document.querySelector('#compose-from')?.textContent.includes('@') && document.querySelector('.editor')?.textContent.includes('Elek'))
    // the page's helpers: text offsets across nodes (a start point at a node boundary goes forward)
    await win.evaluate(() => {
      const ed = () => document.querySelector('.editor')
      const pointAt = (n, forward) => {
        const w = document.createTreeWalker(ed(), NodeFilter.SHOW_TEXT)
        let t
        let left = n
        let last = null
        while ((t = w.nextNode())) {
          if (forward ? left < t.data.length : left <= t.data.length) return [t, left]
          left -= t.data.length
          last = t
        }
        return [last, last.data.length]
      }
      window.__t = {
        select(from, to) {
          const text = ed().textContent
          const a = text.indexOf(from)
          const b = text.indexOf(to, a) + to.length
          ed().focus()
          const [x, xo] = pointAt(a, true)
          const [y, yo] = pointAt(b, false)
          const r = document.createRange()
          r.setStart(x, xo)
          r.setEnd(y, yo)
          getSelection().removeAllRanges()
          getSelection().addRange(r)
        },
        caretAfter(word) {
          const text = ed().textContent
          const [x, xo] = pointAt(text.indexOf(word) + word.length, false)
          ed().focus()
          const r = document.createRange()
          r.setStart(x, xo)
          r.collapse(true)
          getSelection().removeAllRanges()
          getSelection().addRange(r)
        },
        look(word) {
          const text = ed().textContent
          const [n] = pointAt(text.indexOf(word) + 1, false)
          const el = n.parentElement
          const cs = getComputedStyle(el)
          let bg = 'none'
          for (let e = el; e && e !== ed(); e = e.parentElement) {
            const b = getComputedStyle(e).backgroundColor
            if (b !== 'rgba(0, 0, 0, 0)') {
              bg = b
              break
            }
          }
          let underline = false
          for (let e = el; e && e !== ed(); e = e.parentElement) if (/underline/.test(getComputedStyle(e).textDecorationLine)) underline = true
          return { color: cs.color, bg, bold: Number(cs.fontWeight) >= 600, italic: cs.fontStyle === 'italic', underline }
        },
        same(a, b) {
          const x = document.createElement('template')
          x.innerHTML = a
          const y = document.createElement('template')
          y.innerHTML = b
          return x.content.isEqualNode(y.content)
        },
      }
    })
    return win
  }
  const newComposer = async () => ready((await Promise.all([app.waitForEvent('window', { timeout: 15_000 }), page.locator('.compose-button').click()]))[0])
  const setBody = (win, html) => win.locator('.editor').evaluate((el, h) => {
    el.innerHTML = h
    el.focus()
  }, html)
  const body = win => win.locator('.editor').evaluate(el => el.innerHTML)
  const select = (win, from, to = from) => win.evaluate(([a, b]) => window.__t.select(a, b), [from, to])
  const look = (win, word) => win.evaluate(w => window.__t.look(w), word)
  const tool = (win, kind) => win.locator(`.editor-toolbar button[aria-label="${t.composeTools[kind]}"]`)
  const ITEM = {
    red: t.composeColors.text.red, blue: t.composeColors.text.blue, auto: t.composeColors.auto,
    yellow: t.composeColors.highlight.yellow, green: t.composeColors.highlight.green, none: t.composeColors.noHighlight,
  }
  const KIND = { red: 'textColor', blue: 'textColor', auto: 'textColor', yellow: 'highlight', green: 'highlight', none: 'highlight' }
  // a colour chosen with the mouse: the bar's button, the menu's item
  const choose = async (win, item) => {
    await tool(win, KIND[item]).click()
    await win.locator('.color-menu').getByRole('menuitem', { name: ITEM[item], exact: true }).click()
    await win.waitForTimeout(40)
  }
  const sendAndRead = async win => {
    await win.locator('#compose-to').fill('Címzett <cimzett@example.invalid>')
    await win.locator('#compose-subject').fill('Színek')
    const before = received.length
    const closed = win.waitForEvent('close', { timeout: 30_000 })
    await win.getByRole('button', { name: t.composeSend, exact: true }).click({ noWaitAfter: true }).catch(e => {
      if (!win.isClosed()) throw e
    })
    await closed
    for (let i = 0; i < 50 && received.length === before; i++) await new Promise(r => setTimeout(r, 200))
    return received.length > before ? (await simpleParser(received[received.length - 1])).html || '' : ''
  }
  const close = async win => {
    if (win.isClosed()) return
    await win.close().catch(() => {})
  }

  // 1. a word -> Red; Ctrl+Z; Red again, then Yellow on the same (still selected) word; sent
  {
    const win = await newComposer()
    await setBody(win, '<p>Egy fontos szó itt.</p>')
    await select(win, 'fontos')
    const before = csp()
    await choose(win, 'red')
    const a = await look(win, 'fontos')
    const sel1 = await win.evaluate(() => getSelection().toString())
    check('1a Red on a selected word: the computed colour, the selection kept', a.color === RGB(RED) && sel1 === 'fontos', `${a.color} "${sel1}"`)
    await win.keyboard.press('Control+Z')
    const z = await look(win, 'fontos')
    const plain = await look(win, 'Egy')
    check('1b one Ctrl+Z: the word without colour again', z.color === plain.color, `${z.color} / ${plain.color}`)
    await select(win, 'fontos')
    await choose(win, 'red')
    await choose(win, 'yellow')
    const b = await look(win, 'fontos')
    check('1c then Yellow on the still selected word: both shown', b.color === RGB(RED) && b.bg === RGB(YELLOW.hex), JSON.stringify(b))
    const out = await sendAndRead(win)
    const m = markupLook(out, 'fontos')
    check('1d sent: <font color> and the exact highlight style', /<font [^>]*color="#c62828"/.test(out) && out.includes(YELLOW.style) && m.color === RGB(RED) && m.bg === RGB(YELLOW.hex), out.replace(/\s+/g, ' ').slice(0, 300))
    check('1e no CSP line while colouring', csp() === before, `+${csp() - before}`)
  }

  // 2. combinations in one window, then sent: highlight -> colour, recolour, a partly overlapping selection, with bold
  {
    const win = await newComposer()
    await setBody(win, '<p>alfa béta gamma delta epszilon</p>')
    const before = csp()
    await select(win, 'alfa')
    await choose(win, 'green')
    await choose(win, 'blue')
    await select(win, 'béta')
    await choose(win, 'red')
    await choose(win, 'blue')
    await select(win, 'gamma')
    await win.keyboard.press('Control+B')
    await choose(win, 'red')
    await choose(win, 'yellow')
    await select(win, 'mma', 'del')
    await choose(win, 'green')
    const L = {}
    for (const w of ['alfa', 'béta', 'gam', 'mma', 'delta']) L[w] = await look(win, w)
    const shown = L.alfa.color === RGB(BLUE) && L.alfa.bg === RGB(GREEN.hex) && L['béta'].color === RGB(BLUE) && L['béta'].bg === 'none' &&
      L.gam.color === RGB(RED) && L.gam.bg === RGB(YELLOW.hex) && L.gam.bold && L.mma.bg === RGB(GREEN.hex) && L.mma.color === RGB(RED) && L.delta.bg === RGB(GREEN.hex)
    check('2a highlight -> colour, recolour, bold + colour + highlight, a partly overlapping highlight: all shown', shown, JSON.stringify(L))
    const out = await sendAndRead(win)
    const M = {}
    for (const w of ['alfa', 'béta', 'gam', 'delta']) M[w] = markupLook(out, w)
    check('2b sent: the same colours, highlights and bold', M.alfa.color === RGB(BLUE) && M.alfa.bg === RGB(GREEN.hex) && M['béta'].color === RGB(BLUE) && !M['béta'].bg && M.gam.color === RGB(RED) && M.gam.bold && M.delta.bg === RGB(GREEN.hex), JSON.stringify(M))
    check('2c no CSP line', csp() === before, `+${csp() - before}`)
  }

  // 3. the nested structures (the planner's measurement cases) at a paragraph's start, middle and end, in a list item
  // and a quote: Blue, Automatic, Yellow, No highlight; the editor shows what goes out, one Ctrl+Z back, no CSP line
  {
    const win = await newComposer()
    const wrap = { p: x => `<p>${x}</p><p>után</p>`, li: x => `<ul><li>${x}</li><li>után</li></ul>`, bq: x => `<blockquote><p>${x}</p><p>után</p></blockquote>` }
    const content = {
      'font>b': (a, b) => `${a}<font color="${RED}"><b>SZÓ</b></font>${b}`,
      'font+highlight>b': (a, b) => `${a}<font color="${RED}" style="${YELLOW.style}"><b>SZÓ</b></font>${b}`,
      'highlight>font': (a, b) => `${a}<span style="${YELLOW.style}"><font color="${RED}">SZÓ</font></span>${b}`,
      'word part': (a, b) => `${a}<font color="${RED}"><b>xxSZÓyy</b></font>${b}`,
      // a whole link or code element: the highlight goes onto the a / code itself (a link's own colour wins over a text
      // colour, in the editor as at the recipient: only the highlight is measured on it)
      'whole link': (a, b) => `${a}<a href="https://example.invalid/">SZÓ</a>${b}`,
      'whole code': (a, b) => `${a}<code>SZÓ</code>${b}`,
    }
    const pos = { start: ['', ' b'], mid: ['a ', ' b'], end: ['a ', ''] }
    let bad = []
    let n = 0
    const before = csp()
    for (const [cx, w] of Object.entries(wrap)) for (const [cn, c] of Object.entries(content)) for (const [pn, [pre, post]] of Object.entries(pos)) for (const op of cn === 'whole link' ? ['yellow', 'none'] : ['blue', 'auto', 'yellow', 'none']) {
      const html = w(c(pre, post))
      await setBody(win, html)
      await select(win, 'SZÓ')
      const start = await body(win)
      const c0 = csp()
      await choose(win, op)
      const ed = await look(win, 'SZÓ')
      const out = markupLook(outgoing(await body(win)), 'SZÓ')
      const plain = (await look(win, 'után')).color
      const wantColor = op === 'blue' ? RGB(BLUE) : op === 'auto' ? plain : null
      const colorOk = wantColor ? ed.color === wantColor : true
      const bgOk = op === 'yellow' ? ed.bg === RGB(YELLOW.hex) : op === 'none' ? ed.bg === 'none' : true
      // the editor = what goes out: the colour (null = none: the text's own) and the highlight
      const sameOut = (cn === 'whole link' || (out.color || plain) === ed.color) && (out.bg || 'none') === ed.bg && out.bold === ed.bold
      await win.keyboard.press('Control+Z')
      const back = await win.evaluate(s => window.__t.same(document.querySelector('.editor').innerHTML, s), start)
      n++
      if (!(colorOk && bgOk && sameOut && back && csp() === c0)) bad.push(`${cx}/${cn}/${pn}/${op}: ed ${JSON.stringify(ed)} out ${JSON.stringify(out)} back ${back} csp+${csp() - c0}`)
    }
    check(`3 nested structures, ${n} cases: the colour and highlight asked, the editor = what goes out, one Ctrl+Z back, no CSP line`, bad.length === 0 && csp() === before, bad.slice(0, 3).join(' || '))
    // the commands' own nesting: colour, highlight, bold, then Blue and Automatic
    await setBody(win, '<p>a SZÓ b</p><p>után</p>')
    await select(win, 'SZÓ')
    await choose(win, 'red')
    await choose(win, 'yellow')
    await win.keyboard.press('Control+B')
    await choose(win, 'blue')
    const x = await look(win, 'SZÓ')
    const xo = markupLook(outgoing(await body(win)), 'SZÓ')
    await choose(win, 'auto')
    const y = await look(win, 'SZÓ')
    const yo = markupLook(outgoing(await body(win)), 'SZÓ')
    check('3b colour, highlight, bold by the commands, then Blue and Automatic: shown and sent alike, bold kept', x.color === RGB(BLUE) && xo.color === RGB(BLUE) && xo.bg === RGB(YELLOW.hex) && x.bold && xo.bold && !yo.color && yo.bg === RGB(YELLOW.hex) && y.bg === RGB(YELLOW.hex) && csp() === before, JSON.stringify({ x, xo, y, yo }))
    await close(win)
  }

  // 4. bold, italic, underline on and off over a colour and without one: the format really goes, no CSP line
  {
    const win = await newComposer()
    const before = csp()
    const runs = [
      ['colour, bold, bold off', ['red', 'Control+B', 'Control+B'], l => l.color === RGB(RED) && !l.bold],
      ['bold, colour, bold off', ['Control+B', 'red', 'Control+B'], l => l.color === RGB(RED) && !l.bold],
      ['italic, underline, italic off (no colour)', ['Control+I', 'Control+U', 'Control+I'], l => !l.italic && l.underline],
      ['bold, italic, bold off (no colour)', ['Control+B', 'Control+I', 'Control+B'], l => !l.bold && l.italic],
    ]
    const bad = []
    for (const [name, steps, want] of runs) {
      await setBody(win, '<p>a SZÓ b</p>')
      await select(win, 'SZÓ')
      for (const s of steps) {
        if (s.startsWith('Control')) await win.keyboard.press(s)
        else await choose(win, s)
      }
      const l = await look(win, 'SZÓ')
      const out = outgoing(await body(win))
      const o = markupLook(out, 'SZÓ')
      if (!(want(l) && o.bold === l.bold && !/style="(?!background-color)/.test(out))) bad.push(`${name}: ${JSON.stringify(l)} ${out}`)
    }
    check('4 bold / italic / underline on and off, with and without a colour: the format goes, the sent the same, no CSP line', bad.length === 0 && csp() === before, bad.join(' || '))
    await close(win)
  }

  // 5. two paragraphs, two list items, a quote's two paragraphs: Blue and Automatic; the blocks stay, one Ctrl+Z back
  {
    const win = await newComposer()
    const before = csp()
    const bad = []
    for (const html of [`<p>a <font color="${RED}"><b>xxONE</b></font></p><p><font color="${RED}"><b>TWOyy</b></font> b</p>`, '<ul><li>a ONE</li><li><b>TWO</b> c</li></ul>', '<blockquote><p>a ONE</p><p>TWO b</p></blockquote>']) {
      for (const op of ['blue', 'auto', 'yellow']) {
        await setBody(win, html)
        const blocks = await win.locator('.editor').evaluate(el => el.querySelectorAll('p,li').length)
        await select(win, 'ONE', 'TWO')
        const start = await body(win)
        await choose(win, op)
        const one = await look(win, 'ONE')
        const two = await look(win, 'TWO')
        const after = await win.locator('.editor').evaluate(el => el.querySelectorAll('p,li').length)
        const plain = (await look(win, 'ONE')).color
        const want = l => (op === 'blue' ? l.color === RGB(BLUE) : op === 'yellow' ? l.bg === RGB(YELLOW.hex) : l.color !== RGB(RED) && l.color !== RGB(BLUE))
        const o1 = markupLook(outgoing(await body(win)), 'ONE')
        await win.keyboard.press('Control+Z')
        const back = await win.evaluate(s => window.__t.same(document.querySelector('.editor').innerHTML, s), start)
        if (!(want(one) && want(two) && blocks === after && back && (o1.color || plain) === one.color)) bad.push(`${html.slice(0, 30)} ${op}: ${JSON.stringify({ one, two, blocks, after, back, o1 })}`)
      }
    }
    check('5 across two paragraphs / list items / quote paragraphs: both coloured, the blocks unchanged, one Ctrl+Z back, no CSP line', bad.length === 0 && csp() === before, bad.slice(0, 2).join(' || '))
    await close(win)
  }

  // 6. the keyboard only: Alt+F10, the arrows, Enter, the arrows, Enter; Esc changes nothing
  {
    const win = await newComposer()
    await setBody(win, '<p>Egy fontos szó itt.</p>')
    await select(win, 'fontos')
    await win.keyboard.press('Alt+F10')
    for (let i = 0; i < 3; i++) await win.keyboard.press('ArrowRight')
    const onTool = await win.evaluate(() => document.activeElement.getAttribute('aria-label'))
    await win.keyboard.press('Enter')
    await win.keyboard.press('ArrowDown')
    await win.keyboard.press('Enter')
    await win.waitForTimeout(40)
    const l = await look(win, 'fontos')
    const state = await win.evaluate(() => ({ focus: document.activeElement === document.querySelector('.editor'), sel: getSelection().toString() }))
    check('6a Alt+F10, arrows, Enter, Down, Enter: the selection red, the focus in the text, the selection kept', onTool === t.composeTools.textColor && l.color === RGB(RED) && state.focus && state.sel === 'fontos', `${onTool} ${l.color} ${JSON.stringify(state)}`)
    const start = await body(win)
    await win.keyboard.press('Alt+F10')
    await win.keyboard.press('ArrowRight')
    await win.keyboard.press('Enter')
    const open = await win.locator('.color-menu').count()
    await win.keyboard.press('Escape')
    const after = await win.evaluate(() => ({ focus: document.activeElement === document.querySelector('.editor'), sel: getSelection().toString(), menu: document.querySelectorAll('.color-menu').length }))
    check('6b the Highlight menu opened with Enter, Esc: closed, nothing changed, back in the text with the selection', open === 1 && after.menu === 0 && after.focus && after.sel === 'fontos' && (await body(win)) === start, JSON.stringify(after))
    await close(win)
  }

  // 7. at the caret: the colour goes to the text typed next, not the text before
  {
    const win = await newComposer()
    await setBody(win, '<p>előtte </p>')
    await win.evaluate(() => window.__t.caretAfter('előtte '))
    await choose(win, 'red')
    await win.keyboard.type('utána')
    const a = await look(win, 'előtte')
    const b = await look(win, 'utána')
    check('7 a colour at the caret: the typed text red, the text before not', b.color === RGB(RED) && a.color !== RGB(RED), `${a.color} / ${b.color}`)
    await close(win)
  }

  // 8. the text emptied by Ctrl+A + Delete: the next typed text inherits no colour or highlight; one chosen after it does
  {
    const win = await newComposer()
    await setBody(win, `<p><font color="${RED}"><span style="${YELLOW.style}">színes kiemelt</span></font></p>`)
    await win.locator('.editor').click()
    await win.keyboard.press('Control+A')
    await win.keyboard.press('Delete')
    await win.keyboard.type('új')
    const a = await look(win, 'új')
    const plain = await win.locator('.editor').evaluate(el => getComputedStyle(el).color)
    check('8a Ctrl+A + Delete on a coloured text, then typing: no colour, no highlight', a.color === plain && a.bg === 'none', JSON.stringify(a))
    await setBody(win, `<p><font color="${RED}">színes</font></p>`)
    await win.locator('.editor').click()
    await win.keyboard.press('Control+A')
    await win.keyboard.press('Delete')
    await choose(win, 'blue')
    await win.keyboard.type('kék')
    const b = await look(win, 'kék')
    check('8b the same with Blue chosen after the emptying: the typed text blue', b.color === RGB(BLUE), JSON.stringify(b))
    await close(win)
  }

  // 9. the window's own copy, cut and paste keep the colours (a paragraph's start and end, a list item); a foreign
  // paste and a faked mark do not
  {
    const win = await newComposer()
    await setBody(win, `<p>a <font color="${RED}">piros</font> és <span style="${YELLOW.style}">sárga</span> vége</p><p>CÉL1 közép CÉL2</p><ul><li>CÉL3</li></ul>`)
    const before = csp()
    // a copy event of this window: the clipboard's types and HTML as the page gives them
    const copy = (from, to, type = 'copy') => win.evaluate(([a, b, ty]) => {
      window.__t.select(a, b)
      const dt = new DataTransfer()
      const e = new ClipboardEvent(ty, { clipboardData: dt, bubbles: true, cancelable: true })
      document.querySelector('.editor').dispatchEvent(e)
      return { types: [...dt.types], html: dt.getData('text/html'), text: dt.getData('text/plain'), mark: dt.getData('application/x-shadowmail-compose') }
    }, [from, to, type])
    const paste = (data, where, how) => win.evaluate(([d, w, h]) => {
      if (h === 'before') {
        window.__t.select(w, w)
        getSelection().collapseToStart()
      } else window.__t.caretAfter(w)
      const dt = new DataTransfer()
      for (const [k, v] of Object.entries(d)) dt.setData(k, v)
      document.querySelector('.editor').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    }, [data, where, how])
    const c = await copy('piros', 'sárga')
    check('9a copy: the own HTML with the palette colours, the plain text, the window\'s mark (a target without the mark gets meaningful HTML)', c.html.includes(`<font color="${RED}">piros</font>`) && c.html.includes(YELLOW.style) && c.text === 'piros és sárga' && /^[0-9a-f-]{36}$/.test(c.mark), JSON.stringify(c))
    const part = await copy('iro', 'iro')
    check('9b copy of a piece of one coloured word: still coloured', part.html === `<font color="${RED}">iro</font>`, part.html)
    const data = { 'text/html': c.html, 'text/plain': c.text, 'application/x-shadowmail-compose': c.mark }
    const bad = []
    for (const [w, how] of [['CÉL1', 'before'], ['CÉL2', 'after'], ['CÉL3', 'after']]) {
      const start = await body(win)
      await paste(data, w, how)
      const html = await body(win)
      const pasted = (await win.locator('.editor').evaluate(el => [...el.querySelectorAll('font, span')].length))
      const l = await win.evaluate(target => {
        const ed = document.querySelector('.editor')
        const all = [...ed.querySelectorAll('font[color]')]
        const fonts = all.filter(f => f.textContent === 'piros' && f.closest('p,li') !== ed.querySelector('p'))
        const spans = [...ed.querySelectorAll('[style]')].filter(s => s.textContent === 'sárga' && s.closest('p,li') !== ed.querySelector('p'))
        return { font: fonts.length ? getComputedStyle(fonts[0]).color : null, span: spans.length ? getComputedStyle(spans[0]).backgroundColor : null, target }
      }, w)
      await win.keyboard.press('Control+Z')
      const back = await win.evaluate(s => window.__t.same(document.querySelector('.editor').innerHTML, s), start)
      if (!(l.font === RGB(RED) && l.span === RGB(YELLOW.hex) && back)) bad.push(`${w} ${how}: ${JSON.stringify(l)} back ${back} ${html.slice(0, 200)} (${pasted})`)
    }
    check('9c own paste at a paragraph\'s start and end and in a list item: the colour and highlight kept, one Ctrl+Z back', bad.length === 0, bad.join(' || '))
    // cut: the selection goes (one Ctrl+Z back), the pasted copy is coloured
    const start = await body(win)
    const x = await copy('piros', 'piros', 'cut')
    const gone = !(await body(win)).includes('piros')
    await win.keyboard.press('Control+Z')
    const back = await win.evaluate(s => window.__t.same(document.querySelector('.editor').innerHTML, s), start)
    check('9d cut: the selection deleted (one Ctrl+Z back), its HTML coloured with the mark', gone && back && x.html === `<font color="${RED}">piros</font>` && x.mark === c.mark, JSON.stringify({ gone, back, x }))
    // foreign: a palette colour without the mark, or with another mark
    for (const [name, d] of [['no mark', { 'text/html': `<font color="${RED}">IDEGEN</font>` }], ['another mark', { 'text/html': `<font color="${RED}">HAMIS</font>`, 'application/x-shadowmail-compose': '00000000-0000-4000-8000-000000000000' }]]) {
      await paste(d, 'CÉL3', 'after')
      const word = name === 'no mark' ? 'IDEGEN' : 'HAMIS'
      const l = await look(win, word)
      const plain = (await look(win, 'CÉL3')).color
      check(`9e a paste with ${name}: the palette colour does not stay`, l.color === plain && !(await body(win)).includes(`<font color="${RED}">${word}`), JSON.stringify(l))
    }
    check('9f no CSP line while copying and pasting', csp() === before, `+${csp() - before}`)
    // the real keys too, where this headless window has a clipboard (it may not: then only said)
    await setBody(win, `<p>X <font color="${RED}">kulcs</font> Y</p><p>Z</p>`)
    await select(win, 'kulcs')
    await win.keyboard.press('Control+C')
    await win.evaluate(() => window.__t.caretAfter('Z'))
    await win.keyboard.press('Control+V')
    const keys = await win.locator('.editor').evaluate(el => [...el.querySelectorAll('font')].filter(f => f.textContent === 'kulcs').length)
    console.log(`INFO real Ctrl+C / Ctrl+V in this headless window: ${keys === 2 ? 'the copy is coloured' : `${keys} coloured copies (no clipboard here?)`}`)
    await close(win)
  }

  // 10. a saved draft opened again: the colours shown and sent
  {
    const win = await newComposer()
    await setBody(win, '<p>Mentett piros és kiemelt szöveg.</p>')
    await select(win, 'piros')
    await choose(win, 'red')
    await select(win, 'kiemelt')
    await choose(win, 'yellow')
    await win.locator('#compose-to').fill('Címzett <cimzett@example.invalid>')
    await win.locator('#compose-subject').fill('Színes piszkozat')
    await win.getByRole('button', { name: t.composeSaveDraft, exact: true }).click()
    await win.locator('.hint[role="status"]').filter({ hasText: savedHint }).waitFor({ timeout: 15_000 })
    const closed = win.waitForEvent('close', { timeout: 15_000 })
    await win.getByRole('button', { name: t.composeCloseWindow, exact: true }).click({ noWaitAfter: true }).catch(() => {})
    await closed
    const pane = page.locator('.folder-tree section', { hasText: 'POP3-fiók' })
    await pane.locator('.folder[data-path="Drafts"]').click()
    const readerFrom = consoleLines.length
    await page.locator('.msg-row', { hasText: 'Színes piszkozat' }).click()
    await page.locator('.reader-tools .reader-edit-draft').waitFor({ timeout: 10_000 })
    await page.waitForTimeout(300)
    // the reader's own known lines: only the main window's, only CSP, only in this step
    for (const l of consoleLines.splice(readerFrom)) {
      if (/^main error: Applying inline style violates/.test(l)) known.push(l)
      else consoleLines.push(l)
    }
    console.log(`KNOWN the reader's sanitizer on the main page: ${known.length} CSP line(s) for the draft's style attributes`)
    const [again] = await Promise.all([app.waitForEvent('window', { timeout: 15_000 }), page.locator('.reader-tools .reader-edit-draft').click()])
    watch(again)
    await again.setViewportSize({ width: 900, height: 700 })
    await again.waitForFunction(() => document.querySelector('.editor')?.textContent.includes('Mentett'))
    const shown = await again.locator('.editor').evaluate(el => ({ red: [...el.querySelectorAll('font')].some(f => f.textContent === 'piros' && getComputedStyle(f).color === 'rgb(198, 40, 40)'), yellow: [...el.querySelectorAll('[style]')].some(s => s.textContent === 'kiemelt' && getComputedStyle(s).backgroundColor === 'rgb(255, 245, 157)') }))
    const before = received.length
    const closing = again.waitForEvent('close', { timeout: 30_000 })
    await again.getByRole('button', { name: t.composeSend, exact: true }).click({ noWaitAfter: true }).catch(() => {})
    await closing
    for (let i = 0; i < 50 && received.length === before; i++) await new Promise(r => setTimeout(r, 200))
    const out = received.length > before ? (await simpleParser(received[received.length - 1])).html || '' : ''
    check('10 a saved draft opened again: the colours shown, and sent', shown.red && shown.yellow && markupLook(out, 'piros')?.color === RGB(RED) && markupLook(out, 'kiemelt')?.bg === RGB(YELLOW.hex), `${JSON.stringify(shown)} ${out.replace(/\s+/g, ' ').slice(0, 200)}`)
  }

  // 11. the writing surface is light under every theme; the bar and the menus follow the theme
  {
    const win = await newComposer()
    const s = await win.evaluate(() => {
      const ed = document.querySelector('.editor')
      const root = getComputedStyle(document.documentElement)
      return { theme: document.documentElement.dataset.theme, bg: getComputedStyle(ed).backgroundColor, color: getComputedStyle(ed).color, menuBg: root.getPropertyValue('--c-bg').trim() }
    })
    await tool(win, 'textColor').click()
    const menu = await win.locator('.color-menu').evaluate(el => getComputedStyle(el).backgroundColor)
    await win.keyboard.press('Escape')
    const tokenRgb = await win.evaluate(v => {
      const d = document.createElement('div')
      d.style.color = v
      document.body.append(d)
      const c = getComputedStyle(d).color
      d.remove()
      return c
    }, s.menuBg)
    check(`11 the writing surface light (${s.theme}): white page, dark text; the menu on the theme's own background`, s.bg === 'rgb(255, 255, 255)' && s.color === 'rgb(31, 31, 31)' && menu === tokenRgb, JSON.stringify({ ...s, menu }))
    await close(win)
  }
} finally {
  await app.close().catch(() => {})
  smtp.close()
  await pop.close?.()
}
const mainLog = fs.readFileSync(path.join(dataDir, 'electron', 'logs', 'main.log'), 'utf8')
check('the main log: no error or failure line', !/failed|error/i.test(mainLog), mainLog.trim().split('\n').filter(l => /failed|error/i.test(l)).join(' | '))
check('no renderer console error or warning, no page exception', consoleLines.length === 0 && pageErrors.length === 0, [...consoleLines, ...pageErrors].slice(0, 3).join(' | '))
fs.rmSync(work, { recursive: true, force: true })
console.log(`\n${results.filter(Boolean).length} / ${results.length} OK`)
process.exit(results.every(Boolean) ? 0 : 1)
