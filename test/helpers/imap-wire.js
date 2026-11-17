// SPDX-License-Identifier: GPL-3.0-or-later
// A minimal IMAP server on a real TCP socket, for the real imapflow client: greeting, CAPABILITY, LOGIN, NAMESPACE,
// LIST / LSUB (the folders with their flags), STATUS (MESSAGES), EXAMINE / SELECT, UID SEARCH (empty folders only),
// SUBSCRIBE / UNSUBSCRIBE (kept in `subscribed`), NOOP, LOGOUT; every other command answers OK. Enough for a LIST + STATUS + a sync of empty folders, so a test sees
// what imapflow's own list() makes of a folder set (its SPECIAL-USE from the name, its pick between two names).
// Every command line is kept in `log` (the tests check that the sync only reads: no SELECT, STORE, APPEND, ...).
import net from 'node:net'

/** Modified UTF-7 (RFC 3501 5.1.3), as a server sends a non-ASCII folder name. */
export function mutf7(s) {
  return s.replace(/&/g, '&-').replace(/[^\x20-\x7e]+/g, run => {
    const b = Buffer.alloc(run.length * 2)
    for (let i = 0; i < run.length; i++) b.writeUInt16BE(run.charCodeAt(i), i * 2)
    return `&${b.toString('base64').replace(/=+$/, '').replace(/\//g, ',')}-`
  })
}

/**
 * folders: [{ path, flags?: ['\\Sent', ...], messages?: n }]; specialUse: announce the SPECIAL-USE capability;
 * subscribed: the paths LSUB lists (default: every folder); lsub: 'no' answers LSUB with a tagged NO (imapflow takes that
 * as transient and says "subscribed" of every folder). -> { port, log, subscribed (a live Set), setLsub(mode), close() }
 */
export async function startImapWire({ folders, delimiter = '.', specialUse = false, subscribed = null, lsub = 'ok' }) {
  const subs = new Set(subscribed || folders.map(f => f.path))
  let lsubMode = lsub
  const caps = `IMAP4rev1 LITERAL+ NAMESPACE${specialUse ? ' SPECIAL-USE' : ''}`
  const byWire = new Map(folders.map(f => [mutf7(f.path), f]))
  const log = []
  const sockets = new Set()
  const unquote = s => (s.startsWith('"') ? s.slice(1, -1).replace(/\\(.)/g, '$1') : s)
  const server = net.createServer(socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    socket.write(`* OK [CAPABILITY ${caps}] wire IMAP ready\r\n`)
    let buf = ''
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
        } else if (c === 'LSUB') {
          if (lsubMode === 'no') socket.write(`${tag} NO LSUB not now\r\n`)
          else {
            for (const f of folders) if (subs.has(f.path)) socket.write(`* LSUB () "${delimiter}" "${mutf7(f.path)}"\r\n`)
            ok('LSUB done')
          }
        } else if (c === 'SUBSCRIBE' || c === 'UNSUBSCRIBE') {
          const f = byWire.get(unquote(rest.trim()))
          if (f) c === 'SUBSCRIBE' ? subs.add(f.path) : subs.delete(f.path)
          ok(`${c} done`)
        } else if (c === 'STATUS') {
          const name = unquote(rest.slice(0, rest.lastIndexOf(' (')))
          const f = byWire.get(name)
          if (!f) socket.write(`${tag} NO no such mailbox\r\n`)
          else socket.write(`* STATUS "${name}" (MESSAGES ${f.messages || 0})\r\n${tag} OK STATUS done\r\n`)
        } else if (c === 'EXAMINE' || c === 'SELECT') {
          const name = unquote(/^("(?:[^"\\]|\\.)*"|\S+)/.exec(rest)[1])
          if (!byWire.has(name)) socket.write(`${tag} NO no such mailbox\r\n`)
          else {
            socket.write('* FLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft)\r\n* 0 EXISTS\r\n* OK [UIDVALIDITY 7] ok\r\n* OK [UIDNEXT 1] ok\r\n')
            ok(`[${c === 'EXAMINE' ? 'READ-ONLY' : 'READ-WRITE'}] ${c} done`)
          }
        } else if (c === 'SEARCH') socket.write(`* SEARCH\r\n${tag} OK SEARCH done\r\n`)
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
    close: () =>
      new Promise(resolve => {
        for (const s of sockets) s.destroy()
        server.close(() => resolve())
      }),
  }
}
