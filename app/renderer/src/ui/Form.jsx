// SPDX-License-Identifier: GPL-3.0-or-later
// The shared form layout: a page header above the card, sections (a bold title, an optional one-line description, a
// 1 px divider between them, no inner frame), rows of fields that belong together (they wrap in a narrow window), the
// action bar (primary + text Cancel, a side action on the right; `sticky`: it stays at the bottom of the scrolled form),
// the preferences list (pattern B: name + description on the left, the control on the right) and a read-only value.
// Only layout and look: the fields keep their own ids, names, values and handlers.
import { useId } from 'react'

const cx = (...parts) => parts.filter(Boolean).join(' ')

/** A 22 px bold page title with an optional subtitle, above the form card; `children` go to the right (actions). */
export function PageHeader({ title, subtitle, className, children }) {
  return (
    <header className={cx('page-head', className)}>
      <div className="page-head-text">
        <h1 className="page-title">{title}</h1>
        {subtitle ? <p className="page-sub">{subtitle}</p> : null}
      </div>
      {children}
    </header>
  )
}

/** One section of a form: a 14 px bold title, an optional description, the fields below. */
export function FormSection({ title, description, className, children, ...rest }) {
  return (
    <section className={cx('form-section', className)} {...rest}>
      {title ? <h2 className="form-section-title">{title}</h2> : null}
      {description ? <p className="form-section-desc">{description}</p> : null}
      <div className="form-section-body">{children}</div>
    </section>
  )
}

/** Fields that belong together in one row (server + port, user + password); they wrap when the row is too narrow. */
export function FormRow({ className, children }) {
  return <div className={cx('form-row', className)}>{children}</div>
}

/**
 * The action bar: `children` in order (primary first, then the text Cancel), `side` on the right (an outlined side
 * action such as a connection test). `sticky`: the bar stays visible at the bottom while the form scrolls.
 */
export function FormActions({ sticky = false, side = null, className, children }) {
  return (
    <div className={cx('form-actions', sticky && 'form-actions-sticky', className)}>
      {children}
      {side ? (
        <>
          <span className="form-actions-spacer" />
          {side}
        </>
      ) : null}
    </div>
  )
}

/** The preferences list (pattern B): a list of SettingRow. */
export function SettingList({ className, children, ...rest }) {
  return (
    <ul className={cx('setting-list', className)} {...rest}>
      {children}
    </ul>
  )
}

/**
 * One preference: a bold name and a one-line description on the left, the control on the right in one column.
 * `labelId`: the id of the name, for a control that names itself with aria-labelledby.
 */
export function SettingRow({ label, description, labelId, className, children }) {
  return (
    <li className={cx('setting-row', className)}>
      <div className="setting-text">
        <span className="setting-label" id={labelId}>{label}</span>
        {description ? <p className="setting-desc">{description}</p> : null}
      </div>
      <div className="setting-control">{children}</div>
    </li>
  )
}

/**
 * A value that cannot change (the account type after saving): label, the value, a hint below. The value is a read-only
 * textbox named by the label and described by the hint (aria), so a screen reader reads "Típus, IMAP, read only"; `id`
 * goes to the value.
 */
export function ReadOnlyField({ label, value, hint, id, className, valueClassName }) {
  const base = useId()
  const labelId = `${base}-label`
  const hintId = hint ? `${base}-hint` : undefined
  return (
    <div className={cx('text-field', 'readonly-field', className)}>
      <span className="text-field-label" id={labelId}>{label}</span>
      <span id={id} className={cx('readonly-value', valueClassName)} role="textbox" aria-readonly="true" aria-labelledby={labelId} aria-describedby={hintId}>
        {value}
      </span>
      {hint ? <span className="text-field-message hint" id={hintId}>{hint}</span> : null}
    </div>
  )
}
