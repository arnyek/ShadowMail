// SPDX-License-Identifier: GPL-3.0-or-later
// The interface themes: a color scheme is a set of token overrides on [data-theme] (theme.css), a density a set of size
// overrides on [data-density]. The list drives the setting's menu and the tests (every theme gets the contrast test).
// The default is the original light look; a stored value that is not on the list falls back to it.
export const THEMES = Object.freeze([
  Object.freeze({ id: 'default', density: 'normal' }),
  Object.freeze({ id: 'dark', density: 'normal' }),
  Object.freeze({ id: 'graphite', density: 'normal' }),
  // the classic styles set the reading pane once, when chosen (the header switch and the setting change it freely after)
  Object.freeze({ id: 'classic-blue', density: 'compact', readerPane: 'right' }),
  Object.freeze({ id: 'classic-light', density: 'compact', readerPane: 'bottom' }),
])
export const DEFAULT_THEME = 'default'

/** A stored or chosen value as a theme of the list: anything unknown is the default. */
export function themeOf(v) {
  return THEMES.find(t => t.id === v) || THEMES.find(t => t.id === DEFAULT_THEME)
}

/** Puts the theme on the page: <html data-theme data-density>. Before React renders, and at once on a change. */
export function applyTheme(v, doc = document) {
  const theme = themeOf(v)
  doc.documentElement.dataset.theme = theme.id
  doc.documentElement.dataset.density = theme.density
  return theme.id
}
