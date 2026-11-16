// The READMEs: every relative link and image points to an existing file, the English and the Hungarian README have
// the same sections in the same order, and the screenshots stay small.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8')
const DOCS = ['README.md', 'README.hu.md', 'CONTRIBUTING.md']

// markdown links and images outside code blocks: [text](target) and ![alt](target)
export function links (md) {
  const text = md.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')
  return [...text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => m[1])
}
const headings = (md) => md.replace(/```[\s\S]*?```/g, '').split('\n').filter((l) => /^#{1,6} /.test(l)).map((l) => l.match(/^#+/)[0].length)

test('readme: every relative link and image of the docs points to an existing file', () => {
  const missing = []
  for (const doc of DOCS) {
    for (const target of links(read(doc))) {
      if (/^(https?:|mailto:|#)/.test(target)) continue
      if (!fs.existsSync(path.join(root, target.split('#')[0]))) missing.push(`${doc}: ${target}`)
    }
  }
  assert.deepEqual(missing, [])
})

test('readme: the English and the Hungarian README have the same sections, in the same order, and link to each other', () => {
  const en = read('README.md')
  const hu = read('README.hu.md')
  assert.deepEqual(headings(hu), headings(en))
  assert.ok(headings(en).length >= 10)
  assert.ok(links(en).includes('README.hu.md'))
  assert.ok(links(hu).includes('README.md'))
  // the same screens, in the same order: the English README shows the English interface (readme-en-*.png), the
  // Hungarian one the Hungarian (readme-*.png)
  const images = (md) => [...md.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => m[1])
  assert.ok(images(en).length >= 8 && images(en).every((i) => /\/readme-en-[\w-]+\.png$/.test(i)), JSON.stringify(images(en)))
  assert.ok(images(hu).every((i) => !/\/readme-en-/.test(i)), JSON.stringify(images(hu)))
  assert.deepEqual(images(hu), images(en).map((i) => i.replace('/readme-en-', '/readme-')))
})

test('readme: the screenshots are in docs/screenshots, each at most 300 KB, at most 3 MB in all, and every one is used', () => {
  const dir = path.join(root, 'docs', 'screenshots')
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.png'))
  assert.ok(files.length >= 8)
  const sizes = files.map((f) => fs.statSync(path.join(dir, f)).size)
  assert.ok(sizes.every((s) => s <= 300 * 1024), JSON.stringify(sizes))
  assert.ok(sizes.reduce((a, b) => a + b, 0) <= 3 * 1024 * 1024)
  const used = new Set([...links(read('README.md')), ...links(read('README.hu.md'))])
  assert.deepEqual(files.filter((f) => !used.has(`docs/screenshots/${f}`)), [])
})
