import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { publishSpacetimeModule, type SpacetimeConnection } from './spacetime'

/**
 * Repeats the whole plan and publish when a request got no answer, as when an upload stalls in a tunnel. Planning again
 * accounts for a publish that did land, and a migration the server refused is not asked twice.
 */
export async function retryingStalls(publish: () => Promise<void>, attempts = 3, retryMs = 5_000) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await publish()
    } catch (error) {
      const stalled = error instanceof Error && (error.name === 'TimeoutError' || error instanceof TypeError)
      if (!stalled || attempt === attempts) throw error
      await delay(retryMs)
    }
  }
}

function required(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

/** The connection from `SPACETIME_*` variables, with Cloudflare Access service-token headers when the server sits behind Access. */
export function connectionFromEnvironment(): SpacetimeConnection {
  const clientId = process.env.SPACETIME_ACCESS_CLIENT_ID
  const clientSecret = process.env.SPACETIME_ACCESS_CLIENT_SECRET
  return {
    url: required('SPACETIME_URL'),
    database: required('SPACETIME_DATABASE'),
    token: required('SPACETIME_TOKEN'),
    ...(clientId && clientSecret ? { headers: { 'CF-Access-Client-Id': clientId, 'CF-Access-Client-Secret': clientSecret } } : {}),
  }
}

if (import.meta.main) {
  const bundle = await readFile(process.argv[2] ?? 'spacetimedb/dist/bundle.js')
  const connection = connectionFromEnvironment()
  await retryingStalls(() => publishSpacetimeModule(connection, bundle, { breakClients: process.env.SPACETIME_BREAK_CLIENTS === 'true' }))
  console.log(`Published the module to ${connection.database}`)
}
