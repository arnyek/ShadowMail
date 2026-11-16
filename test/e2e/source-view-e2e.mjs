#!/usr/bin/env node
// The source view in the real app (More -> Headers / Show original / Save as .eml).
// The data folder is the seed's (test/tools/seed-index.mjs --eml: an IMAP account at 127.0.0.1:1, nothing listens there,
// the messages are unread and already downloaded); the fixtures are written here, into a temporary folder (one is 3 MB).
// Not part of `npm test`.
//
//   node test/e2e/source-view-e2e.mjs
//
// Measures: HTML, image and link in the source -> no img/script/a/iframe in the Modal, the net-guard log empty; a U+202E
// in the subject -> the "⟨U+202E⟩" mark is shown, the raw character is not; a 3 MB message -> the Banner with its real
// size, and how long the Original tab took (must be under 2 s); the summary of a pass / fail / missing authentication
// triple (signs and text); saving from the menu and from the Modal gives the whole message byte for byte; the message
// is still unread afterwards (the IMAP server is unreachable here, so the reader's own \Seen fails too: the H1 unit test
// measures the real IMAP path); the tabs with the arrow keys; Esc closes and the focus goes back to More; Ctrl+C copies.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { t, locale, seedLanguage } from './lang.mjs'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// the source view's marks line for any count (no left-out ones): "N láthatatlan karakter … jelként látszik (⟨U+…⟩).";
// English words it differently for one mark, so the one-mark line is an alternative
const marksRe = new RegExp(`${esc(t.source.marks(1))}|${esc(t.source.marks(7)).replace(esc((7).toLocaleString(locale)), '\\d[\\d,\\s]*')}`)
const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-h2-e2e-'))
const emlDir = path.join(work, 'eml')
const dataDir = path.join(work, 'data')
const saveTo = path.join(work, 'saved')
fs.mkdirSync(emlDir)
fs.mkdirSync(saveTo)

const date = new Date().toUTCString()
const eml = (name, headers, body) => {
  const buf = Buffer.isBuffer(body) ? Buffer.concat([Buffer.from(headers.join('\r\n') + '\r\n\r\n'), body]) : Buffer.from(headers.join('\r\n') + '\r\n\r\n' + body)
  fs.writeFileSync(path.join(emlDir, name), buf)
  return buf
}
const base = (subject, extra = []) => [
  'From: Teszt Felado <felado-h2@example.invalid>',
  'To: h2@example.invalid',
  `Subject: ${subject}`,
  `Date: ${date}`,
  `Message-ID: <${subject.replace(/[^a-z0-9]/gi, '').slice(0, 20) || 'x'}-h2@example.invalid>`,
  ...extra,
  'MIME-Version: 1.0',
]
const RTL = '\u202e'
const raw = {
  hostile: eml('a-hostile.eml', [...base('H2 hostile'), 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: 8bit'],
    '<html><body><img src="http://example.invalid/x.png"><script>document.title="pwned"</script><a href="http://example.invalid">katt</a><iframe src="http://example.invalid/f"></iframe></body></html>\r\n'),
  rtl: eml('b-rtl.eml', [...base(`H2 Szamla ${RTL}fdp.exe`), 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit'], `Szöveg ${RTL}fordított\r\n`),
  big: eml('c-big.eml', [...base('H2 big'), 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit'],
    Buffer.from(('x'.repeat(76) + '\r\n').repeat(Math.ceil((3 * 1024 * 1024) / 78)))),
  pass: eml('d-pass.eml', [...base('H2 auth pass', ['Authentication-Results: mx.example.invalid; spf=pass smtp.mailfrom=example.invalid; dkim=pass header.d=example.invalid; dmarc=pass'])], 'pass\r\n'),
  fail: eml('e-fail.eml', [...base('H2 auth fail', ['Authentication-Results: mx.example.invalid; spf=softfail smtp.mailfrom=example.invalid; dkim=fail; dmarc=fail (p=reject)'])], 'fail\r\n'),
  none: eml('f-none.eml', base('H2 auth none'), 'none\r\n'),
  // 2 MB of control characters (U+0001) and, for the timing, 2 MB of ordinary text of the same shape
  ctl: eml('g-ctl.eml', [...base('Forras control'), 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit'], Buffer.alloc(2 * 1024 * 1024, 1)),
  plain: eml('h-plain.eml', [...base('Forras plain'), 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit'], Buffer.alloc(2 * 1024 * 1024, 0x78)),
}

const seed = JSON.parse(execFileSync(process.execPath, [path.join(repo, 'test', 'tools', 'seed-index.mjs'), dataDir, '--count', '3', '--eml', emlDir], { encoding: 'utf8' }))
seedLanguage(dataDir)
const idOf = file => seed.eml.find(e => e.file === file).id

const consoleProblems = []
const app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
try {
  await app.evaluate(({ dialog }, dir) => {
    globalThis.__saved = []
    dialog.showSaveDialog = async (...args) => {
      const opts = args[args.length - 1]
      const filePath = `${dir}/${globalThis.__saved.length}-${opts.defaultPath}`
      globalThis.__saved.push(filePath)
      return { canceled: false, filePath }
    }
  }, saveTo)
  const page = await app.firstWindow()
  page.on('console', m => (m.type() === 'error' || m.type() === 'warning') && consoleProblems.push(m.text()))
  page.on('pageerror', e => consoleProblems.push(e.message))
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.locator('#vault-unlock').fill(seed.master)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  await page.locator('.msg-row[data-id]').first().waitFor({ timeout: 30_000 })

  const modal = page.locator('.source-modal')
  const flagsOf = id => page.evaluate(async ([accountId, i]) => (await window.shadowMail.mail.list({ accountId, folder: 'INBOX', limit: 500 })).rows.find(r => r.id === i)?.flags ?? null, [seed.accountId, id])
  const openMessage = async file => {
    const id = idOf(file)
    if (await page.locator('.reader-back').count()) await page.locator('.reader-back').click()
    await page.locator(`.msg-row[data-id="${id}"]`).click()
    await page.locator(`.reader[data-message-id="${id}"]`).waitFor()
    return id
  }
  const more = () => page.locator('.reader-tools').getByRole('button', { name: t.readerMore, exact: true })
  const menu = async item => {
    await more().click()
    await page.getByRole('menuitem', { name: item, exact: true }).click()
  }
  const openSource = async (file, item = t.source.menuHeaders) => {
    await openMessage(file)
    await menu(item)
    await modal.waitFor()
    await modal.locator('.source-panel[aria-busy="false"]').waitFor({ timeout: 10_000 })
  }
  const closeModal = async () => {
    await page.keyboard.press('Escape')
    await modal.waitFor({ state: 'detached' })
  }

  // 1. HTML, image, script and link in the source: text only
  const hostileId = idOf('a-hostile.eml')
  const flagsBefore = await flagsOf(hostileId)
  await openSource('a-hostile.eml')
  check('the menu "Fejlécek" opens the Modal on the Fejlécek tab', (await modal.locator('[role=tab][aria-selected=true]').getAttribute('data-tab')) === 'headers')
  await modal.getByRole('tab', { name: t.source.tabs.original, exact: true }).click()
  const original = await modal.locator('pre.source-original').innerText()
  check('the Original tab shows the HTML source as text', original.includes('<img src="http://example.invalid/x.png">') && original.includes('<script>') && original.includes('<a href="http://example.invalid">'))
  const elements = await modal.evaluate(m => ['img', 'script', 'a', 'iframe', 'object', 'embed', 'link', 'style'].map(t => `${t}=${m.querySelectorAll(t).length}`).join(' '))
  check('no img, script, a, iframe (or other loading element) inside the Modal', /^(\w+=0 ?)+$/.test(elements), elements)
  check('the script did not run', (await page.title()) !== 'pwned')
  // the tabs with the keyboard
  await modal.getByRole('tab', { name: t.source.tabs.original, exact: true }).focus()
  await page.keyboard.press('ArrowLeft')
  const afterLeft = await modal.locator('[role=tab][aria-selected=true]').getAttribute('data-tab')
  await page.keyboard.press('End')
  const afterEnd = await modal.locator('[role=tab][aria-selected=true]').getAttribute('data-tab')
  check('the tabs move with the arrow keys and Home/End', afterLeft === 'headers' && afterEnd === 'original', `${afterLeft}, ${afterEnd}`)
  // Ctrl+C copies the selected text
  await modal.locator('pre.source-original').evaluate(pre => {
    const r = document.createRange()
    r.selectNodeContents(pre)
    const s = window.getSelection()
    s.removeAllRanges()
    s.addRange(r)
  })
  await page.keyboard.press('Control+C')
  const copied = await app.evaluate(async ({ clipboard }) => await clipboard.readText())
  check('the text is selectable and Ctrl+C copies it', copied.includes('<script>document.title="pwned"</script>'), `${copied.length} characters`)
  await closeModal()
  const focused = await page.evaluate(() => document.activeElement && document.activeElement.getAttribute('aria-label'))
  check('Esc closes the Modal and the focus goes back to More; the reader stays open', focused === t.readerMore && (await page.locator(`.reader[data-message-id="${hostileId}"]`).count()) === 1, String(focused))

  // 2. saving: from the menu and from the Modal, the whole message byte for byte
  await menu(t.source.menuSave)
  let saved = []
  for (let i = 0; i < 50 && !(saved.length && fs.existsSync(saved[0])); i++) {
    await page.waitForTimeout(100)
    saved = await app.evaluate(() => globalThis.__saved)
  }
  check('Save as .eml from the menu: the whole message, byte for byte', saved.length === 1 && fs.existsSync(saved[0]) && Buffer.compare(fs.readFileSync(saved[0]), raw.hostile) === 0, saved.join(','))
  await menu(t.source.menuOriginal)
  await modal.waitFor()
  check('the menu "Eredeti megjelenítése" opens the Modal on the Eredeti tab', (await modal.locator('[role=tab][aria-selected=true]').getAttribute('data-tab')) === 'original')
  await modal.locator('.source-save').click()
  await modal.locator('.source-notice').waitFor()
  saved = await app.evaluate(() => globalThis.__saved)
  check('Save as .eml from the Modal: the whole message, byte for byte, and a notice', saved.length === 2 && Buffer.compare(fs.readFileSync(saved[1]), raw.hostile) === 0 && (await modal.locator('.source-notice').innerText()).includes(t.source.saved))
  check('the file name is the subject', path.basename(saved[1]) === '1-H2 hostile.eml', path.basename(saved[1]))
  await modal.getByRole('button', { name: t.close, exact: true }).last().click()
  await modal.waitFor({ state: 'detached' })
  const flagsAfter = await flagsOf(hostileId)
  check('the message is still unread after the source view and both saves', flagsBefore !== null && !/\\Seen/.test(flagsBefore) && !/\\Seen/.test(flagsAfter), `${JSON.stringify(flagsBefore)} -> ${JSON.stringify(flagsAfter)}`)

  // 3. U+202E in the subject
  await openSource('b-rtl.eml')
  const subjectCell = modal.locator('tr[data-row="subject"] td')
  const subjectText = await subjectCell.innerText()
  const modalText = await modal.innerText()
  check('the subject shows the ⟨U+202E⟩ mark as its own element', subjectText.includes('⟨U+202E⟩') && (await subjectCell.locator('.ctl-mark').count()) === 1, JSON.stringify(subjectText))
  check('the raw U+202E is nowhere in the Modal (summary, raw header)', !modalText.includes(RTL) && (await modal.locator('pre.source-headers .ctl-mark').count()) >= 1)
  check('the marks are counted under the summary', marksRe.test(modalText))
  await closeModal()

  // 4. a 3 MB message: the Banner with the real size, under 2 s
  await openMessage('c-big.eml')
  await more().click()
  const t0 = await page.evaluate(() => performance.now())
  await page.getByRole('menuitem', { name: t.source.menuOriginal, exact: true }).click()
  await modal.locator('.source-truncated').waitFor({ timeout: 10_000 })
  await modal.locator('pre.source-original').waitFor()
  const ms = (await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(performance.now()))))) - t0
  const banner = await modal.locator('.source-truncated').innerText()
  const sizeText = `${(raw.big.length / 1024 / 1024).toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`
  check('3 MB: the Banner with the real size', banner.includes(t.source.truncated(sizeText)), `${banner} (${raw.big.length} bytes)`)
  check('3 MB: the view is up in under 2 s', ms < 2000, `${Math.round(ms)} ms`)
  const shownLen = await modal.locator('pre.source-original').evaluate(p => p.textContent.length)
  check('3 MB: 2 097 152 characters shown', shownLen === 2 * 1024 * 1024, String(shownLen))
  const t1 = await page.evaluate(() => performance.now())
  await modal.getByRole('tab', { name: t.source.tabs.headers, exact: true }).click()
  await modal.locator('pre.source-headers').waitFor()
  const t2 = await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(performance.now()))))
  check('3 MB: switching to Fejlécek answers in under 2 s', t2 - t1 < 2000, `${Math.round(t2 - t1)} ms`)
  await closeModal()
  console.log(`MEASURED 3 MB Original tab: ${Math.round(ms)} ms, back to Fejlécek: ${Math.round(t2 - t1)} ms`)

  // 5. the summary of the authentication triple
  const expect = {
    'd-pass.eml': { spf: ['pass', 'ok', t.source.authResults.pass], dkim: ['pass', 'ok', t.source.authResults.pass], dmarc: ['pass', 'ok', t.source.authResults.pass], note: t.source.authBy('mx.example.invalid') },
    'e-fail.eml': { spf: ['softfail', 'bad', t.source.authResults.softfail], dkim: ['fail', 'bad', t.source.authResults.fail], dmarc: ['fail', 'bad', t.source.authResults.fail], note: t.source.authBy('mx.example.invalid') },
    'f-none.eml': { spf: ['missing', 'neutral', t.source.authMissing], dkim: ['missing', 'neutral', t.source.authMissing], dmarc: ['missing', 'neutral', t.source.authMissing], note: t.source.authNone },
  }
  for (const [file, want] of Object.entries(expect)) {
    await openSource(file)
    const got = []
    let ok = true
    for (const m of ['spf', 'dkim', 'dmarc']) {
      const v = modal.locator(`tr[data-row="${m}"] .auth-value`)
      const result = await v.getAttribute('data-result')
      const cls = await v.getAttribute('class')
      const text = (await v.innerText()).trim()
      got.push(`${m}=${result}/${cls}/${text}`)
      ok &&= result === want[m][0] && cls.includes(`auth-${want[m][1]}`) && text === want[m][2]
    }
    const note = await modal.locator('.source-auth-note').innerText()
    const rows = await modal.locator('.source-summary tr').evaluateAll(trs => trs.map(t => t.dataset.row).join(','))
    check(`summary ${file}: signs and text`, ok && note.includes(want.note), got.join(' | '))
    check(`summary ${file}: Feladó, Címzett, Dátum, Tárgy, Message-ID, SPF, DKIM, DMARC`, rows === 'from,to,date,subject,messageId,spf,dkim,dmarc', rows)
    await closeModal()
  }

  // 6. 2 MB of control characters vs. 2 MB of ordinary text, the Original tab, 3 openings each (median)
  const openOriginal = async file => {
    await openMessage(file)
    await more().click()
    const t0 = await page.evaluate(() => performance.now())
    await page.getByRole('menuitem', { name: t.source.menuOriginal, exact: true }).click()
    await modal.locator('pre.source-original').waitFor({ timeout: 20_000 })
    const t1 = await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(performance.now()))))
    return t1 - t0
  }
  const median = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]
  const times = { ctl: [], plain: [] }
  for (let i = 0; i < 3; i++) {
    for (const [k, file] of [['plain', 'h-plain.eml'], ['ctl', 'g-ctl.eml']]) {
      times[k].push(await openOriginal(file))
      if (k === 'ctl' && i === 0) {
        const pre = modal.locator('pre.source-original')
        const shown = await page.evaluate(i => window.shadowMail.mail.source(i), idOf('g-ctl.eml'))
        const ctlChars = [...shown.text].filter(c => c === '\u0001').length
        const info = await pre.evaluate(p => ({ len: p.textContent.length, marks: [...p.querySelectorAll('.ctl-mark')].reduce((n, e) => n + (e.textContent.match(/U\+/g) || []).length, 0), raw: p.textContent.includes('\u0001'), summary: [...p.querySelectorAll('.ctl-summary')].map(s => s.textContent.trim()) }))
        check('2 MB control: 10 000 marks, no raw character, the text within 2 MB', info.marks === 10_000 && !info.raw && info.len <= 2 * 1024 * 1024, JSON.stringify({ len: info.len, marks: info.marks, raw: info.raw }))
        const hint = await modal.locator('.source-marks').innerText()
        check('2 MB control: the hint line names the 10 000 drawn and the left-out ones apart', hint === t.source.marks(10_000, ctlChars - 10_000), hint)
        check('2 MB control: the closing line with the exact count of the rest', info.summary.length === 1 && info.summary[0] === t.source.unmarked(ctlChars - 10_000), JSON.stringify(info.summary))
      }
      await closeModal()
    }
  }
  const mc = median(times.ctl)
  const mp = median(times.plain)
  console.log(`MEASURED Original tab, median of 3: 2 MB control ${Math.round(mc)} ms (${times.ctl.map(Math.round).join(', ')}), 2 MB plain ${Math.round(mp)} ms (${times.plain.map(Math.round).join(', ')})`)
  check('2 MB of control characters opens no slower than 2 MB of plain text + 20 %', mc <= mp * 1.2, `${Math.round(mc)} ms vs ${Math.round(mp)} ms`)

  // logs
  const log = fs.readFileSync(path.join(dataDir, 'electron', 'logs', 'main.log'), 'utf8')
  const leaked = ['H2 hostile', 'felado-h2', 'example.invalid/x.png', 'Szamla', 'auth pass'].filter(w => log.includes(w))
  check('main.log: no subject, sender or text of the messages', leaked.length === 0, leaked.join(','))
  check('no console error or warning in the renderer', consoleProblems.length === 0, consoleProblems.join(' | '))
  const netLog = path.join(dataDir, 'electron', 'logs', 'net-guard.log')
  check('the net-guard log has no outgoing request', !fs.existsSync(netLog) || fs.readFileSync(netLog, 'utf8').trim() === '', fs.existsSync(netLog) ? fs.readFileSync(netLog, 'utf8').slice(0, 300) : '')
} catch (err) {
  check('the run', false, err.stack)
} finally {
  await app.close().catch(() => {})
  fs.rmSync(work, { recursive: true, force: true })
}
const ok = results.filter(Boolean).length
console.log(`${ok} / ${results.length} ${ok === results.length ? 'OK' : 'FAIL'}`)
process.exit(ok === results.length ? 0 : 1)
