// SPDX-License-Identifier: GPL-3.0-or-later
// Menus: a popup list with keyboard handling (arrows, Home/End, Enter/Space,
// Esc, Tab), the button that opens one, and a menu-based Select that replaces the native <select>.
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Icon } from '../Icon.jsx'
import { Button, IconButton } from './Button.jsx'

const cx = (...parts) => parts.filter(Boolean).join(' ')
// the gap a menu keeps from the window's edges, px
const EDGE = 4

function enabledItems(list) {
  return list ? [...list.querySelectorAll('[role^="menuitem"]:not(:disabled)')] : []
}

/**
 * items: [{ key, label, icon?, swatch?, swatchOutline?, disabled?, title?, checked?, danger?, onSelect }] or { separator: true };
 * swatch: a color dot before the label (a label's color); swatchOutline: the dot gets the theme's outline instead of its own
 * color (a light or a dark color that would not stand out on the menu, a transparent one).
 * `checked` (true/false) turns the items into radio items (the Select). onClose(reason) is called
 * with 'select', 'escape', 'tab' or 'outside'. `at` = { x, y } positions it fixed (context menu);
 * without it the menu sits under its (relatively positioned) parent.
 * It stays inside the window: a context menu that would run past the bottom or the right edge opens upward or
 * leftward from the point (at worst it sits at the edge); an anchored one opens above its button when it does not
 * fit below but does above, and keeps to the window's side edges.
 */
export function Menu({ items, onClose, label, at, className, style, id }) {
  const list = useRef(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const [place, setPlace] = useState(null) // a context menu's corrected { left, top }
  const [flip, setFlip] = useState(null) // an anchored menu's placement classes

  // measured before the first paint (a layout effect's state update renders before it)
  const atX = at ? at.x : null
  const atY = at ? at.y : null
  useLayoutEffect(() => {
    const el = list.current
    if (!el || atX === null) return
    const r = el.getBoundingClientRect()
    const left = atX + r.width > window.innerWidth - EDGE ? Math.max(EDGE, atX - r.width) : atX
    const top = atY + r.height > window.innerHeight - EDGE ? Math.max(EDGE, atY - r.height) : atY
    setPlace(left === atX && top === atY ? null : { left, top })
  }, [atX, atY])
  useLayoutEffect(() => {
    const el = list.current
    if (!el || at || !el.parentElement) return
    const r = el.getBoundingClientRect()
    const a = el.parentElement.getBoundingClientRect()
    const up = r.bottom > window.innerHeight - EDGE && a.top - (r.top - a.bottom) - r.height >= EDGE
    const side = r.right > window.innerWidth - EDGE ? 'menu-to-end' : r.left < EDGE ? 'menu-to-start' : null
    if (up || side) setFlip(cx(up && 'menu-up', side))
    // measured once, where it first opened: a later measurement would see the moved menu
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useLayoutEffect(() => {
    const all = enabledItems(list.current)
    const start = all.find(el => el.getAttribute('aria-checked') === 'true') || all[0]
    if (start) start.focus()
  }, [])

  useEffect(() => {
    // the button that opened it (the menu's anchor) is not "outside": its own click toggles the menu
    // shut; closing here too would make that click open it again
    const outside = e => {
      const el = list.current
      if (!el || el.contains(e.target)) return
      const anchor = el.parentElement && el.parentElement.classList.contains('menu-anchor') ? el.parentElement : null
      if (anchor && anchor.contains(e.target)) return
      closeRef.current('outside')
    }
    const blur = () => closeRef.current('outside')
    window.addEventListener('pointerdown', outside, true)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('blur', blur)
    }
  }, [])

  const onKeyDown = e => {
    const all = enabledItems(list.current)
    const i = all.indexOf(document.activeElement)
    const go = n => {
      e.preventDefault()
      if (all.length) all[(n + all.length) % all.length].focus()
    }
    if (e.key === 'ArrowDown') go(i + 1)
    else if (e.key === 'ArrowUp') go(i < 0 ? all.length - 1 : i - 1)
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(all.length - 1)
    else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose('escape')
    } else if (e.key === 'Tab') onClose('tab')
  }

  const radio = items.some(it => it && typeof it.checked === 'boolean')
  return (
    <ul
      ref={list}
      id={id}
      role="menu"
      aria-label={label}
      className={cx('menu', at && 'menu-fixed', flip, className)}
      style={at ? { ...style, left: place ? place.left : at.x, top: place ? place.top : at.y } : style}
      onKeyDown={onKeyDown}
    >
      {items.map((it, n) =>
        it.separator ? (
          <li key={`sep-${n}`} role="separator" className="menu-separator" />
        ) : (
          <li key={it.key} role="none">
            <button
              type="button"
              role={radio ? 'menuitemradio' : 'menuitem'}
              aria-checked={radio ? Boolean(it.checked) : undefined}
              className={cx('menu-item', it.danger && 'menu-item-danger')}
              tabIndex={-1}
              disabled={it.disabled}
              title={it.title}
              data-key={it.key}
              onClick={() => {
                it.onSelect && it.onSelect()
                onClose('select')
              }}
            >
              {radio ? <Icon name="check" className={it.checked ? '' : 'icon-invisible'} /> : it.icon ? <Icon name={it.icon} /> : null}
              {it.swatch ? (
                <span
                  className={cx('label-swatch', it.swatchOutline && 'swatch-outline')}
                  style={it.swatchOutline ? { backgroundColor: it.swatch } : { backgroundColor: it.swatch, borderColor: it.swatch }}
                  aria-hidden="true"
                />
              ) : null}
              <span className="menu-item-label">{it.label}</span>
            </button>
          </li>
        ),
      )}
    </ul>
  )
}

/**
 * A button with a popup menu. With `text` it is a text button with a drop-down arrow, without it
 * an IconButton (`icon` + `label`). Esc and a choice give the focus back to the button.
 */
export function MenuButton({ label, icon, text, variant = 'text', items, disabled, className, menuClassName, align = 'start' }) {
  const [open, setOpen] = useState(false)
  const trigger = useRef(null)
  const menuId = useId()
  const close = reason => {
    setOpen(false)
    if (reason !== 'outside' && reason !== 'tab' && trigger.current) trigger.current.focus()
  }
  const triggerProps = {
    ref: trigger,
    disabled,
    'aria-haspopup': 'menu',
    'aria-expanded': open,
    'aria-controls': open ? menuId : undefined,
    onClick: () => setOpen(o => !o),
    onKeyDown: e => {
      if (e.key === 'ArrowDown' && !open) {
        e.preventDefault()
        setOpen(true)
      }
    },
  }
  return (
    <span className={cx('menu-anchor', className)}>
      {text ? (
        <Button variant={variant} icon={icon} aria-label={label === text ? undefined : label} {...triggerProps}>
          {text}
          <Icon name="chevronDown" />
        </Button>
      ) : (
        <IconButton icon={icon} label={label} {...triggerProps} />
      )}
      {open && (
        <Menu id={menuId} items={items} label={label} onClose={close} className={cx(`menu-align-${align}`, menuClassName)} />
      )}
    </span>
  )
}

/**
 * The menu-based Select (the native <select> is gone). The button's accessible name is
 * `label`; it shows the current option's text. options: [{ value, label }]. `describedBy`: the id of the field's hint or
 * error message (aria-describedby); `invalid`: aria-invalid.
 */
export function Select({ label, value, options, onChange, disabled, id, className, describedBy, invalid = false }) {
  const [open, setOpen] = useState(false)
  const trigger = useRef(null)
  const current = options.find(o => o.value === value)
  const close = reason => {
    setOpen(false)
    if (reason !== 'outside' && reason !== 'tab' && trigger.current) trigger.current.focus()
  }
  return (
    <span className={cx('menu-anchor', 'select', className)}>
      <button
        ref={trigger}
        type="button"
        id={id}
        className="select-trigger"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-describedby={describedBy}
        aria-invalid={invalid ? true : undefined}
        disabled={disabled}
        onClick={() => setOpen(o => !o)}
        onKeyDown={e => {
          if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !open) {
            e.preventDefault()
            setOpen(true)
          }
        }}
      >
        <span className="select-value">{current ? current.label : ''}</span>
        <Icon name="chevronDown" />
      </button>
      {open && (
        <Menu
          label={label}
          onClose={close}
          items={options.map(o => ({ key: String(o.value), label: o.label, checked: o.value === value, onSelect: () => onChange(o.value) }))}
        />
      )}
    </span>
  )
}
