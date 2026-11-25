// SPDX-License-Identifier: GPL-3.0-or-later
// The composer window: From, To / Cc / Bcc with completion, Subject, a simple HTML editor
// (bold, italic, underline, lists, link, quote) with the account's signature, attachments (browse or
// drop), a draft every 60 s, Send. Closing asks first when something is not saved.
// The frame: a title strip with the close button, fields with a bottom line only (From is a
// menu), the editor, attachment chips, and the bottom bar: the blue Send pill, the formatting
// toggle, Attach; on the right Save draft and Discard. The formatting bar is icon buttons.
import { useCallback, useEffect, useRef, useState } from 'react'
import DOMPurify from 'dompurify'
import { t } from '../i18n/index.js'
import { sanitizeCompose, pastedImageSrc, isPastedImageOf } from './sanitize.js'
import { shapeOf } from './compose-shape.js'
import { createDraftState } from './draft-state.js'
import { accountSignatureHtml, accountImageSrc, signatureInner, SIGNATURE_ATTR } from '../../../core/smtp/signature.js'
import { Banner, Button, IconButton, Menu, Modal, Select, TextField } from './ui/index.js'
import { IMAGE_SIZES, sizeOf } from '../../../core/smtp/image-width.js'
import { TEXT_COLORS, HIGHLIGHT_COLORS, AUTO_COLOR } from '../../../core/smtp/text-colors.js'
import { selectionHtml, plainColorAt } from './compose-colors.js'
import { preparePaste, prepareQuote, hasShownText } from '../../../core/mime/paste-prepare.js'
import { ScheduleDialog } from './ScheduleDialog.jsx'

export { ScheduleDialog }

const api = window.shadowMail
export const AUTOSAVE_MS = 60_000

const escapeHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
// same rule as displayAddress in app/main/compose.js: quote a name with a special, without " and \
const fmtContact = c => {
  const clean = String(c.name || '').replace(/["\\]/g, '').trim()
  if (!clean) return c.address
  return `${/[()<>[\]:;@,.]/.test(clean) ? `"${clean}"` : clean} <${c.address}>`
}

/** A recipient field: comma-separated text, suggestions for the part being typed. */
function RecipientField({ id, label, value, onChange, disabled = false, children = null }) {
  const [items, setItems] = useState([])
  const [active, setActive] = useState(0)
  const timer = useRef(null)
  const current = v => v.split(/[,;]/).pop().trim()
  const ask = v => {
    clearTimeout(timer.current)
    const term = current(v)
    if (term.length < 2) {
      setItems([])
      return
    }
    timer.current = setTimeout(async () => {
      const res = await api.compose.suggest(term)
      setItems(res.ok ? res.contacts : [])
      setActive(0)
    }, 150)
  }
  const pick = c => {
    const parts = value.split(/([,;])/)
    parts[parts.length - 1] = ` ${fmtContact(c)}`
    onChange(`${parts.join('').replace(/^\s+/, '')}, `)
    setItems([])
  }
  return (
    <div className="compose-row recipient">
      <label className="compose-label" htmlFor={id}>{label}</label>
      <div className="suggest-wrap">
        <input
          disabled={disabled}
          id={id}
          type="text"
          value={value}
          spellCheck={false}
          autoComplete="off"
          onChange={e => {
            onChange(e.target.value)
            ask(e.target.value)
          }}
          onBlur={() => setTimeout(() => setItems([]), 150)}
          onKeyDown={e => {
            if (!items.length) return
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActive(a => (a + 1) % items.length)
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive(a => (a - 1 + items.length) % items.length)
            } else if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault()
              pick(items[active])
            } else if (e.key === 'Escape') setItems([])
          }}
        />
        {items.length > 0 && (
          <ul className="suggestions" role="listbox" aria-label={t.composeSuggestions}>
            {items.map((c, i) => (
              <li key={c.address} role="option" aria-selected={i === active} className={i === active ? 'active' : ''} onMouseDown={() => pick(c)}>
                {c.name ? <><strong>{c.name}</strong> &lt;{c.address}&gt;</> : c.address}
              </li>
            ))}
          </ul>
        )}
      </div>
      {children}
    </div>
  )
}

const TOOLS = [
  ['bold', 'bold'],
  ['italic', 'italic'],
  ['underline', 'underline'],
  // the two colour buttons open a menu (ColorTool), they run no command themselves
  ['foreColor', 'textColor', 'textColor'],
  ['hiliteColor', 'highlight', 'highlight'],
  ['insertUnorderedList', 'list', 'ul'],
  ['insertOrderedList', 'listOrdered', 'ol'],
  ['link', 'link'],
  ['formatBlock', 'quote', 'quote', 'blockquote'],
  ['removeFormat', 'clearFormat', 'clear'],
]

// The text outside the signature block (as the user wrote it), whether an image is there, and the editor's top-level node
// that holds the signature block (an insertion range stops before it).
function outsideSignature(el) {
  const sig = el.querySelector(`[${SIGNATURE_ATTR}]`)
  let top = sig
  while (top && top.parentNode !== el) top = top.parentNode
  let text = ''
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (!sig || !sig.contains(n)) text += n.data
  const image = [...el.querySelectorAll('img')].some(img => !sig || !sig.contains(img))
  return { top, text, image }
}
const bare = s => s.replace(/\s+/g, '')

// Whether the selection starts or ends in a paragraph (outside a list and the signature block). A list chosen there lands
// INSIDE it, <p><ul> (MEASURED: an empty paragraph, one with text, two selected, a new message too); saved and sent the
// HTML parser splits it into <p></p><ul></ul><p></p>, two blank lines around the list in the text part. Not when the
// selection takes in an existing list item too: the div there would cut the list in two (MEASURED, the tester's
// paragraph + list case); the editor makes one list of them, as before.
function inParagraph(el) {
  const sel = window.getSelection()
  if (!el || !sel || !sel.rangeCount) return false
  const range = sel.getRangeAt(0)
  if ([...el.querySelectorAll('li')].some(li => range.intersectsNode(li))) return false
  // an element boundary (the caret on the editor itself, before its first block) is the child at the offset
  const elementAt = (node, offset) => {
    let at = node && node.nodeType === 1 ? node.childNodes[offset] || node : node
    if (at && at.nodeType !== 1) at = at.parentNode
    return at
  }
  return [elementAt(sel.anchorNode, sel.anchorOffset), elementAt(sel.focusNode, sel.focusOffset)].some(at => {
    const p = at && at.closest ? at.closest('p') : null
    return Boolean(p && el.contains(p) && !p.closest('li') && !p.closest(`[${SIGNATURE_ATTR}]`))
  })
}

const FORMATS = { formatBold: 'bold', formatItalic: 'italic', formatUnderline: 'underline' }
const INLINE_COMMANDS = new Set(['bold', 'italic', 'underline'])
const BLOCK_COMMANDS = new Set(['formatBlock', 'insertUnorderedList', 'insertOrderedList'])

/**
 * The editor's state after a delete of a selection that emptied the text (nothing left outside the signature block), until the next
 * typed character: the browser keeps the deleted text's b/i/u and its quote or list, and a bold or italic toggled over
 * them is written as a style attribute, which the page's CSP blocks. So the first typed character starts from a clean
 * paragraph, with only what the user chose since. Everything goes through editing commands, so the undo stack keeps it:
 * Ctrl+Z right after the delete brings the text back at once (nothing is changed before the first character, or before
 * a quote, list, colour or highlight chosen into the emptied text: then the plain start comes before the choice).
 *   watch(el, e) on every beforeinput, input and compositionstart event of the editor; choose(cmd, el) for a command of the formatting bar (a
 *   command fires no beforeinput, and its input event can not be told apart reliably); beforePaste(el) right before a
 *   paste inserts its text (the paste's own command fires no beforeinput either).
 */
export function createEmptyTextGuard() {
  // { toggles: { bold, italic, underline } (odd = the user turned it on), color / highlight: a text colour / highlight
  // chosen, reset: the plain start already made (before a quote, list, colour or highlight chosen since) }
  let emptied = null
  const fresh = () => ({ toggles: { bold: 0, italic: 0, underline: 0 }, color: false, highlight: false, reset: false })
  let cleaning = false // the clean-up's own commands fire input events too: not the user's choice
  // the delete took a selection (not a single character): only that starts the text again; one Backspace keeps the
  // formatting (Ctrl+B, x, Backspace, y = bold y)
  let selectedDelete = false
  const isEmpty = el => {
    const { text, image } = outsideSignature(el)
    return !bare(text) && !image
  }
  // the selection covers the whole text outside the signature block (or everything): typing replaces it all
  const coversAll = el => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || !sel.rangeCount) return false
    const chosen = bare(sel.toString())
    const { text, image } = outsideSignature(el)
    return chosen !== '' && (chosen === bare(el.textContent) || (!image && chosen === bare(text)))
  }
  // only the commands that change something: each one is a step of the undo stack
  const blockAt = el => {
    const sel = window.getSelection()
    let n = sel && sel.rangeCount ? sel.getRangeAt(0).startContainer : null
    for (; n && n !== el; n = n.parentNode) if (n.nodeType === 1 && /^(BLOCKQUOTE|UL|OL|LI)$/.test(n.tagName)) return true
    return false
  }
  // the emptied block can still carry the deleted text's own style (a pasted <div style>, which formatBlock copies onto
  // the new block; the editor's remembered font size of a pasted span): one delete over the editor's content, so the
  // next text starts in a new block. When the signature block is still there, only the caret's block is emptied: a delete
  // up to the signature block pulls its first line up into the text
  const clearBefore = el => {
    const sel = window.getSelection()
    if (!sel || !sel.rangeCount || !el.firstChild) return
    const { top } = outsideSignature(el)
    // the caret's top-level block, asked again after each command: a delete can replace the block with a new node
    const caretBlock = () => {
      if (!sel.rangeCount) return null
      const { startContainer, startOffset } = sel.getRangeAt(0)
      let b = startContainer === el ? el.childNodes[startOffset] || el.lastChild : startContainer
      while (b && b.parentNode !== el) b = b.parentNode
      return b
    }
    // a whole list deleted leaves its style behind as inline wrappers around the empty line (MEASURED): one more delete.
    // Beside the signature block that delete keeps them, and the block's own style too (MEASURED): there an empty
    // paragraph replaces what is left
    for (let i = 0; i < 3; i++) {
      const block = top ? caretBlock() : el
      if (!block || block === top || !block.firstChild) return
      if (i > 0 && ![...block.querySelectorAll('*')].some(n => n.tagName !== 'BR')) return
      const r = document.createRange()
      r.selectNodeContents(block)
      sel.removeAllRanges()
      sel.addRange(r)
      if (i > 0 && top) {
        document.execCommand('insertHTML', false, '<p><br></p>')
        return
      }
      document.execCommand('delete')
    }
  }
  // the plain start of the emptied text: its content deleted, out of a quote or list, one paragraph. Before a block
  // command no paragraph: a list made in an empty paragraph lands inside it, <p><ul> (MEASURED, a plain one too), so
  // before a list a paragraph left there (beside the signature block) becomes a div
  const reset = (el, beforeCmd) => {
    clearBefore(el)
    for (let i = 0; i < 3 && blockAt(el); i++) document.execCommand('outdent')
    if (!beforeCmd) {
      if (document.queryCommandValue('formatBlock') !== 'p') document.execCommand('formatBlock', false, 'p')
    } else if (/List$/.test(beforeCmd) && document.queryCommandValue('formatBlock') === 'p') {
      document.execCommand('formatBlock', false, 'div')
    }
  }
  const clean = (el, state) => {
    cleaning = true
    try {
      // a block, colour or highlight chosen since had the plain start before it (choose)
      if (!state.reset) reset(el)
      for (const f of ['bold', 'italic', 'underline']) if (document.queryCommandState(f) !== Boolean(state.toggles[f] % 2)) document.execCommand(f)
      // the deleted text's colour and highlight are kept for the next character too: back to none, unless chosen since
      // (no colour: the "Automatic" marker, which the editor shows in the colour around it and nothing sends)
      const sel = window.getSelection()
      if (sel && sel.rangeCount) {
        if (!state.color && document.queryCommandValue('foreColor') !== plainColorAt(sel.getRangeAt(0), el)) {
          document.execCommand('styleWithCSS', false, false)
          document.execCommand('foreColor', false, AUTO_COLOR)
        }
        // the highlight's value comes from backColor (hiliteColor gives none)
        const hl = document.queryCommandValue('backColor') || document.queryCommandValue('hiliteColor')
        if (!state.highlight && !/^(transparent|rgba\(0, 0, 0, 0\))?$/.test(hl)) {
          document.execCommand('styleWithCSS', false, false)
          document.execCommand('hiliteColor', false, 'transparent')
        }
      }
    } finally {
      cleaning = false
    }
  }
  function watch(el, e) {
    if (!el) return
    const type = e.inputType || ''
    if (cleaning) return
    // a composition (an IME, a dead key) as the first input: the clean-up runs at its start, before the composition
    // writes anything, never while it is going on (a command there could break the IME's text)
    if (e.type === 'compositionstart') {
      if (emptied && isEmpty(el)) clean(el, emptied)
      emptied = null
      return
    }
    if (e.type === 'input') {
      if (type.startsWith('delete')) emptied = selectedDelete && isEmpty(el) ? fresh() : null
      return
    }
    if (type.startsWith('delete')) {
      const sel = window.getSelection()
      selectedDelete = Boolean(sel && sel.rangeCount && !sel.isCollapsed)
      return
    }
    // beforeinput: a format key (Ctrl+B / I / U; it fires even with nothing selected), or the first typed character
    if (FORMATS[type]) {
      if (emptied) emptied.toggles[FORMATS[type]]++
      return
    }
    // Enter or Shift+Enter as the first input starts a clean paragraph too; the state lives on until the first character
    // (the new paragraph can carry the old formatting again), whose clean-up then changes only what still differs
    const lineBreak = type === 'insertParagraph' || type === 'insertLineBreak'
    if (type === 'insertText' || lineBreak) begin(el, lineBreak)
  }
  // the first typed or pasted text (or a line break): a selection over the whole text is deleted first, then the emptied
  // text starts clean
  const begin = (el, lineBreak = false) => {
    if (coversAll(el)) {
      cleaning = true
      try {
        document.execCommand('delete')
      } finally {
        cleaning = false
      }
      emptied = isEmpty(el) ? fresh() : null
    }
    if (emptied && isEmpty(el)) clean(el, emptied)
    // after a line break the state lives on with its plain start made: the first character's clean-up then changes only
    // what still differs (a second reset would delete the new line)
    if (!lineBreak) emptied = null
    else if (emptied) emptied.reset = true
  }
  // a paste inserts with its own command, which fires no beforeinput: the paste handler calls this before it
  const beforePaste = el => {
    if (el && !cleaning) begin(el)
  }
  const choose = (cmd, el) => {
    if (!emptied) return
    // a block, colour or highlight chosen into the emptied text lands on the plain start, not on the deleted text's style
    if ((BLOCK_COMMANDS.has(cmd) || cmd === 'foreColor' || cmd === 'hiliteColor') && !emptied.reset && el && isEmpty(el)) {
      cleaning = true
      try {
        reset(el, BLOCK_COMMANDS.has(cmd) ? cmd : null)
      } finally {
        cleaning = false
      }
      emptied.reset = true
    }
    if (INLINE_COMMANDS.has(cmd)) emptied.toggles[cmd]++
    else if (cmd === 'foreColor') emptied.color = true
    else if (cmd === 'hiliteColor') emptied.highlight = true
  }
  return { watch, choose, beforePaste }
}

/**
 * The formatting bar: icon buttons, the old names as aria-label + tooltip. None of them is a Tab stop, so Tab goes
 * from the Subject straight to the text; from the text Alt+F10 enters the bar (the last used button), the arrows,
 * Home and End move in it, Esc or Tab goes back to the text with its selection.
 */
// the colour menus: "Automatikus" / "Nincs kiemelés" first, then the palette with a swatch and a name
function colorItems(cmd, paint) {
  if (cmd === 'foreColor') {
    return [
      { key: 'auto', label: t.composeColors.auto, swatch: 'var(--c-mail-text)', swatchOutline: true, onSelect: () => paint(cmd, null) },
      ...TEXT_COLORS.map(c => ({ key: c.id, label: t.composeColors.text[c.id], swatch: c.hex, swatchOutline: true, onSelect: () => paint(cmd, c.hex) })),
    ]
  }
  return [
    { key: 'none', label: t.composeColors.noHighlight, swatch: 'transparent', swatchOutline: true, onSelect: () => paint(cmd, null) },
    ...HIGHLIGHT_COLORS.map(c => ({ key: c.id, label: t.composeColors.highlight[c.id], swatch: c.hex, swatchOutline: true, onSelect: () => paint(cmd, c.hex) })),
  ]
}

/**
 * A colour button of the formatting bar and its menu (under the button). Click, Enter, Space or Down opens it; in the
 * menu the arrows move, Enter chooses (on the text's selection), Esc closes; both go back to the text with its selection.
 */
function ColorTool({ cmd, icon, label, index, current, open, setOpen, paint, onOpen, onLeave }) {
  const show = () => {
    onOpen()
    setOpen(cmd)
  }
  return (
    <span className="menu-anchor">
      <IconButton
        icon={icon}
        size="s"
        label={label}
        tabIndex={-1}
        aria-haspopup="menu"
        aria-expanded={open}
        onFocus={() => (current.current = index)}
        onMouseDown={e => e.preventDefault()}
        onClick={() => (open ? setOpen(null) : show())}
        onKeyDown={e => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault()
            show()
          }
        }}
      />
      {open && (
        <Menu
          items={colorItems(cmd, paint)}
          label={label}
          className={`menu-align-start color-menu color-menu-${cmd}`}
          onClose={reason => {
            setOpen(null)
            if (reason === 'escape' || reason === 'tab') onLeave()
          }}
        />
      )}
    </span>
  )
}

function Toolbar({ run, paint, barRef, current, onLeave, onOpenMenu }) {
  const [menu, setMenu] = useState(null) // the open colour menu: 'foreColor' | 'hiliteColor'
  const onKeyDown = e => {
    // the bar's own buttons (an open menu's items are not among them)
    const buttons = [...barRef.current.querySelectorAll(':scope > button, :scope > .menu-anchor > button')]
    const at = buttons.indexOf(document.activeElement)
    if (at < 0) return
    let next = null
    if (e.key === 'ArrowRight') next = (at + 1) % buttons.length
    else if (e.key === 'ArrowLeft') next = (at - 1 + buttons.length) % buttons.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = buttons.length - 1
    else if (e.key === 'Escape' || (e.key === 'Tab' && !e.shiftKey)) {
      e.preventDefault()
      e.stopPropagation()
      onLeave()
      return
    }
    if (next === null) return
    e.preventDefault()
    buttons[next].focus()
  }
  return (
    <div ref={barRef} className="editor-toolbar" role="toolbar" aria-label={t.composeFormatting} aria-keyshortcuts="Alt+F10" onKeyDown={onKeyDown}>
      {TOOLS.map(([cmd, icon, key = cmd, arg], i) =>
        cmd === 'foreColor' || cmd === 'hiliteColor' ? (
          <ColorTool
            key={cmd}
            cmd={cmd}
            icon={icon}
            label={t.composeTools[key]}
            index={i}
            current={current}
            open={menu === cmd}
            setOpen={setMenu}
            paint={paint}
            onOpen={onOpenMenu}
            onLeave={onLeave}
          />
        ) : (
        <IconButton
          key={cmd + (arg || '')}
          icon={icon}
          size="s"
          label={t.composeTools[key]}
          tabIndex={-1}
          onFocus={() => (current.current = i)}
          onMouseDown={e => e.preventDefault()}
          onClick={() => run(cmd, arg)}
        />
        ),
      )}
    </div>
  )
}

// "Küldés később": the quick choices or a custom date and time (the computer's local time); the note says it goes out only
// while the app runs and is unlocked. onPick(ms) schedules; the main process checks the range again.
function Ask({ title, text, buttons, onCancel, safeFocus = false }) {
  return (
    <Modal
      title={title}
      role="alertdialog"
      onClose={onCancel}
      actions={buttons.map(([label, fn, variant], i) => (
        <Button key={label} variant={variant || 'text'} onClick={fn} data-autofocus={(safeFocus ? i === 0 : variant === 'primary') ? true : undefined}>
          {label}
        </Button>
      ))}
    >
      {text && <p>{text}</p>}
    </Modal>
  )
}

/**
 * A pasted image's size menu: the three sizes (off where the image is not wider: no enlarging), its own size, and
 * Remove. onPick(img, width) with width 0 for Remove. Only the shown width changes, never the bytes.
 */
function ImageSizeMenu({ menu, onPick, onClose }) {
  const natural = menu.img.naturalWidth
  const now = sizeOf(natural, menu.img.getAttribute('width'))
  const items = [
    ...Object.entries(IMAGE_SIZES).map(([key, width]) => ({
      key,
      label: t.composeImageMenu[key],
      checked: now === key,
      disabled: width >= natural,
      title: width >= natural ? t.composeImageMenu.noEnlarge : undefined,
      onSelect: () => onPick(menu.img, width),
    })),
    { key: 'original', label: t.composeImageMenu.original, checked: now === 'original', disabled: !natural, onSelect: () => onPick(menu.img, natural) },
    { separator: true },
    { key: 'remove', label: t.composeImageMenu.remove, checked: false, onSelect: () => onPick(menu.img, 0) },
  ]
  return <Menu items={items} at={menu.at} className="context-menu image-size-menu" label={t.composeImageMenu.label} onClose={onClose} />
}

export function Composer({ sessionId }) {
  const [accounts, setAccounts] = useState([])
  const [accountId, setAccountId] = useState(null)
  const [to, setTo] = useState('')
  const [cc, setCc] = useState('')
  const [bcc, setBcc] = useState('')
  const [showCopies, setShowCopies] = useState(false)
  const [showFormat, setShowFormat] = useState(true) // the formatting bar, shown until hidden
  const [subject, setSubject] = useState('')
  const [attachments, setAttachments] = useState([])
  const [busy, setBusy] = useState(null) // 'saving' | 'sending'
  const [error, setError] = useState(null)
  const [savedAt, setSavedAt] = useState(null)
  // { kind: 'close' } | { kind: 'link' }. Not a bare string: 'close'.link is String.prototype.link (truthy)
  const [ask, setAsk] = useState(null)
  // a scheduled message whose earlier send may have gone out (interrupted / uncertain): said above the form, and the
  // send or a new schedule asks first, as the list's "Küldés most" does
  const [mayHaveGone, setMayHaveGone] = useState(null)
  const resendOk = useRef(false)
  const [linkUrl, setLinkUrl] = useState('https://')
  const draft = useRef(createDraftState()) // unsaved changes; see draft-state.js
  const busyRef = useRef(null)
  const [sentNotice, setSentNotice] = useState(null)
  // an informing line (an image that could only be attached), not an error
  const [info, setInfo] = useState(null)
  // a pasted image's size menu: { img, at }
  const [imageMenu, setImageMenu] = useState(null)
  // the message went out: the window only shows what happened, nothing is saved or sent again
  const [sent, setSent] = useState(false)
  const sentRef = useRef(false)
  const bodyTouched = useRef(false)
  const editor = useRef(null)
  const formRef = useRef(null)
  const savedRange = useRef(null) // the selection while the link dialog is open
  const toolbar = useRef(null)
  const toolIndex = useRef(0) // the formatting button Alt+F10 goes back to
  const textRange = useRef(null) // the text's selection while the keyboard is in the formatting bar
  const threading = useRef({ inReplyTo: null, references: [] }) // a reply's In-Reply-To / References

  const touch = () => {
    draft.current.touch()
  }
  useEffect(() => {
    busyRef.current = busy
  }, [busy])

  useEffect(() => {
    // the "e-mail bomb" check: the starting body is sanitized, parsed into an inert template and measured
    // BEFORE it goes into the editor; over SHAPE_LIMIT (or SWITCH_LIMIT) it does not go in at all: compose:suspect, the main process closes
    // this (still hidden) window and asks in the main window. Otherwise compose:checked shows the window.
    // 1.: the main process's watchdog waits for this page to say it holds its starting body. The layout is forced first (a
    // body the browser cannot lay out freezes HERE, and then nothing below runs); then the signal goes after the next
    // frame, or after 250 ms if no frame comes (a covered or minimized window may draw none: not measured; a page that
    // runs its timers is not stuck).
    let signalled = false
    const ready = () => {
      if (signalled) return
      signalled = true
      api.compose.ready(sessionId)
    }
    const afterBody = () => {
      if (editor.current) void editor.current.offsetHeight
      requestAnimationFrame(() => setTimeout(ready, 0))
      setTimeout(ready, 250)
    }
    // the starting body into the editor, unless its shape says no -> true, or the reason ('run': a run over N,
    // 'switches': a block over B direction switches; nothing written). `saved`: the user's own saved body (a draft or a
    // scheduled message opened again) keeps its formatting as it was saved; otherwise the link's body and the signature the
    // old way (no formatting, a table as lines), and a reply's / forward's `quote` with the original's formatting
    // (prepareQuote: hidden text out, readability, the table limit; too complex: the old way). Claude's quote
    // (app/main/compose.js) makes the same bytes.
    const place = ({ fragment, reason }) => {
      if (reason) return reason
      if (editor.current) editor.current.replaceChildren(fragment)
      return true
    }
    // `quote`: { before, body, after } (core/smtp/compose.js quoteParts): only the original's body is made ready, its
    // <style> never reaches our header lines; a quote without parts counts as all body
    const writeBody = (html, saved = false, quote = null) => {
      if (saved) return place(shapeOf(document, sanitizeCompose(DOMPurify, html, { sessionId, rich: true })))
      const head = sanitizeCompose(DOMPurify, html, { sessionId, tableRows: true })
      if (!quote || !quote.body) return place(shapeOf(document, head))
      const whole = quote.before + quote.body + quote.after
      // the old way's shape too, and it decides first: the quote asks wherever the plain quote (tables as lines, h4 / hr /
      // td joined) asks. The rich quote keeps those as blocks of their own, and 2000 blocks of alternating directions are
      // as slow to lay out as one long run (measured: until the watchdog). On the prepared quote: no <style> reaches the
      // sanitizer's parser (Chromium writes a policy line for one)
      const ready = prepareQuote(quote.body)
      const prepared = ready.plain ? whole : quote.before + ready.html + quote.after
      const plain = shapeOf(document, head + sanitizeCompose(DOMPurify, prepared, { sessionId, tableRows: true }))
      if (plain.reason || ready.plain) return place(plain)
      return place(shapeOf(document, head + sanitizeCompose(DOMPurify, prepared, { sessionId, rich: true })))
    }
    Promise.all([api.compose.accounts(), api.compose.initial(sessionId)]).then(([res, init]) => {
      if (!res.ok || !res.accounts.length) return true
      setAccounts(res.accounts)
      const form = init.ok ? init.form : null
      const account = (form && res.accounts.find(a => a.id === form.accountId)) || res.accounts[0]
      setAccountId(account.id)
      if (init.ok && init.attachments.length) setAttachments(init.attachments)
      if (form) {
        // reply / forward, or a mailto: link. The quote, or the link's body (escaped plain
        // text), goes through the composer sanitizer like a paste.
        setTo(form.to)
        setCc(form.cc)
        if (form.cc) setShowCopies(true)
        setSubject(form.subject)
        threading.current = { inReplyTo: form.inReplyTo, references: form.references }
        if (form.mayHaveGone) setMayHaveGone(form.mayHaveGone)
        if (form.body || form.quote || form.draftHtml) bodyTouched.current = true
        if (form.bcc) {
          setBcc(form.bcc)
          setShowCopies(true)
        }
        // a saved draft opened again: its own body, the signature is already in it
        const saved = form.draftHtml !== undefined
        const html = saved ? form.draftHtml : (form.body || '') + accountSignatureHtml(account)
        document.title = form.subject ? `${form.subject} - ShadowMail` : t.composeTitle
        const quote = saved ? null : form.quoteParts || (form.quote ? { before: '', body: form.quote, after: '' } : null)
        return writeBody(html, saved, quote)
      }
      document.title = t.composeTitle
      return writeBody(accountSignatureHtml(account))
    })
      // an error on the way (an IPC or a sanitizer failure) is no suspect: the window shows (empty), as before the check
      .catch(() => true)
      .then(ok => {
      if (ok !== true) {
        api.compose.suspect(sessionId, ok)
        return
      }
      api.compose.checked(sessionId)
      afterBody()
    })
  }, [sessionId])

  // another account: its signature replaces the signature block, and only it (the text written, the quote and the
  // attachments stay); no block (the user deleted it): no new one
  const chooseAccount = id => {
    setAccountId(id)
    touch()
    const a = accounts.find(x => x.id === id)
    const block = editor.current && editor.current.querySelector(`[${SIGNATURE_ATTR}]`)
    if (a && block) block.innerHTML = sanitizeCompose(DOMPurify, signatureInner(a.signature || '', a.hasImage ? accountImageSrc(a.id) : null))
  }

  const form = () => ({
    accountId,
    to,
    cc,
    bcc,
    subject,
    html: sanitizeCompose(DOMPurify, editor.current ? editor.current.innerHTML : '', { sessionId, rich: true }),
    inReplyTo: threading.current.inReplyTo || undefined,
    references: threading.current.references.length ? threading.current.references : undefined,
  })
  formRef.current = form

  const saveDraft = useCallback(async () => {
    if (!accountId || sentRef.current) return false
    setBusy('saving')
    const token = draft.current.beginSave()
    const res = await api.compose.saveDraft(sessionId, formRef.current())
    setBusy(null)
    if (!res.ok) {
      setError(t.composeError(res.error, res.detail, 'save'))
      return false
    }
    draft.current.saved(token) // what was typed during the save stays unsaved
    setError(res.oldDraftLeft ? t.composeOldDraftLeft : null)
    setSavedAt(res.savedAt)
    // the old account still holds a draft: the closing path shows it instead of closing
    return res.oldDraftLeft ? 'old_draft_left' : true
  }, [accountId, sessionId])

  // a draft every 60 s while something changed
  useEffect(() => {
    const timer = setInterval(() => {
      if (draft.current.dirty && !busy && !sentRef.current) saveDraft()
    }, AUTOSAVE_MS)
    return () => clearInterval(timer)
  }, [saveDraft, busy])

  // closing, from the window frame's X (the main process holds the close and asks the page) and from the header's own
  // close button alike: ask when something is not saved and not sent, else close. The header button does not call
  // window.close(): a page's own close never reaches the main process's close guard (measured), it closed unasked.
  const requestClose = () => {
    if (draft.current.dirty && !sentRef.current) setAsk({ kind: 'close' })
    else api.compose.close(sessionId)
  }
  useEffect(
    () => api.compose.onCloseRequested(() => requestClose()),
    // requestClose reads refs and the session only
    [sessionId],
  )

  // a lock is coming. Unsaved text is saved through the autosave path; the main process
  // waits at most 10 s for every window, then closes them. While sending there is nothing to save here.
  useEffect(
    () =>
      api.compose.onLockRequested(async () => {
        let ok = true
        if (draft.current.dirty && !sentRef.current && busyRef.current !== 'sending') ok = (await saveDraft()) !== false
        api.compose.lockDone(sessionId, ok)
      }),
    [sessionId, saveDraft],
  )

  // the earlier send of this scheduled message may have gone out: ask once before it goes again
  const askResend = (next, later = false) => {
    if (!mayHaveGone || resendOk.current) return false
    setAsk({ kind: 'resend', next, later })
    return true
  }
  const send = async () => {
    setError(null)
    if (!to.trim() && !cc.trim() && !bcc.trim()) {
      setError(t.composeErrors.no_recipients)
      return
    }
    if (askResend(send)) return
    setBusy('sending')
    const token = draft.current.beginSave()
    const res = await api.compose.send(sessionId, formRef.current())
    setBusy(null)
    if (!res.ok) {
      setError(t.composeError(res.error, res.detail) + (res.draftSaved ? ` ${t.composeKeptAsDraft}` : ''))
      if (res.draftSaved) draft.current.saved(token)
      return
    }
    draft.current.saved(token)
    sentRef.current = true
    setSent(true)
    // typed while it was being sent: that text did not go out
    const changed = draft.current.dirty
    // sent, but a recipient was refused or the Sent copy failed: the user must see it
    if ((res.rejected && res.rejected.length) || (res.warnings && res.warnings.length) || changed) {
      const parts = [t.composeSentWithWarnings(res.rejected || [], res.warnings || [])]
      if (changed) parts.push(t.composeChangedWhileSending)
      parts.push(t.composeSentLocked)
      setSentNotice(parts.join(' '))
      return
    }
    api.compose.close(sessionId)
  }

  // "Küldés később": the same checks as the send, then the window closes (the main window shows the notice)
  const [scheduling, setScheduling] = useState(false)
  const schedule = async sendAt => {
    setScheduling(false)
    setError(null)
    if (!to.trim() && !cc.trim() && !bcc.trim()) {
      setError(t.composeErrors.no_recipients)
      return
    }
    if (askResend(() => schedule(sendAt), true)) return
    setBusy('sending')
    const res = await api.compose.schedule(sessionId, formRef.current(), sendAt)
    setBusy(null)
    if (!res.ok) {
      setError(t.composeError(res.error, res.detail))
      return
    }
    sentRef.current = true
    setSent(true)
    api.compose.close(sessionId)
  }

  const emptyGuard = useRef(null)
  emptyGuard.current ??= createEmptyTextGuard()
  // the text emptied by a delete starts again clean at the first typed character (createEmptyTextGuard); the native
  // beforeinput / input events, the React ones carry no inputType
  useEffect(() => {
    const el = editor.current
    if (!el) return undefined
    const onEvent = e => {
      if (!sentRef.current) emptyGuard.current.watch(el, e)
    }
    el.addEventListener('beforeinput', onEvent)
    el.addEventListener('input', onEvent)
    el.addEventListener('compositionstart', onEvent)
    return () => {
      el.removeEventListener('beforeinput', onEvent)
      el.removeEventListener('input', onEvent)
      el.removeEventListener('compositionstart', onEvent)
    }
  }, [])

  const editorRange = () => {
    const sel = window.getSelection()
    return sel && sel.rangeCount && editor.current && editor.current.contains(sel.getRangeAt(0).commonAncestorContainer) ? sel.getRangeAt(0).cloneRange() : null
  }
  // back to the text from the formatting bar, with the selection the text had when the keyboard left it
  const backToText = () => {
    if (!editor.current) return
    editor.current.focus()
    const sel = window.getSelection()
    if (textRange.current && sel) {
      sel.removeAllRanges()
      sel.addRange(textRange.current)
    }
  }
  // a colour menu opened with the mouse: the text's selection is kept for the choice (the menu takes the focus)
  const keepTextRange = () => {
    const r = editorRange()
    if (r) textRange.current = r
  }
  const enterToolbar = () => {
    const buttons = toolbar.current ? toolbar.current.querySelectorAll('button') : []
    if (!buttons.length) return
    textRange.current = editorRange()
    ;(buttons[toolIndex.current] || buttons[0]).focus()
  }

  const run = (cmd, arg) => {
    if (!editor.current || sentRef.current) return
    // a mouse click keeps the focus in the text (mousedown is prevented); a key press comes from the bar
    if (toolbar.current && toolbar.current.contains(document.activeElement)) backToText()
    else editor.current.focus()
    if (cmd === 'link') {
      const sel = window.getSelection()
      savedRange.current = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null
      setLinkUrl('https://')
      setAsk({ kind: 'link' })
      return
    }
    emptyGuard.current.choose(cmd, editor.current)
    // a list in a paragraph: the paragraph(s) a div first (the editor's own command, an undo step), as the emptied text's
    // plain start does (reset), so the list does not go inside a paragraph
    if (/List$/.test(cmd) && inParagraph(editor.current)) document.execCommand('formatBlock', false, 'div')
    document.execCommand(cmd, false, arg)
    bodyTouched.current = true
    touch()
  }

  // a colour from a colour menu: the editor's own command on the text's selection (styleWithCSS off: a <font color>, a
  // highlight span); null = take it off: "Automatikus" the marker (text-colors.js AUTO_COLOR: shown in the colour around
  // it, never sent), "Nincs kiemelés" transparent
  const paint = (cmd, value) => {
    if (!editor.current || sentRef.current) return
    if (toolbar.current && toolbar.current.contains(document.activeElement)) backToText()
    else editor.current.focus()
    let v = value
    if (v === null) v = cmd === 'hiliteColor' ? 'transparent' : AUTO_COLOR
    emptyGuard.current.choose(cmd, editor.current)
    document.execCommand('styleWithCSS', false, false)
    document.execCommand(cmd, false, v)
    bodyTouched.current = true
    touch()
  }

  // copy / cut in the text: the composer's own HTML of the selection (sanitized, its formatting kept: rich; Chromium's own
  // copy would write the editor's computed font and colour onto it); a cut then deletes the selection with the editor's
  // own command (one undo step). A paste is one way for every clipboard (pasteHtml), so no mark is needed
  const ownCopy = (e, cut) => {
    if (sentRef.current || !editor.current) return
    const sel = window.getSelection()
    if (!sel || !sel.rangeCount || sel.isCollapsed) return
    const range = sel.getRangeAt(0)
    if (!editor.current.contains(range.commonAncestorContainer)) return
    e.preventDefault()
    e.clipboardData.setData('text/html', sanitizeCompose(DOMPurify, selectionHtml(range, editor.current), { sessionId, rich: true }))
    e.clipboardData.setData('text/plain', sel.toString())
    if (cut) {
      document.execCommand('delete')
      bodyTouched.current = true
      touch()
    }
  }

  // a pasted or dropped text/html into the text at the selection, one insertHTML (one undo step): the clipboard made ready
  // (core/mime/paste-prepare.js: hidden text out, an unreadable colour off, a huge table as lines), then the rich
  // sanitizer; too complex to make ready: the old way (no formatting, a table as lines) with an informing line
  const pasteHtml = html => {
    const ready = preparePaste(html)
    setInfo(ready.plain ? t.composePastePlain : null)
    // insert: no bare span (the old way leaves every span bare) and many blocks in one wrapping div: the editor's insertHTML
    // is quadratic in both (sanitize.js INSERT_WRAP_NODES)
    document.execCommand('insertHTML', false, ready.plain ? sanitizeCompose(DOMPurify, html, { sessionId, tableRows: true, insert: true }) : sanitizeCompose(DOMPurify, ready.html, { sessionId, rich: true, insert: true }))
    bodyTouched.current = true
    touch()
  }
  // a drag that started in this very text is the editor's own move (Chromium moves it), not a drop from outside
  const dragFromText = useRef(false)

  // pasted / dropped images into the text at `range` (the caret's range when the paste or drop came; the awaits move
  // the selection): PNG / JPEG go in as inl-img images of this session, one insertHTML (one undo step); a format the text
  // does not take (GIF, WebP, HEIC...: not_inline) is attached, with an informing line; any other refusal is the error
  // line and nothing of that image goes in
  const insertImages = async (files, range) => {
    setError(null)
    setInfo(null)
    const html = []
    const attach = []
    let failed = null
    for (const f of files) {
      const res = await api.compose.addImage(sessionId, await f.arrayBuffer())
      if (res.ok) html.push(`<img src="${pastedImageSrc(sessionId, res.id)}" alt="">`)
      else if (res.error === 'not_inline') attach.push(f)
      else if (!failed) failed = t.composeImageError(res.error, res.detail)
    }
    if (html.length && editor.current) {
      editor.current.focus()
      const sel = window.getSelection()
      if (range && editor.current.contains(range.startContainer)) {
        sel.removeAllRanges()
        sel.addRange(range)
      }
      document.execCommand('insertHTML', false, html.join(''))
      bodyTouched.current = true
      touch()
    }
    if (attach.length) {
      // an image with no file behind it (image data on the clipboard) cannot be attached: the preload has no path for it
      const n = await addFiles(attach)
      if (n) setInfo(t.composeImageAttached(n))
      if (n !== null && n < attach.length && !failed) failed = t.composeImageError('not_attachable')
    }
    if (failed) setError(failed)
  }
  const isInlineType = f => f.type === 'image/png' || f.type === 'image/jpeg'

  // a pasted image of this window, in the text
  const ownImage = node => Boolean(node && node.nodeName === 'IMG' && editor.current && editor.current.contains(node) && isPastedImageOf(node.getAttribute('src'), sessionId))
  // the image a context menu is for: the one clicked, or (the keyboard: Shift+F10, the menu key) the one selected or
  // right beside the caret
  const imageAt = target => {
    if (ownImage(target)) return target
    const sel = window.getSelection()
    if (!sel.rangeCount) return null
    const r = sel.getRangeAt(0)
    const c = r.startContainer
    if (c.nodeType === Node.ELEMENT_NODE) return [...(r.collapsed ? [c.childNodes[r.startOffset - 1]] : []), c.childNodes[r.startOffset]].find(ownImage) || null
    if (!r.collapsed) return null
    if (r.startOffset === 0 && ownImage(c.previousSibling)) return c.previousSibling
    if (r.startOffset === c.length && ownImage(c.nextSibling)) return c.nextSibling
    return null
  }
  // the image a keyboard selection holds exactly (Shift+arrow over it, or a click), or null
  const selectedImage = () => {
    const sel = window.getSelection()
    if (!sel.rangeCount) return null
    const r = sel.getRangeAt(0)
    if (r.collapsed || r.startContainer !== r.endContainer || r.endOffset !== r.startOffset + 1 || r.startContainer.nodeType !== Node.ELEMENT_NODE) return null
    const node = r.startContainer.childNodes[r.startOffset]
    return ownImage(node) ? node : null
  }
  const selectImage = img => {
    if (!ownImage(img)) return
    editor.current.focus()
    const r = document.createRange()
    r.selectNode(img)
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(r)
  }
  const openImageMenu = (img, at) => {
    const b = img.getBoundingClientRect()
    setImageMenu({ img, at: at || { x: b.left, y: b.bottom } })
  }
  // a size (a width attribute) or, with 0, the image removed: the image selected and replaced by the editor's own
  // commands, so Ctrl+Z takes the change back in one step
  const pickImageSize = (img, width) => {
    if (!ownImage(img)) return
    editor.current.focus()
    const r = document.createRange()
    r.selectNode(img)
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(r)
    if (width) document.execCommand('insertHTML', false, `<img src="${img.getAttribute('src')}" alt="" width="${width}">`)
    else document.execCommand('delete')
    bodyTouched.current = true
    touch()
  }

  // files: File objects (drop) or null (the open dialog); the preload turns them into paths
  // -> how many were attached, or null on an error (said in the error line)
  const addFiles = async files => {
    const res = await api.compose.addFiles(sessionId, files)
    if (res.ok) {
      setAttachments(res.attachments)
      touch()
      return res.added
    }
    setError(t.composeError(res.error, res.detail, 'attach'))
    return null
  }

  const discard = async () => {
    // queued behind the send it would come too late to stop it; say so, as for the save
    if (busyRef.current === 'sending') {
      setError(t.composeWaitSending)
      return
    }
    const res = await api.compose.discard(sessionId)
    // a draft left behind is said before the window goes
    if (!res.ok) {
      setError(t.composeError(res.error, res.detail, 'discard'))
      return
    }
    api.compose.close(sessionId)
  }
  const fromOptions = accounts.map(a => ({ value: a.id, label: a.display_name ? `${a.display_name} <${a.email}>` : a.email }))

  return (
    <main
      className="composer"
      onDragOver={e => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault()
      }}
      onDrop={e => {
        if (sentRef.current) return
        // a piece of a web page or a document dragged ONTO THE TEXT: the paste's own way (the editor would put it in as it
        // came, styles and all), at the drop point; the editor's own drag is its own move
        const html = e.dataTransfer.getData('text/html')
        if (!e.dataTransfer.files.length && html && !dragFromText.current && editor.current && editor.current.contains(e.target)) {
          e.preventDefault()
          const range = document.caretRangeFromPoint ? document.caretRangeFromPoint(e.clientX, e.clientY) : null
          editor.current.focus()
          if (range && editor.current.contains(range.startContainer)) {
            const sel = window.getSelection()
            sel.removeAllRanges()
            sel.addRange(range)
          }
          pasteHtml(html)
          return
        }
        if (!e.dataTransfer.files.length) return
        e.preventDefault()
        const files = [...e.dataTransfer.files]
        // a PNG / JPEG dropped ON THE TEXT goes in at the drop point; anything else, and anything dropped elsewhere, is attached
        const onText = editor.current && editor.current.contains(e.target)
        const images = onText ? files.filter(isInlineType) : []
        const rest = files.filter(f => !images.includes(f))
        if (images.length) void insertImages(images, document.caretRangeFromPoint ? document.caretRangeFromPoint(e.clientX, e.clientY) : null)
        if (rest.length) void addFiles(rest)
      }}
    >
      <header className="compose-title">
        <h1>{subject.trim() || t.newMessage}</h1>
        {/* the window's own close path: the main process asks the page first (onCloseRequested) */}
        <IconButton icon="close" size="s" label={t.composeCloseWindow} onClick={requestClose} />
      </header>
      {sentNotice && (
        <Banner kind="warning" className="notice" actions={<Button variant="text" onClick={() => api.compose.close(sessionId)}>{t.close}</Button>}>
          <p>{sentNotice}</p>
        </Banner>
      )}
      {mayHaveGone && !sent && (
        <Banner kind="warning" className="compose-may-have-gone">
          {t.composeMayHaveGone}
        </Banner>
      )}
      {error && (
        <Banner kind="error" className="compose-error">
          {error}
        </Banner>
      )}
      {info && (
        <p className="compose-info" role="status">
          {info}
        </p>
      )}
      <div className="compose-fields">
        <div className="compose-row">
          <span className="compose-label" id="compose-from-label">{t.composeFrom}</span>
          <Select id="compose-from" label={t.composeFrom} value={accountId} options={fromOptions} disabled={sent} onChange={id => chooseAccount(Number(id))} />
        </div>
        <RecipientField id="compose-to" label={t.composeTo} value={to} disabled={sent} onChange={v => (setTo(v), touch())}>
          {!showCopies && (
            <button type="button" className="link compose-copies" onClick={() => setShowCopies(true)}>{t.composeShowCopies}</button>
          )}
        </RecipientField>
        {showCopies && (
          <>
            <RecipientField id="compose-cc" label={t.composeCc} value={cc} disabled={sent} onChange={v => (setCc(v), touch())} />
            <RecipientField id="compose-bcc" label={t.composeBcc} value={bcc} disabled={sent} onChange={v => (setBcc(v), touch())} />
          </>
        )}
        <div className="compose-row">
          <label className="compose-label" htmlFor="compose-subject">{t.composeSubject}</label>
          <input id="compose-subject" type="text" value={subject} disabled={sent} onChange={e => (setSubject(e.target.value), touch())} />
        </div>
      </div>
      {showFormat && <Toolbar run={run} paint={paint} barRef={toolbar} current={toolIndex} onLeave={backToText} onOpenMenu={keepTextRange} />}
      <div
        ref={editor}
        className="editor"
        contentEditable={!sent}
        spellCheck={false}
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label={t.composeBody}
        aria-keyshortcuts={showFormat ? 'Alt+F10' : undefined}
        onKeyDown={e => {
          if (e.key === 'F10' && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && showFormat) {
            e.preventDefault()
            enterToolbar()
          }
          // Enter on a selected pasted image: its size menu (not a new line in place of the image)
          if (e.key === 'Enter' && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && !sentRef.current) {
            const img = selectedImage()
            if (img) {
              e.preventDefault()
              openImageMenu(img)
            }
          }
        }}
        onClick={e => {
          // a click on a pasted image: the image selected, its size menu at the pointer
          if (sentRef.current || !ownImage(e.target)) return
          selectImage(e.target)
          openImageMenu(e.target, { x: e.clientX, y: e.clientY })
        }}
        onInput={() => {
          bodyTouched.current = true
          touch()
        }}
        onContextMenu={e => {
          if (sentRef.current) return
          const img = imageAt(e.target)
          if (!img) return
          e.preventDefault()
          openImageMenu(img, e.target === img ? { x: e.clientX, y: e.clientY } : null)
        }}
        onDragStart={() => {
          dragFromText.current = true
        }}
        onDragEnd={() => {
          dragFromText.current = false
        }}
        onCopy={e => ownCopy(e, false)}
        onCut={e => ownCopy(e, true)}
        onPaste={e => {
          // only what the composer itself can make survives a paste
          e.preventDefault()
          const html = e.clipboardData.getData('text/html')
          // an image on the clipboard (a screenshot, a copied image or image file): the image goes in, unless the HTML
          // beside it has text to show (then it is a piece of a page: the HTML path, where outside images are dropped)
          const images = [...e.clipboardData.files].filter(f => f.type.startsWith('image/'))
          if (images.length && !hasShownText(html)) {
            const sel = window.getSelection()
            void insertImages(images, sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null)
            return
          }
          // the formatting stays (a table with its grid, colours, fonts, lists), only what can do harm goes (pasteHtml);
          // no text/html (Ctrl+Shift+V: Chromium hands only the text/plain then, MEASURED): the plain text. Into an
          // emptied text both start clean, as typing does (createEmptyTextGuard)
          if (!sentRef.current) emptyGuard.current.beforePaste(editor.current)
          if (html) {
            pasteHtml(html)
            return
          }
          setInfo(null)
          document.execCommand('insertText', false, e.clipboardData.getData('text/plain'))
          bodyTouched.current = true
          touch()
        }}
      />
      {imageMenu && (
        <ImageSizeMenu
          menu={imageMenu}
          onPick={pickImageSize}
          onClose={reason => {
            const img = imageMenu.img
            setImageMenu(null)
            // Esc: back to the image, selected (a choice already put the focus in the text)
            if (reason === 'escape' && editor.current) {
              if (ownImage(img)) selectImage(img)
              else editor.current.focus()
            }
          }}
        />
      )}
      {attachments.length > 0 && (
        <ul className="compose-attachments" aria-label={t.composeAttachmentsLabel(attachments.length)}>
          {attachments.map(a => (
            <li key={a.id} data-filename={a.filename} className="attachment-chip" title={a.filename}>
              <span className="attachment-chip-name">{a.filename}</span> <span className="hint">{t.sizeKb(a.size)}</span>
              <IconButton
                icon="close"
                size="s"
                disabled={sent}
                label={t.composeRemoveAttachment(a.filename)}
                onClick={async () => {
                  const res = await api.compose.removeAttachment(sessionId, a.id)
                  if (res.ok) setAttachments(res.attachments)
                  touch()
                }}
              />
            </li>
          ))}
        </ul>
      )}
      <footer className="compose-actions">
        <Button variant="primary" icon="send" onClick={send} disabled={busy !== null || !accountId || sent}>{busy === 'sending' ? t.composeSending : t.composeSend}</Button>
        <Button variant="outlined" className="compose-send-later" onClick={() => setScheduling(true)} disabled={busy !== null || !accountId || sent}>{t.composeSendLater}</Button>
        <IconButton icon="formatToggle" label={t.composeFormatting} title={t.composeFormattingHint} pressed={showFormat} onClick={() => setShowFormat(f => !f)} />
        <IconButton icon="attachment" label={t.composeAttach} disabled={sent} onClick={() => addFiles(null)} />
        <span className="hint compose-saved" role="status">{busy === 'saving' ? t.composeSaving : savedAt ? t.composeSavedAt(new Date(savedAt)) : ''}</span>
        <IconButton icon="save" label={t.composeSaveDraft} onClick={saveDraft} disabled={busy !== null || !accountId || sent} />
        <IconButton icon="trash" label={t.composeDiscard} onClick={() => setAsk({ kind: 'discard' })} disabled={sent} />
      </footer>
      {scheduling && <ScheduleDialog onPick={schedule} onCancel={() => setScheduling(false)} />}
      {ask && ask.kind === 'close' && (
        <Ask
          title={t.composeCloseTitle}
          text={t.composeCloseText}
          onCancel={() => setAsk(null)}
          buttons={[
            [t.composeSaveAndClose, async () => {
              setAsk(null)
              // while sending, a draft of the message that is going out must not be left behind; say so
              // instead of doing nothing
              if (busyRef.current === 'sending') {
                setError(t.composeWaitSending)
                return
              }
              if ((await saveDraft()) === true) api.compose.close(sessionId)
            }, 'primary'],
            [t.composeDiscard, async () => {
              setAsk(null)
              await discard()
            }, 'danger'],
            [t.confirmCancel, () => setAsk(null)],
          ]}
        />
      )}
      {ask && ask.kind === 'resend' && (
        <Ask
          title={ask.later ? t.scheduledList.interruptedLaterTitle : t.scheduledList.interruptedTitle}
          text={ask.later ? t.scheduledList.interruptedLaterText : t.scheduledList.interruptedText}
          safeFocus
          onCancel={() => setAsk(null)}
          buttons={[
            [t.scheduledList.interruptedNo, () => setAsk(null)],
            [ask.later ? t.scheduledList.interruptedLaterYes : t.scheduledList.interruptedYes, () => {
              const next = ask.next
              setAsk(null)
              resendOk.current = true
              next()
            }, 'primary'],
          ]}
        />
      )}
      {ask && ask.kind === 'discard' && (
        <Ask
          title={t.composeDiscardTitle}
          text={t.composeDiscardText}
          onCancel={() => setAsk(null)}
          buttons={[
            [t.confirmCancel, () => setAsk(null)],
            [t.composeDiscard, async () => {
              setAsk(null)
              await discard()
            }, 'danger'],
          ]}
        />
      )}
      {ask && ask.kind === 'link' && (
        <Modal
          title={t.composeTools.link}
          onClose={() => setAsk(null)}
          onSubmit={() => {
            setAsk(null)
            if (/^(https?:\/\/|mailto:)\S+$/i.test(linkUrl)) {
              editor.current.focus()
              const sel = window.getSelection()
              if (savedRange.current && sel) {
                sel.removeAllRanges()
                sel.addRange(savedRange.current)
              }
              // no selection: the address itself becomes the link text
              if (!sel || sel.isCollapsed) document.execCommand('insertHTML', false, `<a href="${escapeHtml(linkUrl)}">${escapeHtml(linkUrl)}</a>`)
              else document.execCommand('createLink', false, linkUrl)
              bodyTouched.current = true
              touch()
            } else setError(t.composeErrors.bad_link)
          }}
          actions={[
            <Button key="cancel" onClick={() => setAsk(null)}>{t.confirmCancel}</Button>,
            <Button key="ok" type="submit" variant="primary">{t.composeLinkOk}</Button>,
          ]}
        >
          <TextField label={t.composeLinkUrl} value={linkUrl} onChange={e => setLinkUrl(e.target.value)} spellCheck={false} data-autofocus />
        </Modal>
      )}
    </main>
  )
}
