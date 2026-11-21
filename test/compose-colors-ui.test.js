// SPDX-License-Identifier: GPL-3.0-or-later
// The composer page (Composer.jsx, jsdom, a stub bridge) and the toolbar's colours (core/smtp/text-colors.js): a saved
// body opened again (a draft, a scheduled message) keeps its palette colours in the editor; a reply's or a forward's quote,
// a mailto body and a signature come without colour; what the editor holds goes to send and save with its palette colours
// (form() sanitizes with colors), and a colour the toolbar does not make does not.
process.env.TZ = 'Europe/Budapest'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupDom, mount, inAct } from './helpers/react-dom-env.js'

setupDom()
globalThis.requestAnimationFrame = window.requestAnimationFrame = fn => setTimeout(() => fn(Date.now()), 0)
globalThis.cancelAnimationFrame = window.cancelAnimationFrame = id => clearTimeout(id)
const sent = []
let initialForm = null
let signature = ''
window.shadowMail = {
  language: 'hu',
  onStatus: () => () => {},
  compose: {
    accounts: async () => ({ ok: true, accounts: [{ id: 1, name: 'Munka', email: 'sajat@example.invalid', display_name: 'Saját', signature, hasImage: false }] }),
    initial: async () => ({ ok: true, form: initialForm, attachments: [] }),
    checked: async () => ({ ok: true }),
    ready: async () => ({ ok: true }),
    suspect: async () => ({ ok: true }),
    suggest: async () => ({ ok: true, items: [] }),
    onLockRequested: () => () => {},
    onCloseRequested: () => () => {},
    lockDone: async () => ({ ok: true }),
    send: async (sid, form) => (sent.push(['send', form.html]), { ok: true, rejected: [], warnings: [] }),
    schedule: async () => ({ ok: true }),
    saveDraft: async (sid, form) => (sent.push(['save', form.html]), { ok: true, savedAt: Date.now() }),
    close: async () => ({ ok: true }),
    discard: async () => ({ ok: true }),
    addFiles: async () => ({ ok: true, attachments: [] }),
    removeAttachment: async () => ({ ok: true, attachments: [] }),
  },
}
const { createElement: h } = await import('react')
const { Composer } = await import('../app/renderer/src/Composer.jsx')
const { hu } = await import('../app/renderer/i18n/hu.js')
const { TEXT_COLORS, HIGHLIGHT_COLORS } = await import('../core/smtp/text-colors.js')

const SID = '11111111-2222-3333-4444-555555555555'
const RED = TEXT_COLORS[0].hex
const YELLOW = HIGHLIGHT_COLORS[0].style
const COLOURED = `<p>Sima <font color="${RED}">piros</font> és <span style="${YELLOW}">kiemelt</span>, <font color="#ff0000">idegen</font>.</p>`
const base = (over = {}) => ({ accountId: 1, to: 'anna@example.invalid', cc: '', bcc: '', subject: 'Színek', inReplyTo: null, references: [], ...over })
const settle = () => inAct(async () => new Promise(r => setTimeout(r, 20)))
const button = name => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === name)
const editor = () => document.querySelector('.editor')
const coloured = html => html.includes(`<font color="${RED}">piros</font>`) && html.includes(`<span style="${YELLOW}">kiemelt</span>`)
const colourless = html => !/<font|style=|color=/i.test(html)

async function open(t, f, sig = '') {
  sent.length = 0
  initialForm = f
  signature = sig
  const v = await mount(h(Composer, { sessionId: SID }))
  t.after(v.unmount)
  await settle()
  await settle()
  return v
}
const send = async () => {
  await inAct(async () => button(hu.composeSend).click())
  await settle()
  const last = sent.filter(x => x[0] === 'send').pop()
  assert.ok(last, 'sent')
  return last[1]
}

test('a saved draft opened again: its palette colours in the editor; sent with them; a foreign colour not', async t => {
  await open(t, base({ draftHtml: COLOURED }))
  assert.ok(coloured(editor().innerHTML), editor().innerHTML)
  assert.ok(!editor().innerHTML.includes('#ff0000'), 'the foreign colour is not in the editor')
  const html = await send()
  assert.ok(coloured(html), html)
  assert.ok(!html.includes('#ff0000'), html)
})

test('a scheduled message opened again (it comes as draftHtml too): the colours stay', async t => {
  await open(t, base({ draftHtml: COLOURED, mayHaveGone: undefined }))
  assert.ok(coloured(editor().innerHTML))
})

for (const [name, over] of [
  ['a reply\'s quote', { body: '', quote: `<p>Idézet:</p><blockquote>${COLOURED}</blockquote>` }],
  ['a forward\'s quote', { body: '', quote: `<p>---------- Továbbított üzenet ----------</p>${COLOURED}` }],
  ['a mailto body', { body: COLOURED }],
]) {
  test(`${name}: no colour in the editor (as before); the user's own colour added afterwards goes out`, async t => {
    await open(t, base(over))
    assert.ok(colourless(editor().innerHTML), editor().innerHTML)
    assert.ok(editor().textContent.includes('kiemelt'), 'the text stays')
    // the user colours a word with the toolbar (what the editor writes)
    await inAct(async () => editor().insertAdjacentHTML('afterbegin', `<p>Új <font color="${RED}">piros</font> és <span style="${YELLOW}">kiemelt</span>.</p>`))
    const html = await send()
    assert.ok(coloured(html), html)
    assert.equal((html.match(/<font /g) || []).length, 1, 'only the own colour')
    assert.equal(html.split(YELLOW).length - 1, 1)
  })
}

test('the signature comes without colour, a saved draft\'s own text with it', async t => {
  await open(t, base({ body: '' }), 'Üdv, Saját')
  assert.ok(colourless(editor().innerHTML))
  const sig = editor().querySelector('[data-sm-signature]')
  assert.ok(sig && sig.textContent.includes('Üdv, Saját'))
})

test('save as draft: the palette colours go to the saved draft', async t => {
  await open(t, base({ draftHtml: COLOURED }))
  await inAct(async () => editor().insertAdjacentHTML('beforeend', '<p>még</p>'))
  await inAct(async () => editor().dispatchEvent(new window.Event('input', { bubbles: true })))
  const save = document.querySelector(`button[aria-label="${hu.composeSaveDraft}"]`)
  assert.ok(save, 'the save button')
  await inAct(async () => save.click())
  await settle()
  const saved = sent.filter(x => x[0] === 'save').pop()
  assert.ok(saved && coloured(saved[1]), saved && saved[1])
})

// --- the colour buttons and menus (the editor's commands recorded: jsdom has no execCommand) --------------------------
const { CLIP_TYPE, selectionHtml, plainColorAt } = await import('../app/renderer/src/compose-colors.js')
const commands = []
document.execCommand = (cmd, ui, value) => (commands.push([cmd, value]), true)
document.queryCommandState = () => false
document.queryCommandValue = () => ''
const tool = name => document.querySelector(`.editor-toolbar button[aria-label="${name}"]`)
const menuItems = () => [...document.querySelectorAll('.color-menu [role="menuitem"]')]
// the focus first: jsdom (not Chromium) collapses the selection when an editable element gets the focus
const selectText = word => {
  const el = editor()
  el.focus()
  const w = document.createTreeWalker(el, 4)
  let n
  while ((n = w.nextNode()) && !n.data.includes(word)) {}
  const r = document.createRange()
  const i = n.data.indexOf(word)
  r.setStart(n, i)
  r.setEnd(n, i + word.length)
  window.getSelection().removeAllRanges()
  window.getSelection().addRange(r)
}
const key = (el, k, more = {}) => inAct(async () => el.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...more })))

test('the bar: Text color and Highlight right after Underline, menu buttons, no Tab stop, the order of the others unchanged', async t => {
  await open(t, base({ body: '' }))
  const names = [...document.querySelectorAll('.editor-toolbar > button, .editor-toolbar > .menu-anchor > button')].map(b => b.getAttribute('aria-label'))
  assert.deepEqual(names, [hu.composeTools.bold, hu.composeTools.italic, hu.composeTools.underline, hu.composeTools.textColor, hu.composeTools.highlight, hu.composeTools.ul, hu.composeTools.ol, hu.composeTools.link, hu.composeTools.quote, hu.composeTools.clear])
  for (const name of [hu.composeTools.textColor, hu.composeTools.highlight]) {
    const b = tool(name)
    assert.equal(b.getAttribute('aria-haspopup'), 'menu')
    assert.equal(b.getAttribute('aria-expanded'), 'false')
    assert.equal(b.tabIndex, -1)
  }
})

test('Text color: the menu lists Automatic first, then the six palette colours with a swatch and a name; a choice colours the selection with the editor command (styleWithCSS off)', async t => {
  await open(t, base({ draftHtml: '<p>egy szó itt</p>' }))
  selectText('szó')
  await inAct(async () => tool(hu.composeTools.textColor).click())
  assert.equal(tool(hu.composeTools.textColor).getAttribute('aria-expanded'), 'true')
  const items = menuItems()
  assert.deepEqual(items.map(i => i.textContent.trim()), [hu.composeColors.auto, ...TEXT_COLORS.map(c => hu.composeColors.text[c.id])])
  assert.ok(items.every(i => i.querySelector('.label-swatch.swatch-outline')), 'every swatch has the outline')
  assert.equal(items[1].querySelector('.label-swatch').style.backgroundColor, 'rgb(198, 40, 40)')
  commands.length = 0
  await inAct(async () => items[4].click())
  assert.deepEqual(commands, [['styleWithCSS', false], ['foreColor', TEXT_COLORS[3].hex]])
  assert.equal(menuItems().length, 0, 'the menu closed')
  assert.equal(document.activeElement, editor(), 'back in the text')
  assert.equal(window.getSelection().toString(), 'szó', 'the selection kept')
})

test('Automatic takes the colour off with the colour the text has without one; No highlight with transparent', async t => {
  await open(t, base({ draftHtml: `<p>egy <font color="${RED}">szó</font> itt</p>` }))
  selectText('szó')
  await inAct(async () => tool(hu.composeTools.textColor).click())
  commands.length = 0
  await inAct(async () => menuItems()[0].click())
  const plain = getComputedStyle(editor().querySelector('p')).color
  assert.deepEqual(commands, [['styleWithCSS', false], ['foreColor', plain]])
  selectText('szó')
  await inAct(async () => tool(hu.composeTools.highlight).click())
  const items = menuItems()
  assert.deepEqual(items.map(i => i.textContent.trim()), [hu.composeColors.noHighlight, ...HIGHLIGHT_COLORS.map(c => hu.composeColors.highlight[c.id])])
  commands.length = 0
  await inAct(async () => items[0].click())
  assert.deepEqual(commands, [['styleWithCSS', false], ['hiliteColor', 'transparent']])
  selectText('szó')
  await inAct(async () => tool(hu.composeTools.highlight).click())
  commands.length = 0
  await inAct(async () => menuItems()[1].click())
  assert.deepEqual(commands, [['styleWithCSS', false], ['hiliteColor', HIGHLIGHT_COLORS[0].hex]])
})

test('keyboard: Alt+F10, the arrows over the colour buttons (not into a menu), Down opens, Esc closes without a change and goes back to the text with the selection', async t => {
  await open(t, base({ draftHtml: '<p>egy szó itt</p>' }))
  selectText('szó')
  await key(editor(), 'F10', { altKey: true })
  const bar = document.querySelector('.editor-toolbar')
  assert.equal(document.activeElement, tool(hu.composeTools.bold))
  for (let i = 0; i < 3; i++) await key(document.activeElement, 'ArrowRight')
  assert.equal(document.activeElement, tool(hu.composeTools.textColor))
  await key(document.activeElement, 'ArrowDown')
  assert.equal(menuItems().length, 7, 'Down opened the menu')
  assert.equal(document.activeElement, menuItems()[0], 'the focus on its first item')
  // the arrows in the menu move in the menu, not in the bar
  await key(document.activeElement, 'ArrowDown')
  assert.equal(document.activeElement, menuItems()[1])
  commands.length = 0
  await key(document.activeElement, 'Escape')
  assert.equal(menuItems().length, 0)
  assert.deepEqual(commands, [], 'nothing coloured')
  assert.equal(document.activeElement, editor())
  assert.equal(window.getSelection().toString(), 'szó')
  // again, Enter in the menu colours the selection
  await key(editor(), 'F10', { altKey: true })
  assert.equal(document.activeElement, tool(hu.composeTools.textColor), 'Alt+F10 goes back to the last button')
  await inAct(async () => document.activeElement.click())
  await key(document.activeElement, 'ArrowDown')
  commands.length = 0
  await inAct(async () => document.activeElement.click())
  assert.deepEqual(commands, [['styleWithCSS', false], ['foreColor', TEXT_COLORS[0].hex]])
  assert.equal(document.activeElement, editor())
  assert.equal(window.getSelection().toString(), 'szó')
  void bar
})

// a copy / cut / paste event with a stand-in DataTransfer
const clip = (type, data = {}) => {
  const e = new window.Event(type, { bubbles: true, cancelable: true })
  const store = { ...data }
  e.clipboardData = { setData: (k, v) => (store[k] = v), getData: k => store[k] ?? '', files: [], types: Object.keys(store) }
  return { e, store }
}

test('copy in the text: the selection\'s own HTML with its palette colours (a piece of one coloured word too), the plain text and the window\'s mark; cut deletes with the editor command', async t => {
  await open(t, base({ draftHtml: `<p>egy <font color="${RED}"><b>színesszó</b></font> <span style="${YELLOW}">kiemelt</span> itt</p>` }))
  selectText('esszó')
  const c = clip('copy')
  await inAct(async () => editor().dispatchEvent(c.e))
  assert.ok(c.e.defaultPrevented)
  assert.equal(c.store['text/html'], `<font color="${RED}"><b>esszó</b></font>`)
  assert.equal(c.store['text/plain'], 'esszó')
  assert.match(c.store[CLIP_TYPE], /^[0-9a-f-]{36}$/)
  commands.length = 0
  selectText('kiemelt')
  const x = clip('cut')
  await inAct(async () => editor().dispatchEvent(x.e))
  assert.equal(x.store['text/html'], `<span style="${YELLOW}">kiemelt</span>`)
  assert.equal(x.store[CLIP_TYPE], c.store[CLIP_TYPE], 'one mark per window')
  assert.deepEqual(commands, [['delete', undefined]])
})

test('paste: the window\'s own mark keeps the palette colours; no mark, another mark, a foreign colour: none', async t => {
  await open(t, base({ draftHtml: '<p>egy szó itt</p>' }))
  selectText('szó')
  const c = clip('copy')
  await inAct(async () => editor().dispatchEvent(c.e))
  const mark = c.store[CLIP_TYPE]
  const html = `<font color="${RED}">piros</font> <span style="${YELLOW}">sárga</span> <font color="#ff0000">idegen</font>`
  const pasted = async data => {
    commands.length = 0
    const p = clip('paste', data)
    await inAct(async () => editor().dispatchEvent(p.e))
    return commands.find(x => x[0] === 'insertHTML')[1]
  }
  assert.equal(await pasted({ 'text/html': html, [CLIP_TYPE]: mark }), `<font color="${RED}">piros</font> <span style="${YELLOW}">sárga</span> idegen`)
  assert.equal(await pasted({ 'text/html': html }), 'piros <span>sárga</span> idegen')
  assert.equal(await pasted({ 'text/html': html, [CLIP_TYPE]: '00000000-0000-0000-0000-000000000000' }), 'piros <span>sárga</span> idegen')
})

test('selectionHtml: the formatting around a piece is copied up to its block, not the block or a link; plainColorAt: the colour outside the coloured fonts', () => {
  const root = document.createElement('div')
  document.body.append(root)
  root.innerHTML = `<blockquote><p>a <a href="https://x.invalid/"><font color="${RED}"><i><u>abcdef</u></i></font></a> b</p></blockquote>`
  const u = root.querySelector('u').firstChild
  const r = document.createRange()
  r.setStart(u, 1)
  r.setEnd(u, 4)
  assert.equal(selectionHtml(r, root), `<font color="${RED}"><i><u>bcd</u></i></font>`)
  const whole = document.createRange()
  whole.selectNodeContents(root.querySelector('p'))
  assert.equal(selectionHtml(whole, root), root.querySelector('p').innerHTML)
  assert.equal(plainColorAt(r, root), getComputedStyle(root.querySelector('a')).color)
  root.remove()
})
