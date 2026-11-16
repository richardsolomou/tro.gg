export type SpacetimeConnection = {
  /** Origin of the SpacetimeDB host. Plain HTTP is accepted only for loopback or `internalHost`. */
  url: string
  database: string
  token: string
  /** Sent with every request, such as Cloudflare Access service-token headers. */
  headers?: Record<string, string>
  /** A container name on a private network, such as `spacetime`, that may be reached over plain HTTP. */
  internalHost?: string
  /** Replaces the global `fetch`, such as in a test of code that calls the database. */
  fetch?: typeof fetch
}

// Scripts load this file with Node's type stripping, which rejects parameter properties.
export class SpacetimeRequestError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
    this.name = 'SpacetimeRequestError'
  }
}

// Not `loopback` from `middleware.ts`: publish scripts import this file outside Vite, where the middleware cannot load.
const loopback = (hostname: string) => hostname === 'localhost' || hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(hostname)

export function spacetimeDatabaseUrl(connection: Pick<SpacetimeConnection, 'url' | 'database' | 'internalHost'>, path = '') {
  const base = new URL(connection.url)
  const internal = /^[a-z][a-z0-9-]{1,63}$/.test(connection.internalHost ?? '') && base.hostname === connection.internalHost
  const local = base.protocol === 'http:' && (loopback(base.hostname) || internal)
  if ((!local && base.protocol !== 'https:') || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
    throw new Error('Invalid SpacetimeDB URL')
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(connection.database)) throw new Error('Invalid SpacetimeDB database name')
  return new URL(`/v1/database/${connection.database}${path}`, base)
}

/** Calls a reducer or procedure with JSON arguments, as the connection's token. A procedure's result is the response body. */
export async function callSpacetime(connection: SpacetimeConnection, name: string, args: unknown[], timeoutMs = 10_000) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('Invalid SpacetimeDB procedure name')
  return request(connection, spacetimeDatabaseUrl(connection, `/call/${name}`), name, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
    timeoutMs,
  })
}

/** `spacetime-environment` publish headers, which SpacetimeDB stores with the module and keeps across later publishes. */
export function moduleEnvironmentHeaders(environment: Record<string, string>): [string, string][] {
  return Object.entries(environment).map(([key, value]) => {
    // A bare header value is visible ASCII without quotes, commas, or backslashes.
    if (!/^[!#-&(-+\--[\]-~]+$/.test(value)) throw new Error(`Invalid ${key} for the module environment`)
    return ['spacetime-environment', `${key}=${value}`]
  })
}

export type PublishOptions = {
  /** Declared on first publish; SpacetimeDB keeps it, so later publishes may omit it. */
  environment?: Record<string, string>
  /** Accept an automatic migration that changes the schema in ways existing clients cannot read. */
  breakClients?: boolean
  timeoutMs?: number
}

/**
 * Publishes a bundled JavaScript module through SpacetimeDB's migration planner: a missing database is created, an
 * automatic migration is applied, and a migration that needs manual steps, or would break clients unasked, is refused
 * before anything changes.
 */
export async function publishSpacetimeModule(
  connection: SpacetimeConnection,
  bundle: Uint8Array<ArrayBuffer>,
  options: PublishOptions = {},
) {
  const timeoutMs = options.timeoutMs ?? 90_000
  const binary = { 'content-type': 'application/octet-stream' }
  const plan = await request(connection, spacetimeDatabaseUrl(connection, '/pre_publish?host_type=Js'), 'pre_publish', {
    method: 'POST',
    headers: binary,
    body: bundle,
    timeoutMs,
    allowNotFound: true,
  })
  const query = new URLSearchParams({ host_type: 'Js' })
  if (plan.status !== 404) {
    const result = (await plan.json()) as {
      AutoMigrate?: { token: string; break_clients: boolean }
      ManualMigrate?: { reason: string }
    }
    if (result.ManualMigrate) throw new Error(`SpacetimeDB database needs a manual migration: ${result.ManualMigrate.reason}`)
    if (!result.AutoMigrate) throw new Error('SpacetimeDB returned an unknown migration plan')
    if (result.AutoMigrate.break_clients) {
      if (!options.breakClients) throw new Error('SpacetimeDB migration would break existing clients; pass breakClients to accept it')
      query.set('policy', 'BreakClients')
      query.set('token', result.AutoMigrate.token)
    }
  }
  await request(connection, spacetimeDatabaseUrl(connection, `?${query}`), 'publish', {
    method: 'PUT',
    headers: [...Object.entries(binary), ...moduleEnvironmentHeaders(options.environment ?? {})],
    body: bundle,
    timeoutMs,
  })
}

/** Deletes the database; one that does not exist counts as already deleted, so preview cleanup can run repeatedly. */
export async function deleteSpacetimeDatabase(connection: SpacetimeConnection, timeoutMs = 15_000) {
  await request(connection, spacetimeDatabaseUrl(connection), 'delete', { method: 'DELETE', headers: {}, timeoutMs, allowNotFound: true })
}

async function request(
  connection: SpacetimeConnection,
  url: URL,
  operation: string,
  init: { method: string; headers: HeadersInit; body?: BodyInit; timeoutMs: number; allowNotFound?: boolean },
) {
  const headers = new Headers(init.headers)
  for (const [name, value] of Object.entries(connection.headers ?? {})) headers.set(name, value)
  headers.set('authorization', `Bearer ${connection.token}`)
  const response = await (connection.fetch ?? fetch)(url, {
    method: init.method,
    headers,
    ...(init.body === undefined ? {} : { body: init.body }),
    // A redirect would resend the bearer token to wherever it points.
    redirect: 'manual',
    signal: AbortSignal.timeout(init.timeoutMs),
  })
  if (response.ok || (init.allowNotFound && response.status === 404)) return response
  throw new SpacetimeRequestError(
    response.status,
    `SpacetimeDB ${operation} failed with HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`,
  )
}
