// SPDX-License-Identifier: GPL-3.0-or-later
// The label chips (0.17.0): one chip (the label's color, black or white text by contrast, the name shortened in a row),
// and a row's chip group (at most 3, then "+N" with every name in its tooltip).
import { t } from '../i18n/index.js'
import { Icon } from './Icon.jsx'
import { chipName, chipTextColor, rowChips } from './label-chips.js'

/**
 * One chip. `full`: the whole name (the reader), otherwise shortened to 12 characters. `onRemove`: an "x" button that
 * takes the label off (the reader).
 */
export function LabelChip({ label, full = false, onRemove = null }) {
  const style = { backgroundColor: label.color, color: chipTextColor(label.color) }
  return (
    <span className="label-chip" style={style} title={label.name} data-label-id={label.id}>
      <span className="label-chip-name">{full ? label.name : chipName(label.name)}</span>
      {onRemove ? (
        <button type="button" className="label-chip-remove" aria-label={t.labels.remove(label.name)} title={t.labels.remove(label.name)} onClick={onRemove}>
          <Icon name="close" />
        </button>
      ) : null}
    </span>
  )
}

/**
 * A list or search row's labels: the row's label ids in the label list's order, at most 3 drawn, then "+N". The form
 * comes from the width of the row's text cell (app.css, @container msg-text): chips, up to 3 dots, 1 dot (then the
 * second "+N", the rest after the first), or nothing (then the hidden text names them). Every "+N" names the rest in
 * its tooltip.
 */
export function RowChips({ ids, list }) {
  const { shown, more, all, title } = rowChips(ids, list)
  if (!shown.length) return null
  const names = ls => ls.map(l => l.name).join(', ')
  return (
    <>
      <span className="label-chips" role="group" title={title} aria-label={t.labels.group(title)}>
        {shown.map(l => (
          <LabelChip key={l.id} label={l} />
        ))}
        {more ? (
          <span className="label-chip-more label-more-3" title={names(all.slice(shown.length))} aria-hidden="true">{`+${more}`}</span>
        ) : null}
        {all.length > 1 ? (
          <span className="label-chip-more label-more-1" title={names(all.slice(1))} aria-hidden="true">{`+${all.length - 1}`}</span>
        ) : null}
      </span>
      <span className="label-chips-none sr-only">{t.labels.group(title)}</span>
    </>
  )
}
