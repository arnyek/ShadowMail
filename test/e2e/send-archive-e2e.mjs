#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// "Küldés és archiválás" in the real app (headless Electron + Playwright). Not part of `npm test`.
//
//   node test/e2e/send-archive-e2e.mjs        (E2E_LANG=en: the same in English; E2E_THEME=<id>: under that theme)
//
// Two POP3 accounts (fake POP3 servers) and a local SMTP server (it refuses nincs@example.invalid). The first account has
// a local "Archívum", the second none. Measured:
// 1. A reply: the button between Küldés and Küldés később, its name, title and keys; the footer at widths from 900 px
//    down: no horizontal overflow, under the breakpoint only the icon (the name in aria-label and title). A click: the
//    window closes, the SMTP server got it, the original left the inbox list and is in the Archive, answered.
// 2. A forward with Ctrl+Shift+Enter: archived, forwarded.
// 3. Reply all: Ctrl+Shift+Enter under an open suggestion list picks it, sends and archives nothing; then Ctrl+Enter:
//    sent, the original stays in the inbox, answered.
// 4. A refused recipient: the window stays open with the sentence, the original stays; no key sends again.
// 5. A new message: no button; Ctrl+Enter under an open recipient suggestion list picks it and sends nothing;
//    Ctrl+Shift+Enter does nothing, nor Ctrl+Enter under the "Küldés később" dialog;
//    Ctrl+Enter after it sends. The new message's footer at the same widths (the reference).
// 6. The account without an Archive: no button on a reply.
// 7. The main window's list while it is sent (the SMTP server holds the data a moment): the original greyed out at once
//    (leaving) in 1., then gone; back (not leaving) after the refused recipient of 4. and after a failed send.
// The main log has no error line, no console error or warning in any window.
// Playwright: PW=<path of the playwright package> (default: the repo's playwright-core devDependency).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { SMTPServer } from 'smtp-server'
import { FakePop3Server } from '../helpers/fake-pop3.js'
import { MailIndex } from '../../core/db/mail-index.js'
import { createVaultedDatabase } from '../../core/vault/vaulted-db.js'
import { AccountStore } from '../../core/accounts/model.js'
import { newAccountDefaults } from '../../core/accounts/defaults.js'
import { t, seedLanguage } from './lang.mjs'
import { useTheme, e2eTheme } from './theme-env.mjs'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const MASTER = 'Teszt-mesterjelszo-kuldes-archivalas'
const ME = 'teszt@example.invalid'
const WIDTHS = [900, 800, 760, 744, 740, 720, 700, 640, 600, 560, 540, 520, 500, 480, 440, 400, 360, 320]
const sleep = ms => new Promise(r => setTimeout(r, ms))

const watchdog = setTimeout(() => {
  console.log('FAIL watchdog: the run took more than 4 minutes')
  process.exit(1)
}, 240_000)
watchdog.unref()

const received = []
let holdMs = 0 // the SMTP server waits this long before it answers the data
let refuseData = false // the SMTP server refuses the next message's data
const smtp = new SMTPServer({
  disabledCommands: ['STARTTLS'], allowInsecureAuth: true, authMethods: ['PLAIN', 'LOGIN'], logger: false,
  onAuth: (a, _s, cb) => cb(null, { user: a.username }),
  onRcptTo: (address, _s, cb) => (address.address === 'nincs@example.invalid' ? cb(Object.assign(new Error('No such user here'), { responseCode: 550 })) : cb()),
  onData(stream, session, cb) {
    const chunks = []
    stream.on('data', c => chunks.push(c))
    stream.on('end', () =>
      setTimeout(() => {
        if (refuseData) {
          refuseData = false
          return cb(Object.assign(new Error('Message refused'), { responseCode: 554 }))
        }
        received.push(Buffer.concat(chunks))
        cb()
      }, holdMs),
    )
  },
})
smtp.on('error', () => {})
await new Promise(r => smtp.listen(0, '127.0.0.1', r))

const mail = (n, subject) =>
  Buffer.from([`From: Kovács Anna <anna@example.invalid>`, `To: Teszt Elek <${ME}>`, `Subject: ${subject}`, `Date: ${new Date().toUTCString()}`, `Message-ID: <ka-${n}@example.invalid>`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', `Kérdés szövege ${n}.`, ''].join('\r\n'))
const popA = await new FakePop3Server().listen()
for (let i = 1; i <= 5; i++) popA.add(mail(i, `Kerdes ${i}`))
const popB = await new FakePop3Server().listen()
popB.add(mail(9, 'Masik fiok kerdese'))

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-send-archive-e2e-'))
const dataDir = path.join(work, 'data')
fs.mkdirSync(dataDir)
seedLanguage(dataDir)
let accA, accB
{
  const { db, vault } = await createVaultedDatabase(dataDir, MASTER)
  const store = new AccountStore(db, vault, { storeDir: path.join(dataDir, 'store') })
  const base = { display_name: 'Teszt Elek', in_host: '127.0.0.1', in_security: 'none', smtp_host: '127.0.0.1', smtp_port: smtp.server.address().port, smtp_security: 'none' }
  accA = store.save({ ...newAccountDefaults('pop3'), ...base, name: 'Archivalo', email: ME, in_port: popA.port, in_user: popA.user, in_password: popA.pass }).account.id
  accB = store.save({ ...newAccountDefaults('pop3'), ...base, name: 'Archivum nelkul', email: 'masik@example.invalid', in_port: popB.port, in_user: popB.user, in_password: popB.pass }).account.id
  new MailIndex(db).addFolder(accA, 'Archívum', '/', true)
  db.close()
}

const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const consoleLines = []
const watch = (win, where) => {
  win.on('console', m => (m.type() === 'error' || m.type() === 'warning') && consoleLines.push(`${where} ${m.type()}: ${m.text()}`))
  win.on('pageerror', e => consoleLines.push(`${where} pageerror: ${e.message}`))
}
const app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
try {
  const page = await app.firstWindow()
  watch(page, 'main')
  await page.setViewportSize({ width: 1280, height: 900 })
  await useTheme(app, page)
  if (e2eTheme) console.log(`THEME ${await page.evaluate(() => `${document.documentElement.dataset.theme} ${document.documentElement.dataset.density}`)}`)
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  const folderOf = (acc, p) => page.locator(`.folder-tree section[data-account="${acc}"] .folder[data-path="${p}"]`)
  const row = s => page.locator('.msg-row', { hasText: s })
  const rowsOf = (acc, folder) =>
    page.evaluate(async q => {
      const res = await window.shadowMail.mail.list({ ...q, sort: 'date', dir: 'asc', offset: 0, limit: 50 })
      return res.ok ? res.rows.map(r => ({ subject: r.subject, flags: r.flags || '' })) : []
    }, { accountId: acc, folder })
  const until = async (fn, what, ms = 10_000) => {
    const t0 = performance.now()
    while (!(await fn())) {
      if (performance.now() - t0 > ms) throw new Error(`timed out: ${what}`)
      await sleep(50)
    }
  }
  let composers = 0
  const composerOf = async click => {
    const [win] = await Promise.all([app.waitForEvent('window', { timeout: 15_000 }), click()])
    watch(win, `composer${++composers}`)
    await win.setViewportSize({ width: 900, height: 700 })
    await win.locator('.compose-actions').waitFor({ timeout: 15_000 })
    await win.waitForFunction(() => document.querySelector('.editor') && document.querySelector('.editor').innerHTML.length > 0)
    await win.waitForTimeout(200)
    return win
  }
  const openMessage = async (acc, subject) => {
    await folderOf(acc, 'INBOX').click()
    await row(subject).waitFor({ timeout: 20_000 })
    await row(subject).click()
    await page.locator('.reader-tools').waitFor({ timeout: 10_000 })
    await page.waitForTimeout(300) // the account's folders are known by then
  }
  const replyWith = mode => composerOf(() => page.locator('.reader-tools').getByRole('button', { name: t.replyModes[mode], exact: true }).click())
  const back = async () => {
    if (await page.locator('.reader-back').count()) await page.locator('.reader-back').click()
  }
  // a click or key that closes its window: the close event is what counts (the window may go before the click ends)
  const closing = async (win, act) => {
    const closed = win.waitForEvent('close', { timeout: 30_000 })
    await act().catch(e => {
      if (!win.isClosed()) throw e
    })
    await closed
  }
  const footerAt = (win, width) =>
    win.setViewportSize({ width, height: 700 }).then(() =>
      win.waitForTimeout(80).then(() =>
        win.evaluate(() => {
          const f = document.querySelector('.compose-actions')
          const b = document.querySelector('.compose-send-archive')
          const text = document.querySelector('.compose-send-archive-text')
          return {
            over: f.scrollWidth - f.clientWidth,
            page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            text: Boolean(text && text.getBoundingClientRect().width > 0),
            button: b ? Math.round(b.getBoundingClientRect().width) : null,
            height: b ? Math.round(b.getBoundingClientRect().height) : null,
            inside: [...f.querySelectorAll('button')].every(x => x.getBoundingClientRect().right <= f.getBoundingClientRect().right + 0.5),
            rows: new Set([...f.children].filter(x => x.getBoundingClientRect().width > 0).map(x => Math.round((x.getBoundingClientRect().top + x.getBoundingClientRect().height / 2) / 8))).size,
          }
        }),
      ),
    )

  await until(async () => popA.log.includes('QUIT') && popB.log.includes('QUIT'), 'the first POP3 fetches', 25_000)
  await page.locator('.reader-pane-switch').click() // none -> right: the list stays in sight beside the open message
  const leavingNow = subject => row(subject).evaluateAll(els => els.map(e => e.classList.contains('leaving')))

  // 1. a reply: the button, its place, its names; the footer by width; a click archives
  await openMessage(accA, 'Kerdes 1')
  let win = await replyWith('reply')
  const footer = await win.evaluate(() => [...document.querySelector('.compose-actions').children].map(e => e.className))
  const at = c => footer.findIndex(x => x.includes(c))
  check('reply: the button between Küldés and Küldés később', at('btn-primary') === 0 && at('compose-send-archive') === 1 && at('compose-send-later') === 2, JSON.stringify(footer.slice(0, 3)))
  const attrs = await win.evaluate(() => {
    const a = document.querySelector('.compose-send-archive')
    const s = document.querySelector('.compose-actions > .btn-primary')
    return { name: a.getAttribute('aria-label'), title: a.title, keys: a.getAttribute('aria-keyshortcuts'), text: a.textContent.trim(), sendTitle: s.title, sendKeys: s.getAttribute('aria-keyshortcuts') }
  })
  check('reply: name, title and key of both buttons', attrs.name === t.composeSendArchive && attrs.text === t.composeSendArchive && attrs.title === t.composeSendArchiveTitle && attrs.keys === 'Control+Shift+Enter' && attrs.sendTitle === t.composeSendTitle && attrs.sendKeys === 'Control+Enter', JSON.stringify(attrs))
  check('reply: found by its accessible name', (await win.getByRole('button', { name: t.composeSendArchive, exact: true }).count()) === 1)
  const widths = []
  for (const w of WIDTHS) widths.push([w, await footerAt(win, w)])
  console.log(`MEASURED reply footer [width, overflow, label, button px, rows]: ${JSON.stringify(widths.map(([w, m]) => [w, m.over, m.text ? 'text' : 'icon', m.button, m.rows]))}`)
  await win.setViewportSize({ width: 900, height: 700 })
  await win.waitForTimeout(80)

  // 5 (first half): a new message's footer at the same widths: the reference for the narrowest composer
  const newWin = await composerOf(() => page.getByRole('button', { name: t.newMessage, exact: true }).click())
  const reference = []
  for (const w of WIDTHS) reference.push([w, await footerAt(newWin, w)])
  console.log(`MEASURED new message footer [width, overflow, rows]: ${JSON.stringify(reference.map(([w, m]) => [w, m.over, m.rows]))}`)
  const replyAt = new Map(widths)
  check(`reply footer: no horizontal overflow at any width (${WIDTHS[WIDTHS.length - 1]}-${WIDTHS[0]} px)`, widths.every(([, m]) => m.over <= 0 && m.inside), JSON.stringify(widths.filter(([, m]) => m.over > 0 || !m.inside).map(([w, m]) => [w, m])))
  check('new message footer: no horizontal overflow at any width', reference.every(([, m]) => m.over <= 0))
  // the page itself: below ~425 px the composer's other parts run over (the new message too, before this change); the
  // reply page must not run over more than the new message's at any width
  console.log(`MEASURED page overflow [width, reply, new message]: ${JSON.stringify(widths.map(([w, m], i) => [w, m.page, reference[i][1].page]))}`)
  check('the page: the reply runs over nowhere more than the new message', widths.every(([, m], i) => m.page <= reference[i][1].page))
  check('reply footer: the name shown at 900 and 800 px, one row', [900, 800].every(w => replyAt.get(w).text && replyAt.get(w).rows === 1))
  const iconOnly = widths.filter(([, m]) => !m.text)
  check('reply footer: narrow, only the icon, a square button', iconOnly.length > 0 && iconOnly.every(([, m]) => m.button === m.height), JSON.stringify(iconOnly.map(([w, m]) => [w, m.button, m.height])))
  check('reply footer: one row wherever the label goes (icon from 744 px down) as long as the new message has one row less 40 px', widths.every(([w, m]) => m.rows === 1 || (reference.find(([x]) => x === w)?.[1].rows ?? 1) > 1 || w < Math.min(...reference.filter(([, r]) => r.rows === 1).map(([x]) => x)) + 48), JSON.stringify(widths.map(([w, m]) => [w, m.rows])))
  await newWin.setViewportSize({ width: 900, height: 700 })
  check('new message: no "Küldés és archiválás"', (await newWin.locator('.compose-send-archive').count()) === 0)

  // 1 (second half): the click; the main window's row greyed out while the SMTP server holds the data
  const before1 = received.length
  holdMs = 2000
  const closed1 = closing(win, () => win.getByRole('button', { name: t.composeSendArchive, exact: true }).click({ noWaitAfter: true }))
  await until(async () => (await leavingNow('Kerdes 1')).includes(true), 'Kerdes 1 leaving', 1500).catch(() => {})
  const during1 = await leavingNow('Kerdes 1')
  check('the main window while it is sent: the original greyed out at once (leaving)', JSON.stringify(during1) === '[true]', JSON.stringify(during1))
  await closed1
  holdMs = 0
  await until(async () => (await rowsOf(accA, 'Archívum')).some(r => r.subject === 'Kerdes 1'), 'Kerdes 1 in the Archive')
  check('the click: sent once', received.length === before1 + 1, `${received.length - before1}`)
  const arch1 = (await rowsOf(accA, 'Archívum')).find(r => r.subject === 'Kerdes 1')
  check('the click: the original in the Archive, answered', /\\Answered/.test(arch1.flags), arch1.flags)
  await back()
  await folderOf(accA, 'INBOX').click()
  await row('Kerdes 2').waitFor()
  await until(async () => (await row('Kerdes 1').count()) === 0, 'Kerdes 1 gone from the inbox list', 5000).catch(() => {})
  check('the main window: the original gone from the inbox list', (await row('Kerdes 1').count()) === 0)
  await folderOf(accA, 'Archívum').click()
  await row('Kerdes 1').waitFor({ timeout: 5000 }).catch(() => {})
  check('the main window: the original in the Archive list', (await row('Kerdes 1').count()) === 1)

  // 2. a forward, Ctrl+Shift+Enter
  await openMessage(accA, 'Kerdes 2')
  win = await replyWith('forward')
  check('forward: the button is there', (await win.locator('.compose-send-archive').count()) === 1)
  await win.locator('#compose-to').fill('Címzett Béla <bela@example.invalid>')
  await win.locator('.editor').click()
  const before2 = received.length
  await closing(win, () => win.keyboard.press('Control+Shift+Enter'))
  await until(async () => (await rowsOf(accA, 'Archívum')).some(r => r.subject === 'Kerdes 2'), 'Kerdes 2 in the Archive')
  const arch2 = (await rowsOf(accA, 'Archívum')).find(r => r.subject === 'Kerdes 2')
  check('Ctrl+Shift+Enter on a forward: sent, archived, forwarded', received.length === before2 + 1 && /\$Forwarded/.test(arch2.flags), arch2.flags)
  await back()

  // 3. reply all, Ctrl+Enter
  await openMessage(accA, 'Kerdes 3')
  win = await replyWith('replyAll')
  check('reply all: the button is there', (await win.locator('.compose-send-archive').count()) === 1)
  // an open suggestion list under the To field: Ctrl+Shift+Enter picks the suggestion, sends and archives nothing
  const before3 = received.length
  await win.locator('#compose-to').click()
  await win.keyboard.press('End')
  await win.keyboard.type(', an')
  await win.locator('.suggestions').waitFor({ timeout: 5000 })
  await win.keyboard.press('Control+Shift+Enter')
  await win.waitForTimeout(800)
  const to3 = await win.locator('#compose-to').inputValue()
  check('an open suggestion list: Ctrl+Shift+Enter picks it, sends nothing, archives nothing', received.length === before3 && !win.isClosed() && /anna@example\.invalid>, $/.test(to3) && (await rowsOf(accA, 'INBOX')).some(r => r.subject === 'Kerdes 3'), to3)
  await win.locator('.editor').click()
  await closing(win, () => win.keyboard.press('Control+Enter'))
  await until(async () => (await rowsOf(accA, 'INBOX')).some(r => r.subject === 'Kerdes 3' && /\\Answered/.test(r.flags)), 'Kerdes 3 answered')
  check('Ctrl+Enter: sent once, the original stays in the inbox, answered', received.length === before3 + 1 && !(await rowsOf(accA, 'Archívum')).some(r => r.subject === 'Kerdes 3'))
  await back()

  // 4. a refused recipient: the window stays open with the sentence; no key sends again
  await openMessage(accA, 'Kerdes 4')
  win = await replyWith('reply')
  await win.locator('#compose-to').fill('anna@example.invalid, nincs@example.invalid')
  const before4 = received.length
  holdMs = 2000
  await win.getByRole('button', { name: t.composeSendArchive, exact: true }).click()
  await until(async () => (await leavingNow('Kerdes 4')).includes(true), 'Kerdes 4 leaving', 1500).catch(() => {})
  check('refused recipient: greyed out while it is sent', JSON.stringify(await leavingNow('Kerdes 4')) === '[true]')
  const sentence = t.composeSentWithWarnings([], ['archive_rejected']).replace(t.composeSentWithWarnings([], []), '').trim()
  await win.getByText(sentence, { exact: false }).first().waitFor({ timeout: 15_000 })
  check('refused recipient: the window open with the sentence', !win.isClosed() && (await win.getByText(sentence, { exact: false }).count()) > 0, sentence)
  holdMs = 0
  check('refused recipient: sent once, the original stays in the inbox', received.length === before4 + 1 && (await rowsOf(accA, 'INBOX')).some(r => r.subject === 'Kerdes 4'))
  await until(async () => JSON.stringify(await leavingNow('Kerdes 4')) === '[false]', 'Kerdes 4 back', 3000).catch(() => {})
  check('refused recipient: the row back in the list, not greyed out', JSON.stringify(await leavingNow('Kerdes 4')) === '[false]', JSON.stringify(await leavingNow('Kerdes 4')))
  await win.locator('.editor').click({ force: true }).catch(() => {})
  await win.keyboard.press('Control+Enter')
  await win.keyboard.press('Control+Shift+Enter')
  await win.waitForTimeout(800)
  check('after the send: no key sends again', received.length === before4 + 1, `${received.length - before4}`)
  await closing(win, () => win.getByRole('button', { name: t.composeCloseWindow, exact: true }).click({ noWaitAfter: true }))
  await back()

  // 7. a failed send with archive: the row comes back, the original stays
  await openMessage(accA, 'Kerdes 5')
  win = await replyWith('reply')
  refuseData = true
  holdMs = 1500
  await win.getByRole('button', { name: t.composeSendArchive, exact: true }).click()
  await until(async () => (await leavingNow('Kerdes 5')).includes(true), 'Kerdes 5 leaving', 1200).catch(() => {})
  check('a failed send: greyed out while it is tried', JSON.stringify(await leavingNow('Kerdes 5')) === '[true]')
  await win.locator('.compose-error, [role="alert"]').first().waitFor({ timeout: 20_000 })
  holdMs = 0
  await until(async () => JSON.stringify(await leavingNow('Kerdes 5')) === '[false]', 'Kerdes 5 back', 3000).catch(() => {})
  check('a failed send: the window open with its error, the row back, the original in the inbox', !win.isClosed() && JSON.stringify(await leavingNow('Kerdes 5')) === '[false]' && (await rowsOf(accA, 'INBOX')).some(r => r.subject === 'Kerdes 5'), JSON.stringify(await leavingNow('Kerdes 5')))
  await closing(win, async () => {
    await win.getByRole('button', { name: t.composeCloseWindow, exact: true }).click({ noWaitAfter: true })
    // a failed send keeps a draft: closing asks nothing more then; if it asks, the answer is to close
    const ask = win.locator('[role="alertdialog"] button').first()
    if (await ask.count().catch(() => 0)) await ask.click({ noWaitAfter: true }).catch(() => {})
  })

  // 5 (second half): the new message's keys; first an open suggestion list: Ctrl+Enter picks, sends nothing
  await newWin.locator('#compose-to').click()
  await newWin.keyboard.type('an')
  await newWin.locator('.suggestions').waitFor({ timeout: 5000 })
  const beforeList = received.length
  await newWin.keyboard.press('Control+Enter')
  await newWin.waitForTimeout(800)
  const toList = await newWin.locator('#compose-to').inputValue()
  check('an open suggestion list: Ctrl+Enter picks it and sends nothing', received.length === beforeList && !newWin.isClosed() && /anna@example\.invalid>, $/.test(toList), toList)
  await newWin.locator('#compose-to').fill('bela@example.invalid')
  await newWin.locator('#compose-subject').fill('Uj level')
  await newWin.locator('.editor').click()
  const before5 = received.length
  await newWin.keyboard.press('Control+Shift+Enter')
  await newWin.waitForTimeout(800)
  check('new message: Ctrl+Shift+Enter does nothing', received.length === before5 && !newWin.isClosed())
  await newWin.getByRole('button', { name: t.composeSendLater, exact: true }).click()
  await newWin.locator('[role="dialog"]').waitFor()
  await newWin.keyboard.press('Control+Enter')
  await newWin.waitForTimeout(800)
  check('under the "Küldés később" dialog: Ctrl+Enter does nothing', received.length === before5 && !newWin.isClosed())
  await newWin.keyboard.press('Escape')
  await newWin.locator('[role="dialog"]').waitFor({ state: 'detached' })
  await newWin.locator('.editor').click()
  await closing(newWin, () => newWin.keyboard.press('Control+Enter'))
  check('new message: Ctrl+Enter sends', received.length === before5 + 1)

  // 6. the account without an Archive
  await openMessage(accB, 'Masik fiok kerdese')
  win = await replyWith('reply')
  check('an account without an Archive: no button on a reply', (await win.locator('.compose-send-archive').count()) === 0)
  await closing(win, () => win.getByRole('button', { name: t.composeCloseWindow, exact: true }).click({ noWaitAfter: true }))
} catch (err) {
  check('the run finished', false, err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : String(err))
} finally {
  await app.close().catch(() => {})
  await popA.close()
  await popB.close()
  await new Promise(r => smtp.close(r))
}
const mainLog = fs.readFileSync(path.join(dataDir, 'electron', 'logs', 'main.log'), 'utf8')
// the one failed send of 7. writes its line; nothing else may
const badLines = mainLog.trim().split('\n').filter(l => /failed|error/i.test(l))
check('the main log: only the failed send of 7., no other error or failure line', badLines.length === 1 && /send failed \(/.test(badLines[0]), badLines.join(' | '))
check('no console error or warning in any window', consoleLines.length === 0, consoleLines.slice(0, 3).join(' | '))
fs.rmSync(work, { recursive: true, force: true })
console.log(`\n${results.filter(Boolean).length} / ${results.length} OK`)
process.exit(results.every(Boolean) ? 0 : 1)
