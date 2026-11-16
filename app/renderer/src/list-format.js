// SPDX-License-Identifier: GPL-3.0-or-later
// Formatting for the message list. Pure: also used by the unit tests.
// Dates in the local time zone of the machine (the installation's, Europe/Budapest), in the interface language's locale.
import { locale } from '../i18n/index.js'

const timeFmt = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' })
const dayFmt = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' })
const fullFmt = new Intl.DateTimeFormat(locale, { year: 'numeric', month: '2-digit', day: '2-digit' })

/** today: "14:05"; this year: "nov. 12."; older (or in a future year): "2024. 03. 05." */
export function formatListDate(ms, now = new Date()) {
  if (!ms) return ''
  const d = new Date(ms)
  if (d.toDateString() === now.toDateString()) return timeFmt.format(d)
  if (d.getFullYear() === now.getFullYear()) return dayFmt.format(d)
  return fullFmt.format(d)
}

const tooltipFmt = new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeStyle: 'short' })

/** The full date and time for the tooltip (one cached formatter: a list renders it for every row). */
export function formatFullDate(ms) {
  return ms ? tooltipFmt.format(new Date(ms)) : ''
}

const num = n => n.toLocaleString(locale)

/** The visible range over the total: "1–50 / 1 234" (empty list: "0 / 0"). */
export function formatRange(first, last, total) {
  if (!total) return '0 / 0'
  return `${num(first)}–${num(last)} / ${num(total)}`
}

/** The preview text for one line: whitespace collapsed; empty when there is none. */
export function previewLine(preview) {
  return preview ? String(preview).replace(/\s+/g, ' ').trim() : ''
}
