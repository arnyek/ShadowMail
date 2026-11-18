// SPDX-License-Identifier: GPL-3.0-or-later
// Narrow IPC bridge. Sandboxed preloads must be CommonJS and may only require 'electron'.
// Nothing here returns a key or a password: vault calls answer { ok, status: { exists, unlocked } },
// account calls answer accounts without passwords (only has_*_password flags), or { ok: false, error }.
const { contextBridge, ipcRenderer, webUtils } = require('electron')

// the interface language ('hu' | 'en'), asked once, synchronously, before the page's modules run (the i18n module
// reads it at load); anything else than 'en' is Hungarian there
const language = ipcRenderer.sendSync('app:language')

contextBridge.exposeInMainWorld('shadowMail', {
  language: language === 'en' ? 'en' : 'hu',
  // a new interface language, stored in the data folder -> { ok, language }; the window applies it on reload
  setLanguage: language => ipcRenderer.invoke('app:setLanguage', language),
  // -> { dataDir, sqliteVersion, appVersion }
  hello: () => ipcRenderer.invoke('app:hello'),
  // the view settings (localStorage) to disk now; no argument (prefs.js calls it after a change, coalesced)
  flushPrefs: () => ipcRenderer.invoke('app:flushPrefs'),
  vault: {
    status: () => ipcRenderer.invoke('vault:status'),
    create: password => ipcRenderer.invoke('vault:create', password),
    unlock: password => ipcRenderer.invoke('vault:unlock', password),
    lock: () => ipcRenderer.invoke('vault:lock'),
    // after an unlock -> { failedDrafts } the last lock could not save
    lockNotice: () => ipcRenderer.invoke('vault:lockNotice'),
    change: (oldPassword, newPassword) => ipcRenderer.invoke('vault:change', oldPassword, newPassword),
    // forgotten master password without the code: a full reset; only locked, with the word TÖRLÉS
    reset: (confirmWord, newPassword) => ipcRenderer.invoke('vault:reset', confirmWord, newPassword),
    // with the recovery code -> { recoveryCode } (the new one); only locked
    recover: (code, newPassword) => ipcRenderer.invoke('vault:recover', code, newPassword),
    // Settings, a new recovery code (the master password) -> { recoveryCode }
    newRecoveryCode: password => ipcRenderer.invoke('vault:newRecoveryCode', password),
    // the code screen's check: group n (1..5) typed back; the main process checks it
    confirmRecovery: (n, typed) => ipcRenderer.invoke('vault:confirmRecovery', n, typed),
    // "Mentés fájlba" (the main process asks where) -> { saved }
    saveRecoveryCode: code => ipcRenderer.invoke('vault:saveRecoveryCode', code),
    // the main process copies the code and clears it after 60 s
    copyRecoveryCode: code => ipcRenderer.invoke('vault:copyRecoveryCode', code),
    finishReset: (confirmWord, newPassword) => ipcRenderer.invoke('vault:finishReset', confirmWord, newPassword),
  },
  accounts: {
    list: () => ipcRenderer.invoke('accounts:list'),
    save: form => ipcRenderer.invoke('accounts:save', form),
    remove: id => ipcRenderer.invoke('accounts:delete', id),
    // the new order: every account id once -> { accounts }
    reorder: ids => ipcRenderer.invoke('accounts:reorder', ids),
    test: form => ipcRenderer.invoke('accounts:test', form),
    // the signature image: chosen in the main process's dialog (no path here), removed, and its preview as a data: URL
    signatureImagePick: id => ipcRenderer.invoke('accounts:signatureImagePick', id),
    signatureImageRemove: id => ipcRenderer.invoke('accounts:signatureImageRemove', id),
    signatureImage: id => ipcRenderer.invoke('accounts:signatureImage', id),
  },
  mail: {
    // -> { accounts: [{ id, name, email, type, folders: [{ path, delimiter, special_use, count, unread }] }] }
    folders: () => ipcRenderer.invoke('mail:folders'),
    // { accountId, folder, sort: date|from|subject, dir: asc|desc, offset, limit, filter? } -> { total, folderTotal, rows }
    // filter (0.10.1): { unread?, flagged?, hasAttachment?, since?, before? (epoch ms), keepIds? (<= 500 ids kept in view) }
    list: query => ipcRenderer.invoke('mail:list', query),
    status: () => ipcRenderer.invoke('mail:status'),
    sync: accountId => ipcRenderer.invoke('mail:sync', accountId),
    // reader. open -> { message: { id, subject, from, to, cc, date, html | text, hasExternalImages, attachments, seenError } }
    open: id => ipcRenderer.invoke('mail:open', id),
    thread: id => ipcRenderer.invoke('mail:thread', id),
    allowImages: id => ipcRenderer.invoke('mail:allowImages', id),
    // sanitized body -> { url } of the sandboxed frame's document (mail-view:)
    render: (id, html) => ipcRenderer.invoke('mail:render', id, html),
    saveAttachment: (id, index) => ipcRenderer.invoke('mail:saveAttachment', id, index),
    // the raw message for the "Fejlécek / Eredeti" view, and its .eml save
    source: id => ipcRenderer.invoke('mail:source', id),
    saveSource: id => ipcRenderer.invoke('mail:saveSource', id),
    openAttachment: (id, index) => ipcRenderer.invoke('mail:openAttachment', id, index),
    // message actions. { ids, action: read|unread|star|unstar|move|delete|archive, target?, permanent? } -> { done, final, created? }
    action: request => ipcRenderer.invoke('mail:action', request),
    // { accountId, folder, sort, dir, seen?, filter? } -> { ids } (Ctrl+A; with filter: the filtered list's ids)
    ids: query => ipcRenderer.invoke('mail:ids', query),
  },
  // the address book. list({ q, offset, limit <= 200 }) -> { items: [{ id, name, address, source }], total };
  // get(id) -> { person }; save(person) -> { id } (address_taken + personId); delete(ids) -> { removed };
  // addFromMessage(messageId) -> { id, created } (the sender, by hand); count() -> { count }
  contacts: {
    list: query => ipcRenderer.invoke('contacts:list', query),
    get: id => ipcRenderer.invoke('contacts:get', id),
    save: person => ipcRenderer.invoke('contacts:save', person),
    delete: ids => ipcRenderer.invoke('contacts:delete', ids),
    addFromMessage: messageId => ipcRenderer.invoke('contacts:addFromMessage', messageId),
    count: () => ipcRenderer.invoke('contacts:count'),
    // contacts import/export: the file is chosen in the main process's dialog; the page gets counts and a token, never a path
    importPreview: () => ipcRenderer.invoke('contacts:importPreview'),
    importApply: token => ipcRenderer.invoke('contacts:importApply', token),
    export: opts => ipcRenderer.invoke('contacts:export', opts),
    lookup: address => ipcRenderer.invoke('contacts:lookup', address),
  },
  // MCP: Claude access. status -> { enabled, running, connections }; setEnabled(bool) -> the same
  mcp: {
    status: () => ipcRenderer.invoke('mcp:status'),
    setEnabled: on => ipcRenderer.invoke('mcp:setEnabled', on),
    // the user's decision on a request of Claude (only the main window's is accepted); the waiting requests
    confirm: (id, approve) => ipcRenderer.invoke('mcp:confirm', { id, approve }),
    confirmations: () => ipcRenderer.invoke('mcp:confirmations'),
    // the confirmation switches: -> { settings: [{ op, on }] }; set only from the main window
    confirmSettings: () => ipcRenderer.invoke('mcp:confirmSettings'),
    setConfirm: (op, on) => ipcRenderer.invoke('mcp:setConfirm', { op, on }),
    // the "Claude-hozzáférés" page (read only, and a Másolás of one of the two config snippets)
    recent: () => ipcRenderer.invoke('mcp:recent'),
    connectInfo: () => ipcRenderer.invoke('mcp:connectInfo'),
    copy: which => ipcRenderer.invoke('mcp:copy', which),
    // the main window's answer to Claude's open_message (opened / offered)
    openAck: (seq, result) => ipcRenderer.invoke('mcp:openAck', { seq, result }),
  },
  // the unread badge on the taskbar button: status -> { enabled }; setEnabled(bool) -> the same
  taskbar: {
    status: () => ipcRenderer.invoke('taskbar:status'),
    setEnabled: on => ipcRenderer.invoke('taskbar:setEnabled', on),
  },
  // composer. form: { accountId, to, cc, bcc, subject, html, inReplyTo?, references? }
  compose: {
    // request: undefined (new) or { mode: reply | replyAll | forward, messageId }
    open: request => ipcRenderer.invoke('compose:open', request),
    // -> { form: null | { accountId, to, cc, subject, body, quote, inReplyTo, references }, attachments }
    initial: sessionId => ipcRenderer.invoke('compose:initial', sessionId),
    accounts: () => ipcRenderer.invoke('compose:accounts'),
    suggest: term => ipcRenderer.invoke('compose:suggest', term),
    // paths of dropped files (pathFor), or null for the open dialog -> { attachments: [{ id, filename, size }] }
    // files: File objects (drop) or null (the open dialog). The PATHS are worked out here, so the page
    // cannot hand the main process a raw path of its own (e.g. data\\mail.sqlite).
    addFiles: (sessionId, files) =>
      ipcRenderer.invoke('compose:addFiles', sessionId, files === null || files === undefined ? null : Array.from(files, f => webUtils.getPathForFile(f)).filter(Boolean)),
    removeAttachment: (sessionId, id) => ipcRenderer.invoke('compose:removeAttachment', sessionId, id),
    saveDraft: (sessionId, form) => ipcRenderer.invoke('compose:saveDraft', sessionId, form),
    send: (sessionId, form) => ipcRenderer.invoke('compose:send', sessionId, form),
    schedule: (sessionId, form, sendAt) => ipcRenderer.invoke('compose:schedule', sessionId, form, sendAt),
    discard: sessionId => ipcRenderer.invoke('compose:discard', sessionId),
    close: sessionId => ipcRenderer.invoke('compose:close', sessionId),
    // the composer holds its starting body (the main process's watchdog waits for it)
    ready: sessionId => ipcRenderer.invoke('compose:ready', sessionId),
    // the starting body was measured: fine (the window may show) / over the limit (it never shows)
    checked: sessionId => ipcRenderer.invoke('compose:checked', sessionId),
    // reason: 'run' (a run over N) or 'switches' (a block over B direction switches); the main process asks accordingly
    suspect: (sessionId, reason) => ipcRenderer.invoke('compose:suspect', sessionId, reason),
    // the window's close button was pressed: the page asks, then calls close()
    onCloseRequested: callback => {
      const listener = () => callback()
      ipcRenderer.on('compose:closeRequested', listener)
      return () => ipcRenderer.removeListener('compose:closeRequested', listener)
    },
    // a lock is coming; the page saves its draft, then answers lockDone(sessionId, ok)
    onLockRequested: callback => {
      const listener = () => callback()
      ipcRenderer.on('compose:lockRequested', listener)
      return () => ipcRenderer.removeListener('compose:lockRequested', listener)
    },
    lockDone: (sessionId, ok) => ipcRenderer.invoke('compose:lockDone', sessionId, ok),
  },
  // folders. -> { path } or { ok: false, error }; delete needs confirmed: true (else confirm_needed)
  folders: {
    create: request => ipcRenderer.invoke('folder:create', request),
    rename: request => ipcRenderer.invoke('folder:rename', request),
    remove: request => ipcRenderer.invoke('folder:delete', request),
    // the delete warning's count: { accountId, path } -> { count, exact } (exact false: the local count, at least)
    deleteCount: request => ipcRenderer.invoke('folder:deleteCount', request),
    // the manual order of one displayed sibling list: { accountId, parentKey (null = top level), paths } -> { count }
    reorder: request => ipcRenderer.invoke('folders:reorder', request),
    resetOrder: request => ipcRenderer.invoke('folders:resetOrder', request),
    // the role picker: { accountId, role: drafts|sent|trash|junk|archive, path (null = Automatic) } -> { changed }
    setRole: request => ipcRenderer.invoke('folders:setRole', request),
    // subscriptions: { accountId } -> { folders: [{ path, delimiter, shown, subscribed, kept, role }] };
    // setSubscribed: { accountId, path, subscribed } (a role folder cannot be unsubscribed: role_folder)
    subscriptions: request => ipcRenderer.invoke('folders:subscriptions', request),
    setSubscribed: request => ipcRenderer.invoke('folders:setSubscribed', request),
  },
  // the "Időzített" list (main window only). list -> { rows }; reschedule(id, sendAt); sendNow(id); cancel(id) (back
  // to Drafts). A row open in a composer: scheduled_open; one being sent: scheduled_sending. Changes come as
  // { kind: 'scheduledList' } on onStatus.
  scheduled: {
    list: () => ipcRenderer.invoke('scheduled:list'),
    reschedule: (id, sendAt) => ipcRenderer.invoke('scheduled:reschedule', id, sendAt),
    sendNow: id => ipcRenderer.invoke('scheduled:sendNow', id),
    cancel: id => ipcRenderer.invoke('scheduled:cancel', id),
  },
  // search. local -> { rows, truncated, headersOnly, scope: { imap, pop3 } }; server / pop3Old -> { jobId }, then
  // { kind: 'search', jobId, source, progress?, hits?, finished? } on onStatus.
  search: {
    local: query => ipcRenderer.invoke('search:local', query),
    server: query => ipcRenderer.invoke('search:server', query),
    pop3Old: query => ipcRenderer.invoke('search:pop3Old', query),
    cancel: jobId => ipcRenderer.invoke('search:cancel', jobId),
  },
  // Status events from the main process: { kind: 'reindex' | 'sync' | 'mail', ... }. Only the payload is passed on, never the
  // IPC event object. Returns an unsubscribe function.
  onStatus: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('app:status', listener)
    return () => ipcRenderer.removeListener('app:status', listener)
  },
})
