// SPDX-License-Identifier: GPL-3.0-or-later
// One account's body phase at a time: the SyncManager gives every Syncer and Pop3Fetcher the same gate, and the body
// phase holds it for one batch of pending rows (IMAP 500, POP3 200), then lets it go. Two accounts' parses and writes
// on the main thread never interleave (measured before: "bodies+bodies" in the probe), and another account's new
// message (a targeted run) waits at most one batch. First come, first served. The metadata phase, LIST, the account
// list and IDLE do not go through it.
//
// acquire() -> { ready, cancel }: `ready` resolves with a release function, or with null when cancel() came first
// (a stopped sync: the caller throws its SyncStopped). cancel() on a held lease lets the gate go at once (a stopped run
// may sit in a network wait; the next account must not wait for it); a later release() is then a no-op.
export class BodyGate {
  #held = null // the lease that holds the gate
  #queue = [] // waiting leases, in order

  acquire() {
    const lease = { resolve: null, done: false }
    const ready = new Promise(resolve => (lease.resolve = resolve))
    const release = () => {
      if (lease.done) return
      lease.done = true
      if (this.#held === lease) {
        this.#held = null
        this.#next()
      }
    }
    lease.release = release
    if (!this.#held) {
      this.#held = lease
      lease.resolve(release)
    } else this.#queue.push(lease)
    return {
      ready,
      cancel: () => {
        if (lease.done) return
        const i = this.#queue.indexOf(lease)
        if (i !== -1) {
          this.#queue.splice(i, 1)
          lease.done = true
          lease.resolve(null)
          return
        }
        release()
      },
    }
  }

  #next() {
    const lease = this.#queue.shift()
    if (!lease) return
    this.#held = lease
    lease.resolve(lease.release)
  }

  /** tests and measurements: is it held, and how many wait */
  state() {
    return { held: Boolean(this.#held), waiting: this.#queue.length }
  }
}
