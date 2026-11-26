// The right-click menu of a message, the main-process side (context-menu.js, ipc/context-menu.js): the items from
// Electron's context-menu params, the mailto addresses, where a menu may open, the one-time token, what goes to the page
// (no URL, no address) and what the chosen item does (the REAL href on the clipboard, the shared link opener).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ContextMenus, MENU_TTL_MS, linkKind, mailtoAddresses, menuItems, menuSource } from '../app/main/context-menu.js'
import { registerContextMenuIpc, CONTEXT_MENU_CHANNEL } from '../app/main/ipc/context-menu.js'

const FRAME = 'mail-view://view/35c3f22845548eee9d288c6'
const LONG_HREF = `https://evil.example.com/${'a'.repeat(9000)}`

function menus({ now = () => 1000 } = {}) {
  const done = []
  let n = 0
  const m = new ContextMenus({
    act: { writeText: text => done.push(['clipboard', text]), open: url => done.push(['open', url]), selectAll: source => done.push(['selectAll', source]) },
    newToken: () => `token-${++n}`,
    now,
    log: line => done.push(['log', line]),
  })
  return { m, done }
}

test('the items: a web link, a mailto link, a selection, an empty place; other schemes have no link item', () => {
  assert.deepEqual(menuItems({ linkURL: 'https://otpbank-login.example.com/belepes?u=1', selectionText: '' }), ['copyLink', 'openLink'])
  assert.deepEqual(menuItems({ linkURL: 'http://example.com/', selectionText: '' }), ['copyLink', 'openLink'])
  assert.deepEqual(menuItems({ linkURL: 'mailto:a@example.invalid', selectionText: '' }), ['copyAddress', 'newMail'])
  assert.deepEqual(menuItems({ linkURL: '', selectionText: 'Kérem az árajánlatot' }), ['copy'])
  assert.deepEqual(menuItems({ linkURL: '', selectionText: '' }), ['selectAll'])
  assert.deepEqual(menuItems({ linkURL: '', selectionText: '\n' }), ['selectAll'], 'white space only is no selection (measured: a click beside the text gives "\\n")')
  assert.deepEqual(menuItems({ linkURL: 'https://x.example/', selectionText: 'x' }), ['copyLink', 'openLink', 'copy'])
  for (const url of ['javascript:alert(1)', 'file:///C:/Windows/win.ini', 'data:text/html,<b>x</b>', 'ftp://x.example/', 'not a url']) {
    assert.deepEqual(menuItems({ linkURL: url, selectionText: '' }), ['selectAll'], url)
    assert.equal(linkKind(url), null, url)
  }
})

test('mailto: the addresses without "mailto:" and the "?" part, %-decoded, several with ", "', () => {
  assert.equal(mailtoAddresses('mailto:a@example.invalid?subject=x'), 'a@example.invalid')
  assert.equal(mailtoAddresses('mailto:a%40example.invalid'), 'a@example.invalid')
  assert.equal(mailtoAddresses('mailto:a@example.invalid,c@other.invalid'), 'a@example.invalid, c@other.invalid')
  assert.equal(mailtoAddresses('MAILTO:a@example.invalid?cc=c@other.invalid&body=hello'), 'a@example.invalid', 'the cc / body are not addresses of the link')
  assert.equal(mailtoAddresses('mailto:a@example.invalid%2C%20c@other.invalid'), 'a@example.invalid, c@other.invalid', 'an encoded comma stays one part, decoded')
  assert.equal(mailtoAddresses('mailto:%E9@example.invalid'), '%E9@example.invalid', 'a broken %-sequence: as written')
  assert.equal(mailtoAddresses('mailto:?subject=x'), '')
})

test('where a menu opens: the message frame, the page itself (the reader decides), no other frame', () => {
  assert.equal(menuSource(FRAME, false), 'mail')
  assert.equal(menuSource('file:///app/index.html', true), 'page')
  assert.equal(menuSource('about:blank', false), null)
  assert.equal(menuSource('mail-view://other/x', false), null)
  assert.equal(menuSource(null, false), null)
  const { m } = menus()
  assert.equal(m.open({ linkURL: 'https://x.example/', selectionText: '' }, { frameUrl: 'https://evil.example/', isMainFrame: false }), null)
})

test('what the page gets: a token, the item ids and the place; no URL and no address anywhere', () => {
  const { m } = menus()
  const sent = m.open({ linkURL: 'https://otpbank-login.example.com/belepes?u=1', linkText: 'otpbank.hu', selectionText: '', x: 308.4, y: 463 }, { frameUrl: FRAME, isMainFrame: false })
  assert.deepEqual(sent, { token: 'token-1', items: ['copyLink', 'openLink'], x: 308, y: 463, source: 'mail' })
  const mail = m.open({ linkURL: 'mailto:support@evil.example.com?subject=Hi', linkText: 'info@example.org', selectionText: '', x: 1, y: 2 }, { frameUrl: FRAME, isMainFrame: false })
  const text = JSON.stringify(mail)
  assert.ok(!/example|mailto|@/.test(text), text)
})

test('the chosen item: the REAL href on the clipboard (not the text), the long one whole; open through the shared opener', () => {
  const { m, done } = menus()
  let menu = m.open({ linkURL: 'https://otpbank-login.example.com/belepes?u=1', linkText: 'otpbank.hu', selectionText: '' }, { frameUrl: FRAME, isMainFrame: false })
  assert.deepEqual(m.choose(menu.token, 'copyLink'), { ok: true })
  assert.deepEqual(done, [['clipboard', 'https://otpbank-login.example.com/belepes?u=1']], 'copied, nothing opened')
  done.length = 0
  menu = m.open({ linkURL: LONG_HREF, selectionText: '' }, { frameUrl: FRAME, isMainFrame: false })
  m.choose(menu.token, 'copyLink')
  assert.equal(done[0][1].length, LONG_HREF.length)
  done.length = 0
  menu = m.open({ linkURL: 'https://otpbank-login.example.com/', selectionText: '' }, { frameUrl: FRAME, isMainFrame: false })
  m.choose(menu.token, 'openLink')
  assert.deepEqual(done, [['open', 'https://otpbank-login.example.com/']])
  done.length = 0
  menu = m.open({ linkURL: 'mailto:a%40example.invalid,c@other.invalid?subject=x', selectionText: '' }, { frameUrl: FRAME, isMainFrame: false })
  m.choose(menu.token, 'copyAddress')
  assert.deepEqual(done, [['clipboard', 'a@example.invalid, c@other.invalid']])
  done.length = 0
  menu = m.open({ linkURL: 'mailto:a@example.invalid', selectionText: '' }, { frameUrl: FRAME, isMainFrame: false })
  m.choose(menu.token, 'newMail')
  assert.deepEqual(done, [['open', 'mailto:a@example.invalid']])
  done.length = 0
  menu = m.open({ linkURL: '', selectionText: 'Kérem az árajánlatot' }, { frameUrl: FRAME, isMainFrame: false })
  m.choose(menu.token, 'copy')
  assert.deepEqual(done, [['clipboard', 'Kérem az árajánlatot']])
  done.length = 0
  menu = m.open({ linkURL: '', selectionText: '' }, { frameUrl: FRAME, isMainFrame: false })
  m.choose(menu.token, 'selectAll')
  assert.deepEqual(done, [['selectAll', 'mail']])
})

test('an old, used, unknown or foreign token, or an item the menu did not offer: nothing written, nothing opened', () => {
  let clock = 1000
  const { m, done } = menus({ now: () => clock })
  const first = m.open({ linkURL: 'https://a.example/', selectionText: '' }, { frameUrl: FRAME, isMainFrame: false })
  const second = m.open({ linkURL: 'https://b.example/', selectionText: '' }, { frameUrl: FRAME, isMainFrame: false })
  assert.equal(m.choose(first.token, 'copyLink').error, 'stale', 'a new right click voids the old menu')
  assert.equal(m.choose('token-999', 'copyLink').error, 'stale', 'an unknown token')
  assert.equal(m.choose(second.token, 'copyAddress').error, 'not_offered')
  assert.equal(m.choose(second.token, 'selectAll').error, 'not_offered')
  assert.deepEqual(m.choose(second.token, 'copyLink'), { ok: true })
  assert.equal(m.choose(second.token, 'openLink').error, 'stale', 'one use')
  const late = m.open({ linkURL: 'https://c.example/', selectionText: '' }, { frameUrl: FRAME, isMainFrame: false })
  clock += MENU_TTL_MS + 1
  assert.equal(m.choose(late.token, 'openLink').error, 'stale', 'after 60 s')
  // nothing done but the one copy; the log lines name no URL
  assert.deepEqual(done.filter(d => d[0] !== 'log'), [['clipboard', 'https://b.example/']])
  assert.ok(done.filter(d => d[0] === 'log').every(d => !/example/.test(d[1])))
  // a right click on another frame voids the open menu too
  const third = m.open({ linkURL: 'https://d.example/', selectionText: '' }, { frameUrl: FRAME, isMainFrame: false })
  m.open({ linkURL: 'https://d.example/', selectionText: '' }, { frameUrl: 'about:blank', isMainFrame: false })
  assert.equal(m.choose(third.token, 'copyLink').error, 'stale')
})

test('IPC: only the main window, only a token string and a known item', async () => {
  const handlers = new Map()
  const { m, done } = menus()
  registerContextMenuIpc({ ipcMain: { handle: (c, fn) => handlers.set(c, fn) }, menus: m, isMainWindow: e => e.main === true })
  const call = handlers.get(CONTEXT_MENU_CHANNEL)
  const menu = m.open({ linkURL: 'https://a.example/', selectionText: '' }, { frameUrl: FRAME, isMainFrame: false })
  assert.deepEqual(await call({ main: false }, menu.token, 'copyLink'), { ok: false, error: 'untrusted_sender' })
  for (const args of [[5, 'copyLink'], [menu.token, 'deleteAll'], [menu.token, 'copyLink', 'https://other.example/'], ['x'.repeat(101), 'copyLink']]) {
    assert.deepEqual(await call({ main: true }, ...args), { ok: false, error: 'bad_request' }, JSON.stringify(args).slice(0, 60))
  }
  assert.deepEqual(done, [], 'nothing done for the refused calls')
  assert.deepEqual(await call({ main: true }, menu.token, 'copyLink'), { ok: true })
  assert.deepEqual(done, [['clipboard', 'https://a.example/']])
})
