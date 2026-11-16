#!/usr/bin/env node
// Long alternating bodies in the real app, drawn in blocks. Not part of `npm test`.
//
//   node test/e2e/reader-blocks-e2e.mjs [--base-reader <ms>] [--base-source <ms>] [--only plain]
//
// The patterns (x + U+202E, U+05D0, U+FE0F, U+1F600, U+0300, a lone CR, a TAB), text/plain:
//   reader: 2 MB <= 5000 ms and 256 KB <= 1500 ms (median of 3), then another message <= 500 ms;
//   source view (Original tab): 2 MB <= 10 000 ms, then another message <= 500 ms;
//   the ordinary 2 MB (c): reader and source view within +20 % of --base-reader / --base-source (measured on the build before the blocks, with
//   --only plain; without them the time is only printed).
// Measured only: (d2) the Hebrew and the emoji pattern as an HTML body, another message 5 s after the frame; (e2) Reply on
// the Hebrew pattern (the composer).
// The characters are made with String.fromCodePoint (no invisible character in this file).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { t, seedLanguage } from './lang.mjs'

const { values } = parseArgs({ options: { 'base-reader': { type: 'string' }, 'base-source': { type: 'string' }, only: { type: 'string' } } })
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
const KB256 = 256 * 1024
const PATTERNS = { rlo: cp(0x202e), heb: cp(0x5d0), vs16: cp(0xfe0f), emoji: cp(0x1f600), comb: cp(0x300), cr: String.fromCharCode(13), tab: String.fromCharCode(9) }
const fill = (unit, bytes) => unit.repeat(Math.floor(bytes / Buffer.byteLength(unit)))

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-r2-e2e-'))
const emlDir = path.join(work, 'eml')
const dataDir = path.join(work, 'data')
fs.mkdirSync(emlDir)
const date = new Date().toUTCString()
const eml = (name, type, body) =>
  fs.writeFileSync(path.join(emlDir, name), Buffer.concat([Buffer.from(`From: Blokk <blokk@example.invalid>\r\nTo: r2-to@example.invalid\r\nSubject: Blokk ${name}\r\nDate: ${date}\r\nMessage-ID: <${name}@example.invalid>\r\nMIME-Version: 1.0\r\nContent-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n`), Buffer.from(body)]))
const only = values.only === 'plain'
eml('c-plain.eml', 'text/plain', 'Ez egy hosszabb, közönséges sor a levélben, hogy a tördelés is dolgozzon. \r\n'.repeat(Math.ceil(MB2 / 77)))
eml('z-small.eml', 'text/plain', 'Kicsi, közönséges levél.\r\n')
if (!only) {
  for (const [k, ch] of Object.entries(PATTERNS)) {
    eml(`p-${k}-2m.eml`, 'text/plain', fill(`x${ch}`, MB2))
    eml(`p-${k}-256k.eml`, 'text/plain', fill(`x${ch}`, KB256))
  }
  eml('d2-heb.eml', 'text/html', `<p>${fill(`x${PATTERNS.heb}`, MB2 - 7)}</p>`)
  eml('d2-emoji.eml', 'text/html', `<p>${fill(`x${PATTERNS.emoji}`, MB2 - 7)}</p>`)
}
const seed = JSON.parse(execFileSync(process.execPath, [path.join(repo, 'test', 'tools', 'seed-index.mjs'), dataDir, '--count', '3', '--eml', emlDir], { encoding: 'utf8' }))
seedLanguage(dataDir)
const idOf = file => seed.eml.find(e => e.file === file).id
const median = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]
const race = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r(null), ms))])

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
  await race(app.close(), 5000).catch(() => {})
  try {
    app.process().kill('SIGKILL')
  } catch {}
}
const frame = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => r())))
// row click -> the body drawn; Infinity when not within 30 s
async function openReader(page, file, body = 'pre.mail-text') {
  const id = idOf(file)
  if (await page.locator('.reader-back').count()) await page.locator('.reader-back').click()
  const t0 = performance.now()
  await page.locator(`.msg-row[data-id="${id}"]`).click()
  const ok = await race(page.locator(`.reader[data-message-id="${id}"] ${body}`).waitFor({ timeout: 30_000 }).then(() => frame(page)).then(() => true, () => false), 31_000)
  return ok ? performance.now() - t0 : Infinity
}
// the open message's Original tab -> the text drawn
async function openSource(page) {
  await page.locator('.reader-tools').getByRole('button', { name: t.readerMore, exact: true }).click()
  const t0 = performance.now()
  await page.getByRole('menuitem', { name: t.source.menuOriginal, exact: true }).click()
  const ok = await race(page.locator('.source-modal pre.source-original').waitFor({ timeout: 30_000 }).then(() => frame(page)).then(() => true, () => false), 31_000)
  const ms = ok ? performance.now() - t0 : Infinity
  await page.keyboard.press('Escape')
  await page.locator('.source-modal').waitFor({ state: 'detached', timeout: 30_000 }).catch(() => {})
  return ms
}
const fmt = ms => (ms === Infinity ? 'did not open in 30 s' : `${Math.round(ms)} ms`)

try {
  const { app, page, problems } = await launch()
  try {
    // (c) the ordinary 2 MB: reader and source view, median of 3
    const cr = []
    const cs = []
    for (let i = 0; i < 3; i++) {
      cr.push(await openReader(page, 'c-plain.eml'))
      cs.push(await openSource(page))
    }
    const mcr = median(cr)
    const mcs = median(cs)
    console.log(`MEASURED (c) ordinary 2 MB: reader ${fmt(mcr)} [${cr.map(Math.round)}], source view ${fmt(mcs)} [${cs.map(Math.round)}]`)
    if (values['base-reader']) check('(c) reader within +20 % of the base time', mcr <= Number(values['base-reader']) * 1.2, `${Math.round(mcr)} vs ${values['base-reader']} ms`)
    if (values['base-source']) check('(c) source view within +20 % of the base time', mcs <= Number(values['base-source']) * 1.2, `${Math.round(mcs)} vs ${values['base-source']} ms`)
    if (!only) {
      for (const k of Object.keys(PATTERNS)) {
        const big = []
        const small = []
        for (let i = 0; i < 3; i++) {
          big.push(await openReader(page, `p-${k}-2m.eml`))
          small.push(await openReader(page, `p-${k}-256k.eml`))
        }
        const after = await openReader(page, 'z-small.eml')
        const mb = median(big)
        const ms = median(small)
        console.log(`MEASURED reader x+${k}: 2 MB ${fmt(mb)} [${big.map(Math.round)}], 256 KB ${fmt(ms)} [${small.map(Math.round)}], another message ${fmt(after)}`)
        check(`reader x+${k}: 2 MB <= 5000 ms, 256 KB <= 1500 ms, another message <= 500 ms`, mb <= 5000 && ms <= 1500 && after <= 500, `${fmt(mb)}, ${fmt(ms)}, ${fmt(after)}`)
      }
      for (const k of Object.keys(PATTERNS)) {
        const opened = await openReader(page, `p-${k}-2m.eml`)
        const src = opened === Infinity ? Infinity : await openSource(page)
        const after = await openReader(page, 'z-small.eml')
        console.log(`MEASURED source view x+${k} 2 MB: ${fmt(src)}, another message ${fmt(after)}`)
        check(`source view x+${k}: 2 MB <= 10 000 ms, another message <= 500 ms`, src <= 10_000 && after <= 500, `${fmt(src)}, ${fmt(after)}`)
      }
    }
    check('no console error or warning', problems.length === 0, problems.join(' | '))
  } finally {
    await close(app)
  }
  if (!only) {
    // (d2) HTML bodies: the frame, then 5 s, then another message (measured only)
    for (const f of ['d2-heb.eml', 'd2-emoji.eml']) {
      const { app, page } = await launch()
      try {
        const frameMs = await openReader(page, f, 'iframe.mail-frame') // not `t`: that is the dictionary
        await page.waitForTimeout(5000)
        const after = await openReader(page, 'z-small.eml')
        console.log(`MEASURED (d2) ${f} as HTML: the frame ${fmt(frameMs)}; another message 5 s later ${fmt(after)}`)
      } finally {
        await close(app)
      }
    }
    // (e2) Reply on the Hebrew pattern (measured only)
    {
      const { app, page } = await launch()
      try {
        // this body is itself a bomb: the outcome is a ready composer (its body in) or the
        // watchdog closing it (~5 s; the reply-blocks e2e checks that), never a freeze. The empty editor is no measure.
        const opened = await openReader(page, 'p-heb-2m.eml')
        const t0 = performance.now()
        let composer = null
        const win = opened === Infinity ? null : await race((async () => {
          const [w] = await Promise.all([app.waitForEvent('window', { timeout: 30_000 }), page.locator('.reader-tools').getByRole('button', { name: t.replyModes.reply, exact: true }).click()])
          composer = w
          await w.setViewportSize({ width: 1000, height: 700 })
          await w.waitForFunction(() => (document.querySelector('.editor')?.textContent.length || 0) > 1_000_000, null, { timeout: 30_000, polling: 100 })
          return w
        })().catch(() => null), 31_000)
        const ms = Math.round(performance.now() - t0)
        const outcome = win ? `the composer holds the body in ${ms} ms` : composer && composer.isClosed() ? `closed by the watchdog (${ms} ms)` : 'neither ready nor closed within 30 s'
        console.log(`MEASURED (e2) Reply on the Hebrew 2 MB: ${outcome}`)
      } finally {
        await close(app)
      }
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
