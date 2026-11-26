// SPDX-License-Identifier: GPL-3.0-or-later
// The reader's right-click menu: the item the user chose comes back with the menu's token (context-menu.js). Only the
// main window may ask; nothing else than the token and the item id is taken.
import { MENU_ITEMS } from '../context-menu.js'

export const CONTEXT_MENU_CHANNEL = 'reader:contextMenu'

export function registerContextMenuIpc({ ipcMain, menus, isMainWindow }) {
  ipcMain.handle(CONTEXT_MENU_CHANNEL, async (event, token, item, ...rest) => {
    if (!isMainWindow(event)) return { ok: false, error: 'untrusted_sender' }
    if (rest.length || typeof token !== 'string' || token.length > 100 || !MENU_ITEMS.includes(item)) return { ok: false, error: 'bad_request' }
    return menus.choose(token, item)
  })
}
