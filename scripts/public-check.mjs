#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Public-tree check: scans the text files that would go into the public repository for things that must not be published
// (internal references, personal names and paths, secrets, real e-mail addresses, and the entries of a local, untracked
// deny list such as a test server's host name).
//
//   node scripts/public-check.mjs [--paths <file> ...] [--root <dir>] [--local-list <file>] [--allow-missing-local] [--no-exclude] [--summary]
//
//   --paths <file> ...       check only these files (relative to the root); default: every tracked file (git ls-files), or every
//                            file under the root when it is not the top of a git checkout (an exported tree)
//   --root <dir>             the tree to check (default: the git top level of the current directory, else the current directory)
//   --local-list <file>      the local deny list to use instead of <root>/.public-deny.local (an export checks its tree with the
//                            list of the repository it came from, so the list is never copied into the tree)
//   --allow-missing-local    run without the local deny list (.public-deny.local); only for a public clone, which has none
//   --no-exclude             check the excluded paths too (publish.json "exclude")
//   --summary                also print the finding counts per category and per folder
//
// Output: one line per finding, "<file>:<line> <category> <match>"; for the secret and the local categories the match is NOT
// printed, and on a line that holds a secret or a local entry no finding prints its text. Exit code: 0 no finding,
// 1 findings, 2 usage error (also a --paths file that does not exist) or missing local deny list.
//
// A line can waive one category with a marker anywhere on it: "public-check: allow <category> <reason>" (the reason is required).
// A file that cannot carry a marker (generated JSON) is waived in publish.json: "allow": [{ "path", "category", "reason" }].
//
// The patterns below are written so that this file does not match itself (a character class inside a literal word).
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const LOCAL_LIST = '.public-deny.local'
export const CONFIG = 'publish.json'

// Categories that apply to every text line.
const LINE_RULES = [
  // a Hungarian name takes suffixes (-nek, -tól, -é): any letters may follow
  { category: 'agent-name', re: /\b(?:tervez[o]|tesztel[o]|k[o]dol[o]|marvee[n])[a-z]*\b/gi, fold: true },
  { category: 'owner-name', re: /\bZ[s]olt[a-z]*\b/gi, fold: true },
  { category: 'telegram-ref', re: /\bTelegra[m]\s*[:#-]?\s*\d+/gi },
  { category: 'message-ref', re: /\b(?:ms[g](?:_id)?|messag[e](?:_id)?|[u]zenet)\s*[:#_-]?\s*\d{3,4}\b/gi, fold: true },
  { category: 'home-path', re: /\/hom[e]\/(?!<)[A-Za-z_][\w.-]*(?![\w.-])/g },
  // C:\Users\<name>, C:/Users/<name>, and the WSL form /mnt/c/Users/<name>
  { category: 'windows-user-path', re: /\b[A-Za-z]:(?:\\{1,2}|\/)User[s](?:\\{1,2}|\/)(?![<%$])[^\\/\s"'`<>]+|\/mn[t]\/[a-z]\/User[s]\/(?![<%$])[^\\/\s"'`<>]+/gi },
  // the macOS form /Users/<name>: case-sensitive (a web route like /users/:id is not one), not /Users/Shared, not a placeholder
  { category: 'windows-user-path', re: /(?<![\w.:])\/User[s]\/(?!Shared\b)(?![<%$:{])[^\\/\s"'`<>]+/g },
  { category: 'secret', secret: true, re: /-----BEGIN [A-Z ]*PRIVAT[E] KEY-----|\bsk-an[t]-[\w-]{8,}|\bgh[p]_[A-Za-z0-9]{20,}|\bxo[x][bp]-[\w-]{8,}|\bAKI[A][0-9A-Z]{16}\b/g },
  { category: 'email', re: /[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})\b/g, keep: (m) => !allowedMailDomain(m[1]) },
]

const SECRET_RULES = LINE_RULES.filter((r) => r.secret)

// Categories that apply only to comments, test titles and prose (documentation): an identifier in code is not a reference.
const NOTE_RULES = [
  { category: 'card-id', re: /\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{8}\b/g },
  { category: 'card-code', re: /\b(?:[A-Z]{1,2}-Q\d{1,2}|[A-Z]{1,2}\d{1,2}[a-z]?)\b/g, keep: (m) => !TECH_TOKENS.has(m[0]) },
  // a technical-looking code (C1, H1) is a card when a version stands before it or a point number after it
  { category: 'card-code', re: /(?:\b\d+\.\d+(?:\.\d+)?\s+([A-Z]{1,2}\d{1,2}[a-z]?)\b|\b([A-Z]{1,2}\d{1,2}[a-z]?)\s+\(?(?:\d+\.(?!\d)|poin[t]\s+\d|\d+\.?\s*pon[t]))/g,
    keep: (m) => TECH_TOKENS.has(m[1] || m[2]) },
  { category: 'plan-ref', re: /\b(?:pla[n]|ter[v])\s+(?:point\s+)?\d+(?:\.\d+)+\b/gi },
  { category: 'plan-ref', re: /\b(?:pla[n]|ter[v])(?:\s*:\s*|\s+)`?[\w.-]+\.m[d]\b|\bplan[s]\/[\w.-]+|\bcar[d]\s+point\s+\d+|\bkarty[a]\s+\d+\.\s*pon[t]/gi, fold: true },
  // review rounds and measurement / message pointers: "comment <n>" (also with # or :, and suffixed), "Linux <n>" (not a
  // year: Windows <year> is a product), "round <n>", "<ordinal> round" (not a round trip), "<n>. kör",
  // "<n> #<n>", "<n>/#<n>"
  { category: 'comment-ref', re: /\b(?:comm?en[t]|kommen[t])[a-z]*\s*[:#]?\s*\d{3,4}\b|\b(?:Window[s]|Linu[x])\s+(?!(?:19|20)\d\d\b)\d{3,4}\b|\brou[n]d\s+\d+\b|\b\d+(?:st|nd|rd|th)\s+rou[n]d\b|\b(?:first|second|third|fourth|fifth)\s+rou[n]d\b(?![\s-]*trip)|\b\d+\.\s*ko[r](?:e|ben|os|re|bol|nek|et|t)?\b|\b\d{3,4}\s*\/?\s*#\d+/gi, fold: true },
  // a commit of the private repository: 7-12 hex with a letter and a digit (8 is card-id; a longer run, e.g. a sha256, is not;
  // a lower-case algorithm name that happens to be hex is not one either)
  { category: 'commit-ref', re: /\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,12}\b/g, keep: (m) => m[0].length !== 8 && !HEX_WORDS.has(m[0]) },
]

// Upper-case letter+digit tokens that are technical names, not card codes.
const TECH_TOKENS = new Set(['MD5', 'V8', 'ES5', 'ES6', 'IE11', 'X11', 'A4', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P256', 'U2F', 'W3C', 'G1', 'C0', 'C1'])

// Hex-looking words that are names, not commits.
const HEX_WORDS = new Set(['ed25519'])

const MAIL_OK = new Set(['example', 'invalid', 'test', 'localhost'])
function allowedMailDomain (domain) {
  return domain.toLowerCase().split('.').some((label) => MAIL_OK.has(label))
}

const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.icns', '.webp', '.zip', '.gz', '.7z', '.pdf', '.woff', '.woff2',
  '.ttf', '.otf', '.exe', '.dll', '.node', '.sqlite', '.db', '.bin'])

// Comment syntax per extension; 'prose' = the whole line counts as a note.
const SLASH = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.css'])
const HASH = new Set(['.sh', '.py', '.yml', '.yaml', '.toml', '.gitignore', '.gitattributes', '.ps1'])
const PROSE = new Set(['.md', '.txt', ''])

const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '')

function syntaxOf (file) {
  const base = path.basename(file)
  const ext = base.startsWith('.') && !base.slice(1).includes('.') ? base : path.extname(base).toLowerCase()
  if (SLASH.has(ext)) return 'slash'
  if (HASH.has(ext)) return 'hash'
  if (ext === '.cmd' || ext === '.bat') return 'cmd'
  if (ext === '.html' || ext === '.htm' || ext === '.xml' || ext === '.svg') return 'markup'
  if (PROSE.has(ext)) return 'prose'
  return 'data'
}

// Returns, per line, the note text (comments, test titles, prose) of a file. A light scanner: it tracks strings and block
// comments, which is enough for the project's own sources.
export function noteText (text, syntax) {
  const lines = text.split(/\r?\n/)
  if (syntax === 'prose') return lines
  if (syntax === 'data') return lines.map(() => '')
  if (syntax === 'cmd') return lines.map((l) => (/^\s*(?:@?rem\b|::)/i.test(l) ? l : ''))
  if (syntax === 'markup') {
    let inside = false
    return lines.map((l) => {
      let out = ''
      let i = 0
      while (i < l.length) {
        if (inside) {
          const end = l.indexOf('-->', i)
          if (end < 0) { out += l.slice(i); break }
          out += l.slice(i, end); i = end + 3; inside = false
        } else {
          const start = l.indexOf('<!--', i)
          if (start < 0) break
          i = start + 4; inside = true
        }
      }
      return out
    })
  }
  if (syntax === 'hash') {
    let block = false
    return lines.map((l) => {
      if (block) { if (l.includes('#>')) block = false; return l }
      if (/^\s*<#/.test(l)) { block = !l.includes('#>'); return l }
      const m = /(^|\s)#(?!!)/.exec(l)
      return m ? l.slice(m.index) : ''
    })
  }
  // slash: //, /* */, the title of test(...), it(...), describe(...), suite(...), check(...), and the console.* texts
  const consoleTexts = consoleNotes(lines)
  let block = false
  return lines.map((l) => {
    let out = ''
    let quote = null
    for (let i = 0; i < l.length; i++) {
      const c = l[i]
      if (block) {
        if (c === '*' && l[i + 1] === '/') { block = false; i++; continue }
        out += c
        continue
      }
      if (quote) {
        if (c === '\\') { i++; continue }
        if (c === quote) quote = null
        continue
      }
      if (c === '/' && l[i + 1] === '/') { out += ' ' + l.slice(i + 2); break }
      if (c === '/' && l[i + 1] === '*') { block = true; i++; continue }
      if (c === '"' || c === "'" || c === '`') quote = c
    }
    const title = /\b(?:test|it|describe|suite|check)(?:\.\w+)?\(\s*(['"`])((?:\\.|(?!\1).)*)\1/.exec(l)
    if (title) out += ' ' + title[2]
    return out
  }).map((note, i) => note + consoleTexts[i])
}

const CONSOLE_CALL = /console\.(?:log|info|warn|error|debug)\s*\(/y
// after one of these characters or words a "/" starts a regular expression, otherwise it divides; not after "<", which
// in JSX is a closing tag ("</p>")
const BEFORE_REGEX = new Set([...'(,=:[!&|?{};+-*%>~^'])
const REGEX_WORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof', 'yield', 'await'])

// Per line, the text of the string and template literals that are arguments of a console.log/info/warn/error/debug
// call: what a run prints is read like a note. A small tokenizer: strings, templates with their ${...} parts (nested
// ones too), comments and regular expression literals are skipped as units, so a call is only found in code, and it
// ends at its own closing parenthesis, over lines if it must.
export function consoleNotes (lines) {
  const out = lines.map(() => '')
  const text = lines.join('\n')
  const len = text.length
  const starts = [0]
  for (let i = 0; i < len; i++) if (text[i] === '\n') starts.push(i + 1)
  const lineOf = (pos) => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= pos) lo = mid; else hi = mid - 1 }
    return lo
  }
  const note = (pos, s) => { const first = lineOf(pos); s.split('\n').forEach((part, k) => { out[first + k] += ' ' + part }) }

  // A template from just after its opening backtick; returns the index after the closing one.
  const template = (i, inCall) => {
    let from = i
    while (i < len) {
      const c = text[i]
      if (c === '\\') { i += 2; continue }
      if (c === '`') { if (inCall) note(from, text.slice(from, i)); return i + 1 }
      if (c === '$' && text[i + 1] === '{') {
        if (inCall) note(from, text.slice(from, i))
        i = code(i + 2, '}', inCall)
        from = i
        continue
      }
      i++
    }
    if (inCall) note(from, text.slice(from))
    return len
  }

  // Code from i up to the closer at depth 0 (null: to the end); returns the index after the closer.
  const code = (i, closer, inCall) => {
    let depth = 0
    let prev = '('
    let word = ''
    while (i < len) {
      const c = text[i]
      if (c === '"' || c === "'") {
        let j = i + 1
        while (j < len && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1
        if (inCall) note(i + 1, text.slice(i + 1, j))
        i = j + 1; prev = 'a'; word = ''
        continue
      }
      if (c === '`') { i = template(i + 1, inCall); prev = 'a'; word = ''; continue }
      if (c === '/' && text[i + 1] === '/') { const e = text.indexOf('\n', i); i = e < 0 ? len : e; continue }
      if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? len : e + 2; continue }
      if (c === '/' && (BEFORE_REGEX.has(prev) || REGEX_WORDS.has(word))) {
        let j = i + 1
        let inClass = false
        while (j < len && text[j] !== '\n') {
          const d = text[j]
          if (d === '\\') { j += 2; continue }
          if (inClass) { if (d === ']') inClass = false } else if (d === '[') inClass = true; else if (d === '/') break
          j++
        }
        i = j + 1
        while (i < len && /[a-z]/i.test(text[i])) i++
        prev = 'a'; word = ''
        continue
      }
      if (c === 'c' && !/[\w$.]/.test(text[i - 1] || '')) {
        CONSOLE_CALL.lastIndex = i
        const m = CONSOLE_CALL.exec(text)
        if (m) { i = code(i + m[0].length, ')', true); prev = 'a'; word = ''; continue }
      }
      if (c === '(' || c === '[' || c === '{') depth++
      else if (c === ')' || c === ']' || c === '}') {
        if (depth === 0 && closer !== null) return i + 1
        if (depth > 0) depth--
      }
      if (/[\w$]/.test(c)) word += c
      else if (!/\s/.test(c)) word = ''
      if (!/\s/.test(c)) prev = c
      i++
    }
    return len
  }
  code(0, null, false)
  return out
}

// File names: every segment of a published path, by the card-id and card-code rules (a name is always read). Technical
// names that look like a code are not one.
const PATH_TECH = new Set([...TECH_TOKENS, 'E2E', 'I18N', 'PS1', 'X64', 'X86'])
export function checkPath (rel) {
  const findings = []
  for (const seg of rel.split(/[\\/]/)) {
    const question = /(?<![A-Za-z0-9])[A-Za-z]{1,2}-Q\d{1,2}(?![A-Za-z0-9])/gi
    for (const m of seg.matchAll(question)) findings.push({ line: null, category: 'file-name', match: m[0] })
    for (const token of seg.replace(question, ' ').split(/[^A-Za-z0-9]+/)) {
      const code = /^[A-Za-z]{1,2}\d{1,2}[A-Za-z]?$/.test(token) && !PATH_TECH.has(token.toUpperCase())
      const id = /^[0-9a-f]{8}$/i.test(token) && /[a-f]/i.test(token) && /\d/.test(token)
      if (code || id) findings.push({ line: null, category: 'file-name', match: token })
    }
  }
  return findings
}

function readLocalList (root) {
  const file = path.join(root, LOCAL_LIST)
  return fs.existsSync(file) ? readListFile(file) : null
}

function readListFile (file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'))
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function readConfig (root) {
  const file = path.join(root, CONFIG)
  if (!fs.existsSync(file)) return { exclude: [], allow: [] }
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

// A whole-file waiver from publish.json "allow": [{ path, category, reason }], for files that cannot carry a marker (generated JSON).
function fileAllows (rel, allow) {
  const p = rel.split(path.sep).join('/')
  return new Set(allow.filter((a) => a.path === p && a.category && a.reason).map((a) => a.category))
}

export function isExcluded (rel, exclude) {
  const p = rel.split(path.sep).join('/')
  return exclude.some((e) => (e.endsWith('/') ? p.startsWith(e) : p === e))
}

// The tracked files when the root is the top of a git work tree, otherwise every file under it. A folder inside another
// repository (an export in a work tree) is walked: there "git ls-files" would list nothing, and the check would pass.
function listFiles (root) {
  let top = null
  try {
    top = execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {}
  if (top && fs.realpathSync(path.resolve(top)) === fs.realpathSync(root)) {
    const out = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return out.split('\0').filter(Boolean)
  }
  const ignored = gitignoreMatcher(root)
  const files = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules') continue
      const rel = dir ? `${dir}/${e.name}` : e.name
      if (ignored(rel, e.isDirectory())) continue
      if (e.isDirectory()) walk(rel)
      else if (e.isFile() && e.name !== LOCAL_LIST) files.push(rel)
    }
  }
  walk('')
  return files
}

// The simple patterns of the root .gitignore (a name, a glob with * and ?, a trailing / for a folder, a leading or inner /
// for a path from the root, and "!" to take a path back), so a walked tree skips what git would not track: build output
// (out/, dist/), data folders, logs. As in git, the last matching pattern decides.
export function gitignoreMatcher (root) {
  const file = path.join(root, '.gitignore')
  const rules = (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : [])
    .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const negate = l.startsWith('!')
      const dirOnly = l.endsWith('/')
      const body = l.replace(/^!/, '').replace(/\/+$/, '')
      const anchored = body.includes('/')
      const glob = body.replace(/^\//, '').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')
      return { negate, dirOnly, anchored, re: new RegExp(`^${glob}$`) }
    })
  return (rel, isDir) => {
    let skip = false
    for (const r of rules) {
      if ((!r.dirOnly || isDir) && r.re.test(r.anchored ? rel : rel.slice(rel.lastIndexOf('/') + 1))) skip = !r.negate
    }
    return skip
  }
}

function isBinary (rel, buf) {
  if (BINARY_EXT.has(path.extname(rel).toLowerCase())) return true
  return buf.subarray(0, 8000).includes(0)
}

// Checks one file's text; returns [{ line, category, match }].
export function checkText (rel, text, localList = [], fileAllowed = new Set()) {
  const findings = []
  const notes = noteText(text, syntaxOf(rel))
  const localRules = localList.map((entry) => ({
    category: 'local-deny', secret: true, re: new RegExp(`(?<![A-Za-z0-9])${escapeRe(entry)}(?![A-Za-z0-9])`, 'gi'),
  }))
  text.split(/\r?\n/).forEach((line, i) => {
    const allowed = new Set([...fileAllowed, ...[...line.matchAll(/public-check: allow ([\w-]+) \S/g)].map((m) => m[1])])
    const seen = new Set()
    const run = (rules, src) => {
      for (const rule of rules) {
        if (allowed.has(rule.category) || seen.has(rule.category)) continue
        const subject = rule.fold ? fold(src) : src
        for (const m of subject.matchAll(rule.re)) {
          if (rule.keep && !rule.keep(m)) continue
          findings.push({ line: i + 1, category: rule.category, match: rule.secret ? null : m[0] })
          seen.add(rule.category)
          break
        }
      }
    }
    const first = findings.length
    run(LINE_RULES, line)
    run(localRules, line)
    if (notes[i]) run(NOTE_RULES, notes[i])
    // A local entry or a secret can sit inside another category's match (an address on the test host, a home path named
    // after the machine): on such a line no finding prints its text. Checked regardless of a waiver. search(), not test():
    // a global regex's test() leaves lastIndex behind, and matchAll() on the next line would start from there.
    if ([...SECRET_RULES, ...localRules].some((r) => line.search(r.re) !== -1)) {
      for (let k = first; k < findings.length; k++) findings[k].match = null
    }
  })
  if (needsSpdx(rel) && !text.split(/\r?\n/, 3).join('\n').includes(SPDX_LINE) && !fileAllowed.has('spdx-missing')) {
    findings.unshift({ line: 1, category: 'spdx-missing', match: 'no license line' })
  }
  return findings
}

// Every source file of the program and its scripts names its license in its first 3 lines (after a shebang or doctype).
export const SPDX_LINE = 'SPDX-License-Identifier: GPL-3.0-or-later'
const SPDX_DIRS = ['app/', 'core/', 'scripts/']
const SPDX_EXT = new Set(['.js', '.mjs', '.cjs', '.jsx', '.css', '.sh', '.ps1', '.py', '.cmd', '.html'])
export function needsSpdx (rel) {
  const p = rel.split(path.sep).join('/')
  return SPDX_DIRS.some((d) => p.startsWith(d)) && SPDX_EXT.has(path.extname(p).toLowerCase())
}

function main (argv) {
  const opts = { paths: null, root: null, localList: null, allowMissingLocal: false, noExclude: false, summary: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--allow-missing-local') opts.allowMissingLocal = true
    else if (a === '--no-exclude') opts.noExclude = true
    else if (a === '--summary') opts.summary = true
    else if (a === '--root') opts.root = argv[++i]
    else if (a === '--local-list') opts.localList = argv[++i]
    else if (a === '--paths') {
      opts.paths = []
      while (argv[i + 1] && !argv[i + 1].startsWith('--')) opts.paths.push(argv[++i])
      if (!opts.paths.length) { console.error('public-check: --paths needs at least one file'); return 2 }
    }
    else { console.error(`public-check: unknown argument ${a}`); return 2 }
  }
  let root = opts.root
  if (!root) {
    try { root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { root = process.cwd() }
  }
  root = path.resolve(root)
  if (opts.localList !== null && !(opts.localList && fs.existsSync(opts.localList) && fs.statSync(opts.localList).isFile())) {
    console.error(`public-check: --local-list: not a file: ${opts.localList || '(none given)'}`)
    return 2
  }
  const local = opts.localList ? readListFile(opts.localList) : readLocalList(root)
  if (!local && !opts.allowMissingLocal) {
    console.error(`public-check: the local deny list ${LOCAL_LIST} is missing in ${root} (one host or machine name per line, not tracked).`)
    console.error('public-check: in a public clone, which has nothing to hide, run it with --allow-missing-local.')
    return 2
  }
  const { exclude = [], allow = [] } = readConfig(root)
  // a mistyped --paths file is an error, not a green run
  const notFiles = (opts.paths || []).filter((f) => { const abs = path.join(root, f); return !fs.existsSync(abs) || !fs.statSync(abs).isFile() })
  if (notFiles.length) { for (const f of notFiles) console.error(`public-check: not a file: ${f}`); return 2 }
  const files = (opts.paths || listFiles(root)).filter((f) => opts.noExclude || !isExcluded(f, exclude))
  const findings = []
  for (const rel of files) {
    const abs = path.join(root, rel)
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue
    if (!fileAllows(rel, allow).has('file-name')) for (const f of checkPath(rel)) findings.push({ file: rel, ...f })
    const buf = fs.readFileSync(abs)
    if (isBinary(rel, buf)) continue
    for (const f of checkText(rel, buf.toString('utf8'), local || [], fileAllows(rel, allow))) findings.push({ file: rel, ...f })
  }
  for (const f of findings) console.log(`${f.file}${f.line === null ? '' : ':' + f.line} ${f.category}${f.match === null ? '' : ' ' + JSON.stringify(f.match.slice(0, 80))}`)
  if (opts.summary) {
    const by = (key) => findings.reduce((acc, f) => { const k = key(f); acc[k] = (acc[k] || 0) + 1; return acc }, {})
    const folder = (f) => { const parts = f.file.split('/'); return parts.length > 2 ? parts.slice(0, 2).join('/') : parts.length === 2 ? parts[0] : '.' }
    console.log('\nby category:'); for (const [k, v] of Object.entries(by((f) => f.category)).sort()) console.log(`  ${k} ${v}`)
    console.log('by folder:'); for (const [k, v] of Object.entries(by(folder)).sort()) console.log(`  ${k} ${v}`)
  }
  console.log(`public-check: ${files.length} files, ${findings.length} findings${local ? '' : ' (no local deny list)'}`)
  return findings.length ? 1 : 0
}

// fileURLToPath, not URL.pathname: on Windows that is "/C:/...", and the script would never run its main
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2))
