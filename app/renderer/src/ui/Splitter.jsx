// SPDX-License-Identifier: GPL-3.0-or-later
// A draggable divider between two panes. One component for every split
// view. The size lives in a CSS variable on the document root (e.g. --list-w), so the grid that uses it (and anything
// else following it, like the header's first column for --sidebar-w) moves together; while dragging only that variable
// changes (once per animation frame), the pref (prefs.js, `split.<name>`) is written when the drag ends.
// - Mouse / pen / touch: pointer events with setPointerCapture; while dragging the page has the `splitting` class (no text
//   selection, the resize cursor everywhere).
// - Keyboard: role="separator", aria-orientation, aria-valuenow/min/max, Tab reaches it, the arrows move it 16 px, Home
//   (and a double click) gives back the default: the variable and the pref are removed, the stylesheet's layout returns.
// - The size is clamped between `min` and `max()` (the caller's max keeps the other pane's minimum): on load, on every move,
//   when the window is resized and when the `observe` element (the panes' container) changes size, e.g. because another
//   divider (the sidebar) moved or the sidebar was folded. The saved value stays; more room gets it back.
// - Every size falls between `min` and `max()`, a saved one or the stylesheet's default: without a saved size the default
//   is measured and, only when it does not fit, the variable holds the clamped size. That is display only: nothing is
//   saved, and when the default fits again (a wider window) the variable goes and the stylesheet's default returns.
// While a size is set the root has the data-split-<name> attribute, so the stylesheet can switch from its default (often
// fractional) tracks to the variable.
import { useCallback, useEffect, useRef, useState } from 'react'
import { getPref, setPref } from '../prefs.js'

export const SPLIT_STEP = 16

const root = () => document.documentElement
// one frame later (the page always has it; a test DOM may not)
const raf = fn => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(fn, 16))
const caf = id => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(id) : clearTimeout(id))

function applySize(cssVar, name, px) {
  root().style.setProperty(cssVar, `${px}px`)
  root().setAttribute(`data-split-${name}`, '')
}

function clearSize(cssVar, name) {
  root().style.removeProperty(cssVar)
  root().removeAttribute(`data-split-${name}`)
}

/**
 * @param name         the pref key's end (`split.<name>`) and the data-split-<name> attribute
 * @param cssVar       the CSS variable it sets on the root (e.g. '--list-w')
 * @param orientation  'vertical' (a vertical line, the width changes, col-resize) or 'horizontal' (the height, row-resize)
 * @param label        the accessible name (hu.js)
 * @param min          the pane's smallest size, px
 * @param max          () => the largest size now, px (the other pane's minimum kept)
 * @param measure      () => the pane's size now, px (the start of a drag and aria-valuenow when no size is set)
 * @param observe      optional ref of the container whose size changes call for a re-fit (ResizeObserver)
 */
export function Splitter({ name, cssVar, orientation = 'vertical', label, min, max, measure, observe, className }) {
  const key = `split.${name}`
  const saved = useRef(null) // the saved size (not the clamped one)
  const drag = useRef(null)
  const frame = useRef(0)
  const [now, setNow] = useState(null)
  const [hi, setHi] = useState(min)

  const bounds = useCallback(() => {
    const top = Math.max(min, Math.floor(max()))
    return [min, top]
  }, [min, max])
  const clamp = useCallback(
    v => {
      const [lo, top] = bounds()
      return Math.round(Math.min(top, Math.max(lo, v)))
    },
    [bounds],
  )
  const refresh = useCallback(() => {
    setHi(bounds()[1])
    const m = measure()
    if (Number.isFinite(m)) setNow(Math.round(m))
  }, [bounds, measure])
  const set = useCallback(
    px => {
      applySize(cssVar, name, px)
      caf(frame.current)
      frame.current = raf(refresh)
    },
    [cssVar, name, refresh],
  )

  // the size between min and max(): the saved one clamped, or without one the stylesheet's default, clamped only when it
  // does not fit (display only, nothing is saved; with room again the default returns)
  const fit = useCallback(() => {
    if (saved.current !== null) applySize(cssVar, name, clamp(saved.current))
    else {
      clearSize(cssVar, name)
      const d = measure()
      if (Number.isFinite(d) && d > 0) {
        const c = clamp(d)
        if (Math.abs(c - d) >= 1) applySize(cssVar, name, c)
      }
    }
    refresh()
  }, [cssVar, name, clamp, measure, refresh])

  // load: the saved size or the default, clamped; and again on every window resize
  useEffect(() => {
    const v = getPref(key, null)
    saved.current = Number.isFinite(v) && v > 0 ? v : null
    fit()
    let pending = 0
    const onResize = () => {
      caf(pending)
      pending = raf(fit)
    }
    window.addEventListener('resize', onResize)
    // the container changes without a window resize when another divider moves or the sidebar folds
    const box = observe?.current
    const ro = box && typeof ResizeObserver === 'function' ? new ResizeObserver(onResize) : null
    ro?.observe(box)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', onResize)
      caf(pending)
      caf(frame.current)
    }
  }, [key, fit, observe])

  const commit = px => {
    saved.current = px
    setPref(key, px)
  }
  const reset = () => {
    saved.current = null
    setPref(key, null)
    clearSize(cssVar, name)
    caf(frame.current)
    // the default, clamped when it does not fit
    frame.current = raf(fit)
  }
  const along = e => (orientation === 'vertical' ? e.clientX : e.clientY)

  const onPointerDown = e => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    drag.current = { from: along(e), size: measure(), last: null }
    root().classList.add('splitting', orientation === 'vertical' ? 'splitting-col' : 'splitting-row')
  }
  const onPointerMove = e => {
    const d = drag.current
    if (!d) return
    e.preventDefault()
    d.last = clamp(d.size + along(e) - d.from)
    const px = d.last
    caf(frame.current)
    frame.current = raf(() => {
      applySize(cssVar, name, px)
      refresh()
    })
  }
  const end = e => {
    const d = drag.current
    if (!d) return
    drag.current = null
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    root().classList.remove('splitting', 'splitting-col', 'splitting-row')
    if (d.last !== null) {
      set(d.last)
      commit(d.last)
    }
  }
  const onKeyDown = e => {
    const less = orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp'
    const more = orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown'
    if (e.key === less || e.key === more) {
      e.preventDefault()
      // the last set size (now may be a frame behind on fast key repeats), else the pane as it is
      const base = saved.current !== null ? clamp(saved.current) : measure()
      const px = clamp(base + (e.key === more ? SPLIT_STEP : -SPLIT_STEP))
      set(px)
      commit(px)
    } else if (e.key === 'Home') {
      e.preventDefault()
      reset()
    }
  }

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation={orientation}
      aria-label={label}
      title={label}
      aria-valuemin={min}
      aria-valuemax={hi}
      aria-valuenow={now ?? undefined}
      data-split={name}
      className={`splitter splitter-${orientation}${className ? ` ${className}` : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={reset}
      onKeyDown={onKeyDown}
      // a drag on the divider is not a drag of a message (the list's drag-and-drop)
      onDragStart={e => e.preventDefault()}
    />
  )
}
