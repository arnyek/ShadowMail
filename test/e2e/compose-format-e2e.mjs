#!/usr/bin/env node
// Bold, italic and underline in the composer, in the real app (headless Electron + Playwright). Not part of `npm test`.
//
//   node test/e2e/compose-format-e2e.mjs          (E2E_LANG=en: the same in English)
//
// 12 combinations of the keys and the buttons (with a quote and a list too), from two starts: a paragraph with its text
// selected, and the text emptied with Ctrl+A + Delete, typed in and selected. Each in a new composer window, sent to a
// local SMTP server: the asked formatting shows (computed style), the editor and the outgoing HTML hold b/i/u tags and no
// style attribute, no CSP line in the console. Then: each format pressed twice is off again; after a delete that empties
// the text the next typed text inherits no formatting or block, the signature block stays; Ctrl+B in the empty editor and
// typing gives bold; in a reply the quote stays; Ctrl+Z raises nothing. A formatted paste (Word, web, a styled list, a
// bold italic quote) emptied with Ctrl+A + Delete: the next typed, plain-pasted or HTML-pasted text is one plain paragraph,
// and Ctrl+Z brings the old text back; a quote or list chosen into it holds and takes nothing of the paste; with the
// signature block kept it is untouched. The main log has no error line.
// Playwright: PW=<path of the playwright package> (default: the repo's playwright-core devDependency).
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

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const MASTER = 'Teszt-mesterjelszo-formazas'
const ME = 'teszt@example.invalid'
const SUBJECT = 'Formázás próba'

const watchdog = setTimeout(() => {
  console.log('FAIL watchdog: the run took more than 8 minutes')
  process.exit(1)
}, 480_000)
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
  'From: Kovács Anna <anna@example.invalid>', `To: Teszt Elek <${ME}>`, 'Subject: =?utf-8?q?Form=C3=A1z=C3=A1s_pr=C3=B3ba?=',
  `Date: ${new Date().toUTCString()}`, 'Message-ID: <fmt-1@example.invalid>', 'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit', '', 'Az eredeti levél szövege.', '',
].join('\r\n')))

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-format-e2e-'))
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
const watch = w => {
  w.on('console', m => (m.type() === 'error' || m.type() === 'warning') && consoleLines.push(`${m.type()}: ${m.text()}`))
  w.on('pageerror', e => pageErrors.push(String(e)))
}
const csp = () => consoleLines.filter(l => /Content Security Policy/.test(l)).length
try {
  const page = await app.firstWindow()
  watch(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  await page.locator('.msg-row', { hasText: SUBJECT }).waitFor({ timeout: 20_000 })

  const ready = async win => {
    watch(win)
    await win.setViewportSize({ width: 900, height: 700 })
    await win.waitForFunction(() => document.querySelector('#compose-from')?.textContent.includes('@') && document.querySelector('.editor')?.textContent.includes('Elek'))
    return win
  }
  const newComposer = async () => ready((await Promise.all([app.waitForEvent('window', { timeout: 15_000 }), page.locator('.compose-button').click()]))[0])
  const key = k => win => win.keyboard.press(k)
  const btn = name => win => win.getByRole('button', { name: t.composeTools[name], exact: true }).click()
  const fromP = async win => win.locator('.editor').evaluate(el => {
    const p = document.createElement('p')
    p.textContent = 'Szöveg'
    el.prepend(p)
    el.focus()
    const r = document.createRange()
    r.selectNodeContents(p)
    const s = window.getSelection()
    s.removeAllRanges()
    s.addRange(r)
  })
  const fromTyped = async win => {
    await win.locator('.editor').click()
    await win.keyboard.press('Control+A')
    await win.keyboard.press('Delete')
    await win.keyboard.type('Szöveg')
    await win.keyboard.press('Shift+Home')
  }
  const state = win => win.locator('.editor').evaluate(el => {
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    let n
    while ((n = w.nextNode()) && n.textContent !== 'Szöveg' && !n.textContent.startsWith('Szöveg')) {}
    const cs = n ? getComputedStyle(n.parentElement) : null
    const tags = new Set()
    // an underline is drawn by the element that has it, it is not inherited as a computed value: look at the ancestors
    let underline = false
    for (let e = n?.parentElement; e && e !== el; e = e.parentElement) {
      tags.add(e.tagName.toLowerCase())
      if (/underline/.test(getComputedStyle(e).textDecorationLine)) underline = true
    }
    return {
      html: el.innerHTML,
      styled: el.querySelectorAll('[style]').length,
      tags: [...tags],
      italic: cs?.fontStyle === 'italic',
      bold: Number(cs?.fontWeight) >= 600,
      underline,
    }
  })
  const sendAndRead = async win => {
    await win.locator('#compose-to').fill('Címzett <cimzett@example.invalid>')
    await win.locator('#compose-subject').fill('Formázás')
    const before = received.length
    const closed = win.waitForEvent('close', { timeout: 30_000 })
    await win.getByRole('button', { name: t.composeSend, exact: true }).click({ noWaitAfter: true }).catch(e => {
      if (!win.isClosed()) throw e
    })
    await closed
    for (let i = 0; i < 50 && received.length === before; i++) await new Promise(r => setTimeout(r, 200))
    return received.length > before ? (await simpleParser(received[received.length - 1])).html || '' : ''
  }
  // [name, steps, expected b / i / u, and the block it must sit in]
  const cases = [
    ['Ctrl+B, Ctrl+I', [key('Control+B'), key('Control+I')], 'bi'],
    ['Bold button, Italic button', [btn('bold'), btn('italic')], 'bi'],
    ['Ctrl+I, Ctrl+B', [key('Control+I'), key('Control+B')], 'bi'],
    ['Ctrl+B, Ctrl+U', [key('Control+B'), key('Control+U')], 'bu'],
    ['Ctrl+B, Ctrl+I, Ctrl+U', [key('Control+B'), key('Control+I'), key('Control+U')], 'biu'],
    ['Ctrl+U, Ctrl+I', [key('Control+U'), key('Control+I')], 'iu'],
    ['Bold button, Underline button', [btn('bold'), btn('underline')], 'bu'],
    ['Italic button alone', [btn('italic')], 'i'],
    ['Ctrl+I, Ctrl+U', [key('Control+I'), key('Control+U')], 'iu'],
    ['Ctrl+B, Quote, Ctrl+I', [key('Control+B'), btn('quote'), key('Control+I')], 'bi', 'blockquote'],
    ['Bold button, List, Italic button', [btn('bold'), btn('ul'), btn('italic')], 'bi', 'li'],
    ['Ctrl+B, Ctrl+I, Ctrl+I (italic off again)', [key('Control+B'), key('Control+I'), key('Control+I')], 'b'],
    ['Ctrl+B twice', [key('Control+B'), key('Control+B')], ''],
    ['Italic button twice', [btn('italic'), btn('italic')], ''],
    ['Ctrl+U twice', [key('Control+U'), key('Control+U')], ''],
  ]
  const tagOf = { b: 'b', i: 'i', u: 'u' }
  for (const [startName, start] of [['paragraph', fromP], ['emptied and typed', fromTyped]]) {
    for (const [name, steps, want, block] of cases) {
      const win = await newComposer()
      await start(win)
      const before = csp()
      for (const step of steps) await step(win)
      await win.waitForTimeout(80)
      const s = await state(win)
      const shown = s.bold === want.includes('b') && s.italic === want.includes('i') && s.underline === want.includes('u')
      const tagsOk = [...'biu'].every(f => s.tags.includes(tagOf[f]) === want.includes(f)) && (!block || s.tags.includes(block))
      const out = await sendAndRead(win)
      const outPart = out.slice(0, out.indexOf('Szöveg') + 'Szöveg'.length + 20)
      const outOk = !/style=/i.test(out) && [...'biu'].every(f => new RegExp(`<${f}>[^]*Szöveg`).test(outPart) === want.includes(f))
      check(`${startName}, ${name}: shown, b/i/u tags in the editor and the outgoing HTML, no style, no CSP line`,
        shown && tagsOk && s.styled === 0 && outOk && csp() === before, `${s.html.slice(0, 140)} | out ${outPart.replace(/\s+/g, ' ').slice(0, 120)} | csp +${csp() - before}`)
    }
  }

  // a delete that empties the text: the next typed text inherits nothing; the signature block stays
  {
    const win = await newComposer()
    await fromP(win)
    for (const step of [key('Control+B'), key('Control+I'), btn('quote')]) await step(win)
    // only the formatted text, not the signature: select it and delete
    await win.locator('.editor').evaluate(el => {
      const q = el.querySelector('blockquote')
      const r = document.createRange()
      r.selectNodeContents(q)
      const s = window.getSelection()
      s.removeAllRanges()
      s.addRange(r)
    })
    await win.keyboard.press('Delete')
    await win.keyboard.type('Új szöveg')
    const html = await win.locator('.editor').innerHTML()
    const kept = await win.locator('.editor [data-sm-signature]').count()
    check('the formatted text deleted (the signature not): the typed text is plain, no block, the signature block stays',
      /^<p>Új szöveg<\/p>/.test(html) && !/<(b|i|u|blockquote|ul|li)\b/.test(html.split('<div data-sm-signature')[0]) && kept === 1 && html.includes('Üdv, Elek'), html.slice(0, 200))
    const out = await sendAndRead(win)
    check('... and it goes out so', /Új szöveg/.test(out) && !/<(b|i|u|blockquote)>[^<]*Új szöveg/.test(out) && !/style=/i.test(out), out.replace(/\s+/g, ' ').slice(0, 200))
  }
  // Ctrl+A + Delete, Ctrl+B in the empty editor, then typing: bold (the clean-up does not undo the wish)
  {
    const win = await newComposer()
    await win.locator('.editor').click()
    await win.keyboard.press('Control+A')
    await win.keyboard.press('Delete')
    await win.keyboard.press('Control+B')
    await win.keyboard.type('Kövér')
    const html = await win.locator('.editor').innerHTML()
    check('Ctrl+A + Delete, then Ctrl+B and typing: bold', /<b>Kövér<\/b>/.test(html), html.slice(0, 120))
    // a block command in the emptied editor is a wish too: the clean-up runs on deletes only
    await win.keyboard.press('Control+A')
    await win.keyboard.press('Delete')
    await win.getByRole('button', { name: t.composeTools.quote, exact: true }).click()
    await win.keyboard.type('Idézet')
    const quoted = await win.locator('.editor').innerHTML()
    check('Ctrl+A + Delete, then the Quote button and typing: the text is in a quote', /<blockquote>[^]*Idézet/.test(quoted), quoted.slice(0, 120))
    // Ctrl+Z after the formatting and after the clean-up: no exception, the editor stays an editor
    const errors = pageErrors.length
    for (let i = 0; i < 4; i++) await win.keyboard.press('Control+Z')
    const after = await win.locator('.editor').evaluate(el => ({ ok: el.isContentEditable, html: el.innerHTML }))
    check('Ctrl+Z four times after it: no exception, the editor is still editable', pageErrors.length === errors && after.ok, after.html.slice(0, 120))
    await win.close()
  }
  // the undo: Ctrl+A + Delete (and Ctrl+Shift+Home + Backspace), then the first Ctrl+Z brings the text back; typing
  // over the whole text (no Delete) is clean too, and Ctrl+Z brings the old text back
  for (const [name, empty] of [
    ['Ctrl+A + Delete', async win => { await win.keyboard.press('Control+A'); await win.keyboard.press('Delete') }],
    ['Ctrl+Shift+Home + Backspace', async win => { await win.keyboard.press('Control+End'); await win.keyboard.press('Control+Shift+Home'); await win.keyboard.press('Backspace') }],
  ]) {
    const win = await newComposer()
    await fromP(win)
    for (const step of [key('Control+B'), key('Control+I')]) await step(win)
    const before = await win.locator('.editor').innerText()
    await win.locator('.editor').click()
    await empty(win)
    await win.keyboard.press('Control+Z')
    const back = await win.locator('.editor').innerText()
    check(`${name}, then Ctrl+Z: the text is back at the first press`, back.includes('Szöveg') && back.trim() === before.trim(), JSON.stringify(back.slice(0, 60)))
    await empty(win)
    await win.keyboard.type('Tiszta')
    const typedHtml = await win.locator('.editor').innerHTML()
    check(`${name}, then typing: one plain paragraph, no inherited b/i/block, no style`, /<p>Tiszta<\/p>/.test(typedHtml) && !/<(b|i|u|blockquote|li)\b|style=/.test(typedHtml), typedHtml.slice(0, 120))
    await win.close()
  }
  {
    const win = await newComposer()
    await fromP(win)
    for (const step of [key('Control+B'), key('Control+I'), btn('quote')]) await step(win)
    const before = csp()
    await win.locator('.editor').click()
    await win.keyboard.press('Control+A')
    await win.keyboard.type('Felül')
    const over = await win.locator('.editor').innerHTML()
    check('Ctrl+A + typing over it: one plain paragraph, no inherited b/i/quote', /^<p>Felül/.test(over) && !/<(b|i|u|blockquote|li)\b|style=/.test(over), over.slice(0, 120))
    await win.keyboard.press('Shift+Home')
    await win.keyboard.press('Control+B')
    await win.keyboard.press('Control+I')
    const fmt = await win.locator('.editor').innerHTML()
    check('... then Ctrl+B + Ctrl+I: tags, no style, no CSP line', /<b>/.test(fmt) && /<i>/.test(fmt) && !/style=/.test(fmt) && csp() === before, `${fmt.slice(0, 120)} csp +${csp() - before}`)
    // every editing command is a step of the undo stack: count the presses (the typing, the formatting, the clean-up)
    let presses = 0
    for (; presses < 12 && !(await win.locator('.editor').innerText()).includes('Szöveg'); presses++) await win.keyboard.press('Control+Z')
    const undone = await win.locator('.editor').innerText()
    console.log(`MEASURED Ctrl+Z presses back to the old text after typing over it and formatting: ${presses}`)
    check('... and Ctrl+Z brings the old text back', undone.includes('Szöveg'), `${presses} presses ${JSON.stringify(undone.slice(0, 60))}`)
    await win.close()
  }
  // an inherited list (a bold list item emptied with Ctrl+A + Delete): the typed text is a plain paragraph
  {
    const win = await newComposer()
    await fromP(win)
    for (const step of [btn('bold'), btn('ul')]) await step(win)
    await win.locator('.editor').click()
    await win.keyboard.press('Control+A')
    await win.keyboard.press('Delete')
    await win.keyboard.type('Lista')
    const html = await win.locator('.editor').innerHTML()
    check('a bold list emptied with Ctrl+A + Delete, then typing: a plain paragraph, no list, no b', /<p>Lista<\/p>/.test(html) && !/<(ul|ol|li|b|i|u)\b|style=/.test(html), html.slice(0, 120))
    await win.close()
  }
  // the first input after the emptying is not a character: Enter (a new paragraph) or Shift+Enter (a line break), then
  // typing; and a composition (an IME or a dead key) as the first input. None inherits the deleted text's b/i or quote.
  // the text before the signature block, exactly: Enter's empty paragraph and Shift+Enter's line break stay (the first
  // character's clean-up must not reset the emptied text a second time, which deletes them)
  for (const [name, first, start] of [
    ['Enter', async win => win.keyboard.press('Enter'), '<p><br></p><p>Masodik</p>'],
    ['Shift+Enter', async win => win.keyboard.press('Shift+Enter'), '<p><br>Masodik</p>'],
  ]) {
    const win = await newComposer()
    await fromP(win)
    for (const step of [key('Control+B'), key('Control+I'), btn('quote')]) await step(win)
    const before = await win.locator('.editor').innerText()
    const cspBefore = csp()
    await win.locator('.editor').click()
    await win.keyboard.press('Control+A')
    await win.keyboard.press('Delete')
    await first(win)
    await win.keyboard.type('Masodik')
    const html = await win.locator('.editor').innerHTML()
    const lead = html.slice(0, html.indexOf('data-sm-signature') < 0 ? html.length : html.indexOf('data-sm-signature'))
    check(`Ctrl+A + Delete, then ${name} first and typing: its new line kept, no quote, no inherited b/i, no style, no CSP line`,
      lead === start && csp() === cspBefore, `${lead.slice(0, 140)} csp +${csp() - cspBefore}`)
    let presses = 0
    for (; presses < 12 && !(await win.locator('.editor').innerText()).includes('Szöveg'); presses++) await win.keyboard.press('Control+Z')
    const undone = await win.locator('.editor').innerText()
    check(`... and Ctrl+Z brings the deleted text back, as it was`, undone.trim() === before.trim(), `${presses} presses ${JSON.stringify(undone.slice(0, 60))}`)
    await win.close()
  }
  {
    const win = await newComposer()
    await fromP(win)
    for (const step of [key('Control+B'), key('Control+I'), btn('quote')]) await step(win)
    const cspBefore = csp()
    await win.locator('.editor').click()
    await win.keyboard.press('Control+A')
    await win.keyboard.press('Delete')
    // the composition through the DevTools protocol (headless has no IME): a dead key's accent, then the composed letter
    const cdp = await win.context().newCDPSession(win)
    const events = await win.locator('.editor').evaluate(el => {
      window.__composeEvents = []
      for (const type of ['compositionstart', 'compositionend']) el.addEventListener(type, () => window.__composeEvents.push(type))
      return true
    })
    await cdp.send('Input.imeSetComposition', { text: '´', selectionStart: 1, selectionEnd: 1 })
    await cdp.send('Input.insertText', { text: 'á' })
    await win.keyboard.type('bc')
    const seen = await win.evaluate(() => window.__composeEvents)
    const html = await win.locator('.editor').innerHTML()
    const lead = html.slice(0, html.indexOf('data-sm-signature') < 0 ? html.length : html.indexOf('data-sm-signature'))
    const text = await win.locator('.editor').innerText()
    console.log(`MEASURED composition events (headless, CDP): ${JSON.stringify(seen)} (listener ${events})`)
    check('Ctrl+A + Delete, then a composition first: the letter once, no inherited b/i or quote, no style, no CSP line',
      /<p>ábc<\/p>/.test(lead) && (text.match(/á/g) || []).length === 1 && !/´/.test(text) && !/<(b|i|u|blockquote|li)\b|style=/.test(lead) && csp() === cspBefore,
      `${lead.slice(0, 140)} csp +${csp() - cspBefore}`)
    await win.close()
  }
  // one Backspace is no new start: Ctrl+B, x, Backspace, y = a bold y
  {
    const win = await newComposer()
    await win.locator('.editor').click()
    await win.keyboard.press('Control+Home')
    await win.keyboard.press('Control+B')
    await win.keyboard.type('x')
    await win.keyboard.press('Backspace')
    await win.keyboard.type('y')
    const html = await win.locator('.editor').innerHTML()
    check('Ctrl+B, x, Backspace, y: the y is bold (one Backspace keeps the formatting)', /<b>y<\/b>/.test(html), html.slice(0, 120))
    await win.close()
  }
  // a formatted paste, then the text emptied: the next typed or pasted text starts as one plain paragraph. The emptied
  // block keeps the paste's own style (a <div style>, the remembered font size of a span) unless the clean-up drops it,
  // and a paste inserts with its own command (no beforeinput), so both paste paths ask the clean-up first
  const paste = (win, htmlText, plain) => win.locator('.editor').evaluate((el, [h, p]) => {
    const dt = new DataTransfer()
    if (h) dt.setData('text/html', h)
    dt.setData('text/plain', p)
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, [htmlText, plain])
  const WORD = '<html><body><!--StartFragment--><p class=MsoNormal><b><span style="font-size:11.0pt;mso-bidi-font-weight:normal">Word felkövér</span></b> <i>dőlt</i></p><!--EndFragment--></body></html>'
  const WEB = '<meta charset="utf-8"><div style="color:#c00;font-family:Arial"><strong>Web erős</strong> <em>hangsúly</em></div><ul><li>elem</li></ul>'
  const LIST = '<ol style="color:green"><li style="font-size:18px"><u>Egy</u></li><li>Kettő</li></ol>'
  const filled = {
    'a Word paste': [win => paste(win, WORD, 'Word felkövér dőlt'), 'Word felkövér'],
    'a web paste': [win => paste(win, WEB, 'Web erős hangsúly elem'), 'Web erős'],
    'a styled list paste': [win => paste(win, LIST, 'Egy Kettő'), 'Egy'],
    'a bold italic quote': [async win => {
      await fromP(win)
      for (const step of [key('Control+B'), key('Control+I'), btn('quote')]) await step(win)
    }, 'Szöveg'],
  }
  const next = {
    typing: win => win.keyboard.type('Utána'),
    'a plain paste': win => paste(win, '', 'Utána'),
    'an HTML paste': win => paste(win, '<p>Utána</p>', 'Utána'),
  }
  for (const [fillName, [fill, mark]] of Object.entries(filled)) {
    for (const [nextName, then] of Object.entries(next)) {
      const win = await newComposer()
      await win.locator('.editor').click()
      await win.keyboard.press('Control+Home')
      await fill(win)
      await win.waitForTimeout(60)
      await win.locator('.editor').click()
      await win.keyboard.press('Control+A')
      await win.keyboard.press('Delete')
      const before = csp()
      await then(win)
      await win.waitForTimeout(60)
      const html = await win.locator('.editor').innerHTML()
      check(`${fillName}, Ctrl+A + Delete, then ${nextName}: one plain paragraph, nothing inherited, no CSP line`,
        html === '<p>Utána</p>' && csp() === before, `${html.slice(0, 160)} | csp +${csp() - before}`)
      let presses = 0
      for (; presses < 12 && !(await win.locator('.editor').innerText()).includes(mark); presses++) await win.keyboard.press('Control+Z')
      check(`... and Ctrl+Z brings the old text back`, (await win.locator('.editor').innerText()).includes(mark), `${presses} presses`)
      await win.close()
    }
  }
  // the wish after the emptying holds for a paste too: Ctrl+B, then a plain paste is bold
  {
    const win = await newComposer()
    await win.locator('.editor').click()
    await win.keyboard.press('Control+Home')
    await paste(win, WORD, 'Word felkövér dőlt')
    await win.locator('.editor').click()
    await win.keyboard.press('Control+A')
    await win.keyboard.press('Delete')
    await win.keyboard.press('Control+B')
    await paste(win, '', 'Kövér')
    const html = await win.locator('.editor').innerHTML()
    check('a Word paste, Ctrl+A + Delete, Ctrl+B, then a plain paste: bold, nothing else', html === '<p><b>Kövér</b></p>', html.slice(0, 120))
    await win.close()
  }
  // a quote or a list chosen into the emptied text: the choice holds, nothing of the deleted paste comes with it (the
  // plain start comes before the block command; a list made in a paragraph would land inside it)
  for (const [tool, want] of [['quote', '<blockquote>Utána</blockquote>'], ['ul', '<ul><li>Utána</li></ul>']]) {
    for (const [fillName, [fill]] of Object.entries(filled).filter(([n]) => n !== 'a bold italic quote')) {
      const win = await newComposer()
      await win.locator('.editor').click()
      await win.keyboard.press('Control+Home')
      await fill(win)
      await win.waitForTimeout(60)
      await win.locator('.editor').click()
      await win.keyboard.press('Control+A')
      await win.keyboard.press('Delete')
      await btn(tool)(win)
      const before = csp()
      await paste(win, '', 'Utána')
      const html = await win.locator('.editor').innerHTML()
      check(`${fillName}, Ctrl+A + Delete, the ${tool} button, then a plain paste: ${want}, nothing of the paste`, html === want && csp() === before, html.slice(0, 160))
      await win.close()
    }
  }
  // only the text emptied (the signature block stays): the signature is untouched, the pasted text inherits no quote,
  // bold, italic, font size or block style (a style-free wrapper <div> of the paste may stay). Not the web paste: its
  // emptied block's own style stays there (MEASURED: no editing command takes a block's style off, and a delete up to the
  // signature block pulls the signature's first line up)
  for (const [fillName, [fill]] of Object.entries(filled).filter(([n]) => n !== 'a web paste')) {
    const win = await newComposer()
    await win.locator('.editor').click()
    await win.keyboard.press('Control+Home')
    await fill(win)
    await win.waitForTimeout(60)
    const sigBefore = await win.locator('.editor [data-sm-signature]').evaluate(s => s.outerHTML)
    await win.locator('.editor').evaluate(el => {
      const sig = el.querySelector('[data-sm-signature]')
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      let last = null
      for (let n = w.nextNode(); n; n = w.nextNode()) if (!sig.contains(n)) last = n
      el.focus()
      const r = document.createRange()
      r.setStart(el, 0)
      r.setEnd(last, last.length)
      const s = window.getSelection()
      s.removeAllRanges()
      s.addRange(r)
    })
    await win.keyboard.press('Delete')
    const before = csp()
    await paste(win, '', 'Utána')
    const html = await win.locator('.editor').innerHTML()
    const text = html.split('<div data-sm-signature')[0]
    const sigAfter = await win.locator('.editor [data-sm-signature]').evaluate(s => s.outerHTML)
    check(`${fillName}, only the text deleted, then a plain paste: no b/i/quote/style, the signature block as it was`,
      /<p>Utána<\/p>/.test(text) && !/<(b|i|u|blockquote|span|font)\b|style=/.test(text) && sigAfter === sigBefore && csp() === before, html.slice(0, 200))
    await win.close()
  }
  // the same with the signature block kept, then a list or a quote chosen: the list is not made inside a paragraph
  // (<p><ul> is the editor's own way in an empty paragraph, a plain one too)
  for (const [fillName, [fill]] of Object.entries(filled).filter(([n]) => n === 'a Word paste' || n === 'a styled list paste')) {
    for (const [tool, tag] of [['ul', 'ul'], ['ol', 'ol'], ['quote', 'blockquote']]) {
      const win = await newComposer()
      await win.locator('.editor').click()
      await win.keyboard.press('Control+Home')
      await fill(win)
      await win.waitForTimeout(60)
      const sigBefore = await win.locator('.editor [data-sm-signature]').evaluate(s => s.outerHTML)
      await win.locator('.editor').evaluate(el => {
        const sig = el.querySelector('[data-sm-signature]')
        const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
        let last = null
        for (let n = w.nextNode(); n; n = w.nextNode()) if (!sig.contains(n)) last = n
        el.focus()
        const r = document.createRange()
        r.setStart(el, 0)
        r.setEnd(last, last.length)
        const s = window.getSelection()
        s.removeAllRanges()
        s.addRange(r)
      })
      await win.keyboard.press('Delete')
      await btn(tool)(win)
      await paste(win, '', 'Utána')
      const html = await win.locator('.editor').innerHTML()
      const text = html.split('<div data-sm-signature')[0]
      const sigAfter = await win.locator('.editor [data-sm-signature]').evaluate(s => s.outerHTML)
      check(`${fillName}, only the text deleted, the ${tool} button, then a plain paste: in a ${tag}, not inside a paragraph, nothing of the paste`,
        new RegExp(`<${tag}>(<li>)?Utána`).test(text) && !/<p[^>]*>\s*<(ul|ol|blockquote)|style=|<(span|font|b|i|u)\b/.test(text) && sigAfter === sigBefore, html.slice(0, 200))
      await win.close()
    }
  }
  // a reply: deleting the typed text above the quote does not run the clean-up
  {
    await page.locator('.msg-row', { hasText: SUBJECT }).click()
    await page.locator('.reader-tools').waitFor()
    const win = await ready((await Promise.all([app.waitForEvent('window', { timeout: 15_000 }), page.locator('.reader-tools').getByRole('button', { name: t.replyModes.reply, exact: true }).click()]))[0])
    await win.locator('.editor').click()
    await win.keyboard.press('Control+Home')
    await win.keyboard.type('Válasz')
    await win.keyboard.press('Shift+Home')
    await win.keyboard.press('Delete')
    const html = await win.locator('.editor').innerHTML()
    check('a reply: the typed text deleted, the quote stays', /<blockquote/.test(html) && html.includes('Az eredeti levél szövege.'), html.slice(0, 160))
    await win.close()
  }
} catch (err) {
  check('the run finished', false, err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : String(err))
} finally {
  await app.close().catch(() => {})
  await pop.close()
  await new Promise(r => smtp.close(r))
}
const mainLog = fs.readFileSync(path.join(dataDir, 'electron', 'logs', 'main.log'), 'utf8')
check('the main log: no error or failure line', !/failed|error/i.test(mainLog), mainLog.trim().split('\n').filter(l => /failed|error/i.test(l)).join(' | '))
check('no renderer console error or warning, no page exception', consoleLines.length === 0 && pageErrors.length === 0, [...consoleLines, ...pageErrors].slice(0, 3).join(' | '))
fs.rmSync(work, { recursive: true, force: true })
console.log(`\n${results.filter(Boolean).length} / ${results.length} OK`)
process.exit(results.every(Boolean) ? 0 : 1)
