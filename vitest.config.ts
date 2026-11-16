import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: [
      { find: '@trogg/shared', replacement: fileURLToPath(new URL('./shared/index.ts', import.meta.url)) },
      // The real server module loads only inside SpacetimeDB's host, so reducer tests evaluate the module against a stand-in.
      { find: /^spacetimedb\/server$/, replacement: fileURLToPath(new URL('./test/mock-server.ts', import.meta.url)) },
    ],
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}', 'shared/**/*.test.ts', 'test/**/*.test.ts', 'scripts/**/*.test.ts'],
    passWithNoTests: true,
  },
})
