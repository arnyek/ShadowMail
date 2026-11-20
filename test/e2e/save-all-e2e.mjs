#!/usr/bin/env node
// "Összes mentése" in the reader, in the real app (headless Electron + Playwright). Not part of `npm test`.
//
//   node test/e2e/save-all-e2e.mjs          (E2E_LANG=en: the same in English)
//
// One POP3 account (fake POP3 server) with three messages: three attachments; one attachment; an HTML message with an
// embedded image, two attachments of the same name and a program. The main process's folder dialog and "show in
// folder" are replaced inside the app (nothing opens):
// 1. One attachment: no "save all" button.
// 2. Three attachments: the button says (3); Cancel in the dialog: nothing written, no line, no error.
// 3. Saved into a folder: the line says 3 saved, each file byte for byte (sha256) the attachment.
// 4. Saved again into the same folder: "name (2).ext", the first ones untouched.
// 5. The embedded image is not counted (3) and not saved; "a.pdf" twice: "a.pdf" and "a (2).pdf"; the program is
//    saved and the line warns.
// 6. "Show in folder": the main process shows the first saved file.
// 7. A folder that cannot be written to: the line says 0 saved and each file left out with the reason.
// 8. Web-page-like attachments (.html, .svg) beside a program: both warnings, each with its own count; the lines of
//    steps 3 and 5 had no web-page warning.
// The renderer console has no error or warning, the main log no error line and no file name, the net-guard log is empty.
// Playwright: PW=<path of the playwright package> (default: the repo's playwright-core devDependency).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { FakePop3Server } from '../helpers/fake-pop3.js'
import { createVaultedDatabase } from '../../core/vault/vaulted-db.js'
import { AccountStore } from '../../core/accounts/model.js'
import { newAccountDefaults } from '../../core/accounts/defaults.js'
import { t, seedLanguage } from './lang.mjs'

const { values } = parseArgs({ options: { shots: { type: 'string' } }, strict: false })
if (values.shots) fs.mkdirSync(values.shots, { recursive: true })

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const MASTER = 'Teszt-mesterjelszo-osszes-melleklet'

const watchdog = setTimeout(() => {
  console.log('FAIL watchdog: the run took more than 4 minutes')
  process.exit(1)
}, 240_000)
watchdog.unref()

const sha = b => crypto.createHash('sha256').update(b).digest('hex')
const b64 = buf => buf.toString('base64').replace(/.{76}/g, '$&\r\n')
const ATT = {
  'szamla-titok.pdf': Buffer.from('%PDF-1.4\n% szamla\n'),
  'jegyzet-titok.txt': Buffer.from('Jegyzet, ékezettel: árvíztűrő.\n'),
  'tabla-titok.csv': Buffer.from('a;b\n1;2\n'),
  'egyetlen.pdf': Buffer.from('%PDF-1.4\n% egy\n'),
  'a.pdf#1': Buffer.from('%PDF-1.4\n% az elso a.pdf\n'),
  'a.pdf#2': Buffer.from('%PDF-1.4\n% a masodik a.pdf\n'),
  'telepito-titok.exe': Buffer.from('MZ\x90\x00 not really a program'),
  'oldal-titok.html': Buffer.from('<!doctype html><script>alert(1)</script>'),
  'rajz-titok.svg': Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
  logo: Buffer.from('\x89PNG\r\n\x1a\n fake logo bytes'),
}
const part = (name, data, type = 'application/octet-stream') =>
  [`Content-Type: ${type}; name="${name}"`, `Content-Disposition: attachment; filename="${name}"`, 'Content-Transfer-Encoding: base64', '', b64(data)].join('\r\n')
const message = (subject, uid, body, parts, { related = null } = {}) =>
  [
    'From: Ügyfél <ugyfel@example.invalid>',
    'To: a@example.invalid',
    `Subject: ${subject}`,
    `Date: Thu, 19 Nov 2026 0${uid}:00:00 +0100`,
    `Message-ID: <save-all-${uid}@example.invalid>`,
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="M"',
    '',
    '--M',
    related || ['Content-Type: text/plain; charset=utf-8', '', body].join('\r\n'),
    ...parts.map(p => `--M\r\n${p}`),
    '--M--',
    '',
  ].join('\r\n')

const pop = await new FakePop3Server().listen()
pop.add(message('Három melléklet', 1, 'Csatolom.', [part('szamla-titok.pdf', ATT['szamla-titok.pdf'], 'application/pdf'), part('jegyzet-titok.txt', ATT['jegyzet-titok.txt'], 'text/plain'), part('tabla-titok.csv', ATT['tabla-titok.csv'], 'text/csv')]))
pop.add(message('Egy melléklet', 2, 'Egy fájl.', [part('egyetlen.pdf', ATT['egyetlen.pdf'], 'application/pdf')]))
const related = [
  'Content-Type: multipart/related; boundary="R"',
  '',
  '--R',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<p>Logó: <img src="cid:logo@example.invalid" alt=""></p>',
  '--R',
  'Content-Type: image/png; name="logo.png"',
  'Content-Disposition: inline; filename="logo.png"',
  'Content-ID: <logo@example.invalid>',
  'Content-Transfer-Encoding: base64',
  '',
  b64(ATT.logo),
  '--R--',
].join('\r\n')
pop.add(message('Képes, programos', 3, '', [part('a.pdf', ATT['a.pdf#1'], 'application/pdf'), part('a.pdf', ATT['a.pdf#2'], 'application/pdf'), part('telepito-titok.exe', ATT['telepito-titok.exe'])], { related }))

pop.add(message('Weboldalas', 4, 'Nézd meg.', [part('oldal-titok.html', ATT['oldal-titok.html'], 'text/html'), part('rajz-titok.svg', ATT['rajz-titok.svg'], 'image/svg+xml'), part('telepito-titok.exe', ATT['telepito-titok.exe'])]))

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-saveall-e2e-'))
const dataDir = path.join(work, 'data')
fs.mkdirSync(dataDir)
seedLanguage(dataDir)
{
  const { db, vault } = await createVaultedDatabase(dataDir, MASTER)
  const store = new AccountStore(db, vault, { storeDir: path.join(dataDir, 'store') })
  store.save({
    ...newAccountDefaults('pop3'), name: 'A-fiók', email: 'a@example.invalid', display_name: 'Anna', signature: '',
    in_host: '127.0.0.1', in_port: pop.port, in_security: 'none', in_user: pop.user, in_password: pop.pass,
    smtp_host: '127.0.0.1', smtp_port: 9, smtp_security: 'none',
  })
  db.close()
}
const target = name => path.join(work, name)
for (const d of ['ide', 'masik', 'zart', 'web']) fs.mkdirSync(target(d))

const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const consoleLines = []
const app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
try {
  const page = await app.firstWindow()
  page.on('console', m => (m.type() === 'error' || m.type() === 'warning') && consoleLines.push(`${m.type()}: ${m.text()}`))
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  // the folder dialog answers what the test sets; "show in folder" is recorded
  const answer = folder => app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => (folder ? { canceled: false, filePaths: [folder] } : { canceled: true, filePaths: [] })
  }, folder)
  await app.evaluate(({ shell }) => {
    globalThis.__shown = []
    shell.showItemInFolder = p => globalThis.__shown.push(p)
  })
  const open = async subject => {
    // the reader may stand in the list's place (a message open): back to the list first
    if (await page.locator('.reader-back').count()) await page.locator('.reader-back').click()
    await page.locator('.msg-row', { hasText: subject }).click({ timeout: 20_000 })
    await page.locator('.reader-attachments').waitFor({ timeout: 10_000 })
    await page.waitForTimeout(200)
  }
  const saveAllButton = () => page.locator('.reader-attachments .save-all')
  const resultText = () => page.locator('.save-all-result').innerText().catch(() => null)
  const press = async () => {
    await saveAllButton().click()
    await page.waitForTimeout(400)
  }

  // 1. one attachment
  await open('Egy melléklet')
  check('one attachment: no "save all" button', (await saveAllButton().count()) === 0)

  // 2. three attachments, Cancel
  await open('Három melléklet')
  const label = await saveAllButton().innerText()
  check('three attachments: the button says (3)', label.trim() === t.readerSaveAll(3), label)
  await answer(null)
  await press()
  check('Cancel: nothing written, no line, no error', fs.readdirSync(target('ide')).length === 0 && (await page.locator('.save-all-result').count()) === 0 && (await page.locator('.reader .banner-error, .action-error').count()) === 0)

  // 3. saved
  await answer(target('ide'))
  await press()
  let text = await resultText()
  const names = ['szamla-titok.pdf', 'jegyzet-titok.txt', 'tabla-titok.csv']
  check('saved: the line says 3 saved', text && text.includes(t.readerSavedAll(3)), String(text))
  check('no program, no web-page-like file: no warning line', (await page.locator('.save-all-result .executable').count()) === 0)
  check('each file byte for byte the attachment (sha256)', names.every(n => fs.existsSync(path.join(target('ide'), n)) && sha(fs.readFileSync(path.join(target('ide'), n))) === sha(ATT[n])), fs.readdirSync(target('ide')).join())

  // 4. again into the same folder
  await press()
  const listing = fs.readdirSync(target('ide')).sort()
  check('saved again: "name (2).ext" beside the first ones', ['jegyzet-titok (2).txt', 'szamla-titok (2).pdf', 'tabla-titok (2).csv'].every(n => listing.includes(n)) && listing.length === 6, listing.join())
  check('the first ones untouched byte for byte', names.every(n => sha(fs.readFileSync(path.join(target('ide'), n))) === sha(ATT[n])))

  // 5. embedded image, same names, a program
  await open('Képes, programos')
  check('the embedded image is not counted: (3)', (await saveAllButton().innerText()).trim() === t.readerSaveAll(3))
  await answer(target('masik'))
  await press()
  const second = fs.readdirSync(target('masik')).sort()
  check('"a.pdf" twice: "a.pdf" and "a (2).pdf", the program saved, the embedded image not', second.join() === ['a (2).pdf', 'a.pdf', 'telepito-titok.exe'].join() && sha(fs.readFileSync(path.join(target('masik'), 'a.pdf'))) === sha(ATT['a.pdf#1']) && sha(fs.readFileSync(path.join(target('masik'), 'a (2).pdf'))) === sha(ATT['a.pdf#2']), second.join())
  text = await resultText()
  check('the line warns about the program', text && text.includes(t.readerSavedExecutable(1)), String(text))
  check('no web-page-like file: no web-page warning', (await page.locator('.save-all-result .browser-active').count()) === 0 && !text.includes(t.readerSavedBrowserActive(1)), String(text))

  // 6. show in folder
  await page.locator('.save-all-result .save-all-show').click()
  await page.waitForTimeout(300)
  const shown = await app.evaluate(() => globalThis.__shown)
  check('"Show in folder": the main process shows the first saved file', shown.length === 1 && shown[0] === path.join(target('masik'), 'a.pdf'), JSON.stringify(shown))

  // 7. a folder that cannot be written to
  fs.chmodSync(target('zart'), 0o555)
  await open('Három melléklet')
  await answer(target('zart'))
  await press()
  text = await resultText()
  const lines = await page.locator('.save-all-result .save-all-skipped').allInnerTexts()
  check('an unwritable folder: 0 saved, each file left out with the reason, no "show in folder"', text && text.includes(t.readerSavedAll(0)) && lines.length === 3 && lines.every(l => l === t.readerSaveSkipped(l.match(/: (.*) \(/)?.[1] ?? '', 'not_writable')) && (await page.locator('.save-all-result .save-all-show').count()) === 0, JSON.stringify(lines))
  check('nothing written into it', fs.readdirSync(target('zart')).length === 0)
  check('nothing saved: no warning line', (await page.locator('.save-all-result .executable').count()) === 0)

  // 8. web-page-like files beside a program
  await open('Weboldalas')
  await answer(target('web'))
  await press()
  text = await resultText()
  const web = fs.readdirSync(target('web')).sort()
  check('the web-page-like files are saved byte for byte', web.join() === ['oldal-titok.html', 'rajz-titok.svg', 'telepito-titok.exe'].join() && ['oldal-titok.html', 'rajz-titok.svg'].every(n => sha(fs.readFileSync(path.join(target('web'), n))) === sha(ATT[n])), web.join())
  const warning = await page.locator('.save-all-result .browser-active').allInnerTexts()
  check('the line warns about the 2 web-page-like files', warning.length === 1 && warning[0] === t.readerSavedBrowserActive(2), JSON.stringify(warning))
  if (values.shots) await page.screenshot({ path: path.join(values.shots, 'save-all-warnings.png') })
  check('and about the program, as before', text && text.includes(t.readerSavedExecutable(1)), String(text))
} catch (err) {
  check('the run finished', false, err && err.stack ? err.stack.split('\n').slice(0, 16).join(' | ') : String(err))
} finally {
  await app.close().catch(() => {})
  await pop.close()
  fs.chmodSync(target('zart'), 0o755)
}
const mainLog = fs.readFileSync(path.join(dataDir, 'electron', 'logs', 'main.log'), 'utf8')
check('the main log: no error or failure line', !/failed|error/i.test(mainLog), mainLog.trim().split('\n').filter(l => /failed|error/i.test(l)).join(' | '))
const named = ['titok', 'a.pdf', '.html', '.svg', target('ide'), target('masik'), target('zart'), target('web')].filter(n => mainLog.includes(n))
check('the main log: no file name, no folder', named.length === 0, named.join(', '))
check('the main log: the counts', /attachments saved: 3 of 3/.test(mainLog) && /attachments saved: 0 of 3 \(not_writable\)/.test(mainLog))
const guard = path.join(dataDir, 'electron', 'logs', 'net-guard.log')
const guardText = fs.existsSync(guard) ? fs.readFileSync(guard, 'utf8').trim() : ''
check('net-guard log: no outgoing request', guardText === '', guardText.split('\n').slice(0, 3).join(' | '))
check('no renderer console error or warning', consoleLines.length === 0, consoleLines.slice(0, 3).join(' | '))
fs.rmSync(work, { recursive: true, force: true })
console.log(`\n${results.filter(Boolean).length} / ${results.length} OK`)
process.exit(results.every(Boolean) ? 0 : 1)
