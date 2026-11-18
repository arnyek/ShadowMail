// The confirmation switches on the "Claude-hozzáférés" page (ClaudeAccess.jsx ConfirmSettings) in jsdom, and their IPC
// (service.js mcp:confirmSettings / mcp:setConfirm): all ON, turning one OFF asks first in a Modal of its own (Mégse keeps
// it ON), an OFF switch shows a red warning, ON again needs no question; only the main window may change them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupDom, mount, inAct } from './helpers/react-dom-env.js'
import { tempDir } from './helpers/tmp.js'
import { createMcpService, registerMcpIpc, MCP_CHANNELS } from '../app/main/mcp/service.js'
import { createConfirmPolicy, CONFIRM_OPS } from '../app/main/mcp/confirm-policy.js'

setupDom()
// the page's bridge: the real policy behind it, as the main process holds it
const store = new Map()
const policy = createConfirmPolicy({ settings: { get: k => store.get(k) ?? null, set: (k, v) => store.set(k, String(v)) } })
const calls = []
window.shadowMail = {
  mcp: {
    confirmSettings: async () => ({ ok: true, settings: policy.list() }),
    setConfirm: async (op, on) => (calls.push([op, on]), policy.set(op, on), { ok: true, settings: policy.list() }),
    // the rest of the page (the recent list test)
    status: async () => ({ ok: true, enabled: true, running: true, connections: 0 }),
    recent: async () => ({ ok: true, calls: recentRows }),
    connectInfo: async () => ({ ok: false }),
  },
}
let recentRows = []
const { createElement: h } = await import('react')
const { ConfirmSettings, ClaudeAccess } = await import('../app/renderer/src/ClaudeAccess.jsx')
const { hu } = await import('../app/renderer/i18n/hu.js')
const ca = hu.claudeAccess

const click = el => inAct(async () => el.click())
const sw = op => document.querySelector(`#claude-confirm-${op}`)

test('the switches: all ON; OFF asks first (Mégse keeps it ON), then a red warning; ON again without a question', async t => {
  const v = await mount(h(ConfirmSettings))
  t.after(v.unmount)
  await inAct(async () => {})
  assert.deepEqual(CONFIRM_OPS.map(op => sw(op).checked), CONFIRM_OPS.map(op => op !== 'updateDraft'), 'all ON but editing a draft')
  const rows = [...document.querySelectorAll('.claude-confirm-row')]
  assert.deepEqual(rows.map(r => r.querySelector('.setting-label').textContent), CONFIRM_OPS.map(op => ca.confirmOps[op]))
  assert.ok(document.body.textContent.includes('a kézzel felvettek, az importáltak és azok, akiknek te magad írtál'), 'the send rule is said')
  assert.equal(document.querySelector('.claude-confirm-off'), null)

  // OFF: the Modal first, nothing changed yet; Mégse keeps it ON
  await click(sw('send'))
  const modal = () => document.querySelector('.claude-confirm-off-modal')
  assert.ok(modal(), 'a Modal of its own')
  assert.equal(modal().getAttribute('role'), 'alertdialog')
  assert.ok(modal().textContent.includes(ca.confirmOffWarning('send')))
  assert.equal(document.activeElement.textContent, ca.confirmOffCancel, 'the focus on Mégse')
  assert.deepEqual(calls, [])
  await click([...modal().querySelectorAll('button')].find(b => b.textContent === ca.confirmOffCancel))
  assert.equal(modal(), null)
  assert.equal(sw('send').checked, true)
  assert.equal(policy.isOn('send'), true)

  // OFF for real: the switch off, the red warning under it
  await click(sw('send'))
  await click(modal().querySelector('.claude-confirm-off-yes'))
  assert.deepEqual(calls, [['send', false]])
  assert.equal(sw('send').checked, false)
  const warn = document.querySelector('.claude-confirm-off[data-op="send"]')
  assert.ok(warn && warn.classList.contains('danger'), 'red')
  assert.equal(warn.textContent, ca.confirmOffWarning('send'))

  // ON again: no question
  await click(sw('send'))
  assert.equal(modal(), null)
  assert.deepEqual(calls, [['send', false], ['send', true]])
  assert.equal(document.querySelector('.claude-confirm-off'), null)
})

test('the IPC: read anywhere trusted, change only from the main window, only a known op and a boolean', async t => {
  const settings = new Map()
  const s = { get: k => settings.get(k) ?? null, set: (k, v) => settings.set(k, String(v)) }
  const p = createConfirmPolicy({ settings: s })
  const mcp = createMcpService({ dataDir: tempDir(t), settings: s, appVersion: '0', accountCount: () => 0 })
  t.after(() => mcp.stop())
  const handlers = new Map()
  registerMcpIpc({ ipcMain: { handle: (c, fn) => handlers.set(c, fn) }, mcp, isTrustedSender: e => e.trusted, isConfirmSender: e => e.main, policy: p })
  for (const c of ['mcp:confirmSettings', 'mcp:setConfirm']) assert.ok(MCP_CHANNELS.includes(c) && handlers.has(c), c)
  const call = (c, e, ...a) => handlers.get(c)(e, ...a)
  const main = { trusted: true, main: true }
  const composer = { trusted: true, main: false }
  assert.equal((await call('mcp:confirmSettings', composer)).settings.length, CONFIRM_OPS.length, 'reading is fine for any trusted page')
  assert.deepEqual(await call('mcp:setConfirm', composer, { op: 'send', on: false }), { ok: false, error: 'untrusted_sender' })
  assert.deepEqual(await call('mcp:setConfirm', { trusted: false, main: true }, { op: 'send', on: false }), { ok: false, error: 'untrusted_sender' })
  for (const bad of [null, { op: 'send' }, { op: 'send', on: 'off' }, { op: 'move', on: false }, { op: 'send', on: false, extra: 1 }]) {
    assert.deepEqual(await call('mcp:setConfirm', main, bad), { ok: false, error: 'bad_request' }, JSON.stringify(bad))
  }
  assert.equal(p.isOn('send'), true, 'nothing changed by the refused calls')
  const r = await call('mcp:setConfirm', main, { op: 'deleteAccount', on: false })
  assert.equal(r.ok, true)
  assert.deepEqual(r.settings.find(x => x.op === 'deleteAccount'), { op: 'deleteAccount', on: false, defaultOn: true })
  assert.equal(settings.get('mcp_confirm:deleteAccount'), 'off')
  // the recent list shows an action run without the Modal as such
  mcp.recordAuto({ tool: 'delete_account', result: 'ok', count: 1 })
  assert.deepEqual((await call('mcp:recent', main)).calls[0], { at: (await call('mcp:recent', main)).calls[0].at, tool: 'delete_account', result: 'ok', items: 1, kind: 'auto' })
})

test('the recent list marks an action run without the Modal, apart from a plain call and a confirmation', async t => {
  recentRows = [
    { at: 3, tool: 'send_message', result: 'ok', items: 1, kind: 'auto' },
    { at: 2, tool: 'delete_folder', result: 'server_refused', items: 1, kind: 'auto' },
    { at: 1, tool: 'send_message', result: 'rejected', items: 1, kind: 'confirm' },
    { at: 0, tool: 'list_messages', result: 'ok', items: 3, kind: 'call' },
  ]
  const v = await mount(h(ClaudeAccess))
  t.after(v.unmount)
  await inAct(async () => {})
  const cells = [...document.querySelectorAll('.claude-recent tbody tr')].map(r => [r.dataset.kind, r.children[2].textContent])
  assert.deepEqual(cells, [
    ['auto', ca.autoResult('ok')],
    ['auto', ca.autoResult('server_refused')],
    ['confirm', ca.confirmResult('rejected')],
    ['call', ca.result('ok')],
  ])
  assert.notEqual(ca.autoResult('ok'), ca.result('ok'))
  assert.match(ca.autoResult('ok'), /megerősítés nélkül/)
})

test('the draft-editing switch starts OFF, without a red warning; ON and OFF again without a question', async t => {
  const v = await mount(h(ConfirmSettings))
  t.after(v.unmount)
  await inAct(async () => {})
  const modal = () => document.querySelector('.claude-confirm-off-modal')
  assert.equal(sw('updateDraft').checked, false)
  assert.equal(document.querySelector('.claude-confirm-off[data-op="updateDraft"]'), null, 'OFF is its default: no warning')
  assert.ok(document.body.textContent.includes(ca.confirmOpDesc.updateDraft))
  calls.length = 0
  await click(sw('updateDraft'))
  assert.equal(modal(), null)
  assert.equal(policy.isOn('updateDraft'), true)
  await click(sw('updateDraft'))
  assert.equal(modal(), null, 'turning it back OFF asks nothing')
  assert.deepEqual(calls, [['updateDraft', true], ['updateDraft', false]])
  assert.equal(document.querySelector('.claude-confirm-off'), null)
})
