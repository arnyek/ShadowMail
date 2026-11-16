#!/usr/bin/env node
// no spell checking in the composer, and no dictionary download.
// Headless Electron + Playwright, not part of `npm test`.
//
//   node test/e2e/spellcheck-e2e.mjs
//
// The net-guard log only sees requests of the app's session; Chromium may fetch a spell-check
// dictionary through another network context. So Chromium's own NetLog (--log-net-log) records every
// request of the run, and the data folder is searched for downloaded dictionaries (*.bdic).
// Playwright: PW=<path of the playwright package> (default: the repo's playwright-core devDependency).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createVaultedDatabase } from '../../core/vault/vaulted-db.js'
import { AccountStore } from '../../core/accounts/model.js'
import { newAccountDefaults } from '../../core/accounts/defaults.js'
import { t, seedLanguage } from './lang.mjs'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const MASTER = 'Teszt-mesterjelszo-helyesiras'
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-spell-'))
const dataDir = path.join(work, 'data')
fs.mkdirSync(dataDir)
const netlog = path.join(work, 'netlog.json')
{
  const { db, vault } = await createVaultedDatabase(dataDir, MASTER) // vault.json + the encrypted mail.sqlite
  const store = new AccountStore(db, vault, { storeDir: path.join(dataDir, 'store') })
  // unreachable on purpose: no mail traffic in the NetLog, only what Chromium does by itself
  store.save({ ...newAccountDefaults('pop3'), name: 'Helyi', email: 'h@example.invalid', in_host: '127.0.0.1', in_port: 1, in_security: 'none', in_user: 'h', in_password: 'x', smtp_host: '127.0.0.1', smtp_port: 1, smtp_security: 'none' })
  db.close()
}
seedLanguage(dataDir)
const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]))
const app = await _electron.launch({
  executablePath: electronBin,
  args: [repo, '--ozone-platform=headless', '--disable-gpu', `--log-net-log=${netlog}`, '--net-log-capture-mode=Everything'],
  cwd: repo,
  env: { ...process.env, SHADOWMAIL_DATA: dataDir },
})
try {
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  const [win] = await Promise.all([app.waitForEvent('window', { timeout: 15_000 }), page.getByRole('button', { name: t.newMessage, exact: true }).click()])
  await win.setViewportSize({ width: 900, height: 700 })
  await win.locator('.editor').waitFor()
  await win.locator('.editor').click()
  await win.keyboard.type('Helyesirasi hibbbbak szandekosan: teszzt szoveeg ')
  const spell = await win.locator('.editor').evaluate(el => ({ attr: el.getAttribute('spellcheck'), prop: el.spellcheck }))
  check('the composer editor has spell checking off', spell.attr === 'false' && spell.prop === false, JSON.stringify(spell))
  const enabled = await app.evaluate(({ session }) => session.defaultSession.isSpellCheckerEnabled())
  check('the session\'s spell checker is off', enabled === false)
  await new Promise(r => setTimeout(r, 15_000)) // time for a dictionary download, if one starts
} catch (err) {
  check('run', false, err.stack)
} finally {
  await app.close().catch(() => {})
}
const log = fs.existsSync(netlog) ? fs.readFileSync(netlog, 'utf8') : ''
const urls = [...new Set([...log.matchAll(/"(?:url|original_url)":"([^"]+)"/g)].map(m => m[1]))].filter(u => !u.startsWith('mail-view:') && !u.startsWith('cid-img:') && !u.startsWith('file:') && !u.startsWith('data:') && !u.startsWith('devtools:'))
check('Chromium NetLog recorded the run', log.length > 1000, `${log.length} bytes`)
check('no dictionary download in the NetLog (gvt1 / dl.google.com / .bdic)', !/gvt1\.com|dl\.google\.com|\.bdic/i.test(log), JSON.stringify(urls.slice(0, 10)))
console.log(`  URLs in the NetLog: ${urls.length ? JSON.stringify(urls) : 'none'}`)
const bdic = walk(dataDir).filter(f => /\.bdic$/i.test(f) || /Dictionaries/i.test(f))
check('no dictionary file in the data folder', bdic.length === 0, JSON.stringify(bdic))
const guard = path.join(dataDir, 'electron', 'logs', 'net-guard.log')
const guardText = fs.existsSync(guard) ? fs.readFileSync(guard, 'utf8') : ''
check('net-guard log: no dictionary request', !/gvt1|dl\.google|bdic/i.test(guardText), guardText.trim().split('\n').slice(0, 5).join(' | ') || 'empty')
fs.rmSync(work, { recursive: true, force: true })
console.log(`\n${results.filter(Boolean).length} / ${results.length} OK`)
process.exit(results.every(Boolean) ? 0 : 1)
