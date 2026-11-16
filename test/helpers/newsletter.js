// a CSS-heavy newsletter like a measured real one (300 style rules, nested tables, a hidden
// preheader, every ninth description display:none). blocks = 2000 -> about 404 KB of HTML.
export function newsletterHtml({ blocks = 2000, hidden = 'rejtettpreheader', visible = 'lathatotermek', rules = 300 } = {}) {
  const css = Array.from({ length: rules }, (_, i) => `.c${i} td.x${i % 17} > a:first-child { color:#${(i * 4111).toString(16).slice(0, 6).padEnd(6, '0')}; font-size:${10 + (i % 8)}px }`).join('\n')
  const block = i =>
    `<table class="c${i % 300}" width="100%"><tr><td class="x${i % 17}" style="padding:4px"><a href="https://example.invalid/${i}">Termék ${i} árvíztűrő ${i === 7 ? visible : ''}</a><div style="display:${i % 9 ? 'block' : 'none'}">leírás ${i} </div></td></tr></table>`
  return `<html><head><style>${css}</style></head><body><div style="display:none;font-size:0;max-height:0">${hidden} előnézeti szöveg</div>${Array.from({ length: blocks }, (_, i) => block(i)).join('')}</body></html>`
}

/** A whole message around it (HTML only, 8 bit, UTF-8). */
export function newsletterEml({ subject = 'Hírlevél', blocks = 2000, hidden, visible, rules, from = 'Hirlevel <hir@example.invalid>' } = {}) {
  return Buffer.from(
    `From: ${from}\r\nTo: t@example.invalid\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${newsletterHtml({ blocks, hidden, visible, rules })}\r\n`,
    'utf8',
  )
}
