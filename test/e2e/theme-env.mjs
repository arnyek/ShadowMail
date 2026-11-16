// SPDX-License-Identifier: GPL-3.0-or-later
// The interface theme of an e2e run: E2E_THEME=<id> (a themes.js id) runs a test under that theme; unset, the default
// theme with no pref written (as before). A test calls useTheme(app, page) right after the first window is there: the
// pref is set and the window reloaded, so the page starts under the theme, as after a restart.
//
//   E2E_THEME=dark node test/e2e/layout-e2e.mjs
import { THEMES } from '../../app/renderer/src/themes.js'

const wanted = process.env.E2E_THEME || ''
if (wanted && !THEMES.some(x => x.id === wanted)) throw new Error(`E2E_THEME must be one of ${THEMES.map(x => x.id).join(', ')}, not ${wanted}`)

export const e2eTheme = wanted || null

/** The theme pref set, every window reloaded, and the page back at its first screen under the theme. */
export async function useTheme(app, page) {
  if (!e2eTheme) return
  await page.waitForLoadState('domcontentloaded')
  await page.evaluate(id => localStorage.setItem('shadowmail.ui.theme', JSON.stringify(id)), e2eTheme)
  await Promise.all([page.waitForEvent('load', { timeout: 20_000 }), app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(w => w.webContents.reload()))])
  await page.waitForFunction(id => document.documentElement.dataset.theme === id, e2eTheme, { timeout: 20_000 })
}
