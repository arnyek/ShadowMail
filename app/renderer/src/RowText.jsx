// SPDX-License-Identifier: GPL-3.0-or-later
// The text cells of a message row: sender, subject + " – " + preview (or a search
// snippet), attachment, date. The message list (MessageRow) and the search hits use the same cells,
// so the two lists look and read the same.
import { t } from '../i18n/index.js'
import { Icon } from './Icon.jsx'
import { formatFullDate, formatListDate } from './list-format.js'

/**
 * m: the row (from_name, from_addr, subject, date, has_attachments); `preview`: a string or a node
 * (the highlighted snippet); `before`: nodes in front of the subject (the hit's account/folder chip);
 * `subjectClass` / `previewClass`: extra hooks (the search's .result-subject / .result-snippet).
 */
// a draft Claude made carries this IMAP keyword (POP3: the local flags)
const CLAUDE_KEYWORD = '$shadowmailclaude'
export const isClaudeDraft = m => (m.flags || '').toLowerCase().split(' ').includes(CLAUDE_KEYWORD)

export function RowText({ m, preview, before = null, subjectClass = '', previewClass = '', cell = 'div' }) {
  const Cell = cell
  const sender = m.from_name || m.from_addr || t.unknownSender
  const cellProps = cell === 'div' ? { role: 'gridcell' } : {}
  return (
    <>
      <Cell {...cellProps} className="col-from" title={m.from_addr || undefined}>{sender}</Cell>
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
