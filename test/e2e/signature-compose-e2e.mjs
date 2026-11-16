#!/usr/bin/env node
// The signature image in the composer and in the sent message, in the real app (headless Electron + Playwright).
// Not part of `npm test`.
//
//   node test/e2e/signature-compose-e2e.mjs          (E2E_LANG=en: the same in English)
//
// Two POP3 accounts (fake POP3 servers, one local SMTP server), A with an image and a text signature, B with another
// image and text:
// 1. A new message from A: the signature block under an empty line, A's text and image; the image is SHOWN (sig-img://).
// 2. Text written, then the sender switched to B: the written text stays, the block is B's (B's text, B's image shown).
// 3. The block deleted, the sender switched back to A: no signature comes back; sent: no image part, no marker.
// 4. A new message from A saved as a draft, closed, opened again from Drafts: the signature block is there, the image
//    shown (the draft's own, sig-img://session/...); the sender switched to B: one block, B's text and image; sent:
//    exactly one inline image part, B's bytes, its Content-ID in the HTML, no marker.
// The main log has no error line, the renderer console no error or warning, the net-guard log is empty.
// Playwright: PW=<path of the playwright package> (default: the repo's playwright-core devDependency).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { SMTPServer } from 'smtp-server'
import { simpleParser } from 'mailparser'
import { FakePop3Server } from '../helpers/fake-pop3.js'
import { createVaultedDatabase } from '../../core/vault/vaulted-db.js'
import { AccountStore } from '../../core/accounts/model.js'
import { newAccountDefaults } from '../../core/accounts/defaults.js'
import { prepareSignatureImage } from '../../core/accounts/signature-image.js'
import { t, locale, seedLanguage } from './lang.mjs'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const MASTER = 'Teszt-mesterjelszo-alairaskep'
const A = { name: 'A-fiók', email: 'a@example.invalid', display: 'Anna Aláíró', signature: 'Üdv,\nAnna A.' }
const B = { name: 'B-fiók', email: 'b@example.invalid', display: 'Béla Beta', signature: 'Béla B.\n+36 1 234 5678' }
const savedHint = (d => t.composeSavedAt(d).replace(d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }), '').trim())(new Date())

const watchdog = setTimeout(() => {
  console.log('FAIL watchdog: the run took more than 4 minutes')
  process.exit(1)
}, 240_000)
watchdog.unref()

// a real PNG (zlib), w x h of one color
function png(w, h, rgb) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32(body))
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const row = Buffer.concat([Buffer.from([0]), Buffer.concat(Array.from({ length: w }, () => Buffer.from(rgb)))])
  const raw = Buffer.concat(Array.from({ length: h }, () => row))
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
const imgA = prepareSignatureImage(png(120, 40, [0x20, 0x60, 0xc0]), { decode: () => ({ width: 120, height: 40 }) })
const imgB = prepareSignatureImage(png(90, 30, [0xc0, 0x40, 0x20]), { decode: () => ({ width: 90, height: 30 }) })

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
const pops = [await new FakePop3Server().listen(), await new FakePop3Server().listen()]

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-sg2-e2e-'))
const dataDir = path.join(work, 'data')
fs.mkdirSync(dataDir)
seedLanguage(dataDir)
const ids = {}
{
  const { db, vault } = await createVaultedDatabase(dataDir, MASTER)
  const store = new AccountStore(db, vault, { storeDir: path.join(dataDir, 'store') })
  for (const [acc, pop, img] of [[A, pops[0], imgA], [B, pops[1], imgB]]) {
    const saved = store.save({
      ...newAccountDefaults('pop3'), name: acc.name, email: acc.email, display_name: acc.display, signature: acc.signature,
      in_host: '127.0.0.1', in_port: pop.port, in_security: 'none', in_user: pop.user, in_password: pop.pass,
      smtp_host: '127.0.0.1', smtp_port: smtp.server.address().port, smtp_security: 'none',
    })
    ids[acc.name] = saved.account.id
    store.setSignatureImage(saved.account.id, img)
  }
  db.close()
}

const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const consoleLines = []
const app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
try {
  const page = await app.firstWindow()
  page.on('console', m => (m.type() === 'error' || m.type() === 'warning') && consoleLines.push(`main ${m.type()}: ${m.text()}`))
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  await page.locator('.folder-tree .folder').first().waitFor()
  const composerOf = async click => {
    const [win] = await Promise.all([app.waitForEvent('window', { timeout: 15_000 }), click()])
    win.on('console', m => (m.type() === 'error' || m.type() === 'warning') && consoleLines.push(`composer ${m.type()}: ${m.text()}`))
    await win.setViewportSize({ width: 900, height: 700 })
    await win.locator('.editor').waitFor()
    await win.waitForFunction(() => document.querySelector('.editor [data-sm-signature]') || document.querySelector('.editor')?.textContent)
    return win
  }
  // the signature block as the editor holds it, and whether its image is really shown
  const blockOf = win =>
    win.evaluate(async () => {
      const block = document.querySelector('.editor [data-sm-signature]')
      const img = block && block.querySelector('img')
      if (img && !img.complete) await new Promise(r => (img.onload = img.onerror = r))
      return {
        block: Boolean(block),
        text: block ? block.innerText : null,
        src: img ? img.getAttribute('src') : null,
        shown: img ? img.naturalWidth : 0,
        body: document.querySelector('.editor').innerText,
      }
    })
  const clickClosing = async (win, name, timeout) => {
    const closed = win.waitForEvent('close', { timeout })
    await win.getByRole('button', { name, exact: true }).click({ noWaitAfter: true }).catch(e => {
      if (!win.isClosed()) throw e
    })
    await closed
  }
  const chooseFrom = async (win, acc) => {
    await win.locator('#compose-from').click()
    await win.getByRole('menuitemradio', { name: `${acc.display} <${acc.email}>`, exact: true }).click()
  }

  // 1. a new message from A
  let win = await composerOf(() => page.getByRole('button', { name: t.newMessage, exact: true }).click())
  let b = await blockOf(win)
  check('a new message from A: the signature block, A text and A image, the image shown', b.block && b.text.includes('Anna A.') && b.src === `sig-img://account/${ids[A.name]}` && b.shown === 120, JSON.stringify(b))

  // 2. text written, the sender switched to B
  await win.locator('.editor').click()
  await win.keyboard.press('Control+Home')
  await win.keyboard.type('Saját szövegem. ')
  await chooseFrom(win, B)
  b = await blockOf(win)
  check('switched to B: the written text stays, the block is B (text and image, shown), A gone', b.body.includes('Saját szövegem.') && b.text.includes('Béla B.') && !b.text.includes('Anna A.') && b.src === `sig-img://account/${ids[B.name]}` && b.shown === 90, JSON.stringify(b))

  // 3. the block deleted, back to A: nothing comes back; sent without an image
  await win.evaluate(() => document.querySelector('.editor [data-sm-signature]').remove())
  await chooseFrom(win, A)
  b = await blockOf(win)
  check('the block deleted, switched back to A: no signature comes back', !b.block && !b.body.includes('Anna A.') && b.body.includes('Saját szövegem.'), JSON.stringify(b))
  await win.locator('#compose-to').fill('cimzett@example.invalid')
  await win.locator('#compose-subject').fill('Aláírás nélkül')
  await clickClosing(win, t.composeSend, 30_000)
  for (let i = 0; i < 50 && received.length < 1; i++) await page.waitForTimeout(200)
  const first = received[0] ? await simpleParser(received[0], { keepCidLinks: true }) : null
  check('sent without the block: no image part, no marker, no sig-img', first && first.attachments.length === 0 && !first.html.includes('data-sm-signature') && !first.html.includes('sig-img') && !/multipart\/related/i.test(received[0].toString('latin1')), first ? first.html.slice(0, 200) : 'nothing arrived')

  // 4. a draft with A's image: saved, closed, opened again, sent
  win = await composerOf(() => page.getByRole('button', { name: t.newMessage, exact: true }).click())
  await win.locator('#compose-to').fill('cimzett@example.invalid')
  await win.locator('#compose-subject').fill('Képes piszkozat')
  await win.locator('.editor').click()
  await win.keyboard.press('Control+Home')
  await win.keyboard.type('Piszkozat szövege. ')
  await win.getByRole('button', { name: t.composeSaveDraft, exact: true }).click()
  await win.locator('.hint[role="status"]').filter({ hasText: savedHint }).waitFor({ timeout: 15_000 })
  await clickClosing(win, t.composeCloseWindow, 15_000)
  const pane = page.locator('.folder-tree section', { hasText: A.name })
  await pane.locator('.folder[data-path="Drafts"]').click()
  await page.locator('.msg-row', { hasText: 'Képes piszkozat' }).click()
  await page.locator('.reader-tools').waitFor({ timeout: 10_000 })
  await page.waitForTimeout(300)
  win = await composerOf(() => page.locator('.reader-tools .reader-edit-draft').click())
  b = await blockOf(win)
  const reopened = await win.evaluate(async () => {
    const img = document.querySelector('.editor img')
    if (img && !img.complete) await new Promise(r => (img.onload = img.onerror = r))
    return { src: img ? img.getAttribute('src') : null, shown: img ? img.naturalWidth : 0, count: document.querySelectorAll('.editor img').length, text: document.querySelector('.editor').innerText }
  })
  check('the draft opened again: its signature block, its own image shown (sig-img://session/...), once, with the text', b.block && reopened.count === 1 && /^sig-img:\/\/session\//.test(reopened.src) && reopened.shown === 120 && reopened.text.includes('Piszkozat szövege.') && reopened.text.includes('Anna A.'), JSON.stringify(reopened))
  await chooseFrom(win, B)
  b = await blockOf(win)
  const blocks = await win.evaluate(() => document.querySelectorAll('.editor [data-sm-signature]').length)
  check('the reopened draft switched to B: one block, B text and image (shown), the draft text stays', blocks === 1 && b.text.includes('Béla B.') && !b.text.includes('Anna A.') && b.src === `sig-img://account/${ids[B.name]}` && b.shown === 90 && b.body.includes('Piszkozat szövege.'), JSON.stringify({ blocks, ...b }))
  await clickClosing(win, t.composeSend, 30_000)
  for (let i = 0; i < 50 && received.length < 2; i++) await page.waitForTimeout(200)
  const sent = received[1] ? await simpleParser(received[1], { keepCidLinks: true }) : null
  const parts = sent ? sent.attachments.filter(a => a.cid) : []
  check('sent: multipart/related, exactly one inline image part, B bytes, its Content-ID in the HTML, no marker', parts.length === 1 && parts[0].content.equals(imgB.bytes) && /multipart\/related/i.test(received[1].toString('latin1')) && sent.html.includes(`cid:${parts[0].cid}`) && !sent.html.includes('sig-img') && !sent.html.includes('data-sm-signature'), sent ? JSON.stringify({ parts: parts.map(p => [p.cid, p.content.length]), html: sent.html.slice(0, 200) }) : 'nothing arrived')
  check('sent: the text part has B text signature, no image reference', sent && sent.text.includes('Béla B.') && !sent.text.includes('Anna A.') && !/cid:|sig-img/.test(sent.text), sent ? sent.text : '')
} catch (err) {
  check('the run finished', false, err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : String(err))
} finally {
  await app.close().catch(() => {})
  for (const p of pops) await p.close()
  await new Promise(r => smtp.close(r))
}
const mainLog = fs.readFileSync(path.join(dataDir, 'electron', 'logs', 'main.log'), 'utf8')
check('the main log: no error or failure line', !/failed|error/i.test(mainLog), mainLog.trim().split('\n').filter(l => /failed|error/i.test(l)).join(' | '))
const guard = path.join(dataDir, 'electron', 'logs', 'net-guard.log')
const guardText = fs.existsSync(guard) ? fs.readFileSync(guard, 'utf8').trim() : ''
check('net-guard log: no outgoing request', guardText === '', guardText.split('\n').slice(0, 3).join(' | '))
check('no renderer console error or warning', consoleLines.length === 0, consoleLines.slice(0, 3).join(' | '))
fs.rmSync(work, { recursive: true, force: true })
console.log(`\n${results.filter(Boolean).length} / ${results.length} OK`)
process.exit(results.every(Boolean) ? 0 : 1)
