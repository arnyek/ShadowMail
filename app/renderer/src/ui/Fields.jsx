// SPDX-License-Identifier: GPL-3.0-or-later
// Text inputs and the checkbox. The native <input> stays (keyboard, IME, autofill,
// the e2e hooks such as #vault-unlock); only its look is ours.
import { useEffect, useRef } from 'react'
import { Icon } from '../Icon.jsx'
import { IconButton } from './Button.jsx'

const cx = (...parts) => parts.filter(Boolean).join(' ')

/** A labelled one-line field (no floating label): label above, 40 px input, hint or error below. */
export function TextField({ label, hint, error, className, inputClassName, ...input }) {
  return (
    <label className={cx('text-field', error && 'text-field-error', className)}>
      <span className="text-field-label">{label}</span>
      <input className={cx('text-field-input', inputClassName)} aria-invalid={error ? true : undefined} {...input} />
      {error ? (
        <span className="text-field-message error" role="alert">{error}</span>
      ) : hint ? (
        <span className="text-field-message hint">{hint}</span>
      ) : null}
    </label>
  )
}

/**
 * The pill-shaped search field: magnifier on the left, a clear (X) button on the right while it has
 * text, then `children` (e.g. a filter button). The input keeps role "searchbox" with `label` as its name.
 */
export function SearchField({ label, clearLabel, value, onClear, className, children, ...input }) {
  if (!clearLabel) throw new Error('SearchField needs a clearLabel')
  return (
    <div className={cx('search-field', className)}>
      <Icon name="search" size="m" />
      <input type="search" className="search-field-input" aria-label={label} value={value} {...input} />
      {value ? <IconButton icon="close" label={clearLabel} size="s" onClick={onClear} /> : null}
      {children}
    </div>
  )
}

/**
 * A drawn checkbox: the native input is visually hidden but stays focusable and clickable (the
 * label wraps it). `indeterminate` shows a dash (the "select all" box with a partial selection).
 */
export function Checkbox({ label, hideLabel = false, indeterminate = false, className, ...input }) {
  const ref = useRef(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate
  }, [indeterminate])
  return (
    <label className={cx('checkbox', className)} title={hideLabel ? label : undefined}>
      <input ref={ref} type="checkbox" className="checkbox-input" {...input} />
      <span className="checkbox-box" aria-hidden="true">
        <Icon name={indeterminate ? 'minus' : 'check'} />
      </span>
      <span className={hideLabel ? 'sr-only' : 'checkbox-label'}>{label}</span>
    </label>
  )
}
