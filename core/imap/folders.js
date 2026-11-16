// SPDX-License-Identifier: GPL-3.0-or-later
// Folder roles and the folder tree for the UI. Pure functions, no Node imports: the renderer
// uses them too. Role order: Inbox, Drafts, Sent, Trash, Junk, Archive, then the rest.
// The Hungarian names live in app/renderer/i18n/hu.js (folderRoles).

export const ROLE_ORDER = Object.freeze(['inbox', 'drafts', 'sent', 'trash', 'junk', 'archive'])

const SPECIAL_USE_ROLE = {
  '\\Inbox': 'inbox',
  '\\Drafts': 'drafts',
  '\\Sent': 'sent',
  '\\Trash': 'trash',
  '\\Junk': 'junk',
  '\\Archive': 'archive',
}

// Many servers (cPanel/Courier, older Dovecot) do not announce SPECIAL-USE: the usual names, matched
// on the last path segment of a top-level folder or a direct child of INBOX.
const ROLE_NAMES = {
  drafts: ['drafts', 'draft', 'piszkozatok', 'piszkozat', 'vázlatok'],
  sent: ['sent', 'sent items', 'sent messages', 'sent mail', 'elküldött', 'elküldött elemek', 'elküldött üzenetek', 'elküldött levelek'],
  trash: ['trash', 'deleted items', 'deleted messages', 'törölt elemek', 'törölt üzenetek', 'kuka'],
  junk: ['junk', 'junk e-mail', 'junk email', 'spam', 'levélszemét'],
  archive: ['archive', 'archives', 'archívum', 'archiválás'],
}
const NAME_ROLE = new Map(Object.entries(ROLE_NAMES).flatMap(([role, names]) => names.map(n => [n, role])))

export function splitPath(path, delimiter) {
  return delimiter ? path.split(delimiter) : [path]
}

function nameRole(folder) {
  const parts = splitPath(folder.path, folder.delimiter)
  const topLevel = parts.length === 1 || (parts.length === 2 && parts[0].toUpperCase() === 'INBOX')
  if (!topLevel) return null
  return NAME_ROLE.get(parts[parts.length - 1].toLowerCase()) || null
}

/**
 * Role of every folder: { path -> role }. INBOX by name, then SPECIAL-USE, then the usual names.
 * One folder per role; a SPECIAL-USE flag beats a name match.
 */
export function assignRoles(folders) {
  const roles = new Map()
  const taken = new Set()
  const give = (f, role) => {
    if (!role || taken.has(role) || roles.has(f.path)) return
    roles.set(f.path, role)
    taken.add(role)
  }
  for (const f of folders) if (f.path.toUpperCase() === 'INBOX') give(f, 'inbox')
  for (const f of folders) give(f, SPECIAL_USE_ROLE[f.special_use ?? f.specialUse])
  for (const f of folders) give(f, nameRole(f))
  return roles
}

const collator = typeof Intl !== 'undefined' ? new Intl.Collator('hu', { sensitivity: 'base', numeric: true }) : null
const byName = (a, b) => (collator ? collator.compare(a.name, b.name) : a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

/**
 * The folder tree: role folders first, at the top level, in ROLE_ORDER (even when they live under
 * INBOX on the server); the rest nested by the delimiter, alphabetically. A missing parent (not
 * selectable, or not synced) becomes a placeholder node with selectable = false.
 * A manual order (the rows' sort_order, set by MailIndex.reorderFolders) applies per sibling list: when any
 * member of a list has one, the ordered members come first by it, the rest (new folders, placeholders) after
 * them, alphabetically. A list without any manual order keeps the rule above.
 * Input rows: { path, delimiter, special_use, count, unread, sort_order? } (MailIndex.folders()).
 * Node: { path, name, role, selectable, count, unread, children }.
 */
export function buildFolderTree(folders) {
  const roles = assignRoles(folders)
  const manual = new Map()
  for (const f of folders) if (Number.isInteger(f.sort_order)) manual.set(f.path, f.sort_order)
  // the manual order of one sibling list, or the default rule when no member has one
  const arrange = (list, byDefault) => {
    if (!list.some(n => manual.has(n.path))) return byDefault(list)
    const ordered = list.filter(n => manual.has(n.path)).sort((a, b) => manual.get(a.path) - manual.get(b.path) || byName(a, b))
    const rest = list.filter(n => !manual.has(n.path)).sort(byName)
    return [...ordered, ...rest]
  }
  const node = (f, name) => ({
    path: f.path,
    name,
    role: roles.get(f.path) || null,
    selectable: true,
    count: f.count || 0,
    unread: f.unread || 0,
    children: [],
  })
  const top = []
  const byPath = new Map()
  const roleNodes = []
  for (const f of folders) {
    if (roles.has(f.path)) {
      const n = node(f, splitPath(f.path, f.delimiter).pop())
      byPath.set(f.path, n)
      roleNodes.push(n)
    }
  }
  // INBOX keeps its own children (e.g. INBOX.Projects) unless they have a role
  const sorted = [...folders].filter(f => !roles.has(f.path)).sort((a, b) => a.path.length - b.path.length)
  for (const f of sorted) {
    const parts = splitPath(f.path, f.delimiter)
    let parentList = top
    for (let i = 1; i < parts.length; i++) {
      const parentPath = parts.slice(0, i).join(f.delimiter)
      let parent = byPath.get(parentPath)
      if (!parent) {
        parent = { path: parentPath, name: parts[i - 1], role: null, selectable: false, count: 0, unread: 0, children: [] }
        byPath.set(parentPath, parent)
        parentList.push(parent)
      }
      parentList = parent.children
    }
    const existing = byPath.get(f.path)
    if (existing) {
      // a placeholder created for a child that came first: it is a real folder after all
      Object.assign(existing, node(f, parts[parts.length - 1]), { children: existing.children })
    } else {
      const n = node(f, parts[parts.length - 1])
      byPath.set(f.path, n)
      parentList.push(n)
    }
  }
  const sortDeep = list => {
    const sorted = arrange(list, l => l.sort(byName))
    for (const n of sorted) n.children = sortDeep(n.children)
    return sorted
  }
  for (const n of [...roleNodes, ...top]) n.children = sortDeep(n.children)
  return arrange([...roleNodes, ...top], () => {
    roleNodes.sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role))
    return [...roleNodes, ...top.sort(byName)]
  })
}

/**
 * The displayed sibling list under parentKey (null = the top level, else the parent's path) in a tree of
 * buildFolderTree, or null when no node has that path.
 */
export function siblingsOf(tree, parentKey) {
  if (parentKey === null) return tree
  const stack = [...tree]
  while (stack.length) {
    const n = stack.pop()
    if (n.path === parentKey) return n.children
    stack.push(...n.children)
  }
  return null
}

/** Depth-first flattening for rendering: [{ node, depth }]. */
export function flattenTree(tree, depth = 0, out = []) {
  for (const node of tree) {
    out.push({ node, depth })
    flattenTree(node.children, depth + 1, out)
  }
  return out
}
