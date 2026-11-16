// SPDX-License-Identifier: GPL-3.0-or-later
// Modal, Banner and Avatar.
import { useEffect, useId, useRef } from 'react'
import { Icon } from '../Icon.jsx'
import { IconButton } from './Button.jsx'

const cx = (...parts) => parts.filter(Boolean).join(' ')
const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

/**
 * An in-app dialog (window.confirm/prompt are native windows). Esc calls onClose, Tab stays inside,
 * the focus goes to the [data-autofocus] element (or the first focusable one) and back to where it
 * was on close. `onSubmit` makes the panel a <form>. role: dialog | alertdialog.
 */
export function Modal({ title, children, actions, onClose, onSubmit, role = 'dialog', className }) {
  const panel = useRef(null)
  const titleId = useId()
  useEffect(() => {
    const before = document.activeElement
    const el = panel.current
    const first = el && (el.querySelector('[data-autofocus]') || el.querySelector(FOCUSABLE))
    if (first) first.focus()
    return () => {
      if (before && typeof before.focus === 'function' && document.contains(before)) before.focus()
    }
  }, [])
  const onKeyDown = e => {
    if (e.key === 'Escape' && onClose) {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    } else if (e.key === 'Tab') {
      const all = [...panel.current.querySelectorAll(FOCUSABLE)]
      if (!all.length) return
      const first = all[0]
      const last = all[all.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
  }
  const Panel = onSubmit ? 'form' : 'div'
  return (
    <div className="modal-backdrop">
      <Panel
        ref={panel}
        className={cx('modal', className)}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
        onSubmit={
          onSubmit &&
          (e => {
            e.preventDefault()
            onSubmit(e)
          })
        }
      >
        <h2 id={titleId} className="modal-title">{title}</h2>
        <div className="modal-content">{children}</div>
        {actions && <div className="modal-buttons">{actions}</div>}
      </Panel>
    </div>
  )
}

const BANNER_ICON = { info: 'info', warning: 'warning', error: 'error' }

/** A full-width notice: info / warning / error, optional action buttons and a close button; `role` overrides the default. */
export function Banner({ kind = 'info', children, actions, onClose, closeLabel, className, id, role }) {
  if (onClose && !closeLabel) throw new Error('Banner with onClose needs a closeLabel')
  return (
    <div id={id} className={cx('banner', `banner-${kind}`, className)} role={role || (kind === 'error' ? 'alert' : 'status')}>
      <Icon name={BANNER_ICON[kind]} size="m" />
      <div className="banner-text">{children}</div>
      {actions && <div className="banner-actions">{actions}</div>}
      {onClose && <IconButton icon="close" label={closeLabel} size="s" onClick={onClose} />}
    </div>
  )
}

export const AVATAR_COLORS = 8

/** Initials of a display name, or the first letter of the address. */
export function initials(name, address) {
  const words = String(name || '')
    .replace(/[<(].*$/, '')
    .replace(/["']/g, '')
    .trim()
    .split(/\s+/)
    .filter(w => /\p{L}/u.test(w))
  if (words.length >= 2) return (firstLetter(words[0]) + firstLetter(words[1])).toUpperCase()
  if (words.length === 1) return firstLetter(words[0]).toUpperCase()
  return firstLetter(String(address || '?')).toUpperCase()
}

function firstLetter(word) {
  const m = /\p{L}|\p{N}/u.exec(word)
  return m ? m[0] : '?'
}

/** A stable color slot (1..8) from the address (or the name): the same sender, the same color. */
export function avatarColor(key) {
  let h = 0
  for (const ch of String(key || '').toLowerCase()) h = (Math.imul(h, 31) + ch.codePointAt(0)) >>> 0
  return (h % AVATAR_COLORS) + 1
}

/** The sender's monogram in a colored circle (no photo, no network). Decorative: the name is next to it. */
export function Avatar({ name, address, className }) {
  return (
    <span className={cx('avatar', `avatar-c${avatarColor(address || name)}`, className)} aria-hidden="true">
      {initials(name, address)}
    </span>
  )
}
