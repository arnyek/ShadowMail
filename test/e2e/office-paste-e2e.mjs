#!/usr/bin/env node
// A paste from Word and Excel in the real composer (headless Electron + Playwright). Not part of `npm test`.
//
//   node test/e2e/office-paste-e2e.mjs          (E2E_LANG=en: the same in English; E2E_THEME=dark: the dark theme)
//
// Headless ozone has no clipboard Word or Excel could have written: the paste is a synthetic ClipboardEvent with the
// synthetic samples' text/html (test/fixtures/paste/, written after the known clipboard formats). One POP3 account, one
// local SMTP server.
// (a) Word: the heading with the sheet's colour, the red / highlighted / bold / Times words, a two-level bullet list (ul in
//     a li), a numbered list (ol), the grid table with its coloured cell; no marker, no Word markup, no local image in the
//     editor; sent: the same lists and table in the HTML part, the items a line each in the text part.
// (b) Excel: the cells' borders, the fill, the bold header in the editor and sent.
// (c) a real Excel clipboard (test/fixtures/paste/excel-windows.html, with the picture of the cells beside it): the HTML goes
//     in, not the picture; every cell's computed sides and alignment as Excel draws them, in the editor and sent; the text
//     part a line per row.
// The composer's console has no error or warning (no CSP line), the main log no error line.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { SMTPServer } from 'smtp-server'
import { simpleParser } from 'mailparser'
import { FakePop3Server } from '../helpers/fake-pop3.js'
import { createVaultedDatabase } from '../../core/vault/vaulted-db.js'
import { AccountStore } from '../../core/accounts/model.js'
import { newAccountDefaults } from '../../core/accounts/defaults.js'
import { t, seedLanguage } from './lang.mjs'
import { useTheme } from './theme-env.mjs'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const MASTER = 'Teszt-mesterjelszo-office'
const ME = 'teszt@example.invalid'
const SUBJECT = 'Office próba'
const fixture = name => fs.readFileSync(path.join(repo, 'test', 'fixtures', 'paste', name), 'utf8')

const watchdog = setTimeout(() => {
  console.log('FAIL watchdog: the run took more than 4 minutes')
  process.exit(1)
}, 240_000)
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
  'From: Kovács Anna <anna@example.invalid>', `To: Teszt Elek <${ME}>`, 'Subject: =?utf-8?q?Office_pr=C3=B3ba?=',
  `Date: ${new Date().toUTCString()}`, 'Message-ID: <office-1@example.invalid>', 'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit', '', 'Szöveg.', '',
].join('\r\n')))
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-office-paste-e2e-'))
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
const app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
const watch = w => {
  w.on('console', m => (m.type() === 'error' || m.type() === 'warning') && consoleLines.push(`composer ${m.type()}: ${m.text()}`))
  w.on('pageerror', e => consoleLines.push(`composer exception: ${e}`))
}
// the list / table shape of an HTML: tags only, no attributes, no white space
const shapeOf = html => html.replace(/<(\/?)([a-z0-9]+)[^>]*>/gi, '<$1$2>').replace(/>\s+</g, '><').replace(/\s+/g, ' ')

try {
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1280, height: 900 })
  await useTheme(app, page)
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  await page.locator('.msg-row', { hasText: SUBJECT }).waitFor({ timeout: 20_000 })
  const newComposer = async () => {
    const [win] = await Promise.all([app.waitForEvent('window', { timeout: 15_000 }), page.locator('.compose-button').click()])
    watch(win)
    await win.setViewportSize({ width: 1000, height: 760 })
    await win.waitForFunction(() => document.querySelector('#compose-from')?.textContent.includes('@') && document.querySelector('.editor')?.textContent.includes('Elek'))
    return win
  }
  // the caret at the start of the text, then a paste of the given text/html (and its text/plain; with `png`, an image.png
  // file beside them, as Excel puts a picture of the cells on the clipboard)
  const paste = (win, html, text, png = null) =>
    win.evaluate(({ html, text, png }) => {
      const el = document.querySelector('.editor')
      el.focus()
      const r = document.createRange()
      r.setStart(el, 0)
      r.collapse(true)
      getSelection().removeAllRanges()
      getSelection().addRange(r)
      const dt = new DataTransfer()
      dt.setData('text/html', html)
      dt.setData('text/plain', text)
      if (png) dt.items.add(new File([Uint8Array.from(atob(png), c => c.charCodeAt(0))], 'image.png', { type: 'image/png' }))
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    }, { html, text, png })
  // the cells' computed borders (and alignment) of a table, as a browser draws them: in a composer window (its CSP lets a
  // style attribute through), in a detached box outside the editor; the borders as "style color" per side
  // (an element, or an HTML text put in a box for the measuring)
  const BORDERS = at => {
    const box = typeof at === 'string' ? document.body.appendChild(document.createElement('div')) : null
    if (box) box.innerHTML = at
    const out = [...(box || at).querySelectorAll('td')].map(td => {
      const s = getComputedStyle(td)
      const side = n => (s[`border${n}Style`] === 'none' ? 'none' : `${s[`border${n}Style`]} ${s[`border${n}Color`]}`)
      return { text: td.textContent.trim(), top: side('Top'), right: side('Right'), bottom: side('Bottom'), left: side('Left'), align: s.textAlign }
    })
    box?.remove()
    return out
  }
  const sendAndRead = async win => {
    await win.locator('#compose-to').fill('Címzett <cimzett@example.invalid>')
    await win.locator('#compose-subject').fill('Office')
    const before = received.length
    const closed = win.waitForEvent('close', { timeout: 30_000 })
    await win.getByRole('button', { name: t.composeSend, exact: true }).click({ noWaitAfter: true }).catch(e => {
      if (!win.isClosed()) throw e
    })
    await closed
    for (let i = 0; i < 50 && received.length === before; i++) await new Promise(r => setTimeout(r, 200))
    return received.length > before ? simpleParser(received[received.length - 1]) : null
  }

  // (a) Word
  {
    const win = await newComposer()
    await paste(win, fixture('word-synthetic.html'), 'Címsor egy\nEz egy piros szó')
    await win.waitForFunction(() => document.querySelector('.editor').textContent.includes('Kettő'))
    const v = await win.locator('.editor').evaluate(el => {
      const cs = e => (e ? getComputedStyle(e) : null)
      const h1 = el.querySelector('h1')
      const td = el.querySelector('td')
      return {
        html: el.innerHTML,
        text: el.innerText,
        h1Color: cs(h1)?.color,
        h1Font: cs(h1)?.fontFamily,
        nested: Boolean(el.querySelector('ul > li > ul > li')),
        ulItems: [...el.querySelectorAll('ul > li')].map(li => li.firstChild?.textContent.trim()),
        olItems: [...el.querySelectorAll('ol > li')].map(li => li.textContent.trim()),
        tdBg: cs(td)?.backgroundColor,
        tdBorder: td ? `${cs(td).borderTopWidth} ${cs(td).borderTopStyle}` : null,
        liMarginLeft: [...el.querySelectorAll('li')].map(li => li.style.marginLeft || li.style.textIndent).filter(Boolean),
      }
    })
    check('Word: the heading with the sheet\'s colour and font', v.h1Color === 'rgb(47, 84, 150)' && /calibri light/i.test(v.h1Font), `${v.h1Color} ${v.h1Font}`)
    check('Word: a two-level bullet list (ul in a li), its items', v.nested && v.ulItems.includes('Első pont') && v.ulItems.includes('Alsó szint'), JSON.stringify(v.ulItems))
    check('Word: a numbered list', JSON.stringify(v.olItems) === '["Egy","Kettő"]', JSON.stringify(v.olItems))
    check('Word: no marker, no indent on the items', !/[·§]/.test(v.text) && !/^o\s/m.test(v.text) && !/1\.\s*Egy/.test(v.text) && v.liMarginLeft.length === 0, JSON.stringify(v.liMarginLeft))
    check('Word: the grid table with its coloured cell', v.tdBg === 'rgb(197, 224, 179)' && /^1(\.\d+)?px solid$/.test(v.tdBorder || ''), `${v.tdBg} ${v.tdBorder}`)
    check('Word: no Word markup, no local image in the editor', !/o:p|mso-|v:shape|file:|<img/i.test(v.html), v.html.slice(0, 200))
    const mail = await sendAndRead(win)
    const shape = shapeOf(mail?.html || '')
    check('Word sent: the lists and the table in the HTML part', shape.includes('<ul><li>Első pont<ul><li>Alsó szint</li></ul></li>') && shape.includes('<ol><li>Egy</li><li>Kettő</li></ol>') && /<table/.test(mail?.html || ''), shape.slice(0, 300))
    check('Word sent: the items a line each in the text part', ['Első pont', 'Alsó szint', 'Egy', 'Kettő'].every(w => new RegExp(`${w}\\s*$`, 'm').test(mail?.text || '')), JSON.stringify((mail?.text || '').slice(0, 300)))
  }

  // (b) Excel
  {
    const win = await newComposer()
    await paste(win, fixture('excel-synthetic.html'), 'Fej1\tFej2\tFej3')
    await win.waitForFunction(() => document.querySelector('.editor').textContent.includes('kitöltve'))
    const v = await win.locator('.editor').evaluate(el => {
      const cell = text => [...el.querySelectorAll('td')].find(td => td.textContent.trim() === text)
      const cs = e => (e ? getComputedStyle(e) : null)
      const head = cell('Fej1')
      const fill = cell('kitöltve')
      return { headWeight: cs(head)?.fontWeight, headBorder: head ? `${cs(head).borderTopStyle} ${cs(head).borderTopColor}` : null, fill: cs(fill)?.backgroundColor }
    })
    check('Excel: the bold header with its border, the filled cell', Number(v.headWeight) >= 700 && /^solid rgb\(0, 0, 0\)$/.test(v.headBorder || '') && v.fill === 'rgb(255, 192, 0)', JSON.stringify(v))
    const mail = await sendAndRead(win)
    const kitoltve = /<td[^>]*>kitöltve<\/td>/.exec(mail?.html || '')?.[0] || ''
    // (the editor may write the border as its longhands: "border-width: medium 0.5pt 0.5pt medium; border-style: none solid ...")
    check('Excel sent: the border and the fill in the HTML part', (/border: 0?\.5pt solid windowtext/.test(kitoltve) || (/border-width: [^;]*0\.5pt/.test(kitoltve) && /border-style: [^;]*solid/.test(kitoltve) && /border-color: [^;]*windowtext/.test(kitoltve))) && /background-color: (#ffc000|rgb\(255, 192, 0\))/i.test(kitoltve), kitoltve)
  }

  // (c) a real Excel clipboard (Windows, Excel 15): its td rule says border: none, its cell classes draw the sides; with the
  // picture of the cells (image.png) beside the HTML, as Excel writes it
  {
    const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const blue = 'solid rgb(180, 198, 231)'
    // what Excel shows: the empty rows (.xl70 / .xl72) right and bottom, the left on the row's first cell only; the number
    // rows (.xl73 / .xl74) right, the left on the first cell, no top (the cell's own) and no bottom (the class's)
    const expected = cells => cells.every((c, i) => {
      const first = i % 6 === 0
      const left = first ? blue : 'none'
      return c.text
        ? c.top === 'none' && c.right === blue && c.bottom === 'none' && c.left === left && c.align === 'right'
        // (an empty cell's left alignment: the editor writes it as the default, start; the same in a left-to-right text)
        : c.top === 'none' && c.right === blue && c.bottom === blue && c.left === left && (c.align === 'left' || c.align === 'start')
    })
    const win = await newComposer()
    await paste(win, fixture('excel-windows.html'), '\t\t\t\t\t\r\n4\t5\t6\t7\t8\t9\r\n', PNG)
    await win.waitForFunction(() => document.querySelector('.editor table')?.textContent.includes('23'), null, { timeout: 10_000 })
    const inEditor = await win.locator('.editor table').evaluate(BORDERS)
    check('real Excel: the HTML went in, not the picture (a table, 42 cells, no image)', inEditor.length === 42 && (await win.locator('.editor img').count()) === 0, `${inEditor.length} cells`)
    check('real Excel: in the editor the blue sides as Excel draws them, the numbers right-aligned', expected(inEditor), JSON.stringify(inEditor.slice(0, 7)))
    const mail = await sendAndRead(win)
    const table = /<table[\s\S]*<\/table>/.exec(mail?.html || '')?.[0] || ''
    const look = await newComposer()
    const sent = await look.evaluate(BORDERS, table)
    check('real Excel sent: the HTML part draws the same sides', sent.length === 42 && expected(sent), JSON.stringify(sent.slice(0, 7)))
    check('real Excel sent: the text part a line per row', /^4\t5\t6\t7\t8\t9\s*$/m.test(mail?.text || '') && /^18\t19\t20\t21\t22\t23\s*$/m.test(mail?.text || ''), JSON.stringify((mail?.text || '').slice(0, 200)))
    const closed = look.waitForEvent('close', { timeout: 15_000 })
    await look.getByRole('button', { name: t.composeCloseWindow, exact: true }).click({ noWaitAfter: true }).catch(() => {})
    await closed
  }
} catch (err) {
  check('the run finished', false, err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : String(err))
} finally {
  await app.close().catch(() => {})
  smtp.close()
  await pop.close?.()
}
const mainLog = fs.readFileSync(path.join(dataDir, 'electron', 'logs', 'main.log'), 'utf8')
check('the main log: no error or failure line', !/failed|error/i.test(mainLog), mainLog.trim().split('\n').filter(l => /failed|error/i.test(l)).join(' | '))
check('no composer console error or warning (no CSP line), no exception', consoleLines.length === 0, consoleLines.slice(0, 3).join(' | '))
fs.rmSync(work, { recursive: true, force: true })
console.log(`\n${results.filter(Boolean).length} / ${results.length} OK`)
process.exit(results.every(Boolean) ? 0 : 1)
