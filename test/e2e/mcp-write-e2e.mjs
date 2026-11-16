#!/usr/bin/env node
// MCP in the real app: the write tools through the connector. A POP3 account (fake POP3 server,
// local folders) whose SMTP side is a local smtp-server. Not part of `npm test`.
//
//   node test/e2e/mcp-write-e2e.mjs
//
// Measures: tools/list has the write tools; mark/move/trash, create/rename folder give what the UI shows (the UI's
// own IPC reads); 501 ids change nothing, the for-good delete asks in the Modal (rejected: nothing changes); create_draft lands in the local Drafts with the
// "Claude" mark, the app's notice comes, its Megnyitás opens the composer, Küldés sends it WITHOUT the
// X-ShadowMail-Draft-Origin header (the smtp-server got nothing before that click); create_reply_draft has the
// app's recipients and subject; prepare_account fills the editor (password empty, no account made) and a
// password-like field refuses the call (no editor); test_account = the account's own "Kapcsolat próbája", no
// password in the answer; no console problem, the net-guard log is empty.
// The IMAP server side (Drafts on the server, the keyword, the server's folders) is in test/mcp-tools.test.js.
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
import { newAccountDefaults, accountEditorForm } from '../../core/accounts/defaults.js'
import { t, seedLanguage } from './lang.mjs'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const MASTER = 'Teszt-mesterjelszo-iras'
const USER = 'm3@example.invalid'
const SMTP_PASSWORD = 'jo-smtp-jelszo-iras'

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
      received.push({ to: session.envelope.rcptTo.map(r => r.address), raw: Buffer.concat(chunks) })
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
  pop.add(Buffer.from(`From: Feladó Ferenc <ferenc@example.invalid>\r\nTo: ${USER}\r\nSubject: ${subject}\r\nMessage-ID: <m3-${i}@example.invalid>\r\nDate: ${now}\r\n\r\nszöveg ${i}\r\n`))
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-m3-e2e-'))
const dataDir = path.join(work, 'data')
fs.mkdirSync(dataDir)
let accountId
{
  const { db, vault } = await createVaultedDatabase(dataDir, MASTER)
  const store = new AccountStore(db, vault, { storeDir: path.join(dataDir, 'store') })
  accountId = store.save({
    ...newAccountDefaults('pop3'), name: 'POP3-fiók', email: USER, display_name: 'Mérő Márta', signature: 'Mérő Márta',
    in_host: '127.0.0.1', in_port: pop.port, in_security: 'none', in_user: pop.user, in_password: pop.pass,
    smtp_host: '127.0.0.1', smtp_port: smtpPort, smtp_security: 'none', smtp_same_password: false, smtp_password: SMTP_PASSWORD,
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
  const ask = (method, params, timeout = 60_000) =>
    new Promise(resolve => {
      const my = ++id
      const timer = setTimeout(() => resolve(null), timeout)
      waiting.set(my, m => (clearTimeout(timer), resolve(m)))
      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: my, method, ...(params ? { params } : {}) })}\n`)
    })
  const tool = async (name, args = {}) => (await ask('tools/call', { name, arguments: args }))?.result
  return { ask, tool, exited: new Promise(r => proc.on('exit', r)), close: () => proc.stdin.end() }
}

const consoleProblems = []
const app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
const c = connector()
try {
  const page = await app.firstWindow()
  page.on('console', m => (m.type() === 'error' || m.type() === 'warning') && consoleProblems.push(m.text()))
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  await page.locator('.msg-row[data-id]').nth(3).waitFor({ timeout: 30_000 })
  await page.evaluate(() => window.shadowMail.mcp.setEnabled(true))
  await c.ask('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } })

  const list = await page.evaluate(id => window.shadowMail.mail.list({ accountId: id, folder: 'INBOX', limit: 50 }), accountId)
  const bySubject = s => list.rows.find(r => r.subject === s).id
  const uiRow = async (folder, id) => page.evaluate(([a, f, m]) => window.shadowMail.mail.list({ accountId: a, folder: f, limit: 200 }).then(r => r.rows.find(x => x.id === m)), [accountId, folder, id])
  const uiFolders = async () => page.evaluate(id => window.shadowMail.mail.folders().then(r => r.accounts.find(a => a.id === id).folders), accountId)
  const inboxCount = async () => (await page.evaluate(id => window.shadowMail.mail.list({ accountId: id, folder: 'INBOX', limit: 200 }), accountId)).rows.length

  const names = (await c.ask('tools/list')).result.tools.map(t => t.name)
  check('tools/list: the write tools', ['mark_messages', 'move_messages', 'trash_messages', 'create_folder', 'rename_folder', 'create_draft', 'create_reply_draft', 'prepare_account', 'test_account'].every(n => names.includes(n)), names.join(','))

  // mark, as the list's buttons
  const first = bySubject('Első levél')
  const marked = await c.tool('mark_messages', { ids: [first], action: 'read' })
  const starred = await c.tool('mark_messages', { ids: [first], action: 'star' })
  const row1 = await uiRow('INBOX', first)
  check('mark_messages read + star: the UI list shows it', !marked.isError && !starred.isError && /\\Seen/.test(row1.flags) && /\\Flagged/.test(row1.flags), row1.flags)

  // folders
  const made = await c.tool('create_folder', { account_id: accountId, name: 'Claude-mappa' })
  check('create_folder: the folder tree has it', !made.isError && (await uiFolders()).some(f => f.path === 'Claude-mappa'), made.content[0].text)
  const second = bySubject('Második levél')
  const moved = await c.tool('move_messages', { ids: [second], target: 'Claude-mappa' })
  const inNew = await page.evaluate(id => window.shadowMail.mail.list({ accountId: id, folder: 'Claude-mappa', limit: 50 }), accountId)
  check('move_messages: the message is in the target folder in the UI', !moved.isError && inNew.rows.some(r => r.subject === 'Második levél'), moved.content[0].text)
  const renamed = await c.tool('rename_folder', { account_id: accountId, path: 'Claude-mappa', name: 'Átnevezett' })
  const fs2 = await uiFolders()
  check('rename_folder: the tree has the new name, not the old', !renamed.isError && fs2.some(f => f.path === 'Átnevezett') && !fs2.some(f => f.path === 'Claude-mappa'))
  const protectedRename = await c.tool('rename_folder', { account_id: accountId, path: 'INBOX', name: 'X' })
  check('rename_folder on INBOX: refused', protectedRename.isError === true)

  // trash, and the for-good branch
  const before = await inboxCount()
  const tooMany = await c.tool('mark_messages', { ids: Array.from({ length: 501 }, (_, i) => i + 1), action: 'unread' })
  check('501 ids: an error, nothing changes', tooMany.isError === true && (await inboxCount()) === before && /\\Seen/.test((await uiRow('INBOX', first)).flags))
  const third = bySubject('Harmadik levél')
  const trashed = await c.tool('trash_messages', { ids: [third] })
  const trashRows = await page.evaluate(id => window.shadowMail.mail.list({ accountId: id, folder: 'Trash', limit: 50 }), accountId)
  const inTrash = trashRows.rows.find(r => r.subject === 'Harmadik levél')
  check('trash_messages: in the Trash, out of the INBOX', !trashed.isError && Boolean(inTrash) && (await inboxCount()) === before - 1)
  // the for-good branch asks the user in the Modal (test/e2e/mcp-confirm-e2e.mjs has the rest); rejected here
  const forGoodCall = c.tool('trash_messages', { ids: [inTrash.id] })
  await page.locator('.claude-confirm[data-kind="deleteMessages"] .claude-confirm-modal').waitFor({ timeout: 20_000 })
  await page.locator('.claude-confirm-modal .confirm-reject').click()
  const forGood = await forGoodCall
  const still = await page.evaluate(id => window.shadowMail.mail.list({ accountId: id, folder: 'Trash', limit: 50 }), accountId)
  check('trash_messages in the Trash: the Modal asks, rejected, the message stays', forGood.isError === true && forGood._meta['shadowmail/data'].error === 'rejected' && still.rows.some(r => r.id === inTrash.id))

  // create_draft: local Drafts, the mark, the notice, nothing sent
  const draft = await c.tool('create_draft', { account_id: accountId, to: 'anna@example.invalid', subject: 'MCP-piszkozat', text: 'Szia Anna,\nez egy piszkozat.' })
  const drafts = await page.evaluate(id => window.shadowMail.mail.list({ accountId: id, folder: 'Drafts', limit: 50 }), accountId)
  const draftRow = drafts.rows.find(r => r.subject === 'MCP-piszkozat')
  check('create_draft: in the local Drafts with the $ShadowMailClaude keyword', !draft.isError && Boolean(draftRow) && /\$ShadowMailClaude/.test(draftRow.flags), draft.content[0].text)
  check('create_draft: nothing went out', received.length === 0)
  await page.locator('.claude-draft-notice').waitFor({ timeout: 10_000 })
  check('the app\'s notice: "Claude piszkozatot készített: MCP-piszkozat"', (await page.locator('.claude-draft-notice').innerText()).includes(t.claudeDraftNotice('MCP-piszkozat')))
  await page.locator('.folder[data-path="Drafts"]').first().click()
  await page.locator('.msg-row', { hasText: 'MCP-piszkozat' }).waitFor({ timeout: 10_000 })
  check('the Drafts list: the "Claude" mark on the row', (await page.locator('.msg-row', { hasText: 'MCP-piszkozat' }).locator('.claude-mark').count()) === 1)

  // Megnyitás -> the composer -> Küldés: out without the header
  const [win] = await Promise.all([app.waitForEvent('window', { timeout: 15_000 }), page.locator('.claude-draft-notice').getByRole('button', { name: t.claudeDraftOpen, exact: true }).click()])
  await win.setViewportSize({ width: 1000, height: 760 }) // headless: a new window starts 0 x 0
  await win.locator('#compose-subject').waitFor()
  await win.waitForFunction(() => document.querySelector('#compose-subject').value === 'MCP-piszkozat')
  const bodyText = await win.locator('.compose-editor, [contenteditable="true"]').first().innerText()
  check('Megnyitás: the composer has the draft (subject, text, one signature)', bodyText.includes('ez egy piszkozat') && bodyText.split('Mérő Márta').length - 1 === 1, bodyText.slice(0, 120))
  await Promise.all([win.waitForEvent('close', { timeout: 15_000 }), win.getByRole('button', { name: t.composeSend, exact: true }).click()])
  for (let i = 0; i < 50 && !received.length; i++) await sleep(100)
  const sent = received[0] ? await simpleParser(received[0].raw) : null
  check('Küldés: the message went out to anna@example.invalid', received.length === 1 && received[0].to.includes('anna@example.invalid'))
  check('the sent message has no X-ShadowMail-Draft-Origin header', Boolean(sent) && !sent.headers.has('x-shadowmail-draft-origin') && !/x-shadowmail-draft-origin/i.test(received[0].raw.toString('utf8')))

  // create_reply_draft: the app's recipients and subject
  const fourth = bySubject('Negyedik levél')
  const reply = await c.tool('create_reply_draft', { message_id: fourth, mode: 'reply', text: 'Köszönöm.' })
  const drafts2 = await page.evaluate(id => window.shadowMail.mail.list({ accountId: id, folder: 'Drafts', limit: 50 }), accountId)
  check('create_reply_draft: "Re: Negyedik levél" in the Drafts, marked', !reply.isError && drafts2.rows.some(r => r.subject === 'Re: Negyedik levél' && /\$ShadowMailClaude/.test(r.flags)), reply.content[0].text)
  check('create_reply_draft: still nothing more went out', received.length === 1)

  // prepare_account
  const accountsBefore = (await page.evaluate(() => window.shadowMail.accounts.list())).accounts.length
  const refused = await c.tool('prepare_account', { email: 'uj@example.invalid', type: 'imap', in_password: 'Titkos-123' })
  await sleep(500)
  check('prepare_account with a password field: refused, no editor', refused.isError === true && (await page.locator('#acc-email').count()) === 0, refused.content[0].text)
  const prepared = await c.tool('prepare_account', { name: 'Claude-fiók', email: 'uj@example.invalid', type: 'imap', in_host: 'imap.example.invalid', in_port: 993, in_security: 'tls', in_user: 'uj', smtp_host: 'smtp.example.invalid', smtp_port: 465, smtp_security: 'tls' })
  await page.locator('#acc-email').waitFor({ timeout: 10_000 })
  check('prepare_account: the editor is filled, the password fields are empty', !prepared.isError && (await page.locator('#acc-email').inputValue()) === 'uj@example.invalid' && (await page.locator('#acc-in_host').inputValue()) === 'imap.example.invalid' && (await page.locator('#acc-in_password').inputValue()) === '')
  await sleep(500)
  check('prepare_account: no account made without the user\'s click', (await page.evaluate(() => window.shadowMail.accounts.list())).accounts.length === accountsBefore)
  const heading = await page.locator('.settings h2, .settings h3').filter({ hasText: new RegExp(`${esc(t.accountNew)}|${esc(t.accountEdit)}`, 'i') }).first().innerText().catch(() => '')
  check('prepare_account: the editor says "Új fiók"', heading.includes(t.accountNew) && !/undefined/.test(heading), heading)
  await c.tool('prepare_account', { email: 'masodik@example.invalid', type: 'imap', in_host: 'imap2.example.invalid' })
  await page.waitForFunction(() => document.querySelector('#acc-email')?.value === 'masodik@example.invalid', null, { timeout: 10_000 }).catch(() => {})
  check('a second prepare_account refreshes the open editor', (await page.locator('#acc-email').inputValue()) === 'masodik@example.invalid' && (await page.locator('#acc-in_host').inputValue()) === 'imap2.example.invalid')

  // test_account = "Kapcsolat próbája"
  const tested = await c.tool('test_account', { account_id: accountId })
  // the UI's own payload: the editor's form (Accounts.jsx toForm = accountEditorForm), not the raw list row
  const listed = (await page.evaluate(() => window.shadowMail.accounts.list())).accounts.find(a => a.id === accountId)
  const ui = await page.evaluate(form => window.shadowMail.accounts.test(form), accountEditorForm(listed))
  check('Kapcsolat próbája on this account (separate SMTP password): both servers ok', ui.ok !== false && ui.incoming.ok && ui.smtp.ok, JSON.stringify(ui))
  const leg = x => `${Boolean(x && x.ok)}:${x && !x.ok ? x.error : ''}`
  check('test_account = the UI\'s Kapcsolat próbája', !tested.isError && leg(tested._meta['shadowmail/data'].incoming) === leg(ui.incoming) && leg(tested._meta['shadowmail/data'].smtp) === leg(ui.smtp), JSON.stringify(tested._meta['shadowmail/data']))
  const out = JSON.stringify(tested)
  check('test_account: no password in the answer', !out.includes(SMTP_PASSWORD) && !out.includes(pop.pass))

  check('no console error or warning in the renderer', consoleProblems.length === 0, consoleProblems.join(' | '))
  const netLog = path.join(dataDir, 'electron', 'logs', 'net-guard.log')
  check('the net-guard log has no outgoing request', !fs.existsSync(netLog) || fs.readFileSync(netLog, 'utf8').trim() === '')
} catch (err) {
  check('the run', false, err.stack)
} finally {
  c.close()
  await app.close().catch(() => {})
  smtp.close()
  await pop.close?.()
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
