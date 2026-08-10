import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { assertPostHogBrowserConformance } from 'ras-stack/conformance'
import { postHogBrowserOptions } from 'ras-stack/posthog/client'

test('PostHog uses the shared browser defaults', () => {
  assert.doesNotThrow(() =>
    assertPostHogBrowserConformance(postHogBrowserOptions({ apiHost: 'https://us.i.posthog.com', uiHost: 'https://us.posthog.com' })),
  )
})
