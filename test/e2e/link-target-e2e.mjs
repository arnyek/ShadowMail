#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// The link-target bar in the real app (headless Electron + Playwright). Not part of `npm test`.
//
//   node test/e2e/link-target-e2e.mjs [--shots <folder>]
//
// A POP3 account (fake POP3 server) with an HTML message full of synthetic links and a plain-text message with a URL.
// Measured: hovering a link in the message frame (which runs no script) shows its REAL target in a bar over the
// bottom-left corner of the message, the registered domain in bold; the bar goes when the mouse leaves the link
// (inside the frame) and when it leaves the frame straight from a link; a link whose text shows another registered
// domain gets the red warning with the real host and the text's host, a subdomain of the same domain and a text that is
// not an address do not; a punycode host shows in both forms; mailto shows the address; "user@host" URLs show the real
// host; a long URL keeps its host visible and cuts the middle; Tab onto a link shows it; the bar never takes the
// pointer; the frame's sandbox is unchanged; a plain-text message's addresses are links with the bar too. Two languages: E2E_LANG=en|hu.
// Playwright: PW=<path of the playwright package> (default: the repo's playwright-core devDependency).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { FakePop3Server } from '../helpers/fake-pop3.js'
import { createVaultedDatabase } from '../../core/vault/vaulted-db.js'
import { AccountStore } from '../../core/accounts/model.js'
import { newAccountDefaults } from '../../core/accounts/defaults.js'
import { t, seedLanguage } from './lang.mjs'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const MASTER = 'Teszt-mesterjelszo-linkcel'
const shotsAt = process.argv.indexOf('--shots')
const shots = shotsAt > 0 ? path.resolve(process.argv[shotsAt + 1]) : null
const sleep = ms => new Promise(r => setTimeout(r, ms))

// the synthetic links: id, text, href
const LONG_PATH = `/a/${'nagyon-hosszu-utvonal-'.repeat(12)}vege?token=${'x'.repeat(80)}`
const LONG_HREF = `https://evil.example.com/${'a'.repeat(9000)}`
// the cut (8192 characters) falls in the user part: the first 8192 characters end in "...a.a.otpbank.hu"
const SPOOF_HREF = `https://${`aa${'a.'.repeat(4086)}otpbank.hu`.padEnd(8184, 'a')}${'b'.repeat(900)}@evil.example/x`
const LINKS = [
  ['same', 'otpbank.hu', 'https://www.otpbank.hu/'],
  ['sub', 'www.otpbank.hu/belepes', 'https://login.otpbank.hu/belepes'],
  ['other', 'otpbank.hu', 'https://otpbank-login.example.com/belepes?u=1'],
  ['url-text', 'https://www.otpbank.hu/belepes', 'https://otpbank.hu.evil.example.net/'],
  ['plain-words', 'Kattints ide', 'https://otpbank-login.example.com/'],
  ['puny', 'otpbank.hu', 'https://xn--tpbank-vxa.hu/belepes'],
  ['puny-plain', 'Belépés', 'https://xn--tpbank-vxa.hu/'],
  ['userinfo', 'Bank', 'https://otpbank.hu@evil.example.org/login'],
  ['couk-same', 'bbc.co.uk', 'https://news.bbc.co.uk/'],
  ['couk-other', 'bbc.co.uk', 'https://bbc-news.co.uk/'],
  ['mail', 'info@example.org', 'mailto:support@evil.example.com?subject=Hi'],
  ['long', 'Részletek', `https://shop.example.com${LONG_PATH}`],
  ['file', 'szamla.pdf', 'https://cdn.example.net/files/szamla.pdf'],
  ['longhost', 'Belépés', `https://${'nagyon-hosszu-aldomain.'.repeat(30)}example.com/x`],
]
// no style attribute: the app's own sanitizing (on the page, whose CSP forbids inline style) logs one CSP line per
// styled element, before and without this card (measured); the plain markup keeps the console check meaningful
// on top (the frame is not scrolled): two links side by side (no '' between them), the second with a target longer
// than what the main process sends
const html = `<div><p><a id="adj1" href="https://www.otpbank.hu/">otpbank.hu</a><a id="adj2" href="${LONG_HREF}">otpbank.hu</a><a id="adj3" href="${SPOOF_HREF}">otpbank.hu</a></p>${LINKS.map(([id, text, href]) => `<p><a id="${id}" href="${href}">${text}</a> &nbsp; szöveg utána</p>`).join('')}<p id="empty">Itt nincs link.</p><p>.</p><p>.</p></div>`

const server = await new FakePop3Server().listen()
server.add(Buffer.from(`From: f@example.invalid\r\nSubject: Sima szoveg\r\nDate: ${new Date(2025, 3, 5, 12).toUTCString()}\r\n\r\nNezd meg: https://otpbank-login.example.com/belepes es info@example.com\r\n`))
server.add(Buffer.from(`From: f@example.invalid\r\nSubject: Linkes level\r\nDate: ${new Date(2025, 3, 6, 12).toUTCString()}\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${html}\r\n`))
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-link-target-e2e-'))
const dataDir = path.join(work, 'data')
fs.mkdirSync(dataDir)
seedLanguage(dataDir)
{
  const { db, vault } = await createVaultedDatabase(dataDir, MASTER)
  const store = new AccountStore(db, vault, { storeDir: path.join(dataDir, 'store') })
  const base = { smtp_host: '127.0.0.1', smtp_port: 1, smtp_security: 'none', in_security: 'none', in_host: '127.0.0.1' }
  store.save({ ...newAccountDefaults('pop3'), ...base, name: 'Fiók', email: 'p@example.invalid', in_port: server.port, in_user: server.user, in_password: server.pass })
  db.close()
}
if (shots) fs.mkdirSync(shots, { recursive: true })

const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const problems = []
const until = async (fn, ms = 4000) => {
  const t0 = performance.now()
  while (!(await fn())) {
    if (performance.now() - t0 > ms) return false
    await sleep(40)
  }
  return true
}

let app
try {
  app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
  const page = await app.firstWindow()
  // "Blocked script execution in 'mail-view:...'": Playwright's own probes into the sandboxed frame, refused (as they should be)
  page.on('console', m => m.type() === 'error' && !/ERR_CONNECTION_REFUSED|connect ECONNREFUSED|^Blocked script execution in 'mail-view:/.test(m.text()) && problems.push(m.text()))
  page.on('pageerror', e => problems.push(e.message))
  await page.setViewportSize({ width: 1400, height: 1000 })
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  await page.locator('.msg-row', { hasText: 'Linkes level' }).waitFor({ timeout: 20_000 })
  await page.locator('.msg-row', { hasText: 'Linkes level' }).click()
  const frameEl = page.locator('iframe.mail-frame')
  await frameEl.waitFor()
  const frame = await (await frameEl.elementHandle()).contentFrame()
  await frame.locator('#empty').waitFor()
  check('the frame keeps its sandbox (no script, no same-origin)', (await frameEl.getAttribute('sandbox')) === 'allow-popups allow-popups-to-escape-sandbox')

  const bar = page.locator('.link-target')
  const barState = () =>
    page.evaluate(() => {
      const b = document.querySelector('.link-target')
      if (!b) return null
      const q = s => b.querySelector(s)
      const box = el => {
        if (!el) return null // a plain-text message has no frame
        const r = el.getBoundingClientRect()
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }
      }
      return {
        warn: b.classList.contains('link-target-warn'),
        url: q('.link-target-url').textContent,
        domain: q('.lt-domain') ? q('.lt-domain').textContent : null,
        domainWeight: q('.lt-domain') ? getComputedStyle(q('.lt-domain')).fontWeight : null,
        warning: q('.link-target-warning') ? q('.link-target-warning').textContent : null,
        real: q('.link-target-real') ? q('.link-target-real').textContent : null,
        detail: [...b.querySelectorAll('.link-target-detail')].map(d => d.textContent),
        idn: q('.link-target-idn') ? q('.link-target-idn').textContent : null,
        bar: box(b),
        host: box(q('.lt-host')),
        rest: q('.lt-rest') ? { ...box(q('.lt-rest')), scroll: q('.lt-rest').scrollWidth, client: q('.lt-rest').clientWidth } : null,
        tail: q('.lt-tail') ? q('.lt-tail').textContent : null,
        frame: box(document.querySelector('iframe.mail-frame')),
        reader: box(document.querySelector('section.reader')),
        pointerEvents: getComputedStyle(b).pointerEvents,
      }
    })
  const hover = async id => {
    const box = await frame.locator(`#${id}`).boundingBox()
    await page.mouse.move(box.x + 4, box.y + box.height / 2)
    return until(async () => {
      const s = await barState()
      return s && s.url.includes(new URL(LINKS.find(l => l[0] === id)[2]).hostname)
    })
  }
  // a non-link spot INSIDE the frame: the middle of the link-less paragraph, scrolled into view first (since the reader
  // header holds the label row the frame is lower, and a fixed offset below it fell out of the frame: leaving the frame
  // straight from a link sends no '', the known limit, and the bar stayed)
  const offLink = async () => {
    await frame.locator('#empty').scrollIntoViewIfNeeded()
    const box = await frame.locator('#empty').boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  }

  // 1. same registered domain: the real target, no warning
  check('hover: the bar shows', await hover('same'))
  let s = await barState()
  check('same domain: no warning', s && !s.warn && s.warning === null, JSON.stringify(s && s.url))
  check('the real URL is shown', s && s.url === 'https://www.otpbank.hu', s && s.url)
  check('the registered domain is bold', s && s.domain === 'otpbank.hu' && Number(s.domainWeight) >= 700, s && `${s.domain} ${s.domainWeight}`)
  check('the bar sits at the bottom-left corner of the message', s && Math.abs(s.bar.left - s.frame.left) <= 8 && Math.abs(s.bar.bottom - Math.min(s.frame.bottom, s.reader.bottom)) <= 8, s && JSON.stringify({ bar: s.bar, frame: s.frame }))
  check('the bar takes no pointer', s && s.pointerEvents === 'none')
  if (shots) await page.screenshot({ path: path.join(shots, 'link-same.png') })

  // 2. the mouse leaves the link inside the frame: the bar goes
  await offLink()
  check('off the link: the bar goes', await until(async () => (await bar.count()) === 0))

  // 3. a subdomain of the same domain is not a mismatch
  await hover('sub')
  s = await barState()
  check('subdomain (login. vs www.): no warning', s && !s.warn && s.domain === 'otpbank.hu', s && s.url)

  // 4. the text shows another domain: the red warning with the real host and the text's host
  await hover('other')
  s = await barState()
  check('other domain: warning', s && s.warn && s.warning === t.linkTarget.mismatch, s && s.warning)
  check('the warning names the real host and the text', s && s.real === 'otpbank-login.example.com' && s.detail[0].includes('otpbank.hu'), s && JSON.stringify(s.detail))
  if (shots) await page.screenshot({ path: path.join(shots, 'link-mismatch.png') })
  await hover('url-text')
  s = await barState()
  check('a URL as text, "otpbank.hu.evil..." host: warning', s && s.warn && s.real === 'otpbank.hu.evil.example.net' && s.domain === 'example.net', s && JSON.stringify([s.real, s.domain]))

  // 5. a text that is not an address: only the target
  await hover('plain-words')
  s = await barState()
  check('"Kattints ide": no warning, the target shown', s && !s.warn && s.url.includes('otpbank-login.example.com'), s && s.url)

  // 6. punycode: shown in both forms, warned when the text shows a Latin domain
  await hover('puny')
  s = await barState()
  check('punycode host vs Latin text: warning', s && s.warn && s.url.includes('xn--tpbank-vxa.hu'), s && s.url)
  check('punycode: the Unicode form too', s && s.idn && s.idn.includes('ötpbank.hu'), s && s.idn)
  await hover('puny-plain')
  s = await barState()
  check('punycode with a plain-word text: both forms, no mismatch warning', s && !s.warn && s.idn && s.idn.includes('ötpbank.hu') && s.url.includes('xn--tpbank-vxa.hu'), s && JSON.stringify([s.url, s.idn]))

  // 7. "otpbank.hu@evil.example.org": the real host is the bold one
  await hover('userinfo')
  s = await barState()
  check('userinfo trick: the real host is the domain shown', s && s.domain === 'example.org' && s.url.includes('otpbank.hu@'), s && JSON.stringify([s.url, s.domain]))

  // 8. two-level suffixes
  await hover('couk-same')
  s = await barState()
  check('news.bbc.co.uk vs bbc.co.uk: no warning', s && !s.warn && s.domain === 'bbc.co.uk', s && s.domain)
  await hover('couk-other')
  s = await barState()
  check('bbc-news.co.uk vs bbc.co.uk: warning', s && s.warn && s.domain === 'bbc-news.co.uk', s && s.domain)

  // 9. mailto: the address; a different domain in the text is a mismatch
  await hover('mail')
  s = await barState()
  check('mailto: the address shown', s && s.url.startsWith('mailto:support@') && s.domain === 'example.com', s && s.url)
  check('mailto: an address text of another domain: warning', s && s.warn, s && JSON.stringify(s.detail))

  // 10. a file name is not a domain
  await hover('file')
  s = await barState()
  check('"szamla.pdf": no warning', s && !s.warn, s && s.url)

  // 11. a long URL in a narrow window: the host stays visible, the middle is cut, the end shows
  await page.setViewportSize({ width: 860, height: 1000 })
  await sleep(400)
  await offLink()
  await until(async () => (await bar.count()) === 0)
  await hover('long')
  s = await barState()
  check('long URL: the bar stays inside the message', s && s.bar.left >= s.frame.left - 1 && s.bar.right <= Math.min(s.frame.right, s.reader.right) + 1, s && JSON.stringify({ bar: s.bar, frame: s.frame }))
  check('long URL: the host is inside the bar', s && s.host.left >= s.bar.left && s.host.right <= s.bar.right + 0.5, s && JSON.stringify({ host: s.host, bar: s.bar }))
  check('long URL: the host is on one line (the rest is cut, not the host)', s && s.host.bottom - s.host.top < 20, s && JSON.stringify(s.host))
  check('long URL: the middle is cut', s && s.rest && s.rest.scroll > s.rest.client, s && JSON.stringify(s.rest))
  check('long URL: its end shows', s && s.tail === LONG_PATH.slice(-18), s && s.tail)
  if (shots) await page.screenshot({ path: path.join(shots, 'link-long-860.png') })
  await hover('longhost')
  s = await barState()
  check('a host wider than the bar wraps inside it', s && s.host.left >= s.bar.left && s.host.right <= s.bar.right + 0.5 && s.host.bottom - s.host.top > 20 && s.bar.top >= s.reader.top, s && JSON.stringify({ host: s.host, bar: s.bar }))
  if (shots) await page.screenshot({ path: path.join(shots, 'link-longhost-860.png') })
  await page.setViewportSize({ width: 1400, height: 1000 })
  await sleep(300)

  // 12. leaving the frame straight from a link (no '' comes from the frame then): the bar goes
  await hover('other')
  await page.mouse.move(5, 5)
  check('leaving the frame from a link: the bar goes', await until(async () => (await bar.count()) === 0))

  // 12b. a link of the page itself (not the message's): no bar (the main process reports every frame's links)
  await page.evaluate(() => {
    const a = document.createElement('a')
    a.id = 'page-link'
    a.href = 'https://page-link.example.com/'
    a.textContent = 'page link'
    document.querySelector('.reader-subject').append(a)
  })
  const pl = await page.locator('#page-link').boundingBox()
  await page.mouse.move(pl.x + 3, pl.y + pl.height / 2)
  await sleep(500)
  check('a link of the page itself: no bar', (await bar.count()) === 0)
  await page.evaluate(() => document.getElementById('page-link').remove())
  await page.mouse.move(5, 5)

  // 12c. from a link straight onto a neighbour whose URL is longer than what the main process sends (it sends the
  // start, cut): the bar follows, the old target never stays; and from nothing onto it too
  await offLink()
  await until(async () => (await bar.count()) === 0)
  const a1 = await frame.locator('#adj1').boundingBox()
  const a2 = await frame.locator('#adj2').boundingBox()
  await page.mouse.move(a1.x + 4, a1.y + a1.height / 2)
  check('neighbour links: the first shows', await until(async () => (await barState())?.url === 'https://www.otpbank.hu'))
  await page.mouse.move(a2.x + 4, a2.y + a2.height / 2)
  const onLong = async () => {
    const st = await barState()
    return st && st.url.startsWith('https://evil.example.com/aaa') && st.url.endsWith('aaaa') && st.warn && st.domain === 'example.com'
  }
  check('straight onto the very long URL: the bar shows it (whole, warned), not the old one', await until(onLong), JSON.stringify((await barState())?.url?.slice(0, 60)))
  await offLink()
  await until(async () => (await bar.count()) === 0)
  await page.mouse.move(a2.x + 4, a2.y + a2.height / 2)
  check('the very long URL from nothing: the bar shows it', await until(onLong))
  await offLink()
  await until(async () => (await bar.count()) === 0)
  // the cut inside the user part: the real host (evil.example), warned, never the "otpbank.hu" the cut start ends in
  const a3 = await frame.locator('#adj3').boundingBox()
  const onSpoof = async () => {
    const st = await barState()
    return st && st.domain === 'evil.example' && st.warn && st.real === 'evil.example' && st.url.length < 400
  }
  await page.mouse.move(a1.x + 4, a1.y + a1.height / 2)
  await until(async () => (await barState())?.url === 'https://www.otpbank.hu')
  await page.mouse.move(a3.x + 4, a3.y + a3.height / 2)
  check('a cut inside the user part: the real host, warned', await until(onSpoof), JSON.stringify(await barState().then(b => b && [b.domain, b.real, b.warn, b.url.slice(0, 80)])))
  await offLink()
  await until(async () => (await bar.count()) === 0)
  await page.mouse.move(a3.x + 4, a3.y + a3.height / 2)
  check('the same from nothing', await until(onSpoof), JSON.stringify(await barState().then(b => b && [b.domain, b.warn])))
  // 12d. a target that is none of the message's links (a canonical form the sanitizer's key does not match), reported
  // while a legit link's bar shows: the old bar goes (the main process's own event, raised from the main process)
  await page.mouse.move(a1.x + 4, a1.y + a1.height / 2)
  await until(async () => (await barState())?.url === 'https://www.otpbank.hu')
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.emit('update-target-url', {}, 'https://stranger.example.net/x')
  })
  check('a target that is not the message\'s: the old bar goes', await until(async () => (await bar.count()) === 0), JSON.stringify((await barState())?.url))
  await offLink()
  await until(async () => (await bar.count()) === 0)

  // 13. the keyboard: Tab onto the links of the frame (after the mouse left a non-link spot of the frame)
  await offLink()
  await page.mouse.move(5, 5)
  await frame.locator('#same').focus()
  const tabbed = []
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Tab')
    await sleep(250)
    const st = await barState()
    tabbed.push(st ? st.url : null)
  }
  check('Tab: the focused link shows', tabbed[0] === 'https://login.otpbank.hu/belepes' && tabbed[1] === 'https://otpbank-login.example.com/belepes?u=1', JSON.stringify(tabbed))
  check('Tab onto a mismatching link: warning', await until(async () => (await barState())?.warn === true), JSON.stringify(await barState()))
  await page.locator('.reader-toolbar button').first().focus()
  check('the focus leaves the frame: the bar goes', await until(async () => (await bar.count()) === 0))
  await page.getByRole('button', { name: t.backToList, exact: true }).click()

  // 14. a plain-text message: its addresses are links (the owner's later decision), the bar shows the real target
  await page.locator('.msg-row', { hasText: 'Sima szoveg' }).click()
  await page.locator('pre.mail-text').waitFor()
  const plainHrefs = await page.locator('pre.mail-text a').evaluateAll(as => as.map(a => a.getAttribute('href')))
  check('plain text: the web and the e-mail address are links', JSON.stringify(plainHrefs) === JSON.stringify(['https://otpbank-login.example.com/belepes', 'mailto:info@example.com']), JSON.stringify(plainHrefs))
  check('plain text: the shown text unchanged', (await page.locator('pre.mail-text').innerText()).trim() === 'Nezd meg: https://otpbank-login.example.com/belepes es info@example.com')
  const text = await page.locator('pre.mail-text').boundingBox()
  await page.mouse.move(text.x + text.width - 6, text.y + text.height - 4)
  await sleep(300)
  check('plain text: beside the links no bar', (await bar.count()) === 0)
  await page.locator('pre.mail-text a').first().hover()
  check('plain text: over the web link the bar with its real target', await until(async () => (await bar.count()) === 1 && (await barState()).domain === 'example.com'), JSON.stringify(await barState()))
  await page.mouse.move(text.x + text.width - 6, text.y + text.height - 4)
  check('plain text: off the link the bar goes', await until(async () => (await bar.count()) === 0))
  check('no console error', problems.length === 0, problems.join(' | '))
} catch (err) {
  check('run', false, err.stack)
} finally {
  if (app) await app.close().catch(() => {})
  server.close?.()
  fs.rmSync(work, { recursive: true, force: true })
}
console.log(`${results.filter(Boolean).length} / ${results.length} OK`)
process.exit(results.every(Boolean) ? 0 : 1)
