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
 * A folder that may hold a role: INBOX, the server's own SPECIAL-USE flag, or a usual role name (top level or under
 * INBOX). These always show, subscribed or not (a role folder cannot be unsubscribed in the app either).
 */
export function isRoleCandidate(folder) {
  if (folder.path.toUpperCase() === 'INBOX') return true
  if (folder.specialUse && SPECIAL_USE_ROLE[folder.specialUse]) return true
  return nameRole(folder) !== null
}

/**
 * Whether a LIST answer tells the subscriptions at all: imapflow gives true to EVERY folder when it does not know them
 * (no LSUB data, or LSUB refused with NO), and true to INBOX always; so the state is known only when a folder other than
 * INBOX is not true. (An account whose folders are all subscribed looks the same as an unknown state: nothing to decide.)
 */
export function subscriptionsKnown(listed) {
  return listed.some(f => f.path.toUpperCase() !== 'INBOX' && f.subscribed !== true)
}

/**
 * The server folders the app shows and syncs after a LIST: the subscribed ones (`subscribed === true`: imapflow never
 * writes false, it leaves the field out of an unsubscribed folder; with no subscription data it gives true to every folder),
 * the kept ones (kept: Map path -> 1, folders the user had before the upgrade), the role candidates and the folders
 * with a stored or chosen role (roles: Set of paths).
 */
export function shownFolders(listed, { kept = new Map(), roles = new Set() } = {}) {
  return listed.filter(f => f.subscribed === true || kept.get(f.path) === 1 || roles.has(f.path) || isRoleCandidate(f))
}

const depth = f => splitPath(f.path, f.delimiter).length
const nameRank = (f, role) => ROLE_NAMES[role].indexOf(splitPath(f.path, f.delimiter).pop().toLowerCase())

/**
 * The roles of an IMAP account's folders as the sync decides them once per LIST (stored in folders.role):
 *   INBOX by name; then the user's own choice (`manual`, path -> role: the account settings' role picker, it beats
 *   every automatic rule); then the server's own SPECIAL-USE flag (`specialUse` here is ONLY a flag the server sent: imapflow's
 *   guess from the name is not one); then the role each folder had before (`previous`, path -> role: a decided role
 *   stays, it does not move with the message counts); then the usual names. When more than one folder has a usual name
 *   of the same role (a mailbox used by several programs: "Sent" and "Elküldött elemek"), the one with more messages on
 *   the server wins (`counts`, path -> MESSAGES or null), then the shallower path, then the order of ROLE_NAMES (the
 *   English name first), then the path.
 * Without `counts`, a contested role is left out and its candidates are in `needCounts` (the sync asks the server for
 * their STATUS and calls again). -> { roles: Map path -> role, needCounts: [path] }
 */
export function resolveRoles(folders, { previous = new Map(), counts = null, manual = new Map() } = {}) {
  const roles = new Map()
  const taken = new Set()
  const give = (path, role) => {
    if (!role || taken.has(role) || roles.has(path)) return
    roles.set(path, role)
    taken.add(role)
  }
  const exists = new Set(folders.map(f => f.path))
  for (const f of folders) if (f.path.toUpperCase() === 'INBOX') give(f.path, 'inbox')
  for (const [path, role] of manual) if (role !== 'inbox' && exists.has(path)) give(path, role)
  for (const f of folders) give(f.path, SPECIAL_USE_ROLE[f.specialUse])
  for (const [path, role] of previous) if (role !== 'inbox' && exists.has(path)) give(path, role)
  const needCounts = []
  for (const role of ROLE_ORDER) {
    if (taken.has(role)) continue
    const candidates = folders.filter(f => !roles.has(f.path) && nameRole(f) === role)
    if (candidates.length > 1 && !counts) {
      needCounts.push(...candidates.map(f => f.path))
      continue
    }
    const messages = f => counts?.get(f.path) ?? -1
    candidates.sort((a, b) => messages(b) - messages(a) || depth(a) - depth(b) || nameRank(a, role) - nameRank(b, role) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    if (candidates.length) give(candidates[0].path, role)
  }
  return { roles, needCounts }
}

/**
 * Role of every folder: { path -> role }.
 * An IMAP account the sync has listed: the stored roles (the `role` column, resolveRoles), INBOX by name; a role no
 * stored folder has goes by the usual name to a folder without a stored role, if it is the only such candidate (one
 * created or renamed in the app since the last full sync: it gets its role at once, and the next sync agrees); two
 * candidates wait for the sync, which has the message counts.
 * Otherwise (POP3's local folders, an account before its first full sync): INBOX by name, then SPECIAL-USE, then the
 * usual names; one folder per role; a SPECIAL-USE flag beats a name match.
 */
export function assignRoles(folders) {
  if (folders.some(f => f.role)) {
    const roles = new Map()
    const taken = new Set()
    for (const f of folders) if (f.path.toUpperCase() === 'INBOX') roles.set(f.path, 'inbox')
    for (const f of folders) {
      if (!f.role || f.role === 'inbox' || taken.has(f.role) || roles.has(f.path)) continue
      roles.set(f.path, f.role)
      taken.add(f.role)
    }
    // only an unambiguous name: two candidates of one role need the message counts, which only the sync has
    const byName = new Map()
    for (const f of folders) {
      const role = f.role ? null : nameRole(f)
      if (role && !taken.has(role) && !roles.has(f.path)) byName.set(role, [...(byName.get(role) || []), f.path])
    }
    for (const [role, paths] of byName) {
      if (paths.length !== 1) continue
      roles.set(paths[0], role)
      taken.add(role)
    }
    return roles
  }
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

// Archiving by year (the account's archive_mode): the Archive role folder's direct children named by a 4-digit year
// ("Archívum/2024", with the server's delimiter) are the year folders. 'single' = everything into the Archive itself,
// 'yearly' = into the year of the message; none set = yearly when the Archive already has a year folder, else single.
export const ARCHIVE_MODES = Object.freeze(['single', 'yearly'])
const YEAR_RE = /^\d{4}$/

/** The year folders under the Archive: Map year (number) -> path. Empty for a folder without a delimiter (flat server). */
export function yearFolders(folders, archivePath) {
  const archive = folders.find(f => f.path === archivePath)
  const years = new Map()
  if (!archive || !archive.delimiter) return years
  const prefix = archivePath + archive.delimiter
  for (const f of folders) {
    if (!f.path.startsWith(prefix)) continue
    const rest = f.path.slice(prefix.length)
    if (YEAR_RE.test(rest)) years.set(Number(rest), f.path)
  }
  return years
}

/** The mode in effect: the account's setting, or by the Archive's year folders; never yearly on a flat server. */
export function archiveModeOf(setting, folders, archivePath) {
  const archive = folders.find(f => f.path === archivePath)
  if (!archive || !archive.delimiter) return 'single'
  if (ARCHIVE_MODES.includes(setting)) return setting
  return yearFolders(folders, archivePath).size ? 'yearly' : 'single'
}

/** Whether a folder is the Archive or inside it (no Archive action there). */
export function inArchive(folders, archivePath, path) {
  if (!archivePath) return false
  if (path === archivePath) return true
  const archive = folders.find(f => f.path === archivePath)
  return Boolean(archive && archive.delimiter && path.startsWith(archivePath + archive.delimiter))
}

/**
 * A message's archive year, in local time (as the user reads the date): its Date header's, else its arrival's, if that
 * year is a plausible one (ARCHIVE_YEAR_MIN .. next year); with neither date, now's. null = no plausible year (a Date
 * header of year 999 or 10000 and no usable arrival): the message goes into the Archive itself, no year folder is made.
 */
export const ARCHIVE_YEAR_MIN = 1970
export function archiveYear(row, now = Date.now()) {
  if (!row.date && !row.idate) return new Date(now).getFullYear()
  const max = new Date(now).getFullYear() + 1
  for (const at of [row.date, row.idate]) {
    if (!at) continue
    const year = new Date(at).getFullYear()
    if (Number.isInteger(year) && year >= ARCHIVE_YEAR_MIN && year <= max) return year
  }
  return null
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
