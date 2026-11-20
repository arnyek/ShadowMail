#!/usr/bin/env node
// 0.11.1: what a REAL model sees through the ShadowMail MCP connector. Claude Code runs non-interactive
// (claude -p) against the test app (a POP3 account on the fake POP3 server, known messages, no network); only the
// ShadowMail tools are available. Not part of `npm test`; it needs a Claude login and makes real model calls.
//
//   CLAUDE_CODE_OAUTH_TOKEN=<your own token> node test/live/claude-mcp-live.mjs [--chain | --open | --show | --labels] [--claude <path>] [--out <file>]
//
// The token comes from the caller's environment and goes only into the child's environment (never written anywhere).
// Isolation (the fleet's "child claude" rule): an empty, plugin-free CLAUDE_CONFIG_DIR and an empty TELEGRAM_STATE_DIR,
// both temporary; the child gets a minimal environment, not the caller's.
// Without --chain: "list, read the <known subject> message, tell its sender, subject and first sentence".
// With --chain: the same, then a reply draft (create_reply_draft) with the model's own ids; the draft is then looked up in
// the app (Drafts of the POP3 account).
// With --open: "Nyisd meg a ShadowMailben a(z) <known subject> levelet": the model has
// to find the message and call open_message with its id; the app (Playwright) must show it in the reader, and it must be
// read now.
// With --show: "Mutasd meg a ShadowMailben Kovács Ilona leveleit tavaly óta": two more messages of
// hers (one recent, one from two years ago); the model has to call show_search; the app (Playwright) must show the search
// with her two recent messages as the hits (the old one is before last year), the sender in the search box or its chip.
// With --labels (0.17.0): the label "Teszt" made in the app (only the user makes labels), then TWO claude -p runs on the
// same app: "Tedd fel a Teszt címkét a legutóbbi levélre." (label_messages on the newest message; the app's row shows
// the chip) and "Listázd a Teszt címkés leveleket." (a list with the label filter; the model must SEE "címkék: Teszt"
// in the tool result's text, not only in the machine data).
// Prints every tool call (name, input) and result (first 600 characters), the model's answer, and OK/FAIL checks;
// --out writes the stream-json events to a file.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { parseArgs } from 'node:util'
import { FakePop3Server } from '../helpers/fake-pop3.js'
import { createVaultedDatabase } from '../../core/vault/vaulted-db.js'
import { AccountStore } from '../../core/accounts/model.js'
import { newAccountDefaults } from '../../core/accounts/defaults.js'

const { values } = parseArgs({ options: { chain: { type: 'boolean', default: false }, open: { type: 'boolean', default: false }, show: { type: 'boolean', default: false }, labels: { type: 'boolean', default: false }, claude: { type: 'string', default: 'claude' }, out: { type: 'string' } } })
if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
  console.error('needs CLAUDE_CODE_OAUTH_TOKEN (or ANTHROPIC_API_KEY) in the environment: your own login')
  process.exit(2)
}
const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const MASTER = 'Teszt-mesterjelszo-MCP-live'
const USER = 'live@example.invalid'
const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}

// the known message and two others
const KNOWN = { from: 'Kovács Ilona', addr: 'ilona.kovacs@example.invalid', subject: 'Ajánlatkérés: irodai székek', first: 'Szeretnénk ajánlatot kérni tizenkét irodai székre a budapesti irodánkba.' }
const mail = (from, addr, subject, body, i) =>
  Buffer.from(`From: ${from} <${addr}>\r\nTo: ${USER}\r\nSubject: ${subject}\r\nMessage-ID: <live-${i}@example.invalid>\r\nDate: ${new Date(Date.now() - i * 3600_000).toUTCString()}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${body}\r\n`)
const pop = await new FakePop3Server().listen()
pop.add(mail('Nagy Péter', 'peter.nagy@example.invalid', 'Heti jelentés', 'Csatolom a heti jelentést. Kérlek, nézd át péntekig.', 3))
pop.add(mail(KNOWN.from, KNOWN.addr, KNOWN.subject, `${KNOWN.first} Kérjük, a szállítási határidőt is adja meg. A székek fekete színűek legyenek.\r\n\r\nÜdvözlettel:\r\nKovács Ilona`, 1))
pop.add(mail('Szabó Anna', 'anna.szabo@example.invalid', 'Ebéd csütörtökön?', 'Lenne kedved csütörtökön ebédelni?', 2))
// --show: one more recent message of the known sender, and one from two years ago (before "last year")
const OLD_HOURS = 2 * 365 * 24
if (values.show) {
  pop.add(mail(KNOWN.from, KNOWN.addr, 'Székek: a szállítás időpontja', 'A szállítás jövő kedden lehetne?', 4))
  pop.add(mail(KNOWN.from, KNOWN.addr, 'Régi megrendelés', 'Ez egy két évvel ezelőtti levél.', OLD_HOURS))
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-claude-live-'))
const dataDir = path.join(work, 'data')
fs.mkdirSync(dataDir)
{
  const { db } = await createVaultedDatabase(dataDir, MASTER).then(r => ({ db: r.db, vault: r.vault, store: new AccountStore(r.db, r.vault, { storeDir: path.join(dataDir, 'store') }) })).then(r => {
    r.store.save({ ...newAccountDefaults('pop3'), name: 'Élő próba', email: USER, display_name: 'Próba Bence', in_host: '127.0.0.1', in_port: pop.port, in_security: 'none', in_user: pop.user, in_password: pop.pass, smtp_host: '127.0.0.1', smtp_port: 1, smtp_security: 'none' })
    return r
  })
  db.close()
}
const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cfg-isolated-'))
const tgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-tg-empty-'))
const mcpConfig = path.join(work, 'mcp.json')
fs.writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { shadowmail: { command: electronBin, args: [repo, '--mcp', '--ozone-platform=headless'], env: { SHADOWMAIL_DATA: dataDir } } } }))

const prompt = values.show
  ? `Mutasd meg a ShadowMailben ${KNOWN.from} leveleit tavaly óta.`
  : values.open
  ? `Nyisd meg a ShadowMailben a(z) "${KNOWN.subject}" tárgyú levelet.`
  : values.chain
  ? `Listázd a beérkezett leveleket, olvasd el a(z) "${KNOWN.subject}" tárgyú levelet, és írd le a feladóját, a tárgyát és az első mondatát. Utána készíts rá válasz-piszkozatot (create_reply_draft) ezzel a szöveggel: "Köszönjük, az ajánlatot jövő hétig elküldjük." Végül írd le, sikerült-e a piszkozat.`
  : `Listázd a beérkezett leveleket, olvasd el a(z) "${KNOWN.subject}" tárgyú levelet, és írd le a feladóját, a tárgyát és az első mondatát.`

const LABEL_PROMPTS = ['Tedd fel a Teszt címkét a legutóbbi levélre a ShadowMailben.', 'Listázd a ShadowMailben a Teszt címkés leveleket.']
if (values.out) fs.writeFileSync(values.out, '')

// --labels: the first run put the label on the newest message (the known one), the second listed it by the label
async function labelChecks(page, first, second) {
  const accounts = await page.evaluate(() => window.shadowMail.accounts.list())
  const acc = accounts.accounts[0]
  const inbox = (await page.evaluate(q => window.shadowMail.mail.list(q), { accountId: acc.id, folder: 'INBOX', limit: 50 })).rows || []
  const newest = [...inbox].sort((a, b) => b.date - a.date)[0]
  const label = (await page.evaluate(() => window.shadowMail.labels.list())).labels.find(l => l.name === 'Teszt')
  const puts = first.calls.filter(c => c.name === 'mcp__shadowmail__label_messages')
  check('run 1: the model called label_messages with "Teszt" on the newest message', newest && puts.some(c => !c.isError && (c.input.ids || []).includes(newest.id) && (c.input.add || []).some(n => n.toLowerCase() === 'teszt')), JSON.stringify(puts.map(c => [c.input, c.isError])))
  check('run 1: only the newest message carries it (the app\'s own data)', label && label.count === 1 && JSON.stringify(inbox.filter(r => (r.labels || []).includes(label.id)).map(r => r.id)) === JSON.stringify([newest.id]), JSON.stringify(inbox.map(r => [r.id, r.labels])))
  const chip = await page.locator(`.msg-row[data-id="${newest.id}"] .label-chip`).waitFor({ timeout: 10_000 }).then(() => true, () => false)
  check('run 1: the main window\'s row shows the chip', chip)
  check('run 1: no label made, renamed or deleted', (await page.evaluate(() => window.shadowMail.labels.list())).labels.length === 1)
  const lists = second.calls.filter(c => ['mcp__shadowmail__list_messages', 'mcp__shadowmail__search_messages'].includes(c.name) && c.input && typeof c.input.label === 'string')
  check('run 2: the model listed by the label filter', lists.some(c => !c.isError && c.input.label.toLowerCase() === 'teszt'), JSON.stringify(second.calls.map(c => [c.name, c.input])))
  const seen = second.calls.map(c => String(c.result || '')).join('\n')
  check('run 2: the tool result\'s TEXT showed the model the label and the message', seen.includes('címkék: Teszt') && seen.includes(KNOWN.subject))
  check('run 2: the answer names the labelled message', second.final.includes(KNOWN.subject) || second.final.includes('irodai szék'), second.final.slice(0, 300))
  console.log(`RUN 1 ANSWER:\n${first.final}`)
}

// the test app never gets the caller's Claude login: only the claude child below needs it
const { CLAUDE_CODE_OAUTH_TOKEN: _token, ANTHROPIC_API_KEY: _apiKey, ...appEnv } = process.env
const app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...appEnv, SHADOWMAIL_DATA: dataDir } })
try {
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: 'Feloldás', exact: true }).click()
  await page.locator('.msg-row[data-id]').first().waitFor({ timeout: 30_000 })
  await page.evaluate(() => window.shadowMail.mcp.setEnabled(true))
  for (let i = 0; i < 50 && !(await page.evaluate(async () => (await window.shadowMail.mcp.status()).running)); i++) await new Promise(r => setTimeout(r, 100))

  // the child: minimal environment, isolated config, the caller's own login
  const childEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: process.env.LANG || 'C.UTF-8',
    CLAUDE_CONFIG_DIR: cfgDir,
    TELEGRAM_STATE_DIR: tgDir,
    ...(process.env.CLAUDE_CODE_OAUTH_TOKEN ? { CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN } : { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }),
  }
  // one claude -p run (one prompt): its events, tool calls with their results, the answer, the init line
  const ask = async promptText => {
    const events = []
    const args = ['-p', promptText, '--mcp-config', mcpConfig, '--strict-mcp-config', '--tools', '', '--allowedTools', 'mcp__shadowmail', '--output-format', 'stream-json', '--verbose']
    const t0 = performance.now()
    await new Promise((resolve, reject) => {
      const child = spawn(values.claude, args, { cwd: work, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
      let buf = ''
      let err = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', d => {
        buf += d
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim()
          buf = buf.slice(i + 1)
          if (line) events.push(JSON.parse(line))
        }
      })
      child.stderr.on('data', d => (err += d))
      const timer = setTimeout(() => child.kill('SIGKILL'), 300_000)
      child.on('error', reject)
      child.on('exit', code => {
        clearTimeout(timer)
        if (code !== 0) console.log(`claude exited ${code}: ${err.slice(0, 500)}`)
        resolve()
      })
    })
    console.log(`claude -p took ${Math.round((performance.now() - t0) / 1000)} s, ${events.length} events`)
    if (values.out) fs.appendFileSync(values.out, events.map(e => JSON.stringify(e)).join('\n') + '\n')

    // the tool calls and their results, as the model got them
    const calls = []
    for (const e of events) {
      for (const c of e.message?.content || []) {
        if (e.type === 'assistant' && c.type === 'tool_use') calls.push({ id: c.id, name: c.name, input: c.input })
        if (e.type === 'user' && c.type === 'tool_result') {
          const call = calls.find(x => x.id === c.tool_use_id)
          const text = Array.isArray(c.content) ? c.content.map(x => x.text || JSON.stringify(x)).join('') : String(c.content)
          if (call) Object.assign(call, { result: text, isError: c.is_error === true })
        }
      }
    }
    for (const c of calls) console.log(`CALL ${c.name} ${JSON.stringify(c.input)}\n  -> ${c.isError ? 'ERROR ' : ''}${String(c.result).slice(0, 600).replace(/\s+/g, ' ')}`)
    const final = events.filter(e => e.type === 'result').map(e => e.result).join('\n')
    console.log(`ANSWER:\n${final}`)
    const init = events.find(e => e.type === 'system' && e.subtype === 'init')
    console.log(`tools available to the model: ${init ? (init.tools || []).join(', ') : '?'}`)
    return { events, calls, final, init }
  }
  let events, calls, final, init
  if (values.labels) {
    // the label (only the user makes one): then the two prompts of the card, each its own claude -p run
    await page.evaluate(() => window.shadowMail.labels.create('Teszt', '#00897b'))
    const first = await ask(LABEL_PROMPTS[0])
    const second = await ask(LABEL_PROMPTS[1])
    ;({ events, calls, final, init } = second)
    await labelChecks(page, first, second)
  } else {
    ;({ events, calls, final, init } = await ask(prompt))
  }

  check('the model used the ShadowMail tools', calls.some(c => c.name.startsWith('mcp__shadowmail__')))
  check('only ShadowMail tools were available', init && (init.tools || []).every(t => t.startsWith('mcp__shadowmail__')), init ? (init.tools || []).join(',') : '')
  if (values.labels) {
    // checked in labelChecks (both runs)
  } else if (values.show) {
    // the model showed the search; the app shows the sender's two recent messages as hits (not the two-year-old one)
    const shows = calls.filter(c => c.name === 'mcp__shadowmail__show_search')
    check('the model called show_search (no error)', shows.some(c => !c.isError), JSON.stringify(shows.map(c => [c.input, c.isError])))
    const want = [KNOWN.subject, 'Székek: a szállítás időpontja'].sort()
    let got = []
    for (let i = 0; i < 50 && JSON.stringify(got) !== JSON.stringify(want); i++) {
      got = (await page.locator('.result-list .result .result-subject').allInnerTexts()).map(t => t.trim()).sort()
      if (JSON.stringify(got) !== JSON.stringify(want)) await new Promise(r => setTimeout(r, 200))
    }
    check('the app shows the search: her two recent messages are the hits, the two-year-old one is not', JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got))
    const ui = await page.evaluate(() => ({
      search: document.querySelector('.app-header-search input[type="search"]')?.value ?? null,
      chips: [...document.querySelectorAll('.search-chips button.chip')].filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.textContent.trim()),
    }))
    console.log(`the window: ${JSON.stringify(ui)}`)
    check('the sender is in the search box or its chip, and a date chip is on', (/kovács|ilona/i.test(ui.search) || ui.chips.some(t => /kovács|ilona/i.test(t))) && ui.chips.some(t => t.startsWith('Bármikor')), JSON.stringify(ui))
    const answers = shows.map(c => String(c.result || '')).join('\n')
    check('the tool result held no subject or text', !answers.includes(KNOWN.subject) && !answers.includes('szállítás'), answers.slice(0, 300))
  } else if (values.open) {
    // the model found the message and opened it with the right id; the app shows it and it is read
    const accounts = await page.evaluate(() => window.shadowMail.accounts.list())
    const acc = accounts.accounts[0]
    const inbox = await page.evaluate(q => window.shadowMail.mail.list(q), { accountId: acc.id, folder: 'INBOX', limit: 50 })
    const known = (inbox.rows || []).find(r => r.subject === KNOWN.subject)
    const opens = calls.filter(c => c.name === 'mcp__shadowmail__open_message')
    check('the model called open_message with the known message\'s id', known && opens.some(c => c.input && c.input.message_id === known.id && !c.isError), JSON.stringify(opens.map(c => [c.input, c.isError])))
    const shown = await page.locator('.reader-subject', { hasText: KNOWN.subject }).waitFor({ timeout: 10_000 }).then(() => true, () => false)
    check('the app shows the message in the reader (.reader-subject)', shown)
    let flags = ''
    for (let i = 0; i < 20 && !flags.includes('\\Seen'); i++) {
      const rows = (await page.evaluate(q => window.shadowMail.mail.list(q), { accountId: acc.id, folder: 'INBOX', limit: 50 })).rows || []
      flags = rows.find(r => r.subject === KNOWN.subject)?.flags || ''
      if (!flags.includes('\\Seen')) await new Promise(r => setTimeout(r, 200))
    }
    check('the message is read now', flags.includes('\\Seen'), flags)
  } else {
    // what the model SAW in the tool results (the prompt itself names the subject, so the answer alone proves nothing there)
    const seen = calls.map(c => String(c.result || '')).join('\n')
    check('a tool result showed the model the subject, the sender and the text', seen.includes(KNOWN.subject) && seen.includes(KNOWN.addr) && seen.includes(KNOWN.first))
    check('the answer names the sender', final.includes(KNOWN.from) || final.includes(KNOWN.addr))
    check('the answer gives the first sentence', final.includes('tizenkét irodai szék'))
  }
  if (values.chain) {
    const draft = calls.find(c => c.name === 'mcp__shadowmail__create_reply_draft')
    check('the model made a reply draft with its own ids', draft && !draft.isError, draft ? String(draft.result).slice(0, 200) : 'no create_reply_draft call')
    const accounts = await page.evaluate(() => window.shadowMail.accounts.list())
    const acc = accounts.accounts[0]
    const drafts = await page.evaluate(q => window.shadowMail.mail.list(q), { accountId: acc.id, folder: 'Drafts', limit: 50 })
    check('the draft is in the Drafts folder, a reply to the known message', drafts.ok && drafts.rows.some(r => /irodai szék/.test(r.subject || '')), JSON.stringify((drafts.rows || []).map(r => r.subject)))
  }
} catch (err) {
  check('the run', false, err.stack)
} finally {
  await app.close().catch(() => {})
  await pop.close?.()
  for (const d of [work, cfgDir, tgDir]) fs.rmSync(d, { recursive: true, force: true })
}
const ok = results.filter(Boolean).length
console.log(`${ok} / ${results.length} ${ok === results.length ? 'OK' : 'FAIL'}`)
process.exit(ok === results.length ? 0 : 1)
