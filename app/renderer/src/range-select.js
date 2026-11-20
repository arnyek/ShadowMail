// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * A Shift selection over the list's ids (the folder's every id in the list's order), from the anchor to the target:
 * - 'set' (Shift on a row's checkbox, the usual webmail way): every id of the range takes the state the target turns to
 *   (the target selected -> the range leaves the selection; not selected -> it joins); the rest stays;
 * - 'replace' (Shift+click on a row): the range is the selection;
 * - 'add' (Ctrl+Shift+click on a row): the range joins the selection.
 * Returns a new Set, or null when the anchor or the target is not among the ids (the caller then does a single step).
 */
export function rangeSelect(prev, ids, anchor, target, mode) {
  const a = ids.indexOf(anchor)
  const b = ids.indexOf(target)
  if (a < 0 || b < 0) return null
  const range = ids.slice(Math.min(a, b), Math.max(a, b) + 1)
  if (mode === 'replace') return new Set(range)
  const next = new Set(prev)
  const on = mode === 'add' || !prev.has(target)
  for (const id of range) {
    if (on) next.add(id)
    else next.delete(id)
  }
  return next
}
