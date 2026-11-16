// SPDX-License-Identifier: GPL-3.0-or-later
// Log lines carry no mail content, address, subject, file name or search word. An error is
// named by its code, never by its message: an SMTP refusal quotes the recipient's address, ENOENT the
// path of the attachment, a parser error a piece of the message.
export const errCode = err => (err && (err.code || err.name)) || 'error'
