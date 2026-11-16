// Shared helpers for the live tests against the dedicated test mailbox (not part of `npm test`).
//
// LOCKOUT RULES: the test server bans the whole IP after a few failed logins, and
// the IP is the owner's too. So: a pre-flight without login on every configured port first (no answer
// = no login at all); every login goes through `guardedLogin`, and the FIRST rejected login ends the
// process; no security-mode sweep and no deliberate wrong password against the live server.
// The env file is parsed here (util.parseEnv), never loaded with --env-file (USER would lose against
// the shell's own USER). Nothing here prints the password or the env file.
import fs from 'node:fs'
import net from 'node:net'
import tls from 'node:tls'
import { parseEnv } from 'node:util'
import { ImapFlow } from 'imapflow'
import { classifyError } from '../../core/accounts/probe.js'
import { newAccountDefaults } from '../../core/accounts/defaults.js'

const KEYS = ['IMAP_HOST', 'IMAP_PORT', 'IMAP_SECURITY', 'POP3_HOST', 'POP3_PORT', 'POP3_SECURITY', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURITY', 'USER', 'PASS', 'EMAIL']
export const sec = v => ({ ssl: 'tls', tls: 'tls', starttls: 'starttls', none: 'none' })[String(v).toLowerCase()] || 'invalid'

export function loadEnv(file) {
  if (!file || !fs.existsSync(file)) throw new Error('usage: <script> <test account .env file>')
  const env = parseEnv(fs.readFileSync(file, 'utf8'))
  const missing = KEYS.filter(k => !env[k])
  if (missing.length) throw new Error(`missing keys in the file: ${missing.join(', ')}`)
  return env
}

/** Hide the password in anything that goes to the console. */
export const redactor = env => s => String(s).split(env.PASS).join('***')

export function abort(env, msg) {
  console.log(redactor(env)(`STOP: ${msg}`))
  process.exit(4)
}

const greet = (host, port, security) =>
  new Promise(resolve => {
    const t0 = Date.now()
    const socket = security === 'tls'
      ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false })
      : net.connect({ host, port })
    const done = (ok, what) => {
      socket.destroy()
      resolve({ ok, what, ms: Date.now() - t0 })
    }
    socket.setTimeout(10_000, () => done(false, 'timeout'))
    socket.once('error', err => done(false, err.code || err.message))
    socket.once('data', d => done(true, String(d).slice(0, 3)))
  })

/** Connect (no login) to every configured port; exits the process if one does not greet. */
export async function preflight(env) {
  for (const [name, host, port, s] of [
    ['imap', env.IMAP_HOST, Number(env.IMAP_PORT), sec(env.IMAP_SECURITY)],
    ['pop3', env.POP3_HOST, Number(env.POP3_PORT), sec(env.POP3_SECURITY)],
    ['smtp', env.SMTP_HOST, Number(env.SMTP_PORT), sec(env.SMTP_SECURITY)],
  ]) {
    const g = await greet(host, port, s)
    console.log(`pre-flight ${name} ${s}:${port}: ${g.ok ? 'greeting' : `NO CONNECTION (${g.what})`}`)
    if (!g.ok) abort(env, `pre-flight: ${name} port ${port} does not answer, no login attempted`)
  }
}

/** The account form as the app stores it (configured settings only). */
export function accountForm(env, type, extra = {}) {
  return {
    ...newAccountDefaults(type),
    name: `Tesztfiók (${type})`,
    email: env.EMAIL,
    in_host: type === 'pop3' ? env.POP3_HOST : env.IMAP_HOST,
    in_port: Number(type === 'pop3' ? env.POP3_PORT : env.IMAP_PORT),
    in_security: sec(type === 'pop3' ? env.POP3_SECURITY : env.IMAP_SECURITY),
    in_user: env.USER,
    in_password: env.PASS,
    smtp_host: env.SMTP_HOST,
    smtp_port: Number(env.SMTP_PORT),
    smtp_security: sec(env.SMTP_SECURITY),
    smtp_same_password: true,
    ...extra,
  }
}

/**
 * The "second client": a plain imapflow connection, independent of the app, to check the server side.
 * A rejected login ends the process (lockout rule).
 */
export async function sideClient(env) {
  const s = sec(env.IMAP_SECURITY)
  const client = new ImapFlow({
    host: env.IMAP_HOST,
    port: Number(env.IMAP_PORT),
    secure: s === 'tls',
    doSTARTTLS: s === 'starttls' ? true : s === 'none' ? false : undefined,
    auth: { user: env.USER, pass: env.PASS },
    logger: false,
    connectionTimeout: 20_000,
    greetingTimeout: 16_000,
    socketTimeout: 30 * 60_000,
  })
  client.on('error', () => {})
  try {
    await client.connect()
  } catch (err) {
    const code = classifyError(err)
    abort(env, `side client login failed (${code}): ${err.message}`)
  }
  // keep the connection alive while the app works (servers log idle sessions out)
  const keepAlive = setInterval(() => client.usable && client.noop().catch(() => {}), 60_000)
  keepAlive.unref()
  client.on('close', () => clearInterval(keepAlive))
  return client
}

export function checker() {
  const results = []
  const check = (name, ok, detail = '') => {
    results.push({ name, ok: Boolean(ok) })
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
    return Boolean(ok)
  }
  check.summary = () => {
    const bad = results.filter(r => !r.ok)
    console.log(`\n${results.length - bad.length}/${results.length} OK`)
    return bad.length
  }
  return check
}

export const sleep = ms => new Promise(r => setTimeout(r, ms))

export async function waitFor(fn, { timeout = 30_000, step = 250 } = {}) {
  const t0 = performance.now() // monotonic: the WSL wall clock jumps by ~1 s now and then (measured)
  const ms = () => Math.round(performance.now() - t0)
  for (;;) {
    const v = await fn()
    if (v) return { value: v, ms: ms() }
    if (ms() > timeout) return { value: null, ms: ms() }
    await sleep(step)
  }
}
