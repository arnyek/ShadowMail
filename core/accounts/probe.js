// SPDX-License-Identifier: GPL-3.0-or-later
// "Kapcsolat próbája": incoming login (IMAP or POP3) and SMTP verify(), each with a time limit,
// and a classification of the failure into a code the UI turns into Hungarian text.
import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'
import { imapOptions } from '../imap/client.js'
import { Pop3Client } from '../pop3/client.js'

export const PROBE_TIMEOUT_MS = 20_000 // per leg; both legs run in parallel, so the answer comes within ~20 s

export const PROBE_ERRORS = Object.freeze([
  'auth_failed',
  'auth_not_offered',
  'host_not_found',
  'connection_refused',
  'timeout',
  'tls_certificate',
  'starttls_unsupported',
  'tls_mismatch',
  'mailbox_in_use',
  'unknown',
])

const CERT_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_UNTRUSTED',
  'CERT_REVOKED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'HOSTNAME_MISMATCH',
])

/** Maps an error from imapflow, nodemailer, the POP3 client or the socket to one of PROBE_ERRORS. */
export function classifyError(err) {
  if (!err) return 'unknown'
  const text = `${err.message || ''} ${err.response || ''} ${err.responseText || ''}`
  // nodemailer wraps socket errors as ESOCKET/ECONNECTION and keeps the system code only in the text
  let code = String(err.code || '')
  if (['ESOCKET', 'ECONNECTION', 'EPROTOCOL', ''].includes(code)) {
    const sys = /\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|ECONNRESET)\b/.exec(text)
    if (sys) code = sys[1]
  }
  // SMTP AUTH refused as a command (500/502/503/504: "not recognized", "authentication not enabled"):
  // typically plain text without TLS. Not a wrong password, so it gets its own message.
  if (code === 'EAUTH' && [500, 502, 503, 504].includes(err.responseCode)) return 'auth_not_offered'
  // POP3 [IN-USE] / [SYS/TEMP] (RFC 2449): the mailbox is busy, not a wrong password
  if (code === 'POP3_IN_USE') return 'mailbox_in_use'
  if (err.authenticationFailed || code === 'EAUTH' || code === 'POP3_AUTH') return 'auth_failed'
  if (CERT_CODES.has(code) || /certificate|self[- ]signed|altnames/i.test(text)) return 'tls_certificate'
  // nodemailer: ETLS "Error upgrading connection with STARTTLS: 500 ..." when the server refuses it
  if (code === 'STARTTLS_UNSUPPORTED' || (code === 'ETLS' && err.command === 'STARTTLS') ||
    /does not support STARTTLS|does not support STLS|STARTTLS.*not (supported|available)|upgrading connection with STARTTLS/i.test(text)) {
    return 'starttls_unsupported'
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EDNS') return 'host_not_found'
  if (code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'connection_refused'
  if (/wrong version number|packet length too long|unknown protocol|ERR_SSL|EPROTO/i.test(`${code} ${text}`)) return 'tls_mismatch'
  if (['ETIMEDOUT', 'ETIMEOUT', 'GREETING_TIMEOUT', 'CONNECTION_TIMEOUT', 'PROBE_TIMEOUT', 'ESOCKET_TIMEOUT'].includes(code)) return 'timeout'
  if (/timed? ?out/i.test(text)) return 'timeout'
  if (err.tlsFailed) return 'starttls_unsupported'
  return 'unknown'
}

function withTimeout(promise, ms, onTimeout) {
  let timer
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => {
      if (onTimeout) onTimeout()
      const err = new Error(`no answer within ${ms} ms`)
      err.code = 'PROBE_TIMEOUT'
      reject(err)
    }, ms)
  })
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer))
}

// The detail text goes to the UI: make sure a password never rides along in a server echo.
function redact(text, secret) {
  return secret ? text.split(secret).join('***') : text
}

async function leg(fn, timeoutMs, cleanup, secret) {
  const t0 = Date.now()
  try {
    await withTimeout(fn(), timeoutMs, cleanup)
    return { ok: true, error: null, detail: null, ms: Date.now() - t0 }
  } catch (err) {
    const detail = redact(String((err && err.message) || err), secret).slice(0, 300)
    return { ok: false, error: classifyError(err), detail, ms: Date.now() - t0 }
  }
}

export function probeImap(account, password, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const client = new ImapFlow({
    ...imapOptions(account, password),
    connectionTimeout: timeoutMs,
    greetingTimeout: Math.min(timeoutMs, 16_000),
    socketTimeout: timeoutMs,
  })
  client.on('error', () => {}) // reported through connect()'s rejection
  return leg(
    async () => {
      await client.connect()
      await client.logout()
    },
    timeoutMs,
    () => client.close(),
    password,
  )
}

export function probePop3(account, password, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const client = new Pop3Client({
    host: account.in_host,
    port: account.in_port,
    security: account.in_security,
    tlsVerify: account.tls_verify !== 0,
    timeoutMs,
  })
  return leg(
    async () => {
      try {
        await client.connect()
        await client.login(account.in_user, password)
        await client.quit()
      } finally {
        client.close()
      }
    },
    timeoutMs,
    () => client.close(),
    password,
  )
}

/** nodemailer options for the account's SMTP side (also used for sending). */
export function smtpOptions(account, password, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const security = account.smtp_security
  return {
    host: account.smtp_host,
    port: account.smtp_port,
    secure: security === 'tls',
    requireTLS: security === 'starttls', // STARTTLS or fail, no silent plain text
    ignoreTLS: security === 'none',
    auth: { user: account.smtp_user || account.in_user, pass: password },
    // Without it verify() reports success WITHOUT logging in when the server offers no AUTH (measured),
    // and the connection test would say "ok" for a password it never checked.
    forceAuth: true,
    tls: { rejectUnauthorized: account.tls_verify !== 0 },
    connectionTimeout: timeoutMs,
    greetingTimeout: Math.min(timeoutMs, 16_000),
    socketTimeout: timeoutMs,
    logger: false,
    debug: false,
  }
}

export function probeSmtp(account, password, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const transport = nodemailer.createTransport(smtpOptions(account, password, { timeoutMs }))
  return leg(
    async () => {
      try {
        await transport.verify()
      } finally {
        transport.close()
      }
    },
    timeoutMs,
    () => transport.close(),
    password,
  )
}

/** Both legs in parallel: { incoming: {ok, error, detail, ms}, smtp: {...} }. */
export async function probeAccount(account, { incomingPassword, smtpPassword }, opts = {}) {
  const incoming = account.type === 'pop3' ? probePop3(account, incomingPassword, opts) : probeImap(account, incomingPassword, opts)
  const [inRes, smtpRes] = await Promise.all([incoming, probeSmtp(account, smtpPassword, opts)])
  return { incoming: inRes, smtp: smtpRes }
}
