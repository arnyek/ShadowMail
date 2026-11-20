// SPDX-License-Identifier: GPL-3.0-or-later
// Electron main process. The data paths MUST be set before anything else touches Electron,
// otherwise Chromium creates its folders under %APPDATA% / %LOCALAPPDATA%.
import { app, BrowserWindow, clipboard, ClipboardItem, dialog, ipcMain, Menu, nativeImage, protocol, screen, session, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveDataDir, electronPaths, ensureWritableDir, databasePath } from '../../core/paths.js'
import { upgradeDatabase } from '../../core/db/upgrade.js'
import { sqliteVersion } from '../../core/db/index.js'
import { t, lang, setLanguage, hu } from '../renderer/i18n/index.js'
import { readLanguage, writeLanguage } from '../../core/ui-language-file.js'
import { COMPOSER_SIZE, composerBounds, MAIN_MIN_WIDTH } from './window-size.js'
import { Vault, VaultError } from '../../core/vault/vault.js'
import { vaultPath, dataFolderState, openUnlockedDatabase, openSealedStore } from '../../core/vault/vaulted-db.js'
import { recoverInterruptedReset } from '../../core/vault/reset.js'
import { VaultFile } from '../../core/vault/vault-file.js'
import { registerVaultIpc } from './ipc/vault.js'
import { accountEditorForm } from '../../core/accounts/defaults.js'
import { testAccountConnection, registerAccountIpc, ACCOUNT_CHANNELS, saveAccount, deleteAccount } from './ipc/accounts.js'
import { AccountStore } from '../../core/accounts/model.js'
import { MailIndex } from '../../core/db/mail-index.js'
import { registerMailIpc, MAIL_CHANNELS } from './ipc/mail.js'
import { SyncManager } from './sync-manager.js'
import { MessageReader } from './reader.js'
import { registerReaderIpc, emptyTmpDir, READER_CHANNELS } from './ipc/reader.js'
import { fallbackTmpDir } from './motw.js'
import { registerSearchIpc, SEARCH_CHANNELS } from './ipc/search.js'
import { MailActions } from './actions.js'
import { registerActionIpc, ACTION_CHANNELS } from './ipc/actions.js'
import { registerLabelIpc, LABEL_CHANNELS } from './ipc/labels.js'
import { Labels } from '../../core/db/labels.js'
import { FolderActions } from './folders.js'
import { registerFolderIpc, FOLDER_CHANNELS } from './ipc/folders.js'
import { registerScheduledIpc, SCHEDULED_CHANNELS } from './ipc/scheduled.js'
import { Composer } from './compose.js'
import { registerComposeIpc, guardComposerClose, COMPOSE_CHANNELS, readyTimeoutFrom } from './ipc/compose.js'
import { Contacts } from '../../core/db/contacts.js'
import { People } from '../../core/db/people.js'
import { registerContactsIpc, CONTACTS_CHANNELS } from './ipc/contacts.js'
import { registerPrefsIpc } from './ipc/prefs.js'
import { showMainWindow } from './window-front.js'
import { noRecent } from './dialog-options.js'
import { registerMailSchemes, handleMailProtocols, VIEW_SCHEME } from './protocols.js'
import { frameReaderKey } from './reader-keys.js'
import { installNetGuard } from './net-guard.js'
import { createRoutedIpc } from './routed-ipc.js'
import { saveBeforeLock } from './lock.js'
import { createClipboardGuard, settleWithin, windowsWrite } from './clipboard-guard.js'
import { errCode } from '../../core/log-safe.js'
import { runConnector } from './mcp/connector.js'
import { createMcpService, registerMcpIpc, MCP_CHANNELS } from './mcp/service.js'
import { createConfirmPolicy } from './mcp/confirm-policy.js'
import { createMcpTools } from './mcp/tools.js'
import { ConfirmationQueue } from './mcp/confirm.js'
import { endpointFile } from './mcp/server.js'
import { openSettings } from './settings.js'
import { overlayApplier, startTaskbarBadge, registerTaskbarIpc, TASKBAR_CHANNELS } from './taskbar.js'
import { Scheduled } from '../../core/db/scheduled.js'
import { createScheduler } from './scheduler.js'
import { SearchTextService } from '../../core/mime/search-text-service.js'
import { createSearchRefiner, createFtsReindex } from './search-index.js'
import { imageCodec } from './image-codec.js'

// The message frame's schemes must be registered before 'ready'.
registerMailSchemes(protocol)

// the signature image's and a pasted image's decoder and upright-turner (nativeImage)
const codec = imageCodec(nativeImage)

// no proxy auto-detection (WPAD) at start: a measurement of the first build saw it as a network
// request on launch. Mail (IMAP/POP3/SMTP) goes through Node sockets and is not affected; the only
// Chromium requests are external images the user allowed ("Képek betöltése"), which then go direct.
app.commandLine.appendSwitch('no-proxy-server')
// the external images of "Képek betöltése" must not reach the disk. No HTTP disk cache
// for the app's session; a separate in-memory partition would need the net guard, the protocols and the
// permission handler moved over, for the same effect. Measured by the grep check (test/e2e/grep-e2e.mjs).
app.commandLine.appendSwitch('disable-http-cache')

const dataDir = resolveDataDir({
  isPackaged: app.isPackaged,
  exePath: app.getPath('exe'),
  appPath: app.getAppPath(),
  env: process.env,
})
const paths = electronPaths(dataDir)
// Test hook: SHADOWMAIL_SMOKE=1 renders the window, records what it shows into
// data/electron/logs/smoke.{json,png} and quits.
const smoke = process.env.SHADOWMAIL_SMOKE === '1'
// the link-target bar gets at most this much of a hovered link's URL (a message can carry a megabyte-long href)
const LINK_TARGET_MAX = 8192
// MCP: `ShadowMail.exe --mcp` is a stdio connector to the running app, not an
// app instance. No window, no single-instance lock, no vault or database; the Electron folders in data\.
const mcpConnector = process.argv.includes('--mcp')
// the connector draws nothing: no GPU process
if (mcpConnector) app.disableHardwareAcceleration()

function log(message) {
  try {
    fs.appendFileSync(path.join(paths.logs, 'main.log'), `${new Date().toISOString()} [${process.pid}] ${message}\n`)
  } catch {
    // Logging must never take the app down.
  }
}

function setupDataPaths({ quiet = smoke } = {}) {
  try {
    ensureWritableDir(dataDir)
    for (const [name, dir] of Object.entries(paths)) {
      ensureWritableDir(dir)
      app.setPath(name, dir)
    }
    return true
  } catch (err) {
    const reason = err && err.code ? err.code : String(err)
    if (quiet) process.stderr.write(`data dir not writable: ${dataDir} (${reason})\n`)
    else dialog.showErrorBox(t.errorTitle, t.dataDirNotWritable(dataDir, reason))
    return false
  }
}

let mainWindow = null
let db = null
let vault = null
let syncManager = null
let reader = null
// the composer's sig-img:// images, of the open session (null when locked)
let signatureSource = null
// the composer's pasted inl-img:// images, of the open session (null when locked)
let pastedSource = null
let sealedStore = null // the session's SealedStore, closed (key wiped) on lock
let searchWork = null // the session's search-text worker, refiner and re-index; stopped on lock
let unlocked = null // what the unlocked session opened (db, services); null while locked
let openMailto = null // a mailto: link of the message frame -> a filled composer window
let saveAllForLock = null // the open composers save before a lock (ipc/compose.js)
let quitting = false
let mcpService = null // MCP: Claude access of the unlocked session (pipe only while the switch is ON)
let taskbar = null // the unread badge on the taskbar button of the unlocked session (taskbar.js)
let scheduler = null // "Küldés később": sends the scheduled messages of the unlocked session (scheduler.js)
// the lock waits this long for a scheduled send under way (its row is recorded while the database is open)
const SCHEDULED_LOCK_WAIT_MS = 10_000
// draws the badge on the main window (Windows only); the e2e watches the calls through SHADOWMAIL_TEST_OVERLAY_LOG
const applyOverlay = overlayApplier({
  getWindow: () => mainWindow,
  nativeImage,
  describe: n => t.taskbarUnreadBadge(n),
  testLog: process.env.SHADOWMAIL_TEST_OVERLAY_LOG || null,
  log,
})

function rendererIndex() {
  return path.join(app.getAppPath(), 'out', 'renderer', 'index.html')
}
// the composer window's page: the same app with its own policy (app/renderer/compose.html)
function rendererCompose() {
  return path.join(app.getAppPath(), 'out', 'renderer', 'compose.html')
}

function isTrustedSender(event) {
  const url = event.senderFrame && event.senderFrame.url
  if (typeof url !== 'string') return false
  const page = url.split('#')[0]
  return page === pathToFileURL(rendererIndex()).href || page === pathToFileURL(rendererCompose()).href
}

function hardenSession() {
  const ses = session.defaultSession
  // no request leaves the app over http(s) except images the user allowed for the open message
  installNetGuard({
    ses,
    allowedHosts: () => (reader ? reader.allowedImageHosts() : new Set()),
    write: line => {
      try {
        fs.appendFileSync(path.join(paths.logs, 'net-guard.log'), `${line}\n`)
      } catch {
        // logging must never take the app down
      }
    },
  })
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  // Spell checking stays off until the composer needs it. Measured on the first build: even so, Windows
  // refreshes the timestamps of %APPDATA%\Microsoft\Spelling\<lang>\default.* on start (content unchanged).
  ses.setSpellCheckerEnabled(false)
  // ...and that alone does not stop the dictionary download: measured on Linux (Chromium NetLog), the
  // session still fetched en-us-10-2.bdic from gvt1.com at start, outside the net guard's reach. With
  // no spell-check language there is nothing to download.
  ses.setSpellCheckerLanguages([])
}

// Every window of the app (main and composer) gets the same locked-down settings.
// Spell checking stays off in the composer too: switched on, Chromium downloads a dictionary.
function webPreferences() {
  return {
    preload: path.join(app.getAppPath(), 'app', 'preload', 'preload.cjs'),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webSecurity: true,
    spellcheck: false,
  }
}

function lockDown(wc) {
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  wc.on('will-navigate', event => event.preventDefault())
  wc.on('will-attach-webview', event => event.preventDefault())
}

/** The composer's bounds: centered on the main window, on its display (window-size.js composerBounds). */
function composerPlacement() {
  if (!mainWindow || mainWindow.isDestroyed()) return { ...COMPOSER_SIZE }
  try {
    const main = mainWindow.isMinimized() ? mainWindow.getNormalBounds() : mainWindow.getBounds()
    return composerBounds(main, screen.getDisplayMatching(main).workArea)
  } catch (err) {
    log(`composer placement failed: ${errCode(err)}`)
    return { ...COMPOSER_SIZE }
  }
}

/** A composer window for one compose session. */
function createComposerWindow(sessionId) {
  const win = new BrowserWindow({ ...composerPlacement(), show: false, title: t.composeTitle, webPreferences: webPreferences() })
  lockDown(win.webContents)
  guardComposerClose(win, () => quitting)
  // no show on 'ready-to-show'; the page's compose:checked shows it (ipc/compose.js), after
  // its starting body was measured: a suspect one never shows
  win.loadFile(rendererCompose(), { hash: `compose=${sessionId}` })
  return win
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: MAIN_MIN_WIDTH,
    show: false,
    title: t.appTitle,
    webPreferences: webPreferences(),
  })
  const wc = mainWindow.webContents
  // Links of the message frame open as popups (target=_blank): only http(s) goes to the system
  // browser, mailto: opens our own composer, javascript:, file: and the rest do nothing.
  wc.setWindowOpenHandler(({ url }) => {
    let u = null
    try {
      u = new URL(url)
    } catch {
      // not a URL: nothing to open
    }
    if (u && (u.protocol === 'http:' || u.protocol === 'https:')) {
      shell.openExternal(u.href).catch(err => log(`openExternal failed: ${errCode(err)}`))
    } else if (u && u.protocol === 'mailto:') {
      if (openMailto) openMailto(url)
      else log('mailto link not opened: the composer is not ready')
    } else {
      log(`link not opened: ${u ? u.protocol : 'invalid url'}`)
    }
    return { action: 'deny' }
  })
  wc.on('will-navigate', event => event.preventDefault())
  // the message frame may only ever show our own mail-view: document (no meta refresh, no link inside it)
  wc.on('will-frame-navigate', event => {
    if (!event.isMainFrame && !String(event.url).startsWith(`${VIEW_SCHEME}://view/`)) event.preventDefault()
  })
  wc.on('will-attach-webview', event => event.preventDefault())
  // the reader's Up / Down / Delete / End typed in the message frame (no script there): to the page as an event
  wc.on('before-input-event', (event, input) => {
    const key = frameReaderKey(input, wc.focusedFrame ? wc.focusedFrame.url : null)
    if (!key) return
    event.preventDefault()
    wc.send('app:status', { kind: 'readerKey', key })
  })
  // the link under the mouse or with the keyboard focus, in any frame (Chromium's own status-bar URL; the message
  // frame runs no script, so this is how its links reach the reader's link-target bar). '' = no link any more.
  wc.on('update-target-url', (event, url) => {
    const full = String(url || '')
    wc.send('app:status', { kind: 'linkTarget', url: full.slice(0, LINK_TARGET_MAX), cut: full.length > LINK_TARGET_MAX })
  })
  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  if (smoke) wc.once('did-finish-load', () => runSmoke().catch(err => finishSmoke({ error: String(err) })))
  mainWindow.loadFile(rendererIndex())
}

async function runSmoke() {
  const wc = mainWindow.webContents
  let text = ''
  // the lock screen shows only the version (the data folder and SQLite moved to Settings / About)
  for (let i = 0; i < 100 && !text.includes(t.helloVersion); i++) {
    await new Promise(resolve => setTimeout(resolve, 100))
    text = await wc.executeJavaScript('document.body.innerText')
  }
  // The window is shown on 'ready-to-show' (first paint); capturing before that fails.
  for (let i = 0; i < 100 && !mainWindow.isVisible(); i++) await new Promise(resolve => setTimeout(resolve, 100))
  await new Promise(resolve => setTimeout(resolve, 300))
  let captureError = null
  try {
    const image = await wc.capturePage()
    fs.writeFileSync(path.join(paths.logs, 'smoke.png'), image.toPNG())
  } catch (err) {
    captureError = String(err) // e.g. no GPU in a headless Linux run; the text check still counts
  }
  finishSmoke({ shown: text, visible: mainWindow.isVisible(), captureError })
}

function finishSmoke(result) {
  fs.writeFileSync(
    path.join(paths.logs, 'smoke.json'),
    JSON.stringify({ dataDir, sqliteVersion: db ? sqliteVersion(db) : null, ...result }, null, 2),
  )
  app.quit()
}

/**
 * MCP: the connector side of `ShadowMail.exe --mcp` (measured). It never takes the single-instance
 * lock (a running app keeps it), opens no window and no vault; it forwards between stdio and the app's pipe;
 * stdin closed = exit. Refused data folders exit 3, as the app does, without a dialog (stderr only: stdout
 * is the protocol's).
 */
function runMcpConnector() {
  const state = dataFolderState(dataDir)
  if (state === 'legacy_plain' || state === 'no_vault') {
    process.stderr.write(`data folder refused: ${state}\n`)
    app.exit(3)
    return
  }
  if (!setupDataPaths({ quiet: true })) {
    app.exit(2)
    return
  }
  log(`mcp connector start packaged=${app.isPackaged}`)
  // measured (Windows, electron.exe as a GUI process): process.stdin is a stub there that ends at once
  // although the parent's pipe is open; fd 0 read directly gets every line, fd 1 written directly arrives
  // its two texts go to Claude, not to the user: they stay Hungarian, as every MCP text does
  runConnector({ dataDir, input: fs.createReadStream(null, { fd: 0 }), write: text => fs.writeSync(1, text), onEnd: () => app.exit(0), text: hu.mcpUnavailable, tooManyText: hu.mcpTooMany, log })
}

function main() {
  if (mcpConnector) {
    runMcpConnector()
    return
  }
  // the interface language (data\ui.json, Hungarian when missing or damaged) before anything is shown, the early
  // error dialogs below included; read only, nothing is created in the folder
  setLanguage(readLanguage(dataDir))
  // an unencrypted folder of an earlier development build, or an encrypted database
  // without its vault.json, is refused BEFORE anything is created in it (the Electron folders, the lock).
  // Read only; showErrorBox may be called before 'ready'.
  const state = dataFolderState(dataDir)
  if (state === 'legacy_plain' || state === 'no_vault') {
    if (smoke) process.stderr.write(`data folder refused: ${state}\n`)
    else dialog.showErrorBox(t.errorTitle, state === 'legacy_plain' ? t.legacyDataFolder : t.vaultFileMissing)
    app.exit(3)
    return
  }
  if (!setupDataPaths()) {
    app.exit(2)
    return
  }
  // The lock lives in userData, so it is per data folder: two copies in different folders may run.
  if (!app.requestSingleInstanceLock()) {
    log('second instance: lock held by another process, exiting')
    app.exit(0)
    return
  }
  log(`start dataDir=${dataDir} packaged=${app.isPackaged} electron=${process.versions.electron}`)
  // MCP: an endpoint.json left by a crash points at no pipe; only after the lock (never under a running copy)
  try {
    fs.rmSync(endpointFile(dataDir), { force: true })
  } catch (err) {
    log(`mcp endpoint cleanup failed: ${errCode(err)}`) // the app starts anyway
  }
  // a reset cut off midway is finished or undone (core/vault/reset.js): only after the single-instance
  // lock, never under a running copy, and logged. The vault settles again before every
  // operation and refuses to work while one cannot be decided.
  // a newer version's data folder is not touched (its reset may work differently)
  const vaultFile = path.join(dataDir, 'vault.json')
  if (fs.existsSync(vaultFile)) {
    if (new VaultFile(vaultFile).versionProblem() === 'vault_newer_version') log('data folder: made by a newer version, left untouched')
    else recoverInterruptedReset(dataDir, log)
  }
  // opened attachments of the previous run; only after the lock, never under a running copy.
  // also %TEMP%\ShadowMail, the fallback when data\tmp cannot carry the Mark-of-the-Web (not NTFS)
  emptyTmpDir(paths.temp, log)
  emptyTmpDir(fallbackTmpDir(dataDir), log)
  app.on('second-instance', () => {
    log('second-instance event: focusing the existing window')
    if (!mainWindow || mainWindow.isDestroyed()) return
    showMainWindow(mainWindow) // the common helper
  })
  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', () => {
    quitting = true
  })
  app.on('will-quit', event => {
    // a recovery code still on the clipboard goes first; the clipboard is asynchronous, so the quit
    // waits for it (at most 1 s) and then starts again
    if (codeClipboard && codeClipboard.isHolding()) {
      event.preventDefault()
      settleWithin(codeClipboard.clearNow(), 1000).then(() => app.quit())
      return
    }
    log('quit')
    closeSession({ now: true }) // the sync stops, the database closes at once
    if (vault) vault.lock() // wipe the key before exit
    emptyTmpDir(paths.temp, log)
    emptyTmpDir(fallbackTmpDir(dataDir), log)
  })

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null)
    hardenSession()
    // nothing of the data folder is opened before the unlock (openSession)
    log(`data folder: ${dataFolderState(dataDir)}`)
    // the language for the preload, synchronously, before the page's modules run (window.shadowMail.language)
    ipcMain.on('app:language', event => {
      event.returnValue = lang
    })
    // a new interface language: stored in data\ui.json and used by this process from now on; the asking window reloads
    // in it. Before that the open composers save their drafts (the lock's path) and close; one whose save
    // failed stays open with its error, so nothing typed is lost. -> { ok, language, unsaved } or { ok: false, error }
    ipcMain.handle('app:setLanguage', async (event, language) => {
      if (!isTrustedSender(event)) throw new Error('untrusted sender')
      try {
        setLanguage(writeLanguage(dataDir, language))
        log(`ui language: ${lang}`)
      } catch (err) {
        return { ok: false, error: err && err.message === 'bad_language' ? 'bad_request' : 'write_failed' }
      }
      const unsaved = saveAllForLock ? (await saveAllForLock({ keepFailed: true }).catch(() => ({ failed: 1 }))).failed : 0
      if (unsaved) log(`ui language: ${unsaved} composer(s) not saved, left open`)
      // the asking window reloads in the new language, by the main process (the page's own location.reload() did not)
      const wc = event.sender
      setImmediate(() => {
        if (!wc.isDestroyed()) wc.reload()
      })
      return { ok: true, language: lang, unsaved }
    })
    // the view settings to disk now (prefs.js asks after a change, coalesced): a forced stop loses none of them
    registerPrefsIpc({ ipcMain, isTrustedSender, log })
    ipcMain.handle('app:hello', event => {
      if (!isTrustedSender(event)) throw new Error('untrusted sender')
      // locked: no database is open, so no SQLite version (it comes from the database connection)
      return { dataDir, sqliteVersion: db ? sqliteVersion(db) : null, appVersion: app.getVersion() }
    })
    vault = new Vault(vaultPath(dataDir))
    routed = createRoutedIpc(ipcMain)
    routed.reserve([...ACCOUNT_CHANNELS, ...MAIL_CHANNELS, ...ACTION_CHANNELS, ...LABEL_CHANNELS, ...FOLDER_CHANNELS, ...COMPOSE_CHANNELS, ...SEARCH_CHANNELS, ...READER_CHANNELS, ...MCP_CHANNELS, ...CONTACTS_CHANNELS, ...TASKBAR_CHANNELS, ...SCHEDULED_CHANNELS])
    // the message frame's schemes live as long as the app; they ask the reader of the open session
    handleMailProtocols({
      protocol,
      reader: { view: token => (reader ? reader.view(token) : null), cidImage: (id, cid) => (reader ? reader.cidImage(id, cid) : null) },
      signature: (kind, ref) => (signatureSource ? signatureSource(kind, ref) : null),
      pasted: (sid, id) => (pastedSource ? pastedSource(sid, id) : null),
      log,
    })
    vault.onLock(() => closeSession())
    // the recovery code leaves the clipboard after 60 s, on lock and on quit (only if it is still there)
    // on Windows the code also stays out of the clipboard history (Win+V) and the cloud clipboard
    codeClipboard = createClipboardGuard({ clipboard, log, ...(process.platform === 'win32' ? { write: windowsWrite(ClipboardItem) } : {}) })
    vault.onLock(() => void codeClipboard.clearNow())
    registerVaultIpc({
      ipcMain,
      vault,
      isTrustedSender,
      log,
      onUnlocked: openSession,
      // the composers save first; then a scheduled send under way may finish (at most 10 s): its row is recorded
      // while the database is open. One that runs longer stays 'sending' and is settled as interrupted at the next
      // unlock (it may have gone out, it is never sent again on its own)
      beforeLock: async () => {
        const failed = await saveBeforeLock({ saveAll: saveAllForLock, log })
        if (scheduler) await settleWithin(scheduler.stop(), SCHEDULED_LOCK_WAIT_MS)
        return failed
      },
      saveCodeFile: saveRecoveryCodeFile,
      copyCode: code => codeClipboard.copy(code),
    })
    createWindow()
  })
}

let routed = null
let codeClipboard = null

/** "Mentés fájlba" on the code screen: the user picks the place; the text explains what the code is. */
async function saveRecoveryCodeFile(code, event) {
  const win = (event && BrowserWindow.fromWebContents(event.sender)) || mainWindow
  const res = await dialog.showSaveDialog(win, noRecent({ defaultPath: t.recoveryFileName, filters: [{ name: t.fileFilterText, extensions: ['txt'] }] }))
  if (res.canceled || !res.filePath) return { saved: false }
  fs.writeFileSync(res.filePath, t.recoveryFileText(code), 'utf8')
  return { saved: true }
}

let opening = null // the openSession in progress (a second unlock call waits for the same one)

/** To the lock screen (only kind + phase, no content): the schema upgrade started / ended. */
function lockScreenStatus(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app:status', payload)
}

/**
 * After vault:create / vault:unlock: the encrypted database opens (and migrates) with the vault's key,
 * then the services are built and their IPC handlers go live. A database that does not open locks the
 * vault again: the error goes to the lock screen.
 * A pending schema upgrade (backup + migrations) runs first in a worker thread (core/db/upgrade.js), with
 * a notice on the lock screen; the main process keeps answering meanwhile.
 */
function openSession(opts = {}) {
  if (unlocked) return
  if (!opening) opening = openSessionNow(opts).finally(() => (opening = null))
  return opening
}

async function openSessionNow({ created = false } = {}) {
  const ipc = routed
  try {
    if (!created) {
      const key = vault.databaseKey()
      let started = 0
      try {
        const done = await upgradeDatabase({
          file: databasePath(dataDir),
          key,
          onStart: p => {
            started = performance.now()
            log(`database upgrade ${p.from} -> ${p.to}: backup and migration in a worker`)
            lockScreenStatus({ kind: 'dbUpgrade', phase: 'start' })
          },
        })
        if (done) log(`database upgrade done in ${Math.round(performance.now() - started)} ms${done.backup ? ` (backup ${done.backup})` : ''}`)
      } finally {
        key.fill(0)
        if (started) lockScreenStatus({ kind: 'dbUpgrade', phase: 'end' })
      }
      if (!vault.isUnlocked()) throw Object.assign(new Error('locked during the upgrade'), { code: 'locked' })
    }
    const opened = openUnlockedDatabase(vault, dataDir, { create: created })
    db = opened.db
    log(`database schema ${opened.migration.from} -> ${opened.migration.to}${opened.migration.backup ? ` (backup ${opened.migration.backup})` : ''}`)
  } catch (err) {
    log(`database open failed: ${errCode(err)}`)
    vault.lock()
    // SQLITE_FULL: the volume filled up during the copy although the check passed (another program wrote meanwhile)
    const code = err && err.code === 'SQLITE_FULL' ? 'db_no_space' : err && ['db_key', 'db_missing', 'db_no_space', 'locked'].includes(err.code) ? err.code : 'db_open_failed'
    throw Object.assign(new VaultError(code), err && err.code === 'db_no_space' && err.info ? { info: err.info } : {})
  }
  unlocked = { db }
  buildServices(ipc)
  mcpService.start().catch(err => log(`mcp start failed: ${errCode(err)}`))
  // in the background: leftovers of an interrupted write, plain files of an earlier build
  const store = sealedStore
  store.sweep().then(r => (r.removed || r.sealed) && log(`store sweep: ${r.removed} temporary removed, ${r.sealed} sealed`), () => {})
  syncManager.startAll()
  // the one-time re-index of the local-source rows (visible text), in the background, through the same worker
  if (searchWork) searchWork.reindex.run().catch(err => log(`search re-index failed: ${errCode(err)}`))
}

/**
 * Lock (and quit): no handler of the session is reachable any more, the reader forgets the open message,
 * the sync stops, and the database closes once the sync has stopped (now: at once, when quitting).
 */
function closeSession({ now = false } = {}) {
  if (!unlocked) return
  const closing = { db, syncManager }
  unlocked = null
  // the search-text worker stops first: what waits is dropped, nothing is written after this; a lost
  // local-source message clears its account's re-index flag (the database is still open here)
  if (searchWork) {
    searchWork.reindex.stop()
    searchWork.refiner.stop()
    searchWork = null
  }
  // the store key goes at once: a late write of the stopping sync fails 'locked', and a
  // POP3 message not written is not marked seen, so it comes again
  if (sealedStore) sealedStore.close()
  sealedStore = null
  // the attachments opened with "Megnyitás" do not wait for the quit
  emptyTmpDir(paths.temp, log)
  emptyTmpDir(fallbackTmpDir(dataDir), log)
  // the waiting confirmations are rejected (M3B), the pipe closes, endpoint.json goes, the key is wiped
  if (mcpService) mcpService.stop(now ? 'quit' : 'locked')
  mcpService = null
  // no scheduled send starts after the lock (one under way finishes; its row is settled at the next unlock)
  if (scheduler) scheduler.stop()
  scheduler = null
  // the badge goes and its triggers are dropped while the database is still open
  if (taskbar) taskbar.stop()
  taskbar = null
  if (routed) routed.clear()
  if (reader) reader.clear()
  reader = null
  signatureSource = null
  pastedSource = null
  openMailto = null
  saveAllForLock = null
  syncManager = null
  db = null
  const close = () => {
    try {
      closing.db.close()
    } catch (err) {
      log(`database close failed: ${errCode(err)}`)
    }
  }
  if (now) {
    closing.syncManager.stopAll().catch(() => {})
    close()
    return
  }
  closing.syncManager
    .stopAll()
    .catch(err => log(`sync stop failed: ${errCode(err)}`))
    .finally(close)
}

// The services of one unlocked session; ipcMain is the routed stand-in (routed-ipc.js).
function buildServices(ipcMain) {
  const store = new AccountStore(db, vault, { storeDir: path.join(dataDir, 'store') })
  const index = new MailIndex(db)
  // every .eml under data\store is sealed with a key derived from the DEK; the session drops it on lock
  const sealed = openSealedStore(vault, dataDir)
  sealedStore = sealed
  // only while THIS session is open: after a lock a late timer of the old sync must not send folder
  // names to the lock screen
  const mine = unlocked
  const notify = payload => {
    if (unlocked !== mine) return
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app:status', payload)
  }
  // the closures below keep THIS session's sync manager: after a lock the module variable is null
  // the search text (visible text) on one worker thread; the refiner writes it, the
  // re-index makes it for the rows stored before
  const searchService = new SearchTextService({ log })
  const searchSettings = openSettings(db)
  const refiner = createSearchRefiner({ service: searchService, index, settings: searchSettings, sealed, log })
  searchWork = { service: searchService, refiner, reindex: createFtsReindex({ index, store, sealed, settings: searchSettings, service: searchService, log, onComplex: item => refiner.retryLater(item) }) }
  // the labels (0.17.0): an IMAP account's on its server (keywords), POP3's in the database; the sync uploads the old local
  // ones of an IMAP account after its first full run
  const labels = new Labels(db)
  const sm = new SyncManager({ store, index, notify, log, sealed, searchText: refiner, labels })
  syncManager = sm
  reader = new MessageReader({
    searchText: refiner,
    index,
    sealed,
    withConnection: (accountId, fn) => sm.withConnection(accountId, fn),
    onChange: change => sm.notifyChange(change),
    log,
  })
  // the user's own steps unlock MCP test_account; the tools are built further down
  let mcpTools = null
  const mcpTestUnlock = id => mcpTools && mcpTools.unlockTestAccount(id)
  // the editor's save and delete (the IPC and, M3B, Claude's approved update_account / delete_account)
  const onAccountSaved = id => (mcpTestUnlock(id), sm.accountSaved(id))
  const onAccountDeleted = id => sm.accountRemoved(id)
  registerAccountIpc({
    ipcMain,
    store,
    index,
    isTrustedSender,
    notify,
    log,
    onSaved: onAccountSaved,
    onDeleted: onAccountDeleted,
    onTested: (id, r) => r.incoming.ok && r.smtp.ok && mcpTestUnlock(id),
    dialog,
    getWindow: () => mainWindow,
    // the signature image: decodable at all, and of which size (a check only); a turned photo turned upright
    decodeImage: codec.decode,
    uprightImage: codec.upright,
  })
  registerLabelIpc({
    ipcMain,
    labels,
    withConnection: (accountId, fn) => sm.withConnection(accountId, fn),
    requestSync: (accountId, folders) => sm.requestSync(accountId, folders),
    onChange: change => sm.notifyChange(change),
    notify,
    isTrustedSender,
    log,
  })
  registerMailIpc({ ipcMain, store, index, manager: sm, labels, isTrustedSender, log, onUserSync: id => (id === null ? store.list().forEach(a => mcpTestUnlock(a.id)) : mcpTestUnlock(id)) })
  const actions = new MailActions({
    index,
    store,
    storeDir: path.join(dataDir, 'store'),
    withConnection: (accountId, fn) => sm.withConnection(accountId, fn),
    onChange: change => sm.notifyChange(change),
    requestSync: (accountId, folders) => sm.requestSync(accountId, folders),
    log,
  })
  registerActionIpc({ ipcMain, actions, index, isTrustedSender, log })
  const folderActions = new FolderActions({
    index,
    store,
    storeDir: path.join(dataDir, 'store'),
    withConnection: (accountId, fn) => sm.withConnection(accountId, fn),
    onChange: change => sm.notifyChange(change),
    requestSync: (accountId, folders) => sm.requestSync(accountId, folders),
    log,
  })
  registerFolderIpc({ ipcMain, folders: folderActions, isTrustedSender, log })
  // C1: the address book; the send adds new recipients as automatic people (Contacts.recordSent)
  const people = new People(db)
  const contacts = new Contacts(db, { people })
  registerContactsIpc({ ipcMain, people, index, isTrustedSender, dialog, getWindow: () => mainWindow, log })
  const scheduledRows = new Scheduled(db)
  const composer = new Composer({
    scheduled: scheduledRows,
    labels, // an IMAP draft saved again keeps its labels (the old copy's keywords)
    index,
    store,
    contacts,
    reader,
    storeDir: path.join(dataDir, 'store'),
    sealed,
    dataDir,
    withConnection: (accountId, fn) => sm.withConnection(accountId, fn),
    requestSync: (accountId, folders) => sm.requestSync(accountId, folders),
    onChange: change => sm.notifyChange(change),
    log,
    searchText: refiner,
    // a pasted image: decodable at all, and of which size (a check only); a turned photo turned upright
    decodeImage: codec.decode,
    uprightImage: codec.upright,
    // a composer opened from the "Időzített" list saved, sent or discarded it: the list reloads
    onScheduledChange: () => {
      notify({ kind: 'scheduledList' })
      // a composer let a held row go (closed) or changed it: the scheduler looks again
      if (scheduler) scheduler.poke()
    },
  })
  signatureSource = (kind, ref) => composer.signatureImageOf(kind, ref)
  pastedSource = (sid, id) => composer.inlineImageOf(sid, id)
  const composeIpc = registerComposeIpc({
    ipcMain,
    composer,
    store,
    contacts,
    openWindow: createComposerWindow,
    dialog,
    windowOf: event => BrowserWindow.fromWebContents(event.sender),
    isTrustedSender,
    log,
    // both notices come from the main process into the MAIN window (a stuck composer page could
    // not show anything). The test switch may only make T shorter.
    readyTimeoutMs: readyTimeoutFrom(process.env.SHADOWMAIL_TEST_COMPOSE_TIMEOUT_MS),
    omittedText: t.composeBodyOmitted,
    // a new scheduled message: the scheduler looks again (its next wake-up may be sooner)
    onScheduled: (id, { subject, sendAt } = {}) => {
      notify({ kind: 'scheduled', event: 'scheduled', id, subject, sendAt })
      notify({ kind: 'scheduledList' })
      if (scheduler) scheduler.poke()
    },
    askSuspect: async (win, { mode, limit, reason }) => {
      // without the quote: a reply or a forward only (a draft's body is not rewritten; a mailto link has no quote)
      const omit = ['reply', 'replyAll', 'forward'].includes(mode)
      const buttons = omit ? [t.composeSuspectOmit, t.composeSuspectCancel] : [t.composeSuspectCancel]
      const message = reason === 'switches' ? t.composeSuspectSlowText(mode) : t.composeSuspectText(mode, limit)
      const opts = { type: 'warning', title: t.composeSuspectTitle, message, buttons, defaultId: buttons.length - 1, cancelId: buttons.length - 1, noLink: true }
      const parent = win && !win.isDestroyed() ? win : mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
      const { response } = parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts)
      return omit && response === 0 ? 'omit' : 'cancel'
    },
    onStalled: ({ kind, seconds }) => {
      const opts = { type: 'warning', title: t.composeSuspectTitle, message: t.composeStalled(kind, seconds), buttons: [t.close], noLink: true }
      const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
      if (parent) showMainWindow(parent)
      ;(parent ? dialog.showMessageBox(parent, opts) : dialog.showMessageBox(opts)).catch(err => log(`stalled notice failed: ${errCode(err)}`))
    },
  })
  openMailto = composeIpc.openMailto
  saveAllForLock = composeIpc.saveAllForLock
  registerSearchIpc({
    ipcMain, db, index, store, manager: sm, sealed, notify, labels, isTrustedSender, log,
    // the POP3 old-text search reads the visible text from the worker (null when dropped: counted as skipped)
    messageTextOf: async bytes => {
      if (!(await searchService.admit(bytes.length))) return null
      const r = await searchService.compute(bytes, { kind: 'message' })
      return r && !r.failed ? r.text : null // null: counted as skipped
    },
  })
  // MCP: the switch in the encrypted settings, the pipe opens after the unlock (openSession)
  // the read tools on the session's own modules (reader.source: no \\Seen)
  // the UI's own action paths for the reversible write tools (no confirmation)
  // the user's confirmation of Claude's dangerous requests. A new request brings the main
  // window forward (and flashes it on the taskbar); the Modal gets the request's view, never its payload
  const flash = on => mainWindow && !mainWindow.isDestroyed() && mainWindow.flashFrame(on)
  const confirm = new ConfirmationQueue({
    log,
    onRequest: view => {
      if (mainWindow && !mainWindow.isDestroyed()) showMainWindow(mainWindow) // the common helper, as before
      flash(true)
      notify({ kind: 'confirm', request: view })
    },
    onSettled: view => {
      notify({ kind: 'confirmSettled', id: view.id, status: view.status })
      if (mcpService) mcpService.recordConfirmation(view) // the "Legutóbbi Claude-hívások" list
      if (!confirm.pending().length) flash(false)
    },
  })
  // open_message's acknowledgements from the main window (seq -> resolve); show_search uses the same way
  let openSeq = 0
  const openAcks = new Map()
  // brings the main window forward (a composer in focus keeps it: the main window only flashes) and hands it a Claude
  // event; the window answers 'opened', or 'offered' when an editor with input was open there; no answer
  // in 3 s: 'unknown'
  const showInMainWindow = async event => {
    const how = showMainWindow(mainWindow, { focused: BrowserWindow.getFocusedWindow(), keepFocus: w => [...composeIpc.windows.values()].includes(w) })
    const seq = ++openSeq
    const view = await new Promise(resolve => {
      const timer = setTimeout(() => {
        openAcks.delete(seq)
        resolve('unknown')
      }, 3000)
      openAcks.set(seq, result => {
        clearTimeout(timer)
        resolve(result)
      })
      notify({ ...event, seq })
    })
    return { window: how, view }
  }
  // the user's switches: which of the confirmed actions still ask (Settings / Claude access / Confirmations)
  const confirmPolicy = createConfirmPolicy({ settings: openSettings(db), people, log })
  mcpTools = createMcpTools({
    appVersion: app.getVersion(),
    // the labels: Claude's label_messages goes the UI's own way (applyLabels, on the server through manager), the list
    // follows the change event
    labels,
    onMailChange: change => sm.notifyChange(change),
    onLabels: notify, // { kind: 'labels' }: the label counts (Settings / Labels, the list) load again
    people, // search_contacts
    confirm,
    policy: confirmPolicy,
    // an action run without the Modal: in the "Legutóbbi Claude-hívások" list as such
    onAutoRun: run => mcpService && mcpService.recordAuto(run),
    log,
    // the editor's own save and delete; the page's account list and folder tree reload ('accounts'). Claude's save
    // restarts the sync but is NOT the user's step: it lifts neither the test_account lock nor the one-restart limit
    saveAccount: form => {
      const account = saveAccount(form, { store, index, notify, log, onSaved: id => sm.accountSaved(id) })
      notify({ kind: 'accounts', accountId: account.id })
      return account
    },
    deleteAccount: async id => {
      await deleteAccount(id, { store, log, onDeleted: onAccountDeleted })
      notify({ kind: 'accounts', accountId: id })
    },
    store,
    index,
    reader,
    manager: sm,
    actions,
    folders: folderActions,
    // the account as the editor gets it (accounts:list: index_years, no secrets), unchanged: the saved settings
    // the editor's form of the saved account (booleans), exactly what the UI's Kapcsolat próbája sends
    testAccount: id => testAccountConnection(accountEditorForm(store.list().find(a => a.id === id)), { store, log }),
    composer,
    // the app says it ("Claude piszkozatot készített: <tárgy>" + Megnyitás)
    onClaudeDraft: ({ accountId, subject, messageId }) => notify({ kind: 'claudeDraft', accountId, subject, messageId }),
    // the main window comes forward with the "Új fiók" editor filled in; saving is the user's click
    showAccountEditor: values => {
      showMainWindow(mainWindow) // the common helper (no window: not_available, as before)
      notify({ kind: 'prefillAccount', values })
    },
    // the message opens in the main window as a click would (it becomes read); a composer in
    // focus keeps it (the main window only flashes) and the view changes behind it
    // the main window acknowledges: 'opened', or 'offered' when an editor with input was open
    // there (it offers the message in a banner instead of leaving the editor); no answer in 3 s: 'unknown'
    openMessage: row => showInMainWindow({ kind: 'claudeOpen', messageId: row.id, accountId: row.account_id, folder: row.folder }),
    // the conditions go into the search box and the chips of the main window (as typed by the user)
    showSearch: conditions => showInMainWindow({ kind: 'claudeSearch', conditions }),
    // "Küldés később": Claude's approved schedule or cancel; the main window says so, the list reloads, the scheduler looks
    scheduled: scheduledRows,
    onScheduled: (id, { subject, sendAt, cancelled } = {}) => {
      if (id) notify({ kind: 'scheduled', event: 'scheduled', id, subject, sendAt })
      if (cancelled) notify({ kind: 'scheduled', event: 'claudeCancelled', id: cancelled, subject })
      notify({ kind: 'scheduledList' })
      if (scheduler) scheduler.poke()
    },
  })
  mcpService = createMcpService({ dataDir, settings: openSettings(db), appVersion: app.getVersion(), accountCount: () => store.list().length, tools: mcpTools, log, confirm })
  registerMcpIpc({
    ipcMain,
    mcp: mcpService,
    isTrustedSender,
    log,
    confirm,
    isConfirmSender: event => Boolean(mainWindow) && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents,
    policy: confirmPolicy,
    onOpenAck: (seq, result) => {
      const done = openAcks.get(seq)
      if (!done) return
      openAcks.delete(seq)
      done(result)
    },
    // the program's CURRENT path; unpackaged (development, tests) the Electron binary + the app folder
    connectInfo: () => ({
      exe: process.execPath,
      args: app.isPackaged ? ['--mcp'] : [app.getAppPath(), '--mcp'],
      env: process.env.SHADOWMAIL_DATA ? { SHADOWMAIL_DATA: dataDir } : null,
      platform: process.platform,
    }),
    copyText: text => clipboard.writeText(text),
  })
  registerReaderIpc({ ipcMain, reader, tmpDir: paths.temp, fallbackDir: fallbackTmpDir(dataDir), dialog, shell, getWindow: () => mainWindow, labels, isTrustedSender, log })
  // the unread badge: counts now, then after every write of this connection (TEMP triggers)
  taskbar = startTaskbarBadge({ db, settings: openSettings(db), apply: applyOverlay, log })
  registerTaskbarIpc({ ipcMain, taskbar, isTrustedSender, log })
  // "Küldés később": only while unlocked; its notices go to the main window (sent, late, failed)
  // the scheduler's own events (sent, retry, failed...) reload the list too
  scheduler = createScheduler({ scheduled: scheduledRows, composer, log, notify: e => (notify(e), notify({ kind: 'scheduledList' })) })
  scheduler.start()
  // the "Időzített" list: the main window only; a change reloads the list and wakes the scheduler ("Küldés most")
  registerScheduledIpc({
    ipcMain,
    scheduled: scheduledRows,
    composer,
    store,
    isMainSender: event => Boolean(mainWindow) && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents,
    log,
    onChanged: () => {
      notify({ kind: 'scheduledList' })
      if (scheduler) scheduler.poke()
    },
  })
}

main()
