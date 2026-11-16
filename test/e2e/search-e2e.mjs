#!/usr/bin/env node
// Global search in the real app, headless Electron + Playwright. Not part of `npm test`.
//
//   node test/e2e/search-e2e.mjs [--shot <file.png>]
//
// Data: an IMAP account (unreachable on purpose: 127.0.0.1:1, the index is written directly) and a
// POP3 account on the TCP fake POP3 server, with old (beyond the limit, never opened) .eml files in
// data/store and 2000 more of them for the progress / cancel check. Nothing leaves the machine.
// Measures: the search starts ~300 ms after typing, accents optional, the account filter, the
// highlighted snippet, opening a hit in the reader, the scope buttons, the POP3 old-text button
// (badge, no duplicates, progress, cancel), the server button's error without a server, Esc.
// Playwright: PW=<path of the playwright package> (default: the repo's playwright-core devDependency).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { FakePop3Server } from '../helpers/fake-pop3.js'
import { MailIndex } from '../../core/db/mail-index.js'
import { createVaultedDatabase, openSealedStore } from '../../core/vault/vaulted-db.js'
import { AccountStore } from '../../core/accounts/model.js'
import { newAccountDefaults } from '../../core/accounts/defaults.js'
import { t, locale, seedLanguage } from './lang.mjs'

const { values } = parseArgs({ options: { shot: { type: 'string' } } })
const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const MASTER = 'Teszt-mesterjelszo-kereses'
const DAY = 86_400_000
const now = Date.now()
const OLD_FILES = 2000

const server = await new FakePop3Server().listen()
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-k11-e2e-'))
const dataDir = path.join(work, 'data')
fs.mkdirSync(dataDir)
seedLanguage(dataDir)
const ids = {}
{
  const { db, vault } = await createVaultedDatabase(dataDir, MASTER) // vault.json + the encrypted mail.sqlite
  const store = new AccountStore(db, vault, { storeDir: path.join(dataDir, 'store') })
  const sealed = openSealedStore(vault, dataDir)
  const base = { smtp_host: '127.0.0.1', smtp_port: 1, smtp_security: 'none', in_security: 'none', in_host: '127.0.0.1' }
  const imap = store.save({ ...newAccountDefaults('imap'), ...base, name: 'IMAP-fiók', email: 'i@example.invalid', in_port: 1, in_user: 'i', in_password: 'nem-valodi' }).account
  const pop = store.save({ ...newAccountDefaults('pop3'), ...base, name: 'POP3-fiók', email: 'p@example.invalid', in_port: server.port, in_user: server.user, in_password: server.pass }).account
  const index = new MailIndex(db)
  index.upsertFolder({ account_id: imap.id, path: 'INBOX', uidvalidity: '1', synced_at: now })
  index.ensureLocalFolders(pop.id, [{ path: 'INBOX' }])
  const row = (account, extra) => ({
    account_id: account.id, folder: 'INBOX', uid: null, pop3_uidl: null, message_id: null, in_reply_to: null, refs: null,
    from_addr: 'felado@example.invalid', from_name: 'Feladó', to_addrs: 'en@example.invalid', cc_addrs: '', flags: '\\Seen',
    size: 100, has_attachments: 0, attachments: null, body_state: 0, sender_text: 'Feladó <felado@example.invalid>', recipients_text: 'en@example.invalid', ...extra,
  })
  const put = (r, body, file) => {
    index.insertMany([r])
    const got = r.uid ? index.getByUid(r.account_id, 'INBOX', r.uid) : index.getByUidl(r.account_id, r.pop3_uidl)
    if (body) index.setBodies([{ id: got.id, text: body, state: 1, preview: body.slice(0, 200) }])
    if (file) {
      sealed.write(file.rel, file.source) // sealed, as the app writes it
      index.setStorePath(got.id, file.rel)
    }
    return got.id
  }
  ids.imapHit = put(row(imap, { uid: 1, subject: 'IMAP ajánlat', date: now - 2 * DAY, idate: now - 2 * DAY }), 'A hőszivattyú karbantartásáról szól.')
  ids.imapOther = put(row(imap, { uid: 2, subject: 'IMAP más', date: now - 3 * DAY, idate: now - 3 * DAY }), 'Semmi köze.')
  // an old IMAP row (beyond the limit): only the server could search its text
  put(row(imap, { uid: 3, subject: 'IMAP régi', date: now - 4 * 365 * DAY, idate: now - 4 * 365 * DAY, body_state: 3 }))
  const eml = (subject, body, date) =>
    `From: Régi Feladó <regi@example.invalid>\r\nTo: p@example.invalid\r\nSubject: ${subject}\r\nDate: ${new Date(date).toUTCString()}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${body}\r\n`
  ids.popRecent = put(row(pop, { pop3_uidl: 'r1', subject: 'POP3 friss', date: now - DAY, idate: now - DAY }), 'Új hőszivattyú ajánlat.',
    { rel: `${pop.id}/r1.eml`, source: eml('POP3 friss', 'Új hőszivattyú ajánlat.', now - DAY) })
  ids.popOld = put(row(pop, { pop3_uidl: 'o1', subject: 'POP3 régi', date: now - 5 * 365 * DAY, idate: now - 5 * 365 * DAY, body_state: 3 }), null,
    { rel: `${pop.id}/o1.eml`, source: eml('POP3 régi', 'A régi hőszivattyú garanciajegye és a kéménytisztítás.', now - 5 * 365 * DAY) })
  for (let i = 0; i < OLD_FILES; i++) {
    const d = now - 6 * 365 * DAY - i * DAY
    put(row(pop, { pop3_uidl: `x${i}`, subject: `Archív ${i}`, date: d, idate: d, body_state: 3 }), null,
      { rel: `${pop.id}/x${i}.eml`, source: eml(`Archív ${i}`, `tömeges régi levél ${i} macskakörmös`, d) })
  }
  db.close()
}

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// the old-text job's progress line, its numbers as patterns: "<done> / 2000-2009 messages" (2 000 / 2,000 by locale)
const progressRe = done => {
  const text = esc(t.searchPop3Progress({ done: 7, total: 2001 }))
  return text.replace(esc((7).toLocaleString(locale)), done).replace(esc((2001).toLocaleString(locale)), '2[\\s,]?00\\d')
}
// the word of the result count ("találat" / "result")
const countWord = t.searchCount(1, false).replace(/^1\s/, '')

const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
try {
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  await page.locator('.folder-tree .folder').first().waitFor()
  const box = page.getByRole('searchbox', { name: t.searchLabel })
  const subjects = () => page.locator('.result .result-subject').allInnerTexts()

  // the search starts after ~300 ms; accent-free query, both accounts
  const t0 = Date.now()
  await box.fill('hoszivattyu')
  await page.locator('.result').first().waitFor()
  const waited = Date.now() - t0
  const both = (await subjects()).sort()
  check('accent-free query finds both accounts (IMAP + recent POP3), not the old ones', JSON.stringify(both) === JSON.stringify(['IMAP ajánlat', 'POP3 friss']), JSON.stringify(both))
  check('results appear after the 300 ms delay', waited >= 300, `${waited} ms`)
  check('highlighted snippet', (await page.locator('.result-snippet mark').count()) >= 1, await page.locator('.result-snippet').first().innerText())
  check('header-only line under the list', (await page.locator('.search-footer').innerText()).includes(t.searchHeadersOnly(OLD_FILES + 2)))
  check('both buttons for the two-account scope', (await page.getByRole('button', { name: t.searchOnServer, exact: true }).count()) === 1 && (await page.getByRole('button', { name: t.searchInOld, exact: true }).count()) === 1)

  // account filter: POP3 only -> no server button
  // the filters are chips; the account chip is a menu
  const accountChip = page.locator('.search-chips').getByRole('button', { name: new RegExp(`^${esc(t.searchFilter.account)}`) })
  const pickAccount = async name => {
    await accountChip.click()
    await page.getByRole('menuitemradio', { name, exact: true }).click()
  }
  check('the chips are there while searching', (await page.locator('.search-chips').count()) === 1)
  await pickAccount('POP3-fiók')
  check('active chip: check mark and the chosen account', (await accountChip.getAttribute('aria-pressed')) === 'true' && (await accountChip.innerText()).includes('POP3-fiók') && (await accountChip.locator('[data-icon="check"]').count()) === 1)
  await page.waitForFunction(() => document.querySelectorAll('.result').length === 1)
  check('account filter: only the POP3 hit', JSON.stringify(await subjects()) === JSON.stringify(['POP3 friss']))
  check('POP3 scope: no server button', (await page.getByRole('button', { name: t.searchOnServer, exact: true }).count()) === 0)

  // the POP3 old-text button: the old message with a badge, the recent one not repeated
  await page.getByRole('button', { name: t.searchInOld, exact: true }).click()
  await page.locator('.result[data-source="pop3Old"]').first().waitFor({ timeout: 20000 })
  await page.locator('.search-job.done[data-source="pop3Old"]').waitFor({ timeout: 30000 })
  const afterOld = await subjects()
  check('old POP3 message found by the button, marked, no duplicate', JSON.stringify(afterOld) === JSON.stringify(['POP3 friss', 'POP3 régi']) && (await page.locator('.result[data-source="pop3Old"] .badge').innerText()) === t.searchFoundInOld, JSON.stringify(afterOld))

  // open a hit: the reader shows it
  await page.locator('.result', { hasText: 'POP3 régi' }).locator('.result-open').click()
  await page.locator(`.reader[data-message-id="${ids.popOld}"]`).waitFor()
  check('a hit opens in the reader', (await page.locator('.reader .mail-text').innerText()).includes('garanciajegye'))

  // progress and cancel over the 2000 archive files
  await box.fill('macskakormos')
  await page.waitForFunction(word => document.querySelector('.search-footer') && document.querySelector('.search-footer').innerText.includes(word), countWord)
  await page.getByRole('button', { name: t.searchInOld, exact: true }).click()
  await page.locator('.search-job[data-source="pop3Old"]:not(.done)').waitFor()
  await page.waitForFunction(src => new RegExp(src).test(document.querySelector('.search-job[data-source="pop3Old"]')?.innerText || ''), progressRe('[1-9]\\d*'), { timeout: 20000 })
  const progressText = await page.locator('.search-job[data-source="pop3Old"]').innerText()
  // the UI stays usable meanwhile: the account chip's menu opens and closes (without changing the
  // search, which would cancel the job on purpose)
  const tUi = Date.now()
  await accountChip.click()
  await page.getByRole('menu', { name: t.searchFilter.account }).waitFor()
  await page.keyboard.press('Escape')
  await page.getByRole('menu', { name: t.searchFilter.account }).waitFor({ state: 'detached' })
  const uiMs = Date.now() - tUi
  const tCancel = Date.now()
  const cancelBtn = page.locator('.search-job[data-source="pop3Old"]').getByRole('button', { name: t.searchCancel, exact: true })
  if (await cancelBtn.count()) await cancelBtn.click()
  await page.locator('.search-job.done[data-source="pop3Old"]').waitFor({ timeout: 5000 }).catch(() => {})
  const cancelMs = Date.now() - tCancel
  const doneText = await page.locator('.search-job[data-source="pop3Old"]').innerText()
  check('progress shown while it runs', new RegExp(progressRe('\\d+')).test(progressText), progressText)
  check('UI usable during the job (filter toggled)', uiMs < 1500, `${uiMs} ms`)
  check('cancel stops within 2 s', cancelMs < 2000 && doneText.includes(t.searchPop3Done({ cancelled: true, hits: 0 }).split(':')[0]), `${cancelMs} ms, ${doneText}`)

  // the server button without a reachable server: an error, not a hang
  await pickAccount('IMAP-fiók')
  await box.fill('hoszivattyu')
  await page.waitForFunction(() => [...document.querySelectorAll('.result .result-subject')].map(e => e.textContent).join() === 'IMAP ajánlat')
  check('IMAP scope: no POP3 button', (await page.getByRole('button', { name: t.searchInOld, exact: true }).count()) === 0)
  await page.getByRole('button', { name: t.searchOnServer, exact: true }).click()
  await page.locator('.search-job.done[data-source="server"]').waitFor({ timeout: 15000 })
  const serverText = await page.locator('.search-job.done[data-source="server"]').innerText()
  check('server search without a server: a clear error', serverText.includes(t.searchServerDone({ hits: 0, errors: [{ account: 'IMAP-fiók', code: 'connection_refused' }] })), serverText)
  if (values.shot) await page.screenshot({ path: values.shot })

  // Esc: back to the folder view
  await box.press('Escape')
  await page.locator('.message-list').waitFor()
  check('Esc returns to the folder view', (await page.locator('.search-results').count()) === 0 && (await box.inputValue()) === '')
} catch (err) {
  check('run', false, err.stack)
} finally {
  await app.close().catch(() => {})
  await server.close()
  fs.rmSync(work, { recursive: true, force: true })
}
console.log(`\n${results.filter(Boolean).length} / ${results.length} OK`)
process.exit(results.every(Boolean) ? 0 : 1)
