#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Public export: writes the tree of a commit, without the paths that stay private (publish.json "exclude"), into a new
// folder, then runs the public-check on that folder with the local deny list of this repository. If the check fails, the
// folder is removed. No git command runs in the target: committing the export to the public repository is a separate step.
//
//   node scripts/public-export.mjs <ref> <target folder>
//
// The tree comes from "git archive", so it is what a release holds: the committed files only, with the line endings of
// .gitattributes (a .cmd file gets CRLF). The target must not exist, or be an empty folder; nothing else is ever deleted.
// Exit code: 0 exported and clean, 1 the check found something (the target is removed), 2 usage error, missing local
// deny list, a target that is not empty, or a failed git call.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { CONFIG, LOCAL_LIST, isExcluded } from './public-check.mjs'

const SELF = fileURLToPath(import.meta.url)
const CHECK = path.join(path.dirname(SELF), 'public-check.mjs')

// The entries of a tar archive as git archive writes it (ustar, with pax headers for long names): [{ path, type, mode,
// data, link }]. type: 'file', 'dir' or 'symlink'.
export function readTar (buf) {
  const entries = []
  const text = (from, len) => { const s = buf.toString('utf8', from, from + len); const z = s.indexOf('\0'); return z < 0 ? s : s.slice(0, z) }
  const octal = (from, len) => parseInt(text(from, len).trim() || '0', 8)
  let pax = {}
  let off = 0
  while (off + 512 <= buf.length) {
    const h = off
    if (buf.subarray(h, h + 512).every((b) => b === 0)) break
    const size = octal(h + 124, 12)
    const flag = String.fromCharCode(buf[h + 156] || 0x30)
    const data = buf.subarray(h + 512, h + 512 + size)
    if (data.length !== size) throw new Error('public-export: the archive is cut short')
    off = h + 512 + Math.ceil(size / 512) * 512
    if (flag === 'g') continue // the global header: the commit id, not a file
    if (flag === 'x') { pax = parsePax(data); continue }
    const prefix = buf.toString('utf8', h + 257, h + 262) === 'ustar' ? text(h + 345, 155) : ''
    const name = pax.path ?? (prefix ? `${prefix}/${text(h, 100)}` : text(h, 100))
    const link = pax.linkpath ?? text(h + 157, 100)
    pax = {}
    const type = flag === '5' ? 'dir' : flag === '2' ? 'symlink' : flag === '0' ? 'file' : null
    if (!type) throw new Error(`public-export: unsupported tar entry type "${flag}" for ${name}`)
    entries.push({ path: name.replace(/\/$/, ''), type, mode: octal(h + 100, 8), data, link })
  }
  return entries
}

// "<length> <key>=<value>\n" records
function parsePax (data) {
  const out = {}
  let i = 0
  while (i < data.length) {
    const space = data.indexOf(0x20, i)
    if (space < 0) break
    const len = parseInt(data.toString('utf8', i, space), 10)
    if (!(len > 0)) break
    const record = data.toString('utf8', space + 1, i + len - 1)
    const eq = record.indexOf('=')
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1)
    i += len
  }
  return out
}

// A path from the archive, written under the target: relative, without "..", or the export stops.
function safeJoin (target, rel) {
  const parts = rel.split('/')
  if (!rel || path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || parts.some((p) => p === '..' || p === '')) {
    throw new Error(`public-export: refusing the path "${rel}" from the archive`)
  }
  return path.join(target, ...parts)
}

export function exportTree ({ repo, ref, target }) {
  const archive = execFileSync('git', ['-C', repo, 'archive', '--format=tar', ref], { maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'] })
  const entries = readTar(archive)
  const config = entries.find((e) => e.path === CONFIG && e.type === 'file')
  const exclude = config ? JSON.parse(config.data.toString('utf8')).exclude || [] : []
  let files = 0
  for (const e of entries) {
    if (isExcluded(e.path, exclude) || (e.type === 'dir' && isExcluded(e.path + '/', exclude))) continue
    const dest = safeJoin(target, e.path)
    if (e.type === 'dir') { fs.mkdirSync(dest, { recursive: true }); continue }
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    if (e.type === 'symlink') { fs.symlinkSync(e.link, dest); files++; continue }
    fs.writeFileSync(dest, e.data)
    if (process.platform !== 'win32' && e.mode & 0o111) fs.chmodSync(dest, 0o755)
    files++
  }
  // an excluded path that is still there is a bug of this script, not a finding: stop
  for (const e of exclude) {
    if (fs.existsSync(path.join(target, ...e.replace(/\/$/, '').split('/')))) throw new Error(`public-export: the excluded path ${e} is in the export`)
  }
  return { files, exclude }
}

function main (argv) {
  if (argv.length !== 2 || argv.some((a) => a.startsWith('--'))) {
    console.error('usage: node scripts/public-export.mjs <ref> <target folder>')
    return 2
  }
  const [ref, targetArg] = argv
  let repo
  try {
    repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    execFileSync('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { stdio: 'ignore' })
  } catch {
    console.error(`public-export: not a commit in this repository: ${ref}`)
    return 2
  }
  const localList = path.join(repo, LOCAL_LIST)
  if (!fs.existsSync(localList)) {
    console.error(`public-export: the local deny list ${LOCAL_LIST} is missing in ${repo}: an export is always checked with it`)
    return 2
  }
  const target = path.resolve(targetArg)
  if (fs.existsSync(target) && (!fs.statSync(target).isDirectory() || fs.readdirSync(target).length)) {
    console.error(`public-export: the target exists and is not an empty folder: ${target}`)
    return 2
  }
  const created = !fs.existsSync(target)
  fs.mkdirSync(target, { recursive: true })
  // only what this run wrote is removed: the target itself if it made it, otherwise the target's contents
  const discard = () => {
    if (created) fs.rmSync(target, { recursive: true, force: true })
    else for (const e of fs.readdirSync(target)) fs.rmSync(path.join(target, e), { recursive: true, force: true })
  }
  let result
  try {
    result = exportTree({ repo, ref, target })
  } catch (err) {
    discard()
    console.error(err.message)
    return 2
  }
  const check = spawnSync(process.execPath, [CHECK, '--root', target, '--local-list', localList], { encoding: 'utf8' })
  process.stdout.write(check.stdout)
  process.stderr.write(check.stderr)
  if (check.status !== 0) {
    discard()
    console.error(`public-export: the public check failed (exit ${check.status}); ${target} ${created ? 'removed' : 'emptied'}`)
    return check.status === 1 ? 1 : 2
  }
  console.log(`public-export: ${ref} -> ${target}: ${result.files} files, without ${result.exclude.join(', ') || 'nothing'}`)
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) process.exitCode = main(process.argv.slice(2))
