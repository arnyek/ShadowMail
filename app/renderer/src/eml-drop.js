// SPDX-License-Identifier: GPL-3.0-or-later
// .eml files dropped on "Új levél": each opens a composer prefilled from it (a template). The page only hands over the
// files; the main process checks and reads them (compose:open { mode: 'eml' }). A drop elsewhere opens nothing.

/** The most composers one drop opens; the rest is a notice. */
export const EML_DROP_MAX = 5

/** A drag that carries files (from Explorer, the desktop, or our own list's drag-out). */
export function carriesFiles(dataTransfer) {
  return Boolean(dataTransfer && dataTransfer.types && Array.from(dataTransfer.types).includes('Files'))
}

/**
 * Opens the first `max` of `files` one after the other, each with `open(file)` (-> the IPC result { ok, error, detail }).
 * -> { opened, errors: [{ error, detail }] in the files' order, skipped: how many were left out over `max` }.
 * A rejected call counts as { error: 'internal' }.
 */
export async function openDroppedEml(files, open, max = EML_DROP_MAX) {
  const list = Array.from(files || [])
  const errors = []
  let opened = 0
  for (const file of list.slice(0, max)) {
    let res
    try {
      res = await open(file)
    } catch {
      res = { ok: false, error: 'internal' }
    }
    if (res && res.ok) opened++
    else errors.push({ error: (res && res.error) || 'internal', detail: res && res.detail })
  }
  return { opened, errors, skipped: Math.max(0, list.length - max) }
}
