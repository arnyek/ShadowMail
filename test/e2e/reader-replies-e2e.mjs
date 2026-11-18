#!/usr/bin/env node
// The reader's reply pills (Reply / Reply all / Forward) under a body longer than the reader, in the real app. Not part
// of `npm test`. The data folder is the seed's (an IMAP account at 127.0.0.1:1, the messages already downloaded).
//
//   node test/e2e/reader-replies-e2e.mjs [--shots <folder>]
//
// Measures, in each reading-pane mode (none, right, bottom) at 1280 x 800 and in the list's place at 860 x 640: for a
// long plain-text message (wide lines, like a cron report) and a long HTML message, the pills lie below the body box
// and inside the reader (nothing of the body is drawn under them), and the plain text scrolls inside its own box down
// to its last line, which then ends above the pills. The reader itself scrolls only when it is too short for the body's
// 160 px minimum (the bottom pane, a small window: as before, for HTML too); then the pills are measured with the reader
// scrolled to its end. A short plain-text message keeps its pills under the text area, inside the reader.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { t, seedLanguage } from './lang.mjs'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const { values: opts } = parseArgs({ options: { shots: { type: 'string' } } })
const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-replies-e2e-'))
const emlDir = path.join(work, 'eml')
const dataDir = path.join(work, 'data')
fs.mkdirSync(emlDir)
if (opts.shots) fs.mkdirSync(opts.shots, { recursive: true })

const date = new Date().toUTCString()
const eml = (name, subject, type, body) =>
  fs.writeFileSync(
    path.join(emlDir, name),
    `From: Cron Daemon <cron@example.invalid>\r\nTo: root@example.invalid\r\nSubject: ${subject}\r\nDate: ${date}\r\nMessage-ID: <${name}@example.invalid>\r\nMIME-Version: 1.0\r\nContent-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${body}`,
  )
const line = i => `Warning: unable to read default ACL from /var/www/site35/web196/web/folder${i}/a rather long path name/${'x'.repeat(40)}: surrogates not allowed`
const LAST = 'THE LAST LINE OF THE REPORT'
// geometry tolerance: a reader that scrolls stops on a whole pixel while its content sits on a fractional one (up to
// 0.55 px measured with other banners above the reader), as in the other geometry e2e files
const TOL = 1
eml('long-plain.eml', 'Replies long plain', 'text/plain', `${Array.from({ length: 120 }, (_, i) => line(i)).join('\r\n')}\r\n${LAST}\r\n`)
eml('long-html.eml', 'Replies long html', 'text/html', `<html><body>${Array.from({ length: 120 }, (_, i) => `<p>${line(i)}</p>`).join('')}<p>${LAST}</p></body></html>`)
eml('short-plain.eml', 'Replies short plain', 'text/plain', 'One short line.\r\n')

const seed = JSON.parse(execFileSync(process.execPath, [path.join(repo, 'test', 'tools', 'seed-index.mjs'), dataDir, '--count', '3', '--eml', emlDir], { encoding: 'utf8' }))
seedLanguage(dataDir)
const idOf = file => seed.eml.find(e => e.file === file).id

// the geometry of the open reader: the body box, the pills, the reader's own scroll, the plain text's last line
const geometry = page =>
  page.evaluate(() => {
    const r = document.querySelector('.reader:not(.reader-empty)')
    r.scrollTop = r.scrollHeight
    const body = r.querySelector('.reader-body')
    const pills = r.querySelector('.reader-replies')
    const rr = r.getBoundingClientRect()
    const b = body.getBoundingClientRect()
    const p = pills.getBoundingClientRect()
    const blocks = body.querySelectorAll('.text-block')
    const last = blocks.length ? blocks[blocks.length - 1].getBoundingClientRect() : null
    // the topmost element at points just above the pills' bottom edge, across the pills: must be the pills, not text
    const hits = [0.1, 0.5, 0.9].map(f => {
      const el = document.elementFromPoint(p.left + p.width * f, p.bottom - 4)
      return Boolean(el && (pills.contains(el) || el === r))
    })
    return {
      readerTop: rr.top,
      readerBottom: rr.bottom,
      readerScroll: r.scrollHeight - r.clientHeight,
      bodyBottom: b.bottom,
      bodyHeight: b.height,
      bodyScroll: body.scrollHeight - body.clientHeight,
      pillsTop: p.top,
      pillsBottom: p.bottom,
      pillsCount: pills.querySelectorAll('button').length,
      lastBottom: last && last.bottom,
      hits,
    }
  })

async function open(page, file) {
  const id = idOf(file)
  if (await page.locator('.reader-back').count()) await page.locator('.reader-back').click()
  await page.locator(`.msg-row[data-id="${id}"]`).click()
  await page.locator(`.reader[data-message-id="${id}"] .reader-replies`).waitFor({ timeout: 15_000 })
  if (file.includes('html')) await page.locator(`.reader[data-message-id="${id}"] iframe.mail-frame`).waitFor({ timeout: 15_000 })
  else await page.locator(`.reader[data-message-id="${id}"] pre.mail-text`).waitFor({ timeout: 15_000 })
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
}

async function measure(page, tag) {
  for (const file of ['long-plain.eml', 'long-html.eml']) {
    await open(page, file)
    const g = await geometry(page)
    const kind = file.includes('html') ? 'html' : 'plain'
    check(
      `${tag} ${kind}: the pills below the body box and inside the reader, the reader scrolls only below the body minimum`,
      g.pillsCount >= 3 && g.pillsTop >= g.bodyBottom - TOL && g.pillsBottom <= g.readerBottom + TOL && (g.readerScroll <= 1 || g.bodyHeight <= 160 + TOL) && g.hits.every(Boolean),
      JSON.stringify(g),
    )
    if (kind === 'plain') {
      check(`${tag} plain: the text scrolls inside its box`, g.bodyScroll > 100, `scroll ${g.bodyScroll}`)
      await page.locator('.reader-body-text').evaluate(b => (b.scrollTop = b.scrollHeight))
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r())))
      const end = await geometry(page)
      const lastText = await page.locator('.reader-body-text .text-block').last().innerText()
      check(
        `${tag} plain: scrolled to the end, the last line is above the pills`,
        lastText.trimEnd().endsWith(LAST) && end.lastBottom <= end.pillsTop + TOL && end.lastBottom <= end.bodyBottom + TOL && end.hits.every(Boolean),
        JSON.stringify({ lastBottom: end.lastBottom, pillsTop: end.pillsTop, bodyBottom: end.bodyBottom }),
      )
      if (opts.shots) await page.screenshot({ path: path.join(opts.shots, `${tag.replace(/[^a-z0-9]+/gi, '-')}-plain-end.png`) })
    }
  }
  await open(page, 'short-plain.eml')
  const s = await geometry(page)
  check(`${tag} short plain: the pills inside the reader, the text does not scroll`, s.pillsBottom <= s.readerBottom + TOL && (s.readerScroll <= 1 || s.bodyHeight <= 160 + TOL) && s.bodyScroll <= 1 && s.pillsTop >= s.bodyBottom - TOL, JSON.stringify(s))
}

const app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
try {
  const page = await app.firstWindow()
  const problems = []
  page.on('console', m => (m.type() === 'error' || m.type() === 'warning') && problems.push(m.text()))
  page.on('pageerror', e => problems.push(e.message))
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.locator('#vault-unlock').fill(seed.master)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  await page.locator('.msg-row[data-id]').first().waitFor({ timeout: 30_000 })

  const paneNow = () => page.evaluate(() => document.querySelector('.reader-pane-switch')?.getAttribute('data-pane') ?? null)
  for (const want of ['none', 'right', 'bottom']) {
    for (let i = 0; i < 3 && (await paneNow()) !== want; i++) await page.locator('.reader-pane-switch').click()
    check(`reading pane switched to ${want}`, (await paneNow()) === want, String(await paneNow()))
    await measure(page, `1280x800 ${want}`)
  }
  for (let i = 0; i < 3 && (await paneNow()) !== 'none'; i++) await page.locator('.reader-pane-switch').click()
  await page.setViewportSize({ width: 860, height: 640 })
  await measure(page, '860x640 none')
  check('no console error or warning', problems.length === 0, problems.join(' | '))
} catch (err) {
  check('run', false, err.stack)
} finally {
  await Promise.race([app.close(), new Promise(r => setTimeout(r, 5000))]).catch(() => {})
  try {
    app.process().kill('SIGKILL')
  } catch {}
  fs.rmSync(work, { recursive: true, force: true })
}
const failed = results.filter(r => !r).length
console.log(`\n${results.length - failed}/${results.length} OK`)
process.exit(failed ? 1 : 0)
