#!/usr/bin/env node
// The whole-app UI audit, headless Electron + Playwright. Not part
// of `npm test`.
//
//   node test/e2e/ui-audit-e2e.mjs
//
// One round over every screen per theme of themes.js (scripts/ui-screenshots.mjs --strict [--theme <id>] into a temporary folder: lock,
// list, folded sidebar, selection, hover, search with chips, context menu, folder dialog, the folder and account menus, delete
// confirmation, reader, composer, every settings tab, the account editor, first start, recovery
// code), and per screen: no unstyled native control (`button:not([class]), select`), no icon button
// without aria-label or title; for the round: no renderer console error/warning, no main-process
// stderr, an empty net-guard log. Statically: no raw hex color outside theme.css in app/renderer (a CSS attribute
// selector's value is a matched value, not a painted colour: the "Automatic" marker's selector is checked against
// text-colors.js AUTO_COLOR instead).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { THEMES, DEFAULT_THEME } from '../../app/renderer/src/themes.js'
import { AUTO_COLOR } from '../../core/smtp/text-colors.js'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}

// every theme of themes.js: the same round under each (the default without a pref, as before)
for (const theme of THEMES) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-audit-'))
  const args = [path.join(repo, 'scripts', 'ui-screenshots.mjs'), 'audit', '--out', out, '--strict', ...(theme.id === DEFAULT_THEME ? [] : ['--theme', theme.id])]
  const run = spawnSync(process.execPath, args, { cwd: repo, encoding: 'utf8', timeout: 300_000 })
  const text = `${run.stdout || ''}${run.stderr || ''}`
  const screens = [...text.matchAll(/^ {2}([\w-]+): native controls (\d+), icon buttons without aria-label (\d+), without title (\d+), theme (\S+)$/gm)].map(m => ({ name: m[1], native: +m[2], unnamed: +m[3], untitled: +m[4], theme: m[5] }))
  const EXPECTED = ['unlock', 'list', 'collapsed', 'selected', 'hover', 'chips', 'context-menu', 'folder-dialog', 'folder-menu', 'account-menu', 'confirm-dialog', 'reader', 'reader-plain', 'compose', 'settings', 'settings-security', 'settings-about', 'settings-appearance', 'settings-labels', 'account-editor', 'account-editor-bottom', 'create', 'recovery-code']
  const at = `[${theme.id}] `
  check(`${at}every screen was reached`, EXPECTED.every(n => screens.some(s => s.name === n)), EXPECTED.filter(n => !screens.some(s => s.name === n)).join(', ') || `${screens.length} screens`)
  check(`${at}every screen is under the theme (the composer window too)`, screens.length > 0 && screens.every(s => s.theme === theme.id), screens.filter(s => s.theme !== theme.id).map(s => `${s.name}=${s.theme}`).join(', '))
  for (const s of screens) check(`${at}${s.name}: no native control, every icon button named and titled`, !s.native && !s.unnamed && !s.untitled, JSON.stringify(s))
  check(`${at}no renderer console error or warning`, /renderer console errors\/warnings: 0\b/.test(text))
  check(`${at}no main-process stderr`, /main process stderr lines: 0\b/.test(text))
  check(`${at}net-guard log: no outgoing request`, /net-guard log lines: 0\b/.test(text))
  check(`${at}no failed screen step`, !/^FAIL /m.test(text), (text.match(/^FAIL .*/gm) || []).join(' | '))
  check(`${at}the audit run ended cleanly`, run.status === 0, `exit ${run.status}`)
  fs.rmSync(out, { recursive: true, force: true })
}

// raw hex colors: only theme.css may have them. label-chips.js holds the offered LABEL colors (data a label stores as
// #rrggbb, chosen by the user, not a color of the interface) and the black / white of the chip text: exempt by name.
// In a CSS file the value of an attribute selector (`font[color="#010203" i]`) is what the rule matches, not a colour it
// paints: left out of this check.
const HEX_EXEMPT = new Set(['theme.css', 'label-chips.js'])
const ATTR_SELECTOR_VALUE = /\[\s*[\w-]+\s*[~|^$*]?=\s*(?:"[^"\n]*"|'[^'\n]*')\s*[is]?\s*\]/g
const hex = []
const walk = dir => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else if (/\.(css|jsx?)$/.test(e.name) && !HEX_EXEMPT.has(e.name)) {
      let text = fs.readFileSync(p, 'utf8')
      if (e.name.endsWith('.css')) text = text.replace(ATTR_SELECTOR_VALUE, '[]')
      if (/#[0-9a-fA-F]{3,6}\b/.test(text)) hex.push(path.relative(repo, p))
    }
  }
}
walk(path.join(repo, 'app', 'renderer'))
check('no raw hex color outside theme.css', hex.length === 0, hex.join(', '))
// the editor's "Automatic" rule matches the marker the editor writes, and paints nothing of its own
const css = fs.readFileSync(path.join(repo, 'app', 'renderer', 'src', 'app.css'), 'utf8')
const autoRule = css.match(/\.editor font\[color="(#[0-9a-fA-F]{6})" i\]\s*\{([^}]*)\}/)
check('the editor\'s Automatic rule: the marker of text-colors.js, shown in the colour around it', autoRule && autoRule[1].toLowerCase() === AUTO_COLOR && autoRule[2].trim() === 'color: inherit;', autoRule ? `${autoRule[1]} { ${autoRule[2].trim()} }` : 'no rule')

console.log(`\n${results.filter(Boolean).length} / ${results.length} OK`)
process.exit(results.every(Boolean) ? 0 : 1)
