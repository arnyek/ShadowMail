// SPDX-License-Identifier: GPL-3.0-or-later
// The list's message drag in the real app, headless. A row whose messages are all stored here goes out as files: the
// page cancels the HTML drag, the main process writes the .eml files and starts a NATIVE file drag
// (webContents.startDrag), which headless ozone cannot run (there is no OS drag). So: the row gets Chromium's own
// dragstart (a synthetic DragEvent), the main process's startDrag is replaced in the app and records what it was given,
// and a drop of those files back into the window is played as a real one would bring them: File objects with their
// paths (a hidden file input, setInputFiles: only those have a path), in a DataTransfer, dragenter / dragover / drop on
// the target. Any other row keeps the HTML drag (its DataTransfer, dropped on the target the same way).

/** Replaces startDrag on every WebContents (the prototype: the IPC's event.sender is the same kind of object); once. */
export async function watchStartDrag(app) {
  await app.evaluate(({ webContents }) => {
    if (globalThis.__e2eDrags) return
    globalThis.__e2eDrags = []
    const [wc] = webContents.getAllWebContents()
    Object.getPrototypeOf(wc).startDrag = function (item) {
      globalThis.__e2eDrags.push({ files: [...item.files], icon: Boolean(item.icon && !item.icon.isEmpty()), size: item.icon ? item.icon.getSize() : null })
    }
  })
}

export const startedDrags = app => app.evaluate(() => globalThis.__e2eDrags)

/**
 * dragstart on `row` (a locator) -> { cancelled: the page cancelled the HTML drag (it goes out as files), drag: what
 * startDrag got, or null when nothing started within `ms`, types: the HTML drag's types when it was not cancelled }
 */
export async function startRowDrag(app, row, { ms = 5000 } = {}) {
  await watchStartDrag(app)
  const before = (await startedDrags(app)).length
  const { cancelled, types } = await row.evaluate(el => {
    const dt = new DataTransfer()
    const ev = new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt })
    el.dispatchEvent(ev)
    window.__e2eRowDrag = dt
    window.__e2eRowEl = el
    return { cancelled: ev.defaultPrevented, types: [...dt.types] }
  })
  if (!cancelled) return { cancelled, drag: null, types }
  for (const end = performance.now() + ms; performance.now() < end; await new Promise(r => setTimeout(r, 25))) {
    const drags = await startedDrags(app)
    if (drags.length > before) return { cancelled, drag: drags.at(-1) }
  }
  return { cancelled, drag: null }
}

/** Drops `files` (paths on disk) on `target` (a locator) as files -> { accepted: the dragover was taken } */
export async function dropFiles(page, files, target) {
  await page.evaluate(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.id = 'e2e-drag-files'
    input.hidden = true
    document.body.append(input)
  })
  await page.locator('#e2e-drag-files').setInputFiles(files)
  return target.evaluate(el => {
    const input = document.getElementById('e2e-drag-files')
    const dt = new DataTransfer()
    for (const f of input.files) dt.items.add(f)
    input.remove()
    const r = el.getBoundingClientRect()
    const opts = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }
    el.dispatchEvent(new DragEvent('dragenter', opts))
    const over = new DragEvent('dragover', opts)
    el.dispatchEvent(over)
    if (over.defaultPrevented) el.dispatchEvent(new DragEvent('drop', opts))
    return { accepted: over.defaultPrevented }
  })
}

/**
 * The HTML drag of the last startRowDrag dropped on `target`, then its dragend on the row (with the drop effect the
 * target set, as Chromium gives it) -> { accepted, dropEffect }
 */
export function dropRowDrag(target) {
  return target.evaluate(el => {
    const dt = window.__e2eRowDrag
    const r = el.getBoundingClientRect()
    const opts = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }
    el.dispatchEvent(new DragEvent('dragenter', opts))
    const over = new DragEvent('dragover', opts)
    el.dispatchEvent(over)
    if (over.defaultPrevented) el.dispatchEvent(new DragEvent('drop', opts))
    // the dragend's drop effect is the browser's (the accepted dragover's: 'move' on our folders; 'none' when refused).
    // A constructed DataTransfer keeps 'none' whatever is set, so the dragend carries the effect as the browser would
    const dropEffect = over.defaultPrevented ? 'move' : 'none'
    const src = window.__e2eRowEl
    if (src && src.isConnected) {
      const end = new Event('dragend', { bubbles: true })
      Object.defineProperty(end, 'dataTransfer', { value: { dropEffect, types: [...dt.types] } })
      src.dispatchEvent(end)
    }
    return { accepted: over.defaultPrevented, dropEffect }
  })
}

/** The HTML drag of the last startRowDrag ends without a drop on any target (out of the window, Esc): its dragend. */
export function endRowDrag(page) {
  return page.evaluate(() => {
    const end = new Event('dragend', { bubbles: true })
    Object.defineProperty(end, 'dataTransfer', { value: { dropEffect: 'none', types: [...window.__e2eRowDrag.types] } })
    window.__e2eRowEl.dispatchEvent(end)
  })
}

/**
 * A message row dragged onto a folder: out as files and back onto the folder, or (not all stored here, too many, too
 * big) the HTML drag dropped there. -> { cancelled, drag, accepted }
 */
export async function dragMessageTo(app, page, row, target) {
  const { cancelled, drag } = await startRowDrag(app, row)
  if (!cancelled) return { cancelled, drag, ...(await dropRowDrag(target)) }
  if (!drag) return { cancelled, drag, accepted: false }
  const { accepted } = await dropFiles(page, drag.files, target)
  return { cancelled, drag, accepted }
}
