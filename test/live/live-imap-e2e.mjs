#!/usr/bin/env node
// Live acceptance run of the IMAP side in the REAL app (headless Electron + Playwright) against the
// dedicated test mailbox: sync, reader, actions, composer, reply, search, folders. Not part of `npm test`.
//
//   node test/live/live-imap-e2e.mjs <test account .env> [--only k5,k11,...]
//
// Lockout rules (live-lib.mjs): pre-flight without login first, the configured settings only, no
// deliberate wrong password; the first rejected login stops the run. Mail goes ONLY to the test
// account's own address. Every message and folder this run makes carries the tag SMLIVE-<run id>.
// The server side is checked with a second, independent IMAP connection (imapflow, "side client").
// The network cut is a tls/net.connect wrapper installed in the app's main process (installNetcut).
// Playwright: PW=<path of the playwright package> (default: the repo's playwright-core devDependency).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import nodemailer from 'nodemailer'
import { simpleParser } from 'mailparser'
import Database from 'better-sqlite3-multiple-ciphers'
import { loadEnv, preflight, sideClient, accountForm, checker, sleep, waitFor, redactor, abort } from './live-lib.mjs'
import { smtpOptions } from '../../core/accounts/probe.js'
import { databasePath } from '../../core/paths.js'
import { createVaultedDatabase } from '../../core/vault/vaulted-db.js'
import { AccountStore } from '../../core/accounts/model.js'

const { values, positionals } = parseArgs({ allowPositionals: true, options: { only: { type: 'string' }, keep: { type: 'boolean' } } })
const env = loadEnv(positionals[0])
const redact = redactor(env)
const want = card => !values.only || values.only.split(',').includes(card)
const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const MASTER = 'Live-mesterjelszo-helyi'
const RUN = `SMLIVE-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}-${crypto.randomBytes(2).toString('hex')}`
const r = crypto.randomBytes(3).toString('hex')
const W = { subjOld: `fejlecszo${r}`, bodyOld: `regiszoveg${r}`, common: `kozosszo${r}` }
const sha = b => crypto.createHash('sha256').update(b).digest('hex')
const check = checker()
console.log(`run ${RUN}`)

const watchdog = setTimeout(() => {
  console.log('FAIL watchdog: the run took more than 25 minutes')
  process.exit(1)
}, 25 * 60_000)
watchdog.unref()

await preflight(env)
const S = await sideClient(env)

// ---- server helpers (side client) ----
async function serverStatus() {
  const out = {}
  for (const f of await S.list({ statusQuery: { messages: true, unseen: true } })) out[f.path] = { messages: f.status.messages, unseen: f.status.unseen }
  return out
}
async function serverFind(folder, subjectPart) {
  const lock = await S.getMailboxLock(folder, { readOnly: true })
  try {
    await S.noop() // an already selected mailbox learns about new messages (EXISTS) only on the next command
    const uids = (await S.search({ header: { subject: subjectPart } }, { uid: true })) || []
    const out = []
    if (uids.length) for await (const m of S.fetch(uids, { uid: true, flags: true, envelope: true }, { uid: true })) out.push({ uid: m.uid, flags: [...m.flags], subject: m.envelope.subject, messageId: m.envelope.messageId })
    return out
  } finally {
    lock.release()
  }
}
async function serverSource(folder, uid) {
  const lock = await S.getMailboxLock(folder, { readOnly: true })
  try {
    const m = await S.fetchOne(String(uid), { source: true }, { uid: true })
    return m.source
  } finally {
    lock.release()
  }
}
async function serverFolders() {
  return (await S.list()).map(f => ({ path: f.path, delimiter: f.delimiter }))
}
const mime = ({ subject, body, date, messageId }) =>
  Buffer.from(
    `From: ShadowMail élő teszt <${env.EMAIL}>\r\nTo: <${env.EMAIL}>\r\nSubject: ${subject}\r\nDate: ${date.toUTCString()}\r\nMessage-ID: <${messageId}@shadowmail.invalid>\r\n` +
      `MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${body}\r\n`,
  )

// ---- 0. seed: the 4 year old message and 26 messages for the actions ----
const now = Date.now()
const oldDate = new Date(now - 4 * 365 * 86400_000)
await S.append('INBOX', mime({ subject: `${RUN} regi level ${W.subjOld}`, body: `Ez egy negy eves level. ${W.bodyOld} ${W.common}`, date: oldDate, messageId: `${RUN}-old` }), [], oldDate)
for (let i = 1; i <= 26; i++) {
  const d = new Date(now - i * 60_000)
  await S.append('INBOX', mime({ subject: `${RUN} ACT ${String(i).padStart(2, '0')}`, body: `ACT tesztlevel ${i}. ${W.common}`, date: d, messageId: `${RUN}-k7-${i}` }), [], d)
}
const before = await serverStatus()
console.log(`seeded: INBOX ${before.INBOX.messages} messages, ${before.INBOX.unseen} unseen`)

// ---- the app's data folder: vault + the IMAP account (configured settings, limit 3 years) ----
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-live-'))
const dataDir = path.join(work, 'data')
fs.mkdirSync(dataDir)
const files = path.join(work, 'files')
fs.mkdirSync(files)
const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), crypto.randomBytes(40_000)])
const txtName = 'árvíztűrő tükörfúrógép.txt'
fs.writeFileSync(path.join(files, 'szamla.pdf'), pdf)
fs.writeFileSync(path.join(files, txtName), 'Ékezetes tartalom őű\r\n')
const cutFlag = path.join(work, 'netcut.on')
let accountId
let dbKeyHex // the measurement reads the app's encrypted database with the same key, read-only
{
  const { db, vault } = await createVaultedDatabase(dataDir, MASTER) // vault.json + the encrypted mail.sqlite
  const store = new AccountStore(db, vault, { storeDir: path.join(dataDir, 'store') })
  accountId = store.save(accountForm(env, 'imap', { name: 'Élő tesztfiók', display_name: 'ShadowMail Élő Teszt' })).account.id
  const key = vault.databaseKey()
  dbKeyHex = key.toString('hex')
  key.fill(0)
  db.close()
}
const ro = () => {
  const d = new Database(databasePath(dataDir), { readonly: true, fileMustExist: true })
  d.pragma("cipher = 'sqlcipher'")
  d.pragma(`key = "x'${dbKeyHex}'"`)
  return d
}
const dbRow = (sql, ...a) => {
  const d = ro()
  try {
    return d.prepare(sql).get(...a)
  } finally {
    d.close()
  }
}

// Test-only "network cable" inside the app's main process (Playwright drops NODE_OPTIONS, so it is
// installed with app.evaluate before the unlock). While the flag file exists, every open socket to the
// host is reset and new connections to it are refused (sent to 127.0.0.1:9, servername kept).
// Removing the file plugs the cable back in. imapflow and nodemailer look tls.connect / net.connect up
// at call time, so replacing the properties is enough.
function installNetcut(_electron, { flag, host }) {
  const fs = process.getBuiltinModule('node:fs')
  const net = process.getBuiltinModule('node:net')
  const tls = process.getBuiltinModule('node:tls')
  const open = new Set()
  const cut = () => fs.existsSync(flag)
  const wrap = original =>
    function connect(...args) {
      const o = args[0]
      if (o && typeof o === 'object' && (o.host === host || o.servername === host)) {
        if (cut()) args[0] = { ...o, host: '127.0.0.1', port: 9, servername: o.servername || host }
        const socket = original.apply(this, args)
        open.add(socket)
        socket.once('close', () => open.delete(socket))
        return socket
      }
      return original.apply(this, args)
    }
  tls.connect = wrap(tls.connect)
  net.connect = net.createConnection = wrap(net.connect)
  let was = false
  globalThis.__netcutTimer = setInterval(() => {
    const now = cut()
    if (now && !was) for (const s of open) s.destroy(Object.assign(new Error('read ECONNRESET (netcut)'), { code: 'ECONNRESET' }))
    was = now
  }, 200)
  return true
}

let app
let page
async function launch() {
  app = await _electron.launch({
    executablePath: electronBin,
    args: [repo, '--ozone-platform=headless', '--disable-gpu'],
    cwd: repo,
    env: {
      ...process.env,
      SHADOWMAIL_DATA: dataDir,
    },
  })
  // before the unlock, so the very first connection already goes through it
  await app.evaluate(installNetcut, { flag: cutFlag, host: env.IMAP_HOST })
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [`${dir}/szamla.pdf`, `${dir}/árvíztűrő tükörfúrógép.txt`] })
  }, files)
  page = await app.firstWindow()
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: 'Feloldás', exact: true }).click()
  await page.evaluate(() => {
    window.__ev = []
    window.shadowMail.onStatus(p => window.__ev.push(p))
  })
}
// while the unlock still runs the mail IPC answers { ok: false, error: 'locked' }: no accounts yet
const status = async () => ((await page.evaluate(() => window.shadowMail.mail.status())).accounts || []).find(a => a.accountId === accountId)
async function syncedAfter(t, timeout = 120_000) {
  return waitFor(async () => {
    const s = await status()
    return s && !s.running && s.lastFinished && Date.parse(s.lastFinished) >= t ? s : null
  }, { timeout, step: 500 })
}
const list = folder => page.evaluate(async ([id, f]) => (await window.shadowMail.mail.list({ accountId: id, folder: f, limit: 500 })).rows, [accountId, folder])
const findRow = async (folder, part) => (await list(folder)).find(x => (x.subject || '').includes(part))
const local = query => page.evaluate(async ([id, q]) => (await window.shadowMail.search.local({ query: q, accountId: id })).rows, [accountId, query])
const ipc = (fn, arg) => page.evaluate(async ([f, a]) => {
  const [ns, m] = f.split('.')
  return window.shadowMail[ns][m](...a)
}, [fn, arg])
async function serverSearch(query) {
  const t0 = Date.now()
  const { jobId } = await page.evaluate(async ([id, q]) => window.shadowMail.search.server({ query: q, accountId: id }), [accountId, query])
  const done = await waitFor(() => page.evaluate(j => window.__ev.find(e => e.kind === 'search' && e.jobId === j && e.finished), jobId), { timeout: 120_000 })
  const hits = await page.evaluate(j => window.__ev.filter(e => e.kind === 'search' && e.jobId === j && e.hits).flatMap(e => e.hits), jobId)
  return { jobId, finished: done.value && done.value.finished, hits, ms: Date.now() - t0 }
}
async function openInbox() {
  await page.locator('.folder-tree section', { hasText: 'Élő tesztfiók' }).locator('.folder[data-path="INBOX"]').click()
}

try {
  let t = Date.now()
  await launch()
  const first = await syncedAfter(t)
  check('first sync finished', first.value && !first.value.errorCode, `${first.ms} ms, ${JSON.stringify(first.value && { errorCode: first.value.errorCode, live: first.value.live })}`)
  const old = await findRow('INBOX', W.subjOld)

  if (want('k4')) {
    // the app's own "Kapcsolat próbája" (accounts:test): the stored IMAP account (blank password
    // field = the stored one), and the same mailbox as an unsaved POP3 form. Configured settings only.
    const acc = (await ipc('accounts.list', [])).accounts.find(a => a.id === accountId)
    const t1 = performance.now()
    const imapTest = await ipc('accounts.test', [{ ...acc, in_password: '', smtp_password: '' }])
    const imapMs = Math.round(performance.now() - t1)
    check('IMAP account: the connection test passes on the incoming AND the SMTP side', imapTest.ok && imapTest.incoming?.ok && imapTest.smtp?.ok,
      `${imapMs} ms ${JSON.stringify({ incoming: imapTest.incoming && { ok: imapTest.incoming.ok, error: imapTest.incoming.error, ms: imapTest.incoming.ms }, smtp: imapTest.smtp && { ok: imapTest.smtp.ok, error: imapTest.smtp.error, ms: imapTest.smtp.ms } })}`)
    if (!imapTest.incoming?.ok || !imapTest.smtp?.ok) abort(env, 'the connection test failed, stopping (lockout rule)')
    const popTest = await ipc('accounts.test', [accountForm(env, 'pop3')])
    check('POP3 form: the connection test passes on the incoming AND the SMTP side', popTest.ok && popTest.incoming?.ok && popTest.smtp?.ok,
      JSON.stringify({ incoming: popTest.incoming && { ok: popTest.incoming.ok, error: popTest.incoming.error, ms: popTest.incoming.ms }, smtp: popTest.smtp && { ok: popTest.smtp.ok, error: popTest.smtp.error, ms: popTest.smtp.ms } }))
    if (!popTest.incoming?.ok || !popTest.smtp?.ok) abort(env, 'the connection test failed, stopping (lockout rule)')
    const raw = fs.readFileSync(databasePath(dataDir))
    const wal = fs.existsSync(`${databasePath(dataDir)}-wal`) ? fs.readFileSync(`${databasePath(dataDir)}-wal`) : Buffer.alloc(0)
    check('the password is not in mail.sqlite / -wal (only in the vault, encrypted)', !raw.includes(Buffer.from(env.PASS)) && !wal.includes(Buffer.from(env.PASS)))
  }

  if (want('k5')) {
    // folder tree, counts, nothing set to read by the sync
    const tree = await page.locator('.folder-tree section', { hasText: 'Élő tesztfiók' }).innerText()
    console.log(`  folder tree: ${tree.replace(/\n+/g, ' | ')}`)
    const folders = (await ipc('mail.folders', [])).accounts.find(a => a.id === accountId).folders
    const inbox = folders.find(f => f.path === 'INBOX')
    check('INBOX count in the app = on the server', inbox.count === before.INBOX.messages, `${inbox.count} / ${before.INBOX.messages}`)
    const after = await serverStatus()
    check('the sync set nothing read (unread counts on the server unchanged in every folder)', JSON.stringify(after) === JSON.stringify(before), JSON.stringify(after))
    check('unread count in the app = on the server', inbox.unread === before.INBOX.unseen, `${inbox.unread} / ${before.INBOX.unseen}`)
    check('the 4 year old APPENDed message is in the list with its metadata', old && Math.abs(old.date - oldDate.getTime()) < 2000, old ? `${old.subject} ${new Date(old.date).toISOString()}` : 'missing')
    check('4 year old message: its text is NOT found by the local search', (await local(W.bodyOld)).length === 0)
    check('4 year old message: its subject IS found', (await local(W.subjOld)).length === 1)
  }

  if (want('k11')) {
    // server search before the old message is ever opened
    const res = await serverSearch(W.bodyOld)
    check('"Keresés a szerveren is" finds the 4 year old text', res.finished && !res.finished.errors.length && res.hits.length === 1 && res.hits[0].id === old.id, `${res.ms} ms, hits ${JSON.stringify(res.hits.map(h => h.subject))}, finished ${JSON.stringify(res.finished)}`)
    const common = await serverSearch(W.common)
    const localCommon = await local(W.common)
    const overlap = common.hits.filter(h => localCommon.some(l => l.id === h.id))
    check('a word in old AND recent messages: the server adds only the old one, no duplicates', common.hits.length === 1 && common.hits[0].id === old.id && overlap.length === 0, `server ${common.hits.length}, local ${localCommon.length}, overlap ${overlap.length}`)
    check('after the server search the old message is still not in the text index (body_state 3)', dbRow('SELECT body_state FROM messages WHERE id = ?', old.id).body_state === 3)
    // cancel
    const tc = Date.now()
    const { jobId } = await page.evaluate(async ([id, q]) => window.shadowMail.search.server({ query: q, accountId: id }), [accountId, W.common])
    await page.evaluate(j => window.shadowMail.search.cancel(j), jobId)
    const c = await waitFor(() => page.evaluate(j => window.__ev.find(e => e.kind === 'search' && e.jobId === j && e.finished), jobId), { timeout: 10_000 })
    check('cancel: finished within 2 s', c.value && Date.now() - tc < 2000, `${Date.now() - tc} ms, ${JSON.stringify(c.value && c.value.finished)}`)
    const again = await serverSearch(W.bodyOld)
    check('after the cancel the connection still works (a new server search finds it)', again.hits.length === 1, `${again.ms} ms`)
  }

  if (want('k5')) {
    // limit 3 -> 5 years: the old text becomes searchable; back to 3: not any more
    const setYears = async years => {
      const acc = (await ipc('accounts.list', [])).accounts.find(a => a.id === accountId)
      const t0 = Date.now()
      const res = await ipc('accounts.save', [{ ...acc, index_years: years, in_password: '', smtp_password: '' }])
      if (!res.ok) throw new Error(`accounts.save: ${JSON.stringify(res)}`)
      await syncedAfter(t0)
      return Date.now() - t0
    }
    let ms = await setYears(5)
    const found5 = await waitFor(async () => (await local(W.bodyOld)).length === 1, { timeout: 60_000 })
    check('limit 3 -> 5 years: the old text is found after the reindex', found5.value, `${ms} ms + ${found5.ms} ms`)
    ms = await setYears(3)
    const gone3 = await waitFor(async () => (await local(W.bodyOld)).length === 0, { timeout: 60_000 })
    check('back to 3 years (not opened): the text is not found again', gone3.value, `${ms} ms + ${gone3.ms} ms`)
    check('back to 3 years: the subject is still found', (await local(W.subjOld)).length === 1)

    // a message sent by SMTP shows up through IDLE within 30 s, no refresh
    await openInbox()
    await waitFor(async () => (await status()).live, { timeout: 30_000 })
    const idleSubject = `${RUN} IDLE próba`
    const tr = nodemailer.createTransport({ ...smtpOptions(accountForm(env, 'imap'), env.PASS), logger: false })
    const t0 = performance.now()
    await tr.sendMail({ from: env.EMAIL, to: env.EMAIL, subject: idleSubject, text: 'IDLE teszt' })
    tr.close()
    const sentMs = Math.round(performance.now() - t0)
    let seenMs = null
    try {
      await page.locator('.msg-row', { hasText: idleSubject }).waitFor({ timeout: 30_000 })
      seenMs = Math.round(performance.now() - t0)
    } catch {}
    check('a message sent to the account shows in the INBOX list via IDLE within 30 s, no refresh', seenMs !== null && seenMs <= 30_000, `SMTP ${sentMs} ms, in the list after ${seenMs} ms`)

    // read / deleted in another client -> the same here after the next sync
    const idleOnServer = (await serverFind('INBOX', idleSubject))[0]
    const k7last = (await serverFind('INBOX', `${RUN} ACT 26`))[0]
    {
      const lock = await S.getMailboxLock('INBOX')
      try {
        await S.messageFlagsAdd(String(idleOnServer.uid), ['\\Seen'], { uid: true })
        await S.messageDelete(String(k7last.uid), { uid: true })
      } finally {
        lock.release()
      }
    }
    const t1 = Date.now()
    await ipc('mail.sync', [accountId])
    await syncedAfter(t1)
    const idleRow = await findRow('INBOX', idleSubject)
    check('set read in the other client -> read here after the next sync', idleRow && (idleRow.flags || '').includes('\\Seen'), idleRow && idleRow.flags)
    check('deleted in the other client -> gone here', !(await findRow('INBOX', `${RUN} ACT 26`)))

    // network cut and back
    fs.writeFileSync(cutFlag, '1')
    const tc = Date.now()
    await ipc('mail.sync', [accountId])
    const errShown = await waitFor(async () => {
      const s = await status()
      return s.errorCode ? s : null
    }, { timeout: 90_000 })
    const barErr = await waitFor(async () => {
      const text = await page.locator('footer.status-bar').innerText().catch(() => '')
      return /nem fogadja a kapcsolatot|nincs hálózat|hiba/i.test(text) ? text : null
    }, { timeout: 30_000 })
    check('network cut: the error shows on the status line (UI)', errShown.value && barErr.value, `${errShown.ms} ms (IPC ${errShown.value && errShown.value.errorCode}), UI +${barErr.ms} ms: "${(barErr.value || '').replace(/\n/g, ' ').slice(0, 160)}"`)
    fs.rmSync(cutFlag)
    const back = await waitFor(async () => {
      const s = await status()
      const text = await page.locator('footer.status-bar').innerText().catch(() => '')
      return !s.errorCode && Date.parse(s.lastFinished) > tc && s.live && !/nem fogadja a kapcsolatot/.test(text) ? text : null
    }, { timeout: 180_000, step: 1000 })
    check('network back: the sync goes on by itself, the error disappears (UI too), IDLE live again', back.value, `${back.ms} ms after the cable was back: "${(back.value || '').replace(/\n/g, ' ').slice(0, 120)}"`)
  }

  if (want('k7')) {
    // the 25 messages the actions work on (01..25); 26 is the sync's "deleted in the other client" message
    const k7re = new RegExp(`^${RUN} ACT (0[1-9]|1\\d|2[0-5])$`)
    const isK7 = x => k7re.test(x.subject || '')
    const k7n = async folder => (await serverFind(folder, `${RUN} ACT`)).filter(isK7).length
    const rows = (await list('INBOX')).filter(isK7)
    const ids = rows.map(x => x.id)
    const subjects = rows.map(x => x.subject)
    check('25 messages to work on', ids.length === 25, String(ids.length))
    const flagsOf = async () => {
      const m = await serverFind('INBOX', `${RUN} ACT`)
      return subjects.map(s => m.find(x => x.subject === s)?.flags || null)
    }
    const run = async (action, sel, extra = {}) => {
      const res = await ipc('mail.action', [{ ids: sel, action, ...extra }])
      if (!res.ok) throw new Error(`${action}: ${JSON.stringify(res)}`)
      return res
    }
    await run('read', ids.slice(0, 1))
    let f = await flagsOf()
    check('read on 1: \\Seen on the server', f[0].includes('\\Seen') && !f[1].includes('\\Seen'))
    await run('read', ids)
    f = await flagsOf()
    check('read on 25: all \\Seen on the server', f.every(x => x && x.includes('\\Seen')))
    await run('unread', ids)
    f = await flagsOf()
    check('unread on 25: none \\Seen on the server', f.every(x => x && !x.includes('\\Seen')))
    await run('star', ids.slice(0, 1))
    f = await flagsOf()
    check('star on 1: \\Flagged on the server', f[0].includes('\\Flagged') && !f[1].includes('\\Flagged'))
    await run('star', ids)
    f = await flagsOf()
    check('star on 25', f.every(x => x && x.includes('\\Flagged')))
    await run('unstar', ids)
    f = await flagsOf()
    check('unstar on 25', f.every(x => x && !x.includes('\\Flagged')))
    await run('move', ids, { target: 'Junk' })
    let inJunk = await serverFind('Junk', `${RUN} ACT`)
    check('move 25 to Junk: on the server in Junk, gone from the INBOX', inJunk.filter(isK7).length === 25 && (await k7n('INBOX')) === 0, `${inJunk.filter(isK7).length}`)
    const t2 = Date.now()
    await ipc('mail.sync', [accountId])
    await syncedAfter(t2)
    const junkIds = (await list('Junk')).filter(isK7).map(x => x.id)
    await run('move', junkIds.slice(0, 1), { target: 'INBOX' })
    check('move 1 back to the INBOX', (await k7n('INBOX')) === 1)
    await run('move', junkIds.slice(1), { target: 'INBOX' })
    check('move 24 back', (await k7n('INBOX')) === 25 && (await k7n('Junk')) === 0)
    const t3 = Date.now()
    await ipc('mail.sync', [accountId])
    await syncedAfter(t3)
    const back = (await list('INBOX')).filter(isK7)
    await run('delete', back.slice(0, 1).map(x => x.id))
    check('delete 1: in the Trash on the server', (await k7n('Trash')) === 1 && (await k7n('INBOX')) === 24)
    await run('delete', back.slice(1, 6).map(x => x.id))
    check('delete 5 more: 6 in the Trash', (await k7n('Trash')) === 6)
    // the network cut during an action: back to the old state, error
    const victim = (await list('INBOX')).find(isK7)
    fs.writeFileSync(cutFlag, '1')
    await sleep(500)
    const res = await ipc('mail.action', [{ ids: [victim.id], action: 'star' }])
    const rowAfter = (await list('INBOX')).find(x => x.id === victim.id)
    fs.rmSync(cutFlag)
    check('network cut during an action: error, the row is not left flagged', !res.ok || res.error || !(rowAfter.flags || '').includes('\\Flagged'), `${JSON.stringify(res)} | flags "${rowAfter && rowAfter.flags}"`)
    const srv = (await serverFind('INBOX', victim.subject))[0]
    check('... and not flagged on the server either', srv && !srv.flags.includes('\\Flagged'))
    await waitFor(async () => !(await status()).errorCode && (await status()).live, { timeout: 180_000, step: 1000 })
  }

  if (want('k12')) {
    const top = `${RUN}-mappa`
    const create = await ipc('folders.create', [{ accountId, parent: null, name: top }])
    let sf = await serverFolders()
    check('create: the folder is on the server', create.ok && sf.some(x => x.path === create.path), `${JSON.stringify(create)}`)
    const sub = await ipc('folders.create', [{ accountId, parent: create.path, name: 'Alma' }])
    sf = await serverFolders()
    const subRow = sf.find(x => x.path === sub.path)
    check('subfolder with the server\'s delimiter (".")', sub.ok && subRow && sub.path === `${create.path}.Alma`, `${sub.path} delim ${subRow && subRow.delimiter}`)
    const ren = await ipc('folders.rename', [{ accountId, path: create.path, name: `${top}-uj` }])
    sf = await serverFolders()
    check('rename: the new name and its subfolder on the server, the old name gone', ren.ok && sf.some(x => x.path === `${top}-uj`) && sf.some(x => x.path === `${top}-uj.Alma`) && !sf.some(x => x.path === create.path), JSON.stringify(ren))
    const refused = await ipc('folders.remove', [{ accountId, path: `${top}-uj`, confirmed: true }])
    check('delete with a subfolder is refused', !refused.ok && refused.error === 'has_children', JSON.stringify(refused))
    const d1 = await ipc('folders.remove', [{ accountId, path: `${top}-uj.Alma`, confirmed: true }])
    const d2 = await ipc('folders.remove', [{ accountId, path: `${top}-uj`, confirmed: true }])
    sf = await serverFolders()
    check('delete: gone from the server', d1.ok && d2.ok && !sf.some(x => x.path.startsWith(top)), `${JSON.stringify(d1)} ${JSON.stringify(d2)}`)
    for (const role of ['INBOX', 'Sent', 'Drafts', 'Trash', 'Junk']) {
      const x = await ipc('folders.rename', [{ accountId, path: role, name: 'Valami' }])
      if (x.ok) check(`role folder ${role} cannot be renamed`, false)
    }
    check('the role folders cannot be renamed (IPC refuses)', true)
  }

  if (want('k6')) {
    const target = (await list('INBOX')).find(x => (x.subject || '').startsWith(`${RUN} ACT`) && !(x.flags || '').includes('\\Seen'))
    const opened = await ipc('mail.open', [target.id])
    const srv = (await serverFind('INBOX', target.subject))[0]
    check('opened -> read on the server too', opened.ok && !opened.message.seenError && srv.flags.includes('\\Seen'), `${opened.ok} ${srv && srv.flags}`)
    const o = await ipc('mail.open', [old.id])
    check('the 4 year old message opens', o.ok && /negy eves level/.test(o.message.text || o.message.html || ''))
    const f = await waitFor(async () => (await local(W.bodyOld)).length === 1, { timeout: 20_000 })
    check('after opening, its text is found by the local search', f.value, `${f.ms} ms`)
    await app.close()
    await launch()
    await syncedAfter(Date.now() - 1000).catch(() => {})
    check('... and after a restart too', (await local(W.bodyOld)).length === 1)
  }

  if (want('k8') || want('k9')) {
    await openInbox()
    // compose in the real composer window, To and Bcc = the account's own address
    const subject = `${RUN} Ékezetes tárgy: árvíztűrő tükörfúrógép`
    const [win] = await Promise.all([app.waitForEvent('window', { timeout: 15_000 }), page.getByRole('button', { name: 'Új levél', exact: true }).click()])
    await win.setViewportSize({ width: 900, height: 700 })
    await win.locator('.editor').waitFor()
    await win.waitForFunction(() => document.querySelector('#compose-from')?.textContent.trim())
    await win.locator('#compose-to').fill(env.EMAIL)
    await win.getByRole('button', { name: 'Másolat, titkos másolat…' }).click()
    await win.locator('#compose-bcc').fill(env.EMAIL)
    await win.locator('#compose-subject').fill(subject)
    await win.locator('.editor').click()
    await win.keyboard.press('Control+Home')
    await win.keyboard.type('Élő küldési próba, árvíztűrő tükörfúrógép.')
    await win.getByRole('button', { name: 'Melléklet…' }).click()
    await win.locator('.compose-attachments li').nth(1).waitFor()
    const ts = Date.now()
    await Promise.all([win.waitForEvent('close', { timeout: 60_000 }), win.getByRole('button', { name: 'Küldés', exact: true }).click()])
    console.log(`  send: window closed after ${Date.now() - ts} ms`)
    const arrived = await waitFor(async () => (await serverFind('INBOX', `${RUN} Ékezetes`)).length > 0 || null, { timeout: 90_000, step: 2000 })
    const inInbox = await serverFind('INBOX', `${RUN} Ékezetes`)
    check('the message to itself arrived (server INBOX)', arrived.value, `${arrived.ms} ms, ${inInbox.length} cop${inInbox.length === 1 ? 'y' : 'ies'}`)
    const raw = await serverSource('INBOX', inInbox[0].uid)
    const got = await simpleParser(raw)
    const atts = got.attachments.map(a => [a.filename, sha(a.content)])
    const wantAtts = [['szamla.pdf', sha(pdf)], [txtName, sha(fs.readFileSync(path.join(files, txtName)))]]
    check('attachments byte for byte (sha256)', JSON.stringify(atts) === JSON.stringify(wantAtts), JSON.stringify(atts))
    console.log(`  sha256 szamla.pdf ${wantAtts[0][1]}\n  sha256 ${txtName} ${wantAtts[1][1]}`)
    check('accented subject and sender name on the receiving side', got.subject === subject && got.from.value[0].name === 'ShadowMail Élő Teszt', `${got.subject} | ${got.from.text}`)
    const header = raw.toString('latin1').split(/\r?\n\r?\n/)[0]
    check('no Bcc header in the delivered message', !/^bcc:/im.test(header))
    const sentCopies = await serverFind('Sent', `${RUN} Ékezetes`)
    check('exactly one copy in Sent on the server', sentCopies.length === 1, String(sentCopies.length))
    const sentRaw = sentCopies.length ? (await serverSource('Sent', sentCopies[0].uid)).toString('latin1').split(/\r?\n\r?\n/)[0] : ''
    console.log(`  Sent copy keeps the Bcc header: ${/^bcc:/im.test(sentRaw) ? 'yes' : 'no'} (a product decision)`)

    // a draft saved twice -> one copy in Drafts
    const draftSubject = `${RUN} piszkozat`
    const [w2] = await Promise.all([app.waitForEvent('window', { timeout: 15_000 }), page.getByRole('button', { name: 'Új levél', exact: true }).click()])
    await w2.setViewportSize({ width: 900, height: 700 })
    await w2.locator('.editor').waitFor()
    await w2.waitForFunction(() => document.querySelector('#compose-from')?.textContent.trim())
    await w2.locator('#compose-to').fill(env.EMAIL)
    await w2.locator('#compose-subject').fill(draftSubject)
    await w2.locator('.hint[role="status"]').filter({ hasText: 'Piszkozat mentve' }).waitFor({ timeout: 75_000 })
    await w2.locator('#compose-subject').fill(`${draftSubject} javitva`)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.getTitle().startsWith('Új levél')).close())
    await w2.getByRole('alertdialog').waitFor()
    check('closing with unsaved changes asks first', /Bezárod a levelet/.test(await w2.getByRole('alertdialog').innerText()))
    await Promise.all([w2.waitForEvent('close', { timeout: 30_000 }), w2.getByRole('alertdialog').getByRole('button', { name: 'Mentés piszkozatként' }).click()])
    await sleep(1500)
    const drafts = await serverFind('Drafts', draftSubject)
    check('autosave + save on close: exactly one draft on the server, the latest', drafts.length === 1 && drafts[0].subject === `${draftSubject} javitva`, JSON.stringify(drafts.map(d => d.subject)))

    if (want('k9')) {
      const t4 = Date.now()
      await ipc('mail.sync', [accountId])
      await syncedAfter(t4)
      await page.locator('.msg-row', { hasText: `${RUN} Ékezetes` }).first().click({ timeout: 30_000 })
      await page.locator('.reader-tools').waitFor()
      const original = inInbox[0]
      // reply
      const [wr] = await Promise.all([app.waitForEvent('window', { timeout: 15_000 }), page.locator('.reader-tools').getByRole('button', { name: 'Válasz', exact: true }).click()])
      await wr.setViewportSize({ width: 900, height: 700 })
    await wr.locator('.editor').waitFor()
      await wr.waitForFunction(() => document.querySelector('#compose-from')?.textContent.trim())
      const replyTo = await wr.locator('#compose-to').inputValue()
      // replyRecipients drops the own address from a plain reply too, so a reply to an own message
      // starts with an empty To (open question for the planner); the user types the address then
      console.log(`  reply to an own message: To prefilled with "${replyTo}"`)
      check('reply: subject "Re: ..." prefilled', /^Re: /.test(await wr.locator('#compose-subject').inputValue()))
      if (!replyTo.trim()) await wr.locator('#compose-to').fill(env.EMAIL)
      await wr.locator('.editor').click()
      await wr.keyboard.press('Control+Home')
      await wr.keyboard.type('Élő válasz.')
      await Promise.all([wr.waitForEvent('close', { timeout: 60_000 }), wr.getByRole('button', { name: 'Küldés', exact: true }).click()])
      const rep = await waitFor(async () => (await serverFind('INBOX', `Re: ${RUN} Ékezetes`))[0] || null, { timeout: 90_000, step: 2000 })
      const repParsed = rep.value ? await simpleParser(await serverSource('INBOX', rep.value.uid)) : null
      check('reply arrived with In-Reply-To = the original Message-ID and References ending in it',
        repParsed && repParsed.inReplyTo === original.messageId && [].concat(repParsed.references || []).at(-1) === original.messageId,
        repParsed ? `${repParsed.inReplyTo} | ${repParsed.references}` : 'not arrived')
      const origFlags = (await serverFind('INBOX', `${RUN} Ékezetes`)).find(x => x.uid === original.uid)?.flags || []
      check('\\Answered on the original on the server', origFlags.includes('\\Answered'), origFlags.join(' '))
      const t5 = Date.now()
      await ipc('mail.sync', [accountId])
      await syncedAfter(t5)
      const repRow = await findRow('INBOX', `Re: ${RUN} Ékezetes`)
      const th = repRow ? await ipc('mail.thread', [repRow.id]) : null
      const origRow = (await list('INBOX')).find(x => x.subject === subject)
      const thIds = th && th.ok ? th.messages.map(m => m.id) : []
      check('the app\'s thread view (from the reply) has the original AND the reply', repRow && origRow && thIds.includes(repRow.id) && thIds.includes(origRow.id),
        th && th.ok ? JSON.stringify(th.messages.map(m => m.subject)) : JSON.stringify(th))
      // forward
      await page.locator('.msg-row', { hasText: `${RUN} Ékezetes` }).filter({ hasNotText: 'Re:' }).first().click()
      await page.locator('.reader-tools').waitFor()
      const [wf] = await Promise.all([app.waitForEvent('window', { timeout: 15_000 }), page.locator('.reader-tools').getByRole('button', { name: 'Továbbítás', exact: true }).click()])
      await wf.setViewportSize({ width: 900, height: 700 })
    await wf.locator('.editor').waitFor()
      await wf.waitForFunction(() => document.querySelector('#compose-from')?.textContent.trim())
      await wf.locator('.compose-attachments li').nth(1).waitFor({ timeout: 30_000 })
      await wf.locator('#compose-to').fill(env.EMAIL)
      await Promise.all([wf.waitForEvent('close', { timeout: 60_000 }), wf.getByRole('button', { name: 'Küldés', exact: true }).click()])
      const fw = await waitFor(async () => (await serverFind('INBOX', `Fwd: ${RUN} Ékezetes`))[0] || null, { timeout: 90_000, step: 2000 })
      const fwParsed = fw.value ? await simpleParser(await serverSource('INBOX', fw.value.uid)) : null
      const fwAtts = fwParsed ? fwParsed.attachments.map(a => [a.filename, sha(a.content)]) : []
      check('forward arrived with the original attachments byte for byte', JSON.stringify(fwAtts) === JSON.stringify(wantAtts), JSON.stringify(fwAtts))
      const origFlags2 = (await serverFind('INBOX', `${RUN} Ékezetes`)).find(x => x.uid === original.uid)?.flags || []
      check('$Forwarded on the original on the server', origFlags2.includes('$Forwarded'), origFlags2.join(' '))
    }
  }
} catch (err) {
  check('run', false, redact(err.stack))
} finally {
  if (fs.existsSync(cutFlag)) fs.rmSync(cutFlag)
  await app?.close().catch(() => {})
  await S.logout().catch(() => {})
  if (!values.keep) fs.rmSync(work, { recursive: true, force: true })
  else console.log(`data kept: ${work}`)
}
console.log(`run tag on the server: ${RUN}`)
process.exit(check.summary() ? 1 : 0)
