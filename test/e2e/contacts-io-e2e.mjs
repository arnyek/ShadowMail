#!/usr/bin/env node
// Contacts import and export in the real app: contacts:importPreview / importApply / export through the app's own IPC bridge,
// the main process's dialogs replaced inside the app (nothing opens on the machine). Not part of `npm test`.
//
//   node test/e2e/contacts-io-e2e.mjs
//
// Measures: a vCard fixture imports (new = its contacts); people saved by hand; export all as vCard and as CSV ->
// the file is the one chosen in the save dialog, named <t.contactsExportBase>-<date> (ShadowMail-cimlista / ShadowMail-contacts); each file imported back: new 0,
// unchanged = the count, and the apply changes nothing; the page never gets a path; main.log holds no name, address or
// file name; no console problem; the net-guard log is empty.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createVaultedDatabase } from '../../core/vault/vaulted-db.js'
import { t, seedLanguage } from './lang.mjs'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const MASTER = 'Teszt-mesterjelszo-import'
const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-c3-e2e-'))
const dataDir = path.join(work, 'data')
const files = path.join(work, 'files')
fs.mkdirSync(dataDir)
fs.mkdirSync(files)
{
  const { db } = await createVaultedDatabase(dataDir, MASTER)
  db.close()
}
seedLanguage(dataDir)
const fixture = path.join(files, 'Titkos-forras.vcf')
fs.copyFileSync(path.join(repo, 'test', 'fixtures', 'contacts', 'iphone-3.0.vcf'), fixture)

const consoleProblems = []
const app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
try {
  await app.evaluate(({ dialog }, dir) => {
    globalThis.__saved = []
    globalThis.__open = null
    dialog.showSaveDialog = async (...args) => {
      const opts = args[args.length - 1]
      globalThis.__saved.push(opts.defaultPath)
      return { canceled: false, filePath: `${dir}/${opts.defaultPath}` }
    }
    dialog.showOpenDialog = async () => (globalThis.__open ? { canceled: false, filePaths: [globalThis.__open] } : { canceled: true, filePaths: [] })
  }, files)
  const choose = f => app.evaluate((_, file) => (globalThis.__open = file), f)
  const page = await app.firstWindow()
  page.on('console', m => (m.type() === 'error' || m.type() === 'warning') && consoleProblems.push(m.text()))
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  await page.locator('header.app-header').waitFor({ timeout: 30_000 })
  const api = (method, ...args) => page.evaluate(([m, a]) => window.shadowMail.contacts[m](...a), [method, args])

  // 1. import the iPhone fixture
  await choose(fixture)
  const p1 = await api('importPreview')
  check('import preview of a vCard: 1 new', p1.ok && JSON.stringify(p1.counts) === '{"new":1,"merged":0,"unchanged":0,"invalid":0,"warnings":0}', JSON.stringify(p1))
  check('the preview answer has no path and no file name', !JSON.stringify(p1).includes(work) && !JSON.stringify(p1).includes('Titkos-forras'))
  const a1 = await api('importApply', p1.token)
  check('import apply: 1 new', a1.ok && a1.counts.new === 1, JSON.stringify(a1))

  // 2. people by hand
  for (const person of [
    { displayName: 'Kézi Béla', org: '=1+1', emails: ['bela-c3@example.invalid'], phones: ['+36 1 234 5678'], note: 'két\nsor' },
    { displayName: 'Ödön Ágnes', emails: ['odon-c3@example.invalid', 'odon2-c3@example.invalid'] },
    { emails: ['csakcim-c3@example.invalid'] },
  ]) {
    const r = await api('save', person)
    if (!r.ok) check('save', false, JSON.stringify(r))
  }
  const count = (await api('count')).count
  check('4 people in the book', count === 4, String(count))

  // 3. export vCard and CSV, both back
  for (const format of ['vcf', 'csv']) {
    const e = await api('export', { all: true, format })
    const name = await app.evaluate(() => globalThis.__saved[globalThis.__saved.length - 1])
    const file = path.join(files, name)
    check(`export ${format}: all 4, the chosen file, ${t.contactsExportBase}-<date>.${format}`, e.ok && e.saved && e.count === 4 && new RegExp(`^${t.contactsExportBase}-\\d{4}-\\d{2}-\\d{2}\\.(vcf|csv)$`).test(name) && fs.existsSync(file), `${JSON.stringify(e)} ${name}`)
    check(`export ${format}: no temporary file left`, fs.readdirSync(files).every(n => !n.endsWith('.tmp')))
    await choose(file)
    const p = await api('importPreview')
    check(`the ${format} export imported back: new 0, unchanged 4`, p.ok && JSON.stringify(p.counts) === '{"new":0,"merged":0,"unchanged":4,"invalid":0,"warnings":0}', JSON.stringify(p.counts))
    const before = JSON.stringify(await Promise.all((await api('list', { limit: 200 })).items.map(i => api('get', i.id))))
    const a = await api('importApply', p.token)
    const after = JSON.stringify(await Promise.all((await api('list', { limit: 200 })).items.map(i => api('get', i.id))))
    check(`the ${format} re-import apply changes nothing`, a.ok && a.counts.unchanged === 4 && before === after, JSON.stringify(a))
  }
  const csvName = (await app.evaluate(() => globalThis.__saved)).find(n => n.endsWith('.csv'))
  const csv = fs.readFileSync(path.join(files, csvName), 'utf8')
  check("the CSV: BOM, Google header, '=1+1 guarded, the phone unguarded", csv.startsWith('﻿Name,') && csv.includes("'=1+1") && csv.includes(',+36 1 234 5678'))
  check('a used token: preview_expired', (await api('importApply', p1.token)).error === 'preview_expired')

  const log = fs.readFileSync(path.join(dataDir, 'electron', 'logs', 'main.log'), 'utf8')
  const leaked = ['Kézi', 'Béla', 'Ödön', 'Árvíztűrő', 'Tükörfúrógép', 'example.invalid', 'example.hu', 'Titkos-forras', t.contactsExportBase, files].filter(w => log.includes(w))
  // (the data folder's path is in the start line by design; the chosen files' folder must not be)
  check('main.log: no name, address, file name or the files\' path', leaked.length === 0, leaked.join(','))
  check('main.log: the import and export logged with counts', /contacts: import preview \(vcf, \d+ bytes\): new 1/.test(log) && /contacts: exported 4 \(csv, \d+ bytes\)/.test(log))
  check('no console error or warning in the renderer', consoleProblems.length === 0, consoleProblems.join(' | '))
  const netLog = path.join(dataDir, 'electron', 'logs', 'net-guard.log')
  check('the net-guard log has no outgoing request', !fs.existsSync(netLog) || fs.readFileSync(netLog, 'utf8').trim() === '')
} catch (err) {
  check('the run', false, err.stack)
} finally {
  await app.close().catch(() => {})
  fs.rmSync(work, { recursive: true, force: true })
}
const ok = results.filter(Boolean).length
console.log(`${ok} / ${results.length} ${ok === results.length ? 'OK' : 'FAIL'}`)
process.exit(ok === results.length ? 0 : 1)
