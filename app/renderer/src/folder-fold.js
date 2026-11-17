// SPDX-License-Identifier: GPL-3.0-or-later
// Folding a folder's subfolders away in the sidebar. Pure: the tree comes from core/imap/folders.js (buildFolderTree +
// flattenTree), the folded set is the stored list of foldKey()s. A folded folder hides its whole subtree, and its
// unread count is its own plus every hidden descendant's, so new mail under it does not drop out of sight.

/** The stored key of a folded folder: per account, by its server path. */
export const foldKey = (accountId, path) => `${accountId}:${path}`

/** The stored list back as a set; a damaged value (not a list, odd members) is an empty fold, never an error. */
export function foldedSet(value) {
  return new Set(Array.isArray(value) ? value.filter(x => typeof x === 'string') : [])
}

// the hidden subtree's unread, and whether the selected folder is in it
const hiddenPart = (node, selectedPath) => {
  let unread = 0
  let selected = false
  const stack = [...node.children]
  while (stack.length) {
    const c = stack.pop()
    unread += c.unread || 0
    if (c.path === selectedPath) selected = true
    stack.push(...c.children)
  }
  return { unread, selected }
}

/**
 * The rows the tree shows: flattenTree's items without the subtrees of the folded folders.
 * @param items     [{ node, depth }] in tree order (flattenTree)
 * @param isFolded  path -> whether the folder is folded (only asked for a folder with children)
 * @param selectedPath  the selected folder of this account, or null
 * @returns [{ node, depth, hasChildren, folded, unread, hiddenUnread, hidesSelected }]: `unread` is what the row shows
 *          (its own, plus the hidden ones when folded), `hiddenUnread` the descendants' part of it, `hidesSelected`
 *          the selected folder is folded away under this one
 */
export function visibleFolders(items, isFolded, selectedPath = null) {
  const out = []
  let hideBelow = -1 // while > -1: the rows deeper than this depth are inside a folded folder
  for (const { node, depth } of items) {
    if (hideBelow > -1) {
      if (depth > hideBelow) continue
      hideBelow = -1
    }
    const hasChildren = node.children.length > 0
    const folded = hasChildren && Boolean(isFolded(node.path))
    const hidden = folded ? hiddenPart(node, selectedPath) : { unread: 0, selected: false }
    out.push({ node, depth, hasChildren, folded, unread: (node.unread || 0) + hidden.unread, hiddenUnread: hidden.unread, hidesSelected: hidden.selected })
    if (folded) hideBelow = depth
  }
  return out
}
