// SPDX-License-Identifier: GPL-3.0-or-later
// Second line of defence for the message view: every http(s)/ws(s)/ftp request of the
// app's session is cancelled, except images from the hosts the user allowed with "Képek betöltése"
// for the message that is open right now. The first line is the frame's CSP and the sanitizer; this
// one also catches what they might miss (CSS url(), <link>, srcset). Every decision is logged
// (host only: query strings of tracking links are not written to disk).
//
// IMAP/SMTP run in the main process over Node sockets and are not affected.

const NETWORK = /^(https?|wss?|ftp):$/

/**
 * -> 'pass' (not a network request: file:, mail-view:, cid-img:, data:, devtools...),
 *    'allow' (an image from an allowed host), 'block'.
 */
export function netDecision({ url, resourceType }, allowedHosts) {
  let u
  try {
    u = new URL(url)
  } catch {
    return 'block'
  }
  if (!NETWORK.test(u.protocol)) return 'pass'
  const isHttp = u.protocol === 'http:' || u.protocol === 'https:'
  if (isHttp && resourceType === 'image' && allowedHosts && allowedHosts.has(u.host.toLowerCase())) return 'allow'
  return 'block'
}

export function guardLogLine(decision, { url, resourceType }) {
  let where = '?'
  try {
    const u = new URL(url)
    where = `${u.protocol}//${u.host}`
  } catch {
    // keep '?'
  }
  return `${new Date().toISOString()} ${decision} ${resourceType || '-'} ${where}`
}

/**
 * @param ses           Electron Session
 * @param allowedHosts  () => Set<string> of host[:port], lower case
 * @param write         (line) => void, the net-guard log
 */
export function installNetGuard({ ses, allowedHosts, write = () => {} }) {
  ses.webRequest.onBeforeRequest((details, callback) => {
    const decision = netDecision(details, allowedHosts())
    if (decision !== 'pass') write(guardLogLine(decision, details))
    callback({ cancel: decision === 'block' })
  })
}
