// SPDX-License-Identifier: GPL-3.0-or-later
// A minimal IMAP server on a real TCP socket, for the real imapflow client: greeting, CAPABILITY, LOGIN, NAMESPACE,
// LIST / LSUB (the folders with their flags), STATUS (MESSAGES), EXAMINE / SELECT, UID SEARCH ALL, UID FETCH (UID FLAGS),
// UID STORE +FLAGS / -FLAGS (and .SILENT), SUBSCRIBE / UNSUBSCRIBE (kept in `subscribed`), RENAME (the folder and the
// ones under it; like the measured live server it does NOT carry a subscription along), NOOP, LOGOUT; every other
// command answers OK. Enough for a LIST + STATUS + a sync, so a test sees what imapflow's own list() makes of a folder
// set (its SPECIAL-USE from the name, its pick between two names). A folder's `mail` ([{ uid, flags, source? }]) are
// messages with UID and flags (no envelope): an app whose index already holds rows with these UIDs (a seeded data
// folder) syncs their flags and can STORE on them; a sync that sees a NEW UID would ask for its envelope, which this
// server does not have. A message with a `source` (a Buffer) also answers UID FETCH BODY.PEEK[] / BODY[] with it (the
// non-PEEK form sets \Seen, as a real server does).
// Every command line is kept in `log` (the tests check that the sync only reads: no SELECT, STORE, APPEND, ...).
import net from 'node:net'

/** Modified UTF-7 (RFC 3501 5.1.3), as a server sends a non-ASCII folder name. */
/** The modified UTF-7 of a mailbox name back to a string (RFC 3501 5.1.3). */
function unmutf7(s) {
  return s.replace(/&([^-]*)-/g, (_, b) => {
    if (!b) return '&'
    const buf = Buffer.from(b.replace(/,/g, '/'), 'base64')
    let out = ''
    for (let k = 0; k + 1 < buf.length; k += 2) out += String.fromCharCode(buf.readUInt16BE(k))
    return out
  })
}

export function mutf7(s) {
  return s.replace(/&/g, '&-').replace(/[^\x20-\x7e]+/g, run => {
    const b = Buffer.alloc(run.length * 2)
    for (let i = 0; i < run.length; i++) b.writeUInt16BE(run.charCodeAt(i), i * 2)
    return `&${b.toString('base64').replace(/=+$/, '').replace(/\//g, ',')}-`
  })
}

/**
 * folders: [{ path, flags?: ['\\Sent', ...], messages?: n (STATUS), mail?: [{ uid, flags: [..] }], uidValidity?: 7,
 * permanentFlags?: [..] (SELECT's PERMANENTFLAGS; default the system flags and \\*; null = none sent) }];
 * specialUse: announce the SPECIAL-USE capability;
 * subscribed: the paths LSUB lists (default: every folder); lsub: 'no' answers LSUB with a tagged NO (imapflow takes that
 * as transient and says "subscribed" of every folder); status: 'ok', 'hang' or 'slow:<ms>' (also setStatus(mode)).
 * -> { port, log, subscribed (a live Set), setLsub(mode), setStatus(mode), flagsOf(path, uid), setFlags(path, uid, flags),
 * close() }
 */
export async function startImapWire({ folders, delimiter = '.', specialUse = false, subscribed = null, lsub = 'ok', status = 'ok' }) {
  let statusMode = status
  const subs = new Set(subscribed || folders.map(f => f.path))
  let lsubMode = lsub
  const caps = `IMAP4rev1 LITERAL+ NAMESPACE${specialUse ? ' SPECIAL-USE' : ''}`
  const byWire = new Map(folders.map(f => [mutf7(f.path), f]))
  const log = []
  const sockets = new Set()
  const unquote = s => (s.startsWith('"') ? s.slice(1, -1).replace(/\\(.)/g, '$1') : s)
  const DEFAULT_PERMANENT = ['\\Answered', '\\Flagged', '\\Deleted', '\\Seen', '\\Draft', '\\*']
  // the messages per folder path: Map uid -> Set of flags
  const boxes = new Map(folders.map(f => [f.path, new Map((f.mail || []).map(m => [m.uid, new Set(m.flags || [])]))]))
  const sources = new Map(folders.map(f => [f.path, new Map((f.mail || []).filter(m => m.source).map(m => [m.uid, m.source]))]))
  const uidsOf = path => [...boxes.get(path).keys()].sort((a, b) => a - b)
  const inSet = (set, uids) => {
    const max = uids.length ? uids[uids.length - 1] : 0
    const want = new Set()
    for (const part of set.split(',')) {
      const [a, b] = part.split(':').map(x => (x === '*' ? max : Number(x)))
      const [lo, hi] = b === undefined ? [a, a] : [Math.min(a, b), Math.max(a, b)]
      for (const u of uids) if (u >= lo && u <= hi) want.add(u)
    }
    return uids.filter(u => want.has(u))
  }
  const flagList = set => `(${[...set].join(' ')})`
  const server = net.createServer(socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    socket.write(`* OK [CAPABILITY ${caps}] wire IMAP ready\r\n`)
    let buf = ''
    let selected = null // { path, readOnly }
    socket.on('data', chunk => {
      buf += chunk.toString('latin1')
      let i
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 2)
        const m = /^(\S+) (?:UID )?(\S+)(?: (.*))?$/i.exec(line)
        if (!m) continue
        const [, tag, cmd, rest = ''] = m
        const c = cmd.toUpperCase()
        log.push(/^LOGIN$/i.test(c) ? 'LOGIN' : line.slice(tag.length + 1))
        const ok = text => socket.write(`${tag} OK ${text}\r\n`)
        if (c === 'CAPABILITY') socket.write(`* CAPABILITY ${caps}\r\n${tag} OK done\r\n`)
        else if (c === 'LOGIN') ok(`[CAPABILITY ${caps}] logged in`)
        else if (c === 'NAMESPACE') socket.write(`* NAMESPACE (("" "${delimiter}")) NIL NIL\r\n${tag} OK done\r\n`)
        else if (c === 'LIST') {
          for (const f of folders) {
            const flags = ['\\HasNoChildren', ...(specialUse ? f.flags || [] : [])]
            socket.write(`* LIST (${flags.join(' ')}) "${delimiter}" "${mutf7(f.path)}"\r\n`)
          }
          ok('LIST done')
        } else if (c === 'RENAME') {
          const mm = /^("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/.exec(rest.trim())
          const from = mm && byWire.get(unquote(mm[1]))
          const toPath = mm && unmutf7(unquote(mm[2]))
          if (!from) socket.write(`${tag} NO Mailbox doesn't exist\r\n`)
          else if (folders.some(f => f.path === toPath)) socket.write(`${tag} NO [ALREADYEXISTS] Target mailbox already exists\r\n`)
          else {
            const old = from.path
            for (const f of folders.filter(x => x.path === old || x.path.startsWith(old + delimiter))) {
              const np = toPath + f.path.slice(old.length)
              byWire.delete(mutf7(f.path))
              boxes.set(np, boxes.get(f.path))
              boxes.delete(f.path)
              f.path = np
              byWire.set(mutf7(np), f)
            }
            ok('RENAME done')
          }
        } else if (c === 'LSUB') {
          if (lsubMode === 'no') socket.write(`${tag} NO LSUB not now\r\n`)
          else {
            for (const f of folders) if (subs.has(f.path)) socket.write(`* LSUB () "${delimiter}" "${mutf7(f.path)}"\r\n`)
            ok('LSUB done')
          }
        } else if (c === 'SUBSCRIBE' || c === 'UNSUBSCRIBE') {
          const f = byWire.get(unquote(rest.trim()))
          // UNSUBSCRIBE also takes a name without a folder (a stale subscription; the live server does)
          if (c === 'SUBSCRIBE') f && subs.add(f.path)
          else subs.delete(f ? f.path : unmutf7(unquote(rest.trim())))
          ok(`${c} done`)
        } else if (c === 'STATUS' && statusMode === 'hang') {
          // the command is taken and never answered
        } else if (c === 'STATUS' && statusMode.startsWith('slow:')) {
          const name = unquote(rest.slice(0, rest.lastIndexOf(' (')))
          const f = byWire.get(name)
          setTimeout(() => socket.write(`* STATUS "${name}" (MESSAGES ${(f && f.messages) || 0})\r\n${tag} OK STATUS done\r\n`), Number(statusMode.slice(5)))
        } else if (c === 'STATUS') {
          const name = unquote(rest.slice(0, rest.lastIndexOf(' (')))
          const f = byWire.get(name)
          if (!f) socket.write(`${tag} NO no such mailbox\r\n`)
          else socket.write(`* STATUS "${name}" (MESSAGES ${f.mail ? f.mail.length : f.messages || 0})\r\n${tag} OK STATUS done\r\n`)
        } else if (c === 'EXAMINE' || c === 'SELECT') {
          const name = unquote(/^("(?:[^"\\]|\\.)*"|\S+)/.exec(rest)[1])
          if (!byWire.has(name)) socket.write(`${tag} NO no such mailbox\r\n`)
          else {
            const f = byWire.get(name)
            const uids = uidsOf(f.path)
            const perm = f.permanentFlags === undefined ? DEFAULT_PERMANENT : f.permanentFlags
            selected = { path: f.path, readOnly: c === 'EXAMINE' }
            socket.write('* FLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft)\r\n')
            if (c === 'SELECT' && perm) socket.write(`* OK [PERMANENTFLAGS (${perm.join(' ')})] ok\r\n`)
            socket.write(`* ${uids.length} EXISTS\r\n* OK [UIDVALIDITY ${f.uidValidity || 7}] ok\r\n* OK [UIDNEXT ${(uids[uids.length - 1] || 0) + 1}] ok\r\n`)
            ok(`[${c === 'EXAMINE' ? 'READ-ONLY' : 'READ-WRITE'}] ${c} done`)
          }
        } else if (c === 'SEARCH') {
          socket.write(`* SEARCH${selected ? uidsOf(selected.path).map(u => ` ${u}`).join('') : ''}\r\n${tag} OK SEARCH done\r\n`)
        } else if (c === 'FETCH' && selected) {
          const uids = uidsOf(selected.path)
          const set = rest.split(' ')[0]
          const body = /BODY(\.PEEK)?\[\]/i.exec(rest)
          for (const u of inSet(set, uids)) {
            const flags = boxes.get(selected.path).get(u)
            const src = body && sources.get(selected.path).get(u)
            if (!src) {
              socket.write(`* ${uids.indexOf(u) + 1} FETCH (UID ${u} FLAGS ${flagList(flags)})\r\n`)
              continue
            }
            if (!body[1] && !selected.readOnly) flags.add('\\Seen')
            socket.write(`* ${uids.indexOf(u) + 1} FETCH (UID ${u} FLAGS ${flagList(flags)} BODY[] {${src.length}}\r\n`)
            socket.write(src)
            socket.write(')\r\n')
          }
          ok('FETCH done')
        } else if (c === 'STORE' && selected) {
          const sm = /^(\S+) ([+-])FLAGS(\.SILENT)? \(([^)]*)\)$/i.exec(rest)
          if (!sm || selected.readOnly) socket.write(`${tag} NO store refused\r\n`)
          else {
            const uids = uidsOf(selected.path)
            const flags = sm[4].split(' ').filter(Boolean)
            for (const u of inSet(sm[1], uids)) {
              const set = boxes.get(selected.path).get(u)
              for (const fl of flags) sm[2] === '+' ? set.add(fl) : set.delete(fl)
              if (!sm[3]) socket.write(`* ${uids.indexOf(u) + 1} FETCH (UID ${u} FLAGS ${flagList(set)})\r\n`)
            }
            ok('STORE done')
          }
        }
        else if (c === 'LOGOUT') {
          socket.write(`* BYE bye\r\n${tag} OK LOGOUT done\r\n`)
          socket.end()
        } else ok(`${c} done`)
      }
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    port: server.address().port,
    log,
    subscribed: subs,
    setLsub: mode => {
      lsubMode = mode
    },
    // STATUS: 'ok', 'hang' (taken, never answered) or 'slow:<ms>'
    setStatus: mode => {
      statusMode = mode
    },
    flagsOf: (path, uid) => [...boxes.get(path).get(uid)],
    // another client changes a message's flags (seen by the next sync)
    setFlags: (path, uid, flags) => boxes.get(path).set(uid, new Set(flags)),
    close: () =>
      new Promise(resolve => {
        for (const s of sockets) s.destroy()
        server.close(() => resolve())
      }),
  }
}
