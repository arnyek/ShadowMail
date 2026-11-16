#!/usr/bin/env node
// Smoke test ON THE PACKAGE, run on Windows with the Windows Node from the build folder:
//
//   node test\e2e\package-smoke.mjs --zip <ShadowMail-x.y.z-win-x64.zip> --work <empty folder> [--upgrade <data folder of an older build>]
//
// The packaged exe has its fuses set (no --inspect), so Playwright's _electron cannot drive it: the
// pages are driven over the Chromium DevTools protocol (--remote-debugging-port) with playwright-core
// (the repo's playwright-core devDependency; PW=<path> overrides it). The app runs from its own folder with
// its default data folder (exe folder\data): no SHADOWMAIL_DATA.
// Local servers only: a fake POP3 server (one message with a PDF) and an smtp-server for sending.
// Measures: start, unlock, account and folders, the download, a message opens, search finds, a message
// is sent; then the footprint outside the data folder (scripts\win\footprint.ps1), data\tmp emptied;
// optionally the upgrade: an older build's data folder next to the new exe unlocks with its accounts.
// 0.12.0: the sent recipient is an automatic person; a vCard and a CSV fixture imported and the address
// book exported to both formats, a message's source and its .eml save: through the REAL native file dialogs, answered by
// scripts\win\answer-file-dialog.ps1 (Win32, works on a locked machine); the net-guard log stays empty. The upgrade from a
// 0.11.x folder (--upgradeBak 4): the migration's mail.sqlite.bak-4, its old contacts as automatic people.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { SMTPServer } from 'smtp-server'
import { FakePop3Server } from '../helpers/fake-pop3.js'
import { newsletterEml } from '../helpers/newsletter.js'
import { createVaultedDatabase, dataFolderState } from '../../core/vault/vaulted-db.js'
import { AccountStore } from '../../core/accounts/model.js'
import { newAccountDefaults } from '../../core/accounts/defaults.js'

const { values } = parseArgs({ options: { zip: { type: 'string' }, work: { type: 'string' }, upgrade: { type: 'string' }, upgradeMaster: { type: 'string' }, upgradeSearch: { type: 'string' }, upgradeBak: { type: 'string' } } })
if (!values.zip || !values.work) {
  console.error('usage: package-smoke.mjs --zip <zip> --work <empty folder> [--upgrade <data folder> --upgradeMaster <password> [--upgradeSearch <word in its mail, default szamla>] [--upgradeBak <N: mail.sqlite.bak-N must appear>]]')
  process.exit(2)
}
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const footprint = path.join(repo, 'scripts', 'win', 'footprint.ps1')
const answerDialog = path.join(repo, 'scripts', 'win', 'answer-file-dialog.ps1')
// the native dialogs must leave no shortcut in the Windows Recent folder (outside the data folder; the
// app passes 'dontAddToRecent'); the common dialog's own MRU in the registry (ComDlg32) is measured, before and after
const recentDir = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Recent')
const recentSnap = () => {
  try {
    return Object.fromEntries(fs.readdirSync(recentDir).filter(n => n.toLowerCase().endsWith('.lnk')).map(n => [n, fs.statSync(path.join(recentDir, n)).mtimeMs]))
  } catch {
    return null
  }
}
const COMDLG = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\ComDlg32'
// the key and value NAMES of a reg export (never the data: it holds paths)
const regNames = file => {
  if (spawnSync('reg', ['export', COMDLG, file, '/y'], { encoding: 'utf8' }).status !== 0) return null
  const text = fs.readFileSync(file).toString('utf16le')
  const out = new Map()
  let key = ''
  let cur = null
  for (const line of text.split(/\r?\n/)) {
    if (/^\[.*\]$/.test(line)) key = line.slice(1, -1).replace(/^.*\\ComDlg32/, 'ComDlg32')
    const m = /^"([^"]*)"=(.*)$/.exec(line)
    if (m) {
      cur = `${key} | ${m[1]}`
      out.set(cur, m[2])
    } else if (cur && /^\s+/.test(line)) out.set(cur, out.get(cur) + line.trim())
    else cur = null
  }
  return out
}
// the direct subkeys of HKCU\Software (a new vendor key would be a write of the app's: none is allowed)
const softwareKeys = () => {
  const r = spawnSync('reg', ['query', 'HKCU\\Software'], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.split(/\r?\n/).map(l => l.trim()).filter(l => /^HKEY_CURRENT_USER\\Software\\/i.test(l)) : null
}
// answers the next native file dialog of the app's main process with `file` -> { code, out }
// dump: the helper prints the dialog's window tree, and the whole output goes to the log (Save dialog diagnosis)
const answerFileDialog = (pid, file, dump = false) =>
  new Promise(resolve => {
    const p = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', answerDialog, '-ProcessId', String(pid), '-Path', file, '-TimeoutSec', '30', ...(dump ? ['-Dump'] : [])], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    p.stdout.on('data', d => (out += d))
    p.stderr.on('data', d => (out += d))
    p.on('close', code => {
      if (dump) console.log(`DIALOG ${path.basename(file)}:\n${out.trim()}`)
      resolve({ code, out: out.trim().split(/\r?\n/).slice(-1)[0] })
    })
  })
const MASTER = 'Csomag-proba-mesterjelszo'
const ME = 'teszt@example.invalid'
const sleep = ms => new Promise(r => setTimeout(r, ms))

const watchdog = setTimeout(() => {
  console.log('FAIL watchdog: more than 5 minutes')
  process.exit(1)
}, 300_000)
watchdog.unref()

const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}

const work = path.resolve(values.work)
fs.rmSync(work, { recursive: true, force: true })
fs.mkdirSync(work, { recursive: true })
const appDir = path.join(work, 'app')
fs.mkdirSync(appDir)
execFileSync('tar', ['-xf', path.resolve(values.zip), '-C', appDir])
const exe = path.join(appDir, 'ShadowMail.exe')
check('the zip has ShadowMail.exe', fs.existsSync(exe))

// local servers
const received = []
const smtp = new SMTPServer({
  disabledCommands: ['STARTTLS'], allowInsecureAuth: true, authMethods: ['PLAIN', 'LOGIN'], logger: false,
  onAuth: (a, _s, cb) => (a.password === 'jo-jelszo' ? cb(null, { user: a.username }) : cb(new Error('Invalid username or password'))),
  onData(stream, _session, cb) {
    const chunks = []
    stream.on('data', c => chunks.push(c))
    stream.on('end', () => (received.push(Buffer.concat(chunks)), cb()))
  },
})
smtp.on('error', () => {})
await new Promise(r => smtp.listen(0, '127.0.0.1', r))
const pop = await new FakePop3Server().listen()
const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), crypto.randomBytes(5000)])
pop.add(Buffer.from([
  'From: Kovács Anna <anna@example.invalid>', `To: ${ME}`, 'Subject: =?utf-8?q?Csomagpr=C3=B3ba_lev=C3=A9l?=', `Date: ${new Date().toUTCString()}`,
  'Message-ID: <csomag-1@example.invalid>', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="B"', '', '--B',
  'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit', '', 'A hőszivattyú-ajánlat szövege: pipacsmező.', '--B',
  'Content-Type: application/pdf; name="ajanlat.pdf"', 'Content-Disposition: attachment; filename="ajanlat.pdf"', 'Content-Transfer-Encoding: base64', '',
  pdf.toString('base64').replace(/.{76}/g, '$&\r\n'), '--B--', '',
].join('\r\n')))
// a newsletter with a hidden preheader; its search text is made on the worker thread (in the asar)
pop.add(newsletterEml({ subject: 'Csomag hirlevel', blocks: 600, rules: 20, hidden: 'csomagrejtettszo', visible: 'csomaglathatoszo' }))

// the app's default data folder: next to the exe
const dataDir = path.join(appDir, 'data')
{
  fs.mkdirSync(dataDir, { recursive: true })
  const { db, vault } = await createVaultedDatabase(dataDir, MASTER) // vault.json + the encrypted mail.sqlite
  new AccountStore(db, vault, { storeDir: path.join(dataDir, 'store') }).save({
    ...newAccountDefaults('pop3'), name: 'Csomagpróba', email: ME, display_name: 'Teszt Elek',
    in_host: '127.0.0.1', in_port: pop.port, in_security: 'none', in_user: pop.user, in_password: pop.pass,
    smtp_host: '127.0.0.1', smtp_port: smtp.server.address().port, smtp_security: 'none', smtp_same_password: false, smtp_password: 'jo-jelszo',
  })
  db.close()
}

function ps(args) {
  return execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', footprint, ...args], { encoding: 'utf8' })
}

let port = 9400 + Math.floor(Math.random() * 400)
async function launch(dir) {
  port++
  const env = { ...process.env }
  delete env.SHADOWMAIL_DATA
  delete env.SHADOWMAIL_SMOKE
  const proc = spawn(path.join(dir, 'ShadowMail.exe'), [`--remote-debugging-port=${port}`], { cwd: dir, env, stdio: 'ignore' })
  let browser = null
  for (let i = 0; i < 60 && !browser; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    } catch {
      await sleep(500)
    }
  }
  if (!browser) throw new Error('no DevTools endpoint')
  const context = browser.contexts()[0]
  let page = context.pages().find(p => p.url().includes('index.html'))
  for (let i = 0; i < 40 && !page; i++) {
    await sleep(250)
    page = context.pages().find(p => p.url().includes('index.html'))
  }
  await page.setViewportSize({ width: 1280, height: 900 })
  return { proc, browser, context, page }
}

// the Windows clipboard as other programs see it (formats and text), read with PowerShell
function windowsClipboard() {
  const cmd = "Add-Type -AssemblyName System.Windows.Forms; $d=[System.Windows.Forms.Clipboard]::GetDataObject(); " +
    "$o=@{formats=@(); text=''}; if($d){ $o.formats=@($d.GetFormats()); $o.text=[System.Windows.Forms.Clipboard]::GetText() }; " +
    "foreach($f in 'ExcludeClipboardContentFromMonitorProcessing','CanIncludeInClipboardHistory','CanUploadToCloudClipboard'){ $x=$null; if($d){ $x=$d.GetData($f) }; if($x -is [System.IO.MemoryStream]){ $o[$f]=@($x.ToArray()) } }; " +
    "$o | ConvertTo-Json -Compress"
  const r = spawnSync('powershell.exe', ['-NoProfile', '-STA', '-Command', cmd], { encoding: 'utf8' })
  return JSON.parse(r.stdout.trim() || '{}')
}
async function clipboardSettles(want, tries = 30) {
  let c = windowsClipboard()
  for (let i = 0; i < tries && !want(c); i++) {
    await sleep(100)
    c = windowsClipboard()
  }
  return c
}

async function quit({ proc, browser, page }) {
  // the user's way out: the main window closes, the app quits (will-quit: lock, close, empty data\tmp).
  // Browser.close over CDP does not quit an Electron app (measured: killed after 10 s, nothing cleaned).
  await page.evaluate(() => window.close()).catch(() => {})
  for (let i = 0; i < 40 && proc.exitCode === null; i++) await sleep(250)
  await browser.close().catch(() => {})
  if (proc.exitCode === null) {
    proc.kill()
    return false
  }
  return true
}

const snap = path.join(work, 'footprint-before.txt')
console.log(ps(['-Mode', 'snapshot', '-Out', snap]).trim())
const since = new Date().toISOString()
await sleep(1500)

let app
try {
  app = await launch(appDir)
  const { page, context } = app
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: 'Feloldás', exact: true }).click()
  await page.locator('.folder-tree .account-name', { hasText: 'Csomagpróba' }).waitFor({ timeout: 20_000 })
  check('unlocked, the account is there', true)
  // the version in the zip name and in the exe's About (app.getVersion())
  const pkgVersion = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version
  const hello = await page.evaluate(() => window.shadowMail.hello())
  check('version: the zip name and the About box show package.json\'s version', path.basename(values.zip).includes(`-${pkgVersion}-`) && hello.appVersion === pkgVersion, `${path.basename(values.zip)} | About ${hello.appVersion} | package.json ${pkgVersion}`)
  await page.locator('.msg-row', { hasText: 'Csomagpróba levél' }).waitFor({ timeout: 20_000 })
  const folders = await page.locator('.folder-tree .folder-label').allInnerTexts()
  check('folders loaded, the message downloaded', ['Beérkezett', 'Elküldött', 'Piszkozatok', 'Kuka'].every(f => folders.includes(f)), JSON.stringify(folders))
  await page.locator('.msg-row', { hasText: 'Csomagpróba levél' }).click()
  await page.locator('.reader .mail-text').waitFor()
  check('a message opens (accents, attachment listed)', /hőszivattyú-ajánlat/.test(await page.locator('.reader .mail-text').innerText()) && (await page.locator('.reader-attachments li[data-filename="ajanlat.pdf"]').count()) === 1)
  await page.getByRole('searchbox', { name: 'Keresés' }).fill('pipacsmezo')
  await page.locator('.result').first().waitFor({ timeout: 10_000 })
  check('search finds (accent-free)', (await page.locator('.result .result-subject').allInnerTexts()).includes('Csomagpróba levél'))
  // the worker thread starts in the package: the newsletter's hidden preheader leaves the local search, its visible
  // word stays (the old text is there at once, the worker's visible text replaces it)
  const hits = q => page.evaluate(query => window.shadowMail.search.local({ query }).then(r => (r.ok ? r.rows.length : -1)), q)
  let f1 = { hidden: -1, visible: -1 }
  for (let i = 0; i < 100; i++) {
    f1 = { hidden: await hits('csomagrejtettszo'), visible: await hits('csomaglathatoszo') }
    if (f1.hidden === 0 && f1.visible === 1) break
    await sleep(200)
  }
  check('the search-text worker runs in the package (the hidden word 0 hits, the visible 1)', f1.hidden === 0 && f1.visible === 1, JSON.stringify(f1))
  await page.getByRole('searchbox', { name: 'Keresés' }).press('Escape')
  // with the Windows fonts, 1280 px wide, the folder view's chip row is ONE line
  // with the on/off chips on; the screenshot goes into the work folder (chip-row-1280.png)
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.locator('.list-header').waitFor()
  if (!(await page.locator('.search-chips').count())) await page.getByRole('button', { name: 'Szűrők', exact: true }).click()
  for (const name of ['Van melléklet', 'Olvasatlan', 'Csillagos']) await page.locator('.search-chips').getByRole('button', { name, exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.search-chips button.chip[aria-pressed="true"]').length === 3)
  await sleep(300)
  const chipRow = await page.locator('.search-chips').evaluate(el => {
    const chips = [...el.querySelectorAll('button.chip')]
    const cs = getComputedStyle(el)
    return {
      lines: new Set(chips.map(e => Math.round(e.getBoundingClientRect().top))).size,
      chips: chips.length,
      used: Math.round(chips.reduce((s, e) => s + e.getBoundingClientRect().width, 0) + (chips.length - 1) * parseFloat(cs.columnGap)),
      row: Math.round(el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)),
      window: document.documentElement.clientWidth,
      segoe: document.fonts.check('14px "Segoe UI"'),
    }
  })
  await page.screenshot({ path: path.join(work, 'chip-row-1280.png') })
  check('0.10.1: the chip row is one line at 1280 px (Windows fonts, 3 chips on)', chipRow.lines === 1 && chipRow.window === 1280, JSON.stringify(chipRow))
  await page.locator('.list-header .clear-filters').click()
  await page.setViewportSize({ width: 1280, height: 900 })
  const [composer] = await Promise.all([context.waitForEvent('page', { timeout: 15_000 }), page.getByRole('button', { name: 'Új levél', exact: true }).click()])
  await composer.setViewportSize({ width: 900, height: 700 })
  await composer.waitForFunction(() => document.querySelector('#compose-from')?.textContent.trim())
  await composer.locator('#compose-to').fill(ME)
  await composer.locator('#compose-subject').fill('Csomagpróba küldés')
  await composer.locator('.editor').click()
  await composer.keyboard.type('Ez a csomagból ment ki.')
  await Promise.all([composer.waitForEvent('close', { timeout: 20_000 }), composer.getByRole('button', { name: 'Küldés', exact: true }).click()])
  check('a message is sent (local SMTP got it)', received.length === 1 && /Csomagpr/.test(received[0].toString('latin1')))
  // 0.12.0: the address book and the source view on the real exe
  const call = (fn, ...args) => page.evaluate(([f, a]) => window.shadowMail[f.split('.')[0]][f.split('.')[1]](...a), [fn, args])
  const people0 = await call('contacts.list', {})
  // (whether a message to one's own address makes a person is not asserted here: the recipient is the account's address)
  check('after the send there is an automatic person', people0.ok && people0.items.some(p => p.source === 'auto'), JSON.stringify((people0.items || []).map(p => [p.address, p.source])))
  const fixtures = path.join(repo, 'test', 'fixtures', 'contacts')
  const recentBefore = recentSnap()
  const regBefore = regNames(path.join(work, 'comdlg-before.reg'))
  const softwareBefore = softwareKeys()
  // the two fixtures share addresses (arviz@, tukor@): the second may be all unchanged, which is right
  for (const f of ['gmail-3.0.vcf', 'google-new.csv']) {
    const answered = answerFileDialog(app.proc.pid, path.join(fixtures, f))
    const pre = await call('contacts.importPreview')
    const d = await answered
    const applied = pre.ok && pre.token ? await call('contacts.importApply', pre.token) : null
    check(`${f} imported through the real Open dialog (preview, then apply)`, d.code === 0 && pre.ok && applied && applied.ok && applied.counts.new + applied.counts.merged + applied.counts.unchanged > 0, JSON.stringify({ dialog: d.out, preview: pre.counts || pre.error, applied: applied && (applied.counts || applied.error) }))
  }
  for (const fmt of ['vcf', 'csv']) {
    const out = path.join(work, `c6-export.${fmt}`)
    const answered = answerFileDialog(app.proc.pid, out, true)
    const r = await call('contacts.export', { all: true, format: fmt })
    const d = await answered
    const text = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : ''
    const cards = (text.match(/^BEGIN:VCARD/gm) || []).length
    check(`exported to ${fmt} through the real Save dialog`, d.code === 0 && r.ok && r.saved && r.count > 1 && (fmt === 'vcf' ? cards === r.count : /^\uFEFFName,/.test(text) || /^Name,/.test(text)), JSON.stringify({ dialog: d.out, saved: r.saved, count: r.count, cards, bytes: text.length }))
  }
  const firstId = Number(await page.locator('.msg-row[data-id]').first().getAttribute('data-id'))
  const src = await call('mail.source', firstId)
  check('the source of a message (headers, the summary, the size)', src.ok && /^Subject:/m.test(src.headers) && Boolean(src.summary && src.summary.subject) && src.size > 0, JSON.stringify({ ok: src.ok, size: src.size, subject: Boolean(src.summary && src.summary.subject) }))
  {
    const out = path.join(work, 'c6-source.eml')
    const answered = answerFileDialog(app.proc.pid, out, true)
    const r = await call('mail.saveSource', firstId)
    const d = await answered
    const size = fs.existsSync(out) ? fs.statSync(out).size : -1
    let zone = ''
    try {
      zone = fs.readFileSync(`${out}:Zone.Identifier`, 'utf8')
    } catch {}
    const recentAfter = recentSnap()
    const shortcuts = recentBefore && recentAfter ? Object.keys(recentAfter).filter(n => recentBefore[n] !== recentAfter[n]) : null
    check('the native dialogs left no shortcut in the Windows Recent folder (new or rewritten)', Array.isArray(shortcuts) && shortcuts.length === 0, JSON.stringify(shortcuts))
    const regAfter = regNames(path.join(work, 'comdlg-after.reg'))
    const changed = regBefore && regAfter ? [...regAfter.keys()].filter(k => regBefore.get(k) !== regAfter.get(k)) : null
    console.log(`MEASURED ComDlg32 (the common dialog's MRU, names only): ${changed === null ? 'not readable' : changed.length ? `${changed.length} value(s) new or changed: ${changed.join('; ')}` : 'no change'}`)
    // the ONLY accepted registry change is ComDlg32\LastVisitedPidlMRU (the README names it); anything else fails
    const otherComDlg = changed === null ? null : changed.filter(k => !k.startsWith('ComDlg32\\LastVisitedPidlMRU |'))
    const softwareAfter = softwareKeys()
    const newSoftware = softwareBefore && softwareAfter ? softwareAfter.filter(k => !softwareBefore.includes(k)) : null
    check('the registry: no change but ComDlg32\\LastVisitedPidlMRU (README), and no new HKCU\\Software key', Array.isArray(otherComDlg) && otherComDlg.length === 0 && Array.isArray(newSoftware) && newSoftware.length === 0, JSON.stringify({ otherComDlg, newSoftware }))
    check('the .eml saved through the real Save dialog, whole, marked as from the internet (Zone.Identifier)', d.code === 0 && r.ok && size === src.size && /ZoneId=3/.test(zone), JSON.stringify({ dialog: d.out, size, sourceSize: src.size, motw: /ZoneId=3/.test(zone) }))
  }
  // locked, the app holds no handle on mail.sqlite: on Windows an open file cannot be renamed, so
  // the rename is the measurement; then the database opens again with the master password
  const dbFile = path.join(dataDir, 'mail.sqlite')
  check('mail.sqlite is encrypted (not the SQLite header)', !fs.readFileSync(dbFile).subarray(0, 16).equals(Buffer.from('SQLite format 3\0', 'latin1')))
  await page.evaluate(() => window.shadowMail.vault.lock())
  let renamed = false
  for (let i = 0; i < 50 && !renamed; i++) {
    try {
      fs.renameSync(dbFile, `${dbFile}.zarolva`)
      fs.renameSync(`${dbFile}.zarolva`, dbFile)
      renamed = true
    } catch {
      await sleep(200) // the sync stops first, then the database closes
    }
  }
  check('locked, mail.sqlite can be renamed (no handle left on it)', renamed)
  await page.reload()
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: 'Feloldás', exact: true }).click()
  await page.getByRole('button', { name: 'Új levél', exact: true }).waitFor({ timeout: 20_000 })
  // "Másolás" of a new recovery code: the text with the history / cloud opt-out formats; the lock clears it
  // (this smoke uses the real Windows clipboard: whatever was on it is replaced, and it is left empty)
  const copyNewCode = async () => {
    const made = await page.evaluate(m => window.shadowMail.vault.newRecoveryCode(m), MASTER)
    const copied = await page.evaluate(c => window.shadowMail.vault.copyRecoveryCode(c), made.recoveryCode)
    return { code: made.recoveryCode, ok: made.ok && copied.ok }
  }
  let copy = await copyNewCode()
  const onClip = windowsClipboard()
  const fmt = name => JSON.stringify(onClip[name] || null)
  check('"Másolás": the code on the Windows clipboard, kept out of the history and the cloud clipboard',
    copy.ok && onClip.text === copy.code && fmt('ExcludeClipboardContentFromMonitorProcessing') === '[1,0,0,0]' && fmt('CanIncludeInClipboardHistory') === '[0,0,0,0]' && fmt('CanUploadToCloudClipboard') === '[0,0,0,0]',
    `formats: ${(onClip.formats || []).join(',')}`)
  await page.evaluate(() => window.shadowMail.vault.lock())
  const afterLock = await clipboardSettles(c => c.text !== copy.code)
  check('the lock clears the code from the clipboard', afterLock.text === '', afterLock.text ? 'something left' : 'empty')
  await page.reload()
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: 'Feloldás', exact: true }).click()
  await page.getByRole('button', { name: 'Új levél', exact: true }).waitFor({ timeout: 20_000 })
  copy = await copyNewCode()
  // something in data\tmp, so the cleanup on quit has work to do
  fs.writeFileSync(path.join(dataDir, 'tmp', 'marad-e.txt'), 'x')
  check('quit cleanly', await quit(app))
  const afterQuit = windowsClipboard()
  check('the quit clears the code from the clipboard', copy.ok && afterQuit.text === '', afterQuit.text ? 'something left' : 'empty')
  app = null
  await sleep(1500)
  // the downloaded, opened and searched message's words are in no file of the data folder (UTF-8,
  // UTF-16LE): the database, the -wal, the mail files, the Chromium folders, the logs
  {
    const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]))
    const needles = ['pipacsmező', 'hőszivattyú', 'anna@example.invalid'].flatMap(w => [Buffer.from(w, 'utf8'), Buffer.from(w, 'utf16le')])
    const all = walk(dataDir)
    const found = all.filter(f => {
      try {
        const b = fs.readFileSync(f)
        return needles.some(n => b.includes(n))
      } catch {
        return false // a file Windows still holds: it is not a mail file
      }
    })
    check('grep: the message words are in no file of the data folder', found.length === 0, `${all.length} files; found in: ${found.map(f => path.relative(dataDir, f)).join(', ') || 'none'}`)
  }
  check('data\\tmp empty after quit', fs.readdirSync(path.join(dataDir, 'tmp')).length === 0, fs.readdirSync(path.join(dataDir, 'tmp')).join(','))
  const netLog = path.join(dataDir, 'electron', 'logs', 'net-guard.log')
  check('the net-guard log has no outgoing request', !fs.existsSync(netLog) || fs.readFileSync(netLog, 'utf8').trim() === '')
  const diff = ps(['-Mode', 'diff', '-Before', snap, '-Since', since])
  // another browser's own crash reporter (Chrome, Edge: "Crashpad" in the path) is not this app (measured: Chrome's Crashpad\settings.dat)
  const OTHER_APP = /\\(Google\\Chrome|Microsoft\\Edge|BraveSoftware|Mozilla)\\/i
  const suspect = diff.split(/\r?\n/).filter(l => /^\s*! /.test(l) && !OTHER_APP.test(l))
  // other programs write there meanwhile; these are theirs (judged once, listed every time):
  // "{GUID} - OProcSessId.dat" is Microsoft Office's process session file
  const FOREIGN = [/\\\{[0-9A-F-]{36}\} - OProcSessId\.dat$/i]
  const added = diff.split(/\r?\n/).filter(l => /^\s*\+ /.test(l))
  const unknown = added.filter(l => !FOREIGN.some(re => re.test(l.trim())))
  // every line, the "modified since" ones too: other programs' files are judged by reading them
  console.log(diff.trim().split(/\r?\n/).map(l => `    ${l}`).join('\n'))
  check('nothing app-related outside the data folder', suspect.length === 0 && unknown.length === 0,
    `${suspect.length} app-related, ${added.length} new top-level (${added.length - unknown.length} known foreign): ${added.map(l => l.trim()).join(' ; ')}`)

  // an UNENCRYPTED data folder of an earlier build is refused untouched (no
  // A -> B migration); an encrypted one of an earlier build unlocks with its accounts and messages
  if (values.upgrade && dataFolderState(path.resolve(values.upgrade)) === 'legacy_plain') {
    const upDir = path.join(work, 'upgrade')
    fs.cpSync(appDir, upDir, { recursive: true, filter: src => !src.startsWith(dataDir) })
    fs.cpSync(path.resolve(values.upgrade), path.join(upDir, 'data'), { recursive: true })
    const upData = path.join(upDir, 'data')
    const snapshot = () => fs.readdirSync(upData, { recursive: true }).sort().map(n => [n, fs.statSync(path.join(upData, n)).size, fs.statSync(path.join(upData, n)).mtimeMs])
    const before = snapshot()
    const env = { ...process.env, SHADOWMAIL_SMOKE: '1' } // the refusal on stderr instead of a dialog
    delete env.SHADOWMAIL_DATA
    const r = spawnSync(path.join(upDir, 'ShadowMail.exe'), [], { cwd: upDir, env, encoding: 'utf8', timeout: 60_000 })
    check('older UNENCRYPTED data folder: refused (exit code 3), nothing in it created or changed', r.status === 3 && JSON.stringify(snapshot()) === JSON.stringify(before), `status=${r.status} ${String(r.stderr || '').trim().split(/\r?\n/).slice(-1)[0] || ''}`)
  } else if (values.upgrade) {
    const upDir = path.join(work, 'upgrade')
    fs.cpSync(appDir, upDir, { recursive: true, filter: src => !src.startsWith(dataDir) })
    fs.cpSync(path.resolve(values.upgrade), path.join(upDir, 'data'), { recursive: true })
    app = await launch(upDir)
    await app.page.locator('#vault-unlock').fill(values.upgradeMaster)
    await app.page.getByRole('button', { name: 'Feloldás', exact: true }).click()
    await app.page.locator('.folder-tree .account-name').first().waitFor({ timeout: 20_000 })
    const footer = await app.page.locator('.list-count').getAttribute('data-total').catch(() => '')
    const accounts = await app.page.locator('.folder-tree .account-name').allInnerTexts()
    check('upgrade: the older data folder unlocks, its account and messages are there', accounts.length > 0 && Number(footer) > 0, `${accounts.join(',')} | ${footer}`)
    // a word of the older folder's mail: an older package smoke's folder has pipacsmezo, the folder seed szamla
    await app.page.getByRole('searchbox', { name: 'Keresés' }).fill(values.upgradeSearch || 'szamla')
    await app.page.locator('.result').first().waitFor({ timeout: 10_000 }).catch(() => {})
    check('upgrade: the index answers', (await app.page.locator('.result').count()) > 0)
    // 0.12.0: the migration 5 from a 0.11.x folder: its backup, the old contacts rows as automatic people, the settings
    const upPeople = await app.page.evaluate(() => window.shadowMail.contacts.list({}))
    const autos = upPeople.ok ? upPeople.items.filter(p => p.source === 'auto').length : -1
    const mcp = await app.page.evaluate(() => window.shadowMail.mcp.status())
    const bakName = values.upgradeBak ? `mail.sqlite.bak-${values.upgradeBak}` : null
    const bak = bakName ? fs.existsSync(path.join(upDir, 'data', bakName)) : true
    check(`upgrade: ${bakName || 'no backup asked'} there, the old contacts are automatic people, the settings answer`, bak && autos > 0 && mcp.ok, JSON.stringify({ bak: bakName && bak, autos, total: upPeople.total, settings: mcp.ok }))
    await quit(app)
    app = null
  }
} catch (err) {
  check('run', false, err.stack)
} finally {
  if (app) await quit(app)
  await pop.close()
  smtp.close(() => {})
}
console.log(`\n${results.filter(Boolean).length} / ${results.length} OK`)
process.exit(results.every(Boolean) ? 0 : 1)
