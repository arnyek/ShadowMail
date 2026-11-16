#!/usr/bin/env node
// The message source in the real app: mail:source and mail:saveSource on a POP3 message (fake POP3 server; the
// IMAP \Seen point is in test/raw-view.test.js: there is no TCP IMAP test server). Not part of `npm test`.
//
//   node test/e2e/source-e2e.mjs
//
// Measures: the source of a POP3 message has its X-EsetId: line (the stored .eml keeps it); the summary is the
// message's; mail:saveSource writes the whole message, byte for byte the downloaded one, as a_b_c_.eml for the subject
// "a/b:c?"; the main.log has no subject, sender or Message-ID of it; no console problem; the net-guard log is empty.
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
const MASTER = 'Teszt-mesterjelszo-H1'
const USER = 'h1@example.invalid'
const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}

const RAW = Buffer.from(
  `Return-Path: <titok-felado-h1@example.invalid>\r\nX-EsetId: 37303A29C9D8F3A1B2C3D4\r\nFrom: Titok Felado <titok-felado-h1@example.invalid>\r\nTo: ${USER}\r\n` +
    `Subject: a/b:c?\r\nMessage-ID: <titok-mid-h1@example.invalid>\r\nDate: ${new Date().toUTCString()}\r\n` +
    'Authentication-Results: mx.example.invalid; spf=pass smtp.mailfrom=example.invalid; dkim=none; dmarc=fail\r\n' +
    'MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\nÁrvíztűrő titkos szöveg H1\r\n',
)
const pop = await new FakePop3Server().listen()
pop.add(RAW)
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-h1-e2e-'))
const dataDir = path.join(work, 'data')
const saveTo = path.join(work, 'saved')
fs.mkdirSync(dataDir)
seedLanguage(dataDir)
fs.mkdirSync(saveTo)
{
  const { db, vault } = await createVaultedDatabase(dataDir, MASTER)
  const store = new AccountStore(db, vault, { storeDir: path.join(dataDir, 'store') })
  store.save({ ...newAccountDefaults('pop3'), name: 'POP3-fiók', email: USER, in_host: '127.0.0.1', in_port: pop.port, in_security: 'none', in_user: pop.user, in_password: pop.pass, smtp_host: '127.0.0.1', smtp_port: 1, smtp_security: 'none' })
  db.close()
}

const consoleProblems = []
const app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
try {
  await app.evaluate(({ dialog }, dir) => {
    globalThis.__saved = []
    dialog.showSaveDialog = async (...args) => {
      const opts = args[args.length - 1]
      globalThis.__saved.push(opts.defaultPath)
      return { canceled: false, filePath: `${dir}/${opts.defaultPath}` }
    }
  }, saveTo)
  const page = await app.firstWindow()
  page.on('console', m => (m.type() === 'error' || m.type() === 'warning') && consoleProblems.push(m.text()))
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  await page.locator('.msg-row[data-id]').first().waitFor({ timeout: 30_000 })
  const id = Number(await page.locator('.msg-row[data-id]').first().getAttribute('data-id'))

  const v = await page.evaluate(i => window.shadowMail.mail.source(i), id)
  check('mail:source answers', v.ok === true, v.error || '')
  check('the POP3 source has its X-EsetId: line (the stored .eml keeps it)', v.headers.includes('X-EsetId: 37303A29C9D8F3A1B2C3D4') && v.text.includes('X-EsetId:'))
  check('the text is the whole message, UTF-8', v.text.includes('Árvíztűrő titkos szöveg H1') && v.size === RAW.length && v.truncated === false, `${v.size} / ${RAW.length}`)
  check('the summary: sender, subject, Message-ID, SPF/DKIM/DMARC as the server wrote', /titok-felado-h1@example\.invalid/.test(v.summary.from) && v.summary.subject === 'a/b:c?' && v.summary.messageId === '<titok-mid-h1@example.invalid>' && JSON.stringify(v.summary.auth) === '{"by":"mx.example.invalid","spf":"pass","dkim":"none","dmarc":"fail"}', JSON.stringify(v.summary))

  const s = await page.evaluate(i => window.shadowMail.mail.saveSource(i), id)
  const names = await app.evaluate(() => globalThis.__saved)
  const file = path.join(saveTo, 'a_b_c_.eml')
  check('mail:saveSource: the file name a_b_c_.eml for "a/b:c?"', s.ok && s.saved && names[0] === 'a_b_c_.eml', JSON.stringify(names))
  check('mail:saveSource: the whole message, byte for byte the downloaded one', fs.existsSync(file) && Buffer.compare(fs.readFileSync(file), RAW) === 0)
  const bad = await page.evaluate(() => window.shadowMail.mail.source(-1))
  check('a bad id: bad_request', bad.ok === false && bad.error === 'bad_request')

  const log = fs.readFileSync(path.join(dataDir, 'electron', 'logs', 'main.log'), 'utf8')
  const leaked = ['a/b:c?', 'titok-felado-h1', 'titok-mid-h1', 'Árvíztűrő titkos', '37303A29C9D8'].filter(w => log.includes(w))
  check('main.log: no subject, sender, Message-ID or text of it', leaked.length === 0, leaked.join(','))
  check('main.log: the view and the save logged with the id and size only', /source view: message \d+, \d+ bytes/.test(log) && /source saved: message \d+, \d+ bytes/.test(log))
  check('no console error or warning in the renderer', consoleProblems.length === 0, consoleProblems.join(' | '))
  const netLog = path.join(dataDir, 'electron', 'logs', 'net-guard.log')
  check('the net-guard log has no outgoing request', !fs.existsSync(netLog) || fs.readFileSync(netLog, 'utf8').trim() === '')
} catch (err) {
  check('the run', false, err.stack)
} finally {
  await app.close().catch(() => {})
  await pop.close?.()
  fs.rmSync(work, { recursive: true, force: true })
}
const ok = results.filter(Boolean).length
console.log(`${ok} / ${results.length} ${ok === results.length ? 'OK' : 'FAIL'}`)
process.exit(ok === results.length ? 0 : 1)
