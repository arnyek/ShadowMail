#!/usr/bin/env node
// The filter chips without a search (since 0.10.1), headless
// Electron + Playwright. Not part of `npm test`.
//
//   node test/e2e/filters-e2e.mjs [--shot <file.png>]
//
// A POP3 account on the TCP fake POP3 server (its read flag and delete are local, so opening a message
// really makes it read, and "select all" + Delete really moves to the Trash), 30 messages: every 3rd
// with an attachment, 21-30 forty days old; the even ones are made read and every 5th starred through
// the app's own bridge. Expected: unread 15, unread + attachment 5, + since 10 days ago 3. A second,
// unreachable IMAP account (rows written directly) for the account / folder chips.
// Playwright: PW=<path of the playwright package> (default: the repo's playwright-core devDependency).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { FakePop3Server } from '../helpers/fake-pop3.js'
import { MailIndex } from '../../core/db/mail-index.js'
import { createVaultedDatabase } from '../../core/vault/vaulted-db.js'
import { AccountStore } from '../../core/accounts/model.js'
import { newAccountDefaults } from '../../core/accounts/defaults.js'
import { t, seedLanguage } from './lang.mjs'

const { values } = parseArgs({ options: { shot: { type: 'string' } } })
const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const MASTER = 'Teszt-mesterjelszo-szurok'
const now = Date.now()
const DAY = 86_400_000
const pad = i => String(i).padStart(2, '0')

const server = await new FakePop3Server().listen()
for (let i = 1; i <= 30; i++) {
  const date = new Date(i <= 20 ? now - i * 60_000 : now - 40 * DAY - i * 60_000).toUTCString()
  const head = `From: Feladó ${pad(31 - i)} <f${i}@example.invalid>\r\nTo: p@example.invalid\r\nSubject: POP ${pad(i)}\r\nDate: ${date}\r\nMIME-Version: 1.0\r\n`
  const body =
    i % 3 === 0
      ? `Content-Type: multipart/mixed; boundary="b${i}"\r\n\r\n--b${i}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nszöveg ${i}\r\n--b${i}\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename="melleklet-${i}.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0xLjQK\r\n--b${i}--\r\n`
      : `Content-Type: text/plain; charset=utf-8\r\n\r\nszöveg ${i}\r\n`
  server.add(Buffer.from(head + body))
}
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-f2-e2e-'))
const dataDir = path.join(work, 'data')
fs.mkdirSync(dataDir)
seedLanguage(dataDir)
{
  const { db, vault } = await createVaultedDatabase(dataDir, MASTER)
  const store = new AccountStore(db, vault, { storeDir: path.join(dataDir, 'store') })
  const base = { smtp_host: '127.0.0.1', smtp_port: 1, smtp_security: 'none', in_security: 'none', in_host: '127.0.0.1' }
  store.save({ ...newAccountDefaults('pop3'), ...base, name: 'POP3-fiók', email: 'p@example.invalid', in_port: server.port, in_user: server.user, in_password: server.pass })
  const imap = store.save({ ...newAccountDefaults('imap'), ...base, name: 'IMAP elérhetetlen', email: 'i@example.invalid', in_port: 1, in_user: 'i', in_password: 'nem-valodi' }).account
  const index = new MailIndex(db)
  for (const p of ['INBOX', 'Archív']) index.upsertFolder({ account_id: imap.id, path: p, uidvalidity: '1', synced_at: now })
  index.insertMany(['INBOX', 'INBOX', 'Archív'].map((folder, i) => ({ account_id: imap.id, folder, uid: i + 1, message_id: null, in_reply_to: null, refs: null, from_addr: 'x@example.invalid', from_name: 'IMAP feladó',
    to_addrs: '', cc_addrs: '', subject: `IMAP ${folder} ${i + 1}`, date: now - i * 1000, idate: now - i * 1000, flags: '', size: 1, has_attachments: 0, attachments: null, body_state: 3, sender_text: '', recipients_text: '' })))
  db.close()
}

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const startsWith = text => new RegExp(`^${esc(text)}`)
// the count's filtered tail: "(szűrve, összesen 30)" / "(filtered, 30 in total)", and its first word
const filteredTail = n => t.listFiltered(n).trim()
const filteredWord = filteredTail(30).slice(1).split(',')[0]

const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const consoleProblems = []
const app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
try {
  const page = await app.firstWindow()
  page.on('console', m => (m.type() === 'error' || m.type() === 'warning') && consoleProblems.push(m.text()))
  page.on('pageerror', e => consoleProblems.push(String(e)))
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  const pop = page.locator('.folder-tree section', { hasText: 'POP3-fiók' })
  await pop.locator('.folder[data-path="INBOX"]').waitFor({ timeout: 20000 })
  await pop.locator('.folder[data-path="INBOX"]').click()
  const total = () => page.locator('.list-count').getAttribute('data-total')
  const waitTotal = (n, folderTotal) =>
    page.waitForFunction(([n, ft]) => {
      const c = document.querySelector('.list-count')
      return c && c.dataset.total === String(n) && (ft === null || c.dataset.folderTotal === String(ft))
    }, [n, folderTotal ?? null], { timeout: 15000 })
  await waitTotal(30)

  // the read and starred states through the app's own bridge (the same IPC as the toolbar)
  const popId = await page.evaluate(async () => (await window.shadowMail.mail.folders()).accounts.find(a => a.name === 'POP3-fiók').id)
  const bySubject = async folder =>
    page.evaluate(async ([accountId, folder]) => {
      const res = await window.shadowMail.mail.list({ accountId, folder, limit: 500 })
      return Object.fromEntries(res.rows.map(r => [r.subject, { id: r.id, flags: r.flags || '' }]))
    }, [popId, folder])
  const inbox0 = await bySubject('INBOX')
  const ids = pred => Object.entries(inbox0).filter(([s]) => pred(Number(s.slice(4)))).map(([, m]) => m.id)
  const act = (action, list) => page.evaluate(([action, ids]) => window.shadowMail.mail.action({ ids, action }), [action, list])
  check('setup: 15 read, 6 starred', (await act('read', ids(i => i % 2 === 0))).done === 15 && (await act('star', ids(i => i % 5 === 0))).done === 6)
  await page.getByRole('button', { name: t.refresh, exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.msg-row.unread').length > 0 && document.querySelectorAll('.msg-row.unread').length < 20)

  const chips = page.locator('.search-chips')
  const chip = name => chips.getByRole('button', { name, exact: true })
  const filtersButton = page.getByRole('button', { name: t.searchFiltersButton, exact: true })
  const countText = () => page.locator('.list-count').innerText()
  const visibleSubjects = () => page.locator('.msg-row[data-id] .col-subject').allInnerTexts()

  // 1. no search: Unread filters the folder view, the count says "(szűrve, összesen 30)"; off = the whole list
  await filtersButton.click()
  await chips.waitFor()
  await chip(t.searchFilter.unread).click()
  await waitTotal(15, 30)
  const allUnread = await page.locator('.msg-row[data-id]').evaluateAll(els => els.length > 0 && els.every(e => e.classList.contains('unread')))
  check('(1) Olvasatlan without a search: only the 15 unread, "(szűrve, összesen 30)"', allUnread && (await countText()).endsWith(filteredTail(30)), await countText())
  await chip(t.searchFilter.unread).click()
  await waitTotal(30, 30)
  check('(1) Olvasatlan off: the whole folder again, no "szűrve"', !(await countText()).includes(filteredWord), await countText())

  // 2. Unread + attachment + a date range together; the same with a query filters the hits
  await chip(t.searchFilter.unread).click()
  await chip(t.searchFilter.hasAttachment).click()
  await waitTotal(5, 30)
  const since = new Date(now - 10 * DAY)
  const ymd = `${since.getFullYear()}-${pad(since.getMonth() + 1)}-${pad(since.getDate())}`
  await chips.getByRole('button', { name: startsWith(t.searchAnyTime) }).click()
  await page.getByRole('dialog', { name: t.searchAnyTime }).getByLabel(t.searchFilter.since).fill(ymd)
  await page.keyboard.press('Escape')
  await waitTotal(3, 30)
  const three = (await visibleSubjects()).sort()
  check('(2) Olvasatlan + Van melléklet (5) + Bármikor (since 10 days ago): POP 03, 09, 15', JSON.stringify(three) === JSON.stringify(['POP 03', 'POP 09', 'POP 15']), JSON.stringify(three))
  const box = page.getByRole('searchbox', { name: t.searchLabel })
  await box.fill('POP')
  await page.locator('.result').first().waitFor()
  await page.waitForTimeout(500)
  const hits = (await page.locator('.result .result-subject').allInnerTexts()).sort()
  check('(2) the same filters with a query: the hits are filtered the same way', JSON.stringify(hits) === JSON.stringify(['POP 03', 'POP 09', 'POP 15']), JSON.stringify(hits))
  await box.fill('')
  await waitTotal(3, 30)
  // the header's "Szűrők törlése" turns everything off
  await page.locator('.list-header').getByRole('button', { name: t.clearFilters, exact: true }).click()
  await waitTotal(30, 30)
  const offAll = await chips.locator('button.chip[aria-pressed="true"]').count()
  check('the header "Szűrők törlése": every chip off, the whole folder', offAll === 0 && (await page.locator('.list-header .clear-filters').count()) === 0)

  // 3. the filter stays on a folder change, the row shows and cannot be closed while it is on
  await chip(t.searchFilter.unread).click()
  await waitTotal(15, 30)
  await pop.locator('.folder[data-path="Sent"]').click()
  await page.waitForFunction(() => document.querySelector('.folder-tree .folder[aria-current="true"]')?.dataset.path === 'Sent')
  await filtersButton.click() // a try to close it
  await page.waitForTimeout(300)
  check(' another folder: Olvasatlan stays on, the chip row stays (the Szűrők button cannot hide it)', (await chip(t.searchFilter.unread).getAttribute('aria-pressed')) === 'true' && (await chips.count()) === 1 && (await filtersButton.getAttribute('aria-expanded')) === 'true')
  // an empty filtered list (Sent has no unread starred message): the text and the button
  await chip(t.searchFilter.flagged).click()
  await page.locator('.list-filtered-empty').waitFor()
  const emptyText = await page.locator('.list-filtered-empty .hint').innerText()
  await page.locator('.list-filtered-empty').getByRole('button', { name: t.clearFilters, exact: true }).click()
  await page.waitForFunction(() => !document.querySelector('.list-filtered-empty'))
  check('empty filtered list: "Nincs a szűrőknek megfelelő levél." + Szűrők törlése, which turns every filter off', emptyText === t.listFilteredEmpty && (await chips.locator('button.chip[aria-pressed="true"]').count()) === 0, emptyText)

  // 4. a message opened in the Unread filter becomes read and stays listed until the folder changes
  await pop.locator('.folder[data-path="INBOX"]').click()
  await chip(t.searchFilter.unread).click()
  await waitTotal(15, 30)
  const firstRow = page.locator('.msg-row[data-id]').first()
  const opened = await firstRow.locator('.col-subject').innerText()
  await firstRow.click()
  await page.locator('.reader[data-message-id]').waitFor()
  await page.waitForFunction(async ([accountId, subject]) => {
    const res = await window.shadowMail.mail.list({ accountId, folder: 'INBOX', limit: 500 })
    return res.rows.some(r => r.subject === subject && (r.flags || '').split(' ').includes('\\Seen'))
  }, [popId, opened])
  await page.locator('.reader-back').click()
  await page.waitForTimeout(800) // the change event reloads the list (with the kept id)
  const keptRow = page.locator('.msg-row[data-id]', { hasText: opened })
  check(' opened in the Unread filter: read now, still listed (15)', (await total()) === '15' && (await keptRow.count()) === 1 && !(await keptRow.getAttribute('class')).includes('unread'), `${opened}, total ${await total()}`)
  await pop.locator('.folder[data-path="Sent"]').click()
  await pop.locator('.folder[data-path="INBOX"]').click()
  await waitTotal(14, 30)
  check(' after a folder change it is gone from the Unread filter (14)', (await keptRow.count()) === 0)
  // the same with Refresh: opened, kept (14), Refresh -> gone (13)
  const second = page.locator('.msg-row[data-id]').first()
  const opened2 = await second.locator('.col-subject').innerText()
  await second.click()
  await page.locator('.reader[data-message-id]').waitFor()
  await page.locator('.reader-back').click()
  await page.waitForTimeout(800)
  const kept2 = (await total()) === '14' && (await page.locator('.msg-row[data-id]', { hasText: opened2 }).count()) === 1
  await page.getByRole('button', { name: t.refresh, exact: true }).click()
  await waitTotal(13, 30)
  check(' a second opened one stays (14), Refresh drops it (13)', kept2 && (await page.locator('.msg-row[data-id]', { hasText: opened2 }).count()) === 0, opened2)

  // 5. the filtered "select all" + Delete takes only the filtered messages
  const before = { inbox: Object.keys(await bySubject('INBOX')).length, trash: Object.keys(await bySubject('Trash')).length }
  // Ctrl+A on the list: the filtered set as well; then cleared (the select-all box clears a selection)
  await page.locator('.msg-viewport').focus()
  await page.keyboard.press('Control+A')
  await page.locator('.selection-count').waitFor()
  await page.waitForTimeout(300)
  const byKeys = await page.locator('.selection-count').innerText()
  check(' Ctrl+A in the filtered view: the 13 listed', byKeys === t.selectedCount(13), byKeys)
  await page.locator('.select-all input').click()
  await page.locator('.list-tools').waitFor()
  await page.locator('.select-all input').click() // async: the ids come from mail:ids, then the box is checked
  await page.locator('.selection-count').waitFor()
  await page.waitForTimeout(300)
  const selected = await page.locator('.selection-count').innerText()
  check(' the filtered "select all" selects the 13 listed, not the folder', selected === t.selectedCount(13), selected)
  if (selected !== t.selectedCount(13)) throw new Error('wrong selection: not deleting it') // the delete would take unlisted mail
  await page.locator('.action-bar').getByRole('button', { name: t.actions.delete, exact: true }).click()
  await page.locator('.list-filtered-empty').waitFor({ timeout: 15000 })
  const inboxAfter = await bySubject('INBOX')
  const trashAfter = await bySubject('Trash')
  const after = { inbox: Object.keys(inboxAfter).length, trash: Object.keys(trashAfter).length }
  const leftAllRead = Object.values(inboxAfter).every(m => m.flags.split(' ').includes('\\Seen'))
  const trashedUnreadOnly = Object.keys(trashAfter).every(s => Number(s.slice(4)) % 2 === 1 && s !== opened && s !== opened2)
  check(' filtered select all = 13, Delete: only those 13 to the Trash, the 17 others stay', before.inbox === 30 && before.trash === 0 && after.inbox === 17 && after.trash === 13 && leftAllRead && trashedUnreadOnly, `before ${JSON.stringify(before)}, after ${JSON.stringify(after)}`)
  await page.locator('.list-header').getByRole('button', { name: t.clearFilters, exact: true }).click()
  await waitTotal(17, 17)

  // 6. the account chip opens that account's INBOX, the folder chip that folder; the tree follows
  await chips.getByRole('button', { name: startsWith(`${t.searchFilter.account}: `) }).click()
  await page.getByRole('menuitemradio', { name: 'IMAP elérhetetlen', exact: true }).click()
  await waitTotal(2)
  const current = () => page.evaluate(() => {
    const el = document.querySelector('.folder-tree .folder[aria-current="true"]')
    return el ? `${el.closest('section').querySelector('.account-name').innerText}|${el.dataset.path}` : null
  })
  check('the Fiók chip: the account\'s INBOX opens, the tree marks it', (await current()) === 'IMAP elérhetetlen|INBOX' && (await chips.getByRole('button', { name: startsWith(`${t.searchFilter.account}: `) }).innerText()) === `${t.searchFilter.account}: IMAP elérhetetlen`, await current())
  await chips.getByRole('button', { name: startsWith(`${t.searchFilter.folder}: `) }).click()
  await page.getByRole('menuitemradio', { name: 'Archív', exact: true }).click()
  await waitTotal(1)
  check('the Mappa chip: that folder opens, the tree marks it', (await current()) === 'IMAP elérhetetlen|Archív', await current())

  // 7. the Rendezés chip and the More menu: one state
  const sortChip = chips.getByRole('button', { name: startsWith(t.searchFilter.sort) })
  const sort0 = await sortChip.getAttribute('aria-label')
  await sortChip.click()
  await page.getByRole('menuitemradio', { name: t.sortMenu.from, exact: true }).click()
  await page.getByRole('button', { name: t.moreMenu, exact: true }).click()
  const moreChecked = await page.getByRole('menuitemradio', { name: t.sortMenu.from, exact: true }).getAttribute('aria-checked')
  await page.getByRole('menuitemradio', { name: t.sortMenu.subject, exact: true }).click()
  const sort2 = await sortChip.getAttribute('aria-label')
  check('Rendezés chip <-> More menu: the chip\'s pick shows in the menu, the menu\'s pick in the chip', sort0 === t.listSortChip('date', 'desc') && moreChecked === 'true' && sort2 === t.listSortChip('subject', 'asc'), `${sort0} -> menu ${moreChecked} -> ${sort2}`)

  // 8. only the folder view's actions are kept. Csillagos on in the POP3 INBOX (starred
  // and left after the delete: POP 10, 20, 30): unstarred from a SEARCH hit -> gone after the query is
  // cleared; unstarred in the folder view -> stays listed
  await pop.locator('.folder[data-path="INBOX"]').click()
  await chip(t.searchFilter.flagged).click()
  await waitTotal(3, 17)
  await box.fill('POP')
  await page.locator('.result', { hasText: 'POP 10' }).waitFor()
  await page.locator('.result', { hasText: 'POP 10' }).locator('.result-open').click()
  await page.locator('.reader[data-message-id]').waitFor()
  await page.locator('.reader-tools').getByRole('button', { name: t.actions.unstar, exact: true }).click()
  await page.waitForFunction(async ([accountId]) => {
    const res = await window.shadowMail.mail.list({ accountId, folder: 'INBOX', limit: 500 })
    return !(res.rows.find(r => r.subject === 'POP 10')?.flags || '').includes('\\Flagged')
  }, [popId])
  await box.fill('')
  await page.locator('.list-header').waitFor()
  await page.waitForTimeout(800)
  const afterSearch = await visibleSubjects()
  check('unstarred from a search hit: not in the Csillagos folder view after the query is cleared', !afterSearch.includes('POP 10') && (await total()) === '2', JSON.stringify(afterSearch))
  await page.locator('.msg-row[data-id]', { hasText: 'POP 20' }).locator('.col-star button').click()
  await page.waitForTimeout(800)
  const afterFolder = await visibleSubjects()
  check('unstarred in the folder view: stays listed', afterFolder.includes('POP 20') && (await total()) === '2', JSON.stringify(afterFolder))

  if (values.shot) await page.screenshot({ path: values.shot })
  check('renderer console: no error or warning', consoleProblems.length === 0, consoleProblems.slice(0, 3).join(' | '))
} finally {
  await app.close().catch(() => {})
  await server.close?.()
  fs.rmSync(work, { recursive: true, force: true })
}
const ok = results.filter(Boolean).length
console.log(`${ok} / ${results.length} ${ok === results.length ? 'OK' : 'FAIL'}`)
process.exit(ok === results.length ? 0 : 1)
