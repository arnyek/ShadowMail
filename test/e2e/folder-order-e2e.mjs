#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// The manual order of the accounts and the folders in the real app, through the app's own IPC bridge (the drag and
// the menus come with the interface work): headless Electron + Playwright. Not part of `npm test`.
//
//   node test/e2e/folder-order-e2e.mjs
//
// A POP3 account (fake POP3 server: its command log shows any contact) and an unreachable IMAP account. Measured:
// folders:reorder on the top level and on a child list changes the sidebar, a wrong list is refused and changes
// nothing, accounts:reorder changes the account order, both survive a restart, folders:resetOrder gives the old tree
// back; meanwhile the POP3 server gets no command, the net-guard log stays empty, no IPC failure in main.log.
// Playwright: PW=<path of the playwright package> (default: the repo's playwright-core devDependency).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { FakePop3Server } from '../helpers/fake-pop3.js'
import { MailIndex } from '../../core/db/mail-index.js'
import { createVaultedDatabase } from '../../core/vault/vaulted-db.js'
import { AccountStore } from '../../core/accounts/model.js'
import { newAccountDefaults } from '../../core/accounts/defaults.js'
import { t, seedLanguage } from './lang.mjs'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const MASTER = 'Teszt-mesterjelszo-sorrend'
const now = Date.now()
const sleep = ms => new Promise(r => setTimeout(r, ms))

const server = await new FakePop3Server().listen()
server.add(Buffer.from(`From: f1@example.invalid\r\nSubject: POP 1\r\nDate: ${new Date(now - 60_000).toUTCString()}\r\n\r\nszöveg\r\n`))
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-order-e2e-'))
const dataDir = path.join(work, 'data')
fs.mkdirSync(dataDir)
seedLanguage(dataDir)
let pop, imap
{
  const { db, vault } = await createVaultedDatabase(dataDir, MASTER)
  const store = new AccountStore(db, vault, { storeDir: path.join(dataDir, 'store') })
  const base = { smtp_host: '127.0.0.1', smtp_port: 1, smtp_security: 'none', in_security: 'none', in_host: '127.0.0.1' }
  pop = store.save({ ...newAccountDefaults('pop3'), ...base, name: 'POP3-fiók', email: 'p@example.invalid', in_port: server.port, in_user: server.user, in_password: server.pass }).account.id
  imap = store.save({ ...newAccountDefaults('imap'), ...base, name: 'IMAP elérhetetlen', email: 'i@example.invalid', in_port: 1, in_user: 'i', in_password: 'nem-valodi' }).account.id
  const index = new MailIndex(db)
  for (const p of ['Számlák', 'Ügyek', 'Ügyek/2025', 'Ügyek/2026', 'Archív régi']) index.addFolder(pop, p, '/', true)
  for (const p of ['INBOX', 'Projektek']) index.upsertFolder({ account_id: imap, path: p, delimiter: '/', uidvalidity: '1', synced_at: now })
  db.close()
}

const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const netLog = path.join(dataDir, 'electron', 'logs', 'net-guard.log')
const mainLog = path.join(dataDir, 'electron', 'logs', 'main.log')
const quits = () => server.log.filter(l => l === 'QUIT').length

async function start() {
  const app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1280, height: 900 })
  const before = quits()
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  await page.locator(`.folder-tree section[data-account="${pop}"] .folder[data-path="INBOX"]`).waitFor({ timeout: 20000 })
  // the POP3 fetch of the unlock ends (QUIT): after that the server hears nothing until the 5 minute timer
  for (let i = 0; quits() === before; i++) {
    if (i > 400) throw new Error('the first POP3 fetch did not end')
    await sleep(50)
  }
  return { app, page }
}
const api = (page, group, method, ...args) => page.evaluate(([g, m, a]) => window.shadowMail[g][m](...a), [group, method, args])
// the sidebar as shown: [{ path, depth }] of one account, and the account order
const shown = (page, id) =>
  page.locator(`.folder-tree section[data-account="${id}"] .folder`).evaluateAll(els => els.map(el => ({ path: el.dataset.path, depth: Number(el.style.getPropertyValue('--depth') || 0) })))
const paths = list => list.map(x => x.path)
const level = (list, depth) => paths(list.filter(x => x.depth === depth))
const accounts = page => page.locator('.folder-tree section[data-account]').evaluateAll(els => els.map(el => Number(el.dataset.account)))
const until = async (fn, what) => {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return true
    await sleep(50)
  }
  throw new Error(`timed out: ${what}`)
}

let app = null
try {
  let page
  ;({ app, page } = await start())
  const logAt = server.log.length
  const original = await shown(page, pop)
  const top = level(original, 0)
  check('the seeded tree: the old rule (role folders first, the rest alphabetical)', JSON.stringify(top) === JSON.stringify(['INBOX', 'Drafts', 'Sent', 'Trash', 'Archív régi', 'Számlák', 'Ügyek']), JSON.stringify(top))

  // the top level reversed, then the children of Ügyek
  const reversed = [...top].reverse()
  const r1 = await api(page, 'folders', 'reorder', { accountId: pop, parentKey: null, paths: reversed })
  check('folders:reorder on the top level: ok', r1.ok && r1.count === top.length, JSON.stringify(r1))
  await until(async () => JSON.stringify(level(await shown(page, pop), 0)) === JSON.stringify(reversed), 'the top level in the new order')
  const r2 = await api(page, 'folders', 'reorder', { accountId: pop, parentKey: 'Ügyek', paths: ['Ügyek/2026', 'Ügyek/2025'] })
  check('folders:reorder on a child list: ok', r2.ok && r2.count === 2, JSON.stringify(r2))
  const ordered = ['Ügyek', 'Ügyek/2026', 'Ügyek/2025', 'Számlák', 'Archív régi', 'Trash', 'Sent', 'Drafts', 'INBOX']
  await until(async () => JSON.stringify(paths(await shown(page, pop))) === JSON.stringify(ordered), 'the child list in the new order')
  check('the sidebar shows both orders, the hierarchy (depths) unchanged', true)
  // by path, not in the shown order (the order did change)
  const depths = list => JSON.stringify(list.map(x => [x.path, x.depth]).sort((a, b) => (a[0] < b[0] ? -1 : 1)))
  const current = await shown(page, pop)
  check('every folder at its old depth', depths(current) === depths(original), depths(current))

  // a wrong list: refused, the tree stays
  const bad = await api(page, 'folders', 'reorder', { accountId: pop, parentKey: null, paths: [...reversed.slice(1), 'Ügyek/2025'] })
  const malformed = await api(page, 'folders', 'reorder', { accountId: pop, parentKey: null, paths: 'Ügyek' })
  check('a list with a path of another parent: order_mismatch; malformed: bad_request', bad.error === 'order_mismatch' && malformed.error === 'bad_request', JSON.stringify([bad, malformed]))
  await sleep(400)
  check('the refused calls changed nothing', JSON.stringify(paths(await shown(page, pop))) === JSON.stringify(ordered))

  // the accounts
  const accountOrder = await accounts(page)
  check('the seeded account order: the creation order', JSON.stringify(accountOrder) === JSON.stringify([pop, imap]), JSON.stringify(accountOrder))
  const r3 = await api(page, 'accounts', 'reorder', [imap, pop])
  check('accounts:reorder: ok, the answer in the new order', r3.ok && JSON.stringify(r3.accounts.map(a => a.id)) === JSON.stringify([imap, pop]))
  await until(async () => JSON.stringify(await accounts(page)) === JSON.stringify([imap, pop]), 'the account order in the sidebar')
  const r4 = await api(page, 'accounts', 'reorder', [imap, imap])
  check('accounts:reorder with a repeated id: order_mismatch', r4.error === 'order_mismatch', JSON.stringify(r4))

  check('no command reached the POP3 server meanwhile', server.log.length === logAt, JSON.stringify(server.log.slice(logAt)))
  await app.close()
  app = null

  // a restart: both orders are there
  ;({ app, page } = await start())
  await until(async () => JSON.stringify(paths(await shown(page, pop))) === JSON.stringify(ordered), 'the folder order after a restart').catch(() => false)
  check('after a restart: the folder order', JSON.stringify(paths(await shown(page, pop))) === JSON.stringify(ordered), JSON.stringify(paths(await shown(page, pop))))
  check('after a restart: the account order', JSON.stringify(await accounts(page)) === JSON.stringify([imap, pop]))

  // reset: the old tree; the account order is not part of it
  const logAt2 = server.log.length
  const r5 = await api(page, 'folders', 'resetOrder', { accountId: pop })
  check('folders:resetOrder: ok', r5.ok && r5.count === top.length + 2, JSON.stringify(r5))
  await until(async () => JSON.stringify(await shown(page, pop)) === JSON.stringify(original), 'the old tree')
  check('after the reset: the old tree, the account order stays', JSON.stringify(await accounts(page)) === JSON.stringify([imap, pop]))
  check('no command reached the POP3 server during the reset', server.log.length === logAt2)

  check('the net-guard log has no request', !fs.existsSync(netLog) || fs.readFileSync(netLog, 'utf8').trim() === '')
  const failed = fs.existsSync(mainLog) ? fs.readFileSync(mainLog, 'utf8').split('\n').filter(l => /(folders|accounts):(reorder|resetOrder) failed/.test(l)) : []
  check('main.log: no reorder failure', failed.length === 0, failed.join(' | '))
} catch (err) {
  check('run', false, err.stack)
} finally {
  if (app) await app.close().catch(() => {})
  await server.close()
  fs.rmSync(work, { recursive: true, force: true })
}
console.log(`\n${results.filter(Boolean).length} / ${results.length} OK`)
process.exit(results.every(Boolean) ? 0 : 1)
