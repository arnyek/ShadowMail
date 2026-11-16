#!/usr/bin/env node
// MCP M3B in the real app: Claude's dangerous requests through the connector, decided in the
// app's confirmation Modal. Two POP3 accounts on fake POP3 servers (the second one's password is wrong, so its sync is
// stopped), the SMTP side a local smtp-server. Not part of `npm test`; takes about 2 minutes (one real 60 s wait).
//
//   node test/e2e/mcp-confirm-e2e.mjs [--shots <folder>]     (E2E_THEME=<id>: under that theme)
//
// Measures: send_message -> the Modal shows exactly the envelope; Enter at once rejects (0 messages); Jóváhagyás is
// not clickable before 1.5 s; approved -> 1 message whose envelope and subject are the Modal's, without the
// X-ShadowMail-Draft-Origin header, a local Sent copy; delete for good of 3 messages in the Trash (rejected: 3 stay,
// approved: 0), 501 ids -> error without a Modal; update_account (old -> new in the Modal, rejected: unchanged, a
// password field: error without a Modal, approved: saved); delete_folder and delete_account (rejected: unchanged,
// approved: as the UI's own Delete); send_draft; the restart of a stopped login (two parallel calls -> one Modal and
// the same id; rejected: 0 logins; approved: exactly 1, stopped again, no further attempt; with the right password the
// sync runs); after 60 s pending_confirmation, then confirmation_status gives the result; expired after 10 minutes
// (the main process's clock moved, no test hook in the code); the reply quote's link shows its real target; the
// Modal's "Mind elutasítása, Claude-hozzáférés ki" and Zárolás with two waiting requests reject both; quit too; the
// main.log has no subject, recipient or text; no console problem; the net-guard log is empty.
// The IMAP server side (the Trash on the server, one login per approval with IDLE) is in test/mcp-tools.test.js; the
// live IMAP points belong to a live test round.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { SMTPServer } from 'smtp-server'
import { simpleParser } from 'mailparser'
import { FakePop3Server } from '../helpers/fake-pop3.js'
import { createVaultedDatabase } from '../../core/vault/vaulted-db.js'
import { AccountStore } from '../../core/accounts/model.js'
import { newAccountDefaults } from '../../core/accounts/defaults.js'
import { t, seedLanguage } from './lang.mjs'
import { e2eTheme, useTheme } from './theme-env.mjs'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const MASTER = 'Teszt-mesterjelszo-M3B'
const USER = 'm3b@example.invalid'
const SMTP_PASSWORD = 'jo-smtp-jelszo-M3B'
const WRONG = 'rossz-jelszo-M3B'
// words that must never reach the main.log (subjects, recipients, texts of this run)
const SECRET_WORDS = ['Kuldott-targy-77', 'cimzett-anna-77', 'masolat-bela-77', 'titkos-cili-77', 'Kuldott-szoveg-77', 'Piszkozat-targy-77', 'Varakozo-targy-77']

const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}

const received = []
const smtp = new SMTPServer({
  disabledCommands: ['STARTTLS'],
  allowInsecureAuth: true,
  authMethods: ['PLAIN', 'LOGIN'],
  logger: false,
  onAuth: (auth, _s, cb) => (auth.password === SMTP_PASSWORD ? cb(null, { user: auth.username }) : cb(new Error('Invalid username or password'))),
  onData(stream, session, cb) {
    const chunks = []
    stream.on('data', c => chunks.push(c))
    stream.on('end', () => {
      received.push({ from: session.envelope.mailFrom.address, to: session.envelope.rcptTo.map(r => r.address), raw: Buffer.concat(chunks) })
      cb()
    })
  },
})
smtp.on('error', () => {})
await new Promise(r => smtp.listen(0, '127.0.0.1', r))
const smtpPort = smtp.server.address().port

const pop = await new FakePop3Server().listen()
const now = new Date().toUTCString()
for (const [i, subject] of ['Első levél', 'Második levél', 'Harmadik levél', 'Negyedik levél'].entries()) {
  pop.add(Buffer.from(`From: Feladó Ferenc <ferenc@example.invalid>\r\nTo: ${USER}\r\nSubject: ${subject}\r\nMessage-ID: <m3b-${i}@example.invalid>\r\nDate: ${now}\r\n\r\nszöveg ${i}\r\n`))
}
// a message whose link text names another site than its target: the reply quote keeps the link
pop.add(Buffer.from(`From: Feladó Ferenc <ferenc@example.invalid>\r\nTo: ${USER}\r\nSubject: Linkes levél\r\nMessage-ID: <m3b-link@example.invalid>\r\nDate: ${now}\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Fizessen itt: <a href="https://phish.evil.invalid/pay">https://netbank.otp.hu/fizetes</a></p>\r\n`))
// the second account's server: its saved password is wrong, so the app's first sync stops it
const pop2 = await new FakePop3Server({ pass: 'masik-jo-jelszo' }).listen()
pop2.add(Buffer.from(`From: x@example.invalid\r\nTo: masodik@example.invalid\r\nSubject: Masodik fiok levele\r\nMessage-ID: <p2@example.invalid>\r\nDate: ${now}\r\n\r\nx\r\n`))

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-m3b-e2e-'))
const dataDir = path.join(work, 'data')
fs.mkdirSync(dataDir)
let accountId
let stoppedId
{
  const { db, vault } = await createVaultedDatabase(dataDir, MASTER)
  const store = new AccountStore(db, vault, { storeDir: path.join(dataDir, 'store') })
  const smtpSide = { smtp_host: '127.0.0.1', smtp_port: smtpPort, smtp_security: 'none', smtp_same_password: false, smtp_password: SMTP_PASSWORD }
  accountId = store.save({
    ...newAccountDefaults('pop3'), name: 'POP3-fiók', email: USER, display_name: 'Mérő Márta', in_host: '127.0.0.1', in_port: pop.port, in_security: 'none', in_user: pop.user, in_password: pop.pass, ...smtpSide,
  }).account.id
  stoppedId = store.save({
    ...newAccountDefaults('pop3'), name: 'Leállt fiók', email: 'masodik@example.invalid', in_host: '127.0.0.1', in_port: pop2.port, in_security: 'none', in_user: pop2.user, in_password: WRONG, ...smtpSide,
  }).account.id
  db.close()
}
seedLanguage(dataDir)

function connector() {
  const proc = spawn(electronBin, [repo, '--mcp', '--ozone-platform=headless'], { env: { ...process.env, SHADOWMAIL_DATA: dataDir }, stdio: ['pipe', 'pipe', 'pipe'] })
  let out = ''
  const waiting = new Map()
  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', d => {
    out += d
    let i
    while ((i = out.indexOf('\n')) >= 0) {
      const line = out.slice(0, i).trim()
      out = out.slice(i + 1)
      if (!line) continue
      const m = JSON.parse(line)
      // 0.11.1: the shape of every tools/call result the connector gave back
      if (m.result && Array.isArray(m.result.content)) (globalThis.__callShapes ??= []).push(Object.keys(m.result).sort().join(','))
      waiting.get(m.id)?.(m)
      waiting.delete(m.id)
    }
  })
  proc.stderr.resume()
  let id = 0
  const ask = (method, params, timeout = 90_000) =>
    new Promise(resolve => {
      const my = ++id
      const timer = setTimeout(() => resolve(null), timeout)
      waiting.set(my, m => (clearTimeout(timer), resolve(m)))
      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: my, method, ...(params ? { params } : {}) })}\n`)
    })
  const tool = async (name, args = {}, timeout) => (await ask('tools/call', { name, arguments: args }, timeout))?.result
  const init = () => ask('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } })
  return { ask, tool, init, close: () => proc.stdin.end() }
}

const consoleProblems = []
const app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
let c = connector()
let c2 = connector()
const mainLog = path.join(dataDir, 'electron', 'logs', 'main.log')
const logText = () => (fs.existsSync(mainLog) ? fs.readFileSync(mainLog, 'utf8') : '')
try {
  const page = await app.firstWindow()
  page.on('console', m => (m.type() === 'error' || m.type() === 'warning') && consoleProblems.push(m.text()))
  await useTheme(app, page)
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  await page.locator('.msg-row[data-id]').nth(3).waitFor({ timeout: 30_000 })
  await page.evaluate(() => window.shadowMail.mcp.setEnabled(true))
  await c.init()
  await c2.init()

  // the Modal is the app window: its texts follow the interface language (t.claudeConfirm)
  const ct = t.claudeConfirm
  const modal = page.locator('.claude-confirm-modal')
  const reject = modal.locator('.confirm-reject')
  const approve = modal.locator('.confirm-approve')
  const waitModal = async kind => {
    await page.locator(`.claude-confirm[data-kind="${kind}"] .claude-confirm-modal`).waitFor({ timeout: 20_000 })
    return page.locator('.claude-confirm').getAttribute('data-request-id')
  }
  const gone = () => page.locator('.claude-confirm').waitFor({ state: 'detached', timeout: 20_000 }).then(() => true, () => false)
  const approveWhenReady = async () => {
    await page.waitForFunction(() => document.querySelector('.confirm-approve') && !document.querySelector('.confirm-approve').disabled, null, { timeout: 5000 })
    await approve.click()
  }
  const list = (folder, id = accountId) => page.evaluate(([a, f]) => window.shadowMail.mail.list({ accountId: a, folder: f, limit: 200 }), [id, folder])
  const uiFolders = async () => page.evaluate(id => window.shadowMail.mail.folders().then(r => r.accounts.find(a => a.id === id).folders), accountId)
  const accounts = async () => (await page.evaluate(() => window.shadowMail.accounts.list())).accounts

  const names = (await c.ask('tools/list')).result.tools.map(t => t.name)
  check('tools/list: the M3B tools', ['send_message', 'send_draft', 'delete_folder', 'update_account', 'delete_account', 'confirmation_status'].every(n => names.includes(n)), names.join(','))

  // --- send_message: the Modal shows the envelope; Enter at once rejects --------------------------------------
  const ask = { account_id: accountId, to: 'Anna <cimzett-anna-77@example.invalid>', cc: 'masolat-bela-77@example.invalid', bcc: 'titkos-cili-77@example.invalid', subject: 'Kuldott-targy-77 <b>', text: 'Kuldott-szoveg-77\nmásodik sor' }
  const first = c.tool('send_message', ask)
  await waitModal('send')
  const shown = await modal.innerText()
  // --shots <folder>: the send Modal as the owner sees it (claude-confirm-<theme>.png)
  const shotsAt = process.argv.indexOf('--shots')
  if (shotsAt > 0) {
    fs.mkdirSync(process.argv[shotsAt + 1], { recursive: true })
    await page.screenshot({ path: path.join(process.argv[shotsAt + 1], `claude-confirm-${e2eTheme || 'default'}.png`) })
  }
  check('send: the Modal says Claude made it', shown.includes(ct.header))
  check('send: the Modal shows sender, recipients, Cc, Bcc, subject, text', ['Mérő Márta <m3b@example.invalid>', 'Anna <cimzett-anna-77@example.invalid>', 'masolat-bela-77@example.invalid', 'titkos-cili-77@example.invalid', 'Kuldott-targy-77 <b>', 'Kuldott-szoveg-77'].every(x => shown.includes(x)), shown.slice(0, 300))
  check('send: the focus is on Elutasítás, Jóváhagyás is disabled', (await page.evaluate(() => document.activeElement && document.activeElement.classList.contains('confirm-reject'))) && (await approve.isDisabled()))
  await page.keyboard.press('Enter')
  const r1 = await first
  check('send: Enter at once -> rejected, the SMTP server got 0 messages', r1 && r1.isError && r1._meta['shadowmail/data'].error === 'rejected' && received.length === 0, JSON.stringify(r1 && r1._meta['shadowmail/data']))
  check('send: the Modal went', await gone())

  // --- approved: 1.5 s, then exactly what was shown -------------------------------------------------------------
  const second = c.tool('send_message', ask)
  await waitModal('send')
  const t0 = performance.now()
  await approve.dispatchEvent('click')
  await sleep(300)
  check('send: Jóváhagyás before 1.5 s does nothing (the Modal stays)', (await page.locator('.claude-confirm').count()) === 1 && received.length === 0)
  await page.waitForFunction(() => !document.querySelector('.confirm-approve').disabled, null, { timeout: 5000 })
  const ready = Math.round(performance.now() - t0)
  check('send: Jóváhagyás enabled after about 1.5 s', ready >= 1200 && ready < 4000, `${ready} ms`)
  await approve.click()
  const r2 = await second
  for (let i = 0; i < 50 && !received.length; i++) await sleep(100)
  const sent = received[0] ? await simpleParser(received[0].raw) : null
  check('send: approved -> 1 message', r2 && !r2.isError && r2._meta['shadowmail/data'].status === 'approved' && received.length === 1, JSON.stringify(r2 && r2._meta['shadowmail/data']))
  check('send: the envelope is the Modal\'s (to + cc + bcc, from)', received[0] && received[0].to.sort().join(',') === ['cimzett-anna-77@example.invalid', 'masolat-bela-77@example.invalid', 'titkos-cili-77@example.invalid'].sort().join(',') && received[0].from === USER, received[0] && received[0].to.join(','))
  check('send: the subject byte for byte the Modal\'s', sent && sent.subject === 'Kuldott-targy-77 <b>', sent && sent.subject)
  check('send: no X-ShadowMail-Draft-Origin, no Bcc header', sent && !/x-shadowmail-draft-origin/i.test(received[0].raw.toString('utf8')) && !sent.headers.has('bcc'))
  check('send: the local Sent copy', (await list('Sent')).rows.some(r => r.subject === 'Kuldott-targy-77 <b>'))

  // --- delete for good: 3 messages in the Trash ---------------------------------------------------------------
  const inbox = (await list('INBOX')).rows
  for (const s of ['Első levél', 'Második levél', 'Harmadik levél']) await c.tool('trash_messages', { ids: [inbox.find(r => r.subject === s).id] })
  const trashIds = (await list('Trash')).rows.map(r => r.id)
  check('trash: 3 messages in the Trash, no Modal for that', trashIds.length === 3 && (await page.locator('.claude-confirm').count()) === 0)
  let call = c.tool('trash_messages', { ids: trashIds })
  await waitModal('deleteMessages')
  const delText = await modal.innerText()
  check('delete for good: the Modal gives the count and the messages', delText.includes(t.confirmDeleteTrash(3)) && ['Első levél', 'Második levél', 'Harmadik levél'].every(s => delText.includes(s)), delText.slice(0, 300))
  await reject.click()
  check('delete for good rejected: all 3 stay', (await call)._meta['shadowmail/data'].error === 'rejected' && (await list('Trash')).rows.length === 3)
  call = c.tool('trash_messages', { ids: trashIds })
  await waitModal('deleteMessages')
  await approveWhenReady()
  const r3 = await call
  check('delete for good approved: 0 left', r3 && !r3.isError && r3._meta['shadowmail/data'].done === 3 && (await list('Trash')).rows.length === 0, JSON.stringify(r3 && r3._meta['shadowmail/data']))
  const tooMany = await c.tool('trash_messages', { ids: Array.from({ length: 501 }, (_, i) => i + 1) })
  await sleep(300)
  check('501 ids: an error, no Modal', tooMany.isError === true && (await page.locator('.claude-confirm').count()) === 0)

  // --- delete_folder --------------------------------------------------------------------------------------------
  await c.tool('create_folder', { account_id: accountId, name: 'Torlendo' })
  call = c.tool('delete_folder', { account_id: accountId, path: 'Torlendo' })
  await waitModal('deleteFolder')
  await reject.click()
  check('delete_folder rejected: the folder stays', (await call)._meta['shadowmail/data'].error === 'rejected' && (await uiFolders()).some(f => f.path === 'Torlendo'))
  call = c.tool('delete_folder', { account_id: accountId, path: 'Torlendo' })
  await waitModal('deleteFolder')
  await approveWhenReady()
  const r4 = await call
  check('delete_folder approved: gone from the folder tree', r4 && !r4.isError && !(await uiFolders()).some(f => f.path === 'Torlendo'))

  // --- update_account -------------------------------------------------------------------------------------------
  const before = (await accounts()).find(a => a.id === accountId)
  call = c.tool('update_account', { account_id: accountId, smtp_host: 'smtp.uj-szerver.invalid' })
  await waitModal('updateAccount')
  const upd = await modal.innerText()
  check('update_account: the Modal shows old -> new', upd.includes(`${t.accountFields.smtp}: ${t.accountFields.smtp_host}`) && upd.includes('127.0.0.1 -> smtp.uj-szerver.invalid'), upd.slice(0, 300))
  await reject.click()
  const after = (await accounts()).find(a => a.id === accountId)
  check('update_account rejected: the account is unchanged', (await call)._meta['shadowmail/data'].error === 'rejected' && JSON.stringify(after) === JSON.stringify(before))
  const pw = await c.tool('update_account', { account_id: accountId, in_password: 'x' })
  await sleep(300)
  check('update_account with a password field: an error, no Modal', pw.isError && pw._meta['shadowmail/data'].error === 'password_not_allowed' && (await page.locator('.claude-confirm').count()) === 0)
  call = c.tool('update_account', { account_id: accountId, signature: 'Új aláírás M3B' })
  await waitModal('updateAccount')
  await approveWhenReady()
  const r5 = await call
  check('update_account approved: saved', r5 && !r5.isError && (await accounts()).find(a => a.id === accountId).signature === 'Új aláírás M3B')

  // --- delete_account (a third account, made in the UI) -----------------------------------------------------------
  const extra = await page.evaluate(form => window.shadowMail.accounts.save(form), { ...newAccountDefaults('pop3'), name: 'Törlendő fiók', email: 'torlendo@example.invalid', in_host: '127.0.0.1', in_port: 1, in_security: 'none', in_user: 'x', in_password: 'x', smtp_host: '127.0.0.1', smtp_port: 1, smtp_security: 'none' })
  const extraId = extra.account.id
  call = c.tool('delete_account', { account_id: extraId })
  await waitModal('deleteAccount')
  check('delete_account: the Modal names the account', (await modal.innerText()).includes('Törlendő fiók <torlendo@example.invalid>'))
  await reject.click()
  check('delete_account rejected: the account stays', (await call)._meta['shadowmail/data'].error === 'rejected' && (await accounts()).some(a => a.id === extraId))
  call = c.tool('delete_account', { account_id: extraId })
  await waitModal('deleteAccount')
  await approveWhenReady()
  const r6 = await call
  check('delete_account approved: gone, as with the account list\'s Delete', r6 && !r6.isError && !(await accounts()).some(a => a.id === extraId))

  // --- send_draft ---------------------------------------------------------------------------------------------------
  await c.tool('create_draft', { account_id: accountId, to: 'cimzett-anna-77@example.invalid', subject: 'Piszkozat-targy-77', text: 'piszkozat szövege' })
  const draft = (await list('Drafts')).rows.find(r => r.subject === 'Piszkozat-targy-77')
  call = c.tool('send_draft', { draft_id: draft.id })
  await waitModal('send')
  check('send_draft: the Modal shows the draft', (await modal.innerText()).includes('Piszkozat-targy-77'))
  await approveWhenReady()
  const r7 = await call
  for (let i = 0; i < 50 && received.length < 2; i++) await sleep(100)
  check('send_draft approved: sent, the draft gone', r7 && !r7.isError && received.length === 2 && !(await list('Drafts')).rows.some(r => r.subject === 'Piszkozat-targy-77'), JSON.stringify(r7 && r7._meta['shadowmail/data']))

  // --- the restart of a stopped login -------------------------------------------------
  const st = async () => (await page.evaluate(() => window.shadowMail.mail.status())).accounts.find(a => a.accountId === stoppedId)
  for (let i = 0; i < 100 && !(await st())?.stopped; i++) await sleep(100)
  check('the second account is stopped by its rejected login', (await st()).stopped === true && pop2.loginAttempts === 1, `attempts ${pop2.loginAttempts}`)
  const all = await c.tool('sync_account', {})
  await sleep(300)
  const stoppedItem = all._meta['shadowmail/data'].accounts.find(x => x.account_id === stoppedId)
  check('sync_account for every account: no Modal, account_stopped with the hint', (await page.locator('.claude-confirm').count()) === 0 && stoppedItem.error === 'account_stopped' && /account_id/.test(stoppedItem.message) && pop2.loginAttempts === 1)
  const p1 = c.tool('sync_account', { account_id: stoppedId })
  const p2 = c2.tool('sync_account', { account_id: stoppedId })
  await waitModal('restartLogin')
  await sleep(500)
  const restartText = await modal.innerText()
  check('restart: one Modal for two calls, with the reason and the warning', (await page.locator('.claude-confirm').count()) === 1 && !restartText.includes(ct.more(1)) && restartText.includes('Leállt fiók') && restartText.includes(ct.restartReason('auth_failed')) && restartText.includes(ct.restartWarning), restartText.slice(0, 300))
  await reject.click()
  const [q1, q2] = await Promise.all([p1, p2])
  check('restart rejected: both calls rejected with the same id, 0 logins, still stopped', q1._meta['shadowmail/data'].error === 'rejected' && q2._meta['shadowmail/data'].error === 'rejected' && q1._meta['shadowmail/data'].confirmation_id === q2._meta['shadowmail/data'].confirmation_id && pop2.loginAttempts === 1 && (await st()).stopped)
  call = c.tool('sync_account', { account_id: stoppedId })
  await waitModal('restartLogin')
  await approveWhenReady()
  const r8 = await call
  check('restart approved, the server still refuses: exactly 1 login, stopped again', r8 && !r8.isError && r8._meta['shadowmail/data'].accounts[0].error === 'account_stopped' && pop2.loginAttempts === 2 && (await st()).stopped, `attempts ${pop2.loginAttempts}`)
  await sleep(5000)
  check('restart: no further attempt in the next 5 s', pop2.loginAttempts === 2, `attempts ${pop2.loginAttempts}`)
  pop2.pass = WRONG // the server now takes the saved password
  call = c.tool('sync_account', { account_id: stoppedId })
  await waitModal('restartLogin')
  await approveWhenReady()
  const r9 = await call
  check('restart approved with the right password: the sync ran, the account is not stopped', r9 && !r9.isError && r9._meta['shadowmail/data'].accounts[0].ok === true && !(await st()).stopped && (await list('INBOX', stoppedId)).rows.length === 1, JSON.stringify(r9 && r9._meta['shadowmail/data']))

  // --- 60 s: pending_confirmation, then confirmation_status -------------------------------------------------------
  const t1 = performance.now() // not Date.now(): the WSL clock jumps (CLAUDE.md, Buktatók)
  call = c.tool('send_message', { account_id: accountId, to: 'cimzett-anna-77@example.invalid', subject: 'Varakozo-targy-77', text: 'x' })
  await waitModal('send')
  const r10 = await call
  check('after 60 s: pending_confirmation with an id, nothing sent', r10 && !r10.isError && r10._meta['shadowmail/data'].status === 'pending_confirmation' && performance.now() - t1 >= 59_000 && received.length === 2, `${Math.round(performance.now() - t1)} ms`)
  const pendingId = r10._meta['shadowmail/data'].confirmation_id
  await approveWhenReady()
  let r11
  for (let i = 0; i < 50; i++) {
    r11 = await c.tool('confirmation_status', { confirmation_id: pendingId })
    if (r11._meta['shadowmail/data'].status !== 'pending_confirmation' && r11._meta['shadowmail/data'].status !== 'running') break
    await sleep(100)
  }
  check('confirmation_status after the approval: approved with the result', !r11.isError && r11._meta['shadowmail/data'].status === 'approved' && r11._meta['shadowmail/data'].sent === true && received.length === 3, JSON.stringify(r11._meta['shadowmail/data']))

  // --- 10 minutes: expired (the main process's clock moved forward) -------------------------------------------------
  const r12 = await c2.tool('delete_folder', { account_id: accountId, path: 'Sent' })
  check('delete_folder on a role folder: refused, no Modal', r12.isError && r12._meta['shadowmail/data'].error === 'protected_folder' && (await page.locator('.claude-confirm').count()) === 0)
  await c.tool('create_folder', { account_id: accountId, name: 'Marad' })
  const p4 = c2.tool('delete_folder', { account_id: accountId, path: 'Marad' })
  const expiringId = await waitModal('deleteFolder')
  await app.evaluate(() => {
    globalThis.__m3bNow = Date.now
    Date.now = () => globalThis.__m3bNow() + 11 * 60_000
  })
  const r13 = await c.tool('confirmation_status', { confirmation_id: expiringId })
  await app.evaluate(() => {
    Date.now = globalThis.__m3bNow
  })
  const r14 = await p4
  check('after 10 minutes: expired (status and the waiting call), the folder stays, the Modal went', r13._meta['shadowmail/data'].error === 'expired' && r14._meta['shadowmail/data'].error === 'expired' && (await uiFolders()).some(f => f.path === 'Marad') && (await gone()))

  // --- the reply quote's link: text -> the real target in the Modal -------------------------------------
  const linked = (await list('INBOX')).rows.find(r => r.subject === 'Linkes levél')
  call = c.tool('send_message', { reply_to: linked.id, mode: 'reply', text: 'Rendben' })
  await waitModal('send')
  const linkText = await modal.innerText()
  check('reply: the quoted link shows its real target in the Modal', linkText.includes('https://netbank.otp.hu/fizetes -> https://phish.evil.invalid/pay'), linkText.slice(linkText.indexOf(ct.links), linkText.indexOf(ct.links) + 200))
  await reject.click()
  check('reply rejected: nothing sent', (await call)._meta['shadowmail/data'].error === 'rejected' && received.length === 3)

  // --- the Modal's way out: two waiting requests, then "Mind elutasítása, Claude-hozzáférés ki" ---------
  const endpoint = path.join(dataDir, 'mcp', 'endpoint.json')
  const rejectedLines = reason => (logText().match(new RegExp(`mcp confirm tool=delete_folder result=rejected error=${reason}`, 'g')) || []).length
  c.tool('delete_folder', { account_id: accountId, path: 'Marad' }, 5000)
  c2.tool('delete_folder', { account_id: accountId, path: 'Marad' }, 5000)
  await waitModal('deleteFolder')
  await page.waitForFunction(() => (document.querySelector('.confirm-more') || {}).textContent?.includes('1'), null, { timeout: 10_000 })
  check('two waiting requests: the Modal says one more waits; the way-out buttons are there, not focused', (await modal.locator('.confirm-lock').count()) === 1 && (await modal.locator('.confirm-off').count()) === 1 && (await page.evaluate(() => document.activeElement.classList.contains('confirm-reject'))))
  await modal.locator('.confirm-off').click()
  await gone()
  await sleep(500)
  const sw = await page.evaluate(() => window.shadowMail.mcp.status())
  check('"Mind elutasítása, Claude-hozzáférés ki": both rejected (log), the switch OFF, no pipe, no endpoint.json', rejectedLines('access_off') === 2 && sw.enabled === false && sw.running === false && !fs.existsSync(endpoint), JSON.stringify(sw))
  await page.evaluate(() => window.shadowMail.mcp.setEnabled(true))
  c.close()
  c2.close()
  c = connector()
  c2 = connector()
  await c.init()
  await c2.init()

  // --- two waiting requests, then the Modal's Zárolás ---------------------------------------------------------------
  c.tool('delete_folder', { account_id: accountId, path: 'Marad' }, 5000)
  c2.tool('delete_folder', { account_id: accountId, path: 'Marad' }, 5000)
  await waitModal('deleteFolder')
  await page.waitForFunction(() => (document.querySelector('.confirm-more') || {}).textContent?.includes('1'), null, { timeout: 10_000 })
  await modal.locator('.confirm-lock').click()
  await page.locator('#vault-unlock').waitFor({ timeout: 10_000 })
  check('Zárolás in the Modal: the app is locked, both requests rejected (log)', rejectedLines('locked') === 2 && (await page.locator('.claude-confirm').count()) === 0)
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  await page.locator('.msg-row[data-id]').first().waitFor({ timeout: 30_000 })
  check('after the lock: nothing was deleted, no Modal', (await uiFolders()).some(f => f.path === 'Marad') && (await page.locator('.claude-confirm').count()) === 0)

  const log = logText()
  const leaked = SECRET_WORDS.filter(w => log.includes(w))
  check('main.log: no subject, recipient or text of the run', leaked.length === 0, leaked.join(','))
  check('main.log: the decisions are logged without content', /mcp confirm tool=send_message result=approved items=1/.test(log) && /mcp confirm tool=send_message result=rejected items=1/.test(log))
  check('no console error or warning in the renderer', consoleProblems.length === 0, consoleProblems.join(' | '))
  const netLog = path.join(dataDir, 'electron', 'logs', 'net-guard.log')
  check('the net-guard log has no outgoing request', !fs.existsSync(netLog) || fs.readFileSync(netLog, 'utf8').trim() === '')

  // quit with a waiting request: rejected (log), nothing deleted at the next start
  await page.evaluate(() => window.shadowMail.mcp.setEnabled(true))
  await c.init()
  c.tool('delete_folder', { account_id: accountId, path: 'Marad' }, 5000)
  await waitModal('deleteFolder')
  await app.close()
  check('quit: the waiting request rejected (log)', /mcp confirm tool=delete_folder result=rejected error=quit/.test(logText()))
} catch (err) {
  check('the run', false, err.stack)
} finally {
  c.close()
  c2.close()
  await app.close().catch(() => {})
  smtp.close()
  await pop.close?.()
  await pop2.close?.()
  fs.rmSync(work, { recursive: true, force: true })
}
{
  // 0.11.1: the model must get the text, so no structuredContent next to it; our data is in _meta
  const shapes = globalThis.__callShapes || []
  check('0.11.1: every tools/call result is exactly { content, _meta, isError }, no structuredContent', shapes.length > 0 && shapes.every(k => k === '_meta,content,isError'), `${shapes.length} results: ${[...new Set(shapes)].join(' | ')}`)
}
const ok = results.filter(Boolean).length
console.log(`${ok} / ${results.length} ${ok === results.length ? 'OK' : 'FAIL'}`)
process.exit(ok === results.length ? 0 : 1)
