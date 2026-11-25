// A replied or forwarded message shows its mark at the start of the row's text cell, in the list and in the search
// hits: a reply icon for \Answered, a forward icon for $Forwarded (any case, as a server may write them), both in that
// order, nothing without them; the words in the title and for a screen reader, in both languages.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupDom, mount } from './helpers/react-dom-env.js'

setupDom()
const { createElement: h } = await import('react')
const { RowText, replyMarks } = await import('../app/renderer/src/RowText.jsx')
const { hu } = await import('../app/renderer/i18n/hu.js')
const { en } = await import('../app/renderer/i18n/en.js')

const row = flags => ({ id: 1, from_addr: 'a@example.invalid', subject: 'Tárgy', date: Date.UTC(2026, 10, 25), has_attachments: 0, flags })

test('replyMarks: \\Answered and $Forwarded, in any case, as whole flags only', () => {
  assert.deepEqual(replyMarks('\\Seen \\Answered'), { answered: true, forwarded: false })
  assert.deepEqual(replyMarks('\\Seen $Forwarded'), { answered: false, forwarded: true })
  assert.deepEqual(replyMarks('$Forwarded \\Answered \\Seen'), { answered: true, forwarded: true })
  assert.deepEqual(replyMarks('\\ANSWERED $forwarded'), { answered: true, forwarded: true }, 'flags and keywords are case-insensitive')
  assert.deepEqual(replyMarks('\\Seen \\Flagged'), { answered: false, forwarded: false })
  assert.deepEqual(replyMarks('$ForwardedX \\AnsweredY Answered'), { answered: false, forwarded: false }, 'a longer or bare word is no flag')
  assert.deepEqual(replyMarks(''), { answered: false, forwarded: false })
  assert.deepEqual(replyMarks(null), { answered: false, forwarded: false })
})

test('the row: the icons in order at the start of the text cell, their words in the title and for a screen reader', async () => {
  const marksOf = async (flags, extra = {}) => {
    const { container } = await mount(h('div', null, h(RowText, { m: row(flags), ...extra })))
    const text = container.querySelector('.col-text')
    const marks = text.querySelector('.reply-marks')
    return {
      first: text.firstElementChild === marks,
      icons: marks ? [...marks.querySelectorAll('svg')].map(s => s.getAttribute('data-icon')) : [],
      title: marks ? marks.getAttribute('title') : null,
      hidden: marks ? marks.querySelector('.sr-only').textContent : null,
      inMain: Boolean(container.querySelector('.col-main .reply-marks')),
      textCopy: marks ? marks.classList.contains('reply-marks-text') : null,
      // the sender cell's copy (shown by app.css in a narrow row instead of this one): the same marks, first there
      fromCopy: (() => {
        const from = container.querySelector('.col-from')
        const c = from.querySelector('.reply-marks-from')
        return c ? { first: from.firstElementChild === c, icons: [...c.querySelectorAll('svg')].map(s => s.getAttribute('data-icon')), title: c.getAttribute('title'), hidden: c.querySelector('.sr-only').textContent } : null
      })(),
      copies: container.querySelectorAll('.reply-marks').length,
    }
  }
  const replied = await marksOf('\\Seen \\Answered')
  assert.deepEqual(replied.icons, ['reply'])
  assert.equal(replied.first, true, 'the first thing in the text cell')
  assert.equal(replied.inMain, false, 'outside .col-main (the label group measures the room it has)')
  assert.equal(replied.title, hu.replyMarks.answered)
  assert.equal(replied.hidden, hu.replyMarks.answered)
  assert.equal(replied.textCopy, true)
  assert.equal(replied.copies, 2, 'two copies: the text cell and the sender cell (app.css shows one)')
  assert.deepEqual(replied.fromCopy, { first: true, icons: ['reply'], title: hu.replyMarks.answered, hidden: hu.replyMarks.answered })
  const forwarded = await marksOf('$Forwarded')
  assert.deepEqual(forwarded.icons, ['forward'])
  assert.equal(forwarded.title, hu.replyMarks.forwarded)
  const both = await marksOf('$Forwarded \\Answered')
  assert.deepEqual(both.icons, ['reply', 'forward'], 'the reply first, then the forward')
  assert.equal(both.title, hu.replyMarks.both)
  assert.deepEqual(both.fromCopy, { first: true, icons: ['reply'], title: hu.replyMarks.both, hidden: hu.replyMarks.both },
    'before the sender one icon (the name keeps the room), the words still both')
  assert.deepEqual(forwarded.fromCopy && forwarded.fromCopy.icons, ['forward'], 'a forward alone keeps its icon there')
  const none = await marksOf('\\Seen')
  assert.deepEqual(none.icons, [])
  assert.equal(none.title, null, 'no mark without the flags')
  assert.equal(none.copies, 0)
  // the list passes its own flags (a change not yet in m.flags): they win
  const listFlags = await marksOf('\\Seen', { flags: '\\Seen \\Answered' })
  assert.deepEqual(listFlags.icons, ['reply'])
  // the Sent / Drafts recipient cell has the sender cell's copy too
  const recipient = await marksOf('\\Answered', { recipient: true })
  assert.deepEqual(recipient.fromCopy && recipient.fromCopy.icons, ['reply'])
})

test('the words in both languages', () => {
  assert.deepEqual(hu.replyMarks, { answered: 'Megválaszolva', forwarded: 'Továbbítva', both: 'Megválaszolva és továbbítva' })
  assert.deepEqual(en.replyMarks, { answered: 'Replied', forwarded: 'Forwarded', both: 'Replied and forwarded' })
})

// a flag another client set (another mail program, the webmail): the sync brings it into the row, the marks follow
test('a flag set on the server by another client: \\Answered, then $Forwarded, in the row after the sync', async t => {
  const { memoryIndex, addAccount, DAY } = await import('./helpers/fixtures.js')
  const { FakeImapServer } = await import('./helpers/fake-imap.js')
  const { SyncManager } = await import('../app/main/sync-manager.js')
  const { onCleanup } = await import('./helpers/tmp.js')
  const NOW = Date.UTC(2026, 10, 25, 12, 0, 0)
  const { db, index } = memoryIndex(t)
  const account = addAccount(db)
  const server = new FakeImapServer().addMailbox('INBOX')
  server.addMessage('INBOX', { from: 'k@example.invalid', to: 'en@example.invalid', subject: 'Kérdés', messageId: '<q1@x>', date: NOW - DAY, body: 'Szöveg' })
  const manager = new SyncManager({
    store: { list: () => db.prepare('SELECT * FROM accounts ORDER BY id').all(), getRow: id => db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) },
    index,
    notify: () => {},
    connect: () => server.connect(),
    now: () => NOW,
    throttleMs: 5,
    syncerOptions: { retryDelaysMs: [30, 30] },
    idleOptions: { retryDelaysMs: [30], debounceMs: 10 },
  })
  onCleanup(t, () => manager.stopAll())
  const flagsNow = () => index.listFolder({ accountId: account.id, folder: 'INBOX', limit: 10 })[0]?.flags ?? null
  const until = async (fn, ms = 3000) => {
    const t0 = performance.now()
    while (!fn()) {
      if (performance.now() - t0 > ms) throw new Error('timed out waiting')
      await new Promise(r => setTimeout(r, 5))
    }
  }
  manager.startAll()
  await until(() => manager.entries.get(account.id)?.idle?.connected && flagsNow() !== null)
  assert.deepEqual(replyMarks(flagsNow()), { answered: false, forwarded: false })
  server.setFlags('INBOX', 1, ['\\Seen', '\\Answered'])
  await until(() => replyMarks(flagsNow()).answered)
  assert.deepEqual(replyMarks(flagsNow()), { answered: true, forwarded: false }, flagsNow())
  server.setFlags('INBOX', 1, ['\\Seen', '\\Answered', '$Forwarded'])
  await until(() => replyMarks(flagsNow()).forwarded)
  assert.deepEqual(replyMarks(flagsNow()), { answered: true, forwarded: true }, flagsNow())
})
