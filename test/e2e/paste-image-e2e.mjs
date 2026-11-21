#!/usr/bin/env node
// Pasted and dropped images in the composer, in the real app (headless Electron + Playwright). Not part of `npm test`.
//
//   node test/e2e/paste-image-e2e.mjs          (E2E_LANG=en: the same in English)
//
// Headless ozone has no clipboard and no OS drag: the paste and the drop are synthetic events with a DataTransfer. A file
// that must have a path on disk (an attachment) comes from a hidden file input (setInputFiles), as a real drop's would.
// One POP3 account (fake POP3 server, one message in INBOX), one local SMTP server:
// 1. Window 1: a PNG pasted (no HTML) goes in as this session's image and is shown; one paste with two PNGs gives two
//    images; a 1000 px wide JPEG. Its size menu (right click): Large checked by default, Small sets width="320" (shown
//    320 px), Ctrl+Z takes it back; Shift+F10 beside it opens the menu by keyboard, Original sets width="1000"; a left
//    click opens it too; on the 200 px PNG, selected, Enter opens it (the image stays), no size is on (no enlarging), Esc
//    gives the image back selected; Remove takes one PNG out. Window 2
//    meanwhile:
// 2. a PNG with an HTML of only an outside image: only the PNG goes in; a PNG with an HTML that has text: the HTML path
//    (the text, bold kept, no image at all); window 1's image src pasted as HTML: dropped; a GIF without a file: the error
//    line, nothing in; a GIF file: an attachment chip and the informing line, no image; an 11 MB PNG: the error line,
//    nothing in; a JPEG whose header says 16000 x 12000 (192 MP, not turned): the pixel-limit error line, nothing in.
//    Window 2 is discarded.
// 3. Window 1 sent: three inline parts (the removed one not), the PNG bytes unchanged, each cid in the HTML, the JPEG
//    with width="1000" (the original, over 800), no inl-img in the HTML or the text part.
// 4. Window 3: a PNG dropped on the text goes in at the drop point; a PDF dropped on the text and a PNG dropped on the
//    attachment bar are attachments; Ctrl+Z takes the image out, Ctrl+Y and Ctrl+Shift+Z bring it back; deleted with
//    Backspace and sent: no inline part, the two attachments.
// 5. A reply and a forward with a pasted PNG: sent with the inline part (the reply with In-Reply-To).
// 6. A pasted PNG saved in a draft, closed, opened again from Drafts: the image shown (the new session's src); sent with
//    the same bytes.
// 7. A turned photo (a real JPEG with Exif Orientation 6): shown upright (its natural size swapped), and
//    the sent part, decoded by the real nativeImage, is upright (the colored corners where an upright image has them).
// 8. A table copied from a web page (Chromium's clipboard HTML: no space or line between the cells, a style on the
//    table): one row a line in the editor, the header cell bold, no table tag; sent, the text part has the rows as lines
//    and nothing runs together. The policy lines of this HTML paste are told apart like step 2's (the formatted-paste card).
// The renderer console has no error or warning (no CSP line), the main log no error line and no file name, the net-guard
// log is empty.
// Playwright: PW=<path of the playwright package> (default: the repo's playwright-core devDependency).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { SMTPServer } from 'smtp-server'
import { simpleParser } from 'mailparser'
import { FakePop3Server } from '../helpers/fake-pop3.js'
import { pngFile, jpegFile, exifSegment } from '../helpers/inline-images.js'
import { createVaultedDatabase } from '../../core/vault/vaulted-db.js'
import { AccountStore } from '../../core/accounts/model.js'
import { newAccountDefaults } from '../../core/accounts/defaults.js'
import { t, locale, seedLanguage } from './lang.mjs'

const { values } = parseArgs({ options: { shots: { type: 'string' } }, strict: false })
if (values.shots) fs.mkdirSync(values.shots, { recursive: true })

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const MASTER = 'Teszt-mesterjelszo-kepbeillesztes'
const ME = { name: 'A-fiók', email: 'a@example.invalid', display: 'Anna Képes', signature: 'Üdv,\nAnna' }
const SUBJECT_IN = 'Képes kérdés'
const savedHint = (d => t.composeSavedAt(d).replace(d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }), '').trim())(new Date())

const watchdog = setTimeout(() => {
  console.log('FAIL watchdog: the run took more than 6 minutes')
  process.exit(1)
}, 360_000)
watchdog.unref()

// the images, and the file names the main log must not show
const PNG = [pngFile(200, 100, { seed: 1 }), pngFile(120, 60, { seed: 2 }), pngFile(130, 70, { seed: 3 }), pngFile(140, 80, { seed: 4 }), pngFile(150, 90, { seed: 5 }), pngFile(160, 50, { seed: 6 }), pngFile(170, 40, { seed: 7 })]
const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.from([1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 1, 0, 0x3b])])
const NAMES = ['kepernyo-titok-1.png', 'ket-kep-a.png', 'ket-kep-b.png', 'szeles-foto.jpg', 'kulso-kep-mellett.png', 'szoveg-mellett.png', 'fajl-nelkul.gif', 'animacio-titok.gif', 'nagy-kep.png', 'ejtett-kep.png', 'dokumentum-titok.pdf', 'melleklet-kep.png', 'valasz-kep.png', 'tovabbitas-kep.png', 'piszkozat-kep.png', 'orias-kep-titok.jpg']
const file = (i, name) => ({ b64: PNG[i].toString('base64'), name, type: 'image/png' })

const received = []
const smtp = new SMTPServer({
  disabledCommands: ['STARTTLS'], allowInsecureAuth: true, authMethods: ['PLAIN', 'LOGIN'], logger: false,
  onAuth: (a, _s, cb) => cb(null, { user: a.username }),
  onData(stream, session, cb) {
    const chunks = []
    stream.on('data', c => chunks.push(c))
    stream.on('end', () => (received.push(Buffer.concat(chunks)), cb()))
  },
})
smtp.on('error', () => {})
await new Promise(r => smtp.listen(0, '127.0.0.1', r))
const pop = await new FakePop3Server().listen()
pop.add([
  'From: Ügyfél Ödön <ugyfel@example.invalid>',
  `To: ${ME.display} <${ME.email}>`,
  `Subject: ${SUBJECT_IN}`,
  'Date: Thu, 19 Nov 2026 09:00:00 +0100',
  'Message-ID: <kerdes-1@example.invalid>',
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: 8bit',
  '',
  'Küldenél egy képet a kazánról?',
  '',
].join('\r\n'))

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-paste-e2e-'))
const dataDir = path.join(work, 'data')
const disk = path.join(work, 'files')
fs.mkdirSync(dataDir)
fs.mkdirSync(disk)
fs.writeFileSync(path.join(disk, 'animacio-titok.gif'), GIF)
fs.writeFileSync(path.join(disk, 'dokumentum-titok.pdf'), '%PDF-1.4\n% e2e\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n')
fs.writeFileSync(path.join(disk, 'melleklet-kep.png'), PNG[6])
seedLanguage(dataDir)
{
  const { db, vault } = await createVaultedDatabase(dataDir, MASTER)
  const store = new AccountStore(db, vault, { storeDir: path.join(dataDir, 'store') })
  store.save({
    ...newAccountDefaults('pop3'), name: ME.name, email: ME.email, display_name: ME.display, signature: ME.signature,
    in_host: '127.0.0.1', in_port: pop.port, in_security: 'none', in_user: pop.user, in_password: pop.pass,
    smtp_host: '127.0.0.1', smtp_port: smtp.server.address().port, smtp_security: 'none',
  })
  db.close()
}

const results = []
const consoleLines = []
let consoleSeen = 0
let knownHtmlPath = 0
let knownTablePath = 0
// a web page's label / value table as Chromium puts it on the clipboard (measured in Electron 45.3.0), synthetic values
const TABLE_HTML = '<meta charset="utf-8"><table class="bevitel" style="color: rgb(0, 0, 0); font-family: &quot;Times New Roman&quot;; font-size: medium;"><tbody><tr><th>Kedvezményezett neve:</th><td>Példa Kft</td></tr><tr><th>Számlavezető bank neve:</th><td>Minta Bank</td></tr><tr><th>Összeg:</th><td class="bold">1000 HUF</td></tr></tbody></table><br class="Apple-interchange-newline">'
const TABLE_LINES = ['Kedvezményezett neve: Példa Kft', 'Számlavezető bank neve: Minta Bank', 'Összeg: 1000 HUF']
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
  // which step a console line came with
  if (consoleLines.length > consoleSeen) console.log(`     console +${consoleLines.length - consoleSeen} by now: ${consoleLines[consoleSeen].slice(0, 120)}`)
  consoleSeen = consoleLines.length
}
const app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })

// the composer page's helpers: a File from a spec ({ b64 } | { jpeg: [w, h] } | { zeros: n } | { disk: i }) and a
// DataTransfer of such files
const installHelpers = win =>
  win.evaluate(() => {
    const bytes = b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0))
    window.__e2eFile = async f => {
      if (f.disk !== undefined) return window.__e2eDisk[f.disk]
      if (f.jpeg) {
        const c = document.createElement('canvas')
        c.width = f.jpeg[0]
        c.height = f.jpeg[1]
        const g = c.getContext('2d')
        // blue right half, red left half, a green top-left quarter (where a turned copy has it tells the turn)
        g.fillStyle = '#2040e0'
        g.fillRect(0, 0, c.width, c.height)
        g.fillStyle = '#e02020'
        g.fillRect(0, 0, c.width / 2, c.height)
        g.fillStyle = '#20c020'
        g.fillRect(0, 0, c.width / 4, c.height / 2)
        const blob = new Uint8Array(await (await new Promise(r => c.toBlob(r, 'image/jpeg', 0.95))).arrayBuffer())
        // an Exif block (with its Orientation) right after the SOI, as a phone writes it
        const jpeg = f.exif ? new Uint8Array([...blob.subarray(0, 2), ...bytes(f.exif), ...blob.subarray(2)]) : blob
        return new File([jpeg], f.name, { type: 'image/jpeg' })
      }
      if (f.zeros) return new File([new Uint8Array(f.zeros)], f.name, { type: f.type })
      return new File([bytes(f.b64)], f.name, { type: f.type })
    }
    window.__e2eTransfer = async files => {
      const dt = new DataTransfer()
      for (const f of files) dt.items.add(await window.__e2eFile(f))
      return dt
    }
  })
// files with a path on disk (what a real drop or a copied file brings): window.__e2eDisk[i]
const loadDisk = async (win, names) => {
  await win.evaluate(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.id = 'e2e-files'
    input.hidden = true
    document.body.append(input)
  })
  await win.locator('#e2e-files').setInputFiles(names.map(n => path.join(disk, n)))
  await win.evaluate(() => {
    window.__e2eDisk = [...document.getElementById('e2e-files').files]
    document.getElementById('e2e-files').remove()
  })
}
const paste = (win, files, html = '') =>
  win.evaluate(
    async ({ files, html }) => {
      const dt = await window.__e2eTransfer(files)
      if (html) dt.setData('text/html', html)
      document.querySelector('.editor').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    },
    { files, html },
  )
// a drop on the text just before `before` (a piece of the editor's text), or on the middle of `selector`
const drop = (win, files, { before, selector }) =>
  win.evaluate(
    async ({ files, before, selector }) => {
      const dt = await window.__e2eTransfer(files)
      let el, x, y
      if (before) {
        const walk = document.createTreeWalker(document.querySelector('.editor'), NodeFilter.SHOW_TEXT)
        let n = walk.nextNode()
        while (n && !n.data.includes(before)) n = walk.nextNode()
        const i = n.data.indexOf(before)
        const r = document.createRange()
        r.setStart(n, i)
        r.setEnd(n, i + 1)
        const b = r.getBoundingClientRect()
        el = n.parentElement
        x = b.left + 1
        y = b.top + b.height / 2
      } else {
        el = document.querySelector(selector)
        const b = el.getBoundingClientRect()
        x = b.left + b.width / 2
        y = b.top + b.height / 2
      }
      el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, clientX: x, clientY: y, bubbles: true, cancelable: true }))
    },
    { files, before, selector },
  )
// the editor's images (src, shown width), its text with each image as [K], the chips, the info and the error line
const stateOf = win =>
  win.evaluate(async () => {
    const ed = document.querySelector('.editor')
    const imgs = [...ed.querySelectorAll('img')]
    await Promise.all(imgs.map(i => (i.complete ? null : new Promise(r => (i.onload = i.onerror = r)))))
    const copy = ed.cloneNode(true)
    for (const i of copy.querySelectorAll('img')) i.replaceWith('[K]')
    return {
      imgs: imgs.map(i => ({ src: i.getAttribute('src'), shown: i.naturalWidth })),
      text: copy.textContent.replace(/\u00a0/g, ' '),
      html: ed.innerHTML,
      chips: [...document.querySelectorAll('.compose-attachments .attachment-chip')].map(c => c.dataset.filename),
      info: document.querySelector('.compose-info')?.textContent || null,
      error: document.querySelector('.compose-error')?.textContent || null,
    }
  })
const imgCount = (win, n) => win.waitForFunction(n => document.querySelectorAll('.editor img').length === n && [...document.querySelectorAll('.editor img')].every(i => i.complete), n, { timeout: 10_000 })
const SESSION_IMG = /^inl-img:\/\/session\/([0-9a-f-]{36})\/[0-9a-f]{24}$/
const sessionOf = src => (SESSION_IMG.exec(src || '') || [])[1] || null
const caretToStart = async win => {
  await win.locator('.editor').click()
  await win.keyboard.press('Control+Home')
}
const sentMail = async (page, n) => {
  for (let i = 0; i < 75 && received.length < n; i++) await page.waitForTimeout(200)
  return received[n - 1] ? simpleParser(received[n - 1], { keepCidLinks: true }) : null
}
const inlineOf = mail => (mail ? mail.attachments.filter(a => a.related || (a.cid && a.contentDisposition === 'inline')) : [])
const brief = mail => (mail ? JSON.stringify({ parts: mail.attachments.map(a => [a.contentType, a.cid || null, a.contentDisposition, a.filename || null, a.size]), html: (mail.html || '').slice(0, 300) }) : 'nothing arrived')

try {
  const page = await app.firstWindow()
  page.on('console', m => (m.type() === 'error' || m.type() === 'warning') && consoleLines.push(`main ${m.type()}: ${m.text()}`))
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  await page.locator('.msg-row', { hasText: SUBJECT_IN }).waitFor({ timeout: 20_000 })
  const composerOf = async click => {
    const [win] = await Promise.all([app.waitForEvent('window', { timeout: 15_000 }), click()])
    win.on('console', m => (m.type() === 'error' || m.type() === 'warning') && consoleLines.push(`composer ${m.type()}: ${m.text()}`))
    await win.setViewportSize({ width: 900, height: 700 })
    await win.locator('.editor').waitFor()
    await win.waitForFunction(() => document.querySelector('.editor')?.textContent)
    await installHelpers(win)
    return win
  }
  const newMessage = () => composerOf(() => page.getByRole('button', { name: t.newMessage, exact: true }).click())
  const fromReader = button => composerOf(() => page.locator('.reader-tools').getByRole('button', { name: button, exact: true }).click())
  const clickClosing = async (win, name, timeout) => {
    const closed = win.waitForEvent('close', { timeout })
    await win.getByRole('button', { name, exact: true }).click({ noWaitAfter: true }).catch(e => {
      if (!win.isClosed()) throw e
    })
    await closed
  }
  const send = async (win, to, subject) => {
    if (to) await win.locator('#compose-to').fill(to)
    if (subject) await win.locator('#compose-subject').fill(subject)
    await clickClosing(win, t.composeSend, 30_000)
  }

  // 1. window 1: one PNG, two PNGs in one paste, a wide JPEG
  const w1 = await newMessage()
  await caretToStart(w1)
  await w1.keyboard.type('Itt a kép: ')
  await paste(w1, [file(0, NAMES[0])])
  await imgCount(w1, 1)
  let s = await stateOf(w1)
  const sid1 = sessionOf(s.imgs[0]?.src)
  check('a pasted PNG: one image of this session, shown, at the caret', sid1 && s.imgs[0].shown === 200 && s.text.includes('Itt a kép: [K]') && !s.error && !s.info, JSON.stringify(s.imgs) + s.text)
  await paste(w1, [file(1, NAMES[1]), file(2, NAMES[2])])
  await imgCount(w1, 3)
  s = await stateOf(w1)
  check('two PNGs in one paste: two images, in order, shown', s.imgs.length === 3 && s.imgs[1].shown === 120 && s.imgs[2].shown === 130 && s.imgs.every(i => sessionOf(i.src) === sid1), JSON.stringify(s.imgs))
  await paste(w1, [{ jpeg: [1000, 40], name: NAMES[3] }])
  await imgCount(w1, 4)
  s = await stateOf(w1)
  check('a pasted JPEG (1000 px): in, shown at its size', s.imgs.length === 4 && s.imgs[3].shown === 1000 && sessionOf(s.imgs[3].src) === sid1, JSON.stringify(s.imgs[3]))
  const w1Src = s.imgs[0].src

  // the size menu
  const sizeMenu = w1.getByRole('menu', { name: t.composeImageMenu.label })
  const menuItems = () => sizeMenu.evaluate(m => [...m.querySelectorAll('[role^="menuitem"]')].map(b => `${b.dataset.key}:${b.disabled ? 'off' : 'on'}${b.getAttribute('aria-checked') === 'true' ? ':checked' : ''}`).join(' '))
  const widthOf = (n, want) => w1.waitForFunction(([n, want]) => (document.querySelectorAll('.editor img')[n]?.getAttribute('width') ?? null) === want, [n, want], { timeout: 10_000 })
  // a left click on the image opens it too (the card: a click, or Enter / Shift+F10 / the menu key on a selected image)
  await w1.locator('.editor img').nth(3).click()
  await sizeMenu.waitFor()
  let items = await menuItems()
  check('the size menu on the 1000 px JPEG: the three sizes on, Large checked (the default), Original, Remove', items === 'small:on medium:on large:on:checked original:on remove:on', items)
  if (values.shots) await w1.screenshot({ path: path.join(values.shots, 'paste-image-size-menu.png') })
  await sizeMenu.getByRole('menuitemradio', { name: t.composeImageMenu.small, exact: true }).click()
  await widthOf(3, '320')
  let box = await w1.evaluate(() => Math.round(document.querySelectorAll('.editor img')[3].getBoundingClientRect().width))
  check('Small: width="320", shown 320 px wide, still four images', box === 320 && (await w1.locator('.editor img').count()) === 4, String(box))
  await w1.keyboard.press('Control+z')
  const undone = await widthOf(3, null).then(() => true, () => false)
  check('Ctrl+Z: the size taken back', undone)
  await w1.evaluate(() => {
    const r = document.createRange()
    r.setStartAfter(document.querySelectorAll('.editor img')[3])
    r.collapse(true)
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(r)
  })
  await w1.keyboard.press('Shift+F10')
  await sizeMenu.waitFor()
  const focusedKey = await w1.evaluate(() => document.activeElement?.dataset?.key || null)
  check('Shift+F10 beside the image: the menu, the focus on the checked item (Large)', focusedKey === 'large', String(focusedKey))
  await w1.keyboard.press('ArrowDown')
  await w1.keyboard.press('Enter')
  const original = await widthOf(3, '1000').then(() => true, () => false)
  check('Original by keyboard: width="1000"', original)
  // the 200 px PNG selected by keyboard, Enter: the menu (not a new line in place of the image)
  await w1.evaluate(() => {
    const r = document.createRange()
    r.selectNode(document.querySelector('.editor img'))
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(r)
  })
  await w1.keyboard.press('Enter')
  const byEnter = await sizeMenu.waitFor({ timeout: 5000 }).then(() => true, () => false)
  check('Enter on a selected image: its size menu, the image stays', byEnter && (await w1.locator('.editor img').count()) === 4, String(byEnter))
  items = byEnter ? await menuItems() : ''
  check('the menu on the 200 px PNG: no size is on (no enlarging), Original checked', items === 'small:off medium:off large:off original:on:checked remove:on', items)
  await w1.keyboard.press('Escape')
  await sizeMenu.waitFor({ state: 'detached' })
  const backOnImage = await w1.evaluate(() => {
    const sel = window.getSelection()
    const r = sel.rangeCount ? sel.getRangeAt(0) : null
    return document.activeElement === document.querySelector('.editor') && r && r.startContainer.childNodes[r.startOffset] === document.querySelector('.editor img') && r.endOffset === r.startOffset + 1
  })
  check('Esc: the menu closes, the focus back with the image selected, nothing changed', backOnImage && (await w1.locator('.editor img').count()) === 4)
  // from a right click (nothing selected before): Esc selects the image
  await w1.evaluate(() => {
    const r = document.createRange()
    r.setStart(document.querySelector('.editor'), 0)
    r.collapse(true)
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(r)
  })
  await w1.locator('.editor img').first().click({ button: 'right' })
  await sizeMenu.waitFor()
  await w1.keyboard.press('Escape')
  await sizeMenu.waitFor({ state: 'detached' })
  const selectedAfterRight = await w1.evaluate(() => {
    const sel = window.getSelection()
    const r = sel.rangeCount ? sel.getRangeAt(0) : null
    return Boolean(r && r.startContainer.childNodes[r.startOffset] === document.querySelector('.editor img') && r.endOffset === r.startOffset + 1)
  })
  check('right click, then Esc: the image selected', selectedAfterRight)
  await w1.locator('.editor img').nth(1).click({ button: 'right' })
  await sizeMenu.waitFor()
  await sizeMenu.getByRole('menuitemradio', { name: t.composeImageMenu.remove, exact: true }).click()
  await imgCount(w1, 3)
  s = await stateOf(w1)
  check('Remove: that image is out of the text, the others stay', s.imgs.map(i => i.shown).join() === '200,130,1000', JSON.stringify(s.imgs))

  // 2. window 2: what does not go in as an image
  const w2 = await newMessage()
  await loadDisk(w2, ['animacio-titok.gif'])
  await caretToStart(w2)
  await paste(w2, [file(4, NAMES[4])], '<meta charset="utf-8"><img src="http://example.invalid/kulso.png" alt="">')
  await imgCount(w2, 1)
  s = await stateOf(w2)
  const sid2 = sessionOf(s.imgs[0]?.src)
  check('a PNG with an HTML of only an outside image: only the PNG, as this session\'s image', s.imgs.length === 1 && sid2 && sid2 !== sid1 && s.imgs[0].shown === 150 && !s.html.includes('example.invalid'), s.html)
  // the HTML path (as before this change: the editor puts pasted text in a styled span, and the policy reports that
  // style; the older finding of the formatted paste, a separate card). Its policy lines are told apart, not counted
  // against the images
  const htmlPathFrom = consoleLines.length
  await paste(w2, [file(5, NAMES[5])], '<meta charset="utf-8"><p>Szia világ</p><img src="http://example.invalid/masik.png">')
  await w2.waitForFunction(() => document.querySelector('.editor').textContent.includes('Szia világ'))
  s = await stateOf(w2)
  await w2.waitForTimeout(300)
  // the policy lines of this step are the known ones; any other line goes back among the failures
  knownHtmlPath = consoleLines.splice(htmlPathFrom).filter(l => /Applying inline style violates/.test(l) || (consoleLines.push(l), false)).length
  consoleSeen = consoleLines.length
  check('a PNG with an HTML that has text: the HTML path (the text), no image from it', s.imgs.length === 1 && s.text.includes('Szia világ') && !s.html.includes('example.invalid'), s.html)
  await paste(w2, [], `<img src="${w1Src}" alt="">`)
  await w2.waitForTimeout(300)
  s = await stateOf(w2)
  check('another window\'s image pasted as HTML: dropped, nothing shown', s.imgs.length === 1 && !s.html.includes(sid1), s.html)
  await paste(w2, [{ b64: GIF.toString('base64'), name: NAMES[6], type: 'image/gif' }])
  await w2.locator('.compose-error').waitFor({ timeout: 10_000 })
  s = await stateOf(w2)
  check('a GIF without a file: the error line, nothing in, no chip', s.error === t.composeImageError('not_attachable') && s.imgs.length === 1 && s.chips.length === 0 && !s.info, JSON.stringify({ error: s.error, chips: s.chips }))
  await paste(w2, [{ disk: 0 }])
  await w2.locator('.compose-info').waitFor({ timeout: 10_000 })
  s = await stateOf(w2)
  check('a GIF file: an attachment chip, the informing line, no image, the error line gone', s.info === t.composeImageAttached(1) && s.chips.join() === 'animacio-titok.gif' && s.imgs.length === 1 && !s.error, JSON.stringify({ info: s.info, chips: s.chips, error: s.error }))
  await paste(w2, [{ zeros: 11 * 1024 * 1024, name: NAMES[8], type: 'image/png' }])
  await w2.locator('.compose-error').waitFor({ timeout: 15_000 })
  s = await stateOf(w2)
  check('an 11 MB PNG: the error line (10 MB), nothing in, no new chip', s.error === t.composeImageError('too_large', { bytes: 1 }) && s.imgs.length === 1 && s.chips.length === 1, JSON.stringify({ error: s.error, chips: s.chips, imgs: s.imgs.length }))
  // over the pixel limit by its header, not turned: refused before the main process decodes it
  const giantError = t.composeImageError('too_large', { width: 16000, height: 12000, maxPixels: 50_000_000, turned: false })
  await paste(w2, [{ b64: jpegFile(16000, 12000).toString('base64'), name: NAMES[15], type: 'image/jpeg' }])
  for (const until = performance.now() + 15_000; performance.now() < until; await w2.waitForTimeout(100)) {
    s = await stateOf(w2)
    if (s.error && s.error !== t.composeImageError('too_large', { bytes: 1 })) break // the line is cleared while the paste runs
  }
  check('a 192 MP JPEG (not turned): the pixel-limit error line, nothing in, no new chip', s.error === giantError && s.imgs.length === 1 && s.chips.length === 1, JSON.stringify({ error: s.error, want: giantError, chips: s.chips, imgs: s.imgs.length }))
  // the window frame's X (the main process closes it), which asks about the unsaved message; the header's own close
  // button does not ask (a separate, older finding), so it is not used with unsaved changes here
  const closedW2 = w2.waitForEvent('close', { timeout: 15_000 })
  await app.evaluate(({ BrowserWindow }, sid) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes(`compose=${sid}`)).close(), sid2)
  await w2.getByRole('alertdialog').waitFor({ timeout: 10_000 })
  await w2.getByRole('alertdialog').getByRole('button', { name: t.composeDiscard, exact: true }).click({ noWaitAfter: true }).catch(e => {
    if (!w2.isClosed()) throw e
  })
  await closedW2

  // 3. window 1 sent
  await send(w1, 'cimzett@example.invalid', 'Három kép')
  let mail = await sentMail(page, 1)
  let parts = inlineOf(mail)
  const pngParts = parts.filter(p => p.contentType === 'image/png')
  const jpg = parts.find(p => p.contentType === 'image/jpeg')
  const jpgTag = jpg && mail ? ((mail.html.match(new RegExp(`<img[^>]*cid:${jpg.cid.replace(/[.$]/g, '\\$&')}[^>]*>`)) || [])[0] || '') : ''
  check('sent: three inline parts (not the removed one), the PNGs byte for byte in order, each cid in the HTML', parts.length === 3 && pngParts.length === 2 && pngParts[0].content.equals(PNG[0]) && pngParts[1].content.equals(PNG[2]) && parts.every(p => mail.html.includes(`cid:${p.cid}`)), brief(mail))
  check('sent: the 1000 px JPEG with width="1000" (the original, over 800), no inl-img in the HTML or the text part', /width="1000"/.test(jpgTag) && !/inl-img/.test(mail.html) && !/inl-img|cid:/.test(mail.text || ''), jpgTag + ' | ' + (mail ? mail.text : ''))

  // 4. window 3: drops, undo / redo, a deleted image
  const w3 = await newMessage()
  await loadDisk(w3, ['dokumentum-titok.pdf', 'melleklet-kep.png'])
  await caretToStart(w3)
  await w3.keyboard.type('Első sor szövege.')
  await drop(w3, [file(0, NAMES[9])], { before: 'sor' })
  await imgCount(w3, 1)
  s = await stateOf(w3)
  check('a PNG dropped on the text: in at the drop point, shown', /Első ?\[K\] ?sor szövege\./.test(s.text) && s.imgs[0].shown === 200 && s.chips.length === 0, s.text)
  await drop(w3, [{ disk: 0 }], { before: 'szövege' })
  await w3.locator('.compose-attachments .attachment-chip').first().waitFor({ timeout: 10_000 })
  s = await stateOf(w3)
  check('a PDF dropped on the text: an attachment, no image', s.chips.join() === 'dokumentum-titok.pdf' && s.imgs.length === 1, JSON.stringify(s.chips))
  await drop(w3, [{ disk: 1 }], { selector: '.compose-attachments' })
  await w3.waitForFunction(() => document.querySelectorAll('.compose-attachments .attachment-chip').length === 2, null, { timeout: 10_000 })
  s = await stateOf(w3)
  check('a PNG dropped on the attachment bar: an attachment, not an image', s.chips.join() === 'dokumentum-titok.pdf,melleklet-kep.png' && s.imgs.length === 1, JSON.stringify(s.chips))
  await w3.locator('.editor').focus()
  await w3.keyboard.press('Control+z')
  await imgCount(w3, 0)
  s = await stateOf(w3)
  check('Ctrl+Z: the image out, the text stays', s.imgs.length === 0 && s.text.includes('Első sor szövege.'), s.text)
  await w3.keyboard.press('Control+y')
  const redoY = await imgCount(w3, 1).then(() => true, () => false)
  check('Ctrl+Y: the image back', redoY)
  if (redoY) await w3.keyboard.press('Control+z')
  await imgCount(w3, 0)
  await w3.keyboard.press('Control+Shift+z')
  await imgCount(w3, 1)
  s = await stateOf(w3)
  check('Ctrl+Shift+Z: the image back, shown', s.imgs.length === 1 && s.imgs[0].shown === 200, JSON.stringify(s.imgs))
  await w3.evaluate(() => {
    const img = document.querySelector('.editor img')
    const r = document.createRange()
    r.setStartAfter(img)
    r.collapse(true)
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(r)
  })
  await w3.keyboard.press('Backspace')
  await imgCount(w3, 0)
  await send(w3, 'cimzett@example.invalid', 'Törölt kép')
  mail = await sentMail(page, 2)
  check('the deleted image is not sent: no inline part, the two attachments, the text', mail && inlineOf(mail).length === 0 && mail.attachments.map(a => a.filename).sort().join() === 'dokumentum-titok.pdf,melleklet-kep.png' && !/inl-img|cid:/.test(mail.html) && mail.text.replace(/\u00a0/g, ' ').includes('Első sor szövege.'), brief(mail))

  // 5. a reply and a forward
  await page.locator('.msg-row', { hasText: SUBJECT_IN }).click()
  await page.locator('.reader-tools').waitFor({ timeout: 10_000 })
  for (const [mode, i, name, n] of [['reply', 3, NAMES[12], 3], ['forward', 4, NAMES[13], 4]]) {
    const w = await fromReader(t.replyModes[mode])
    await caretToStart(w)
    await paste(w, [file(i, name)])
    await imgCount(w, 1)
    await send(w, mode === 'forward' ? 'masik@example.invalid' : null, null)
    mail = await sentMail(page, n)
    parts = inlineOf(mail)
    check(`${mode}: the pasted PNG sent as an inline part, its cid in the HTML`, parts.length === 1 && parts[0].content.equals(PNG[i]) && mail.html.includes(`cid:${parts[0].cid}`) && (mode !== 'reply' || mail.inReplyTo === '<kerdes-1@example.invalid>'), brief(mail))
  }

  // 6. a draft with a pasted image
  let w = await newMessage()
  await w.locator('#compose-to').fill('cimzett@example.invalid')
  await w.locator('#compose-subject').fill('Képes piszkozat')
  await caretToStart(w)
  await w.keyboard.type('Piszkozat szövege. ')
  await paste(w, [file(5, NAMES[14])])
  await imgCount(w, 1)
  const draftSid = sessionOf((await stateOf(w)).imgs[0].src)
  await w.getByRole('button', { name: t.composeSaveDraft, exact: true }).click()
  await w.locator('.hint[role="status"]').filter({ hasText: savedHint }).waitFor({ timeout: 15_000 })
  await clickClosing(w, t.composeCloseWindow, 15_000)
  await page.locator('.folder[data-path="Drafts"]').click()
  await page.locator('.msg-row', { hasText: 'Képes piszkozat' }).click()
  await page.locator('.reader-tools').waitFor({ timeout: 10_000 })
  await page.waitForTimeout(300)
  w = await composerOf(() => page.locator('.reader-tools .reader-edit-draft').click())
  await imgCount(w, 1)
  s = await stateOf(w)
  const reSid = sessionOf(s.imgs[0].src)
  check('the draft opened again: the image shown, the new session\'s src, the text', s.imgs.length === 1 && s.imgs[0].shown === 160 && reSid && reSid !== draftSid && s.text.includes('Piszkozat szövege.'), JSON.stringify(s.imgs) + s.text)
  await send(w, null, null)
  mail = await sentMail(page, 5)
  parts = inlineOf(mail)
  check('the reopened draft sent: one inline part, the same bytes', parts.length === 1 && parts[0].content.equals(PNG[5]) && mail.html.includes(`cid:${parts[0].cid}`), brief(mail))

  // 7. a turned photo
  w = await newMessage()
  await caretToStart(w)
  await paste(w, [{ jpeg: [120, 60], exif: exifSegment(6).toString('base64'), name: 'allo-foto.jpg' }])
  await imgCount(w, 1)
  const upright = await w.evaluate(() => {
    const i = document.querySelector('.editor img')
    return [i.naturalWidth, i.naturalHeight]
  })
  check('a photo with Exif Orientation 6: in, shown upright (60 x 120, not 120 x 60)', upright.join() === '60,120', upright.join())
  await send(w, 'cimzett@example.invalid', 'Álló fotó')
  mail = await sentMail(page, 6)
  parts = inlineOf(mail)
  const sentPixels = parts.length === 1
    ? await app.evaluate(({ nativeImage }, b64) => {
        const img = nativeImage.createFromBuffer(Buffer.from(b64, 'base64'))
        const { width, height } = img.getSize()
        const bmp = img.toBitmap()
        const color = (x, y) => {
          const [b, g, r] = bmp.subarray((y * width + x) * 4, (y * width + x) * 4 + 3)
          return g > 150 && r < 120 ? 'green' : r > 150 && b < 120 ? 'red' : b > 150 && r < 120 ? 'blue' : `${r},${g},${b}`
        }
        return { width, height, topRight: color(50, 10), topLeft: color(10, 10), bottom: color(30, 100) }
      }, parts[0].content.toString('base64'))
    : null
  check('sent upright: 60 x 120, green top right, red top left, blue at the bottom (turned 90 clockwise), no Exif in the part', sentPixels && sentPixels.width === 60 && sentPixels.height === 120 && sentPixels.topRight === 'green' && sentPixels.topLeft === 'red' && sentPixels.bottom === 'blue' && !parts[0].content.includes(Buffer.from('Exif', 'latin1')), JSON.stringify(sentPixels))

  // 8. a table copied from a web page
  w = await newMessage()
  await caretToStart(w)
  const tableFrom = consoleLines.length
  await paste(w, [], TABLE_HTML)
  await w.waitForFunction(() => document.querySelector('.editor').textContent.includes('1000 HUF'))
  await w.waitForTimeout(300)
  knownTablePath = consoleLines.splice(tableFrom).filter(l => /Applying inline style violates/.test(l) || (consoleLines.push(l), false)).length
  consoleSeen = consoleLines.length
  const shown = await w.evaluate(() => {
    const ed = document.querySelector('.editor')
    return { lines: ed.innerText.split('\n').map(l => l.trim()).filter(Boolean), table: ed.querySelectorAll('table, tr, td, th').length, bold: [...ed.querySelectorAll('b, strong')].map(b => b.textContent), html: ed.innerHTML.slice(0, 400) }
  })
  check('a pasted web-page table: one row a line in the editor, the cells apart, the header cells bold, no table tag', TABLE_LINES.every(l => shown.lines.includes(l)) && shown.table === 0 && ['Kedvezményezett neve:', 'Összeg:'].every(b => shown.bold.includes(b)), JSON.stringify(shown))
  await send(w, 'cimzett@example.invalid', 'Táblázat')
  mail = await sentMail(page, 7)
  const sentLines = mail ? (mail.text || '').split('\n').map(l => l.trim()) : []
  check('the pasted table sent: the text part has each row as a line, nothing runs together; the HTML has no table and no glued cells', mail && TABLE_LINES.every(l => sentLines.includes(l)) && !/neve:Példa|KftSzámla|BankÖsszeg/.test(mail.text + mail.html) && !/<table/i.test(mail.html), mail ? JSON.stringify({ text: mail.text, html: mail.html.slice(0, 400) }) : 'nothing arrived')
} catch (err) {
  check('the run finished', false, err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : String(err))
} finally {
  await app.close().catch(() => {})
  await pop.close()
  await new Promise(r => smtp.close(r))
}
const mainLog = fs.readFileSync(path.join(dataDir, 'electron', 'logs', 'main.log'), 'utf8')
check('the main log: no error or failure line', !/failed|error/i.test(mainLog), mainLog.trim().split('\n').filter(l => /failed|error/i.test(l)).join(' | '))
check('the main log: no file name', NAMES.every(n => !mainLog.includes(n)), NAMES.filter(n => mainLog.includes(n)).join(', '))
const guard = path.join(dataDir, 'electron', 'logs', 'net-guard.log')
const guardText = fs.existsSync(guard) ? fs.readFileSync(guard, 'utf8').trim() : ''
check('net-guard log: no outgoing request', guardText === '', guardText.split('\n').slice(0, 3).join(' | '))
console.log(`     the HTML path's own policy lines (older, the formatted-paste card): ${knownHtmlPath}`)
console.log(`     the table paste's own policy lines (the same formatted-paste card): ${knownTablePath}`)
check('no renderer console error or warning (no CSP line) at any image step', consoleLines.length === 0, consoleLines.slice(0, 3).join(' | '))
fs.rmSync(work, { recursive: true, force: true })
console.log(`\n${results.filter(Boolean).length} / ${results.length} OK`)
process.exit(results.every(Boolean) ? 0 : 1)
