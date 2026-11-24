#!/usr/bin/env node
// The MCP show_search in the real app through the connector.
// Not part of `npm test`.
//
//   node test/e2e/mcp-show-e2e.mjs
//
// Two POP3 accounts (fake POP3 servers; their messages are local: the read and starred flags are set in the app's index).
// Measures: every condition (query, from, to, account_id, folder, since, until, unread, flagged, has_attachment, sort) is in
// the search box or its chip; the window's hit list has the ids search_messages gives for the same input (and in its
// order); the folder filters of the view before are replaced; a folder without an account is the folder chip's value; bad
// input (unknown account, bad date, 501-character query) is the same error as search_messages' and the window does not
// change; an empty search is show_search's own bad_arguments (search_messages lists the newest);
// the answer's count is the window's, without content; an editor with input is not left (a banner offers the search); a
// composer in focus keeps it (flashed); two requests sent at once (open_message / show_search, not waiting for the first
// answer): the later one is what the window shows, in all four pairs; the request is not applied again when
// the mail view mounts again; no server
// search starts; the call is in the "Legutóbbi Claude-hívások" list; main.log holds no search word or subject; no
// console problem; the net-guard log is empty.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
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
const MASTER = 'Teszt-mesterjelszo-mutatas'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}

const headers = (from, to, subject, minutesAgo) =>
  `From: ${from}\r\nTo: ${to}\r\nSubject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=\r\nDate: ${new Date(Date.now() - minutesAgo * 60_000).toUTCString()}\r\nMessage-ID: <${Buffer.from(subject).toString('hex').slice(0, 40)}@example.invalid>\r\nMIME-Version: 1.0\r\n`
const plain = (from, to, subject, body, minutesAgo) =>
  Buffer.from(`${headers(from, to, subject, minutesAgo)}Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${body}\r\n`)
const withAttachment = (from, to, subject, body, minutesAgo) =>
  Buffer.from(
    `${headers(from, to, subject, minutesAgo)}Content-Type: multipart/mixed; boundary="b0"\r\n\r\n--b0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${body}\r\n` +
      `--b0\r\nContent-Type: application/pdf; name="szamla.pdf"\r\nContent-Disposition: attachment; filename="szamla.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0xLjQKJcOkw7zDtsOfCg==\r\n--b0--\r\n`,
  )
// account A: four "számla" messages, one of them matching every condition (Anna, to a@, attachment, unread, starred)
const popA = await new FakePop3Server().listen()
popA.add(withAttachment('Anna Árvíztűrő <anna@example.invalid>', 'a@example.invalid', 'Célpont árvíztűrő számla', 'számla november', 6))
popA.add(plain('Anna Árvíztűrő <anna@example.invalid>', 'a@example.invalid', 'Számla melléklet nélkül', 'számla', 5))
popA.add(withAttachment('Anna Árvíztűrő <anna@example.invalid>', 'a@example.invalid', 'Olvasott számla', 'számla', 4))
popA.add(plain('Bence <bence@example.invalid>', 'a@example.invalid', 'Bence számlája', 'számla', 3))
popA.add(plain('Bence <bence@example.invalid>', 'a@example.invalid', 'Egészen más', 'semmi', 2))
// account B: two "számla" messages (an all-accounts search finds them too)
const popB = await new FakePop3Server().listen()
popB.add(plain('Cili <cili@example.invalid>', 'b@example.invalid', 'B-fiók számla', 'számla', 3))
popB.add(plain('Anna Árvíztűrő <anna@example.invalid>', 'b@example.invalid', 'B-fiók Anna számla', 'számla számla', 1))

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-o2-e2e-'))
const dataDir = path.join(work, 'data')
fs.mkdirSync(dataDir)
{
  const { db, vault } = await createVaultedDatabase(dataDir, MASTER)
  const store = new AccountStore(db, vault, { storeDir: path.join(dataDir, 'store') })
  for (const [name, email, pop] of [['A-fiók', 'a@example.invalid', popA], ['B-fiók', 'b@example.invalid', popB]]) {
    store.save({ ...newAccountDefaults('pop3'), name, email, in_host: '127.0.0.1', in_port: pop.port, in_security: 'none', in_user: pop.user, in_password: pop.pass, smtp_host: '127.0.0.1', smtp_port: 1, smtp_security: 'none' })
  }
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
  const ask = (method, params, timeout = 60_000) =>
    new Promise(resolve => {
      const my = ++id
      const timer = setTimeout(() => resolve(null), timeout)
      waiting.set(my, m => (clearTimeout(timer), resolve(m)))
      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: my, method, ...(params ? { params } : {}) })}\n`)
    })
  const tool = async (name, args = {}) => (await ask('tools/call', { name, arguments: args }))?.result
  return { ask, tool, exited: new Promise(r => proc.on('exit', r)), close: () => proc.stdin.end() }
}

// a local day (YYYY-MM-DD), `plus` days from today
const localDay = (plus = 0) => {
  const d = new Date()
  d.setDate(d.getDate() + plus)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const meta = r => (r && r._meta && r._meta['shadowmail/data']) || {}

const consoleProblems = []
const app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
const c = connector()
try {
  const page = await app.firstWindow()
  page.on('console', m => (m.type() === 'error' || m.type() === 'warning') && consoleProblems.push(m.text()))
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  await page.locator('.msg-row').first().waitFor({ timeout: 30_000 })
  const accounts = (await page.evaluate(() => window.shadowMail.mail.folders())).accounts
  const [accA, accB] = [accounts.find(a => a.name === 'A-fiók'), accounts.find(a => a.name === 'B-fiók')]
  const rowsOf = async acc => (await page.evaluate(id => window.shadowMail.mail.list({ accountId: id, folder: 'INBOX', limit: 50 }), acc.id)).rows
  let rowsA = []
  let rowsB = []
  for (let i = 0; i < 80 && (rowsA.length < 5 || rowsB.length < 2); i++) {
    ;[rowsA, rowsB] = [await rowsOf(accA), await rowsOf(accB)]
    if (rowsA.length < 5 || rowsB.length < 2) await sleep(250)
  }
  const bySubject = s => [...rowsA, ...rowsB].find(r => r.subject === s)
  const target = bySubject('Célpont árvíztűrő számla')
  const seenOne = bySubject('Olvasott számla')
  // the target and the "read" one starred; the "read" one read: only the target matches every condition
  const act = req => page.evaluate(q => window.shadowMail.mail.action(q), req)
  await act({ ids: [target.id, seenOne.id], action: 'star' })
  await act({ ids: [seenOne.id], action: 'read' })
  for (let i = 0; i < 20; i++) {
    const r = (await rowsOf(accA)).find(x => x.id === seenOne.id)
    if ((r.flags || '').includes('\\Seen') && (r.flags || '').includes('\\Flagged')) break
    await sleep(150)
  }
  const tgtFlags = (await rowsOf(accA)).find(x => x.id === target.id).flags || ''
  check('setup: 5 + 2 messages; the target unread, starred, with an attachment', rowsA.length === 5 && rowsB.length === 2 && tgtFlags.includes('\\Flagged') && !tgtFlags.includes('\\Seen') && target.has_attachments === 1, JSON.stringify({ a: rowsA.length, b: rowsB.length, tgtFlags, att: target.has_attachments }))

  await page.evaluate(() => window.shadowMail.mcp.setEnabled(true))
  await c.ask('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } })
  const tools = (await c.ask('tools/list')).result.tools
  const ss = tools.find(t => t.name === 'show_search')
  const sm = tools.find(t => t.name === 'search_messages')
  // search_messages' own: limit, and the label filter (the search box shows no label, show_search takes none)
  const props = x => Object.keys(x.inputSchema.properties).filter(k => k !== 'limit' && k !== 'label').sort().join(',')
  check('tools/list: show_search, read only, hits not returned; its properties are search_messages\' without limit', ss && ss.annotations.readOnlyHint === true && /hits themselves are NOT returned/.test(ss.description) && !('limit' in ss.inputSchema.properties) && !('label' in ss.inputSchema.properties) && props(ss) === props(sm), props(ss))

  // the view before: account A's INBOX with the folder filter "Olvasatlan" on
  await page.locator('.folder-tree section', { hasText: 'A-fiók' }).locator('.folder[data-path="INBOX"]').click()
  await page.getByRole('button', { name: t.searchFiltersButton, exact: true }).click()
  await page.locator('.search-chips button.chip', { hasText: t.searchFilter.unread }).click()
  await page.locator('.list-count').waitFor()

  const state = () =>
    page.evaluate(() => ({
      search: document.querySelector('.app-header-search input[type="search"]')?.value ?? null,
      chips: [...document.querySelectorAll('.search-chips button.chip')].map(b => [b.textContent.trim(), b.getAttribute('aria-pressed')]),
      ids: [...document.querySelectorAll('.result-list .result')].map(li => Number(li.dataset.id)),
      count: document.querySelector('.search-footer .hint')?.textContent || null,
      jobs: document.querySelectorAll('.search-job').length,
      reader: document.querySelector('.reader-subject')?.textContent || null,
    }))
  const waitIds = async (want, ms = 10_000) => {
    const t0 = performance.now()
    let s = await state()
    while (JSON.stringify(s.ids) !== JSON.stringify(want) && performance.now() - t0 < ms) {
      await sleep(100)
      s = await state()
    }
    return s
  }
  const smIds = async args => meta(await c.tool('search_messages', args)).items.map(x => x.id)

  // 1. every field
  const full = { query: 'számla', from: 'anna', to: 'a@example.invalid', account_id: accA.id, folder: 'INBOX', since: localDay(-1), until: localDay(0), unread: true, flagged: true, has_attachment: true, sort: 'date' }
  const expect1 = await smIds(full)
  const r1 = await c.tool('show_search', full)
  const s1 = await waitIds(expect1)
  const chip = start => s1.chips.find(([text]) => text.startsWith(start)) || [null, null]
  const f = t.searchFilter
  check('every field: the window\'s hits are search_messages\' ids (the target only)', JSON.stringify(s1.ids) === JSON.stringify(expect1) && expect1.length === 1 && expect1[0] === target.id, JSON.stringify({ ui: s1.ids, sm: expect1 }))
  check('every field: the search box has the query', s1.search === 'számla', s1.search)
  check('every field: account and folder chips', chip(f.account)[0] === `${f.account}: A-fiók` && chip(f.account)[1] === 'true' && chip(f.folder)[0] === `${f.folder}: INBOX` && chip(f.folder)[1] === 'true', JSON.stringify([chip(f.account), chip(f.folder)]))
  check('every field: sender and recipient chip', chip(f.from)[0] === `${f.from}: ${t.searchPeople('anna', 'a@example.invalid')}` && chip(f.from)[1] === 'true', JSON.stringify(chip(f.from)))
  check('every field: the date chip', chip(t.searchAnyTime)[0] === `${t.searchAnyTime}: ${t.searchDateRange(full.since, full.until)}` && chip(t.searchAnyTime)[1] === 'true', JSON.stringify(chip(t.searchAnyTime)))
  check('every field: attachment, unread, starred chips on', [f.hasAttachment, f.unread, f.flagged].every(n => chip(n)[1] === 'true'), JSON.stringify(s1.chips))
  check('every field: the order chip says Dátum', chip(f.sort)[0] === `${f.sort}: ${t.searchSort.date}`, JSON.stringify(chip(f.sort)))
  check('the answer: shown, the count is the window\'s, no subject, sender or search word', r1 && r1.isError === false && meta(r1).shown === true && meta(r1).total === s1.ids.length && /: 1 találat a helyi indexben\./.test(r1.content[0].text) /* the tool's text: Hungarian in both languages */ && !/célpont|árvíztűrő|Árvíztűrő|anna@|számla/.test(JSON.stringify(r1)), JSON.stringify(r1))
  check('no server or old-text search started', s1.jobs === 0)

  // 2. fewer fields: the earlier ones are gone (a new request replaces the box and the chips), every account, relevance
  const few = { query: 'számla' }
  const expect2 = await smIds(few)
  const r2 = await c.tool('show_search', few)
  const s2 = await waitIds(expect2)
  check('query only: the window\'s hits and their order are search_messages\' (both accounts)', JSON.stringify(s2.ids) === JSON.stringify(expect2) && expect2.length === 6 && expect2.includes(bySubject('B-fiók számla').id), JSON.stringify({ ui: s2.ids, sm: expect2 }))
  const on2 = s2.chips.filter(([, p]) => p === 'true').map(([text]) => text)
  check('query only: no chip is left on; without a sort the order chip says Dátum', on2.length === 0 && s2.chips.some(([text]) => text === `${t.searchFilter.sort}: ${t.searchSort.date}`), JSON.stringify(s2.chips))
  check('query only: the count in the answer', meta(r2).total === 6 && /: 6 találat/.test(r2.content[0].text), r2.content[0].text)
  // search_messages without a sort: newest first (the messages' dates are minutes apart, the newest is B's Anna)
  const dateOf = id => [...rowsA, ...rowsB].find(r => r.id === id).date
  check('search_messages without a sort: newest first', expect2.every((id, i) => i === 0 || dateOf(expect2[i - 1]) >= dateOf(id)) && expect2[0] === bySubject('B-fiók Anna számla').id, JSON.stringify(expect2.map(dateOf)))
  // 2b. the user's stored order is relevance: Claude's show_search without a sort still shows by date and does not write
  // the stored choice; with sort 'relevance' it shows relevance; after Esc the user's own search starts with the stored one
  const STORE = 'shadowmail.ui.searchSort'
  const stored = () => page.evaluate(k => window.localStorage.getItem(k), STORE)
  const sortChip = s => (s.chips.find(([text]) => text.startsWith(t.searchFilter.sort)) || [null])[0]
  await page.evaluate(k => window.localStorage.setItem(k, '"relevance"'), STORE)
  await c.tool('show_search', { query: 'kettő' }) // another search first, so the next one is a change the window applies
  const r2b = await c.tool('show_search', few)
  const s2b = await waitIds(expect2)
  check('stored relevance: show_search without a sort is by date, search_messages\' order', r2b.isError === false && JSON.stringify(s2b.ids) === JSON.stringify(expect2) && sortChip(s2b) === `${t.searchFilter.sort}: ${t.searchSort.date}`, JSON.stringify({ ui: s2b.ids, chip: sortChip(s2b) }))
  check('show_search does not write the stored order', (await stored()) === '"relevance"', await stored())
  const expectRel = await smIds({ ...few, sort: 'relevance' })
  await c.tool('show_search', { ...few, sort: 'relevance' })
  const s2c = await waitIds(expectRel)
  check('show_search sort relevance: relevance, search_messages\' relevance order', JSON.stringify(s2c.ids) === JSON.stringify(expectRel) && sortChip(s2c) === `${t.searchFilter.sort}: ${t.searchSort.relevance}`, JSON.stringify({ ui: s2c.ids, sm: expectRel, chip: sortChip(s2c) }))
  await c.tool('show_search', few)
  await waitIds(expect2)
  const box = page.locator('.app-header-search input[type="search"]')
  await box.press('Escape')
  await box.fill('számla')
  const s2d = await waitIds(expectRel)
  check('after Esc the user\'s own search starts with the stored order (relevance)', sortChip(s2d) === `${t.searchFilter.sort}: ${t.searchSort.relevance}` && JSON.stringify(s2d.ids) === JSON.stringify(expectRel), JSON.stringify({ ui: s2d.ids, chip: sortChip(s2d) }))
  await box.press('Escape')
  await page.evaluate(k => window.localStorage.removeItem(k), STORE)

  // 3. a folder without an account; the sender only
  const fold = { from: 'Árvíztűrő', folder: 'INBOX' }
  const expect3 = await smIds(fold)
  await c.tool('show_search', fold)
  const s3 = await waitIds(expect3)
  const chip3 = start => s3.chips.find(([text]) => text.startsWith(start)) || [null, null]
  check('folder without an account, the sender only (accents): ids as search_messages\'; the folder chip shows INBOX', JSON.stringify(s3.ids) === JSON.stringify(expect3) && expect3.length === 4 && s3.search === '' && chip3(t.searchFilter.folder)[0] === `${t.searchFilter.folder}: INBOX` && chip3(t.searchFilter.account)[1] === 'false', JSON.stringify({ ui: s3.ids, sm: expect3, chips: s3.chips }))

  // 4. bad input: the same error as search_messages; the window does not change
  const before = await state()
  for (const [name, bad] of [
    ['unknown account', { query: 'számla', account_id: 9999 }],
    ['bad date', { query: 'számla', since: '2026-02-30' }],
    ['501-character query', { query: 'számla'.padEnd(501, 'x') }],
  ]) {
    const a = await c.tool('show_search', bad)
    const b = await c.tool('search_messages', bad)
    await sleep(300)
    const after = await state()
    check(`bad input (${name}): isError, the same code and text as search_messages; the window unchanged`, a.isError === true && b.isError === true && meta(a).error === meta(b).error && a.content[0].text === b.content[0].text && JSON.stringify(after) === JSON.stringify(before), JSON.stringify({ code: meta(a).error, sm: meta(b).error }))
  }

  // an empty search (no query, sender or recipient): show_search's own error, the window unchanged; search_messages lists
  // the newest as since 0.11.0
  const e1 = await c.tool('show_search', { query: '  ', unread: true })
  const e2 = await c.tool('search_messages', { query: '  ', unread: true })
  await sleep(300)
  check('empty search: show_search bad_arguments, the window unchanged; search_messages lists the unread newest', e1.isError === true && meta(e1).error === 'bad_arguments' && JSON.stringify(await state()) === JSON.stringify(before) && e2.isError === false && meta(e2).items.length === 6, JSON.stringify({ e1: meta(e1).error, sm: meta(e2).items && meta(e2).items.length }))

  // 4b. two requests at once on the connector (Claude Code's parallel tool calls): the later one
  // is what the window shows (open+open, open+search, search+open, search+search), 3 times each
  const msgA = bySubject('Egészen más')
  const msgB = bySubject('Bence számlája')
  const shownNow = async () => {
    await sleep(1200)
    const s = await state()
    return { reader: s.reader, search: s.search, ids: s.ids }
  }
  const backToFolder = async () => {
    await page.locator('.app-header-search input[type="search"]').press('Escape').catch(() => {})
    await page.keyboard.press('Escape').catch(() => {})
    await page.locator('.folder-tree section', { hasText: 'A-fiók' }).locator('.folder[data-path="INBOX"]').click()
    await sleep(300)
  }
  const PAIRS = [
    ['open+open', ['open_message', { message_id: msgA.id }], ['open_message', { message_id: msgB.id }], v => v.reader === 'Bence számlája' && v.search === ''],
    ['open+search', ['open_message', { message_id: msgA.id }], ['show_search', { query: 'tükörfúrógép számla' }], v => v.search === 'tükörfúrógép számla' && v.reader === null],
    ['search+open', ['show_search', { from: 'cili' }], ['open_message', { message_id: msgB.id }], v => v.reader === 'Bence számlája' && v.search === ''],
    ['search+search', ['show_search', { from: 'cili' }], ['show_search', { from: 'bence' }], v => v.search === '' && JSON.stringify(v.ids) !== '[]' && v.ids.every(id => [bySubject('Bence számlája').id, bySubject('Egészen más').id].includes(id))],
  ]
  for (const [name, first, second, ok] of PAIRS) {
    let good = 0
    let last = null
    for (let i = 0; i < 3; i++) {
      await backToFolder()
      const [a, b] = await Promise.all([c.tool(...first), c.tool(...second)])
      last = await shownNow()
      if (ok(last) && a.isError === false && b.isError === false) good++
    }
    check(`two at once (${name}): the later request is shown, 3/3`, good === 3, `${good}/3 ${JSON.stringify(last)}`)
  }
  await backToFolder()

  // 5. Esc leaves Claude's search; back from Beállítások it is not applied again (the request was taken)
  await page.locator('.app-header-search input[type="search"]').press('Escape')
  await page.locator('.msg-row').first().waitFor({ timeout: 10_000 })
  await page.getByRole('button', { name: t.viewSettings, exact: true }).click()
  await page.locator('section.settings').waitFor()
  await page.getByRole('button', { name: t.backToMail, exact: true }).click()
  await page.locator('.msg-row').first().waitFor({ timeout: 10_000 })
  await sleep(500)
  const s5 = await state()
  check('back from Beállítások: Claude\'s search is not shown again', s5.search === '' && s5.ids.length === 0, JSON.stringify(s5))
  // the same for open_message (the same way of taking the request)
  await c.tool('open_message', { message_id: bySubject('Egészen más').id })
  await page.locator('.reader-subject', { hasText: 'Egészen más' }).waitFor({ timeout: 10_000 })
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: t.viewSettings, exact: true }).click()
  await page.locator('section.settings').waitFor()
  await page.getByRole('button', { name: t.backToMail, exact: true }).click()
  await page.locator('.msg-row').first().waitFor({ timeout: 10_000 })
  await sleep(500)
  check('back from Beállítások: Claude\'s opened message does not open again', (await state()).reader === null, String((await state()).reader))

  // 6. an editor with input is not left: the banner offers the search; "Megjelenítés" shows it
  await page.getByRole('button', { name: t.viewContacts, exact: true }).click()
  await page.locator('.contact-new').click()
  await page.locator('input[name="displayName"]').fill('Félkész Ferenc')
  const u1 = await c.tool('show_search', { query: 'számla', account_id: accB.id })
  await page.locator('.claude-offer').waitFor({ timeout: 5000 })
  const offerText = await page.locator('.claude-offer').innerText()
  const kept = await page.locator('form.contact-editor input[name="displayName"]').inputValue()
  check('Címlista editor with input: offered, the input kept, the banner names a search', meta(u1).offered === true && meta(u1).shown === false && /nem váltott/.test(u1.content[0].text) /* the tool's text: Hungarian */ && offerText.includes(t.claudeOfferSearch) && kept === 'Félkész Ferenc' && (await page.locator('.mail-panes').count()) === 0, JSON.stringify({ meta: meta(u1), offerText, kept }))
  await page.locator('.claude-offer-open').click()
  const expect6 = await smIds({ query: 'számla', account_id: accB.id })
  const s6 = await waitIds(expect6)
  check('"Megjelenítés" in the banner shows the search', (await page.locator('.claude-offer').count()) === 0 && JSON.stringify(s6.ids) === JSON.stringify(expect6) && expect6.length === 2 && s6.search === 'számla', JSON.stringify({ ui: s6.ids, sm: expect6 }))

  // 7. a composer in focus keeps it; the search still shows behind it
  const [win] = await Promise.all([app.waitForEvent('window', { timeout: 15_000 }), page.getByRole('button', { name: t.newMessage, exact: true }).click()])
  await win.locator('.editor').waitFor()
  await win.locator('#compose-subject').focus()
  await app.evaluate(({ BrowserWindow }, prefix) => BrowserWindow.getAllWindows().find(w => w.getTitle().startsWith(prefix))?.focus(), t.newMessage)
  await sleep(300)
  const focusedBefore = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.getTitle() || null)
  const expect7 = await smIds({ from: 'bence' })
  const r7 = await c.tool('show_search', { from: 'bence' })
  const s7 = await waitIds(expect7)
  const focusedAfter = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.getTitle() || null)
  check('a composer in focus: "flashed", the focus stays on the composer, the search shows', focusedBefore && focusedBefore.startsWith(t.newMessage) && meta(r7).window === 'flashed' && focusedAfter === focusedBefore && JSON.stringify(s7.ids) === JSON.stringify(expect7) && expect7.length === 2, JSON.stringify({ focusedBefore, focusedAfter, window: meta(r7).window, ui: s7.ids }))
  await app.evaluate(({ BrowserWindow }, prefix) => BrowserWindow.getAllWindows().find(w => w.getTitle().startsWith(prefix))?.destroy(), t.newMessage)

  const recent = await page.evaluate(() => window.shadowMail.mcp.recent())
  // (the list keeps the last 20: the errors are measured in main.log below)
  check('the calls are in the "Legutóbbi Claude-hívások" list', (recent.calls || []).some(x => x.tool === 'show_search' && x.result === 'ok'), JSON.stringify(recent).slice(0, 300))
  await page.evaluate(() => window.shadowMail.mcp.setEnabled(false))
  const log = fs.readFileSync(path.join(dataDir, 'electron', 'logs', 'main.log'), 'utf8')
  check('main.log: no search word, sender or subject; the tool lines with counts', !/számla|szamla|árvíztűrő|Árvíztűrő|anna@|bence|célpont/i.test(log) && /mcp tool=show_search result=ok items=1 /.test(log) && /mcp tool=show_search result=bad_arguments/.test(log) && /mcp tool=show_search result=not_found/.test(log))
  check('no console error or warning in the renderer', consoleProblems.length === 0, consoleProblems.join(' | '))
  const netLog = path.join(dataDir, 'electron', 'logs', 'net-guard.log')
  check('the net-guard log has no outgoing request', !fs.existsSync(netLog) || fs.readFileSync(netLog, 'utf8').trim() === '')
} catch (err) {
  check('run', false, err.stack)
} finally {
  c.close()
  await Promise.race([c.exited, sleep(10_000)])
  await app.close().catch(() => {})
  await popA.close?.()
  await popB.close?.()
  fs.rmSync(work, { recursive: true, force: true })
}
const ok = results.filter(Boolean).length
console.log(`${ok} / ${results.length} ${ok === results.length ? 'OK' : 'FAIL'}`)
process.exit(ok === results.length ? 0 : 1)
