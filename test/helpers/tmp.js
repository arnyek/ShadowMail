import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// node:test runs t.after() hooks in registration order. Cleanups must run in reverse (close the
// database BEFORE removing its folder): on Windows an open file cannot be deleted (EBUSY).
const stacks = new WeakMap()

/** Registers fn to run when the test ends, last registered first. */
export function onCleanup(t, fn) {
  let stack = stacks.get(t)
  if (!stack) {
    stack = []
    stacks.set(t, stack)
    t.after(async () => {
      const errors = []
      while (stack.length) {
        try {
          await stack.pop()()
        } catch (err) {
          errors.push(err)
        }
      }
      if (errors.length) throw errors[0]
    })
  }
  stack.push(fn)
}

// A fresh temporary folder that is removed when the test `t` finishes, pass or fail.
export function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowmail-test-'))
  onCleanup(t, () => {
    try {
      fs.chmodSync(dir, 0o755)
    } catch {
      // already writable or gone
    }
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return dir
}
