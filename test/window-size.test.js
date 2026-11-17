// The main window's minimum width keeps the mail view's three panes (sidebar, list, reader on the right) whole: it is at
// least their minimums (read from Mail.jsx, where the dividers use them) plus the mail area's right margin (app.css) plus
// 20 px. A pane minimum or the margin raised without the window's one makes this red. The composer window has no minimum;
// it opens centered on the main window, on the main window's display (composerBounds).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { COMPOSER_SIZE, composerBounds, MAIN_MIN_WIDTH } from '../app/main/window-size.js'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = rel => fs.readFileSync(path.join(repo, rel), 'utf8')

/** The three pane minimums as Mail.jsx uses them; every place that names one of them must agree. */
export function paneMinimums(mail) {
  const one = (re, what) => {
    const m = mail.match(re)
    assert.ok(m, `${what}: not found in Mail.jsx`)
    return Number(m[1])
  }
  const sidebar = one(/<Splitter name="sidebar"[^>]*\bmin=\{(\d+)\}/, 'the sidebar divider min')
  const list = one(/<Splitter name="list"[^>]*\bmin=\{(\d+)\}/, 'the list divider min')
  const reader = one(/const listMax = useCallback\(\(\) => \(panesRef\.current\?\.clientWidth \?\? 0\) - (\d+)/, 'the reader minimum (listMax)')
  // the sidebar's limit with the reader on the right leaves the list and the reader their minimums: the same numbers
  const both = mail.match(/readerPane === 'right' \? (\d+) \+ (\d+) : (\d+)/)
  assert.ok(both, 'the sidebar limit (sidebarMax): not found in Mail.jsx')
  assert.deepEqual([Number(both[1]), Number(both[2]), Number(both[3])], [list, reader, list], 'sidebarMax uses other pane minimums than the dividers')
  return { sidebar, list, reader }
}

/** The mail area's right margin in px: .mail-main's margin (its second value), a theme token resolved. */
export function mailRightMargin(appCss, themeCss) {
  const m = appCss.match(/\.mail-main \{[^}]*?\bmargin: (\S+) (\S+)/)
  assert.ok(m, '.mail-main margin: not found in app.css')
  const v = m[2]
  const px = v.match(/^(\d+)px$/)
  if (px) return Number(px[1])
  const token = v.match(/^var\((--[\w-]+)\)$/)
  assert.ok(token, `.mail-main right margin: unexpected value ${v}`)
  const t = themeCss.match(new RegExp(`${token[1]}: (\\d+)px;`))
  assert.ok(t, `${token[1]}: not found in theme.css`)
  return Number(t[1])
}

test('the main window minimum >= sidebar + list + reader minimums + the right margin + 20 px', () => {
  const { sidebar, list, reader } = paneMinimums(read('app/renderer/src/Mail.jsx'))
  const margin = mailRightMargin(read('app/renderer/src/app.css'), read('app/renderer/src/theme.css'))
  assert.deepEqual({ sidebar, list, reader, margin }, { sidebar: 180, list: 280, reader: 360, margin: 16 })
  const need = sidebar + list + reader + margin + 20
  assert.ok(MAIN_MIN_WIDTH >= need, `${MAIN_MIN_WIDTH} < ${sidebar} + ${list} + ${reader} + ${margin} + 20`)
  assert.equal(MAIN_MIN_WIDTH, 860)
})

test('the minimum is on the main window only; the composer window keeps its size and has none', () => {
  const main = read('app/main/main.js')
  const mainWin = main.slice(main.indexOf('function createWindow()'), main.indexOf('const wc = mainWindow.webContents'))
  assert.match(mainWin, /minWidth: MAIN_MIN_WIDTH,/)
  const composer = main.slice(main.indexOf('function composerPlacement('), main.indexOf('function createWindow()'))
  assert.match(composer, /new BrowserWindow\(\{ \.\.\.composerPlacement\(\), show: false,/)
  assert.doesNotMatch(composer, /minWidth|minHeight|parent:/)
  assert.deepEqual(COMPOSER_SIZE, { width: 900, height: 700 })
  // where it opens: the main window's display, its normal bounds when minimized; the plain size without a main window
  assert.match(composer, /mainWindow\.isMinimized\(\) \? mainWindow\.getNormalBounds\(\) : mainWindow\.getBounds\(\)/)
  assert.match(composer, /composerBounds\(main, screen\.getDisplayMatching\(main\)\.workArea\)/)
  assert.match(composer, /if \(!mainWindow \|\| mainWindow\.isDestroyed\(\)\) return \{ \.\.\.COMPOSER_SIZE \}/)
})

// two displays side by side, the second one LEFT of the primary (negative x), both with a 40 px taskbar at the bottom
const PRIMARY = { x: 0, y: 0, width: 1920, height: 1040 }
const LEFT = { x: -1920, y: 0, width: 1920, height: 1040 }

test('the composer opens centered on the main window, on the main window\'s display', () => {
  // the main window in the middle of the left display: the composer's center is the main window's center
  const main = { x: -1600, y: 150, width: 1100, height: 720 }
  const b = composerBounds(main, LEFT)
  assert.deepEqual(b, { x: -1500, y: 160, width: 900, height: 700 })
  assert.equal(b.x + b.width / 2, main.x + main.width / 2)
  assert.equal(b.y + b.height / 2, main.y + main.height / 2)
  // the same on the primary display
  assert.deepEqual(composerBounds({ x: 400, y: 100, width: 1100, height: 720 }, PRIMARY), { x: 500, y: 110, width: 900, height: 700 })
  // an odd size rounds to a whole pixel
  const odd = composerBounds({ x: 0, y: 0, width: 1101, height: 721 }, PRIMARY)
  assert.ok(Number.isInteger(odd.x) && Number.isInteger(odd.y))
})

test('the composer stays inside the work area: a main window at an edge, smaller than the composer, or a maximized one', () => {
  // a small main window in the left display's top-left corner: the composer is pushed in, not off the screen
  assert.deepEqual(composerBounds({ x: -1920, y: 0, width: 400, height: 300 }, LEFT), { x: -1920, y: 0, width: 900, height: 700 })
  // at the bottom-right corner of the primary: it ends at the work area's edge (above the taskbar)
  assert.deepEqual(composerBounds({ x: 1700, y: 900, width: 220, height: 140 }, PRIMARY), { x: 1020, y: 340, width: 900, height: 700 })
  // a main window half off the display (dragged): still fully on the display
  const half = composerBounds({ x: 1500, y: 600, width: 1100, height: 720 }, PRIMARY)
  assert.ok(half.x >= 0 && half.x + half.width <= 1920 && half.y >= 0 && half.y + half.height <= 1040, JSON.stringify(half))
  // maximized: its bounds are the work area, the composer in the middle of it
  assert.deepEqual(composerBounds(PRIMARY, PRIMARY), { x: 510, y: 170, width: 900, height: 700 })
})

test('a display smaller than the composer: it is shrunk to the work area, at its origin', () => {
  const small = { x: 1920, y: 0, width: 800, height: 560 }
  assert.deepEqual(composerBounds({ x: 1950, y: 20, width: 700, height: 500 }, small), { x: 1920, y: 0, width: 800, height: 560 })
})

test('the check itself: a raised pane minimum or a changed sidebar limit is found', () => {
  const mail = read('app/renderer/src/Mail.jsx')
  const raisedReader = mail.replace('(panesRef.current?.clientWidth ?? 0) - 360', '(panesRef.current?.clientWidth ?? 0) - 400').replace("'right' ? 280 + 360", "'right' ? 280 + 400")
  const r = paneMinimums(raisedReader)
  assert.ok(!(MAIN_MIN_WIDTH >= r.sidebar + r.list + r.reader + 16 + 20))
  const css = read('app/renderer/src/app.css')
  const theme = read('app/renderer/src/theme.css')
  assert.equal(mailRightMargin(css.replace(/(\.mail-main \{[^}]*?\bmargin: \S+ )var\(--space-4\)/, '$1var(--space-6)'), theme.replace(/--space-6: \d+px;/, '--space-6: 48px;')), 48)
  assert.throws(() => paneMinimums(mail.replace('(panesRef.current?.clientWidth ?? 0) - 360', '(panesRef.current?.clientWidth ?? 0) - 400')), /sidebarMax uses other pane minimums/)
  assert.throws(() => paneMinimums(mail.replace('<Splitter name="list"', '<Splitter name="lista"')), /the list divider min: not found/)
})
