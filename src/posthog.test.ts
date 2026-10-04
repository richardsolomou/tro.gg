import { strict as assert } from 'node:assert'
import { test, mock } from 'node:test'
import { createServer } from 'vite'

for (const token of ['phc_test', '']) {
  test(`application analytics initialization with ${token ? 'configured' : 'missing'} credentials`, async () => {
    const server = await createServer({
      configFile: false,
      envDir: false,
      define: {
        'import.meta.env.VITE_POSTHOG_KEY': JSON.stringify(token),
        'import.meta.env.VITE_POSTHOG_HOST': JSON.stringify('https://eu.i.posthog.com'),
        'window.location.origin': JSON.stringify('http://localhost'),
        __BUILD_ID__: JSON.stringify('test-build'),
      },
      server: { middlewareMode: true },
      appType: 'custom',
    })
    try {
      const analytics = await server.ssrLoadModule('/src/analytics.ts')
      const init = mock.method(analytics.posthog, 'init', () => undefined)
      try {
        analytics.initAnalytics()
        if (!token) {
          assert.equal(init.mock.callCount(), 0)
          return
        }
        assert.equal(init.mock.callCount(), 1)
        const [key, options] = init.mock.calls[0]!.arguments
        assert.deepEqual(
          {
            key,
            host: options.api_host,
            exceptions: options.capture_exceptions,
            masking: options.mask_personal_data_properties,
            service: options.logs.serviceName,
            build: options.logs.serviceVersion,
            consoleLogs: options.logs.captureConsoleLogs,
            canvas: options.session_recording.captureCanvas,
          },
          {
            key: 'phc_test',
            host: 'https://eu.i.posthog.com',
            exceptions: true,
            masking: true,
            service: 'trogg-web',
            build: 'test-build',
            consoleLogs: false,
            canvas: { recordCanvas: true, canvasFps: 15 },
          },
        )
      } finally {
        init.mock.restore()
      }
    } finally {
      await server.close()
    }
  })
}
