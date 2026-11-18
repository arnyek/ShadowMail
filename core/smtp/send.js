// SPDX-License-Identifier: GPL-3.0-or-later
// Sending over SMTP: the account's security mode (tls = implicit TLS, starttls = required,
// none = only when set explicitly), the same mapping as the connection test (core/accounts/probe.js).
// The raw message is sent as built; the envelope carries every recipient (Bcc too).
import nodemailer from 'nodemailer'
import { smtpOptions } from '../accounts/probe.js'

export const SEND_TIMEOUT_MS = 60_000

/**
 * @returns { accepted, rejected, response, messageId }
 * Throws nodemailer's error (classify with classifyError: auth_failed, connection_refused, ...).
 */
export async function sendRaw({ account, password, envelope, raw, createTransport = nodemailer.createTransport, timeoutMs = SEND_TIMEOUT_MS }) {
  // forceAuth (from smtpOptions): a server that offers no AUTH is refused, the message never goes out unauthenticated
  // was the whole message handed over when an error came? nodemailer's own log line says when the message stream
  // has gone into the socket (after the server's 354 to DATA); an error after it (no final answer in time, the
  // connection lost, a refusal of the message itself) leaves it unknown whether the server took it: `afterData` on
  // the error (the scheduler then never sends it again on its own). Only this event is looked at, nothing is logged.
  let handed = false
  const watch = { info: entry => (entry && entry.tnx === 'message' && 'outByteCount' in entry ? (handed = true) : undefined), trace() {}, debug() {}, warn() {}, error() {}, fatal() {} }
  const transport = createTransport({ ...smtpOptions(account, password, { timeoutMs }), logger: watch })
  try {
    let info
    try {
      info = await transport.sendMail({ envelope, raw })
    } catch (err) {
      if (handed && err && typeof err === 'object') err.afterData = true
      throw err
    }
    // a server that takes the message for nobody is a failure, not a success
    if (!info.accepted || !info.accepted.length) {
      throw Object.assign(new Error(`no recipient accepted: ${info.response || ''}`), { code: 'no_recipient_accepted', rejected: info.rejected })
    }
    return { accepted: info.accepted, rejected: info.rejected || [], response: info.response, messageId: info.messageId }
  } finally {
    transport.close()
  }
}
