// SPDX-License-Identifier: GPL-3.0-or-later
// The reader's keys typed inside the message frame. The mail-view: frame runs no script (its CSP), so a key
// pressed after a click into the message body never reaches the page's own handler; the main process sees it first
// (webContents 'before-input-event', with webContents.focusedFrame naming the frame) and passes the four reader keys on
// as an app:status event. Pure, no Electron.
import { VIEW_SCHEME } from './protocols.js'

const KEYS = { ArrowUp: 'up', ArrowDown: 'down', Delete: 'delete', End: 'archive' }

/**
 * input: Electron's before-input-event Input; frameUrl: the focused frame's url (or null). -> 'up' | 'down' | 'delete' |
 * 'archive' when the key is one of the reader's, pressed in the message frame (Shift only with Delete, as on the page),
 * else null (the key goes on as usual: PageUp / PageDown / Space still scroll the message).
 */
export function frameReaderKey(input, frameUrl) {
  if (!input || input.type !== 'keyDown') return null
  if (typeof frameUrl !== 'string' || !frameUrl.startsWith(`${VIEW_SCHEME}://`)) return null
  if (input.control || input.alt || input.meta || (input.shift && input.key !== 'Delete')) return null
  return KEYS[input.key] || null
}
