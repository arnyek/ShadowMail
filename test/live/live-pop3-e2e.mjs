#!/usr/bin/env node
// Live acceptance run of the POP3 side in the REAL app (headless Electron + Playwright) against
// the dedicated test mailbox. Not part of `npm test`.
//
//   node test/live/live-pop3-e2e.mjs <test account .env>
//
// Lockout rules (live-lib.mjs): pre-flight first, configured settings only, the first rejected login
// stops the run. POP3 sees the INBOX of the same mailbox, and "delete after N days" (N = 0 here)
// would empty the whole INBOX: for that step every other INBOX message is parked in a temporary
// folder (side client, IMAP MOVE) and moved back after the app is closed.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { loadEnv, preflight, sideClient, accountForm, checker, waitFor, redactor, sec, abort } from './live-lib.mjs'
import { Pop3Client } from '../../core/pop3/client.js'
import { createVaultedDatabase } from '../../core/vault/vaulted-db.js'
import { AccountStore } from '../../core/accounts/model.js'

const env = loadEnv(process.argv[2])
const redact = redactor(env)
const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const MASTER = 'Live-mesterjelszo-helyi'
const RUN = `SMLIVE-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}-${crypto.randomBytes(2).toString('hex')}`
const word = `popszo${crypto.randomBytes(3).toString('hex')}`
const check = checker()
console.log(`run ${RUN}`)
setTimeout(() => {
  console.log('FAIL watchdog: more than 10 minutes')
  process.exit(1)
}, 10 * 60_000).unref()

async function stat() {
  const c = new Pop3Client({ host: env.POP3_HOST, port: Number(env.POP3_PORT), security: sec(env.POP3_SECURITY), tlsVerify: true, timeoutMs: 20_000 })
  try {
    await c.connect()
    try {
      await c.login(env.USER, env.PASS)
    } catch (err) {
      abort(env, `POP3 login failed: ${err.message}`)
    }
    const s = await c.stat()
    await c.quit()
    return s
  } finally {
    c.close()
  }
}

await preflight(env)
const S = await sideClient(env)
const subject = `${RUN} POP3 próba`
const d = new Date()
await S.append('INBOX', Buffer.from(`From: <${env.EMAIL}>\r\nTo: <${env.EMAIL}>\r\nSubject: ${subject}\r\nDate: ${d.toUTCString()}\r\nMessage-ID: <${RUN}-pop3@shadowmail.invalid>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\nPOP3 élő próba ${word}\r\n`), [], d)
const stat0 = await stat()
console.log(`STAT before: ${JSON.stringify(stat0)}`)

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-live-pop3-'))
const dataDir = path.join(work, 'data')
fs.mkdirSync(dataDir)
let accountId
{
  const { db, vault } = await createVaultedDatabase(dataDir, MASTER) // vault.json + the encrypted mail.sqlite
  const store = new AccountStore(db, vault, { storeDir: path.join(dataDir, 'store') })
  accountId = store.save(accountForm(env, 'pop3', { name: 'Élő POP3' })).account.id
  db.close()
}
let app
let page
const parked = `${RUN}-tarolo`
let parkedCount = 0
try {
  app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
  page = await app.firstWindow()
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: 'Feloldás', exact: true }).click()
  // while the unlock still runs the mail IPC answers { ok: false, error: 'locked' }: no accounts yet
  const status = async () => ((await page.evaluate(() => window.shadowMail.mail.status())).accounts || []).find(a => a.accountId === accountId)
  const synced = t => waitFor(async () => {
    const s = await status()
    return s && !s.running && s.lastFinished && Date.parse(s.lastFinished) >= t ? s : null
  }, { timeout: 120_000, step: 500 })
  const rows = async () => (await page.evaluate(id => window.shadowMail.mail.list({ accountId: id, folder: 'INBOX', limit: 500 }), accountId)).rows
  const local = q => page.evaluate(async ([id, q]) => (await window.shadowMail.search.local({ query: q, accountId: id })).rows, [accountId, q])

  let t = Date.now() - 1000
  const s1 = await synced(t)
  check('first POP3 fetch finished', s1.value && !s1.value.errorCode, `${s1.ms} ms`)
  const mine = (await rows()).find(r => r.subject === subject)
  check('the message is in the list', Boolean(mine), `${(await rows()).length} rows`)
  await page.locator('.msg-row', { hasText: subject }).waitFor({ timeout: 20_000 })
  check('... and shows in the UI list', true)
  const hits = await local(word)
  check('its text is found by the local search', hits.length === 1 && hits[0].id === mine.id)
  const stat1 = await stat()
  check('leave on server (default): STAT before = after', stat1.count === stat0.count && stat1.size === stat0.size, `${JSON.stringify(stat0)} -> ${JSON.stringify(stat1)}`)

  // delete after 0 days: park every other INBOX message first
  {
    await S.mailboxCreate(parked)
    const lock = await S.getMailboxLock('INBOX')
    try {
      const all = (await S.search({ all: true }, { uid: true })) || []
      const keep = (await S.search({ header: { subject: RUN } }, { uid: true })) || []
      const others = all.filter(u => !keep.includes(u))
      parkedCount = others.length
      if (others.length) await S.messageMove(others, parked, { uid: true })
    } finally {
      lock.release()
    }
    console.log(`  parked ${parkedCount} other INBOX messages in ${parked}`)
  }
  const acc = (await page.evaluate(() => window.shadowMail.accounts.list())).accounts.find(a => a.id === accountId)
  t = Date.now()
  const saved = await page.evaluate(form => window.shadowMail.accounts.save(form), { ...acc, pop3_delete_after_days: 0, in_password: '', smtp_password: '' })
  if (!saved.ok) throw new Error(`accounts.save: ${JSON.stringify(saved)}`)
  await synced(t)
  const stat2 = await stat()
  const onServer = await (async () => {
    const lock = await S.getMailboxLock('INBOX', { readOnly: true })
    try {
      return ((await S.search({ header: { subject } }, { uid: true })) || []).length
    } finally {
      lock.release()
    }
  })()
  check('delete after 0 days: gone from the server', onServer === 0, `STAT ${JSON.stringify(stat2)}, on the server ${onServer}`)
  const still = (await rows()).find(r => r.subject === subject)
  const opened = still ? await page.evaluate(id => window.shadowMail.mail.open(id), still.id) : null
  check('... kept here, and it opens from the local copy', opened && opened.ok && /POP3 élő próba/.test(opened.message.text || opened.message.html || ''))
} catch (err) {
  check('run', false, redact(err.stack))
} finally {
  await app?.close().catch(() => {})
  // the app is closed: nothing can delete any more; put the parked messages back
  if (parkedCount) {
    const lock = await S.getMailboxLock(parked)
    try {
      await S.messageMove('1:*', 'INBOX')
    } finally {
      lock.release()
    }
  }
  try {
    const st = await S.status(parked, { messages: true })
    if (st.messages === 0) await S.mailboxDelete(parked)
    console.log(`  parked messages moved back (${parkedCount}), ${parked} ${st.messages === 0 ? 'deleted' : `KEPT, ${st.messages} still inside`}`)
  } catch (err) {
    if (parkedCount) console.log(`  parking folder: ${err.message}`)
  }
  await S.logout().catch(() => {})
  fs.rmSync(work, { recursive: true, force: true })
}
console.log(`run tag on the server: ${RUN}`)
process.exit(check.summary() ? 1 : 0)
