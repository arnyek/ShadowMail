#!/usr/bin/env node
// The "e-mail bomb" measurements (c), (d), (e) on the WINDOWS PACKAGE (not part of `npm test`): how long the composer of
// Válasz and Továbbítás takes to hold its starting body. Run with the Windows Node in the build folder (PW = the path of
// playwright-core, as for package-smoke.mjs). Windows appear on the screen: run it on a LOCKED machine.
//
//   node test\e2e\bomb-package-measure.mjs --zip <zip> --work <empty folder> [--what c,d,e,f] [--runs 5] [--real <folder of .eml>]
//
// (c) the normal messages (test/helpers/bomb-samples.js writeNormal, plus the .eml files of --real), (d) the 2 MB plain
// text samples (Hebrew, emoji), (e) the image cases (50 cid:, one 10 MB data:, 200 small data:), (f) the
// Hebrew one-paragraph HTML of exactly N = SHAPE_LIMIT characters (the shape check lets it through), Válasz only: the
// slowest run must stay <= T / 2. The data folder is seeded
// with test/tools/seed-index.mjs (--eml); the exe runs with SHADOWMAIL_DATA and --remote-debugging-port (CDP). A run: the
// message opens, the button, until the composer page holds a reply's quote block or a forward's header line and drew a
// frame; a run not ready in 30 s counts as 30 s and the app restarts. Printed: the file's size, never its words.
import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { writeNormal, writeR3, writeImages, writeAtLimit } from '../helpers/bomb-samples.js'

const { values } = parseArgs({ options: { zip: { type: 'string' }, work: { type: 'string' }, what: { type: 'string', default: 'c,d,e,f' }, runs: { type: 'string', default: '5' }, real: { type: 'string' } } })
if (!values.zip || !values.work) {
  console.error('usage: bomb-package-measure.mjs --zip <zip> --work <empty folder> [--what c,d,e,f] [--runs 5] [--real <folder>]')
  process.exit(2)
}
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const race = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r(null), ms))])
const what = values.what.split(',')
const RUNS = Number(values.runs)

const work = path.resolve(values.work)
fs.mkdirSync(work, { recursive: true })
if (fs.readdirSync(work).length) throw new Error('--work must be an empty folder')
const appDir = path.join(work, 'app')
const emlDir = path.join(work, 'eml')
const dataDir = path.join(work, 'data')
fs.mkdirSync(appDir)
fs.mkdirSync(emlDir)
execFileSync('tar', ['-xf', path.resolve(values.zip), '-C', appDir])
const list = []
if (what.includes('c')) {
  list.push(...writeNormal(emlDir))
  if (values.real) for (const f of fs.readdirSync(values.real).filter(x => x.endsWith('.eml')).sort()) {
    fs.copyFileSync(path.join(values.real, f), path.join(emlDir, `r-${f}`))
    list.push([`r-${f}`, 'real (test mailbox)'])
  }
}
if (what.includes('d')) list.push(...writeR3(emlDir))
if (what.includes('e')) list.push(...writeImages(emlDir))
// N: SHAPE_LIMIT of app/main/ipc/compose.js (not imported: the measurement also runs on a build of an earlier commit)
if (what.includes('f')) list.push(...writeAtLimit(emlDir, 40_000))
fs.writeFileSync(path.join(emlDir, 'z-small.eml'), 'From: a@example.invalid\r\nSubject: kicsi\r\n\r\nkicsi\r\n')
const seed = JSON.parse(execFileSync(process.execPath, [path.join(repo, 'test', 'tools', 'seed-index.mjs'), dataDir, '--count', '3', '--eml', emlDir], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }))
const idOf = file => seed.eml.find(e => e.file === file).id

let port = 9400 + Math.floor(Math.random() * 400)
async function launch() {
  port++
  const proc = spawn(path.join(appDir, 'ShadowMail.exe'), [`--remote-debugging-port=${port}`], { cwd: appDir, env: { ...process.env, SHADOWMAIL_DATA: dataDir }, stdio: 'ignore' })
  let browser = null
  for (let i = 0; i < 60 && !browser; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    } catch {
      await sleep(500)
    }
  }
  if (!browser) throw new Error('no DevTools endpoint')
  const context = browser.contexts()[0]
  let page = null
  for (let i = 0; i < 40 && !page; i++) {
    page = context.pages().find(p => p.url().includes('index.html') && !p.url().includes('#compose'))
    if (!page) await sleep(250)
  }
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.locator('#vault-unlock').fill(seed.master)
  await page.getByRole('button', { name: 'Feloldás', exact: true }).click()
  await page.locator('.msg-row[data-id]').first().waitFor({ timeout: 60_000 })
  return { proc, browser, context, page }
}
async function quit({ proc, browser, page }) {
  await page.evaluate(() => window.close()).catch(() => {})
  for (let i = 0; i < 40 && proc.exitCode === null; i++) await sleep(250)
  await browser.close().catch(() => {})
  if (proc.exitCode === null) proc.kill()
}
const frame = p => p.evaluate(() => new Promise(r => requestAnimationFrame(() => r())))

try {
  for (const [file, desc, modes = ['reply', 'forward']] of list) {
    const size = fs.statSync(path.join(emlDir, file)).size
    for (const mode of modes) {
      const times = []
      for (let i = 0; i < RUNS; i++) {
        const app = await launch()
        try {
          const id = idOf(file)
          await app.page.locator(`.msg-row[data-id="${id}"]`).click()
          await app.page.locator(`.reader[data-message-id="${id}"] iframe.mail-frame, .reader[data-message-id="${id}"] pre.mail-text`).first().waitFor({ timeout: 60_000 })
          const t0 = performance.now()
          const ok = await race((async () => {
            const [w] = await Promise.all([app.context.waitForEvent('page', { timeout: 30_000 }), app.page.locator('.reader-tools').getByRole('button', { name: mode === 'reply' ? 'Válasz' : 'Továbbítás', exact: true }).click()])
            await w.locator('.editor').waitFor({ timeout: 30_000 })
            await w.waitForFunction(m => (m === 'reply' ? Boolean(document.querySelector('.editor blockquote')) : (document.querySelector('.editor')?.textContent || '').includes('Továbbított üzenet')), mode, { timeout: 30_000, polling: 50 })
            await frame(w)
            return true
          })().catch(() => false), 31_000)
          times.push(ok ? Math.round(performance.now() - t0) : 30_000)
        } finally {
          await quit(app)
        }
      }
      const sorted = [...times].sort((a, b) => a - b)
      console.log(`${file} [${desc}, ${Math.round(size / 1024)} KB] ${mode}: ${times.join('/')} ms (median ${sorted[Math.floor(sorted.length / 2)]}, max ${sorted[sorted.length - 1]})`)
    }
  }
} catch (err) {
  console.log(`FAIL ${err.stack}`)
  process.exitCode = 1
}
