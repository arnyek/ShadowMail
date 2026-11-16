// SPDX-License-Identifier: GPL-3.0-or-later
// The interface language of an e2e run: E2E_LANG=en runs a test against the English interface, unset or hu against the
// Hungarian one (as before). A test reads the texts it looks for from `t` (the dictionary the app shows), and seeds its
// data folder with seedLanguage() before the launch.
//
//   E2E_LANG=en node test/e2e/folders-e2e.mjs
import { hu } from '../../app/renderer/i18n/hu.js'
import { en } from '../../app/renderer/i18n/en.js'
import { LANGUAGES, LOCALES } from '../../core/ui-language.js'
import { writeLanguage } from '../../core/ui-language-file.js'

const wanted = process.env.E2E_LANG || 'hu'
if (!LANGUAGES.includes(wanted)) throw new Error(`E2E_LANG must be one of ${LANGUAGES.join(', ')}, not ${wanted}`)

export const lang = wanted
export const t = { hu, en }[lang]
export const locale = LOCALES[lang]

/**
 * The data folder opens in the run's language: data/ui.json for English; for Hungarian no file at all (as an installation
 * from before the language setting). -> the language
 */
export function seedLanguage(dataDir) {
  if (lang !== 'hu') writeLanguage(dataDir, lang)
  return lang
}
