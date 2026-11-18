// SPDX-License-Identifier: GPL-3.0-or-later
// The recipient column in the real app (headless Electron + Playwright): in Sent the sender cell shows the recipient
// ("Name +2", a Bcc-only message by its Bcc, none: "(nincs címzett)"), the More menu says "by recipient" and that order
// is by the recipient; INBOX and a plain folder stay by the sender; a hand-picked Sent folder switches with the role;
// with a long name the name is cut and the "+N" stays whole.
// Data: test/tools/seed-index.mjs (a dummy IMAP account at 127.0.0.1:1, nothing leaves the machine), then the Sent rows'
// recipient lines are rewritten in the encrypted database before the app starts.
// Needs a fresh renderer build first: npx vite build
//
//   E2E_LANG=hu|en node test/e2e/recipient-column-e2e.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { t, seedLanguage } from './lang.mjs'
import { openVaultedDatabase } from '../../core/vault/vaulted-db.js'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-recipient-e2e-'))
const dataDir = path.join(work, 'data')
const seed = JSON.parse(execFileSync(process.execPath, [path.join(repo, 'test', 'tools', 'seed-index.mjs'), dataDir, '--count', '12'], { encoding: 'utf8' }))
seedLanguage(dataDir)

const LONG = 'Nagyon Hosszu Nevu Cimzett Aki Biztosan Nem Fer Ki A Cellaban Sehogy Sem Es Meg Annal Is Hosszabb'
const SENT = {
  1: { to: 'Kiss Anna <anna@example.invalid>, b@example.invalid', cc: 'c@example.invalid', bcc: '' },
  2: { to: '', cc: '', bcc: 'Titkos Tobias <tobias@example.invalid>' },
  3: { to: '', cc: '', bcc: '' },
  4: { to: `${LONG} <long@example.invalid>, d@example.invalid, e@example.invalid`, cc: '', bcc: '' },
  5: { to: 'zed@example.invalid', cc: '', bcc: '' },
}
{
  const { db } = await openVaultedDatabase(dataDir, seed.master)
  const set = db.prepare("UPDATE messages SET to_addrs = ?, cc_addrs = ?, bcc_addrs = ? WHERE folder = 'Sent' AND uid = ?")
  for (const [uid, r] of Object.entries(SENT)) set.run(r.to, r.cc, r.bcc, Number(uid))
  // two messages in Ügyfelek (a plain folder until it is picked as Sent)
  const src = db.prepare("SELECT * FROM messages WHERE folder = 'Sent' AND uid IN (1, 2) ORDER BY uid").all()
  const ins = db.prepare(`INSERT INTO messages (account_id, folder, uid, message_id, from_addr, from_name, to_addrs, cc_addrs, bcc_addrs, subject, date, idate, flags, size, body_state)
    VALUES (@account_id, 'Ügyfelek', @uid, @message_id, @from_addr, @from_name, @to_addrs, @cc_addrs, @bcc_addrs, @subject, @date, @idate, @flags, @size, @body_state)`)
  for (const r of src) ins.run(r)
  db.close()
}

const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const problems = []

let app = null
try {
  app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
  const page = await app.firstWindow()
  page.on('console', m => m.type() === 'error' && !/ERR_CONNECTION_REFUSED|connect ECONNREFUSED/.test(m.text()) && problems.push(m.text()))
  page.on('pageerror', e => problems.push(e.message))
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.locator('#vault-unlock').fill(seed.master)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  await page.getByRole('button', { name: t.viewSettings, exact: true }).waitFor({ timeout: 20_000 })

  const openFolder = async p => {
    await page.locator(`.folder-tree .folder[data-path="${p}"]`).first().click()
    await page.waitForFunction(() => document.querySelectorAll('.msg-row[data-id]').length > 0)
    await page.waitForTimeout(300)
  }
  const cells = () => page.locator('.msg-row[data-id] .col-from').evaluateAll(els => els.map(e => ({ id: Number(e.parentElement.dataset.id), text: e.textContent, title: e.getAttribute('title'), recipient: e.classList.contains('col-recipient') })))
  const idOfUid = new Map((await page.evaluate(async () => (await window.shadowMail.mail.list({ accountId: 1, folder: 'Sent', sort: 'date', dir: 'desc', limit: 50 })).rows)).map(r => [r.uid, r.id]))
  const sortPick = async label => {
    await page.getByRole('button', { name: t.moreMenu, exact: true }).click()
    const item = page.getByRole('menuitemradio', { name: label, exact: true })
    const n = await item.count()
    if (n) await item.click()
    else await page.keyboard.press('Escape')
    return n
  }

  // 1. Sent: the recipient in the sender's place
  await openFolder('Sent')
  let rows = await cells()
  const by = async uid => rows.find(r => r.id === idOfUid.get(uid))
  const r1 = await by(1)
  check('Sent: "Kiss Anna +2" (To + Cc), the tooltip lists them all', r1 && r1.recipient && r1.text === 'Kiss Anna +2' && r1.title === 'Kiss Anna <anna@example.invalid>, b@example.invalid, c@example.invalid', JSON.stringify(r1))
  const r2 = await by(2)
  check('Sent: a Bcc-only message shows its Bcc', r2 && r2.text === 'Titkos Tobias', JSON.stringify(r2))
  const r3 = await by(3)
  check('Sent: no recipient at all', r3 && r3.text === t.noRecipient, JSON.stringify(r3))
  const r5 = await by(5)
  check('Sent: no name -> the address', r5 && r5.text === 'zed@example.invalid', JSON.stringify(r5))
  const r6 = await by(6)
  check('Sent: the seed\'s plain To (an address)', r6 && r6.text === 'meres@example.invalid', JSON.stringify(r6))

  // 2. the long name is cut, the "+2" is whole and inside the cell
  const geo = await page.evaluate(long => {
    const cell = [...document.querySelectorAll('.msg-row .col-recipient')].find(c => c.textContent.startsWith(long))
    const name = cell.querySelector('.recipient-name')
    const more = cell.querySelector('.recipient-more')
    const c = cell.getBoundingClientRect()
    const m = more.getBoundingClientRect()
    return { cut: name.scrollWidth > name.clientWidth, moreInside: m.left >= c.left && m.right <= c.right + 0.5, moreWhole: more.scrollWidth <= more.clientWidth + 0.5, more: more.textContent, cellW: Math.round(c.width) }
  }, LONG)
  check('a long name: the name is cut (ellipsis), the " +2" stays whole inside the cell', geo.cut && geo.moreInside && geo.moreWhole && geo.more === ' +2', JSON.stringify(geo))

  // 3. the More menu says "by recipient" in Sent; that order is by the recipient
  const n = await sortPick(t.sortMenu.recipient)
  check('Sent: the More menu has "Sort by recipient" (not "by sender")', n === 1)
  await page.waitForTimeout(400)
  rows = await cells()
  const shown = rows.map(r => r.text)
  const want = [t.noRecipient, 'Kiss Anna +2']
  check('Sent by recipient, ascending: (none), Kiss Anna, the addresses, Nagyon..., Titkos Tobias, zed@', shown[0] === want[0] && shown[1] === want[1] && shown.at(-2) === 'Titkos Tobias' && shown.at(-1) === 'zed@example.invalid' && shown.at(-3).startsWith('Nagyon'), JSON.stringify(shown))
  // the filter row's order chip names it too ("Címzett", "Rendezés: Címzett, növekvő")
  await page.getByRole('button', { name: t.searchFiltersButton, exact: true }).click()
  const sortChip = page.locator('.search-chips .sort-chip button.chip')
  await sortChip.waitFor()
  const chipText = (await sortChip.innerText()).trim()
  const chipName = await sortChip.getAttribute('aria-label')
  check('Sent: the order chip says recipient', chipText === t.listSortField.recipient && chipName === t.listSortChip('recipient', 'asc'), JSON.stringify({ chipText, chipName }))
  await page.getByRole('button', { name: t.searchFiltersButton, exact: true }).click()

  // 4. INBOX: the sender, the menu says "by sender", the same order key ('from') stays chosen
  await openFolder('INBOX')
  rows = await cells()
  check('INBOX: the sender cell, no recipient class', rows.length > 0 && rows.every(r => !r.recipient), JSON.stringify(rows.slice(0, 2)))
  check('INBOX: the More menu says "Sort by sender"', (await sortPick(t.sortMenu.from)) === 1)
  await page.waitForTimeout(300)
  const senders = (await cells()).map(r => r.text)
  check('INBOX by sender: the sender names in order (the old rule)', senders.length > 1, JSON.stringify(senders.slice(0, 4)))

  // 5. a hand-picked Sent folder: Ügyfelek shows the recipient, the old Sent the sender
  await openFolder('Ügyfelek')
  check('Ügyfelek (no role): the sender', (await cells()).every(r => !r.recipient))
  const res = await page.evaluate(async () => window.shadowMail.folders.setRole({ accountId: 1, role: 'sent', path: 'Ügyfelek' }))
  check('Ügyfelek picked as Sent', res && res.ok, JSON.stringify(res))
  await page.waitForTimeout(800)
  rows = await cells()
  check('Ügyfelek now Sent: the open list redraws with the recipient', rows.length === 2 && rows.every(r => r.recipient) && rows.some(r => r.text === 'Kiss Anna +2'), JSON.stringify(rows))
  await openFolder('Sent')
  check('the old Sent: the sender again', (await cells()).every(r => !r.recipient))
  await page.evaluate(async () => window.shadowMail.folders.setRole({ accountId: 1, role: 'sent', path: null }))
  await page.waitForTimeout(800)
  await openFolder('Sent')
  check('Automatic again: Sent shows the recipient', (await cells()).some(r => r.recipient && r.text === 'Kiss Anna +2'))

  check('no console error, no page error', problems.length === 0, JSON.stringify(problems.slice(0, 3)))
} finally {
  if (app) await app.close().catch(() => {})
  fs.rmSync(work, { recursive: true, force: true })
}
const ok = results.filter(Boolean).length
console.log(`${ok} / ${results.length} OK`)
process.exit(ok === results.length ? 0 : 1)
