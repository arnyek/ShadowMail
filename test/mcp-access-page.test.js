// MCP: the "Claude-hozzáférés" page's main side: the config snippets with the program's
// path (formats from the official docs, 2026-11-13), the last 20 Claude calls in memory (tool, result, count; never an
// argument), the confirmations' results in the same list, and the read-only IPC with the Másolás of a snippet.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tempDir } from './helpers/tmp.js'
import { createDispatcher } from '../app/main/mcp/protocol.js'
import { createMcpService, registerMcpIpc, connectSnippets, RECENT_CALLS, MCP_CHANNELS } from '../app/main/mcp/service.js'

test('connectSnippets: Claude Desktop JSON with the exact path; Claude Code command quoted for the platform', () => {
  const win = connectSnippets({ exe: 'D:\\Apps\\Shadow Mail\\ShadowMail.exe', args: ['--mcp'], platform: 'win32' })
  assert.deepEqual(JSON.parse(win.desktop), { mcpServers: { shadowmail: { command: 'D:\\Apps\\Shadow Mail\\ShadowMail.exe', args: ['--mcp'] } } })
  assert.ok(win.desktop.includes('"D:\\\\Apps\\\\Shadow Mail\\\\ShadowMail.exe"'), 'the backslashes doubled in the JSON')
  assert.equal(win.code, 'claude mcp add --transport stdio --scope user shadowmail -- "D:\\Apps\\Shadow Mail\\ShadowMail.exe" --mcp')
  const nix = connectSnippets({ exe: "/opt/it's here/electron", args: ['/repo', '--mcp'], env: { SHADOWMAIL_DATA: '/tmp/d d' }, platform: 'linux' })
  assert.deepEqual(JSON.parse(nix.desktop).mcpServers.shadowmail, { command: "/opt/it's here/electron", args: ['/repo', '--mcp'], env: { SHADOWMAIL_DATA: '/tmp/d d' } })
  assert.equal(nix.code, "claude mcp add --env SHADOWMAIL_DATA='/tmp/d d' --transport stdio --scope user shadowmail -- '/opt/it'\\''s here/electron' /repo --mcp")
  // the docs: the server name must not follow --env directly
  assert.doesNotMatch(nix.code, /--env \S+ shadowmail/)
})

test('the dispatcher tells every tool call (tool, result, count), never its arguments', async () => {
  const seen = []
  const tools = {
    list: () => [],
    has: () => true,
    call: async (name, args) => {
      if (name === 'boom') throw Object.assign(new Error('x'), { code: 'not_found' })
      if (name === 'wait') return { data: { status: 'pending_confirmation' }, items: 0, text: 'x' }
      return { data: { echo: args }, items: 3, text: 'x' }
    },
  }
  const dispatch = createDispatcher({ serverInfo: { name: 's', version: '1' }, tools, onCall: c => seen.push(c) })
  const call = (name, args) => dispatch(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }))
  await call('search_messages', { query: 'TITKOS-KERESOSZO' })
  await call('boom', {})
  await call('wait', {})
  assert.deepEqual(seen, [
    { tool: 'search_messages', result: 'ok', items: 3 },
    { tool: 'boom', result: 'not_found', items: 0 },
    { tool: 'wait', result: 'pending_confirmation', items: 0 },
  ])
  assert.ok(!JSON.stringify(seen).includes('TITKOS'))
})

test('the recent list: newest first, at most 20, the confirmations\' results too; the IPC reads it and copies a snippet', async t => {
  const settings = new Map()
  let clock = 1000
  const mcp = createMcpService({ dataDir: tempDir(t), settings: { get: k => settings.get(k) ?? null, set: (k, v) => settings.set(k, v) }, appVersion: '0', accountCount: () => 0, now: () => clock++ })
  t.after(() => mcp.stop())
  for (let i = 0; i < RECENT_CALLS + 5; i++) mcp.recordConfirmation({ tool: `t${i}`, status: 'approved', count: i })
  mcp.recordConfirmation({ tool: 'send_message', status: 'rejected', count: 1 })
  const list = mcp.recent()
  assert.equal(list.length, RECENT_CALLS)
  assert.deepEqual(list[0], { at: list[0].at, tool: 'send_message', result: 'rejected', items: 1, kind: 'confirm' })
  assert.ok(list[0].at > list[1].at, 'newest first')
  const handlers = new Map()
  const copied = []
  registerMcpIpc({
    ipcMain: { handle: (c, fn) => handlers.set(c, fn) },
    mcp,
    isTrustedSender: e => e.trusted,
    connectInfo: () => ({ exe: 'C:\\SM\\ShadowMail.exe', args: ['--mcp'], env: null, platform: 'win32' }),
    copyText: async text => copied.push(text),
  })
  for (const c of ['mcp:recent', 'mcp:connectInfo', 'mcp:copy']) assert.ok(MCP_CHANNELS.includes(c) && handlers.has(c), c)
  const call = (c, ...a) => handlers.get(c)({ trusted: true }, ...a)
  assert.equal((await call('mcp:recent')).calls.length, RECENT_CALLS)
  const info = await call('mcp:connectInfo')
  assert.equal(info.exe, 'C:\\SM\\ShadowMail.exe')
  assert.deepEqual(await call('mcp:copy', 'code'), { ok: true })
  assert.deepEqual(await call('mcp:copy', 'desktop'), { ok: true })
  assert.deepEqual(copied, [info.code, info.desktop], 'the main process\'s own text goes to the clipboard')
  for (const bad of ['other', { text: 'x' }, null]) assert.deepEqual(await call('mcp:copy', bad), { ok: false, error: 'bad_request' })
  assert.deepEqual(await handlers.get('mcp:recent')({ trusted: false }), { ok: false, error: 'untrusted_sender' })
})

test('a Windows path with $ or a backtick gets PowerShell single quotes and says so', () => {
  const r = connectSnippets({ exe: "C:\\Mail$Box\\O'B\\ShadowMail.exe", args: ['--mcp'], platform: 'win32' })
  assert.equal(r.code, "claude mcp add --transport stdio --scope user shadowmail -- 'C:\\Mail$Box\\O''B\\ShadowMail.exe' --mcp")
  assert.equal(r.powershell, true)
  assert.equal(connectSnippets({ exe: 'C:\\Mail`x\\ShadowMail.exe', args: ['--mcp'], platform: 'win32' }).powershell, true)
  const plain = connectSnippets({ exe: 'C:\\Shadow Mail\\ShadowMail.exe', args: ['--mcp'], platform: 'win32' })
  assert.deepEqual([plain.powershell, plain.code.includes('"C:\\Shadow Mail\\ShadowMail.exe"')], [false, true], 'cmd and PowerShell both take it')
  assert.equal(JSON.parse(r.desktop).mcpServers.shadowmail.command, "C:\\Mail$Box\\O'B\\ShadowMail.exe", 'the JSON is exact')
})
