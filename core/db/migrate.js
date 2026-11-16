// SPDX-License-Identifier: GPL-3.0-or-later
// Migration runner. The current version lives in the one-row `schema_version` table.
// Before migrating a database that already has a schema, a consistent copy is written next to it:
// <file>.bak-<old version> (VACUUM INTO, works with WAL). A brand-new database has nothing to back up.
// The app runs this in a worker thread (upgrade.js), so the main process stays responsive meanwhile.
import fs from 'node:fs'
import path from 'node:path'

export function currentVersion(db) {
  const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'").get()
  if (!hasTable) return 0
  const row = db.prepare('SELECT version FROM schema_version').get()
  return row ? row.version : 0
}

export function backupPath(file, version) {
  return `${file}.bak-${version}`
}

/**
 * Removes the leftovers of a backup copy that did not finish: <file>.bak-<N>.tmp and its -journal / -wal /
 * -shm, for any N. A kill, a closed window or a full disk during the copy leaves them; they are the program's own and
 * nobody else knows about them (left in place they would eat the free space the next copy needs).
 */
export function removeBackupLeftovers(file) {
  const dir = path.dirname(file)
  const re = new RegExp(`^${path.basename(file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.bak-\\d+\\.tmp(-journal|-wal|-shm)?$`)
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const removed = names.filter(n => re.test(n))
  for (const n of removed) fs.rmSync(path.join(dir, n), { force: true })
  return removed
}

/**
 * Applies the pending migrations in order. `file` is the database path (null or ':memory:' = no backup).
 * Returns { from, to, backup } where backup is the copy's path or null.
 */
export function migrate(db, migrations, { file = null } = {}) {
  const ordered = [...migrations].sort((a, b) => a.version - b.version)
  ordered.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`migrations must be numbered 1..n without gaps (found ${m.version} at ${i + 1})`)
  })
  const from = currentVersion(db)
  const target = ordered.length
  if (from > target) throw new Error(`database schema ${from} is newer than this program (${target})`)
  if (from === target) return { from, to: from, backup: null }

  let backup = null
  if (from > 0 && file && file !== ':memory:') {
    backup = backupPath(file, from)
    // written under a temporary name and renamed when complete: a run stopped during the copy leaves
    // a .tmp (removed by the next run), never a half .bak-N that looks like a backup
    const tmp = `${backup}.tmp`
    // with its rollback journal (VACUUM INTO writes one; a kill leaves it, measured on Windows)
    removeBackupLeftovers(file)
    try {
      db.prepare('VACUUM INTO ?').run(tmp)
    } catch (err) {
      // e.g. SQLITE_FULL: the partial copy must not stay and eat the space of the next try
      removeBackupLeftovers(file)
      throw err
    }
    fs.renameSync(tmp, backup)
  }

  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)')
  for (const m of ordered.slice(from)) {
    db.transaction(() => {
      m.up(db)
      db.prepare('DELETE FROM schema_version').run()
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(m.version)
    })()
  }
  return { from, to: target, backup }
}
