// SPDX-License-Identifier: GPL-3.0-or-later
// The text cells of a message row: sender, subject + " – " + preview (or a search
// snippet), attachment, date. The message list (MessageRow) and the search hits use the same cells,
// so the two lists look and read the same.
import { t } from '../i18n/index.js'
import { Icon } from './Icon.jsx'
import { formatFullDate, formatListDate } from './list-format.js'
import { recipientLabel } from '../../../core/mime/recipient-label.js'

/**
 * m: the row (from_name, from_addr, subject, date, has_attachments); `preview`: a string or a node
 * (the highlighted snippet); `before`: nodes in front of the subject (the hit's account/folder chip);
 * `subjectClass` / `previewClass`: extra hooks (the search's .result-subject / .result-snippet).
 * `recipient`: the Sent and Drafts lists show the recipient in the sender's cell ("Name +2", RecipientCell).
 */
// a draft Claude made carries this IMAP keyword (POP3: the local flags)
const CLAUDE_KEYWORD = '$shadowmailclaude'
export const isClaudeDraft = m => (m.flags || '').toLowerCase().split(' ').includes(CLAUDE_KEYWORD)

const fmtAddress = a => (a.name ? `${a.name} <${a.address}>` : a.address)

/**
 * The recipient in the sender's place: the first To (with an empty To the first Cc, then Bcc), its name or, without one,
 * its address, and "+N" for the others; the name is cut, the count never. The tooltip lists them all.
 */
function RecipientCell({ m, Cell, cellProps }) {
  const r = recipientLabel(m)
  if (!r) return <Cell {...cellProps} className="col-from col-recipient" data-recipient="none">{t.noRecipient}</Cell>
  return (
    <Cell {...cellProps} className="col-from col-recipient" data-recipient="" title={r.all.map(fmtAddress).join(', ')}>
      <span className="recipient-name">{r.name || r.address}</span>
      {r.more ? <span className="recipient-more">{` +${r.more}`}</span> : null}
    </Cell>
  )
}

export function RowText({ m, preview, before = null, subjectClass = '', previewClass = '', cell = 'div', recipient = false }) {
  const Cell = cell
  const sender = m.from_name || m.from_addr || t.unknownSender
  const cellProps = cell === 'div' ? { role: 'gridcell' } : {}
  return (
    <>
      {recipient ? (
        <RecipientCell m={m} Cell={Cell} cellProps={cellProps} />
      ) : (
        <Cell {...cellProps} className="col-from" title={m.from_addr || undefined}>{sender}</Cell>
      )}
      <Cell {...cellProps} className="col-text">
        {before}
        {isClaudeDraft(m) ? <span className="claude-mark" title={t.claudeMarkTitle}>{t.claudeMark}</span> : null}
        <span className={`col-subject${subjectClass ? ` ${subjectClass}` : ''}`}>{m.subject || t.noSubject}</span>
        {preview ? (
          <span className={`col-preview${previewClass ? ` ${previewClass}` : ''}`}>
            <span className="col-sep"> – </span>
            {preview}
          </span>
        ) : null}
      </Cell>
      <Cell {...cellProps} className="col-attachment">{m.has_attachments ? <Icon name="attachment" label={t.hasAttachment} /> : null}</Cell>
      <Cell {...cellProps} className="col-date" title={formatFullDate(m.date) || undefined}>{formatListDate(m.date)}</Cell>
    </>
  )
}
