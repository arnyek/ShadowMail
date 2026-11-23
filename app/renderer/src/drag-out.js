// SPDX-License-Identifier: GPL-3.0-or-later
// A list row dragged out of the program: the page's side. The row's dragstart is cancelled, the main process writes
// the messages as .eml files (mail:dragOut) and then starts a native file drag (mail:dragStart), which another program
// (Claude, Explorer, the desktop) takes as files. The same drag dropped back on one of our folders is still a move: the
// drop carries our own files, and the main process names their messages (mail:dragDrop).
//
// The mouse button is checked between the two steps: a mouseup while the files are written means the user let go, and
// no drag starts (a native drag started after that would drop wherever the pointer happens to be).
//
// The choice is made at once, in the dragstart (it cannot wait for the main process): only a drag whose every message
// is stored here (the list row's `stored`, or downloaded by an earlier drag), at most `max` of them and `maxBytes`
// together (the rows' `size`), goes out as files. Anything else is the list's internal drag, exactly as before (a move
// onto a folder). Only when that drag ends anywhere but on one of our folders (its dragend's dropEffect is 'none':
// dragged out, Esc, let go elsewhere) does a notice say why nothing went out, and the messages not here yet are
// downloaded in the background (mail:dragFetch), so the next drag takes them out. Not at the dragstart: the download
// runs on the account's one interactive connection and mailbox lock, and a move onto a folder would wait for it.

/** The message drag type of the list's internal drag (folder targets read it). */
export const DRAG_TYPE = 'application/x-shadowmail-ids'

/** The most messages one drag carries out: the main process's DRAG_MAX_FILES (a test keeps the two equal). */
export const DRAG_OUT_MAX = 50
/** ...and bytes together: the main process's DRAG_MAX_BYTES. */
export const DRAG_OUT_MAX_BYTES = 100 * 1024 * 1024

/**
 * @param api       window.shadowMail.mail (dragOut, dragStart, dragDrop, dragFetch)
 * @param max       the most messages one drag carries out (DRAG_MAX_FILES of the main process)
 * @param maxBytes  ...and bytes together (DRAG_MAX_BYTES)
 * @param onError   (res) => void: a failed preparation, start or background download (res.error; too_large: bytes, max)
 * @param onNotice  (kind, info) => void: an internal drag ended outside our folders, why it did not go out: 'tooMany'
 *                  { n, max }, 'notYet' (being downloaded now), 'tooLarge' { bytes, max }, 'noSize' (a row without a size)
 * @param target    the window the mouse events come from
 */
export function createDragOut({ api, max, maxBytes = DRAG_OUT_MAX_BYTES, onError = () => {}, onNotice = () => {}, target = window }) {
  let drag = null // { ids, token, phase: 'preparing' | 'dragging' }
  const fetched = new Set() // stored by a background download after the list was loaded (its rows still say not stored)
  // the dragend watch of the last internal drag; a new drag drops it (a source row unmounted during the drag, e.g. moved
  // away, never sends its dragend, and the watch must not take a later drag's end for its own)
  let pendingEnd = null
  const unwatch = () => {
    if (pendingEnd) target.removeEventListener('dragend', pendingEnd, true)
    pendingEnd = null
  }

  const clear = d => {
    if (drag === d) drag = null
  }
  const fetchLater = ids =>
    api.dragFetch(ids).then(
      res => {
        for (const id of (res && res.ok && res.stored) || []) fetched.add(id)
        if (!res || !res.ok || res.error) onError(res && res.ok ? { ok: false, error: res.error } : res || { error: 'internal' })
      },
      () => onError({ error: 'internal' }),
    )

  return {
    /**
     * The row's dragstart. ids: the dragged messages (the selection, or the row); rowOf(id): its list row, undefined where
     * the page has not loaded it (then it is not known to be here, and the drag stays internal). Asked only under the
     * limit: a selection of the whole folder is not looked up row by row.
     */
    start(e, ids, rowOf = () => undefined) {
      unwatch()
      // the list's own drag; after it, only if it did not end on one of our folders: the notice (and the download)
      const internal = (kind, info, missing = []) => {
        e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(ids))
        e.dataTransfer.effectAllowed = 'move'
        drag = null
        const end = ev => {
          unwatch()
          if (ev.dataTransfer && ev.dataTransfer.dropEffect !== 'none') return // moved onto a folder: as before
          onNotice(kind, info)
          if (missing.length) fetchLater(missing)
        }
        pendingEnd = end
        target.addEventListener('dragend', end, true)
      }
      if (ids.length > max) return internal('tooMany', { n: ids.length, max })
      const rows = ids.map(rowOf)
      const missing = ids.filter((id, i) => !(rows[i] && rows[i].stored) && !fetched.has(id))
      if (missing.length) return internal('notYet', undefined, missing)
      const sizes = rows.map(r => (r && Number.isFinite(r.size) ? r.size : null))
      if (sizes.includes(null)) return internal('noSize')
      const bytes = sizes.reduce((a, b) => a + b, 0)
      if (bytes > maxBytes) return internal('tooLarge', { bytes, max: maxBytes })
      e.preventDefault()
      const d = { ids, token: null, phase: 'preparing', released: false }
      drag = d
      const up = () => {
        d.released = true
      }
      target.addEventListener('mouseup', up)
      api.dragOut(ids).then(
        res => {
          target.removeEventListener('mouseup', up)
          if (drag !== d) return // another drag began meanwhile
          if (!res || !res.ok) {
            clear(d)
            onError(res || { error: 'internal' })
            return
          }
          if (d.released) {
            clear(d)
            return
          }
          d.token = res.token
          d.phase = 'dragging'
          // the drag is over at the next click (a drop on our folder or the next drag clears it sooner). Not at a
          // mousemove: Chromium sends button-less moves of its own after a layout change, and a drag cleared too early
          // would turn the move onto a folder into nothing. A late one is harmless: the main process checks the paths.
          const over = () => {
            target.removeEventListener('mousedown', over)
            clear(d)
          }
          target.addEventListener('mousedown', over)
          api.dragStart(res.token).then(r => {
            if (!r || !r.ok) {
              clear(d)
              onError(r || { error: 'internal' })
            }
          }, () => clear(d))
        },
        () => {
          target.removeEventListener('mouseup', up)
          clear(d)
          onError({ error: 'internal' })
        },
      )
    },

    /** True while our own native drag is on: a folder may take a Files drag (a foreign file drag stays refused). */
    ownFiles: () => Boolean(drag && drag.phase === 'dragging'),

    /** A Files drop on a folder -> the ids of our drag's messages, or null (not ours). */
    async drop(files) {
      const d = drag
      if (!d || d.phase !== 'dragging') return null
      clear(d)
      // an array of File: a FileList does not cross the context bridge with its files (the composer does the same)
      const res = await api.dragDrop(d.token, Array.from(files || []))
      return res && res.ok && res.ids.length ? res.ids : null
    },
  }
}
