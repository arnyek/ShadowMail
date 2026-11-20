// SPDX-License-Identifier: GPL-3.0-or-later
// Pure helpers of the label chips (0.17.0): the palette, the chip's text color by contrast, the shortened name, and the
// "at most 3 chips, then +N" rule of a list row. No DOM here: the list, the search, the reader and the picker share it.

/** The 12 offered colors (the custom color picker can give any #rrggbb). */
export const LABEL_PALETTE = Object.freeze([
  '#d32f2f', '#f57c00', '#fbc02d', '#388e3c', '#00897b', '#0097a7',
  '#1976d2', '#3949ab', '#7b1fa2', '#c2185b', '#6d4c41', '#616161',
])
export const CHIP_NAME_MAX = 12 // characters shown in a row's chip before the "…"
export const ROW_CHIPS_MAX = 3 // chips in a list row; the rest is "+N"
// The three widths of the row's text cell (px) that switch the label group's form: from `chips` the chips, from `dots`
// up to 3 dots, from `dot` 1 dot, under it nothing in the cell. The CSS holds them in its @container conditions (a var()
// cannot stand there); test/label-fit.test.js checks the two agree.
export const LABEL_FIT = Object.freeze({ chips: 240, dots: 90, dot: 52 })
/** The group's form for a text cell of `width` px: 'chips' | 'dots' | 'dot' | 'none'. */
export function labelFit(width) {
  return width >= LABEL_FIT.chips ? 'chips' : width >= LABEL_FIT.dots ? 'dots' : width >= LABEL_FIT.dot ? 'dot' : 'none'
}
export const CHIP_TEXT_DARK = '#000000'
export const CHIP_TEXT_LIGHT = '#ffffff'

const HEX = /^#[0-9a-f]{6}$/i

/** WCAG relative luminance of '#rrggbb'. */
export function luminance(hex) {
  const n = parseInt(hex.slice(1), 16)
  const lin = c => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255)
}

/** WCAG contrast ratio of two '#rrggbb' colors. */
export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

/**
 * The chip's text color: black or white, whichever contrasts more with the background. For every background one of
 * the two reaches at least 4.58:1 (the worst case is a luminance of about 0.18, where both are equal), so the rule alone
 * gives >= 4.5:1. A malformed color gets the dark text on a neutral background (the caller shows it so).
 */
export function chipTextColor(bg) {
  if (typeof bg !== 'string' || !HEX.test(bg)) return CHIP_TEXT_DARK
  return contrast(bg, CHIP_TEXT_DARK) >= contrast(bg, CHIP_TEXT_LIGHT) ? CHIP_TEXT_DARK : CHIP_TEXT_LIGHT
}

/** The name as a row's chip shows it: at most `max` characters (code points), then "…". */
export function chipName(name, max = CHIP_NAME_MAX) {
  const chars = [...String(name ?? '')]
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('')
}

/**
 * A row's chips: the row's label ids in the label list's order (unknown ids, e.g. a label deleted a moment ago, left
 * out), the first `max` as chips, the rest counted. `title` names every label of the row (the "+N" tooltip).
 * @param ids    the row's label ids (any order)
 * @param list   the label list ([{ id, name, color, sort_order }] in its order)
 */
export function rowChips(ids, list, max = ROW_CHIPS_MAX) {
  if (!Array.isArray(ids) || !ids.length || !Array.isArray(list)) return { shown: [], more: 0, all: [], title: '' }
  const has = new Set(ids)
  const all = list.filter(l => has.has(l.id))
  return { shown: all.slice(0, max), more: Math.max(0, all.length - max), all, title: all.map(l => l.name).join(', ') }
}

/**
 * The picker's state of one label over the chosen messages: 'all' (every one has it), 'some' (indeterminate), 'none'.
 * @param rowsLabels  [[label id]] of the chosen messages
 */
export function pickState(labelId, rowsLabels) {
  if (!rowsLabels.length) return 'none'
  const n = rowsLabels.filter(ls => ls.includes(labelId)).length
  return n === 0 ? 'none' : n === rowsLabels.length ? 'all' : 'some'
}

/** What a click on a label in the picker does: 'all' takes it off every message, anything else puts it on every one. */
export function pickToggle(state) {
  return state === 'all' ? 'remove' : 'add'
}

/** One label put on ('add') or taken off ('remove') a row's label ids; the same array when nothing changes. */
export function changedLabels(labels, labelId, action) {
  const has = labels.includes(labelId)
  if (action === 'add') return has ? labels : [...labels, labelId]
  return has ? labels.filter(id => id !== labelId) : labels
}

/**
 * A row's label ids as shown while label changes are on their way: the stored ids with every pending change
 * ({ ids: Set, labelId, action }) of this row applied in order. Without a pending change of the row: the stored array
 * itself (a memoized row does not draw again).
 */
export function labelsWithDeltas(labels, id, deltas) {
  let out = Array.isArray(labels) ? labels : []
  for (const d of deltas) if (d.ids.has(id)) out = changedLabels(out, d.labelId, d.action)
  return out
}
