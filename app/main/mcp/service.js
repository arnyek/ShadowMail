// SPDX-License-Identifier: GPL-3.0-or-later
// MCP: Claude access in one unlocked session. The switch lives in the
// encrypted settings (`settings`, OFF by default); the pipe is open only while the switch is ON and the
// session is unlocked. IPC: mcp:status, mcp:setEnabled (the settings page uses them; the e2e too).
import { McpPipeServer } from './server.js'
import { createDispatcher, createTools } from './protocol.js'

export const MCP_SETTING = 'claude_access'
// mcp:confirm (the user's yes / no, the main window only), mcp:confirmations (the waiting requests)
// mcp:recent (the last Claude calls), mcp:connectInfo (the config snippets), mcp:copy (one of them to the clipboard)
export const MCP_CHANNELS = Object.freeze(['mcp:status', 'mcp:setEnabled', 'mcp:confirm', 'mcp:confirmations', 'mcp:recent', 'mcp:connectInfo', 'mcp:copy', 'mcp:openAck', 'mcp:confirmSettings', 'mcp:setConfirm'])
// the "Legutóbbi Claude-hívások": the last RECENT_CALLS, in memory only (a lock or a restart empties it);
// time, tool, result, item count: never an argument or a result
export const RECENT_CALLS = 20

/**
 * @param settings  { get(key) -> string | null, set(key, value) }, the encrypted settings of the session
 * @param confirm   ConfirmationQueue (M3B): every waiting request is rejected on lock, quit and switch-off
 */
export function createMcpService({ dataDir, settings, appVersion, accountCount, tools = createTools({ appVersion, accountCount }), log = () => {}, platform = process.platform, confirm = null, now = () => Date.now() }) {
  const recent = []
  const record = ({ tool, result, items = 0, kind = 'call' }) => {
    recent.unshift({ at: now(), tool: String(tool), result: String(result), items: Number(items) || 0, kind })
    if (recent.length > RECENT_CALLS) recent.length = RECENT_CALLS
  }
  const dispatch = createDispatcher({ serverInfo: { name: 'shadowmail', version: appVersion }, tools, log, onCall: record })
  const server = new McpPipeServer({ dataDir, dispatch, log, platform })
  const enabled = () => settings.get(MCP_SETTING) === 'on'
  return {
    enabled,
    /** After the unlock: open the pipe when the switch is ON. */
    async start() {
      if (enabled()) await server.start()
    },
    /** Lock ('locked') and quit ('quit'): the waiting requests are rejected, the pipe closes, endpoint.json goes, the key is wiped. */
    stop(reason = 'locked') {
      if (confirm) confirm.rejectAll(reason)
      return server.stop()
    },
    async setEnabled(on) {
      settings.set(MCP_SETTING, on ? 'on' : 'off')
      log(`mcp switch ${on ? 'on' : 'off'}`)
      if (on) {
        try {
          await server.start()
        } catch (err) {
          // setEnabled: a pipe that could not open leaves the switch OFF, not "ON, not running"
          settings.set(MCP_SETTING, 'off')
          log(`mcp switch off again: the pipe did not open (${err && err.code ? err.code : 'internal'})`)
          throw err
        }
      } else {
        if (confirm) confirm.rejectAll('access_off')
        server.stop()
      }
    },
    status: () => ({ enabled: enabled(), running: server.running, connections: server.connections }),
    /** A decided confirmation (M3B) in the list: approved / rejected / expired / failed. */
    recordConfirmation: view => record({ tool: view.tool, result: view.status, items: view.count, kind: 'confirm' }),
    /** An action the user's switch let run without the Modal (confirm-policy.js): ok or its error code. */
    recordAuto: ({ tool, result, count }) => record({ tool, result, items: count, kind: 'auto' }),
    recent: () => recent.map(x => ({ ...x })),
  }
}

/**
 * What the user types into Claude, with the CURRENT path of the program. The app never writes a
 * Claude config. exe: the program's absolute path; args: what follows it (the packaged exe: ['--mcp']); env: only when
 * the data folder is set from outside (SHADOWMAIL_DATA), so the connector finds the same folder.
 * Formats (fetched 2026-11-13, no "last updated" shown):
 *   Claude Desktop, https://modelcontextprotocol.io/docs/develop/connect-local-servers: claude_desktop_config.json,
 *     { "mcpServers": { "<name>": { "command", "args", "env" } } }, absolute paths, the backslashes doubled (JSON);
 *   Claude Code, https://code.claude.com/docs/en/mcp: `claude mcp add [options] <name> -- <command> [args...]`, everything
 *     after `--` goes to the server untouched; --scope user = every project; the name must not follow --env directly.
 * The command line is quoted for the platform's shell. Windows: a double-quoted path works in cmd AND PowerShell, unless
 * it holds a $ or a backtick, which PowerShell expands even there (measured in PowerShell 5.1): then
 * single quotes (PowerShell only, ' doubled) and powershell: true, the page says so. POSIX: single quotes.
 */
export function connectSnippets({ exe, args, env = null, platform = process.platform }) {
  const entry = { command: exe, args, ...(env ? { env } : {}) }
  const desktop = JSON.stringify({ mcpServers: { shadowmail: entry } }, null, 2)
  const plain = s => /^[A-Za-z0-9_\-.,:/=@]+$/.test(s)
  const all = [exe, ...args, ...(env ? Object.values(env) : [])].map(String)
  const powershell = platform === 'win32' && all.some(s => /[$`]/.test(s))
  const q = s => (plain(s) ? s : platform === 'win32' && !powershell ? `"${s}"` : powershell ? `'${String(s).replace(/'/g, "''")}'` : `'${String(s).replace(/'/g, `'\\''`)}'`)
  const envFlags = env ? Object.entries(env).map(([k, v]) => `--env ${k}=${q(v)} `).join('') : ''
  const code = `claude mcp add ${envFlags}--transport stdio --scope user shadowmail -- ${[exe, ...args].map(q).join(' ')}`
  return { desktop, code, powershell }
}

/**
 * @param confirm          ConfirmationQueue (M3B), or null
 * @param isConfirmSender  (event) => boolean: only the main window decides (not a composer window)
 * @param connectInfo      () => { exe, args, env }: the program's own path for the config snippets
 * @param copyText         async (text) => void: the main process's clipboard (Másolás)
 */
export function registerMcpIpc({ ipcMain, mcp, isTrustedSender, log = () => {}, confirm = null, isConfirmSender = () => false, connectInfo = null, copyText = null, onOpenAck = () => {}, policy = null }) {
  const handle = (channel, fn, trusted = isTrustedSender) =>
    ipcMain.handle(channel, async (event, ...args) => {
      if (!trusted(event)) return { ok: false, error: 'untrusted_sender' }
      try {
        return { ok: true, ...(await fn(...args)) }
      } catch (err) {
        if (err && err.badRequest) return { ok: false, error: 'bad_request' }
        log(`${channel} failed: ${err && err.code ? err.code : 'internal'}`)
        return { ok: false, error: 'internal' }
      }
    })
  handle('mcp:status', async () => mcp.status())
  handle('mcp:setEnabled', async on => {
    if (typeof on !== 'boolean') throw Object.assign(new Error('bad request'), { badRequest: true })
    await mcp.setEnabled(on)
    return mcp.status()
  })
  // the decision only: the main process runs the request it stored, never anything sent from here
  handle(
    'mcp:confirm',
    async q => {
      const ok = q !== null && typeof q === 'object' && typeof q.id === 'string' && q.id.length <= 100 && typeof q.approve === 'boolean'
      if (!ok || !confirm) throw Object.assign(new Error('bad request'), { badRequest: true })
      const st = confirm.status(q.id)
      if (st.status === 'not_found') return { status: 'not_found' }
      if (!q.approve) return confirm.reject(q.id)
      // the action may take a while (a send): the answer does not wait for it, the outcome comes as confirmSettled
      confirm.approve(q.id).catch(err => log(`mcp confirm failed: ${err && err.code ? err.code : 'internal'}`))
      return { id: q.id, status: 'running' }
    },
    e => isTrustedSender(e) && isConfirmSender(e),
  )
  handle('mcp:confirmations', async () => ({ requests: confirm ? confirm.pending() : [] }))
  // the confirmation switches (confirm-policy.js): read on the settings page; changed only from the main window, never
  // by an MCP tool (there is none for it)
  handle('mcp:confirmSettings', async () => ({ settings: policy ? policy.list() : [] }))
  handle(
    'mcp:setConfirm',
    async q => {
      const ok = q !== null && typeof q === 'object' && Object.keys(q).length === 2 && typeof q.op === 'string' && typeof q.on === 'boolean'
      if (!ok || !policy) throw Object.assign(new Error('bad request'), { badRequest: true })
      try {
        policy.set(q.op, q.on)
      } catch (err) {
        if (err && err.code === 'bad_request') throw Object.assign(new Error('bad request'), { badRequest: true })
        throw err
      }
      return { settings: policy.list() }
    },
    e => isTrustedSender(e) && isConfirmSender(e),
  )
  // the main window says what it did with Claude's open_message: opened, or only offered
  // (an editor with unsaved input was open); only the main window answers
  handle(
    'mcp:openAck',
    async q => {
      const ok = q !== null && typeof q === 'object' && Number.isInteger(q.seq) && q.seq > 0 && (q.result === 'opened' || q.result === 'offered')
      if (!ok) throw Object.assign(new Error('bad request'), { badRequest: true })
      onOpenAck(q.seq, q.result)
      return {}
    },
    e => isTrustedSender(e) && isConfirmSender(e),
  )
  // read only
  handle('mcp:recent', async () => ({ calls: mcp.recent ? mcp.recent() : [] }))
  const snippets = () => {
    if (!connectInfo) throw Object.assign(new Error('bad request'), { badRequest: true })
    const info = connectInfo()
    return { ...info, ...connectSnippets(info) }
  }
  handle('mcp:connectInfo', async () => snippets())
  // the page names WHICH snippet, the text is made here: the page never puts its own text on the clipboard this way
  handle('mcp:copy', async which => {
    if (!['desktop', 'code'].includes(which) || !copyText) throw Object.assign(new Error('bad request'), { badRequest: true })
    await copyText(snippets()[which])
    return {}
  })
}
