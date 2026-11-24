#!/usr/bin/env node
// Files Claude attaches to a draft, in the real app: the MCP draft tools' "attachments" through the connector, decided
// in the app's confirmation Modal. One POP3 account on a fake POP3 server (one of its messages has a PDF attachment),
// the SMTP side a local smtp-server. Not part of `npm test`; about a minute.
//
//   E2E_LANG=hu|en node test/e2e/mcp-attach-e2e.mjs [--shots <folder>]
//
// Measures: create_draft with two local files (one with an accented name) and a message's attachment -> the
// create-draft Modal names every file with its FULL path (or the message) and its size and hash; rejected -> no draft;
// approved (with a 260+ character path too) -> the draft; in the Modal the long path wraps inside it and the file name
// stays whole on its own line; send_draft of that draft -> every attachment goes out byte for byte (SHA-256);
// update_draft adds a file to a draft holding one (the Modal, the old one stays); a relative path is refused without a
// Modal; the main.log has no file name, path or subject; no console problem; the net-guard log is empty.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
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

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const sha = b => crypto.createHash('sha256').update(b).digest('hex')
const MASTER = 'Teszt-mesterjelszo-ATT'
const USER = 'att@example.invalid'
const SMTP_PASSWORD = 'jo-smtp-jelszo-ATT'
// words that must never reach the main.log (file names, folder names, subjects of this run)
const SECRET_WORDS = ['ajánlat', 'ajanlat', 'jegyzet-88', 'Ugyfelmappa-88', 'Csatolt-targy-88', 'Frissitett-88', 'szamla-88']

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

// the message whose attachment Claude takes: a small PDF, by its number in read_message's list
const PDF = Buffer.from('%PDF-1.4\n% szamla-88 teszt\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n')
const pop = await new FakePop3Server().listen()
const now = new Date().toUTCString()
pop.add(Buffer.from(`From: Feladó Ferenc <ferenc@example.invalid>\r\nTo: ${USER}\r\nSubject: Sima levél\r\nMessage-ID: <att-0@example.invalid>\r\nDate: ${now}\r\n\r\nszöveg\r\n`))
pop.add(
  Buffer.from(
    `From: Feladó Ferenc <ferenc@example.invalid>\r\nTo: ${USER}\r\nSubject: Mellékletes levél\r\nMessage-ID: <att-1@example.invalid>\r\nDate: ${now}\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="b1"\r\n\r\n--b1\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nA számla mellékelve.\r\n--b1\r\nContent-Type: application/pdf; name="szamla-88.pdf"\r\nContent-Disposition: attachment; filename="szamla-88.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n${PDF.toString('base64')}\r\n--b1--\r\n`,
  ),
)

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-att-e2e-'))
const dataDir = path.join(work, 'data')
fs.mkdirSync(dataDir)
// the user's files, outside the data folder: an accented name, a plain one, and one under a 260+ character path
const files = path.join(work, 'Ugyfelmappa-88')
fs.mkdirSync(files)
const A = path.join(files, 'ajánlat é.pdf')
fs.writeFileSync(A, Buffer.from('%PDF-1.4 ajánlat tartalma'))
const B = path.join(files, 'jegyzet-88.txt')
fs.writeFileSync(B, 'első sor\nmásodik sor\n')
const deep = path.join(files, ...Array.from({ length: 4 }, (_, i) => `nagyon-hosszu-mappanev-${i}-${'x'.repeat(40)}`))
fs.mkdirSync(deep, { recursive: true })
const LONG = path.join(deep, `hosszu-nevu-ajanlat-${'y'.repeat(30)}.pdf`)
fs.writeFileSync(LONG, Buffer.from('%PDF-1.4 hosszu'))
const real = p => fs.realpathSync(p)

let accountId
{
  const { db, vault } = await createVaultedDatabase(dataDir, MASTER)
  const store = new AccountStore(db, vault, { storeDir: path.join(dataDir, 'store') })
  accountId = store.save({
    ...newAccountDefaults('pop3'), name: 'POP3-fiók', email: USER, display_name: 'Mérő Márta', in_host: '127.0.0.1', in_port: pop.port, in_security: 'none', in_user: pop.user, in_password: pop.pass,
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
const c = connector()
const mainLog = path.join(dataDir, 'electron', 'logs', 'main.log')
const logText = () => (fs.existsSync(mainLog) ? fs.readFileSync(mainLog, 'utf8') : '')
try {
  const page = await app.firstWindow()
  page.on('console', m => (m.type() === 'error' || m.type() === 'warning') && consoleProblems.push(m.text()))
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  await page.locator('.msg-row[data-id]').nth(1).waitFor({ timeout: 30_000 })
  await page.evaluate(() => window.shadowMail.mcp.setEnabled(true))
  await c.init()

  const ct = t.claudeConfirm
  const modal = page.locator('.claude-confirm-modal')
  const reject = modal.locator('.confirm-reject')
  const approve = modal.locator('.confirm-approve')
  const waitModal = kind => page.locator(`.claude-confirm[data-kind="${kind}"] .claude-confirm-modal`).waitFor({ timeout: 20_000 })
  const gone = () => page.locator('.claude-confirm').waitFor({ state: 'detached', timeout: 20_000 }).then(() => true, () => false)
  const approveWhenReady = async () => {
    await page.waitForFunction(() => document.querySelector('.confirm-approve') && !document.querySelector('.confirm-approve').disabled, null, { timeout: 5000 })
    await approve.click()
  }
  const list = folder => page.evaluate(([a, f]) => window.shadowMail.mail.list({ accountId: a, folder: f, limit: 200 }), [accountId, folder])
  const inboxRows = (await list('INBOX')).rows
  const withPdf = inboxRows.find(r => r.subject === 'Mellékletes levél')
  check('the message with the PDF is in the index', Boolean(withPdf), inboxRows.map(r => r.subject).join(','))
  const read = await c.tool('read_message', { message_id: withPdf.id })
  check('read_message lists its attachment as number 1', read && /szamla-88\.pdf/.test(read.content[0].text), read && read.content[0].text.slice(-200))

  // --- create_draft with two local files and the message's attachment: the Modal; rejected -> no draft ------------
  const items = [{ path: A }, { path: B }, { message_id: withPdf.id, attachment: 1 }]
  const draftArgs = { account_id: accountId, to: 'cimzett-88@example.invalid', subject: 'Csatolt-targy-88', text: 'Küldöm a fájlokat.' }
  let call = c.tool('create_draft', { ...draftArgs, attachments: items })
  await waitModal('createDraft')
  const shown = await modal.innerText()
  check('create_draft: the create-draft Modal with its title and the header', shown.includes(ct.titles.createDraft) && shown.includes(ct.header))
  check('the Modal: every file\'s name, the FULL real path, the message and its attachment', [path.basename(A), real(A), path.basename(B), real(B), ct.claudeFileFromMessage('Mellékletes levél', 'szamla-88.pdf')].every(x => shown.includes(x)), shown.slice(0, 600))
  check('the Modal: each size and the first 12 digits of each SHA-256', [[fs.readFileSync(A)], [fs.readFileSync(B)], [PDF]].every(([b]) => shown.includes(`${t.sizeKb(b.length)} · SHA-256 ${sha(b).slice(0, 12)}`)))
  check('the Modal: the envelope, the text, nothing sent', ['cimzett-88@example.invalid', 'Csatolt-targy-88', 'Küldöm a fájlokat.', ct.draftNotSent].every(x => shown.includes(x)))
  await reject.click()
  const r1 = await call
  check('rejected: an error, no draft', r1 && r1.isError && r1._meta['shadowmail/data'].error === 'rejected' && !(await list('Drafts')).rows.some(r => r.subject === 'Csatolt-targy-88'), JSON.stringify(r1 && r1._meta['shadowmail/data']))
  check('the Modal went', await gone())

  // --- again with the 260+ character path: the layout; approved -> the draft -----------------------------------------
  check('the long path is 260+ characters', real(LONG).length >= 260, `${real(LONG).length}`)
  call = c.tool('create_draft', { ...draftArgs, attachments: [...items, { path: LONG }] })
  await waitModal('createDraft')
  const layout = await page.evaluate(longPath => {
    const box = document.querySelector('.claude-confirm-modal')
    const li = [...document.querySelectorAll('.confirm-claude-file')].find(x => x.querySelector('.confirm-file-source').textContent === longPath)
    if (!li) return null
    const name = li.querySelector('.confirm-file-name')
    const src = li.querySelector('.confirm-file-source')
    const b = box.getBoundingClientRect()
    const n = name.getBoundingClientRect()
    const s = src.getBoundingClientRect()
    const line = parseFloat(getComputedStyle(src).lineHeight) || 16
    return {
      nameWhole: name.scrollWidth <= name.clientWidth + 1 && n.left >= b.left - 1 && n.right <= b.right + 1,
      nameOwnLine: n.bottom <= s.top + 1,
      pathWraps: s.height > line * 1.5 && src.scrollWidth <= src.clientWidth + 1 && s.right <= b.right + 1,
      noSideScroll: [...box.querySelectorAll('*')].every(el => el.scrollWidth <= el.clientWidth + 1 || getComputedStyle(el).overflowX !== 'visible'),
      pathText: src.textContent,
    }
  }, real(LONG))
  check('the long path: the file name whole, on its own line above the path', layout && layout.nameWhole && layout.nameOwnLine, JSON.stringify(layout))
  check('the long path wraps inside the Modal, all of it shown, no side scroll', layout && layout.pathWraps && layout.noSideScroll && layout.pathText === real(LONG))
  const shotsAt = process.argv.indexOf('--shots')
  if (shotsAt > 0) {
    fs.mkdirSync(process.argv[shotsAt + 1], { recursive: true })
    await page.screenshot({ path: path.join(process.argv[shotsAt + 1], `claude-attach-${process.env.E2E_LANG || 'hu'}.png`) })
  }
  await approveWhenReady()
  const r2 = await call
  check('approved: the draft saved, NOT sent', r2 && !r2.isError && r2._meta['shadowmail/data'].status === 'approved' && received.length === 0, JSON.stringify(r2 && r2._meta['shadowmail/data']))
  const draft = (await list('Drafts')).rows.find(r => r.subject === 'Csatolt-targy-88')
  check('the draft is in Drafts', Boolean(draft))

  // --- send_draft: the four attachments go out byte for byte ------------------------------------------------------
  call = c.tool('send_draft', { draft_id: draft.id })
  await waitModal('send')
  const sendShown = await modal.innerText()
  check('send_draft: the send Modal lists the four attachments', [path.basename(A), path.basename(B), 'szamla-88.pdf', path.basename(LONG)].every(x => sendShown.includes(x)))
  await approveWhenReady()
  const r3 = await call
  for (let i = 0; i < 50 && !received.length; i++) await sleep(100)
  const out = received[0] ? await simpleParser(received[0].raw) : null
  const want = [[path.basename(A), sha(fs.readFileSync(A))], [path.basename(B), sha(fs.readFileSync(B))], ['szamla-88.pdf', sha(PDF)], [path.basename(LONG), sha(fs.readFileSync(LONG))]]
  const got = out ? out.attachments.map(x => [x.filename, sha(x.content)]) : []
  check('sent: the four attachments byte for byte (SHA-256), in order', r3 && !r3.isError && JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got))

  // --- update_draft adds a file to a draft holding one ------------------------------------------------------------
  // (with a text: send_draft refuses a draft with no visible text, draft_too_complex)
  call = c.tool('create_draft', { account_id: accountId, to: 'cimzett-88@example.invalid', subject: 'Frissitett-88', text: 'Második piszkozat.', attachments: [{ path: A }] })
  await waitModal('createDraft')
  await approveWhenReady()
  await call
  const second = (await list('Drafts')).rows.find(r => r.subject === 'Frissitett-88')
  call = c.tool('update_draft', { draft_id: second.id, attachments: [{ path: B }] })
  await waitModal('updateDraft')
  const upShown = await modal.innerText()
  check('update_draft with a file: the Modal (its switch is OFF by default), the new file with its path', upShown.includes(real(B)) && !upShown.includes(real(A)))
  await approveWhenReady()
  const r4 = await call
  check('update_draft approved', r4 && !r4.isError && r4._meta['shadowmail/data'].status === 'approved', JSON.stringify(r4 && r4._meta['shadowmail/data']))
  // a local (POP3) draft is saved in its own row
  const updated = (await list('Drafts')).rows.filter(r => r.subject === 'Frissitett-88')
  check('the updated draft is one row', updated.length === 1, JSON.stringify(updated.map(r => r.id)))
  call = c.tool('send_draft', { draft_id: updated[0].id })
  await waitModal('send')
  await approveWhenReady()
  await call
  for (let i = 0; i < 50 && received.length < 2; i++) await sleep(100)
  const out2 = received[1] ? await simpleParser(received[1].raw) : null
  check('update_draft approved: the old file stays, the new one added (sent byte for byte)', r4 && !r4.isError && out2 && JSON.stringify(out2.attachments.map(x => [x.filename, sha(x.content)])) === JSON.stringify([[path.basename(A), sha(fs.readFileSync(A))], [path.basename(B), sha(fs.readFileSync(B))]]))

  // --- refused before any Modal ------------------------------------------------------------------------------------
  const bad = await c.tool('create_draft', { ...draftArgs, subject: 'Rossz-88', attachments: [{ path: 'relativ.txt' }] }, 10_000)
  await sleep(300)
  check('a relative path: bad_path, no Modal, no draft', bad && bad.isError && bad._meta['shadowmail/data'].error === 'bad_path' && (await page.locator('.claude-confirm').count()) === 0 && !(await list('Drafts')).rows.some(r => r.subject === 'Rossz-88'))

  const log = logText()
  const leaked = SECRET_WORDS.filter(w => log.includes(w))
  // (the data folder's own path may be logged; the user's files lie in another folder)
  check('main.log: no file name, folder or subject of the run', leaked.length === 0 && !log.includes(files), leaked.join(','))
  check('main.log: the decisions are logged without content', /mcp confirm tool=create_draft result=approved items=1/.test(log) && /mcp confirm tool=create_draft result=rejected items=1/.test(log) && /mcp confirm tool=update_draft result=approved items=1/.test(log))
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
const ok = results.filter(Boolean).length
console.log(`${ok} / ${results.length} ${ok === results.length ? 'OK' : 'FAIL'}`)
process.exit(ok === results.length ? 0 : 1)
