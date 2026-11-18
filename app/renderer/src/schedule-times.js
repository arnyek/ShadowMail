// SPDX-License-Identifier: GPL-3.0-or-later
// "Küldés később": the quick choices and the custom time, in the computer's local time (summer time by the Date
// itself). Pure: the composer's dialog and the tests use it.

const MIN_AHEAD = 60_000

const at = (base, dayOffset, hour) => {
  const d = new Date(base)
  d.setDate(d.getDate() + dayOffset)
  d.setHours(hour, 0, 0, 0)
  return d.getTime()
}

/**
 * The quick choices from `now`: this evening 18:00 (only if still at least a minute ahead), tomorrow 8:00, Monday 8:00
 * (the next Monday; left out when it is tomorrow, the same time twice). -> [{ key, at }]
 */
export function quickTimes(now) {
  const out = []
  const evening = at(now, 0, 18)
  if (evening >= now + MIN_AHEAD) out.push({ key: 'today18', at: evening })
  out.push({ key: 'tomorrow8', at: at(now, 1, 8) })
  const day = new Date(now).getDay() // 0 Sunday .. 6 Saturday
  const toMonday = ((8 - day) % 7) || 7
  if (toMonday !== 1) out.push({ key: 'monday8', at: at(now, toMonday, 8) })
  return out
}

/** "2026-11-20" + "07:30" (the inputs' own forms) -> ms in local time, or null. */
export function localTime(date, time) {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''))
  const h = /^(\d{2}):(\d{2})$/.exec(String(time || ''))
  if (!d || !h) return null
  const [y, mo, da, hh, mm] = [+d[1], +d[2], +d[3], +h[1], +h[2]]
  if (mo < 1 || mo > 12 || da < 1 || da > 31 || hh > 23 || mm > 59) return null
  const v = new Date(y, mo - 1, da, hh, mm, 0, 0)
  // a day that does not exist (31 November) rolls over: refused
  if (v.getFullYear() !== y || v.getMonth() !== mo - 1 || v.getDate() !== da) return null
  return v.getTime()
}

/** The inputs' default values: tomorrow, 8:00. */
export function customDefaults(now) {
  const d = new Date(at(now, 1, 8))
  const p = n => String(n).padStart(2, '0')
  return { date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, time: '08:00' }
}
