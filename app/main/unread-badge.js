// SPDX-License-Identifier: GPL-3.0-or-later
// When the taskbar badge is drawn again (Electron-free, so it is tested on its own): a change signal schedules ONE
// recount after `delayMs` (the changes of a big batch, e.g. 5000 messages marked read at once, fold into it), and the
// badge is applied only when the number really changed. Switched off or stopped (lock, quit): the badge goes (apply(0))
// and no recount runs until it is switched on again.

export const BADGE_DELAY_MS = 300

/**
 * total(): the current unread number; apply(n): draw it (0 = no badge).
 * -> { changed(), refresh(), setEnabled(on), stop(), enabled }
 */
export function createUnreadBadge({ total, apply, delayMs = BADGE_DELAY_MS, enabled = true, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let last
  let timer = null
  let on = enabled
  let stopped = false
  const cancel = () => {
    if (timer) clearTimer(timer)
    timer = null
  }
  const refresh = () => {
    timer = null
    if (!on || stopped) return
    const n = total()
    if (n === last) return
    last = n
    apply(n)
  }
  const clear = () => {
    cancel()
    if (last !== 0 && last !== undefined) apply(0)
    last = undefined
  }
  return {
    changed() {
      if (!on || stopped || timer) return
      timer = setTimer(refresh, delayMs)
    },
    refresh() {
      cancel()
      refresh()
    },
    setEnabled(value) {
      on = Boolean(value)
      if (!on) clear()
      else if (!stopped) {
        cancel()
        refresh()
      }
    },
    stop() {
      stopped = true
      clear()
    },
    get enabled() {
      return on
    },
  }
}

/** The stored switch (settings key taskbar_unread): 'off' switches it off, anything else (missing, damaged) is on. */
export const TASKBAR_UNREAD_KEY = 'taskbar_unread'
export const taskbarUnreadOn = value => value !== 'off'
