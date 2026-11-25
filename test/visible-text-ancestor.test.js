// The ancestor-keyed rule index of the visible-text cascade: a rule whose subject has no id and no class (".c td.x > a")
// is looked at only by the elements whose ancestors carry the rule's rarest ancestor id or class. The index only skips
// rules that cannot match, so the output is byte for byte the old code's: both are run here without the work ceiling
// and with clocks that never move (the old code from git, the code before the index; both copied outside the repo).
// The newsletter fixture is no longer complex; the complex case (all rules in one class list) still is.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { visibleTextInfo, MAX_MATCH_WORK, TIME_LIMIT_MS } from '../core/mime/visible-text.js'
import { prepareQuote, preparePaste } from '../core/mime/paste-prepare.js'
import { newsletterHtml, complexNewsletterHtml } from './helpers/newsletter.js'
import { Parser, DomHandler } from 'htmlparser2'
import { retryWhenLoaded } from './helpers/load-retry.js'

const repo = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const still = { cpu: () => 0, wall: () => 0 } // no time net: the output alone is compared
const CEILING = 'export const MAX_MATCH_WORK = 2_000_000'
const MARK = 'this.byTagAnc = new Map()'

// the commit before the index: the parent of the commit that brought it, or HEAD while it is not committed; null
// without git (an exported tree, the Windows build)
function oldRevision() {
  try {
    const hits = execFileSync('git', ['-C', repo, 'log', '--format=%H', '-S', MARK, '--', 'core/mime/visible-text.js'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').filter(Boolean)
    return hits.length ? `${hits.at(-1)}^` : 'HEAD'
  } catch {
    return null
  }
}

// a copy of a core directory outside the repo with the work ceiling lifted; returns its two modules
async function unlimited(t, fill) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-cascade-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fill(dir)
  fs.symlinkSync(path.join(repo, 'node_modules'), path.join(dir, 'node_modules'))
  const file = path.join(dir, 'core', 'mime', 'visible-text.js')
  const src = fs.readFileSync(file, 'utf8')
  assert.equal(src.split(CEILING).length, 2, 'the ceiling line is there once')
  fs.writeFileSync(file, src.replace(CEILING, 'export const MAX_MATCH_WORK = Infinity'))
  const url = rel => pathToFileURL(path.join(dir, 'core', 'mime', rel)).href
  return { vt: await import(url('visible-text.js')), pp: await import(url('paste-prepare.js')), src }
}

let trees = null
async function bothTrees(t) {
  const rev = oldRevision()
  if (rev === null) return null
  if (!trees) {
    const old = await unlimited(t, dir => execFileSync('tar', ['-x', '-C', dir], { input: execFileSync('git', ['-C', repo, 'archive', rev, 'core']) }))
    assert.ok(!old.src.includes(MARK), `the old code (${rev}) has no index`)
    const cur = await unlimited(t, dir => fs.cpSync(path.join(repo, 'core'), path.join(dir, 'core'), { recursive: true }))
    assert.ok(cur.src.includes(MARK))
    trees = { old, cur }
  }
  return trees
}
const outputOf = ({ vt, pp }, html) =>
  JSON.stringify([pp.prepareQuote(html, { clocks: still }), pp.preparePaste(html, { clocks: still }), vt.visibleTextInfo(html, undefined, { clocks: still })])

const S = (css, body) => `<style>${css}</style>${body}`
// the planner's probe: rules ending in a tag under a class, a hidden ninth description
const probeNews = (blocks, rules) => {
  const css = Array.from({ length: rules }, (_, i) => `.c${i} td.x${i % 17} a { color:#${((i * 4111) % 0x7fffff).toString(16).padStart(6, '0')}; font-size:${12 + (i % 6)}px }\n.c${i} td { background-color:#f${i % 10}f${i % 10}f${i % 10}; padding:6px }`).join('\n')
  const block = i => `<table class="c${i % rules}"><tr><td class="x${i % 17}"><a href="https://example.invalid/${i}">T ${i}</a><div class="d${i % 9}">l ${i}</div></td></tr></table>`
  return `<style>${css}\n.d0{display:none}</style>${Array.from({ length: blocks }, (_, i) => block(i)).join('')}`
}
// n wrappers, each with its own class and a rule for its paragraph: an element's ancestors hold one of n keys
const wrappers = n => S(Array.from({ length: n }, (_, i) => `.k${i} p { color:#${(i * 97 % 0xffffff).toString(16).padStart(6, '0')} }`).join('\n'), Array.from({ length: n }, (_, i) => `<div class="k${i}"><p>w${i}</p></div>`).join(''))

const CASES = {
  probe100: probeNews(100, 300),
  probe500: probeNews(500, 300),
  probe2000r30: probeNews(2000, 30),
  childComb: S('.w > p { color:#ff0000 } .w p { font-weight:bold }', '<div class="w"><p>A</p><div><p>B</p></div></div><p>C</p>'),
  siblingBreaks: S('.s + div p { color:#00ff00 } .s ~ div > p { display:none }', '<p class="s">x</p><div><p>HID</p></div><div><p>Y</p></div>'),
  idAncestor: S('#main td { color:#0000ff } #main .k a { font-style:italic }', '<div id="main"><table><tr><td class="k"><a href="https://e.invalid">L</a></td></tr></table></div><table><tr><td>OUT</td></tr></table>'),
  universal: S('.box * { color:#123456 } .box > * { text-decoration:underline }', '<div class="box"><span>a</span><b><i>b</i></b></div><span>c</span>'),
  sameClassSelf: S('.a .a p { color:#ff00ff }', '<div class="a"><p>one</p><div class="a"><p>two</p></div></div>'),
  pseudo: S('.l li:first-child { font-weight:bold } .l li:last-child { display:none }', '<ul class="l"><li>1</li><li>2</li><li>3</li></ul>'),
  hiddenByAncestor: S('.hide span { display:none } .show .hide span { display:inline }', '<div class="hide"><span>H</span></div><div class="show"><div class="hide"><span>S</span></div></div>'),
  important: S('.x p { color:#ff0000 !important } p { color:#00ff00 }', '<div class="x"><p style="color:#0000ff">I</p></div>'),
  structuralChain: S('.m li:first-child > a { color:#aa0000 } .m > li:only-child b { display:none } .m li:last-child a:first-child { font-size:0 }',
    '<ul class="m"><li><a href="https://e.invalid/1">one</a><b>B1</b></li><li><a href="https://e.invalid/2">two</a></li></ul><ul class="m"><li><b>ONLY</b><a href="https://e.invalid/3">three</a></li></ul>'),
  starInTheMiddle: S('.box * span { color:#00aa00 } .box > * > i { display:none } .box * * em { font-weight:bold }',
    '<div class="box"><p><span>s1</span><i>I1</i><b><em>e</em></b></p><span>s2</span></div><span>out</span>'),
  idAndClassOneAncestor: S('#m.k td { color:#0000aa } .k td.z a { font-style:italic } #m a { text-decoration:underline }',
    '<div id="m" class="k"><table><tr><td class="z"><a href="https://e.invalid">L</a></td><td>t</td></tr></table></div><div class="k"><table><tr><td>K</td></tr></table></div>'),
  twoAncestorRulesOneElement: S('.a .b p { color:#ff0000 } .a p { color:#00ff00; font-weight:bold } #x p { color:#0000ff } .b p { font-size:20px } .a .b p { font-size:14px }',
    '<div class="a"><div class="b"><p>ab</p></div><p>a</p></div><div id="x" class="a"><div class="b"><p>xab</p></div></div>'),
  hiddenFromAncestor: S('.h p { display:none } .f span { font-size:0 } .w em { color:#ffffff } .w { background-color:#ffffff } .v b { visibility:hidden }',
    '<div class="h"><p>NONE</p></div><div class="f"><span>ZERO</span></div><div class="w"><em>WHITE</em></div><div class="v"><b>VIS</b></div><p>shown</p>'),
  wrappers1000: wrappers(1000),
  newsletter500: newsletterHtml({ blocks: 500 }),
  newsletter2000: newsletterHtml({ blocks: 2000 }),
}

test('the index gives the old code\'s output byte for byte (no ceiling, still clocks): quote, paste, reader', async t => {
  const both = await bothTrees(t)
  if (!both) return t.skip('no git history here')
  const differ = []
  for (const [name, html] of Object.entries(CASES)) if (outputOf(both.old, html) !== outputOf(both.cur, html)) differ.push(name)
  assert.deepEqual(differ, [])
})

test('the 5000-block newsletter: the same quote as the old code\'s (no ceiling)', async t => {
  const both = await bothTrees(t)
  if (!both) return t.skip('no git history here')
  const html = newsletterHtml({ blocks: 5000 })
  const quote = ({ pp }) => JSON.stringify(pp.prepareQuote(html, { clocks: still }))
  assert.ok(quote(both.old) === quote(both.cur))
})

test('1000 levels deep with ancestor-keyed rules: no stack overflow, the old code\'s output', async t => {
  const html = S('.d p { color:#ff0000 } .d > span { display:none } .d .d .d em { font-weight:bold }',
    `${'<div class="d">'.repeat(1000)}<p>deep</p><span>HID</span><em>e</em>${'</div>'.repeat(1000)}<p>top</p>`)
  const info = visibleTextInfo(html, undefined, { clocks: still })
  assert.equal(info.cut, null)
  assert.ok(info.text.includes('deep') && !info.text.includes('HID'), info.text)
  const both = await bothTrees(t)
  if (!both) return t.skip('no git history here')
  assert.ok(outputOf(both.old, html) === outputOf(both.cur, html))
})

test('3000 wrappers with a rule each: under the ceiling (each paragraph tries only its own wrapper\'s rule)', () => {
  // the old code put every rule in the "p" list: 3000 x 3000 tries, over the ceiling. An ancestor key that is not taken
  // back on the way out, or the larger side walked, brings that back
  const info = visibleTextInfo(wrappers(3000), undefined, { clocks: still })
  assert.equal(info.cut, null)
  assert.ok(info.text.includes('w2999'))
})

test('the ceiling and the net stay; the complex newsletter (all rules in one class list) is still complex', () => {
  assert.equal(MAX_MATCH_WORK, 2_000_000)
  assert.equal(TIME_LIMIT_MS, 1500)
  const html = complexNewsletterHtml()
  assert.equal(visibleTextInfo(html, undefined, { clocks: still }).cut, 'complex')
  assert.equal(preparePaste(html, { clocks: still }).reason, 'complex')
  assert.equal(prepareQuote(html, { clocks: still }).reason, 'complex')
})

// The timed work against the machine: a multiple of the gauge, htmlparser2's own parse of the 5000-block newsletter
// into a DOM (best of 5, no code of ours: a slowdown of the cascade itself does not hide in it), timed in the same run.
// Measured on a quiet machine (parse 27-34 ms), in this test and alone: 2000 blocks quote and paste 3.4-5.9 x the gauge,
// reader 1.9-3.9; 5000 blocks 8.7-14 / 5.1-8.2. The limits are about twice the highest: a slower machine (the Windows
// build: 310 ms for the 2000-block quote, over the old 300 ms wall-clock limit) is slower in the gauge too.
const LIMITS = [[2000, 12, 8], [5000, 28, 16]]
function parseGaugeMs(html) {
  let ms = Infinity
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now()
    const p = new Parser(new DomHandler(() => {}))
    p.write(html)
    p.end()
    ms = Math.min(ms, performance.now() - t0)
  }
  return ms
}

test('the newsletter is formatted now, in a multiple of the parse gauge: 2000 blocks quote and paste <= 12, reader <= 8; 5000 blocks 28 / 16 (best of 3)', async t => {
  // on a loaded machine a failure is tried again (load-retry.js), on a quiet one it stands
  await retryWhenLoaded(t, () => {
    const gauge = parseGaugeMs(newsletterHtml({ blocks: 5000 }))
    t.diagnostic(`parse gauge ${gauge.toFixed(1)} ms`)
    for (const [blocks, formatTimes, readerTimes] of LIMITS) {
      const formatMs = formatTimes * gauge
      const readerMs = readerTimes * gauge
      const html = newsletterHtml({ blocks })
      const best = f => {
        let ms = Infinity
        let r
        for (let i = 0; i < 3; i++) {
          const t0 = performance.now()
          r = f()
          ms = Math.min(ms, performance.now() - t0)
        }
        return { ms, r }
      }
      const q = best(() => prepareQuote(html))
      const p = best(() => preparePaste(html))
      const v = best(() => visibleTextInfo(html))
      assert.equal(q.r.reason, undefined, `${blocks}: the quote is formatted`)
      assert.equal(p.r.reason, undefined, `${blocks}: the paste is formatted`)
      assert.equal(v.r.cut, null, `${blocks}: the reader's text is whole`)
      t.diagnostic(`${blocks} blocks: quote ${Math.round(q.ms)} ms, paste ${Math.round(p.ms)} ms, reader ${Math.round(v.ms)} ms`)
      assert.ok(q.ms <= formatMs && p.ms <= formatMs, `${blocks}: quote ${Math.round(q.ms)} / paste ${Math.round(p.ms)} ms, the limit ${Math.round(formatMs)} (${formatTimes} x the gauge's ${gauge.toFixed(1)})`)
      assert.ok(v.ms <= readerMs, `${blocks}: reader ${Math.round(v.ms)} ms, the limit ${Math.round(readerMs)} (${readerTimes} x the gauge's ${gauge.toFixed(1)})`)
    }
  })
})
