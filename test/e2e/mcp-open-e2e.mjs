#!/usr/bin/env node
// The MCP open_message in the real app through the connector.
// Not part of `npm test`.
//
//   node test/e2e/mcp-open-e2e.mjs
//
// Two POP3 accounts (fake POP3 servers; their messages are local, so the read flag is measured in the app's index; the
// IMAP \Seen of the same open path: test/reader.test.js). Measures: open_message on account B's message while account A's
// INBOX is shown and a search is active: the search is left, the view goes to account B's INBOX, the row is the open one,
// the reader shows the subject, the message becomes read; the answer holds no subject or sender; the call is in
// the "Legutóbbi Claude-hívások" list; an unknown id: isError not_found, the view stays; a composer window in focus keeps
// the focus (the main window flashes) while the view still changes; no console problem; the net-guard log is empty.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { FakePop3Server } from '../helpers/fake-pop3.js'
import { createVaultedDatabase } from '../../core/vault/vaulted-db.js'
import { AccountStore } from '../../core/accounts/model.js'
import { newAccountDefaults } from '../../core/accounts/defaults.js'
import { t, seedLanguage } from './lang.mjs'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const MASTER = 'Teszt-mesterjelszo-megnyitas'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}

const mail = (from, to, subject, body, minutesAgo) =>
  Buffer.from(`From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nDate: ${new Date(Date.now() - minutesAgo * 60_000).toUTCString()}\r\nMessage-ID: <${subject.replace(/\W/g, '')}@example.invalid>\r\n\r\n${body}\r\n`)
const popA = await new FakePop3Server().listen()
popA.add(mail('Anna <anna@example.invalid>', 'a@example.invalid', 'Fiók A első', 'szia', 5))
popA.add(mail('Bence <bence@example.invalid>', 'a@example.invalid', 'Fiók A második', 'keresoszo-a', 4))
const popB = await new FakePop3Server().listen()
popB.add(mail('Titkos Feladó <titkos-o1@example.invalid>', 'b@example.invalid', 'Célpont titkos tárgy', 'titkos szöveg', 3))
popB.add(mail('Cili <cili@example.invalid>', 'b@example.invalid', 'Másik levél', 'masik', 2))

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-o1-e2e-'))
const dataDir = path.join(work, 'data')
fs.mkdirSync(dataDir)
{
  const { db, vault } = await createVaultedDatabase(dataDir, MASTER)
  const store = new AccountStore(db, vault, { storeDir: path.join(dataDir, 'store') })
  for (const [name, email, pop] of [['A-fiók', 'a@example.invalid', popA], ['B-fiók', 'b@example.invalid', popB]]) {
    store.save({ ...newAccountDefaults('pop3'), name, email, in_host: '127.0.0.1', in_port: pop.port, in_security: 'none', in_user: pop.user, in_password: pop.pass, smtp_host: '127.0.0.1', smtp_port: 1, smtp_security: 'none' })
  }
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
  await page.locator('.msg-row', { hasText: 'Fiók A első' }).waitFor({ timeout: 30_000 })
  const accounts = (await page.evaluate(() => window.shadowMail.mail.folders())).accounts
  const [accA, accB] = [accounts.find(a => a.name === 'A-fiók'), accounts.find(a => a.name === 'B-fiók')]
  // wait for B's messages to be downloaded too
  let rowsB = []
  for (let i = 0; i < 60 && rowsB.length < 2; i++) {
    rowsB = (await page.evaluate(id => window.shadowMail.mail.list({ accountId: id, folder: 'INBOX', limit: 50 }), accB.id)).rows
    if (rowsB.length < 2) await sleep(250)
  }
  const target = rowsB.find(r => r.subject === 'Célpont titkos tárgy')
  const other = rowsB.find(r => r.subject === 'Másik levél')
  check('setup: account B has the two messages, the target unread', target && other && !(target.flags || '').includes('\\Seen'), JSON.stringify(rowsB.map(r => [r.subject, r.flags])))

  await page.evaluate(() => window.shadowMail.mcp.setEnabled(true))
  await c.ask('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } })
  const tl = (await c.ask('tools/list')).result.tools.find(t => t.name === 'open_message')
  check('tools/list: open_message, not read only (it marks read), says the content is not returned', tl && tl.annotations.readOnlyHint === false && tl.annotations.destructiveHint === false && /content is NOT returned/.test(tl.description))

  // the view: account A's INBOX with an active search
  await page.locator('.folder-tree section', { hasText: 'A-fiók' }).locator('.folder[data-path="INBOX"]').click()
  const search = page.getByRole('searchbox', { name: t.searchLabel })
  await search.fill('keresoszo')
  await page.locator('.result-open').first().waitFor({ timeout: 15_000 })

  const r = await c.tool('open_message', { message_id: target.id })
  await page.locator('.reader-subject', { hasText: 'Célpont titkos tárgy' }).waitFor({ timeout: 10_000 })
  const view = await page.evaluate(() => ({
    search: document.querySelector('.app-header-search input[type="search"]')?.value ?? null,
    results: document.querySelectorAll('.result-open').length,
    current: document.querySelector('.folder[aria-current="page"], .folder.selected, .folder[aria-selected="true"]')?.closest('section')?.textContent || '',
    openRow: document.querySelector('.msg-row.open')?.getAttribute('data-id') || null,
  }))
  check('open_message: the search is left, the view is account B, the target row is the open one, the reader shows its subject', view.search === '' && view.results === 0 && /B-fiók/.test(view.current) && view.openRow === String(target.id), JSON.stringify(view))
  check('the answer: opened, the id, no subject or sender; nothing of the content', r && r.isError === false && r._meta['shadowmail/data'].opened === true && r._meta['shadowmail/data'].id === target.id && !/célpont|titkos|Titkos|O1 /.test(JSON.stringify(r)), JSON.stringify(r))
  let flags = ''
  for (let i = 0; i < 20 && !flags.includes('\\Seen'); i++) {
    flags = (await page.evaluate(([id, mid]) => window.shadowMail.mail.list({ accountId: id, folder: 'INBOX', limit: 50 }).then(x => x.rows.find(y => y.id === mid).flags || ''), [accB.id, target.id])) || ''
    if (!flags.includes('\\Seen')) await sleep(200)
  }
  check('the opened message became read, as on a click', flags.includes('\\Seen'), flags)
  const recent = await page.evaluate(() => window.shadowMail.mcp.recent())
  check('the call is in the "Legutóbbi Claude-hívások" list', JSON.stringify(recent).includes('open_message'), JSON.stringify(recent).slice(0, 200))

  // an unknown id: not_found, the view stays
  const nf = await c.tool('open_message', { message_id: 999_999 })
  await sleep(300)
  check('an unknown id: isError, not_found; the reader still shows the target', nf && nf.isError === true && nf._meta['shadowmail/data'].error === 'not_found' && (await page.locator('.reader-subject').innerText()) === 'Célpont titkos tárgy', JSON.stringify(nf && nf._meta))

  // a composer in focus keeps it; the view changes behind it
  const [win] = await Promise.all([app.waitForEvent('window', { timeout: 15_000 }), page.getByRole('button', { name: t.newMessage, exact: true }).click()])
  await win.locator('.editor').waitFor()
  await win.locator('#compose-subject').focus()
  await app.evaluate(({ BrowserWindow }, prefix) => BrowserWindow.getAllWindows().find(w => w.getTitle().startsWith(prefix))?.focus(), t.newMessage)
  await sleep(300)
  const focusedBefore = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.getTitle() || null)
  const r2 = await c.tool('open_message', { message_id: other.id })
  await page.locator('.reader-subject', { hasText: 'Másik levél' }).waitFor({ timeout: 10_000 })
  const focusedAfter = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.getTitle() || null)
  check('a composer in focus: the answer says "flashed", the focus stays on the composer, the view changed', focusedBefore && focusedBefore.startsWith(t.newMessage) && r2._meta['shadowmail/data'].window === 'flashed' && focusedAfter === focusedBefore, JSON.stringify({ focusedBefore, focusedAfter, window: r2._meta['shadowmail/data'].window }))
  await app.evaluate(({ BrowserWindow }, prefix) => BrowserWindow.getAllWindows().find(w => w.getTitle().startsWith(prefix))?.destroy(), t.newMessage)
  await sleep(200)
  // without a composer the main window is shown
  const r3 = await c.tool('open_message', { message_id: target.id })
  check('without a composer: "shown"', r3._meta['shadowmail/data'].window === 'shown', JSON.stringify(r3._meta))

  // an editor with input open in the main window is not left; the message is offered in a banner
  // the Címlista editor
  await page.getByRole('button', { name: t.viewContacts, exact: true }).click()
  await page.locator('.contact-new').click()
  await page.locator('input[name="displayName"]').fill('Félkész Ferenc')
  await page.locator('input[name="org"]').fill('Mentetlen Kft.')
  const u1 = await c.tool('open_message', { message_id: other.id })
  await page.locator('.claude-offer').waitFor({ timeout: 5000 })
  const u1State = await page.evaluate(() => ({ name: document.querySelector('form.contact-editor input[name="displayName"]')?.value ?? null, org: document.querySelector('form.contact-editor input[name="org"]')?.value ?? null, mail: !!document.querySelector('.mail-panes') }))
  check('Címlista editor with input: the view stays, the input is kept, a banner offers the message; the answer says offered', u1 && u1.isError === false && u1._meta['shadowmail/data'].offered === true && u1._meta['shadowmail/data'].opened === false && /nem váltott/.test(u1.content[0].text) /* the tool's text: Hungarian in both languages */ && u1State.name === 'Félkész Ferenc' && u1State.org === 'Mentetlen Kft.' && !u1State.mail, JSON.stringify({ meta: u1 && u1._meta, u1State }))
  await page.locator('.claude-offer-open').click()
  await page.locator('.reader-subject', { hasText: 'Másik levél' }).waitFor({ timeout: 10_000 })
  check('"Megnyitás" in the banner opens the message (the user\'s choice)', (await page.locator('.claude-offer').count()) === 0)
  // the Beállítások "Új fiók" form
  await page.getByRole('button', { name: t.viewSettings, exact: true }).click()
  await page.getByRole('button', { name: t.accountNew, exact: true }).click()
  await page.locator('form.account-editor').waitFor()
  await page.locator('#acc-name').fill('Mentetlen fiók')
  const u2 = await c.tool('open_message', { message_id: target.id })
  await page.locator('.claude-offer').waitFor({ timeout: 5000 })
  check('the account editor with input: the view stays, the name is kept; offered', u2._meta['shadowmail/data'].offered === true && (await page.locator('#acc-name').inputValue()) === 'Mentetlen fiók')
  await page.locator('.claude-offer button[aria-label]').first().click()
  await page.waitForTimeout(150)
  check('the banner closes without opening; the editor still there', (await page.locator('.claude-offer').count()) === 0 && (await page.locator('#acc-name').inputValue()) === 'Mentetlen fiók')
  // the settings view without an editor: opened as before
  await page.getByRole('button', { name: t.accountCancel, exact: true }).click().catch(() => {})
  await page.locator('form.account-editor').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
  const u3 = await c.tool('open_message', { message_id: target.id })
  await page.locator('.reader-subject', { hasText: 'Célpont titkos tárgy' }).waitFor({ timeout: 10_000 })
  check('settings without an open editor: opened at once (as before)', u3._meta['shadowmail/data'].opened === true, JSON.stringify(u3._meta))

  await page.evaluate(() => window.shadowMail.mcp.setEnabled(false))
  const log = fs.readFileSync(path.join(dataDir, 'electron', 'logs', 'main.log'), 'utf8')
  check('main.log: no subject or sender of the opened message; the tool line with counts', !/célpont|titkos-o1/.test(log) && /mcp tool=open_message result=ok items=1/.test(log) && /mcp tool=open_message result=not_found/.test(log))
  check('no console error or warning in the renderer', consoleProblems.length === 0, consoleProblems.join(' | '))
  const netLog = path.join(dataDir, 'electron', 'logs', 'net-guard.log')
  check('the net-guard log has no outgoing request', !fs.existsSync(netLog) || fs.readFileSync(netLog, 'utf8').trim() === '')
} catch (err) {
  check('run', false, err.stack)
} finally {
  c.close()
  await Promise.race([c.exited, sleep(10_000)])
  await app.close().catch(() => {})
  await popA.close?.()
  await popB.close?.()
  fs.rmSync(work, { recursive: true, force: true })
}
const ok = results.filter(Boolean).length
console.log(`${ok} / ${results.length} ${ok === results.length ? 'OK' : 'FAIL'}`)
process.exit(ok === results.length ? 0 : 1)
