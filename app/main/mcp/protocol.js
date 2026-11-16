// SPDX-License-Identifier: GPL-3.0-or-later
// MCP: the JSON-RPC 2.0 side of the server inside the running app. Own
// small implementation, no SDK (plan: the SDK would bring many dependencies for a few tools).
// Protocol version: @modelcontextprotocol/sdk 1.32.1 LATEST_PROTOCOL_VERSION = '2025-11-25' and its
// SUPPORTED_PROTOCOL_VERSIONS (read from the installed package, dist/esm/types.js, 2026-11-12).
// The log line of a tool call: tool, result, item count, duration. Never arguments or results (3.5).

export const PROTOCOL_VERSION = '2025-11-25'
export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'])
export const JSONRPC = Object.freeze({ parseError: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602, internalError: -32603 })

const KNOWN_NOTIFICATIONS = new Set(['notifications/initialized', 'notifications/cancelled'])
const error = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } })
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * tools: { list() -> [{ name, description, inputSchema }], call(name, args, ctx) -> { data, items } | throws ToolError }
 * Returns dispatch(line, ctx) -> the answer as an object, or null (a notification). ctx.alive() is false once
 * the connection, the session or the switch is gone: an async tool checks it before it
 * touches mail data, and its result is dropped.
 */
/** @param onCall ({ tool, result, items }) after every tool call: the "Legutóbbi Claude-hívások" list */
export function createDispatcher({ serverInfo, tools, log = () => {}, now = () => Date.now(), onCall = () => {} }) {
  return async function dispatch(line, ctx = { alive: () => true }) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return error(null, JSONRPC.parseError, 'Parse error')
    }
    if (!isObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return error(isObject(message) && 'id' in message ? message.id : null, JSONRPC.invalidRequest, 'Invalid Request')
    }
    const { method, params } = message
    if (!('id' in message)) {
      // JSON-RPC 2.0: a message with a method and no id is a notification, never answered;
      // one we do not know only leaves a log line, without its content
      if (!KNOWN_NOTIFICATIONS.has(method)) log('mcp notification ignored')
      return null
    }
    const id = message.id
    if (!(typeof id === 'string' || Number.isInteger(id))) return error(null, JSONRPC.invalidRequest, 'Invalid Request: bad id')
    switch (method) {
      case 'initialize': {
        const asked = isObject(params) ? params.protocolVersion : undefined
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo,
          },
        }
      }
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} }
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: tools.list() } }
      case 'tools/call': {
        if (!isObject(params) || typeof params.name !== 'string') return error(id, JSONRPC.invalidParams, 'Invalid params')
        const args = params.arguments === undefined ? {} : params.arguments
        if (!isObject(args)) return error(id, JSONRPC.invalidParams, 'Invalid params')
        if (!tools.has(params.name)) return error(id, JSONRPC.invalidParams, `Unknown tool`)
        const started = now()
        try {
          const { data, items, text } = await tools.call(params.name, args, ctx)
          if (!ctx.alive()) {
            log(`mcp tool=${params.name} result=dropped items=0 ms=${now() - started}`)
            onCall({ tool: params.name, result: 'dropped', items: 0 })
            return null
          }
          log(`mcp tool=${params.name} result=ok items=${items} ms=${now() - started}`)
          // a call that waits for the user answers ok with pending_confirmation: the list says that
          onCall({ tool: params.name, result: data && data.status === 'pending_confirmation' ? 'pending_confirmation' : 'ok', items: Number(items) || 0 })
          // since 0.11.1 the model reads the TEXT (the tool's own wording, message fields inside
          // <email_content>). A structuredContent next to it was what Claude got instead of the text
          // (measured with a real Claude Code), so there is none: our metadata goes to _meta for programs
          // and tests, and tools/list gives no outputSchema.
          return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: text ?? JSON.stringify(data) }], _meta: { [META_KEY]: data }, isError: false } }
        } catch (err) {
          const code = err && typeof err.code === 'string' ? err.code : 'internal'
          log(`mcp tool=${params.name} result=${code} items=0 ms=${now() - started}`)
          onCall({ tool: params.name, result: code, items: 0 })
          // the error code (and e.g. retry_after_s) for a program; never message content. The model sees
          // them in the text too (0.11.1): "<message> (hiba: <code>, <key>: <value>, ...)"
          const extra = err && err.data && typeof err.data === 'object' ? err.data : {}
          const message = err && err.userMessage ? err.userMessage : 'Error'
          return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `${message} ${errorTail(code, extra)}` }], _meta: { [META_KEY]: { error: code, ...extra } }, isError: true } }
        }
      }
      default:
        return error(id, JSONRPC.methodNotFound, 'Method not found')
    }
  }
}

/** The _meta key of a tools/call result that holds our machine-readable data (0.11.1; was structuredContent). */
export const META_KEY = 'shadowmail/data'

/** "(hiba: <code>, <key>: <value>, ...)": the error code and its extra fields in words, for the model. */
export function errorTail(code, extra = {}) {
  const parts = [`hiba: ${code}`]
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined || v === null || k === 'error') continue
    parts.push(`${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
  }
  return `(${parts.join(', ')})`
}

/** The smallest tool set: `status` only (createMcpTools adds the rest). */
export function createTools({ appVersion, accountCount }) {
  const defs = {
    status: {
      description: 'ShadowMail status: the program version and the number of mail accounts. Takes no arguments.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: () => ({ data: { appVersion, accounts: accountCount() }, items: 1 }),
    },
  }
  return {
    list: () => Object.entries(defs).map(([name, d]) => ({ name, description: d.description, inputSchema: d.inputSchema })),
    has: name => Object.hasOwn(defs, name),
    call: async (name, args) => defs[name].run(args),
  }
}
