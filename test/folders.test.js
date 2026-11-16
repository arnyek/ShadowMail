// Folder roles and the folder tree: special-use and name based roles, order, nesting.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assignRoles, buildFolderTree, flattenTree } from '../core/imap/folders.js'
import { listSyncFolders } from '../core/imap/client.js'
import { FakeImapServer } from './helpers/fake-imap.js'

const f = (path, extra = {}) => ({ path, delimiter: '/', special_use: null, count: 0, unread: 0, ...extra })
const shape = tree => flattenTree(tree).map(({ node, depth }) => `${'  '.repeat(depth)}${node.role || node.name}${node.selectable ? '' : ' (-)'}`)

test('roles: SPECIAL-USE first, then the usual names; one folder per role; INBOX by name', () => {
  const roles = assignRoles([
    f('INBOX'),
    f('Elküldött elemek'),
    f('Sent Items', { special_use: '\\Sent' }),
    f('Trash'),
    f('Spam'),
    f('Projects/Archive'), // not top level: no role
    f('Archívum'),
    f('Drafts', { special_use: '\\Drafts' }),
  ])
  assert.equal(roles.get('INBOX'), 'inbox')
  assert.equal(roles.get('Sent Items'), 'sent', 'the SPECIAL-USE flag wins')
  assert.equal(roles.get('Elküldött elemek'), undefined)
  assert.equal(roles.get('Trash'), 'trash')
  assert.equal(roles.get('Spam'), 'junk')
  assert.equal(roles.get('Archívum'), 'archive')
  assert.equal(roles.get('Projects/Archive'), undefined)
  assert.equal(roles.get('Drafts'), 'drafts')
})

test('tree: role folders on top in the fixed order (Beérkezett, Piszkozatok, Elküldött, Kuka, Levélszemét, Archívum), then the rest alphabetically', () => {
  const tree = buildFolderTree([
    f('Zöldség'),
    f('Archive', { special_use: '\\Archive' }),
    f('Junk', { special_use: '\\Junk' }),
    f('INBOX', { unread: 3, count: 10 }),
    f('Trash', { special_use: '\\Trash' }),
    f('Sent', { special_use: '\\Sent' }),
    f('Drafts', { special_use: '\\Drafts' }),
    f('Ügyfelek/Bp'),
    f('Ügyfelek'),
    f('alma'),
    f('Ábel'),
  ])
  assert.deepEqual(shape(tree), [
    'inbox', 'drafts', 'sent', 'trash', 'junk', 'archive',
    'Ábel', 'alma', 'Ügyfelek', '  Bp', 'Zöldség',
  ])
  assert.equal(tree[0].unread, 3)
  assert.equal(tree[0].count, 10)
})

test('cPanel style: everything under INBOX with "." delimiter; roles come up to the top, the rest stays under INBOX', () => {
  const d = path => f(path, { delimiter: '.' })
  const tree = buildFolderTree([d('INBOX'), d('INBOX.Sent'), d('INBOX.Trash'), d('INBOX.spam'), d('INBOX.Drafts'), d('INBOX.Számlák'), d('INBOX.Számlák.2025')])
  assert.deepEqual(shape(tree), ['inbox', '  Számlák', '    2025', 'drafts', 'sent', 'trash', 'junk'])
})

test('a parent that is not a folder of its own becomes a non-selectable placeholder', () => {
  const tree = buildFolderTree([f('INBOX'), f('Régi/2019'), f('Régi/2020')])
  assert.deepEqual(shape(tree), ['inbox', 'Régi (-)', '  2019', '  2020'])
})

test('sync folder list: trash and junk are synced (shown in the tree), Gmail "All Mail" is not', async () => {
  const server = new FakeImapServer()
    .addMailbox('INBOX')
    .addMailbox('[Gmail]/All Mail', { specialUse: '\\All' })
    .addMailbox('[Gmail]/Trash', { specialUse: '\\Trash' })
    .addMailbox('[Gmail]/Spam', { specialUse: '\\Junk' })
  const paths = (await listSyncFolders(server.client(), { skipJunkTrash: false })).map(x => x.path)
  assert.deepEqual(paths, ['INBOX', '[Gmail]/Trash', '[Gmail]/Spam'])
  const old = (await listSyncFolders(server.client())).map(x => x.path)
  assert.deepEqual(old, ['INBOX'], 'the original default still skips them')
})
