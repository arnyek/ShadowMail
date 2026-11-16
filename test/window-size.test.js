// The main window's minimum width keeps the mail view's three panes (sidebar, list, reader on the right) whole: it is at
// least their minimums (read from Mail.jsx, where the dividers use them) plus the mail area's right margin (app.css) plus
// 20 px. A pane minimum or the margin raised without the window's one makes this red. The composer window has no minimum.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MAIN_MIN_WIDTH } from '../app/main/window-size.js'

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
  const composer = main.slice(main.indexOf('function createComposerWindow('), main.indexOf('function createWindow()'))
  assert.match(composer, /new BrowserWindow\(\{ width: 900, height: 700, show: false,/)
  assert.doesNotMatch(composer, /minWidth|minHeight/)
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
