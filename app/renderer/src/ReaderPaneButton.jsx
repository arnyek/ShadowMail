// SPDX-License-Identifier: GPL-3.0-or-later
// Where a message opens: 'none' (in the list's place), 'right' (beside the list) or 'bottom' (under it).
// One source of the value (the App holds it), one check of a stored value, and the header's quick switch:
// one click goes to the NEXT layout (none -> right -> bottom -> none); the icon shows the layout that is on now, and
// the name says both what is on and what the click gives, so the step is never blind.
import { IconButton } from './ui/index.js'
import { t } from '../i18n/index.js'

export const READER_PANES = ['none', 'right', 'bottom']
const ICON = { none: 'layoutNone', right: 'layoutRight', bottom: 'layoutBottom' }

/** A stored value as a layout: an unknown or damaged one is the default. */
export function readerPaneOf(v) {
  return READER_PANES.includes(v) ? v : 'none'
}

/** The layout one click gives. */
export function nextReaderPane(v) {
  const i = READER_PANES.indexOf(readerPaneOf(v))
  return READER_PANES[(i + 1) % READER_PANES.length]
}

export function ReaderPaneButton({ value, onChange }) {
  const now = readerPaneOf(value)
  const next = nextReaderPane(now)
  return <IconButton icon={ICON[now]} className="reader-pane-switch" data-pane={now} label={t.readerPaneButton(now, next)} onClick={() => onChange(next)} />
}
