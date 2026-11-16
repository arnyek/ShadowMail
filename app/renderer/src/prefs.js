// SPDX-License-Identifier: GPL-3.0-or-later
// Small per-installation view settings of the renderer (the folded sidebar and accounts, the panes, the theme).
// They live in the window's localStorage, which is in the portable data folder
// (data\electron\sessionData), so they survive a restart and travel with the data. Never mail data,
// never secrets: only layout switches. A broken or missing store falls back to the default.
// Chromium writes localStorage to disk late, so a value set just before a forced stop (a crash, taskkill) could be
// lost; after a change the main process is asked to write it now (app:flushPrefs), once for a burst of changes (a
// splitter drag writes many): FLUSH_DELAY_MS after the last one. A failed flush is as quiet as a failed write.
const PREFIX = 'shadowmail.ui.'
export const FLUSH_DELAY_MS = 300
let flushTimer = null

function scheduleFlush() {
  if (flushTimer !== null) clearTimeout(flushTimer)
  flushTimer = setTimeout(() => {
    flushTimer = null
    try {
      const bridge = window.shadowMail
      if (bridge && typeof bridge.flushPrefs === 'function') Promise.resolve(bridge.flushPrefs()).catch(() => {})
    } catch {
      // no bridge (a test page): nothing to flush
    }
  }, FLUSH_DELAY_MS)
}

export function getPref(key, fallback) {
  try {
    const raw = window.localStorage.getItem(PREFIX + key)
    return raw === null ? fallback : JSON.parse(raw)
  } catch {
    return fallback
  }
}

export function setPref(key, value) {
  try {
    window.localStorage.setItem(PREFIX + key, JSON.stringify(value))
    scheduleFlush()
  } catch {
    // a full or blocked store: the switch still works for this session
  }
}
