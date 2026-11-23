#!/usr/bin/env node
// Rich paste in the composer, in the real app (headless Electron + Playwright) with a REAL copy and paste: a page in a
// window of the app's own main process is selected and copied (webContents.copy(): headless ozone keeps its own clipboard
// while the window is shown and focused), then pasted into the composer (webContents.paste()). Not part of `npm test`.
//
//   node test/e2e/rich-paste-e2e.mjs        (E2E_LANG=en: in English; E2E_THEME=dark: under the dark theme)
//
// (a) a web page: a table with a border, a header background and a colspan, coloured, highlighted, font-faced and sized
//     text, lists, a heading, sup / sub, a link, an image: the editor shows the grid and the formatting, no image; sent,
//     the HTML part is the editor's own (the rich sanitizer on it, byte for byte), the text part a line per row with TABs;
// (b) hidden text (font-size 0, transparent, opacity 0, sr-only) is on the clipboard (Chromium copies it, MEASURED) but
//     neither in the editor, nor in the HTML part, nor in the text part;
// (b2) eight texts unreadable on the page come readable (3:1, inside the editor) and are sent (the tester's cases)
// (c) a dark page's block comes as a dark island (readable, kept); the same with its background taken off the clipboard
//     by hand: the light text takes the default dark colour, the text is there;
// (d) a 25 000 cell table: lines (no table), the paste under 2 s;
// (e) Ctrl+Shift+V (pasteAndMatchStyle): the text only;
// (f) a piece of a web page dragged onto the text: the same as pasted; nothing of a foreign style stays raw;
// (g) a clipboard too complex: no formatting, the informing line;
// (h) the paste's own 500 ms net: a 1 MB web page copy comes formatted within 1.5 s, a stylesheet-heavy newsletter falls
//     back within 900 ms (the planner's limits for the whole paste), in a new message and in the middle of a paragraph, one Ctrl+Z back (the many-block wrapper).
// No new CSP line on the composer's console (no image load either; the fallback's known line of the old HTML path, a
// <style> on the clipboard, counted apart as KNOWN), no page exception, the main log clean.
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
import { newsletterHtml } from '../helpers/newsletter.js'
import { createVaultedDatabase } from '../../core/vault/vaulted-db.js'
import { AccountStore } from '../../core/accounts/model.js'
import { newAccountDefaults } from '../../core/accounts/defaults.js'
import { sanitizeCompose } from '../../app/renderer/src/sanitize.js'
import { unwrapSignature } from '../../core/smtp/signature.js'
import { t, seedLanguage } from './lang.mjs'
import { useTheme, e2eTheme } from './theme-env.mjs'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const MASTER = 'Teszt-mesterjelszo-beilleszt'
const ME = 'teszt@example.invalid'
const SUBJECT = 'Beillesztés próba'
const purify = createDOMPurify(new JSDOM('').window)
// a 1 x 1 PNG (the page's own image: no network)
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

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
  'From: Kovács Anna <anna@example.invalid>', `To: Teszt Elek <${ME}>`, 'Subject: =?utf-8?q?Beilleszt=C3=A9s_pr=C3=B3ba?=',
  `Date: ${new Date().toUTCString()}`, 'Message-ID: <paste-1@example.invalid>', 'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit', '', 'Az eredeti levél szövege.', '',
].join('\r\n')))

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-rich-paste-e2e-'))
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

// the source pages (what a user copies from)
const WEB = `<div id="all" style="font-family: Georgia, serif; color: rgb(32, 33, 36);">
<h2 style="color: rgb(21, 101, 192); font-size: 22px;">Ajánlat címe</h2>
<p>Sima, <span style="color: rgb(198, 40, 40);">piros</span>, <span style="background-color: rgb(255, 245, 157);">kiemelt</span>,
<span style="font-family: 'Courier New', monospace; font-size: 18px;">nagy betűs</span>, x<sup>2</sup> H<sub>2</sub>O,
<a href="https://example.invalid/ajanlat">link</a> <img src="${PNG}" width="1" height="1" alt="kép"></p>
<table style="border-collapse: collapse; border: 2px solid rgb(0, 128, 0);"><tbody>
<tr><th colspan="2" style="background-color: rgb(238, 238, 238); border: 1px solid rgb(153, 153, 153); text-align: left;">Termék és darab</th></tr>
<tr><td style="border: 1px solid rgb(153, 153, 153); padding: 2px 6px;">Kazán A</td><td style="border: 1px solid rgb(153, 153, 153); text-align: right;">1</td></tr>
<tr><td style="border: 1px solid rgb(153, 153, 153); padding: 2px 6px;">Kazán B</td><td style="border: 1px solid rgb(153, 153, 153); text-align: right;">2</td></tr>
</tbody></table>
<ul><li>első pont</li><li>második pont</li></ul><ol start="3"><li>harmadik</li></ol>
</div>`
// unreadable on the page as Chromium copies it (the tester's eight cases, 1642): each word must come readable (3:1 on what it
// stands on in the editor, its alpha mixed in), inside the editor, not zero wide
const UNREADABLE = `<div id="all"><p>a <span style="background-color: #000000; color: #000000;">FEKETE</span> b</p><p>a <span style="background-color: #111111; color: #222222;">SOTET</span> b</p><table bgcolor="#000000"><tr><td><font color="#000000">CELLA</font></td></tr></table><div style="background-image: linear-gradient(#000000, #000000);"><span style="color: #ffffff;">GRADIENS</span></div><div style="background: url(nincs.png) #000000;"><span style="color: #ffffff;">KEPES</span></div><p style="text-indent: -200px;">BEHUZAS</p><p>a <span style="color: rgba(0, 0, 0, 0.12);">HALVANY</span> b</p><div style="background-color: #000000;"><div style="background-color: transparent;"><span style="color: #000000;">ATLATSZO</span></div></div><p>a <span style="font-size: 3px; letter-spacing: -5px;">SZOROS</span> b</p></div>`
const UNREADABLE_WORDS = ['FEKETE', 'SOTET', 'CELLA', 'GRADIENS', 'KEPES', 'BEHUZAS', 'HALVANY', 'ATLATSZO']
const HIDDEN = `<div id="all"><p>Látható eleje <span style="font-size: 0px;">REJTETT0</span><span style="color: transparent;">REJTETT1</span><span style="opacity: 0;">REJTETT2</span><span style="position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0px, 0px, 0px, 0px); white-space: nowrap;">REJTETT3</span> látható vége</p></div>`
const DARK = `<style>body { background: #121212; color: #e8e8e8; font-family: Arial, sans-serif; }</style><div id="all"><p>Sötét oldal szövege, olvasható.</p><p>Második bekezdés.</p></div>`
const bigTable = cells => `<table id="all" style="border-collapse: collapse;"><tbody>${Array.from({ length: cells / 5 }, (_, r) => `<tr>${[0, 1, 2, 3, 4].map(c => `<td style="border: 1px solid rgb(153, 153, 153);">C${r * 5 + c}</td>`).join('')}</tr>`).join('')}</tbody></table>`

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
// what goes out of the editor's HTML: form()'s rich sanitizer, then the main process takes the signature mark off
const outgoing = html => unwrapSignature(sanitizeCompose(purify, html, { rich: true }))
const known = []

// a page shown in a window of the app's main process, its #all selected and copied: the clipboard's text/html and text/plain
// (a file, not a data: URL: the big table's page is over Chromium's URL length)
let pages = 0
const copyPage = html => {
  const file = path.join(work, `page-${++pages}.html`)
  fs.writeFileSync(file, `<!doctype html><meta charset="utf-8"><body>${html}</body>`)
  return app.evaluate(async ({ BrowserWindow, clipboard }, page) => {
    clipboard.clear()
    const w = new BrowserWindow({ show: true, width: 1000, height: 800, webPreferences: { sandbox: true, contextIsolation: true } })
    await w.loadFile(page)
    w.focus()
    w.webContents.focus()
    await w.webContents.executeJavaScript(`{ const r = document.createRange(); r.selectNodeContents(document.getElementById('all')); getSelection().removeAllRanges(); getSelection().addRange(r); 1 }`)
    w.webContents.copy()
    await new Promise(r => setTimeout(r, 400))
    // Electron 45's main-process clipboard: readHTML / readText where they are, else the async read() (MEASURED: 45.3.0 has no readHTML)
    const read = async type => {
      const sync = type === 'text/html' ? clipboard.readHTML : clipboard.readText
      if (typeof sync === 'function') return sync.call(clipboard)
      for (const it of await clipboard.read()) if (it.types.includes(type)) return await (await it.getType(type)).text()
      return ''
    }
    const got = { html: await read('text/html'), text: await read('text/plain') }
    w.destroy()
    return got
  }, file)
}
// the clipboard into the composer at its caret, as the user's Ctrl+V (match: Ctrl+Shift+V)
const pasteReal = (match = false) =>
  app.evaluate(async ({ BrowserWindow }, m) => {
    const w = BrowserWindow.getAllWindows().find(x => !x.isDestroyed() && x.webContents.getURL().includes('compose.html'))
    w.focus()
    w.webContents.focus()
    if (m) w.webContents.pasteAndMatchStyle()
    else w.webContents.paste()
    await new Promise(r => setTimeout(r, 300))
    return true
  }, match)

try {
  const page = await app.firstWindow()
  watch(page, 'main')
  await page.setViewportSize({ width: 1280, height: 900 })
  await useTheme(app, page)
  if (e2eTheme) console.log(`THEME ${await page.evaluate(() => document.documentElement.dataset.theme)}`)
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
  // the caret at the start of the text (before the signature)
  const caretAtStart = win => win.locator('.editor').evaluate(el => {
    el.focus()
    const r = document.createRange()
    r.setStart(el, 0)
    r.collapse(true)
    getSelection().removeAllRanges()
    getSelection().addRange(r)
  })
  const body = win => win.locator('.editor').evaluate(el => el.innerHTML)
  const sendAndRead = async win => {
    await win.locator('#compose-to').fill('Címzett <cimzett@example.invalid>')
    await win.locator('#compose-subject').fill('Beillesztett')
    const before = received.length
    const closed = win.waitForEvent('close', { timeout: 30_000 })
    await win.getByRole('button', { name: t.composeSend, exact: true }).click({ noWaitAfter: true }).catch(e => {
      if (!win.isClosed()) throw e
    })
    await closed
    for (let i = 0; i < 50 && received.length === before; i++) await new Promise(r => setTimeout(r, 200))
    return received.length > before ? simpleParser(received[received.length - 1]) : null
  }
  const close = async win => {
    if (!win.isClosed()) await win.close().catch(() => {})
  }

  // (a) a web page
  {
    const clip = await copyPage(WEB)
    check('a0 the copy: the clipboard has the page\'s HTML (the table, the styles) and its text', /<table/.test(clip.html) && /border/.test(clip.html) && /Kazán A/.test(clip.text), `${clip.html.length} / ${clip.text.length}`)
    const win = await newComposer()
    const c0 = csp()
    await caretAtStart(win)
    await pasteReal()
    await win.waitForFunction(() => document.querySelector('.editor table'))
    const shown = await win.locator('.editor').evaluate(el => {
      const cs = x => (x ? getComputedStyle(x) : null)
      const word = w => [...el.querySelectorAll('*')].find(x => x.childNodes.length === 1 && x.textContent === w)
      const table = el.querySelector('table')
      const th = el.querySelector('th')
      const td = el.querySelector('td')
      return {
        tableBorder: cs(table)?.borderTopWidth, tableBorderColor: cs(table)?.borderTopColor, thBg: cs(th)?.backgroundColor, colspan: th?.colSpan,
        tdBorder: cs(td)?.borderTopColor, red: cs(word('piros'))?.color, hl: cs(word('kiemelt'))?.backgroundColor, mono: cs(word('nagy betűs'))?.fontFamily,
        size: cs(word('nagy betűs'))?.fontSize, h2: Boolean(el.querySelector('h2')), sup: Boolean(el.querySelector('sup')), sub: Boolean(el.querySelector('sub')),
        lis: el.querySelectorAll('li').length, olStart: el.querySelector('ol')?.getAttribute('start'), link: el.querySelector('a')?.getAttribute('href'), img: el.querySelectorAll('img').length,
      }
    })
    check('a1 the editor: the table with its grid, the header background and the colspan, the colours, the font and size, the lists, h2, sup / sub, the link; no image',
      shown.tableBorder === '2px' && shown.tableBorderColor === 'rgb(0, 128, 0)' && shown.thBg === 'rgb(238, 238, 238)' && shown.colspan === 2 && shown.tdBorder === 'rgb(153, 153, 153)' &&
      shown.red === 'rgb(198, 40, 40)' && shown.hl === 'rgb(255, 245, 157)' && /Courier New/.test(shown.mono) && shown.size === '18px' && shown.h2 && shown.sup && shown.sub &&
      shown.lis === 3 && shown.olStart === '3' && shown.link === 'https://example.invalid/ajanlat' && shown.img === 0, JSON.stringify(shown))
    const editorHtml = await body(win)
    const mail = await sendAndRead(win)
    const out = mail?.html || ''
    const want = outgoing(editorHtml)
    let at = 0
    while (at < out.length && out[at] === want[at]) at++
    check('a2 sent: the HTML part is the editor\'s own (the rich sanitizer on it, byte for byte)', out === want, `at ${at}: ${out.slice(at - 60, at + 140)} || ${want.slice(at - 60, at + 140)}`)
    check('a3 sent: the text part a line per row, the cells one TAB apart', /Termék és darab\nKazán A\t1\nKazán B\t2/.test(mail?.text || ''), JSON.stringify((mail?.text || '').slice(0, 300)))
    check('a4 no CSP line on the composer (no image load either)', csp() === c0, `+${csp() - c0}`)
  }

  // (b) hidden text
  {
    const clip = await copyPage(HIDDEN)
    const onClip = ['REJTETT0', 'REJTETT1', 'REJTETT2', 'REJTETT3'].filter(w => clip.html.includes(w))
    console.log(`INFO hidden words on the clipboard's HTML (Chromium copies them): ${onClip.join(', ') || 'none'}`)
    const win = await newComposer()
    await caretAtStart(win)
    await pasteReal()
    await win.waitForFunction(() => document.querySelector('.editor').textContent.includes('Látható eleje'))
    const ed = await win.locator('.editor').evaluate(el => el.textContent)
    const mail = await sendAndRead(win)
    const sent = `${mail?.html || ''}\n${mail?.text || ''}`
    check('b1 hidden text (font-size 0, transparent, opacity 0, sr-only): not in the editor, not in the HTML part, not in the text part; the visible text is', onClip.length === 4 && !/REJTETT/.test(ed) && !/REJTETT/.test(sent) && /Látható eleje/.test(ed) && /látható vége/.test(mail?.text || ''), JSON.stringify({ onClip, ed: ed.slice(0, 120) }))
  }

  // (b2) unreadable on the page: readable once pasted (3:1, inside the editor), and sent
  {
    await copyPage(UNREADABLE)
    const win = await newComposer()
    await caretAtStart(win)
    await pasteReal()
    await win.waitForFunction(() => document.querySelector('.editor').textContent.includes('ATLATSZO'))
    const looks = await win.locator('.editor').evaluate((ed, words) => {
      const rgba = v => {
        const m = /rgba?\(([^)]*)\)/.exec(v || '')
        if (!m) return null
        const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number)
        return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }
      }
      const lum = c => {
        const f = x => {
          const y = x / 255
          return y <= 0.03928 ? y / 12.92 : ((y + 0.055) / 1.055) ** 2.4
        }
        return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)
      }
      const mix = (c, under) => ({ r: c.r * c.a + under.r * (1 - c.a), g: c.g * c.a + under.g * (1 - c.a), b: c.b * c.a + under.b * (1 - c.a), a: 1 })
      const box = ed.getBoundingClientRect()
      const out = {}
      for (const w of words) {
        const walker = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT)
        let n
        while ((n = walker.nextNode()) && !n.data.includes(w));
        if (!n) {
          out[w] = { missing: true }
          continue
        }
        const r = document.createRange()
        r.setStart(n, n.data.indexOf(w))
        r.setEnd(n, n.data.indexOf(w) + w.length)
        const rect = r.getBoundingClientRect()
        // the background it stands on: the nearest opaque-ish one up to the editor's own
        let bg = null
        for (let e = n.parentElement; e; e = e.parentElement) {
          const c = rgba(getComputedStyle(e).backgroundColor)
          if (c && c.a > 0) {
            bg = c.a >= 1 ? c : mix(c, { r: 255, g: 255, b: 255 })
            break
          }
          if (e === ed) break
        }
        bg = bg || { r: 255, g: 255, b: 255, a: 1 }
        const fg = mix(rgba(getComputedStyle(n.parentElement).color), bg)
        const [x, y] = [lum(fg), lum(bg)].sort((p, q) => q - p)
        out[w] = { ratio: Math.round(((x + 0.05) / (y + 0.05)) * 10) / 10, inside: rect.left >= box.left - 1 && rect.right <= box.right + 1, width: Math.round(rect.width) }
      }
      return out
    }, UNREADABLE_WORDS)
    const bad = Object.entries(looks).filter(([, l]) => l.missing || l.ratio < 3 || !l.inside || l.width <= 0)
    check('b2 eight unreadable texts of a page (dark on dark, under a gradient or an image, far indent, a faint alpha): readable in the editor (3:1), inside it', bad.length === 0, JSON.stringify(bad.length ? Object.fromEntries(bad) : looks))
    const szoros = await win.locator('.editor').evaluate(el => el.innerHTML.match(/<span[^>]*>SZOROS<\/span>|SZOROS/)?.[0] || '')
    check('b3 a 3 px letter at -5 px letter spacing (a zero-wide word): the letter spacing goes', !/letter-spacing: -5px/.test(szoros), szoros)
    const mail = await sendAndRead(win)
    check('b4 the eight sent: every word in the HTML part and the text part', UNREADABLE_WORDS.every(w => (mail?.html || '').includes(w) && (mail?.text || '').includes(w)), (mail?.text || '').slice(0, 200))
  }

  // (c) a dark page
  {
    const clip = await copyPage(DARK)
    const win = await newComposer()
    await caretAtStart(win)
    await pasteReal()
    await win.waitForFunction(() => document.querySelector('.editor').textContent.includes('Sötét oldal'))
    const island = await win.locator('.editor').evaluate(el => {
      const p = [...el.querySelectorAll('*')].find(x => x.childNodes.length === 1 && x.textContent.includes('Sötét oldal'))
      let bg = 'none'
      for (let e = p; e && e !== el; e = e.parentElement) {
        const b = getComputedStyle(e).backgroundColor
        if (b !== 'rgba(0, 0, 0, 0)') {
          bg = b
          break
        }
      }
      return { color: getComputedStyle(p).color, bg }
    })
    check('c1 a dark page\'s block: a dark island (its background and its light text kept: readable)', island.bg === 'rgb(18, 18, 18)' && island.color === 'rgb(232, 232, 232)', `${JSON.stringify(island)} clip ${clip.html.slice(0, 200)}`)
    // the same clipboard with its background taken off by hand: a light text on the white page
    const stripped = clip.html.replace(/background-color:\s*rgb\(18,\s*18,\s*18\);?/g, '')
    await win.locator('.editor').evaluate(el => {
      el.innerHTML = '<p>CÉL</p>'
    })
    await win.evaluate(html => {
      const el = document.querySelector('.editor')
      el.focus()
      const r = document.createRange()
      r.selectNodeContents(el.querySelector('p'))
      r.collapse(false)
      getSelection().removeAllRanges()
      getSelection().addRange(r)
      const dt = new DataTransfer()
      dt.setData('text/html', html)
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    }, stripped)
    const light = await win.locator('.editor').evaluate(el => {
      const p = [...el.querySelectorAll('*')].find(x => x.childNodes.length === 1 && x.textContent.includes('Sötét oldal'))
      return { color: p ? getComputedStyle(p).color : null, text: el.textContent }
    })
    check('c2 the background off the clipboard: the light text takes the default dark colour, the text is there', !/rgb\(18, 18, 18\)/.test(stripped) && light.color === 'rgb(31, 31, 31)' && /Második bekezdés/.test(light.text), JSON.stringify(light))
    await close(win)
  }

  // (d) a 25 000 cell table
  {
    const clip = await copyPage(bigTable(25_000))
    const win = await newComposer()
    await caretAtStart(win)
    await win.evaluate(() => {
      window.__pasteAt = null
      document.querySelector('.editor').addEventListener('paste', () => (window.__pasteAt = performance.now()), { capture: true, once: true })
    })
    await pasteReal()
    const done = await win.waitForFunction(() => document.querySelector('.editor').textContent.includes('C24999'), null, { timeout: 30_000 }).then(() => true, () => false)
    if (!done) console.log(`INFO d: ${JSON.stringify(await win.evaluate(() => ({ at: window.__pasteAt, len: document.querySelector('.editor').textContent.length, tail: document.querySelector('.editor').textContent.slice(-80), info: document.querySelector('.compose-info')?.textContent || null, error: document.querySelector('.compose-error')?.textContent || null })))}`)
    const r = await win.evaluate(() => ({ ms: performance.now() - window.__pasteAt, tables: document.querySelectorAll('.editor table').length, lines: document.querySelectorAll('.editor div > div').length }))
    check('d1 a 25 000 cell table: lines, no table; the paste under 2 s', clip.html.length > 1_000_000 && r.tables === 0 && r.lines >= 5000 && r.ms < 2000, `${JSON.stringify(r)} clipboard ${clip.html.length}`)
    console.log(`INFO the 25 000 cell paste took ${Math.round(r.ms)} ms (to the last cell in the editor; an upper bound)`)
    await close(win)
  }

  // (e) Ctrl+Shift+V
  {
    await copyPage(WEB)
    const win = await newComposer()
    await caretAtStart(win)
    await pasteReal(true)
    await win.waitForFunction(() => document.querySelector('.editor').textContent.includes('Kazán A'))
    const plain = await win.locator('.editor').evaluate(el => ({ tables: el.querySelectorAll('table').length, styled: el.querySelectorAll('[style], font, h2, li').length, text: el.textContent.includes('Ajánlat címe') }))
    check('e1 Ctrl+Shift+V (paste and match style): the text only, no table, style, heading or list', plain.tables === 0 && plain.styled === 0 && plain.text, JSON.stringify(plain))
    await close(win)
  }

  // (f) a piece dragged onto the text = the same as pasted; nothing of a foreign style raw
  {
    const html = `<p style="color: rgb(198, 40, 40); position: fixed; z-index: 9;">húzott <b style="white-space: nowrap;">szöveg</b></p><table style="border: 1px solid rgb(0, 0, 0);"><tbody><tr><td>H1</td></tr></tbody></table>`
    const win = await newComposer()
    const pasted = await win.evaluate(h => {
      const el = document.querySelector('.editor')
      el.innerHTML = '<p>CÉL</p>'
      el.focus()
      const r = document.createRange()
      r.selectNodeContents(el.querySelector('p'))
      r.collapse(false)
      getSelection().removeAllRanges()
      getSelection().addRange(r)
      const dt = new DataTransfer()
      dt.setData('text/html', h)
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
      return el.innerHTML
    }, html)
    const box = await win.locator('.editor p').first().boundingBox()
    const dropped = await win.evaluate(([h, x, y]) => {
      const el = document.querySelector('.editor')
      el.innerHTML = '<p>CÉL</p>'
      const dt = new DataTransfer()
      dt.setData('text/html', h)
      dt.setData('text/plain', 'húzott szöveg')
      const e = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: x, clientY: y })
      el.querySelector('p').dispatchEvent(e)
      return { html: el.innerHTML, prevented: e.defaultPrevented }
    }, [html, box.x + box.width - 1, box.y + box.height / 2])
    check('f1 dragged onto the text: the paste\'s way (the same HTML as pasted at the same place), nothing of a foreign style raw', dropped.prevented && dropped.html === pasted && !/position|z-index|white-space/.test(dropped.html) && /<table/.test(dropped.html) && /rgb\(198, 40, 40\)/.test(dropped.html), `${dropped.html} || ${pasted}`)
    await close(win)
  }

  // (g) too complex: no formatting, the informing line
  {
    const win = await newComposer()
    await caretAtStart(win)
    const r = await win.evaluate(() => {
      const el = document.querySelector('.editor')
      const dt = new DataTransfer()
      dt.setData('text/html', `<table><tr><th>Fej</th><td><font color="#c62828">piros</font></td></tr></table>${'<i>x</i>'.repeat(100_001)}`)
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
      return { table: el.querySelectorAll('table').length, font: el.querySelectorAll('font').length, lines: el.textContent.includes('Fej piros') }
    })
    await win.locator('.compose-info[role="status"]').waitFor({ timeout: 5000 })
    const info = await win.locator('.compose-info[role="status"]').textContent()
    check('g1 a clipboard too complex: no formatting (a table as lines), the informing line', r.table === 0 && r.font === 0 && r.lines && info === t.composePastePlain, `${JSON.stringify(r)} "${info}"`)
    await close(win)
  }

  // (h) the paste's own time net (500 ms): a 1 MB web page copy formatted within 1.5 s; the newsletter on the old way, within
  // 900 ms (the whole paste; MEASURED 1.2-1.3 s / 0.74-0.78 s: the sanitizer and the step are most of it)
  {
    const block = '<p style="margin: 0px 0px 10px; line-height: 1.5; color: rgb(32, 33, 36);">Bekezdés <span style="font-weight: 700;">vastag</span> <span style="color: rgb(198, 40, 40);">piros</span> <a href="https://example.invalid/" style="color: rgb(26, 13, 171);">link</a></p>'
    const web = block.repeat(Math.ceil((1024 * 1024) / block.length))
    // the caret as a new message has it (in the empty first paragraph, the signature block after it), or in the middle of
    // a paragraph's text; the time is the paste event (the step, the sanitizer and the insert)
    const timed = (win, html, at = 'new') => win.evaluate(([h, where]) => {
      const el = document.querySelector('.editor')
      el.focus()
      const r = document.createRange()
      if (where === 'mid') {
        el.insertAdjacentHTML('afterbegin', '<p>eleje vége</p>')
        r.setStart(el.firstChild.firstChild, 6)
      } else r.setStart(el, 0)
      r.collapse(true)
      getSelection().removeAllRanges()
      getSelection().addRange(r)
      window.__before = el.innerHTML
      const dt = new DataTransfer()
      dt.setData('text/html', h)
      const t0 = performance.now()
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
      return { ms: performance.now() - t0, red: el.querySelectorAll('span[style*="198, 40, 40"]').length, links: el.querySelectorAll('a').length, sig: Boolean(el.querySelector('[data-sm-signature]')) }
    }, [html, at])
    // one Ctrl+Z takes the whole paste back (the wrapper is one insert)
    const undoneOnce = async win => {
      await win.locator('.editor').press('Control+Z')
      return win.locator('.editor').evaluate(el => el.innerHTML === window.__before)
    }
    const news = newsletterHtml({ blocks: 2000 })
    for (const at of ['new', 'mid']) {
      let win = await newComposer()
      const w = await timed(win, web, at)
      const winfo = await win.locator('.compose-info[role="status"]').count()
      const where = at === 'new' ? 'a new message' : 'the middle of a paragraph'
      check(`h1 a 1 MB web page copy (${where}) comes formatted (no informing line), the signature kept, one Ctrl+Z back`, w.red > 3000 && w.links > 3000 && winfo === 0 && w.sig && (await undoneOnce(win)), `${JSON.stringify(w)} info ${winfo}`)
      check(`h1t the 1 MB web page copy (${where}) within 1.5 s (the whole paste: step, sanitizer, insert)`, w.ms <= 1500, `${Math.round(w.ms)} ms`)
      console.log(`INFO the 1 MB web page copy (${at}): ${Math.round(w.ms)} ms (the step, the sanitizer and the insert)`)
      await close(win)
      win = await newComposer()
      const from = consoleLines.length
      const n = await timed(win, news, at)
      await win.locator('.compose-info[role="status"]').waitFor({ timeout: 5000 })
      await win.waitForTimeout(300)
      // the old way parses the raw clipboard (its <style> too) with the sanitizer's DOMParser, and Chromium writes a policy
      // line for that (MEASURED; the rich way drops the <style> first: none): the old HTML path's known line, counted apart
      known.push(...consoleLines.splice(from).filter(l => /Applying inline style violates/.test(l) || (consoleLines.push(l), false)))
      const ninfo = await win.locator('.compose-info[role="status"]').textContent()
      check(`h2 a stylesheet-heavy newsletter (${where}): the old way with the informing line, the signature kept, one Ctrl+Z back`, ninfo === t.composePastePlain && n.sig && (await undoneOnce(win)), `${JSON.stringify(n)} "${ninfo}"`)
      check(`h2t the newsletter (${where}) within 900 ms (the whole paste)`, n.ms <= 900, `${Math.round(n.ms)} ms`)
      console.log(`INFO the newsletter (${at}): ${Math.round(n.ms)} ms`)
      await close(win)
    }
  }
} finally {
  await app.close().catch(() => {})
  smtp.close()
  await pop.close?.()
}
const mainLog = fs.readFileSync(path.join(dataDir, 'electron', 'logs', 'main.log'), 'utf8')
check('the main log: no error or failure line', !/failed|error/i.test(mainLog), mainLog.trim().split('\n').filter(l => /failed|error/i.test(l)).join(' | '))
check('no renderer console error or warning, no page exception', consoleLines.length === 0 && pageErrors.length === 0, [...consoleLines, ...pageErrors].slice(0, 3).join(' | '))
if (known.length) console.log(`KNOWN ${known.length}`)
fs.rmSync(work, { recursive: true, force: true })
console.log(`\n${results.filter(Boolean).length} / ${results.length} OK`)
process.exit(results.every(Boolean) ? 0 : 1)
