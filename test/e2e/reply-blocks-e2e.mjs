#!/usr/bin/env node
// Reply and Forward in the real app, on long alternating text/plain bodies. Not part of `npm test`.
//
//   node test/e2e/reply-blocks-e2e.mjs [--patterns heb,emoji] [--modes reply,forward] [--runs 5] [--html] [--watchdog] [--cases] [--spaced] [--switches] [--measure-only]
//
// The patterns (x + U+202E, U+05D0, U+FE0F, U+1F600, U+0300, a lone CR, a TAB), 2 MB text/plain each.
// A run: the message open in the reader, the Válasz / Továbbítás button, until the composer holds the body (over 1 000 000
// characters of text in the editor) and drew a frame. Each run must be ready within 5000 ms; after it the composer closes
// and another message opens within 500 ms. A run that is not ready within 30 s counts as failed, and the app is restarted.
// every run has the main process's dialog.showMessageBox replaced (app.evaluate), so the bomb question and
// notice are recorded (text, buttons, parent window) and answered. Plain text: the 2 MB Hebrew may end in the watchdog's
// notice instead of a ready composer (the sample is itself a bomb); never a freeze; any other pattern: no notice.
// --html: the Hebrew and the emoji 2 MB one-paragraph HTML: Válasz / Továbbítás asks in the main window within
// 2000 ms and no composer window ever shows (the page measures, its window stays hidden); [Mégse]: no window;
// [Idézet nélkül]: the composer is ready within 2000 ms with the header line and the omitted line (no character of the
// body); another message within 500 ms; the main process answers within 500 ms.
// --cases: 2 MB bodies the old static check let through, text without spaces (x + U+05D0;
// spaced Hebrew of that size is no bomb): split by td / tr / th / h4 / h5 / h6 / hr, <p x'>, <!-->, <!x '>,
// <head>, <textarea>, <noscript>, <select>: each asks within 2000 ms, no composer window shows; a normal newsletter does not.
// ASCII whitespace breaks a run outside a <pre>, NBSP does not: the bypasses split by NBSP still ask; the
// "news" table (400 rows of spaced text in cells, no p / div / br) asks nothing, Válasz and Továbbítás.
// --spaced: (a) spaced Hebrew-Latin 2 MB in one <p>; (b) 2 MB in one <p>, no-space x + U+05D0 pieces of N-1 and of 1000
// characters separated by a space. They pass N, but every one has far more than B direction switches in its block: the
// B question within 2 s, no composer window, the main process answers within 500 ms meanwhile.
// --switches (B): every switch kind (Hebrew-Latin, Arabic-Latin, Hebrew-digit, Hebrew-Arabic-Indic digit, Latin letters in
// isolates) at exactly B (no question, the composer ready within 2 s) and at B + 10 000 (the B question within 2 s, no
// window); the 2 MB spaced Hebrew-Latin, in one <p> and with a <br> every ~1000 characters (the question); a 2 MB spaced
// Latin paragraph and the normal messages of the earlier bomb measurement (no question, the composer ready); seven
// pairs of characters an earlier class list passed over as neutral (128 006 characters each: the question).
// --watchdog: SHADOWMAIL_TEST_COMPOSE_TIMEOUT_MS=200 and a long, normal HTML (~1 s on Linux; the shape check lets it
// through): the composer window is gone within T + 2000 ms, the notice in the main window, the session ended,
// no new message anywhere (no draft); another message within 500 ms; then, with the normal T, a Válasz works.
// --measure-only: print, no check.
// The characters are made with String.fromCodePoint (no invisible character in this file).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { t, seedLanguage } from './lang.mjs'

const { values } = parseArgs({
  options: {
    patterns: { type: 'string', default: 'rlo,heb,vs16,emoji,comb,cr,tab' },
    modes: { type: 'string', default: 'reply,forward' },
    runs: { type: 'string', default: '5' },
    html: { type: 'boolean', default: false },
    watchdog: { type: 'boolean', default: false },
    cases: { type: 'boolean', default: false },
    spaced: { type: 'boolean', default: false },
    switches: { type: 'boolean', default: false },
    'measure-only': { type: 'boolean', default: false },
    'no-layout': { type: 'boolean', default: false },
  },
})
const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const cp = n => String.fromCodePoint(n)
const MB2 = 2 * 1024 * 1024
const PATTERNS = { rlo: cp(0x202e), heb: cp(0x5d0), vs16: cp(0xfe0f), emoji: cp(0x1f600), comb: cp(0x300), cr: String.fromCharCode(13), tab: String.fromCharCode(9) }
const fill = (unit, bytes) => unit.repeat(Math.floor(bytes / Buffer.byteLength(unit)))
const RUNS = Number(values.runs)
const READY_MS = 5000
// the 2 MB Hebrew is itself a bomb, the bomb check handles it; its limit is 8000 ms, the others 5000
const READY = k => (k === 'heb' ? 8000 : READY_MS)
const NEXT_MS = 500
const BUTTON = { reply: t.replyModes.reply, forward: t.replyModes.forward }
const patterns = values.watchdog || values.cases || values.spaced || values.switches ? [] : values.html ? ['heb', 'emoji'] : values.patterns.split(',').filter(k => PATTERNS[k])
const V1_MS = 2000 // the question, and the composer without the quote
const WATCH_T = 200 // --watchdog: the lowered T
const RUN_LIMIT_MS = 90_000 // --html: one run (both questions, the composer, another message) or FAIL
const OMITTED = t.composeBodyOmitted
// the main process's texts as patterns: the number (seconds, characters) as any number
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const anyNumber = s => new RegExp(reEsc(s).replace('987', '[\\d.,\\s\\u00a0\\u202f]+'))
// the watchdog's notice, any kind; "... sem nyílt meg, ezért bezártam"
const STALLED_RES = ['reply', 'forward', 'draft', 'new', 'mailto'].flatMap(kind => [987, 1].map(n => anyNumber(t.composeStalled(kind, n))))
const STALLED = { test: m => STALLED_RES.some(re => re.test(m)) }
// the bomb question of a reply or a forward; "... tördeletlen szövegrészt ..."
const SUSPECT_RES = ['reply', 'replyAll', 'forward'].map(mode => anyNumber(t.composeSuspectText(mode, 987)))
const SUSPECT = { test: m => SUSPECT_RES.some(re => re.test(m)) }
// the question of B (one paragraph with too many direction switches): its own text
const SLOW_TEXTS = ['reply', 'replyAll', 'forward'].map(mode => t.composeSuspectSlowText(mode))
const SLOW = { test: m => SLOW_TEXTS.includes(m) }
// the outgoing quote's header line in the editor ("... írta:") and the forwarded block's ("Továbbított üzenet")
const QUOTE_HEAD = { wrote: t.outgoingQuote.wrote('').trim(), forwarded: t.outgoingQuote.forwarded }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const modes = values.modes.split(',').filter(m => BUTTON[m])

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-r3-e2e-'))
const emlDir = path.join(work, 'eml')
const dataDir = path.join(work, 'data')
fs.mkdirSync(emlDir)
const date = new Date().toUTCString()
const eml = (name, type, body) =>
  fs.writeFileSync(path.join(emlDir, name), Buffer.concat([Buffer.from(`From: Valasz <valasz@example.invalid>\r\nTo: r3-to@example.invalid\r\nSubject: Valasz ${name}\r\nDate: ${date}\r\nMessage-ID: <${name}@example.invalid>\r\nMIME-Version: 1.0\r\nContent-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n`), Buffer.from(body)]))
eml('z-small.eml', 'text/plain', 'Kicsi, közönséges levél.\r\n')
// the layout check: a long text of lines with empty lines (several blocks), as a real letter would be
const LAYOUT_TEXT = Array.from({ length: 1500 }, (_, i) => (i % 9 === 0 ? '' : `Ez a(z) ${i}. sor egy hosszabb, valódi levélben & <jelekkel>.`)).join('\r\n')
eml('m-lines.eml', 'text/plain', LAYOUT_TEXT)
// a small letter with a long run of empty lines (the carry of empty lines was quadratic in the main process)
eml('n-run.eml', 'text/plain', `${'\n'.repeat(160_000)}x\n${'z\n'.repeat(1500)}`)
// --watchdog: a long, normal HTML (the generated one of the normal-mail measurement: ~1 s to a ready composer on Linux)
const { newsletterHtml } = await import('../helpers/newsletter.js')
if (values.watchdog || values.cases) eml('w-long-html.eml', 'text/html', `<html><body>${newsletterHtml({ blocks: 3000, rules: 20 })}</body></html>`)
// --cases: what the composer's sanitizer joins (or keeps) into one 2 MB run; the text has no space (x + U+05D0)
const CHUNK = `x${PATTERNS.heb}`.repeat(500) // 1000 characters
const BIG = fill(`x${PATTERNS.heb}`, MB2)
// 1000 characters: no-space pieces of 10 joined by NBSP (U+00A0)
const NB_CHUNK = Array.from({ length: 91 }, () => `x${PATTERNS.heb}`.repeat(5)).join(String.fromCodePoint(0xa0)).slice(0, 1000)
const split = sep => `<p>${`${CHUNK}${sep}`.repeat(2000)}</p>`
// the table cases: the main process's parseMessage used to take ~1.5 s on these 2 MB tables before any window (mailparser's
// HTML -> text, quadratic in a table's text); it no longer converts the HTML, so they have the shape check's own limit again
const TABLE_CASES = new Set(['td', 'tr', 'th'])
const TABLE_MS = V1_MS
const CASES = {
  td: `<table><tr>${`<td>${CHUNK}</td>`.repeat(2000)}</tr></table>`,
  tr: split('<tr>'),
  th: split('<th>'),
  h4: `${`<h4>${CHUNK}</h4>`.repeat(2000)}`,
  h5: `${`<h5>${CHUNK}</h5>`.repeat(2000)}`,
  h6: `${`<h6>${CHUNK}</h6>`.repeat(2000)}`,
  hr: split('<hr>'),
  'p-quote-name': `<p x'>${BIG}</p><p>'</p>`,
  'empty-comment': `<!-->${BIG}-->`,
  'bogus-comment': `<!x '>${BIG}'>`,
  head: `<p>a</p><head>${BIG}`,
  textarea: `<textarea>${`${CHUNK}<br>`.repeat(2000)}</textarea>`,
  noscript: `<noscript>${BIG}</noscript>`,
  select: `<select><option>${BIG}</option></select>`,
  // NBSP is no break: split by it, they are still one run
  'td-nbsp': `<table><tr>${`<td>${NB_CHUNK}</td>`.repeat(2000)}</tr></table>`,
  'hr-nbsp': `<p>${`${NB_CHUNK}<hr>`.repeat(2000)}</p>`,
  'h4-nbsp': `${`<h4>${NB_CHUNK}</h4>`.repeat(2000)}`,
  'p-quote-name-nbsp': `<p x'>${Array.from({ length: 2000 }, () => CHUNK).join(String.fromCodePoint(0xa0))}</p>`,
  // the form feed is no break: 2 MB in one <p>, 30 000-character pieces split by U+000C
  'p-formfeed': `<p>${Array.from({ length: Math.floor(MB2 / 30_001) }, () => `x${PATTERNS.heb}`.repeat(15_000)).join(String.fromCharCode(12))}</p>`,
}
if (values.cases) for (const [k, html] of Object.entries(CASES)) eml(`k-${k}.eml`, 'text/html', `<html><body>${html}</body></html>`)
const TABLE_NBSP = new Set(['td-nbsp'])
// the "news" table: normal mail, no question
const { newsTableHtml } = await import('../helpers/bomb-samples.js')
if (values.cases) eml('n-news.eml', 'text/html', `<html><body>${newsTableHtml()}</body></html>`)
// --spaced: (a) spaced Hebrew; (b) no-space pieces of N-1 and of 1000 characters separated by a space
const piece = n => `x${PATTERNS.heb}`.repeat(Math.floor(n / 2)) + (n % 2 ? 'x' : '')
const SPACED = {
  'a-spaced-hebrew': `<p>${Array.from({ length: Math.floor(MB2 / 22) }, () => `x${PATTERNS.heb}`.repeat(5)).join(' ')}</p>`,
  'b-pieces-39999': `<p>${Array.from({ length: Math.floor(MB2 / 60_000) }, () => piece(39_999)).join(' ')}</p>`,
  'b-pieces-1000': `<p>${Array.from({ length: Math.floor(MB2 / 1500) }, () => piece(1000)).join(' ')}</p>`,
}
if (values.spaced) for (const [k, html] of Object.entries(SPACED)) eml(`s-${k}.eml`, 'text/html', `<html><body>${html}</body></html>`)
// --switches (B): every direction-switch kind at exactly B (no question, the composer ready <= 2 s) and at B + 10 000 (the
// question); the 2 MB spaced Hebrew-Latin in one <p> and with a <br> every ~1000 characters (the question); a 2 MB spaced
// Latin paragraph and the normal messages (no question)
const { switchText, SWITCH_KINDS, writeNormal, BYPASS_PAIRS, DIGIT_PAIRS, pairText } = await import('../helpers/bomb-samples.js')
const B = 50_000
const NORMAL = []
if (values.switches) {
  for (const k of SWITCH_KINDS) {
    eml(`x-${k}-at.eml`, 'text/html', `<html><body><p>${switchText(k, B)}</p></body></html>`)
    eml(`x-${k}-over.eml`, 'text/html', `<html><body><p>${switchText(k, B + 10_000)}</p></body></html>`)
  }
  const hl = Array.from({ length: Math.floor(MB2 / 11) }, () => `x${PATTERNS.heb}`.repeat(5))
  eml('x-hl-2m.eml', 'text/html', `<html><body><p>${hl.join(' ')}</p></body></html>`)
  eml('x-hl-2m-br.eml', 'text/html', `<html><body><p>${hl.map((w, i) => (i % 91 === 90 ? `${w}<br>` : `${w} `)).join('')}</p></body></html>`)
  eml('x-latin-2m.eml', 'text/html', `<html><body><p>${Array.from({ length: Math.floor(MB2 / 11) }, () => 'arviztukorf').join(' ')}</p></body></html>`)
  NORMAL.push(...writeNormal(emlDir).map(([file]) => file))
  // the characters a hand-made class list passed over (RLM, LRM, a superscript, a circled letter, a spacing mark, two
  // Arabic number signs, an Extended Arabic-Indic digit, the danda): 128 006 characters each; the watchdog closed them, now they ask
  for (const [k, pair] of Object.entries(BYPASS_PAIRS)) eml(`x-bypass-${k}.eml`, 'text/html', `<html><body><p>${pairText(pair, 128_006)}</p></body></html>`)
  // Latin and digits alternating (an EN after L is L): no question, the composer ready <= 2 s; Hebrew and digits: the question
  eml('x-digits-latin.eml', 'text/html', `<html><body><p>${pairText(DIGIT_PAIRS.LATIN, 128_000)}</p></body></html>`)
  eml('x-digits-hebrew.eml', 'text/html', `<html><body><p>${pairText(DIGIT_PAIRS.HEBREW, 128_000)}</p></body></html>`)
}
const fileOf = k => (values.html ? `h-${k}-2m.eml` : `p-${k}-2m.eml`)
for (const k of patterns) {
  if (values.html) eml(fileOf(k), 'text/html', `<p>${fill(`x${PATTERNS[k]}`, MB2 - 7)}</p>`)
  else eml(fileOf(k), 'text/plain', fill(`x${PATTERNS[k]}`, MB2))
}
const seed = JSON.parse(execFileSync(process.execPath, [path.join(repo, 'test', 'tools', 'seed-index.mjs'), dataDir, '--count', '3', '--eml', emlDir], { encoding: 'utf8' }))
seedLanguage(dataDir)
const idOf = file => seed.eml.find(e => e.file === file).id
const race = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r(null), ms))])

async function launch(extraEnv = {}) {
  const app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir, ...extraEnv } })
  // the main process's message boxes recorded and answered (button index globalThis.__v1.answer, the last if out of range)
  await app.evaluate(({ app: electronApp, dialog, BrowserWindow }) => {
    globalThis.__v1 = { asked: [], answer: 1, shown: 0 }
    // a suspect composer never shows; every composer window's show is counted
    electronApp.on('browser-window-created', (_e, w) => w.on('show', () => String(w.webContents.getURL()).includes('#compose') && globalThis.__v1.shown++))
    dialog.showMessageBox = async (...args) => {
      const o = args[args.length - 1]
      const parent = args.length > 1 ? args[0] : null
      globalThis.__v1.asked.push({ message: o.message, buttons: o.buttons, parentIsMain: Boolean(parent && BrowserWindow.getAllWindows()[0] && !String(parent.webContents.getURL()).includes('#compose')) })
      return { response: Math.min(globalThis.__v1.answer, o.buttons.length - 1), checkboxChecked: false }
    }
  })
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.locator('#vault-unlock').fill(seed.master)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  await page.locator('.msg-row[data-id]').first().waitFor({ timeout: 30_000 })
  return { app, page }
}
const close = async app => {
  await race(app.close(), 5000).catch(() => {})
  try {
    app.process().kill('SIGKILL')
  } catch {}
}
const frame = p => p.evaluate(() => new Promise(r => requestAnimationFrame(() => r())))
const asked = app => app.evaluate(() => globalThis.__v1.asked)
const answer = (app, i) => app.evaluate((_, n) => (globalThis.__v1.answer = n), i)
const stalls = async app => (await asked(app)).filter(a => STALLED.test(a.message))
// the main log's line of a composer the watchdog closed ("compose: the composer was not ready in 5000 ms, closed (reply)")
const WATCHDOG_CLOSED = /compose: the composer was not ready in \d+ ms, closed/
const watchdogClosed = () => {
  try {
    return fs.readFileSync(path.join(dataDir, 'electron', 'logs', 'main.log'), 'utf8').split('\n').filter(l => WATCHDOG_CLOSED.test(l))
  } catch {
    return []
  }
}
const shown = app => app.evaluate(() => globalThis.__v1.shown)
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
  return { stop: async () => ((on = false), await loop, longest) }
}
// waits until fn() is true (polled every 50 ms) -> the ms since t0, or Infinity after `ms`
async function until(fn, t0, ms) {
  while (performance.now() - t0 < ms) {
    if (await fn()) return performance.now() - t0
    await sleep(50)
  }
  return Infinity
}
// the number of messages in every folder (no draft may appear): the folder list's counts
const totals = page => page.evaluate(async () => {
  const r = await window.shadowMail.mail.folders()
  return JSON.stringify((r.accounts || []).map(a => (a.folders || []).map(f => [f.path, f.total ?? f.count ?? null])))
})
async function openReader(page, file, body) {
  const id = idOf(file)
  if (await page.locator('.reader-back').count()) await page.locator('.reader-back').click()
  const t0 = performance.now()
  await page.locator(`.msg-row[data-id="${id}"]`).click()
  const ok = await race(page.locator(`.reader[data-message-id="${id}"] ${body}`).waitFor({ timeout: 30_000 }).then(() => frame(page)).then(() => true, () => false), 31_000)
  return ok ? performance.now() - t0 : Infinity
}
// the button -> the composer window holds the body and drew a frame; { ms, win } or { ms: Infinity, win: null }
async function compose(app, page, mode, minChars = 1_000_000, minBreaks = 0) {
  const t0 = performance.now()
  const win = await race((async () => {
    const [w] = await Promise.all([app.waitForEvent('window', { timeout: 30_000 }), page.locator('.reader-tools').getByRole('button', { name: BUTTON[mode], exact: true }).click()])
    // the window loads its page after the event: the empty editor first (that alone is no measure: it is up in ~0.2 s
    // while the body still freezes the renderer), then the body
    await w.setViewportSize({ width: 1000, height: 700 }) // headless: a window is 0 x 0 and every element "hidden"
    await w.locator('.editor').waitFor({ timeout: 30_000 })
    // the body is in: its text, or (an empty-line run is no text) its line breaks
    await w.waitForFunction(([n, b]) => (b ? document.querySelectorAll('.editor br').length > b : (document.querySelector('.editor')?.textContent.length || 0) > n), [minChars, minBreaks], { timeout: 30_000, polling: 100 })
    await frame(w)
    return w
  })().catch(() => null), 31_000)
  return win ? { ms: performance.now() - t0, win } : { ms: Infinity, win: null }
}
// the composer's own close button; a "Bezárod a levelet?" question is answered with Elvetés
async function closeComposer(win) {
  const closed = win.waitForEvent('close', { timeout: 15_000 }).then(() => true, () => false)
  await win.getByRole('button', { name: t.composeCloseWindow, exact: true }).click({ timeout: 5000 }).catch(() => {})
  const ask = win.getByRole('button', { name: t.composeDiscard, exact: true })
  await race(ask.click({ timeout: 3000 }).catch(() => {}), 3500)
  return race(closed, 16_000)
}
const fmt = ms => (ms === -1 ? 'the reader did not open' : ms === -2 ? 'closed by the watchdog' : ms === Infinity ? 'not ready in 30 s' : `${Math.round(ms)} ms`)

try {
  const body = values.html ? 'iframe.mail-frame' : 'pre.mail-text'
  // Válasz and Továbbítás on the empty-line run, the main process pinged every 250 ms meanwhile
  if (!values.html && !values.watchdog && !values.cases && !values.spaced && !values.switches && !values['no-layout']) {
    const s = await launch()
    try {
      for (const mode of ['reply', 'forward']) {
        await openReader(s.page, 'n-run.eml', 'pre.mail-text')
        const closedBefore = watchdogClosed().length
        let longest = 0
        let last = performance.now()
        let pinging = true
        const ping = (async () => {
          while (pinging) {
            await s.app.evaluate(() => 1)
            const now = performance.now()
            longest = Math.max(longest, now - last)
            last = now
            await new Promise(r => setTimeout(r, 250))
          }
        })()
        const { ms, win } = await compose(s.app, s.page, mode, 0, 150_000)
        pinging = false
        await ping
        const gone = win ? await closeComposer(win) : false
        // A guard against a quadratic regression, not a speed measurement. The quadratic quote builder ran in the main
        // process and froze the whole app for ~23 s here; the main-process ping (longest gap <= 500 ms) is what catches
        // that (measured on the quadratic code: a 31-32 s gap). Alone the composer is ready in ~2.0 s (1960-1983 ms on
        // Linux, the longest gap 254 ms); "ready <= 6000 ms" keeps the intent with room for a busy machine. Under a heavy
        // parallel load the composer takes ~5 s, and the product's own watchdog (5000 ms) may close it first: that is
        // reported as a warning, not a failure, and the ping must still hold.
        const closed = watchdogClosed().slice(closedBefore)
        if (!win && closed.length) {
          console.log(`WARN empty-line run (160 000) ${mode}: the composer was closed by the product's watchdog before it was ready (the longest main-process gap ${Math.round(longest)} ms): ${closed.at(-1).trim()}`)
          check(`empty-line run (160 000) ${mode}: the main process answers within 500 ms meanwhile (the composer closed by the watchdog)`, longest <= 500, `the longest main-process gap ${Math.round(longest)} ms`)
        } else {
          check(`empty-line run (160 000) ${mode}: ready <= 6000 ms, the main process answers within 500 ms meanwhile`, ms <= 6000 && longest <= 500 && gone, `${fmt(ms)}, the longest main-process gap ${Math.round(longest)} ms`)
        }
      }
    } finally {
      await close(s.app)
    }
  }
  // (2.) the composer shows the blocks as the old one <p> did: the same line breaks (innerText); the height is reported
  if (!values['no-layout'] && !values.html && !values.watchdog && !values.cases && !values.spaced && !values.switches) {
    const s = await launch()
    try {
      await openReader(s.page, 'm-lines.eml', 'pre.mail-text')
      const { win } = await compose(s.app, s.page, 'reply', 50_000)
      const esc = x => x.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
      const oldBody = `<p>${esc(LAYOUT_TEXT).replace(/\r?\n/g, '<br>')}</p>`
      const r = win && (await win.evaluate(oldHtml => {
        const bq = document.querySelector('.editor blockquote')
        const ref = document.createElement('blockquote')
        ref.innerHTML = oldHtml
        bq.after(ref)
        const out = { blocks: bq.querySelectorAll('div > div').length, same: bq.innerText === ref.innerText, newH: bq.getBoundingClientRect().height, oldH: ref.getBoundingClientRect().height }
        ref.remove()
        return out
      }, oldBody))
      check('the composer: the quote of a long letter in blocks has the old line breaks (innerText equal to the old <p>)', r && r.blocks > 1 && r.same, JSON.stringify(r))
      if (r) console.log(`MEASURED layout: the quote is ${Math.round(r.newH)} px high in blocks, ${Math.round(r.oldH)} px as the old <p> (difference ${Math.round(r.oldH - r.newH)} px)`)
    } finally {
      await close(s.app)
    }
  }
  // --html: the shape check's question in the main window, [Mégse] and [Idézet nélkül]
  if (values.html) {
    for (const k of patterns) {
      for (const mode of modes) {
        const s = await launch()
        const rows = []
        let ok = true
        try {
          for (let i = 0; i < RUNS; i++) {
            // one run within RUN_LIMIT_MS: a frozen composer's renderer never answers a CDP call (setViewportSize, evaluate),
            // so without the bound the old code hung here instead of failing (negctl-v1.py, measured 2026-11-14)
            const once = async () => {
              const ping = pinger(s.app)
              const button = () => s.page.locator('.reader-tools').getByRole('button', { name: BUTTON[mode], exact: true })
              // [Mégse]
              const shownBefore = await shown(s.app)
              await openReader(s.page, fileOf(k), body)
              await answer(s.app, 1)
              let n = (await asked(s.app)).length
              let t0 = performance.now()
              await button().click()
              const askCancel = await until(async () => (await asked(s.app)).length > n, t0, 30_000)
              await sleep(700)
              const winsAfterCancel = s.app.windows().length
              const shownAfterCancel = (await shown(s.app)) - shownBefore
              const q = (await asked(s.app))[n]
              // [Idézet nélkül]
              await answer(s.app, 0)
              n = (await asked(s.app)).length
              t0 = performance.now()
              const created = []
              const onWindow = x => created.push(x)
              s.app.on('window', onWindow)
              await button().click()
              const askOmit = await until(async () => (await asked(s.app)).length > n, t0, 30_000)
              await until(async () => created.length >= 2, t0, 30_000)
              s.app.off('window', onWindow)
              const w = created[1]
              await w.setViewportSize({ width: 1000, height: 700 })
              await w.locator('.editor').waitFor({ timeout: 30_000 })
              await w.waitForFunction(t => (document.querySelector('.editor')?.textContent || '').includes(t), OMITTED, { timeout: 30_000, polling: 50 })
              await frame(w)
              const readyOmit = performance.now() - t0
              const editor = await w.evaluate(([ch, head]) => {
                const t = document.querySelector('.editor').textContent
                return { hasBody: t.includes(ch), header: t.includes(head.wrote) || t.includes(head.forwarded), length: t.length }
              }, [PATTERNS[k], QUOTE_HEAD])
              const gone = await closeComposer(w)
              const next = gone ? await openReader(s.page, 'z-small.eml', 'pre.mail-text') : Infinity
              const gap = await ping.stop()
              const row = {
                askCancel: Math.round(askCancel), winsAfterCancel, shownAfterCancel, shownTotal: (await shown(s.app)) - shownBefore, askOmit: Math.round(askOmit), readyOmit: Math.round(readyOmit), next: Math.round(next), gap: Math.round(gap),
                question: Boolean(q && SUSPECT.test(q.message) && q.parentIsMain && JSON.stringify(q.buttons) === JSON.stringify([t.composeSuspectOmit, t.composeSuspectCancel])), ...editor,
              }
              return row
            }
            const row = await race(once(), RUN_LIMIT_MS)
            if (!row) {
              rows.push({ timeout: RUN_LIMIT_MS })
              ok = false
              break
            }
            rows.push(row)
            // shown once in the run: the window without the quote, never the suspect ones
            ok &&= row.shownAfterCancel === 0 && row.shownTotal === 1 && row.askCancel <= V1_MS && row.winsAfterCancel === 1 && row.askOmit <= V1_MS && row.readyOmit <= V1_MS && row.question && !row.hasBody && row.header && row.next <= NEXT_MS && row.gap <= 500
          }
          ok &&= (await stalls(s.app)).length === 0
        } catch (err) {
          ok = false
          console.log(err.stack)
        } finally {
          await close(s.app)
        }
        check(`HTML ${k} ${mode}: ${RUNS}/${RUNS} the question in the main window <= ${V1_MS} ms, [Mégse] no window, [Idézet nélkül] ready <= ${V1_MS} ms without the body, another message <= ${NEXT_MS} ms, main process gap <= 500 ms, no watchdog notice`, ok && rows.length === RUNS, JSON.stringify(rows))
      }
    }
  }
  // --watchdog: T lowered to 200 ms, a long normal HTML
  if (values.watchdog) {
    let s = await launch({ SHADOWMAIL_TEST_COMPOSE_TIMEOUT_MS: String(WATCH_T) })
    try {
      for (const mode of modes) {
        const rows = []
        let ok = true
        for (let i = 0; i < RUNS; i++) {
          const ping = pinger(s.app)
          await openReader(s.page, 'w-long-html.eml', 'iframe.mail-frame')
          const before = await totals(s.page)
          const n = (await stalls(s.app)).length
          const t0 = performance.now()
          const [w] = await Promise.all([s.app.waitForEvent('window', { timeout: 30_000 }), s.page.locator('.reader-tools').getByRole('button', { name: BUTTON[mode], exact: true }).click()])
          const session = /#compose=([0-9a-f-]{36})/.exec(w.url())?.[1] || (await w.waitForURL(/#compose=/, { timeout: 5000 }).then(() => /#compose=([0-9a-f-]{36})/.exec(w.url())?.[1], () => null))
          const gone = await until(async () => w.isClosed(), t0, WATCH_T + V1_MS + 3000)
          const notice = await until(async () => (await stalls(s.app)).length > n, t0, WATCH_T + V1_MS + 3000)
          const last = (await stalls(s.app))[n]
          // the session ends on the window's 'closed' (after the destroy, a moment after the notice): polled, not read once
          // (one run of 20 read it before)
          let sessionEnded = null
          if (session) {
            const t1 = performance.now()
            while (performance.now() - t1 < 2000) {
              sessionEnded = await s.page.evaluate(id => window.shadowMail.compose.initial(id), session)
              if (sessionEnded && sessionEnded.ok === false) break
              await sleep(50)
            }
          }
          await sleep(300)
          const after = await totals(s.page)
          const next = await openReader(s.page, 'z-small.eml', 'pre.mail-text')
          const gap = await ping.stop()
          const want = t.composeStalled(mode === 'forward' ? 'forward' : 'reply', WATCH_T / 1000)
          const row = {
            gone: Math.round(gone), notice: Math.round(notice), text: Boolean(last && last.message.includes(want) && last.parentIsMain), sessionEnded: Boolean(sessionEnded && sessionEnded.ok === false && sessionEnded.error === 'no_session'),
            noDraft: before === after, next: Math.round(next), gap: Math.round(gap),
          }
          rows.push(row)
          ok &&= row.gone <= WATCH_T + V1_MS && row.notice <= WATCH_T + V1_MS && row.text && row.sessionEnded && row.noDraft && row.next <= NEXT_MS && row.gap <= 500
        }
        check(`watchdog (T = ${WATCH_T} ms) ${mode}: ${RUNS}/${RUNS} the composer gone and the notice in the main window <= T + ${V1_MS} ms, the session ended, no draft, another message <= ${NEXT_MS} ms, main process gap <= 500 ms`, ok && rows.length === RUNS, JSON.stringify(rows))
      }
      // the normal T again: a Válasz on a normal message works and no notice comes
      await close(s.app)
      s = await launch()
      await openReader(s.page, 'w-long-html.eml', 'iframe.mail-frame')
      const { ms, win } = await compose(s.app, s.page, 'reply', 1000)
      if (win) await closeComposer(win)
      check('watchdog: with the normal T the same message replies (no notice)', win && ms <= 5000 && (await stalls(s.app)).length === 0, fmt(ms))
    } finally {
      await close(s.app)
    }
  }
  // --cases: the bodies the old static check let through ask now; a normal newsletter does not
  if (values.cases) {
    const s = await launch()
    try {
      for (const k of [...Object.keys(CASES), 'normal']) {
        const file = k === 'normal' ? 'w-long-html.eml' : `k-${k}.eml`
        const rows = []
        for (let i = 0; i < Math.min(RUNS, 3); i++) {
          await openReader(s.page, file, 'iframe.mail-frame')
          await answer(s.app, 1)
          const n = (await asked(s.app)).length
          const shownBefore = await shown(s.app)
          const t0 = performance.now()
          const created = []
          const onWindow = x => created.push(x)
          s.app.on('window', onWindow)
          await s.page.locator('.reader-tools').getByRole('button', { name: t.replyModes.reply, exact: true }).click()
          const ask = await until(async () => (await asked(s.app)).length > n, t0, k === 'normal' ? 3000 : 30_000)
          await sleep(500)
          s.app.off('window', onWindow)
          const q = (await asked(s.app))[n]
          const shownNow = (await shown(s.app)) - shownBefore
          // no question: the composer must show, ready, and hold no run over N (the sanitizer dropped the text: a noscript in
          // the quote's blockquote is dropped with its content, measured in Electron)
          const w = ask === Infinity ? created[0] : null
          const editorChars = w ? await w.waitForFunction(() => Boolean(document.querySelector('.editor blockquote')), null, { timeout: 10_000 }).then(() => w.evaluate(() => document.querySelector('.editor').textContent.length), () => -1) : null
          if (w && !w.isClosed()) await closeComposer(w)
          rows.push({ ask: ask === Infinity ? null : Math.round(ask), shown: shownNow, text: Boolean(q && SUSPECT.test(q.message)), editorChars })
        }
        const limit = TABLE_CASES.has(k) || TABLE_NBSP.has(k) ? TABLE_MS : V1_MS
        const asks = r => r.ask !== null && r.ask <= limit && r.shown === 0 && r.text
        // no question, the composer showed and is ready; for a bomb case its WHOLE text is under N (stricter than the run)
        const opened = r => r.ask === null && r.shown === 1 && r.editorChars >= 0
        const clean = r => opened(r) && r.editorChars < 40_000
        if (k === 'normal') check('cases: a normal newsletter: no question, the composer shows and is ready', rows.every(opened), JSON.stringify(rows))
        else check(`cases ${k}: the question <= ${limit} ms and no composer window, or (the sanitizer dropped the text) the composer without it`, rows.every(r => asks(r) || (k === 'noscript' && clean(r))), JSON.stringify(rows))
      }
      for (const mode of ['reply', 'forward']) {
        const rows = []
        for (let i = 0; i < Math.min(RUNS, 3); i++) {
          await openReader(s.page, 'n-news.eml', 'iframe.mail-frame')
          const n = (await asked(s.app)).length
          const t0 = performance.now()
          const [w] = await Promise.all([s.app.waitForEvent('window', { timeout: 30_000 }), s.page.locator('.reader-tools').getByRole('button', { name: BUTTON[mode], exact: true }).click()])
          await w.setViewportSize({ width: 1000, height: 700 })
          const ok = await w
            .waitForFunction(([m, forwarded]) => {
              const ed = document.querySelector('.editor')
              return m === 'reply' ? Boolean(ed && ed.querySelector('blockquote') && ed.textContent.includes('Heti hírek')) : Boolean(ed && ed.textContent.includes(forwarded) && ed.textContent.includes('Heti hírek'))
            }, [mode, QUOTE_HEAD.forwarded], { timeout: 10_000 })
            .then(() => true, () => false)
          rows.push({ ready: ok ? Math.round(performance.now() - t0) : null, asked: (await asked(s.app)).length > n })
          if (!w.isClosed()) await closeComposer(w)
        }
        check(`cases news table ${mode}: no question, a ready composer with the quote`, rows.every(r => r.ready !== null && !r.asked), JSON.stringify(rows))
      }
      check('cases: no watchdog notice', (await stalls(s.app)).length === 0)
    } finally {
      await close(s.app)
    }
  }
  // one Válasz on a message whose reader is open: -> { outcome: 'ready' | 'slow' | 'question' | 'notice' | 'neither', ms,
  // gap, shown }. 'ready': the composer holds >= minText characters and its forced layout returned (the window is sized
  // first: a headless window is 0 x 0); 'slow' / 'question': the B / the N question in the main window; 'notice': the
  // watchdog's. The main process is pinged meanwhile (gap: its longest silence).
  async function replyOutcome(s, file, minText, T = 5000) {
    await openReader(s.page, file, 'iframe.mail-frame')
    const n = (await asked(s.app)).length
    const shownBefore = await shown(s.app)
    const ping = pinger(s.app)
    const created = []
    const onWindow = x => created.push(x)
    s.app.on('window', onWindow)
    const t0 = performance.now()
    await s.page.locator('.reader-tools').getByRole('button', { name: t.replyModes.reply, exact: true }).click()
    let sized = false
    const outcome = await race(
      (async () => {
        while (performance.now() - t0 < T + 2000) {
          const a = (await asked(s.app)).slice(n)
          if (a.some(x => STALLED.test(x.message))) return 'notice'
          if (a.some(x => SLOW.test(x.message))) return 'slow'
          if (a.some(x => SUSPECT.test(x.message))) return 'question'
          const w = created[0]
          if (w && !w.isClosed()) {
            if (!sized) sized = await w.setViewportSize({ width: 1000, height: 700 }).then(() => true, () => false)
            const len = await race(w.evaluate(() => document.querySelector('.editor')?.textContent.length || 0).catch(() => 0), 1000)
            if (len && len >= minText) {
              const laid = await race(w.evaluate(() => document.querySelector('.editor').offsetHeight).then(() => true, () => false), T)
              if (laid) return 'ready'
            }
          }
          await sleep(50)
        }
        return 'neither'
      })(),
      T + 4000,
    )
    const ms = Math.round(performance.now() - t0)
    s.app.off('window', onWindow)
    const gap = Math.round(await ping.stop())
    const shownNow = (await shown(s.app)) - shownBefore
    const w = created[0]
    if (w && !w.isClosed()) await race(closeComposer(w), 20_000)
    return { outcome: outcome || 'neither', ms, gap, shown: shownNow }
  }
  // the spaced bombs (they passed N before B): with B they ask (its own text) within 2 s, no window, no freeze
  if (values.spaced) {
    for (const [k] of Object.entries(SPACED)) {
      const s = await launch()
      const rows = []
      try {
        for (let i = 0; i < Math.min(RUNS, 3); i++) rows.push(await replyOutcome(s, `s-${k}.eml`, 1_900_000))
      } finally {
        await close(s.app)
      }
      console.log(`MEASURED spaced ${k}: ${JSON.stringify(rows)}`)
      check(`spaced ${k}: the B question <= ${V1_MS} ms, no window, the main process gap <= 500 ms`, rows.every(r => r.outcome === 'slow' && r.ms <= V1_MS && r.shown === 0 && r.gap <= 500), JSON.stringify(rows))
    }
  }
  // B: exactly B switches -> no question, the composer ready <= 2 s; B + 10 000 -> the B question <= 2 s, no window;
  // the 2 MB spaced Hebrew-Latin (one <p>, and with <br>) -> the B question; Latin and the normal messages -> no question
  if (values.switches) {
    const s = await launch()
    try {
      // for the record (no check): the Unicode of this Electron, against the table's (core/mime/bidi-class.js); a newer one
      // is expected, its unassigned-here characters count on their own
      const versions = await s.app.evaluate(() => ({ unicode: process.versions.unicode, icu: process.versions.icu }))
      const { UNICODE_VERSION } = await import('../../core/mime/bidi-class.js')
      console.log(`MEASURED Unicode: Electron ${versions.unicode} (ICU ${versions.icu}), the table ${UNICODE_VERSION}`)
      const runs = Math.min(RUNS, 3)
      const each = async (file, minText) => {
        const rows = []
        for (let i = 0; i < runs; i++) rows.push(await replyOutcome(s, file, minText))
        return rows
      }
      for (const k of SWITCH_KINDS) {
        const at = await each(`x-${k}-at.eml`, Math.floor(switchText(k, B).length * 0.95))
        console.log(`MEASURED switches ${k} at B: ${JSON.stringify(at)}`)
        check(`switches ${k}: exactly B -> no question, the composer ready <= ${V1_MS} ms`, at.every(r => r.outcome === 'ready' && r.ms <= V1_MS && r.gap <= 500), JSON.stringify(at))
        const over = await each(`x-${k}-over.eml`, Number.MAX_SAFE_INTEGER)
        check(`switches ${k}: B + 10 000 -> the B question <= ${V1_MS} ms, no window`, over.every(r => r.outcome === 'slow' && r.ms <= V1_MS && r.shown === 0), JSON.stringify(over))
      }
      for (const file of ['x-hl-2m.eml', 'x-hl-2m-br.eml', 'x-digits-hebrew.eml', ...Object.keys(BYPASS_PAIRS).map(k => `x-bypass-${k}.eml`)]) {
        const rows = await each(file, Number.MAX_SAFE_INTEGER)
        check(`switches ${file}: the B question <= ${V1_MS} ms, no window, no watchdog, gap <= 500 ms`, rows.every(r => r.outcome === 'slow' && r.ms <= V1_MS && r.shown === 0 && r.gap <= 500), JSON.stringify(rows))
      }
      const digits = await each('x-digits-latin.eml', 120_000)
      console.log(`MEASURED switches Latin + digits 128 000: ${JSON.stringify(digits)}`)
      check(`switches: Latin and ASCII digits alternating, 128 000 characters -> no question, the composer ready <= ${V1_MS} ms`, digits.every(r => r.outcome === 'ready' && r.ms <= V1_MS), JSON.stringify(digits))
      const latin = await each('x-latin-2m.eml', 2_000_000)
      console.log(`MEASURED switches Latin 2 MB: ${JSON.stringify(latin)}`)
      check('switches: a 2 MB spaced Latin paragraph -> no question, the composer ready (or the watchdog: then its number is the finding)', latin.every(r => r.outcome === 'ready' || r.outcome === 'notice'), JSON.stringify(latin))
      check('switches: a 2 MB spaced Latin paragraph -> the composer ready within T', latin.every(r => r.outcome === 'ready'), JSON.stringify(latin))
      for (const file of NORMAL) {
        const rows = await each(file, 1)
        check(`switches: the normal message ${file}: no question, the composer ready`, rows.every(r => r.outcome === 'ready'), JSON.stringify(rows))
      }
    } finally {
      await close(s.app)
    }
  }
  for (const k of values.html ? [] : patterns) {
    for (const mode of modes) {
      const times = []
      const nexts = []
      let s = await launch()
      for (let i = 0; i < RUNS; i++) {
        const opened = await openReader(s.page, fileOf(k), body)
        if (opened === Infinity) {
          times.push(-1) // the reader did not open: no measure of the composer
          nexts.push(Infinity)
          await close(s.app)
          s = await launch()
          continue
        }
        const before = (await stalls(s.app)).length
        const { ms, win } = await compose(s.app, s.page, mode)
        if (!win && (await stalls(s.app)).length > before) {
          // the watchdog closed the composer; the app goes on (no restart)
          times.push(-2)
          nexts.push(await openReader(s.page, 'z-small.eml', 'pre.mail-text'))
          continue
        }
        times.push(ms)
        if (!win) {
          nexts.push(Infinity)
          await close(s.app)
          s = await launch()
          continue
        }
        const gone = await closeComposer(win)
        nexts.push(gone ? await openReader(s.page, 'z-small.eml', 'pre.mail-text') : Infinity)
      }
      await close(s.app)
      const ready = times.filter(t => t >= 0 && t <= READY(k)).length
      const guarded = times.filter(t => t === -2).length
      const line = `${k} ${mode}: ready ${ready}/${RUNS}, the watchdog's notice ${guarded}/${RUNS} [${times.map(fmt).join(', ')}], another message after [${nexts.map(fmt).join(', ')}]`
      if (values['measure-only']) console.log(`MEASURED ${line}`)
      // the 2 MB Hebrew is a bomb: a ready composer or the watchdog's notice, never a freeze; the others never a notice
      else if (k === 'heb') check(`${k} ${mode}: ${RUNS}/${RUNS} ready <= ${READY(k)} ms or closed by the watchdog, another message <= ${NEXT_MS} ms`, ready + guarded === RUNS && nexts.every(t => t <= NEXT_MS), line)
      else check(`${k} ${mode}: ${RUNS}/${RUNS} ready <= ${READY(k)} ms (no watchdog notice), another message <= ${NEXT_MS} ms`, ready === RUNS && nexts.every(t => t <= NEXT_MS), line)
    }
  }
  const netLog = path.join(dataDir, 'electron', 'logs', 'net-guard.log')
  check('the net-guard log has no outgoing request', !fs.existsSync(netLog) || fs.readFileSync(netLog, 'utf8').trim() === '')
} catch (err) {
  check('the run', false, err.stack)
} finally {
  fs.rmSync(work, { recursive: true, force: true })
}
const ok = results.filter(Boolean).length
console.log(`${ok} / ${results.length} ${ok === results.length ? 'OK' : 'FAIL'}`)
process.exit(ok === results.length ? 0 : 1)
