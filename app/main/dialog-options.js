// SPDX-License-Identifier: GPL-3.0-or-later
// Every native Open / Save dialog of the app adds 'dontAddToRecent'. Without it the
// Windows shell writes a shortcut of the chosen file (and of its folder) into the user's profile
// (%APPDATA%\Microsoft\Windows\Recent): measured on the 0.12.0 package smoke, against the README's
// promise that nothing is written outside the data folder. test/dialog-options.test.js requires it at every call.

/** The dialog's options with 'dontAddToRecent' among its properties (the others kept, none twice). */
export function noRecent(opts = {}) {
  const properties = Array.isArray(opts.properties) ? opts.properties : []
  return { ...opts, properties: properties.includes('dontAddToRecent') ? properties : [...properties, 'dontAddToRecent'] }
}
