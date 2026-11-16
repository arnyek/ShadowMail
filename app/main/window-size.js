// SPDX-License-Identifier: GPL-3.0-or-later
// The main window's smallest width: the mail view's three panes side by side at their minimum (with the reader on the
// right) still fit, so a narrow window never cuts the reader off. The same for every reader layout. (The dividers clamp
// every pane, a saved size or the stylesheet's default, between its minimum and what the others leave.)
// The panes' minimum (app/renderer/src/Mail.jsx): folder sidebar 180 + message list 280 + reader 360, + the mail area's
// 16 px right margin (app.css) = 836, + 24 px spare. test/window-size.test.js reads them and keeps this in step.
export const MAIN_MIN_WIDTH = 860
