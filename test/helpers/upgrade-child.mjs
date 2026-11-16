// Child process of test/upgrade.test.js: runs the schema upgrade of an encrypted database so that
// the test can kill it mid-way (SIGKILL), like a user closing the program from the task manager.
//
//   node upgrade-child.mjs <file> <key hex> backup      the real migrations (the backup copy is the long part)
//   node upgrade-child.mjs <file> <key hex> slow <mark>  the real migrations + a slow version N+1 that writes <mark>
//                                                       when it starts, then works for a long time inside its transaction
import fs from 'node:fs'
import { openMailDatabase } from '../../core/db/index.js'
import { MIGRATIONS } from '../../core/db/schema.js'

const [file, keyHex, mode, mark] = process.argv.slice(2)
const key = Buffer.from(keyHex, 'hex')
const slow = {
  version: MIGRATIONS.length + 1,
  up: db => {
    db.exec('CREATE TABLE slow_step (n INTEGER, b BLOB)')
    fs.writeFileSync(mark, 'started')
    const ins = db.prepare('INSERT INTO slow_step (n, b) VALUES (?, randomblob(4096))')
    for (let i = 0; i < 50_000_000; i++) ins.run(i)
  },
}
const { db } = openMailDatabase(file, { key, migrations: mode === 'slow' ? [...MIGRATIONS, slow] : MIGRATIONS })
db.close()
console.log('finished')
