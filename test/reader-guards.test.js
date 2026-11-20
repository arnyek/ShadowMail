// Reader guards without a window: attachment file names and executable types, external image hosts,
// the net guard's decisions, the message frame's protocols (own CSP, cid images of the open message
// only), and the reader IPC (argument checks, executables can only be saved, data/tmp).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { safeFileName, isExecutableName, isBrowserActiveName, isOpenableName, externalImageHosts, parseMessage, EXECUTABLE_EXTENSIONS, BROWSER_ACTIVE_EXTENSIONS, OPENABLE_EXTENSIONS } from '../core/mime/message.js'
import { netDecision, guardLogLine, installNetGuard } from '../app/main/net-guard.js'
import { viewCsp, viewDocument, handleMailProtocols, registerMailSchemes } from '../app/main/protocols.js'
import { registerReaderIpc, emptyTmpDir, READER_CHANNELS } from '../app/main/ipc/reader.js'
import { ActionError } from '../app/main/sync-manager.js'
import { tempDir } from './helpers/tmp.js'

test('executable types: every listed type, any case, trailing dots/spaces and double extensions', () => {
  for (const ext of ['.exe', '.bat', '.cmd', '.com', '.scr', '.msi', '.ps1', '.vbs', '.js', '.jse', '.wsf', '.hta', '.lnk', '.cpl', '.reg', '.jar']) {
    assert.ok(EXECUTABLE_EXTENSIONS.includes(ext), ext)
    assert.equal(isExecutableName(`a${ext}`), true, ext)
    assert.equal(isExecutableName(`A${ext.toUpperCase()}`), true, ext)
  }
  assert.equal(isExecutableName('szamla.pdf.exe'), true)
  assert.equal(isExecutableName('szamla.exe.'), true, 'Windows drops the trailing dot')
  assert.equal(isExecutableName('szamla.exe  . '), true)
  assert.equal(isExecutableName('szamla.pdf'), false)
  assert.equal(isExecutableName('kep.png'), false)
  // right-to-left override: "evil\u202Efdp.exe" looks like "evilexe.pdf"
  assert.equal(safeFileName('evil\u202Efdp.exe'), 'evil_fdp.exe')
  assert.equal(isExecutableName('evil\u202Efdp.exe'), true)
})

test('browser-active types: HTML, SVG, MHT, XML are save-only, any case, double extensions; separate from executables', () => {
  for (const ext of ['.html', '.htm', '.xhtml', '.xht', '.shtml', '.svg', '.svgz', '.mht', '.mhtml', '.xml', '.xsl', '.xslt']) {
    assert.ok(BROWSER_ACTIVE_EXTENSIONS.includes(ext), ext)
    assert.equal(isBrowserActiveName(`a${ext}`), true, ext)
    assert.equal(isBrowserActiveName(`A${ext.toUpperCase()}`), true, ext)
    assert.equal(isExecutableName(`a${ext}`), false, `${ext} is its own list`)
  }
  assert.equal(isBrowserActiveName('szamla.pdf.html'), true)
  assert.equal(isBrowserActiveName('SZAMLA.PDF.HTML'), true)
  assert.equal(isBrowserActiveName('kep.svg.'), true, 'trailing dot')
  assert.equal(isBrowserActiveName('level.MHT'), true)
  assert.equal(isBrowserActiveName('szamla.html.pdf'), false)
  assert.equal(isBrowserActiveName('szamla.pdf'), false)
  assert.equal(isBrowserActiveName('kep.png'), false)
})

test('safe file names: no folders, no reserved names or characters, never empty', () => {
  assert.equal(safeFileName('../../Windows/system32/x.dll'), '.._.._Windows_system32_x.dll')
  assert.equal(safeFileName('C:\\temp\\a.txt'), 'C__temp_a.txt')
  assert.equal(safeFileName('con.txt'), '_con.txt')
  assert.equal(safeFileName('LPT1'), '_LPT1')
  assert.equal(safeFileName(''), 'melleklet')
  assert.equal(safeFileName('...'), 'melleklet')
  assert.equal(safeFileName('a<b>:"|?*.txt'), 'a_b______.txt')
  assert.equal(safeFileName('Számla 2026 – május.pdf'), 'Számla 2026 – május.pdf')
  const long = safeFileName(`${'x'.repeat(300)}.pdf`)
  assert.equal(long.length, 150)
  assert.ok(long.endsWith('.pdf'))
})

test('external image hosts: <img src> and srcset only, protocol-relative and entities handled', () => {
  const hosts = externalImageHosts(`
    <img src="https://A.example.invalid/x.png"><img src="//b.example.invalid/y.png">
    <img srcset="https://c.example.invalid/1.png 1x, http://d.example.invalid:8080/2.png 2x">
    <img src="cid:logo"><img src="data:image/png;base64,AAAA"><img src="relative.png">
    <div style="background:url(https://css.example.invalid/z.png)"></div><link href="https://link.example.invalid/s.css">
    <img src="https&#58;//e.example.invalid/e.png">`)
  assert.deepEqual([...hosts].sort(), ['a.example.invalid', 'b.example.invalid', 'c.example.invalid', 'd.example.invalid:8080', 'e.example.invalid'])
  assert.equal(externalImageHosts(null).size, 0)
})

test('parseMessage: a broken or empty source does not throw the whole reader away', async () => {
  const m = await parseMessage(Buffer.from('Subject: csak fejlec\r\n\r\n'))
  assert.equal(m.subject, 'csak fejlec')
  assert.equal(m.html, null)
  assert.deepEqual(m.attachments, [])
})

test('net guard: http(s), ws(s), ftp blocked; images only from the allowed hosts; local schemes pass', () => {
  const allowed = new Set(['img.example.invalid', '127.0.0.1:47811'])
  const d = (url, resourceType = 'image', hosts = allowed) => netDecision({ url, resourceType }, hosts)
  assert.equal(d('https://img.example.invalid/a.png'), 'allow')
  assert.equal(d('http://127.0.0.1:47811/kep.png'), 'allow')
  assert.equal(d('http://127.0.0.1:47812/kep.png'), 'block', 'other port')
  assert.equal(d('https://IMG.example.invalid/a.png'), 'allow', 'host case')
  assert.equal(d('https://img.example.invalid/style.css', 'stylesheet'), 'block', 'only images')
  assert.equal(d('https://img.example.invalid/f.woff', 'font'), 'block')
  assert.equal(d('https://img.example.invalid/', 'subFrame'), 'block')
  assert.equal(d('https://other.example.invalid/a.png'), 'block')
  assert.equal(d('https://img.example.invalid/a.png', 'image', new Set()), 'block', 'nothing allowed')
  assert.equal(d('wss://img.example.invalid/', 'webSocket'), 'block')
  assert.equal(d('ftp://img.example.invalid/a.png'), 'block')
  for (const url of ['file:///C:/app/index.html', 'mail-view://view/abc', 'cid-img://m1/x', 'data:image/png;base64,AA', 'devtools://devtools/x']) {
    assert.equal(d(url, 'mainFrame'), 'pass', url)
  }
  assert.equal(d('not a url'), 'block')
  // the log line has the host, not the path or the query (tracking tokens stay off the disk)
  const line = guardLogLine('block', { url: 'https://tracker.example.invalid/open?u=me%40example.invalid', resourceType: 'image' })
  assert.match(line, / block image https:\/\/tracker\.example\.invalid$/)
})

test('net guard installer: cancels what it blocks and logs every network decision', () => {
  let listener = null
  const lines = []
  const ses = { webRequest: { onBeforeRequest: fn => (listener = fn) } }
  installNetGuard({ ses, allowedHosts: () => new Set(['ok.example.invalid']), write: l => lines.push(l) })
  const results = []
  for (const url of ['https://ok.example.invalid/a.png', 'https://bad.example.invalid/a.png', 'file:///x']) listener({ url, resourceType: 'image' }, r => results.push(r.cancel))
  assert.deepEqual(results, [false, true, false])
  assert.equal(lines.length, 2)
  assert.match(lines[0], / allow image https:\/\/ok\.example\.invalid$/)
  assert.match(lines[1], / block image https:\/\/bad\.example\.invalid$/)
})

test('frame CSP: no script, no network; http(s) images only when allowed for the message', () => {
  const off = viewCsp(false)
  assert.match(off, /default-src 'none'/)
  assert.doesNotMatch(off, /script-src/)
  assert.match(off, /img-src cid-img: data:;/)
  assert.doesNotMatch(off, /https?:/)
  assert.match(viewCsp(true), /img-src cid-img: data: https: http:;/)
  assert.match(off, /form-action 'none'/)
  assert.match(off, /base-uri 'none'/)
  const doc = viewDocument('<p>x</p>', false)
  assert.ok(doc.includes(`content="${off}"`))
  assert.ok(doc.includes('<body><p>x</p></body>'))
})

function fakeProtocol() {
  const handlers = new Map()
  let privileged = null
  return {
    handlers,
    get privileged() {
      return privileged
    },
    registerSchemesAsPrivileged: list => (privileged = list),
    handle: (scheme, fn) => handlers.set(scheme, fn),
  }
}

test('protocols: mail-view serves only the current token with its own CSP; cid-img only the open message', async () => {
  const protocol = fakeProtocol()
  registerMailSchemes(protocol)
  assert.deepEqual(protocol.privileged.map(s => s.scheme), ['mail-view', 'cid-img', 'sig-img', 'inl-img'])
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
  const reader = {
    view: token => (token === 'tok' ? { html: '<p>levél</p>', imagesAllowed: false } : null),
    cidImage: (id, cid) => (id === 7 && cid === 'logo@x' ? { contentType: 'image/png', content: png } : null),
  }
  handleMailProtocols({ protocol, reader })
  const view = protocol.handlers.get('mail-view')
  const ok = await view({ url: 'mail-view://view/tok' })
  assert.equal(ok.status, 200)
  assert.equal(ok.headers.get('content-security-policy'), viewCsp(false))
  assert.match(await ok.text(), /<p>levél<\/p>/)
  assert.equal((await view({ url: 'mail-view://view/other' })).status, 404)
  assert.equal((await view({ url: 'mail-view://elsewhere/tok' })).status, 404)

  const cid = protocol.handlers.get('cid-img')
  const img = await cid({ url: 'cid-img://m7/logo%40x' })
  assert.equal(img.status, 200)
  assert.equal(img.headers.get('content-type'), 'image/png')
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), png)
  assert.equal((await cid({ url: 'cid-img://m8/logo%40x' })).status, 404)
  assert.equal((await cid({ url: 'cid-img://m7/%E0%A4%A' })).status, 404, 'bad escape')
  assert.equal((await cid({ url: 'cid-img://x7/logo%40x' })).status, 404)
})

function fakeIpc() {
  const handlers = new Map()
  return {
    handle: (ch, fn) => handlers.set(ch, fn),
    call: (ch, trusted, ...args) => handlers.get(ch)({ senderFrame: { url: trusted ? 'app' : 'evil' } }, ...args),
    handlers,
  }
}

function readerIpc(t, { attachments = [], openPathResult = '' } = {}) {
  const tmpDir = path.join(tempDir(t), 'tmp')
  fs.mkdirSync(tmpDir)
  const opened = []
  const saveTarget = path.join(path.dirname(tmpDir), 'mentett.pdf')
  const ipc = fakeIpc()
  const reader = {
    open: async id => {
      if (id === 404) throw new ActionError('not_found')
      return { id }
    },
    thread: id => [{ id }],
    allowImages: () => ['a.example.invalid'],
    setView: () => 'tok123',
    attachment: (id, index) => {
      const a = attachments[index]
      if (!a) throw new ActionError('not_found')
      return a
    },
  }
  registerReaderIpc({
    ipcMain: ipc,
    reader,
    tmpDir,
    dialog: { showSaveDialog: async () => ({ canceled: false, filePath: saveTarget }) },
    shell: { openPath: async p => (opened.push(p), openPathResult) },
    isTrustedSender: e => e.senderFrame.url === 'app',
  })
  return { ipc, tmpDir, opened, saveTarget }
}

test('reader IPC: only the app page, arguments checked, ActionError codes passed on', async t => {
  const { ipc } = readerIpc(t)
  assert.deepEqual([...ipc.handlers.keys()].sort(), [...READER_CHANNELS].sort())
  assert.deepEqual(await ipc.call('mail:open', false, 1), { ok: false, error: 'untrusted_sender' })
  for (const bad of [0, -1, 1.5, '1', null, { id: 1 }]) assert.deepEqual(await ipc.call('mail:open', true, bad), { ok: false, error: 'bad_request' })
  assert.deepEqual(await ipc.call('mail:open', true, 404), { ok: false, error: 'not_found' })
  assert.deepEqual(await ipc.call('mail:open', true, 5), { ok: true, message: { id: 5 } })
  assert.deepEqual(await ipc.call('mail:render', true, 5, 42), { ok: false, error: 'bad_request' })
  assert.deepEqual(await ipc.call('mail:render', true, 5, '<p>x</p>'), { ok: true, url: 'mail-view://view/tok123' })
  assert.deepEqual(await ipc.call('mail:allowImages', true, 5), { ok: true, hosts: ['a.example.invalid'] })
  assert.deepEqual(await ipc.call('mail:openAttachment', true, 5, -1), { ok: false, error: 'bad_request' })
})

test('reader IPC: an executable attachment cannot be opened (nothing written), only saved; a PDF opens from data/tmp', async t => {
  const attachments = [
    { filename: 'telepito.exe', executable: true, content: Buffer.from('MZ') },
    { filename: 'szamla.pdf', executable: false, openable: true, content: Buffer.from('%PDF-1.4') },
  ]
  const { ipc, tmpDir, opened, saveTarget } = readerIpc(t, { attachments })
  assert.deepEqual(await ipc.call('mail:openAttachment', true, 5, 0), { ok: false, error: 'executable' })
  assert.deepEqual(fs.readdirSync(tmpDir), [])
  assert.deepEqual(opened, [])

  assert.deepEqual(await ipc.call('mail:saveAttachment', true, 5, 0), { ok: true, saved: true })
  assert.equal(fs.readFileSync(saveTarget, 'utf8'), 'MZ')

  assert.deepEqual(await ipc.call('mail:openAttachment', true, 5, 1), { ok: true })
  assert.equal(opened.length, 1)
  assert.equal(path.basename(opened[0]), 'szamla.pdf')
  assert.equal(path.dirname(path.dirname(opened[0])), tmpDir)
  assert.equal(fs.readFileSync(opened[0], 'utf8'), '%PDF-1.4')

  emptyTmpDir(tmpDir)
  assert.deepEqual(fs.readdirSync(tmpDir), [], 'data/tmp is empty after the cleanup (start / quit)')
  emptyTmpDir(path.join(tmpDir, 'nincs-ilyen')) // a missing folder is not an error
})

test('reader IPC: an HTML, SVG or MHT attachment cannot be opened (nothing written), only saved', async t => {
  const attachments = ['szamla.pdf.html', 'LOGO.SVG', 'level.mht'].map(filename => ({
    filename,
    executable: false,
    browserActive: isBrowserActiveName(filename),
    content: Buffer.from('<script>alert(1)</script>'),
  }))
  const { ipc, tmpDir, opened } = readerIpc(t, { attachments })
  for (const i of [0, 1, 2]) assert.deepEqual(await ipc.call('mail:openAttachment', true, 5, i), { ok: false, error: 'browser_active' })
  assert.deepEqual(fs.readdirSync(tmpDir), [])
  assert.deepEqual(opened, [])
  assert.deepEqual(await ipc.call('mail:saveAttachment', true, 5, 0), { ok: true, saved: true })
})

test('reader IPC: a failed system open is reported', async t => {
  const { ipc } = readerIpc(t, { attachments: [{ filename: 'a.pdf', executable: false, openable: true, content: Buffer.from('x') }], openPathResult: 'No application' })
  assert.deepEqual(await ipc.call('mail:openAttachment', true, 5, 0), { ok: false, error: 'open_failed' })
})

test('more types Windows runs, installs or connects with are save-only; device names with a space or a superscript are renamed', () => {
  for (const name of ['meeting.rdp', 'Share.searchConnector-ms', 'x.appinstaller', 'a.vsto', 'kek.theme', 'a.themepack', 'a.desktopthemepackfile', 'sandbox.wsb', 'update.msu',
    'a.sct', 'a.shb', 'a.shs', 'a.hlp', 'a.ins', 'a.isp', 'start.jnlp', 'script.py', 'script.PYW', 'a.pl', 'a.xbap', 'a.vb', 'adat.mdb', 'adat.accdb', 'a.mde', 'a.ade', 'a.adp',
    'a.appcontent-ms', 'a.printerexport', 'a.ps2', 'a.psc1', 'tanusitvany.cer']) {
    assert.equal(isExecutableName(name), true, name)
  }
  for (const name of ['szamla.pdf', 'kep.jpg', 'level.docx', 'tabla.xlsx', 'jegyzet.txt']) assert.equal(isExecutableName(name), false, name)
  assert.equal(safeFileName('CON .txt'), '_CON .txt')
  assert.equal(safeFileName('com¹.txt'), '_com¹.txt')
  assert.equal(safeFileName('LPT³'), '_LPT³')
  assert.equal(safeFileName('CONOUT$'), '_CONOUT$')
  assert.equal(safeFileName('console.txt'), 'console.txt', 'not a device name')
})

// ---- "Megnyitás" only from an allow list ----

test('every type of the allow list opens, in any case', () => {
  assert.deepEqual([...OPENABLE_EXTENSIONS].sort(), ['.bmp', '.doc', '.docx', '.gif', '.jpeg', '.jpg', '.odp', '.ods', '.odt', '.pdf', '.png', '.ppt', '.pptx', '.tif', '.tiff', '.txt', '.webp', '.xls', '.xlsx'])
  for (const ext of OPENABLE_EXTENSIONS) {
    assert.equal(isOpenableName(`a${ext}`), true, ext)
    assert.equal(isOpenableName(`A${ext.toUpperCase()}`), true, ext.toUpperCase())
  }
  assert.equal(isOpenableName('Számla 2026.PDF '), true, 'trailing space: the name written to disk counts')
})

test('macro Office, rtf, csv, slide shows, archives, executables, web files, no extension and double extensions do not open', () => {
  for (const name of ['a.docm', 'a.xlsm', 'a.pptm', 'a.dotm', 'a.xltm', 'a.potm', 'a.ppsm', 'a.xlsb', 'a.rtf', 'a.csv', 'a.pps', 'a.ppsx', 'a.zip', 'a.7z', 'a.iso', 'a.exe', 'a.html', 'a.svg', 'a.xml', 'nincskiterjesztes', 'szamla.pdf.exe', 'kep.jpg.lnk']) {
    assert.equal(isOpenableName(name), false, name)
  }
})

test('no executable and no browser-active type is on the allow list', () => {
  for (const ext of [...EXECUTABLE_EXTENSIONS, ...BROWSER_ACTIVE_EXTENSIONS]) assert.ok(!OPENABLE_EXTENSIONS.includes(ext), ext)
})

test('reader IPC: a .zip cannot be opened (not_openable, nothing written, openPath not called); .exe stays executable, .html browser_active', async t => {
  const attachments = ['archivum.zip', 'telepito.exe', 'oldal.html', 'makro.docm'].map(filename => ({
    filename,
    executable: isExecutableName(filename),
    browserActive: isBrowserActiveName(filename),
    openable: isOpenableName(filename),
    content: Buffer.from('PK\x03\x04'),
  }))
  const { ipc, tmpDir, opened } = readerIpc(t, { attachments })
  assert.deepEqual(await ipc.call('mail:openAttachment', true, 5, 0), { ok: false, error: 'not_openable' })
  assert.deepEqual(await ipc.call('mail:openAttachment', true, 5, 1), { ok: false, error: 'executable' })
  assert.deepEqual(await ipc.call('mail:openAttachment', true, 5, 2), { ok: false, error: 'browser_active' })
  assert.deepEqual(await ipc.call('mail:openAttachment', true, 5, 3), { ok: false, error: 'not_openable' })
  assert.deepEqual(fs.readdirSync(tmpDir), [], 'nothing written to data/tmp')
  assert.deepEqual(opened, [], 'openPath never called')
  assert.deepEqual(await ipc.call('mail:saveAttachment', true, 5, 0), { ok: true, saved: true }, 'saving stays')
})

test('protocols: sig-img serves the signature image of an account or a session, nothing else', async () => {
  const protocol = fakeProtocol()
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
  const asked = []
  const signature = (kind, ref) => {
    asked.push(`${kind}/${ref}`)
    return (kind === 'account' && ref === '3') || (kind === 'session' && ref === 'abc-1') ? { type: 'image/png', bytes: png } : null
  }
  handleMailProtocols({ protocol, reader: { view: () => null, cidImage: () => null }, signature })
  const sig = protocol.handlers.get('sig-img')
  for (const url of ['sig-img://account/3', 'sig-img://session/abc-1']) {
    const res = await sig({ url })
    assert.equal(res.status, 200, url)
    assert.equal(res.headers.get('content-type'), 'image/png')
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), png)
  }
  asked.length = 0
  for (const url of ['sig-img://account/4', 'sig-img://account/3x', 'sig-img://account/3/x', 'sig-img://other/3', 'sig-img://session/a b', 'not a url']) {
    assert.equal((await sig({ url })).status, 404, url)
  }
  assert.deepEqual(asked, ['account/4'], 'only a well-formed reference reaches the lookup')
})

test('protocols: inl-img serves a pasted image of an open composer session only, nothing else', async () => {
  const protocol = fakeProtocol()
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
  const sid = '0123abcd-0000-4000-8000-00000000abcd'
  const id = 'a'.repeat(24)
  const asked = []
  let locked = false
  const pasted = (s, i) => {
    asked.push(`${s}/${i}`)
    return !locked && s === sid && i === id ? { type: 'image/png', bytes: png } : null
  }
  handleMailProtocols({ protocol, reader: { view: () => null, cidImage: () => null }, pasted })
  const inl = protocol.handlers.get('inl-img')
  const res = await inl({ url: `inl-img://session/${sid}/${id}` })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'image/png')
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), png)
  asked.length = 0
  const other = '0123abcd-0000-4000-8000-00000000ffff'
  for (const url of [`inl-img://session/${other}/${id}`, `inl-img://session/${sid}/${'b'.repeat(24)}`]) {
    assert.equal((await inl({ url })).status, 404, url)
  }
  assert.deepEqual(asked, [`${other}/${id}`, `${sid}/${'b'.repeat(24)}`], 'another session, an id it does not have: asked, refused')
  asked.length = 0
  for (const url of [`inl-img://other/${sid}/${id}`, `inl-img://session/${sid}/${id}/x`, `inl-img://session/${sid}/AAAA`, `inl-img://session/x/${id}`, 'not a url']) {
    assert.equal((await inl({ url })).status, 404, url)
  }
  assert.deepEqual(asked, [], 'only a well-formed reference reaches the lookup')
  locked = true
  assert.equal((await inl({ url: `inl-img://session/${sid}/${id}` })).status, 404, 'locked: no session, nothing served')
})
