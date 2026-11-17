// SPDX-License-Identifier: GPL-3.0-or-later
// English UI strings (renderer and main process): the same keys as hu.js, with the same types (a function: the same
// parameter count), checked by test/i18n.test.js. American spelling; dates and numbers in the en-GB locale (day/month).

// a number for the text (1,000), and a noun after it in the singular or the plural
const num = n => (typeof n === 'number' ? n.toLocaleString('en-GB') : String(n))
const count = (n, one, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`

export const en = {
  appTitle: 'ShadowMail',
  helloHeading: 'ShadowMail is working',
  helloDataDir: 'Data folder',
  helloSqlite: 'SQLite version',
  helloVersion: 'Program version',
  loading: 'Loading…',
  errorTitle: 'ShadowMail: error',
  dataDirNotWritable: (dir, reason) =>
    `The data folder cannot be written, so the program closes:\n${dir}\n\nReason: ${reason}\n\n` +
    'Copy the program to a writable place (for example your Documents folder or a USB drive) and start it from there.',
  // data folders this build does not open; it touches nothing in them
  legacyDataFolder:
    'This data folder comes from an earlier, unencrypted development version of ShadowMail; this version does not open it. ' +
    'Rename or delete the data folder.',
  vaultFileMissing:
    'The data folder has an encrypted database, but the vault.json next to it is missing, so it cannot be opened. ' +
    'Put the vault.json file back (for example from a backup), or rename the data folder.',

  // Vault
  vaultCreateHeading: 'Set a master password',
  vaultCreateIntro:
    'The master password protects your mail: the mailbox passwords, the messages and the search index. They travel encrypted ' +
    'with the program in this folder; on any computer they open with this master password.',
  vaultForgetWarning:
    'In the next step you get a recovery code: with it you can get in if you forget the master password. ' +
    'Without the code and the password, the data stored here cannot be opened again.',
  vaultPassword: 'Master password',
  vaultPasswordAgain: 'Master password again',
  vaultMinLength: n => `At least ${count(n, 'character')}.`,
  vaultCreateButton: 'Set password',
  vaultMismatch: 'The two passwords do not match.',
  vaultUnlockHeading: 'ShadowMail is locked',
  vaultUnlockButton: 'Unlock',
  vaultWorking: 'One moment…',
  vaultLockButton: 'Lock',
  settingsHeading: 'Settings',
  vaultChangeHeading: 'Change the master password',
  vaultOldPassword: 'Current master password',
  vaultNewPassword: 'New master password',
  vaultNewPasswordAgain: 'New master password again',
  vaultChangeButton: 'Change the master password',
  vaultChangeIntro: 'You unlock ShadowMail with it at start and after locking.',
  vaultChanged: 'The master password has been changed.',
  vaultErrors: {
    wrong_password: 'Wrong master password',
    password_too_short: 'The master password is too short (at least 10 characters).',
    password_too_long: 'The master password is too long.',
    bad_password: 'Invalid password.',
    vault_exists: 'The master password is already set.',
    no_vault: 'No master password has been set yet.',
    busy: 'Another operation is in progress; wait a moment.',
    locked: 'The program is locked.',
    unsupported_kdf: 'Unknown key derivation: a newer version of the program is needed.',
    confirm_word: 'To confirm, type exactly this: DELETE',
    unlocked: 'The program is unlocked: starting over is only possible from the unlock screen.',
    vault_corrupt: 'The vault file is damaged.',
    // another version's vault.json; nothing is written
    vault_old_version:
      'This data folder comes from an earlier development version of ShadowMail; this version does not open it. Start over (I forgot the master password → I have no code; all local data is deleted), or rename or delete the data folder.',
    vault_newer_version:
      'This data folder was made by a newer version of ShadowMail. Start that version or a later one; this older version neither opens nor changes it.',
    db_key: 'The database cannot be opened with this key.',
    db_open_failed: 'The database cannot be opened.',
    db_missing: 'The database (mail.sqlite) is missing from the data folder, so it cannot be opened. Put it back, for example from a backup.',
    // before the schema upgrade the backup needs as much free space as the database
    db_no_space: info =>
      info && info.needMb
        ? `Not enough free space to back up the database: ${num(info.needMb)} MB needed, ${num(info.freeMb)} MB free. Free up some space and try again; your data is untouched.`
        : 'Not enough free space to back up the database. Free up some space and try again; your data is untouched.',
    wrong_recovery_code: 'Wrong recovery code',
    wrong_group: 'This does not match that group of the code.',
    no_pending_code: 'There is no code waiting for confirmation.',
    reset_pending: 'An earlier start-over was interrupted, and the program cannot tell for sure how far it got.',
    not_available: 'There is no start-over to finish: the program can be unlocked as usual.',
    bad_recovery_code: 'This is not a recovery code: 25 characters, in groups of five.',
    no_recovery: 'This vault has no recovery code.',
    internal: 'An unexpected error occurred.',
  },
  vaultError: (code, info = null) => {
    const text = en.vaultErrors[code] || en.vaultErrors.internal
    return typeof text === 'function' ? text(info) : text
  },
  // on the lock screen while the schema upgrade (backup + migration) runs
  vaultDbUpgrade: 'Updating the database: a backup is made first, which can take a few minutes with a lot of mail. Do not close the program.',
  // Forgotten master password
  vaultForgot: 'I forgot the master password',
  lockDraftsFailed: n => `On locking, ${count(n, 'draft')} could not be saved; the latest autosave is in Drafts.`, // a lock with an open composer
  // the two ways of a forgotten master password
  vaultForgotHeading: 'Forgotten master password',
  vaultForgotHaveCode: 'I have a recovery code',
  vaultForgotNoCode: 'I have no code',
  vaultRecoverHeading: 'Sign in with the recovery code',
  vaultRecoverIntro: 'With the recovery code and a new master password, all your data stays. You then get a new code, and the current one stops working.',
  vaultRecoverCode: 'Recovery code',
  vaultRecoverButton: 'Sign in and set a new master password',
  vaultResetHeading: 'Start over completely',
  vaultResetWarning:
    'Without the code the data stored here cannot be opened, so ALL local data is lost: the accounts and their passwords, the search index, ' +
    'the POP3 messages, the local folders, and the drafts and Sent copies kept only here. IMAP messages are downloaded again from the ' +
    'server after you add the account again.',
  vaultResetConfirmLabel: 'To confirm, type: DELETE',
  vaultResetButton: 'Delete all local data and set a new master password',
  vaultResetBack: 'I remember the password after all',
  // the way out of an interrupted reset that cannot be decided
  vaultResetPendingText:
    'An earlier start-over was interrupted, and the program cannot tell for sure how far it got. You can finish it: then ALL local data is deleted, as with »I have no code«.',
  vaultFinishResetButton: 'Finish starting over',
  // the recovery code screen
  recoveryHeading: 'Recovery code',
  recoveryIntro: 'With this code you can get in if you forget the master password. Write it down or save it, and keep it somewhere safe, apart from the computer and the USB drive.',
  recoveryWarning:
    'Anyone who gets the code can open your mail without the master password. The program does not store the code: if you lose it, you can make a new one in Settings. ' +
    'The old code and the old password still open your mail together with an earlier backup of the data folder. If the code or the password got into the wrong hands, destroy the old backups too.',
  recoveryCodeAfterError: (error, code) => `${error} Your new recovery code (write it down, the old one no longer works): ${code}`,
  recoveryCopy: 'Copy',
  recoveryCopied: 'Copied to the clipboard.',
  recoveryClipboardNote: 'The code is removed from the clipboard in 60 seconds.', // the clipboard guard
  recoverySave: 'Save to file',
  recoverySaved: 'Saved.',
  recoveryCheck: n => `Check: type group ${n} of the code`,
  recoveryCheckWrong: 'This does not match that group of the code.',
  recoveryDone: 'Got it, continue',
  recoveryUnconfirmed: 'Your recovery code has not been confirmed. Make a new one in Settings and write it down.',
  recoveryGoSettings: 'Make a new code…',
  recoveryNewHeading: 'New recovery code',
  recoveryNewIntro: 'Once the new code is made, the current one stops working.',
  recoveryNewButton: 'Make a new code',
  recoveryFileName: 'ShadowMail-recovery-code.txt',
  recoveryFileText: code =>
    `ShadowMail recovery code\r\n\r\n${code}\r\n\r\n` +
    'With this code you can get in if the master password is forgotten ("I forgot the master password" -> "I have a recovery code").\r\n' +
    'Anyone who gets it can open the mail without the master password: keep it somewhere safe, apart from the program.\r\n',
  accountNoPassword: 'no password',
  accountNoPasswordHint: 'No password is saved for this account: open Edit and enter it again.',

  // Accounts
  accountsHeading: 'Mailboxes',
  accountsEmpty: 'No mailbox yet.',
  accountNew: 'New account',
  accountEdit: 'Edit',
  accountDelete: 'Delete',
  accountDeleteConfirm: name =>
    `Delete the account “${name}”? Its messages, folders and passwords are deleted from this computer too (they stay on the server).`,
  accountDeleteYes: 'Yes, delete it',
  accountSave: 'Save',
  accountCancel: 'Cancel',
  accountSaved: 'Saved.',
  accountTest: 'Test the connection',
  accountTesting: 'Testing…',
  accountFields: {
    type: 'Type',
    name: 'Account name',
    email: 'Email address',
    display_name: 'Display name',
    incoming: 'Incoming server',
    in_host: 'Server',
    in_port: 'Port',
    in_security: 'Security',
    in_user: 'User name',
    in_password: 'Password',
    smtp: 'Outgoing (SMTP) server',
    smtp_host: 'Server',
    smtp_port: 'Port',
    smtp_security: 'Security',
    smtp_user: 'User name (empty = the same as incoming)',
    smtp_same_password: 'The SMTP password is the same',
    smtp_password: 'SMTP password',
    tls_verify: 'Verify the certificate',
    index_years: 'Indexed messages: last N years',
    index_all: 'all',
    sync_interval_min: 'Refresh (minutes)',
    save_sent_to_server: 'Save sent messages on the server',
    archive_mode: 'Archiving',
    pop3_delete_after_days: 'Delete from the server after N days (empty = never)',
    signature: 'Signature',
  },
  // the account editor's own words (the shared form base); accountFields stays the field names of Claude's confirm view
  accountForm: {
    editTitle: 'Edit account',
    sections: { account: 'Account', incoming: 'Incoming server', incomingImap: 'Incoming server (IMAP)', incomingPop3: 'Incoming server (POP3)', smtp: 'Outgoing server (SMTP)', folders: 'Folders', sync: 'Sync', signature: 'Signature' },
    typeLocked: 'Cannot be changed after saving.',
    smtpUser: 'User name',
    smtpUserHint: 'Leave it empty to use the incoming one.',
    indexYears: 'Indexed messages',
    yearsUnit: 'years',
    indexAll: 'All',
    syncInterval: 'Refresh every',
    minutesUnit: 'minutes',
    signatureText: 'Text',
  },
  accountPasswordUnchanged: '•••• (unchanged)',
  securityLabels: { tls: 'SSL/TLS', starttls: 'STARTTLS', none: 'None (unencrypted)' },
  typeLabels: { imap: 'IMAP', pop3: 'POP3' },
  accountTypeHelp: { imap: 'the mail stays on the server, every device sees the same', pop3: 'the mail is downloaded to this computer, deleted from the server only as set below' },
  tlsVerifyOffWarning:
    'Certificate verification is off: the connection is encrypted, but it is not checked that you are really talking to your server. Only turn it off if your host’s certificate is issued to a different name.',
  noSecurityWarning: 'Without encryption, the password and the messages travel over the network in readable form.',
  indexHelp: 'In older messages you can only search by sender, recipient, subject and date; in the ones you have opened, by the text too.',
  indexHelpImap: 'To search the text of older ones, use the Search on the server too button.',
  // measured live: a test server marks a message read when POP3 fetches it
  pop3SeenHelp: 'Some servers (e.g. Dovecot) mark a message as read on the server when POP3 downloads it. If you also read this mailbox over IMAP (webmail, phone), the downloaded messages show as read there.',
  reindexStatus: (cleared, requeued) => `Reindexing: the text of ${count(cleared, 'message')} was taken out of the index; the text of ${count(requeued, 'message')} is loaded at the next sync.`,
  accountErrors: {
    required: 'Required field.',
    too_long: 'Too long.',
    bad_email: 'Invalid email address.',
    bad_type: 'Choose the account type (IMAP or POP3).',
    type_locked: 'The type of an existing account cannot be changed.',
    bad_host: 'Invalid server name.',
    bad_security: 'Choose a security mode.',
    bad_port: 'The port is a whole number between 1 and 65535.',
    bad_index_years: 'A whole number between 1 and 50, or “all”.',
    bad_interval: 'A whole number between 1 and 1440.',
    bad_archive_mode: 'Unknown archive mode.',
    bad_days: 'A whole number between 0 and 3650, or empty.',
    bad_password: 'Invalid password.',
    bad_chars: 'It cannot contain a line break or a control character.',
    not_found: 'The account was not found.',
    unknown: 'Invalid value.',
  },
  accountError: code => en.accountErrors[code] || en.accountErrors.unknown,
  // the signature image of an account (under the text signature)
  signatureImage: {
    label: 'Signature image',
    none: 'No image. The image appears under the text signature in your messages.',
    alt: 'The signature image',
    upload: 'Upload image…',
    replace: 'Replace…',
    remove: 'Remove',
    help: 'PNG or JPG, at most 800 x 400 pixels and 150 KB. The image is not resized; its metadata (such as the GPS location or the author) is removed when it is saved.',
    saveFirst: 'You can upload a signature image after saving the account.',
    error: r => {
      if (r.error === 'too_large' && r.width && (r.width > r.maxWidth || r.height > r.maxHeight)) return `The image is ${r.width} x ${r.height} px; it can be at most ${r.maxWidth} x ${r.maxHeight} px.`
      if (r.error === 'too_large') return `The image is ${Math.ceil(r.bytes / 1024)} KB; it can be at most ${Math.round((r.maxBytes || 153600) / 1024)} KB.`
      if (r.error === 'rotated_image') return 'The image carries a rotation flag; save it rotated and upload it again.'
      if (r.error === 'unsupported_image') return 'This is not a PNG or JPG image, or it is damaged (an animated PNG is not accepted either).'
      if (r.error === 'read_failed') return 'The file could not be read.'
      return 'The image could not be saved.'
    },
  },
  probeIncoming: 'Incoming',
  probeSmtp: 'Outgoing (SMTP)',
  probeOk: 'OK',
  probeErrors: {
    auth_failed: 'Wrong user name or password.',
    auth_not_offered: 'The server does not allow signing in on this connection (most servers do not without encryption: choose SSL/TLS or STARTTLS).',
    host_not_found: 'The server was not found (check the server name).',
    connection_refused: 'The server does not accept connections on this port (check the port).',
    timeout: 'The server did not answer in time (wrong port or a firewall).',
    tls_certificate: 'The server’s certificate is not valid for this name, or it is not trusted.',
    starttls_unsupported: 'The server does not support STARTTLS on this port.',
    tls_mismatch: 'The security mode does not match the port (e.g. SSL/TLS on an unencrypted port).',
    mailbox_in_use: 'Another connection is using the mailbox right now (another program or an earlier download); try again a little later.',
    unknown: 'Unknown error while connecting.',
  },
  probeError: code => en.probeErrors[code] || en.probeErrors.unknown,

  // Mail view
  viewMail: 'Mail',
  viewSettings: 'Accounts and settings',
  settingsNavLabel: 'Settings',
  // the address book
  viewContacts: 'Contacts',
  // Claude wants to show a message while an editor is open
  claudeOffer: 'Claude would like to show you a message. Opening it leaves the unfinished editing.',
  claudeOfferOpen: 'Open',
  claudeOfferSearch: 'Claude would like to show you a search. Showing it leaves the unfinished editing.',
  claudeOfferSearchOpen: 'Show',
  contacts: {
    title: 'Contacts',
    search: 'Search contacts',
    searchClear: 'Clear the search',
    count: n => count(n, 'contact'),
    selected: n => `${num(n)} selected`,
    listLabel: 'Contacts',
    newContact: 'New contact',
    import: 'Import…',
    export: 'Export',
    exportAllVcf: 'All, vCard (.vcf)',
    exportAllCsv: 'All, CSV (.csv)',
    exportSelVcf: 'Selected, vCard (.vcf)',
    exportSelCsv: 'Selected, CSV (.csv)',
    deleteSelected: 'Delete selected',
    select: name => `Select ${name}`,
    source: { auto: 'Automatic', manual: 'Manual', import: 'Imported' },
    sourceHint: { auto: 'Added automatically when you sent mail', manual: 'You added it yourself', import: 'You imported it from a file' },
    empty: 'No contacts yet. Recipients are added automatically when you send mail, or you can import a file.',
    noMatch: 'No results.',
    choose: 'Choose a contact from the list.',
    noName: '(no name)',
    write: 'Write a message',
    edit: 'Edit',
    delete: 'Delete',
    primary: 'primary',
    fields: { displayName: 'Display name', givenName: 'First name', familyName: 'Last name', org: 'Company', title: 'Job title', note: 'Note' },
    emails: 'Email addresses',
    phones: 'Phone numbers',
    address: 'Address',
    number: 'Number',
    label: 'Label',
    primaryChoice: 'Primary address',
    addEmail: 'Add an address',
    addPhone: 'Add a phone',
    removeEmail: n => `Remove address ${n}`,
    removePhone: n => `Remove phone ${n}`,
    // the address book on the shared form base
    emptyTitle: 'No contact selected',
    emptyText: 'Pick one from the list, or add a new one. You can import from vCard and CSV files.',
    primaryTag: 'Primary',
    detailEmail: 'Email',
    detailPhone: 'Phone',
    detailSource: 'Source',
    sectionName: 'Name',
    sectionWork: 'Work',
    headAddress: 'Email address',
    headNumber: 'Phone number',
    emailRow: n => `Email address ${n}`,
    emailLabelRow: n => `Label of address ${n}`,
    primaryRow: n => `Address ${n} is the primary one`,
    phoneRow: n => `Phone number ${n}`,
    phoneLabelRow: n => `Label of phone ${n}`,
    save: 'Save',
    cancel: 'Cancel',
    newTitle: 'New contact',
    editTitle: 'Edit contact',
    saved: 'The contact has been saved.',
    errors: {
      bad_request: 'A field is not right: a name or a valid address is needed, and the fields cannot be too long.',
      address_taken: 'This address already belongs to another contact.',
      not_found: 'This contact no longer exists.',
      preview_expired: 'The preview has expired (5 minutes). Choose the file again.',
      nothing_to_export: 'There is nothing to export.',
      unsupported_file: 'This file cannot be read: a .vcf, .vcard or .csv file is needed.',
      read_failed: 'The file cannot be read.',
      write_failed: 'The file could not be saved.',
      too_large: 'The file is too large (at most 10 MB).',
      too_many: 'The file has too many contacts (at most 10,000).',
      not_available: 'This is not available right now.',
      internal: 'An unexpected error occurred.',
    },
    error: code => en.contacts.errors[code] || en.contacts.errors.internal,
    openOther: 'Open the other contact',
    deleteTitle: n => (n === 1 ? 'Delete contact' : `Delete ${count(n, 'contact')}`),
    deleteText: 'A deleted contact does not come back by itself with the next message.',
    deleted: n => `${count(n, 'contact')} deleted.`,
    importTitle: 'Import preview',
    importCounts: c => `New: ${num(c.new)}, merged: ${num(c.merged)}, unchanged: ${num(c.unchanged)}, cannot be imported: ${num(c.invalid)}`,
    importInvalid: 'Rows that cannot be imported',
    importWarnings: n => `${count(n, 'contact')} lost an address or phone number (the contact is still imported)`,
    importSample: 'Sample',
    importKind: { new: 'new', merged: 'merged' },
    reasons: {
      two_people: 'its addresses belong to two contacts',
      no_name_or_address: 'it has no name and no valid address',
      missing_end: 'the end of the contact is missing (END:VCARD)',
      missing_begin: 'the start of the contact is missing (BEGIN:VCARD)',
      line_too_long: 'a line is too long (over 64 KB)',
      unterminated_quote: 'an unclosed quotation mark',
      unknown_header: 'unknown header: neither Google nor Outlook format',
      address_limit: n => `${count(n, 'address or phone number', 'addresses or phone numbers')} over the limit of 20 left out`,
      invalid_address: n => `${count(n, 'address', 'addresses')} not in email form left out`,
    },
    reason: (code, dropped) => {
      const r = en.contacts.reasons[code]
      return typeof r === 'function' ? r(dropped) : r || code
    },
    row: n => `Row ${n}`,
    doImport: 'Import',
    imported: c => `Imported: ${num(c.new)} new, ${num(c.merged)} merged, ${num(c.unchanged)} unchanged.`,
    exported: n => `${count(n, 'contact')} exported.`,
    addSender: 'Add to contacts',
    senderAdded: 'The sender has been added to your contacts.',
  },
  splitterContacts: 'Contact list width',
  // the draggable dividers' names (the arrows move them, Home or a double click gives back the default)
  splitters: { sidebar: 'Folder pane width', list: 'Message list width', listh: 'Message list height', settings: 'Settings menu width' },
  settingsNav: { accounts: 'Accounts', appearance: 'Appearance', security: 'Security', claude: 'Claude access', about: 'About' },
  // MCP: the "Claude access" page (ClaudeAccess.jsx)
  claudeAccess: {
    title: 'Claude access',
    intro: 'When it is on, the Claude running on your computer (Claude Desktop or Claude Code) can reach your mail through this program, while ShadowMail is running and unlocked. When it is off, locked or the program is closed, Claude can reach nothing.',
    switchLabel: 'Claude access on',
    switchFailed: 'The switch could not be changed.',
    stateLabel: 'Status:',
    stateOff: 'Off',
    stateStarting: 'Starting…',
    stateWaiting: 'Waiting (no Claude connected)',
    stateConnected: n => `Connected: ${num(n)}`,
    connectTitle: 'Setting it up in Claude',
    connectIntro: 'ShadowMail does not write Claude’s settings: you copy one of the following yourself. Both contain the program’s current location.',
    desktopTitle: 'Claude Desktop: into the claude_desktop_config.json file',
    desktopHint: 'The file on Windows: %APPDATA%\\Claude\\claude_desktop_config.json (on macOS: ~/Library/Application Support/Claude/claude_desktop_config.json). If it already has "mcpServers", only add the "shadowmail" part next to the others. After saving, restart Claude Desktop.',
    codeTitle: 'Claude Code: a command for the terminal',
    codeHint: 'With --scope user it is available in every project. In Claude Code the /mcp command shows whether it is connected.',
    codeHintPowershell: 'The program’s path contains a $ or ` character, so this command is for PowerShell (the Command Prompt treats the quotes differently). With --scope user it is available in every project; in Claude Code the /mcp command shows whether it is connected.',
    copy: 'Copy',
    copied: 'Copied',
    copyFailed: 'Copying failed.',
    moved: 'If you moved the ShadowMail folder, copy it in again: Claude looks for the program in the old place.',
    rulesTitle: 'What can Claude do?',
    freeTitle: 'Without confirmation:',
    free: 'reading and searching (a message does not become read), marking (read, star), moving, moving to Trash, creating and renaming folders, writing drafts (into Drafts, with a "Claude" mark), refreshing, testing an account’s connection.',
    confirmTitle: 'Only with your confirmation, in this window:',
    confirm: 'sending a message, deleting permanently, deleting a folder or an account, changing account settings, restarting the sign-in of a stopped account.',
    neverTitle: 'Never:',
    never: 'passwords, the master password and the recovery code, the content of attachments, attaching a local file, and this switch.',
    threat: 'The protection is against other programs on your computer and instructions hidden in messages; it does not protect against malware running as your user.',
    webTools: 'Suggestion: in Claude, keep the approval prompts for web and other tools on, because an instruction hidden in a message could try to take data out through them.',
    recentTitle: 'Recent Claude calls',
    recentEmpty: 'No calls yet.',
    recentHint: 'The last 20 calls, kept only in memory: empty after locking or a restart. Search words, addresses, subjects and message text are never kept here.',
    colTime: 'Time',
    colTool: 'Tool',
    colResult: 'Result',
    colItems: 'Items',
    result: r => ({ ok: 'OK', pending_confirmation: 'waiting for confirmation', dropped: 'interrupted' })[r] || `error (${r})`,
    confirmResult: r => `confirmation: ${({ approved: 'approved', rejected: 'rejected', expired: 'expired', failed: 'failed' })[r] || r}`,
  },
  passwordShow: 'Show password',
  passwordHide: 'Hide password',
  backToMail: 'Back to mail',
  sidebarCollapse: 'Collapse the sidebar',
  sidebarExpand: 'Expand the sidebar',
  accountFoldersHide: account => `${account}: hide folders`,
  accountFoldersShow: account => `${account}: show folders`,
  refresh: 'Refresh',
  folderRoles: {
    inbox: 'Inbox',
    drafts: 'Drafts',
    sent: 'Sent',
    trash: 'Trash',
    junk: 'Junk',
    archive: 'Archive',
  },
  archiveCreated: paths => `A new folder was made for archiving: ${paths.join(', ')}`,
  archiveModes: { '': 'Automatic (by year if the Archive already has a year folder)', single: 'Into one folder (Archive)', yearly: 'By year (Archive/2024)' },
  folderRolePicker: {
    label: 'Folder roles',
    auto: 'Automatic',
    autoNow: path => `Automatic (now: ${path})`,
    help: 'Which folder is Sent, Trash, Drafts, Junk and Archive. Automatic goes by the server\'s flag, the earlier choice or the usual name, and between two similarly named folders it takes the one with more messages. The choice applies at once; nothing changes on the server.',
  },
  foldersHeading: 'Folders',
  unreadCount: n => `${num(n)} unread`,
  unreadCountFolded: n => `${num(n)} unread, subfolders included`,
  folderFoldHide: folder => `${folder}: hide subfolders`,
  folderFoldShow: folder => `${folder}: show subfolders`,
  noMailAccounts: 'No mailbox yet. Add one under “Accounts and settings”.',
  noFolders: 'The folders appear after the first sync.',
  chooseFolder: 'Choose a folder.',
  listEmpty: 'There are no messages in this folder.',
  listCount: n => count(n, 'message'),
  // since 0.10.1 the chips filter the folder view too
  listFiltered: folderTotal => ` (filtered, ${num(folderTotal)} in total)`,
  listFilteredEmpty: 'No message matches the filters.',
  // MCP: the connector's answer when the app cannot be reached (it goes to Claude: the connector uses the Hungarian one)
  mcpUnavailable: 'ShadowMail is not running, is locked, or Claude access is turned off.',
  mcpTooMany: 'Two Claude connections to ShadowMail are already open (that is the most at a time). Close another Claude session and try again.',
  listLoadError: code => `The message list cannot be loaded: ${en.searchError(code)}`,
  clearFilters: 'Clear filters',
  listSortField: { date: 'Date', from: 'Sender', subject: 'Subject' },
  listSortChip: (sort, dir) => `Sort: ${en.listSortField[sort]}, ${dir === 'asc' ? 'ascending' : 'descending'}`,
  listColumns: { star: 'Star', attachment: 'Attachment', from: 'Sender', subject: 'Subject', date: 'Date' },
  noSubject: '(no subject)',
  unknownSender: '(unknown sender)',
  flagged: 'Starred',
  hasAttachment: 'Has attachment',
  // Message list
  listToolsLabel: 'Message list',
  selectRow: 'Select',
  selectAll: 'Select all',
  selectMenu: 'Selection options',
  selectMenuItems: { all: 'All', none: 'None', read: 'Read', unread: 'Unread' },
  moreMenu: 'More',
  sortMenu: { date: 'Sort by date', from: 'Sort by sender', subject: 'Sort by subject', reverse: 'Reverse order' },
  starToggle: 'Star',
  listRange: (range, total) => `${range} (${count(total, 'message')} in total)`,
  syncPhases: {
    connecting: 'connecting…',
    metadata: (folder, p) => `updating folder: ${folder}${p ? ` (${num(p.done)} / ${num(p.total)})` : ''}`,
    bodies: (p, requeued) => `${requeued ? 'Reindexing' : 'indexing message text'}${p ? `: ${num(p.done)} / ${num(p.total)}` : ''}`,
  },
  syncedAt: time => `updated ${time}`,
  syncNever: 'not updated yet',
  syncLive: 'live',
  // Background sync: the probe's texts (en.probeErrors) assume a settings mistake; during a sync the
  // usual cause is the network, so these come first.
  syncErrors: {
    connection_lost: 'the connection was lost; retrying…',
    host_not_found: 'the server cannot be reached (no network, or a wrong server name); retrying…',
    connection_refused: 'the server does not accept the connection (no network, the server refuses it, or a wrong port); retrying…',
    timeout: 'the server did not answer in time; retrying…',
    auth_failed: 'the server refused the sign-in (wrong user name or password).',
    no_password: 'no password is saved: enter it in the account settings.',
    folder: 'the server did not give out some folders.',
    uidl_unsupported: 'the POP3 server does not support the UIDL command, so it cannot be told which messages are new.',
    mailbox_in_use: 'another connection is using the mailbox right now; retrying…',
    partial: 'the server did not give out some messages; they are tried again at the next refresh.',
  },
  syncError: code => en.syncErrors[code] || en.probeErrors[code] || en.probeErrors.unknown,
  syncStopped: 'Automatic refresh is paused: fix the account settings, or press the Refresh button.',

  // Reader pane
  readerEmpty: 'Choose a message from the list.',
  readerLoading: 'Loading the message…',
  readerHeaders: { from: 'From', to: 'To', cc: 'Cc', replyTo: 'Reply-To', date: 'Date' },
  readerFrameTitle: 'The message text',
  readerImagesBlocked: n => `The message has ${n === 1 ? 'an external image' : 'external images'}; for your safety ${n === 1 ? 'it was' : 'they were'} not loaded (so the sender cannot tell that you opened it).`,
  readerLoadImages: 'Load images',
  readerAttachments: n => `Attachments (${num(n)})`,
  readerSave: 'Save…',
  readerOpen: 'Open',
  readerExecutable: 'Executable file: it can only be saved, not opened from here.',
  readerBrowserActive: 'Web-page-like file (HTML, SVG, XML): in a browser it could run a program, so it can only be saved.',
  readerNotOpenable: 'This file type is not opened directly; it can only be saved.', // not on the allow list
  readerThread: 'Thread',
  readerThreadHide: 'Hide the thread',
  readerThreadHeading: n => `Messages in the thread (${num(n)})`,
  readerThreadCurrent: 'this message',
  // the plain-text body in the reader
  readerControlsHidden: n => `The message contains ${count(n, 'control character')}; ${n === 1 ? 'it is' : 'they are'} not shown here, the Source view marks ${n === 1 ? 'it' : 'them'}.`,
  readerTextCut: n => `The remaining ${count(n, 'character')} of the message ${n === 1 ? 'is' : 'are'} not shown here; the full text is in the Source view.`,
  // Source view
  source: {
    menuHeaders: 'Headers',
    menuOriginal: 'Show original',
    menuSave: 'Save as .eml',
    title: 'Message source',
    tabsLabel: 'Views of the source',
    tabs: { headers: 'Headers', original: 'Original' },
    loading: 'Loading the source…',
    save: 'Save as .eml',
    saved: 'The message has been saved as .eml.',
    summaryLabel: 'Summary',
    rows: { from: 'From', to: 'To', cc: 'Cc', date: 'Date', subject: 'Subject', messageId: 'Message-ID', spf: 'SPF', dkim: 'DKIM', dmarc: 'DMARC' },
    authResults: {
      pass: 'pass (passed)',
      fail: 'fail (failed)',
      softfail: 'softfail (suspicious)',
      neutral: 'neutral',
      none: 'none (no signature or policy)',
      temperror: 'temperror (temporary error)',
      permerror: 'permerror (permanent error)',
      policy: 'policy (by policy)',
    },
    authMissing: 'no data',
    authBy: by => `The result comes from the message’s Authentication-Results line, written by “${by}”. ShadowMail does not check it itself; if the receiving server wrote no such line, the sender could have written this one.`,
    authNone: 'The message has no Authentication-Results line, so no SPF/DKIM/DMARC result is shown. ShadowMail does not check it itself.',
    rawHeaders: 'The full header',
    noHeaders: 'This message has no recognizable header.',
    truncated: size => `The message is ${size}; the first 2 MB is shown. For the full message, save it as .eml.`,
    headersTruncated: 'The header is longer than 2 MB; only its start is shown. For the full one, save it as .eml.',
    marks: (n, rest = 0) =>
      `${count(n, 'invisible character')} (control, direction, zero-width and so on) ${n === 1 ? 'is' : 'are'} shown as ${n === 1 ? 'a mark' : 'marks'} (⟨U+…⟩)${rest ? `, ${num(rest)} more left out (summed up at the end of the text)` : ''}.`,
    markTitle: code => `Invisible character: ${code}`,
    // past the 10 000th mark
    unmarked: n => `… and ${count(n, 'more invisible character', 'more invisible characters')} (not marked one by one)`,
    cutByMarks: '… with the marks the text would be longer than 2 MB, so its end is not shown. For the full message, save it as .eml.',
  },
  // Reader
  backToList: 'Back to the list',
  readerToolsLabel: 'Actions on the message',
  readerMore: 'More',
  readerDetailsShow: 'Show details',
  readerDetailsHide: 'Hide details',
  readerToSummary: names => `to: ${names}`,
  readerNoRecipient: 'no recipient',
  readerAttachmentKind: { executable: 'executable', browserActive: 'web-page-like', notOpenable: 'save only' },
  // Appearance
  settingDesc: {
    language: 'The language of the interface. The change applies at once.',
    theme: 'Colors and density.',
    readerPane: 'Where the selected message opens.',
    taskbar: 'A red disc with the number when the Inbox has unread messages (Windows).',
  },
  settingsAppearance: 'Appearance',
  readerPaneLabel: 'Reading pane',
  // the unread badge on the taskbar button (Windows): the switch, its error, and the screen reader's description of the badge
  taskbarUnreadLabel: 'Unread count on the taskbar icon',
  taskbarUnreadFailed: 'The setting could not be saved.',
  taskbarUnreadBadge: n => count(n, 'unread message'),
  readerPaneOptions: { none: 'None: the message opens in place of the list', right: 'On the right of the list', bottom: 'Below the list' },
  languageLabel: 'Nyelv / Language',
  languageOptions: { hu: 'Magyar', en: 'English' },
  themeLabel: 'Theme',
  themes: { default: 'Default (light)', dark: 'Dark', graphite: 'Graphite', 'classic-blue': 'Classic blue', 'classic-light': 'Classic light' },
  languageApplying: 'Changing the language: the open composers save, then the window reloads…',
  languageFailed: 'The language could not be saved; the setting is unchanged.',
  // the header's quick switch: what is on now, and what one click gives
  readerPaneShort: { none: 'no reading pane', right: 'reading pane on the right', bottom: 'reading pane at the bottom' },
  readerPaneButton: (now, next) => `Layout: ${en.readerPaneShort[now]}. Click for: ${en.readerPaneShort[next]}`,
  readerSeenFailed: code => `The message could not be marked as read on the server: ${en.syncError(code)}`,
  readerErrors: {
    not_found: 'This message is no longer there (it was deleted or moved in the meantime).',
    gone: 'This message is no longer on the server.',
    stale: 'The folder changed on the server. Refresh, then open it again.',
    not_downloaded: 'The message file is not in the data\\store folder.',
    store_corrupt: 'The message file in the data\\store folder is damaged, so it cannot be opened. The other messages and the search still work.',
    pop3_local: 'For a POP3 account this action only makes sense locally.',
    locked: 'The store is locked.',
    no_account: 'The message’s account is not active.',
    sync_stopped: 'The account is paused because the server refused the sign-in. Fix the settings, or press the Refresh button.',
    not_open: 'The message was closed in the meantime. Open it again.',
    not_a_draft: 'This message is no longer in Drafts (it was moved or sent meanwhile).',
    executable: 'Executable files are not opened; they can only be saved.',
    browser_active: 'Web-page-like files (HTML, SVG, XML) are not opened; they can only be saved.',
    not_openable: 'This file type is not opened directly; it can only be saved.',
    open_failed: 'The attachment could not be opened (is there no program for it?).',
    motw_failed: 'The attachment cannot be marked safely; save it and open it from there.',
    internal: 'An unexpected error occurred.',
  },
  // Message actions
  actionsLabel: 'Actions on the selected messages',
  actions: { read: 'Mark as read', unread: 'Mark as unread', star: 'Star', unstar: 'Remove star', delete: 'Delete', move: 'Move', moveTo: 'Move to…', archive: 'Archive' },
  selectedCount: n => `${num(n)} selected`,
  confirmDeleteTitle: 'Delete permanently',
  confirmDeleteTrash: n => `${n === 1 ? 'The message is' : `${count(n, 'message')} are`} in Trash: after deleting, ${n === 1 ? 'it is' : 'they are'} gone from the server too and cannot be restored.`,
  confirmDeleteNoTrash: n => `This account has no Trash folder, so ${n === 1 ? 'the message is' : `the ${count(n, 'message')} are`} deleted permanently, from the server too. This cannot be undone.`,
  confirmDeleteYes: 'Delete permanently',
  confirmCancel: 'Cancel',
  close: 'Close',
  // Claude's drafts
  claudeDraftNotice: subject => `Claude made a draft: ${subject || '(no subject)'}`,
  claudeDraftOpen: 'Open',
  claudeDraftNotYet: 'The draft has not reached the Drafts folder yet; try again in a few seconds.',
  claudeMark: 'Claude',
  claudeMarkTitle: 'Claude made this draft',
  // the user's confirmation of Claude's requests (ClaudeConfirm.jsx)
  claudeConfirm: {
    header: 'Claude started this request. Only approve it if you want it too.',
    titles: {
      send: 'Claude would send a message',
      deleteMessages: 'Claude would delete messages permanently',
      deleteFolder: 'Claude would delete a folder',
      updateAccount: 'Claude would change an account’s settings',
      deleteAccount: 'Claude would delete an account',
      restartLogin: 'Claude would restart an account’s sign-in',
    },
    unknownTitle: 'Claude’s request',
    reject: 'Reject',
    approve: 'Approve',
    lock: 'Lock',
    rejectAllOff: 'Reject all, turn Claude access off',
    offFailed: 'Claude access could not be turned off; the requests are still waiting. Reject them one by one, or lock the program.',
    more: n => `${count(n, 'more request', 'more requests')} ${n === 1 ? 'is' : 'are'} waiting after this one.`,
    from: 'From',
    to: 'To',
    cc: 'Cc',
    bcc: 'Bcc',
    subject: 'Subject',
    noSubject: '(no subject)',
    text: 'Text',
    noText: '(empty)',
    showAll: n => `Show the full text (${count(n, 'character')})`,
    showStart: 'Only the start',
    attachments: 'Attachments',
    links: 'Links in the message (label -> real target):',
    linksMore: n => `… and ${count(n, 'more link', 'more links')}`,
    account: 'Account',
    folder: 'Folder',
    listMore: n => `… and ${count(n, 'more message', 'more messages')}`,
    folderDelete: n => `The folder and ${n === 1 ? 'the message' : `the ${count(n, 'message')}`} in it are deleted permanently, on the server too. This cannot be undone.`,
    accountDelete: n => `The account, its folders, its downloaded messages (${count(n, 'message')}) and its saved password are deleted from this program. Nothing is deleted on the mail server.`,
    changesHead: 'The changes (old -> new):',
    empty: '(empty)',
    on: 'on',
    off: 'off',
    never: 'never',
    loginChanged: 'At the next sign-in the program gives the saved password to the new server or user. Only approve it if you know the server.',
    deletesSooner: 'With the shorter time, older messages may be deleted from the server at the next download.',
    restartsLogin: 'This account’s sync is stopped now (because a sign-in was refused). Saving restarts it: one sign-in attempt is made. If the password is wrong, the server may temporarily block this computer.',
    restartReason: reason => `Why it stopped: ${en.syncError(reason)}`,
    restartWarning: 'If the password is still wrong, the server may temporarily block this computer. After you approve, one sign-in attempt is made.',
  },
  actionErrors: {
    server_refused: 'the server refused it.',
    uidvalidity_changed: 'the folder changed on the server in the meantime (it was created again), so it was left alone; refresh and try again.',
    mixed_selection: 'you can only work with the messages of one folder at a time.',
    bad_target: 'it cannot be moved there.',
    not_found: 'the message disappeared in the meantime (refresh and try again).',
  },
  actionError: (action, code) => `${en.actions[action] || 'The action'} failed, the list was restored: ${en.actionErrors[code] || en.searchError(code)}`,
  // Reply, forward
  replyModes: { reply: 'Reply', replyAll: 'Reply all', forward: 'Forward', edit: 'Edit' },
  // Composer
  newMessage: 'New message',
  composeTitle: 'New message - ShadowMail',
  composeFrom: 'From',
  composeTo: 'To',
  composeCc: 'Cc',
  composeBcc: 'Bcc',
  composeShowCopies: 'Cc, Bcc…',
  composeSubject: 'Subject',
  composeBody: 'The message text',
  composeSuggestions: 'Address suggestions',
  composeFormatting: 'Formatting',
  composeTools: { bold: 'Bold', italic: 'Italic', underline: 'Underline', ul: 'Bulleted list', ol: 'Numbered list', link: 'Link', quote: 'Quote', clear: 'Clear formatting' },
  composeToolLabels: { link: 'Link', quote: 'Quote', clear: 'Clear' },
  composeLinkUrl: 'Address (https://… or mailto:…)',
  composeLinkOk: 'Insert',
  composeSend: 'Send',
  composeSending: 'Sending…',
  composeSaveDraft: 'Save as draft',
  composeSaving: 'Saving…',
  composeAttach: 'Attach…',
  composeAttachments: 'Attachments',
  composeRemoveAttachment: name => `Remove ${name}`,
  composeSavedAt: d => `Draft saved at ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`,
  composeCloseTitle: 'Close the message?',
  composeCloseText: 'The latest changes are not saved.',
  composeSaveAndClose: 'Save as draft',
  composeDiscard: 'Discard',
  // Composer: the window frame
  composeCloseWindow: 'Close the window',
  composeDiscardTitle: 'Discard the message?',
  composeDiscardText: 'The message and its saved draft are both deleted.',
  composeAttachmentsLabel: n => `Attachments (${num(n)})`,
  composeKeptAsDraft: 'The message was kept in Drafts.',
  // a message that may be broken or harmful ("e-mail bomb")
  composeSuspectTitle: 'ShadowMail',
  // the shape check (2.): one unbroken run of text longer than `limit` characters in the starting body
  // mode: reply | replyAll | forward (the question), draft, mailto, new (only cancel: nothing to leave out)
  composeSuspectText: (mode, limit) =>
    `${mode === 'mailto' ? 'The mail link' : 'The message'} may be broken or harmful: it contains one unbroken run of text longer than ${count(limit, 'character')}. ` +
    (mode === 'draft'
      ? 'So the draft does not open.'
      : mode === 'mailto' || mode === 'new'
        ? 'So the editor does not open.'
        : `Open the ${mode === 'forward' ? 'forward' : 'reply'} without quoting the original text?`),
  // the same question when one paragraph changes its writing direction too often (B: slow to lay out, not long)
  composeSuspectSlowText: mode =>
    `${mode === 'mailto' ? 'The mail link' : 'The message'} may be broken or harmful: one of its paragraphs holds too many characters that are slow to display. ` +
    (mode === 'draft'
      ? 'So the draft does not open.'
      : mode === 'mailto' || mode === 'new'
        ? 'So the editor does not open.'
        : `Open the ${mode === 'forward' ? 'forward' : 'reply'} without quoting the original text?`),
  composeSuspectOmit: 'Without the quote',
  composeSuspectCancel: 'Cancel',
  composeBodyOmitted: '[The text of the original message was left out: it may be broken or harmful.]',
  // the watchdog: the composer did not get ready in `seconds`; kind: reply | forward | draft | new | mailto
  composeStalled: (kind, sec) => {
    const seconds = Number(sec).toLocaleString('en-GB', { maximumFractionDigits: 1 })
    const unit = Number(sec) === 1 ? 'second' : 'seconds'
    return kind === 'new'
      ? `The new message’s editor did not open in ${seconds} ${unit}, so it was closed.`
      : kind === 'mailto'
        ? `The editor opened from a mail link did not open in ${seconds} ${unit}, so it was closed. The link may be broken or harmful.`
        : `The message may be broken or harmful: the editor of the ${kind === 'forward' ? 'forward' : kind === 'draft' ? 'draft' : 'reply'} did not open in ${seconds} ${unit}, so it was closed. The original message has not changed.`
  },
  // after a send the window only shows what happened
  composeSentLocked: 'A sent message can no longer be changed or sent again. If it has to go to someone again, write a new message.',
  composeChangedWhileSending: 'The changes typed during sending were NOT sent with the message.',
  composeOldDraftLeft: 'The draft in the previous sender’s account has not been deleted yet; this is tried again at the next save.',
  composeWaitSending: 'The message is being sent; wait until it finishes.',
  // sent, but not everything went well
  composeSentWithWarnings: (rejected, warnings) => {
    const parts = ['The message was sent.']
    if (rejected.length) parts.push(`The server did NOT accept these recipients, so it did not go to them: ${rejected.join(', ')}.`)
    const w = warnings.map(x => String(x).split(':')[0])
    if (w.includes('sent_copy_failed') || w.includes('no_sent_folder')) parts.push('No copy went into the Sent folder.')
    if (w.includes('kept_as_draft')) parts.push('The message was kept in Drafts.')
    if (w.includes('kept_older_draft')) parts.push('Only an earlier save of it was kept in Drafts, not the sent text.')
    if (w.includes('draft_not_removed')) parts.push('The earlier draft was not removed from Drafts.')
    if (w.includes('origin_flag_failed')) parts.push('The “answered” mark was not set on the original message.')
    return parts.join(' ')
  },
  composeErrors: {
    no_recipients: 'Enter at least one recipient.',
    bad_address: 'Invalid address',
    bad_link: 'A link can only start with https://, http:// or mailto:.',
    too_large: 'The attachments can be at most 25 MB together (most servers do not accept more).',
    not_a_file: 'A folder cannot be attached, only a file.',
    file_not_found: 'The file was not found.',
    forbidden_path: 'Nothing can be attached from the program’s own data folder.',
    no_drafts_folder: 'The account has no Drafts folder.',
    no_recipient_accepted: 'The server did not accept any of the recipients.',
    no_session: 'The editor session has expired; open a new message.',
    already_sent: 'the message has already been sent; to send it again, write a new message.',
    auth_failed: 'the SMTP server refused the sign-in (wrong user name or password in the account settings).',
  },
  // what: 'send' | 'save' | 'attach' | 'discard' -> the prefix says which step failed
  composeError: (code, detail, what = 'send') => {
    if (code === 'bad_address') return `${en.composeErrors.bad_address}: ${(detail || []).join(', ')}`
    if (['no_recipients', 'bad_link', 'too_large', 'not_a_file', 'file_not_found', 'no_session', 'forbidden_path'].includes(code)) return en.composeErrors[code]
    // server_refused (an APPEND or a delete answered NO): the message-action text, not a connection error
    const text = en.composeErrors[code] || en.actionErrors[code] || en.searchError(code)
    const prefix = { send: 'Sending failed', save: 'Saving the draft failed', attach: 'Attaching failed', discard: 'Discarding failed, the draft may have been kept' }[what]
    return `${prefix}: ${text}`
  },
  // Folder management
  folderMenu: { newSub: 'New subfolder…', rename: 'Rename…', moveUp: 'Move up', moveDown: 'Move down', delete: 'Delete…', unsubscribe: 'Unsubscribe' },
  // the account head's menu (the manual order)
  accountMenu: { moveUp: 'Move up', moveDown: 'Move down', sortFolders: 'Sort folders A-Z', subscriptions: 'Folder subscriptions…' },
  subscriptions: {
    title: account => `Folder subscriptions: ${account}`,
    help: 'The ticked folders show in the sidebar and sync. The messages of an unsubscribed folder stay on the server too.',
    loading: 'Loading the server’s folders…',
    roleLocked: 'This is one of the account’s main folders: it always shows and cannot be unsubscribed.',
    kept: 'kept from the earlier version',
    close: 'Done',
  },
  // the reader's End key where archiving is not possible
  readerKeys: { no_archive: 'This account has no Archive folder: there is nowhere to archive to.', in_archive: 'A message in the Archive cannot be archived again.' },
  // after the label of a field that may stay empty (ui/Fields.jsx TextField optional)
  optionalField: '(optional)',
  folderProtected: 'This is one of the account’s standard folders: it cannot be renamed or deleted.',
  newFolderTitle: account => `New folder: ${account}`,
  newSubfolderTitle: parent => `New subfolder in: ${parent}`,
  renameFolderTitle: name => `Rename: ${name}`,
  folderNameLabel: 'Folder name',
  folderCreate: 'Create',
  folderRename: 'Rename',
  folderDelete: 'Delete folder',
  deleteFolderTitle: 'Delete folder',
  confirmFolderDelete: (name, count) =>
    `The folder “${name}” is deleted${count ? `, and with it the ${count === 1 ? 'message' : `${num(count)} messages`} in it, from the server too` : ''}. This cannot be undone.`,
  folderErrors: {
    bad_name: 'Invalid name (empty, too long, or it contains a forbidden character: % * " \\).',
    name_has_delimiter: 'The name cannot contain a separator character (/ or the server’s own separator, e.g. a dot). You can create a subfolder from the folder’s context menu.',
    folder_exists: 'There is already a folder with this name.',
    role_folder: 'This is one of the account’s main folders: it cannot be unsubscribed.',
    protected_folder: 'This is one of the account’s standard folders: it cannot be renamed or deleted.',
    has_children: 'The folder has subfolders: delete those first.',
    no_subfolders: 'This server does not support subfolders.',
    confirm_needed: 'Deleting needs a confirmation.',
    order_mismatch: 'The folders or accounts changed in the meantime, the order was not saved. Try again.',
  },
  folderError: code => en.folderErrors[code] || en.searchError(code),
  // Global search
  searchLabel: 'Search',
  searchPlaceholder: 'Search all messages (accents optional)…',
  searchFiltersButton: 'Filters',
  searchFiltersLabel: 'Search filters',
  searchClear: 'Clear the search',
  searchAnyTime: 'Any time',
  searchDateRange: (since, until) => {
    // the days come as YYYY-MM-DD; shown as DD/MM/YYYY (en-GB)
    const d = v => v.split('-').reverse().join('/')
    if (since && until) return `${d(since)} – ${d(until)}`
    return since ? `since ${d(since)}` : `until ${d(until)}`
  },
  // the sender chip's value (its label "From" is already in front of it)
  searchPeople: (from, to) => [from, to && `${en.searchFilter.to.toLowerCase()}: ${to}`].filter(Boolean).join(', '),
  searchFilter: { account: 'Account', folder: 'Folder', from: 'From', to: 'To', since: 'From date', until: 'To date', hasAttachment: 'Has attachment', unread: 'Unread', flagged: 'Starred', sort: 'Sort' },
  searchAllAccounts: 'All accounts',
  searchAllFolders: 'All folders',
  searchSort: { relevance: 'Relevance', date: 'Date' },
  searchResultsLabel: 'Results',
  searchRunning: 'Searching…',
  searchNoHits: 'No results.',
  searchCount: (n, truncated) => `${count(n, 'result')}${truncated ? ' (the first 500 local results are shown; narrow the search)' : ''}`,
  searchHeadersOnly: n =>
    n === 1
      ? '1 message is older than its account’s indexing limit: in it, only the sender, recipients and subject are searched, unless it was already opened. You can search its text with the buttons below.'
      : `${count(n, 'message')} are older than their account’s indexing limit: in these, only the sender, recipients and subject are searched, except for the ones already opened. You can search their text with the buttons below.`,
  searchOnServer: 'Search on the server too',
  searchOnServerHelp: '(in the text of older IMAP messages; the server’s search is usually not accent-insensitive)',
  searchInOld: 'Search the text of old messages too',
  searchCancel: 'Cancel',
  searchFoundOnServer: 'found on the server',
  searchFoundInOld: 'found in an old message',
  searchServerProgress: p => (p && p.total ? `Searching on the server: ${num(p.done)} / ${count(p.total, 'folder')}${p.folder ? ` (${p.account}: ${p.folder})` : ''}` : 'Searching on the server…'),
  searchPop3Progress: p => (p && p.total ? `Searching old messages: ${num(p.done)} / ${count(p.total, 'message')}` : 'Searching old messages…'),
  searchServerDone: f =>
    `${f.cancelled ? 'Server search cancelled' : 'Server search finished'}: ${count(f.hits, 'new result')}` +
    (f.errors && f.errors.length ? `; failed: ${f.errors.map(e => `${e.account} (${en.searchError(e.code)})`).join(', ')}` : '') +
    (f.failedFolders && f.failedFolders.length ? `; the server refused the search in ${count(f.failedFolders.length, 'folder')}` : '') +
    (f.error ? '; unexpected error' : ''),
  // the sync texts end in "retrying…"; a search is not retried on its own
  searchError: code => (en.readerErrors[code] || en.syncError(code)).replace(/[;,]?\s*retrying…$/, ''),
  searchPop3Done: f =>
    `${f.cancelled ? 'Search in old messages cancelled' : 'Search in old messages finished'}: ${count(f.hits, 'new result')}` +
    (f.skipped ? `; the file of ${count(f.skipped, 'message')} is missing or damaged, skipped` : '') +
    (f.error ? '; unexpected error' : ''),
  // opening is not retried on its own: no "retrying…" (searchError strips it)
  readerError: code => en.searchError(code),
  sizeKb: bytes => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`),
  // the main process's file dialogs: the filter names
  fileFilterText: 'Text',
  fileFilterContacts: 'Contacts (.vcf, .csv)',
  contactsExportBase: 'ShadowMail-contacts',
  sourceFileFallback: 'message',
  attachmentFallback: 'attachment',
  // the word typed to confirm a full reset without the code (the label and the error above show it)
  resetConfirmWord: 'DELETE',
  // the OUTGOING reply / forward: the line above the quote and the forwarded block's header (goes to the recipient)
  outgoingQuote: {
    wrote: header => `${header} wrote:`,
    forwarded: '---------- Forwarded message ----------',
    labels: { from: 'From', date: 'Date', subject: 'Subject', to: 'To', cc: 'Cc' },
  },
}
