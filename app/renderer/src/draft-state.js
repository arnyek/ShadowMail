// SPDX-License-Identifier: GPL-3.0-or-later
// Whether the composer has unsaved changes. Pure, no DOM: the tests use it directly.
// A save that finishes must not mark changes typed DURING the save as saved (typing on
// while a slow autosave ran, then closing, would lose the new text without a question).
export function createDraftState() {
  let version = 0 // every change counts
  let savedVersion = 0
  return {
    touch() {
      version++
    },
    get dirty() {
      return version !== savedVersion
    },
    /** call before the save starts; pass the token to saved() when the save succeeded */
    beginSave() {
      return version
    },
    saved(token) {
      // only what existed when the save started is saved
      if (token > savedVersion) savedVersion = token
    },
  }
}
