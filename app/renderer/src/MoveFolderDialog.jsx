// SPDX-License-Identifier: GPL-3.0-or-later
// "Move…" from a folder's menu, the keyboard way of a drag: the account's folders (and the top level) as a listbox.
// A target the main process would refuse cannot be chosen and says why (shown, and to a screen reader through the
// option's aria-describedby). The choice goes to the same confirmation and folders:move as a drop (onChoose).
import { useEffect, useId, useMemo, useState } from 'react'
import { t } from '../i18n/index.js'
import { buildFolderTree, flattenTree, assignRoles } from '../../../core/imap/folders.js'
import { moveTargetReason } from './folder-order.js'
import { Button, Modal } from './ui/index.js'

/** The targets in the tree's order: the top level first; `reason` is null when the folder may go there. */
export function moveChoices(account, from) {
  const roles = assignRoles(account.folders)
  const top = { parent: null, label: t.moveDialog.topLevel(account.name), depth: 0, reason: moveTargetReason(account.folders, roles, from, null) }
  const rows = flattenTree(buildFolderTree(account.folders)).map(({ node, depth }) => ({
    parent: node.path,
    label: node.role ? t.folderRoles[node.role] : node.name,
    depth: depth + 1,
    reason: node.selectable ? moveTargetReason(account.folders, roles, from, node.path) : 'missing',
  }))
  return [top, ...rows]
}

export function MoveFolderDialog({ account, from, label, onChoose, onCancel }) {
  const choices = useMemo(() => moveChoices(account, from), [account, from])
  const [active, setActive] = useState(() => Math.max(0, choices.findIndex(c => !c.reason)))
  const base = useId()
  const optionId = i => `${base}-o${i}`
  useEffect(() => {
    document.getElementById(optionId(active))?.scrollIntoView?.({ block: 'nearest' })
  }, [active])
  const current = choices[active]
  const choose = i => {
    const c = choices[i]
    if (c && !c.reason) onChoose(c)
  }
  const onKeyDown = e => {
    const last = choices.length - 1
    const next = { ArrowDown: Math.min(active + 1, last), ArrowUp: Math.max(active - 1, 0), Home: 0, End: last }[e.key]
    if (e.key === 'Enter') {
      e.preventDefault()
      choose(active)
    } else if (next !== undefined) {
      e.preventDefault()
      setActive(next)
    }
  }
  return (
    <Modal
      title={t.moveDialog.title(label)}
      className="move-folder-dialog"
      onClose={onCancel}
      actions={[
        <Button key="cancel" variant="text" onClick={onCancel}>{t.confirmCancel}</Button>,
        <Button key="ok" variant="primary" disabled={!current || Boolean(current.reason)} onClick={() => choose(active)}>{t.moveDialog.ok}</Button>,
      ]}
    >
      <p className="hint" id={`${base}-help`}>{t.moveDialog.help}</p>
      <ul
        role="listbox"
        className="move-targets"
        tabIndex={0}
        data-autofocus
        aria-label={t.moveDialog.listLabel}
        aria-describedby={`${base}-help`}
        aria-activedescendant={optionId(active)}
        onKeyDown={onKeyDown}
      >
        {choices.map((c, i) => (
          <li
            key={c.parent === null ? '' : `f:${c.parent}`}
            id={optionId(i)}
            role="option"
            aria-selected={i === active}
            aria-disabled={c.reason ? 'true' : undefined}
            aria-describedby={c.reason ? `${optionId(i)}-why` : undefined}
            className={`move-target${i === active ? ' active' : ''}${c.reason ? ' disabled' : ''}`}
            style={{ '--depth': c.depth }}
            data-path={c.parent === null ? '' : c.parent}
            onClick={() => setActive(i)}
            onDoubleClick={() => choose(i)}
          >
            <span className="move-target-name">{c.label}</span>
            {c.reason && <span className="move-target-why" id={`${optionId(i)}-why`}>{t.moveDialog.reasons[c.reason]}</span>}
          </li>
        ))}
      </ul>
    </Modal>
  )
}
