// SPDX-License-Identifier: GPL-3.0-or-later
// Folder role -> icon name of Icon.jsx: the special-use folders get their own icon,
// every other folder (and a missing parent placeholder) the plain folder icon.
const ROLE_ICON = Object.freeze({
  inbox: 'inbox',
  drafts: 'drafts',
  sent: 'sent',
  trash: 'trash',
  junk: 'junk',
  archive: 'archive',
})

export function folderIcon(role) {
  return (role && ROLE_ICON[role]) || 'folder'
}
