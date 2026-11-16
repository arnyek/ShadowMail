// SPDX-License-Identifier: GPL-3.0-or-later
// The manual order in the sidebar, pure (no React, no IPC): which displayed sibling list a folder is in, and the
// new order of a list after one step (the menu, Alt+Up / Alt+Down) or a drop. The writes are folders:reorder and
// accounts:reorder; the main process checks the list again against the same tree (core/imap/folders.js).

/**
 * Per folder of a buildFolderTree tree: its displayed parent (null = the top level) and its sibling list, as the
 * write takes it: the real folders only (a placeholder parent has no row, so it cannot be ordered), in the shown
 * order. -> Map path -> { parentKey, paths }
 */
export function siblingLists(tree) {
  const out = new Map()
  const walk = (list, parentKey) => {
    const entry = { parentKey, paths: list.filter(n => n.selectable).map(n => n.path) }
    for (const n of list) {
      out.set(n.path, entry)
      walk(n.children, n.path)
    }
  }
  walk(tree, null)
  return out
}

/** `list` with `item` one place up (delta -1) or down (+1); null at the edge or when `item` is not in it. */
export function stepped(list, item, delta) {
  const i = list.indexOf(item)
  const j = i + delta
  if (i < 0 || j < 0 || j >= list.length) return null
  const next = [...list]
  next.splice(i, 1)
  next.splice(j, 0, item)
  return next
}

/** `list` with `item` put before (after = false) or after `target`; null when either is missing or nothing moves. */
export function dropped(list, item, target, after) {
  if (item === target || !list.includes(item) || !list.includes(target)) return null
  const next = list.filter(x => x !== item)
  next.splice(next.indexOf(target) + (after ? 1 : 0), 0, item)
  return next.every((x, i) => x === list[i]) ? null : next
}

/** Over an element: does a drop go after it? (the lower half) */
export function dropAfter(e, el) {
  const r = el.getBoundingClientRect()
  return e.clientY > r.top + r.height / 2
}
