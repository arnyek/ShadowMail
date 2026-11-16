#!/usr/bin/env node
// The reader in the real app: the reader's plain-text body with many control characters. Not part of
// `npm test`. The data folder is the seed's (an IMAP account at 127.0.0.1:1, the messages already downloaded); the
// fixtures are written here (each 2 MB).
//
//   node test/e2e/reader-text-e2e.mjs
//
// Measures (median of 3 openings): (a) "x" + U+0001 alternating, (b) "x" + U+200B alternating (Cf: not left out), (c)
// ordinary text in lines; (a) and (b) must open within (c) + 20 %, and another message must open after them. (a): the
// info banner with the exact count; (c): no banner. Measured and reported only (no condition): (d) the (a) body as HTML,
// (e) Reply on (a), each in its own app instance (a freeze there must not spoil the rest).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { t, seedLanguage } from './lang.mjs'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const N = 1024 * 1024
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-r1-e2e-'))
const emlDir = path.join(work, 'eml')
const dataDir = path.join(work, 'data')
fs.mkdirSync(emlDir)

const date = new Date().toUTCString()
const eml = (name, subject, type, body) =>
  fs.writeFileSync(
    path.join(emlDir, name),
    Buffer.concat([
      Buffer.from(`From: Olvaso Felado <r1@example.invalid>\r\nTo: r1-to@example.invalid\r\nSubject: ${subject}\r\nDate: ${date}\r\nMessage-ID: <${name}@example.invalid>\r\nMIME-Version: 1.0\r\nContent-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n`),
      Buffer.from(body),
    ]),
  )
eml('a-ctl.eml', 'Olvaso a ctl', 'text/plain', 'x\u0001'.repeat(N))
eml('b-zw.eml', 'Olvaso b zw', 'text/plain', 'x\u200b'.repeat(N))
eml('c-plain.eml', 'Olvaso c plain', 'text/plain', `${'Ez egy hosszabb, közönséges sor a levélben, hogy a tördelés is dolgozzon. '.repeat(1)}\r\n`.repeat(Math.ceil((2 * N) / 77)))
eml('d-html.eml', 'Olvaso d html', 'text/html', `<p>${'x\u0001'.repeat(N)}</p>`)
eml('z-small.eml', 'Olvaso z small', 'text/plain', 'Kicsi, közönséges levél.\r\n')

const seed = JSON.parse(execFileSync(process.execPath, [path.join(repo, 'test', 'tools', 'seed-index.mjs'), dataDir, '--count', '3', '--eml', emlDir], { encoding: 'utf8' }))
seedLanguage(dataDir)
const idOf = file => seed.eml.find(e => e.file === file).id

async function launch() {
  const app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
  const page = await app.firstWindow()
  const problems = []
  page.on('console', m => (m.type() === 'error' || m.type() === 'warning') && problems.push(m.text()))
  page.on('pageerror', e => problems.push(e.message))
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.locator('#vault-unlock').fill(seed.master)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  await page.locator('.msg-row[data-id]').first().waitFor({ timeout: 30_000 })
  return { app, page, problems }
}
const close = async app => {
  await Promise.race([app.close(), new Promise(r => setTimeout(r, 5000))]).catch(() => {})
  try {
    app.process().kill('SIGKILL')
  } catch {}
}
// row click -> the reader's body drawn (the next animation frame); null when not within `timeout`
async function openTime(page, file, body = 'pre.mail-text', timeout = 30_000) {
  const id = idOf(file)
  if (await page.locator('.reader-back').count()) await page.locator('.reader-back').click()
  const t0 = performance.now()
  await page.locator(`.msg-row[data-id="${id}"]`).click()
  const ok = await page
    .locator(`.reader[data-message-id="${id}"] ${body}`)
    .waitFor({ timeout })
    .then(() => true, () => false)
  if (!ok) return null
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r())))
  return performance.now() - t0
}
const median = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]

try {
  // (a), (b), (c)
  {
    const { app, page, problems } = await launch()
    try {
      const times = { a: [], b: [], c: [] }
      for (let i = 0; i < 3; i++)
        for (const [k, file] of [['c', 'c-plain.eml'], ['a', 'a-ctl.eml'], ['b', 'b-zw.eml']]) {
          const ms = await openTime(page, file)
          times[k].push(ms === null ? Infinity : ms)
          if (k === 'a' && i === 0) {
            const banner = await page.locator('.reader-controls-hidden').innerText().catch(() => '')
            const shown = await page.locator('pre.mail-text').evaluate(p => ({ len: p.textContent.length, ctl: /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(p.textContent) }))
            check('(a) the info banner with the exact count', banner === t.readerControlsHidden(N), banner)
            check('(a) the drawn text has no control character, 1 048 576 characters', !shown.ctl && shown.len === N, JSON.stringify(shown))
          }
          if (k === 'b' && i === 0) {
            const cut = await page.locator('.reader-text-cut').innerText().catch(() => '')
            check('(b) U+200B is kept (Cf), so 2 097 152 characters: the end is cut with the exact count', cut.trim() === t.readerTextCut(N), cut)
            check('(b) no control-character banner', (await page.locator('.reader-controls-hidden').count()) === 0)
          }
          if (k === 'c' && i === 0) check('(c) no control-character banner (2 MB: past the limit the cut line is expected)', (await page.locator('.reader-controls-hidden').count()) === 0)
        }
      const [ma, mb, mc] = ['a', 'b', 'c'].map(k => median(times[k]))
      console.log(`MEASURED reader open, median of 3: (a) x+U+0001 ${Math.round(ma)} ms [${times.a.map(Math.round)}], (b) x+U+200B ${Math.round(mb)} ms [${times.b.map(Math.round)}], (c) plain ${Math.round(mc)} ms [${times.c.map(Math.round)}]`)
      check('(a) opens within (c) + 20 %', ma <= mc * 1.2, `${Math.round(ma)} vs ${Math.round(mc)} ms`)
      check('(b) opens within (c) + 20 %', mb <= mc * 1.2, `${Math.round(mb)} vs ${Math.round(mc)} ms`)
      const after = await openTime(page, 'z-small.eml', 'pre.mail-text', 10_000)
      check('after them another message opens (the window is not frozen)', after !== null, `${Math.round(after)} ms`)
      check('no console error or warning', problems.length === 0, problems.join(' | '))
    } finally {
      await close(app)
    }
  }
  // (d) the (a) body as HTML: measured only
  {
    const { app, page } = await launch()
    try {
      const ms = await openTime(page, 'd-html.eml', 'iframe.mail-frame')
      console.log(`MEASURED (d) the (a) body as HTML: ${ms === null ? 'did not open within 30 s' : `${Math.round(ms)} ms`}`)
    } finally {
      await close(app)
    }
  }
  // (e) Reply on (a): measured only
  {
    const { app, page } = await launch()
    try {
      const opened = await openTime(page, 'a-ctl.eml')
      if (opened === null) console.log('MEASURED (e) Reply on (a): the reader did not open')
      else {
        const t0 = performance.now()
        const win = await Promise.race([
          (async () => {
            const [w] = await Promise.all([app.waitForEvent('window', { timeout: 30_000 }), page.locator('.reader-tools').getByRole('button', { name: t.replyModes.reply, exact: true }).click()])
            // a headless window is 0 x 0; laid out that narrow, this body took 10.4-10.6 s even before the bomb check and
            // the watchdog (T = 5 s) closed it. At a real size it is ~2.5 s. And the empty editor is no measure (~0.2 s):
            // the body must be in.
            await w.setViewportSize({ width: 1000, height: 700 })
            await w.waitForFunction(() => (document.querySelector('.editor')?.textContent.length || 0) > 1_000_000, null, { timeout: 30_000, polling: 100 })
            return w
          })(),
          new Promise(r => setTimeout(() => r(null), 30_000)),
        ]).catch(() => null)
        console.log(`MEASURED (e) Reply on (a): ${win ? `the composer is up in ${Math.round(performance.now() - t0)} ms` : 'the composer did not come up within 30 s'}`)
      }
    } finally {
      await close(app)
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
