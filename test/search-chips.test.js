// the filter chips without a search. No disabled chip, no help
// line; the account / folder chips navigate; the order chip uses the list's own items; the panel state
// becomes the folder list's filter with the same day rule as the search.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupDom, mount, inAct, key } from './helpers/react-dom-env.js'

setupDom()
const { createElement: h } = await import('react')
const { SearchChips, EMPTY_FILTERS, toListFilter, listFilterOn, clearedFilters, leftSearch, toRequest, fromConditions } = await import('../app/renderer/src/Search.jsx')

const folder = (path, extra = {}) => ({ path, delimiter: '/', special_use: null, count: 3, unread: 0, ...extra })
const ACCOUNTS = [
  { id: 1, name: 'Első fiók', folders: [folder('INBOX'), folder('Sent', { special_use: '\\Sent' }), folder('Ügyfelek')] },
  { id: 2, name: 'Második fiók', folders: [folder('Archív'), folder('INBOX')] },
  { id: 3, name: 'Üres fiók', folders: [] },
]
const click = el => inAct(() => el.click())
const press = (el, k) => inAct(() => key(el, k))
const chipByText = (root, start) => [...root.querySelectorAll('button.chip')].find(b => b.textContent.startsWith(start))

test('toListFilter: only the chips that are on, dates as local days (until = the whole day); the rest is not a list filter', () => {
  assert.deepEqual(toListFilter(EMPTY_FILTERS), {})
  assert.equal(listFilterOn(EMPTY_FILTERS), false)
  const f = { ...EMPTY_FILTERS, unread: true, hasAttachment: true, since: '2026-11-01', until: '2026-11-12', accountId: 2, folder: 'X', from: 'anna', sort: 'date' }
  const lf = toListFilter(f)
  assert.deepEqual(Object.keys(lf).sort(), ['before', 'hasAttachment', 'since', 'unread'])
  const req = toRequest('', f)
  assert.equal(lf.since, req.since, 'the same day rule as the search')
  assert.equal(lf.before, req.before)
  assert.equal(lf.before, new Date(2026, 10, 13).getTime(), 'until = up to the next local midnight')
  assert.equal(listFilterOn({ ...EMPTY_FILTERS, from: 'anna' }), false, 'the sender starts a search, it is not a list filter')
  assert.equal(listFilterOn({ ...EMPTY_FILTERS, flagged: true }), true)
  assert.deepEqual(clearedFilters(f), { ...EMPTY_FILTERS, sort: 'date' }, 'every filter off, the search order kept')
  // Esc leaves the search only: its own fields go, the folder filters stay
  const left = leftSearch(f)
  assert.deepEqual(left, { ...EMPTY_FILTERS, unread: true, hasAttachment: true, since: '2026-11-01', until: '2026-11-12' })
  assert.deepEqual(toListFilter(left), lf, 'the folder view is filtered the same way after Esc')
})

test('the next local midnight on DST days (23 / 25 hours), years 0-99 kept, before 1970 = 0 for the list', () => {
  for (const until of ['2026-10-25', '2026-03-29', '2026-11-12']) {
    const [y, m, d] = until.split('-').map(Number)
    const next = new Date(y, m - 1, d + 1).getTime()
    assert.equal(toListFilter({ ...EMPTY_FILTERS, until }).before, next, until)
    assert.equal(toRequest('x', { ...EMPTY_FILTERS, until }).before, next, `${until} (search)`)
  }
  // the year as typed: 0099 is not 1999 (1999 would be a positive time); before 1970 the search gets 0 too, as the list
  // does (search:local refused a negative time with bad_request)
  assert.equal(toRequest('x', { ...EMPTY_FILTERS, since: '0099-01-01' }).since, 0)
  assert.equal(toRequest('x', { ...EMPTY_FILTERS, until: '1960-05-01' }).before, 0)
  assert.equal(toRequest('x', { ...EMPTY_FILTERS, since: '1999-01-01' }).since, new Date(1999, 0, 1).getTime())
  // the list filter never gets a negative time (the IPC refuses it): before 1970 filters like 0
  assert.equal(toListFilter({ ...EMPTY_FILTERS, since: '0099-01-01' }).since, 0)
  assert.equal(toListFilter({ ...EMPTY_FILTERS, until: '0002-11-12' }).before, 0)
  assert.equal(toListFilter({ ...EMPTY_FILTERS, since: '1970-01-01' }).since >= 0, true)
})

test('folder view: no aria-disabled chip and no help line; the filter chips work; account -> its INBOX, folder -> that folder', async t => {
  let filters = EMPTY_FILTERS
  const went = []
  const sortPicks = []
  const render = () =>
    h(SearchChips, {
      accounts: ACCOUNTS,
      filters,
      onChange: f => (filters = f),
      searching: false,
      view: { accountId: 1, folder: 'Sent' },
      onNavigate: sel => went.push(sel),
      listSort: { sort: 'date', dir: 'desc' },
      sortItems: [{ key: 'date', label: 'Rendezés dátum szerint', checked: true, onSelect: () => sortPicks.push('date') }, { key: 'from', label: 'Rendezés feladó szerint', checked: false, onSelect: () => sortPicks.push('from') }],
    })
  const v = await mount(render())
  t.after(v.unmount)
  const root = v.container
  assert.equal(root.querySelectorAll('[aria-disabled]').length, 0)
  assert.equal(root.querySelector('.search-chips-help'), null)

  await click(chipByText(root, 'Olvasatlan'))
  assert.equal(filters.unread, true, 'the Unread chip sets the filter without a search')

  const account = chipByText(root, 'Fiók:')
  assert.equal(account.textContent, 'Fiók: Első fiók')
  assert.equal(account.getAttribute('aria-pressed'), 'false', 'where the list is, not a filter: no check mark')
  await click(account)
  const items = [...root.querySelectorAll('[role="menuitemradio"]')]
  assert.deepEqual(items.map(i => i.textContent), ['Első fiók', 'Második fiók'], 'no "Minden fiók", no account without folders')
  await click(items[1])
  assert.deepEqual(went.at(-1), { accountId: 2, folder: 'INBOX' }, "the account's INBOX, not its first folder")

  const folderChip = chipByText(root, 'Mappa:')
  assert.equal(folderChip.textContent, 'Mappa: Elküldött', 'the role name, as in the tree')
  await click(folderChip)
  const fitems = [...root.querySelectorAll('[role="menuitemradio"]')]
  assert.deepEqual(fitems.map(i => i.textContent), ['Beérkezett (INBOX)', 'Elküldött (Sent)', 'Ügyfelek'])
  assert.equal(fitems[1].getAttribute('aria-checked'), 'true')
  await click(fitems[2])
  assert.deepEqual(went.at(-1), { accountId: 1, folder: 'Ügyfelek' })

  // short on screen ("Dátum" + the direction arrow), the full text as name and tooltip
  const sort = root.querySelector('.sort-chip button.chip')
  assert.equal(sort.textContent, 'Dátum')
  assert.ok(sort.querySelector('[data-icon="sortDesc"]'), 'descending: the down arrow')
  assert.equal(sort.getAttribute('aria-label'), 'Rendezés: Dátum, csökkenő')
  assert.equal(sort.getAttribute('title'), 'Rendezés: Dátum, csökkenő')
  assert.equal(account.getAttribute('title'), 'Fiók: Első fiók', 'the full name in the tooltip (the shown one may be cut)')
  assert.ok(account.querySelector('.chip-value'))
  await press(sort, 'ArrowDown')
  await press(document.activeElement, 'ArrowDown')
  await click(document.activeElement)
  assert.deepEqual(sortPicks, ['from'], "the order chip runs the list's own item")
})

test('with a search the chips are as before: "Minden fiók", the account filter, Relevancia / Dátum', async t => {
  let filters = EMPTY_FILTERS
  const v = await mount(h(SearchChips, { accounts: ACCOUNTS, filters, onChange: f => (filters = f), searching: true, view: { accountId: 1, folder: 'INBOX' } }))
  t.after(v.unmount)
  const root = v.container
  const account = chipByText(root, 'Fiók')
  assert.equal(account.textContent, 'Fiók')
  await click(account)
  assert.deepEqual([...root.querySelectorAll('[role="menuitemradio"]')].map(i => i.textContent), ['Minden fiók', 'Első fiók', 'Második fiók', 'Üres fiók'])
  await click(root.querySelectorAll('[role="menuitemradio"]')[2])
  assert.equal(filters.accountId, 2)
  assert.equal(chipByText(root, 'Rendezés').textContent, 'Rendezés: Relevancia')
})

// Claude's show_search conditions -> the panel state
test('fromConditions: the conditions become the panel\'s fields one to one; a foreign type is the empty value', () => {
  const c = { text: 'számla', accountId: 2, folder: 'Archív', from: 'anna', to: 'bence', since: '2026-01-01', until: '2026-11-30', hasAttachment: true, unread: true, flagged: true, sort: 'date' }
  const f = fromConditions(c)
  assert.deepEqual(f, { accountId: 2, folder: 'Archív', from: 'anna', to: 'bence', since: '2026-01-01', until: '2026-11-30', hasAttachment: true, unread: true, flagged: true, label: null, sort: 'date' })
  assert.deepEqual(Object.keys(f).sort(), Object.keys(EMPTY_FILTERS).sort(), 'exactly the panel\'s fields')
  assert.deepEqual(fromConditions({}), EMPTY_FILTERS)
  assert.deepEqual(fromConditions({ accountId: '2', folder: 5, from: null, since: '2026-1-1', until: 20261130, hasAttachment: 'true', unread: 1, sort: 'subject' }), EMPTY_FILTERS)
  // the request made of it is the one search_messages' conditions make (tools.js indexSearchOf: the same day rule)
  const req = toRequest(c.text, f)
  assert.equal(req.since, new Date(2026, 0, 1).getTime())
  assert.equal(req.before, new Date(2026, 11, 1).getTime())
})

test('a folder without an account, or one the account does not list, is the folder chip\'s value (not "Minden mappa")', async t => {
  for (const [filters, label] of [
    [{ ...EMPTY_FILTERS, folder: 'INBOX' }, 'Mappa: INBOX'],
    [{ ...EMPTY_FILTERS, accountId: 1, folder: 'Nincs-ilyen' }, 'Mappa: Nincs-ilyen'],
    [{ ...EMPTY_FILTERS, accountId: 1, folder: 'Ügyfelek' }, 'Mappa: Ügyfelek'],
  ]) {
    const v = await mount(h(SearchChips, { accounts: ACCOUNTS, filters, onChange: () => {}, searching: true }))
    const chip = chipByText(v.container, 'Mappa')
    assert.ok(chip, `${label}: the chip is there`)
    assert.equal(chip.title, label)
    assert.equal(chip.getAttribute('aria-pressed') === 'true' || chip.classList.contains('active'), true, `${label}: active`)
    await v.unmount()
  }
  // no folder, no account: no folder chip (as before)
  const v = await mount(h(SearchChips, { accounts: ACCOUNTS, filters: EMPTY_FILTERS, onChange: () => {}, searching: true }))
  t.after(v.unmount)
  assert.equal(chipByText(v.container, 'Mappa'), undefined)
})

test('the Label chip: only with labels; a menu of the labels with their color; the pick filters the folder view and the search; off with "any label", Szűrők törlése and Esc-kept', async t => {
  const { t: dict } = await import('../app/renderer/i18n/index.js')
  const LABELS = [{ id: 7, name: 'Számla', color: '#d32f2f' }, { id: 9, name: 'Ügyfél', color: '#fbc02d' }]
  let filters = EMPTY_FILTERS
  const props = (searching, labels) => ({
    accounts: ACCOUNTS, filters, onChange: f => (filters = f), searching, labels,
    view: { accountId: 1, folder: 'INBOX' }, onNavigate: () => {}, listSort: { sort: 'date', dir: 'desc' }, sortItems: [],
  })
  const none = await mount(h(SearchChips, props(false, [])))
  assert.equal(none.container.querySelector('.label-filter-chip'), null, 'no label: no chip')
  await none.unmount()

  const v = await mount(h(SearchChips, props(false, LABELS)))
  t.after(v.unmount)
  const chip = () => v.container.querySelector('.label-filter-chip button.chip')
  assert.equal(chip().textContent, dict.searchFilter.label)
  assert.equal(chip().getAttribute('aria-pressed'), 'false', 'not active without a pick')
  await click(chip())
  const items = [...v.container.querySelectorAll('.label-filter-chip [role="menuitemradio"]')]
  assert.deepEqual(items.map(i => i.textContent), [dict.searchAnyLabel, 'Számla', 'Ügyfél'])
  assert.equal(items[0].querySelector('.label-swatch'), null, '"any label" has no color dot')
  assert.equal(items[1].querySelector('.label-swatch').style.backgroundColor, 'rgb(211, 47, 47)')
  await click(items[2])
  assert.equal(filters.label, 9)
  assert.deepEqual(toListFilter(filters), { label: 9 }, 'the folder view: the list filter')
  assert.equal(listFilterOn(filters), true, 'the chip row stays open, the list says "szűrve"')
  assert.equal(toRequest('szó', filters).label, 9, 'the search request')
  await v.rerender(h(SearchChips, props(false, LABELS)))
  assert.ok(chip().textContent.includes('Ügyfél'), 'the chosen label in the chip')
  assert.equal(chip().getAttribute('aria-pressed'), 'true')
  assert.equal(chip().title, `${dict.searchFilter.label}: Ügyfél`)
  // a chosen label whose list is not loaded (yet): the chip stays, so it can be switched off
  await v.rerender(h(SearchChips, props(true, [])))
  assert.ok(chip(), 'with a pick the chip shows even without labels')
  await v.rerender(h(SearchChips, props(false, LABELS)))
  await click(chip())
  await click(v.container.querySelector('.label-filter-chip [role="menuitemradio"]'))
  assert.equal(filters.label, null, '"any label" switches it off')
  assert.deepEqual(toListFilter(filters), {})
  const on = { ...EMPTY_FILTERS, label: 7, unread: true }
  assert.equal(leftSearch(on).label, 7, 'Esc leaves the search, the folder filter stays')
  assert.equal(clearedFilters(on).label, null, 'Szűrők törlése')
  assert.equal(fromConditions({ label: 7 }).label, null, "Claude's show_search sets no label (yet)")
})
