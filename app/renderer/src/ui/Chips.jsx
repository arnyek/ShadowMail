// SPDX-License-Identifier: GPL-3.0-or-later
// Filter chips with a drop-down: ChipSelect (a menu of choices, like Select) and
// ChipPanel (a small panel with fields, e.g. sender / dates). An active chip has the check mark and
// the active background; its text shows the chosen value, its accessible name starts with the label.
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Chip } from './Button.jsx'
import { Menu } from './Menu.jsx'

const cx = (...parts) => parts.filter(Boolean).join(' ')

function ChipText({ label, value }) {
  if (value === undefined || value === null || value === '') return label
  return (
    <>
      <span className="sr-only">{label}: </span>
      {value}
    </>
  )
}

/**
 * options: [{ value, label }]; the first option is "everything" (not active). `showValue` shows
 * "label: value" even for the first option (the sort order).
 */
export function ChipSelect({ label, value, options, onChange, showValue = false, disabled, className }) {
  const [open, setOpen] = useState(false)
  const anchor = useRef(null)
  const current = options.find(o => o.value === value) || options[0]
  const active = current !== options[0]
  const close = reason => {
    setOpen(false)
    if (reason !== 'outside' && reason !== 'tab') anchor.current?.querySelector('button')?.focus()
  }
  return (
    <span ref={anchor} className={cx('menu-anchor', 'chip-select', className)}>
      <Chip
        active={active}
        menu
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`${label}: ${current.label}`}
        onClick={() => setOpen(o => !o)}
        onKeyDown={e => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault()
            setOpen(true)
          }
        }}
      >
        {showValue ? `${label}: ${current.label}` : <ChipText label={label} value={active ? current.label : null} />}
      </Chip>
      {open && (
        <Menu
          label={label}
          onClose={close}
          items={options.map(o => ({ key: String(o.value), label: o.label, checked: o.value === current.value, onSelect: () => onChange(o.value) }))}
        />
      )}
    </span>
  )
}

/**
 * A chip with a menu of its own items (0.10.1: the folder view's order, the same items as the list's
 * More menu): `text` is the chip's full text (its accessible name and tooltip), `display` an optional
 * shorter form shown instead (one row at 1280 px), `items` are Menu items.
 */
export function ChipMenu({ label, text, display, items, className }) {
  const [open, setOpen] = useState(false)
  const anchor = useRef(null)
  const close = reason => {
    setOpen(false)
    if (reason !== 'outside' && reason !== 'tab') anchor.current?.querySelector('button')?.focus()
  }
  return (
    <span ref={anchor} className={cx('menu-anchor', 'chip-select', className)}>
      <Chip
        menu
        aria-haspopup="menu"
        aria-expanded={open}
        title={text}
        aria-label={display ? text : undefined}
        onClick={() => setOpen(o => !o)}
        onKeyDown={e => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault()
            setOpen(true)
          }
        }}
      >
        {display ?? text}
      </Chip>
      {open && <Menu label={label} onClose={close} items={items} />}
    </span>
  )
}

/**
 * A chip that opens a small panel (role="dialog") under it. Esc or a click outside closes it and
 * the focus goes back to the chip; the first field gets the focus on open.
 */
export function ChipPanel({ label, active = false, value, children, className }) {
  const [open, setOpen] = useState(false)
  const anchor = useRef(null)
  const panel = useRef(null)
  const panelId = useId()
  const close = (back = true) => {
    setOpen(false)
    if (back) anchor.current?.querySelector('button')?.focus()
  }
  useLayoutEffect(() => {
    if (open) panel.current?.querySelector('input, button')?.focus()
  }, [open])
  useEffect(() => {
    if (!open) return undefined
    const outside = e => {
      if (anchor.current && !anchor.current.contains(e.target)) close(false)
    }
    window.addEventListener('pointerdown', outside, true)
    return () => window.removeEventListener('pointerdown', outside, true)
  }, [open])
  return (
    <span ref={anchor} className={cx('menu-anchor', 'chip-panel-anchor', className)}>
      <Chip active={active} menu aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={() => setOpen(o => !o)}>
        <ChipText label={label} value={active ? value : null} />
      </Chip>
      {open && (
        <div
          ref={panel}
          id={panelId}
          className="chip-panel"
          role="dialog"
          aria-label={label}
          onKeyDown={e => {
            if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              close()
            }
          }}
        >
          {children}
        </div>
      )}
    </span>
  )
}
