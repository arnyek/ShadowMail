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

/**
 * Over a folder row while a folder is dragged: 'before' / 'after' (the top / bottom quarter of a sibling's row: the
 * manual order) or 'into' (the middle half of a sibling's row; all of a row that is not a sibling: a move under it).
 */
export function dropZone(e, el, isSibling) {
  if (!isSibling) return 'into'
  const r = el.getBoundingClientRect()
  const y = e.clientY - r.top
  if (y < r.height / 4) return 'before'
  if (y > (r.height * 3) / 4) return 'after'
  return 'into'
}

/**
 * Can the folder `from` move under `target` (null = the top level) of the same account? The main process refuses the
 * same (FolderActions.move); this is what the tree shows as a drop target. `folders`: the account's rows (path,
 * delimiter); `roles`: Map path -> role (assignRoles). No: a role anywhere in the moved subtree, a folder without a
 * delimiter, itself or a folder under it, its present parent, a placeholder (no row), the Trash or the Junk folder or a
 * folder under them; the top level when it is there already.
 */
export function moveTarget(folders, roles, from, target) {
  return moveTargetReason(folders, roles, from, target) === null
}

/**
 * Why the folder `from` cannot go under `target` (null = the top level), or null when it can (the main process's
 * refusals, FolderActions.move): 'flat' (no hierarchy delimiter, or no such folder), 'role' (a role folder in its
 * subtree), 'top' (already at the top level), 'missing' (no such folder: a placeholder), 'self' (itself or a folder under
 * it), 'parent' (its present parent), 'trash' (the Trash or the Junk folder, or under them).
 */
export function moveTargetReason(folders, roles, from, target) {
  const row = folders.find(f => f.path === from)
  if (!row || !row.delimiter) return 'flat'
  const d = row.delimiter
  const inside = (p, root) => p === root || p.startsWith(root + d)
  for (const p of roles.keys()) if (inside(p, from)) return 'role'
  const cut = from.lastIndexOf(d)
  const parent = cut >= 0 ? from.slice(0, cut) : null
  if (target === null) return parent !== null ? null : 'top'
  if (!folders.some(f => f.path === target)) return 'missing'
  if (inside(target, from)) return 'self'
  if (target === parent) return 'parent'
  for (const [p, role] of roles) if ((role === 'trash' || role === 'junk') && inside(target, p)) return 'trash'
  return null
}

/** A path after its folder or an ancestor of it was renamed / moved from `from` to `to`; null when it is not inside. */
export function followPath(path, from, to, delimiter) {
  if (path === from) return to
  if (delimiter && path.startsWith(from + delimiter)) return to + path.slice(from.length)
  return null
}
