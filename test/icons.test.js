// The icon set: Lucide only through Icon.jsx, every name of the plan's list
// renders the planned glyph, and lucide-react is a dev dependency (Vite compiles the used icons
// into the bundle; as a runtime dependency electron-builder would pack the whole 39 MB package).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setupDom, mount } from './helpers/react-dom-env.js'

setupDom()
const { createElement: h } = await import('react')
const { Icon, ICONS } = await import('../app/renderer/src/Icon.jsx')

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// role -> Lucide glyph (its kebab-case name is the class Lucide puts on the <svg>)
const PLAN = {
  compose: 'pencil', inbox: 'inbox', starred: 'star', sent: 'send', drafts: 'file', trash: 'trash-2', junk: 'octagon-alert',
  archive: 'archive', folder: 'folder', refresh: 'rotate-cw', checkbox: 'square', checkboxChecked: 'square-check',
  markRead: 'mail-open', markUnread: 'mail', move: 'folder-input', more: 'ellipsis-vertical', attachment: 'paperclip',
  reply: 'reply', replyAll: 'reply-all', forward: 'forward', back: 'arrow-left', search: 'search', filters: 'sliders-horizontal',
  lock: 'lock', settings: 'settings', account: 'user-round', download: 'download', open: 'external-link', images: 'image',
  close: 'x', send: 'send', bold: 'bold', italic: 'italic', underline: 'underline', list: 'list', listOrdered: 'list-ordered', link: 'link',
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]))
}

test('only Icon.jsx imports lucide-react', () => {
  const importers = walk(path.join(repo, 'app'))
    .filter(f => /\.(jsx?|mjs|cjs)$/.test(f))
    .filter(f => /from\s+['"]lucide-react|require\(\s*['"]lucide-react|import\(\s*['"]lucide-react/.test(fs.readFileSync(f, 'utf8')))
    .map(f => path.relative(repo, f).split(path.sep).join('/'))
  assert.deepEqual(importers, ['app/renderer/src/Icon.jsx'])
})

test('every name of the plan list renders its Lucide glyph, decorative by default', async t => {
  const names = Object.keys(PLAN)
  for (const n of names) assert.ok(ICONS[n], `missing icon role: ${n}`)
  const v = await mount(h('div', null, names.map(n => h(Icon, { key: n, name: n }))))
  t.after(v.unmount)
  const svgs = [...v.container.querySelectorAll('svg')]
  assert.equal(svgs.length, names.length)
  svgs.forEach((svg, i) => {
    const n = names[i]
    assert.ok(svg.classList.contains(`lucide-${PLAN[n]}`), `${n}: expected lucide-${PLAN[n]}, got "${svg.getAttribute('class')}"`)
    assert.ok(svg.classList.contains('icon') && svg.classList.contains('icon-s'))
    assert.equal(svg.getAttribute('aria-hidden'), 'true')
    assert.ok(svg.querySelector('path, line, rect, circle, polyline, polygon'), `${n}: empty svg`)
  })
})

test('every other role renders too; a label makes it an image; an unknown name throws', async t => {
  const v = await mount(h('div', null, Object.keys(ICONS).map(n => h(Icon, { key: n, name: n, size: 'm' }))))
  t.after(v.unmount)
  assert.equal(v.container.querySelectorAll('svg.icon-m').length, Object.keys(ICONS).length)
  const w = await mount(h(Icon, { name: 'attachment', label: 'Van melléklet' }))
  t.after(w.unmount)
  const svg = w.container.querySelector('svg')
  assert.equal(svg.getAttribute('role'), 'img')
  assert.equal(svg.getAttribute('aria-label'), 'Van melléklet')
  assert.equal(svg.hasAttribute('aria-hidden'), false)
  assert.throws(() => Icon({ name: 'gmail' }), /unknown icon/)
})

test('lucide-react is a pinned dev dependency', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'))
  assert.equal(pkg.dependencies['lucide-react'], undefined)
  assert.match(pkg.devDependencies['lucide-react'] || '', /^\d+\.\d+\.\d+$/)
})
