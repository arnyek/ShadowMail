// Mark-of-the-Web: the Zone.Identifier stream on Windows, a no-op elsewhere; "Megnyitás" falls
// back to %TEMP%\ShadowMail when data\tmp cannot carry the mark, and opens nothing when that fails too.
// The Windows-only writes are injected; the real NTFS stream is measured on Windows (card comment).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tempDir } from './helpers/tmp.js'
import { markOfTheWeb, openMarked, saveMarked, fallbackTmpDir, ZONE_IDENTIFIER } from '../app/main/motw.js'

const walk = dir => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)])) : [])

test('markOfTheWeb: on Windows it writes <file>:Zone.Identifier with ZoneId=3; elsewhere a no-op, no file appears', t => {
  const writes = []
  assert.equal(markOfTheWeb('C:\\x\\a.pdf', { platform: 'win32', writeFile: (f, c) => writes.push([f, c]) }), true)
  assert.deepEqual(writes, [['C:\\x\\a.pdf:Zone.Identifier', '[ZoneTransfer]\r\nZoneId=3\r\n']])
  assert.equal(ZONE_IDENTIFIER, '[ZoneTransfer]\r\nZoneId=3\r\n')

  const dir = tempDir(t)
  const file = path.join(dir, 'a.pdf')
  fs.writeFileSync(file, 'x')
  assert.equal(markOfTheWeb(file, { platform: 'linux' }), false)
  if (process.platform !== 'win32') {
    assert.equal(markOfTheWeb(file), false, 'the real call on this platform')
    assert.deepEqual(walk(dir).map(f => path.basename(f)), ['a.pdf'], 'no :Zone.Identifier file next to it')
  }
})

test('openMarked: marked in data/tmp, then opened from there', async t => {
  const tmpDir = tempDir(t)
  const fallbackDir = path.join(tempDir(t), 'ShadowMail')
  const events = []
  const file = await openMarked({ filename: 'számla.pdf', content: Buffer.from('%PDF'), tmpDir, fallbackDir, mark: f => events.push(['mark', f]), openPath: async f => (events.push(['open', f]), '') })
  assert.ok(file.startsWith(tmpDir) && path.basename(file) === 'számla.pdf')
  assert.deepEqual(events, [['mark', file], ['open', file]], 'marked BEFORE it opens, the same file')
  assert.equal(fs.existsSync(fallbackDir), false, 'the system temp folder is not touched')
})

test('openMarked: the mark fails in data/tmp -> opens from %TEMP%\\ShadowMail, marked, the first copy is gone', async t => {
  const tmpDir = tempDir(t)
  const fallbackDir = path.join(tempDir(t), 'ShadowMail')
  const opened = []
  const marked = []
  const mark = f => {
    if (f.startsWith(tmpDir)) throw Object.assign(new Error('not NTFS'), { code: 'EINVAL' })
    marked.push(f)
  }
  const log = []
  const file = await openMarked({ filename: 'a.docm', content: Buffer.from('doc'), tmpDir, fallbackDir, mark, openPath: async f => (opened.push(f), ''), log: l => log.push(l) })
  assert.ok(file.startsWith(fallbackDir), file)
  assert.deepEqual(marked, [file])
  assert.deepEqual(opened, [file])
  assert.deepEqual(walk(tmpDir), [], 'no copy left in data/tmp')
  assert.equal(fs.readFileSync(file, 'utf8'), 'doc')
  assert.match(log.join('\n'), /EINVAL/)
})

test('openMarked: the mark fails in both places -> nothing opens, the UI gets motw_failed, no copy left', async t => {
  const tmpDir = tempDir(t)
  const fallbackDir = path.join(tempDir(t), 'ShadowMail')
  let opened = 0
  await assert.rejects(
    openMarked({ filename: 'a.pdf', content: Buffer.from('x'), tmpDir, fallbackDir, mark: () => { throw new Error('no streams') }, openPath: async () => (opened++, '') }),
    err => err.code === 'motw_failed',
  )
  assert.equal(opened, 0, 'shell.openPath was not called')
  assert.deepEqual([...walk(tmpDir), ...walk(fallbackDir)], [])
})

test('openMarked: the program fails to open it -> open_failed (unchanged)', async t => {
  await assert.rejects(
    openMarked({ filename: 'a.xyz', content: Buffer.from('x'), tmpDir: tempDir(t), fallbackDir: tempDir(t), mark: () => {}, openPath: async () => 'no application' }),
    err => err.code === 'open_failed',
  )
})

test('saveMarked: writes and marks; a failed mark is only logged, the file stays', t => {
  const dir = tempDir(t)
  const marked = []
  saveMarked({ filePath: path.join(dir, 'a.pdf'), content: Buffer.from('1'), mark: f => marked.push(f) })
  assert.deepEqual(marked, [path.join(dir, 'a.pdf')])
  const log = []
  saveMarked({ filePath: path.join(dir, 'b.pdf'), content: Buffer.from('2'), mark: () => { throw Object.assign(new Error(`exFAT: ${path.join(dir, 'b.pdf')}`), { code: 'EINVAL' }) }, log: l => log.push(l) })
  assert.equal(fs.readFileSync(path.join(dir, 'b.pdf'), 'utf8'), '2')
  // the code, never the message: it may name the file
  assert.match(log.join(''), /EINVAL/)
  assert.doesNotMatch(log.join(''), /b\.pdf/)
})

// Windows only (runs in the Windows build of npm test): the real NTFS stream, read back by PowerShell
// exactly as the card asks (Get-Content <file> -Stream Zone.Identifier).
test('Windows, NTFS: "Megnyitás" and "Mentés másként" files carry Zone.Identifier ZoneId=3 (PowerShell Get-Content)', { skip: process.platform !== 'win32' && 'Windows only' }, async t => {
  const { execFileSync } = await import('node:child_process')
  const zone = f => execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-Content -LiteralPath '${f.replace(/'/g, "''")}' -Stream Zone.Identifier`], { encoding: 'utf8' })
  const tmpDir = tempDir(t)
  let opened = null
  const file = await openMarked({ filename: 'számla.pdf', content: Buffer.from('%PDF'), tmpDir, fallbackDir: path.join(tempDir(t), 'ShadowMail'), openPath: async f => ((opened = f), '') })
  assert.equal(opened, file)
  const out = zone(file)
  console.log(`  Get-Content -Stream Zone.Identifier (open): ${JSON.stringify(out)}`)
  assert.match(out, /\[ZoneTransfer\]\s+ZoneId=3/)
  const saved = path.join(tempDir(t), 'mentett.docm')
  saveMarked({ filePath: saved, content: Buffer.from('doc') })
  const out2 = zone(saved)
  console.log(`  Get-Content -Stream Zone.Identifier (save): ${JSON.stringify(out2)}`)
  assert.match(out2, /\[ZoneTransfer\]\s+ZoneId=3/)
})

test('the %TEMP% fallback folder is per copy of the app: two data folders, two subfolders', () => {
  const a = fallbackTmpDir('/x/ShadowMail-A/data')
  const b = fallbackTmpDir('/x/ShadowMail-B/data')
  assert.notEqual(a, b)
  assert.equal(a, fallbackTmpDir('/x/ShadowMail-A/data'))
  assert.equal(path.basename(path.dirname(a)), 'ShadowMail')
})

test('openMarked: a first copy that cannot be removed (virus scanner) does not stop the fallback', { skip: process.platform === 'win32' || (process.getuid && process.getuid() === 0) }, async t => {
  const tmpDir = tempDir(t)
  const fallbackDir = path.join(tempDir(t), 'ShadowMail')
  const log = []
  const opened = []
  const mark = f => {
    if (f.startsWith(tmpDir)) {
      fs.chmodSync(path.dirname(f), 0o500) // the copy's folder cannot be emptied now
      throw Object.assign(new Error('not NTFS'), { code: 'EINVAL' })
    }
  }
  let file
  try {
    file = await openMarked({ filename: 'a.pdf', content: Buffer.from('x'), tmpDir, fallbackDir, mark, openPath: async f => (opened.push(f), ''), log: l => log.push(l) })
  } finally {
    for (const d of fs.readdirSync(tmpDir)) fs.chmodSync(path.join(tmpDir, d), 0o700)
  }
  assert.ok(file.startsWith(fallbackDir))
  assert.deepEqual(opened, [file])
  assert.match(log.join('\n'), /could not remove/)
})
