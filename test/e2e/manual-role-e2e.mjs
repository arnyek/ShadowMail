#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// A folder role picked by hand moves with its folder in the folder tree too, in the real app (headless Electron +
// Playwright). Not part of `npm test`. Needs a fresh renderer build first: npx vite build
//
//   E2E_LANG=hu|en node test/e2e/manual-role-e2e.mjs
//
// Two IMAP accounts on the TCP mini server (test/helpers/imap-wire.js, "/" delimiter, SPECIAL-USE on), so every move
// and rename is a real RENAME on a server:
// A: INBOX, Sent (\Sent), Trash (\Trash), Ügyfelek, Ügyfelek/Régi, Projektek, Másik.
//   1. The Archive role picked by hand on Ügyfelek/Régi in the account settings (#acc-role-archive). Ügyfelek is a drop
//      target's taker again; dragged with the mouse into Projektek (the confirmation, Yes): one RENAME, Régi under the
//      new path with the Archive label and icon, still after the full sync; then Projektek/Ügyfelek renamed from its
//      menu; the role picker shows the new path.
//   2. Keyboard only: Shift+F10 on the parent, "Move…", the dialog's listbox (arrows, Enter), the confirmation (Enter):
//      under Másik. The hand-picked folder's own menu: Rename and Move on, Delete off; Rename starts from the folder's
//      own name (not the role's label) and keeps the role; the role picker shows the new path.
//   3. The automatic Sent and Trash (the server's SPECIAL-USE): no drop target (the dragover is not taken, no frame; a
//      mouse drag asks nothing), the menu's Move off with the role reason, Rename off with the protected text.
//   4a. Sent (\Sent) picked by hand as Sent: the same as 3.
// B: INBOX, Sent, Elküldött elemek (two usual Sent names, no flag), Spam (\Junk), Projektek.
//   4b. the usual-name Sent picked by hand as Sent, 4c. the \Junk Spam picked by hand as Archive: the same as 3.
// 5. The page console has no error or warning, the main log no error line and no folder name.
// Playwright: PW=<path of the playwright package> (default: the repo's playwright-core devDependency).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { startImapWire, mutf7 } from '../helpers/imap-wire.js'
import { createVaultedDatabase } from '../../core/vault/vaulted-db.js'
import { AccountStore } from '../../core/accounts/model.js'
import { newAccountDefaults } from '../../core/accounts/defaults.js'
import { t, seedLanguage } from './lang.mjs'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PW || 'playwright-core')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const MASTER = 'Teszt-mesterjelszo-kezi-szerep'
const sleep = ms => new Promise(r => setTimeout(r, ms))

const wireA = await startImapWire({
  delimiter: '/',
  specialUse: true,
  folders: [
    { path: 'INBOX' },
    { path: 'Sent', flags: ['\\Sent'] },
    { path: 'Trash', flags: ['\\Trash'] },
    { path: 'Ügyfelek' },
    { path: 'Ügyfelek/Régi' },
    { path: 'Projektek' },
    { path: 'Másik' },
  ],
})
const wireB = await startImapWire({
  delimiter: '/',
  specialUse: true,
  folders: [{ path: 'INBOX' }, { path: 'Sent' }, { path: 'Elküldött elemek' }, { path: 'Spam', flags: ['\\Junk'] }, { path: 'Projektek' }],
})
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-manual-role-e2e-'))
const dataDir = path.join(work, 'data')
fs.mkdirSync(dataDir)
seedLanguage(dataDir)
const NAME_A = 'IMAP fiók A'
const NAME_B = 'IMAP fiók B'
let idA, idB
{
  const { db, vault } = await createVaultedDatabase(dataDir, MASTER)
  const store = new AccountStore(db, vault, { storeDir: path.join(dataDir, 'store') })
  const base = { smtp_host: '127.0.0.1', smtp_port: 1, smtp_security: 'none', in_security: 'none', in_host: '127.0.0.1', in_password: 'nem-valodi' }
  idA = store.save({ ...newAccountDefaults('imap'), ...base, name: NAME_A, email: 'a@example.invalid', in_port: wireA.port, in_user: 'a' }).account.id
  idB = store.save({ ...newAccountDefaults('imap'), ...base, name: NAME_B, email: 'b@example.invalid', in_port: wireB.port, in_user: 'b' }).account.id
  db.close()
}

const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const until = async (fn, what, ms = 10000) => {
  const t0 = performance.now()
  while (performance.now() - t0 < ms) {
    if (await fn()) return true
    await sleep(50)
  }
  throw new Error(`timed out: ${what}`)
}
const mainLog = path.join(dataDir, 'electron', 'logs', 'main.log')
const consoleLines = []
const renames = wire => wire.log.filter(l => /^RENAME /i.test(l))
// a RENAME line naming both paths (as the client sends them: modified UTF-7, quoted or not)
const renamed = (wire, from, to) => renames(wire).some(l => l.includes(mutf7(from)) && l.includes(mutf7(to)) && l.indexOf(mutf7(from)) < l.lastIndexOf(mutf7(to)))

let app = null
try {
  app = await _electron.launch({ executablePath: electronBin, args: [repo, '--ozone-platform=headless', '--disable-gpu'], cwd: repo, env: { ...process.env, SHADOWMAIL_DATA: dataDir } })
  const page = await app.firstWindow()
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') consoleLines.push(`${m.type()}: ${m.text()}`) })
  page.on('pageerror', e => consoleLines.push(`pageerror: ${e.message}`))
  await page.setViewportSize({ width: 1280, height: 1000 })
  await page.locator('#vault-unlock').fill(MASTER)
  await page.getByRole('button', { name: t.vaultUnlockButton, exact: true }).click()
  const sec = id => page.locator(`.folder-tree section[data-account="${id}"]`)
  const folder = (id, p) => sec(id).locator(`.folder[data-path="${p}"]`)
  const dialog = page.getByRole('alertdialog')
  const focused = () => page.evaluate(() => ({ path: document.activeElement?.dataset?.path ?? null, role: document.activeElement?.getAttribute('role'), text: document.activeElement?.textContent?.trim() }))
  const rowsOf = id => page.evaluate(async id => (await window.shadowMail.mail.folders()).accounts.find(a => a.id === id).folders.map(f => ({ path: f.path, special_use: f.special_use, role: f.role, role_manual: f.role_manual })), id)
  const rowOf = async (id, p) => (await rowsOf(id)).find(r => r.path === p) || null
  const hasRole = async (id, p, role) => {
    const r = await rowOf(id, p)
    return Boolean(r && r.role === role && r.role_manual === 1)
  }
  // the tree draws the folder as the role folder: the role's label and its icon
  const drawnAs = async (id, p, role) => {
    const f = folder(id, p)
    if ((await f.count()) !== 1) return { count: await f.count() }
    return { label: (await f.locator('.folder-label').innerText()).trim(), icon: await f.locator('svg[data-icon]').first().getAttribute('data-icon') }
  }
  const drawnOk = (d, role) => d.label === t.folderRoles[role] && d.icon === role
  // a drag with the mouse to the middle of the target ("into")
  const mouseDrag = async (from, to) => {
    await from.scrollIntoViewIfNeeded()
    const a = await from.boundingBox()
    const b = await to.boundingBox()
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
    await page.mouse.down()
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2 + 6, { steps: 3 })
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 })
    await page.mouse.up()
  }
  // during a drag (Chromium's own DragEvent: a mouse drag delivers the state only at the drop): does the target's
  // middle take the dragged folder (the dragover's default prevented) and is it framed?
  const dropTaken = (id, from, to) =>
    page.evaluate(
      ([id, from, to]) => {
        const q = p => document.querySelector(`.folder-tree section[data-account="${id}"] .folder[data-path="${p}"]`)
        const a = q(from)
        const b = q(to)
        const dt = new DataTransfer()
        a.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
        const r = b.getBoundingClientRect()
        const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 })
        b.dispatchEvent(over)
        return new Promise(resolve =>
          setTimeout(() => {
            const framed = document.querySelectorAll('.folder-tree li.drop-into').length
            a.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }))
            resolve({ taken: over.defaultPrevented, framed })
          }, 250),
        )
      },
      [id, from, to],
    )
  // the folder menu's items as drawn: { label: { disabled, title } }
  const menuState = () =>
    page.evaluate(() =>
      Object.fromEntries([...document.querySelectorAll('.context-menu [role="menuitem"]')].map(el => [el.textContent.trim(), { disabled: el.disabled, title: el.getAttribute('title') }])),
    )
  const openMenuByMouse = async (id, p) => {
    await folder(id, p).click({ button: 'right' })
    await page.locator('.context-menu [role="menuitem"]').first().waitFor({ timeout: 3000 })
  }
  const openMenuByKeys = async (id, p) => {
    await folder(id, p).focus()
    await page.keyboard.press('Shift+F10')
    await page.locator('.context-menu [role="menuitem"]').first().waitFor({ timeout: 3000 })
  }
  const closeMenu = async () => {
    await page.keyboard.press('Escape')
    await page.locator('.context-menu').waitFor({ state: 'detached', timeout: 3000 })
  }
  // the arrows to a menu item, Enter; -> whether the focus reached it
  const pickByKeys = async label => {
    for (let i = 0; i < 12 && (await focused()).text !== label; i++) await page.keyboard.press('ArrowDown')
    const on = (await focused()).text === label
    await page.keyboard.press('Enter')
    return on
  }
  const listbox = page.locator('.move-folder-dialog [role="listbox"]')
  const activePath = () =>
    page.evaluate(() => {
      const lb = document.querySelector('.move-folder-dialog [role="listbox"]')
      return document.getElementById(lb.getAttribute('aria-activedescendant'))?.dataset.path ?? null
    })
  const toTarget = async p => {
    for (let i = 0; i < 20 && (await activePath()) !== p; i++) await page.keyboard.press('ArrowDown')
    return (await activePath()) === p
  }
  // the account settings: the role picker of an account (-> the trigger's text), back to the mail view after
  const settingsOpen = async name => {
    await page.getByRole('button', { name: t.viewSettings, exact: true }).click()
    await page.locator('.settings-tab', { hasText: t.settingsNav.accounts }).click()
    await page.locator('.account-list li', { hasText: name }).getByRole('button', { name: t.accountEdit, exact: true }).click()
    await page.locator('form.account-editor fieldset.folder-roles').waitFor()
  }
  const settingsClose = async () => {
    await page.getByRole('button', { name: t.viewSettings, exact: true }).click()
    await page.locator('.folder-tree').waitFor()
  }
  const pickerText = role => page.locator(`#acc-role-${role}`).textContent()
  const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pickInSettings = async (role, label) => {
    await page.locator(`#acc-role-${role}`).click()
    await page.locator('.menu [role^="menuitem"]').filter({ hasText: new RegExp(`^${escRe(label)}$`) }).first().click()
  }
  // 3. / 4.: a role that stays where it is: no drop target, a mouse drag asks nothing, Move and Rename off with the reasons
  const staysFixed = async (what, id, p, target) => {
    const drop = await dropTaken(id, p, target)
    check(`${what}: dragged over ${target}, no drop target (not taken, no frame)`, !drop.taken && drop.framed === 0, JSON.stringify(drop))
    await mouseDrag(folder(id, p), folder(id, target))
    await sleep(500)
    check(`${what}: a mouse drag into ${target} asks nothing, the folder stays`, (await dialog.count()) === 0 && (await folder(id, p).count()) === 1 && (await folder(id, `${target}/${p}`).count()) === 0)
    await openMenuByMouse(id, p)
    const m = await menuState()
    const mv = m[t.folderMenu.move]
    const rn = m[t.folderMenu.rename]
    check(`${what}: the menu's Move off, the reason as its title`, mv && mv.disabled && mv.title === t.moveDialog.reasons.role, JSON.stringify(mv))
    check(`${what}: the menu's Rename off, the protected text as its title`, rn && rn.disabled && rn.title === t.folderProtected, JSON.stringify(rn))
    await closeMenu()
  }

  await folder(idA, 'Ügyfelek/Régi').waitFor({ timeout: 20000 })
  await folder(idB, 'Spam').waitFor({ timeout: 20000 })
  // the first full sync has stored the automatic roles (Sent, Trash of the server)
  await until(async () => (await rowOf(idA, 'Sent'))?.role === 'sent' && (await rowOf(idA, 'Trash'))?.role === 'trash', 'the automatic roles of A', 20000)

  // 1. the Archive role picked by hand on Ügyfelek/Régi in the account settings
  await settingsOpen(NAME_A)
  await pickInSettings('archive', 'Ügyfelek/Régi')
  await until(() => hasRole(idA, 'Ügyfelek/Régi', 'archive'), 'the hand-picked archive stored')
  // the picker reloads its folders after the store: its text follows a moment later
  await until(async () => (await pickerText('archive')) === 'Ügyfelek/Régi', 'the picker on the chosen folder', 5000).catch(() => {})
  check('1. the picker shows the chosen folder', (await pickerText('archive')) === 'Ügyfelek/Régi', await pickerText('archive'))
  await settingsClose()
  await until(async () => drawnOk(await drawnAs(idA, 'Ügyfelek/Régi', 'archive'), 'archive'), 'Régi drawn as the Archive', 5000).catch(() => {})
  check('1. the tree draws Ügyfelek/Régi as the Archive (label and icon)', drawnOk(await drawnAs(idA, 'Ügyfelek/Régi'), 'archive'), JSON.stringify(await drawnAs(idA, 'Ügyfelek/Régi')))
  const takes = await dropTaken(idA, 'Ügyfelek', 'Projektek')
  check('1. the parent of the hand-picked Archive: Projektek takes it (the dragover taken, framed)', takes.taken && takes.framed === 1, JSON.stringify(takes))

  const renamesBefore = renames(wireA).length
  await mouseDrag(folder(idA, 'Ügyfelek'), folder(idA, 'Projektek'))
  await dialog.waitFor({ timeout: 5000 })
  const ask = await dialog.locator('.confirm-text').innerText()
  check('1. the drop asks: the name, the target, its subfolder', ask === t.confirmFolderMove('Ügyfelek', 'Projektek', 1), ask)
  await dialog.getByRole('button', { name: t.folderMoveYes, exact: true }).click()
  await folder(idA, 'Projektek/Ügyfelek/Régi').waitFor({ timeout: 10000 })
  check('1. one RENAME Ügyfelek -> Projektek/Ügyfelek on the server', renames(wireA).length === renamesBefore + 1 && renamed(wireA, 'Ügyfelek', 'Projektek/Ügyfelek'), renames(wireA).join(' | '))
  check('1. moved: Régi under the new path, the old paths gone', (await folder(idA, 'Ügyfelek').count()) === 0 && (await folder(idA, 'Ügyfelek/Régi').count()) === 0)
  check('1. Régi under the new path is drawn as the Archive (label and icon)', drawnOk(await drawnAs(idA, 'Projektek/Ügyfelek/Régi'), 'archive'), JSON.stringify(await drawnAs(idA, 'Projektek/Ügyfelek/Régi')))
  // the full sync after the move (a LIST after the RENAME) keeps the hand-picked role on the moved row
  const afterMove = wireA.log.length
  await until(async () => wireA.log.slice(afterMove).some(l => /^LIST /i.test(l)), 'the full sync after the move', 15000).catch(() => {})
  await sleep(1500)
  check('1. after the full sync: the moved row keeps archive, picked by hand', await hasRole(idA, 'Projektek/Ügyfelek/Régi', 'archive'), JSON.stringify(await rowOf(idA, 'Projektek/Ügyfelek/Régi')))

  // the parent renamed from its menu (the mouse)
  await openMenuByMouse(idA, 'Projektek/Ügyfelek')
  const parentMenu = await menuState()
  check('1. the parent\'s menu: Rename on', parentMenu[t.folderMenu.rename] && !parentMenu[t.folderMenu.rename].disabled, JSON.stringify(parentMenu[t.folderMenu.rename]))
  await page.locator('.context-menu [role="menuitem"]', { hasText: t.folderMenu.rename }).click()
  const nameInput = page.locator('.modal input[type="text"], [role="dialog"] input[type="text"]').first()
  await nameInput.waitFor({ timeout: 3000 })
  check('1. the rename dialog starts from the folder\'s name', (await nameInput.inputValue()) === 'Ügyfelek', await nameInput.inputValue())
  await nameInput.fill('Partnerek')
  await page.getByRole('button', { name: t.folderRename, exact: true }).click()
  await folder(idA, 'Projektek/Partnerek/Régi').waitFor({ timeout: 10000 })
  check('1. renamed: one RENAME Projektek/Ügyfelek -> Projektek/Partnerek', renamed(wireA, 'Projektek/Ügyfelek', 'Projektek/Partnerek'), renames(wireA).join(' | '))
  check('1. Régi under the renamed parent is drawn as the Archive (label and icon)', drawnOk(await drawnAs(idA, 'Projektek/Partnerek/Régi'), 'archive'), JSON.stringify(await drawnAs(idA, 'Projektek/Partnerek/Régi')))
  check('1. the stored row: archive, picked by hand, under the new path', await hasRole(idA, 'Projektek/Partnerek/Régi', 'archive'), JSON.stringify(await rowOf(idA, 'Projektek/Partnerek/Régi')))
  await settingsOpen(NAME_A)
  await until(async () => (await pickerText('archive')) === 'Projektek/Partnerek/Régi', 'the picker on the new path', 5000).catch(() => {})
  check('1. the account settings\' role picker shows the new path', (await pickerText('archive')) === 'Projektek/Partnerek/Régi', await pickerText('archive'))
  await settingsClose()

  // 2. keyboard only: the parent under Másik through the menu's "Move…"
  await folder(idA, 'Projektek/Partnerek/Régi').waitFor({ timeout: 5000 })
  await openMenuByKeys(idA, 'Projektek/Partnerek')
  const kMenu = await menuState()
  check('2. Shift+F10 opens the parent\'s menu, Move on', kMenu[t.folderMenu.move] && !kMenu[t.folderMenu.move].disabled && !kMenu[t.folderMenu.move].title, JSON.stringify(kMenu[t.folderMenu.move]))
  check('2. the arrows reach "Move…"', await pickByKeys(t.folderMenu.move))
  await listbox.waitFor({ timeout: 3000 })
  check('2. the dialog names the folder, the listbox has the focus', (await page.locator('.move-folder-dialog').innerText()).includes(t.moveDialog.title('Partnerek')) && (await focused()).role === 'listbox')
  check('2. the arrows reach Másik', await toTarget('Másik'))
  const why = await page.evaluate(() => {
    const lb = document.querySelector('.move-folder-dialog [role="listbox"]')
    return document.getElementById(lb.getAttribute('aria-activedescendant'))?.getAttribute('aria-disabled') ?? null
  })
  check('2. Másik is an allowed target', why === null, String(why))
  await page.keyboard.press('Enter')
  await dialog.waitFor({ timeout: 3000 })
  const askK = await dialog.locator('.confirm-text').innerText()
  check('2. the confirmation: the folder, the target, its subfolder', askK === t.confirmFolderMove('Partnerek', 'Másik', 1), askK)
  await page.keyboard.press('Enter')
  await folder(idA, 'Másik/Partnerek/Régi').waitFor({ timeout: 10000 })
  await until(async () => (await focused()).path === 'Másik/Partnerek', 'the focus on the moved folder', 3000).catch(() => {})
  check('2. moved: one RENAME Projektek/Partnerek -> Másik/Partnerek, the focus on it', renamed(wireA, 'Projektek/Partnerek', 'Másik/Partnerek') && (await folder(idA, 'Projektek/Partnerek').count()) === 0 && (await focused()).path === 'Másik/Partnerek', JSON.stringify(await focused()))
  check('2. Régi under Másik is drawn as the Archive (label and icon)', drawnOk(await drawnAs(idA, 'Másik/Partnerek/Régi'), 'archive'), JSON.stringify(await drawnAs(idA, 'Másik/Partnerek/Régi')))
  check('2. the stored row: archive, picked by hand, under Másik', await hasRole(idA, 'Másik/Partnerek/Régi', 'archive'), JSON.stringify(await rowOf(idA, 'Másik/Partnerek/Régi')))

  // the hand-picked role folder itself: its menu from the keyboard, Rename from its own name
  await openMenuByKeys(idA, 'Másik/Partnerek/Régi')
  const own = await menuState()
  check('2. the hand-picked folder\'s menu: Rename on, no protected title', own[t.folderMenu.rename] && !own[t.folderMenu.rename].disabled && !own[t.folderMenu.rename].title, JSON.stringify(own[t.folderMenu.rename]))
  check('2. the hand-picked folder\'s menu: Move on', own[t.folderMenu.move] && !own[t.folderMenu.move].disabled, JSON.stringify(own[t.folderMenu.move]))
  check('2. the hand-picked folder\'s menu: Delete stays off (a role folder)', own[t.folderMenu.delete] && own[t.folderMenu.delete].disabled && own[t.folderMenu.delete].title === t.folderProtected, JSON.stringify(own[t.folderMenu.delete]))
  check('2. the arrows reach "Rename…"', await pickByKeys(t.folderMenu.rename))
  await nameInput.waitFor({ timeout: 3000 })
  const startName = await nameInput.inputValue()
  check('2. the rename dialog starts from the folder\'s own name, not the role\'s label', startName === 'Régi' && startName !== t.folderRoles.archive, startName)
  check('2. the name field has the focus, its text selected', await nameInput.evaluate(el => document.activeElement === el && el.selectionStart === 0 && el.selectionEnd === el.value.length))
  await page.keyboard.type('Lezárt')
  await page.keyboard.press('Enter')
  await folder(idA, 'Másik/Partnerek/Lezárt').waitFor({ timeout: 10000 })
  check('2. renamed: one RENAME Másik/Partnerek/Régi -> Másik/Partnerek/Lezárt', renamed(wireA, 'Másik/Partnerek/Régi', 'Másik/Partnerek/Lezárt') && (await folder(idA, 'Másik/Partnerek/Régi').count()) === 0, renames(wireA).join(' | '))
  check('2. the renamed folder is drawn as the Archive (label and icon)', drawnOk(await drawnAs(idA, 'Másik/Partnerek/Lezárt'), 'archive'), JSON.stringify(await drawnAs(idA, 'Másik/Partnerek/Lezárt')))
  check('2. the stored row: archive, picked by hand, under its new name', await hasRole(idA, 'Másik/Partnerek/Lezárt', 'archive'), JSON.stringify(await rowOf(idA, 'Másik/Partnerek/Lezárt')))
  await settingsOpen(NAME_A)
  await until(async () => (await pickerText('archive')) === 'Másik/Partnerek/Lezárt', 'the picker on the renamed path', 5000).catch(() => {})
  check('2. the account settings\' role picker shows the new path', (await pickerText('archive')) === 'Másik/Partnerek/Lezárt', await pickerText('archive'))
  await settingsClose()
  await folder(idA, 'Sent').waitFor({ timeout: 5000 })

  // 3. the automatic Sent and Trash (the server's SPECIAL-USE): unchanged
  check('3. Sent and Trash: automatic roles (not picked by hand)', (await rowOf(idA, 'Sent'))?.role_manual !== 1 && (await rowOf(idA, 'Trash'))?.role_manual !== 1, JSON.stringify([await rowOf(idA, 'Sent'), await rowOf(idA, 'Trash')]))
  await staysFixed('3. automatic Sent', idA, 'Sent', 'Projektek')
  await staysFixed('3. automatic Trash', idA, 'Trash', 'Projektek')

  // 4a. the \Sent-flagged Sent picked by hand as Sent (the app's own picker call)
  const setA = await page.evaluate(id => window.shadowMail.folders.setRole({ accountId: id, role: 'sent', path: 'Sent' }), idA)
  await until(() => hasRole(idA, 'Sent', 'sent'), 'Sent of A picked by hand')
  check('4a. the \\Sent folder picked by hand as Sent', setA.ok && (await rowOf(idA, 'Sent'))?.special_use === '\\Sent', JSON.stringify(await rowOf(idA, 'Sent')))
  await sleep(1000)
  await staysFixed('4a. hand-picked \\Sent', idA, 'Sent', 'Projektek')

  // 4b. / 4c. account B: the usual-name Sent (next to Elküldött elemek) as Sent, the \Junk Spam as Archive
  const setB1 = await page.evaluate(id => window.shadowMail.folders.setRole({ accountId: id, role: 'sent', path: 'Sent' }), idB)
  const setB2 = await page.evaluate(id => window.shadowMail.folders.setRole({ accountId: id, role: 'archive', path: 'Spam' }), idB)
  await until(async () => (await hasRole(idB, 'Sent', 'sent')) && (await hasRole(idB, 'Spam', 'archive')), 'B: Sent and Spam picked by hand')
  const bSent = await rowOf(idB, 'Sent')
  const bSpam = await rowOf(idB, 'Spam')
  check('4b. the usual-name Sent (no flag, Elküldött elemek beside it) picked by hand as Sent', setB1.ok && !bSent.special_use && (await rowOf(idB, 'Elküldött elemek'))?.role !== 'sent', JSON.stringify([bSent, await rowOf(idB, 'Elküldött elemek')]))
  check('4c. the \\Junk Spam picked by hand as Archive', setB2.ok && bSpam.special_use === '\\Junk', JSON.stringify(bSpam))
  await sleep(1000)
  check('4c. the tree draws Spam as the Archive', drawnOk(await drawnAs(idB, 'Spam'), 'archive'), JSON.stringify(await drawnAs(idB, 'Spam')))
  await staysFixed('4b. hand-picked usual-name Sent', idB, 'Sent', 'Projektek')
  await staysFixed('4c. hand-picked \\Junk as Archive', idB, 'Spam', 'Projektek')

  // 5. clean console and main log
  const text = fs.existsSync(mainLog) ? fs.readFileSync(mainLog, 'utf8') : ''
  const bad = text.trim().split('\n').filter(l => /failed|error/i.test(l))
  check('5. the main log: no error or failure line', bad.length === 0, bad.join(' | '))
  check('5. the main log: no folder name', !['Ügyfelek', 'Régi', 'Partnerek', 'Lezárt', 'Projektek', 'Másik', 'Spam'].some(n => text.includes(n)))
  check('5. the page console: no error or warning', consoleLines.length === 0, consoleLines.join(' | '))
} catch (err) {
  console.error(err)
  results.push(false)
} finally {
  if (app) await app.close().catch(() => {})
  await wireA.close()
  await wireB.close()
  fs.rmSync(work, { recursive: true, force: true })
}
const failed = results.filter(r => !r).length
console.log(`${results.length - failed} / ${results.length} OK`)
process.exit(failed ? 1 : 0)
