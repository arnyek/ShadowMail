// SPDX-License-Identifier: GPL-3.0-or-later
// Buttons. The visible text is the accessible name; an icon-only button must use
// IconButton, which requires a label (aria-label + title, from hu.js at the call site).
import { Icon } from '../Icon.jsx'

const cx = (...parts) => parts.filter(Boolean).join(' ')

/** variant: primary (filled accent) | tonal (soft accent) | outlined | text | danger */
export function Button({ variant = 'text', icon, type = 'button', className, children, ...rest }) {
  return (
    <button type={type} className={cx('btn', `btn-${variant}`, icon && 'btn-with-icon', className)} {...rest}>
      {icon && <Icon name={icon} />}
      {children}
    </button>
  )
}

/** A round, icon-only button. `label` is mandatory: it becomes the aria-label and the tooltip. */
export function IconButton({ icon, label, size = 'm', pressed, filled = false, type = 'button', className, ...rest }) {
  if (!label) throw new Error(`IconButton "${icon}" needs a label`)
  return (
    <button
      type={type}
      className={cx('icon-btn', size === 's' && 'icon-btn-s', className)}
      aria-label={label}
      title={label}
      aria-pressed={pressed === undefined ? undefined : Boolean(pressed)}
      {...rest}
    >
      <Icon name={icon} size={size} filled={filled} />
    </button>
  )
}

/** A filter chip: aria-pressed and a check mark when active; `menu` adds the drop-down arrow. */
export function Chip({ active = false, menu = false, icon, type = 'button', className, onClick, children, ...rest }) {
  return (
    <button type={type} className={cx('chip', active && 'chip-active', className)} aria-pressed={active} onClick={onClick} {...rest}>
      {active ? <Icon name="check" /> : icon ? <Icon name={icon} /> : null}
      <span className="chip-label">{children}</span>
      {menu && <Icon name="chevronDown" />}
    </button>
  )
}
