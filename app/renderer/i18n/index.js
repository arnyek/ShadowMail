// SPDX-License-Identifier: GPL-3.0-or-later
// The interface language: `lang` ('hu' | 'en'), `t` (its dictionary) and `locale` (for Intl formatters).
// Renderer: the language comes from the preload (window.shadowMail.language, read synchronously from the main
// process before any module runs), so `t` is set once per page load (a change of language reloads the window).
// Main process: Hungarian until main() reads data\ui.json and calls setLanguage(); the bindings are live, so every
// importer sees the new value (read `t.x` when needed, not into a module-level constant before main() runs).
import { hu } from './hu.js'
import { en } from './en.js'
import { LOCALES, languageOf } from '../../../core/ui-language.js'

const DICTIONARIES = { hu, en }

function fromPreload() {
  try {
    return globalThis.shadowMail?.language
  } catch {
    return null
  }
}

export let lang = languageOf(fromPreload())
export let t = DICTIONARIES[lang]
export let locale = LOCALES[lang]

/** Switches the language of this process (the main process, after reading data\ui.json). */
export function setLanguage(v) {
  lang = languageOf(v)
  t = DICTIONARIES[lang]
  locale = LOCALES[lang]
  return lang
}

export { hu, en }
