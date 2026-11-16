#!/usr/bin/env node
// The account's signature image in the real app, headless Electron + Playwright. Not part of `npm test`.
//
//   node test/e2e/signature-image-e2e.mjs          (E2E_LANG=en: the same in English)
//
// 1. The pixels stay: a PNG and a JPEG made by Electron's own encoder, with metadata put in (PNG tEXt; JPEG Exif with
//    a GPS note and an ICC profile), go through the app's check; the stored bytes decode (nativeImage) to the same bitmap
//    as the file, without the metadata, the ICC profile kept; a file without metadata is stored byte for byte.
// 2. The account editor: upload through the main process's dialog -> the preview shows the image at its size; a
//    1920 x 1080 image is refused with the numbers; after a restart the preview is there; Eltávolítás -> no image.
// 3. The editor screen has no native control and no unnamed icon button; the main log has the size and the type, not
//    the file's name or folder; the renderer console has no error or warning; the net-guard log is empty.
// Playwright: PW=<path of the playwright package> (default: the repo's playwright-core devDependency).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createVaultedDatabase } from '../../core/vault/vaulted-db.js'
import { AccountStore } from '../../core/accounts/model.js'
import { newAccountDefaults } from '../../core/accounts/defaults.js'
import { prepareSignatureImage } from '../../core/accounts/signature-image.js'
import { t, seedLanguage } from './lang.mjs'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const MASTER = 'Teszt-mesterjelszo-alairaskep'

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-sigimg-e2e-'))
const dataDir = path.join(work, 'data')
const files = path.join(work, 'Titkos-mappa')
fs.mkdirSync(dataDir)
fs.mkdirSync(files)
seedLanguage(dataDir)
let accountId
{
  const { db, vault } = await createVaultedDatabase(dataDir, MASTER)
  const store = new AccountStore(db, vault, { storeDir: path.join(dataDir, 'store') })
  accountId = store.save({ ...newAccountDefaults('pop3'), name: 'Kép-fiók', email: 'kep@example.invalid', in_host: '127.0.0.1', in_port: 1, in_security: 'none', in_user: 'u', in_password: 'jelszo-123456', smtp_host: '127.0.0.1', smtp_port: 1, smtp_security: 'none', signature: 'Üdv,\nKép Elek' }).account.id
  db.close()
}

const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const consoleLines = []

// metadata put into an encoder's output
function pngChunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}
const withPngText = png => Buffer.concat([png.subarray(0, 33), pngChunk('tEXt', Buffer.from('GPS\u000047.4979N 19.0402E', 'latin1')), png.subarray(33)])
function jpegSegment(marker, data) {
  const len = Buffer.alloc(2)
  len.writeUInt16BE(data.length + 2, 0)
  return Buffer.concat([Buffer.from([0xff, marker]), len, data])
}
function withJpegMeta(jpeg) {
  const t = Buffer.alloc(26)
  t.write('II', 0, 'latin1')
  t.writeUInt16LE(42, 2)
  t.writeUInt32LE(8, 4)
  t.writeUInt16LE(1, 8)
  t.writeUInt16LE(0x0112, 10)
  t.writeUInt16LE(3, 12)
  t.writeUInt32LE(1, 14)
  t.writeUInt16LE(1, 18) // Orientation 1: upright
  const exif = jpegSegment(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), t, Buffer.from('GPS 47.4979N 19.0402E', 'latin1')]))
  const icc = jpegSegment(0xe2, Buffer.from('ICC_PROFILE\0\x01\x01e2e-profile', 'latin1'))
  // after SOI and the encoder's own first segment (APP0 JFIF)
  const firstEnd = 4 + jpeg.readUInt16BE(4)
  return Buffer.concat([jpeg.subarray(0, firstEnd), exif, icc, jpeg.subarray(firstEnd)])
}

let app = null
const launch = async () => {
  app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
  await app.evaluate(({ dialog }) => {
    globalThis.__open = null
    dialog.showOpenDialog = async () => (globalThis.__open ? { canceled: false, filePaths: [globalThis.__open] } : { canceled: true, filePaths: [] })
  })
  const page = await app.firstWindow()
  page.on('console', m => (m.type() === 'error' || m.type() === 'warning') && consoleLines.push(`${m.type()}: ${m.text()}`))
  page.on('pageerror', e => consoleLines.push(`pageerror: ${e.message}`))
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  await page.getByRole('button', { name: t.viewSettings, exact: true }).waitFor({ timeout: 20_000 })
  return page
}
const choose = f => app.evaluate((_, file) => (globalThis.__open = file), f)
const openEditor = async page => {
  await page.getByRole('button', { name: t.viewSettings, exact: true }).click()
  await page.locator('.settings-tab', { hasText: t.settingsNav.accounts }).click()
  await page.getByRole('button', { name: t.accountEdit, exact: true }).first().click()
  await page.locator('form.account-editor .signature-image').waitFor()
}
const preview = page =>
  page.evaluate(() => {
    const img = document.querySelector('img.signature-image-preview')
    return img ? { w: img.naturalWidth, h: img.naturalHeight, src: img.getAttribute('src').slice(0, 22) } : null
  })

try {
  let page = await launch()

  // 1. the pixels, with the app's own encoder and decoder (the main process's nativeImage)
  const made = await app.evaluate(({ nativeImage }) => {
    const w = 320
    const h = 96
    const px = Buffer.alloc(w * h * 4)
    for (let i = 0; i < w * h; i++) px.set([(i * 7) % 256, (i * 13) % 256, (i * 29) % 256, 255], i * 4) // BGRA, opaque
    const img = nativeImage.createFromBitmap(px, { width: w, height: h })
    return { png: img.toPNG().toString('base64'), jpeg: img.toJPEG(90).toString('base64') }
  })
  const decodeIn = bytes => app.evaluate(({ nativeImage }, b64) => {
    const img = nativeImage.createFromBuffer(Buffer.from(b64, 'base64'))
    return img.isEmpty() ? null : { size: img.getSize(), bitmap: img.toBitmap().toString('base64') }
  }, bytes.toString('base64'))
  for (const [kind, plain, withMeta] of [['PNG', Buffer.from(made.png, 'base64'), b => withPngText(b)], ['JPEG', Buffer.from(made.jpeg, 'base64'), b => withJpegMeta(b)]]) {
    const original = withMeta(plain)
    const sizes = new Map()
    const decodeSync = bytes => sizes.get(bytes.toString('base64'))
    // the decoder is the app's; the pure check asks it synchronously, so the two candidate byte strings are decoded first
    const stored0 = prepareSignatureImage(original, { decode: () => ({ width: 320, height: 96 }) }).bytes
    for (const b of [stored0, plain]) sizes.set(b.toString('base64'), (await decodeIn(b))?.size ?? null)
    const stored = prepareSignatureImage(original, { decode: decodeSync })
    const [a, b] = [await decodeIn(original), await decodeIn(stored.bytes)]
    check(`${kind}: the stored bytes decode to the same bitmap as the file (${stored.width} x ${stored.height})`, a && b && a.bitmap === b.bitmap && b.size.width === 320 && b.size.height === 96)
    check(`${kind}: the metadata is gone from the stored bytes, it was in the file`, original.includes('47.4979N') && !stored.bytes.includes('47.4979N') && !stored.bytes.includes('Exif'))
    if (kind === 'JPEG') check('JPEG: the ICC profile (APP2) is kept', stored.bytes.includes('ICC_PROFILE'))
    check(`${kind}: a file without metadata is stored byte for byte`, prepareSignatureImage(plain, { decode: decodeSync }).bytes.equals(plain))
  }
  const logoFile = path.join(files, 'Titkos-logo-kep.png')
  fs.writeFileSync(logoFile, withPngText(Buffer.from(made.png, 'base64')))
  const bigFile = path.join(files, 'Titkos-nagy-kep.jpg')
  const big = await app.evaluate(({ nativeImage }) => nativeImage.createFromBitmap(Buffer.alloc(1920 * 1080 * 4, 0x80), { width: 1920, height: 1080 }).toJPEG(60).toString('base64'))
  fs.writeFileSync(bigFile, Buffer.from(big, 'base64'))

  // 2. the account editor
  await openEditor(page)
  check('no image yet: the note and "Kép feltöltése"', (await page.locator('.signature-image-none').count()) === 1 && (await page.locator('.signature-image-pick').innerText()).trim() === t.signatureImage.upload)
  await choose(bigFile)
  await page.locator('.signature-image-pick').click()
  await page.locator('.signature-image-error').waitFor({ timeout: 10_000 })
  const bigText = (await page.locator('.signature-image-error').innerText()).trim()
  check('a 1920 x 1080 image: refused with the numbers, nothing stored', bigText.includes('1920') && bigText.includes('1080') && bigText.includes('800') && (await page.locator('img.signature-image-preview').count()) === 0, bigText)
  await choose(logoFile)
  await page.locator('.signature-image-pick').click()
  await page.locator('img.signature-image-preview').waitFor({ timeout: 10_000 })
  await page.waitForFunction(() => document.querySelector('img.signature-image-preview')?.naturalWidth > 0)
  const p1 = await preview(page)
  check('uploaded: the preview shows the image at its size, from a data: URL', p1 && p1.w === 320 && p1.h === 96 && p1.src === 'data:image/png;base64,', JSON.stringify(p1))
  check('the button says "Csere", the error is gone', (await page.locator('.signature-image-pick').innerText()).trim() === t.signatureImage.replace && (await page.locator('.signature-image-error').count()) === 0)
  const audit = await page.evaluate(() => ({
    native: document.querySelectorAll('button:not([class]), select').length,
    unnamed: document.querySelectorAll('button.icon-btn:not([aria-label])').length,
    untitled: document.querySelectorAll('button.icon-btn:not([title])').length,
  }))
  check('the editor screen: no native control, every icon button named and titled', !audit.native && !audit.unnamed && !audit.untitled, JSON.stringify(audit))
  const accounts = await page.evaluate(() => window.shadowMail.compose.accounts())
  check('compose:accounts says hasImage, carries no bytes', accounts.ok && accounts.accounts[0].hasImage === true && !JSON.stringify(accounts).includes('base64') && !('signature_image' in accounts.accounts[0]), JSON.stringify(accounts).slice(0, 200))
  await app.close()
  app = null

  // after a restart
  page = await launch()
  await openEditor(page)
  await page.waitForFunction(() => document.querySelector('img.signature-image-preview')?.naturalWidth > 0, null, { timeout: 10_000 }).catch(() => {})
  const p2 = await preview(page)
  check('after a restart: the preview is there', p2 && p2.w === 320 && p2.h === 96, JSON.stringify(p2))
  await page.locator('.signature-image-remove').click()
  await page.locator('.signature-image-none').waitFor({ timeout: 10_000 })
  check('Eltávolítás: no image, "Kép feltöltése" again', (await page.locator('img.signature-image-preview').count()) === 0 && (await page.locator('.signature-image-pick').innerText()).trim() === t.signatureImage.upload)
  await app.close()
  app = null
} catch (err) {
  check('the run finished', false, err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : String(err))
} finally {
  if (app) await app.close().catch(() => {})
}

const mainLog = fs.readFileSync(path.join(dataDir, 'electron', 'logs', 'main.log'), 'utf8')
check('the main log: the stored image by type, size and dimensions', /signature image stored: image\/png \d+ B, 320x96, 1 metadata part/.test(mainLog))
check('the main log: the refusal by its code and numbers', /signatureImagePick: refused, too_large \(\d+ B, 1920x1080\)/.test(mainLog))
check('the main log: never the file\'s name or folder', !mainLog.includes('Titkos') && !mainLog.includes(files))
const guard = path.join(dataDir, 'electron', 'logs', 'net-guard.log')
check('net-guard log: no outgoing request', !fs.existsSync(guard) || fs.readFileSync(guard, 'utf8').trim() === '')
check('no renderer console error or warning', consoleLines.length === 0, consoleLines.slice(0, 3).join(' | '))
fs.rmSync(work, { recursive: true, force: true })
console.log(`\n${results.filter(Boolean).length} / ${results.length} OK`)
process.exit(results.every(Boolean) ? 0 : 1)
