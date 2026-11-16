#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Writes THIRD-PARTY-NOTICES.txt: the name, version, license and license text of every production dependency (the
// packages that go into the Windows package), read from node_modules. No dependency of its own.
//
//   node scripts/third-party-notices.mjs [--check] [--table]
//
//   --check   do not write; exit 1 if the file on disk differs from what would be written
//   --table   also print a table: name, version, the license the package declares, the license its file text shows
//
// The license is read twice: the package.json field, and the text of its LICENSE / LICENCE / COPYING file (a few
// well-known texts are recognised). A package with two licenses to choose from is listed with the one this project uses.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// fileURLToPath, not URL.pathname: on Windows that is "/C:/..."
const SELF = fileURLToPath(import.meta.url)
const ROOT = path.resolve(path.dirname(SELF), '..')
const OUT = path.join(ROOT, 'THIRD-PARTY-NOTICES.txt')
// dual-licensed packages: the license this project takes
const CHOSEN = { '@zone-eu/mailsplit': 'MIT', dompurify: 'Apache-2.0' }

// The renderer is bundled by Vite into out/renderer, which goes into the package: every package the renderer imports is
// shipped, a devDependency too (lucide-react: compiled in, not copied as a package).
export function rendererImports () {
  const names = new Set()
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(m?js|jsx)$/.test(e.name)) {
        const text = fs.readFileSync(p, 'utf8')
        // import x from 'p', import 'p', export ... from 'p' (at a line start), and import('p')
        const specs = [
          ...text.matchAll(/^\s*(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"./][^'"]*)['"]/gm),
          ...text.matchAll(/\bimport\(\s*['"]([^'"./][^'"]*)['"]\s*\)/g),
        ]
        for (const m of specs) {
          const spec = m[1]
          if (spec.startsWith('node:')) continue
          names.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0])
        }
      }
    }
  }
  walk(path.join(ROOT, 'app', 'renderer'))
  return [...names].sort()
}

function productionPackages () {
  // on Windows npm is npm.cmd, which only a shell starts (the arguments are fixed, nothing to quote)
  const out = execFileSync('npm', ['ls', '--omit=dev', '--all', '--parseable'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 << 20, shell: process.platform === 'win32' })
  const dirs = [...new Set(out.split('\n').map((s) => s.trim()).filter((d) => d && d !== ROOT))]
  for (const name of rendererImports()) {
    const dir = path.join(ROOT, 'node_modules', name)
    if (fs.existsSync(path.join(dir, 'package.json')) && !dirs.includes(dir)) dirs.push(dir)
  }
  return dirs.map((dir) => {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    const declared = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type || (pkg.licenses || []).map((l) => l.type || l).join(' OR ') || 'UNKNOWN'
    const files = fs.readdirSync(dir).filter((f) => /^(licen[cs]e|copying|notice)(\b|[._-])/i.test(f) && fs.statSync(path.join(dir, f)).isFile()).sort()
    const texts = files.map((f) => ({ file: f, text: fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n').trim() }))
    const native = NATIVE_SOURCES[pkg.name]
    const included = native ? { file: native, entries: nativeNotices(fs.readFileSync(path.join(dir, native), 'utf8')) } : null
    return { name: pkg.name, version: pkg.version, declared, files: texts, included }
  }).sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
}

// The native module is compiled from one amalgamated C file: SQLite (public domain) and the SQLite3MultipleCiphers
// extension with the third-party code it includes (AEGIS, SHA-2, Argon2, miniz ...). Their copyright lines and license
// texts are only in the comments of that file, so they are collected from there.
const NATIVE_SOURCES = { 'better-sqlite3-multiple-ciphers': 'deps/sqlite3/sqlite3.c' }

// a comment that carries a license text or a public-domain statement (not just a copyright line)
const LICENSE_TEXT = /Permission is hereby granted|Redistribution and use in source and binary forms|You may use this work under|public domain|dedicated all copyright|waived all copyright/i
// a line that names a copyright holder or a license; "disclaims copyright" is SQLite's public-domain blessing
const NOTICE_LINE = /^(?:Copyright\b(?!.*\bdisclaim)|License:|SPDX-License-Identifier:)/i
const INCLUDE_MARK = /^\*\*\* (Begin|End) of #include "([^"]+)" \*\*\*$/

function commentLines (raw) {
  const lines = raw.replace(/\r\n?/g, '\n').replace(/\t/g, ' ').split('\n').map((l) => l
    .replace(/^\s*\/\*+/, '').replace(/\*+\/\s*$/, '').replace(/^\s*\/\/+ ?/, '').replace(/^\s*\*+(?= |$)/, '').replace(/^ /, '').trimEnd())
  const body = lines.filter((l) => !/^[*=\-_ ]+$/.test(l) || l.trim() === '')
  while (body.length && !body[0].trim()) body.shift()
  while (body.length && !body.at(-1).trim()) body.pop()
  const indent = Math.min(...body.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length))
  return body.map((l) => l.slice(Number.isFinite(indent) ? indent : 0))
}

// The comments of a C source, in order: /* ... */ blocks and runs of // lines. String and character literals are
// skipped, so a "/*" inside one does not start a comment.
function* comments (source) {
  const re = /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|\/\*[\s\S]*?\*\/|(?:[ \t]*\/\/[^\n]*(?:\n|$))+/g
  for (const m of source.matchAll(re)) if (m[0][0] === '/' || m[0].trimStart().startsWith('//')) yield m[0]
}

// Every distinct notice of a C source, in order of first appearance: a comment with a license text in full, otherwise
// its copyright, "License:" and SPDX lines. Each notice once, with the top-level included files it was found in.
export function nativeNotices (source) {
  const found = new Map()
  const stack = []
  for (const raw of comments(source)) {
    const mark = raw.trim().replace(/^\/|\/$/g, '').trim().match(INCLUDE_MARK)
    if (mark) {
      if (mark[1] === 'Begin') stack.push(mark[2])
      else stack.pop()
      continue
    }
    const lines = commentLines(raw)
    const text = lines.join('\n')
    let notice
    if (LICENSE_TEXT.test(text.replace(/\s+/g, ' '))) notice = text
    else {
      const picked = lines.map((l) => l.trim().replace(/\s+/g, ' ')).filter((l) => NOTICE_LINE.test(l))
      if (!picked.length) continue
      notice = picked.join('\n')
    }
    const key = notice.replace(/\s+/g, ' ').trim()
    if (!found.has(key)) found.set(key, { text: notice, files: new Set() })
    found.get(key).files.add(stack[0] || '(the file itself)')
  }
  return [...found.values()].map((e) => ({ text: e.text, files: [...e.files] }))
}

// A few well-known license texts, by their key sentences.
export function detect (text) {
  const t = text.replace(/\s+/g, ' ')
  if (/Apache License,? Version 2\.0/i.test(t)) return 'Apache-2.0'
  if (/Mozilla Public License,? (v\. |version )?2\.0/i.test(t)) return 'MPL-2.0'
  if (/Permission to use, copy, modify, and\/or distribute this software for any purpose with or without fee is hereby granted/i.test(t)) return 'ISC'
  if (/Permission is hereby granted, free of charge/i.test(t)) {
    return /The above copyright notice and this permission notice shall be included/i.test(t) ? 'MIT' : 'MIT-0'
  }
  if (/Redistribution and use in source and binary forms/i.test(t)) {
    return /Neither the name|names of (its|the) contributors may be used/i.test(t) ? 'BSD-3-Clause' : 'BSD-2-Clause'
  }
  // the EUPL names the GPL among its compatible licenses, so it is recognised first (also in its other languages: "EUPL")
  if (/\bEUPL\b|European Union Public Licen[cs]e/i.test(t)) return 'EUPL'
  if (/GNU (LESSER|LIBRARY) GENERAL PUBLIC LICENSE/i.test(t)) return 'LGPL'
  if (/GNU GENERAL PUBLIC LICENSE/i.test(t)) return 'GPL'
  return 'unrecognised'
}

export function includedSection (included) {
  if (!included) return []
  const head = [
    `--- Included in the native module (compiled from ${included.file}) ---`,
    'The native module is built from one C file: SQLite, which is in the public domain, and SQLite3MultipleCiphers with',
    'the code it includes. Below are the copyright lines, license texts and public-domain statements of its comments, each',
    'once, with the included file(s) it was found in.',
    '',
  ]
  const entries = included.entries.flatMap((e, i) => {
    const files = e.files.length > 4 ? `${e.files.slice(0, 4).join(', ')} and ${e.files.length - 4} more` : e.files.join(', ')
    return [`[${i + 1}] found in: ${files}`, e.text, '']
  })
  return [...head, ...entries]
}

function render (pkgs) {
  const head = [
    'THIRD-PARTY NOTICES',
    '',
    'ShadowMail is licensed under GPL-3.0-or-later (see LICENSE). It includes the following third-party packages, each under',
    'its own license, listed with its license text as found in the package. Electron and Chromium carry their own license',
    'files in the package (LICENSE.electron.txt, LICENSES.chromium.html).',
    '',
  ]
  const body = pkgs.flatMap((p) => {
    const license = CHOSEN[p.name] ? `${CHOSEN[p.name]} (chosen from: ${p.declared})` : p.declared
    const texts = p.files.length ? p.files.flatMap((f) => [`--- ${f.file} ---`, f.text, '']) : ['(the package ships no license file; its package.json names the license above)', '']
    return ['='.repeat(100), `${p.name} ${p.version}`, `License: ${license}`, '', ...texts, ...includedSection(p.included)]
  })
  return [...head, ...body].join('\n').replace(/\n+$/, '\n')
}

function main (argv) {
  const pkgs = productionPackages()
  const text = render(pkgs)
  if (argv.includes('--table')) {
    for (const p of pkgs) {
      const found = [...new Set(p.files.filter((f) => !/^notice/i.test(f.file)).map((f) => detect(f.text)))].join('+') || '-'
      console.log(`${p.name}\t${p.version}\t${p.declared}\t${found}\t${CHOSEN[p.name] || ''}`)
    }
  }
  if (argv.includes('--check')) {
    const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : ''
    if (current !== text) { console.error('third-party-notices: THIRD-PARTY-NOTICES.txt is out of date (run without --check)'); return 1 }
    console.log(`third-party-notices: up to date, ${pkgs.length} packages`)
    return 0
  }
  fs.writeFileSync(OUT, text)
  console.log(`third-party-notices: ${pkgs.length} packages -> ${path.relative(ROOT, OUT)}`)
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) process.exitCode = main(process.argv.slice(2))
