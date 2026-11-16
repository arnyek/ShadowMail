#!/usr/bin/env node
// The address book in the real app: the Címlista view. Not part of `npm test`.
//
//   node test/e2e/contacts-ui-e2e.mjs [--shots docs/ui]
//
// A POP3 account (fake POP3 server) whose SMTP side is a local smtp-server; the open / save dialogs replaced inside the app.
// Measures: "Címlistához ad" in the reader adds the sender (then goes, a banner says so); after a send the new recipient is in
// the Címlista with the auto mark; deleted it goes and a new send does not bring it back; a new person with two addresses and
// a phone, edited, is there after a restart; a taken address shows the error and opens the other person; an import from a
// contacts fixture shows the counts and imports; export to vCard and CSV writes the chosen files; "Levél írása" opens the composer
// with the primary address, and the completion offers the person's second address for its name; the divider; the
// keyboard (arrows, Delete asks, Ctrl+F); 900 px wide still usable; no native control or unnamed icon button; no console
// problem; the net-guard log is empty. --shots: the list, the editor and the import preview.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { SMTPServer } from 'smtp-server'
import { FakePop3Server } from '../helpers/fake-pop3.js'
import { createVaultedDatabase } from '../../core/vault/vaulted-db.js'
import { AccountStore } from '../../core/accounts/model.js'
import { newAccountDefaults } from '../../core/accounts/defaults.js'
import { t, seedLanguage } from './lang.mjs'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const shotsArg = process.argv.indexOf('--shots')
const shots = shotsArg > 0 ? path.resolve(process.argv[shotsArg + 1]) : null
const MASTER = 'Teszt-mesterjelszo-cimlista'
const USER = 'cimlista@example.invalid'
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// "<n> kijelölve" with any count
const anySelected = new RegExp(reEsc(t.contacts.selected(7)).replace('7', '\\d+'))

const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const watchdog = setTimeout(() => {
  console.log('FAIL watchdog: the run took more than 6 minutes')
  process.exit(1)
}, 360_000)
watchdog.unref()

const received = []
const smtp = new SMTPServer({
  disabledCommands: ['STARTTLS'],
  allowInsecureAuth: true,
  authMethods: ['PLAIN', 'LOGIN'],
  logger: false,
  onAuth: (auth, _s, cb) => (auth.password === 'jo-jelszo' ? cb(null, { user: auth.username }) : cb(new Error('Invalid username or password'))),
  onData(stream, session, cb) {
    stream.on('data', () => {})
    stream.on('end', () => {
      received.push(session.envelope.rcptTo.map(r => r.address))
      cb()
    })
  },
})
smtp.on('error', () => {})
await new Promise(r => smtp.listen(0, '127.0.0.1', r))
const pop = await new FakePop3Server().listen()
pop.add(Buffer.from(`From: Feladó Ferenc <ferenc@example.invalid>\r\nTo: ${USER}\r\nSubject: Régi levél\r\nDate: ${new Date().toUTCString()}\r\n\r\nszia\r\n`))
// the user's own address as the sender
pop.add(Buffer.from(`From: Teszt Elek <CIMLISTA@example.invalid>\r\nTo: ${USER}\r\nSubject: Saját levél\r\nDate: ${new Date(Date.now() - 60_000).toUTCString()}\r\n\r\nmagamnak\r\n`))

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-contacts-e2e-'))
const dataDir = path.join(work, 'data')
const files = path.join(work, 'files')
fs.mkdirSync(dataDir)
fs.mkdirSync(files)
fs.copyFileSync(path.join(repo, 'test', 'fixtures', 'contacts', 'gmail-3.0.vcf'), path.join(files, 'gmail.vcf'))
{
  const { db, vault } = await createVaultedDatabase(dataDir, MASTER)
  const store = new AccountStore(db, vault, { storeDir: path.join(dataDir, 'store') })
  store.save({
    ...newAccountDefaults('pop3'), name: 'POP3-fiók', email: USER, display_name: 'Teszt Elek',
    in_host: '127.0.0.1', in_port: pop.port, in_security: 'none', in_user: pop.user, in_password: pop.pass,
    smtp_host: '127.0.0.1', smtp_port: smtp.server.address().port, smtp_security: 'none', smtp_same_password: false, smtp_password: 'jo-jelszo',
  })
  db.close()
}
seedLanguage(dataDir)

const consoleLines = []
let app
let page
async function start() {
  app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
  await app.evaluate(({ dialog }, dir) => {
    globalThis.__open = null
    globalThis.__saved = []
    dialog.showOpenDialog = async () => (globalThis.__open ? { canceled: false, filePaths: [globalThis.__open] } : { canceled: true, filePaths: [] })
    dialog.showSaveDialog = async (...args) => {
      const opts = args[args.length - 1]
      globalThis.__saved.push(opts.defaultPath)
      return { canceled: false, filePath: `${dir}/${globalThis.__saved.length}-${opts.defaultPath}` }
    }
  }, files)
  page = await app.firstWindow()
  page.on('console', m => (m.type() === 'error' || m.type() === 'warning') && consoleLines.push(`${m.type()}: ${m.text()}`))
  page.on('pageerror', e => consoleLines.push(`pageerror: ${e.message}`))
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  await page.locator('.msg-row', { hasText: 'Régi levél' }).waitFor({ timeout: 30_000 })
}
const toContacts = async () => {
  if (!(await page.locator('section.contacts').count())) await page.getByRole('button', { name: t.viewContacts, exact: true }).click()
  await page.locator('section.contacts').waitFor()
}
const toMail = async () => {
  if (await page.locator('section.contacts').count()) await page.getByRole('button', { name: t.viewContacts, exact: true }).click()
  await page.locator('.msg-row').first().waitFor()
}
const item = text => page.locator('.contact-item', { hasText: text })
async function send(to, subject) {
  await toMail()
  const [win] = await Promise.all([app.waitForEvent('window', { timeout: 15_000 }), page.getByRole('button', { name: t.newMessage, exact: true }).click()])
  await win.setViewportSize({ width: 900, height: 700 })
  await win.locator('.editor').waitFor()
  await win.waitForFunction(() => document.querySelector('#compose-from')?.textContent.trim())
  await win.locator('#compose-to').fill(to)
  await win.locator('#compose-subject').fill(subject)
  const before = received.length
  await Promise.all([win.waitForEvent('close', { timeout: 20_000 }), win.getByRole('button', { name: t.composeSend, exact: true }).click()])
  for (let i = 0; i < 40 && received.length === before; i++) await page.waitForTimeout(100)
}
const audit = () =>
  page.evaluate(() => ({
    native: document.querySelectorAll('section.contacts button:not([class]), section.contacts select, .app-header button:not([class])').length,
    unnamed: document.querySelectorAll('button.icon-btn:not([aria-label])').length,
    hscroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }))

try {
  await start()
  check('the header has the Címlista button next to Settings, not pressed', (await page.getByRole('button', { name: t.viewContacts, exact: true }).getAttribute('aria-pressed')) === 'false')

  // 1. the reader: "Címlistához ad" for the unknown sender
  await page.locator('.msg-row', { hasText: 'Régi levél' }).click()
  await page.locator('.reader-add-sender').waitFor({ timeout: 10_000 })
  await page.locator('.reader-add-sender').click()
  await page.locator('.reader-sender-added').waitFor()
  check('reader: "Címlistához ad" adds the sender, goes, and a banner says so', (await page.locator('.reader-add-sender').count()) === 0 && (await page.locator('.reader-sender-added').innerText()).includes(t.contacts.senderAdded))
  await page.keyboard.press('Escape')
  await page.locator('.msg-row', { hasText: 'Saját levél' }).click()
  await page.locator('.reader[data-message-id] .reader-from-name').waitFor()
  await page.waitForTimeout(500)
  check('no "Címlistához ad" for the user\'s own address (other case too)', (await page.locator('.reader-add-sender').count()) === 0)
  await page.keyboard.press('Escape')

  // 2. a send adds the new recipient as automatic
  await send('uj-cimzett@example.invalid', 'címlista küldés')
  await toContacts()
  check('the Címlista button is pressed in the view', (await page.getByRole('button', { name: t.viewContacts, exact: true }).getAttribute('aria-pressed')) === 'true')
  await item('uj-cimzett@example.invalid').waitFor()
  check('after a send the new recipient is listed with the auto mark', (await item('uj-cimzett@example.invalid').getAttribute('data-source')) === 'auto' && (await item('uj-cimzett@example.invalid').innerText()).includes(t.contacts.source.auto))
  check('the sender added from the reader is listed as manual', (await item('Feladó Ferenc').getAttribute('data-source')) === 'manual')
  // delete it (the confirmation), then a new send does not bring it back
  await item('uj-cimzett@example.invalid').click()
  await page.locator('.contact-delete').click()
  const confirmText = await page.locator('.contacts-delete-confirm').innerText()
  await page.locator('.contacts-delete-ok').click()
  await page.waitForTimeout(300)
  check('delete asks ("nem kerül vissza magától") and the person goes', confirmText.includes(t.contacts.deleteText) && (await item('uj-cimzett@example.invalid').count()) === 0, confirmText)
  await send('uj-cimzett@example.invalid', 'címlista újra')
  await toContacts()
  await page.waitForTimeout(300)
  check('a new send to the deleted address does not bring it back', received.length === 2 && (await item('uj-cimzett@example.invalid').count()) === 0, JSON.stringify(received))

  // 3. a new person with two addresses and a phone
  await page.locator('.contact-new').click()
  await page.locator('input[name="displayName"]').fill('Kiss Anna')
  await page.locator('input[name="email-0"]').fill('anna@example.invalid')
  await page.locator('.contact-add-email').click()
  await page.locator('input[name="email-1"]').fill('anna2@example.invalid')
  await page.locator('.contact-add-phone').click()
  await page.locator('input[name="phone-0"]').fill('+36 1 234 5678')
  if (shots) await page.screenshot({ path: path.join(shots, 'contacts-edit.png') })
  await page.getByRole('button', { name: t.contacts.save, exact: true }).click()
  await page.locator('.contact-details .contact-name', { hasText: 'Kiss Anna' }).waitFor()
  const det = await page.locator('.contact-details').innerText()
  check('new person: two addresses (the first primary) and a phone', /anna@example\.invalid/.test(det) && /anna2@example\.invalid/.test(det) && /\+36 1 234 5678/.test(det) && det.includes(t.contacts.primary), det)
  await page.locator('.contact-edit').click()
  await page.locator('input[name="org"]').fill('Cég Kft.')
  await page.getByRole('button', { name: t.contacts.save, exact: true }).click()
  await page.locator('.contact-org', { hasText: 'Cég Kft.' }).waitFor()
  check('edit: the company saved and shown', true)
  // a taken address: the error and the link to the other person
  await page.locator('.contact-new').click()
  await page.locator('input[name="displayName"]').fill('Másik')
  await page.locator('input[name="email-0"]').fill('FERENC@example.invalid')
  await page.getByRole('button', { name: t.contacts.save, exact: true }).click()
  await page.locator('.contact-error').waitFor()
  check('a taken address: the error says so', (await page.locator('.contact-error').innerText()).includes(t.contacts.errors.address_taken))
  await page.locator('.contact-open-other').click()
  await page.locator('.contact-details .contact-name', { hasText: 'Feladó Ferenc' }).waitFor()
  check('the link opens the other person', true)

  // 4. import from a contacts fixture, export to vCard and CSV
  await app.evaluate((_, f) => (globalThis.__open = f), path.join(files, 'gmail.vcf'))
  await page.locator('.contacts-import').click()
  await page.locator('.import-preview').waitFor()
  const counts = await page.locator('.import-counts').evaluate(el => ({ ...el.dataset }))
  if (shots) await page.screenshot({ path: path.join(shots, 'contacts-import.png') })
  check('import preview: the counts (2 new) and the sample', counts.new === '2' && counts.invalid === '0' && (await page.locator('.import-sample li').count()) === 2, JSON.stringify(counts))
  await page.locator('.import-apply').click()
  await page.locator('.contacts-notice', { hasText: t.contacts.imported({ new: Number(counts.new), merged: Number(counts.merged), unchanged: Number(counts.unchanged) }) }).waitFor()
  await item('Árvíztűrő Tükörfúrógép').waitFor()
  check('imported: listed with the import mark', (await item('Árvíztűrő Tükörfúrógép').getAttribute('data-source')) === 'import')
  for (const [label, ext] of [[t.contacts.exportAllVcf, 'vcf'], [t.contacts.exportAllCsv, 'csv']]) {
    await page.locator('.contacts-export').click()
    await page.getByRole('menuitem', { name: label, exact: true }).click()
    await page.locator('.contacts-notice', { hasText: t.contacts.exported(4) }).waitFor()
    const saved = await app.evaluate(() => globalThis.__saved)
    const file = path.join(files, `${saved.length}-${saved[saved.length - 1]}`)
    check(`export ${ext}: the chosen file is written (${t.contactsExportBase}-<date>.${ext})`, fs.existsSync(file) && saved[saved.length - 1].endsWith(`.${ext}`) && path.basename(saved[saved.length - 1]).startsWith(`${t.contactsExportBase}-`) && fs.statSync(file).size > 100, saved[saved.length - 1])
  }
  const total = Number(await page.locator('.contacts-count').getAttribute('data-total'))
  check('the count shows the people', total === 4, String(total))
  if (shots) {
    await item('Kiss Anna').click()
    await page.screenshot({ path: path.join(shots, 'contacts-list.png') })
  }

  // 5. "Levél írása" and the completion
  await item('Kiss Anna').click()
  const [win] = await Promise.all([app.waitForEvent('window', { timeout: 15_000 }), page.locator('.contact-write').click()])
  await win.setViewportSize({ width: 900, height: 700 })
  await win.locator('.editor').waitFor()
  await win.waitForFunction(() => document.querySelector('#compose-from')?.textContent.trim())
  check('"Levél írása" opens the composer with the primary address', (await win.locator('#compose-to').inputValue()) === 'anna@example.invalid', await win.locator('#compose-to').inputValue())
  await win.locator('#compose-to').fill('Kiss')
  await win.locator('.suggestions [role="option"]').first().waitFor()
  const sugg = await win.locator('.suggestions [role="option"]').allInnerTexts()
  check('the completion offers the second address for the name too', sugg.some(s => /anna2@example\.invalid/.test(s)) && sugg.some(s => /anna@example\.invalid/.test(s)), JSON.stringify(sugg))
  await app.evaluate(({ BrowserWindow }, prefix) => BrowserWindow.getAllWindows().find(w => w.getTitle().startsWith(prefix))?.destroy(), t.newMessage)

  // 6. the divider, the keyboard, a narrow window, the audit
  await toContacts()
  const listW = () => page.locator('.contacts-list-pane').evaluate(el => Math.round(el.getBoundingClientRect().width))
  const w0 = await listW()
  const b = await page.locator('.splitter[data-split="contacts"]').boundingBox()
  await page.mouse.move(b.x + b.width / 2, b.y + 200)
  await page.mouse.down()
  await page.mouse.move(b.x + b.width / 2 + 80, b.y + 200, { steps: 6 })
  await page.mouse.up()
  await page.waitForTimeout(100)
  const w1 = await listW()
  await page.locator('.splitter[data-split="contacts"]').dblclick()
  await page.waitForTimeout(100)
  check('the divider: list | details drag +80, a double click gives back 360', Math.abs(w1 - w0 - 80) <= 2 && Math.abs((await listW()) - 360) <= 2, `${w0} -> ${w1} -> ${await listW()}`)
  await item('Feladó Ferenc').click()
  await page.locator('.contact-details .contact-name', { hasText: 'Feladó Ferenc' }).waitFor()
  await page.locator('.contacts-list').focus()
  await page.keyboard.press('ArrowDown')
  const down = await page.locator('.contact-details .contact-name', { hasText: 'Kiss Anna' }).waitFor({ timeout: 3000 }).then(() => true, () => false)
  await page.keyboard.press('ArrowUp')
  const up = await page.locator('.contact-details .contact-name', { hasText: 'Feladó Ferenc' }).waitFor({ timeout: 3000 }).then(() => true, () => false)
  check('arrows move the open person down and up (Hungarian order: Feladó Ferenc, Kiss Anna)', down && up, JSON.stringify({ down, up }))
  await page.keyboard.press('Delete')
  await page.locator('.contacts-delete-confirm').waitFor()
  await page.keyboard.press('Escape')
  await page.waitForTimeout(150)
  check('Delete asks first (Esc keeps the person)', (await page.locator('.contacts-delete-confirm').count()) === 0 && (await item('Feladó Ferenc').count()) === 1)
  // a search hides two selected people; Delete takes the one shown and open, the question names it
  await page.locator('.contact-item', { hasText: 'Kiss Anna' }).locator('input[type="checkbox"]').check()
  await page.locator('.contact-item', { hasText: 'Kiss Éva' }).locator('input[type="checkbox"]').check()
  check('two selected', (await page.locator('.contacts-count').innerText()).includes(t.contacts.selected(2)))
  await page.locator('.contacts-search input').fill('ferenc')
  await page.waitForTimeout(500)
  await item('Feladó Ferenc').click()
  check('the search leaves the hidden ones unselected', !anySelected.test(await page.locator('.contacts-count').innerText()) && (await page.locator('.contacts-delete-selected').count()) === 0, await page.locator('.contacts-count').innerText())
  await page.locator('.contacts-list').focus()
  await page.keyboard.press('Delete')
  await page.locator('.contacts-delete-confirm').waitFor()
  const delNames = await page.locator('.contacts-delete-names li').allInnerTexts()
  check('Delete asks about the person shown, by name', JSON.stringify(delNames) === '["Feladó Ferenc"]' && (await page.locator('.contacts-delete-confirm').innerText()).includes(t.contacts.deleteTitle(1)), JSON.stringify(delNames))
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: t.contacts.searchClear, exact: true }).click().catch(() => {})
  await page.locator('.contacts-search input').fill('')
  await page.waitForTimeout(400)
  check('nobody was deleted (4 people)', Number(await page.locator('.contacts-count').getAttribute('data-total')) === 4)
  await page.keyboard.press('Control+f')
  check('Ctrl+F goes to the search field', await page.evaluate(() => document.activeElement?.closest('.contacts-search') !== null))
  await page.keyboard.type('árvíz')
  await page.waitForTimeout(400)
  check('the search finds by name (no accents needed)', (await page.locator('.contact-item').count()) === 1 && /Árvíztűrő/.test(await page.locator('.contact-item').innerText()))
  await page.getByRole('button', { name: t.contacts.searchClear, exact: true }).click().catch(() => {})
  const a1 = await audit()
  check('no native control, no unnamed icon button, no horizontal scroll (1280)', a1.native === 0 && a1.unnamed === 0 && a1.hscroll <= 0, JSON.stringify(a1))
  await page.setViewportSize({ width: 900, height: 600 })
  await page.waitForTimeout(300)
  const narrow = await page.evaluate(() => ({ list: Math.round(document.querySelector('.contacts-list-pane').getBoundingClientRect().width), detail: Math.round(document.querySelector('.contacts-detail-pane').getBoundingClientRect().width) }))
  const a2 = await audit()
  check('900 px: list and details side by side, no horizontal scroll', narrow.list >= 279 && narrow.detail >= 359 && a2.hscroll <= 0, JSON.stringify({ narrow, a2 }))
  await page.setViewportSize({ width: 1280, height: 800 })

  // 7. after a restart the new person is there
  await app.close()
  await start()
  await toContacts()
  await item('Kiss Anna').click()
  const det2 = await page.locator('.contact-details').innerText()
  check('after a restart the person is there with both addresses, the phone and the company', /anna2@example\.invalid/.test(det2) && /\+36 1 234 5678/.test(det2) && /Cég Kft\./.test(det2))

  check('no console error or warning', consoleLines.length === 0, consoleLines.join(' | '))
  const netLog = path.join(dataDir, 'electron', 'logs', 'net-guard.log')
  check('the net-guard log has no outgoing request', !fs.existsSync(netLog) || fs.readFileSync(netLog, 'utf8').trim() === '')
} catch (err) {
  check('the run', false, err.stack)
} finally {
  await app?.close().catch(() => {})
  smtp.close()
  await pop.close?.()
  fs.rmSync(work, { recursive: true, force: true })
}
const ok = results.filter(Boolean).length
console.log(`${ok} / ${results.length} ${ok === results.length ? 'OK' : 'FAIL'}`)
process.exit(ok === results.length ? 0 : 1)
