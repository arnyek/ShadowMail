#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Big table messages in the real app (headless Electron + Playwright). Not part of `npm test`.
//
//   node test/e2e/parse-perf-e2e.mjs
//
// A POP3 account (fake POP3 server) with a 4 MB table message (4000 cells of 1000 characters), a 5.3 MB one (200 000
// cells of 10) and a short one. mailparser's HTML -> text used to take 3 s and 89 s on these, on the main process. Measured,
// with the main process pinged every 250 ms: the POP3 download (the unlock's first fetch), opening each big message, and
// its Reply (the shape check asks; answered with Cancel): the longest gap <= 500 ms each time; after an open the short
// message opens within 500 ms; the big messages get a non-empty preview (the worker's, later); no error in main.log.
// Playwright: PW=<path of the playwright package> (default: the repo's playwright-core devDependency).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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
const MASTER = 'Teszt-mesterjelszo-pm1'
const GAP_MS = 500
const sleep = ms => new Promise(r => setTimeout(r, ms))

const table = (cells, chars) => `<html><body><table>${Array.from({ length: cells }, () => `<tr><td>${'x'.repeat(chars)}</td></tr>`).join('')}</table></body></html>`
const message = (subject, minutes, type, body) =>
  Buffer.from(`From: Teszt <t@example.invalid>\r\nTo: m@example.invalid\r\nSubject: ${subject}\r\nDate: ${new Date(Date.now() - minutes * 60_000).toUTCString()}\r\nMessage-ID: <${subject}@example.invalid>\r\nMIME-Version: 1.0\r\nContent-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${body}`)
const BIG = [
  ['Tabla4M', table(4000, 1000)],
  ['Tabla5M', table(200_000, 10)],
]
const server = await new FakePop3Server().listen()
server.add(message('Rovid', 1, 'text/plain', 'Szia, holnap 10-kor jó?'))
BIG.forEach(([subject, html], i) => server.add(message(subject, 2 + i, 'text/html', html)))

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-pm1-e2e-'))
const dataDir = path.join(work, 'data')
fs.mkdirSync(dataDir)
seedLanguage(dataDir)
let pop
{
  const { db, vault } = await createVaultedDatabase(dataDir, MASTER)
  const store = new AccountStore(db, vault, { storeDir: path.join(dataDir, 'store') })
  const base = { smtp_host: '127.0.0.1', smtp_port: 1, smtp_security: 'none', in_security: 'none', in_host: '127.0.0.1' }
  pop = store.save({ ...newAccountDefaults('pop3'), ...base, name: 'POP3-fiók', email: 'p@example.invalid', in_port: server.port, in_user: server.user, in_password: server.pass }).account.id
  db.close()
}

const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
// the main process pinged every 250 ms; stop() -> the longest gap in ms
function pinger(app) {
  let longest = 0
  let last = performance.now()
  let on = true
  const loop = (async () => {
    while (on) {
      await app.evaluate(() => 1).catch(() => {})
      const now = performance.now()
      longest = Math.max(longest, now - last)
      last = now
      await sleep(250)
    }
  })()
  return { stop: async () => ((on = false), await loop, Math.round(longest)) }
}
const mainLog = path.join(dataDir, 'electron', 'logs', 'main.log')
const quits = () => server.log.filter(l => l === 'QUIT').length

const app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
try {
  // the shape check's question: recorded, answered with the last button (Cancel)
  await app.evaluate(({ dialog }) => {
    globalThis.__pm1 = { asked: 0 }
    dialog.showMessageBox = async (...args) => {
      const o = args[args.length - 1]
      globalThis.__pm1.asked++
      return { response: o.buttons.length - 1, checkboxChecked: false }
    }
  })
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1280, height: 900 })
  const list = () => page.evaluate(id => window.shadowMail.mail.list({ accountId: id, folder: 'INBOX', limit: 50 }), pop)
  const rows = async () => {
    const r = await list()
    return r.ok ? r.rows || r.messages || [] : []
  }

  // 1. the POP3 download: the unlock's first fetch takes the three messages, the main process keeps answering
  const ping = pinger(app)
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  const t0 = performance.now()
  while (quits() === 0 && performance.now() - t0 < 60_000) await sleep(100)
  // the bodies and the worker's previews: every row has one (or the time is up)
  let all = []
  for (const end = performance.now() + 30_000; performance.now() < end; await sleep(200)) {
    all = await rows()
    if (all.length === 3 && all.every(r => typeof r.preview === 'string' && r.preview.length)) break
  }
  const downloadGap = await ping.stop()
  check(`the POP3 download of the three messages: the main process's longest gap <= ${GAP_MS} ms`, quits() >= 1 && downloadGap <= GAP_MS, `${downloadGap} ms`)
  const bySubject = s => all.find(r => r.subject === s)
  for (const [subject] of BIG) {
    const r = bySubject(subject)
    check(`${subject}: a preview (the worker's), not empty`, r && typeof r.preview === 'string' && r.preview.startsWith('xxxx'), r ? JSON.stringify(String(r.preview).slice(0, 40)) : 'no row')
  }

  // 2. open each big message, then the short one; 3. its Reply: the question comes, nothing freezes
  const row = s => page.locator('.msg-row', { hasText: s })
  // the open message takes the list's place in the default layout: back to the list (Esc) when the row is hidden
  const openRow = async s => {
    if (!(await row(s).isVisible())) await page.keyboard.press('Escape')
    await row(s).click()
  }
  for (const [subject] of BIG) {
    const p1 = pinger(app)
    const t1 = performance.now()
    await openRow(subject)
    await page.locator('.reader-subject', { hasText: subject }).waitFor({ timeout: 30_000 })
    const openMs = Math.round(performance.now() - t1)
    const openGap = await p1.stop()
    check(`${subject}: open, the main process's longest gap <= ${GAP_MS} ms`, openGap <= GAP_MS, `gap ${openGap} ms, shown after ${openMs} ms`)
    const t2 = performance.now()
    await openRow('Rovid')
    await page.locator('.reader-subject', { hasText: 'Rovid' }).waitFor({ timeout: 10_000 })
    const nextMs = Math.round(performance.now() - t2)
    check(`${subject}: after it the short message opens within 500 ms`, nextMs <= 500, `${nextMs} ms`)

    await openRow(subject)
    await page.locator('.reader-subject', { hasText: subject }).waitFor({ timeout: 30_000 })
    const before = await app.evaluate(() => globalThis.__pm1.asked)
    const p2 = pinger(app)
    const t3 = performance.now()
    await page.locator('.reader-tools').getByRole('button', { name: t.replyModes.reply, exact: true }).click()
    let askMs = null
    for (const end = performance.now() + 15_000; performance.now() < end; await sleep(50)) {
      if ((await app.evaluate(() => globalThis.__pm1.asked)) > before) {
        askMs = Math.round(performance.now() - t3)
        break
      }
    }
    const replyGap = await p2.stop()
    check(`${subject}: Reply, the shape check's question, the main process's longest gap <= ${GAP_MS} ms`, askMs !== null && replyGap <= GAP_MS, `question after ${askMs} ms, gap ${replyGap} ms`)
  }

  check('no command error and no failure in main.log', !fs.readFileSync(mainLog, 'utf8').split('\n').some(l => /(failed|error)/i.test(l) && !/no password|connection_refused/.test(l)))
} catch (err) {
  check('run', false, err.stack)
} finally {
  await app.close().catch(() => {})
  await server.close()
  fs.rmSync(work, { recursive: true, force: true })
}
console.log(`\n${results.filter(Boolean).length} / ${results.length} OK`)
process.exit(results.every(Boolean) ? 0 : 1)
