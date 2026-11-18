// The link-target bar's logic: the real target, the registered domain, the visible text that shows an
// address, punycode; and the sanitizer's link list it is fed with. The bar in the real app: test/e2e/link-target-e2e.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { domainToASCII, domainToUnicode } from 'node:url'
import { JSDOM } from 'jsdom'
import createDOMPurify from 'dompurify'
import { sanitizeMail, MAX_LINKS } from '../app/renderer/src/sanitize.js'
import { addressOfText, asciiHost, linkKey, linkTarget, linkTexts, registeredDomain, matchFor, unicodeHost } from '../app/renderer/src/link-target.js'

const purify = createDOMPurify(new JSDOM('').window)
const warned = (url, text) => linkTarget(url, [text]).mismatch

test('registered domain: two labels, or three under a listed two-level suffix; an IP is itself', () => {
  assert.equal(registeredDomain('login.otpbank.hu'), 'otpbank.hu')
  assert.equal(registeredDomain('otpbank.hu'), 'otpbank.hu')
  assert.equal(registeredDomain('a.b.c.example.com'), 'example.com')
  assert.equal(registeredDomain('news.bbc.co.uk'), 'bbc.co.uk')
  assert.equal(registeredDomain('www.shop.com.au'), 'shop.com.au')
  assert.equal(registeredDomain('x.ceg.co.hu'), 'ceg.co.hu')
  assert.equal(registeredDomain('co.uk'), 'co.uk')
  assert.equal(registeredDomain('192.168.1.10'), '192.168.1.10')
  assert.equal(registeredDomain('Example.COM.'), 'example.com')
})

test('the text as an address: URL, bare domain, domain with path, e-mail; not a sentence or a file name', () => {
  assert.equal(addressOfText('otpbank.hu'), 'otpbank.hu')
  assert.equal(addressOfText('www.otpbank.hu/belepes'), 'www.otpbank.hu')
  assert.equal(addressOfText('https://www.otpbank.hu/belepes?x=1'), 'www.otpbank.hu')
  assert.equal(addressOfText('HTTPS://OTPBANK.HU'), 'otpbank.hu')
  assert.equal(addressOfText('info@bank.example.org'), 'bank.example.org')
  assert.equal(addressOfText('mailto:info@bank.example.org'), 'bank.example.org')
  assert.equal(addressOfText('(www.otpbank.hu).'), 'www.otpbank.hu')
  assert.equal(addressOfText('otpbank.hu:8443/x'), 'otpbank.hu')
  assert.equal(addressOfText('ötpbank.hu'), 'xn--tpbank-vxa.hu', 'a Unicode domain in its ASCII form')
  for (const text of ['Kattints ide', 'Belépés', 'szamla.pdf', 'Report.DOCX', 'v1.2', 'info@localhost', 'a b.hu', '', 'ftp', 'javascript:alert(1)', 'https://']) {
    assert.equal(addressOfText(text), null, text)
  }
  assert.equal(addressOfText('www.szamla.pdf'), 'www.szamla.pdf', 'with www. it is a domain')
})

test('mismatch: same domain and subdomain are not, another registered domain is', () => {
  assert.equal(warned('https://www.otpbank.hu/', 'otpbank.hu'), null, 'same domain')
  assert.equal(warned('https://login.otpbank.hu/belepes', 'www.otpbank.hu/belepes'), null, 'subdomain')
  assert.equal(warned('https://OTPBANK.hu./x', 'otpbank.hu'), null, 'case and trailing dot')
  assert.equal(warned('https://otpbank-login.example.com/', 'otpbank.hu'), 'otpbank.hu', 'other domain')
  assert.equal(warned('https://otpbank.hu.evil.example.net/', 'https://www.otpbank.hu/'), 'www.otpbank.hu', 'the domain as a subdomain')
  assert.equal(warned('https://otpbank-login.example.com/', 'Kattints ide'), null, 'text not an address')
  assert.equal(warned('https://news.bbc.co.uk/', 'bbc.co.uk'), null, 'two-level suffix, same')
  assert.equal(warned('https://bbc-news.co.uk/', 'bbc.co.uk'), 'bbc.co.uk', 'two-level suffix, other')
  assert.equal(warned('https://cdn.example.net/szamla.pdf', 'szamla.pdf'), null, 'a file name')
  assert.equal(warned('mailto:support@evil.example.com', 'info@example.org'), 'example.org', 'mailto vs an address in the text')
  assert.equal(warned('mailto:info@example.org', 'info@example.org'), null, 'mailto, same')
  // several links with the same target: one showing another domain is enough
  assert.equal(linkTarget('https://evil.example.com/', ['Kattints ide', 'otpbank.hu']).mismatch, 'otpbank.hu')
})

test('punycode: shown in both forms; a Latin-letter text against it is a mismatch, the same Unicode text is not', () => {
  const host = domainToASCII('ötpbank.hu')
  const info = linkTarget(`https://${host}/belepes`, ['otpbank.hu'])
  assert.equal(info.host, host)
  assert.equal(info.unicode, 'ötpbank.hu')
  assert.equal(info.mismatch, 'otpbank.hu')
  assert.equal(linkTarget(`https://${host}/`, ['Belépés']).mismatch, null)
  assert.equal(linkTarget(`https://${host}/`, ['Belépés']).unicode, 'ötpbank.hu')
  assert.equal(linkTarget(`https://${host}/`, ['ötpbank.hu']).mismatch, null)
  assert.equal(linkTarget('https://otpbank.hu/', ['otpbank.hu']).unicode, null)
  // homograph: Cyrillic letters that look Latin
  const cyr = domainToASCII('аррle.com')
  assert.equal(linkTarget(`https://${cyr}/`, ['apple.com']).mismatch, 'apple.com')
})

test('unicodeHost decodes like node:url; a broken xn-- label stays as it is', () => {
  for (const name of ['ötpbank.hu', 'münchen.de', '例え.jp', 'пример.рф', 'ăâîșț.ro', 'sub.árvíztűrő.hu']) {
    const ascii = domainToASCII(name)
    assert.equal(unicodeHost(ascii), domainToUnicode(ascii), name)
  }
  assert.equal(unicodeHost('xn--a.com'), 'xn--a.com')
  assert.equal(unicodeHost('xn--zzzzzzzzzzzzzzzzzzzzzzz.com'), 'xn--zzzzzzzzzzzzzzzzzzzzzzz.com')
  assert.equal(unicodeHost('plain.example.com'), 'plain.example.com')
})

test('the parts the bar draws: scheme, the user part of a "user@host" URL, sub, domain, the rest', () => {
  assert.deepEqual(linkTarget('https://login.otpbank.hu:8443/a/b?c=1#d', []), {
    kind: 'web', scheme: 'https://', user: '', sub: 'login.', domain: 'otpbank.hu', rest: ':8443/a/b?c=1#d', host: 'login.otpbank.hu', unicode: null, mismatch: null,
  })
  const trick = linkTarget('https://otpbank.hu:jelszo@evil.example.org/login', ['otpbank.hu'])
  assert.equal(trick.user, 'otpbank.hu:***@', 'the password never shows')
  assert.equal(trick.domain, 'example.org')
  assert.equal(trick.mismatch, 'otpbank.hu')
  const mail = linkTarget('mailto:J%C3%A1nos@Example.COM?subject=x', [])
  assert.equal(mail.kind, 'mailto')
  assert.equal(mail.user, 'János@')
  assert.equal(mail.domain, 'example.com')
  assert.equal(linkTarget('', []), null)
  assert.equal(linkTarget('nem url', []).kind, 'other')
  assert.equal(linkTarget('ftp://x.example.com/', []).kind, 'other')
})

test('sanitizer: the kept links with their cleaned text, nothing from removed links or content', () => {
  const html = '<p><a href=" https://www.otpbank.hu/ ">otp<b>bank</b>.hu</a> <a href="javascript:alert(1)">rossz</a> ' +
    '<a href="mailto:x@example.org">  írj\n nekünk </a> <a>nincs cél</a> <a href="https://e.example.com/"><script>evil.example.com</script>Kattints</a>' +
    '<map><area href="https://area.example.com/" alt="area.example.com"></map></p>'
  const { links } = sanitizeMail(purify, html, { messageId: 1 })
  assert.deepEqual(links, [
    { href: 'https://www.otpbank.hu/', text: 'otpbank.hu' },
    { href: 'mailto:x@example.org', text: 'írj nekünk' },
    { href: 'https://e.example.com/', text: 'Kattints' },
    { href: 'https://area.example.com/', text: 'area.example.com' },
  ])
  const many = sanitizeMail(purify, '<a href="https://a.example.com/">x</a>'.repeat(MAX_LINKS + 10), { messageId: 1 })
  assert.equal(many.links.length, MAX_LINKS)
  const long = sanitizeMail(purify, `<a href="https://a.example.com/">${'y'.repeat(5000)}</a>`, { messageId: 1 })
  assert.equal(long.links[0].text.length, 300)
})

test('linkTexts: keyed like the status-bar URL (parsed), each text once', () => {
  const map = linkTexts([
    { href: 'https://WWW.Example.com', text: 'a' },
    { href: 'https://www.example.com/', text: 'a' },
    { href: 'https://www.example.com/', text: 'b' },
    { href: 'nem url', text: 'c' },
  ])
  assert.deepEqual(map.get(linkKey('https://www.example.com/')), ['a', 'b'])
  assert.equal(map.size, 1)
  assert.equal(asciiHost('a b'), null)
})

test('linear on hostile texts and URLs', () => {
  const t0 = performance.now()
  for (const text of ['a.'.repeat(50_000), `${'a-'.repeat(50_000)}.hu`, 'x'.repeat(100_000), `${'(' .repeat(50_000)}a.hu`]) addressOfText(text)
  linkTarget(`https://${'a.'.repeat(1000)}example.com/${'p'.repeat(8000)}`, ['a.'.repeat(5000)])
  assert.ok(performance.now() - t0 < 500, `${performance.now() - t0} ms`)
})

test('matchFor: the exact key, or for a cut URL the message\'s own full link; null for a stranger', () => {
  const long = `https://evil.example.com/${'a'.repeat(9000)}`
  const map = linkTexts([
    { href: 'https://www.example.com/', text: 'example.com' },
    { href: long, text: 'otpbank.hu' },
    { href: `${long}b`, text: 'Bank' },
  ])
  assert.deepEqual(matchFor(map, 'https://www.example.com'), { target: 'https://www.example.com', texts: ['example.com'] }, 'parsed like the status-bar URL')
  assert.equal(matchFor(map, 'https://page-link.example.com/'), null)
  assert.deepEqual(matchFor(map, long.slice(0, 8192), true), { target: long, texts: ['otpbank.hu', 'Bank'] }, 'the full link, same host')
  assert.equal(matchFor(map, `https://other.example.com/${'a'.repeat(8000)}`, true), null)
  assert.equal(matchFor(map, long.slice(0, 8192), false), null, 'a cut URL is not an exact key')
})

test('a cut inside the user part never shows a false host: the bar uses the full link', () => {
  // the first 8192 characters end in "...a.a.otpbank.hu": parsed alone, that would be the host
  const spoof = `https://${`aa${'a.'.repeat(4086)}otpbank.hu`.padEnd(8184, 'a')}${'b'.repeat(900)}@evil.example/x`
  const cutAt = spoof.slice(0, 8192)
  assert.ok(cutAt.endsWith('otpbank.hu'), 'the probe is what it claims')
  const match = matchFor(linkTexts([{ href: spoof, text: 'otpbank.hu' }]), cutAt, true)
  const info = linkTarget(match.target, match.texts)
  assert.equal(info.host, 'evil.example')
  assert.equal(info.mismatch, 'otpbank.hu')
  assert.ok(info.user.length <= 48 + 2, `the user part is shortened: ${info.user.length}`)
  assert.ok(info.user.endsWith('b@'))
  const pw = `https://u:${'a.'.repeat(4096)}otpbank.hu${'b'.repeat(900)}@evil.example/x`
  const m2 = matchFor(linkTexts([{ href: pw, text: 'otpbank.hu' }]), pw.slice(0, 8192), true)
  assert.equal(linkTarget(m2.target, m2.texts).host, 'evil.example')
  assert.equal(linkTarget(m2.target, m2.texts).user, 'u:***@', 'the password never shows')
  // two links sharing the cut start but with different hosts: the bar cannot tell which, so no target
  const other = `${spoof.slice(0, 8200)}@other.example/y`
  const both = matchFor(linkTexts([{ href: spoof, text: 'a' }, { href: other, text: 'b' }]), cutAt, true)
  assert.equal(both.target, null)
})
