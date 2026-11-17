// SPDX-License-Identifier: GPL-3.0-or-later
// Text inputs and the checkbox. The native <input> stays (keyboard, IME, autofill,
// the e2e hooks such as #vault-unlock); only its look is ours.
import { useEffect, useId, useRef } from 'react'
import { t } from '../../i18n/index.js'
import { Icon } from '../Icon.jsx'
import { IconButton } from './Button.jsx'

const cx = (...parts) => parts.filter(Boolean).join(' ')

export const FIELD_WIDTHS = Object.freeze(['xs', 's', 'm', 'l', 'full'])

/**
 * A labelled one-line field (no floating label): label above, 40 px input, hint or error below (the error takes the
 * hint's place). `width`: 'xs' 96 / 's' 176 / 'm' 280 / 'l' 420 / 'full' (at most 660) px, by the content; without it
 * the field takes its container's width, as before. `optional`: "(optional)" after the label. The message is the
 * input's description (aria-describedby), an error also sets aria-invalid.
 */
export function TextField({ label, hint, error, optional = false, width, className, inputClassName, ...input }) {
  const messageId = useId()
  const message = error || hint
  return (
    <label className={cx('text-field', error && 'text-field-error', FIELD_WIDTHS.includes(width) && `w-${width}`, className)}>
      <span className="text-field-label">
        {label}
        {optional ? <span className="optional"> {t.optionalField}</span> : null}
      </span>
      <input
        className={cx('text-field-input', inputClassName)}
        aria-invalid={error ? true : undefined}
        aria-describedby={message ? messageId : undefined}
        {...input}
      />
      {error ? (
        <span className="text-field-message error" role="alert" id={messageId}>
          <Icon name="error" />
          {error}
        </span>
      ) : hint ? (
        <span className="text-field-message hint" id={messageId}>{hint}</span>
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
 * `switch`: drawn as an on/off toggle (an on/off setting); the native checkbox, its role, Space and the click stay.
 */
export function Checkbox({ label, hideLabel = false, indeterminate = false, switch: asSwitch = false, className, ...input }) {
  const ref = useRef(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate
  }, [indeterminate])
  return (
    <label className={cx('checkbox', asSwitch && 'switch', className)} title={hideLabel ? label : undefined}>
      <input ref={ref} type="checkbox" className="checkbox-input" {...input} />
      {asSwitch ? (
        <span className="switch-track" aria-hidden="true" />
      ) : (
        <span className="checkbox-box" aria-hidden="true">
          <Icon name={indeterminate ? 'minus' : 'check'} />
        </span>
      )}
      <span className={hideLabel ? 'sr-only' : 'checkbox-label'}>{label}</span>
    </label>
  )
}
