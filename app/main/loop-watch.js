// SPDX-License-Identifier: GPL-3.0-or-later
// The main thread's event-loop gaps during a sync run, for the run's diagnostic log line (sync-manager.js): one timer
// for every run (INTERVAL_MS, unref'd), on only while at least one run window is open. Each window keeps the longest
// delay of the timer (how much later than due it fired: a block of N ms gives a delay of at least N - INTERVAL_MS) and
// how many delays were over OVER_MS. Two runs at once see the same gap, each in its own window. Electron-free.
export const INTERVAL_MS = 10
export const OVER_MS = 100

export function createLoopWatch({ intervalMs = INTERVAL_MS, overMs = OVER_MS, now = () => performance.now() } = {}) {
  const windows = new Set()
  let timer = null
  let last = 0
  const tick = () => {
    const t = now()
    const delay = Math.max(0, t - last - intervalMs)
    last = t
    for (const w of windows) {
      if (delay > w.max) w.max = delay
      if (delay > overMs) w.over++
    }
  }
  const startTimer = () => {
    last = now()
    timer = setInterval(tick, intervalMs)
    if (timer.unref) timer.unref()
  }
  const stopTimer = () => {
    clearInterval(timer)
    timer = null
  }
  return {
    /** a run starts: its window; -> { end() -> { max, over } } (end once; a later end gives the same numbers) */
    begin() {
      const w = { max: 0, over: 0 }
      windows.add(w)
      if (!timer) startTimer()
      let result = null
      return {
        end() {
          if (result) return result
          // the time since the last tick counts too: a block right before the end is not lost
          if (timer) {
            const delay = Math.max(0, now() - last - intervalMs)
            if (delay > w.max) w.max = delay
            if (delay > overMs) w.over++
          }
          windows.delete(w)
          if (!windows.size && timer) stopTimer()
          result = { max: Math.round(w.max), over: w.over }
          return result
        },
      }
    },
    /** is the timer on (tests) */
    running: () => Boolean(timer),
    /** lock / quit: every window closed, the timer off */
    stop() {
      windows.clear()
      stopTimer()
    },
  }
}
