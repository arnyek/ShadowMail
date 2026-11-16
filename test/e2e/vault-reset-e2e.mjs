#!/usr/bin/env node
// The recovery code and the forgotten master password in the real app, headless Electron +
// Playwright. Not part of `npm test`.
//
//   node test/e2e/vault-reset-e2e.mjs
//
// 1. First start: master password -> the code screen; a wrong group keeps "Megvan, tovább" disabled, the
//    right one lets it through. A POP3 account (fake server, 3 messages) is added.
// 2. Lock -> "Elfelejtettem" -> "Van helyreállító kódom" -> code + new password -> the same mail list ->
//    the new code's screen is compulsory.
// 3. Lock -> "Elfelejtettem" -> "Nincs kódom" -> without "TÖRLÉS" the button is disabled -> new password ->
//    an empty program and the code screen; the app quits WITHOUT confirming it -> after the next unlock the
//    bar is there, and Settings makes a new code.
// 4. None of the codes is in the main log or in any file of the data folder.
// 5. "Másolás" puts the code on the clipboard with the 60 s note; the lock clears it. A data folder in
//    the undecidable "E" state (a reset folder with old data and a damaged mark): the lock screen offers
//    "Újrakezdés befejezése" -> TÖRLÉS + new password -> the code screen and an empty program.
// 6. a version 1 vault.json (an earlier development build): the lock screen shows the vault_old_version
//    text with no password field, the forgotten-password way still there; a version 3 one: the newer text,
//    no way on, and the data folder unchanged.
// Playwright: PW=<path of the playwright package> (default: the repo's playwright-core devDependency).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { FakePop3Server } from '../helpers/fake-pop3.js'
import { newAccountDefaults } from '../../core/accounts/defaults.js'
import { t, seedLanguage } from './lang.mjs'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const FIRST = 'Elso-mesterjelszo-helyreallitas'
const SECOND = 'Masodik-mesterjelszo-helyreallitas'
const THIRD = 'Harmadik-mesterjelszo-helyreallitas'
const FOURTH = 'Negyedik-mesterjelszo-ujrakezdes'
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// "type group <n> of the code": the group number
const groupRe = new RegExp(reEsc(t.recoveryCheck(7)).replace('7', '(\\d)'))

const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const pop = await new FakePop3Server().listen()
for (let i = 1; i <= 3; i++) pop.add(Buffer.from(`From: Feladó <f@example.invalid>\r\nTo: t@example.invalid\r\nSubject: Megmaradó levél ${i}\r\nDate: ${new Date().toUTCString()}\r\n\r\nszöveg ${i}\r\n`))
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-k19-'))
const dataDir = path.join(work, 'data')
fs.mkdirSync(dataDir)
// once: the resets keep data\ui.json (only the old data moves), so every later launch must still be in this language
seedLanguage(dataDir)
const codes = []

const watchdog = setTimeout(() => {
  console.log('FAIL watchdog: the run took more than 5 minutes')
  process.exit(1)
}, 300_000)
watchdog.unref()

const launch = () => _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })

// the code screen: reads the code, tries a wrong group, then the right one
async function passCodeScreen(page, label) {
  await page.locator('#recovery-code').waitFor({ timeout: 20_000 })
  const code = (await page.locator('#recovery-code').innerText()).trim()
  codes.push(code)
  const n = Number(groupRe.exec(await page.locator('label[for="recovery-check"]').innerText())[1])
  const group = code.split('-')[n - 1]
  const done = page.getByRole('button', { name: t.recoveryDone, exact: true })
  await page.locator('#recovery-check').fill(group === 'AAAAA' ? 'BBBBB' : 'AAAAA')
  const blocked = await done.isDisabled()
  await page.locator('#recovery-check').fill(group.toLowerCase()) // case does not matter
  const open = await done.isEnabled()
  check(`${label}: the code screen; a wrong group keeps the way closed, the right one opens it`, /^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){4}$/.test(code) && blocked && open, code.replace(/[A-Z0-9]/g, 'x'))
  await done.click()
  await page.locator('#recovery-code').waitFor({ state: 'detached', timeout: 20_000 })
  return code
}
// the message count is the list header's data-total (it was the footer's text)
const footer = page => page.locator('.list-count').getAttribute('data-total').catch(() => '')
const lock = async page => {
  await page.getByRole('button', { name: t.vaultLockButton, exact: true }).click()
  await page.locator('#vault-unlock').waitFor({ timeout: 15_000 })
}

let app = await launch()
try {
  let page = await app.firstWindow()
  await page.setViewportSize({ width: 1280, height: 900 })
  // 1. first start
  await page.locator('#vault-new').fill(FIRST)
  await page.locator('#vault-new-again').fill(FIRST)
  await page.getByRole('button', { name: t.vaultCreateButton, exact: true }).click()
  // "Másolás" from the main process, with the note
  await page.locator('#recovery-code').waitFor({ timeout: 20_000 })
  await page.getByRole('button', { name: t.recoveryCopy, exact: true }).click()
  await page.locator('p.ok', { hasText: t.recoveryCopied }).waitFor({ timeout: 5_000 })
  const shownCode = (await page.locator('#recovery-code').innerText()).trim()
  const onClipboard = await app.evaluate(({ clipboard }) => clipboard.readText())
  check('"Másolás" puts the code on the clipboard, the note says it goes in 60 s', onClipboard === shownCode && (await page.locator('#recovery-clipboard-note').innerText()) === t.recoveryClipboardNote, onClipboard ? 'something on the clipboard' : 'empty clipboard')
  // the code in five monospace groups; "Mentés fájlba" writes it where the (stubbed) dialog says
  const look = await page.locator('#recovery-code').evaluate(el => ({ groups: el.querySelectorAll('.code-group').length, font: getComputedStyle(el).fontFamily }))
  check('the code in 5 groups, monospace', look.groups === 5 && /Cascadia Mono|Consolas|monospace/.test(look.font), JSON.stringify(look))
  const codeFile = path.join(work, 'helyreallito-kod.txt')
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file })
  }, codeFile)
  await page.getByRole('button', { name: t.recoverySave, exact: true }).click()
  await page.locator('p.ok', { hasText: t.recoverySaved }).waitFor({ timeout: 5_000 }).catch(() => {})
  const fileText = fs.existsSync(codeFile) ? fs.readFileSync(codeFile, 'utf8') : ''
  check('"Mentés fájlba" saves the code', fileText.includes(shownCode), fileText ? 'the file has the code' : 'no file')
  fs.rmSync(codeFile, { force: true })
  const firstCode = await passCodeScreen(page, 'first start')
  await page.getByRole('button', { name: t.newMessage, exact: true }).waitFor({ timeout: 20_000 })
  const saved = await page.evaluate(form => window.shadowMail.accounts.save(form), {
    ...newAccountDefaults('pop3'), name: 'POP3-fiók', email: 't@example.invalid', in_host: '127.0.0.1', in_port: pop.port, in_security: 'none',
    in_user: pop.user, in_password: pop.pass, smtp_host: '127.0.0.1', smtp_port: 1, smtp_security: 'none',
  })
  check('a POP3 account added', saved.ok, JSON.stringify(saved.error || ''))
  await page.locator('.msg-row', { hasText: 'Megmaradó levél 3' }).waitFor({ timeout: 30_000 })
  const listBefore = await footer(page)

  // 2. with the code
  const beforeLock = await app.evaluate(({ clipboard }) => clipboard.readText())
  const stillThere = beforeLock === firstCode
  await lock(page)
  // the clipboard is asynchronous (Electron 45): the clear lands right after the lock
  let afterLock = null
  for (let i = 0; i < 30 && afterLock !== ''; i++) {
    afterLock = await app.evaluate(({ clipboard }) => clipboard.readText())
    if (afterLock !== '') await new Promise(r => setTimeout(r, 100))
  }
  check('the lock clears the code from the clipboard (it was still there before)', stillThere && afterLock === '', `before: ${beforeLock ? (stillThere ? 'the code' : 'other text') : 'empty'}, after: ${afterLock ? (afterLock === firstCode ? 'the code' : 'other text') : 'empty'}`)
  await page.getByRole('button', { name: t.vaultForgot, exact: true }).click()
  await page.getByRole('button', { name: t.vaultForgotHaveCode, exact: true }).click()
  await page.locator('#vault-recover-code').fill(firstCode.toLowerCase().replace(/-/g, ' '))
  await page.locator('#vault-recover-new').fill(SECOND)
  await page.locator('#vault-recover-again').fill(SECOND)
  await page.getByRole('button', { name: t.vaultRecoverButton, exact: true }).click()
  const secondCode = await passCodeScreen(page, 'after the recovery (compulsory new code)')
  await page.getByRole('button', { name: t.newMessage, exact: true }).waitFor({ timeout: 20_000 })
  check('the new code differs from the used one', secondCode !== firstCode)
  await page.locator('.msg-row', { hasText: 'Megmaradó levél 3' }).waitFor({ timeout: 20_000 })
  check('after the recovery the mail list is the same', (await footer(page)) === listBefore, `${listBefore} -> ${await footer(page)}`)

  // 3. without the code
  await lock(page)
  await page.getByRole('button', { name: t.vaultForgot, exact: true }).click()
  await page.getByRole('button', { name: t.vaultForgotNoCode, exact: true }).click()
  const wipe = page.getByRole('button', { name: t.vaultResetButton, exact: true })
  await page.locator('#vault-reset-new').fill(THIRD)
  await page.locator('#vault-reset-again').fill(THIRD)
  check('without "TÖRLÉS" the button is disabled', await wipe.isDisabled())
  check('the warning says every local data goes', (await page.locator('.warning').innerText()).includes(t.vaultResetWarning))
  await page.locator('#vault-reset-word').fill(t.resetConfirmWord)
  await wipe.click()
  await page.locator('#recovery-code').waitFor({ timeout: 20_000 })
  codes.push((await page.locator('#recovery-code').innerText()).trim())
  // quit without confirming the code
  await app.close()
  app = await launch()
  page = await app.firstWindow()
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.locator('#vault-unlock').fill(THIRD)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  await page.getByRole('button', { name: t.newMessage, exact: true }).waitFor({ timeout: 20_000 })
  const accounts = await page.evaluate(async () => (await window.shadowMail.accounts.list()).accounts.length)
  check('after the reset: an empty program (0 accounts)', accounts === 0, String(accounts))
  const bar = page.locator('.notice', { hasText: t.recoveryUnconfirmed })
  check('an unconfirmed code: the bar after the next unlock', (await bar.count()) === 1)
  await bar.getByRole('button').click() // to Settings
  await page.locator('#recovery-new-password').fill(THIRD)
  await page.getByRole('button', { name: t.recoveryNewButton, exact: true }).click()
  await passCodeScreen(page, 'Settings: a new code')
  check('confirmed: the bar is gone', (await page.locator('.notice', { hasText: t.recoveryUnconfirmed }).count()) === 0)
  await app.close()

  // 5. the "E" state, made by hand as a cut reset leaves it: the old data in a reset folder, a damaged old mark
  const trash = path.join(dataDir, 'reset-trash-1')
  fs.mkdirSync(path.join(trash, 'old'), { recursive: true })
  fs.mkdirSync(path.join(trash, 'new'))
  for (const n of fs.readdirSync(dataDir)) if (n === 'store' || n.startsWith('mail.sqlite')) fs.renameSync(path.join(dataDir, n), path.join(trash, 'old', n))
  fs.writeFileSync(path.join(trash, 'vault.json.old'), '')
  app = await launch()
  page = await app.firstWindow()
  await page.setViewportSize({ width: 1280, height: 900 })
  const pendingNote = page.locator('#vault-reset-pending')
  await pendingNote.waitFor({ timeout: 20_000 })
  check('the "E" folder: the lock screen explains and offers "Újrakezdés befejezése"', (await pendingNote.innerText()).includes(t.vaultResetPendingText) && (await page.getByRole('button', { name: t.vaultFinishResetButton, exact: true }).count()) === 1)
  check('nothing deleted by itself', fs.existsSync(path.join(trash, 'old', 'mail.sqlite')))
  await page.getByRole('button', { name: t.vaultFinishResetButton, exact: true }).click()
  const finish = page.locator('form.vault').getByRole('button', { name: t.vaultFinishResetButton, exact: true })
  await page.locator('#vault-reset-new').fill(FOURTH)
  await page.locator('#vault-reset-again').fill(FOURTH)
  const blockedWithoutWord = await finish.isDisabled()
  await page.locator('#vault-reset-word').fill(t.resetConfirmWord)
  await finish.click()
  await passCodeScreen(page, 'after "Újrakezdés befejezése"')
  await page.getByRole('button', { name: t.newMessage, exact: true }).waitFor({ timeout: 20_000 })
  const left = await page.evaluate(async () => (await window.shadowMail.accounts.list()).accounts.length)
  check('without "TÖRLÉS" disabled; after it an empty program (0 accounts), no reset folder left', blockedWithoutWord && left === 0 && !fs.readdirSync(dataDir).some(n => n.startsWith('reset-trash-')), `${left} accounts`)
  await app.close()

  // 6. another version's vault.json
  const vaultJson = path.join(dataDir, 'vault.json')
  const good = fs.readFileSync(vaultJson, 'utf8')
  // the user data (vault.json, mail.sqlite*, store\, reset folders); every start writes the runtime folders
  // data\electron (log, Chromium profile) and data\tmp (the writable-folder probe), whatever the version
  const listing = () => fs.readdirSync(dataDir, { recursive: true }).filter(n => !n.startsWith('electron') && !n.startsWith('tmp')).sort().map(n => `${n}|${fs.statSync(path.join(dataDir, n)).mtimeMs}`).join(',')
  for (const [version, want, forgot] of [[1, t.vaultErrors.vault_old_version, true], [3, t.vaultErrors.vault_newer_version, false]]) {
    fs.writeFileSync(vaultJson, JSON.stringify({ ...JSON.parse(good), version }))
    const before = listing()
    app = await launch()
    page = await app.firstWindow()
    await page.setViewportSize({ width: 1280, height: 900 })
    const note = page.locator('#vault-version-problem')
    await note.waitFor({ timeout: 20_000 })
    const text = await note.innerText()
    const hasPassword = (await page.locator('#vault-unlock').count()) > 0
    const hasForgot = (await page.getByRole('button', { name: t.vaultForgot, exact: true }).count()) === 1
    await app.close()
    check(`version ${version}: the lock screen explains, no password field${forgot ? ', the forgotten-password way stays' : ', no way on'}; the user data unchanged`, text.includes(want) && !hasPassword && hasForgot === forgot && listing() === before, `password field: ${hasPassword}, forgot: ${hasForgot}, changed: ${listing() === before ? 'none' : listing().split(',').filter(x => !before.split(',').includes(x)).join(' ')}`)
  }
  fs.writeFileSync(vaultJson, good)
  app = await launch()
  page = await app.firstWindow()
} catch (err) {
  check('run', false, err.stack)
} finally {
  await app.close().catch(() => {})
  await pop.close()
}

// 4. no code in the log or anywhere under data\
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]))
const forms = codes.flatMap(c => [c, c.replace(/-/g, '')]).flatMap(c => [Buffer.from(c, 'utf8'), Buffer.from(c, 'utf16le')])
const files = walk(dataDir)
const found = files.filter(f => forms.some(x => fs.readFileSync(f).includes(x)))
check(`no recovery code (${codes.length}, grouped or normalized) in any file of the data folder or the log`, codes.length >= 4 && found.length === 0, `${files.length} files; found in: ${found.map(f => path.relative(dataDir, f)).join(', ') || 'none'}`)
const mainLog = fs.readFileSync(path.join(dataDir, 'electron', 'logs', 'main.log'), 'utf8')
check('the main log: no error or failure line', !/failed|error/i.test(mainLog), mainLog.trim().split('\n').filter(l => /failed|error/i.test(l)).join(' | '))

fs.rmSync(work, { recursive: true, force: true })
console.log(`\n${results.filter(Boolean).length} / ${results.length} OK`)
process.exit(results.every(Boolean) ? 0 : 1)
