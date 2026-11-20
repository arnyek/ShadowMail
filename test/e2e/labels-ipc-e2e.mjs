#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// The labels in the real app, through the app's own IPC bridge: headless Electron + Playwright. Not part of `npm test`.
//
//   node test/e2e/labels-ipc-e2e.mjs
//
// A POP3 account (fake POP3 server: its command log shows any contact) with two downloaded messages, an IMAP account on
// the TCP mini server (test/helpers/imap-wire.js) with seeded rows in two folders, and an unreachable IMAP account with
// one seeded row. Measured: a label made and put on three messages of two accounts and three folders (the IMAP ones as
// the keyword on the server); the change events name exactly those folders and the list change; the list rows and the
// search hits carry the label; on the unreachable account nothing changes and the answer says why; bad requests are
// refused and change nothing; after a restart the labels are there; meanwhile the POP3 server gets no command, the
// net-guard log stays empty, no label failure in main.log, the page console has no error or warning.
// Playwright: PW=<path of the playwright package> (default: the repo's playwright-core devDependency).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { FakePop3Server } from '../helpers/fake-pop3.js'
import { startImapWire } from '../helpers/imap-wire.js'
import { MailIndex } from '../../core/db/mail-index.js'
import { createVaultedDatabase } from '../../core/vault/vaulted-db.js'
import { AccountStore } from '../../core/accounts/model.js'
import { newAccountDefaults } from '../../core/accounts/defaults.js'
import { t, seedLanguage } from './lang.mjs'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const MASTER = 'Teszt-mesterjelszo-cimkek'
const now = Date.now()
const sleep = ms => new Promise(r => setTimeout(r, ms))

const server = await new FakePop3Server().listen()
for (const [i, s] of [[1, 'Ajánlatkérés kazánra'], [2, 'Számla november']]) {
  server.add(Buffer.from(`From: f${i}@example.invalid\r\nTo: p@example.invalid\r\nSubject: =?UTF-8?B?${Buffer.from(s).toString('base64')}?=\r\nMessage-ID: <pop${i}@example.invalid>\r\nDate: ${new Date(now - i * 60_000).toUTCString()}\r\n\r\nbodzaszörp ${i}\r\n`))
}
// older than the account's index limit: the sync asks no body of the mini server (it has none)
const OLD = now - 4 * 365 * 86_400_000
const wire = await startImapWire({ delimiter: '/', folders: [{ path: 'INBOX', mail: [{ uid: 1, flags: ['\\Seen'] }] }, { path: 'Projektek', mail: [{ uid: 2, flags: ['\\Seen'] }, { uid: 3, flags: ['\\Seen'] }] }] })
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-labels-e2e-'))
const dataDir = path.join(work, 'data')
fs.mkdirSync(dataDir)
seedLanguage(dataDir)
let pop, imap, unreachable
{
  const { db, vault } = await createVaultedDatabase(dataDir, MASTER)
  const store = new AccountStore(db, vault, { storeDir: path.join(dataDir, 'store') })
  const base = { smtp_host: '127.0.0.1', smtp_port: 1, smtp_security: 'none', in_security: 'none', in_host: '127.0.0.1' }
  pop = store.save({ ...newAccountDefaults('pop3'), ...base, name: 'POP3-fiók', email: 'p@example.invalid', in_port: server.port, in_user: server.user, in_password: server.pass }).account.id
  imap = store.save({ ...newAccountDefaults('imap'), ...base, name: 'IMAP szerverrel', email: 'i@example.invalid', in_port: wire.port, in_user: 'i', in_password: 'nem-valodi' }).account.id
  unreachable = store.save({ ...newAccountDefaults('imap'), ...base, name: 'IMAP elérhetetlen', email: 'u@example.invalid', in_port: 1, in_user: 'u', in_password: 'nem-valodi' }).account.id
  const index = new MailIndex(db)
  for (const p of ['INBOX', 'Projektek']) index.upsertFolder({ account_id: imap, path: p, delimiter: '/', uidvalidity: '7', synced_at: now })
  index.upsertFolder({ account_id: unreachable, path: 'INBOX', delimiter: '/', uidvalidity: '7', synced_at: now })
  const row = (folder, uid, subject, account = imap) => ({ account_id: account, folder, uid, message_id: `<imap${account}-${uid}@example.invalid>`, in_reply_to: null, refs: null,
    from_addr: 'k@example.invalid', from_name: 'Küldő', to_addrs: 'i@example.invalid', cc_addrs: '', subject, date: OLD - uid * 1000, idate: OLD - uid * 1000,
    flags: '\\Seen', size: 500, has_attachments: 0, attachments: null, body_state: 3, sender_text: 'Küldő k@example.invalid', recipients_text: 'i@example.invalid' })
  index.insertMany([row('INBOX', 1, 'IMAP bodzaszörp beérkezett'), row('Projektek', 2, 'IMAP bodzaszörp projekt'), row('Projektek', 3, 'Címke nélkül'), row('INBOX', 1, 'Elérhetetlen levél', unreachable)])
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
const consoleLines = []

async function start() {
  const app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
  const page = await app.firstWindow()
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') consoleLines.push(`${m.type()}: ${m.text()}`) })
  await page.setViewportSize({ width: 1280, height: 900 })
  const before = quits()
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  await page.locator(`.folder-tree section[data-account="${pop}"] .folder[data-path="INBOX"]`).waitFor({ timeout: 20000 })
  for (let i = 0; quits() === before; i++) {
    if (i > 400) throw new Error('the first POP3 fetch did not end')
    await sleep(50)
  }
  // every app:status event from now on
  await page.evaluate(() => {
    window.__events = []
    window.shadowMail.onStatus(e => window.__events.push(e))
  })
  return { app, page }
}
const api = (page, group, method, ...args) => page.evaluate(([g, m, a]) => window.shadowMail[g][m](...a), [group, method, args])
const events = page => page.evaluate(() => window.__events.splice(0))
const listOf = async (page, accountId, folder) => (await api(page, 'mail', 'list', { accountId, folder })).rows
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
  const popRows = await listOf(page, pop, 'INBOX')
  const inbox = await listOf(page, imap, 'INBOX')
  const projects = await listOf(page, imap, 'Projektek')
  check('the seed: two POP3 messages, one IMAP INBOX row, two IMAP Projektek rows', popRows.length === 2 && inbox.length === 1 && projects.length === 2)
  check('the rows carry an empty labels list', [...popRows, ...inbox, ...projects].every(r => Array.isArray(r.labels) && r.labels.length === 0))

  const made = await api(page, 'labels', 'create', 'Ügyfél', '#2E7D32')
  check('labels.create: ok, the color lower case', made.ok && made.label.name === 'Ügyfél' && made.label.color === '#2e7d32', JSON.stringify(made))
  const id = made.label.id
  await until(async () => (await page.evaluate(() => window.__events.some(e => e.kind === 'labels'))), 'the labels event')
  await events(page)

  const target = [popRows[0].id, inbox[0].id, projects.find(r => r.subject === 'IMAP bodzaszörp projekt').id]
  const res = await api(page, 'mail', 'label', { ids: target, add: [id] })
  check('mail.label: three ids of two accounts and three folders, changed 3', res.ok && res.changed === 3 && res.failed.length === 0 && res.local.length === 0, JSON.stringify(res))
  check('the IMAP ones: the keyword on the server (that copy only)', wire.flagsOf('INBOX', 1).includes(made.label.keyword) && wire.flagsOf('Projektek', 2).includes(made.label.keyword) && !wire.flagsOf('Projektek', 3).includes(made.label.keyword), JSON.stringify([wire.flagsOf('INBOX', 1), wire.flagsOf('Projektek', 2), wire.flagsOf('Projektek', 3)]))
  await until(async () => (await page.evaluate(() => window.__events.some(e => e.kind === 'mail'))), 'the mail change event')
  await sleep(400) // the change events come in 250 ms batches
  const changed = (await events(page)).filter(e => e.kind === 'mail').flatMap(e => e.changes).flatMap(c => c.folders.map(f => `${c.accountId}:${f}`))
  check('the change events name the three folders', JSON.stringify([...new Set(changed)].sort()) === JSON.stringify([`${imap}:INBOX`, `${imap}:Projektek`, `${pop}:INBOX`].sort()), JSON.stringify(changed))

  const labelled = rows => rows.filter(r => r.labels.includes(id)).map(r => r.id)
  check('mail.list: the labelled rows have the label, the others not',
    JSON.stringify(labelled(await listOf(page, pop, 'INBOX'))) === JSON.stringify([popRows[0].id]) &&
    JSON.stringify(labelled(await listOf(page, imap, 'INBOX'))) === JSON.stringify([inbox[0].id]) &&
    JSON.stringify(labelled(await listOf(page, imap, 'Projektek'))) === JSON.stringify([target[2]]))
  const hits = (await api(page, 'search', 'local', { query: 'bodzaszörp' })).rows
  check('search.local: the hits carry the label', hits.length === 4 && JSON.stringify(labelled(hits).sort()) === JSON.stringify([...target].sort()), JSON.stringify(hits.map(h => [h.subject, h.labels])))
  const list = await api(page, 'labels', 'list')
  check('labels.list: the count is 3 messages', list.ok && list.labels.length === 1 && list.labels[0].count === 3, JSON.stringify(list))

  // the unreachable account: nothing changes, the answer names the folder and the reason
  const lost = (await listOf(page, unreachable, 'INBOX'))[0]
  const refused = await api(page, 'mail', 'label', { ids: [lost.id], add: [id] })
  check('unreachable IMAP: nothing changes, failed with the reason', refused.ok && refused.changed === 0 && refused.failed.length === 1 && refused.failed[0].accountId === unreachable && refused.failed[0].folder === 'INBOX' && refused.failed[0].error === 'connection_refused', JSON.stringify(refused))
  check('unreachable IMAP: the row has no label', (await listOf(page, unreachable, 'INBOX'))[0].labels.length === 0)

  const bad = [
    await api(page, 'mail', 'label', { ids: [popRows[1].id], add: [id + 99] }),
    await api(page, 'mail', 'label', { ids: Array.from({ length: 501 }, (_, i) => i + 1), add: [id] }),
    await api(page, 'mail', 'label', { ids: [String(popRows[1].id)], add: [id] }),
  ]
  check('unknown label, 501 ids, string id: bad_request', bad.every(r => r.ok === false && r.error === 'bad_request'), JSON.stringify(bad))
  check('the refused calls changed nothing', (await api(page, 'labels', 'list')).labels[0].count === 3 && (await listOf(page, pop, 'INBOX')).find(r => r.id === popRows[1].id).labels.length === 0)
  const taken = await api(page, 'labels', 'create', 'ügyfél', '#000000')
  check('labels.create with the name in another case: name_taken', taken.error === 'name_taken', JSON.stringify(taken))

  check('no command reached the POP3 server meanwhile', server.log.length === logAt, JSON.stringify(server.log.slice(logAt)))
  await app.close()
  app = null

  // a restart: the label and its messages are there
  ;({ app, page } = await start())
  const again = await api(page, 'labels', 'list')
  check('after a restart: the label with 3 messages', again.ok && again.labels[0].name === 'Ügyfél' && again.labels[0].count === 3, JSON.stringify(again))
  check('after a restart: the list rows carry it', JSON.stringify(labelled(await listOf(page, imap, 'Projektek'))) === JSON.stringify([target[2]]))
  const off = await api(page, 'mail', 'label', { ids: [target[2]], remove: [id] })
  check('mail.label remove: changed 1', off.ok && off.changed === 1, JSON.stringify(off))
  const gone = await api(page, 'labels', 'remove', id)
  check('labels.remove: the count it was on (2)', gone.ok && gone.count === 2, JSON.stringify(gone))
  check('after the delete: no row carries a label', [...(await listOf(page, pop, 'INBOX')), ...(await listOf(page, imap, 'INBOX'))].every(r => r.labels.length === 0))

  check('the net-guard log has no request', !fs.existsSync(netLog) || fs.readFileSync(netLog, 'utf8').trim() === '')
  const failed = fs.existsSync(mainLog) ? fs.readFileSync(mainLog, 'utf8').split('\n').filter(l => /(labels:\w+|mail:label) failed/.test(l)) : []
  check('main.log: no label failure', failed.length === 0, failed.join(' | '))
  check('the page console: no error or warning', consoleLines.length === 0, consoleLines.join(' | '))
} catch (err) {
  check('run', false, err.stack)
} finally {
  if (app) await app.close().catch(() => {})
  await server.close()
  await wire.close()
  fs.rmSync(work, { recursive: true, force: true })
}
console.log(`\n${results.filter(Boolean).length} / ${results.length} OK`)
process.exit(results.every(Boolean) ? 0 : 1)
