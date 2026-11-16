import { strict as assert } from 'node:assert'
import { posthog } from 'posthog-js'
import { afterEach, test, vi } from 'vitest'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.resetModules()
})

async function initWith(token: string) {
  vi.stubEnv('VITE_POSTHOG_KEY', token)
  vi.stubEnv('VITE_POSTHOG_HOST', 'https://eu.i.posthog.com')
  vi.stubGlobal('window', { location: { origin: 'http://localhost' } })
  vi.stubGlobal('__BUILD_ID__', 'test-build')
  const init = vi.spyOn(posthog, 'init').mockImplementation(() => posthog)
  const analytics = await import('./analytics')
  analytics.initAnalytics()
  return init
}

test('application analytics initialization with missing credentials', async () => {
  const init = await initWith('')
  assert.equal(init.mock.calls.length, 0)
})

test('application analytics initialization with configured credentials', async () => {
  const init = await initWith('phc_test')
  assert.equal(init.mock.calls.length, 1)
  const [key, options] = init.mock.calls[0]!
  assert.deepEqual(
    {
      key,
      host: options?.api_host,
      ui: options?.ui_host,
      exceptions: options?.capture_exceptions,
      masking: options?.mask_personal_data_properties,
      service: options?.logs?.serviceName,
      build: options?.logs?.serviceVersion,
      consoleLogs: options?.logs?.captureConsoleLogs,
      canvas: options?.session_recording?.captureCanvas,
    },
    {
      key: 'phc_test',
      host: 'https://eu.i.posthog.com',
      ui: 'https://eu.posthog.com',
      exceptions: true,
      masking: true,
      service: 'trogg-web',
      build: 'test-build',
      consoleLogs: false,
      canvas: { recordCanvas: true, canvasFps: 15 },
    },
  )
})
