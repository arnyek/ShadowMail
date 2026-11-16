#!/usr/bin/env node
// The grep check of the sealed mail files, headless Electron + Playwright. Not part of `npm test`.
//
//   node test/e2e/grep-e2e.mjs
//
// One message carries a unique word in its subject, body, sender address and attachment file name, and in
// the bytes and the URL of an external image. In the real app: the POP3 download, opening it, "Képek
// betöltése", a search for the word, a reply saved as a draft (sealed POP3 draft). After quitting, every
// file under data\ is searched for the word, UTF-8 and UTF-16LE, any case: no file may hold it.
// Everything stays on this machine (fake POP3, local HTTP image server).
// Playwright: PW=<path of the playwright package> (default: the repo's playwright-core devDependency).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { FakePop3Server } from '../helpers/fake-pop3.js'
import { createVaultedDatabase } from '../../core/vault/vaulted-db.js'
import { AccountStore } from '../../core/accounts/model.js'
import { newAccountDefaults } from '../../core/accounts/defaults.js'
import { t, locale, seedLanguage } from './lang.mjs'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const MASTER = 'Teszt-mesterjelszo-pecset-grep'
const USER = 'teszt@example.invalid'
// unique per run, so nothing in the program or an earlier run can hold it
const WORD = `Nyomszo${crypto.randomBytes(4).toString('hex')}`

// the composer's "draft saved" line without its time: "Piszkozat mentve" / "Draft saved at"
const savedPrefix = (() => {
  const d = new Date()
  const text = t.composeSavedAt(d)
  return text.slice(0, text.indexOf(d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }))).replace(/[:\s]+$/, '')
})()

const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}

// a 1x1 PNG with the word in a tEXt chunk: if the image bytes reach the disk, the grep finds them
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(zlib.crc32(td))
  return Buffer.concat([len, td, crc])
}
const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0])
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('tEXt', Buffer.from(`Comment\0${WORD}`, 'latin1')),
  chunk('IDAT', zlib.deflateSync(Buffer.from([0, 0, 0, 0, 0]))),
  chunk('IEND', Buffer.alloc(0)),
])
const imageHits = []
const images = http.createServer((req, res) => {
  imageHits.push(req.url)
  res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' })
  res.end(png)
})
await new Promise(r => images.listen(0, '127.0.0.1', r))
const imgUrl = `http://127.0.0.1:${images.address().port}/${WORD}.png`

const boundary = 'b-k18-grep'
const message = [
  `From: ${WORD} Feladó <${WORD.toLowerCase()}@example.invalid>`,
  `To: ${USER}`,
  `Subject: ${WORD} tárgy`,
  `Date: ${new Date().toUTCString()}`,
  `Message-ID: <${WORD.toLowerCase()}@example.invalid>`,
  'MIME-Version: 1.0',
  `Content-Type: multipart/mixed; boundary="${boundary}"`,
  '',
  `--${boundary}`,
  'Content-Type: text/html; charset=utf-8',
  '',
  `<p>${WORD} a törzsben.</p><p><img src="${imgUrl}" alt="kep"></p>`,
  `--${boundary}`,
  `Content-Type: text/plain; name="${WORD}-melleklet.txt"`,
  `Content-Disposition: attachment; filename="${WORD}-melleklet.txt"`,
  '',
  `melléklet ${WORD}`,
  `--${boundary}--`,
  '',
].join('\r\n')
const pop = await new FakePop3Server().listen()
pop.add(Buffer.from(message))

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-k18-'))
const dataDir = path.join(work, 'data')
fs.mkdirSync(dataDir)
seedLanguage(dataDir)
{
  const { db, vault } = await createVaultedDatabase(dataDir, MASTER)
  const store = new AccountStore(db, vault, { storeDir: path.join(dataDir, 'store') })
  store.save({
    ...newAccountDefaults('pop3'), name: 'POP3-fiók', email: USER, display_name: 'Teszt Elek',
    in_host: '127.0.0.1', in_port: pop.port, in_security: 'none', in_user: pop.user, in_password: pop.pass,
    smtp_host: '127.0.0.1', smtp_port: 1, smtp_security: 'none',
  })
  db.close()
}

const watchdog = setTimeout(() => {
  console.log('FAIL watchdog: the run took more than 4 minutes')
  process.exit(1)
}, 240_000)
watchdog.unref()

const app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
try {
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  // POP3 download (sealed into data\store)
  const row = page.locator('.msg-row', { hasText: WORD })
  await row.waitFor({ timeout: 30_000 })
  check('POP3: the message is downloaded and listed', true)
  // open, load images
  await row.click()
  await page.locator('.reader').waitFor()
  await page.getByRole('button', { name: t.readerLoadImages, exact: true }).click()
  const loaded = await (async () => {
    for (let i = 0; i < 50; i++) {
      if (imageHits.length) return true
      await page.waitForTimeout(100)
    }
    return false
  })()
  check('the message opens, "Képek betöltése" fetches the image', loaded, JSON.stringify(imageHits))
  check('the attachment is listed', (await page.locator('.reader').innerText()).includes(`${WORD}-melleklet.txt`))
  // search for the word
  const box = page.getByRole('searchbox', { name: t.searchLabel })
  await box.fill(WORD)
  await page.locator('.result').first().waitFor({ timeout: 10_000 })
  check('the search finds it', (await page.locator('.result').count()) >= 1)
  await box.press('Escape')
  // a reply saved as a draft (POP3: a sealed local draft)
  await row.click()
  await page.locator('.reader').waitFor()
  const [win] = await Promise.all([app.waitForEvent('window', { timeout: 15_000 }), page.locator('.reader-tools').getByRole('button', { name: t.replyModes.reply, exact: true }).click()])
  await win.setViewportSize({ width: 900, height: 700 })
  await win.waitForFunction(() => document.querySelector('#compose-subject')?.value)
  await win.locator('.editor').click()
  await win.keyboard.type(`Valasz a ${WORD} levelre. `)
  await win.getByRole('button', { name: t.composeSaveDraft, exact: true }).click()
  await win.locator('.hint[role="status"]').filter({ hasText: savedPrefix }).waitFor({ timeout: 20_000 })
  const drafts = await page.evaluate(async () => {
    const f = (await window.shadowMail.mail.folders()).accounts[0].folders.find(x => x.path === 'Drafts')
    return f ? f.count : -1
  })
  check('the reply is saved as a draft (local Drafts)', drafts === 1, `Drafts: ${drafts}`)
} catch (err) {
  check('run', false, err.stack)
} finally {
  await app.close().catch(() => {})
  await pop.close()
  images.close()
}

// every file under data\, the word in UTF-8 and UTF-16LE, original and lower case
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]))
const files = walk(dataDir)
const needles = [...new Set([WORD, WORD.toLowerCase()])].flatMap(w => [Buffer.from(w, 'utf8'), Buffer.from(w, 'utf16le')])
const found = files.filter(f => {
  const b = fs.readFileSync(f)
  return needles.some(n => b.includes(n))
})
const storeFiles = files.filter(f => f.includes(`${path.sep}store${path.sep}`))
check('data\\store holds the sealed message and the draft', storeFiles.length >= 2, `${storeFiles.length} files`)
check(`grep -r -a for the word (UTF-8 and UTF-16LE) over the whole data folder: no file holds it`, found.length === 0, `${files.length} files searched; found in: ${found.map(f => path.relative(dataDir, f)).join(', ') || 'none'}`)
const mainLog = fs.readFileSync(path.join(dataDir, 'electron', 'logs', 'main.log'), 'utf8')
check('the main log: no error or failure line', !/failed|error/i.test(mainLog), mainLog.trim().split('\n').filter(l => /failed|error/i.test(l)).join(' | '))
console.log(`  word: ${WORD}; files: ${files.length}`)

fs.rmSync(work, { recursive: true, force: true })
console.log(`\n${results.filter(Boolean).length} / ${results.length} OK`)
process.exit(results.every(Boolean) ? 0 : 1)
