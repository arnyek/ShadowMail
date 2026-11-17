// SPDX-License-Identifier: GPL-3.0-or-later
// Account defaults and unit conversions. Pure (no Node imports): the renderer bundles this file too.

export const SECURITY = Object.freeze(['tls', 'starttls', 'none'])
export const ACCOUNT_TYPES = Object.freeze(['imap', 'pop3'])
export const DEFAULT_INDEX_YEARS = 3
export const MAX_INDEX_YEARS = 50
const DAYS_PER_YEAR = 365 // the UI shows years; the leap-day error is ignored on purpose

/** Default port for a protocol and security mode (IMAP 993/143, POP3 995/110, SMTP 465/587). */
export function defaultPort(protocol, security) {
  if (protocol === 'imap') return security === 'tls' ? 993 : 143
  if (protocol === 'pop3') return security === 'tls' ? 995 : 110
  if (protocol === 'smtp') return security === 'tls' ? 465 : 587
  throw new Error(`unknown protocol ${protocol}`)
}

/** What the editor starts with for a new account of the given type. */
export function newAccountDefaults(type = 'imap') {
  return {
    type,
    name: '',
    email: '',
    display_name: '',
    in_host: '',
    in_security: 'tls',
    in_port: defaultPort(type, 'tls'),
    in_user: '',
    smtp_host: '',
    smtp_security: 'tls',
    smtp_port: defaultPort('smtp', 'tls'),
    smtp_user: '',
    smtp_same_password: true,
    tls_verify: true,
    index_years: DEFAULT_INDEX_YEARS,
    sync_interval_min: 5,
    save_sent_to_server: true,
    pop3_delete_after_days: null,
    signature: '',
    archive_mode: '',
  }
}

/** 'all' -> 0 days, N years -> N * 365 days. */
export function yearsToDays(years) {
  return years === 'all' ? 0 : years * DAYS_PER_YEAR
}

/** 0 -> 'all'; otherwise whole years (values not written by the UI are rounded, at least 1). */
export function daysToYears(days) {
  if (!days) return 'all'
  return Math.max(1, Math.round(days / DAYS_PER_YEAR))
}

/**
 * A saved account (accounts:list row) as the editor's form (Accounts.jsx), the payload of accounts:test and
 * accounts:save: the 0/1 columns as booleans, passwords empty (only "stored" flags exist). MCP test_account uses it
 * too (the raw row's 0 must not be read as "on": that once sent the incoming password to SMTP).
 */
export function accountEditorForm(account) {
  return {
    id: account.id,
    type: account.type,
    name: account.name,
    email: account.email,
    display_name: account.display_name || '',
    in_host: account.in_host,
    in_port: account.in_port,
    in_security: account.in_security,
    in_user: account.in_user,
    in_password: '',
    smtp_host: account.smtp_host || '',
    smtp_port: account.smtp_port || defaultPort('smtp', 'tls'),
    smtp_security: account.smtp_security || 'tls',
    smtp_user: account.smtp_user || '',
    smtp_same_password: Boolean(account.smtp_same_password),
    smtp_password: '',
    tls_verify: Boolean(account.tls_verify),
    index_years: account.index_years,
    sync_interval_min: account.sync_interval_min,
    save_sent_to_server: Boolean(account.save_sent_to_server),
    pop3_delete_after_days: account.pop3_delete_after_days,
    signature: account.signature || '',
    archive_mode: account.archive_mode || '',
  }
}
