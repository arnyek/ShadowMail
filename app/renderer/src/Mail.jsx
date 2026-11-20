// SPDX-License-Identifier: GPL-3.0-or-later
// Mail view: account and folder tree on the left, the message list in the middle (virtual
// scrolling: only the visible rows are in the DOM, pages of PAGE rows come from the main process
// on demand), the reader pane under it, and the sync status line at the bottom.
// The search in the header with filter chips, the list header (select all,
// refresh, more; the icon actions while something is selected; the visible range), one-line rows
// with a preview, the row star and the hover actions.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { t, locale } from '../i18n/index.js'
import { buildFolderTree, flattenTree, assignRoles, inArchive } from '../../../core/imap/folders.js'
import { Reader } from './Reader.jsx'
import { SearchBox, SearchChips, SearchResults, EMPTY_FILTERS, clearedFilters, fromConditions, leftSearch, listFilterOn, searchActive, toListFilter, toRequest } from './Search.jsx'
import { Icon } from './Icon.jsx'
import { Banner, Button, Checkbox, IconButton, Menu, MenuButton, Modal, Splitter } from './ui/index.js'
import { folderIcon } from './folder-icons.js'
import { dropAfter, dropped, dropZone, followPath, moveTarget, moveTargetReason, siblingLists, stepped } from './folder-order.js'
import { foldKey, foldedSet, movedFolded, visibleFolders } from './folder-fold.js'
import { getPref, setPref } from './prefs.js'
import { formatRange, previewLine } from './list-format.js'
import { RowText } from './RowText.jsx'
import { RECIPIENT_ROLES } from '../../../core/mime/recipient-label.js'
import { SubscriptionsDialog } from './Subscriptions.jsx'
import { MoveFolderDialog } from './MoveFolderDialog.jsx'
import { neighbor, afterRemoval, archiveFor, readerKeyOf } from './reader-nav.js'
import { ScheduledList, useScheduledRows } from './Scheduled.jsx'
import { LabelPicker, nextLabelColor } from './LabelPicker.jsx'
import { labelsWithDeltas } from './label-chips.js'
import { rangeSelect } from './range-select.js'

// a stored label change the list has not shown yet is dropped after this at the latest
const DELTA_TIMEOUT_MS = 5000

const api = window.shadowMail
export const ROW_HEIGHT = 40 // the default --row-h of theme.css (a density may change it: useRowHeight)

/** The list row's height from the --row-h token, read again when the density (<html data-density>) changes. */
function rowHeightNow() {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--row-h'))
  return Number.isFinite(v) && v > 0 ? v : ROW_HEIGHT
}
function useRowHeight() {
  const [h, setH] = useState(rowHeightNow)
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return undefined // jsdom without it: the height stays
    const mo = new MutationObserver(() => setH(rowHeightNow()))
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-density', 'data-theme'] })
    return () => mo.disconnect()
  }, [])
  return h
}
const PAGE = 200
const OVERSCAN = 15
const DEFAULT_DIR = { date: 'desc', from: 'asc', subject: 'asc' }
// since 0.10.1 the messages opened or acted on in a filtered view stay listed until the filter, the
// folder or the order changes, or Refresh; at most this many (the oldest goes)
const MAX_KEEP = 500

/** A Sent or Drafts folder (by role, the hand-picked one too): its list shows the recipient in the sender's place. */
export const isRecipientFolder = (folders, folder) => Boolean(folders && folder) && RECIPIENT_ROLES.has(assignRoles(folders).get(folder))

/**
 * The order's menu items: the list's More menu and the folder view's Rendezés chip (one state). In a recipient folder
 * the "from" item says recipient: the main process sorts that folder's "from" by the recipient (ipc/mail.js listSortFor).
 */
function sortMenuItems(sort, dir, onSort, recipientView = false) {
  const label = col => t.sortMenu[col === 'from' && recipientView ? 'recipient' : col]
  return [
    ...['date', 'from', 'subject'].map(col => ({ key: col, label: label(col), checked: sort === col, onSelect: () => onSort(col) })),
    { separator: true },
    { key: 'reverse', label: t.sortMenu.reverse, checked: dir !== DEFAULT_DIR[sort], onSelect: () => onSort(sort, true) },
  ]
}

const timeFmt = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' })

const hasFlag = (flags, flag) => (flags || '').split(' ').includes(flag)

// the change an action makes to the flags, shown at once (the main process confirms or it is dropped)
const FLAG_CHANGE = {
  read: { add: ['\\Seen'], remove: [] },
  unread: { add: [], remove: ['\\Seen'] },
  star: { add: ['\\Flagged'], remove: [] },
  unstar: { add: [], remove: ['\\Flagged'] },
}
function changedFlags(flags, change) {
  const set = new Set((flags || '').split(' ').filter(Boolean))
  for (const f of change.add) set.add(f)
  for (const f of change.remove) set.delete(f)
  return [...set].join(' ')
}
const DRAG_TYPE = 'application/x-shadowmail-ids'
// the manual order's own drags: never a message move, never a hierarchy change
const FOLDER_DRAG_TYPE = 'application/x-shadowmail-folder'
const ACCOUNT_DRAG_TYPE = 'application/x-shadowmail-account'

function roleFolder(folders, wanted) {
  for (const [p, role] of assignRoles(folders)) if (role === wanted) return p
  return null
}

/** The Trash of an account's folder list, or null. */
export function trashOf(folders) {
  return roleFolder(folders, 'trash')
}

/** The Archive of an account's folder list (by SPECIAL-USE or name), or null. */
export function archiveOf(folders) {
  return roleFolder(folders, 'archive')
}

const stop = e => e.stopPropagation()

function folderLabel(node) {
  return node.role ? t.folderRoles[node.role] : node.name
}

/**
 * The accounts and their folders: an account head that folds its folders away, the
 * "+" (new top-level folder), and per folder its role icon, name and unread count. Folded to icons
 * (`collapsed`), the names stay in the DOM for the accessible name and show as tooltips.
 *
 * The manual order: an account head is dragged among the account heads, a folder among its own displayed siblings
 * (a line marks the place; another parent shows no line and takes no drop: the hierarchy never changes), each with
 * its own drag type, so a folder dropped on a folder moves no message and a message drag is as before. Alt+Up /
 * Alt+Down on a folder or an account head steps it. onReorderFolders({ accountId, parentKey, paths, focus }),
 * onReorderAccounts(ids, focusId); the menus get the folder's / account's list to know their edges.
 */
export function FolderTree({ accounts, selected, onSelect, onDropMessages, onFolderMenu, onNewFolder, onAccountMenu = () => {}, onReorderFolders = () => {}, onReorderAccounts = () => {}, onMoveFolder = () => {}, movedFolder = null, collapsed = false }) {
  // the drag in progress (dragover cannot read the data, only its types): { kind: 'folder', accountId, path, label }
  // or { kind: 'account', id }; the mark: a line { key, after } (the manual order) or { key, into: true } (a move
  // under that folder, or to the top level on the account head)
  const dragRef = useRef(null)
  const [mark, setMark] = useState(null)
  const accountIds = accounts.map(a => a.id)
  const endDrag = () => {
    dragRef.current = null
    setMark(null)
  }
  // the line shows only while the dragover under the pointer is accepted: a target accepts in its own handler
  // (preventDefault), before the event reaches the document; anything else (an account head for a folder, the sidebar's
  // background, a message row) clears it
  const markRef = useRef(null)
  markRef.current = mark
  useEffect(() => {
    const over = e => {
      if (dragRef.current && markRef.current && !e.defaultPrevented) setMark(null)
    }
    document.addEventListener('dragover', over)
    return () => document.removeEventListener('dragover', over)
  }, [])
  // a damaged stored value (not a list) must not take the mail view down
  const [folded, setFolded] = useState(() => {
    const v = getPref('foldedAccounts', [])
    return new Set(Array.isArray(v) ? v.filter(x => typeof x === 'number' || typeof x === 'string') : [])
  })
  const toggleAccount = id =>
    setFolded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      setPref('foldedAccounts', [...next])
      return next
    })
  // folded folders (their subfolders hidden): foldKey(account, path) strings, kept like the folded accounts
  const [foldedFolders, setFoldedFolders] = useState(() => foldedSet(getPref('foldedFolders', [])))
  const toggleFolder = key =>
    setFoldedFolders(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      setPref('foldedFolders', [...next])
      return next
    })
  // a folder moved or renamed (the caller's movedFolder, one per change): the folded keys of its subtree follow it, and
  // the new parent opens so the moved folder shows
  const movedSeq = movedFolder ? movedFolder.seq : null
  useEffect(() => {
    if (!movedFolder) return
    const { accountId, from, to, delimiter, expand } = movedFolder
    setFoldedFolders(prev => {
      const next = movedFolded(prev, accountId, from, to, delimiter, expand)
      if (next !== prev) setPref('foldedFolders', [...next])
      return next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [movedSeq])
  if (!accounts.length) return <p className="hint pad">{t.noMailAccounts}</p>
  return (
    <nav className={`folder-tree${collapsed ? ' collapsed' : ''}`} aria-label={t.foldersHeading}>
      {accounts.map(a => {
        const tree = buildFolderTree(a.folders)
        // on a sidebar folded to icons every folder shows (it has no fold toggles)
        const items = visibleFolders(flattenTree(tree), path => !collapsed && foldedFolders.has(foldKey(a.id, path)), selected && selected.accountId === a.id ? selected.folder : null)
        const lists = siblingLists(tree)
        // a dragged folder of this account: may it go under `to` (null = the top level)? the main process refuses the same
        const roles = assignRoles(a.folders)
        const canMove = (from, to) => moveTarget(a.folders, roles, from, to)
        const subfolders = p => {
          const d = a.folders.find(f => f.path === p)?.delimiter
          return d ? a.folders.filter(f => f.path.startsWith(p + d)).length : 0
        }
        const askMove = (d, parent, targetLabel) => onMoveFolder({ accountId: a.id, path: d.path, parent, label: d.label, targetLabel, subfolders: subfolders(d.path), delimiter: a.folders.find(f => f.path === d.path)?.delimiter || null })
        const markClass = k => (mark && mark.key === k ? (mark.into ? ' drop-into' : mark.after ? ' drop-after' : ' drop-before') : '')
        const isFolded = folded.has(a.id) && !collapsed
        const accountKey = `a:${a.id}`
        const stepAccount = delta => {
          const ids = stepped(accountIds, a.id, delta)
          if (ids) onReorderAccounts(ids, a.id)
        }
        return (
          <section key={a.id} className="account" data-account={a.id}>
            <div
              className={`account-head${markClass(accountKey)}`}
              draggable
              onDragStart={e => {
                dragRef.current = { kind: 'account', id: a.id }
                e.dataTransfer.setData(ACCOUNT_DRAG_TYPE, String(a.id))
                e.dataTransfer.effectAllowed = 'move'
              }}
              onDragEnd={endDrag}
              onDragOver={e => {
                const d = dragRef.current
                // a folder of this account onto its head: to the top level
                if (d && d.kind === 'folder') {
                  if (d.accountId !== a.id || !canMove(d.path, null)) return
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                  if (!mark || mark.key !== accountKey || !mark.into) setMark({ key: accountKey, into: true })
                  return
                }
                if (!d || d.kind !== 'account' || d.id === a.id) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                const after = dropAfter(e, e.currentTarget)
                if (!mark || mark.key !== accountKey || mark.after !== after) setMark({ key: accountKey, after })
              }}
              onDrop={e => {
                const d = dragRef.current
                if (d && d.kind === 'folder') {
                  if (d.accountId !== a.id || !canMove(d.path, null) || !e.dataTransfer.types.includes(FOLDER_DRAG_TYPE)) return
                  e.preventDefault()
                  endDrag()
                  askMove(d, null, a.name)
                  return
                }
                if (!d || d.kind !== 'account' || !e.dataTransfer.types.includes(ACCOUNT_DRAG_TYPE)) return
                e.preventDefault()
                const ids = dropped(accountIds, d.id, a.id, dropAfter(e, e.currentTarget))
                endDrag()
                if (ids) onReorderAccounts(ids, d.id)
              }}
              onContextMenu={e => {
                e.preventDefault()
                onAccountMenu({ x: e.clientX, y: e.clientY, accountId: a.id, label: a.name, ids: accountIds, imap: a.type === 'imap' })
              }}
            >
              <h2 className="account-name">
                <button
                  type="button"
                  className="account-toggle"
                  aria-expanded={!isFolded}
                  title={`${a.email}\n${isFolded ? t.accountFoldersShow(a.name) : t.accountFoldersHide(a.name)}`}
                  onClick={() => toggleAccount(a.id)}
                  onKeyDown={e => {
                    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
                    e.preventDefault()
                    stepAccount(e.key === 'ArrowUp' ? -1 : 1)
                  }}
                >
                  <Icon name={isFolded ? 'chevronRight' : 'chevronDown'} />
                  <span className="account-label">{a.name}</span>
                </button>
              </h2>
              <IconButton icon="plus" size="s" className="new-folder" label={t.newFolderTitle(a.name)} onClick={() => onNewFolder(a.id)} />
            </div>
            {!isFolded && !items.length && <p className="hint pad">{t.noFolders}</p>}
            {!isFolded && (
              <ul>
                {items.map(({ node, depth, hasChildren, folded: folderFolded, unread, hiddenUnread, hidesSelected }) => {
                  const isSel = selected && selected.accountId === a.id && selected.folder === node.path
                  const label = folderLabel(node)
                  const depthStyle = { '--depth': collapsed ? 0 : depth }
                  const list = lists.get(node.path)
                  const key = `f:${a.id}:${node.path}`
                  // a folder drag over this folder: only from the same displayed sibling list
                  const sibling = d => d && d.kind === 'folder' && d.accountId === a.id && d.path !== node.path && list.paths.includes(d.path)
                  // folded: the count is its own plus the hidden subfolders' (the badge says so)
                  const badge = unread > 0 && (
                    <span
                      className={`unread-badge${hiddenUnread ? ' with-hidden' : ''}`}
                      aria-label={hiddenUnread ? t.unreadCountFolded(unread) : t.unreadCount(unread)}
                      title={hiddenUnread ? t.unreadCountFolded(unread) : undefined}
                    >
                      {unread}
                    </span>
                  )
                  const foldLabel = folderFolded ? t.folderFoldShow(label) : t.folderFoldHide(label)
                  return (
                    <li key={node.path} className={markClass(key).trim() || undefined}>
                      {hasChildren && !collapsed && (
                        <button
                          type="button"
                          className="folder-fold"
                          style={depthStyle}
                          aria-expanded={!folderFolded}
                          aria-label={foldLabel}
                          title={foldLabel}
                          onClick={() => toggleFolder(foldKey(a.id, node.path))}
                        >
                          <Icon name={folderFolded ? 'chevronRight' : 'chevronDown'} />
                        </button>
                      )}
                      {node.selectable ? (
                        <button
                          type="button"
                          className={`folder${isSel ? ' selected' : ''}${hidesSelected ? ' holds-selected' : ''}${unread ? ' has-unread' : ''}`}
                          style={depthStyle}
                          aria-current={isSel ? 'true' : undefined}
                          title={collapsed ? `${label}${unread ? ` (${t.unreadCount(unread)})` : ''}` : node.path}
                          data-path={node.path}
                          draggable
                          onClick={() => onSelect({ accountId: a.id, folder: node.path })}
                          onContextMenu={e => {
                            e.preventDefault()
                            onFolderMenu({ x: e.clientX, y: e.clientY, accountId: a.id, path: node.path, label, role: node.role, count: node.count, parentKey: list.parentKey, siblings: list.paths, imap: a.type === 'imap', moveBlocked: ['flat', 'role'].find(r => r === moveTargetReason(a.folders, roles, node.path, null)) || null })
                          }}
                          onKeyDown={e => {
                            if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
                            e.preventDefault()
                            const paths = stepped(list.paths, node.path, e.key === 'ArrowUp' ? -1 : 1)
                            if (paths) onReorderFolders({ accountId: a.id, parentKey: list.parentKey, paths, focus: node.path })
                          }}
                          onDragStart={e => {
                            dragRef.current = { kind: 'folder', accountId: a.id, path: node.path, label }
                            e.dataTransfer.setData(FOLDER_DRAG_TYPE, node.path)
                            e.dataTransfer.effectAllowed = 'move'
                          }}
                          onDragEnd={endDrag}
                          onDragOver={e => {
                            const d = dragRef.current
                            if (d && d.kind === 'folder') {
                              // a sibling's top / bottom quarter: the manual order (the line); its middle, or any other
                              // row of the same account: into it, when the move is allowed; anything else takes nothing
                              const zone = d.accountId === a.id ? dropZone(e, e.currentTarget, sibling(d)) : null
                              const ok = zone === 'into' ? canMove(d.path, node.path) : zone !== null && sibling(d)
                              if (!ok) {
                                if (mark) setMark(null)
                                return
                              }
                              e.preventDefault()
                              e.dataTransfer.dropEffect = 'move'
                              if (zone === 'into') {
                                if (!mark || mark.key !== key || !mark.into) setMark({ key, into: true })
                              } else {
                                const after = zone === 'after'
                                if (!mark || mark.key !== key || mark.into || mark.after !== after) setMark({ key, after })
                              }
                              return
                            }
                            // messages: only into another folder of the same account
                            if (selected && selected.accountId === a.id && selected.folder !== node.path && e.dataTransfer.types.includes(DRAG_TYPE)) {
                              e.preventDefault()
                              e.dataTransfer.dropEffect = 'move'
                            }
                          }}
                          onDrop={e => {
                            const d = dragRef.current
                            if (d && d.kind === 'folder') {
                              e.preventDefault()
                              const zone = d.accountId === a.id && e.dataTransfer.types.includes(FOLDER_DRAG_TYPE) ? dropZone(e, e.currentTarget, sibling(d)) : null
                              endDrag()
                              if (zone === 'into') {
                                if (canMove(d.path, node.path)) askMove(d, node.path, label)
                                return
                              }
                              const paths = zone && sibling(d) ? dropped(list.paths, d.path, node.path, zone === 'after') : null
                              if (paths) onReorderFolders({ accountId: a.id, parentKey: list.parentKey, paths, focus: d.path })
                              return
                            }
                            const raw = e.dataTransfer.getData(DRAG_TYPE)
                            if (!raw) return
                            e.preventDefault()
                            onDropMessages(JSON.parse(raw), node.path)
                          }}
                        >
                          <Icon name={folderIcon(node.role)} size="m" />
                          <span className="folder-label">{label}</span>
                          {badge}
                        </button>
                      ) : (
                        <span className={`folder placeholder${hidesSelected ? ' holds-selected' : ''}`} style={depthStyle} title={collapsed ? label : undefined}>
                          <Icon name="folder" size="m" />
                          <span className="folder-label">{label}</span>
                          {badge}
                        </span>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        )
      })}
    </nav>
  )
}

/**
 * One list row, memoized: it re-renders only when its own message, flags, selection,
 * open or hover state changes. The hover actions exist only on the row under the mouse.
 */
const MessageRow = memo(function MessageRow({ m, index, top, flags, labels, labelList, selected, open, leaving, archive, hovered, recipient, h }) {
  const unread = !hasFlag(flags, '\\Seen')
  const flagged = hasFlag(flags, '\\Flagged')
  const preview = previewLine(m.preview)
  return (
    <div
      role="row"
      aria-rowindex={index + 1}
      aria-selected={selected}
      data-id={m.id}
      className={`msg-row${unread ? ' unread' : ''}${selected ? ' selected' : ''}${open ? ' open' : ''}${leaving ? ' leaving' : ''}`}
      style={{ top }}
      draggable
      onMouseEnter={() => h.hover(m.id)}
      onMouseLeave={() => h.hover(id => (id === m.id ? null : id))}
      onDragStart={e => {
        const ids = h.selection.has(m.id) ? [...h.selection] : [m.id]
        e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(ids))
        e.dataTransfer.effectAllowed = 'move'
      }}
      onClick={e => h.click(e, m.id)}
      onContextMenu={e => {
        e.preventDefault()
        const isSel = h.selection.has(m.id)
        const ids = isSel ? [...h.selection] : [m.id]
        if (!isSel) h.onSelection(new Set([m.id]))
        h.onContextMenu({ x: e.clientX, y: e.clientY, ids, flagged })
      }}
    >
      <div role="gridcell" className="col-check" onClick={stop}>
        <Checkbox label={t.selectRow} hideLabel checked={selected} onChange={e => h.toggle(m.id, Boolean(e.nativeEvent && e.nativeEvent.shiftKey))} />
      </div>
      <div role="gridcell" className="col-star" onClick={stop}>
        <IconButton
          icon="star"
          size="s"
          filled={flagged}
          className={`star-toggle${flagged ? ' star-on' : ''}`}
          label={t.starToggle}
          pressed={flagged}
          onClick={() => h.action(flagged ? 'unstar' : 'star', [m.id])}
        />
      </div>
      <RowText m={m} preview={preview} recipient={recipient} labels={labels} labelList={labelList} />
      {hovered && !leaving && (
        // mouse shortcuts of the toolbar's actions: hidden from assistive tech, the toolbar has them
        <div className="row-quick" aria-hidden="true" onClick={stop}>
          {archive && <IconButton tabIndex={-1} icon="archive" size="s" label={t.actions.archive} onClick={() => h.action('archive', [m.id])} />}
          <IconButton tabIndex={-1} icon="trash" size="s" label={t.actions.delete} onClick={() => h.action('delete', [m.id])} />
          <IconButton
            tabIndex={-1}
            icon={unread ? 'markRead' : 'markUnread'}
            size="s"
            label={unread ? t.actions.read : t.actions.unread}
            onClick={() => h.action(unread ? 'read' : 'unread', [m.id])}
          />
        </div>
      )}
    </div>
  )
})

/**
 * The list header: the select-all box with its menu, Refresh (always: a click on a
 * row selects it), "Szűrők törlése" while a filter is on, then without a selection More
 * (the order), with one the icon actions (Archive, Delete, Read/Unread, Move, Star) and the selected
 * count; on the right the visible range ("(szűrve, összesen N)" when filtered).
 */
function ListHeader({ ctx }) {
  const { selection, total, folderTotal, filtered, range, folders, folder, archive, sortItems, onSelectAll, onSelectNone, onSelectSeen, onAction, onLabel, onRefresh, onClearFilters, selectedInfo } = ctx
  const n = selection.size
  const ids = [...selection]
  const all = total > 0 && n === total
  const targets = useMemo(() => {
    const roles = assignRoles(folders)
    return folders
      .filter(f => f.path !== folder)
      .map(f => ({ path: f.path, role: roles.get(f.path) || null }))
  }, [folders, folder])
  const selectItems = [
    { key: 'all', label: t.selectMenuItems.all, onSelect: onSelectAll },
    { key: 'none', label: t.selectMenuItems.none, onSelect: onSelectNone },
    { key: 'read', label: t.selectMenuItems.read, onSelect: () => onSelectSeen(true) },
    { key: 'unread', label: t.selectMenuItems.unread, onSelect: () => onSelectSeen(false) },
  ]
  return (
    <div className="list-header">
      <div className="list-select">
        <Checkbox
          label={t.selectAll}
          hideLabel
          className="select-all"
          checked={all}
          indeterminate={n > 0 && !all}
          onChange={() => (n ? onSelectNone() : onSelectAll())}
        />
        <MenuButton icon="chevronDown" label={t.selectMenu} items={selectItems} className="select-menu" />
      </div>
      {/* Refresh stays: a click on a row selects it too, so a selection is the usual state */}
      <IconButton icon="refresh" className="list-refresh" label={t.refresh} onClick={onRefresh} />
      {filtered && <IconButton icon="filterClear" className="clear-filters" label={t.clearFilters} onClick={onClearFilters} />}
      {n === 0 ? (
        <div className="list-tools" role="toolbar" aria-label={t.listToolsLabel}>
          <MenuButton icon="more" label={t.moreMenu} items={sortItems} />
        </div>
      ) : (
        <div className="action-bar" role="toolbar" aria-label={t.actionsLabel}>
          {archive && <IconButton icon="archive" label={t.actions.archive} onClick={() => onAction('archive', ids)} />}
          <IconButton icon="trash" label={t.actions.delete} onClick={() => onAction('delete', ids)} />
          {selectedInfo.anyUnread ? (
            <IconButton icon="markRead" label={t.actions.read} onClick={() => onAction('read', ids)} />
          ) : (
            <IconButton icon="markUnread" label={t.actions.unread} onClick={() => onAction('unread', ids)} />
          )}
          <MenuButton
            icon="move"
            label={t.actions.move}
            items={targets.map(f => ({ key: f.path, label: f.role ? `${t.folderRoles[f.role]} (${f.path})` : f.path, icon: folderIcon(f.role), onSelect: () => onAction('move', ids, { target: f.path }) }))}
          />
          {selectedInfo.allFlagged ? (
            <IconButton icon="star" filled className="star-on" label={t.actions.unstar} onClick={() => onAction('unstar', ids)} />
          ) : (
            <IconButton icon="star" label={t.actions.star} onClick={() => onAction('star', ids)} />
          )}
          {onLabel && <IconButton icon="tag" className="label-open" label={t.labels.button} onClick={() => onLabel(ids)} />}
          <span className="selection-count">{t.selectedCount(n)}</span>
        </div>
      )}
      <span className="list-count" data-total={total ?? ''} data-folder-total={folderTotal ?? ''} title={total ? t.listCount(total) : undefined}>
        {total === null ? '' : formatRange(range.first, range.last, total) + (filtered && folderTotal !== null ? t.listFiltered(folderTotal) : '')}
      </span>
    </div>
  )
}

/**
 * The virtual list. `version` changes when the main process reports a change in this folder: the
 * visible pages are re-read in place (no jump, no flash), the others when they come into view.
 */
function MessageList({ accountId, folder, folders, version, openId, onOpen, selection, onSelection, overlay, onAction, onContextMenu, sort, dir, onSort, filter, keepRef, onRefresh, onClearFilters, idsRef = null, labelList = null, labelDeltas = [], onLabel = null, onDeltaSettled = () => {} }) {
  const [total, setTotal] = useState(null)
  const [folderTotal, setFolderTotal] = useState(null)
  const [loadError, setLoadError] = useState(null) // a refused list request: said, not an endless "busy"
  const [scrollTop, setScrollTop] = useState(0)
  const [height, setHeight] = useState(0)
  const [, setTick] = useState(0)
  const pages = useRef(new Map()) // page index -> { gen, rows }
  const loading = useRef(new Set())
  const gen = useRef(0)
  const viewport = useRef(null)
  const anchor = useRef(null)
  const archive = useMemo(() => archiveOf(folders), [folders])
  // Sent / Drafts: the recipient in the sender's place, and the "from" order is by recipient (a role change reloads)
  const recipientView = useMemo(() => isRecipientFolder(folders, folder), [folders, folder])
  const [hoverId, setHoverId] = useState(null) // the row under the mouse gets the quick actions

  // the folder view's filter; the list, its count and every id use the same one, with the
  // ids kept in view (read at request time: keeping one does not reset the list)
  const filterKey = JSON.stringify(filter)
  const filtered = filterKey !== '{}'
  const request = () => (filtered ? { filter: keepRef.current.length ? { ...filter, keepIds: keepRef.current } : filter } : {})

  // every id of the folder in the list's order (Shift+click over unloaded pages, Ctrl+A); seen: true/false filters
  // a late answer after a folder (or order, or filter) change is dropped: it would select the old view's ids
  const viewKey = `${accountId}|${folder}|${sort}|${dir}|${filterKey}|${recipientView}`
  const viewKeyRef = useRef(viewKey)
  viewKeyRef.current = viewKey
  const allIds = async (seen = null) => {
    const asked = viewKey
    const askedKeep = keepRef.current // a Refresh (or an action) in between changes the listed set: drop the answer
    const res = await api.mail.ids({ accountId, folder, sort, dir, ...(seen === null ? {} : { seen }), ...request() })
    if (asked !== viewKeyRef.current || askedKeep !== keepRef.current) return null
    return res.ok ? res.ids : []
  }
  // the reader's Up / Down and the next message after a delete or an archive go by this order (the list's own)
  if (idsRef) idsRef.current = () => allIds()

  // the Shift anchor belongs to one view: another folder, order or filter drops it
  useEffect(() => {
    anchor.current = null
  }, [viewKey])

  // a row's checkbox; with Shift (and an anchor in the list) every row from the anchor to this one takes the state this
  // one turns to. Either way this row is the new anchor
  const toggleOne = async (id, shift = false) => {
    if (shift && anchor.current !== null) {
      window.getSelection()?.removeAllRanges()
      const ids = await allIds()
      if (!ids) return
      const next = rangeSelect(selection, ids, anchor.current, id, 'set')
      anchor.current = id
      if (next) return onSelection(next)
    }
    const next = new Set(selection)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    anchor.current = id
    onSelection(next)
  }

  const clickRow = async (e, id) => {
    // Shift: the range from the anchor (the anchor stays); with Ctrl too it joins the selection
    if (e.shiftKey && anchor.current !== null) {
      window.getSelection()?.removeAllRanges()
      const ids = await allIds()
      if (!ids) return
      const next = rangeSelect(selection, ids, anchor.current, id, e.ctrlKey || e.metaKey ? 'add' : 'replace')
      if (next) onSelection(next)
      return
    }
    if (e.ctrlKey || e.metaKey) {
      toggleOne(id)
      return
    }
    // a plain click opens the message and does NOT select it; it is the Shift anchor
    anchor.current = id
    onOpen(id)
  }

  const keyDown = async e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault()
      const ids = await allIds()
      if (ids) onSelection(new Set(ids))
    }
    // Delete: the mail view's key handler (the selection, or the open message)
  }

  const loadPage = useCallback(
    p => {
      const myGen = gen.current
      const key = `${myGen}:${p}`
      if (loading.current.has(key)) return
      loading.current.add(key)
      api.mail.list({ accountId, folder, sort, dir, offset: p * PAGE, limit: PAGE, ...request() }).then(res => {
        loading.current.delete(key)
        if (myGen !== gen.current) return
        if (!res.ok) {
          setLoadError(res.error)
          return
        }
        setLoadError(null)
        pages.current.set(p, { gen: myGen, rows: res.rows })
        setTotal(res.total)
        setFolderTotal(res.folderTotal)
        setTick(t => t + 1)
      })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accountId, folder, sort, dir, filterKey, recipientView],
  )

  // another folder, ordering or filter: start from the top with an empty cache
  useLayoutEffect(() => {
    gen.current++
    pages.current = new Map()
    loading.current = new Set()
    setTotal(null)
    setFolderTotal(null)
    setLoadError(null)
    if (viewport.current) viewport.current.scrollTop = 0
    setScrollTop(0)
  }, [accountId, folder, sort, dir, filterKey, recipientView])

  // something changed on the server: the cached pages are stale (still shown until replaced)
  useEffect(() => {
    if (version) gen.current++
    setTick(t => t + 1)
  }, [version])

  // in a filtered view a change (Refresh, an action, a sync) can drop selected
  // messages from the list (a kept id let go, more than MAX_KEEP acted on): the selection is narrowed
  // to the listed set, so a Delete never takes a message the user no longer sees
  const selectionRef = useRef(selection)
  selectionRef.current = selection
  useEffect(() => {
    if (!version || !filtered || !selectionRef.current.size) return
    allIds().then(ids => {
      if (!ids) return
      const listed = new Set(ids)
      onSelection(prev => {
        const next = new Set([...prev].filter(id => listed.has(id)))
        return next.size === prev.size ? prev : next
      })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version])

  useLayoutEffect(() => {
    const el = viewport.current
    if (!el) return
    const ro = new ResizeObserver(() => setHeight(el.clientHeight))
    ro.observe(el)
    setHeight(el.clientHeight)
    return () => ro.disconnect()
  }, [])

  const rowH = useRowHeight()
  // the open message's row stays in view when the reader steps (Up / Down, the next one after a delete)
  useEffect(() => {
    const el = viewport.current
    if (!el || openId === null) return
    for (const [p, entry] of pages.current) {
      const i = entry.rows.findIndex(r => r.id === openId)
      if (i < 0) continue
      const top = (p * PAGE + i) * rowH
      if (top < el.scrollTop) el.scrollTop = top
      else if (top + rowH > el.scrollTop + el.clientHeight) el.scrollTop = top + rowH - el.clientHeight
      return
    }
  }, [openId, rowH])
  const first = Math.max(0, Math.floor(scrollTop / rowH) - OVERSCAN)
  const count = total ?? 0
  const last = Math.min(count, Math.ceil((scrollTop + height) / rowH) + OVERSCAN)
  const range = {
    first: Math.min(count, Math.floor(scrollTop / rowH) + 1),
    last: Math.min(count, Math.max(1, Math.floor((scrollTop + height) / rowH))),
  }

  // fetch every page the visible window touches that is missing or stale
  useEffect(() => {
    const firstPage = Math.floor(first / PAGE)
    const lastPage = total === null ? 0 : Math.floor(Math.max(first, last - 1) / PAGE)
    for (let p = firstPage; p <= lastPage; p++) {
      const entry = pages.current.get(p)
      if (!entry || entry.gen !== gen.current) loadPage(p)
    }
  })

  const flagsOf = m => {
    const ov = overlay.get(m.id)
    return ov && ov.change ? changedFlags(m.flags, ov.change) : m.flags
  }

  // a stored label change is no longer needed once every loaded row it touches carries it in its own labels (the
  // reloaded page): then it goes, so a later change made elsewhere is not hidden behind it
  useEffect(() => {
    for (const d of labelDeltas) {
      if (!d.stored) continue
      let stale = false
      for (const entry of pages.current.values()) {
        for (const m of entry.rows) {
          if (!d.ids.has(m.id)) continue
          const has = (m.labels || []).includes(d.labelId)
          if (has !== (d.action === 'add')) stale = true
        }
      }
      if (!stale) onDeltaSettled(d)
    }
  })

  // the toolbar's Read/Unread and Star choice: from the loaded rows of the selection
  let anyUnread = false
  let allFlagged = selection.size > 0
  let seenSelected = 0
  for (const entry of pages.current.values()) {
    for (const m of entry.rows) {
      if (!selection.has(m.id)) continue
      seenSelected++
      const f = flagsOf(m)
      if (!hasFlag(f, '\\Seen')) anyUnread = true
      if (!hasFlag(f, '\\Flagged')) allFlagged = false
    }
  }
  if (seenSelected < selection.size) {
    // part of the selection is not loaded (Ctrl+A on a big folder): offer "read" and "star"
    if (!seenSelected) anyUnread = true
    allFlagged = false
  }

  // the handlers the rows call: one stable object (its functions see this render's state), so a
  // memoized row re-renders only when its own data changes, not on every scroll frame
  const h = useRef({}).current
  h.click = clickRow
  h.toggle = toggleOne
  h.action = onAction
  h.selection = selection
  h.onSelection = onSelection
  h.onContextMenu = onContextMenu
  h.hover = setHoverId

  const rows = []
  for (let i = first; i < last; i++) {
    const entry = pages.current.get(Math.floor(i / PAGE))
    const m = entry && entry.rows[i % PAGE]
    const top = i * rowH
    if (!m) {
      rows.push(<div key={`empty-${i}`} role="row" aria-rowindex={i + 1} className="msg-row loading" style={{ top }} />)
      continue
    }
    const ov = overlay.get(m.id)
    rows.push(
      <MessageRow
        key={m.id}
        m={m}
        index={i}
        top={top}
        flags={flagsOf(m)}
        labels={labelsWithDeltas(m.labels, m.id, labelDeltas)}
        labelList={labelList}
        selected={selection.has(m.id)}
        open={openId === m.id}
        leaving={Boolean(ov && ov.leaving)}
        archive={archive && !inArchive(folders, archive, folder) ? archive : null}
        hovered={hoverId === m.id}
        recipient={recipientView}
        h={h}
      />,
    )
  }

  const ctx = {
    selection,
    total,
    folderTotal,
    filtered,
    range,
    folders,
    folder,
    archive: archive && !inArchive(folders, archive, folder) ? archive : null, // no Archive action in the Archive or its years
    sortItems: sortMenuItems(sort, dir, onSort, recipientView),
    onAction,
    onLabel,
    onRefresh,
    onClearFilters,
    selectedInfo: { anyUnread, allFlagged },
    onSelectAll: async () => {
      const ids = await allIds()
      if (ids) onSelection(new Set(ids))
    },
    onSelectNone: () => onSelection(new Set()),
    onSelectSeen: async seen => {
      const ids = await allIds(seen)
      if (ids) onSelection(new Set(ids))
    },
  }

  return (
    <section className="message-list">
      <ListHeader ctx={ctx} />
      <div
        className="msg-viewport"
        role="grid"
        aria-label={folder}
        aria-rowcount={count}
        aria-busy={total === null && !loadError}
        ref={viewport}
        tabIndex={0}
        onKeyDown={keyDown}
        // Shift+mousedown on a row would extend the browser's text selection over the rows: a Shift click selects rows
        onMouseDown={e => {
          if (e.shiftKey && e.target.closest && e.target.closest('.msg-row')) e.preventDefault()
        }}
        onScroll={e => setScrollTop(e.currentTarget.scrollTop)}
      >
        <div className="msg-canvas" style={{ height: count * rowH }}>
          {rows}
        </div>
        {loadError && (
          <p className="error pad" role="alert">
            {t.listLoadError(loadError)}
          </p>
        )}
        {total === 0 && !filtered && <p className="hint pad">{t.listEmpty}</p>}
        {total === 0 && filtered && (
          <div className="list-filtered-empty pad">
            <p className="hint">{t.listFilteredEmpty}</p>
            <Button variant="outlined" icon="filterClear" onClick={onClearFilters}>{t.clearFilters}</Button>
          </div>
        )}
      </div>
    </section>
  )
}

/** The row's context menu (the shared Menu, keyboard included). */
function ContextMenu({ menu, onAction, onLabel = null, onClose }) {
  const items = [
    { key: 'read', label: t.actions.read, icon: 'markRead', onSelect: () => onAction('read', menu.ids) },
    { key: 'unread', label: t.actions.unread, icon: 'markUnread', onSelect: () => onAction('unread', menu.ids) },
    menu.flagged
      ? { key: 'unstar', label: t.actions.unstar, icon: 'star', onSelect: () => onAction('unstar', menu.ids) }
      : { key: 'star', label: t.actions.star, icon: 'star', onSelect: () => onAction('star', menu.ids) },
    ...(onLabel ? [{ key: 'labels', label: t.labels.menuItem, icon: 'tag', onSelect: () => onLabel(menu.ids) }] : []),
    { separator: true },
    { key: 'delete', label: t.actions.delete, icon: 'trash', danger: true, onSelect: () => onAction('delete', menu.ids) },
  ]
  return <Menu items={items} at={{ x: menu.x, y: menu.y }} className="context-menu" label={t.actionsLabel} onClose={onClose} />
}

/** The folder's context menu (the shared Menu). Role folders: no rename, no delete. Up / Down: off at the list's edge. */
export function FolderMenu({ menu, onPick, onClose }) {
  const locked = Boolean(menu.role)
  const items = [
    { key: 'create', label: t.folderMenu.newSub, icon: 'plus', onSelect: () => onPick('create', menu) },
    { key: 'rename', label: t.folderMenu.rename, icon: 'compose', disabled: locked, title: locked ? t.folderProtected : undefined, onSelect: () => onPick('rename', menu) },
    { key: 'move', label: t.folderMenu.move, icon: 'move', disabled: Boolean(menu.moveBlocked), title: menu.moveBlocked ? t.moveDialog.reasons[menu.moveBlocked] : undefined, onSelect: () => onPick('move', menu) },
    { key: 'moveUp', label: t.folderMenu.moveUp, icon: 'moveUp', disabled: !stepped(menu.siblings, menu.path, -1), onSelect: () => onPick('moveUp', menu) },
    { key: 'moveDown', label: t.folderMenu.moveDown, icon: 'moveDown', disabled: !stepped(menu.siblings, menu.path, 1), onSelect: () => onPick('moveDown', menu) },
    { key: 'delete', label: t.folderMenu.delete, icon: 'trash', danger: true, disabled: locked, title: locked ? t.folderProtected : undefined, onSelect: () => onPick('delete', menu) },
  ]
  // IMAP: unsubscribe (the folder leaves the app, it stays on the server); a role folder always shows
  if (menu.imap) {
    items.splice(items.findIndex(i => i.key === 'delete'), 0, { key: 'unsubscribe', label: t.folderMenu.unsubscribe, icon: 'hide', disabled: locked, title: locked ? t.subscriptions.roleLocked : undefined, onSelect: () => onPick('unsubscribe', menu) })
  }
  // the pick itself closes the menu (pickFolderAction); a closing click elsewhere only closes it
  return <Menu items={items} at={{ x: menu.x, y: menu.y }} className="context-menu" label={menu.label} onClose={reason => reason !== 'select' && onClose()} />
}

/** The account head's context menu: Up / Down among the accounts (off at the edge), the folders back to A-Z. */
export function AccountMenu({ menu, onPick, onClose }) {
  const items = [
    { key: 'moveUp', label: t.accountMenu.moveUp, icon: 'moveUp', disabled: !stepped(menu.ids, menu.accountId, -1), onSelect: () => onPick('moveUp', menu) },
    { key: 'moveDown', label: t.accountMenu.moveDown, icon: 'moveDown', disabled: !stepped(menu.ids, menu.accountId, 1), onSelect: () => onPick('moveDown', menu) },
    { key: 'sortFolders', label: t.accountMenu.sortFolders, icon: 'sortAlpha', onSelect: () => onPick('sortFolders', menu) },
    ...(menu.imap ? [{ key: 'subscriptions', label: t.accountMenu.subscriptions, icon: 'folder', onSelect: () => onPick('subscriptions', menu) }] : []),
  ]
  return <Menu items={items} at={{ x: menu.x, y: menu.y }} className="context-menu account-menu" label={menu.label} onClose={reason => reason !== 'select' && onClose()} />
}

/** The menu's "Move…" dialog of one folder; the chosen target in the shape a drop asks with (Mail's askMoveFolder). */
function MoveDialogFor({ dialog, accounts, onChoose, onCancel }) {
  const account = dialog && accounts.find(a => a.id === dialog.accountId)
  if (!account) return null
  const row = account.folders.find(f => f.path === dialog.path)
  const delimiter = row?.delimiter || null
  const subfolders = delimiter ? account.folders.filter(f => f.path.startsWith(dialog.path + delimiter)).length : 0
  return (
    <MoveFolderDialog
      account={account}
      from={dialog.path}
      label={dialog.label}
      onCancel={onCancel}
      onChoose={c => onChoose({ accountId: account.id, path: dialog.path, parent: c.parent, label: dialog.label, targetLabel: c.parent === null ? account.name : c.label, subfolders, delimiter })}
    />
  )
}

/** In-app name prompt (window.prompt is a native window; it is also not available in Electron): a Modal. */
function NameDialog({ dialog, onOk, onCancel }) {
  const [value, setValue] = useState(dialog.initial || '')
  const input = useRef(null)
  useEffect(() => {
    if (input.current) {
      input.current.focus()
      input.current.select()
    }
  }, [])
  return (
    <Modal
      title={dialog.title}
      onClose={onCancel}
      onSubmit={() => value.trim() && onOk(value)}
      actions={[
        <Button key="cancel" variant="text" onClick={onCancel}>{t.confirmCancel}</Button>,
        <Button key="ok" type="submit" variant="primary" disabled={!value.trim()}>{dialog.okLabel}</Button>,
      ]}
    >
      <label className="field">
        <span>{t.folderNameLabel}</span>
        <input ref={input} type="text" value={value} onChange={e => setValue(e.target.value)} spellCheck={false} maxLength={200} />
      </label>
      {dialog.error && <p className="error" role="alert">{dialog.error}</p>}
    </Modal>
  )
}

/** Delete confirmations (a Modal): Esc = Mégse, Enter = the red button (it has the focus). */
function ConfirmDialog({ confirm, onYes, onNo }) {
  return (
    <Modal
      title={confirm.title || t.confirmDeleteTitle}
      role="alertdialog"
      onClose={onNo}
      actions={[
        <Button key="no" variant="text" onClick={onNo}>{t.confirmCancel}</Button>,
        <Button key="yes" variant={confirm.yesVariant || 'danger'} data-autofocus onClick={onYes}>{confirm.yesLabel || t.confirmDeleteYes}</Button>,
      ]}
    >
      <p className="confirm-text">{confirm.text || (confirm.inTrash ? t.confirmDeleteTrash(confirm.ids.length) : t.confirmDeleteNoTrash(confirm.ids.length))}</p>
      {confirm.note && <p className="hint confirm-note">{confirm.note}</p>}
    </Modal>
  )
}

function statusText(s) {
  if (s.running) {
    if (s.phase === 'metadata') return t.syncPhases.metadata(s.folder, s.progress)
    if (s.phase === 'bodies') return t.syncPhases.bodies(s.progress, s.requeued)
    return t.syncPhases.connecting
  }
  if (s.errorCode) return t.syncError(s.errorCode)
  if (s.idleError && s.lastFinished) return t.syncError(s.idleError) // the IDLE connection dropped, retrying
  return s.lastFinished ? t.syncedAt(timeFmt.format(new Date(s.lastFinished))) : t.syncNever
}

function StatusBar({ accounts }) {
  if (!accounts.length) return <footer className="status-bar" />
  return (
    <footer className="status-bar" role="status" aria-live="polite">
      {accounts.map(s => (
        <span key={s.accountId} className={`sync-status${s.errorCode || s.idleError ? ' error' : ''}`} data-account={s.accountId}>
          <strong>{s.name}</strong>: {statusText(s)}
          {s.live && !s.running && !s.errorCode && <span className="live" title={t.syncLive}> ●</span>}
          {s.stopped && <span className="stopped"> {t.syncStopped}</span>}
        </span>
      ))}
    </footer>
  )
}

export function Mail({ collapsed = false, readerPane = 'none', searchSlot = null, claudeRequest = null, onClaudeTaken = () => {}, onManageLabels = null }) {
  const [accounts, setAccounts] = useState([])
  const [selected, setSelected] = useState(null)
  // the "Időzített" view (every account's scheduled messages) in the list's place; a folder leaves it
  const [scheduledOpen, setScheduledOpen] = useState(false)
  const scheduledRows = useScheduledRows()
  const [status, setStatus] = useState([])
  const [version, setVersion] = useState(0)
  const [openId, setOpenId] = useState(null)
  const [openInfo, setOpenInfo] = useState(null) // the open message's account and folder (from the reader)
  const [flagEvent, setFlagEvent] = useState(null) // the last flag change (or its failure), for the reader's star
  // where the message opens: 'none' (in the list's place), 'right' or 'bottom'; the App holds it (the header's quick
  // switch changes it while the view stays mounted, so the open message, the search and the selection stay)
  const fullReader = readerPane === 'none'
  // the panes the dividers measure; the limits: sidebar 180-480, list (right) >= 280 with the reader >= 360,
  // list (bottom) >= 120 with the reader >= 160; the sidebar leaves the mail area its minimum (both panes when right)
  const bodyRef = useRef(null)
  const asideRef = useRef(null)
  const panesRef = useRef(null)
  const listAreaRef = useRef(null)
  const sidebarMeasure = useCallback(() => asideRef.current?.getBoundingClientRect().width ?? 0, [])
  // the sidebar may take what the panes have over their minimum (measured, so the mail area's own edges count too)
  const sidebarMax = useCallback(
    () => Math.min(480, (asideRef.current?.getBoundingClientRect().width ?? 0) + (panesRef.current?.clientWidth ?? 0) - (readerPane === 'right' ? 280 + 360 : 280)),
    [readerPane],
  )
  const listMeasure = useCallback(() => listAreaRef.current?.getBoundingClientRect().width ?? 0, [])
  const listMax = useCallback(() => (panesRef.current?.clientWidth ?? 0) - 360, [])
  const listhMeasure = useCallback(() => listAreaRef.current?.getBoundingClientRect().height ?? 0, [])
  const listhMax = useCallback(() => (panesRef.current?.clientHeight ?? 0) - 160, [])
  const [searchText, setSearchText] = useState('')
  const [filters, setFilters] = useState(EMPTY_FILTERS)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const searching = searchActive(searchText, filters)
  // since 0.10.1 the chips filter the folder view too; the filter stays on a
  // folder change and the chip row cannot be closed while it is on
  const listFilter = useMemo(() => toListFilter(filters), [filters])
  const listFilterKey = JSON.stringify(listFilter)
  const filterOn = listFilterOn(filters)
  // the list's order, one state for the More menu and the Rendezés chip
  const [listSort, setListSort] = useState({ sort: 'date', dir: 'desc' })
  const onSort = (column, reverse = false) =>
    setListSort(cur => (reverse || column === cur.sort ? { ...cur, dir: cur.dir === 'asc' ? 'desc' : 'asc' } : { sort: column, dir: DEFAULT_DIR[column] }))
  // ids kept in a filtered view (a ref: keeping one must not reload or scroll the list)
  const keepRef = useRef([])
  const filterOnRef = useRef(filterOn)
  filterOnRef.current = filterOn
  const searchingRef = useRef(searching)
  searchingRef.current = searching
  const keep = ids => {
    // only the folder view keeps (a search hit acted on is not the folder's row)
    if (!filterOnRef.current || searchingRef.current) return
    // one action over MAX_KEEP ids keeps its first ones (the top of the list), the selection is then
    // narrowed to what is listed (MessageList, #2)
    const incoming = [...new Set(ids)].slice(0, MAX_KEEP)
    const fresh = new Set(incoming)
    keepRef.current = [...keepRef.current.filter(id => !fresh.has(id)), ...incoming].slice(-MAX_KEEP)
  }
  // message actions
  const [selection, setSelection] = useState(() => new Set())
  const [overlay, setOverlay] = useState(() => new Map()) // id -> { change } | { leaving: true }
  const [menu, setMenu] = useState(null)
  // 0.17.0 labels: the label list, the pending changes (the optimistic view), the last change for the reader and the
  // search hits, and the open picker ({ ids, from: 'list' | 'reader' })
  const [labelList, setLabelList] = useState([])
  const [labelDeltas, setLabelDeltas] = useState([])
  const [labelEvent, setLabelEvent] = useState(null)
  const [picker, setPicker] = useState(null)
  const [confirm, setConfirm] = useState(null)
  const [actionError, setActionError] = useState(null)
  const [actionNotice, setActionNotice] = useState(null)
  // folder management
  const [folderMenu, setFolderMenu] = useState(null)
  const [accountMenu, setAccountMenu] = useState(null)
  const [subsDialog, setSubsDialog] = useState(null) // the subscriptions dialog: { accountId, label }
  const [nameDialog, setNameDialog] = useState(null)
  const [folderError, setFolderError] = useState(null)
  // a folder moved or renamed: the tree's folded keys follow it ({ seq, accountId, from, to, delimiter, expand })
  const [movedFolder, setMovedFolder] = useState(null)
  // the menu's "Move…": the folder whose target is being chosen ({ accountId, path, label })
  const [moveDialog, setMoveDialog] = useState(null)
  const selectedRef = useRef(null)
  selectedRef.current = selected

  // a new folder, filter or order drops the kept ids; a new filter also drops the selection (it could
  // hold messages the filtered list no longer shows: a Delete must take only what is on screen)
  const viewKey = JSON.stringify([selected, listFilterKey, listSort])
  const lastView = useRef(viewKey)
  if (lastView.current !== viewKey) {
    lastView.current = viewKey
    keepRef.current = []
  }
  const lastFilter = useRef(listFilterKey)
  useEffect(() => {
    if (lastFilter.current === listFilterKey) return
    lastFilter.current = listFilterKey
    setSelection(new Set())
  }, [listFilterKey])

  // the folder tree and the account / folder chips open a folder the same way
  const navigate = sel => {
    setSelected(sel)
    setScheduledOpen(false)
    setOpenId(null)
    setSelection(new Set())
  }
  const openMessage = id => {
    keep([id])
    setOpenId(id)
  }
  // Claude's open_message: leave a search, go to the message's account and folder, then open it as a
  // click would (keep it in the list, the reader marks it read). The open waits in pendingOpen until the view is
  // there: leaving the search closes the open message (the searchKey effect below), so it is applied after that one.
  const pendingOpen = useRef(null)
  // Claude's show_search: its conditions replace the search box and the chips (the folder filters
  // too: the hits are what Claude asked for), and the search runs as if the user had typed it. One request at a time, the
  // latest (App: claudeRequest): a pending open_message is dropped by a later search, a search left by a later open.
  useEffect(() => {
    const r = claudeRequest
    if (!r) return
    if (r.type === 'search') {
      pendingOpen.current = null
      setSearchText(r.conditions.text || '')
      setFilters(fromConditions(r.conditions))
      setFiltersOpen(true)
    } else {
      pendingOpen.current = r
      setSearchText('')
      setFilters(leftSearch)
      setFiltersOpen(false)
      setSelected({ accountId: r.accountId, folder: r.folder })
      setScheduledOpen(false)
    }
    setSelection(new Set())
    onClaudeTaken(r)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claudeRequest])
  const refresh = () => {
    keepRef.current = []
    setVersion(v => v + 1)
    api.mail.sync(null)
  }

  const loadFolders = useCallback(async () => {
    const res = await api.mail.folders()
    if (!res.ok) return
    setAccounts(res.accounts)
    // first time: the first account's INBOX (not when Claude's open_message waits to open its own folder: on a freshly
    // mounted view this default came after it and took its place)
    if (!selectedRef.current && !pendingOpen.current) {
      const a = res.accounts.find(x => x.folders.length)
      if (a) {
        const inbox = a.folders.find(f => f.path.toUpperCase() === 'INBOX') || a.folders[0]
        setSelected({ accountId: a.id, folder: inbox.path })
      }
    }
  }, [])

  // a label deleted (Settings / Labels, another window) while it is the filter: the filter goes, not an empty list
  useEffect(() => {
    if (filters.label && !labelList.some(l => l.id === filters.label)) setFilters(f => ({ ...f, label: null }))
  }, [labelList, filters.label])

  const loadLabels = useCallback(() => {
    // a stand-in bridge without labels (older tests) simply has none
    if (api.labels) api.labels.list().then(res => res && res.ok && setLabelList(res.labels))
  }, [])

  useEffect(() => {
    loadFolders()
    loadLabels()
    api.mail.status().then(res => res.ok && setStatus(res.accounts))
    return api.onStatus(payload => {
      if (payload.kind === 'labels') loadLabels()
      if (payload.kind === 'sync') setStatus(payload.accounts)
      if (payload.kind === 'mail' || payload.kind === 'reindex' || payload.kind === 'accounts') {
        loadFolders()
        const sel = selectedRef.current
        if (payload.kind === 'mail' && sel && payload.changes.some(c => c.accountId === sel.accountId && c.folders.includes(sel.folder))) {
          setVersion(v => v + 1)
        }
      }
    })
  }, [loadFolders, loadLabels])

  // a deleted account or a vanished folder: drop the selection
  const exists = useMemo(
    () => selected && accounts.some(a => a.id === selected.accountId && a.folders.some(f => f.path === selected.folder)),
    [accounts, selected],
  )
  const account = exists ? accounts.find(a => a.id === selected.accountId) : null
  // the folder's list is on screen (not the "Időzített" view)
  const folderView = exists && !scheduledOpen
  const openScheduledView = () => {
    // a search would cover the view: it is left as Esc leaves it (the folder filters stay)
    setSearchText('')
    setFilters(leftSearch)
    setFiltersOpen(false)
    setScheduledOpen(true)
    setOpenId(null)
    setSelection(new Set())
  }

  const dropOverlay = ids =>
    setOverlay(prev => {
      const m = new Map(prev)
      for (const id of ids) m.delete(id)
      return m
    })

  /**
   * Puts a label on ('add') or takes it off ('remove') the given messages: shown at once (a pending change), sent in
   * batches of 500 (the IPC's cap; a selection can be a whole folder). A failure takes the change back, shows the
   * error and reloads the list. On an IMAP account the label goes to the server: a folder out of reach changes nothing
   * (the other folders stand; the change is taken back, the reloaded list shows what is stored, the error names the
   * account), and a folder whose server does not allow keywords keeps the label here (a notice). Returns true when
   * every message got the change.
   */
  const runLabel = async (ids, labelId, action) => {
    keep(ids) // a label taken off in the Label-filtered view: the row stays until the view changes
    const delta = { ids: new Set(ids), labelId, action }
    setActionError(null)
    setLabelDeltas(d => [...d, delta])
    const drop = () => setLabelDeltas(d => d.filter(x => x !== delta))
    const failures = new Map() // "<account>:<code>" -> { accountId, error }
    let localOnly = false
    for (let i = 0; i < ids.length; i += 500) {
      const res = await api.mail.label({ ids: ids.slice(i, i + 500), [action]: [labelId] })
      if (!res || !res.ok) {
        drop()
        setLabelEvent({ ids, labelId, action, failed: true, at: Date.now() })
        setActionError(t.labels.error(res && res.error))
        setVersion(v => v + 1)
        return false
      }
      for (const f of res.failed || []) failures.set(`${f.accountId}:${f.error}`, f)
      if ((res.local || []).length) localOnly = true
    }
    if (localOnly) setActionNotice(t.labels.localOnly)
    if (failures.size) {
      const nameOf = id => (accounts.find(a => a.id === id) || {}).name || `#${id}`
      drop()
      setLabelEvent({ ids, labelId, action, failed: true, at: Date.now() })
      setActionError([...failures.values()].map(f => t.labels.serverError(nameOf(f.accountId), f.error)).join(' '))
      setVersion(v => v + 1)
      loadLabels()
      return false
    }
    setLabelEvent({ ids, labelId, action, at: Date.now() })
    // stored now: the list drops it once its reloaded rows show the change (onDeltaSettled); the timeout only guards
    // against a row that never comes back into view
    delta.stored = true
    setLabelDeltas(d => [...d])
    setVersion(v => v + 1)
    loadLabels() // the counts of the list
    setTimeout(drop, DELTA_TIMEOUT_MS)
    return true
  }
  const createLabel = async name => {
    const res = await api.labels.create(name, nextLabelColor(labelList))
    if (res && res.ok) setLabelList(list => [...list, res.label])
    return res && res.ok ? { label: res.label } : { error: res && res.error }
  }
  const openPicker = (ids, from = 'list') => ids.length && setPicker({ ids, from })

  /** Folders: create / rename (after the name dialog) and delete (after the confirmation). */
  const folderOp = async (op, target, name) => {
    setFolderError(null)
    const res =
      op === 'create'
        ? await api.folders.create({ accountId: target.accountId, parent: target.path ?? null, name })
        : op === 'rename'
          ? await api.folders.rename({ accountId: target.accountId, path: target.path, name })
          : await api.folders.remove({ accountId: target.accountId, path: target.path, confirmed: true })
    if (!res.ok) return t.folderError(res.error)
    await loadFolders()
    const sel = selectedRef.current
    if (op === 'rename') followFolder(target.accountId, target.path, res.path, folderDelimiter(target.accountId, target.path), null)
    if (op === 'delete' && sel && sel.accountId === target.accountId && sel.folder === target.path) {
      setSelected(null)
      setOpenId(null)
    }
    if (op === 'create') setSelected({ accountId: target.accountId, folder: res.path })
    return null
  }

  // the manual order (local, the main process checks the list against the same tree); the focus stays on the moved
  // folder / account head (a keyed move takes the DOM node out and back, and the focus with it)
  // the selection (the folder itself or one under it) and the folded keys follow a renamed / moved folder
  const folderDelimiter = (accountId, path) => accounts.find(a => a.id === accountId)?.folders.find(f => f.path === path)?.delimiter || null
  const followFolder = (accountId, from, to, delimiter, expand) => {
    const sel = selectedRef.current
    const next = sel && sel.accountId === accountId ? followPath(sel.folder, from, to, delimiter) : null
    if (next !== null && next !== sel.folder) setSelected({ accountId, folder: next })
    setMovedFolder(m => ({ seq: (m ? m.seq : 0) + 1, accountId, from, to, delimiter, expand }))
  }
  // a dropped folder: the move after the confirmation (always asked)
  const askMoveFolder = m =>
    setConfirm({
      move: m,
      title: t.moveFolderTitle,
      text: t.confirmFolderMove(m.label, m.targetLabel, m.subfolders),
      yesLabel: t.folderMoveYes,
      yesVariant: 'primary',
    })
  const moveFolder = async m => {
    setFolderError(null)
    const res = await api.folders.move({ accountId: m.accountId, path: m.path, parent: m.parent })
    if (!res.ok) return setFolderError(t.folderError(res.error))
    await loadFolders()
    followFolder(m.accountId, m.path, res.path, m.delimiter, m.parent)
    focusFolder(m.accountId, res.path)
  }
  const focusFolder = (accountId, path) =>
    setTimeout(() => document.querySelector(`.folder-tree section[data-account="${accountId}"] .folder[data-path="${CSS.escape(path)}"]`)?.focus(), 0)
  // a menu closed: its deferred focus return must not take the focus from a menu opened in the meantime (a right
  // click right after Esc: the new menu has focused its first item already)
  const noMenuOpen = () => !document.querySelector('[role="menu"]')
  const focusAccount = accountId => setTimeout(() => noMenuOpen() && document.querySelector(`.folder-tree section[data-account="${accountId}"] .account-toggle`)?.focus(), 0)
  const reorderFolders = async ({ accountId, parentKey, paths, focus }) => {
    setFolderError(null)
    const res = await api.folders.reorder({ accountId, parentKey, paths })
    if (!res.ok) return setFolderError(t.folderError(res.error))
    await loadFolders()
    if (focus) focusFolder(accountId, focus)
  }
  const reorderAccounts = async (ids, focusId) => {
    setFolderError(null)
    const res = await api.accounts.reorder(ids)
    if (!res.ok) return setFolderError(t.folderError(res.error))
    await loadFolders()
    if (focusId) focusAccount(focusId)
  }
  const pickAccountAction = async (op, m) => {
    setAccountMenu(null)
    if (op === 'subscriptions') return setSubsDialog({ accountId: m.accountId, label: m.label })
    if (op === 'sortFolders') {
      setFolderError(null)
      const res = await api.folders.resetOrder({ accountId: m.accountId })
      if (!res.ok) setFolderError(t.folderError(res.error))
      else await loadFolders()
      focusAccount(m.accountId)
      return
    }
    const ids = stepped(m.ids, m.accountId, op === 'moveUp' ? -1 : 1)
    if (ids) await reorderAccounts(ids, m.accountId)
  }

  const pickFolderAction = async (op, m) => {
    setFolderMenu(null)
    if (op === 'moveUp' || op === 'moveDown') {
      const paths = stepped(m.siblings, m.path, op === 'moveUp' ? -1 : 1)
      if (paths) await reorderFolders({ accountId: m.accountId, parentKey: m.parentKey, paths, focus: m.path })
      return
    }
    if (op === 'unsubscribe') {
      setFolderError(null)
      const res = await api.folders.setSubscribed({ accountId: m.accountId, path: m.path, subscribed: false })
      if (!res.ok) return setFolderError(t.folderError(res.error))
      await loadFolders()
      // the folder left the tree: like a delete, drop the selection when it was the open one
      const sel = selectedRef.current
      if (sel && sel.accountId === m.accountId && sel.folder === m.path) {
        setSelected(null)
        setOpenId(null)
      }
      return
    }
    if (op === 'move') return setMoveDialog({ accountId: m.accountId, path: m.path, label: m.label })
    if (op === 'create') setNameDialog({ op, target: m, title: t.newSubfolderTitle(m.label), okLabel: t.folderCreate })
    else if (op === 'rename') setNameDialog({ op, target: m, title: t.renameFolderTitle(m.label), okLabel: t.folderRename, initial: m.label })
    else {
      // the count the warning names comes from the main process: IMAP asks the server (STATUS), which may take a
      // while, so the dialog opens at once with the local count as "at least" and takes the server's when it comes;
      // a POP3 account's local folder is the folder (its count is exact and quick)
      const ask = api.folders.deleteCount({ accountId: m.accountId, path: m.path })
      const textOf = res => (res && res.ok ? t.confirmFolderDelete(m.label, res.count, !res.exact) : t.confirmFolderDelete(m.label, m.count || 0, true))
      const base = { folder: m, title: t.deleteFolderTitle, yesLabel: t.folderDelete }
      if (!m.imap) return setConfirm({ ...base, text: textOf(await ask) })
      setConfirm({ ...base, text: t.confirmFolderDelete(m.label, m.count || 0, true), note: t.folderDeleteChecking })
      const res = await ask
      // only the same dialog: it may be closed, or another one opened, by now
      setConfirm(c => (c && c.folder === m ? { ...c, text: textOf(res), note: null } : c))
    }
  }

  /**
   * Runs an action on ids (the selection, the context menu, Del, a drop). The change shows at once;
   * it is dropped again on an error (with a message), or replaced by the refreshed list on success.
   * A final delete (inside the Trash, or an account without one) asks first.
   */
  const runActionRef = useRef(null)
  // ids with an action on the way (until the refreshed list replaces them): a second click (a double
  // click on the row's trash icon) does nothing
  const busyIds = useRef(new Set())
  const runAction = async (action, allIds, { target = null, permanent = false, accountId = null, folder = null } = {}) => {
    // the reader passes the open message's own account and folder (a search hit may be elsewhere)
    const acc = accountId ? accounts.find(a => a.id === accountId) : account
    const inFolder = folder ?? (selected && selected.folder)
    const ids = allIds.filter(id => !busyIds.current.has(id))
    if (!ids.length || !acc) return
    setMenu(null)
    if (action === 'delete' && !permanent) {
      const trash = trashOf(acc.folders)
      if (!trash || trash === inFolder) {
        setConfirm({ ids, inTrash: Boolean(trash), ctx: { accountId: acc.id, folder: inFolder } })
        return
      }
    }
    setActionError(null)
    setActionNotice(null)
    const change = FLAG_CHANGE[action]
    // busy BEFORE any await: a second call in the meantime (a double click on the row's trash, a held Delete) must find
    // these ids taken, or it deletes the message again, now in the Trash, and asks for a final delete
    for (const id of ids) busyIds.current.add(id)
    const release = () => {
      for (const id of ids) busyIds.current.delete(id)
    }
    // the order BEFORE the action (afterwards the row is gone): what opens when the open message leaves
    const openNow = keyState.current.openId
    let after
    try {
      after = !change && openNow !== null && ids.includes(openNow) ? afterRemoval((await orderedIds()) || [], openNow, ids) : undefined
    } catch {
      after = undefined // no order: the open message just closes, as before (the ids must not stay busy)
    }
    keep(ids) // a row changed in a filtered view stays until the view changes
    setOverlay(prev => {
      const m = new Map(prev)
      for (const id of ids) m.set(id, change ? { change } : { leaving: true })
      return m
    })
    const res = await api.mail.action({ ids, action, target: target || undefined, permanent: permanent || undefined })
    if (!res.ok) {
      release()
      dropOverlay(ids)
      if (change) setFlagEvent({ ids, change, failed: true, n: Date.now() })
      // the main process says whether the message is in the Trash (the list may still show the old folder)
      if (res.error === 'confirm_needed') setConfirm({ ids, inTrash: res.inTrash ?? false, ctx: { accountId: acc.id, folder: inFolder } })
      else setActionError(t.actionError(action, res.error))
      return
    }
    // archiving by year: the year folders it had to create (Archívum/2024)
    if (res.created && res.created.length) setActionNotice(t.archiveCreated(res.created))
    if (!change) {
      // only the moved / deleted ones leave the selection (a row's hover action keeps the rest)
      setSelection(prev => new Set([...prev].filter(id => !ids.includes(id))))
      // the one open NOW (a slow delete may outlive a click) gives way to the next one
      setOpenId(cur => (ids.includes(cur) ? (cur === openNow && after ? after : null) : cur))
    }
    // a flag change may be repeated at once (it is idempotent); a moved / deleted row stays busy until
    // the refreshed list no longer has it
    if (change) {
      release()
      setFlagEvent({ ids, change, n: Date.now() }) // the reader follows a star set on the list
    }
    setVersion(v => v + 1)
    loadFolders() // counts in the tree at once, not only with the next status event
    // the refreshed pages replace the overlay; keep it a moment so the old state never flashes back
    setTimeout(() => {
      dropOverlay(ids)
      release()
    }, 400)
  }
  runActionRef.current = runAction

  // a new search (or filter) closes the open message: the hits are what the user asked for now
  const searchKey = JSON.stringify([searchText, filters])
  const lastSearch = useRef(searchKey)
  useEffect(() => {
    if (lastSearch.current !== searchKey) {
      lastSearch.current = searchKey
      setOpenId(null)
    }
  }, [searchKey])
  // Claude's pending open, once the view is the message's folder without a search (after the effect above). "Without a
  // search" is the state the request asked for: an empty box AND the filters already as leftSearch leaves them; a search
  // of a sender only (an empty box) would otherwise open the message here and the search change of the next render would
  // close it
  useEffect(() => {
    const p = pendingOpen.current
    if (!p || searchText !== '' || JSON.stringify(filters) !== JSON.stringify(leftSearch(filters))) return
    if (!selected || selected.accountId !== p.accountId || selected.folder !== p.folder) return
    pendingOpen.current = null
    keep([p.messageId])
    setOpenId(p.messageId)
  })

  const backToList = () => {
    setOpenId(null)
    // back on the list where it was (scroll position and selection are kept, the list was only hidden)
    setTimeout(() => document.querySelector('.msg-viewport, .result-list')?.focus(), 0)
  }

  // keys: Esc / Backspace back to the list (message in the list's place); Delete deletes the
  // selection, or the open message when nothing is selected. Not inside a field or a dialog.
  const keyState = useRef(null)
  // the list's order of the view on screen (the folder list or the search hits), for the reader's steps
  const listIdsRef = useRef(null)
  const searchIdsRef = useRef(null)
  const orderedIds = async () => (keyState.current.searching ? searchIdsRef.current?.() : await listIdsRef.current?.()) || null
  /**
   * The reader keys: up / down open the message above / below the open one in the list's order; delete
   * and archive act on the selection while it is on screen (no search, the list not covered by the message), else on
   * the open message once the reader knows its account and folder. -> true when the key did something (or is ours).
   */
  const readerKeyRef = useRef(null)
  readerKeyRef.current = key => {
    const k = keyState.current
    if (key === 'up' || key === 'down') {
      if (!k.openId) return false
      const cur = k.openId
      orderedIds().then(ids => {
        const next = ids && neighbor(ids, cur, key === 'up' ? -1 : 1)
        if (next !== null && next !== undefined && keyState.current.openId === cur) (k.searching ? setOpenId : openMessage)(next)
      })
      return true
    }
    // End archives only with a message open (the reader keys are the reader's): without one the list keeps its own End
    if (key === 'archive' && !k.openId) return false
    const selectionVisible = k.selection.size > 0 && !k.searching && !(k.fullReader && k.openId)
    let ids = null
    let ctx = {}
    if (selectionVisible) ids = [...k.selection]
    else if (k.openId && k.openInfo && k.openInfo.id === k.openId) {
      ids = [k.openId]
      ctx = { accountId: k.openInfo.accountId, folder: k.openInfo.folder }
    }
    if (!ids) return false
    if (key === 'archive') {
      const acc = accountsRef.current.find(a => a.id === (ctx.accountId ?? k.accountId))
      const where = acc ? archiveFor(acc.folders, ctx.folder ?? k.folder) : { reason: 'no_archive' }
      if (where.reason) {
        setActionError(null)
        setActionNotice(t.readerKeys[where.reason])
        return true
      }
    }
    runActionRef.current(key === 'archive' ? 'archive' : 'delete', ids, ctx)
    return true
  }
  keyState.current = { openId, openInfo, selection, fullReader, searching, accountId: selected && selected.accountId, folder: selected && selected.folder, blocked: Boolean(menu || confirm || nameDialog || folderMenu || accountMenu || subsDialog) }
  const accountsRef = useRef(accounts)
  accountsRef.current = accounts
  useEffect(() => {
    const onKey = e => {
      const k = keyState.current
      const t = e.target
      if (e.defaultPrevented || k.blocked || e.ctrlKey || e.altKey || e.metaKey) return
      // a text field keeps its keys; a checkbox (the row's, after a click on it) does not
      const typing = t && (t.isContentEditable || /^(TEXTAREA|SELECT)$/.test(t.tagName) || (t.tagName === 'INPUT' && !/^(checkbox|radio)$/i.test(t.type)))
      if (typing || (t && t.closest && t.closest('[role="dialog"], [role="alertdialog"], [role="menu"]'))) return
      // a focused divider, tab list or radio group keeps its arrow / Home / End keys
      if (t && t.closest && t.closest('[role="separator"], [role="tablist"], [role="radiogroup"], [role="listbox"]')) return
      if ((e.key === 'Escape' || e.key === 'Backspace') && k.fullReader && k.openId) {
        e.preventDefault()
        backToList()
        return
      }
      const key = readerKeyOf(e)
      if (key && readerKeyRef.current(key)) e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  // the same four keys typed inside the message's frame: the main process sees them first (the frame runs no script)
  useEffect(() => api.onStatus(payload => {
    if (payload.kind !== 'readerKey') return
    const k = keyState.current
    if (k.blocked || document.querySelector('[role="dialog"], [role="alertdialog"]')) return
    readerKeyRef.current(payload.key)
  }), [])

  const searchBox = (
    <SearchBox
      text={searchText}
      onText={setSearchText}
      filtersOpen={filtersOpen}
      filtersLocked={filterOn}
      onFiltersOpen={setFiltersOpen}
      onEscape={() => {
        setSearchText('')
        setFilters(leftSearch) // the folder filters stay
        setFiltersOpen(false)
        setOpenId(null)
      }}
    />
  )

  return (
    <div className="mail">
      {searchSlot ? createPortal(searchBox, searchSlot) : searchBox}
      <div className="mail-body" ref={bodyRef}>
        <aside className={`sidebar${collapsed ? ' collapsed' : ''}`} ref={asideRef}>
          <div className="sidebar-tools">
            <Button variant="tonal" icon="compose" className="compose-button" title={collapsed ? t.newMessage : undefined} onClick={() => api.compose.open()}>
              <span className="compose-label">{t.newMessage}</span>
            </Button>
          </div>
          {(scheduledOpen || (scheduledRows && scheduledRows.length > 0)) && (
            <button
              type="button"
              className={`scheduled-entry${scheduledOpen ? ' selected' : ''}`}
              aria-current={scheduledOpen ? 'page' : undefined}
              title={collapsed ? t.scheduledList.entry(scheduledRows ? scheduledRows.length : 0) : undefined}
              onClick={openScheduledView}
            >
              <Icon name="scheduled" />
              <span className="scheduled-entry-label">{t.scheduledList.entry(scheduledRows ? scheduledRows.length : 0)}</span>
            </button>
          )}
          <FolderTree
            collapsed={collapsed}
            accounts={accounts}
            selected={scheduledOpen ? null : selected}
            onSelect={navigate}
            onDropMessages={(ids, path) => runAction('move', ids, { target: path })}
            onFolderMenu={setFolderMenu}
            onAccountMenu={setAccountMenu}
            onReorderFolders={reorderFolders}
            onReorderAccounts={reorderAccounts}
            onMoveFolder={askMoveFolder}
            movedFolder={movedFolder}
            onNewFolder={accountId =>
              setNameDialog({ op: 'create', target: { accountId, path: null }, title: t.newFolderTitle(accounts.find(a => a.id === accountId)?.name || ''), okLabel: t.folderCreate })
            }
          />
          {folderError && (
            <p className="error pad" role="alert">
              {folderError}
            </p>
          )}
        </aside>
        {/* no divider on a folded sidebar; its saved width stays for the next unfold */}
        {!collapsed && <Splitter name="sidebar" cssVar="--sidebar-w" label={t.splitters.sidebar} min={180} max={sidebarMax} measure={sidebarMeasure} observe={bodyRef} />}
        <div className="mail-main">
          {actionNotice && (
            <Banner kind="info" className="action-notice" onClose={() => setActionNotice(null)} closeLabel={t.close}>
              {actionNotice}
            </Banner>
          )}
          {actionError && (
            <Banner kind="error" className="action-error" onClose={() => setActionError(null)} closeLabel={t.close}>
              {actionError}
            </Banner>
          )}
          <div className={`mail-panes pane-${readerPane}${openId && (folderView || searching) ? ' reading' : ''}`} ref={panesRef}>
          <div className="list-area" ref={listAreaRef}>
          {(searching || filtersOpen || filterOn) && (
            <SearchChips
              accounts={accounts}
              filters={filters}
              onChange={setFilters}
              searching={searching}
              view={folderView ? selected : null}
              onNavigate={navigate}
              listSort={listSort}
              sortItems={sortMenuItems(listSort.sort, listSort.dir, onSort, Boolean(account) && isRecipientFolder(account.folders, selected.folder))}
              labels={labelList}
            />
          )}
          {searching ? (
            <SearchResults request={toRequest(searchText, filters)} accounts={accounts} selectedId={openId} onOpen={setOpenId} idsRef={searchIdsRef} labelList={labelList} labelEvent={labelEvent} />
          ) : scheduledOpen ? (
            <div className="list-pane scheduled-pane">
              <ScheduledList rows={scheduledRows} onNotice={setActionNotice} onError={setActionError} />
            </div>
          ) : exists ? (
            <div className="list-pane">
              <MessageList
                accountId={selected.accountId}
                folder={selected.folder}
                folders={account.folders}
                version={version}
                openId={openId}
                onOpen={openMessage}
                selection={selection}
                onSelection={setSelection}
                overlay={overlay}
                onAction={runAction}
                onContextMenu={setMenu}
                sort={listSort.sort}
                dir={listSort.dir}
                onSort={onSort}
                filter={listFilter}
                keepRef={keepRef}
                idsRef={listIdsRef}
                labelList={labelList}
                labelDeltas={labelDeltas}
                onDeltaSettled={d => setLabelDeltas(ds => (ds.includes(d) ? ds.filter(x => x !== d) : ds))}
                onLabel={openPicker}
                onRefresh={refresh}
                onClearFilters={() => setFilters(f => clearedFilters(f))}
              />
            </div>
          ) : (
            <section className="message-list">
              <p className="hint pad">{accounts.length ? t.chooseFolder : ''}</p>
            </section>
          )}
          </div>
          {/* the list | reader divider (the search results use the same panes), only while a message is shown */}
          {readerPane === 'right' && openId && (folderView || searching) && (
            <Splitter name="list" cssVar="--list-w" label={t.splitters.list} min={280} max={listMax} measure={listMeasure} observe={panesRef} />
          )}
          {readerPane === 'bottom' && openId && (folderView || searching) && (
            <Splitter name="listh" cssVar="--list-h" orientation="horizontal" label={t.splitters.listh} min={120} max={listhMax} measure={listhMeasure} observe={panesRef} />
          )}
          <Reader
            messageId={folderView || searching ? openId : null}
            onOpen={openMessage}
            onBack={fullReader ? backToList : null}
            onAction={runAction}
            onLoaded={m => setOpenInfo(m ? { id: m.id, accountId: m.accountId, folder: m.folder } : null)}
            flagEvent={flagEvent}
            accounts={accounts}
            labelList={labelList}
            labelEvent={labelEvent}
            onLabel={runLabel}
            onLabelPick={id => openPicker([id], 'reader')}
          />
          </div>
        </div>
      </div>
      <StatusBar accounts={status} />
      {menu && (
        <ContextMenu
          menu={menu}
          onAction={runAction}
          onLabel={ids => openPicker(ids)}
          onClose={() => {
            setMenu(null)
            // the focus back on the list (it went into the menu; the rows themselves are not focusable); not when the
            // menu opened the label picker, which has the focus now
            setTimeout(() => !document.querySelector('.label-picker') && noMenuOpen() && document.querySelector('.msg-viewport')?.focus(), 0)
          }}
        />
      )}
      {picker && (
        <LabelPicker
          ids={picker.ids}
          list={labelList}
          onToggle={(labelId, action) => runLabel(picker.ids, labelId, action)}
          onCreate={createLabel}
          onManage={onManageLabels ? () => (setPicker(null), onManageLabels()) : null}
          onClose={() => {
            const from = picker.from
            setPicker(null)
            // from the list: the focus back on the list (the menu that opened it is gone); the reader's own button
            // gets it back by itself (the dialog gives the focus back to what had it)
            if (from === 'list') setTimeout(() => document.querySelector('.msg-viewport')?.focus(), 0)
          }}
        />
      )}
      {folderMenu && (
        <FolderMenu
          menu={folderMenu}
          onPick={pickFolderAction}
          onClose={() => {
            const m = folderMenu
            setFolderMenu(null)
            setTimeout(() => noMenuOpen() && document.querySelector(`.folder-tree section[data-account="${m.accountId}"] .folder[data-path="${CSS.escape(m.path)}"]`)?.focus(), 0)
          }}
        />
      )}
      {subsDialog && (
        <SubscriptionsDialog
          accountId={subsDialog.accountId}
          accountName={subsDialog.label}
          onClose={() => {
            const d = subsDialog
            setSubsDialog(null)
            loadFolders()
            focusAccount(d.accountId)
          }}
        />
      )}
      {accountMenu && (
        <AccountMenu
          menu={accountMenu}
          onPick={pickAccountAction}
          onClose={() => {
            const m = accountMenu
            setAccountMenu(null)
            focusAccount(m.accountId)
          }}
        />
      )}
      {moveDialog && (
        <MoveDialogFor
          dialog={moveDialog}
          accounts={accounts}
          onCancel={() => {
            const d = moveDialog
            setMoveDialog(null)
            focusFolder(d.accountId, d.path)
          }}
          onChoose={m => {
            setMoveDialog(null)
            askMoveFolder(m)
          }}
        />
      )}
      {nameDialog && (
        <NameDialog
          dialog={nameDialog}
          onOk={async name => {
            const err = await folderOp(nameDialog.op, nameDialog.target, name)
            if (err) setNameDialog(d => d && { ...d, error: err })
            else setNameDialog(null)
          }}
          onCancel={() => setNameDialog(null)}
        />
      )}
      {confirm && (
        <ConfirmDialog
          confirm={confirm}
          onYes={async () => {
            const c = confirm
            setConfirm(null)
            if (c.move) await moveFolder(c.move)
            else if (c.folder) {
              const err = await folderOp('delete', c.folder)
              if (err) setFolderError(err)
            } else runAction('delete', c.ids, { permanent: true, ...(c.ctx || {}) })
          }}
          onNo={() => {
            const c = confirm
            setConfirm(null)
            // a folder move not made (Esc, Cancel; from the menu or a drop): the focus back on that folder, not the page
            if (c.move) focusFolder(c.move.accountId, c.move.path)
          }}
        />
      )}
    </div>
  )
}
