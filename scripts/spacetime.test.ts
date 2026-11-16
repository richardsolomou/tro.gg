import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  callSpacetime,
  deleteSpacetimeDatabase,
  moduleEnvironmentHeaders,
  publishSpacetimeModule,
  spacetimeDatabaseUrl,
  SpacetimeRequestError,
} from './spacetime'

const connection = { url: 'https://spacetime.example', database: 'app-production', token: 'owner-token' }

afterEach(() => {
  vi.restoreAllMocks()
})

function server(...responses: Response[]) {
  const request = vi.spyOn(globalThis, 'fetch')
  for (const response of responses) request.mockResolvedValueOnce(response)
  return request
}

function sent(request: ReturnType<typeof server>, call = 0) {
  const [url, init] = request.mock.calls[call] ?? []
  return { url: (url as URL).href, method: init?.method, headers: new Headers(init?.headers) }
}

describe('SpacetimeDB database URLs', () => {
  it('builds a database route on an HTTPS origin', () => {
    expect(spacetimeDatabaseUrl(connection, '/sql').href).toBe('https://spacetime.example/v1/database/app-production/sql')
  })

  it.each([
    ['plain HTTP to a public host', { url: 'http://spacetime.example' }, 'Invalid SpacetimeDB URL'],
    ['credentials in the URL', { url: 'https://user:pass@spacetime.example' }, 'Invalid SpacetimeDB URL'],
    ['a path on the origin', { url: 'https://spacetime.example/v1' }, 'Invalid SpacetimeDB URL'],
    ['an unsafe database name', { database: '../other' }, 'Invalid SpacetimeDB database name'],
  ])('rejects %s', (_name, override, message) => {
    expect(() => spacetimeDatabaseUrl({ ...connection, ...override })).toThrow(message)
  })

  it('allows plain HTTP to loopback and to a named internal host', () => {
    expect(spacetimeDatabaseUrl({ ...connection, url: 'http://127.0.0.1:3000' }).origin).toBe('http://127.0.0.1:3000')
    expect(spacetimeDatabaseUrl({ ...connection, url: 'http://spacetime:3000', internalHost: 'spacetime' }).origin).toBe(
      'http://spacetime:3000',
    )
  })

  it('allows plain HTTP to IPv6 loopback', () => {
    expect(spacetimeDatabaseUrl({ ...connection, url: 'http://[::1]:3000' }).origin).toBe('http://[::1]:3000')
  })
})

describe('SpacetimeDB calls', () => {
  it('posts JSON arguments with the bearer token and extra headers', async () => {
    const request = server(Response.json('ok'))
    await callSpacetime({ ...connection, headers: { 'cf-access-client-id': 'client' } }, 'operator_health', [1, 'two'])

    expect({ ...sent(request), body: request.mock.calls[0]?.[1]?.body }).toMatchObject({
      url: 'https://spacetime.example/v1/database/app-production/call/operator_health',
      method: 'POST',
      body: '[1,"two"]',
    })
    expect(Object.fromEntries(sent(request).headers)).toMatchObject({
      authorization: 'Bearer owner-token',
      'cf-access-client-id': 'client',
      'content-type': 'application/json',
    })
  })

  it('throws the HTTP status and a bounded body for a failed call', async () => {
    server(new Response('x'.repeat(1_000), { status: 530 }))
    const failure = await callSpacetime(connection, 'operator_health', []).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(SpacetimeRequestError)
    expect(failure).toMatchObject({ status: 530, message: `SpacetimeDB operator_health failed with HTTP 530: ${'x'.repeat(300)}` })
  })

  it('rejects an unsafe procedure name before sending', async () => {
    const request = server()
    await expect(callSpacetime(connection, '../sql', [])).rejects.toThrow('Invalid SpacetimeDB procedure name')
    expect(request).not.toHaveBeenCalled()
  })
})

describe('module environment headers', () => {
  it('declares one spacetime-environment header per value', () => {
    expect(moduleEnvironmentHeaders({ AUTH_ISSUER: 'https://app.example/api/auth', AUTH_AUDIENCE: 'app' })).toEqual([
      ['spacetime-environment', 'AUTH_ISSUER=https://app.example/api/auth'],
      ['spacetime-environment', 'AUTH_AUDIENCE=app'],
    ])
  })

  it.each([
    ['a comma', 'a,b'],
    ['a quote', 'a"b'],
    ['a space', 'a b'],
  ])('rejects a value containing %s', (_name, value) => {
    expect(() => moduleEnvironmentHeaders({ AUTH_AUDIENCE: value })).toThrow('Invalid AUTH_AUDIENCE')
  })
})

describe('SpacetimeDB module publishing', () => {
  const bundle = new TextEncoder().encode('export {}')

  it('publishes a database that does not exist yet with its environment', async () => {
    const request = server(new Response(null, { status: 404 }), new Response(null, { status: 200 }))
    await publishSpacetimeModule(connection, bundle, { environment: { AUTH_AUDIENCE: 'app' } })

    expect(sent(request, 0)).toMatchObject({
      url: 'https://spacetime.example/v1/database/app-production/pre_publish?host_type=Js',
      method: 'POST',
    })
    expect(sent(request, 1)).toMatchObject({ url: 'https://spacetime.example/v1/database/app-production?host_type=Js', method: 'PUT' })
    expect(sent(request, 1).headers.get('spacetime-environment')).toBe('AUTH_AUDIENCE=app')
  })

  it('applies a compatible automatic migration without a policy', async () => {
    const request = server(Response.json({ AutoMigrate: { token: 'abc', break_clients: false } }), new Response(null, { status: 200 }))
    await publishSpacetimeModule(connection, bundle)

    expect(sent(request, 1).url).toBe('https://spacetime.example/v1/database/app-production?host_type=Js')
  })

  it('sends the migration token when the caller accepts breaking clients', async () => {
    const request = server(Response.json({ AutoMigrate: { token: 'a/b', break_clients: true } }), new Response(null, { status: 200 }))
    await publishSpacetimeModule(connection, bundle, { breakClients: true })

    expect(sent(request, 1).url).toBe('https://spacetime.example/v1/database/app-production?host_type=Js&policy=BreakClients&token=a%2Fb')
  })

  it('refuses a client-breaking migration the caller did not accept', async () => {
    const request = server(Response.json({ AutoMigrate: { token: 'abc', break_clients: true } }))
    await expect(publishSpacetimeModule(connection, bundle)).rejects.toThrow('would break existing clients')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('refuses a migration that needs manual steps and keeps the data', async () => {
    const request = server(Response.json({ ManualMigrate: { reason: 'column removed' } }))
    await expect(publishSpacetimeModule(connection, bundle)).rejects.toThrow('needs a manual migration: column removed')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('throws when the publish itself fails', async () => {
    server(new Response(null, { status: 404 }), new Response('bad module', { status: 400 }))
    await expect(publishSpacetimeModule(connection, bundle)).rejects.toMatchObject({ status: 400 })
  })
})

describe('SpacetimeDB database deletion', () => {
  it('deletes the database with the bearer token', async () => {
    const request = server(new Response(null, { status: 200 }))
    await deleteSpacetimeDatabase(connection)

    expect(sent(request)).toMatchObject({ url: 'https://spacetime.example/v1/database/app-production', method: 'DELETE' })
    expect(sent(request).headers.get('authorization')).toBe('Bearer owner-token')
  })

  it('treats a database that does not exist as already deleted', async () => {
    server(new Response(null, { status: 404 }))
    await expect(deleteSpacetimeDatabase(connection)).resolves.toBeUndefined()
  })

  it('throws when the server refuses the deletion', async () => {
    server(new Response('Database is locked', { status: 403 }))
    await expect(deleteSpacetimeDatabase(connection)).rejects.toMatchObject({ status: 403 })
  })
})
