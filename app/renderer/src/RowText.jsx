// SPDX-License-Identifier: GPL-3.0-or-later
// The text cells of a message row: sender, subject + " – " + preview (or a search
// snippet), attachment, date. The message list (MessageRow) and the search hits use the same cells,
// so the two lists look and read the same.
import { t } from '../i18n/index.js'
import { Icon } from './Icon.jsx'
import { formatFullDate, formatListDate } from './list-format.js'
import { recipientLabel } from '../../../core/mime/recipient-label.js'
import { RowChips } from './LabelChip.jsx'
import { rowChips } from './label-chips.js'

/**
 * m: the row (from_name, from_addr, subject, date, has_attachments); `preview`: a string or a node
 * (the highlighted snippet); `before`: nodes in front of the subject (the hit's account/folder chip);
 * `subjectClass` / `previewClass`: extra hooks (the search's .result-subject / .result-snippet).
 * `recipient`: the Sent and Drafts lists show the recipient in the sender's cell ("Name +2", RecipientCell).
 * `flags`: the row's flags as shown (the list's own, with a pending change); without it m.flags.
 */
// a draft Claude made carries this IMAP keyword (POP3: the local flags)
const CLAUDE_KEYWORD = '$shadowmailclaude'
export const isClaudeDraft = m => (m.flags || '').toLowerCase().split(' ').includes(CLAUDE_KEYWORD)

/** The replied / forwarded marks of a row's flags (\\Answered, $Forwarded; any case, as a server may write them). */
export function replyMarks(flags) {
  const set = new Set((flags || '').toLowerCase().split(' '))
  return { answered: set.has('\\answered'), forwarded: set.has('$forwarded') }
}

const hasReplyMarks = flags => {
  const { answered, forwarded } = replyMarks(flags)
  return answered || forwarded
}

/**
 * The mark: ONE icon (the reply; a forward alone: the forward), at the sender cell's right end in a fixed place
 * (app.css .has-reply-marks), so the labels and the subject start at the same x in every row; its words (with both flags
 * both of them) in the title and once for a screen reader.
 */
function ReplyMarks({ flags }) {
  const { answered, forwarded } = replyMarks(flags)
  if (!answered && !forwarded) return null
  const words = answered && forwarded ? t.replyMarks.both : answered ? t.replyMarks.answered : t.replyMarks.forwarded
  return (
    <span className="reply-marks" title={words}>
      <Icon name={answered ? 'reply' : 'forward'} />
      <span className="sr-only">{words}</span>
    </span>
  )
}

const fmtAddress = a => (a.name ? `${a.name} <${a.address}>` : a.address)

/**
 * The recipient in the sender's place: the first To (with an empty To the first Cc, then Bcc), its name or, without one,
 * its address, and "+N" for the others; the name is cut, the count never. The tooltip lists them all.
 */
function RecipientCell({ m, Cell, cellProps, flags }) {
  const r = recipientLabel(m)
  const className = `col-from col-recipient${hasReplyMarks(flags) ? ' has-reply-marks' : ''}`
  if (!r) return <Cell {...cellProps} className={className} data-recipient="none">{t.noRecipient}<ReplyMarks flags={flags} /></Cell>
  return (
    <Cell {...cellProps} className={className} data-recipient="" title={r.all.map(fmtAddress).join(', ')}>
      <span className="recipient-name">{r.name || r.address}</span>
      {r.more ? <span className="recipient-more">{` +${r.more}`}</span> : null}
      <ReplyMarks flags={flags} />
    </Cell>
  )
}

export function RowText({ m, preview, before = null, subjectClass = '', previewClass = '', cell = 'div', recipient = false, labels = null, labelList = null, flags = m.flags }) {
  const Cell = cell
  const sender = m.from_name || m.from_addr || t.unknownSender
  const cellProps = cell === 'div' ? { role: 'gridcell' } : {}
  const labelIds = labelList ? (labels ?? m.labels) : null
  const labelTitle = labelList ? rowChips(labelIds, labelList).title : ''
  return (
    <>
      {recipient ? (
        <RecipientCell m={m} Cell={Cell} cellProps={cellProps} flags={flags} />
      ) : (
        <Cell {...cellProps} className={`col-from${hasReplyMarks(flags) ? ' has-reply-marks' : ''}`} title={m.from_addr || undefined}>
          {sender}
          <ReplyMarks flags={flags} />
        </Cell>
      )}
      {/* the cell's tooltip names the labels in every form of the group (in the narrowest the group is not drawn) */}
      <Cell {...cellProps} className="col-text" title={labelTitle ? t.labels.group(labelTitle) : undefined}>
        {before}
        {/* the labels, the subject and the preview in their own box: the labels' form comes from ITS width (what is left
            after the search hit's account / folder tag), app.css @container msg-text */}
        <span className="col-main">
        {labelList ? <RowChips ids={labelIds} list={labelList} /> : null}
        {isClaudeDraft(m) ? <span className="claude-mark" title={t.claudeMarkTitle}>{t.claudeMark}</span> : null}
        <span className={`col-subject${subjectClass ? ` ${subjectClass}` : ''}`}>{m.subject || t.noSubject}</span>
        {preview ? (
          <span className={`col-preview${previewClass ? ` ${previewClass}` : ''}`}>
            <span className="col-sep"> – </span>
            {preview}
          </span>
        ) : null}
        </span>
      </Cell>
      <Cell {...cellProps} className="col-attachment">{m.has_attachments ? <Icon name="attachment" label={t.hasAttachment} /> : null}</Cell>
      <Cell {...cellProps} className="col-date" title={formatFullDate(m.date) || undefined}>{formatListDate(m.date)}</Cell>
    </>
  )
}
