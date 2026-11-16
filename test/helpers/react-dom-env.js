// A jsdom page for rendering renderer components in node:test. Call setupDom() before the
// first import of react-dom; render() mounts into a fresh container inside act().
import { JSDOM } from 'jsdom'
import { register } from 'node:module'

let dom = null

export function setupDom() {
  if (dom) return dom
  register('./jsx-loader.mjs', import.meta.url)
  dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' })
  const w = dom.window
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Element', 'Event', 'KeyboardEvent', 'MouseEvent', 'FocusEvent', 'getComputedStyle']) {
    Object.defineProperty(globalThis, key, { value: key === 'window' ? w : w[key], configurable: true, writable: true })
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  return dom
}

export async function mount(element) {
  const { createRoot } = await import('react-dom/client')
  const { act } = await import('react')
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => root.render(element))
  return {
    container,
    rerender: el => act(async () => root.render(el)),
    unmount: async () => {
      await act(async () => root.unmount())
      container.remove()
    },
  }
}

/** Runs fn inside act() (state updates flushed). */
export async function inAct(fn) {
  const { act } = await import('react')
  let out
  await act(async () => {
    out = await fn()
  })
  return out
}

export function key(el, k, extra = {}) {
  el.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }))
}
