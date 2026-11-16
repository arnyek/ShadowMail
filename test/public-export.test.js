// The public export (scripts/public-export.mjs): the tree of a commit without the private paths, the same bytes as git
// archive, checked with the local deny list; a failed check leaves no export, and nothing else is ever deleted.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'
import { tempDir } from './helpers/tmp.js'

const SCRIPT = fileURLToPath(new URL('../scripts/public-export.mjs', import.meta.url))
const j = (...parts) => parts.join('')
const LONG = 'deep/' + 'a-rather-long-folder-name/'.repeat(5) + 'file-with-a-long-name.txt' // over 100 bytes: a pax header

function makeRepo (t) {
  const repo = tempDir(t)
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
  git('init', '-q')
  git('config', 'user.email', 'dev@example.invalid')
  git('config', 'user.name', 'dev')
  const write = (rel, content) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), content) }
  write('publish.json', JSON.stringify({ exclude: ['NOTES.md', 'private/'] }))
  write('.gitattributes', '* text=auto eol=lf\n*.cmd text eol=crlf\n')
  write('.gitignore', '.public-deny.local\n')
  write('app.js', '// a clean comment\nconst a = 1\n')
  write('run.cmd', '@echo off\necho hello\n')
  write('build.sh', '#!/bin/sh\necho build\n')
  fs.chmodSync(path.join(repo, 'build.sh'), 0o755)
  write(LONG, 'long\n')
  write('NOTES.md', 'the server is mail.box-one.example-host\n')
  write('private/x.md', j('asked by Z', 'solt\n'))
  write('.public-deny.local', '# hosts\nmail.box-one.example-host\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'first')
  return { repo, git, write }
}

const run = (repo, ...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: repo, encoding: 'utf8' })

test('public export: the tree of the commit without the excluded paths, byte for byte as git archive writes it', (t) => {
  const { repo } = makeRepo(t)
  const target = path.join(tempDir(t), 'out')
  const r = run(repo, 'HEAD', target)
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.match(r.stdout, /public-check: \d+ files, 0 findings/)
  assert.match(r.stdout, /public-export: HEAD -> .*: 7 files, without NOTES\.md, private\//)
  assert.ok(!fs.existsSync(path.join(target, 'NOTES.md')))
  assert.ok(!fs.existsSync(path.join(target, 'private')))
  assert.ok(!fs.existsSync(path.join(target, '.public-deny.local')), 'the local list is never copied')
  assert.ok(!fs.existsSync(path.join(target, '.git')), 'no git in the target')
  // the same bytes as git archive: the line endings of .gitattributes, a long path
  const listed = execFileSync('git', ['-C', repo, 'ls-files'], { encoding: 'utf8' }).split('\n').filter((f) => f && f !== 'NOTES.md' && !f.startsWith('private/'))
  for (const f of listed) {
    const expected = execFileSync('git', ['-C', repo, 'archive', '--format=tar', 'HEAD', f])
    assert.ok(expected.includes(fs.readFileSync(path.join(target, f))), f)
  }
  assert.equal(fs.readFileSync(path.join(target, 'run.cmd'), 'utf8'), '@echo off\r\necho hello\r\n')
  assert.equal(fs.readFileSync(path.join(target, LONG), 'utf8'), 'long\n')
  if (process.platform !== 'win32') {
    assert.ok(fs.statSync(path.join(target, 'build.sh')).mode & 0o100)
    assert.ok(!(fs.statSync(path.join(target, 'app.js')).mode & 0o100))
  }
})

test('public export: a forbidden line fails the check, and the export is gone (also a target inside a repository)', (t) => {
  const { repo, git, write } = makeRepo(t)
  write('app.js', j('// asked by Z', 'solt\n'))
  git('commit', '-q', '-am', 'a forbidden line')
  const target = path.join(tempDir(t), 'out')
  const r = run(repo, 'HEAD', target)
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stdout, /^app\.js:1 owner-name /m)
  assert.match(r.stderr, /the public check failed .* removed/)
  assert.ok(!fs.existsSync(target))
  // the local deny list counts too, and a target inside the repository itself is walked, not asked from git (where it
  // is untracked, so git would list nothing and the check would pass)
  write('app.js', '// the mail.box-one.example-host server\n')
  git('commit', '-q', '-am', 'a host name')
  const inside = path.join(repo, 'export')
  const r2 = run(repo, 'HEAD', inside)
  assert.equal(r2.status, 1, r2.stdout + r2.stderr)
  assert.match(r2.stdout, /^app\.js:1 local-deny$/m)
  assert.ok(!r2.stdout.includes('box-one'))
  assert.ok(!fs.existsSync(inside))
  // an empty folder that was there is emptied, not removed
  const empty = path.join(tempDir(t), 'empty')
  fs.mkdirSync(empty)
  assert.equal(run(repo, 'HEAD', empty).status, 1)
  assert.deepEqual(fs.readdirSync(empty), [])
  // the commit before it still exports
  assert.equal(run(repo, 'HEAD~2', path.join(tempDir(t), 'ok')).status, 0)
})

test('public export: it refuses a target with files, a missing local list, a wrong ref, and touches nothing', (t) => {
  const { repo } = makeRepo(t)
  const busy = tempDir(t)
  fs.writeFileSync(path.join(busy, 'keep.txt'), 'mine')
  const r = run(repo, 'HEAD', busy)
  assert.equal(r.status, 2)
  assert.match(r.stderr, /not an empty folder/)
  assert.deepEqual(fs.readdirSync(busy), ['keep.txt'])
  const target = path.join(tempDir(t), 'out')
  const wrong = run(repo, 'no-such-ref', target)
  assert.equal(wrong.status, 2)
  assert.match(wrong.stderr, /not a commit/)
  assert.equal(run(repo, 'HEAD').status, 2)
  fs.rmSync(path.join(repo, '.public-deny.local'))
  const missing = run(repo, 'HEAD', target)
  assert.equal(missing.status, 2)
  assert.match(missing.stderr, /local deny list .* is missing/)
  assert.ok(!fs.existsSync(target))
})
