import { definePostHogCoverage } from 'ras-stack/posthog'

export const postHogCoverage = definePostHogCoverage({
  browser: { analytics: true, errorTracking: true, featureFlags: true, identity: true, sessionReplay: true },
  server: {
    analytics: true,
    errorTracking: { disabled: 'SpacetimeDB exposes fetch capture but not the Node exception SDK' },
    logs: { disabled: 'SpacetimeDB exposes fetch capture but not the Node logging SDK' },
  },
  sourceMaps: { disabled: 'source-map upload requires a Cloudflare deployment personal API key' },
})
