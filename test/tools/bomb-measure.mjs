#!/usr/bin/env node
// The "e-mail bomb" measurements (a) and (b) in the real app (headless Electron + Playwright). Not part of `npm test`.
//
//   node test/tools/bomb-measure.mjs [--part a,b,c,e] [--runs 3] [--sizes 64,256,512,1024] [--real <folder of .eml>]
//
// (a) The 2 MB one-paragraph HTML (Hebrew, emoji): Válasz. While the composer's renderer is busy (2 s after the click):
//     does the MAIN window answer (another message opens: the time), how long is the main process's longest gap (a ping
//     every 250 ms), and can the main process close the busy composer window (win.destroy(), forcefullyCrashRenderer()
//     before it if needed): the time until the window is gone.
// (b) The same patterns as one-paragraph HTML of 64 KB, 256 KB, 512 KB, 1 MB: Válasz until the composer holds the body and
//     drew a frame (3 runs each; a run not ready in 30 s counts as 30 s and the app restarts).
// (c) NORMAL messages: generated ones (a big image newsletter with 50 cid: images, 1-2 MB; a long HTML; a
//     long plain text; a short one) and the .eml files of --real (the test mailbox's biggest, downloaded for the
//     measurement): Válasz and Továbbítás, `--runs` each, until the composer holds its starting body (the quote block or the
//     forwarded header) and drew a frame. Printed: the file's size and shape, never its words.
// (e) Images (test/helpers/bomb-samples.js writeImages): 50 cid: images, one 10 MB data: image, 200 small data: images;
//     the same Válasz / Továbbítás measurement as (c).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: { part: { type: 'string', default: 'a,b' }, runs: { type: 'string', default: '3' }, sizes: { type: 'string', default: '64,256,512,1024' }, real: { type: 'string' } } })
const parts = values.part.split(',')
const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const cp = n => String.fromCodePoint(n)
const PATTERNS = { heb: cp(0x5d0), emoji: cp(0x1f600) }
const fill = (unit, bytes) => unit.repeat(Math.floor(bytes / Buffer.byteLength(unit)))
const race = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r(null), ms))])
const sleep = ms => new Promise(r => setTimeout(r, ms))

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-bomb-measure-'))
const emlDir = path.join(work, 'eml')
const dataDir = path.join(work, 'data')
fs.mkdirSync(emlDir)
const date = new Date().toUTCString()
const eml = (name, type, body) =>
  fs.writeFileSync(path.join(emlDir, name), Buffer.concat([Buffer.from(`From: Bomba <bomba@example.invalid>\r\nTo: v1-to@example.invalid\r\nSubject: Bomba ${name}\r\nDate: ${date}\r\nMessage-ID: <${name}@example.invalid>\r\nMIME-Version: 1.0\r\nContent-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n`), Buffer.from(body)]))
eml('z-small.eml', 'text/plain', 'Kicsi, közönséges levél.\r\n')
const sizes = values.sizes.split(',').map(Number)
const fileOf = (k, kb) => `h-${k}-${kb}k.eml`
const chars = (k, kb) => fill(`x${PATTERNS[k]}`, kb * 1024 - 7).length
for (const k of Object.keys(PATTERNS)) {
  for (const kb of [...new Set([...sizes, 2048])]) eml(fileOf(k, kb), 'text/html', `<p>${fill(`x${PATTERNS[k]}`, kb * 1024 - 7)}</p>`)
}
// (c) the generated normal messages
const { newsletterHtml } = await import('../helpers/newsletter.js')
const crypto = await import('node:crypto')
const NORMAL = []
if (parts.includes('c')) {
  const img = i => crypto.randomBytes(18_000 + (i % 7) * 1000).toString('base64').replace(/.{76}/g, '$&\r\n')
  const cids = Array.from({ length: 50 }, (_, i) => `<p><img src="cid:kep${i}@v1" width="600"> Termék ${i}: rövid leírás a képhez.</p>`).join('')
  const related = [`--R\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n<html><body>${newsletterHtml({ blocks: 1500, rules: 40 })}${cids}</body></html>\r\n`]
  for (let i = 0; i < 50; i++) related.push(`--R\r\nContent-Type: image/jpeg\r\nContent-ID: <kep${i}@v1>\r\nContent-Disposition: inline\r\nContent-Transfer-Encoding: base64\r\n\r\n${img(i)}\r\n`)
  fs.writeFileSync(path.join(emlDir, 'c-newsletter.eml'), Buffer.from(`From: Hirlevel <h@example.invalid>\r\nTo: v1-to@example.invalid\r\nSubject: Bomba c-newsletter\r\nDate: ${date}\r\nMessage-ID: <c-newsletter@example.invalid>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="R"\r\n\r\n${related.join('')}--R--\r\n`, 'utf8'))
  eml('c-long-html.eml', 'text/html', `<html><body>${newsletterHtml({ blocks: 3000, rules: 20 })}</body></html>`)
  eml('c-long-plain.eml', 'text/plain', Array.from({ length: 8000 }, (_, i) => (i % 12 === 0 ? '' : `Ez a(z) ${i}. sor egy hosszú, valódi szerkezetű sima szöveges levélben.`)).join('\r\n'))
  eml('c-short.eml', 'text/plain', 'Szia, holnap 10-kor jó?\r\nÜdv')
  NORMAL.push(['c-newsletter.eml', 'generated image newsletter'], ['c-long-html.eml', 'generated long HTML'], ['c-long-plain.eml', 'generated long plain text'], ['c-short.eml', 'generated short'])
  if (values.real) {
    for (const f of fs.readdirSync(values.real).filter(x => x.endsWith('.eml')).sort()) {
      fs.copyFileSync(path.join(values.real, f), path.join(emlDir, `r-${f}`))
      NORMAL.push([`r-${f}`, 'real (test mailbox)'])
    }
  }
}
// (e) images (50 cid:, one 10 MB data:, 200 small data:): the same measurement as (c)
const IMAGES = []
if (parts.includes('e')) {
  const { writeImages } = await import('../helpers/bomb-samples.js')
  IMAGES.push(...writeImages(emlDir, date))
}
const seed = JSON.parse(execFileSync(process.execPath, [path.join(repo, 'test', 'tools', 'seed-index.mjs'), dataDir, '--count', '3', '--eml', emlDir], { encoding: 'utf8' }))
const idOf = file => seed.eml.find(e => e.file === file).id

async function launch() {
  const app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.locator('#vault-unlock').fill(seed.master)
  await page.getByRole('button', { name: 'Feloldás', exact: true }).click()
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
async function openReader(page, file, body) {
  const id = idOf(file)
  if (await page.locator('.reader-back').count()) await page.locator('.reader-back').click()
  const t0 = performance.now()
  await page.locator(`.msg-row[data-id="${id}"]`).click()
  const ok = await race(page.locator(`.reader[data-message-id="${id}"] ${body}`).waitFor({ timeout: 30_000 }).then(() => frame(page)).then(() => true, () => false), 31_000)
  return ok ? Math.round(performance.now() - t0) : Infinity
}

try {
  if (parts.includes('a')) {
    for (const k of Object.keys(PATTERNS)) {
      const s = await launch()
      try {
        await openReader(s.page, fileOf(k, 2048), 'iframe.mail-frame')
        let longest = 0
        let last = performance.now()
        let pinging = true
        const ping = (async () => {
          while (pinging) {
            await s.app.evaluate(() => 1)
            const now = performance.now()
            longest = Math.max(longest, now - last)
            last = now
            await sleep(250)
          }
        })()
        const winP = s.app.waitForEvent('window', { timeout: 15_000 })
        await s.page.locator('.reader-tools').getByRole('button', { name: 'Válasz', exact: true }).click()
        const win = await winP
        await sleep(2000)
        // is the composer busy now? (its page does not answer an evaluate within 1 s)
        const busy = (await race(win.evaluate(() => 1).then(() => 'answers', () => 'error'), 1000)) === null
        // the main window meanwhile: another message
        const other = await openReader(s.page, 'z-small.eml', 'pre.mail-text')
        // the main process closes the composer window: destroy (and, if it is still there after 1 s, crash its renderer first)
        const t0 = performance.now()
        const gone = win.waitForEvent('close', { timeout: 10_000 }).then(() => true, () => false)
        const how = await s.app.evaluate(({ BrowserWindow }) => {
          const w = BrowserWindow.getAllWindows().find(x => x.webContents.getURL().includes('#compose='))
          if (!w) return 'none'
          w.destroy()
          return 'destroy'
        })
        let closed = await race(gone, 2000)
        let crashed = false
        if (!closed) {
          crashed = true
          await s.app.evaluate(({ BrowserWindow }) => {
            const w = BrowserWindow.getAllWindows().find(x => x.webContents.getURL().includes('#compose='))
            if (w) {
              w.webContents.forcefullyCrashRenderer()
              w.destroy()
            }
          })
          closed = await race(gone, 8000)
        }
        const closeMs = Math.round(performance.now() - t0)
        const left = await s.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
        const after = await openReader(s.page, 'z-small.eml', 'pre.mail-text')
        pinging = false
        await ping
        console.log(`(a) ${k} 2 MB HTML Válasz: the composer busy after 2 s: ${busy}; the main window opens another message in ${other} ms; the main process's longest gap ${Math.round(longest)} ms; the composer closed by ${how}${crashed ? ' + forcefullyCrashRenderer' : ''}: ${closed ? `gone in ${closeMs} ms` : 'NOT gone'}; windows left ${left}; another message after it ${after} ms`)
      } finally {
        await close(s.app)
      }
    }
  }
  if (parts.includes('b')) {
    const RUNS = Number(values.runs)
    for (const k of Object.keys(PATTERNS)) {
      for (const kb of sizes) {
        const times = []
        let s = await launch()
        for (let i = 0; i < RUNS; i++) {
          await openReader(s.page, fileOf(k, kb), 'iframe.mail-frame')
          const want = Math.floor(chars(k, kb) * 0.9)
          const t0 = performance.now()
          const win = await race((async () => {
            const [w] = await Promise.all([s.app.waitForEvent('window', { timeout: 30_000 }), s.page.locator('.reader-tools').getByRole('button', { name: 'Válasz', exact: true }).click()])
            await w.setViewportSize({ width: 1000, height: 700 })
            await w.locator('.editor').waitFor({ timeout: 30_000 })
            await w.waitForFunction(n => (document.querySelector('.editor')?.textContent.length || 0) > n, want, { timeout: 30_000, polling: 100 })
            await frame(w)
            return w
          })().catch(() => null), 31_000)
          const ms = win ? Math.round(performance.now() - t0) : 30_000
          times.push(ms)
          await close(s.app)
          s = await launch()
        }
        await close(s.app)
        const sorted = [...times].sort((a, b) => a - b)
        console.log(`(b) ${k} ${kb} KB (${chars(k, kb)} characters): ready ${times.join('/')} ms (median ${sorted[Math.floor(sorted.length / 2)]})`)
      }
    }
  }
  if (parts.includes('c') || parts.includes('e')) {
    const RUNS = Number(values.runs)
    for (const [file, what, tag] of [...NORMAL.map(x => [...x, 'c']), ...IMAGES.map(x => [...x, 'e'])]) {
      const size = fs.statSync(path.join(emlDir, file)).size
      for (const mode of ['reply', 'forward']) {
        const times = []
        let s = await launch()
        for (let i = 0; i < RUNS; i++) {
          // the reader shows it (a frame for HTML, a pre for text)
          await openReader(s.page, file, 'iframe.mail-frame, pre.mail-text')
          const t0 = performance.now()
          const win = await race((async () => {
            const [w] = await Promise.all([s.app.waitForEvent('window', { timeout: 30_000 }), s.page.locator('.reader-tools').getByRole('button', { name: mode === 'reply' ? 'Válasz' : 'Továbbítás', exact: true }).click()])
            await w.setViewportSize({ width: 1000, height: 700 })
            await w.locator('.editor').waitFor({ timeout: 30_000 })
            // the starting body is in: a reply's quote block, a forward's header line
            await w.waitForFunction(m => (m === 'reply' ? Boolean(document.querySelector('.editor blockquote')) : (document.querySelector('.editor')?.textContent || '').includes('Továbbított üzenet')), mode, { timeout: 30_000, polling: 50 })
            await frame(w)
            return w
          })().catch(() => null), 31_000)
          times.push(win ? Math.round(performance.now() - t0) : 30_000)
          await close(s.app)
          s = await launch()
        }
        await close(s.app)
        const sorted = [...times].sort((a, b) => a - b)
        console.log(`(${tag}) ${file} [${what}, ${Math.round(size / 1024)} KB] ${mode}: ${times.join('/')} ms (median ${sorted[Math.floor(sorted.length / 2)]}, max ${sorted[sorted.length - 1]})`)
      }
    }
  }
} finally {
  fs.rmSync(work, { recursive: true, force: true })
}
