// theme.css contrast, for EVERY theme of themes.js: every text/background token pair at least 4.5:1 (WCAG AA),
// icons on their backgrounds at least 3:1. Computed from the file itself (the :root tokens, then the theme's
// [data-theme="<id>"] overrides; var() resolved, rgba composited over the background it sits on). Disabled text is
// exempt (WCAG 1.4.3).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { THEMES } from '../app/renderer/src/themes.js'
import { viewDocument } from '../app/main/protocols.js'
import { LABEL_PALETTE, chipTextColor } from '../app/renderer/src/label-chips.js'

const css = fs.readFileSync(new URL('../app/renderer/src/theme.css', import.meta.url), 'utf8')

/** The declarations of every rule whose selector matches, in file order. */
function blocks(text, selector) {
  const out = []
  const plain = text.replace(/\/\*[\s\S]*?\*\//g, '') // comments are not selectors
  for (const m of plain.matchAll(/([^{}]+)\{([^{}]*)\}/g)) if (selector(m[1].trim())) out.push(m[2])
  return out
}
/** The tokens of a theme: :root, then its [data-theme="<id>"] overrides. */
export function themeTokens(text, id) {
  const out = {}
  const take = body => {
    for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim()
  }
  blocks(text, sel => sel === ':root').forEach(take)
  blocks(text, sel => sel.split(',').some(s => s.trim().replace(/^:root/, '') === `[data-theme="${id}"]`)).forEach(take)
  return out
}
let T = themeTokens(css, 'default')

function resolve(name, seen = new Set()) {
  if (seen.has(name)) throw new Error(`cycle at ${name}`)
  seen.add(name)
  const raw = T[name]
  if (raw === undefined) throw new Error(`no token ${name}`)
  const ref = /^var\((--[\w-]+)\)$/.exec(raw)
  return ref ? resolve(ref[1], seen) : raw
}

/** -> [r, g, b, a] (0..255, a 0..1) */
function parseColor(v) {
  let m = /^#([0-9a-f]{6})$/i.exec(v)
  if (m) return [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16)).concat(1)
  m = /^#([0-9a-f]{3})$/i.exec(v)
  if (m) return [...m[1]].map(c => parseInt(c + c, 16)).concat(1)
  m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(v)
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])]
  throw new Error(`not a color: ${v}`)
}

/** A color token, composited over the given layers (bottom first) when it is translucent. */
function solid(name, ...under) {
  const [r, g, b, a] = parseColor(resolve(name))
  if (a >= 1) return [r, g, b]
  if (!under.length) throw new Error(`${name} is translucent: give the background under it`)
  const base = solid(...under)
  return [r, g, b].map((c, i) => c * a + base[i] * (1 - a))
}

function luminance([r, g, b]) {
  const lin = c => {
    c /= 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

export function contrast(fg, bg) {
  const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x)
  return (a + 0.05) / (b + 0.05)
}

// [foreground, background (layers, top first)]
const TEXT_PAIRS = [
  ['--c-text', ['--c-bg']],
  ['--c-text', ['--c-surface']],
  ['--c-text', ['--c-surface-2']],
  ['--c-text', ['--c-hover']],
  ['--c-text', ['--c-info-bg']],
  ['--c-text', ['--c-highlight']],
  ['--c-text', ['--c-accent-soft', '--c-surface']], // tonal "Új levél" button on the sidebar
  ['--c-text', ['--c-accent-soft-hover', '--c-surface']],
  ['--c-text', ['--c-accent-soft', '--c-bg']],
  ['--c-text-2', ['--c-bg']],
  ['--c-text-2', ['--c-surface']],
  ['--c-text-2', ['--c-surface-2']],
  ['--c-text-2', ['--c-hover']],
  ['--c-accent', ['--c-bg']],
  ['--c-accent', ['--c-surface']],
  ['--c-accent', ['--c-surface-2']],
  ['--c-accent-hover', ['--c-accent-soft', '--c-bg']], // a text button on hover
  // the "Elsődleges" (primary) tag in the contact details card: --c-accent-hover, the mockup's --c-accent measured
  // 4.37:1 (default) and 4.48:1 (graphite)
  ['--c-accent-hover', ['--c-accent-soft', '--c-bg']],
  ['--c-on-accent', ['--c-accent']],
  ['--c-on-accent', ['--c-accent-hover']],
  ['--c-on-accent', ['--c-danger']],
  ['--c-on-accent', ['--c-danger-hover']],
  ['--c-danger', ['--c-bg']],
  ['--c-danger', ['--c-danger-bg']],
  ['--c-warning-text', ['--c-warning-bg']],
  ['--c-warning-text', ['--c-bg']],
  ['--c-success', ['--c-bg']],
  ['--c-success', ['--c-surface']],
  ...Array.from({ length: 8 }, (_, i) => ['--c-on-accent', [`--c-avatar-${i + 1}`]]),
]

const ICON_PAIRS = [
  ['--c-text-2', ['--c-bg']],
  ['--c-text-2', ['--c-surface']],
  ['--c-text-2', ['--c-surface-2']],
  ['--c-text-2', ['--c-hover']],
  ['--c-accent', ['--c-bg']],
  ['--c-accent', ['--c-surface-2']],
  ['--c-star', ['--c-bg']],
  ['--c-star', ['--c-surface-2']],
  ['--c-star', ['--c-hover']],
  ['--c-danger', ['--c-bg']],
  // the Checkbox switch (ui/ui.css): the track off is --c-text-2 (the pair above; --c-border-strong measured only
  // 1.7-2.7:1), the knob on the track off and on
  ['--c-bg', ['--c-text-2']],
  ['--c-bg', ['--c-accent']],
]

const ratio = ([fg, bg]) => contrast(solid(fg, ...bg.slice(1)), solid(...bg))

/** The pairs under the limits for one token set: text below 4.5:1, icons below 3:1. */
export function weakPairs(tokens, { text = TEXT_PAIRS, icons = ICON_PAIRS } = {}) {
  const keep = T
  T = tokens
  try {
    const say = (p, r) => `${p[0]} on ${p[1].join(' over ')}: ${r.toFixed(2)}`
    return [
      ...text.map(p => [p, ratio(p)]).filter(([, r]) => r < 4.5).map(([p, r]) => `text ${say(p, r)}`),
      ...icons.map(p => [p, ratio(p)]).filter(([, r]) => r < 3).map(([p, r]) => `icon ${say(p, r)}`),
    ]
  } finally {
    T = keep
  }
}

// The header band: a theme may give it its own tokens on [data-theme="<id>"] .app-header (the classic blue band), and
// the search field in it its own again. What sits there: the brand and icon buttons (text, text-2; hover; pressed:
// accent on surface-2), the search field (text and the placeholder/icons on its surface-2, and on bg when focused).
const HEADER_TEXT = [['--c-text', ['--c-surface']], ['--c-text', ['--c-hover']]]
const HEADER_ICONS = [['--c-text-2', ['--c-surface']], ['--c-text-2', ['--c-hover']], ['--c-text', ['--c-hover']], ['--c-accent', ['--c-surface-2']]]
const SEARCH_TEXT = [['--c-text', ['--c-surface-2']], ['--c-text', ['--c-bg']], ['--c-text-2', ['--c-surface-2']], ['--c-text-2', ['--c-bg']]]
const SEARCH_ICONS = [['--c-text-2', ['--c-surface-2']], ['--c-text-2', ['--c-bg']]]
/** A theme's tokens inside a region: the theme's, then each region's [data-theme="<id>"] <region> overrides in turn. */
export function regionTokens(text, id, regions) {
  const out = { ...themeTokens(text, id) }
  for (const region of regions) {
    for (const body of blocks(text, sel => sel.split(',').some(x => x.trim() === `[data-theme="${id}"] ${region}`))) {
      for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim()
    }
  }
  return out
}

for (const theme of THEMES) {
  test(`theme ${theme.id}: the header band and its search field, text 4.5:1 and icons 3:1`, () => {
    assert.deepEqual(weakPairs(regionTokens(css, theme.id, ['.app-header']), { text: HEADER_TEXT, icons: HEADER_ICONS }), [])
    assert.deepEqual(weakPairs(regionTokens(css, theme.id, ['.app-header', '.app-header .search-field']), { text: SEARCH_TEXT, icons: SEARCH_ICONS }), [])
  })
}

for (const theme of THEMES) {
  test(`theme ${theme.id}: every text pair at least 4.5:1, every icon pair at least 3:1`, () => {
    assert.deepEqual(weakPairs(themeTokens(css, theme.id)), [])
  })
}

// 0.17.0 labels: a chip's background is the label's own color (the same in every theme), its text black or white by
// label-chips.js; measured here with this file's own contrast, in every theme (the chip does not take a theme token),
// for the 12 offered colors and two custom ones. The "+N" next to the chips is --c-text-2 on the row: in TEXT_PAIRS.
const hexRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16))
for (const theme of THEMES) {
  test(`theme ${theme.id}: every label chip's text at least 4.5:1 (the 12 offered colors, #ffff00, #000080)`, () => {
    const weak = [...LABEL_PALETTE, '#ffff00', '#000080']
      .map(bg => [bg, contrast(hexRgb(chipTextColor(bg)), hexRgb(bg))])
      .filter(([, c]) => c < 4.5)
      .map(([bg, c]) => `${bg}: ${c.toFixed(2)}`)
    assert.deepEqual(weak, [])
  })
}

// the dot form of a chip (a narrow text cell, app.css @container msg-text < 240px): 8 px of the label's color; its ring
// token is read from app.css itself. WCAG 1.4.11: the fill OR the ring at least 3:1 against the row it sits on, the plain
// row (--c-bg) and the selected one (--c-surface-2), in every theme
const appCss = fs.readFileSync(new URL('../app/renderer/src/app.css', import.meta.url), 'utf8')
export function dotRing(text) {
  const at = text.indexOf('@container msg-text (width < 240px)')
  if (at < 0) return null
  const rule = /\.label-chips \.label-chip\s*\{([^}]*)\}/.exec(text.slice(at))
  const ring = rule && /box-shadow:\s*inset 0 0 0 1px var\((--[\w-]+)\)\s*;/.exec(rule[1])
  return ring ? ring[1] : null
}
export function weakDots(tokens, ring, colors = [...LABEL_PALETTE, '#ffff00', '#000080']) {
  T = tokens
  const out = []
  for (const bgName of ['--c-bg', '--c-surface-2']) {
    const bg = solid(bgName, '--c-bg')
    for (const c of colors) {
      const fill = contrast(hexRgb(c), bg)
      const edge = ring ? contrast(solid(ring, bgName, '--c-bg'), bg) : 0
      if (Math.max(fill, edge) < 3) out.push(`${c} on ${bgName}: fill ${fill.toFixed(2)}, ring ${edge.toFixed(2)}`)
    }
  }
  T = themeTokens(css, 'default')
  return out
}
for (const theme of THEMES) {
  test(`theme ${theme.id}: every label dot stands out from the plain and the selected row at 3:1 (fill or ring)`, () => {
    assert.equal(dotRing(appCss), '--c-text-2', 'the dot has its ring')
    assert.deepEqual(weakDots(themeTokens(css, theme.id), dotRing(appCss)), [])
  })
}
test('the dot check catches a missing ring, and a ring in the chip\'s text color (black / white): both leave weak dots', () => {
  const noRing = appCss.replace('box-shadow: inset 0 0 0 1px var(--c-text-2);', '')
  assert.equal(dotRing(noRing), null)
  assert.ok(weakDots(themeTokens(css, 'default'), null).some(w => w.startsWith('#fbc02d on --c-bg')))
  assert.ok(weakDots(themeTokens(css, 'dark'), null).some(w => w.startsWith('#3949ab on --c-bg')))
  // the first try: a ring of black on a dark row for a mid-tone (teal, green), measured weak
  const textRing = appCss.replace('box-shadow: inset 0 0 0 1px var(--c-text-2);', 'box-shadow: inset 0 0 0 1px var(--probe-ring);')
  assert.equal(dotRing(textRing), '--probe-ring')
  const probe = `${css}\n[data-theme="dark"] { --probe-ring: #000000; }\n`
  assert.ok(weakDots(themeTokens(probe, 'dark'), dotRing(textRing)).some(w => w.startsWith('#00897b')))
})

test('the check catches a weak pair in a theme (a probe theme on top of theme.css)', () => {
  const probe = `${css}\n[data-theme="probe"] { --c-text-2: #c0c0c0; --c-star: #fff3c4; }\n`
  const weak = weakPairs(themeTokens(probe, 'probe'))
  assert.ok(weak.some(w => w.startsWith('text --c-text-2 on --c-bg')), weak.join(' | '))
  assert.ok(weak.some(w => w.startsWith('icon --c-star on --c-bg')), weak.join(' | '))
  assert.deepEqual(weakPairs(themeTokens(probe, 'default')), [], 'another theme is not touched by the probe')
})

test('the measure itself: known values', () => {
  assert.equal(contrast([0, 0, 0], [255, 255, 255]).toFixed(1), '21.0')
  assert.equal(contrast([255, 255, 255], [255, 255, 255]), 1)
  // #767676 on white is the classic 4.54:1 boundary
  assert.equal(contrast(parseColor('#767676').slice(0, 3), [255, 255, 255]).toFixed(2), '4.54')
  assert.equal(resolve('--c-accent'), '#2563eb', 'the accent')
  assert.equal(resolve('--row-h'), '40px', 'the row height')
})

test('every color token of theme.css is checked in some pair (or explicitly exempt)', () => {
  const EXEMPT = new Set(['--c-border', '--c-border-strong', '--c-backdrop', '--c-text-disabled', '--c-warning-border', ...THEME_INDEPENDENT])
  const used = new Set([...TEXT_PAIRS, ...ICON_PAIRS].flatMap(([fg, bg]) => [fg, ...bg]))
  const colors = Object.keys(T).filter(k => k.startsWith('--c-'))
  assert.deepEqual(colors.filter(k => !used.has(k) && !EXEMPT.has(k)), [])
})

// the message frame's background: light in every theme (the message keeps its own colors), never overridden
const THEME_INDEPENDENT = ['--c-mail-bg']
const overrides = id => {
  const out = new Set()
  for (const body of blocks(css, sel => sel.split(',').some(x => x.trim().replace(/^:root/, '') === `[data-theme="${id}"]`))) {
    for (const m of body.matchAll(/(--[\w-]+)\s*:/g)) out.add(m[1])
  }
  return out
}

// a dark scheme (color-scheme: dark in its block) redraws everything; a light one may keep the default's tokens
const darkScheme = id => blocks(css, sel => sel.split(',').some(x => x.trim() === `[data-theme="${id}"]`)).some(b => /color-scheme:\s*dark/.test(b))

test('every dark theme overrides every color token and both shadows; no theme overrides the message frame', () => {
  const colors = Object.keys(themeTokens(css, 'default')).filter(k => k.startsWith('--c-') || k.startsWith('--shadow-'))
  for (const theme of THEMES.filter(x => x.id !== 'default')) {
    if (!darkScheme(theme.id)) {
      assert.deepEqual(THEME_INDEPENDENT.filter(k => overrides(theme.id).has(k)), [], `${theme.id}: overrides a theme-independent token`)
      continue
    }
    const own = overrides(theme.id)
    assert.deepEqual(colors.filter(k => !THEME_INDEPENDENT.includes(k) && !own.has(k)), [], `${theme.id}: not overridden`)
    assert.deepEqual(THEME_INDEPENDENT.filter(k => own.has(k)), [], `${theme.id}: overrides a theme-independent token`)
    assert.equal(themeTokens(css, theme.id)['--c-mail-bg'], '#ffffff')
  }
  assert.deepEqual(THEMES.filter(x => darkScheme(x.id)).map(x => x.id), ['dark', 'graphite'])
})

/** CIELAB lightness L* (0..100) of a color token of a theme, with the sRGB white point. */
function lightness(tokens, name) {
  const keep = T
  T = tokens
  try {
    const y = luminance(solid(name))
    return 116 * (y > 216 / 24389 ? Math.cbrt(y) : ((24389 / 27) * y + 16) / 116) - 16
  } finally {
    T = keep
  }
}

test('graphite lies between the dark and the default theme: --c-bg and --c-surface, at least 10 L* lighter than dark', () => {
  const at = id => themeTokens(css, id)
  for (const name of ['--c-bg', '--c-surface']) {
    const [g, d, l] = ['graphite', 'dark', 'default'].map(id => lightness(at(id), name))
    assert.ok(g > d && g < l, `${name}: graphite ${g.toFixed(1)}, dark ${d.toFixed(1)}, default ${l.toFixed(1)}`)
    assert.ok(g - d >= 10, `${name}: graphite ${g.toFixed(1)} is not 10 L* lighter than dark ${d.toFixed(1)}`)
  }
  assert.equal(Math.round(lightness({ '--x': '#ffffff' }, '--x')), 100)
  assert.equal(Math.round(lightness({ '--x': '#000000' }, '--x')), 0)
  assert.equal(lightness({ '--x': '#777777' }, '--x').toFixed(1), '50.0') // a mid gray: L* 50.0 (sRGB 119 = Y 0.1845)
})

test('a message keeps its own light page under every theme: the reader frame and the message document are light', () => {
  const app = fs.readFileSync(new URL('../app/renderer/src/app.css', import.meta.url), 'utf8')
  const frame = blocks(app, sel => sel === '.mail-frame').join('')
  assert.match(frame, /background:\s*var\(--c-mail-bg\);/, 'the frame element sits on the theme-independent token')
  const doc = viewDocument('<p>x</p>', false)
  assert.match(doc, /html\{color-scheme:light\}/, 'the message document says it is light')
  assert.match(doc, /body\{[^}]*background:#fff[;}]/, 'and paints its own white page')
})
