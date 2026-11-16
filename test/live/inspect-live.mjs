// Read-only look at the test mailbox: capabilities, namespace, folders (delimiter, special-use, counts).
//   node test/live/inspect-live.mjs <test account .env>
// Opens nothing for writing (STATUS only), changes no flag.
import { loadEnv, preflight, sideClient } from './live-lib.mjs'

const env = loadEnv(process.argv[2])
await preflight(env)
const c = await sideClient(env)
console.log('capabilities:', [...c.capabilities.keys()].sort().join(' '))
console.log('namespace:', JSON.stringify(c.namespace))
for (const f of await c.list({ statusQuery: { messages: true, unseen: true, uidValidity: true } })) {
  console.log(`folder ${JSON.stringify(f.path)} delim=${JSON.stringify(f.delimiter)} special=${f.specialUse || '-'} flags=${[...f.flags].join(',')} messages=${f.status?.messages} unseen=${f.status?.unseen}`)
}
await c.logout()
