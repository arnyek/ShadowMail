// The sizes of the test mailbox's messages, read only. Not part of `npm test`.
//   node test/live/live-sizes.mjs <test account .env> [--top 10] [--download 5 --to <empty local folder>]
// The lockout rules of live-lib.mjs: a pre-flight without login, ONE login (the first rejection ends the process).
// Every folder is opened read-only (EXAMINE); FETCH asks for the size and the structure only; --download fetches the
// sources of the N biggest (BODY.PEEK: no \Seen) into files named 1.eml ... N.eml. Printed: the folder, the uid, the size,
// html / plain, the number of image parts. Never a subject, a sender or a word of the message.
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { loadEnv, preflight, sideClient } from './live-lib.mjs'

const { values, positionals } = parseArgs({ allowPositionals: true, options: { top: { type: 'string', default: '10' }, download: { type: 'string', default: '0' }, to: { type: 'string' } } })
const env = loadEnv(positionals[0])
const N = Number(values.download)
if (N > 0 && (!values.to || !fs.existsSync(values.to) || fs.readdirSync(values.to).length)) throw new Error('--download needs --to <an existing EMPTY folder>')
await preflight(env)
const c = await sideClient(env)
const shape = node => {
  const out = { html: false, plain: false, images: 0 }
  const walk = n => {
    if (!n) return
    const t = String(n.type || '').toLowerCase()
    if (t === 'text/html') out.html = true
    if (t === 'text/plain') out.plain = true
    if (t.startsWith('image/')) out.images++
    for (const x of n.childNodes || []) walk(x)
  }
  walk(node)
  return out
}
const all = []
try {
  for (const f of await c.list()) {
    if ((f.flags && f.flags.has('\\Noselect')) || f.specialUse === '\\All') continue
    const lock = await c.getMailboxLock(f.path, { readOnly: true })
    try {
      if (!c.mailbox.exists) continue
      for await (const m of c.fetch('1:*', { uid: true, size: true, bodyStructure: true })) all.push({ folder: f.path, uid: m.uid, size: m.size, ...shape(m.bodyStructure) })
    } finally {
      lock.release()
    }
  }
  all.sort((a, b) => b.size - a.size)
  console.log(`${all.length} messages; over 100 KB: ${all.filter(m => m.size > 100 * 1024).length}`)
  for (const m of all.slice(0, Number(values.top))) console.log(`${m.folder} uid=${m.uid} ${Math.round(m.size / 1024)} KB ${m.html ? 'html' : m.plain ? 'plain' : 'other'} images=${m.images}`)
  for (const [i, m] of all.slice(0, N).entries()) {
    const lock = await c.getMailboxLock(m.folder, { readOnly: true })
    try {
      const msg = await c.fetchOne(String(m.uid), { uid: true, source: true }, { uid: true })
      fs.writeFileSync(path.join(values.to, `${i + 1}.eml`), msg.source)
      console.log(`downloaded ${i + 1}.eml (${Math.round(msg.source.length / 1024)} KB)`)
    } finally {
      lock.release()
    }
  }
} finally {
  await c.logout()
}
