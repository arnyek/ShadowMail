// SPDX-License-Identifier: GPL-3.0-or-later
// The main window's smallest width: the mail view's three panes side by side at their minimum (with the reader on the
// right) still fit, so a narrow window never cuts the reader off. The same for every reader layout. (The dividers clamp
// every pane, a saved size or the stylesheet's default, between its minimum and what the others leave.)
// The panes' minimum (app/renderer/src/Mail.jsx): folder sidebar 180 + message list 280 + reader 360, + the mail area's
// 16 px right margin (app.css) = 836, + 24 px spare. test/window-size.test.js reads them and keeps this in step.
export const MAIN_MIN_WIDTH = 860

// The composer window's size, and where it opens: centered on the main window, on the display the main window is on
// (its work area: without the taskbar), shrunk to that work area when it does not fit. Electron's default would be the
// center of the PRIMARY display, whichever monitor the main window is on.
export const COMPOSER_SIZE = Object.freeze({ width: 900, height: 700 })

const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi))

/**
 * main: the main window's bounds { x, y, width, height } (its normal bounds when minimized); workArea: the work area of
 * the display that holds it (screen.getDisplayMatching(main).workArea). -> { x, y, width, height }, whole pixels.
 */
export function composerBounds(main, workArea, size = COMPOSER_SIZE) {
  const width = Math.min(size.width, workArea.width)
  const height = Math.min(size.height, workArea.height)
  const x = Math.round(main.x + main.width / 2 - width / 2)
  const y = Math.round(main.y + main.height / 2 - height / 2)
  return {
    x: clamp(x, workArea.x, workArea.x + workArea.width - width),
    y: clamp(y, workArea.y, workArea.y + workArea.height - height),
    width,
    height,
  }
}
