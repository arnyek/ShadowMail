// The public-tree check (scripts/public-check.mjs): every category is found, the waivers work, secrets are not echoed.
// The samples are assembled at run time, so this file itself stays clean for the check.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'
import { tempDir } from './helpers/tmp.js'

const SCRIPT = fileURLToPath(new URL('../scripts/public-check.mjs', import.meta.url))
const j = (...parts) => parts.join('')

let mod
const load = async () => (mod ||= await import(pathToFileURL(SCRIPT).href))

// One line per category; the comment ones sit in a // comment, so the file is scanned as JavaScript.
const SAMPLES = {
  'agent-name': j('// asked by Teszt', 'elő in the review'),
  'owner-name': j('// as Zs', 'olt wanted'),
  'telegram-ref': j('// decided in Tele', 'gram 2012'),
  'message-ref': j('// see m', 'sg 2350'),
  'home-path': j("const p = '/ho", "me/someone/tool'"),
  'windows-user-path': j("const w = 'C:\\\\Us", "ers\\\\Someone\\\\x'"),
  secret: j("const k = 'sk-a", "nt-", 'abcdefghijklmnop', "'"),
  email: j("const to = 'person@", "real-domain.hu'"),
  'card-id': j('// fixed for ', '450ed', '561'),
  'card-code': j('// the K', '21 rule'),
  'plan-ref': j('// see pl', 'an 4.6'),
}

test('public check: one sample per category is found, and the secret is not echoed', async () => {
  const { checkText } = await load()
  const text = Object.values(SAMPLES).join('\n') + '\n'
  const found = checkText('sample.js', text)
  assert.deepEqual(found.map((f) => f.category).sort(), Object.keys(SAMPLES).sort())
  const secret = found.find((f) => f.category === 'secret')
  assert.equal(secret.match, null)
})

test('public check: the accent-free spelling of a name and the test title are checked too', async () => {
  const { checkText } = await load()
  const lines = [j('// Teszt', 'elo said so'), j("test('the M", "5 case works', () => {})")]
  assert.deepEqual(checkText('a.test.js', lines.join('\n')).map((f) => f.category), ['agent-name', 'card-code'])
})

test('public check: code identifiers, strings and allowed mail domains are not notes', async () => {
  const { checkText } = await load()
  const lines = [
    j("const id = 'ab12", "cd34'"), // a hex id in code, not in a comment
    j("const key = 'F", "5'"),
    "const a = 'x@mail.example'; const b = 'y@host.invalid'; const c = 'z@localhost.test'",
    j('// the C', '0 controls and an MD', '5 sum are technical names'),
  ]
  assert.deepEqual(checkText('code.js', lines.join('\n')), [])
})

test('public check: a line marker waives one category only, and needs a reason', async () => {
  const { checkText } = await load()
  const marked = j('// see m', 'sg 2350 and Z', 'solt  public-check: allow message-ref quoted on purpose')
  assert.deepEqual(checkText('m.js', marked).map((f) => f.category), ['owner-name'])
  const noReason = j('// see m', 'sg 2350 public-check: allow message-ref')
  assert.deepEqual(checkText('m.js', noReason).map((f) => f.category), ['message-ref'])
})

test('public check: the local deny list matches whole names, case-insensitively, and is not echoed', async () => {
  const { checkText } = await load()
  const found = checkText('doc.md', 'connect to MAIL.Box-One.example-host now\nmail.box-one.example-hostx and xmail.box-one.example-host are other names\n', ['mail.box-one.example-host'])
  assert.deepEqual(found, [{ line: 1, category: 'local-deny', match: null }])
})

test('public check: on a line with a local entry or a secret no category prints its text', async () => {
  const { checkText } = await load()
  const local = ['fakebox-qq7', 'qa.fakecorp.hu']
  const lines = [
    j('mail admin', '@qa.fakecorp.hu here'),
    j('path /ho', 'me/fakebox-qq7/x'),
    j('ssh deploy', '@fakebox-qq7.fakecorp.hu'),
    '// host FAKEBOX-QQ7 here',
    j("const k = 'sk-a", "nt-", "abcdefghijklmnop' // to deploy", '@real-domain.hu'),
    j('mail someone', '@real-domain.hu'), // no entry on this line: the text is printed
  ]
  const found = checkText('notes.js', lines.join('\n'), local)
  const out = JSON.stringify(found)
  assert.ok(!/fakebox|fakecorp|qq7|abcdefghijklmnop/i.test(out), out)
  for (const n of [1, 2, 3, 4, 5]) assert.ok(found.some((f) => f.line === n), `line ${n} found`)
  assert.ok(found.filter((f) => f.line <= 5).every((f) => f.match === null))
  assert.deepEqual(found.filter((f) => f.line === 6), [{ line: 6, category: 'email', match: j('someone', '@real-domain.hu') }])
  // the check of one line leaves nothing behind for the next: an entry early on a line after a long one is still found
  const pad = 'x '.repeat(40)
  const next = checkText('n.md', [pad + 'qa.fakecorp.hu', 'qa.fakecorp.hu', pad + j('sk-a', 'nt-', 'abcdefghijklmnop'), j('sk-a', 'nt-', 'abcdefghijklmnop')].join('\n'), local)
  assert.deepEqual(next.map((f) => `${f.line} ${f.category}`), ['1 local-deny', '2 local-deny', '3 secret', '4 secret'])
})

test('public check: suffixed names, other separators, a home path without a slash, the WSL user path', async () => {
  const { checkText } = await load()
  const cases = [
    [j('// sent to the Teszt', 'előnek'), 'agent-name'],
    [j('// from the K', 'ódolótól'), 'agent-name'],
    [j('// Marv', 'eennek'), 'agent-name'],
    [j('// Tervez', 'őé'), 'agent-name'],
    [j('// as Zs', 'oltnak'), 'owner-name'],
    [j('// msg', '_id:3172'), 'message-ref'],
    [j('// ms', 'g-3172'), 'message-ref'],
    [j('// Telegr', 'am: 2015'), 'telegram-ref'],
    [j("const h = '/ho", "me/someone'"), 'home-path'],
    [j('cd /ho', 'me/someone'), 'home-path'],
    [j('B=/mnt/c/Us', 'ers/Someone/build'), 'windows-user-path'],
  ]
  for (const [line, category] of cases) assert.deepEqual(checkText('x.js', line).map((f) => f.category), [category], line)
  // the placeholders stay allowed, and an ordinary word is no name
  assert.deepEqual(checkText('x.md', j('/ho', 'me/<user>/ and /mnt/c/Us', 'ers/<user>/ and the tervezés of it')), [])
})

test('public check: the second set of reference forms (technical-looking card codes, plan files, rounds, pointers, commits, macOS)', async () => {
  const { checkText } = await load()
  const cases = [
    // 1. a code from the technical list is a card with a version before it or a point number after it
    [j('// the address book (0.12.0 C', '1, see there)'), 'card-code'],
    [j('// the completion (C', '1 6.): names first'), 'card-code'],
    [j('// as H', '1 point 3 says'), 'card-code'],
    // 2. plan files, the plans folder, card points
    [j('// plan shadowmail-ui.m', 'd 3.1'), 'plan-ref'],
    [j('// see the pla', 'n `shadowmail-ui.m', 'd`'), 'plan-ref'],
    [j('// pla', 'ns/shadowmail-mcp.md'), 'plan-ref'],
    [j('// card poi', 'nt 7: the source'), 'plan-ref'],
    [j('// a kártya 7', '. pontja szerint'), 'plan-ref'],
    // 3. comments, measured runs, review rounds, message pointers
    [j('// measured: comm', 'ent 1058'), 'comment-ref'],
    [j('// Windows 10', '59: 1.6 s'), 'comment-ref'],
    [j('// Linu', 'x 1059 too'), 'comment-ref'],
    [j('// rou', 'nd 2: the N line'), 'comment-ref'],
    [j('// a 2', '. körben'), 'comment-ref'],
    [j('// the 88', '0 #2 rule'), 'comment-ref'],
    // 4. a commit of the private repository (7 and 10 hex)
    [j('// measured against 33ff', '9c7'), 'commit-ref'],
    [j("test('as on a1b2c", "3d4e5', () => {})"), 'commit-ref'],
  ]
  for (const [line, category] of cases) assert.deepEqual(checkText('x.js', line).map((f) => f.category), [category], line)
  // 5. the macOS user path (a line rule, like the Windows forms)
  assert.deepEqual(checkText('x.js', j("const p = '/Us", "ers/someone/x'")).map((f) => f.category), ['windows-user-path'])
  // not references: the technical meanings, Windows versions, a sha256, an ordinary word, the shared and placeholder paths
  const clean = [
    '// C1 control characters are dropped, and the H1 heading stays',
    '// works on Windows 10 and Windows 11, round trips are cheap',
    '// sha256: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    '// the tervezés of the page',
    "const s = '/Users/Shared/x'; const u = '/Users/<user>/x'; const w = 'C:/Users/<user>'",
    '// a 7-letter word like defaced or a number like 1234567 is no commit',
  ]
  assert.deepEqual(checkText('clean.js', clean.join('\n')), [])
})

test('public check: separators, suffixes and ordinal rounds of the second set; routes, years and algorithm names stay clean', async () => {
  const { checkText } = await load()
  const cases = [
    [j('// see comm', 'ent #952'), 'comment-ref'],
    [j('// see comm', 'ent: 952'), 'comment-ref'],
    [j('// a kommentben 9', '52'), 'comment-ref'],
    [j('// (3rd rou', 'nd)'), 'comment-ref'],
    [j('// in the second rou', 'nd'), 'comment-ref'],
    [j('// the 88', '0/#2 rule'), 'comment-ref'],
    [j('// the completion: C', '1 (6.)'), 'card-code'],
    [j('// pla', 'n: shadowmail-ui.md'), 'plan-ref'],
  ]
  for (const [line, category] of cases) assert.deepEqual(checkText('x.js', line).map((f) => f.category), [category], line)
  const clean = [
    "app.get('/users/:id', handler) // a web route, not a macOS home",
    "const r = '/Users/{name}/x'; const route = '/users/alice/profile'",
    '// runs on Windows 2000 and Windows 2019 too',
    '// the ed25519 key, a second round trip, a round-trip test',
  ]
  assert.deepEqual(checkText('clean.js', clean.join('\n')), [])
})

test('public check: every source file of app/, core/ and scripts/ names its license in its first lines', async () => {
  const { checkText, SPDX_LINE } = await load()
  const cat = (rel, text) => checkText(rel, text).map((f) => f.category)
  assert.deepEqual(cat('core/x.js', 'export const a = 1\n'), ['spdx-missing'])
  assert.deepEqual(cat('app/renderer/src/x.css', '.a { color: red }\n'), ['spdx-missing'])
  assert.deepEqual(cat('scripts/win/x.ps1', 'Write-Host 1\r\n'), ['spdx-missing'])
  assert.deepEqual(cat('core/x.js', `// ${SPDX_LINE}\nexport const a = 1\n`), [])
  assert.deepEqual(cat('scripts/x.mjs', `#!/usr/bin/env node\n// ${SPDX_LINE}\n`), [])
  assert.deepEqual(cat('app/renderer/index.html', `<!doctype html>\n<!-- ${SPDX_LINE} -->\n`), [])
  // the line far down the file does not count; test/ and data files need none
  assert.deepEqual(cat('core/x.js', '\n'.repeat(50) + `// ${SPDX_LINE}\n`), ['spdx-missing'])
  assert.deepEqual(cat('test/x.test.js', 'export const a = 1\n'), [])
  assert.deepEqual(cat('app/renderer/i18n/x.json', '{}\n'), [])
  // another license id is not the project's
  assert.deepEqual(cat('core/x.js', '// SPDX-License-Identifier: MIT\n'), ['spdx-missing'])
})

test('public check: comments of shell, cmd and markup files', async () => {
  const { noteText } = await load()
  assert.deepEqual(noteText('echo "#x" # note\n#!/bin/sh', 'hash'), [' # note', ''])
  assert.deepEqual(noteText('rem note\necho x', 'cmd'), ['rem note', ''])
  assert.deepEqual(noteText('<p>a</p><!-- one\ntwo --> <b>', 'markup'), [' one', 'two '])
})

test('public check: the command line (excluded paths, missing local list, exit codes, run time)', (t) => {
  const dir = tempDir(t)
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, '--root', dir, ...args], { encoding: 'utf8' })
  execFileSync('git', ['init', '-q', dir])
  fs.writeFileSync(path.join(dir, 'publish.json'), JSON.stringify({ exclude: ['NOTES.md', 'private/'] }))
  fs.writeFileSync(path.join(dir, 'NOTES.md'), 'the server is mail.box-one.example-host\n')
  fs.mkdirSync(path.join(dir, 'private'))
  fs.writeFileSync(path.join(dir, 'private', 'x.md'), j('Z', 'solt\n'))
  fs.writeFileSync(path.join(dir, 'ok.js'), '// a clean comment\nconst a = 1\n')
  fs.writeFileSync(path.join(dir, 'pic.png'), Buffer.from([0x89, 0x50, 0, 0x5a, 0x73, 0x6f, 0x6c, 0x74]))
  execFileSync('git', ['-C', dir, 'add', '-A'])

  const missing = run()
  assert.equal(missing.status, 2)
  assert.match(missing.stderr, /local deny list .* is missing/)
  assert.equal(run('--allow-missing-local').status, 0)

  fs.writeFileSync(path.join(dir, '.public-deny.local'), '# hosts\nmail.box-one.example-host\n')
  const t0 = performance.now()
  const clean = run()
  assert.ok(performance.now() - t0 < 5000)
  assert.equal(clean.status, 0, clean.stdout)
  const all = run('--no-exclude')
  assert.equal(all.status, 1)
  assert.match(all.stdout, /^NOTES\.md:1 local-deny$/m)
  assert.match(all.stdout, /^private\/x\.md:1 owner-name /m)
  assert.ok(!all.stdout.includes('box-one'))
  assert.equal(run('--paths', 'NOTES.md', '--no-exclude').status, 1)
  // a mistyped path or an empty --paths is a usage error, not a green run
  const typo = run('--paths', 'ok.js', 'nope.js')
  assert.equal(typo.status, 2)
  assert.match(typo.stderr, /not a file: nope\.js/)
  assert.equal(run('--paths').status, 2)
  assert.equal(run('--paths', '--no-exclude').status, 2)
})

test('public check: a file name with a card code or a card id is found, a technical name is not', async () => {
  const { checkPath } = await load()
  const names = (p) => checkPath(p).map((f) => [f.category, f.match, f.line])
  assert.deepEqual(names(j('test/sync-k', '5.test.js')), [['file-name', j('k', '5'), null]])
  assert.deepEqual(names(j('test/fixtures/mail/k', '20-attachments.eml')), [['file-name', j('k', '20'), null]])
  assert.deepEqual(names(j('test/helpers/v', '1-samples.js')), [['file-name', j('v', '1'), null]])
  assert.deepEqual(names(j('docs/ui/C', '4-edit.png')), [['file-name', j('C', '4'), null]])
  assert.deepEqual(names(j('docs/H', '2b-view.md')), [['file-name', j('H', '2b'), null]])
  assert.deepEqual(names(j('notes/m-q', '2.md')), [['file-name', j('m-q', '2'), null]])
  assert.deepEqual(names(j('probe-450ed', '561/run.js')), [['file-name', j('450ed', '561'), null]])
  // technical names: e2e, i18n, ps1, pop3, win32, x64, utf8, md5, sha256, a version, a year, a hex word without a digit
  for (const p of ['test/e2e/pop3-e2e.mjs', 'app/renderer/i18n/hu.js', 'scripts/win/footprint.ps1', 'dist/ShadowMail-0.12.0-win-x64.zip',
    'win32/utf8-md5.txt', 'sha256/2026-11-15.log', 'deadbeef/cafebabe.txt', 'prebuilds/linux-arm64.node']) {
    assert.deepEqual(checkPath(p), [], p)
  }
})

test('public check: the texts of console calls are notes (strings and templates, over lines); other strings are not', async () => {
  const { checkText } = await load()
  const lines = [
    j('con', "sole.log('MEASURED K", "8 done', n)"),
    j('con', 'sole.error(`', 'the R', '1 sample: ${ms} ms`)'),
    j('con', 'sole.warn(', "'a'", ','),
    j("  'see pl", "an 4.6',"),
    j("  'after ", 'round 2', "')"),
    j('con', "sole.info('fixed in 450ed", "561')"),
    j('con', "sole.debug('the run of 3ccb", "bdf')"),
    j("const label = 'K", "21 is a key in code'"),
    j('con', 'sole.log(K', '21, n)'),
    j("log('K", "21 elsewhere')"),
  ]
  const found = checkText('run.mjs', lines.join('\n')).map((f) => [f.line, f.category])
  assert.deepEqual(found, [[1, 'card-code'], [2, 'card-code'], [4, 'plan-ref'], [5, 'comment-ref'], [6, 'card-id'], [7, 'commit-ref']])
  const { consoleNotes } = await load()
  assert.deepEqual(consoleNotes([j('con', 'sole.log("a",'), '  `b', 'c`)', 'x("d")']), [' a', ' b', ' c', ''])
})

test('public check: the console tokenizer follows nested templates, skips regular expressions, and finds calls only in code', async () => {
  const { checkText } = await load()
  const lines = [
    j('con', 'sole.log(`outer ${ok ? `K', '8 inner` : ', "'no'} done`)"), // a template inside a template
    j('con', "sole.log(s.replace(/'/g, ''), 'F", "7 after regex')"), // a quote in a regular expression
    j('con', "sole.warn(`deep ${a ? `${b ? 'x' : 'y'}` : 'z'} P", '3 tail`)'),
    j('con', 'sole.info(f(/[/`]/.test(x)), "K', '4 after a class")'), // a slash and a backtick in a character class
    j("const t = 'con", "sole.log( only a string'"), // not a call: the next line is not read as its text
    j("log('Q", "5 not a console call')"),
    j('function r () { return /\'/ } ; con', "sole.log('M", "6 after return')"), // a regular expression after return
    j('const el = <p>a</p>; con', "sole.log('K", "7 after a closing tag')"),
    j('const half = a / b; con', "sole.log('done', c / d, 'S", "2 after division')"),
  ]
  const found = checkText('run.jsx', lines.join('\n')).map((f) => [f.line, f.match])
  assert.deepEqual(found, [[1, j('K', '8')], [2, j('F', '7')], [3, j('P', '3')], [4, j('K', '4')], [7, j('M', '6')], [8, j('K', '7')], [9, j('S', '2')]])
})

test('public check: the command line prints a file name finding without a line number, and publish.json can waive it', (t) => {
  const dir = tempDir(t)
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, '--root', dir, '--allow-missing-local', ...args], { encoding: 'utf8' })
  execFileSync('git', ['init', '-q', dir])
  fs.writeFileSync(path.join(dir, j('sync-k', '5.test.js')), '// clean\n')
  fs.writeFileSync(path.join(dir, 'pop3-e2e.mjs'), '// clean\n')
  execFileSync('git', ['-C', dir, 'add', '-A'])
  const r = run()
  assert.equal(r.status, 1)
  assert.equal(r.stdout.split('\n')[0], j('sync-k', '5.test.js file-name "k', '5"'))
  fs.writeFileSync(path.join(dir, 'publish.json'), JSON.stringify({ allow: [{ path: j('sync-k', '5.test.js'), category: 'file-name', reason: 'a test of the waiver' }] }))
  execFileSync('git', ['-C', dir, 'add', '-A'])
  assert.equal(run().status, 0)
})

test('public check: a tree without git is walked, without what the root .gitignore leaves out (build output, data, logs)', (t) => {
  const dir = tempDir(t)
  const write = (rel, content) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), content) }
  write('.gitignore', 'node_modules/\ndist/\nout/\ndata*/\n*.log\n/top-only.txt\n!keep.log\n')
  write('app.js', j('// asked by Z', 'solt\n'))
  write('sub/top-only.txt', j('Z', 'solt\n')) // an anchored pattern: only the root one is left out
  for (const f of ['out/renderer/b.js', 'dist/n.txt', 'data-dev/n.txt', 'sub/data/x.txt', 'run.log', 'top-only.txt', 'keep.log']) write(f, j('Z', 'solt\n'))
  const r = spawnSync(process.execPath, [SCRIPT, '--root', dir, '--allow-missing-local'], { encoding: 'utf8' })
  assert.equal(r.status, 1)
  const files = r.stdout.split('\n').filter((l) => / owner-name /.test(l)).map((l) => l.split(':')[0]).sort()
  assert.deepEqual(files, ['app.js', 'keep.log', 'sub/top-only.txt']) // "!keep.log" takes it back, as in git
})
