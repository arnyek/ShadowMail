// SPDX-License-Identifier: GPL-3.0-or-later
// The right click in a message. The message frame runs no script, so the page gets no contextmenu event from it; the
// main process does (webContents 'context-menu', with the frame, the REAL href of the link, the selection). It keeps
// those, and the page gets only a one-time menu id (token), the item ids and the place: no URL, no address. The chosen
// item comes back with the token and is done here, from the kept parameters: a misleading message or a faulty page
// cannot put anything else on the clipboard. Copying never opens, loads or navigates anything. No Electron import.
import { VIEW_SCHEME } from './protocols.js'

export const MENU_TTL_MS = 60_000
export const MENU_ITEMS = Object.freeze(['copyLink', 'openLink', 'copyAddress', 'newMail', 'copy', 'selectAll'])

/** 'web' (http / https), 'mail' (mailto) or null (no link, or any other scheme: no link item). */
export function linkKind(url) {
  if (typeof url !== 'string' || !url) return null
  let u
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol === 'http:' || u.protocol === 'https:') return 'web'
  if (u.protocol === 'mailto:') return 'mail'
  return null
}

/** The addresses of a mailto: link: without "mailto:" and the "?" part, %-decoded, several joined with ", ". */
export function mailtoAddresses(url) {
  const rest = String(url).replace(/^mailto:/i, '').split('?')[0]
  return rest
    .split(',')
    .map(part => {
      try {
        return decodeURIComponent(part).trim()
      } catch {
        return part.trim() // a broken %-sequence: the text as written
      }
    })
    .filter(Boolean)
    .join(', ')
}

/**
 * Where a right click may open our menu: 'mail' (the message frame, mail-view://view/...), 'page' (the page itself:
 * the reader decides, only over a plain-text message's body) or null (any other frame: nothing).
 */
export function menuSource(frameUrl, isMainFrame) {
  if (isMainFrame) return 'page'
  if (typeof frameUrl === 'string' && frameUrl.startsWith(`${VIEW_SCHEME}://view/`)) return 'mail'
  return null
}

/**
 * The items for Electron's context-menu params: a web link -> copyLink, openLink; a mailto link -> copyAddress,
 * newMail; a selection (not only white space) -> copy; neither a link nor a selection -> selectAll.
 */
export function menuItems(params) {
  const items = []
  const kind = linkKind(params && params.linkURL)
  if (kind === 'web') items.push('copyLink', 'openLink')
  if (kind === 'mail') items.push('copyAddress', 'newMail')
  const selected = typeof (params && params.selectionText) === 'string' && params.selectionText.trim() !== ''
  if (selected) items.push('copy')
  if (!kind && !selected) items.push('selectAll')
  return items
}

/**
 * One open menu at a time. open() keeps the parameters under a new token (an earlier token is void from then on);
 * choose() does the item once, within MENU_TTL_MS, only an item that menu offered.
 * act: { writeText(text), open(url), selectAll(source) } (Electron's clipboard, the shared link opener, the frame).
 */
export class ContextMenus {
  constructor({ act, newToken, now = () => Date.now(), log = () => {} }) {
    this.act = act
    this.newToken = newToken
    this.now = now
    this.log = log
    this.current = null
  }

  /** -> { token, items, x, y, source } for the page, or null (not our frame, nothing to offer). */
  open(params, { frameUrl, isMainFrame }) {
    const source = menuSource(frameUrl, isMainFrame)
    const items = source ? menuItems(params) : []
    if (!source || !items.length) {
      this.current = null
      return null
    }
    const token = this.newToken()
    this.current = {
      token,
      items,
      source,
      at: this.now(),
      linkURL: String(params.linkURL || ''),
      selectionText: String(params.selectionText || ''),
    }
    return { token, items, x: Math.round(Number(params.x) || 0), y: Math.round(Number(params.y) || 0), source }
  }

  /** -> { ok: true } | { ok: false, error: 'stale' | 'not_offered' } */
  choose(token, item) {
    const m = this.current
    if (!m || typeof token !== 'string' || token !== m.token || this.now() - m.at > MENU_TTL_MS) {
      this.log('context menu: an old or unknown menu chosen, nothing done')
      return { ok: false, error: 'stale' }
    }
    if (!m.items.includes(item)) return { ok: false, error: 'not_offered' }
    this.current = null // one use
    if (item === 'copyLink') this.act.writeText(m.linkURL)
    else if (item === 'copyAddress') this.act.writeText(mailtoAddresses(m.linkURL))
    else if (item === 'openLink' || item === 'newMail') this.act.open(m.linkURL)
    else if (item === 'copy') this.act.writeText(m.selectionText)
    else if (item === 'selectAll') this.act.selectAll(m.source)
    return { ok: true }
  }
}
