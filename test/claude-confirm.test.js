// MCP M3B: the confirmation Modal (ClaudeConfirm.jsx) in jsdom, and the main side's IPC
// (service.js mcp:confirm / mcp:confirmations, the reject-all of lock, quit and switch-off).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupDom, mount, inAct, key } from './helpers/react-dom-env.js'
import { tempDir } from './helpers/tmp.js'
import { ConfirmationQueue } from '../app/main/mcp/confirm.js'
import { createMcpService, registerMcpIpc, MCP_CHANNELS } from '../app/main/mcp/service.js'

setupDom()
const { createElement: h } = await import('react')
const { ClaudeConfirm, APPROVE_DELAY_MS, TEXT_START } = await import('../app/renderer/src/ClaudeConfirm.jsx')
const { hu } = await import('../app/renderer/i18n/hu.js')
const sleep = ms => new Promise(r => setTimeout(r, ms))

const sendView = (over = {}) => ({
  id: 'k1',
  tool: 'send_message',
  view: {
    kind: 'send',
    from: { name: 'Bence', address: 'sajat@example.invalid' },
    to: ['Anna <anna@example.invalid>'],
    cc: [],
    bcc: ['titkos@example.invalid'],
    subject: '<img src=x onerror=alert(1)> Ajánlat',
    text: 'Szia Anna,\n<b>nem HTML</b>',
    attachments: [{ name: 'szamla.pdf', size: 2048 }],
    ...over,
  },
})

async function show(request, waiting = 1) {
  const decisions = []
  const v = await mount(h(ClaudeConfirm, { request, waiting, onDecide: (id, approve) => decisions.push([id, approve]) }))
  return { v, decisions, modal: () => document.querySelector('.claude-confirm-modal') }
}

test('Modal: the header, the envelope as text (never HTML), the focus on Elutasítás, Enter rejects', async t => {
  const { v, decisions, modal } = await show(sendView(), 3)
  t.after(v.unmount)
  const m = modal()
  assert.equal(m.getAttribute('role'), 'alertdialog')
  assert.equal(m.querySelector('.modal-title').textContent, hu.claudeConfirm.titles.send)
  assert.equal(m.querySelector('.confirm-header').textContent, 'Ezt a kérést Claude indította. Csak akkor hagyd jóvá, ha te is ezt akarod.')
  const text = m.textContent
  for (const part of ['Bence <sajat@example.invalid>', 'Anna <anna@example.invalid>', 'titkos@example.invalid', '<img src=x onerror=alert(1)> Ajánlat', '<b>nem HTML</b>', 'szamla.pdf (2 KB)']) assert.ok(text.includes(part), part)
  assert.equal(m.querySelector('img, b'), null, 'message content is text, not markup')
  assert.ok(!text.includes(hu.claudeConfirm.cc), 'no empty Másolat row')
  assert.ok(text.includes(hu.claudeConfirm.more(2)))
  assert.equal(document.activeElement, m.querySelector('.confirm-reject'), 'the focus is on Elutasítás')
  assert.equal(m.querySelector('.confirm-approve').disabled, true)
  await inAct(() => key(document.activeElement, 'Enter'))
  assert.deepEqual(decisions, [['k1', false]], 'Enter rejects')
})

test('Modal: Jóváhagyás works only after 1.5 s; Enter elsewhere still rejects; Esc rejects', async t => {
  const { v, decisions, modal } = await show(sendView())
  t.after(v.unmount)
  const approve = modal().querySelector('.confirm-approve')
  await inAct(() => approve.click())
  assert.deepEqual(decisions, [], 'not clickable before 1.5 s')
  await inAct(() => sleep(APPROVE_DELAY_MS + 100))
  assert.equal(approve.disabled, false)
  await inAct(() => key(modal().querySelector('.confirm-reject'), 'Enter'))
  assert.deepEqual(decisions, [['k1', false]], 'Enter on Elutasítás rejects')
  approve.focus()
  await inAct(() => key(approve, 'Enter'))
  await inAct(() => approve.click())
  assert.deepEqual(decisions, [['k1', false], ['k1', true], ['k1', true]], 'a deliberate Tab to Jóváhagyás + Enter, or a click, approves')
  await inAct(() => key(modal(), 'Escape'))
  assert.deepEqual(decisions.at(-1), ['k1', false], 'Esc rejects')
})

test('Modal: the next request starts its own 1.5 s; the long text opens on request; every kind renders', async t => {
  const long = 'a'.repeat(TEXT_START + 500)
  const { v, modal } = await show(sendView({ text: long }))
  t.after(v.unmount)
  assert.ok(modal().querySelector('.confirm-text').textContent.length <= TEXT_START + 1)
  await inAct(() => modal().querySelector('.confirm-expand').click())
  assert.equal(modal().querySelector('.confirm-text').textContent, long)
  await inAct(() => sleep(APPROVE_DELAY_MS + 100))
  assert.equal(modal().querySelector('.confirm-approve').disabled, false)
  const account = { name: 'Munka', email: 'munka@example.invalid', type: 'imap' }
  const kinds = [
    { kind: 'deleteMessages', account, folder: 'Trash', inTrash: true, count: 25, items: [{ subject: 'Első', from: 'Anna <anna@example.invalid>', folder: 'Trash' }] },
    { kind: 'deleteFolder', account, path: 'Régi/2019', count: 12 },
    { kind: 'updateAccount', account, changes: [{ field: 'smtp_host', old: 'smtp.regi.invalid', new: 'smtp.uj.invalid' }, { field: 'tls_verify', old: true, new: false }, { field: 'pop3_delete_after_days', old: null, new: 7 }], loginChanged: true, deletesSooner: true },
    { kind: 'deleteAccount', account, count: 340 },
    { kind: 'restartLogin', account, reason: 'auth_failed' },
  ]
  const expect = {
    deleteMessages: [hu.confirmDeleteTrash(25), 'Első', hu.claudeConfirm.listMore(24)],
    deleteFolder: ['Régi/2019', hu.claudeConfirm.folderDelete(12)],
    updateAccount: ['Kimenő (SMTP) szerver: Szerver', 'smtp.regi.invalid -> smtp.uj.invalid', 'be -> ki', 'soha -> 7', hu.claudeConfirm.loginChanged, hu.tlsVerifyOffWarning, hu.claudeConfirm.deletesSooner],
    deleteAccount: ['Munka <munka@example.invalid>', hu.claudeConfirm.accountDelete(340)],
    restartLogin: ['A leállítás oka: a szerver elutasította a belépést', 'Ha a jelszó továbbra is rossz, a szerver ideiglenesen letilthatja a gépet. Jóváhagyás után egy belépési kísérlet történik.'],
  }
  for (const [i, view] of kinds.entries()) {
    await v.rerender(h(ClaudeConfirm, { request: { id: `r${i}`, tool: 'x', view }, waiting: 1, onDecide: () => {} }))
    assert.equal(modal().querySelector('.modal-title').textContent, hu.claudeConfirm.titles[view.kind])
    for (const part of expect[view.kind]) assert.ok(modal().textContent.includes(part), `${view.kind}: ${part}`)
    assert.equal(modal().querySelector('.confirm-approve').disabled, true, `${view.kind}: a new request waits its own 1.5 s`)
  }
})

test('IPC: mcp:confirm only from the main window, the stored request runs; switch-off, lock and quit reject every waiting one', async t => {
  assert.ok(MCP_CHANNELS.includes('mcp:confirm') && MCP_CHANNELS.includes('mcp:confirmations'))
  const ran = []
  const q = new ConfirmationQueue()
  const make = n => q.create({ tool: 't', view: { kind: 'deleteFolder', n }, payload: { n }, execute: async p => (ran.push(p.n), { text: 'ok' }) })
  const store = new Map()
  const mcp = createMcpService({ dataDir: tempDir(t), settings: { get: k => store.get(k) ?? null, set: (k, v) => store.set(k, v) }, appVersion: '0', accountCount: () => 0, confirm: q })
  t.after(() => mcp.stop())
  const handlers = new Map()
  registerMcpIpc({ ipcMain: { handle: (c, fn) => handlers.set(c, fn) }, mcp, confirm: q, isTrustedSender: e => e.trusted, isConfirmSender: e => e.main })
  const call = (c, e, ...a) => handlers.get(c)(e, ...a)
  const main = { trusted: true, main: true }
  const a = make(1)
  assert.deepEqual(await call('mcp:confirm', { trusted: true, main: false }, { id: a, approve: true }), { ok: false, error: 'untrusted_sender' }, 'a composer window cannot decide')
  assert.deepEqual((await call('mcp:confirmations', main)).requests.map(r => r.id), [a])
  assert.deepEqual((await call('mcp:confirmations', main)).requests[0].view, { kind: 'deleteFolder', n: 1 })
  assert.equal(JSON.stringify(await call('mcp:confirmations', main)).includes('execute'), false)
  for (const bad of [null, { id: a }, { id: 5, approve: true }, { id: a, approve: 'yes' }]) assert.deepEqual(await call('mcp:confirm', main, bad), { ok: false, error: 'bad_request' })
  assert.deepEqual(await call('mcp:confirm', main, { id: 'nincs', approve: true }), { ok: true, status: 'not_found' })
  assert.equal((await call('mcp:confirm', main, { id: a, approve: true })).status, 'running')
  await sleep(10)
  assert.deepEqual([q.status(a).status, ran], ['approved', [1]])
  const b = make(2)
  assert.equal((await call('mcp:confirm', main, { id: b, approve: false })).status, 'rejected')
  const c = make(3)
  await mcp.setEnabled(true)
  await mcp.setEnabled(false)
  assert.deepEqual([q.status(c).status, q.status(c).error], ['rejected', 'access_off'])
  const d = make(4)
  mcp.stop()
  assert.deepEqual([q.status(d).status, q.status(d).error], ['rejected', 'locked'])
  const e = make(5)
  mcp.stop('quit')
  assert.deepEqual([q.status(e).status, q.status(e).error], ['rejected', 'quit'])
  assert.deepEqual(ran, [1], 'only the approved one ran')
})

test('a request swapped in (not a click) is never committed with an enabled Jóváhagyás', async () => {
  const { createRoot } = await import('react-dom/client')
  const was = globalThis.IS_REACT_ACT_ENVIRONMENT
  globalThis.IS_REACT_ACT_ENVIRONMENT = false
  const req = id => ({ id, tool: 'delete_account', view: { kind: 'deleteAccount', account: { name: 'N', email: 'n@example.invalid', type: 'imap' }, count: 1 } })
  const decisions = []
  const onDecide = (id, a) => decisions.push([id, a])
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  try {
    root.render(h(ClaudeConfirm, { request: req('A'), onDecide }))
    await sleep(APPROVE_DELAY_MS + 200)
    assert.equal(container.querySelector('.confirm-approve').disabled, false, 'A is ready')
    let seen = null
    const mo = new window.MutationObserver(() => {
      const el = container.querySelector('.claude-confirm')
      if (seen || !el || el.getAttribute('data-request-id') !== 'B') return
      const btn = container.querySelector('.confirm-approve')
      seen = { disabled: btn.disabled }
      btn.click()
    })
    mo.observe(container, { subtree: true, childList: true, attributes: true })
    setTimeout(() => root.render(h(ClaudeConfirm, { request: req('B'), onDecide })), 0)
    await sleep(100)
    mo.disconnect()
    assert.deepEqual(seen, { disabled: true })
    assert.deepEqual(decisions, [], 'B is not approved in its first frame')
  } finally {
    root.unmount()
    container.remove()
    globalThis.IS_REACT_ACT_ENVIRONMENT = was
  }
})

test('Zárolás and "Mind elutasítása, Claude-hozzáférés ki" in the Modal: never focused, Enter does not press them, no delay', async t => {
  const calls = []
  const decisions = []
  const v = await mount(h(ClaudeConfirm, { request: sendView(), waiting: 2, onDecide: (id, a) => decisions.push([id, a]), onLock: () => calls.push('lock'), onRejectAllOff: () => calls.push('off') }))
  t.after(v.unmount)
  const m = document.querySelector('.claude-confirm-modal')
  const lockBtn = m.querySelector('.confirm-lock')
  const offBtn = m.querySelector('.confirm-off')
  assert.equal(lockBtn.textContent, hu.claudeConfirm.lock)
  assert.equal(offBtn.textContent, hu.claudeConfirm.rejectAllOff)
  assert.equal(document.activeElement, m.querySelector('.confirm-reject'), 'the focus stays on Elutasítás')
  assert.deepEqual([lockBtn.disabled, offBtn.disabled], [false, false], 'no 1.5 s delay')
  offBtn.focus()
  await inAct(() => key(offBtn, 'Enter'))
  assert.deepEqual([calls, decisions], [[], [['k1', false]]], 'Enter on them rejects the shown request, it does not press them')
  await inAct(() => lockBtn.click())
  await inAct(() => offBtn.click())
  assert.deepEqual(calls, ['lock', 'off'])
})

test('the send Modal lists every link as text -> real target; the update Modal warns about the restart of a stopped account', async t => {
  const links = [{ text: 'https://netbank.otp.hu/fizetes', href: 'https://phish.evil.invalid/pay' }]
  const { v, modal } = await show(sendView({ links, linkCount: 53 }))
  t.after(v.unmount)
  const text = modal().textContent
  assert.ok(text.includes(hu.claudeConfirm.links))
  assert.ok(text.includes('https://netbank.otp.hu/fizetes -> https://phish.evil.invalid/pay'), text)
  assert.ok(text.includes(hu.claudeConfirm.linksMore(52)))
  await v.rerender(h(ClaudeConfirm, { request: { id: 'u1', tool: 'update_account', view: { kind: 'updateAccount', account: { name: 'M', email: 'm@example.invalid', type: 'imap' }, changes: [{ field: 'signature', old: 'a', new: 'b' }], loginChanged: false, deletesSooner: false, restartsLogin: true } }, waiting: 1, onDecide: () => {} }))
  assert.ok(modal().textContent.includes(hu.claudeConfirm.restartsLogin))
})

test('the send Modal names the recipients not in the address book (the send switch OFF); none: no such block', async t => {
  const { v, modal } = await show(sendView({ unknown: ['idegen@example.invalid', 'masik@example.invalid'] }))
  t.after(v.unmount)
  const block = modal().querySelector('.confirm-unknown')
  assert.ok(block, 'the block is shown')
  assert.ok(block.textContent.includes(hu.claudeConfirm.unknownRecipients(2)), block.textContent)
  assert.deepEqual([...block.querySelectorAll('li')].map(li => li.textContent), ['idegen@example.invalid', 'masik@example.invalid'])
  await v.rerender(h(ClaudeConfirm, { request: sendView({ id: 'k2' }), waiting: 1, onDecide: () => {} }))
  assert.equal(modal().querySelector('.confirm-unknown'), null, 'no unknown list: no block')
})

test('the update_draft Modal: the account, old -> new per changed field, the new text as text, and that nothing is sent', async t => {
  const request = { id: 'd1', tool: 'update_draft', view: { kind: 'updateDraft', account: { name: 'M', email: 'm@example.invalid', type: 'imap' }, changes: [{ field: 'subject', old: 'Régi', new: '<b>Új</b>' }, { field: 'bcc', old: '', new: 'titkos@example.invalid' }], text: 'Szia,\n<i>nem HTML</i>' } }
  const { v, modal } = await show(request)
  t.after(v.unmount)
  const m = modal()
  assert.ok(m.textContent.includes(hu.claudeConfirm.titles.updateDraft))
  const rows = [...m.querySelectorAll('.confirm-changes .confirm-field')].map(f => [f.querySelector('dt').textContent, f.querySelector('.confirm-old').textContent, f.querySelector('.confirm-new').textContent])
  assert.deepEqual(rows, [[hu.claudeConfirm.subject, 'Régi', '<b>Új</b>'], [hu.claudeConfirm.bcc, hu.claudeConfirm.empty, 'titkos@example.invalid']])
  assert.equal(m.querySelector('.confirm-draft-text').textContent, 'Szia,\n<i>nem HTML</i>')
  assert.equal(m.querySelectorAll('b, i').length, 0, 'never HTML')
  assert.ok(m.textContent.includes(hu.claudeConfirm.draftNotSent))
  assert.equal(m.querySelector('.confirm-unknown'), null, 'no added stranger: no block')
  await v.rerender(h(ClaudeConfirm, { request: { ...request, id: 'd2', view: { ...request.view, unknown: ['idegen@example.invalid'] } }, waiting: 1, onDecide: () => {} }))
  assert.deepEqual([...modal().querySelectorAll('.confirm-unknown li')].map(li => li.textContent), ['idegen@example.invalid'])
})

test('the send Modal of a scheduled send ("Küldés később") says when, and that it does not go out now; a plain send has no such line', async t => {
  const when = new Date(2026, 10, 20, 8).getTime()
  const { v, modal } = await show(sendView({ sendAt: when }))
  t.after(v.unmount)
  const line = modal().querySelector('.confirm-send-at')
  assert.ok(line, 'the line is shown')
  assert.ok(line.textContent.startsWith(`${hu.claudeConfirm.sendAt}: `), line.textContent)
  assert.ok(line.textContent.includes('2026') && line.textContent.includes('8:00'), line.textContent)
  assert.ok(line.textContent.includes(hu.claudeConfirm.sendAtNote))
  await v.rerender(h(ClaudeConfirm, { request: sendView({ id: 'k3' }), waiting: 1, onDecide: () => {} }))
  assert.equal(modal().querySelector('.confirm-send-at'), null)
})

test('the cancel_scheduled Modal (the user\'s own scheduled message): its title, account, subject and recipients as text, the time, what approval means; the focus on Elutasítás', async t => {
  const when = new Date(2026, 10, 20, 8).getTime()
  const { v, decisions, modal } = await show({ id: 'c1', tool: 'cancel_scheduled', view: { kind: 'cancelScheduled', account: { name: 'Munka', email: 'sajat@example.invalid', type: 'imap' }, subject: '<b>Sajátom</b>', recipients: 'anna@example.invalid, bela@example.invalid', sendAt: when } })
  t.after(v.unmount)
  const m = modal()
  assert.ok(m.textContent.includes(hu.claudeConfirm.titles.cancelScheduled))
  const fields = m.querySelector('.confirm-cancel-scheduled')
  assert.ok(fields, 'the fields')
  assert.ok(fields.textContent.includes('<b>Sajátom</b>'), 'the subject as text')
  assert.equal(fields.querySelector('b'), null, 'never HTML')
  assert.ok(fields.textContent.includes('anna@example.invalid, bela@example.invalid'))
  assert.ok(fields.textContent.includes('2026') && fields.textContent.includes('8:00'), fields.textContent)
  assert.ok(m.textContent.includes(hu.claudeConfirm.cancelScheduledNote))
  assert.ok(m.textContent.includes('sajat@example.invalid'))
  assert.equal(document.activeElement.textContent.trim(), hu.claudeConfirm.reject)
  assert.equal(decisions.length, 0)
})
