#!/usr/bin/env node
// Reader measurement in the real app, headless Electron + Playwright. Not part of `npm test`.
//
//   node test/e2e/reader-e2e.mjs [--keep] [--shots <folder>] [--only a.eml,b.eml]
//
// --only: just these hostile messages, then the net guard log (for negative controls).
//
// Seeds a temporary data folder (test/tools/seed-index.mjs --eml) with the hostile set and the
// cid/attachment/charset fixtures, already downloaded into data/store, so no mail server is needed
// (the account points at 127.0.0.1:1). Measures: no script runs in any hostile message, the net
// guard log shows no request let through, cid images load without permission, "Képek betöltése"
// loads the external image from a local HTTP server and the next message is blocked again, links,
// attachments (executables: save only), data/tmp emptied on the next start, charsets.
// shell.openExternal / shell.openPath / dialog.showSaveDialog are replaced inside the app so the
// measurement opens nothing on the machine.
//
// Playwright: PW=<path of the playwright package> (default: the repo's playwright-core devDependency).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { t, seedLanguage } from './lang.mjs'

const { values } = parseArgs({ options: { keep: { type: 'boolean' }, shots: { type: 'string' }, only: { type: 'string' } } })
const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-k6-e2e-'))
const dataDir = path.join(work, 'data')
const emlDir = path.join(work, 'eml')
fs.mkdirSync(emlDir)
for (const dir of ['hostile', 'mail']) {
  for (const f of fs.readdirSync(path.join(repo, 'test', 'fixtures', dir))) fs.copyFileSync(path.join(repo, 'test', 'fixtures', dir, f), path.join(emlDir, f))
}
const seed = JSON.parse(execFileSync(process.execPath, [path.join(repo, 'test', 'tools', 'seed-index.mjs'), dataDir, '--count', '20', '--eml', emlDir], { encoding: 'utf8' }))
seedLanguage(dataDir)
const idOf = file => seed.eml.find(e => e.file === file).id
const guardLog = path.join(dataDir, 'electron', 'logs', 'net-guard.log')
const readGuard = () => (fs.existsSync(guardLog) ? fs.readFileSync(guardLog, 'utf8').split('\n').filter(Boolean) : [])
const tmpDir = path.join(dataDir, 'tmp')

// the "external" image of cid-and-attachments.eml: http://127.0.0.1:47811/kep.png
const png = fs.readFileSync(path.join(repo, 'test', 'fixtures', 'mail', 'cid-and-attachments.eml'), 'latin1')
  .match(/Content-ID: <logo@sender\.invalid>[\s\S]*?\r\n\r\n([\s\S]*?)\r\n--REL--/)[1]
const imageHits = []
const server = http.createServer((req, res) => {
  imageHits.push(req.url)
  res.writeHead(200, { 'content-type': 'image/png' })
  res.end(Buffer.from(png.replace(/\s+/g, ''), 'base64'))
})
await new Promise(r => server.listen(47811, '127.0.0.1', r))
// a host the user did NOT allow: anything arriving here got past the net guard
const strayHits = []
const stray = http.createServer((req, res) => {
  strayHits.push(req.url)
  res.end()
})
await new Promise(r => stray.listen(47812, '127.0.0.1', r))

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}

async function launch() {
  const app = await _electron.launch({
    executablePath: electronBin,
    args: [repo, '--ozone-platform=headless', '--disable-gpu'],
    cwd: repo,
    env: { ...process.env, SHADOWMAIL_DATA: dataDir },
  })
  // nothing may actually open on this machine
  await app.evaluate(({ shell, dialog }, saveTo) => {
    globalThis.__k6 = { external: [], opened: [], saved: [] }
    shell.openExternal = async url => void globalThis.__k6.external.push(url)
    shell.openPath = async p => (globalThis.__k6.opened.push(p), '')
    dialog.showSaveDialog = async (...args) => {
      const opts = args[args.length - 1]
      const filePath = `${saveTo}/${opts.defaultPath}`
      globalThis.__k6.saved.push(filePath)
      return { canceled: false, filePath }
    }
  }, work)
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.locator('#vault-unlock').fill(seed.master)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  await page.locator('.msg-row').first().waitFor()
  return { app, page }
}

const k6 = app => app.evaluate(() => globalThis.__k6)
const mailFrame = page => page.frames().find(f => f.url().startsWith('mail-view://view/'))

async function openMessage(page, id) {
  const before = mailFrame(page)?.url()
  // the message opens in the list's place; back to the list first (the "Vissza a listához" button)
  const back = page.locator('.reader-back')
  if (await back.isVisible()) {
    await back.click()
    await page.locator('.list-area').waitFor({ state: 'visible' })
  }
  await page.locator(`.msg-row[data-id="${id}"]`).click()
  await page.locator(`.reader[data-message-id="${id}"]`).waitFor()
  const pre = await page.locator('.reader .mail-text').count()
  if (pre) return null
  await page.waitForFunction(prev => {
    const f = document.querySelector('.mail-frame')
    return f && f.src && f.src !== prev
  }, before)
  await page.waitForTimeout(150)
  for (let i = 0; i < 50; i++) {
    const f = mailFrame(page)
    if (f && f.url() !== before) {
      await f.waitForLoadState('load')
      return f
    }
    await page.waitForTimeout(50)
  }
  throw new Error(`no frame for ${id}`)
}

let { app, page } = await launch()
const appUrl = page.url()
try {
  // 1. hostile set: nothing runs, nothing leaves
  const only = values.only ? values.only.split(',') : null
  const hostile = seed.eml.filter(e => !['cid-and-attachments.eml', 'iso-8859-2.eml', 'windows-1250.eml', 'openable-attachments.eml'].includes(e.file) && (!only || only.includes(e.file)))
  for (const e of hostile) {
    const frame = await openMessage(page, e.id)
    await page.waitForTimeout(400) // give timers, refresh and onload a chance
    const pwned = await frame.evaluate(() => document.body && document.body.getAttribute('data-pwned'))
    const topPwned = await page.evaluate(() => document.body.getAttribute('data-pwned'))
    const scripts = await frame.evaluate(() => document.querySelectorAll('script, iframe, form, object, embed, link, meta[http-equiv=refresh]').length)
    check(`hostile ${e.file}: no script ran, no active element`, !pwned && !topPwned && scripts === 0 && page.url() === appUrl, `pwned=${pwned} top=${topPwned} active=${scripts}`)
    if (values.shots) await page.screenshot({ path: path.join(values.shots, `k6-${e.file}.png`) })
  }
  const guard1 = readGuard()
  check('net guard: no request let through for the hostile set', !guard1.some(l => / allow /.test(l)), `${guard1.length} log lines: ${JSON.stringify(guard1.slice(0, 5))}`)
  if (only) throw Object.assign(new Error('--only: stopped after the hostile part'), { only: true })

  // 2. links: http(s) to the system browser (stubbed), javascript:/file:/data: nothing
  const linkFrame = await openMessage(page, idOf('javascript-link.eml'))
  for (const sel of ['#js', '#file', '#data']) await linkFrame.locator(sel).click()
  await linkFrame.locator('#web').click()
  await page.waitForTimeout(300)
  const ext = (await k6(app)).external
  check('links: only the https link went to the browser', JSON.stringify(ext) === JSON.stringify(['https://www.example.com/']), JSON.stringify(ext))
  check('links: the app page and the frame did not navigate', page.url() === appUrl && mailFrame(page) === linkFrame)

  // 3. cid image without permission, external image after "Képek betöltése", blocked again on the next message
  const cidId = idOf('cid-and-attachments.eml')
  let frame = await openMessage(page, cidId)
  const cidOk = await frame.evaluate(() => document.getElementById('cidimg').naturalWidth)
  check('cid image shown without "Képek betöltése"', cidOk > 0, `naturalWidth=${cidOk}`)
  const extSrc = await frame.evaluate(() => document.getElementById('extimg').getAttribute('src'))
  check('external image not loaded before permission', extSrc === null && imageHits.length === 0, `src=${extSrc} hits=${imageHits.length}`)
  check('"Képek betöltése" bar visible', await page.locator('.images-bar').isVisible())
  if (values.shots) await page.screenshot({ path: path.join(values.shots, 'k6-cid-before.png') })
  await page.getByRole('button', { name: t.readerLoadImages, exact: true }).click()
  await page.waitForFunction(() => !document.querySelector('.images-bar'))
  frame = null
  for (let i = 0; i < 40 && !frame; i++) {
    const f = mailFrame(page)
    if (f && (await f.evaluate(() => !!document.getElementById('extimg') && document.getElementById('extimg').complete && document.getElementById('extimg').naturalWidth > 0).catch(() => false))) frame = f
    else await page.waitForTimeout(100)
  }
  check('external image loaded after "Képek betöltése"', frame && imageHits.length === 1, `hits=${JSON.stringify(imageHits)}`)
  check('net guard allowed exactly that host', readGuard().filter(l => / allow /.test(l)).every(l => l.endsWith(' allow image http://127.0.0.1:47811')) && readGuard().some(l => / allow /.test(l)))
  if (values.shots) await page.screenshot({ path: path.join(values.shots, 'k6-cid-after.png') })
  // the net guard on its own: with images on, the frame's CSP lets any http image through, so an image of
  // another host (inserted through DevTools, as a CSP gap would) must be stopped by the guard
  await frame.evaluate(() => {
    const img = document.createElement('img')
    img.src = 'http://127.0.0.1:47812/stray.png'
    document.body.appendChild(img)
  })
  await page.waitForTimeout(500)
  check('net guard alone blocks an image of a host that was not allowed', strayHits.length === 0 && readGuard().some(l => l.endsWith(' block image http://127.0.0.1:47812')), `strayHits=${strayHits.length}`)
  await openMessage(page, idOf('external-image.eml'))
  frame = await openMessage(page, cidId)
  const again = await frame.evaluate(() => document.getElementById('extimg').getAttribute('src'))
  check('opening another message and coming back: images blocked again', again === null && imageHits.length === 1 && (await page.locator('.images-bar').isVisible()), `src=${again} hits=${imageHits.length}`)

  // 4. attachments: the exe can only be saved, the pdf opens from data/tmp
  const exeItem = page.locator('.reader-attachments li[data-filename="telepito.exe"]')
  const pdfItem = page.locator('.reader-attachments li[data-filename="szamla.pdf"]')
  check('exe: no "Megnyitás" button, "Mentés…" present', (await exeItem.getByRole('button', { name: t.readerOpen, exact: true }).count()) === 0 && (await exeItem.getByRole('button', { name: t.readerSave, exact: true }).count()) === 1)
  await exeItem.getByRole('button', { name: t.readerSave, exact: true }).click()
  await page.waitForTimeout(200)
  const htmlItem = page.locator('.reader-attachments li[data-filename="szamla.pdf.html"]')
  check('html: no "Megnyitás" button, "Mentés…" present', (await htmlItem.getByRole('button', { name: t.readerOpen, exact: true }).count()) === 0 && (await htmlItem.getByRole('button', { name: t.readerSave, exact: true }).count()) === 1)
  const saved = (await k6(app)).saved
  check('exe saved where the save dialog said', saved.length === 1 && fs.readFileSync(saved[0]).subarray(0, 2).toString() === 'MZ', JSON.stringify(saved))
  await pdfItem.getByRole('button', { name: t.readerOpen, exact: true }).click()
  await page.waitForTimeout(200)
  const opened = (await k6(app)).opened
  check('pdf opened from data/tmp', opened.length === 1 && opened[0].startsWith(tmpDir + path.sep) && fs.readFileSync(opened[0]).subarray(0, 5).toString() === '%PDF-', JSON.stringify(opened))

  // 4b. "Megnyitás" only from the allow list; everything else save-only, with the reason
  await openMessage(page, idOf('openable-attachments.eml'))
  const item = name => page.locator(`.reader-attachments li[data-filename="${name}"]`)
  const hasOpen = async name => (await item(name).getByRole('button', { name: t.readerOpen, exact: true }).count()) === 1
  const hasSave = async name => (await item(name).getByRole('button', { name: t.readerSave, exact: true }).count()) === 1
  const reason = async name => item(name).locator('.hint.executable').innerText().catch(() => '')
  check('.docx and .txt have "Megnyitás"', (await hasOpen('dokumentum.docx')) && (await hasOpen('jegyzet.txt')))
  let k20ok = true
  for (const name of ['makro.docm', 'archivum.zip']) {
    if ((await hasOpen(name)) || !(await hasSave(name)) || (await reason(name)) !== t.readerNotOpenable) k20ok = false
  }
  check('.docm and .zip: no "Megnyitás", "Mentés…" and the reason shown', k20ok)
  check('szamla.pdf.exe counts as an executable (the last extension), save-only', !(await hasOpen('szamla.pdf.exe')) && (await hasSave('szamla.pdf.exe')) && (await reason('szamla.pdf.exe')) === t.readerExecutable)
  const before = (await k6(app)).opened.length
  await item('dokumentum.docx').getByRole('button', { name: t.readerOpen, exact: true }).click()
  await page.waitForTimeout(200)
  const openedNow = (await k6(app)).opened
  check('.docx opens from data/tmp', openedNow.length === before + 1 && path.basename(openedNow.at(-1)) === 'dokumentum.docx' && openedNow.at(-1).startsWith(tmpDir + path.sep), JSON.stringify(openedNow.slice(before)))

  // 5. charsets
  await openMessage(page, idOf('iso-8859-2.eml'))
  const isoText = await page.locator('.reader .mail-text').innerText()
  const isoSubject = await page.locator('.reader-subject').innerText()
  check('ISO-8859-2: subject and body accents', isoSubject === 'Ékezetes tárgy ISO-8859-2' && isoText.includes('Árvíztűrő tükörfúrógép. Őszi ősz, ünnepi űrhajó: ÁÉÍÓÖŐÚÜŰ áéíóöőúüű.'), `${isoSubject} | ${isoText}`)
  frame = await openMessage(page, idOf('windows-1250.eml'))
  const winText = await frame.evaluate(() => document.body.innerText)
  const winSubject = await page.locator('.reader-subject').innerText()
  check('windows-1250: subject and body accents', winSubject === 'Ékezetes tárgy windows-1250' && winText.includes('Árvíztűrő tükörfúrógép') && winText.includes('„idézet” – gondolatjel'), `${winSubject} | ${winText}`)

  // 6. data/tmp after a crash (no quit cleanup) is emptied by the next start
  const tmpBefore = fs.readdirSync(tmpDir)
  app.process().kill('SIGKILL')
  await new Promise(r => setTimeout(r, 500))
  const tmpAfterKill = fs.readdirSync(tmpDir).length
  ;({ app, page } = await launch())
  const left = fs.readdirSync(tmpDir)
  check('data/tmp: the opened pdf is still there after a crash, and gone after the next start', tmpBefore.length >= 1 && tmpAfterKill >= 1 && !left.some(n => tmpBefore.includes(n)), `before=${tmpBefore} afterKill=${tmpAfterKill} afterStart=${left}`)
  const guardAll = readGuard()
  check('net guard log at the end: every "allow" is the one allowed image host', guardAll.length > 0 && guardAll.filter(l => / allow /.test(l)).every(l => l.endsWith('http://127.0.0.1:47811')), `${guardAll.length} lines`)
  console.log(`net-guard.log (${guardAll.length} lines):\n${guardAll.join('\n')}`)
} catch (err) {
  if (!err.only) check('run', false, err.stack)
} finally {
  await app.close().catch(() => {})
  server.close()
  stray.close()
  if (!values.keep) fs.rmSync(work, { recursive: true, force: true })
  else console.log(`kept: ${work}`)
}
const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length} / ${results.length} OK`)
process.exit(failed.length ? 1 : 0)
