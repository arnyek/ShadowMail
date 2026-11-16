// THIRD-PARTY-NOTICES.txt (scripts/third-party-notices.mjs): every production package of the lockfile is in it, it is up
// to date with node_modules, the well-known license texts are told apart, and the package carries it and the LICENSE.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = fileURLToPath(new URL('..', import.meta.url))
const script = fileURLToPath(new URL('../scripts/third-party-notices.mjs', import.meta.url))

test('third-party notices: every production package of the lockfile and every package the renderer bundle imports is listed, with its version', async () => {
  const { rendererImports } = await import(pathToFileURL(script).href)
  const lock = JSON.parse(fs.readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'))
  const nameOf = (p) => p.slice(p.lastIndexOf('node_modules/') + 'node_modules/'.length)
  const prod = Object.entries(lock.packages)
    .filter(([p, v]) => p.startsWith('node_modules/') && !v.dev && !v.devOptional)
    .map(([p, v]) => `${nameOf(p)} ${v.version}`)
  // the renderer is compiled into out/renderer, which the package carries: a devDependency it imports ships too
  const bundled = rendererImports().map((n) => `${n} ${lock.packages[`node_modules/${n}`].version}`)
  assert.ok(rendererImports().includes('lucide-react'))
  const notices = fs.readFileSync(new URL('../THIRD-PARTY-NOTICES.txt', import.meta.url), 'utf8')
  const listed = [...notices.matchAll(/^={100}\n(\S+) (\S+)\nLicense: /gm)].map((m) => `${m[1]} ${m[2]}`)
  assert.ok(prod.length > 0)
  assert.deepEqual([...new Set(listed)].sort(), [...new Set([...prod, ...bundled])].sort())
})

test('third-party notices: the file is up to date with node_modules (--check)', () => {
  const r = spawnSync(process.execPath, [script, '--check'], { cwd: root, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr + r.stdout)
  // the script really ran its check: a main that never runs (a wrong "am I the entry point" test) also exits 0
  assert.match(r.stdout, /^third-party-notices: up to date, \d+ packages$/m)
})

// The native module's section: the part of THIRD-PARTY-NOTICES.txt after its heading, up to the next package.
function nativeSection () {
  const notices = fs.readFileSync(new URL('../THIRD-PARTY-NOTICES.txt', import.meta.url), 'utf8')
  const start = notices.indexOf('--- Included in the native module (compiled from deps/sqlite3/sqlite3.c) ---')
  assert.ok(start > notices.indexOf('\nbetter-sqlite3-multiple-ciphers '), 'the section is under the native module')
  const end = notices.indexOf('\n' + '='.repeat(100), start)
  return notices.slice(start, end < 0 ? undefined : end)
}
// one entry: its "[n] found in:" line and its text
const entries = (section) => section.split(/\n(?=\[\d+\] found in: )/).slice(1)
const oneLine = (s) => s.replace(/\s+/g, ' ').trim()

test('third-party notices: the native module lists SQLite3MultipleCiphers, AEGIS, SHA-2 and Argon2/BLAKE2 by name', () => {
  const section = nativeSection()
  assert.match(section, /SQLite, which is in the public domain, and SQLite3MultipleCiphers/)
  const all = entries(section)
  const find = (re) => all.filter((e) => re.test(e))
  // SQLite3MultipleCiphers: the amalgamation's own header
  assert.ok(find(/^\[\d+\] found in: \(the file itself\)\nCopyright: \(c\) 2006-\d{4} Ulrich Telle\nLicense: MIT\n/).length === 1)
  // AEGIS: 236 file headers of the library, one entry
  assert.deepEqual(find(/Frank Denis/), [find(/Frank Denis/)[0]])
  assert.match(find(/Frank Denis/)[0], /^\[\d+\] found in: aegis\/libaegis\.c\nCopyright: \(c\) 2023-2024 Frank Denis\nSPDX-License-Identifier: MIT\n/)
  // Argon2 and its BLAKE2b: Creative Commons Zero or Apache-2.0
  const argon = find(/Daniel Dinu, Dmitry Khovratovich, Jean-Philippe Aumasson, and Samuel Neves/)
  assert.equal(argon.length, 1)
  assert.match(argon[0], /^\[\d+\] found in: argon2\/libargon2\.c\nArgon2 reference source code package/)
  assert.match(oneLine(argon[0]), /You may use this work under the terms of a Creative Commons CC0 1\.0 License\/Waiver or the Apache Public License 2\.0, at your option\./)
  // SHA-2: the full BSD-3-Clause text, word for word
  const sha2 = find(/Olivier Gay/)
  assert.equal(sha2.length, 1)
  assert.ok(sha2[0].includes([
    'Copyright (C) 2005, 2007 Olivier Gay <olivier.gay@a3.epfl.ch>', // public-check: allow email the third-party copyright line, word for word
    'All rights reserved.',
    '',
    'Redistribution and use in source and binary forms, with or without',
    'modification, are permitted provided that the following conditions',
    'are met:',
    '1. Redistributions of source code must retain the above copyright',
    '   notice, this list of conditions and the following disclaimer.',
    '2. Redistributions in binary form must reproduce the above copyright',
    '   notice, this list of conditions and the following disclaimer in the',
    '   documentation and/or other materials provided with the distribution.',
    '3. Neither the name of the project nor the names of its contributors',
    '   may be used to endorse or promote products derived from this software',
    '   without specific prior written permission.',
    '',
    "THIS SOFTWARE IS PROVIDED BY THE PROJECT AND CONTRIBUTORS ``AS IS'' AND",
    'ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE',
    'IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE',
    'ARE DISCLAIMED.  IN NO EVENT SHALL THE PROJECT OR CONTRIBUTORS BE LIABLE',
    'FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL',
    'DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS',
    'OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)',
    'HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT',
    'LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY',
    'OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF',
    'SUCH DAMAGE.',
  ].join('\n')), sha2[0])
  assert.match(sha2[0], /^\[\d+\] found in: sha2\.c\n/)
})

test('third-party notices: every copyright line and SPDX line of the native source is in its section', () => {
  // read line by line, without the comment parser of the script: a comment it misses would show here
  const source = fs.readFileSync(new URL('../node_modules/better-sqlite3-multiple-ciphers/deps/sqlite3/sqlite3.c', import.meta.url), 'utf8')
  const wanted = new Set(source.split('\n')
    .map((l) => oneLine(l.replace(/^\s*(?:\/\*+|\*+|\/\/+)/, '')))
    .filter((l) => /^(?:Copyright\b(?!.*\bdisclaim)(?! notice)|SPDX-License-Identifier:)/i.test(l)))
  assert.ok(wanted.size >= 20, `${wanted.size} distinct lines`)
  const section = oneLine(nativeSection())
  const missing = [...wanted].filter((l) => !section.includes(l))
  assert.deepEqual(missing, [])
})

test('third-party notices: the native notices are collected from the comments, each once, by included file', async () => {
  const { nativeNotices, includedSection } = await import(pathToFileURL(script).href)
  const source = [
    '/*\n** Copyright:\t(c) 2020 Someone\n** License:     MIT\n*/',
    'static const char *s = "/* Copyright 1999 Not A Comment */"; /* Copyright 2000 Behind A String */',
    "static const char c = '\"'; /* Copyright 2001 After A Quote */",
    '/*** Begin of #include "lib/one.c" ***/',
    '/*\n** Name: a.c\n** Copyright:   (c) 2021 Lib Author\n** SPDX-License-Identifier: MIT\n*/',
    '/*** Begin of #include "inner.h" ***/',
    '/*\n** Name: b.h\n** Copyright: (c) 2021 Lib Author\n** SPDX-License-Identifier:   MIT\n*/',
    '/*** End of #include "inner.h" ***/',
    '/*** End of #include "lib/one.c" ***/',
    '/*** Begin of #include "two.c" ***/',
    '// This code is placed in the public domain.\n// No warranty.',
    '/*\n** The author disclaims copyright to this source code.\n*/',
    '/*\n * Copyright 2005 Text Owner\n *\n * Redistribution and use in source and binary forms, with or without\n *    modification, are permitted.\n */',
    '/*** End of #include "two.c" ***/',
  ].join('\n')
  const got = nativeNotices(source)
  assert.deepEqual(got, [
    { text: 'Copyright: (c) 2020 Someone\nLicense: MIT', files: ['(the file itself)'] },
    { text: 'Copyright 2000 Behind A String', files: ['(the file itself)'] },
    { text: 'Copyright 2001 After A Quote', files: ['(the file itself)'] },
    { text: 'Copyright: (c) 2021 Lib Author\nSPDX-License-Identifier: MIT', files: ['lib/one.c'] },
    { text: 'This code is placed in the public domain.\nNo warranty.', files: ['two.c'] },
    { text: 'Copyright 2005 Text Owner\n\nRedistribution and use in source and binary forms, with or without\n   modification, are permitted.', files: ['two.c'] },
  ])
  const text = includedSection({ file: 'x.c', entries: got }).join('\n')
  assert.match(text, /^--- Included in the native module \(compiled from x\.c\) ---\n/)
  assert.match(text, /\n\[4\] found in: lib\/one\.c\nCopyright: \(c\) 2021 Lib Author\nSPDX-License-Identifier: MIT\n/)
  assert.deepEqual(includedSection(null), [])
})

test('third-party notices: the well-known license texts are told apart', async () => {
  const { detect } = await import(pathToFileURL(script).href)
  const mit = 'Permission is hereby granted, free of charge, to any person ... The above copyright notice and this permission notice shall be included in all copies'
  assert.equal(detect(mit), 'MIT')
  assert.equal(detect('Permission is hereby granted, free of charge, to any person obtaining a copy ...'), 'MIT-0')
  assert.equal(detect('Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted'), 'ISC')
  assert.equal(detect('Redistribution and use in source and binary forms ... Neither the name of the copyright holder'), 'BSD-3-Clause')
  assert.equal(detect('Redistribution and use in source and binary forms, with or without modification'), 'BSD-2-Clause')
  assert.equal(detect('Apache License, Version 2.0'), 'Apache-2.0')
  assert.equal(detect('EUPL v. 1.2 ... compatible: GNU General Public License'), 'EUPL')
  assert.equal(detect('some other text'), 'unrecognised')
})

test('the package carries the license and the notices next to the exe', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.license, 'GPL-3.0-or-later')
  assert.deepEqual(pkg.build.extraFiles.map((f) => f.from).sort(), ['LICENSE', 'THIRD-PARTY-NOTICES.txt'])
  assert.match(fs.readFileSync(new URL('../LICENSE', import.meta.url), 'utf8'), /GNU GENERAL PUBLIC LICENSE\s+Version 3, 29 June 2007/)
})
