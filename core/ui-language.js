// SPDX-License-Identifier: GPL-3.0-or-later
// The interface languages and their number/date locales. Pure (the renderer imports it too).
// Hungarian is the default: a missing or unknown value is Hungarian, so an update changes nothing for an existing
// installation. English uses en-GB (day/month order, as in Europe).
export const LANGUAGES = Object.freeze(['hu', 'en'])
export const DEFAULT_LANGUAGE = 'hu'
export const LOCALES = Object.freeze({ hu: 'hu-HU', en: 'en-GB' })

/** A stored or received value as a language: anything unknown is the default. */
export function languageOf(v) {
  return LANGUAGES.includes(v) ? v : DEFAULT_LANGUAGE
}
